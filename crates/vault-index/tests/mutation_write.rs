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

/// The zone check reads the path the write would actually reach, not the
/// spelling the caller sent. On a case-insensitive filesystem `.OBSIDIAN`
/// *is* `.obsidian`, so a spelling-only comparison lets a semantic write land
/// in the one place the spec says nothing semantic may go.
#[test]
fn a_case_variant_spelling_of_the_zone_is_still_the_zone() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian/plugins")).expect("create the zone");
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path(".OBSIDIAN/plugins/x.md"),
            content: "# nope\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("a folded spelling reaches the same zone");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
    assert_eq!(
        names_in(&fixture.root.join(".obsidian/plugins")),
        BTreeSet::new(),
        "nothing may land in the zone"
    );
}

/// A note under any hidden folder is skipped by `refresh_paths`, so a write
/// there would report a revision at a generation the client can never read
/// back — the same read-your-writes break that makes a non-`.md` path a typed
/// refusal rather than a raw write.
#[test]
fn a_note_under_a_hidden_folder_is_refused() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".trash")).expect("create the local trash");
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path(".trash/Gone.md"),
            content: "# gone\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("the scan never lists a hidden folder");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
    assert_eq!(names_in(&fixture.root.join(".trash")), BTreeSet::new());
}

#[test]
fn a_note_under_a_nested_hidden_folder_is_refused() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join("a/.b")).expect("create the nested hidden folder");
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("a/.b/c.md"),
            content: "# hidden\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("hidden is hidden at any depth");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
    assert_eq!(names_in(&fixture.root.join("a/.b")), BTreeSet::new());
}

/// What the outcome names is what the coordinator hands to `refresh_paths`,
/// and the index must be keyed by the spelling the scanner emits — the one
/// stored on disk. On a case-insensitive filesystem the caller's spelling can
/// differ from it while addressing the same file, and reporting the caller's
/// would key a row the scanner never produces.
#[test]
fn the_outcome_names_the_on_disk_spelling_of_the_folder() {
    let fixture = fixture();
    let outcome = fixture.engine.apply(&Mutation::WriteNote {
        path: path("folder/New.md"),
        content: "# New\n".into(),
        expected: Precondition::Absent,
    });

    if fixture.root.join("folder").exists() {
        // A case-insensitive filesystem: `folder/` resolved to the stored
        // `Folder/`, and the write landed there under the stored spelling.
        let outcome = outcome.expect("the folded parent resolves to the stored folder");
        assert_eq!(
            outcome.changed_paths,
            BTreeSet::from([path("Folder/New.md")]),
            "the outcome must name the stored spelling, not the caller's"
        );
        assert_eq!(
            names_in(&fixture.root.join("Folder")),
            BTreeSet::from(["New.md".to_string()])
        );
    } else {
        // A case-sensitive filesystem: `folder/` is simply not there.
        let error = outcome.expect_err("no folder by that name exists");
        assert!(
            matches!(error, MutationError::ParentNotFound { .. }),
            "expected parent_not_found, got {error:?}"
        );
    }
}

/// The same phantom-row hazard as the folded-folder case, reached through the
/// *file name* rather than the folder: `resolve` canonicalizes the parent
/// only, so the final component still carries the caller's spelling. A case
/// mismatch there is refused by the collision check, but a normalization
/// mismatch is deliberately allowed to fold (it addresses the same file), and
/// then the caller's spelling is not the stored one.
#[test]
fn the_outcome_names_the_on_disk_normalization_of_the_file_name() {
    const COMPOSED: &str = "Caf\u{e9}.md"; // NFC: é as one codepoint
    const DECOMPOSED: &str = "Cafe\u{301}.md"; // NFD: e + combining acute

    let fixture = fixture();
    std::fs::write(fixture.root.join(COMPOSED), "# cafe\n").expect("write the composed name");

    let outcome = fixture.engine.apply(&Mutation::WriteNote {
        path: path(DECOMPOSED),
        content: "# changed\n".into(),
        expected: Precondition::Revision(revision_of(b"# cafe\n")),
    });

    if names_in(&fixture.root).contains(COMPOSED) && fixture.root.join(DECOMPOSED).exists() {
        // A normalization-folding filesystem: the two spellings are one file.
        let outcome = outcome.expect("the decomposed spelling addresses the stored file");
        assert_eq!(
            outcome.changed_paths,
            BTreeSet::from([path(COMPOSED)]),
            "the outcome must name the stored normalization, not the caller's"
        );
        assert_eq!(
            std::fs::read(fixture.root.join(COMPOSED)).expect("read back"),
            b"# changed\n"
        );
        assert!(
            !names_in(&fixture.root).contains(DECOMPOSED),
            "no second file may appear under the caller's spelling"
        );
    } else {
        // A filesystem that stores the two names apart: the decomposed name is
        // simply a different, absent file, and a revision precondition on it
        // is a plain not_found.
        let error = outcome.expect_err("the decomposed name is a different file here");
        assert!(
            matches!(error, MutationError::NotFound { .. }),
            "expected not_found, got {error:?}"
        );
    }
}

