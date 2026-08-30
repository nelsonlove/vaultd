//! Targeted reconciliation of a bounded dirty set.
//!
//! Two things are proven here, and they pull in opposite directions:
//!
//! * **Proportionality** — the ordinary route does no work proportional to the
//!   vault. The structural counters (`complete_inventories`, `body_reads`,
//!   `notes_reparsed`, `affected_references`) are asserted exactly, so a
//!   regression that quietly rebuilds the world fails here rather than only
//!   showing up as a slow benchmark.
//! * **Conservative invalidation** — over-selection is allowed, under-selection
//!   is not. Every case ends by comparing the whole indexed state against a
//!   clean `scan_vault` of the same vault, so a reference whose answer changed
//!   but was never re-resolved is caught immediately. The property test at the
//!   bottom does the same over generated change sequences.

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use common::counting_service_with_two_notes;
use proptest::prelude::*;
use tempfile::TempDir;
use vault_core::{FileSystemVaultSource, VaultPath, scan_vault};
use vault_index::{
    ChangeCause, FileFingerprint, FileSystemIndexSource, IndexConfig, IndexError, IndexService,
    InventorySnapshot, LiveRefreshReport, ReconcileSource,
};

#[test]
fn body_only_dirty_path_avoids_global_work() {
    let mut fixture = counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.service.hydrate_live_graph().expect("hydrate");
    fixture.reset_counts();
    fixture.write_note("One.md", "# One changed\n");

    let paths = BTreeSet::from([VaultPath::new("One.md").unwrap()]);
    let report = fixture
        .service
        .refresh_paths(paths, ChangeCause::Watcher)
        .expect("live refresh");

    assert_eq!(report.metrics.work.complete_inventories, 0);
    assert_eq!(report.metrics.work.body_reads, 1);
    assert_eq!(report.metrics.work.notes_reparsed, 1);
    assert_eq!(report.metrics.work.changed_notes, 1);
    assert_eq!(report.metrics.work.unaffected_references_touched, 0);
}

/// A vault with every resolution state represented, so one dirty path can be
/// shown to move exactly the references that depend on it and no others:
///
/// * `Sub.md` carries a heading and a block id, referenced by subpath from
///   two different notes.
/// * `Hub.md` reaches `Sub.md` four ways plus an unresolved `[[Ghost]]`, an
///   ambiguous-capable `[[Foo]]`, and a non-vault link.
/// * `Peer.md` links `Sub.md` too, so source-scoped invalidation can be shown
///   not to leak across notes.
/// * `Lonely.md` references nothing and is referenced by nothing.
fn live_fixture() -> LiveFixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().to_path_buf();
    std::fs::create_dir_all(root.join("Ambiguous")).expect("create Ambiguous");

    write_file(&root, "Sub.md", "# Section\n\ntext ^block\n");
    write_file(
        &root,
        "Hub.md",
        "# Hub\n[[Sub]]\n[[Sub#Section]]\n[[Sub#^block]]\n[[Sub#Absent]]\n\
         [[Ghost]]\n[[Foo]]\n[site](https://example.com)\n",
    );
    write_file(&root, "Peer.md", "# Peer\n[[Sub]]\n");
    write_file(&root, "Lonely.md", "# Lonely\n");
    write_file(&root, "Ambiguous/Foo.md", "# Foo one\n");

    let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3"))
        .expect("live fixture config");
    let mut service = IndexService::open(config).expect("live fixture service");
    service.refresh(false).expect("cold build");
    let fixture = LiveFixture {
        service,
        root,
        _vault: vault,
        _index: index,
    };
    fixture.assert_matches_scan();
    fixture
}

struct LiveFixture {
    service: IndexService,
    root: PathBuf,
    _vault: TempDir,
    _index: TempDir,
}

impl LiveFixture {
    fn write(&self, name: &str, body: &str) {
        write_file(&self.root, name, body);
    }

