//! Folder operations and the three delete dispositions.

use std::collections::BTreeSet;
use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{DeleteMode, Mutation, MutationEngine, MutationError, Precondition, revision_of};

struct Fixture {
    engine: MutationEngine,
    root: PathBuf,
    _vault: TempDir,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder/Deep")).expect("create Folder/Deep");
    std::fs::create_dir_all(root.join("Empty")).expect("create Empty");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    std::fs::write(root.join("Folder/Two.md"), "# Two\n").expect("write Two");
    std::fs::write(root.join("Folder/Deep/Three.md"), "# Three\n").expect("write Three");
    Fixture {
        engine: MutationEngine::new(&root),
        root,
        _vault: vault,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

#[test]
fn creating_a_folder_chain_creates_every_missing_segment() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("A/B/C"),
        })
        .expect("mkdir -p semantics");
    assert!(fixture.root.join("A/B/C").is_dir());
}

#[test]
fn creating_a_folder_that_already_exists_succeeds_idempotently() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("Empty"),
        })
        .expect("an existing folder is success, not a conflict");
}

#[test]
fn creating_a_folder_where_a_file_sits_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("One.md"),
        })
        .expect_err("a file occupies the name");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
}

#[test]
fn a_permanent_delete_removes_the_file_and_names_it_as_changed() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("One.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect("delete under a matching revision");
    assert!(!fixture.root.join("One.md").exists());
    assert_eq!(outcome.changed_paths, BTreeSet::from([path("One.md")]));
    assert_eq!(
        outcome.revision, None,
        "a deleted file has no revision to report"
    );
}

#[test]
fn a_local_trash_delete_moves_the_file_into_the_vaults_own_trash() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Folder/Two.md"),
            mode: Some(DeleteMode::TrashLocal),
            expected: Precondition::Any,
        })
        .expect("delete into the local trash");
    assert!(!fixture.root.join("Folder/Two.md").exists());
    assert_eq!(
        std::fs::read(fixture.root.join(".trash/Two.md")).expect("read the trashed file"),
        b"# Two\n"
    );

    // `trash_local` is only safe because `.trash` is a dot-directory and the
    // scanner's hidden-directory rule skips it. Asserted rather than assumed:
    // if that rule ever changed, every locally-trashed note would reappear as
    // a live note at a new path, and this is where that shows up.
    let source = vault_core::FileSystemVaultSource::new(&fixture.root).expect("scan source");
    let scanned = vault_core::scan_vault(&source).expect("scan the vault");
    let paths: Vec<String> = scanned
        .graph
        .note_paths()
        .into_iter()
        .map(|path| path.as_str().to_string())
        .collect();
    assert!(
        paths.iter().all(|path| !path.starts_with(".trash/")),
        "the local trash must be invisible to the scanner: {paths:?}"
    );
}

#[test]
fn a_second_local_trash_delete_of_the_same_name_is_numbered_rather_than_clobbered() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Folder/Two.md"),
            mode: Some(DeleteMode::TrashLocal),
            expected: Precondition::Any,
        })
        .expect("first delete");
    std::fs::write(fixture.root.join("Folder/Two.md"), "# Two again\n").expect("recreate Two");
    fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Folder/Two.md"),
            mode: Some(DeleteMode::TrashLocal),
            expected: Precondition::Any,
        })
        .expect("second delete");
    assert_eq!(
        std::fs::read(fixture.root.join(".trash/Two.md")).expect("first trashed file"),
        b"# Two\n"
    );
    assert_eq!(
        std::fs::read(fixture.root.join(".trash/Two 1.md")).expect("second trashed file"),
        b"# Two again\n"
    );
}

/// The addressable surface is one set of paths, not two. `write_note` refuses
/// a path the scan never lists, and so does the delete: what reached the
/// local trash is out of the vault's semantic world, and a client that could
/// delete inside `.trash` could remove a file it can neither read nor write
/// through the same daemon.
#[test]
fn deleting_inside_the_local_trash_is_refused() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Folder/Two.md"),
            mode: Some(DeleteMode::TrashLocal),
            expected: Precondition::Any,
        })
        .expect("delete into the local trash");
    let error = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path(".trash/Two.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect_err("the trash is not an addressable path");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(fixture.root.join(".trash/Two.md").is_file());
}

/// Whether this vault's filesystem folds case, asked of the filesystem rather
/// than assumed of the platform: the two tests below assert what a *fold*
/// reports, and on a case-sensitive volume there is no fold to report.
fn folds_case(fixture: &Fixture) -> bool {
    fixture.root.join("folder").is_dir()
}

#[test]
fn a_delete_reports_the_spelling_the_filesystem_stores() {
    let fixture = fixture();
    if !folds_case(&fixture) {
        return;
    }
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("folder/two.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect("a folded spelling reaches the stored file");
    assert!(!fixture.root.join("Folder/Two.md").exists());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Folder/Two.md")]),
        "the caller's spelling would key a row no scan emits, and the real one would outlive the file"
    );
}

