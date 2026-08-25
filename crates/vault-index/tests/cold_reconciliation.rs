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