    fn delete(&self, name: &str) {
        match std::fs::remove_file(self.root.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("delete {name}: {error}"),
        }
    }

    /// Bump only the modification time, leaving content identical.
    fn touch(&self, name: &str) {
        let path = self.root.join(name);
        let metadata = std::fs::metadata(&path).expect("note metadata");
        let modified = filetime::FileTime::from_last_modification_time(&metadata);
        let bumped =
            filetime::FileTime::from_unix_time(modified.unix_seconds() + 5, modified.nanoseconds());
        filetime::set_file_mtime(&path, bumped).expect("bump mtime");
    }

    fn refresh_paths(&mut self, names: &[&str]) -> LiveRefreshReport {
        self.try_refresh_paths(names).expect("live refresh")
    }

    fn try_refresh_paths(&mut self, names: &[&str]) -> Result<LiveRefreshReport, IndexError> {
        self.service
            .refresh_paths(vault_paths(names), ChangeCause::Watcher)
    }

    fn generation(&self) -> u64 {
        self.service
            .current_generation()
            .expect("generation")
            .expect("published")
            .get()
    }

    /// The whole indexed state, through the production query API only, against
    /// a clean scan of the same vault. This is what makes under-selection
    /// impossible to hide: a reference the plan failed to re-resolve differs
    /// here even when every counter looks right.
    fn assert_matches_scan(&self) {
        let source = FileSystemVaultSource::new(&self.root).expect("scan source");
        let fresh = scan_vault(&source).expect("scan vault");
        assert_eq!(
            common::snapshot_from_index(&self.service),
            common::snapshot_from_scan(&fresh),
        );
    }

    /// How many rows one table holds for one note. The equivalence check above
    /// already compares hydrated `sections`/`list_items` against a fresh scan;
    /// this is what keeps that comparison from passing vacuously when a note
    /// has no structural rows at all.
    fn stored_row_count(&self, table: &str, name: &str) -> i64 {
        self.service
            .connection_for_test()
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE note_path = ?1"),
                rusqlite::params![name],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("counting {table} rows for {name}: {error}"))
    }
}

fn write_file(root: &Path, name: &str, body: &str) {
    let path = root.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent directory");
    }
    std::fs::write(path, body).expect("write note");
}

fn vault_paths(names: &[&str]) -> BTreeSet<VaultPath> {
    names
        .iter()
        .map(|name| VaultPath::new(*name).expect("valid vault path"))
        .collect()
}

// ---------------------------------------------------------------------------
// The invalidation matrix
// ---------------------------------------------------------------------------

/// A body edit that leaves the note's path, headings, and block ids alone
/// cannot change any *other* reference's answer, so nothing but the changed
/// note's own references may be selected.
#[test]
fn a_body_only_edit_selects_no_incoming_references() {
    let mut fixture = live_fixture();
    fixture.write("Sub.md", "# Section\n\nmore text ^block\n");

    let report = fixture.refresh_paths(&["Sub.md"]);

    assert_eq!(
        report.changes.modified,
        vault_paths(&["Sub.md"]).into_iter().collect::<Vec<_>>()
    );
    assert!(report.changes.created.is_empty());
    assert!(report.changes.deleted.is_empty());
    assert_eq!(
        report.affected_reference_count, 0,
        "`Sub.md` has no outgoing references and its identity did not move"
    );
    assert_eq!(report.metrics.work.body_reads, 1);
    assert_eq!(report.metrics.work.complete_inventories, 0);
    assert!(!report.complete_resolution);
    fixture.assert_matches_scan();
}

