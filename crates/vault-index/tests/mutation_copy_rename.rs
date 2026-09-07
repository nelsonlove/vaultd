//! `copy_file` and the movement half of rename. Neither ever overwrites: a
//! mover who means replace must delete first, visibly.
//!
//! Two rules from `mutation_folders.rs` carry here unchanged, because the same
//! landmines are one typo away: no test may reach the platform trash, and no
//! test may write outside its own `TempDir`. Neither operation in this file
//! disposes of anything, so the `app.json` guard that file needs is not
//! repeated — but [`fixture`] still builds a self-contained vault and every
//! assertion is rooted in it.

use std::collections::BTreeSet;
use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    CopyConflict, Mutation, MutationEngine, MutationError, Precondition, revision_of,
};

struct Fixture {
    engine: MutationEngine,
    root: PathBuf,
    _vault: TempDir,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder/Deep")).expect("create Folder/Deep");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    std::fs::write(root.join("Two.md"), "# Two\n").expect("write Two");
    std::fs::write(root.join("image.png"), [0x89, 0x50, 0x4e, 0x47]).expect("write image");
    std::fs::write(root.join("Folder/Deep/Three.md"), "# Three\n").expect("write Three");
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

/// Whether this vault's filesystem folds case, asked of the filesystem rather
/// than assumed of the platform: the tests below assert what a *fold* does, and
/// on a case-sensitive volume there is no fold to assert about.
fn folds_case(fixture: &Fixture) -> bool {
    let folds = fixture.root.join("folder").is_dir();
    if !folds {
        eprintln!("skipped: this volume is case-sensitive, so there is no fold to test");
    }
    folds
}

// ---------------------------------------------------------------- copy_file

/// A copied attachment is a new tree row, so the destination is named even
/// though nothing semantic moved. Ruling B4 governs `changed_paths` for every
/// operation: the index has held a row per tree entry since the tree pre-task,
/// so a created path the outcome does not name is a row that never lands.
#[test]
fn copying_an_attachment_reproduces_its_bytes_exactly() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("image.png"),
            to: path("Folder/image.png"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect("copy an attachment");
    assert_eq!(
        std::fs::read(fixture.root.join("Folder/image.png")).expect("read the copy"),
        vec![0x89, 0x50, 0x4e, 0x47]
    );
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(&[0x89, 0x50, 0x4e, 0x47]).as_str())
    );
    assert!(
        !outcome.semantic,
        "a non-Markdown copy changes nothing the index holds"
    );
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Folder/image.png")]),
        "the tree gained a row, so the tree must hear about it"
    );
}

#[test]
fn copying_a_note_names_the_destination_as_changed() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Folder/One.md"),
            expected_source: Precondition::Revision(revision_of(b"# One\n")),
            if_exists: CopyConflict::Error,
        })
        .expect("copy a note");
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Folder/One.md")])
    );
    assert!(outcome.semantic);
    assert!(
        fixture.root.join("One.md").is_file(),
        "a copy leaves its source alone"
    );
}

#[test]
fn copying_onto_an_existing_file_is_refused_by_default() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Two.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("the default never overwrites");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("Two.md")).expect("read back"),
        b"# Two\n"
    );
}

#[test]
fn the_suffix_policy_numbers_the_destination_the_way_obsidian_does() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Two.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Suffix,
        })
        .expect("copy with auto-numbering");
    assert_eq!(
        std::fs::read(fixture.root.join("Two 1.md")).expect("read the numbered copy"),
        b"# One\n"
    );
    assert_eq!(outcome.changed_paths, BTreeSet::from([path("Two 1.md")]));
    assert_eq!(
        std::fs::read(fixture.root.join("Two.md")).expect("read back"),
        b"# Two\n",
        "the existing file must be untouched"
    );
}

/// The numbering walks until it finds a free name rather than stopping at the
/// first candidate, and it numbers the *file name* — a dot in a folder segment
/// is not an extension separator.
#[test]
fn the_suffix_policy_keeps_counting_and_numbers_only_the_file_name() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("Two 1.md"), "# Two 1\n").expect("write Two 1");
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Two.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Suffix,
        })
        .expect("copy with auto-numbering");
    assert_eq!(outcome.changed_paths, BTreeSet::from([path("Two 2.md")]));

    std::fs::create_dir_all(fixture.root.join("v1.0")).expect("create a dotted folder");
    std::fs::write(fixture.root.join("v1.0/Note"), "extensionless\n").expect("write Note");
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("v1.0/Note"),
            to: path("v1.0/Note"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Suffix,
        })
        .expect("copy an extensionless file inside a dotted folder");
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("v1.0/Note 1")]),
        "the dot belongs to the folder, not to an extension"
    );
}

