//! Rename link repair: spelling-preserving, per-file compare-and-swap at plan
//! time *and* at write time, the movement first and the referrer rewrites
//! second, and every reference the burst declines to repair reported with a
//! stable reason code.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    HookPoint, IndexConfig, IndexService, IoKind, LinkRewriteReason, Mutation, MutationError,
    Precondition, TestHook, revision_of,
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
///
/// `A.md` and `Note.md` are inert decoys. They exist so the two destination
/// names a wikilink cannot spell — `A|B.md` and `Note#1.md` — have something
/// to be silently mis-resolved *to* if the emitted link is not validated
/// against the syntax it is spliced into.
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
    std::fs::write(root.join("A.md"), "# A\n").expect("write A");
    std::fs::write(root.join("Note.md"), "# Note\n").expect("write Note");

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

fn rename(fixture: &mut Fixture, from: &str, to: &str) -> vault_index::MutationOutcome {
    fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path(from),
            to: path(to),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename with repair")
}

/// Reconcile the burst and report how `note`'s single outgoing reference
/// resolved — the honest reading of the bytes on disk, not a stale row.
fn resolution_after(
    fixture: &mut Fixture,
    changed: std::collections::BTreeSet<VaultPath>,
    note: &str,
) -> Vec<vault_core::Resolution> {
    fixture
        .service
        .refresh_paths(changed, vault_index::ChangeCause::Mutation)
        .expect("reconcile the burst");
    fixture
        .service
        .get_note(&path(note))
        .expect("read the note back")
        .outgoing
        .into_iter()
        .map(|reference| reference.resolution)
        .collect()
}

fn reasons(outcome: &vault_index::MutationOutcome) -> Vec<(&str, LinkRewriteReason)> {
    outcome
        .link_rewrite_failures
        .iter()
        .map(|failure| (failure.path.as_str(), failure.reason))
        .collect()
}

/// Install a hook that runs `action` once, the first time `point` is reached.
fn once_at(point: HookPoint, action: impl Fn() + Send + Sync + 'static) -> Arc<dyn TestHook> {
    struct Once<F> {
        point: HookPoint,
        fired: AtomicBool,
        action: F,
    }
    impl<F: Fn() + Send + Sync> TestHook for Once<F> {
        fn reach(&self, point: HookPoint) {
            if point == self.point && !self.fired.swap(true, Ordering::SeqCst) {
                (self.action)();
            }
        }
    }
    Arc::new(Once {
        point,
        fired: AtomicBool::new(false),
        action,
    })
}

#[test]
fn a_rename_preserves_every_referrers_own_spelling_shape() {
    let mut fixture = fixture();
    let outcome = rename(&mut fixture, "Alpha.md", "Renamed.md");

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
    rename(&mut fixture, "Alpha.md", "Renamed.md");
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

    rename(&mut fixture, "Alpha.md", "Other/Beta.md");

    assert_eq!(
        read(&fixture, "Short.md"),
        "before [[Other/Beta]] after\n",
        "over-specifying is safe; silently retargeting is not"
    );
}

// ---------------------------------------------------------------------------
// The destination names a wikilink cannot spell.
// ---------------------------------------------------------------------------

/// `|` inside a wikilink starts the display text, so `[[A|B]]` names `A.md`
/// — a *different existing note*. The candidate must therefore be validated
/// against the syntax it is spliced into, not only as a target string, and
/// the reference falls back to Markdown syntax where the name can be spelled.
#[test]
fn a_destination_a_wikilink_cannot_spell_becomes_a_markdown_link() {
    let mut fixture = fixture();
    let outcome = rename(&mut fixture, "Alpha.md", "A|B.md");

    assert_eq!(
        read(&fixture, "Short.md"),
        "before [A|B](A%7CB) after\n",
        "[[A|B]] would name A.md; the Markdown form spells the real name"
    );
    assert_eq!(
        read(&fixture, "Explicit.md"),
        "[shown](A%7CB#Heading)\n",
        "the display text and the subpath survive the syntax change"
    );
    assert!(outcome.link_rewrite_failures.is_empty());

    let resolutions = resolution_after(&mut fixture, outcome.changed_paths.clone(), "Short.md");
    assert_eq!(
        resolutions,
        vec![vault_core::Resolution::Resolved {
            target: path("A|B.md"),
            subpath: None
        }],
        "the repaired link must resolve to the renamed note, never to A.md"
    );
}

