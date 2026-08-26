//! The runtime coordinator: one writer thread owns every mutation.

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, sync_channel};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{IndexConfig, IndexError, IndexService, LiveState};
use vault_server::runtime::{
    Dispatch, ResyncReason, Runtime, RuntimeCommand, RuntimeHandle, RuntimeNotice, RuntimeOptions,
    RuntimeTestHooks,
};

/// A vault plus its cache directory, kept alive for the whole test: dropping
/// either `TempDir` would delete the vault out from under the runtime.
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

impl Fixture {
    /// Build generation 1 and release the writer lease again, so a runtime
    /// can open the same cache warm.
    fn build_generation_one(&self) {
        let mut service = IndexService::open(self.config.clone()).expect("open service");
        service.refresh(false).expect("cold build");
    }

    fn path(&self, name: &str) -> std::path::PathBuf {
        self.vault.path().join(name)
    }
}

/// Poll `probe` until it yields a value, failing the test after ten seconds.
/// Used only where the thing being waited on is genuinely asynchronous; the
/// margin is deliberately far larger than any timing this test tunes.
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

fn wait_for_generation(handle: &RuntimeHandle, wanted: u64) {
    wait_for(&format!("generation {wanted}"), || {
        let status = handle.reader().published_status().expect("status");
        status
            .generation
            .filter(|generation| generation.get() == wanted)
            .map(|_| ())
    });
}

/// Shut down and prove it did not wait out a reconcile interval. A timer
/// that checks its stop flag only *after* entering `wait_timeout` misses the
/// wake-up entirely and holds the join for the whole interval — which is
/// sixty seconds with the production default. Whether that lands on a given
/// handle is a scheduling race, so every shutdown in a test that configures
/// an interval has to be bounded, not just one.
fn bounded_shutdown(handle: &RuntimeHandle, label: &str) {
    let started = Instant::now();
    handle.shutdown();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "shutting down the {label} runtime must not wait out its reconcile interval, took {elapsed:?}"
    );
}

fn drain(notices: &Receiver<RuntimeNotice>) -> Vec<RuntimeNotice> {
    let mut seen = Vec::new();
    while let Ok(notice) = notices.try_recv() {
        seen.push(notice);
    }
    seen
}

/// A counter that records the largest number of mutations ever in flight at
/// once. The coordinator is the only mutation owner, so this must never
/// exceed one — a second mutating thread would show up here as two.
#[derive(Clone, Default)]
struct MutationCounter {
    active: Arc<AtomicUsize>,
    max: Arc<AtomicUsize>,
}

impl MutationCounter {
    fn hooks(&self) -> RuntimeTestHooks {
        let enter = self.clone();
        let exit = self.clone();
        RuntimeTestHooks {
            mutation_enter: Some(Arc::new(move || {
                let active = enter.active.fetch_add(1, Ordering::AcqRel) + 1;
                enter.max.fetch_max(active, Ordering::AcqRel);
            })),
            mutation_exit: Some(Arc::new(move || {
                exit.active.fetch_sub(1, Ordering::AcqRel);
            })),
            ..RuntimeTestHooks::default()
        }
    }

    fn max(&self) -> usize {
        self.max.load(Ordering::Acquire)
    }
}

