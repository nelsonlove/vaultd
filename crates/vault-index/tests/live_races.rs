//! Forced races around the publication boundary.
//!
//! Every window here is *made* to open — with a rendezvous hook, a real
//! SQLite lock, or a second writer — rather than waited for. The claim under
//! test is always the same one, from three sides:
//!
//! * a client-visible generation exists only once the SQLite rows AND the
//!   matching live state are both in place;
//! * a cycle that cannot reach that point publishes **nothing** — not a row,
//!   not a graph edge, not a generation number;
//! * whatever a cycle does publish is exactly what a clean `scan_vault` of
//!   the same vault would have produced.
//!
//! The equivalence check is deliberately the whole production query API
//! (`common::snapshot_from_index`) against a fresh scan, never a hand-picked
//! subset: a race that corrupts one resolution answer must fail here even
//! when every counter looks right.

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, mpsc};
use std::thread;
use std::time::Duration;

use tempfile::TempDir;
use vault_core::{FileSystemVaultSource, VaultPath, scan_vault};
use vault_index::{
    ChangeCause, FileSystemIndexSource, Generation, HookPoint, IndexConfig, IndexError,
    IndexService, LiveRefreshReport, ReconcileSource, TestHook,
};

/// How long a test waits before concluding a thread is genuinely blocked.
/// Deliberately far larger than any real publication: the assertion is
/// "still blocked", so a generous margin can only make a false failure less
/// likely, never a false pass more likely.
const BLOCKED_MARGIN: Duration = Duration::from_millis(750);

/// How long a released thread is given to finish. A true timeout here is a
/// deadlock, not slowness, so this is generous too.
const FINISH_MARGIN: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// A privately-owned vault with every resolution shape that matters:
/// `Target.md` carries a heading and a block id, `Hub.md` reaches it four
/// ways plus one reference that cannot resolve, `Peer.md` reaches it too (so
/// source-scoped invalidation can be shown not to leak), and `Lonely.md`
/// neither references nor is referenced — the one note whose content can be
/// changed without moving any other note's answer.
struct RaceFixture {
    service: Option<IndexService>,
    config: IndexConfig,
    root: PathBuf,
    _vault: TempDir,
    _index: TempDir,
}

fn race_fixture() -> RaceFixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().to_path_buf();

    write_file(&root, "Target.md", "# Section\n\ntext ^block\n");
    write_file(
        &root,
        "Hub.md",
        "# Hub\n[[Target]]\n[[Target#Section]]\n[[Target#^block]]\n[[Target#Absent]]\n[[Ghost]]\n",
    );
    write_file(&root, "Peer.md", "# Peer\n[[Target]]\n");
    write_file(&root, "Lonely.md", "# Lonely\n");

    let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3"))
        .expect("race fixture config");
    let mut service = IndexService::open(config.clone()).expect("race fixture service");
    service.refresh(false).expect("cold build");

    let fixture = RaceFixture {
        service: Some(service),
        config,
        root,
        _vault: vault,
        _index: index,
    };
    fixture.assert_matches_scan();
    fixture
}

impl RaceFixture {
    fn service(&mut self) -> &mut IndexService {
        self.service.as_mut().expect("service is on this thread")
    }

    fn borrow(&self) -> &IndexService {
        self.service.as_ref().expect("service is on this thread")
    }

    fn take_service(&mut self) -> IndexService {
        self.service.take().expect("service is on this thread")
    }

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

    fn generation(&self) -> u64 {
        self.borrow()
            .current_generation()
            .expect("generation")
            .expect("published")
            .get()
    }

    /// What the publication barrier is asserting right now: the published
    /// generation and the installed graph's generation, which must always
    /// agree outside a publication's own exclusive section.
    fn published(&self) -> (Option<u64>, Option<u64>) {
        let status = self
            .borrow()
            .reader()
            .expect("reader")
            .published_status()
            .expect("published status");
        (
            status.generation.map(Generation::get),
            status.graph_generation.map(Generation::get),
        )
    }