/// The witness for the *second* zone check — the one that runs on the resolved
/// path. Every dot-spelled path is already refused before `resolve` is called,
/// so a symlink whose resolved parent is hidden is the only input that reaches
/// it. Delete the post-resolve check and this test is what goes red.
#[cfg(unix)]
#[test]
fn a_symlink_into_a_hidden_folder_is_refused_after_resolution() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".secret")).expect("create the hidden folder");
    std::os::unix::fs::symlink(fixture.root.join(".secret"), fixture.root.join("Alias"))
        .expect("link an innocuous name at a hidden folder");

    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Alias/x.md"),
            content: "# hidden by another name\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("the link resolves into a folder the scan never lists");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
    assert_eq!(
        names_in(&fixture.root.join(".secret")),
        BTreeSet::new(),
        "nothing may land in a hidden folder under any name"
    );
}

/// The only failure that can happen *after* every check has passed. It must
/// be typed as a filesystem failure, leave the original bytes, and leave no
/// temporary file — the one test that would catch a plain `fs::write`
/// creeping back into the write path.
#[cfg(unix)]
#[test]
fn a_filesystem_failure_is_typed_and_leaves_the_note_alone() {
    use std::os::unix::fs::PermissionsExt as _;

    let fixture = fixture();
    let folder = fixture.root.join("Folder");
    std::fs::write(folder.join("A.md"), "# a\n").expect("write A");
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o500))
        .expect("make the folder unwritable");

    let outcome = fixture.engine.apply(&Mutation::WriteNote {
        path: path("Folder/A.md"),
        content: "# clobbered\n".into(),
        expected: Precondition::Any,
    });

    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755))
        .expect("restore the folder so the tempdir can be cleaned up");

    let error = outcome.expect_err("a temp file cannot be created in an unwritable folder");
    assert!(
        matches!(error, MutationError::Io { .. }),
        "expected a typed filesystem failure, got {error:?}"
    );
    assert_eq!(
        std::fs::read(folder.join("A.md")).expect("read back"),
        b"# a\n"
    );
    assert_eq!(
        names_in(&folder),
        BTreeSet::from(["A.md".to_string()]),
        "a failed write leaves no temporary file"
    );
}

/// A created note has no old mode to keep, so it takes the one the folder
/// implies — the same `0644` inside a `0755` folder that every other tool
/// writing into the vault produces.
#[cfg(unix)]
#[test]
fn a_created_note_takes_its_mode_from_the_folder_it_lands_in() {
    use std::os::unix::fs::PermissionsExt as _;

    let fixture = fixture();
    let folder = fixture.root.join("Folder");
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755))
        .expect("a world-readable folder");

    fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/New.md"),
            content: "# New\n".into(),
            expected: Precondition::Absent,
        })
        .expect("create a new note");

    let mode = std::fs::metadata(folder.join("New.md"))
        .expect("stat the new note")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o644,
        "a 0755 folder implies 0644 notes, not tempfile's 0600"
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

