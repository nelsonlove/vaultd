use std::path::PathBuf;

use vault_core::{FileSystemVaultSource, build_graph, parse_note, read_documents, scan_vault};

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/semantic-read-path/basic-vault")
}

#[test]
fn building_from_parsed_notes_matches_scan_vault() {
    let source = FileSystemVaultSource::new(fixture_root()).expect("fixture source");
    let scanned = scan_vault(&source).expect("scan fixture");
    let documents = read_documents(&source).expect("read fixture");
    let rebuilt = build_graph(
        documents.documents.into_iter().map(parse_note).collect(),
        documents.diagnostics,
    );

    assert_eq!(rebuilt.graph.note_paths(), scanned.graph.note_paths());
    assert_eq!(rebuilt.diagnostics, scanned.diagnostics);
    for path in scanned.graph.note_paths() {
        assert_eq!(rebuilt.graph.outgoing(path), scanned.graph.outgoing(path));
        assert_eq!(rebuilt.graph.backlinks(path), scanned.graph.backlinks(path));
    }
    assert_eq!(rebuilt.graph.unresolved(), scanned.graph.unresolved());
    assert_eq!(rebuilt.graph.ambiguous(), scanned.graph.ambiguous());
}
