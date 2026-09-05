//! `write_note`: create or replace a UTF-8 note, atomically, under a
//! compare-and-swap.

use std::collections::BTreeSet;
use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{Mutation, MutationEngine, MutationError, Precondition, revision_of};

struct Fixture {
    engine: MutationEngine,
    root: PathBuf,
    _vault: TempDir,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder")).expect("create Folder");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    Fixture {
        engine: MutationEngine::new(&root),
        root,
        _vault: vault,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

fn names_in(directory: &std::path::Path) -> BTreeSet<String> {
    std::fs::read_dir(directory)
        .expect("read directory")
        .map(|entry| {
            entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

#[test]
fn creating_a_note_writes_exactly_the_bytes_given() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/New.md"),
            content: "# New\n\nbody\n".into(),
            expected: Precondition::Absent,
        })
        .expect("create a new note");

    assert_eq!(
        std::fs::read(fixture.root.join("Folder/New.md")).expect("read back"),
        b"# New\n\nbody\n"
    );
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(b"# New\n\nbody\n").as_str())
    );
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Folder/New.md")])
    );
    assert!(outcome.semantic, "a Markdown note is semantic");
}

#[test]
fn replacing_a_note_under_its_current_revision_succeeds() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("One.md"),
            content: "# One changed\n".into(),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect("replace under a matching revision");
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# One changed\n"
    );
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(b"# One changed\n").as_str())
    );
}

#[test]
fn a_stale_revision_changes_nothing_at_all() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("One.md"),
            content: "# clobbered\n".into(),
            expected: Precondition::Revision("blake3:0000".into()),
        })
        .expect_err("a stale revision must lose");
    match error {
        MutationError::RevisionConflict { current, .. } => {
            assert_eq!(current.as_deref(), Some(revision_of(b"# One\n").as_str()));
        }
        other => panic!("expected a revision conflict, got {other:?}"),
    }
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# One\n",
        "a refused write must leave the file byte-identical"
    );
}

#[test]
fn creating_where_a_note_already_exists_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("One.md"),
            content: "# clobbered\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("expected-absent against an existing note must lose");
    assert!(
        matches!(error, MutationError::RevisionConflict { .. }),
        "expected a revision conflict, got {error:?}"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# One\n"
    );
}

#[test]
fn a_write_into_a_missing_folder_creates_nothing() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Missing/New.md"),
            content: "# New\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("parent folders are never created implicitly");
    assert!(
        matches!(error, MutationError::ParentNotFound { .. }),
        "expected parent_not_found, got {error:?}"
    );
    assert!(!fixture.root.join("Missing").exists());
}

#[test]
fn creating_a_case_variant_of_an_existing_note_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("one.md"),
            content: "# lowercase\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("a case variant would silently overwrite on APFS");
    match error {
        MutationError::CaseCollision { existing, .. } => assert_eq!(existing, "One.md"),
        other => panic!("expected a case collision, got {other:?}"),
    }
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# One\n"
    );
}

/// The case check runs before the compare-and-swap, so a caller that names a
/// case variant is refused for the *reason that is true* — the name collides —
/// whatever precondition it carried. On a case-insensitive filesystem the
/// alternative is worse than a wrong error code: `check` folds the spelling,
/// reads the differently-spelled file's bytes, and a `revision` precondition
/// naming those bytes would *pass*, letting the write land on a file the
/// caller never addressed.
#[test]
fn a_case_variant_is_refused_under_every_precondition() {
    for expected in [
        Precondition::Any,
        Precondition::Revision(revision_of(b"# One\n")),
    ] {
        let fixture = fixture();
        let error = fixture
            .engine
            .apply(&Mutation::WriteNote {
                path: path("one.md"),
                content: "# lowercase\n".into(),
                expected: expected.clone(),
            })
            .expect_err("a case variant is refused before the precondition is evaluated");
        assert!(
            matches!(error, MutationError::CaseCollision { .. }),
            "expected a case collision for {expected:?}, got {error:?}"
        );
        assert_eq!(
            std::fs::read(fixture.root.join("One.md")).expect("read back"),
            b"# One\n"
        );
    }
}

#[test]
fn a_non_markdown_path_is_not_a_note() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/notes.txt"),
            content: "plain\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("write_note writes notes; write_file writes everything else");
    assert!(
        matches!(error, MutationError::NotANote { .. }),
        "expected not_a_note, got {error:?}"
    );
}

#[test]
fn the_configuration_zone_refuses_every_semantic_operation() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path(".obsidian/app.md"),
            content: "# nope\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("nothing in the zone is ever indexed");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
}

#[test]
fn a_write_leaves_no_temporary_file_behind() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/New.md"),
            content: "# New\n".into(),
            expected: Precondition::Absent,
        })
        .expect("create a new note");
    assert_eq!(
        names_in(&fixture.root.join("Folder")),
        BTreeSet::from(["New.md".to_string()]),
        "the temp file must be renamed away, not left in the vault"
    );
}

#[test]
fn a_read_only_engine_refuses_before_it_touches_anything() {
    let fixture = fixture();
    let engine = MutationEngine::new(&fixture.root).with_read_only(true);
    let error = engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/New.md"),
            content: "# New\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("a read-only daemon writes nothing");
    assert_eq!(error, MutationError::ReadOnly);
    assert!(!fixture.root.join("Folder/New.md").exists());
}

#[test]
fn a_payload_past_the_cap_is_refused_whole() {
    let fixture = fixture();
    let engine = MutationEngine::new(&fixture.root).with_max_file_bytes(16);
    let error = engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/Big.md"),
            content: "x".repeat(17),
            expected: Precondition::Absent,
        })
        .expect_err("the cap is enforced before anything is written");
    match error {
        MutationError::TooLarge { limit, actual } => {
            assert_eq!(limit, 16);
            assert_eq!(actual, 17);
        }
        other => panic!("expected too_large, got {other:?}"),
    }
    assert!(!fixture.root.join("Folder/Big.md").exists());
}

/// A replace is a rename over the target, so the new inode carries the
/// temporary file's private mode unless the old one's is copied onto it. A
/// vault note that quietly went from `644` to `600` the first time the daemon
/// touched it would be a change no caller asked for.
#[cfg(unix)]
#[test]
fn replacing_a_note_keeps_the_permissions_it_had() {
    use std::os::unix::fs::PermissionsExt as _;

    let fixture = fixture();
    let target = fixture.root.join("One.md");
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644))
        .expect("set the readable mode a vault note normally has");

    fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("One.md"),
            content: "# One changed\n".into(),
            expected: Precondition::Any,
        })
        .expect("replace the note");

    let mode = std::fs::metadata(&target)
        .expect("stat the replaced note")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o644,
        "a replace must not narrow a note's permissions"
    );
}
