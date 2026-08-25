mod common;

use vault_index::Generation;

#[test]
fn unchanged_normal_refresh_reads_and_parses_no_bodies() {
    let mut fixture = common::counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.reset_counts();

    let report = fixture.service.refresh(false).expect("warm refresh");

    assert_eq!(fixture.body_reads(), 0);
    assert_eq!(report.reparsed, 0);
    assert_eq!(report.previous_generation, Some(report.generation));
    assert_eq!(report.unchanged, 2);
}

#[test]
fn metadata_only_touch_reads_one_body_and_keeps_the_generation() {
    let mut fixture = common::counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.touch_note("One.md");
    fixture.reset_counts();

    let report = fixture.service.refresh(false).expect("warm refresh");

    assert_eq!(fixture.body_reads(), 1);
    assert_eq!(report.reparsed, 0);
    assert_eq!(report.previous_generation, Some(report.generation));
}

#[test]
fn content_edit_reads_and_parses_one_body_and_advances_the_generation() {
    let mut fixture = common::counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.write_note("One.md", "# One changed\n[[Two]]\n");
    fixture.reset_counts();

    let report = fixture.service.refresh(false).expect("warm refresh");

    assert_eq!(fixture.body_reads(), 1);
    assert_eq!(report.reparsed, 1);
    assert_eq!(report.changed, 1);
    assert_eq!(
        report.generation,
        Generation::new(report.previous_generation.unwrap().get() + 1)
    );
}

#[test]
fn added_note_reads_and_parses_one_body_and_advances_the_generation() {
    let mut fixture = common::counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.write_note("Three.md", "# Three\n");
    fixture.reset_counts();

    let report = fixture.service.refresh(false).expect("warm refresh");

    assert_eq!(fixture.body_reads(), 1);
    assert_eq!(report.reparsed, 1);
    assert_eq!(report.added, 1);
    assert_eq!(
        report.generation,
        Generation::new(report.previous_generation.unwrap().get() + 1)
    );
}

#[test]
fn deleted_note_reads_no_bodies_and_advances_the_generation() {
    let mut fixture = common::counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.delete_note("One.md");
    fixture.reset_counts();

    let report = fixture.service.refresh(false).expect("warm refresh");

    assert_eq!(fixture.body_reads(), 0);
    assert_eq!(report.reparsed, 0);
    assert_eq!(report.deleted, 1);
    assert_eq!(
        report.generation,
        Generation::new(report.previous_generation.unwrap().get() + 1)
    );
}

#[test]
fn same_size_same_mtime_edit_is_invisible_normally_and_found_verified() {
    let mut fixture = common::counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.write_note_preserving_fingerprint("One.md", "# One with EDIT\n");
    fixture.reset_counts();

    let normal = fixture.service.refresh(false).expect("normal refresh");
    assert_eq!(fixture.body_reads(), 0);
    assert_eq!(normal.previous_generation, Some(normal.generation));

    fixture.reset_counts();
    let verified = fixture.service.refresh(true).expect("verified refresh");
    assert_eq!(fixture.body_reads(), 2);
    assert_eq!(verified.reparsed, 1);
    assert_eq!(
        verified.generation,
        Generation::new(verified.previous_generation.unwrap().get() + 1)
    );
}

#[test]
fn verified_refresh_reads_every_body_when_nothing_changed() {
    let mut fixture = common::counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.reset_counts();

    let report = fixture.service.refresh(true).expect("verified refresh");

    assert_eq!(fixture.body_reads(), 2);
    assert_eq!(report.reparsed, 0);
    assert_eq!(report.previous_generation, Some(report.generation));
}