/// The structural rows ride the incremental route, not just the full
/// publication: a targeted single-note refresh must write `sections` and
/// `list_items` for the edited note, drop the rows its previous body owned,
/// and still match a clean scan afterwards.
#[test]
fn a_targeted_refresh_replaces_the_notes_structural_rows() {
    let mut fixture = live_fixture();
    assert_eq!(fixture.stored_row_count("list_items", "Lonely.md"), 0);

    fixture.write(
        "Lonely.md",
        "# Lonely\n\n- [x] done\n    - nested\n- [/] partial\n",
    );
    fixture.refresh_paths(&["Lonely.md"]);

    // Heading plus list; three items, one of them nested.
    assert_eq!(fixture.stored_row_count("sections", "Lonely.md"), 2);
    assert_eq!(fixture.stored_row_count("list_items", "Lonely.md"), 3);
    fixture.assert_matches_scan();

    // Editing the list away must take its rows with it, or a stale item would
    // survive under a note that no longer has one.
    fixture.write("Lonely.md", "# Lonely\n");
    fixture.refresh_paths(&["Lonely.md"]);
    assert_eq!(fixture.stored_row_count("sections", "Lonely.md"), 1);
    assert_eq!(fixture.stored_row_count("list_items", "Lonely.md"), 0);
    fixture.assert_matches_scan();
}

/// Changing a note's own outgoing reference republishes that source and
/// nothing else.
#[test]
fn changing_an_outgoing_reference_selects_only_that_source() {
    let mut fixture = live_fixture();
    fixture.write("Peer.md", "# Peer\n[[Lonely]]\n");

    let report = fixture.refresh_paths(&["Peer.md"]);

    assert_eq!(
        report.affected_reference_count, 1,
        "only `Peer.md`'s own single reference is in play"
    );
    assert_eq!(report.metrics.work.notes_reparsed, 1);
    fixture.assert_matches_scan();
}

/// A heading appearing on a target moves every subpath reference that names
/// it — including ones in notes that were never touched — and nothing else.
#[test]
fn adding_a_heading_selects_the_subpath_references_that_depend_on_it() {
    let mut fixture = live_fixture();
    fixture.write("Sub.md", "# Section\n\n# Absent\n\ntext ^block\n");

    let report = fixture.refresh_paths(&["Sub.md"]);

    // `Hub.md`'s four references to `Sub.md` plus `Peer.md`'s one: every
    // reference carrying a `ResolvedTarget` dependency on `Sub.md`. Nothing
    // from `Lonely.md` or `Ambiguous/Foo.md`.
    assert_eq!(report.affected_reference_count, 5);
    assert_eq!(report.metrics.work.body_reads, 1);
    assert_eq!(report.metrics.work.notes_reparsed, 1);
    fixture.assert_matches_scan();
}

#[test]
fn removing_a_heading_selects_the_subpath_references_that_depend_on_it() {
    let mut fixture = live_fixture();
    fixture.write("Sub.md", "text ^block\n");

    let report = fixture.refresh_paths(&["Sub.md"]);

    assert_eq!(report.affected_reference_count, 5);
    fixture.assert_matches_scan();
}

#[test]
fn adding_and_removing_a_block_id_moves_only_block_subpath_answers() {
    let mut fixture = live_fixture();
    fixture.write("Sub.md", "# Section\n\ntext\n");
    let removed = fixture.refresh_paths(&["Sub.md"]);
    assert_eq!(removed.affected_reference_count, 5);
    fixture.assert_matches_scan();

    fixture.write("Sub.md", "# Section\n\ntext ^block\n");
    let restored = fixture.refresh_paths(&["Sub.md"]);
    assert_eq!(restored.affected_reference_count, 5);
    fixture.assert_matches_scan();
}

/// A note appearing is the classic unresolved-to-resolved transition: the
/// dependents are found through the candidate map, not by re-resolving the
/// vault.
#[test]
fn adding_a_note_resolves_the_references_that_were_waiting_for_it() {
    let mut fixture = live_fixture();
    fixture.write("Ghost.md", "# Ghost\n");

    let report = fixture.refresh_paths(&["Ghost.md"]);

    assert_eq!(
        report.changes.created,
        vec![VaultPath::new("Ghost.md").unwrap()]
    );
    assert_eq!(
        report.affected_reference_count, 1,
        "only `Hub.md`'s `[[Ghost]]` could have been waiting for this path"
    );
    assert_eq!(report.metrics.work.body_reads, 1);
    fixture.assert_matches_scan();
}