/// The whole of the brief's step 1, in one test: a warm runtime answers
/// reads at the last committed generation while catch-up is still blocked,
/// reports `CatchingUp` while it is, publishes exactly one new generation for
/// the note that changed while the cache was closed, and runs a manual
/// refresh that arrived during catch-up strictly afterwards — never
/// alongside it.
#[test]
fn cached_reads_answer_during_catch_up_and_mutations_never_overlap() {
    let fixture = fixture();
    fixture.build_generation_one();
    fs::write(
        fixture.path("Note.md"),
        "# Note\n\n[[Other]]\n[[Third]]\n[[Fourth]]\n",
    )
    .expect("change note");

    let counter = MutationCounter::default();
    let mut hooks = counter.hooks();
    let gate = Arc::new(Barrier::new(2));
    hooks.before_catch_up = Some({
        let gate = Arc::clone(&gate);
        Arc::new(move || {
            gate.wait();
            gate.wait();
        })
    });

    let (sink, notices) = sync_channel(64);
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

    // The coordinator is now parked inside the catch-up mutation window.
    gate.wait();

    let reader = handle.reader();
    let info = reader.vault_info().expect("cached read");
    assert_eq!(
        info.generation.get(),
        1,
        "reads must answer the last committed generation before catch-up runs"
    );
    assert_eq!(
        reader.published_status().expect("status").live_state,
        LiveState::CatchingUp
    );

    // Queue a manual refresh while catch-up is blocked. `send_command`
    // returns once the command is in the mailbox, so this is a rendezvous,
    // not a sleep.
    let (reply, replies) = sync_channel(1);
    assert_eq!(
        handle.send_command(RuntimeCommand::Refresh {
            verify: false,
            reply
        }),
        Dispatch::Accepted
    );

    gate.wait();

    let manual = replies
        .recv()
        .expect("manual refresh reply")
        .expect("manual refresh");
    assert_eq!(
        manual.generation.get(),
        2,
        "the manual refresh must observe the generation catch-up published"
    );
    assert_eq!(
        manual
            .previous_generation
            .map(|generation| generation.get()),
        Some(2),
        "catch-up already published the change, so the manual refresh publishes nothing new"
    );

    wait_for_state(&handle, LiveState::PollingFallback);
    assert_eq!(
        reader.vault_info().expect("read").generation.get(),
        2,
        "exactly one new generation for the note that changed while the cache was closed"
    );
    assert_eq!(
        counter.max(),
        1,
        "the coordinator is the only mutation owner: no two mutations may overlap"
    );

    let states: Vec<LiveState> = drain(&notices)
        .into_iter()
        .filter_map(|notice| match notice {
            RuntimeNotice::State { state, .. } => Some(state),
            _ => None,
        })
        .collect();
    assert_eq!(states.first(), Some(&LiveState::CatchingUp));
}

/// A watched write reaches the coordinator as a `Paths` hint and publishes a
/// targeted generation, with the per-path change set a subscriber needs.
#[test]
fn a_watched_write_publishes_one_targeted_generation() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: true,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::Watching);

    fs::write(fixture.path("Third.md"), "# Third\n\n[[Note]]\n").expect("write third");
    wait_for_generation(&handle, 2);

    let created = wait_for("a targeted generation notice", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::Generation(report) => Some(report.changes.created),
            _ => None,
        })
    });
    assert_eq!(
        created
            .iter()
            .map(|path| path.as_str().to_string())
            .collect::<Vec<_>>(),
        vec!["Third.md".to_string()],
        "a watched write must publish the exact path that changed"
    );
}

/// Overflow is never "just logged": detail was lost, so the runtime
/// reconciles completely and tells observers their incremental view is no
/// longer usable.
#[test]
fn an_overflow_hint_reconciles_completely_and_requires_resync() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: false,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    fs::write(fixture.path("Third.md"), "# Third\n").expect("write third");
    assert!(handle.hint(vault_watch::ChangeHint::Overflow));

    let reason = wait_for("a resync notice", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::ResyncRequired { reason, .. } => Some(reason),
            _ => None,
        })
    });
    assert_eq!(reason, ResyncReason::WatcherOverflow);
    wait_for_generation(&handle, 2);
}

/// A root that was removed or renamed is reported with its own reason, so an
/// observer can tell "we lost events" from "the vault moved".
#[test]
fn a_root_invalidation_reports_its_own_resync_reason() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: false,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    assert!(handle.hint(vault_watch::ChangeHint::RootInvalidated));

    let reason = wait_for("a resync notice", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::ResyncRequired { reason, .. } => Some(reason),
            _ => None,
        })
    });
    assert_eq!(reason, ResyncReason::RootInvalidated);
}

/// A watcher backend failure degrades to polling with a stable error, keeps
/// reconciling, and recovers to watching the moment the stream proves itself
/// again.
#[test]
fn a_watcher_failure_degrades_to_polling_and_recovers() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, _notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: true,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::Watching);

    assert!(handle.hint(vault_watch::ChangeHint::WatcherFailed(
        "backend refused".into()
    )));
    wait_for_state(&handle, LiveState::PollingFallback);
    let status = handle.reader().published_status().expect("status");
    assert!(
        status
            .runtime_error
            .as_deref()
            .is_some_and(|error| error.contains("backend refused")),
        "the watcher failure must stay visible as a stable error, got {:?}",
        status.runtime_error
    );

    // Manual reconciliation still works while degraded.
    fs::write(fixture.path("Third.md"), "# Third\n").expect("write third");
    let report = handle.refresh(false).expect("manual refresh");
    assert_eq!(report.generation.get(), 2);

    // A hint proves the stream works again.
    assert!(
        handle.hint(vault_watch::ChangeHint::Paths(
            [vault_core::VaultPath::new("Third.md").expect("path")]
                .into_iter()
                .collect()
        ))
    );
    wait_for_state(&handle, LiveState::Watching);
    assert_eq!(
        handle
            .reader()
            .published_status()
            .expect("status")
            .runtime_error,
        None
    );
}

