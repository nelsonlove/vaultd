//! Rename link repair: spelling-preserving, per-file compare-and-swap,
//! referrers rewritten before the file moves.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    HookPoint, IndexConfig, IndexService, Mutation, Precondition, TestHook, revision_of,
};

struct Fixture {
    service: IndexService,
    root: PathBuf,
    _vault: TempDir,
    _index: TempDir,
}

/// `Alpha.md` is referenced five ways: the shortest form, with its extension,
/// with a heading subpath *and* display text, relatively from a sibling
/// folder, and through Markdown link syntax. Every one of them must survive a
/// rename with its own shape intact.
///
/// Every fixture reference is a real link — a `[[wikilink]]` or a
/// `[display](target)` — because a bare name in prose parses as prose and
/// would make the whole suite assert nothing.
fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Nested")).expect("create Nested");
    std::fs::write(root.join("Alpha.md"), "# Heading\n\ntext ^block\n").expect("write Alpha");
    std::fs::write(root.join("Short.md"), "before [[Alpha]] after\n").expect("write Short");
    std::fs::write(root.join("Extended.md"), "[[Alpha.md]]\n").expect("write Extended");
    std::fs::write(root.join("Explicit.md"), "[[Alpha#Heading|shown]]\n").expect("write Explicit");
    std::fs::write(root.join("Markdown.md"), "[shown](Alpha.md)\n").expect("write Markdown");
    std::fs::write(root.join("Nested/Relative.md"), "[[../Alpha]]\n").expect("write Relative");
    std::fs::write(root.join("Unrelated.md"), "[[Short]]\n").expect("write Unrelated");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("repair config");
    let mut service = IndexService::open(config).expect("repair service");
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

fn read(fixture: &Fixture, name: &str) -> String {
    std::fs::read_to_string(fixture.root.join(name)).expect("read a note")
}

#[test]
fn a_rename_preserves_every_referrers_own_spelling_shape() {
    let mut fixture = fixture();
    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename with repair");

    assert_eq!(read(&fixture, "Short.md"), "before [[Renamed]] after\n");
    assert_eq!(read(&fixture, "Extended.md"), "[[Renamed.md]]\n");
    assert_eq!(
        read(&fixture, "Explicit.md"),
        "[[Renamed#Heading|shown]]\n",
        "the subpath and the display text are outside the file-target span and must not move"
    );
    assert_eq!(
        read(&fixture, "Markdown.md"),
        "[shown](Renamed.md)\n",
        "a Markdown link's display half is outside the destination span too"
    );
    assert_eq!(read(&fixture, "Unrelated.md"), "[[Short]]\n");
    assert_eq!(outcome.links_rewritten, 5);
    assert!(outcome.link_rewrite_failures.is_empty());
    assert!(fixture.root.join("Renamed.md").is_file());
    assert!(!fixture.root.join("Alpha.md").exists());
    assert!(
        outcome.changed_paths.contains(&path("Short.md")),
        "a rewritten referrer has to reach reconciliation or its rows describe the old bytes"
    );
}

#[test]
fn a_relative_spelling_that_still_reaches_the_target_stays_relative() {
    let mut fixture = fixture();
    fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename with repair");
    assert_eq!(read(&fixture, "Nested/Relative.md"), "[[../Renamed]]\n");
}

#[test]
fn ambiguity_the_rename_introduces_upgrades_the_spelling_to_the_explicit_path() {
    let mut fixture = fixture();
    // A second note whose stem collides with the rename's destination, and a
    // destination that is nested like it — an exact vault path always wins
    // outright, so a *root* namesake would keep the shortest form unambiguous
    // however many nested twins existed, and this test would prove nothing.
    std::fs::create_dir_all(fixture.root.join("Other")).expect("create Other");
    std::fs::write(fixture.root.join("Nested/Beta.md"), "# Beta\n").expect("write Nested/Beta");
    fixture.service.refresh(false).expect("index the new note");

    fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Other/Beta.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename into an ambiguous stem");

    assert_eq!(
        read(&fixture, "Short.md"),
        "before [[Other/Beta]] after\n",
        "over-specifying is safe; silently retargeting is not"
    );
}

#[test]
fn a_referrer_edited_out_of_band_is_skipped_and_reported_never_clobbered() {
    let mut fixture = fixture();
    // Moves `Short.md` past the revision the index knows, exactly as an
    // external editor would between the last reconciliation and this rename.
    std::fs::write(
        fixture.root.join("Short.md"),
        "before [[Alpha]] after, edited\n",
    )
    .expect("edit Short out of band");

    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename with repair");

    assert_eq!(
        read(&fixture, "Short.md"),
        "before [[Alpha]] after, edited\n",
        "a concurrently-edited referrer is never clobbered"
    );
    let failures: Vec<&str> = outcome
        .link_rewrite_failures
        .iter()
        .map(|failure| failure.path.as_str())
        .collect();
    assert_eq!(failures, vec!["Short.md"]);
    assert_eq!(
        outcome.link_rewrite_failures[0].reason, "revision_conflict",
        "the caller must be able to tell why, not just that"
    );
    assert!(
        !outcome.changed_paths.contains(&path("Short.md")),
        "a skipped file is not in the change set"
    );
    assert_eq!(read(&fixture, "Extended.md"), "[[Renamed.md]]\n");
}