#[test]
fn a_stale_source_revision_copies_nothing() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Folder/One.md"),
            expected_source: Precondition::Revision("blake3:0000".into()),
            if_exists: CopyConflict::Error,
        })
        .expect_err("a stale source revision must lose");
    assert!(matches!(error, MutationError::RevisionConflict { .. }));
    assert!(!fixture.root.join("Folder/One.md").exists());
    // The copy streams through a temporary in the destination's own folder; a
    // refusal must leave none of them behind.
    let names: BTreeSet<String> = std::fs::read_dir(fixture.root.join("Folder"))
        .expect("read Folder")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(
        names.iter().all(|name| !name.starts_with(".vaultd-")),
        "a refused copy leaves no temporary behind: {names:?}"
    );
}

/// A copy moves bytes inside the vault; none of them cross the wire, and the
/// daemon never holds the file. Capping it would make a large attachment
/// permanently uncopyable with no remedy — the same reasoning that keeps the
/// payload cap off deletes.
#[test]
fn the_payload_cap_never_governs_a_copy() {
    let fixture = fixture();
    let engine = MutationEngine::new(&fixture.root).with_max_file_bytes(2);
    engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Folder/One.md"),
            expected_source: Precondition::Revision(revision_of(b"# One\n")),
            if_exists: CopyConflict::Error,
        })
        .expect("a copy streams and is never capped");
    assert_eq!(
        std::fs::read(fixture.root.join("Folder/One.md")).expect("read the copy"),
        b"# One\n"
    );
}

/// A copy larger than one streaming buffer, so the loop is exercised rather
/// than the single-read happy path.
#[test]
fn a_copy_larger_than_the_streaming_buffer_reproduces_every_byte() {
    let fixture = fixture();
    let bytes: Vec<u8> = (0..300_000u32).map(|index| (index % 251) as u8).collect();
    std::fs::write(fixture.root.join("big.bin"), &bytes).expect("write big.bin");
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("big.bin"),
            to: path("Folder/big.bin"),
            expected_source: Precondition::Revision(revision_of(&bytes)),
            if_exists: CopyConflict::Error,
        })
        .expect("copy a multi-buffer file");
    assert_eq!(
        std::fs::read(fixture.root.join("Folder/big.bin")).expect("read the copy"),
        bytes
    );
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(&bytes).as_str())
    );
}

#[test]
fn an_absent_precondition_is_meaningless_for_a_copy() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Folder/One.md"),
            expected_source: Precondition::Absent,
            if_exists: CopyConflict::Error,
        })
        .expect_err("expected-absent cannot guard the source of a copy");
    assert!(
        matches!(error, MutationError::InvalidPrecondition { .. }),
        "expected invalid_precondition, got {error:?}"
    );
    assert!(!fixture.root.join("Folder/One.md").exists());
}

#[test]
fn copying_an_absent_source_is_not_a_silent_success() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("Gone.md"),
            to: path("Folder/Gone.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("there is nothing to copy");
    assert!(
        matches!(error, MutationError::NotFound { .. }),
        "expected not_found, got {error:?}"
    );
}

/// A folder is not a file, and copying one is not this operation. Refused
/// before anything is read, so a `read_dir`-shaped `EISDIR` never reaches a
/// client as a claim that the daemon is broken.
#[test]
fn copying_a_folder_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("Folder"),
            to: path("Copy"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("a folder has no bytes to copy");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(!fixture.root.join("Copy").exists());
}

/// The caller-spelling half of the copy guard, on both ends. `.trash/Gone.md`
/// does not exist, so a check that ran only against a *stored* path would
/// answer `not_found` and tell the caller the path was addressable.
#[test]
fn copying_into_or_out_of_an_unindexable_path_is_refused() {
    let fixture = fixture();
    for (from, to) in [
        ("One.md", ".trash/One.md"),
        ("One.md", ".obsidian/One.md"),
        ("One.md", ".git/One.md"),
        (".obsidian/app.json", "app.json"),
        (".trash/Gone.md", "Gone.md"),
    ] {
        let error = fixture
            .engine
            .apply(&Mutation::CopyFile {
                from: path(from),
                to: path(to),
                expected_source: Precondition::Any,
                if_exists: CopyConflict::Error,
            })
            .expect_err("an unindexable path is never addressable");
        assert!(
            matches!(error, MutationError::ZoneViolation { .. }),
            "expected zone_violation for {from} -> {to}, got {error:?}"
        );
    }
    assert!(!fixture.root.join("app.json").exists());
    assert!(!fixture.root.join(".trash").exists());
}