/// A deletion is held for the grace window rather than published the instant
/// a path goes missing, then published as a deletion when it stays missing.
#[test]
fn a_deletion_waits_out_the_grace_window() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, notices) = sync_channel(64);
    let mut options = RuntimeOptions {
        watch: false,
        reconcile_interval: None,
        ..RuntimeOptions::default()
    };
    options.watch_config.debounce = Duration::from_millis(500);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        options,
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    fs::remove_file(fixture.path("Other.md")).expect("remove other");
    assert!(
        handle.hint(vault_watch::ChangeHint::Paths(
            [vault_core::VaultPath::new("Other.md").expect("path")]
                .into_iter()
                .collect()
        ))
    );

    // Well inside the 500ms window: nothing may have been published yet.
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        handle
            .reader()
            .published_status()
            .expect("status")
            .generation
            .map(|generation| generation.get()),
        Some(1),
        "a missing path must not publish a deletion before its grace window ends"
    );

    wait_for_generation(&handle, 2);
    let deleted = wait_for("a deletion notice", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::Generation(report) => Some(report.changes.deleted),
            _ => None,
        })
    });
    assert_eq!(
        deleted
            .iter()
            .map(|path| path.as_str().to_string())
            .collect::<Vec<_>>(),
        vec!["Other.md".to_string()]
    );
}

/// A path that reappears inside its grace window is a modification, not a
/// deletion — the atomic-save case every editor produces.
#[test]
fn a_path_that_reappears_in_the_grace_window_is_a_modification() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, notices) = sync_channel(64);
    let mut options = RuntimeOptions {
        watch: false,
        reconcile_interval: None,
        ..RuntimeOptions::default()
    };
    options.watch_config.debounce = Duration::from_millis(500);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        options,
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    let note = vault_core::VaultPath::new("Note.md").expect("path");
    fs::remove_file(fixture.path("Note.md")).expect("remove note");
    assert!(handle.hint(vault_watch::ChangeHint::Paths(
        [note.clone()].into_iter().collect()
    )));
    fs::write(fixture.path("Note.md"), "# Note\n\n[[Other]]\n[[Third]]\n").expect("rewrite note");
    assert!(handle.hint(vault_watch::ChangeHint::Paths([note].into_iter().collect())));

    wait_for_generation(&handle, 2);
    let report = wait_for("a generation notice", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::Generation(report) => Some(report),
            _ => None,
        })
    });
    assert_eq!(
        report
            .changes
            .modified
            .iter()
            .map(|path| path.as_str().to_string())
            .collect::<Vec<_>>(),
        vec!["Note.md".to_string()]
    );
    assert!(
        report.changes.deleted.is_empty(),
        "a path that came back must never publish as deleted"
    );
}

/// A saturated command mailbox never blocks a producer and never loses the
/// change it was carrying: the overflow latch turns the coordinator's next
/// act into a complete reconciliation.
#[test]
fn a_saturated_mailbox_escalates_to_a_complete_reconciliation() {
    let fixture = fixture();
    fixture.build_generation_one();

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
    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: false,
            reconcile_interval: None,
            command_capacity: 1,
            ..RuntimeOptions::default()
        },
        sink,
        hooks,
    )
    .expect("start runtime");

    gate.wait();
    let note = vault_core::VaultPath::new("Note.md").expect("path");
    let other = vault_core::VaultPath::new("Other.md").expect("path");
    assert!(handle.hint(vault_watch::ChangeHint::Paths([note].into_iter().collect())));
    // The mailbox now holds its one command; this one cannot fit.
    assert!(
        handle.hint(vault_watch::ChangeHint::Paths(
            [other].into_iter().collect()
        )),
        "a full mailbox is not a producer failure"
    );
    fs::write(fixture.path("Third.md"), "# Third\n").expect("write third");
    gate.wait();

    let reason = wait_for("an overflow resync notice", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::ResyncRequired { reason, .. } => {
                (reason == ResyncReason::WatcherOverflow).then_some(reason)
            }
            _ => None,
        })
    });
    assert_eq!(reason, ResyncReason::WatcherOverflow);
}