#[test]
fn every_rewrite_and_the_move_land_in_one_generation() {
    let mut fixture = fixture();
    let before = fixture
        .service
        .current_generation()
        .expect("generation")
        .expect("published");
    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename with repair");
    let report = fixture
        .service
        .refresh_paths(
            outcome.changed_paths.clone(),
            vault_index::ChangeCause::Mutation,
        )
        .expect("reconcile the whole burst");
    assert_eq!(
        report.generation.get(),
        before.get() + 1,
        "the burst is one generation, not one per rewritten file"
    );
    assert!(report.changes.deleted.contains(&path("Alpha.md")));
    assert!(report.changes.created.contains(&path("Renamed.md")));
}

#[test]
fn a_crash_between_the_rewrites_and_the_move_converges_on_a_retry() {
    struct StopBeforeMove {
        fired: AtomicBool,
    }
    impl TestHook for StopBeforeMove {
        fn reach(&self, point: HookPoint) {
            if point == HookPoint::BeforeRenameMove && !self.fired.swap(true, Ordering::SeqCst) {
                panic!("simulated crash between the rewrites and the move");
            }
        }
    }

    let mut fixture = fixture();
    fixture.service.install_test_hook(Arc::new(StopBeforeMove {
        fired: AtomicBool::new(false),
    }));
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = fixture.service.apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        });
    }));
    assert!(crashed.is_err(), "the hook must have aborted the burst");

    // Referrers already point at the new path; the file is still at the old
    // one. Visible as unresolved references, never as stale links that look
    // resolved.
    assert_eq!(read(&fixture, "Short.md"), "before [[Renamed]] after\n");
    assert!(fixture.root.join("Alpha.md").is_file());

    // The hook fires once, so the retry completes the move.
    fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("the retry converges");
    assert!(fixture.root.join("Renamed.md").is_file());
    assert_eq!(read(&fixture, "Short.md"), "before [[Renamed]] after\n");
}

#[test]
fn a_rename_that_will_be_refused_rewrites_nothing_first() {
    let mut fixture = fixture();
    let error = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Short.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect_err("the destination already exists");
    assert!(
        matches!(
            error,
            vault_index::IndexError::Mutation(vault_index::MutationError::TargetExists { .. })
        ),
        "expected target_exists, got {error:?}"
    );
    assert_eq!(read(&fixture, "Short.md"), "before [[Alpha]] after\n");
    assert_eq!(read(&fixture, "Extended.md"), "[[Alpha.md]]\n");
}

/// The precondition is re-evaluated with nothing between it and the move, so a
/// referrer burst that has already landed cannot be followed by a move over a
/// source somebody else replaced in the meantime.
#[test]
fn a_stale_revision_precondition_is_refused_and_moves_nothing() {
    let mut fixture = fixture();
    let error = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Revision(revision_of(b"# something else\n")),
            rewrite_links: true,
        })
        .expect_err("the source does not hold that revision");
    assert!(
        matches!(
            error,
            vault_index::IndexError::Mutation(vault_index::MutationError::RevisionConflict { .. })
        ),
        "expected revision_conflict, got {error:?}"
    );
    assert!(fixture.root.join("Alpha.md").is_file());
    assert_eq!(
        read(&fixture, "Short.md"),
        "before [[Alpha]] after\n",
        "a rename that will be refused rewrites nothing on its way to failing"
    );
}

#[test]
fn renaming_a_folder_repairs_references_to_every_note_it_carried() {
    let mut fixture = fixture();
    std::fs::write(fixture.root.join("Nested/Inner.md"), "# Inner\n").expect("write Inner");
    std::fs::write(fixture.root.join("Pointer.md"), "[[Nested/Inner]]\n").expect("write Pointer");
    fixture.service.refresh(false).expect("index the new notes");

    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameFolder {
            from: path("Nested"),
            to: path("Moved"),
            rewrite_links: true,
        })
        .expect("rename a folder with repair");

    assert_eq!(
        read(&fixture, "Pointer.md"),
        "[[Moved/Inner]]\n",
        "a path-form spelling stays a path-form spelling"
    );
    assert!(outcome.links_rewritten >= 1);
    assert!(fixture.root.join("Moved/Inner.md").is_file());
    assert!(
        outcome.revision.is_none(),
        "a folder has no bytes to hash, so it reports no revision at all"
    );
    assert!(outcome.semantic, "notes moved, so the semantic layer moved");
}

#[test]
fn rewrite_links_false_moves_the_file_and_leaves_every_referrer_alone() {
    let mut fixture = fixture();
    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect("rename without repair");
    assert_eq!(read(&fixture, "Short.md"), "before [[Alpha]] after\n");
    assert_eq!(outcome.links_rewritten, 0);
    assert!(outcome.link_rewrite_failures.is_empty());
    assert!(fixture.root.join("Renamed.md").is_file());
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(b"# Heading\n\ntext ^block\n").as_str()),
        "the moved note's bytes are unchanged, so its revision is its old one"
    );
}