/// The shape the stored-spelling guard alone cannot see, and the one that
/// leaked: a link at the source's **final** component.
///
/// `resolve` canonicalizes only the parent and appends the last component
/// unresolved, because a mutation target need not exist yet — so a link planted
/// at the last component keeps its own innocent name all the way through
/// `stored_path`, while `metadata` and `File::open` both follow it. Without a
/// no-follow check the copy reads through the link and lands unindexable bytes
/// at an indexed path: the configuration zone's plugin data, a repository's
/// config, a note in the trash. The guard `rename_paths` already had, applied
/// here.
#[cfg(unix)]
#[test]
fn a_symlinked_copy_source_is_refused_rather_than_followed() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian/plugins/secret")).expect("create plugins");
    std::fs::write(
        fixture.root.join(".obsidian/plugins/secret/data.json"),
        r#"{"apiKey":"SEKRIT"}"#,
    )
    .expect("write plugin data");
    std::fs::create_dir_all(fixture.root.join(".git")).expect("create .git");
    std::fs::write(fixture.root.join(".git/config"), "[remote]\n").expect("write git config");
    std::fs::create_dir_all(fixture.root.join(".trash")).expect("create .trash");
    std::fs::write(fixture.root.join(".trash/Deleted.md"), "# Deleted\n").expect("write Deleted");

    for (name, target) in [
        ("ZoneBait.md", ".obsidian/plugins/secret/data.json"),
        ("GitBait.md", ".git/config"),
        ("TrashBait.md", ".trash/Deleted.md"),
        // An ordinary indexed file too. Copying through the link would be a
        // defensible answer on its own, but `rename_paths` refuses a symlinked
        // source and the two verbs must not disagree about what a link means.
        ("PlainBait.md", "Two.md"),
    ] {
        std::os::unix::fs::symlink(fixture.root.join(target), fixture.root.join(name))
            .expect("plant the link");
        let error = fixture
            .engine
            .apply(&Mutation::CopyFile {
                from: path(name),
                to: path("leaked.md"),
                expected_source: Precondition::Any,
                if_exists: CopyConflict::Error,
            })
            .expect_err("a link is not the file it points at");
        assert!(
            matches!(error, MutationError::TargetExists { .. }),
            "expected target_exists for {name} -> {target}, got {error:?}"
        );
        assert!(
            !fixture.root.join("leaked.md").exists(),
            "{target} must not have been copied out through {name}"
        );
    }

    // The link's own target is untouched by any of it, and the links survive:
    // a refusal removes nothing.
    assert!(
        fixture
            .root
            .join(".obsidian/plugins/secret/data.json")
            .is_file()
    );
    assert!(fixture.root.join(".git/config").is_file());
    assert!(fixture.root.join(".trash/Deleted.md").is_file());
}

/// The out-of-vault case was already refused before this guard existed, by
/// `resolve`'s own final-component canonicalize and containment check. Pinned
/// so the stronger guard above cannot quietly become the only thing standing
/// between a link and the rest of the filesystem.
#[cfg(unix)]
#[test]
fn a_copy_source_linking_out_of_the_vault_is_refused_by_containment() {
    let fixture = fixture();
    let outside = TempDir::new().expect("outside tempdir");
    std::fs::write(outside.path().join("secrets"), "OUTSIDE\n").expect("write outside");
    std::os::unix::fs::symlink(
        outside.path().join("secrets"),
        fixture.root.join("Escape.md"),
    )
    .expect("link out of the vault");
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("Escape.md"),
            to: path("leaked.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("a link out of the vault is not a source");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(!fixture.root.join("leaked.md").exists());
}

/// The stored-spelling half. `Link/One.md` is hidden nowhere in its spelling;
/// only the resolve reveals that the destination folder *is* the configuration
/// zone.
#[cfg(unix)]
#[test]
fn a_copy_whose_destination_resolves_into_the_configuration_zone_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(fixture.root.join(".obsidian"), fixture.root.join("Link"))
        .expect("link into the zone");
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Link/One.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("a link is not a way into the zone");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(!fixture.root.join(".obsidian/One.md").exists());
}

/// The same half on the source end. Reading *out* of the zone is refused for
/// the reason writing into it is: the addressable surface is one set of paths,
/// not two, and `read_file` is the operation that serves the zone.
#[cfg(unix)]
#[test]
fn a_copy_whose_source_resolves_into_the_configuration_zone_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(fixture.root.join(".obsidian"), fixture.root.join("Link"))
        .expect("link into the zone");
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("Link/app.json"),
            to: path("app.json"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("a link is not a way out of the zone");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(!fixture.root.join("app.json").exists());
}