#[test]
fn a_folder_delete_enumerates_under_the_stored_spelling() {
    let fixture = fixture();
    if !folds_case(&fixture) {
        return;
    }
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("folder"),
            mode: Some(DeleteMode::Permanent),
            recursive: true,
        })
        .expect("a folded folder spelling reaches the stored folder");
    assert!(!fixture.root.join("Folder").exists());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Folder/Two.md"), path("Folder/Deep/Three.md")]),
        "every removed note is named as the scanner would name it"
    );
}

/// The payload cap governs what a client hands the daemon, never what the
/// daemon reads to check a precondition. Capping the delete path would make a
/// file larger than the cap permanently undeletable — a refusal with no
/// remedy, since the caller cannot shrink a file through an interface that
/// will not touch it.
#[test]
fn the_payload_cap_never_governs_a_delete() {
    let fixture = fixture();
    let engine = MutationEngine::new(&fixture.root).with_max_file_bytes(2);
    engine
        .apply(&Mutation::DeleteNote {
            path: path("One.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect("an unconditional delete stats the target and reads nothing");
    engine
        .apply(&Mutation::DeleteNote {
            path: path("Folder/Two.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Revision(revision_of(b"# Two\n")),
        })
        .expect("a guarded delete hashes the target whatever its size");
    assert!(!fixture.root.join("One.md").exists());
    assert!(!fixture.root.join("Folder/Two.md").exists());
}

#[test]
fn deleting_an_absent_note_is_never_a_silent_success() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Gone.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect_err("deletion is never idempotent-silent");
    assert!(
        matches!(error, MutationError::NotFound { .. }),
        "expected not_found, got {error:?}"
    );
}

#[test]
fn an_absent_precondition_is_meaningless_for_a_delete() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("One.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Absent,
        })
        .expect_err("expected-absent cannot guard a delete");
    assert!(
        matches!(error, MutationError::InvalidPrecondition { .. }),
        "expected invalid_precondition, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
}

#[test]
fn deleting_a_non_empty_folder_without_recursive_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("Folder"),
            mode: Some(DeleteMode::Permanent),
            recursive: false,
        })
        .expect_err("a non-empty folder needs recursive");
    assert!(
        matches!(error, MutationError::FolderNotEmpty { .. }),
        "expected folder_not_empty, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Two.md").is_file());
}

#[test]
fn a_recursive_folder_delete_names_every_note_it_removed() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("Folder"),
            mode: Some(DeleteMode::Permanent),
            recursive: true,
        })
        .expect("recursive delete");
    assert!(!fixture.root.join("Folder").exists());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Folder/Two.md"), path("Folder/Deep/Three.md")]),
        "every removed note must reach reconciliation, or its rows survive it"
    );
}

#[test]
fn an_empty_folder_delete_needs_no_recursive_flag() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("Empty"),
            mode: Some(DeleteMode::Permanent),
            recursive: false,
        })
        .expect("an empty folder deletes without ceremony");
    assert!(!fixture.root.join("Empty").exists());
    assert!(outcome.changed_paths.is_empty());
    assert!(
        !outcome.semantic,
        "no note was removed, so nothing the semantic layer indexes moved"
    );
}

#[test]
fn the_default_delete_mode_comes_from_the_vaults_own_app_json() {
    let fixture = fixture();
    assert_eq!(
        fixture.engine.configured_delete_mode(),
        DeleteMode::TrashSystem,
        "Obsidian's own default is the system trash"
    );

    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    std::fs::write(
        fixture.root.join(".obsidian/app.json"),
        r#"{"trashOption":"local","alwaysUpdateLinks":true}"#,
    )
    .expect("write app.json");
    assert_eq!(
        fixture.engine.configured_delete_mode(),
        DeleteMode::TrashLocal
    );

    std::fs::write(
        fixture.root.join(".obsidian/app.json"),
        r#"{"trashOption":"none"}"#,
    )
    .expect("rewrite app.json");
    assert_eq!(
        fixture.engine.configured_delete_mode(),
        DeleteMode::Permanent
    );

    std::fs::write(fixture.root.join(".obsidian/app.json"), "not json at all")
        .expect("corrupt app.json");
    assert_eq!(
        fixture.engine.configured_delete_mode(),
        DeleteMode::TrashSystem,
        "an unreadable app.json must fall back, never fail a delete"
    );
}

#[test]
fn omitting_the_mode_uses_the_configured_default() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    std::fs::write(
        fixture.root.join(".obsidian/app.json"),
        r#"{"trashOption":"local"}"#,
    )
    .expect("write app.json");
    fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("One.md"),
            mode: None,
            expected: Precondition::Any,
        })
        .expect("delete with the configured default");
    assert!(fixture.root.join(".trash/One.md").is_file());
}
