//! Deterministic, filesystem-free coverage of path inclusion, paralleling
//! `vault_core::FileSystemVaultSource`'s inclusion fixture
//! (`lists_markdown_in_vault_path_order_and_excludes_internal_directories`).

use std::path::PathBuf;

use vault_watch::{WatchError, normalize_included_markdown, normalize_included_path};

/// The one configuration file the watcher passes through: the declared
/// property types, which Obsidian writes itself and which retype Bases
/// views. Its siblings and anything deeper under `.obsidian/` stay dropped,
/// and the Markdown view still drops it (it is not a note).
#[test]
fn passes_only_the_property_types_file_out_of_the_config_directory() {
    let path = |relative: &str| {
        normalize_included_path(&root(), &root().join(relative))
            .expect("no error")
            .map(|hint| hint.as_str().to_string())
    };
    assert_eq!(
        path(".obsidian/types.json").as_deref(),
        Some(".obsidian/types.json")
    );
    assert_eq!(
        path(".Obsidian/Types.JSON").as_deref(),
        Some(".Obsidian/Types.JSON"),
        "matched without regard to case, in the spelling the event carried"
    );
    for dropped in [
        ".obsidian/app.json",
        ".obsidian/types.json.tmp",
        ".obsidian/plugins/x/data.json",
        ".obsidian/plugins/types.json",
        ".hidden/types.json",
        "Notes/.obsidian/types.json",
    ] {
        assert_eq!(path(dropped), None, "{dropped} stays dropped");
    }
    assert_eq!(
        normalize_included_markdown(&root(), &root().join(".obsidian/types.json"))
            .expect("no error"),
        None
    );
}

fn root() -> PathBuf {
    PathBuf::from("/vault")
}

#[test]
fn includes_a_top_level_markdown_file() {
    let hint = normalize_included_markdown(&root(), &root().join("A.md"))
        .expect("no error")
        .expect("included");
    assert_eq!(hint.as_str(), "A.md");
}

#[test]
fn includes_a_nested_markdown_file_with_forward_slashes() {
    let hint = normalize_included_markdown(&root(), &root().join("Zed/B.md"))
        .expect("no error")
        .expect("included");
    assert_eq!(hint.as_str(), "Zed/B.md");
}

#[test]
fn excludes_the_obsidian_config_directory() {
    let hint = normalize_included_markdown(&root(), &root().join(".obsidian/config.md"))
        .expect("no error");
    assert_eq!(hint, None);
}

#[test]
fn excludes_any_hidden_directory() {
    let hint =
        normalize_included_markdown(&root(), &root().join(".hidden/note.md")).expect("no error");
    assert_eq!(hint, None);
}

#[test]
fn a_hidden_file_name_itself_is_not_excluded() {
    // Parity with FileSystemVaultSource: only directory components are
    // filtered for a leading dot, not the final file name.
    let hint = normalize_included_markdown(&root(), &root().join(".hidden-note.md"))
        .expect("no error")
        .expect("included");
    assert_eq!(hint.as_str(), ".hidden-note.md");
}

#[test]
fn excludes_non_markdown_files() {
    let hint = normalize_included_markdown(&root(), &root().join("ignored.txt")).expect("no error");
    assert_eq!(hint, None);
}

#[test]
fn excludes_paths_outside_the_vault_root() {
    let hint =
        normalize_included_markdown(&root(), &PathBuf::from("/other/A.md")).expect("no error");
    assert_eq!(hint, None);
}

#[test]
fn rejects_dot_dot_escapes_even_when_lexically_inside_looking() {
    // `/vault/sub/../../outside.md` lexically resolves to `/outside.md`,
    // which is outside the root — must not be treated as included.
    let event = root().join("sub/../../outside.md");
    let hint = normalize_included_markdown(&root(), &event).expect("no error");
    assert_eq!(hint, None);
}

#[test]
fn supports_paths_that_no_longer_exist_on_disk() {
    // No filesystem access happens inside the function at all, so a path to
    // an already-deleted file resolves the same as any other.
    let event = root().join("Deleted/Gone.md");
    let hint = normalize_included_markdown(&root(), &event)
        .expect("no error")
        .expect("included");
    assert_eq!(hint.as_str(), "Deleted/Gone.md");
}

#[cfg(unix)]
#[test]
fn rejects_non_utf8_path_components() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let bad_component = OsString::from_vec(vec![0x66, 0x6f, 0xff, b'.', b'm', b'd']);
    let event = root().join(bad_component);
    let error = normalize_included_markdown(&root(), &event).expect_err("invalid utf-8");
    assert!(matches!(error, WatchError::InvalidPath(_)));
}