/// A folded source spelling reads a file the caller never named, and a copy
/// would then reproduce it under a name the caller chose for something else.
#[test]
fn a_mis_cased_copy_source_is_refused_rather_than_folded() {
    let fixture = fixture();
    if !folds_case(&fixture) {
        return;
    }
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("one.md"),
            to: path("Folder/One.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("a folded spelling names a file the vault does not store");
    assert!(
        matches!(&error, MutationError::CaseCollision { existing, .. } if existing == "One.md"),
        "expected case_collision naming the stored spelling, got {error:?}"
    );
    assert!(!fixture.root.join("Folder/One.md").exists());
}

/// The destination guard, and the reason it runs *before* the existence check:
/// on a case-folding filesystem `two.md` "exists" because `Two.md` does, and
/// `target_exists` would name a path this vault does not store while the real
/// hazard — a write that lands on `Two.md` — went unnamed.
#[test]
fn copying_onto_a_case_variant_of_a_different_file_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("two.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("a case variant of Two.md would clobber it on APFS");
    match error {
        MutationError::CaseCollision { existing, .. } => assert_eq!(existing, "Two.md"),
        other => panic!("expected a case collision, got {other:?}"),
    }
    assert_eq!(
        std::fs::read(fixture.root.join("Two.md")).expect("read back"),
        b"# Two\n"
    );
}

/// Under the suffix policy a case variant is an *occupied* name, not a
/// refusal: the caller asked for the first free spelling and a name that folds
/// onto a stored one is not free.
#[test]
fn the_suffix_policy_treats_a_case_variant_as_occupied() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("two.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Suffix,
        })
        .expect("auto-numbering steps past a folded name");
    assert_eq!(outcome.changed_paths, BTreeSet::from([path("two 1.md")]));
    assert_eq!(
        std::fs::read(fixture.root.join("Two.md")).expect("read back"),
        b"# Two\n"
    );
}

// ------------------------------------------------------------------ rename

#[test]
fn renaming_a_note_moves_it_and_names_both_paths() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("Folder/Renamed.md"),
            expected: Precondition::Revision(revision_of(b"# One\n")),
            rewrite_links: false,
        })
        .expect("rename a note");
    assert!(!fixture.root.join("One.md").exists());
    assert_eq!(
        std::fs::read(fixture.root.join("Folder/Renamed.md")).expect("read the moved note"),
        b"# One\n"
    );
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("One.md"), path("Folder/Renamed.md")]),
        "both the vacated and the occupied path must reach reconciliation"
    );
    assert!(outcome.semantic, "a note moved");
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(b"# One\n").as_str()),
        "the moved bytes are unchanged, and the caller is told so"
    );
}

/// Ruling B4 reaches the attachment rename too: nothing semantic moved, and
/// two tree rows did. A rename that named neither would leave the vacated row
/// describing a file that is gone.
#[test]
fn renaming_an_attachment_names_both_paths_and_is_not_semantic() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("image.png"),
            to: path("Folder/image.png"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect("rename an attachment");
    assert!(!fixture.root.join("image.png").exists());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("image.png"), path("Folder/image.png")])
    );
    assert!(
        !outcome.semantic,
        "no Markdown path moved, so nothing the semantic layer indexes did"
    );
}

#[test]
fn a_stale_revision_renames_nothing() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("Folder/Renamed.md"),
            expected: Precondition::Revision(revision_of(b"# Something else\n")),
            rewrite_links: false,
        })
        .expect_err("a stale revision must not move a file");
    assert!(
        matches!(
            &error,
            MutationError::RevisionConflict { current: Some(current), .. }
                if current == &revision_of(b"# One\n")
        ),
        "expected revision_conflict naming the current revision, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
    assert!(!fixture.root.join("Folder/Renamed.md").exists());
}

#[test]
fn an_absent_precondition_is_meaningless_for_a_rename() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("Renamed.md"),
            expected: Precondition::Absent,
            rewrite_links: false,
        })
        .expect_err("expected-absent cannot guard a rename");
    assert!(
        matches!(error, MutationError::InvalidPrecondition { .. }),
        "expected invalid_precondition, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
}

#[test]
fn renaming_an_absent_note_is_not_a_silent_success() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("Gone.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect_err("there is nothing to move");
    assert!(
        matches!(error, MutationError::NotFound { .. }),
        "expected not_found, got {error:?}"
    );
}