/// The pair rule, stated once: a `.md` path goes through `write_note`,
/// everything else through `write_file`, and neither crosses into the other's
/// half.
#[test]
fn a_raw_write_refuses_a_markdown_path_and_write_note_refuses_everything_else() {
    let fixture = fixture();
    let raw_note = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path("Folder/Raw.md"),
            content: b"# Raw\n".to_vec(),
            expected: Precondition::Absent,
        })
        .expect_err("write_file must not reach a note");
    assert!(
        matches!(raw_note, MutationError::IsANote { .. }),
        "expected is_a_note, got {raw_note:?}"
    );
    assert!(!fixture.root.join("Folder/Raw.md").exists());

    // The mirror image, already covered by `a_non_markdown_path_is_not_a_note`
    // above, restated here so the pair reads as one rule: `.md` goes through
    // `write_note`, everything else through `write_file`, and neither crosses.
    let raw_attachment = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path("Folder/data.bin"),
            content: vec![1, 2, 3],
            expected: Precondition::Absent,
        })
        .expect("an attachment is exactly what write_file is for");
    assert!(
        !raw_attachment.semantic,
        "an attachment carries no semantics the index reads"
    );
    // But it *is* a tree row, and the change set is what the tree is
    // reconciled from. Naming nothing here would leave `snapshot_tree` serving
    // a tree missing the daemon's own attachment — the under-naming hazard
    // `MutationOutcome::changed_paths` documents.
    assert_eq!(
        raw_attachment.changed_paths,
        BTreeSet::from([path("Folder/data.bin")]),
        "a raw write inside the indexed vault must name the path it moved"
    );
}

#[test]
fn a_zone_write_reaches_the_zone_and_stays_out_of_the_change_set() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    let outcome = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path(".obsidian/app.json"),
            content: br#"{"trashOption":"local"}"#.to_vec(),
            expected: Precondition::Any,
        })
        .expect("the zone is writable through the raw pair");
    assert!(!outcome.semantic);
    assert!(
        outcome.changed_paths.is_empty(),
        "the scan never lists the zone, so naming a path there would ask for a \
         reconciliation that can only ever find nothing"
    );
    assert_eq!(
        std::fs::read(fixture.root.join(".obsidian/app.json")).expect("read back"),
        br#"{"trashOption":"local"}"#.to_vec()
    );
}

/// A hidden folder is not the configuration zone, and the raw pair reaches it
/// for the same reason: the scan never lists it, so nothing there can join a
/// generation. It is the second half of the predicate the wire's `semantic`
/// field answers with.
#[test]
fn a_hidden_path_is_written_raw_and_stays_out_of_the_change_set() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".hidden")).expect("create a hidden folder");
    let outcome = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path(".hidden/data.bin"),
            content: vec![7, 8, 9],
            expected: Precondition::Absent,
        })
        .expect("a hidden attachment is raw-writable");
    assert!(!outcome.semantic);
    assert!(outcome.changed_paths.is_empty());
    assert_eq!(
        std::fs::read(fixture.root.join(".hidden/data.bin")).expect("read back"),
        [7, 8, 9]
    );
}

/// A read is the only verb that answers about a path without judging it: a
/// note, an attachment, and the zone all come back as bytes plus the revision
/// a later `write_file` compares against. An absent path is `not_found`, never
/// an empty answer.
#[test]
fn a_raw_read_answers_for_every_kind_of_path_and_refuses_an_absent_one() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    std::fs::write(fixture.root.join(".obsidian/app.json"), b"{}").expect("write app.json");
    std::fs::write(fixture.root.join("Folder/data.bin"), [1u8, 2, 3]).expect("write an attachment");

    for (spelling, expected) in [
        ("One.md", b"# One\n".to_vec()),
        ("Folder/data.bin", vec![1, 2, 3]),
        (".obsidian/app.json", b"{}".to_vec()),
    ] {
        let (bytes, revision) = fixture
            .engine
            .read_file(&path(spelling))
            .unwrap_or_else(|error| panic!("read {spelling}: {error:?}"));
        assert_eq!(bytes, expected, "wrong bytes for {spelling}");
        assert_eq!(
            revision,
            revision_of(&expected),
            "wrong revision for {spelling}"
        );
    }

    let error = fixture
        .engine
        .read_file(&path("Folder/Gone.bin"))
        .expect_err("an absent path has no bytes");
    assert!(
        matches!(error, MutationError::NotFound { .. }),
        "expected not_found, got {error:?}"
    );
}