    fn refresh_paths(&mut self, names: &[&str]) -> LiveRefreshReport {
        self.try_refresh_paths(names).expect("targeted refresh")
    }

    fn try_refresh_paths(&mut self, names: &[&str]) -> Result<LiveRefreshReport, IndexError> {
        self.service()
            .refresh_paths(vault_paths(names), ChangeCause::Watcher)
    }

    fn assert_matches_scan(&self) {
        let source = FileSystemVaultSource::new(&self.root).expect("scan source");
        let fresh = scan_vault(&source).expect("scan vault");
        assert_eq!(
            common::snapshot_from_index(self.borrow()),
            common::snapshot_from_scan(&fresh),
        );
    }

    fn install(&mut self, hook: Arc<dyn TestHook>) {
        self.service().install_test_hook(hook);
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
// Hooks
// ---------------------------------------------------------------------------

/// Runs `action` the first time `point` is reached, and never again — so a
/// hook that provokes a failure disarms itself, and the very next attempt
/// runs against an undisturbed engine.
struct OnceAt {
    point: HookPoint,
    fired: AtomicBool,
    action: Box<dyn Fn() + Send + Sync>,
}

impl TestHook for OnceAt {
    fn reach(&self, point: HookPoint) {
        if point != self.point || self.fired.swap(true, Ordering::SeqCst) {
            return;
        }
        (self.action)();
    }
}

fn once_at(point: HookPoint, action: impl Fn() + Send + Sync + 'static) -> Arc<dyn TestHook> {
    Arc::new(OnceAt {
        point,
        fired: AtomicBool::new(false),
        action: Box::new(action),
    })
}

/// Two rendezvous points around one publication: the first releases the test
/// once the writer is parked between its SQLite commit and its live-state
/// installation, the second lets the writer finish.
fn pause_pair() -> (Arc<Barrier>, Arc<Barrier>, vault_index::PauseHook) {
    let reached = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let hook_reached = Arc::clone(&reached);
    let hook_release = Arc::clone(&release);
    let hook: vault_index::PauseHook = Arc::new(move || {
        hook_reached.wait();
        hook_release.wait();
    });
    (reached, release, hook)
}

// ---------------------------------------------------------------------------
// Crash and publication boundaries
// ---------------------------------------------------------------------------

/// A publication that fails before its commit publishes nothing at all: the
/// stored generation, the installed live graph, and every answer a client can
/// read stay exactly where they were. The failure is real lock contention —
/// an exclusive transaction on the cache from another connection — not an
/// injected error, so the rollback under test is SQLite's own.
#[test]
fn a_publication_that_fails_before_commit_leaves_both_halves_at_the_old_generation() {
    let mut fixture = race_fixture();
    let before = fixture.generation();
    let before_note = fixture
        .borrow()
        .get_note(&VaultPath::new("Hub.md").unwrap())
        .expect("note before");

    let blocker = rusqlite::Connection::open(&fixture.config.index_path).expect("blocker");
    blocker
        .busy_timeout(Duration::from_millis(100))
        .expect("blocker busy timeout");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("lock cache");

    fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");
    let error = fixture
        .try_refresh_paths(&["Hub.md"])
        .expect_err("a blocked publication must fail");
    assert!(
        matches!(error, IndexError::Busy(_)),
        "lock contention must stay retryable, got {error:?}"
    );

    blocker
        .execute_batch("ROLLBACK")
        .expect("release the cache");
    drop(blocker);

    assert_eq!(fixture.generation(), before, "no generation was published");
    assert_eq!(
        fixture.published(),
        (Some(before), Some(before)),
        "neither half of the published state moved"
    );
    assert_eq!(
        fixture
            .borrow()
            .get_note(&VaultPath::new("Hub.md").unwrap())
            .expect("note after")
            .note
            .source
            .revision()
            .as_str(),
        before_note.note.source.revision().as_str(),
        "a failed publication must not leak a single row"
    );

    // The very same dirty path publishes cleanly once the lock is gone: the
    // failure consumed nothing.
    let report = fixture.refresh_paths(&["Hub.md"]);
    assert_eq!(report.generation.get(), before + 1);
    fixture.assert_matches_scan();
}

/// A read that begins *before* a publication takes the barrier finishes at
/// the old generation, and the writer waits for it. Forced, not timed: the
/// read parks inside the barrier's read guard, so the writer provably cannot
/// proceed until it is released.
#[test]
fn a_read_begun_before_a_delta_publication_finishes_at_the_old_generation() {
    let mut fixture = race_fixture();
    let before = fixture.generation();
    let path = VaultPath::new("Hub.md").expect("path");

    let (reached, release, hook) = pause_pair();
    let mut reader = fixture.service().reader().expect("reader");
    reader.pause_reads_for_test(hook);
    let reader = Arc::new(reader);

    let reading = Arc::clone(&reader);
    let reading_path = path.clone();
    let read = thread::spawn(move || reading.get_note(&reading_path));

    // The read now holds the publication read guard.
    reached.wait();

    fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");
    let mut service = fixture.take_service();
    let (published, publications) = mpsc::channel();
    let writer = thread::spawn(move || {
        let report = service
            .refresh_paths(vault_paths(&["Hub.md"]), ChangeCause::Watcher)
            .expect("targeted publish");
        published.send(report.generation.get()).ok();
        service
    });

    assert!(
        publications.recv_timeout(BLOCKED_MARGIN).is_err(),
        "a publication must not overtake a read that already holds the barrier"
    );

    release.wait();
    let during = read
        .join()
        .expect("reader thread")
        .expect("read at the old generation");
    assert_eq!(
        during.generation.get(),
        before,
        "a read that started before the publication must answer from the generation it started in"
    );
    assert_eq!(
        publications.recv_timeout(FINISH_MARGIN),
        Ok(before + 1),
        "the writer must publish once the read releases the barrier"
    );
    fixture.service = Some(writer.join().expect("writer thread"));
    fixture.assert_matches_scan();
}

/// A read that begins *during* the commit / live-install window sees neither
/// half early: it blocks until both are in place, then answers at `G + 1`.
/// This is the "no event before state equality" claim from the reader's side
/// — there is no instant at which the rows have moved and the graph has not.
#[test]
fn a_read_begun_inside_the_publication_window_waits_and_answers_at_the_new_generation() {
    let mut fixture = race_fixture();
    let before = fixture.generation();
    let path = VaultPath::new("Hub.md").expect("path");

    let reader = Arc::new(fixture.service().reader().expect("reader"));
    fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");

    let (reached, release, hook) = pause_pair();
    fixture.service().pause_publication_for_test(hook);

    let mut service = fixture.take_service();
    let writer = thread::spawn(move || {
        service
            .refresh_paths(vault_paths(&["Hub.md"]), ChangeCause::Watcher)
            .expect("targeted publish");
        service
    });

    // The rows are committed; the live graph is not installed yet.
    reached.wait();

    let (finished, answered) = mpsc::channel();
    let reading = Arc::clone(&reader);
    let reading_path = path.clone();
    let blocked = thread::spawn(move || {
        let answer = reading.get_note(&reading_path);
        finished.send(()).ok();
        answer
    });
    assert!(
        answered.recv_timeout(BLOCKED_MARGIN).is_err(),
        "a read must never observe a generation whose live state is not installed yet"
    );

    release.wait();
    let after = blocked
        .join()
        .expect("reader thread")
        .expect("read after the publication");
    fixture.service = Some(writer.join().expect("writer thread"));

    assert_eq!(after.generation.get(), before + 1);
    fixture.assert_matches_scan();
}

/// A process that stops between the SQLite commit and the live install: the
/// rows are at `G + 1`, this process never installed the matching graph.
///
/// Two things must hold. Before the stop, every read **refuses** rather than
/// mixing committed rows with a stale graph. After it, a freshly opened
/// service adopts `G + 1` from SQLite alone — and assumes nothing about
/// events: its next reconciliation finds nothing to do and leaves the
/// generation where it is, so a reconnecting observer sees `G + 1` once, not
/// twice.
#[test]
fn a_stop_between_commit_and_live_install_reopens_from_sqlite_at_the_committed_generation() {
    let mut fixture = race_fixture();
    let before = fixture.generation();

    // `Lonely.md` is referenced by nothing and references nothing, so
    // replacing its row out of band leaves every other note's stored
    // resolution correct — exactly what a real commit of this delta would.
    let committed = publish_out_of_band(&fixture.config, &fixture.root, "Lonely.md", before);
    assert_eq!(committed, before + 1);

    assert_eq!(
        fixture.published(),
        (Some(before), Some(before)),
        "this process never installed the new generation"
    );
    assert!(
        matches!(
            fixture
                .borrow()
                .get_note(&VaultPath::new("Hub.md").unwrap()),
            Err(IndexError::LiveStateStale(_))
        ),
        "a read must refuse while the rows are ahead of the installed live state"
    );

    // The process stops. Everything the next one knows, it reads from SQLite.
    drop(fixture.take_service());
    let mut reopened = IndexService::open(fixture.config.clone()).expect("reopen the cache");
    assert_eq!(
        reopened.current_generation().expect("generation"),
        Some(Generation::new(before + 1))
    );
    fixture.service = Some(reopened);
    assert_eq!(
        fixture.published(),
        (Some(before + 1), Some(before + 1)),
        "reopening installs the live graph that matches the committed rows"
    );
    fixture.assert_matches_scan();

    // No false prior-event assumption: nothing is republished, so the
    // generation an observer reconnects at is the one it already sees.
    reopened = fixture.take_service();
    let report = reopened
        .refresh(false)
        .expect("reconciliation after reopen");
    assert_eq!(report.generation.get(), before + 1);
    assert_eq!(
        report.previous_generation,
        Some(Generation::new(before + 1))
    );
    fixture.service = Some(reopened);
    fixture.assert_matches_scan();
}

/// A process that stops *after* the live install: both halves already agree,
/// so reopening changes nothing and replays nothing. The mirror of the case
/// above, and the reason a reconnecting observer can trust the generation the
/// subscribe response hands it.
#[test]
fn a_stop_after_the_live_install_reopens_at_the_same_generation_and_replays_nothing() {
    let mut fixture = race_fixture();
    let before = fixture.generation();
    fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");
    let report = fixture.refresh_paths(&["Hub.md"]);
    assert_eq!(report.generation.get(), before + 1);

    drop(fixture.take_service());
    let mut reopened = IndexService::open(fixture.config.clone()).expect("reopen the cache");
    assert_eq!(
        reopened.current_generation().expect("generation"),
        Some(Generation::new(before + 1))
    );
    let again = reopened
        .refresh(false)
        .expect("reconciliation after reopen");
    assert_eq!(
        again.generation.get(),
        before + 1,
        "an unchanged vault must not manufacture a generation on reopen"
    );
    fixture.service = Some(reopened);
    assert_eq!(fixture.published(), (Some(before + 1), Some(before + 1)));
    fixture.assert_matches_scan();
}

/// Publish one note's rows through a second store handle — the same thing a
/// crash between commit and install leaves behind: committed rows this
/// process's live state knows nothing about. The fingerprint is the file's
/// real one, so the next reconciliation correctly sees the path as clean.
fn publish_out_of_band(config: &IndexConfig, root: &Path, name: &str, expected: u64) -> u64 {
    let path = VaultPath::new(name).expect("vault path");
    write_file(root, name, "# Lonely, rewritten out of band\n");

    let source = FileSystemVaultSource::new(root).expect("scan source");
    let scan = scan_vault(&source).expect("scan vault");
    let note = scan
        .graph
        .note(&path)
        .expect("the rewritten note is present")
        .clone();
    let fingerprint = FileSystemIndexSource::new(root)
        .expect("fingerprint source")
        .fingerprint(&path)
        .expect("fingerprint")
        .expect("the file exists");

    let resolutions: Vec<vault_index::ResolutionReplacement> = scan
        .graph
        .outgoing(&path)
        .iter()
        .enumerate()
        .map(|(ordinal, resolved)| {
            let target = vault_core::LinkTarget::from(&resolved.reference);
            vault_index::ResolutionReplacement {
                source_path: path.clone(),
                ordinal: ordinal as u32,
                resolution: resolved.resolution.clone(),
                dependencies: vault_core::reference_dependencies(
                    &path,
                    &target,
                    &resolved.resolution,
                ),
                diagnostic: vault_core::resolution_diagnostic(resolved),
            }
        })
        .collect();
    let notes = vec![vault_index::NoteReplacement { note, fingerprint }];

    let mut store = vault_index::IndexStore::open_for_test(config).expect("out-of-band store");
    let outcome = store
        .publish_delta(vault_index::DeltaPublication {
            expected: Generation::new(expected),
            notes: &notes,
            deleted: &[],
            fingerprint_updates: &[],
            resolutions: &resolutions,
            scan_diagnostics: None,
        })
        .expect("out-of-band delta");
    match outcome {
        vault_index::DeltaPublishOutcome::Committed { generation, .. } => generation.get(),
        other => panic!("expected an out-of-band commit, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Filesystem races
// ---------------------------------------------------------------------------

/// A file rewritten between its body read and its stability re-fingerprint is
/// refused, not indexed half-old. Forced at `AfterBodyRead`, so the window is
/// opened deliberately rather than raced for.
#[test]
fn a_file_rewritten_after_its_body_read_is_refused_and_stays_eligible() {
    let mut fixture = race_fixture();
    let before = fixture.generation();

    fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");
    let root = fixture.root.clone();
    fixture.install(once_at(HookPoint::AfterBodyRead, move || {
        write_file(&root, "Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n[[Peer]]\n");
    }));

    let error = fixture
        .try_refresh_paths(&["Hub.md"])
        .expect_err("a body that moved under the read must be refused");
    assert!(
        matches!(error, IndexError::VaultChangedDuringRefresh),
        "unexpected error: {error:?}"
    );
    assert_eq!(fixture.generation(), before, "nothing was published");
    assert_eq!(fixture.published(), (Some(before), Some(before)));

    // The hook has disarmed itself: the same dirty path now settles, and what
    // lands is the *rewritten* content, not the bytes that were read first.
    let report = fixture.refresh_paths(&["Hub.md"]);
    assert_eq!(report.generation.get(), before + 1);
    fixture.assert_matches_scan();
}

/// The pre-publication presence check is the last guard before the barrier: a
/// path the plan intends to replace, deleted after it was read and resolved,
/// aborts the whole batch rather than publishing a note that no longer
/// exists.
#[test]
fn a_planned_replacement_that_vanishes_before_the_presence_check_aborts_the_batch() {
    let mut fixture = race_fixture();
    let before = fixture.generation();

    fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");
    let root = fixture.root.clone();
    fixture.install(once_at(HookPoint::BeforePresenceCheck, move || {
        std::fs::remove_file(root.join("Hub.md")).expect("remove the planned path");
    }));

    let error = fixture
        .try_refresh_paths(&["Hub.md"])
        .expect_err("a planned replacement that vanished must be refused");
    assert!(
        matches!(error, IndexError::VaultChangedDuringRefresh),
        "unexpected error: {error:?}"
    );
    assert_eq!(fixture.generation(), before, "nothing was published");
    assert_eq!(fixture.published(), (Some(before), Some(before)));

    // Retried against the world as it now is: a deletion, published once.
    let report = fixture.refresh_paths(&["Hub.md"]);
    assert_eq!(report.generation.get(), before + 1);
    assert_eq!(
        report.changes.deleted,
        vec![VaultPath::new("Hub.md").unwrap()]
    );
    fixture.assert_matches_scan();
}

/// The mirror: a path the plan intends to *delete*, which comes back before
/// the presence check, must not be published as deleted. This is the atomic
/// save landing on its final name a microsecond too late.
#[test]
fn a_planned_deletion_that_reappears_before_the_presence_check_aborts_the_batch() {
    let mut fixture = race_fixture();
    let before = fixture.generation();

    fixture.delete("Peer.md");
    let root = fixture.root.clone();
    fixture.install(once_at(HookPoint::BeforePresenceCheck, move || {
        write_file(&root, "Peer.md", "# Peer, saved atomically\n[[Target]]\n");
    }));

    let error = fixture
        .try_refresh_paths(&["Peer.md"])
        .expect_err("a planned deletion that came back must be refused");
    assert!(
        matches!(error, IndexError::VaultChangedDuringRefresh),
        "unexpected error: {error:?}"
    );
    assert_eq!(fixture.generation(), before, "nothing was published");

    let report = fixture.refresh_paths(&["Peer.md"]);
    assert_eq!(report.generation.get(), before + 1);
    assert!(
        report.changes.deleted.is_empty(),
        "a path that came back must never publish as deleted"
    );
    assert_eq!(
        report.changes.modified,
        vec![VaultPath::new("Peer.md").unwrap()]
    );
    fixture.assert_matches_scan();
}

// ---------------------------------------------------------------------------
// Concurrent-writer races
// ---------------------------------------------------------------------------

/// A foreign writer that steals the generation between the plan and the
/// compare-and-swap costs a re-plan and nothing else: not one body is read
/// twice. The theft is forced at `BeforeDeltaPublication` and happens through
/// a separate connection, exactly as another process would do it.
#[test]
fn a_lost_compare_and_swap_replans_without_rereading_a_single_body() {
    let mut fixture = race_fixture();
    let before = fixture.generation();

    fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");
    let index_path = fixture.config.index_path.clone();
    let thefts = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&thefts);
    fixture.install(once_at(HookPoint::BeforeDeltaPublication, move || {
        let foreign = rusqlite::Connection::open(&index_path).expect("foreign connection");
        foreign
            .execute(
                "UPDATE index_metadata SET generation = generation + 1 WHERE singleton = 1",
                [],
            )
            .expect("steal the generation");
        counter.fetch_add(1, Ordering::SeqCst);
    }));

    let report = fixture.refresh_paths(&["Hub.md"]);

    assert_eq!(thefts.load(Ordering::SeqCst), 1, "the race must have fired");
    assert_eq!(
        report.generation.get(),
        before + 2,
        "the re-plan builds on the generation the foreign writer left"
    );
    assert_eq!(
        report.metrics.work.body_reads, 1,
        "a lost compare-and-swap re-plans; it must never re-read a body"
    );
    assert_eq!(
        report.metrics.work.notes_reparsed, 1,
        "the retry reports the work of the attempt that published, not the sum"
    );
    fixture.assert_matches_scan();
}

// ---------------------------------------------------------------------------
// Batch determinism
// ---------------------------------------------------------------------------

/// One dirty set, delivered forwards and delivered reversed-with-duplicates,
/// must publish the identical batch: same generation move, same change set,
/// same sorted order. Path order is a property of the producer, never of the
/// answer.
#[test]
fn duplicate_and_reversed_dirty_paths_publish_one_identical_batch() {
    let forward = {
        let mut fixture = race_fixture();
        fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");
        fixture.write("Peer.md", "# Peer\n[[Ghost]]\n");
        fixture.delete("Lonely.md");
        let report = fixture.refresh_paths(&["Hub.md", "Lonely.md", "Peer.md"]);
        fixture.assert_matches_scan();
        report
    };
    let reversed = {
        let mut fixture = race_fixture();
        fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");
        fixture.write("Peer.md", "# Peer\n[[Ghost]]\n");
        fixture.delete("Lonely.md");
        let report = fixture.refresh_paths(&[
            "Peer.md",
            "Lonely.md",
            "Hub.md",
            "Peer.md",
            "Hub.md",
            "Lonely.md",
        ]);
        fixture.assert_matches_scan();
        report
    };

    assert_eq!(forward.changes, reversed.changes);
    assert_eq!(forward.generation, reversed.generation);
    assert_eq!(
        forward.affected_reference_count,
        reversed.affected_reference_count
    );
    assert_eq!(
        forward.changes.modified,
        vault_paths(&["Hub.md", "Peer.md"])
            .into_iter()
            .collect::<Vec<_>>(),
        "the published change set is sorted and deduplicated"
    );
    assert_eq!(
        forward.changes.deleted,
        vec![VaultPath::new("Lonely.md").unwrap()]
    );
}

// ---------------------------------------------------------------------------
// Missed hints and complete-reconciliation convergence
// ---------------------------------------------------------------------------

/// A watcher hint that never arrives leaves the cache genuinely stale — the
/// test proves that first, so the convergence below is not vacuous — and the
/// periodic complete reconciliation repairs it in one generation.
#[test]
fn a_dropped_watcher_hint_converges_on_the_next_periodic_inventory() {
    let mut fixture = race_fixture();
    let before = fixture.generation();

    fixture.write("Hub.md", "# Hub\n[[Target]]\n[[Lonely]]\n");
    fixture.write("Peer.md", "# Peer\n[[Ghost]]\n");
    // Only one of the two changes is hinted; the other is the dropped event.
    let hinted = fixture.refresh_paths(&["Hub.md"]);
    assert_eq!(hinted.generation.get(), before + 1);

    let source = FileSystemVaultSource::new(&fixture.root).expect("scan source");
    let fresh = scan_vault(&source).expect("scan vault");
    assert_ne!(
        common::snapshot_from_index(fixture.borrow()),
        common::snapshot_from_scan(&fresh),
        "the dropped hint must genuinely leave the cache behind, or this test proves nothing"
    );

    let periodic = fixture
        .service()
        .refresh(false)
        .expect("periodic inventory");
    assert_eq!(periodic.generation.get(), before + 2);
    fixture.assert_matches_scan();

    // And it has converged: another inventory finds nothing left to do.
    let settled = fixture.service().refresh(false).expect("settled inventory");
    assert_eq!(settled.generation.get(), before + 2);
}

/// The complete reconciliation an overflow or a root invalidation escalates to
/// must not become a whole-vault re-read: unchanged notes keep their stored
/// parse, exactly one body is read, and the result is still equal to a clean
/// scan.
#[test]
fn a_complete_reconciliation_reads_only_what_changed() {
    let fixture = common::counting_service_with_two_notes();
    let mut fixture = fixture;
    for index in 0..6 {
        fixture.write_note(&format!("Extra-{index}.md"), &format!("# Extra {index}\n"));
    }
    fixture.service.refresh(false).expect("cold build");
    fixture.reset_counts();

    fixture.write_note("Extra-3.md", "# Extra three\n[[One]]\n");
    let report = fixture
        .service
        .refresh(false)
        .expect("complete reconciliation");

    assert_eq!(report.generation.get(), 2);
    assert_eq!(
        fixture.body_reads(),
        1,
        "a complete reconciliation reads only the bodies whose metadata moved"
    );
    assert_eq!(
        report
            .previous_generation
            .expect("a previous generation")
            .get(),
        1
    );
    assert_eq!(report.unchanged, 7);
    assert_eq!(report.reparsed, 1);

    let source = FileSystemVaultSource::new(fixture.vault.path()).expect("scan source");
    let fresh = scan_vault(&source).expect("scan vault");
    assert_eq!(
        common::snapshot_from_index(&fixture.service),
        common::snapshot_from_scan(&fresh),
    );
}