/// `rename_note` addresses a file. A folder reaching it would be moved by the
/// same `std::fs::rename`, and the outcome would then report a revision for
/// something that has no bytes.
#[test]
fn renaming_a_folder_with_the_note_verb_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("Folder"),
            to: path("Moved"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect_err("a folder is not a note");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Deep/Three.md").is_file());
    assert!(!fixture.root.join("Moved").exists());
}

/// The mirror: `rename_folder` addresses a folder, and a file reaching it
/// refuses the way `delete_folder` does.
#[test]
fn renaming_a_note_with_the_folder_verb_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("One.md"),
            to: path("Moved.md"),
            rewrite_links: false,
        })
        .expect_err("a note is not a folder");
    assert!(
        matches!(error, MutationError::NotFound { .. }),
        "expected not_found, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
}

#[test]
fn renaming_onto_an_existing_note_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("Two.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect_err("there is no overwrite-on-rename");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
    assert_eq!(
        std::fs::read(fixture.root.join("Two.md")).expect("read back"),
        b"# Two\n"
    );
}

#[test]
fn a_case_only_rename_succeeds_through_a_temporary_name() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("ONE.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect("a case-only rename is supported internally");
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("One.md"), path("ONE.md")])
    );
    let names: BTreeSet<String> = std::fs::read_dir(&fixture.root)
        .expect("read the vault root")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(names.contains("ONE.md"), "{names:?}");
    assert!(!names.contains("One.md"), "{names:?}");
    assert!(
        names.iter().all(|name| !name.starts_with(".vaultd-")),
        "the intermediate name must not survive: {names:?}"
    );
}

/// The other direction, and the whole reason the source case guard carries an
/// exemption. Here the caller's *source* spelling is the folded one: without
/// the exemption the guard would refuse `one.md` against the stored `One.md`
/// and a case-only rename could never be spelled this way at all. The vacated
/// path reported is the stored spelling, not the caller's.
#[test]
fn a_case_only_rename_from_a_folded_source_spelling_still_moves_the_stored_file() {
    let fixture = fixture();
    if !folds_case(&fixture) {
        return;
    }
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("one.md"),
            to: path("ONE.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect("the case-only exemption serves the folded source spelling");
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("One.md"), path("ONE.md")]),
        "the vacated path is the one the scanner emitted, not the one the caller sent"
    );
    let names: BTreeSet<String> = std::fs::read_dir(&fixture.root)
        .expect("read the vault root")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(names.contains("ONE.md"), "{names:?}");
    assert!(
        names.iter().all(|name| !name.starts_with(".vaultd-")),
        "the intermediate name must not survive: {names:?}"
    );
}

/// The folder shape of the same rename, which is the one where the staging
/// name holds a whole subtree rather than a single file. Every path on both
/// sides is named, and the staging name is gone whatever it was.
#[test]
fn a_case_only_folder_rename_moves_the_whole_subtree() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("Folder/pic.png"), b"png").expect("write an attachment");
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("Folder"),
            to: path("FOLDER"),
            rewrite_links: false,
        })
        .expect("a case-only folder rename is supported internally");
    assert_eq!(
        std::fs::read(fixture.root.join("FOLDER/Deep/Three.md")).expect("read the moved note"),
        b"# Three\n"
    );
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([
            path("FOLDER"),
            path("FOLDER/Deep"),
            path("FOLDER/Deep/Three.md"),
            path("FOLDER/pic.png"),
            path("Folder"),
            path("Folder/Deep"),
            path("Folder/Deep/Three.md"),
            path("Folder/pic.png"),
        ])
    );
    assert!(outcome.semantic, "a note moved");
    let names: BTreeSet<String> = std::fs::read_dir(&fixture.root)
        .expect("read the vault root")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(names.contains("FOLDER"), "{names:?}");
    assert!(
        names.iter().all(|name| !name.starts_with(".vaultd-")),
        "the staging name must not survive: {names:?}"
    );
}

/// The guard itself, on a rename that is *not* case-only: a folded source
/// spelling would move a file the caller never named, leaving the one they did
/// name exactly where it was.
#[test]
fn a_mis_cased_rename_source_is_refused_rather_than_folded() {
    let fixture = fixture();
    if !folds_case(&fixture) {
        return;
    }
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("one.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect_err("a folded spelling names a file the vault does not store");
    assert!(
        matches!(&error, MutationError::CaseCollision { existing, .. } if existing == "One.md"),
        "expected case_collision naming the stored spelling, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
    assert!(!fixture.root.join("Renamed.md").exists());

    let error = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("folder"),
            to: path("Moved"),
            rewrite_links: false,
        })
        .expect_err("the same guard binds the folder verb");
    assert!(
        matches!(&error, MutationError::CaseCollision { existing, .. } if existing == "Folder"),
        "expected case_collision naming the stored spelling, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Deep/Three.md").is_file());
}

