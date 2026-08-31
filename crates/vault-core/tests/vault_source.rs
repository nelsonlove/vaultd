use std::fs;

use tempfile::TempDir;
use vault_core::{FileSystemVaultSource, TreeEntryKind, VaultPath, VaultSource, read_documents};

#[test]
fn lists_markdown_in_vault_path_order_and_excludes_internal_directories() {
    let root = TempDir::new().expect("temp vault");
    fs::create_dir_all(root.path().join("Zed")).expect("create Zed");
    fs::create_dir_all(root.path().join(".obsidian")).expect("create internal dir");
    fs::create_dir_all(root.path().join(".hidden")).expect("create hidden dir");
    fs::write(root.path().join("Zed/B.md"), "B").expect("write B");
    fs::write(root.path().join("A.md"), "A").expect("write A");
    fs::write(root.path().join("ignored.txt"), "text").expect("write text");
    fs::write(root.path().join(".obsidian/config.md"), "config").expect("write config");
    fs::write(root.path().join(".hidden/note.md"), "hidden").expect("write hidden");

    let source = FileSystemVaultSource::new(root.path()).expect("valid vault root");
    let listing = source.markdown_paths().expect("list vault");
    let paths = listing.paths.iter().map(|p| p.as_str()).collect::<Vec<_>>();

    assert_eq!(paths, ["A.md", "Zed/B.md"]);
    assert!(listing.diagnostics.is_empty());
}

#[test]
fn the_markdown_listing_is_a_filtered_view_of_the_same_walk() {
    let root = TempDir::new().expect("temp vault");
    fs::create_dir_all(root.path().join("Zed")).expect("create Zed");
    fs::create_dir_all(root.path().join("Empty")).expect("create empty folder");
    fs::create_dir_all(root.path().join(".obsidian")).expect("create internal dir");
    fs::write(root.path().join("Zed/B.md"), "B").expect("write B");
    fs::write(root.path().join("A.md"), "A").expect("write A");
    fs::write(root.path().join("ignored.txt"), "text").expect("write text");
    fs::write(root.path().join(".obsidian/config.md"), "config").expect("write config");

    let source = FileSystemVaultSource::new(root.path()).expect("valid vault root");
    let scan = source.scan().expect("scan vault");
    let listing = source.markdown_paths().expect("list vault");

    // The Markdown half is identical either way — that is what makes the tree
    // an addition rather than a change to the semantic pipeline.
    assert_eq!(scan.paths, listing.paths);
    assert_eq!(scan.diagnostics, listing.diagnostics);

    let entries = scan
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry.kind))
        .collect::<Vec<_>>();
    assert_eq!(
        entries,
        [
            ("A.md", TreeEntryKind::Note),
            ("Empty", TreeEntryKind::Folder),
            ("Zed", TreeEntryKind::Folder),
            ("Zed/B.md", TreeEntryKind::Note),
            ("ignored.txt", TreeEntryKind::File),
        ]
    );
}

#[test]
fn one_paths_tree_entry_matches_what_the_walk_reported() {
    let root = TempDir::new().expect("temp vault");
    fs::create_dir_all(root.path().join(".obsidian")).expect("create internal dir");
    fs::write(root.path().join(".obsidian/config.md"), "config").expect("write config");
    fs::write(root.path().join("A.md"), "A").expect("write A");

    let source = FileSystemVaultSource::new(root.path()).expect("valid vault root");
    let scan = source.scan().expect("scan vault");

    for entry in &scan.entries {
        assert_eq!(
            source.tree_entry(&entry.path).expect("stat one path"),
            Some(entry.clone()),
            "the per-path stat and the walk must agree about {}",
            entry.path.as_str()
        );
    }

    for hidden in [".obsidian", ".obsidian/config.md"] {
        let path = VaultPath::new(hidden).expect("valid vault path");
        assert_eq!(
            source.tree_entry(&path).expect("stat hidden path"),
            None,
            "hidden territory is excluded by the index's own rule, not only the watcher's"
        );
    }

    let absent = VaultPath::new("Gone.md").expect("valid vault path");
    assert_eq!(source.tree_entry(&absent).expect("stat absent path"), None);
}

#[test]
fn invalid_utf8_is_diagnosed_and_other_notes_continue() {
    let root = TempDir::new().expect("temp vault");
    fs::write(root.path().join("Good.md"), "# Good\n").expect("write good note");
    fs::write(root.path().join("Bad.md"), [0xff, 0xfe]).expect("write invalid note");

    let source = FileSystemVaultSource::new(root.path()).expect("valid vault root");
    let result = read_documents(&source).expect("root remains scannable");

    assert_eq!(result.documents.len(), 1);
    assert_eq!(result.documents[0].path().as_str(), "Good.md");
    assert!(result.diagnostics.iter().any(|d| {
        d.path
            .as_ref()
            .is_some_and(|path| path.as_str() == "Bad.md")
    }));
}

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::os::unix::fs::symlink;

    use tempfile::TempDir;
    use vault_core::{DiagnosticCode, FileSystemVaultSource, VaultSource};

    #[test]
    fn directory_symlinks_are_not_traversed() {
        let root = TempDir::new().expect("temp vault");
        let outside = TempDir::new().expect("outside dir");
        fs::write(outside.path().join("Outside.md"), "outside").expect("write outside note");
        symlink(outside.path(), root.path().join("Linked")).expect("create dir symlink");
        fs::write(root.path().join("Inside.md"), "inside").expect("write inside note");

        let source = FileSystemVaultSource::new(root.path()).expect("valid vault root");
        let listing = source.markdown_paths().expect("list vault");
        let paths = listing.paths.iter().map(|p| p.as_str()).collect::<Vec<_>>();

        assert_eq!(paths, ["Inside.md"]);
    }

    #[test]
    fn symlinked_markdown_inside_the_vault_is_included() {
        let root = TempDir::new().expect("temp vault");
        fs::write(root.path().join("Real.md"), "# Real\n").expect("write real note");
        symlink(root.path().join("Real.md"), root.path().join("Alias.md"))
            .expect("create file symlink");

        let source = FileSystemVaultSource::new(root.path()).expect("valid vault root");
        let listing = source.markdown_paths().expect("list vault");
        let paths = listing.paths.iter().map(|p| p.as_str()).collect::<Vec<_>>();

        assert_eq!(paths, ["Alias.md", "Real.md"]);
        assert!(listing.diagnostics.is_empty());
    }

    #[test]
    fn symlinked_markdown_escaping_the_vault_is_skipped_with_a_diagnostic() {
        let root = TempDir::new().expect("temp vault");
        let outside = TempDir::new().expect("outside dir");
        fs::write(outside.path().join("Secret.md"), "secret").expect("write outside note");
        symlink(
            outside.path().join("Secret.md"),
            root.path().join("Escape.md"),
        )
        .expect("create escaping symlink");

        let source = FileSystemVaultSource::new(root.path()).expect("valid vault root");
        let listing = source.markdown_paths().expect("list vault");
        let paths = listing.paths.iter().map(|p| p.as_str()).collect::<Vec<_>>();

        assert!(paths.is_empty());
        assert!(listing.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == DiagnosticCode::SymlinkOutsideVault
                && diagnostic
                    .path
                    .as_ref()
                    .is_some_and(|path| path.as_str() == "Escape.md")
        }));
    }
}
