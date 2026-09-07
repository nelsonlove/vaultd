//! Folder operations and the three delete dispositions.
//!
//! **Two rules bind every test in this file, and breaking either one writes
//! into the developer's own machine.**
//!
//! 1. No test may select [`DeleteMode::TrashSystem`]. On macOS `trash::delete`
//!    moves its target into the real `~/.Trash`; a `TempDir` cannot contain
//!    that destination, so such a test litters the trash of whoever runs the
//!    suite.
//! 2. No test may pass `mode: None` in a vault with no `.obsidian/app.json`.
//!    `configured_delete_mode` falls back to `TrashSystem` exactly there, so
//!    an omitted mode in a bare vault is rule 1 by another route — silently,
//!    and green.
//!
//! [`fixture`] closes the second hole by writing `{"trashOption":"local"}`
//! into every temp vault it builds, so an omitted mode disposes into the
//! vault's own `.trash/` and never leaves the `TempDir`. A test that wants the
//! bare-vault fallback removes that file itself and says so.

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
    // The landmine guard from this file's own header: with an `app.json`
    // naming the local trash, a `mode: None` delete disposes inside the temp
    // vault instead of into the developer's `~/.Trash`.
    std::fs::create_dir_all(root.join(".obsidian")).expect("create the zone");
    std::fs::write(
        root.join(".obsidian/app.json"),
        r#"{"trashOption":"local"}"#,
    )
    .expect("write app.json");
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
    let outcome = fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("A/B/C"),
        })
        .expect("mkdir -p semantics");
    assert!(fixture.root.join("A/B/C").is_dir());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("A"), path("A/B"), path("A/B/C")]),
        "every folder the daemon created is a tree row the daemon must hint"
    );
    assert!(
        !outcome.semantic,
        "a folder holds nothing the semantic layer indexes"
    );
}

#[test]
fn creating_a_folder_that_already_exists_succeeds_idempotently() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("Empty"),
        })
        .expect("an existing folder is success, not a conflict");
    assert!(
        outcome.changed_paths.is_empty(),
        "nothing was created, so nothing moved"
    );
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

/// The caller-spelling half of the folder guard. Every one of these is
/// refused before the filesystem is touched at all, which is what makes the
/// check load-bearing: `.trash` and `.git` do not exist here, so a check that
/// only ran against a *stored* path would never see them.
#[test]
fn creating_a_hidden_or_zone_folder_is_refused() {
    let fixture = fixture();
    for spelling in [
        ".obsidian",
        ".OBSIDIAN",
        ".obsidian/plugins",
        ".trash",
        ".git",
        ".git/hooks",
        "A/.hidden",
    ] {
        let error = fixture
            .engine
            .apply(&Mutation::CreateFolder {
                path: path(spelling),
            })
            .expect_err("the daemon may not create what it does not index");
        assert!(
            matches!(error, MutationError::ZoneViolation { .. }),
            "expected zone_violation for {spelling}, got {error:?}"
        );
    }
    // Named one by one rather than in the loop: `.obsidian` is there because
    // the harness wrote it, and on a case-folding volume `.OBSIDIAN` "exists"
    // for the same reason, so `!exists()` per spelling would assert the wrong
    // thing. These are the paths that must not have appeared.
    for absent in [".trash", ".git", "A", ".obsidian/plugins"] {
        assert!(
            !fixture.root.join(absent).exists(),
            "{absent} must not have been created"
        );
    }
    assert!(fixture.root.join(".obsidian/app.json").is_file());
}

/// A NUL byte never reaches the filesystem, and which syscall notices first
/// depends on where in the path it sits — so the engine refuses it once, in
/// one typed way, for every verb. `create_folder` walks segments itself
/// instead of calling `resolve`, so it is the one verb that can miss the gate
/// and answer `storage_failure`: a claim the daemon is broken and that a write
/// was attempted, when neither is true.
#[test]
fn creating_a_folder_with_a_nul_byte_is_refused() {
    let fixture = fixture();
    for spelling in ["bad\0name/Deep", "A/bad\0name"] {
        let error = fixture
            .engine
            .apply(&Mutation::CreateFolder {
                path: path(spelling),
            })
            .expect_err("a NUL byte is refused, not attempted");
        assert!(
            matches!(error, MutationError::ZoneViolation { .. }),
            "expected zone_violation for {spelling:?}, got {error:?}"
        );
    }
    assert!(
        !fixture.root.join("A").exists(),
        "the refusal must come before any segment is created"
    );
}