#[test]
fn renaming_onto_a_case_variant_of_a_different_note_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("two.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect_err("a case variant of Two.md would clobber it on APFS");
    match error {
        MutationError::CaseCollision { existing, .. } => assert_eq!(existing, "Two.md"),
        other => panic!("expected a case collision, got {other:?}"),
    }
    assert!(fixture.root.join("One.md").is_file());
}

/// Every path, of every kind, on both sides — Ruling B4. A folder rename moves
/// the folder rows as well as the note rows, and a row it does not name keeps
/// describing a path that no longer exists.
#[test]
fn renaming_a_folder_names_every_path_on_both_sides() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("Folder/pic.png"), b"png").expect("write an attachment");
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("Folder"),
            to: path("Moved"),
            rewrite_links: false,
        })
        .expect("rename a folder");
    assert!(fixture.root.join("Moved/Deep/Three.md").is_file());
    assert!(!fixture.root.join("Folder").exists());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([
            path("Folder"),
            path("Folder/Deep"),
            path("Folder/Deep/Three.md"),
            path("Folder/pic.png"),
            path("Moved"),
            path("Moved/Deep"),
            path("Moved/Deep/Three.md"),
            path("Moved/pic.png"),
        ])
    );
    assert!(outcome.semantic, "a note moved");
    assert_eq!(
        outcome.revision, None,
        "a folder has no bytes, so it reports no revision"
    );
}

/// A folder holding only attachments moves every tree row it owns and no
/// semantic row at all.
#[test]
fn renaming_an_attachment_only_folder_is_not_semantic() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join("Assets")).expect("create Assets");
    std::fs::write(fixture.root.join("Assets/a.png"), b"png").expect("write a.png");
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("Assets"),
            to: path("Media"),
            rewrite_links: false,
        })
        .expect("rename a folder of attachments");
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([
            path("Assets"),
            path("Assets/a.png"),
            path("Media"),
            path("Media/a.png"),
        ])
    );
    assert!(
        !outcome.semantic,
        "no Markdown path moved, so nothing the semantic layer indexes did"
    );
}

#[test]
fn renaming_a_folder_onto_an_existing_name_is_refused() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join("Moved")).expect("create Moved");
    let error = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("Folder"),
            to: path("Moved"),
            rewrite_links: false,
        })
        .expect_err("merging two folders is not a rename");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Deep/Three.md").is_file());
}

/// A folder cannot become its own descendant. The kernel refuses the rename
/// with `EINVAL`, which would reach a client as `storage_failure` — a claim
/// the daemon is broken and an invitation to retry a request that can never
/// succeed. Refused as an invalid target instead.
#[test]
fn renaming_a_folder_into_itself_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("Folder"),
            to: path("Folder/Inner"),
            rewrite_links: false,
        })
        .expect_err("a folder cannot contain itself");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Deep/Three.md").is_file());
    assert!(!fixture.root.join("Folder/Inner").exists());
}

/// The caller-spelling half of the rename guard. Without it a rename is the
/// way to create — and to reach — exactly what `create_folder` and
/// `delete_folder` refuse. `.git` and `.trash` do not exist here, so only a
/// check that runs before the filesystem is touched can see them.
#[test]
fn renaming_into_or_out_of_an_unindexable_path_is_refused() {
    let fixture = fixture();
    for (from, to) in [
        ("One.md", ".trash/One.md"),
        ("One.md", ".obsidian/One.md"),
        ("One.md", ".git/One.md"),
        (".obsidian/app.json", "app.json"),
        // Absent, and refused as a zone violation rather than reported as
        // merely not found: only a check that runs before the resolve can say
        // that, because the resolve answers `parent_not_found` about a `.trash`
        // this vault does not have.
        (".trash/Gone.md", "Gone.md"),
        (".git/COMMIT_EDITMSG", "Message.md"),
    ] {
        let error = fixture
            .engine
            .apply(&Mutation::RenameNote {
                from: path(from),
                to: path(to),
                expected: Precondition::Any,
                rewrite_links: false,
            })
            .expect_err("an unindexable path is never addressable");
        assert!(
            matches!(error, MutationError::ZoneViolation { .. }),
            "expected zone_violation for {from} -> {to}, got {error:?}"
        );
    }

    // The folder verb adds the half `VaultPath::is_hidden` leaves to its
    // caller: a final component that starts with a dot is a hidden *directory*,
    // and a rename must be no more able to create or move one than
    // `create_folder` is.
    for (from, to) in [
        ("Folder", ".hidden"),
        ("Folder", ".git"),
        (".obsidian", "Config"),
        (".trash", "Recovered"),
        ("Folder", "Deep/.hidden"),
    ] {
        let error = fixture
            .engine
            .apply(&Mutation::RenameFolder {
                from: path(from),
                to: path(to),
                rewrite_links: false,
            })
            .expect_err("the daemon may not create or move what it does not index");
        assert!(
            matches!(error, MutationError::ZoneViolation { .. }),
            "expected zone_violation for {from} -> {to}, got {error:?}"
        );
    }

    assert!(fixture.root.join("One.md").is_file());
    assert!(fixture.root.join(".obsidian/app.json").is_file());
    assert!(fixture.root.join("Folder/Deep/Three.md").is_file());
    for absent in [".trash", ".git", ".hidden", "app.json", "Config"] {
        assert!(
            !fixture.root.join(absent).exists(),
            "{absent} must not have appeared"
        );
    }
}

