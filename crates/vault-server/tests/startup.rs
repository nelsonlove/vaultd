//! Runtime startup ordering: what is available, and when.

use std::fs;
use std::sync::mpsc::{Receiver, sync_channel};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use tempfile::TempDir;
use vault_index::{IndexConfig, IndexError, IndexService, LiveState};
use vault_server::ServerStartupError;
use vault_server::runtime::{
    Runtime, RuntimeHandle, RuntimeNotice, RuntimeOptions, RuntimeTestHooks,
};

struct Fixture {
    vault: TempDir,
    _index: TempDir,
    config: IndexConfig,
}

fn fixture() -> Fixture {
    let vault = tempfile::tempdir().expect("vault");
    let index = tempfile::tempdir().expect("index");
    fs::write(vault.path().join("Note.md"), "# Note\n\n[[Other]]\n").expect("write note");
    fs::write(vault.path().join("Other.md"), "# Other\n").expect("write other");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("index config");
    Fixture {
        vault,
        _index: index,
        config,
    }
}

fn wait_for<T>(label: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {label}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait_for_state(handle: &RuntimeHandle, wanted: LiveState) {
    wait_for(&format!("live state {wanted:?}"), || {
        let status = handle.reader().published_status().expect("status");
        (status.live_state == wanted).then_some(())
    });
}

fn states(notices: &Receiver<RuntimeNotice>) -> Vec<LiveState> {
    let mut seen = Vec::new();
    while let Ok(notice) = notices.try_recv() {
        if let RuntimeNotice::State { state, .. } = notice {
            seen.push(state);
        }
    }
    seen
}

/// A gate that parks the coordinator inside the catch-up mutation window
/// until the test releases it.
fn gated_hooks() -> (Arc<Barrier>, RuntimeTestHooks) {
    let gate = Arc::new(Barrier::new(2));
    let hooks = RuntimeTestHooks {
        before_catch_up: Some({
            let gate = Arc::clone(&gate);
            Arc::new(move || {
                gate.wait();
                gate.wait();
            })
        }),
        ..RuntimeTestHooks::default()
    };
    (gate, hooks)
}

/// With no generation yet, only health and state are available: reads refuse
/// until the cold build publishes generation 1.
#[test]
fn a_cold_start_serves_state_until_generation_one_exists() {
    let fixture = fixture();
    let (gate, hooks) = gated_hooks();

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: true,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        hooks,
    )
    .expect("start runtime");

    gate.wait();
    let reader = handle.reader();
    assert!(
        matches!(reader.vault_info(), Err(IndexError::IndexUnavailable)),
        "no generation has ever been published, so reads must refuse"
    );
    let status = reader.published_status().expect("status");
    assert_eq!(status.live_state, LiveState::CatchingUp);
    assert_eq!(status.generation, None);

    gate.wait();
    wait_for_state(&handle, LiveState::Watching);
    assert_eq!(reader.vault_info().expect("read").generation.get(), 1);
    assert_eq!(states(&notices).first(), Some(&LiveState::CatchingUp));
}

/// The watcher is installed before inventory catch-up, so a change made
/// while catch-up runs is already queued when it finishes.
#[test]
fn the_watcher_is_installed_before_catch_up() {
    let fixture = fixture();
    let (gate, hooks) = gated_hooks();

    let (sink, _notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: true,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        hooks,
    )
    .expect("start runtime");

    gate.wait();
    assert!(
        handle.watch_installed(),
        "the watcher must already be installed while catch-up is still blocked"
    );
    assert_eq!(
        handle
            .reader()
            .published_status()
            .expect("status")
            .live_state,
        LiveState::CatchingUp
    );
    gate.wait();
    wait_for_state(&handle, LiveState::Watching);
}

/// A watcher that cannot be installed is not a startup failure: the runtime
/// starts, says so with a stable error, and keeps reconciling on demand.
#[test]
fn a_failed_watcher_installation_starts_in_polling_fallback() {
    let fixture = fixture();

    let (sink, _notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: true,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks {
            fail_watch_install: true,
            ..RuntimeTestHooks::default()
        },
    )
    .expect("a runtime that cannot watch still starts");

    wait_for_state(&handle, LiveState::PollingFallback);
    assert!(!handle.watch_installed());
    let status = handle.reader().published_status().expect("status");
    assert!(
        status.runtime_error.is_some(),
        "the reason watching is unavailable must stay visible"
    );
    assert_eq!(status.generation.map(|it| it.get()), Some(1));

    fs::write(fixture.vault.path().join("Third.md"), "# Third\n").expect("write third");
    let report = handle.refresh(false).expect("manual refresh");
    assert_eq!(
        report.generation.get(),
        2,
        "manual reconciliation is retained while degraded"
    );

    // An in-process hint is not evidence of a working watcher — there is no
    // watcher at all — so it must never promote the runtime to `Watching`.
    assert!(
        handle.hint(vault_watch::ChangeHint::Paths(
            [vault_core::VaultPath::new("Third.md").expect("path")]
                .into_iter()
                .collect()
        ))
    );
    std::thread::sleep(Duration::from_millis(200));
    let status = handle.reader().published_status().expect("status");
    assert_eq!(status.live_state, LiveState::PollingFallback);
    assert!(status.runtime_error.is_some());
}

/// The writer lease is exclusive: a second runtime over the same cache fails
/// at open, before any recovery or reconciliation runs.
#[test]
fn a_second_runtime_on_the_same_cache_is_refused() {
    let fixture = fixture();

    let (sink, _notices) = sync_channel(64);
    let first = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: false,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start first runtime");
    wait_for_state(&first, LiveState::PollingFallback);

    let (sink, _notices) = sync_channel(64);
    let second = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: false,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    );
    assert!(matches!(
        second,
        Err(ServerStartupError::Index(IndexError::IndexInUse))
    ));
}

/// A generation another writer committed while this process was closed is
/// adopted by the startup catch-up, not refused forever.
#[test]
fn startup_adopts_a_generation_committed_by_a_previous_writer() {
    let fixture = fixture();
    {
        let mut service = IndexService::open(fixture.config.clone()).expect("open service");
        service.refresh(false).expect("cold build");
    }

    let (gate, hooks) = gated_hooks();
    let (sink, _notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: false,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        hooks,
    )
    .expect("start runtime");

    gate.wait();
    assert_eq!(
        handle.reader().vault_info().expect("read").generation.get(),
        1,
        "the committed generation is readable before catch-up runs"
    );
    gate.wait();
    wait_for_state(&handle, LiveState::PollingFallback);
}
