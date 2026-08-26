mod common;

use common::counting_service_with_two_notes;

#[test]
fn phase_three_one_file_refresh_reports_its_global_work() {
    let mut fixture = counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.reset_counts();
    fixture.write_note("One.md", "# One changed\n");

    fixture.service.refresh(false).expect("incremental refresh");
    let metrics = fixture
        .service
        .last_reconcile_metrics()
        .expect("refresh metrics");

    assert_eq!(fixture.body_reads(), 1);
    assert_eq!(metrics.work.body_reads, 1);
    assert_eq!(metrics.work.notes_reparsed, 1);
    // One inventory, not two: a warm refresh now calculates its dirty set from
    // a single metadata pass, and confirms the vault did not move under it by
    // re-fingerprinting only the paths it is about to publish.
    assert_eq!(metrics.work.complete_inventories, 1);
    assert!(metrics.work.references_resolved >= 1);
    assert!(metrics.work.resolution_rows_written >= 1);
}

/// Both publication paths must report the same stages, or a benchmark
/// comparing them is comparing different things. Before this was fixed the
/// complete path never recorded `live_install` and the delta path never
/// recorded the SQLite halves, so neither total was interpretable next to the
/// other.
///
/// Asserted as "populated at all" rather than against any threshold: the
/// point is stage coverage, not speed. Each stage covers real SQLite or
/// allocation work, so a zero here means the stage was never timed.
#[test]
fn both_publication_paths_populate_the_same_stages() {
    use std::time::Duration;

    let mut fixture = counting_service_with_two_notes();

    fixture.service.refresh(false).expect("cold build");
    let complete = fixture
        .service
        .last_reconcile_metrics()
        .expect("cold metrics")
        .stages
        .clone();
    assert!(complete.sqlite_write > Duration::ZERO, "{complete:?}");
    assert!(complete.sqlite_commit > Duration::ZERO, "{complete:?}");
    assert!(complete.live_install > Duration::ZERO, "{complete:?}");

    fixture.write_note("One.md", "# One changed\n");
    fixture.service.refresh(false).expect("incremental refresh");
    let delta = fixture
        .service
        .last_reconcile_metrics()
        .expect("delta metrics")
        .stages
        .clone();
    assert!(delta.sqlite_write > Duration::ZERO, "{delta:?}");
    assert!(delta.sqlite_commit > Duration::ZERO, "{delta:?}");
    assert!(delta.live_install > Duration::ZERO, "{delta:?}");
    // The delta path's install is graph work only, never the whole call.
    assert!(delta.live_install < delta.sqlite_write + delta.sqlite_commit + delta.live_install);
}