/// The partition ruling. `write_file`'s note refusal exists so raw bytes can
/// never bypass a generation — but inside a hidden folder *no* generation will
/// ever describe the bytes whichever verb writes them, so the refusal buys
/// nothing there and only removes the one verb that could serve the path.
/// `.trash/` makes it concrete: `delete_note` with `mode: local` puts notes
/// there, `read_file` will read them back, and before this rule nothing could
/// write one back.
#[test]
fn a_markdown_file_in_a_hidden_folder_is_raw_bytes_not_a_note() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".hidden")).expect("create a hidden folder");

    let outcome = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path(".hidden/note.md"),
            content: b"# hidden\n".to_vec(),
            expected: Precondition::Absent,
        })
        .expect("a note the scan will never list is raw bytes, not a note");
    assert!(!outcome.semantic);
    assert!(
        outcome.changed_paths.is_empty(),
        "empty iff unindexable: the scan never lists a hidden folder, so a \
         reconciliation of this path could only ever find nothing"
    );
    assert_eq!(
        std::fs::read(fixture.root.join(".hidden/note.md")).expect("read back"),
        b"# hidden\n"
    );

    // The other half of the same rule, so the partition reads as one fact:
    // the semantic verb still refuses the path outright.
    let refused = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path(".hidden/note.md"),
            content: "# hidden\n".into(),
            expected: Precondition::Any,
        })
        .expect_err("write_note must still refuse a path no generation can describe");
    assert!(
        matches!(refused, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {refused:?}"
    );
}

/// Every path is served by **exactly one** of the two write verbs. This is the
/// test that would have caught the gap the first draft opened: a Markdown file
/// inside a hidden folder was refused by both.
#[test]
fn the_two_write_verbs_partition_every_path() {
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum Verb {
        Note,
        Raw,
    }

    let cases = [
        // An ordinary note.
        ("One.md", Verb::Note),
        // A hidden *file* at the root is not a hidden folder — `is_hidden`
        // deliberately never judges the last component, the scan indexes it,
        // and so it is a note like any other.
        (".hidden-note.md", Verb::Note),
        // Not Markdown: raw by extension.
        ("Folder/data.bin", Verb::Raw),
        // Markdown the scan will never list: raw by location.
        (".hidden/note.md", Verb::Raw),
        // A plugin's own Markdown, inside the zone.
        (".obsidian/plugins/x/data.md", Verb::Raw),
        // The local trash, which `delete_note { mode: local }` fills.
        (".trash/Deleted.md", Verb::Raw),
    ];

    for (spelling, accepted_by) in cases {
        let fixture = fixture();
        if let Some(parent) = std::path::Path::new(spelling).parent() {
            if parent != std::path::Path::new("") {
                std::fs::create_dir_all(fixture.root.join(parent)).expect("create the parent");
            }
        }

        let note = fixture.engine.apply(&Mutation::WriteNote {
            path: path(spelling),
            content: "# body\n".into(),
            expected: Precondition::Any,
        });
        let raw = fixture.engine.apply(&Mutation::WriteFile {
            path: path(spelling),
            content: b"# body\n".to_vec(),
            expected: Precondition::Any,
        });

        match accepted_by {
            Verb::Note => {
                note.unwrap_or_else(|error| panic!("write_note must serve {spelling}: {error:?}"));
                let error = raw.expect_err(&format!("write_file must refuse {spelling}"));
                assert!(
                    matches!(error, MutationError::IsANote { .. }),
                    "{spelling} must be refused as a note, got {error:?}"
                );
            }
            Verb::Raw => {
                raw.unwrap_or_else(|error| panic!("write_file must serve {spelling}: {error:?}"));
                let error = note.expect_err(&format!("write_note must refuse {spelling}"));
                assert!(
                    matches!(
                        error,
                        MutationError::ZoneViolation { .. } | MutationError::NotANote { .. }
                    ),
                    "{spelling} must be refused by write_note, got {error:?}"
                );
            }
        }
    }
}