#[test]
fn deleting_a_note_unresolves_every_reference_that_reached_it() {
    let mut fixture = live_fixture();
    fixture.delete("Sub.md");

    let report = fixture.refresh_paths(&["Sub.md"]);

    assert_eq!(
        report.changes.deleted,
        vec![VaultPath::new("Sub.md").unwrap()]
    );
    assert_eq!(report.affected_reference_count, 5);
    assert_eq!(
        report.metrics.work.body_reads, 0,
        "a deleted path is never read"
    );
    fixture.assert_matches_scan();
}

/// A rename reaches the engine as one dirty set holding both spellings.
#[test]
fn a_rename_arrives_as_a_delete_plus_an_add() {
    let mut fixture = live_fixture();
    let body = std::fs::read_to_string(fixture.root.join("Sub.md")).expect("read Sub");
    fixture.delete("Sub.md");
    fixture.write("Moved.md", &body);

    let report = fixture.refresh_paths(&["Sub.md", "Moved.md"]);

    assert_eq!(
        report.changes.created,
        vec![VaultPath::new("Moved.md").unwrap()]
    );
    assert_eq!(
        report.changes.deleted,
        vec![VaultPath::new("Sub.md").unwrap()]
    );
    assert_eq!(
        report.metrics.work.body_reads, 1,
        "only the new path exists"
    );
    fixture.assert_matches_scan();
}

#[test]
fn a_second_match_makes_a_resolved_reference_ambiguous_and_removing_it_resolves_again() {
    let mut fixture = live_fixture();
    fixture.write("Other/Foo.md", "# Foo two\n");

    let ambiguous = fixture.refresh_paths(&["Other/Foo.md"]);
    assert_eq!(
        ambiguous.affected_reference_count, 1,
        "only `Hub.md`'s `[[Foo]]` reaches a note by that stem"
    );
    fixture.assert_matches_scan();

    fixture.delete("Other/Foo.md");
    let resolved = fixture.refresh_paths(&["Other/Foo.md"]);
    assert_eq!(resolved.affected_reference_count, 1);
    fixture.assert_matches_scan();
}

/// An existing note that stops being valid UTF-8 leaves the cache exactly the
/// way a fresh scan leaves it: no note, one diagnostic, dependents unresolved.
#[test]
fn a_note_that_becomes_invalid_utf8_is_removed_with_a_diagnostic() {
    let mut fixture = live_fixture();
    std::fs::write(fixture.root.join("Sub.md"), [0xff, 0xfe]).expect("write invalid bytes");

    let report = fixture.refresh_paths(&["Sub.md"]);

    assert_eq!(
        report.changes.deleted,
        vec![VaultPath::new("Sub.md").unwrap()]
    );
    assert_eq!(report.affected_reference_count, 5);
    fixture.assert_matches_scan();
}

#[cfg(unix)]
#[test]
fn a_note_that_becomes_unreadable_is_removed_with_a_diagnostic() {
    use std::os::unix::fs::PermissionsExt;

    let mut fixture = live_fixture();
    let path = fixture.root.join("Sub.md");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000))
        .expect("make unreadable");

    let report = fixture.refresh_paths(&["Sub.md"]);

    assert_eq!(
        report.changes.deleted,
        vec![VaultPath::new("Sub.md").unwrap()]
    );
    fixture.assert_matches_scan();

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("restore");
}