/// The last segment gets the guard every other verb applies to its target. On
/// a case-folding volume the create would otherwise be a silent success on a
/// folder the caller did not name; on a case-sensitive one it would create the
/// twin directory that folds into its sibling — and their contents collide —
/// the moment the vault reached a default macOS filesystem. Ancestor folds
/// stay served, per the ratified ancestor-fold doctrine.
#[test]
fn creating_a_folder_that_only_differs_in_case_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("folder"),
        })
        .expect_err("a case variant of a stored folder is not a folder to create");
    assert!(
        matches!(&error, MutationError::CaseCollision { existing, .. } if existing == "Folder"),
        "expected case_collision naming the stored spelling, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Two.md").is_file());

    // The ancestor half, which must keep working: only the final segment is
    // the caller's target, and on a folding volume a folded ancestor names a
    // folder that exists. (On a case-sensitive volume `folder/` is simply a
    // different folder and the create legitimately makes both, so there is
    // nothing to assert there.)
    if !folds_case(&fixture) {
        return;
    }
    fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("folder/New"),
        })
        .expect("a folded ancestor still reaches the stored folder");
    assert!(fixture.root.join("Folder/New").is_dir());
}

/// The stored-spelling half of the folder guard, which nothing lexical can
/// stand in for: `Link` carries no dot and names no zone, and only resolving
/// it reveals that the folder the caller addressed *is* the configuration
/// zone.
#[cfg(unix)]
#[test]
fn creating_through_a_link_into_the_configuration_zone_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(fixture.root.join(".obsidian"), fixture.root.join("Link"))
        .expect("link into the zone");
    let error = fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("Link/plugins"),
        })
        .expect_err("a link is not a way into the zone");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(
        !fixture.root.join(".obsidian/plugins").exists(),
        "nothing may be created inside the zone"
    );
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

/// The revision precondition is checked by hashing the file in chunks rather
/// than by reading it whole, so this pins the refusal that path produces: the
/// current revision reaches the caller and the file survives.
#[test]
fn a_revision_that_does_not_match_refuses_and_leaves_the_file() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("One.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Revision(revision_of(b"# Something else\n")),
        })
        .expect_err("a stale revision must not delete");
    assert!(
        matches!(
            &error,
            MutationError::RevisionConflict { current: Some(current), .. }
                if current == &revision_of(b"# One\n")
        ),
        "expected revision_conflict naming the current revision, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
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
        paths.iter().any(|path| path == "One.md"),
        "a scan returning nothing would make the assertion below vacuous: {paths:?}"
    );
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

/// The caller-spelling half of the note guard, made load-bearing by naming a
/// file that is not there: a check that ran only against a stored path would
/// answer `not_found` and tell the caller the path was addressable.
#[test]
fn an_unindexable_note_is_refused_before_it_is_even_looked_for() {
    let fixture = fixture();
    for spelling in [
        ".trash/Gone.md",
        ".obsidian/app.json",
        ".git/COMMIT_EDITMSG",
    ] {
        let error = fixture
            .engine
            .apply(&Mutation::DeleteNote {
                path: path(spelling),
                mode: Some(DeleteMode::Permanent),
                expected: Precondition::Any,
            })
            .expect_err("an unindexable path is never addressable");
        assert!(
            matches!(error, MutationError::ZoneViolation { .. }),
            "expected zone_violation for {spelling}, got {error:?}"
        );
    }
    assert!(fixture.root.join(".obsidian/app.json").is_file());
}

/// The stored-spelling half of the note guard. `Link/app.json` is hidden
/// nowhere in its spelling; only the resolve reveals the zone.
#[cfg(unix)]
#[test]
fn a_note_delete_that_resolves_into_the_configuration_zone_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(fixture.root.join(".obsidian"), fixture.root.join("Link"))
        .expect("link into the zone");
    let error = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Link/app.json"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect_err("a link is not a way into the zone");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(fixture.root.join(".obsidian/app.json").is_file());
}

/// Whether this vault's filesystem folds case, asked of the filesystem rather
/// than assumed of the platform: the tests below assert what a *fold* does,
/// and on a case-sensitive volume there is no fold to assert about.
fn folds_case(fixture: &Fixture) -> bool {
    let folds = fixture.root.join("folder").is_dir();
    if !folds {
        eprintln!("skipped: this volume is case-sensitive, so there is no fold to test");
    }
    folds
}

