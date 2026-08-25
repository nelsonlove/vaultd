use std::fs;

use tempfile::tempdir;
use vault_core::VaultPath;
use vault_index::{FileSystemIndexSource, ReconcileSource};

#[test]
fn inventory_is_sorted_and_contains_only_lightweight_fingerprints() {
    let vault = tempdir().expect("vault tempdir");
    fs::create_dir_all(vault.path().join("Folder")).expect("create folder");
    fs::create_dir_all(vault.path().join(".obsidian")).expect("create hidden folder");
    fs::write(vault.path().join("z.md"), b"# Z").expect("write z");
    fs::write(vault.path().join("Folder/a.md"), b"# A").expect("write a");
    fs::write(vault.path().join(".obsidian/ignored.md"), b"# ignored").expect("write ignored");

    let source = FileSystemIndexSource::new(vault.path()).expect("index source");
    let snapshot = source.inventory().expect("inventory");
    let paths: Vec<_> = snapshot.entries.keys().map(VaultPath::as_str).collect();

    assert_eq!(paths, vec!["Folder/a.md", "z.md"]);
    assert_eq!(snapshot.entries[&VaultPath::new("z.md").unwrap()].size, 3);
}

#[test]
fn reading_is_explicit_and_reuses_core_containment_checks() {
    let vault = tempdir().expect("vault tempdir");
    fs::write(vault.path().join("Note.md"), b"exact bytes").expect("write note");
    let source = FileSystemIndexSource::new(vault.path()).expect("index source");

    assert_eq!(
        source
            .read_bytes(&VaultPath::new("Note.md").unwrap())
            .expect("read note"),
        b"exact bytes"
    );
}