/// The stored-spelling half. `Link/One.md` carries no dot and names no zone;
/// only the resolve reveals that the destination folder *is* the configuration
/// zone.
#[cfg(unix)]
#[test]
fn a_rename_whose_destination_resolves_into_the_configuration_zone_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(fixture.root.join(".obsidian"), fixture.root.join("Link"))
        .expect("link into the zone");
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("Link/One.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect_err("a link is not a way into the zone");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
    assert!(!fixture.root.join(".obsidian/One.md").exists());
}

/// The source end of the same half, and the one guard the primitive alone can
/// make: the arm above it has already resolved, checked the case, and checked
/// the precondition by the time this is reached, and every one of them passed.
#[cfg(unix)]
#[test]
fn a_rename_whose_source_resolves_into_the_configuration_zone_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(fixture.root.join(".obsidian"), fixture.root.join("Link"))
        .expect("link into the zone");
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("Link/app.json"),
            to: path("app.json"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect_err("a link is not a way out of the zone");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );
    assert!(
        fixture.root.join(".obsidian/app.json").is_file(),
        "a refusal moves nothing"
    );
    assert!(!fixture.root.join("app.json").exists());
}

/// A symlink is not the thing it points at. `std::fs::rename` moves the link
/// while `paths_under` walks the target, so a rename through one would report
/// the target's notes as moved while every one of them stayed put. Refused, so
/// the caller says what it means.
#[cfg(unix)]
#[test]
fn a_symlinked_root_is_never_renamed_through() {
    let fixture = fixture();
    std::os::unix::fs::symlink(fixture.root.join("Folder"), fixture.root.join("LinkIn"))
        .expect("link to an in-vault folder");
    let error = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("LinkIn"),
            to: path("Moved"),
            rewrite_links: false,
        })
        .expect_err("a link is not a folder");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(
        fixture.root.join("Folder/Deep/Three.md").is_file(),
        "the link's target must be untouched"
    );
    assert!(
        fixture.root.join("LinkIn").symlink_metadata().is_ok(),
        "a refusal moves nothing, the link included"
    );
    assert!(!fixture.root.join("Moved").exists());
}

/// A malformed request is refused *as* malformed, whatever else is wrong with
/// it. Each of these reaches a different, plausible-looking answer if its guard
/// runs a step later than it does — and each of those answers would send the
/// caller after the wrong problem: retry with a fresh revision, create the
/// parent folder, or address a file that is not the one they named.
#[test]
fn a_renames_refusals_come_in_the_order_that_makes_them_true() {
    let fixture = fixture();

    // A destination inside the trash is a malformed request, not a stale one.
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path(".trash/One.md"),
            expected: Precondition::Revision("blake3:0000".into()),
            rewrite_links: false,
        })
        .expect_err("an unindexable destination is refused before any revision is compared");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );

    // An `absent` precondition cannot guard a rename whether or not the source
    // is reachable, so it is refused before the path is resolved at all.
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("Missing/One.md"),
            to: path("Renamed.md"),
            expected: Precondition::Absent,
            rewrite_links: false,
        })
        .expect_err("an absent precondition is invalid however the path resolves");
    assert!(
        matches!(error, MutationError::InvalidPrecondition { .. }),
        "expected invalid_precondition, got {error:?}"
    );

    // And the case guard before the precondition: on a case-folding filesystem
    // the precondition itself folds, so a revision compared first would answer
    // about `One.md` for a caller who named `one.md` — a `revision_conflict`
    // inviting a retry that can never be right, instead of the collision that
    // is the real problem.
    if !folds_case(&fixture) {
        return;
    }
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("one.md"),
            to: path("Renamed.md"),
            expected: Precondition::Revision("blake3:0000".into()),
            rewrite_links: false,
        })
        .expect_err("a folded source is refused before its bytes are compared");
    assert!(
        matches!(&error, MutationError::CaseCollision { existing, .. } if existing == "One.md"),
        "expected case_collision naming the stored spelling, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
    assert!(!fixture.root.join("Renamed.md").exists());
}