/// A periodic tick reconciles a change no watcher reported, and announces
/// the generation move as a resync — no per-path change set describes it.
#[test]
fn a_periodic_tick_reconciles_without_a_watcher() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: false,
            reconcile_interval: Some(Duration::from_millis(100)),
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    fs::write(fixture.path("Third.md"), "# Third\n").expect("write third");
    wait_for_generation(&handle, 2);
    let reason = wait_for("a resync notice", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::ResyncRequired { reason, .. } => Some(reason),
            _ => None,
        })
    });
    assert_eq!(reason, ResyncReason::RuntimeRecovered);
}

/// Threads exist only for the work that was asked for: no interval, no
/// timer thread; no watching, no forwarder thread.
#[test]
fn only_the_configured_threads_are_started() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, _notices) = sync_channel(64);
    let bare = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: false,
            reconcile_interval: None,
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start bare runtime");
    assert_eq!(
        bare.thread_count_for_test(),
        1,
        "a runtime that neither watches nor ticks is one coordinator thread"
    );
    bounded_shutdown(&bare, "bare");

    let (sink, _notices) = sync_channel(64);
    let timed = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: false,
            reconcile_interval: Some(Duration::from_secs(60)),
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start timed runtime");
    assert_eq!(timed.thread_count_for_test(), 2);
    bounded_shutdown(&timed, "timed");

    let (sink, _notices) = sync_channel(64);
    let watched = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: true,
            reconcile_interval: Some(Duration::from_secs(60)),
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start watched runtime");
    assert_eq!(watched.thread_count_for_test(), 3);
    bounded_shutdown(&watched, "watched");
}

/// Shutdown joins every thread, records `Stopped`, and releases the writer
/// lease — proven by opening a second production service on the same cache.
#[test]
fn shutdown_joins_every_thread_and_releases_the_lease() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, _notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: true,
            reconcile_interval: Some(Duration::from_millis(100)),
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::Watching);

    // While the runtime holds the lease, nobody else may write.
    assert!(
        matches!(
            IndexService::open(fixture.config.clone()),
            Err(vault_index::IndexError::IndexInUse)
        ),
        "the coordinator holds the exclusive writer lease"
    );

    handle.shutdown();
    assert!(handle.is_stopped());
    assert_eq!(handle.thread_count_for_test(), 0, "every thread was joined");
    assert_eq!(
        handle
            .reader()
            .published_status()
            .expect("status")
            .live_state,
        LiveState::Stopped
    );
    assert!(
        IndexService::open(fixture.config.clone()).is_ok(),
        "shutdown must release the writer lease"
    );

    // A stopped runtime refuses work instead of blocking or panicking.
    assert!(handle.refresh(false).is_err());
    assert!(!handle.hint(vault_watch::ChangeHint::Overflow));
    // Idempotent.
    handle.shutdown();
}

/// Options for a runtime that neither watches nor ticks, so the only
/// mutations are the ones the test causes and their sequence numbers are
/// stable: sequence 0 is the startup catch-up, sequence 1 the first
/// `refresh_paths`.
fn quiet_options() -> RuntimeOptions {
    RuntimeOptions {
        watch: false,
        reconcile_interval: None,
        ..RuntimeOptions::default()
    }
}

fn path(name: &str) -> VaultPath {
    VaultPath::new(name).expect("vault path")
}

fn paths_hint(names: &[&str]) -> vault_watch::ChangeHint {
    vault_watch::ChangeHint::Paths(names.iter().map(|name| path(name)).collect())
}

/// Hooks that fail specific mutations, and count every mutation the
/// coordinator makes.
fn faulty_hooks(
    fault: impl Fn(usize) -> Option<IndexError> + Send + Sync + 'static,
) -> (RuntimeTestHooks, Arc<AtomicUsize>) {
    let mutations = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&mutations);
    let hooks = RuntimeTestHooks {
        mutation_enter: Some(Arc::new(move || {
            counter.fetch_add(1, Ordering::AcqRel);
        })),
        mutation_fault: Some(Arc::new(fault)),
        ..RuntimeTestHooks::default()
    };
    (hooks, mutations)
}