/// The destructive verb must not be the permissive one. `write_note` refuses
/// a spelling that folds onto a differently-cased stored name; a delete that
/// folded instead would destroy the file the caller did **not** name, and the
/// refusal hands back the stored spelling so the caller can retry correctly.
#[test]
fn a_mis_cased_delete_is_refused_rather_than_folded() {
    let fixture = fixture();
    if !folds_case(&fixture) {
        return;
    }
    let error = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("folder/two.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect_err("a folded spelling names a file the vault does not store");
    assert!(
        matches!(&error, MutationError::CaseCollision { existing, .. } if existing == "Two.md"),
        "expected case_collision naming the stored spelling, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Two.md").is_file());
}

#[test]
fn a_mis_cased_folder_delete_is_refused_rather_than_folded() {
    let fixture = fixture();
    if !folds_case(&fixture) {
        return;
    }
    let error = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("folder"),
            mode: Some(DeleteMode::Permanent),
            recursive: true,
        })
        .expect_err("a folded folder spelling names a folder the vault does not store");
    assert!(
        matches!(&error, MutationError::CaseCollision { existing, .. } if existing == "Folder"),
        "expected case_collision naming the stored spelling, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Two.md").is_file());
    assert!(fixture.root.join("Folder/Deep/Three.md").is_file());
}

/// Case folding is refused; Unicode normalization folding is *not*, and is
/// the reason a delete still captures its stored spelling before removing
/// anything. `Café.md` in NFC and NFD are visually one name and the same file
/// on APFS, so the delete serves it — and must report the name the scanner
/// emits, not the one the caller sent.
#[test]
fn a_delete_reports_the_stored_spelling_when_the_platform_folds_normalization() {
    let fixture = fixture();
    let decomposed = "Cafe\u{301}.md";
    let composed = "Caf\u{e9}.md";
    std::fs::write(fixture.root.join(decomposed), "# Cafe\n").expect("write the NFD note");
    if !fixture.root.join(composed).is_file() {
        eprintln!("skipped: this volume does not fold Unicode normalization");
        return;
    }
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path(composed),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect("an NFC spelling reaches the stored NFD file");
    assert!(!fixture.root.join(decomposed).exists());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path(decomposed)]),
        "a hint keyed to the caller's spelling would leave the real index row behind"
    );

    let folder = "Cafe\u{301}";
    std::fs::create_dir(fixture.root.join(folder)).expect("create the NFD folder");
    std::fs::write(fixture.root.join(folder).join("In.md"), "# In\n").expect("write In");
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("Caf\u{e9}"),
            mode: Some(DeleteMode::Permanent),
            recursive: true,
        })
        .expect("an NFC folder spelling reaches the stored NFD folder");
    assert!(!fixture.root.join(folder).exists());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path(folder), path(&format!("{folder}/In.md"))]),
        "every path a folder delete removed is named as the scanner would name it"
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

/// Every path, of every kind. A tree row the delete does not name is a row
/// that outlives the file it describes, and the client reading the tree at
/// the generation this delete published is served a file that is gone.
#[test]
fn a_recursive_folder_delete_names_every_path_it_removed() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("Folder/pic.png"), b"png").expect("write an attachment");
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
        BTreeSet::from([
            path("Folder"),
            path("Folder/Deep"),
            path("Folder/Deep/Three.md"),
            path("Folder/Two.md"),
            path("Folder/pic.png"),
        ]),
        "every removed path must reach reconciliation, or its rows survive it"
    );
    assert!(
        outcome.semantic,
        "notes were removed, so the semantic layer's rows moved too"
    );
}

/// A folder of attachments removes no indexed note, so it is not semantic —
/// and it still names everything it destroyed, because the file tree tracks
/// paths of every kind.
#[test]
fn an_attachment_only_folder_delete_still_names_what_it_destroyed() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join("Assets/Sub")).expect("create Assets/Sub");
    std::fs::write(fixture.root.join("Assets/a.png"), b"png").expect("write a.png");
    std::fs::write(fixture.root.join("Assets/Sub/b.pdf"), b"pdf").expect("write b.pdf");
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("Assets"),
            mode: Some(DeleteMode::Permanent),
            recursive: true,
        })
        .expect("recursive delete");
    assert!(!fixture.root.join("Assets").exists());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([
            path("Assets"),
            path("Assets/Sub"),
            path("Assets/Sub/b.pdf"),
            path("Assets/a.png"),
        ]),
    );
    assert!(
        !outcome.semantic,
        "no note was removed, so nothing the semantic layer indexes moved"
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
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Empty")]),
        "the folder itself is a tree row, and it is gone"
    );
    assert!(
        !outcome.semantic,
        "no note was removed, so nothing the semantic layer indexes moved"
    );
}

