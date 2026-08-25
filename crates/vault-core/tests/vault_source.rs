use std::fs;

use tempfile::TempDir;
use vault_core::{FileSystemVaultSource, VaultSource, read_documents};

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