/// Retries running out must never consume the batch. With no
/// `reconcile_interval` configured — a supported configuration — nothing
/// else would ever revisit these paths, so a dropped batch is a permanently
/// missing change.
#[test]
fn a_dirty_batch_survives_exhausted_busy_retries() {
    let fixture = fixture();
    fixture.build_generation_one();

    // Sequence 0 is the startup catch-up and must succeed; 1, 2 and 3 are
    // the three attempts `reconcile_paths` makes, all of which fail.
    let (hooks, mutations) = faulty_hooks(|sequence| {
        (1..=3)
            .contains(&sequence)
            .then(|| IndexError::Busy("injected lock contention".into()))
    });

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(fixture.config.clone(), quiet_options(), sink, hooks)
        .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    fs::write(fixture.path("Note.md"), "# Note\n\n[[Other]]\n[[Third]]\n").expect("change note");
    assert!(handle.hint(paths_hint(&["Note.md"])));

    // Three Busy failures, then the batch comes back and publishes.
    wait_for_generation(&handle, 2);
    assert!(
        mutations.load(Ordering::Acquire) >= 5,
        "three failed attempts plus at least one successful retry"
    );
    let modified = wait_for("the re-hinted batch to publish", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::Generation(report) => Some(report.changes.modified.clone()),
            _ => None,
        })
    });
    assert_eq!(
        modified.iter().map(VaultPath::as_str).collect::<Vec<_>>(),
        vec!["Note.md"]
    );
}

/// A foreign writer moving the cache is curable in place: adopt what it
/// committed, then retry the same batch.
#[test]
fn a_stale_live_state_is_resynced_and_the_retry_succeeds() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (hooks, mutations) = faulty_hooks(|sequence| {
        (sequence == 1).then(|| IndexError::LiveStateStale("injected foreign writer".into()))
    });

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(fixture.config.clone(), quiet_options(), sink, hooks)
        .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    fs::write(fixture.path("Note.md"), "# Note\n\n[[Other]]\n[[Third]]\n").expect("change note");
    assert!(handle.hint(paths_hint(&["Note.md"])));
    wait_for_generation(&handle, 2);

    // Exactly four mutations: the catch-up (0), the faulted attempt (1),
    // `resync_published` (2), and the successful retry (3). Three would mean
    // the retry ran without adopting the foreign generation first — the one
    // thing `LiveStateStale` requires.
    wait_for("the resync and retry to settle", || {
        (mutations.load(Ordering::Acquire) >= 4).then_some(())
    });
    assert_eq!(mutations.load(Ordering::Acquire), 4);
    assert!(
        handle
            .reader()
            .published_status()
            .expect("status")
            .runtime_error
            .is_none(),
        "a cured stale state is not an error the operator should see"
    );
}

/// `refresh_paths` reads every path before it publishes, so one path moving
/// mid-cycle aborts the whole batch. The whole batch is therefore what must
/// come back — re-hinting only the path that moved would silently drop the
/// rest.
#[test]
fn a_vault_change_during_refresh_returns_the_entire_batch() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (hooks, _mutations) =
        faulty_hooks(|sequence| (sequence == 1).then_some(IndexError::VaultChangedDuringRefresh));

    let (sink, notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(fixture.config.clone(), quiet_options(), sink, hooks)
        .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    fs::write(fixture.path("Note.md"), "# Note\n\n[[Other]]\n[[Third]]\n").expect("change note");
    fs::write(fixture.path("Other.md"), "# Other\n\n[[Note]]\n").expect("change other");
    assert!(handle.hint(paths_hint(&["Note.md", "Other.md"])));

    wait_for_generation(&handle, 2);
    let modified = wait_for("the re-hinted batch to publish", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::Generation(report) => Some(report.changes.modified.clone()),
            _ => None,
        })
    });
    assert_eq!(
        modified.iter().map(VaultPath::as_str).collect::<Vec<_>>(),
        vec!["Note.md", "Other.md"],
        "both paths must come back, not only the one the failure was blamed on"
    );
}