/// `rename_paths` is the primitive Task 12 calls after it has rewritten the
/// referrers, so it must carry its own guards rather than trusting the arm
/// above it: a direct caller gets the same refusals.
#[test]
fn the_movement_primitive_guards_itself() {
    let fixture = fixture();
    let error = fixture
        .engine
        .rename_paths(&path("One.md"), &path(".trash/One.md"))
        .expect_err("the primitive refuses an unindexable destination on its own");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );

    let error = fixture
        .engine
        .rename_paths(&path("One.md"), &path("Two.md"))
        .expect_err("the primitive never overwrites on its own");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );

    // The folder-shaped half, which `VaultPath::is_hidden` cannot give — it
    // never judges the last component — so only a caller that knows its target
    // is a directory can apply it. `.hidden` and `.git` pass every lexical
    // check the note verb makes.
    std::fs::create_dir_all(fixture.root.join(".git")).expect("create .git");
    std::fs::write(fixture.root.join(".git/HEAD"), b"ref: refs/heads/main\n").expect("write HEAD");
    for (from, to) in [("Folder", ".hidden"), (".git", "Git")] {
        let error = fixture
            .engine
            .rename_paths(&path(from), &path(to))
            .expect_err("the primitive refuses a hidden folder on either end");
        assert!(
            matches!(error, MutationError::ZoneViolation { .. }),
            "expected zone_violation for {from} -> {to}, got {error:?}"
        );
    }
    assert!(fixture.root.join(".git/HEAD").is_file());
    assert!(!fixture.root.join(".hidden").exists());
    assert!(!fixture.root.join("Git").exists());

    // And it runs before the destination is resolved, so a hidden folder under
    // a parent that does not exist is still refused as unaddressable rather
    // than reported as `parent_not_found` — which would tell the caller to
    // create the folder and try again.
    let error = fixture
        .engine
        .rename_paths(&path("Folder"), &path("Missing/.hidden"))
        .expect_err("an unindexable destination is never merely absent");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected zone_violation, got {error:?}"
    );

    let moved = fixture
        .engine
        .rename_paths(&path("One.md"), &path("Folder/Renamed.md"))
        .expect("and it moves when nothing refuses");
    assert_eq!(
        moved,
        BTreeSet::from([path("One.md"), path("Folder/Renamed.md")])
    );
    assert!(fixture.root.join("Folder/Renamed.md").is_file());
}

/// The symlink refusal belongs to the primitive too, not only to the folder
/// arm above it: `paths_under` walks the link's target while `std::fs::rename`
/// moves the link, and Task 12 reaches this function directly.
#[cfg(unix)]
#[test]
fn the_movement_primitive_refuses_a_symlinked_root_on_its_own() {
    let fixture = fixture();
    std::os::unix::fs::symlink(fixture.root.join("Folder"), fixture.root.join("LinkIn"))
        .expect("link to an in-vault folder");
    let error = fixture
        .engine
        .rename_paths(&path("LinkIn"), &path("Moved"))
        .expect_err("a link is not the folder it points at");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Deep/Three.md").is_file());
    assert!(!fixture.root.join("Moved").exists());
}

#[test]
fn a_read_only_daemon_copies_and_renames_nothing() {
    let fixture = fixture();
    let engine = MutationEngine::new(&fixture.root).with_read_only(true);
    assert!(matches!(
        engine
            .apply(&Mutation::CopyFile {
                from: path("One.md"),
                to: path("Folder/One.md"),
                expected_source: Precondition::Any,
                if_exists: CopyConflict::Error,
            })
            .expect_err("read-only refuses a copy"),
        MutationError::ReadOnly
    ));
    assert!(matches!(
        engine
            .rename_paths(&path("One.md"), &path("Folder/Renamed.md"))
            .expect_err("read-only refuses the primitive too"),
        MutationError::ReadOnly
    ));
    assert!(fixture.root.join("One.md").is_file());
    assert!(!fixture.root.join("Folder/One.md").exists());
    assert!(!fixture.root.join("Folder/Renamed.md").exists());
}
