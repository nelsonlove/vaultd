//! Clause 6's input, pinned where it is computed: the notes whose own bytes
//! did not change but one of whose references now resolves differently.

mod common;

use std::collections::BTreeSet;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{ChangeCause, IndexConfig, IndexService};

fn paths(names: &[&str]) -> BTreeSet<VaultPath> {
    names
        .iter()
        .map(|name| VaultPath::new(*name).unwrap())
        .collect()
}

#[test]
fn a_source_whose_reference_reresolves_is_reported_and_a_body_edit_is_not() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    std::fs::write(
        vault.path().join("R.md"),
        "---\nref: \"[[Target]]\"\n---\n[[Target]]\n",
    )
    .unwrap();
    let config = IndexConfig::explicit(vault.path(), index.path().join("i.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let target = paths(&["Target.md"]);

    std::fs::write(vault.path().join("Target.md"), "# Target\n").unwrap();
    let created = service
        .refresh_paths(target.clone(), ChangeCause::Watcher)
        .unwrap();
    assert_eq!(created.reresolved, vec![VaultPath::new("R.md").unwrap()]);

    std::fs::write(vault.path().join("Target.md"), "# Target\n\nmore\n").unwrap();
    let edited = service
        .refresh_paths(target.clone(), ChangeCause::Watcher)
        .unwrap();
    assert!(
        edited.reresolved.is_empty(),
        "a body edit moves no resolution: {:?}",
        edited.reresolved
    );

    std::fs::remove_file(vault.path().join("Target.md")).unwrap();
    let deleted = service.refresh_paths(target, ChangeCause::Watcher).unwrap();
    assert_eq!(
        deleted.reresolved,
        vec![VaultPath::new("R.md").unwrap()],
        "a target vanishing re-resolves its sources too"
    );
}

/// A source whose own bytes changed is already in the change set, so it is
/// never reported twice; only the untouched source is.
#[test]
fn a_changed_source_is_not_reported_as_reresolved() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    std::fs::write(vault.path().join("R.md"), "[[Target]]\n").unwrap();
    std::fs::write(vault.path().join("S.md"), "[[Target]]\n").unwrap();
    let config = IndexConfig::explicit(vault.path(), index.path().join("i.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();

    std::fs::write(vault.path().join("Target.md"), "# Target\n").unwrap();
    std::fs::write(vault.path().join("S.md"), "[[Target]] again\n").unwrap();
    let report = service
        .refresh_paths(paths(&["Target.md", "S.md"]), ChangeCause::Watcher)
        .unwrap();
    assert_eq!(report.reresolved, vec![VaultPath::new("R.md").unwrap()]);
    assert!(
        report
            .changes
            .modified
            .contains(&VaultPath::new("S.md").unwrap())
    );
}