/// A path that can never become a usable note must not advance the generation
/// on every cycle: the first cycle records its diagnostic, and every later
/// cycle recomputes the identical diagnostic and publishes nothing.
#[test]
fn a_permanently_unusable_path_advances_the_generation_exactly_once() {
    let mut fixture = live_fixture();
    std::fs::write(fixture.root.join("Bad.md"), [0xff, 0xfe]).expect("write invalid bytes");

    let appeared = fixture.refresh_paths(&["Bad.md"]);
    let settled = appeared.generation;
    assert_eq!(
        settled.get(),
        appeared.previous_generation.unwrap().get() + 1
    );
    fixture.assert_matches_scan();

    for _ in 0..3 {
        let steady = fixture.refresh_paths(&["Bad.md"]);
        assert_eq!(steady.generation, settled);
        assert_eq!(steady.previous_generation, Some(settled));
        assert!(steady.changes.created.is_empty());
        assert!(steady.changes.deleted.is_empty());
    }
    fixture.assert_matches_scan();
}

/// A metadata-only touch reads the body once (that is the only way to know the
/// content did not move), refreshes the fingerprint, and publishes nothing.
#[test]
fn a_metadata_only_touch_keeps_the_generation_and_reports_no_changes() {
    let mut fixture = live_fixture();
    let before = fixture.generation();
    fixture.touch("Sub.md");

    let report = fixture.refresh_paths(&["Sub.md"]);

    assert_eq!(report.generation.get(), before);
    assert_eq!(report.previous_generation, Some(report.generation));
    assert_eq!(report.changes, vault_index::PathChanges::default());
    assert_eq!(report.metrics.work.body_reads, 1);
    assert_eq!(report.metrics.work.notes_reparsed, 0);
    fixture.assert_matches_scan();

    // The refreshed fingerprint means the same touch is not rediscovered.
    let again = fixture.refresh_paths(&["Sub.md"]);
    assert_eq!(again.generation.get(), before);
}

/// A note rewritten *while* it is being read is refused rather than indexed
/// half-old, and the generation does not move — the path stays eligible for
/// the caller's next dirty set.
#[test]
fn a_file_rewritten_during_its_read_is_refused_and_retryable() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().to_path_buf();
    write_file(&root, "Unstable.md", "# Unstable\n");
    write_file(&root, "Stable.md", "# Stable\n[[Unstable]]\n");

    let armed = Arc::new(AtomicBool::new(false));
    let source = RewriteDuringReadSource {
        inner: FileSystemIndexSource::new(&root).expect("inner source"),
        root: root.clone(),
        armed: Arc::clone(&armed),
    };
    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("unstable config");
    let mut service =
        IndexService::open_with_source(config, Box::new(source)).expect("unstable service");
    service.refresh(false).expect("cold build");
    let before = service.current_generation().expect("generation");

    armed.store(true, Ordering::SeqCst);
    let error = service
        .refresh_paths(vault_paths(&["Unstable.md"]), ChangeCause::Watcher)
        .expect_err("an unstable read must be refused");
    assert!(matches!(error, IndexError::VaultChangedDuringRefresh));
    assert_eq!(service.current_generation().expect("generation"), before);

    // Disarmed, the very same dirty path reconciles normally.
    armed.store(false, Ordering::SeqCst);
    let report = service
        .refresh_paths(vault_paths(&["Unstable.md"]), ChangeCause::Watcher)
        .expect("retry after the file settled");
    assert_eq!(
        report.generation.get(),
        before.expect("published").get() + 1
    );
}

/// The overflow escape hatch: past the threshold the plan is abandoned and
/// every reference the compact graph holds is re-resolved. It must still land
/// on exactly the state a fresh scan produces — and still read and parse only
/// the changed body.
#[test]
fn the_complete_resolution_fallback_matches_a_fresh_scan() {
    let mut fixture = live_fixture();
    fixture
        .service
        .set_complete_resolution_threshold_for_test(0);
    fixture.write("Sub.md", "# Section\n\n# Absent\n\ntext ^block\n");

    let report = fixture.refresh_paths(&["Sub.md"]);

    assert!(report.complete_resolution);
    assert_eq!(
        report.metrics.work.body_reads, 1,
        "the fallback re-resolves from the compact graph, it does not reread the vault"
    );
    assert_eq!(report.metrics.work.notes_reparsed, 1);
    fixture.assert_matches_scan();
}

