//! Deterministic debounce and overflow-latching coverage. Drives
//! `Debouncer` with an explicit, synthetic `Instant` timeline — no sleeping,
//! no real-clock flakiness.

use std::time::{Duration, Instant};

use vault_core::VaultPath;
use vault_watch::{ChangeHint, Debouncer};

fn path(value: &str) -> VaultPath {
    VaultPath::new(value).expect("valid path")
}

#[test]
fn stays_idle_with_no_activity() {
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 10);
    assert_eq!(debouncer.poll(Instant::now()), None);
}

#[test]
fn does_not_emit_before_the_debounce_window_elapses() {
    let base = Instant::now();
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 10);
    debouncer.observe_path(path("A.md"), base);
    assert_eq!(debouncer.poll(base + Duration::from_millis(50)), None);
}

#[test]
fn emits_paths_once_no_new_activity_arrives_for_the_debounce_duration() {
    let base = Instant::now();
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 10);
    debouncer.observe_path(path("A.md"), base);
    let hint = debouncer
        .poll(base + Duration::from_millis(100))
        .expect("ready");
    match hint {
        ChangeHint::Paths(paths) => {
            assert_eq!(paths.into_iter().collect::<Vec<_>>(), vec![path("A.md")]);
        }
        other => panic!("expected Paths, got {other:?}"),
    }
}

#[test]
fn new_activity_pushes_the_debounce_window_back_out() {
    let base = Instant::now();
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 10);
    debouncer.observe_path(path("A.md"), base);
    debouncer.observe_path(path("B.md"), base + Duration::from_millis(80));
    // 100ms after the first event but only 20ms after the second: not ready.
    assert_eq!(debouncer.poll(base + Duration::from_millis(100)), None);
    let hint = debouncer
        .poll(base + Duration::from_millis(180))
        .expect("ready");
    match hint {
        ChangeHint::Paths(paths) => {
            assert_eq!(
                paths.into_iter().collect::<Vec<_>>(),
                vec![path("A.md"), path("B.md")]
            );
        }
        other => panic!("expected Paths, got {other:?}"),
    }
}

#[test]
fn duplicate_paths_are_inserted_once() {
    let base = Instant::now();
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 10);
    debouncer.observe_path(path("A.md"), base);
    debouncer.observe_path(path("A.md"), base + Duration::from_millis(10));
    let hint = debouncer
        .poll(base + Duration::from_millis(110))
        .expect("ready");
    match hint {
        ChangeHint::Paths(paths) => {
            assert_eq!(paths.len(), 1);
        }
        other => panic!("expected Paths, got {other:?}"),
    }
}

#[test]
fn exceeding_max_dirty_paths_emits_a_single_overflow_hint() {
    let base = Instant::now();
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 2);
    debouncer.observe_path(path("A.md"), base);
    debouncer.observe_path(path("B.md"), base + Duration::from_millis(1));
    debouncer.observe_path(path("C.md"), base + Duration::from_millis(2));
    let hint = debouncer
        .poll(base + Duration::from_millis(102))
        .expect("ready");
    assert_eq!(hint, ChangeHint::Overflow);
}

#[test]
fn once_overflowed_further_detailed_paths_are_ignored_until_consumed() {
    let base = Instant::now();
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 1);
    debouncer.observe_path(path("A.md"), base);
    debouncer.observe_path(path("B.md"), base + Duration::from_millis(1));
    // Overflowed now. More paths keep arriving but must not be tracked.
    debouncer.observe_path(path("C.md"), base + Duration::from_millis(2));
    let hint = debouncer
        .poll(base + Duration::from_millis(102))
        .expect("ready");
    assert_eq!(hint, ChangeHint::Overflow);
    // After the overflow hint is consumed, state is reset and fresh paths
    // are tracked normally again.
    let base2 = base + Duration::from_millis(200);
    debouncer.observe_path(path("D.md"), base2);
    let hint2 = debouncer
        .poll(base2 + Duration::from_millis(100))
        .expect("ready");
    match hint2 {
        ChangeHint::Paths(paths) => {
            assert_eq!(paths.into_iter().collect::<Vec<_>>(), vec![path("D.md")]);
        }
        other => panic!("expected Paths, got {other:?}"),
    }
}

#[test]
fn root_invalidation_outranks_pending_paths() {
    let base = Instant::now();
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 10);
    debouncer.observe_path(path("A.md"), base);
    debouncer.observe_root_invalidated(base + Duration::from_millis(1));
    let hint = debouncer
        .poll(base + Duration::from_millis(101))
        .expect("ready");
    assert_eq!(hint, ChangeHint::RootInvalidated);
}

#[test]
fn watcher_failure_does_not_accumulate_across_multiple_failures() {
    let base = Instant::now();
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 10);
    debouncer.observe_watcher_failed("first".to_string(), base);
    debouncer.observe_watcher_failed("second".to_string(), base + Duration::from_millis(1));
    let hint = debouncer
        .poll(base + Duration::from_millis(101))
        .expect("ready");
    assert_eq!(hint, ChangeHint::WatcherFailed("second".to_string()));
}

#[test]
fn consuming_a_hint_resets_state_for_the_next_window() {
    let base = Instant::now();
    let mut debouncer = Debouncer::new(Duration::from_millis(100), 10);
    debouncer.observe_path(path("A.md"), base);
    debouncer.poll(base + Duration::from_millis(100));
    assert_eq!(debouncer.poll(base + Duration::from_millis(200)), None);
}