/// `#` inside a wikilink starts the subpath, so `[[Note#1.md]]` names
/// `Note.md`. The Markdown form escapes it as `%23`.
#[test]
fn a_destination_with_a_hash_is_percent_encoded_in_a_markdown_link() {
    let mut fixture = fixture();
    let outcome = rename(&mut fixture, "Alpha.md", "Note#1.md");

    assert_eq!(
        read(&fixture, "Short.md"),
        "before [Note#1](Note%231) after\n"
    );
    assert_eq!(
        read(&fixture, "Markdown.md"),
        "[shown](Note%231.md)\n",
        "a Markdown link stays a Markdown link and only its destination is escaped"
    );
    assert!(outcome.link_rewrite_failures.is_empty());

    let resolutions = resolution_after(&mut fixture, outcome.changed_paths.clone(), "Markdown.md");
    assert_eq!(
        resolutions,
        vec![vault_core::Resolution::Resolved {
            target: path("Note#1.md"),
            subpath: None
        }],
        "the repaired link must resolve to the renamed note, never to Note.md"
    );
}

/// Frontmatter carries wikilinks and nothing else, so a name a wikilink
/// cannot spell has no representation there at all. The bytes are left alone
/// and the reference is reported — never rewritten into a link that means
/// another note.
#[test]
fn a_frontmatter_reference_that_cannot_be_spelled_is_reported_not_corrupted() {
    let mut fixture = fixture();
    std::fs::write(
        fixture.root.join("Front.md"),
        "---\nrelated: \"[[Alpha]]\"\n---\n\nbody\n",
    )
    .expect("write Front");
    fixture.service.refresh(false).expect("index Front");

    let outcome = rename(&mut fixture, "Alpha.md", "A|B.md");

    assert_eq!(
        read(&fixture, "Front.md"),
        "---\nrelated: \"[[Alpha]]\"\n---\n\nbody\n",
        "a reference that cannot be spelled is left exactly as it was"
    );
    assert_eq!(
        reasons(&outcome),
        vec![("Front.md", LinkRewriteReason::UnwritableSpelling)]
    );
    assert!(
        !outcome.changed_paths.contains(&path("Front.md")),
        "a declined referrer is not in the change set"
    );
}

// ---------------------------------------------------------------------------
// Every contained note, wherever the referrer lives.
// ---------------------------------------------------------------------------

/// A path-form link written from *inside* the folder being renamed is an
/// inbound reference to a contained note by any reading, and the move breaks
/// it exactly as it breaks one from outside.
#[test]
fn a_path_form_link_from_inside_the_renamed_folder_is_repaired() {
    let mut fixture = fixture();
    std::fs::write(fixture.root.join("Nested/One.md"), "# One\n").expect("write One");
    std::fs::write(
        fixture.root.join("Nested/Two.md"),
        "[[Nested/One]] and [[One]] and [[./One]]\n",
    )
    .expect("write Two");
    std::fs::write(fixture.root.join("Outside.md"), "[[Nested/One]]\n").expect("write Outside");
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
        read(&fixture, "Moved/Two.md"),
        "[[Moved/One]] and [[One]] and [[./One]]\n",
        "the path form is repaired; the two spellings that still reach the note are untouched"
    );
    assert_eq!(read(&fixture, "Outside.md"), "[[Moved/One]]\n");
    assert!(outcome.link_rewrite_failures.is_empty());
    assert!(
        outcome.changed_paths.contains(&path("Moved/Two.md")),
        "a referrer rewritten at its new path still has to reach reconciliation"
    );
}

/// The one-note-wide case of the same thing.
#[test]
fn a_self_reference_inside_a_renamed_note_is_repaired() {
    let mut fixture = fixture();
    std::fs::write(
        fixture.root.join("Alpha.md"),
        "# Heading\n\nsee [[Alpha]]\n",
    )
    .expect("rewrite Alpha with a self-reference");
    fixture.service.refresh(false).expect("reindex Alpha");

    let outcome = rename(&mut fixture, "Alpha.md", "Renamed.md");

    assert_eq!(
        read(&fixture, "Renamed.md"),
        "# Heading\n\nsee [[Renamed]]\n"
    );
    assert!(outcome.link_rewrite_failures.is_empty());
}

