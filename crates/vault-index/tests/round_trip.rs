mod common;

use vault_core::VaultPath;
use vault_index::FileFingerprint;

#[test]
fn parsed_note_round_trip_preserves_source_semantics_spans_and_order() {
    let mut fixture = common::open_fixture_store();
    let path = VaultPath::new("Properties and aliases.md").expect("valid path");
    let original = fixture
        .scan
        .graph
        .note(&path)
        .expect("fixture note")
        .clone();
    let fingerprint = FileFingerprint {
        size: original.source.text().len() as u64,
        modified_seconds: 123,
        modified_nanos: 456,
    };

    fixture
        .store
        .write_note_for_test(&original, fingerprint)
        .expect("persist note");
    let loaded = fixture
        .store
        .load_note_for_test(&path)
        .expect("load note")
        .expect("stored note");

    assert_eq!(loaded.source, original.source);
    assert_eq!(loaded.properties, original.properties);
    assert_eq!(loaded.aliases, original.aliases);
    assert_eq!(loaded.headings, original.headings);
    assert_eq!(loaded.blocks, original.blocks);
    assert_eq!(loaded.tags, original.tags);
    assert_eq!(loaded.references, original.references);
    assert_eq!(loaded.diagnostics, original.diagnostics);
}

#[test]
fn graph_round_trip_preserves_resolutions_candidates_and_diagnostics() {
    let mut fixture = common::open_fixture_store();
    fixture.persist_complete_fixture().expect("persist graph");
    let loaded = fixture.store.load_graph_for_test().expect("load graph");

    assert_eq!(loaded.diagnostics, fixture.scan.diagnostics);
    for path in fixture.scan.graph.note_paths() {
        assert_eq!(
            loaded.graph.outgoing(path),
            fixture.scan.graph.outgoing(path)
        );
        assert_eq!(
            loaded.graph.backlinks(path),
            fixture.scan.graph.backlinks(path)
        );
    }
    assert_eq!(loaded.graph.unresolved(), fixture.scan.graph.unresolved());
    assert_eq!(loaded.graph.ambiguous(), fixture.scan.graph.ambiguous());
}
