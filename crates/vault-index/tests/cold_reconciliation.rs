mod common;

use std::fs;

use tempfile::tempdir;
use vault_index::{Generation, IndexConfig, IndexService};

#[test]
fn cold_refresh_publishes_generation_one_atomically() {
    let vault = tempdir().expect("vault tempdir");
    let index = tempdir().expect("index tempdir");
    fs::write(vault.path().join("A.md"), "# A\n[[B]]\n").expect("write A");
    fs::write(vault.path().join("B.md"), "# B\n").expect("write B");
    let config =
        IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).expect("config");
    let mut service = IndexService::open(config).expect("open service");

    assert_eq!(service.current_generation().expect("generation"), None);
    let report = service.refresh(false).expect("cold refresh");

    assert_eq!(report.previous_generation, None);
    assert_eq!(report.generation, Generation::new(1));
    assert_eq!(report.added, 2);
    assert_eq!(report.reparsed, 2);
    assert_eq!(
        service.current_generation().unwrap(),
        Some(Generation::new(1))
    );
    let snapshot = service.snapshot_for_test().expect("stored graph");
    let a = snapshot
        .graph
        .note(&vault_core::VaultPath::new("A.md").unwrap())
        .expect("stored A");
    assert_eq!(a.source.text(), "# A\n[[B]]\n");
    assert_eq!(
        snapshot
            .graph
            .outgoing(&vault_core::VaultPath::new("A.md").unwrap())
            .len(),
        1
    );
}

#[test]
fn fixture_cold_build_matches_the_core_scan_oracle() {
    let mut fixture = common::open_fixture_service();
    let report = fixture.service.refresh(false).expect("cold refresh");
    let indexed = fixture
        .service
        .snapshot_for_test()
        .expect("indexed snapshot");

    assert_eq!(report.generation, Generation::new(1));
    common::assert_semantically_equivalent(&indexed, &fixture.scan);
    common::assert_vault_digest_unchanged(&fixture);
}

/// A note body that panics the upstream Markdown parser must not abort the
/// scan. This is the route that made the defect serious: it needs no request
/// at all — merely *having* the file in the vault aborted the daemon on the
/// next refresh. Reproduced against `markdown` 1.0.0's `to_mdast.rs:193`
/// ("Cannot push to non-parent").
#[test]
fn a_note_whose_body_panics_the_markdown_parser_does_not_abort_the_scan() {
    let vault = tempdir().expect("vault tempdir");
    let index = tempdir().expect("index tempdir");
    fs::write(
        vault.path().join("Poison.md"),
        "---\ntitle: x\n---\na\n-\n--\nA\n-\n",
    )
    .expect("write the poisoned note");
    fs::write(vault.path().join("Ok.md"), "# Ok\n[[Poison]]\n").expect("write a neighbour");
    let config =
        IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).expect("config");
    let mut service = IndexService::open(config).expect("open service");

    let report = service.refresh(false).expect("the scan completes");
    assert_eq!(report.added, 2, "both notes index");

    // The poisoned note keeps its frontmatter; only its body semantics are
    // lost, and its neighbour is entirely unaffected.
    let snapshot = service.snapshot_for_test().expect("stored graph");
    assert!(
        snapshot
            .graph
            .note(&vault_core::VaultPath::new("Poison.md").unwrap())
            .is_some(),
        "the poisoned note is still indexed"
    );
    assert_eq!(
        snapshot
            .graph
            .outgoing(&vault_core::VaultPath::new("Ok.md").unwrap())
            .len(),
        1,
        "its neighbour's link is unaffected"
    );
}