/// The most destructive verb in the phase, pointed at the directories the
/// daemon must never remove: the user's Obsidian configuration, the recovery
/// surface `trash_local` exists to provide, and a repository the daemon does
/// not own. `.OBSIDIAN` is the folded spelling that an exact-case compare on
/// the caller's own string lets through; `.git/hooks` does not exist, so only
/// a check that runs *before* the resolve can refuse it.
#[test]
fn deleting_a_hidden_or_zone_folder_is_refused() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".git")).expect("create .git");
    std::fs::write(fixture.root.join(".git/HEAD"), b"ref: refs/heads/main\n").expect("write HEAD");
    std::fs::create_dir_all(fixture.root.join(".trash")).expect("create .trash");
    std::fs::write(fixture.root.join(".trash/Kept.md"), "# Kept\n").expect("write Kept");
    std::fs::create_dir_all(fixture.root.join(".obsidian/plugins")).expect("create plugins");

    for spelling in [
        ".obsidian",
        ".OBSIDIAN",
        ".obsidian/plugins",
        ".trash",
        ".git",
        ".git/hooks",
    ] {
        let error = fixture
            .engine
            .apply(&Mutation::DeleteFolder {
                path: path(spelling),
                mode: Some(DeleteMode::Permanent),
                recursive: true,
            })
            .expect_err("the daemon may not remove what it does not index");
        assert!(
            matches!(error, MutationError::ZoneViolation { .. }),
            "expected zone_violation for {spelling}, got {error:?}"
        );
    }

    assert!(fixture.root.join(".obsidian/app.json").is_file());
    assert!(fixture.root.join(".obsidian/plugins").is_dir());
    assert!(fixture.root.join(".trash/Kept.md").is_file());
    assert!(fixture.root.join(".git/HEAD").is_file());
}

#[cfg(unix)]
#[test]
fn a_folder_delete_that_resolves_into_the_configuration_zone_is_refused() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian/plugins")).expect("create plugins");
    std::os::unix::fs::symlink(fixture.root.join(".obsidian"), fixture.root.join("Link"))
        .expect("link into the zone");
    let error = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("Link/plugins"),
            mode: Some(DeleteMode::Permanent),
            recursive: true,
        })
        .expect_err("a link is not a way into the zone");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(fixture.root.join(".obsidian/plugins").is_dir());
}

/// A symlink is not the folder it points at. Enumerating through it would
/// name the *target's* notes as deleted while `remove_dir_all` removed only
/// the link — a hint claiming files are gone that are still there. Refused
/// instead, so the caller says what it means.
#[cfg(unix)]
#[test]
fn a_symlinked_folder_is_never_deleted_through() {
    let fixture = fixture();
    std::os::unix::fs::symlink(fixture.root.join("Folder"), fixture.root.join("LinkIn"))
        .expect("link to an in-vault folder");
    let error = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("LinkIn"),
            mode: Some(DeleteMode::Permanent),
            recursive: true,
        })
        .expect_err("a link is not a folder");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(
        fixture.root.join("Folder/Two.md").is_file(),
        "the link's target must be untouched"
    );
    assert!(
        fixture.root.join("LinkIn").symlink_metadata().is_ok(),
        "a refusal removes nothing, the link included"
    );
}

#[test]
fn the_default_delete_mode_comes_from_the_vaults_own_app_json() {
    let fixture = fixture();
    // This test is about the fallback, so it removes the `app.json` the
    // harness writes for everyone else. It never applies a delete, so the
    // `TrashSystem` answer below reaches no filesystem.
    std::fs::remove_file(fixture.root.join(".obsidian/app.json")).expect("remove app.json");
    assert_eq!(
        fixture.engine.configured_delete_mode(),
        DeleteMode::TrashSystem,
        "Obsidian's own default is the system trash"
    );

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