/// A raw write answers for **where it landed**, not for what it was called.
/// The engine already resolves and canonicalizes; the outcome has to carry
/// that spelling out, or every reporting decision above it is made on the
/// caller's guess.
#[cfg(unix)]
#[test]
fn a_raw_write_reports_the_path_it_landed_on_not_the_one_it_was_given() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    std::os::unix::fs::symlink(
        fixture.root.join(".obsidian"),
        fixture.root.join("ZoneAlias"),
    )
    .expect("link an innocuous name at the zone");

    let outcome = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path("ZoneAlias/app.json"),
            content: br#"{"trashOption":"local"}"#.to_vec(),
            expected: Precondition::Absent,
        })
        .expect("the alias resolves into the zone, which the raw pair may write");
    assert_eq!(
        outcome.written.as_ref().map(vault_core::VaultPath::as_str),
        Some(".obsidian/app.json"),
        "the outcome must name the zone path the bytes reached, not the alias"
    );
    assert!(
        outcome.changed_paths.is_empty(),
        "the bytes landed in the zone, so nothing joins a generation"
    );
    assert_eq!(
        std::fs::read(fixture.root.join(".obsidian/app.json")).expect("read back"),
        br#"{"trashOption":"local"}"#.to_vec()
    );
}

/// The mirror image, and the reason the post-resolve note check exists: an
/// alias *out* of the zone must not let a raw write land a note in the indexed
/// vault. Delete the post-resolve guard and this is what goes red.
#[cfg(unix)]
#[test]
fn a_zone_alias_that_escapes_the_zone_cannot_land_a_note() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    std::os::unix::fs::symlink("..", fixture.root.join(".obsidian/up"))
        .expect("link the zone back at the vault root");

    let error = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path(".obsidian/up/Evil.md"),
            content: b"# raw\n".to_vec(),
            expected: Precondition::Absent,
        })
        .expect_err("the zone exemption is about the zone, not about the spelling");
    assert!(
        matches!(error, MutationError::IsANote { .. }),
        "expected is_a_note, got {error:?}"
    );
    assert!(
        !fixture.root.join("Evil.md").exists(),
        "a raw write must never land a note in the indexed vault"
    );
}

/// The read path takes the same file-type guard every other reader takes.
/// Without it a directory answers `storage_failure` — a claim the daemon is
/// broken and an invitation to retry a request that can never succeed — and a
/// FIFO blocks the reading thread on an open that waits for a writer.
#[test]
fn a_read_of_a_non_regular_file_is_refused_before_anything_is_opened() {
    let fixture = fixture();
    let error = fixture
        .engine
        .read_file(&path("Folder"))
        .expect_err("a directory is not a file to read");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
}

/// The cap is symmetric. A client that could read a 20 MiB attachment it can
/// never write back would get a ~28 MB single JSON line no streaming client
/// can chunk — and the same typed refusal already names the deferred
/// alternative.
#[test]
fn a_read_past_the_cap_is_refused_rather_than_materialised() {
    let fixture = fixture();
    let engine = MutationEngine::new(&fixture.root).with_max_file_bytes(64);
    std::fs::write(fixture.root.join("Folder/big.bin"), vec![0u8; 65]).expect("write past the cap");

    let error = engine
        .read_file(&path("Folder/big.bin"))
        .expect_err("a file past the cap is not served");
    match error {
        MutationError::TooLarge { limit, actual } => {
            assert_eq!(limit, 64);
            assert_eq!(actual, 65);
        }
        other => panic!("expected too_large, got {other:?}"),
    }

    // Exactly at the cap is served: the bound is inclusive on the read side
    // exactly as it is on the write side.
    std::fs::write(fixture.root.join("Folder/edge.bin"), vec![0u8; 64]).expect("write at the cap");
    let (bytes, _) = engine
        .read_file(&path("Folder/edge.bin"))
        .expect("a file at the cap is served");
    assert_eq!(bytes.len(), 64);
}