/// An escalation whose complete reconciliation fails is not allowed to
/// vanish. `full_reconcile` has already cleared the pending sets and the
/// overflow latch was consumed before it ran, so nothing else remembers it
/// was owed — and with no `reconcile_interval` nothing else would ever come
/// back. It must still announce the loss, and it must still converge.
#[test]
fn a_failed_escalation_is_announced_and_retried() {
    let fixture = fixture();
    fixture.build_generation_one();

    // Sequence 0 is the startup catch-up. 1, 2 and 3 are the three attempts
    // `refresh_with_retries` makes for the escalation, all of which fail
    // with the error a write storm actually produces — and which it retries
    // with no backoff at all, so all three burn in microseconds.
    let (hooks, _mutations) = faulty_hooks(|sequence| {
        (1..=3)
            .contains(&sequence)
            .then_some(IndexError::VaultChangedDuringRefresh)
    });

    let (sink, notices) = sync_channel(256);
    let handle = Runtime::start_with_hooks(fixture.config.clone(), quiet_options(), sink, hooks)
        .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    fs::write(fixture.path("Third.md"), "# Third\n\n[[Note]]\n").expect("write third");
    assert!(handle.hint(vault_watch::ChangeHint::Overflow));

    // Converges: the re-armed escalation runs again and publishes.
    wait_for_generation(&handle, 2);

    // Announced twice: once by the attempt that failed — the loss is true
    // whether or not it can be repaired — and once by the retry that
    // succeeded. Exactly one would mean the failure was swallowed.
    // Counted across polls, not within one: `drain` consumes what it sees,
    // so the two announcements are routinely delivered to different polls
    // and a per-poll count would never reach two.
    let mut seen = 0usize;
    let overflows = wait_for("both overflow announcements", || {
        seen += drain(&notices)
            .into_iter()
            .filter(|notice| {
                matches!(
                    notice,
                    RuntimeNotice::ResyncRequired {
                        reason: ResyncReason::WatcherOverflow,
                        ..
                    }
                )
            })
            .count();
        (seen >= 2).then_some(seen)
    });
    assert!(overflows >= 2, "announced {overflows} times");
}

/// The mirror of `a_path_that_reappears_in_the_grace_window_is_a_modification`:
/// a path already queued for the next batch, which then disappears, must
/// leave that batch and take a grace window — not ride the batch's own
/// `retry_at` backoff out and publish as an ungraced deletion.
#[test]
fn a_path_that_disappears_after_being_queued_takes_the_grace_window() {
    let fixture = fixture();
    fixture.build_generation_one();

    // Fail the first `refresh_paths` so the batch is re-hinted and sits
    // behind a `retry_at` backoff — the window in which the queued path can
    // disappear underneath it.
    let (hooks, _mutations) =
        faulty_hooks(|sequence| (sequence == 1).then_some(IndexError::VaultChangedDuringRefresh));

    let (sink, notices) = sync_channel(64);
    let mut options = quiet_options();
    options.watch_config.debounce = Duration::from_millis(500);
    let handle = Runtime::start_with_hooks(fixture.config.clone(), options, sink, hooks)
        .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    // Queued while it exists; the flush fails and re-hints it at T0 + 500ms.
    fs::write(fixture.path("Note.md"), "# Note\n\n[[Other]]\n[[Third]]\n").expect("change note");
    assert!(handle.hint(paths_hint(&["Note.md"])));

    std::thread::sleep(Duration::from_millis(400));
    fs::remove_file(fixture.path("Note.md")).expect("remove note");
    assert!(handle.hint(paths_hint(&["Note.md"])));

    // The re-hinted batch's own backoff fires around here. If the path is
    // still riding it, the deletion publishes now — with no grace at all.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        handle
            .reader()
            .published_status()
            .expect("status")
            .generation
            .map(|generation| generation.get()),
        Some(1),
        "a queued path that disappeared must take a grace window, not the batch's backoff"
    );

    wait_for_generation(&handle, 2);
    let deleted = wait_for("a deletion notice", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::Generation(report) => Some(report.changes.deleted.clone()),
            _ => None,
        })
    });
    assert_eq!(
        deleted.iter().map(VaultPath::as_str).collect::<Vec<_>>(),
        vec!["Note.md"]
    );
}

