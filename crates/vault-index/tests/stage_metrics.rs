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
    assert_eq!(metrics.work.complete_inventories, 2);
    assert!(metrics.work.references_resolved >= 1);
    assert!(metrics.work.resolution_rows_written >= 1);
}