/// An attachment is not a note, so the live graph carries no identity for it
/// — but the reference rows do reach it, and a folder rename moves it just the
/// same.
#[test]
fn an_attachment_embed_under_a_renamed_folder_is_repaired() {
    let mut fixture = fixture();
    std::fs::write(fixture.root.join("Nested/img.png"), b"not really a png")
        .expect("write the attachment");
    std::fs::write(fixture.root.join("Outside.md"), "![[Nested/img.png]]\n")
        .expect("write Outside");
    fixture.service.refresh(false).expect("index the embed");

    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameFolder {
            from: path("Nested"),
            to: path("Moved"),
            rewrite_links: true,
        })
        .expect("rename a folder with repair");

    assert_eq!(read(&fixture, "Outside.md"), "![[Moved/img.png]]\n");
    assert!(fixture.root.join("Moved/img.png").is_file());
    assert!(outcome.link_rewrite_failures.is_empty());
}

// ---------------------------------------------------------------------------
// Compare-and-swap, at plan time and at write time.
// ---------------------------------------------------------------------------

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

    let outcome = rename(&mut fixture, "Alpha.md", "Renamed.md");

    assert_eq!(
        read(&fixture, "Short.md"),
        "before [[Alpha]] after, edited\n",
        "a concurrently-edited referrer is never clobbered"
    );
    assert_eq!(
        reasons(&outcome),
        vec![("Short.md", LinkRewriteReason::RevisionConflict)],
        "the caller must be able to tell why, not just that"
    );
    assert!(
        !outcome.changed_paths.contains(&path("Short.md")),
        "a skipped file is not in the change set"
    );
    assert_eq!(read(&fixture, "Extended.md"), "[[Renamed.md]]\n");
}

/// The window the plan-time check cannot cover: a referrer edited *after* the
/// plan and before its own write, with every other referrer's write in
/// between. Forced from the rendezvous point rather than raced for.
#[test]
fn a_referrer_edited_between_the_plan_and_the_write_is_reported_never_clobbered() {
    let mut fixture = fixture();
    let target = fixture.root.join("Short.md");
    fixture
        .service
        .install_test_hook(once_at(HookPoint::BeforeLinkRewrites, move || {
            std::fs::write(&target, "FOREIGN EDIT\n").expect("edit Short from the hook");
        }));

    let outcome = rename(&mut fixture, "Alpha.md", "Renamed.md");

    assert_eq!(
        read(&fixture, "Short.md"),
        "FOREIGN EDIT\n",
        "the foreign edit wins; the stale patched body is never written over it"
    );
    assert_eq!(
        reasons(&outcome),
        vec![("Short.md", LinkRewriteReason::RevisionConflict)]
    );
    assert!(!outcome.changed_paths.contains(&path("Short.md")));
    // The rest of the burst still lands.
    assert_eq!(read(&fixture, "Extended.md"), "[[Renamed.md]]\n");
    assert!(fixture.root.join("Renamed.md").is_file());
}

/// The same window, with a delete rather than an edit. `resolve` answers `Ok`
/// for an absent path by design, so an unguarded write would **recreate** the
/// deleted note with its stale body.
#[test]
fn a_referrer_deleted_between_the_plan_and_the_write_is_never_resurrected() {
    let mut fixture = fixture();
    let target = fixture.root.join("Short.md");
    fixture
        .service
        .install_test_hook(once_at(HookPoint::BeforeLinkRewrites, move || {
            std::fs::remove_file(&target).expect("delete Short from the hook");
        }));

    let outcome = rename(&mut fixture, "Alpha.md", "Renamed.md");

    assert!(
        !fixture.root.join("Short.md").exists(),
        "a deleted referrer stays deleted"
    );
    assert_eq!(
        reasons(&outcome),
        vec![("Short.md", LinkRewriteReason::SourceAbsent)]
    );
    assert!(!outcome.changed_paths.contains(&path("Short.md")));
}

// ---------------------------------------------------------------------------
// Ordering: the movement lands first.
// ---------------------------------------------------------------------------