/// A held-back deletion must publish on schedule even while hints keep
/// arriving: maturity is checked every cycle, not only when the coordinator
/// happens to go idle.
#[test]
fn a_deletion_publishes_on_schedule_under_hint_traffic() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, notices) = sync_channel(256);
    let mut options = quiet_options();
    options.watch_config.debounce = Duration::from_millis(500);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        options,
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);
    let _ = drain(&notices);

    fs::remove_file(fixture.path("Other.md")).expect("remove other");
    let started = Instant::now();
    assert!(handle.hint(paths_hint(&["Other.md"])));

    // Keep the coordinator busy for the whole grace window with hints for a
    // path that has not changed. Those publish nothing, so anything that
    // does publish came from the held-back deletion.
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let spammer = {
        let handle = handle.clone();
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                handle.hint(paths_hint(&["Note.md"]));
                std::thread::sleep(Duration::from_millis(2));
            }
        })
    };

    wait_for_generation(&handle, 2);
    let elapsed = started.elapsed();
    stop.store(true, Ordering::Release);
    spammer.join().expect("join spammer");

    assert!(
        elapsed >= Duration::from_millis(300),
        "the grace window must still be honoured, published after {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(4),
        "the deletion must not starve behind hint traffic, published after {elapsed:?}"
    );
    let deleted = wait_for("a deletion notice", || {
        notices.try_recv().ok().and_then(|notice| match notice {
            RuntimeNotice::Generation(report) => Some(report.changes.deleted.clone()),
            _ => None,
        })
    });
    assert_eq!(
        deleted.iter().map(VaultPath::as_str).collect::<Vec<_>>(),
        vec!["Other.md"]
    );
}

/// Dropping the last handle stops the runtime just as `shutdown` does — no
/// thread outlives the runtime, and the lease comes back.
#[test]
fn dropping_the_last_handle_stops_the_runtime() {
    let fixture = fixture();
    fixture.build_generation_one();

    let (sink, _notices) = sync_channel(64);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        RuntimeOptions {
            watch: true,
            reconcile_interval: Some(Duration::from_millis(100)),
            ..RuntimeOptions::default()
        },
        sink,
        RuntimeTestHooks::default(),
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::Watching);

    let clone = handle.clone();
    drop(handle);
    assert!(!clone.is_stopped(), "a surviving handle keeps it running");
    drop(clone);

    assert!(
        IndexService::open(fixture.config.clone()).is_ok(),
        "dropping the last handle must release the writer lease"
    );
}

/// A dropped notice is a gap in an observer's incremental view, and the
/// runtime owes it an announcement. The announcement names the generation to
/// re-read at — so when the coordinator cannot establish that generation (a
/// transient failure on the generation query, or nothing committed yet), the
/// announcement it manages to send says nothing usable and every observer
/// discards it.
///
/// The latch must therefore survive a recovery notice whose generation is
/// unknown. Clearing it there would spend the only record that a gap ever
/// happened on a notice nobody can act on, and nothing re-arms it.
#[test]
fn a_dropped_notice_stays_owed_while_its_generation_is_unknown() {
    let fixture = fixture();

    // Two slots and no draining: startup fills them, and the settle that
    // follows is dropped. Whatever the exact interleaving, the sink is
    // saturated by the time the refresh below is taken, so the latch is set.
    let (sink, notices) = sync_channel(2);
    let handle = Runtime::start_with_hooks(
        fixture.config.clone(),
        quiet_options(),
        sink,
        RuntimeTestHooks {
            blind_generation_query: true,
            ..RuntimeTestHooks::default()
        },
    )
    .expect("start runtime");
    wait_for_state(&handle, LiveState::PollingFallback);

    // Emitting into a full sink leaves the latch set either way: an unset
    // latch is set by the drop, and a set one cannot clear because its own
    // recovery notice will not fit either.
    handle.refresh(false).expect("refresh with a full sink");
    assert_eq!(drain(&notices).len(), 2, "the sink was saturated");

    // With room again, every subsequent emission must lead with the gap
    // announcement — and keep leading with it, because its generation is
    // still unknown and no observer could have acted on the last one.
    for round in 1..=2 {
        handle.refresh(false).expect("refresh with a drained sink");
        let seen = drain(&notices);
        assert!(
            seen.iter().any(|notice| matches!(
                notice,
                RuntimeNotice::ResyncRequired {
                    generation: None,
                    reason: ResyncReason::RuntimeRecovered,
                }
            )),
            "round {round} lost the gap announcement: {seen:?}"
        );
    }

    handle.shutdown();
}
