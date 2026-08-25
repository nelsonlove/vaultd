mod common;

use std::fs;

use proptest::prelude::*;
use tempfile::tempdir;
use vault_core::{FileSystemVaultSource, scan_vault};
use vault_index::{IndexConfig, IndexService};

fn assert_matches_fresh_scan(service: &IndexService, root: &std::path::Path) {
    let source = FileSystemVaultSource::new(root).expect("fresh scan source");
    let fresh = scan_vault(&source).expect("fresh scan");
    assert_eq!(
        common::snapshot_from_index(service),
        common::snapshot_from_scan(&fresh),
    );
}

#[test]
fn mixed_changes_match_a_fresh_scan_after_every_generation() {
    let vault = tempdir().expect("vault");
    let index = tempdir().expect("index");
    fs::write(vault.path().join("A.md"), "# A\n[[B]]\n").unwrap();
    fs::write(vault.path().join("B.md"), "# B\n").unwrap();
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();

    service.refresh(false).unwrap();
    assert_matches_fresh_scan(&service, vault.path());

    fs::write(vault.path().join("B.md"), "# B changed\n[[Missing]]\n").unwrap();
    service.refresh(false).unwrap();
    assert_matches_fresh_scan(&service, vault.path());

    fs::write(vault.path().join("C.md"), "# C\n[[A#A]]\n").unwrap();
    service.refresh(false).unwrap();
    assert_matches_fresh_scan(&service, vault.path());

    fs::remove_file(vault.path().join("A.md")).unwrap();
    service.refresh(false).unwrap();
    assert_matches_fresh_scan(&service, vault.path());
}

#[derive(Clone, Debug)]
enum Change {
    Write { slot: u8, body: String },
    Delete { slot: u8 },
}

fn body_strategy() -> impl proptest::strategy::Strategy<Value = String> {
    proptest::prop_oneof![
        proptest::strategy::Just("# Heading\n".to_string()),
        (0u8..8).prop_map(|slot| format!("# Note\n[[Note-{slot}]]\n")),
        (0u8..8).prop_map(|slot| format!("---\ntags: [tag/{slot}]\n---\n# Tagged\n")),
        proptest::strategy::Just("---\nbroken: [\n---\n[[Missing]]\n".to_string()),
    ]
}

fn change_strategy() -> impl proptest::strategy::Strategy<Value = Change> {
    proptest::prop_oneof![
        (0u8..8, body_strategy()).prop_map(|(slot, body)| Change::Write { slot, body }),
        (0u8..8).prop_map(|slot| Change::Delete { slot }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn incremental_state_matches_full_scan(
        changes in prop::collection::vec(change_strategy(), 1..=30)
    ) {
        let vault = tempfile::tempdir().expect("vault");
        let index = tempfile::tempdir().expect("index");
        let config = vault_index::IndexConfig::explicit(
            vault.path(),
            index.path().join("index.sqlite3"),
        )
        .expect("config");
        let mut service = vault_index::IndexService::open(config).expect("service");

        for change in changes {
            match change {
                Change::Write { slot, body } => {
                    std::fs::write(vault.path().join(format!("Note-{slot}.md")), body)
                        .expect("write generated note");
                }
                Change::Delete { slot } => {
                    match std::fs::remove_file(vault.path().join(format!("Note-{slot}.md"))) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => panic!("delete generated note: {error}"),
                    }
                }
            }
            service.refresh(true).expect("verified incremental refresh");
            assert_matches_fresh_scan(&service, vault.path());
        }
    }
}