#[test]
fn every_rewrite_and_the_move_land_in_one_generation() {
    let mut fixture = fixture();
    let before = fixture
        .service
        .current_generation()
        .expect("generation")
        .expect("published");
    let outcome = rename(&mut fixture, "Alpha.md", "Renamed.md");
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

/// The destination is claimed **before** a single referrer is rewritten, so a
/// foreign writer racing for the same name is refused while the vault is still
/// byte-identical. Asserted from inside the rendezvous point, which is the only
/// place both facts are simultaneously observable.
#[test]
fn the_destination_is_reserved_before_any_referrer_is_rewritten() {
    let mut fixture = fixture();
    let root = fixture.root.clone();
    let seen = Arc::new(AtomicBool::new(false));
    let observed = Arc::clone(&seen);
    fixture
        .service
        .install_test_hook(once_at(HookPoint::BeforeLinkRewrites, move || {
            assert!(
                root.join("Renamed.md").is_file(),
                "the destination must already be claimed"
            );
            assert_eq!(
                std::fs::read_to_string(root.join("Short.md")).expect("read Short"),
                "before [[Alpha]] after\n",
                "no referrer may have been rewritten yet"
            );
            observed.store(true, Ordering::SeqCst);
        }));

    rename(&mut fixture, "Alpha.md", "Renamed.md");
    assert!(seen.load(Ordering::SeqCst), "the rendezvous never fired");
    assert_eq!(read(&fixture, "Short.md"), "before [[Renamed]] after\n");
    assert_eq!(
        read(&fixture, "Renamed.md"),
        "# Heading\n\ntext ^block\n",
        "the move replaces the placeholder with the real note"
    );
}

/// The spec's ordering claim, restored: referrers first, the file last, and a
/// crash in between self-heals when the client retries the rename.
#[test]
fn a_crash_between_the_rewrites_and_the_move_converges_on_a_retry() {
    let mut fixture = fixture();
    fixture
        .service
        .install_test_hook(once_at(HookPoint::BeforeRenameMove, || {
            panic!("simulated crash between the rewrites and the move");
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

    // Referrers already point at the new path; the note is still at the old
    // one, and the new one holds the reservation this burst claimed.
    assert_eq!(read(&fixture, "Short.md"), "before [[Renamed]] after\n");
    assert!(fixture.root.join("Alpha.md").is_file());
    assert!(
        fixture.root.join("Renamed.md").is_file(),
        "the reservation is what the repaired links point at"
    );

    // The hook fires once, so the retry completes the move over the
    // reservation this burst left behind.
    rename(&mut fixture, "Alpha.md", "Renamed.md");
    assert!(!fixture.root.join("Alpha.md").exists());
    assert_eq!(read(&fixture, "Renamed.md"), "# Heading\n\ntext ^block\n");
    assert_eq!(read(&fixture, "Short.md"), "before [[Renamed]] after\n");
}

/// The state the ordering exists to prevent. `Archive/Alpha.md` shadows the
/// basename, so a crash that had moved the file first would leave `[[Alpha]]`
/// resolving to a **different existing note** — resolved, and wrong. Rewriting
/// first plus reserving the destination makes the crash state resolve to the
/// reservation instead: visibly incomplete, never quietly misdirected.
#[test]
fn a_crash_before_the_move_never_lets_a_repaired_link_reach_a_shadowed_namesake() {
    let mut fixture = fixture();
    std::fs::create_dir_all(fixture.root.join("Archive")).expect("create Archive");
    std::fs::write(fixture.root.join("Archive/Renamed.md"), "# shadow\n")
        .expect("write the shadowing namesake");
    fixture.service.refresh(false).expect("index the shadow");

    fixture
        .service
        .install_test_hook(once_at(HookPoint::BeforeRenameMove, || {
            panic!("simulated crash between the rewrites and the move");
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
    assert_eq!(read(&fixture, "Short.md"), "before [[Renamed]] after\n");

    let mut changed = std::collections::BTreeSet::new();
    changed.insert(path("Alpha.md"));
    changed.insert(path("Renamed.md"));
    changed.insert(path("Short.md"));
    let resolutions = resolution_after(&mut fixture, changed, "Short.md");
    assert_eq!(
        resolutions,
        vec![vault_core::Resolution::Resolved {
            target: path("Renamed.md"),
            subpath: None
        }],
        "the repaired link reaches the reservation, never Archive/Renamed.md"
    );
}

/// A refusal reached *after* the destination was claimed must not leave the
/// claim behind: the vault would be left holding a placeholder note nobody
/// asked for.
#[test]
fn a_refusal_after_the_reservation_leaves_no_placeholder_behind() {
    let mut fixture = fixture();
    let source = fixture.root.join("Alpha.md");
    fixture
        .service
        .install_test_hook(once_at(HookPoint::BeforeRenameMove, move || {
            std::fs::remove_file(&source).expect("delete the source from the hook");
        }));

    let error = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect_err("the source vanished under us");
    assert!(
        matches!(
            error,
            vault_index::IndexError::Mutation(MutationError::NotFound { .. })
        ),
        "expected not_found, got {error:?}"
    );
    assert!(
        !fixture.root.join("Renamed.md").exists(),
        "a refused rename leaves no reservation residue"
    );
}

/// A replacement that parses correctly *on its own* can still change how the
/// bytes **around** it parse, and the acceptance check has to be the document
/// rather than the reference.
///
/// `[x][[Alpha]]` is legal prose: `[x]` is literal and the wikilink is a
/// reference. Rewrite that wikilink into `[a|b](a%7Cb)` and CommonMark reads
/// `[x][a|b]` as a full reference link — which the definition at the bottom of
/// the file *defines* — so the whole construct becomes one link to
/// `example.com` and the vault reference is **gone**. One reference in, zero
/// out, reported as repaired.
///
/// The safe reference in the same file proves the check is per-reference: a
/// referrer is not thrown away whole because one of its links cannot be
/// rewritten.
#[test]
fn a_replacement_that_would_change_how_the_document_parses_is_refused() {
    let mut fixture = fixture();
    let before = "go [x][[Alpha]] end\n\nsafe ![[Alpha]] here\n\n[a|b]: http://example.com\n";
    std::fs::write(fixture.root.join("Edges.md"), before).expect("write Edges");
    fixture.service.refresh(false).expect("index Edges");

    let outcome = rename(&mut fixture, "Alpha.md", "a|b.md");

    assert_eq!(
        read(&fixture, "Edges.md"),
        "go [x][[Alpha]] end\n\nsafe ![a|b](a%7Cb) here\n\n[a|b]: http://example.com\n",
        "the reference whose rewrite would be swallowed is left alone; the safe one is repaired"
    );
    assert_eq!(
        reasons(&outcome),
        vec![("Edges.md", LinkRewriteReason::ContextConflict)]
    );

    let mut changed = outcome.changed_paths.clone();
    changed.insert(path("Edges.md"));
    assert_eq!(
        resolution_after(&mut fixture, changed, "Edges.md").len(),
        2,
        "both references survive: a repair that deletes one is not a repair"
    );
}

/// An already-ambiguous reference names no single note, so there is nothing to
/// preserve — but the rename changes what it resolves to, the planner sees it,
/// and silence would be the every-decline-reported rule quietly not applying.
#[test]
fn an_ambiguous_reference_is_reported_rather_than_silently_re_pointed() {
    let mut fixture = fixture();
    std::fs::create_dir_all(fixture.root.join("One")).expect("create One");
    std::fs::create_dir_all(fixture.root.join("Two")).expect("create Two");
    std::fs::write(fixture.root.join("One/Twin.md"), "# one\n").expect("write One/Twin");
    std::fs::write(fixture.root.join("Two/Twin.md"), "# two\n").expect("write Two/Twin");
    std::fs::write(fixture.root.join("Ambiguous.md"), "[[Twin]]\n").expect("write Ambiguous");
    fixture.service.refresh(false).expect("index the twins");

    let outcome = rename(&mut fixture, "One/Twin.md", "One/Renamed.md");

    assert_eq!(
        read(&fixture, "Ambiguous.md"),
        "[[Twin]]\n",
        "declining to guess is right; doing it silently is not"
    );
    assert_eq!(
        reasons(&outcome),
        vec![("Ambiguous.md", LinkRewriteReason::AmbiguousTarget)]
    );
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
            vault_index::IndexError::Mutation(MutationError::TargetExists { .. })
        ),
        "expected target_exists, got {error:?}"
    );
    assert_eq!(read(&fixture, "Short.md"), "before [[Alpha]] after\n");
    assert_eq!(read(&fixture, "Extended.md"), "[[Alpha.md]]\n");
}

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
            vault_index::IndexError::Mutation(MutationError::RevisionConflict { .. })
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

/// The coordinator's own read-only guard, which the engine-level read-only
/// tests cannot reach: they drive `MutationEngine` directly, and this refusal
/// exists because a repairing rename does index work *before* it reaches the
/// engine. All four rename shapes, plus the missing-folder shape the guard's
/// comment exists for.
#[test]
fn read_only_refuses_every_rename_shape_through_apply_mutation() {
    let mut fixture = fixture();
    fixture.service.set_read_only(true);

    let shapes = [
        Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        },
        Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        },
        Mutation::RenameFolder {
            from: path("Nested"),
            to: path("Moved"),
            rewrite_links: true,
        },
        Mutation::RenameFolder {
            from: path("Nested"),
            to: path("Moved"),
            rewrite_links: false,
        },
        // The shape the guard exists for: enumerating a folder that is not
        // there would fail with a filesystem error, and `read_only` is the
        // answer the flag is supposed to produce.
        Mutation::RenameFolder {
            from: path("Absent"),
            to: path("Moved"),
            rewrite_links: true,
        },
    ];
    for shape in shapes {
        let error = fixture
            .service
            .apply_mutation(&shape)
            .expect_err("a read-only daemon refuses every mutation");
        assert!(
            matches!(
                error,
                vault_index::IndexError::Mutation(MutationError::ReadOnly)
            ),
            "expected read_only for {shape:?}, got {error:?}"
        );
    }
    assert_eq!(read(&fixture, "Short.md"), "before [[Alpha]] after\n");
    assert!(fixture.root.join("Alpha.md").is_file());
}

/// A repairing rename against an index that has never built cannot know which
/// references point at the moved note. The move still happens — an unbuilt
/// index must not block a filesystem operation — and the answer says so,
/// because `links_rewritten: 0` with no failures would be an affirmative
/// claim that nothing needed repair.
#[test]
fn a_rename_with_no_generation_reports_that_it_could_not_look() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("Alpha.md"), "# Alpha\n").expect("write Alpha");
    std::fs::write(root.join("Ref.md"), "[[Alpha]]\n").expect("write Ref");
    let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("config");
    let mut service = IndexService::open(config).expect("service");

    let outcome = service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("the move still happens");

    assert!(root.join("Renamed.md").is_file());
    assert_eq!(
        std::fs::read_to_string(root.join("Ref.md")).unwrap(),
        "[[Alpha]]\n"
    );
    assert_eq!(outcome.links_rewritten, 0);
    assert_eq!(
        outcome
            .link_rewrite_failures
            .iter()
            .map(|failure| failure.reason)
            .collect::<Vec<_>>(),
        vec![LinkRewriteReason::IndexUnavailable],
        "silence would be a claim that nothing needed repair"
    );
}

/// The closed set of reason codes, pinned as strings because that is what
/// reaches a client through `LinkRewriteFailureDto::reason` and what
/// `docs/protocol.md` documents. A client branches on these.
#[test]
fn every_reason_code_has_a_stable_spelling() {
    let codes: Vec<&str> = [
        LinkRewriteReason::RevisionConflict,
        LinkRewriteReason::SourceAbsent,
        LinkRewriteReason::NotIndexed,
        LinkRewriteReason::ReferenceMissing,
        LinkRewriteReason::SpanMismatch,
        LinkRewriteReason::UnwritableSpelling,
        LinkRewriteReason::ContextConflict,
        LinkRewriteReason::AmbiguousTarget,
        LinkRewriteReason::WriteFailed(IoKind::Other),
        LinkRewriteReason::IndexUnavailable,
    ]
    .iter()
    .map(|reason| reason.as_str())
    .collect();
    assert_eq!(
        codes,
        vec![
            "revision_conflict",
            "source_absent",
            "not_indexed",
            "reference_missing",
            "span_mismatch",
            "unwritable_spelling",
            "context_conflict",
            "ambiguous_target",
            "write_failed",
            "index_unavailable",
        ]
    );
    assert_eq!(
        LinkRewriteReason::WriteFailed(IoKind::PermissionDenied).as_str(),
        "write_failed",
        "the i/o kind is a diagnostic, never a second wire code"
    );
}
