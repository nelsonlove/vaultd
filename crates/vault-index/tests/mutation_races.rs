//! Forced compare-and-swap races, made to open rather than waited for: the
//! interloper commits while the mutation is parked between its precondition
//! check and the act that precondition guards.
//!
//! On a real daemon the interloper is another process; here it is a plain
//! filesystem write, which is the same thing from the engine's point of view —
//! and the honest one, since vaultd is single-writer by lease and the only
//! writer it can genuinely race is one it does not own.

mod common;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    CopyConflict, DeleteMode, HookPoint, IndexConfig, IndexError, IndexService, Mutation,
    MutationError, Precondition, revision_of,
};

use common::once_at;

/// A service over a one-note vault, cold-built, with its index outside the
/// vault so the vault root holds exactly what a test put there.
struct Fixture {
    service: IndexService,
    root: std::path::PathBuf,
    _vault: TempDir,
    _index: TempDir,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("race config");
    let mut service = IndexService::open(config).expect("race service");
    service.refresh(false).expect("cold build");
    Fixture {
        service,
        root,
        _vault: vault,
        _index: index,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

/// Park at the mutation window and write `bytes` to `name` from it.
fn interloper_writes(fixture: &mut Fixture, name: &'static str, bytes: &'static str) {
    let root = fixture.root.clone();
    fixture
        .service
        .install_test_hook(once_at(HookPoint::AfterMutationPrecondition, move || {
            std::fs::write(root.join(name), bytes).expect("the interloper writes");
        }));
}

fn names_in(root: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .expect("read the vault root")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

#[test]
fn a_writer_parked_after_its_precondition_still_loses_to_the_writer_that_committed() {
    let mut fixture = fixture();
    interloper_writes(&mut fixture, "One.md", "# interloper\n");

    let error = fixture
        .service
        .apply_mutation(&Mutation::WriteNote {
            path: path("One.md"),
            content: "# parked writer\n".into(),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect_err("the parked writer must re-check and lose");
    assert!(
        matches!(
            error,
            IndexError::Mutation(MutationError::RevisionConflict { .. })
        ),
        "expected a revision conflict, got {error:?}"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# interloper\n",
        "the interloper's bytes must survive; a lost update is the one forbidden outcome"
    );
}

#[test]
fn an_unconditional_writer_parked_at_the_same_point_still_wins_last() {
    let mut fixture = fixture();
    interloper_writes(&mut fixture, "One.md", "# interloper\n");

    fixture
        .service
        .apply_mutation(&Mutation::WriteNote {
            path: path("One.md"),
            content: "# unconditional\n".into(),
            expected: Precondition::Any,
        })
        .expect("an unconditional write does not care who wrote last");
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# unconditional\n",
        "`any` is documented as last-writer-wins, and must behave that way"
    );
}

/// The `absent` window is **closed**, not narrowed, so this parks past every
/// re-check: the hook fires and the interloper creates the file with nothing
/// left between it and the create's own link. Only `persist_noclobber` can
/// refuse here.
#[test]
fn a_create_parked_past_its_last_check_still_refuses_to_clobber_the_name() {
    let mut fixture = fixture();
    interloper_writes(&mut fixture, "New.md", "# interloper\n");

    let error = fixture
        .service
        .apply_mutation(&Mutation::WriteNote {
            path: path("New.md"),
            content: "# parked creator\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("a create must never take a name somebody else claimed");
    match error {
        IndexError::Mutation(MutationError::RevisionConflict { current, .. }) => assert_eq!(
            current,
            Some(revision_of(b"# interloper\n")),
            "the loser is told what is there now"
        ),
        other => panic!("expected a revision conflict, got {other:?}"),
    }
    assert_eq!(
        std::fs::read(fixture.root.join("New.md")).expect("read back"),
        b"# interloper\n",
        "the interloper's file must survive whole"
    );
    assert_eq!(
        names_in(&fixture.root),
        vec!["New.md".to_string(), "One.md".to_string()],
        "and the refused create leaves no temporary behind"
    );
}

/// A delete's check-then-act window ends in the one act with nothing to retry
/// against, so it carries the same re-check a write does.
#[test]
fn a_delete_parked_after_its_precondition_refuses_rather_than_destroying_new_bytes() {
    let mut fixture = fixture();
    interloper_writes(&mut fixture, "One.md", "# interloper\n");

    let error = fixture
        .service
        .apply_mutation(&Mutation::DeleteNote {
            path: path("One.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect_err("the parked delete must re-check and lose");
    match error {
        IndexError::Mutation(MutationError::RevisionConflict { current, .. }) => assert_eq!(
            current,
            Some(revision_of(b"# interloper\n")),
            "the loser is told what it would have destroyed"
        ),
        other => panic!("expected a revision conflict, got {other:?}"),
    }
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# interloper\n",
        "bytes the delete never verified must still be there"
    );
}

/// `copy_file` promises never to overwrite. Its destination check runs before
/// the bytes are streamed, so the promise is only kept if the persist itself
/// refuses an occupied name.
#[test]
fn a_copy_parked_while_streaming_refuses_a_destination_that_appeared() {
    let mut fixture = fixture();
    interloper_writes(&mut fixture, "Copy.md", "# interloper\n");

    let error = fixture
        .service
        .apply_mutation(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Copy.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("a copy must not clobber a destination that appeared mid-stream");
    assert!(
        matches!(
            error,
            IndexError::Mutation(MutationError::TargetExists { .. })
        ),
        "expected target_exists, got {error:?}"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("Copy.md")).expect("read back"),
        b"# interloper\n",
        "the destination the caller asked to be protected must be untouched"
    );
    assert_eq!(
        names_in(&fixture.root),
        vec!["Copy.md".to_string(), "One.md".to_string()],
        "and the refused copy leaves no temporary behind"
    );
}

#[test]
fn a_refused_write_never_leaves_a_temporary_file_behind() {
    let mut fixture = fixture();

    let _ = fixture.service.apply_mutation(&Mutation::WriteNote {
        path: path("One.md"),
        content: "# refused\n".into(),
        expected: Precondition::Revision("blake3:0000".into()),
    });
    assert_eq!(names_in(&fixture.root), vec!["One.md".to_string()]);
}