/// A dirty set naming a path that never existed and still does not exist is a
/// no-op, not an error and not a new generation.
#[test]
fn a_dirty_path_that_never_existed_publishes_nothing() {
    let mut fixture = live_fixture();
    let before = fixture.generation();

    let report = fixture.refresh_paths(&["Nowhere.md"]);

    assert_eq!(report.generation.get(), before);
    assert_eq!(report.metrics.work.body_reads, 0);
    assert_eq!(report.changes, vault_index::PathChanges::default());
    fixture.assert_matches_scan();
}

/// A reference the impact plan selected but the store cannot produce is a
/// broken invariant, not a reference to quietly skip: skipping it would leave
/// a selected reference un-re-resolved, which is the one forbidden direction.
///
/// The store is corrupted out of band here — one `resolutions` row dropped.
/// `load_outgoing`'s join to `resolutions` is an INNER JOIN, so the affected
/// reference does not come back as a hole; it is simply absent. Both shapes
/// must fail loudly and publish nothing.
fn drop_one_resolution_and_reconcile(note: &str, ordinal: u32) {
    let mut fixture = live_fixture();
    let before = fixture.generation();
    let dropped = fixture
        .service
        .connection_for_test()
        .execute(
            "DELETE FROM resolutions WHERE reference_id IN \
             (SELECT id FROM note_references WHERE note_path = ?1 AND ordinal = ?2)",
            rusqlite::params![note, ordinal],
        )
        .expect("drop the stored resolution");
    assert_eq!(dropped, 1, "the fixture must have had a row to drop");

    // A heading change on `Sub.md` selects every reference that resolves
    // against it — including `{note}`'s.
    fixture.write("Sub.md", "# Section\n\n# Absent\n\ntext ^block\n");
    let error = fixture
        .try_refresh_paths(&["Sub.md"])
        .expect_err("a selected reference that cannot be loaded must fail loudly");

    assert!(
        matches!(error, IndexError::Storage(_)),
        "unexpected error: {error:?}"
    );
    assert_eq!(
        fixture.generation(),
        before,
        "a failed reconciliation must publish nothing"
    );
}

/// The single-reference shape: `Peer.md` has exactly one outgoing reference,
/// so dropping its resolution leaves an empty result with nothing to mispair.
#[test]
fn a_selected_reference_missing_from_the_stored_index_fails_loudly() {
    drop_one_resolution_and_reconcile("Peer.md", 0);
}

/// The shape that positional indexing gets *wrong* rather than merely
/// skipping: `Hub.md` has seven outgoing references and the dropped one is in
/// the middle, so every later row shifts down a slot. Indexing the result by
/// position would hand ordinal 1 the reference stored at ordinal 2, resolve
/// the wrong target, and commit that answer under ordinal 1 — a silent wrong
/// answer, not a missing one, because the delta writer looks the reference id
/// up by the ordinal it was *asked* for, which exists.
#[test]
fn a_missing_middle_resolution_never_mispairs_later_ordinals() {
    drop_one_resolution_and_reconcile("Hub.md", 1);
}

/// `refresh_paths` builds on a published generation; it has no baseline to be
/// incremental against before the first build.
#[test]
fn refresh_paths_before_the_first_build_is_unavailable() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    write_file(vault.path(), "One.md", "# One\n");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("cold config");
    let mut service = IndexService::open(config).expect("cold service");

    let error = service
        .refresh_paths(vault_paths(&["One.md"]), ChangeCause::Startup)
        .expect_err("no generation to build on");

    assert!(matches!(error, IndexError::IndexUnavailable));
}

/// A source that rewrites the file it was just asked to read, so the
/// after-read fingerprint cannot match the before-read one.
struct RewriteDuringReadSource {
    inner: FileSystemIndexSource,
    root: PathBuf,
    armed: Arc<AtomicBool>,
}

impl ReconcileSource for RewriteDuringReadSource {
    fn canonical_root(&self) -> &Path {
        self.inner.canonical_root()
    }

    fn inventory(&self) -> Result<InventorySnapshot, IndexError> {
        self.inner.inventory()
    }

    fn read_bytes(&self, path: &VaultPath) -> Result<Vec<u8>, vault_core::ScanError> {
        let bytes = self.inner.read_bytes(path)?;
        if self.armed.load(Ordering::SeqCst) {
            std::fs::write(
                self.root.join(path.as_str()),
                "# Unstable, rewritten mid-read\n",
            )
            .expect("rewrite during read");
        }
        Ok(bytes)
    }

    fn fingerprint(&self, path: &VaultPath) -> Result<Option<FileFingerprint>, IndexError> {
        self.inner.fingerprint(path)
    }
}

// ---------------------------------------------------------------------------
// The conservative-invalidation property
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Change {
    Write { slot: usize, body: String },
    Delete { slot: usize },
}

/// Two spellings per stem, so adding or removing either one can flip a
/// reference between resolved and ambiguous.
const SLOTS: &[&str] = &[
    "Note-0.md",
    "Note-1.md",
    "Note-2.md",
    "Nested/Note-0.md",
    "Nested/Note-1.md",
    "Nested/Note-2.md",
];

fn body_strategy() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("# Heading\n".to_string()),
        Just("text ^block\n".to_string()),
        (0usize..3).prop_map(|slot| format!("# Heading\n[[Note-{slot}]]\n")),
        (0usize..3).prop_map(|slot| format!("[[Note-{slot}#Heading]]\n")),
        (0usize..3).prop_map(|slot| format!("[[Note-{slot}#^block]]\n")),
        (0usize..3).prop_map(|slot| format!("[[Note-{slot}.md]]\n^block\n")),
        (0usize..3).prop_map(|slot| format!("[[./Note-{slot}]]\n[[../Note-{slot}]]\n")),
        Just("# Heading\n[[#Heading]]\n[[#Missing]]\n".to_string()),
        Just("---\nbroken: [\n---\n[[Absent]]\n[link](https://example.com)\n".to_string()),
    ]
}

fn change_strategy() -> impl Strategy<Value = Change> {
    prop_oneof![
        (0usize..SLOTS.len(), body_strategy())
            .prop_map(|(slot, body)| Change::Write { slot, body }),
        (0usize..SLOTS.len()).prop_map(|slot| Change::Delete { slot }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// After every single-path change, the incrementally maintained state must
    /// equal a clean scan of the same vault. A reference the impact plan
    /// failed to select — the one forbidden direction — shows up here as a
    /// stale resolution, a stale backlink, or a stale diagnostic.
    #[test]
    fn targeted_reconciliation_matches_a_fresh_scan_after_every_change(
        changes in prop::collection::vec(change_strategy(), 1..=24)
    ) {
        let vault = TempDir::new().expect("vault");
        let index = TempDir::new().expect("index");
        let root = vault.path().to_path_buf();
        write_file(&root, "Seed.md", "# Seed\n[[Note-0]]\n[[Note-1#Heading]]\n");

        let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3"))
            .expect("property config");
        let mut service = IndexService::open(config).expect("property service");
        service.refresh(false).expect("cold build");

        for change in changes {
            let name = match &change {
                Change::Write { slot, body } => {
                    write_file(&root, SLOTS[*slot], body);
                    SLOTS[*slot]
                }
                Change::Delete { slot } => {
                    match std::fs::remove_file(root.join(SLOTS[*slot])) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => panic!("delete generated note: {error}"),
                    }
                    SLOTS[*slot]
                }
            };

            service
                .refresh_paths(vault_paths(&[name]), ChangeCause::Watcher)
                .expect("targeted refresh");

            let source = FileSystemVaultSource::new(&root).expect("scan source");
            let fresh = scan_vault(&source).expect("scan vault");
            prop_assert_eq!(
                common::snapshot_from_index(&service),
                common::snapshot_from_scan(&fresh),
            );
        }
    }
}
