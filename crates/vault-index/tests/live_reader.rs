//! Generation-consistent reads: a reader answers entirely from one
//! published generation, and a publication becomes client-visible only once
//! its SQLite rows AND its live graph are both in place.

mod common;

use std::sync::{Arc, Barrier, mpsc};
use std::thread;
use std::time::Duration;

use tempfile::TempDir;
use vault_core::{Resolution, Resolver, VaultPath};
use vault_index::{IndexConfig, IndexError, IndexService, LiveState};

/// A privately-owned vault plus its service, with the service held in an
/// `Option` so a test can move it onto a writer thread and take it back.
struct LiveFixture {
    service: Option<IndexService>,
    config: IndexConfig,
    vault: TempDir,
    _index_dir: TempDir,
}

impl LiveFixture {
    fn service(&mut self) -> &mut IndexService {
        self.service.as_mut().expect("service is on this thread")
    }

    fn take_service(&mut self) -> IndexService {
        self.service.take().expect("service is on this thread")
    }

    fn write_note(&self, name: &str, body: &str) {
        std::fs::write(self.vault.path().join(name), body).expect("write note");
    }
}

/// `Source.md -> [[Target]]` plus two standalone notes: enough for a
/// resolution answer to exist, and for a body edit to change exactly one
/// note's revision.
fn live_fixture() -> LiveFixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("Source.md"), "# Source\n[[Target]]\n").expect("write Source");
    std::fs::write(vault.path().join("Target.md"), "# Target\n").expect("write Target");
    std::fs::write(vault.path().join("Other.md"), "# Other\n").expect("write Other");

    let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
        .expect("live fixture config");
    let service = IndexService::open(config.clone()).expect("live fixture service");
    LiveFixture {
        service: Some(service),
        config,
        vault,
        _index_dir: index_dir,
    }
}

fn source_path() -> VaultPath {
    VaultPath::new("Source.md").expect("valid path")
}

/// Two rendezvous points around one publication: `reached` releases the test
/// once the writer is paused between its SQLite commit and its live-state
/// installation, and `release` lets the writer finish.
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

#[test]
fn a_read_started_during_publication_waits_for_the_whole_publication() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");
    let old_generation = fixture
        .service()
        .current_generation()
        .expect("generation")
        .expect("cold build published a generation");

    let reader = Arc::new(fixture.service().reader().expect("reader"));
    let old_read = reader.get_note(&source_path()).expect("old read");
    assert_eq!(old_read.generation.get(), old_generation.get());

    fixture.write_note("Source.md", "# Source changed\n[[Target]]\n");
    let (reached, release, hook) = pause_pair();
    fixture.service().pause_publication_for_test(hook);

    let mut service = fixture.take_service();
    let writer = thread::spawn(move || {
        service.refresh(false).expect("warm publish");
        service
    });

    // The writer is now holding the publication barrier: its rows are
    // committed, its live graph is not installed yet.
    reached.wait();

    let (finished, blocked_read) = mpsc::channel();
    let reading = Arc::clone(&reader);
    let blocked = thread::spawn(move || {
        let read = reading.get_note(&source_path());
        finished.send(()).ok();
        read
    });
    assert!(
        blocked_read
            .recv_timeout(Duration::from_millis(250))
            .is_err(),
        "a read must not observe a generation whose live state is not installed yet"
    );

    release.wait();
    let new_read = blocked.join().expect("reader thread").expect("new read");
    fixture.service = Some(writer.join().expect("writer thread"));

    assert_eq!(new_read.generation.get(), old_generation.get() + 1);
    assert_ne!(
        old_read.note.source.revision().as_str(),
        new_read.note.source.revision().as_str()
    );
}

/// The full publication path writes every row of a whole-vault snapshot
/// before it commits. Readers must keep answering throughout that window:
/// the barrier exists to swap state, not to serialize reads behind a write
/// transaction.
///
/// Driven through `refresh_complete_for_test` rather than `refresh`, because
/// a warm `refresh` now routes through the incremental engine, whose
/// publication is delta-bounded and has no row-writing window to keep reads
/// out of. The path under test here is the cold build's — exercised warm so a
/// previous generation exists for the reader to keep answering from.
#[test]
fn a_read_is_not_blocked_while_a_full_publication_writes_its_rows() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");
    let old_generation = fixture
        .service()
        .current_generation()
        .expect("generation")
        .expect("cold build published a generation");
    let reader = Arc::new(fixture.service().reader().expect("reader"));

    fixture.write_note("Source.md", "# Source changed\n[[Target]]\n");
    let (reached, release, hook) = pause_pair();
    fixture.service().pause_row_writes_for_test(hook);

    let mut service = fixture.take_service();
    let writer = thread::spawn(move || {
        service
            .refresh_complete_for_test(false)
            .expect("warm complete publish");
        service
    });

    // Every row of the new snapshot is written and the transaction is still
    // open. The barrier is NOT held.
    reached.wait();

    let (finished, answered) = mpsc::channel();
    let reading = Arc::clone(&reader);
    let read = thread::spawn(move || {
        let answer = reading.get_note(&source_path());
        finished.send(()).ok();
        answer
    });
    assert!(
        answered.recv_timeout(Duration::from_secs(2)).is_ok(),
        "a read must not block behind the writer's row writes"
    );
    let during = read
        .join()
        .expect("reader thread")
        .expect("read during row writes");
    assert_eq!(
        during.generation.get(),
        old_generation.get(),
        "uncommitted rows must be invisible to a reader"
    );

    release.wait();
    fixture.service = Some(writer.join().expect("writer thread"));
    let after = reader
        .get_note(&source_path())
        .expect("read after publication");
    assert_eq!(after.generation.get(), old_generation.get() + 1);
}

#[test]
fn a_read_started_before_the_writer_acquires_the_barrier_finishes_at_the_old_generation() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");
    let old_generation = fixture
        .service()
        .current_generation()
        .expect("generation")
        .expect("cold build published a generation");
    let old_revision = fixture
        .service()
        .get_note(&source_path())
        .expect("old note")
        .note
        .source
        .revision()
        .as_str()
        .to_string();

    let (reached, release, hook) = pause_pair();
    let mut reader = fixture.service().reader().expect("reader");
    reader.pause_reads_for_test(hook);
    let reader = Arc::new(reader);

    let reading = Arc::clone(&reader);
    let read = thread::spawn(move || reading.get_note(&source_path()));

    // The read now holds the publication barrier, before the writer has
    // asked for it.
    reached.wait();

    fixture.write_note("Source.md", "# Source changed\n[[Target]]\n");
    let mut service = fixture.take_service();
    let writer = thread::spawn(move || {
        service.refresh(false).expect("warm publish");
        service
    });
    // Give the writer every chance to reach (and block on) the barrier.
    thread::sleep(Duration::from_millis(150));

    release.wait();
    let old_read = read.join().expect("reader thread").expect("old read");
    fixture.service = Some(writer.join().expect("writer thread"));

    assert_eq!(old_read.generation.get(), old_generation.get());
    assert_eq!(old_read.note.source.revision().as_str(), old_revision);
    assert_eq!(
        fixture
            .service()
            .current_generation()
            .expect("generation")
            .expect("published"),
        vault_index::Generation::new(old_generation.get() + 1)
    );
}

#[test]
fn opening_a_reader_never_creates_a_cache() {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    let index_path = index_dir.path().join("absent.sqlite3");
    let config = IndexConfig::explicit(vault.path(), &index_path).expect("config");

    let error = vault_index::open_reader_for_test(&config).expect_err("no cache to open");
    assert!(
        matches!(
            error,
            IndexError::Storage(_) | IndexError::IncompatibleIndex(_)
        ),
        "unexpected error: {error:?}"
    );
    assert!(
        !index_path.exists(),
        "opening a reader must never create a cache file"
    );
}

#[test]
fn a_reader_connection_refuses_writes() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");

    let connection = vault_index::open_reader_for_test(&fixture.config).expect("reader connection");
    let error = connection
        .execute("DELETE FROM notes", [])
        .expect_err("a reader connection must refuse writes");
    assert!(
        error.to_string().to_lowercase().contains("readonly"),
        "unexpected error: {error}"
    );
}

#[test]
fn the_published_graph_resolves_exactly_like_a_fresh_hydration() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");
    fixture.write_note("Ambiguous.md", "[[Target]]\n[[Missing]]\n");
    fixture.service().refresh(false).expect("warm publish");

    let hydrated = fixture.service().hydrate_live_graph().expect("hydrate");
    let catalog: Vec<vault_core::ResolutionNote> = hydrated
        .note_paths()
        .into_iter()
        .map(|path| {
            let note = hydrated.note(&path).expect("hydrated note");
            vault_core::ResolutionNote {
                path,
                headings: note.headings,
                blocks: note.blocks,
                views: None,
            }
        })
        .collect();
    let expected = Resolver::from_catalog(catalog);

    let reader = fixture.service().reader().expect("reader");
    for destination in ["Target", "Missing", "Other", "Target#Target", "Source"] {
        let (generation, resolution) = reader
            .resolve_link(&source_path(), destination)
            .expect("resolve link");
        assert_eq!(generation.get(), 2);
        assert_eq!(
            resolution,
            expected.resolve_target(&source_path(), &vault_core::LinkTarget::parse(destination)),
            "published graph disagreed with a fresh hydration for {destination}"
        );
    }
}

#[test]
fn a_delta_publication_advances_rows_and_live_graph_together() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");
    let reader = fixture.service().reader().expect("reader");
    let expected = fixture
        .service()
        .current_generation()
        .expect("generation")
        .expect("cold build published a generation");

    // A brand-new note, published as a delta: its row must appear, and the
    // published live graph must start offering it as a resolution target.
    let path = VaultPath::new("New.md").expect("valid path");
    let note = vault_core::parse_note(vault_core::SourceDocument::new(
        path.clone(),
        "# New\n".to_string(),
    ));
    let notes = vec![vault_index::NoteReplacement {
        note,
        fingerprint: vault_index::FileFingerprint {
            size: 6,
            modified_seconds: 1,
            modified_nanos: 0,
        },
    }];
    let graph_notes = vec![vault_index::HydratedNote {
        path: path.clone(),
        headings: vec!["New".to_string()],
        blocks: Vec::new(),
    }];

    assert!(matches!(
        reader
            .resolve_link(&source_path(), "New")
            .expect("resolve before"),
        (_, Resolution::Unresolved)
    ));

    let outcome = fixture
        .service()
        .publish_delta(
            vault_index::DeltaPublication {
                expected,
                notes: &notes,
                deleted: &[],
                fingerprint_updates: &[],
                resolutions: &[],
                scan_diagnostics: None,
                tree: &vault_index::TreeDelta::default(),
            },
            &graph_notes,
            &[],
            &[],
        )
        .expect("publish delta");
    let generation = match outcome {
        vault_index::DeltaPublishOutcome::Committed { generation, .. } => generation,
        other => panic!("expected a committed delta, got {other:?}"),
    };
    assert_eq!(generation.get(), expected.get() + 1);

    let indexed = reader.get_note(&path).expect("delta row is readable");
    assert_eq!(indexed.generation, generation);
    let (resolved_generation, resolution) = reader
        .resolve_link(&source_path(), "New")
        .expect("resolve after");
    assert_eq!(resolved_generation, generation);
    assert!(
        matches!(resolution, Resolution::Resolved { ref target, .. } if target == &path),
        "the live graph installed with this generation must know the new note: {resolution:?}"
    );
}

/// The no-whole-graph-clone claim, mechanically enforced rather than merely
/// documented: `published_state` hands out a co-owning handle, and a handle
/// still alive when a delta installs turns `Arc::make_mut` into a deep copy of
/// the entire graph. Nothing in the process would otherwise report that — it
/// would surface only as unexplained latency — so a debug tripwire fires
/// instead, and this test is what proves the tripwire is armed.
///
/// Debug-assertions only, by construction: the assert compiles out of a
/// release build, where the copy is silently correct (just slow).
#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "whole-graph copy")]
fn a_held_published_state_handle_trips_the_whole_graph_copy_tripwire() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");
    let reader = fixture.service().reader().expect("reader");
    let expected = fixture
        .service()
        .current_generation()
        .expect("generation")
        .expect("cold build published a generation");

    // The leak under test: a second owner of the live graph, still alive when
    // the delta below installs.
    let held = reader.published_state().expect("published state");

    let path = VaultPath::new("New.md").expect("valid path");
    let note = vault_core::parse_note(vault_core::SourceDocument::new(
        path.clone(),
        "# New\n".to_string(),
    ));
    let notes = vec![vault_index::NoteReplacement {
        note,
        fingerprint: vault_index::FileFingerprint {
            size: 6,
            modified_seconds: 1,
            modified_nanos: 0,
        },
    }];
    let graph_notes = vec![vault_index::HydratedNote {
        path,
        headings: vec!["New".to_string()],
        blocks: Vec::new(),
    }];

    let published = fixture.service().publish_delta(
        vault_index::DeltaPublication {
            expected,
            notes: &notes,
            deleted: &[],
            fingerprint_updates: &[],
            resolutions: &[],
            scan_diagnostics: None,
            tree: &vault_index::TreeDelta::default(),
        },
        &graph_notes,
        &[],
        &[],
    );
    drop(held);
    published.expect("publish delta");
}

#[test]
fn a_lost_delta_compare_and_swap_leaves_the_published_state_untouched() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");
    let reader = fixture.service().reader().expect("reader");
    let stale = fixture
        .service()
        .current_generation()
        .expect("generation")
        .expect("cold build published a generation");

    // Another writer moves the cache on between this service's last
    // publication and its next one: the delta's `expected` still matches the
    // published live graph, but no longer matches the stored generation.
    let raw = rusqlite::Connection::open(&fixture.config.index_path).expect("raw open");
    raw.execute(
        "UPDATE index_metadata SET generation = generation + 1 WHERE singleton = 1",
        [],
    )
    .expect("advance generation");
    drop(raw);

    let path = VaultPath::new("New.md").expect("valid path");
    let note = vault_core::parse_note(vault_core::SourceDocument::new(
        path.clone(),
        "# New\n".to_string(),
    ));
    let notes = vec![vault_index::NoteReplacement {
        note,
        fingerprint: vault_index::FileFingerprint {
            size: 6,
            modified_seconds: 1,
            modified_nanos: 0,
        },
    }];
    let graph_notes = vec![vault_index::HydratedNote {
        path: path.clone(),
        headings: vec!["New".to_string()],
        blocks: Vec::new(),
    }];

    let outcome = fixture
        .service()
        .publish_delta(
            vault_index::DeltaPublication {
                expected: stale,
                notes: &notes,
                deleted: &[],
                fingerprint_updates: &[],
                resolutions: &[],
                scan_diagnostics: None,
                tree: &vault_index::TreeDelta::default(),
            },
            &graph_notes,
            &[],
            &[],
        )
        .expect("publish delta");
    assert!(matches!(
        outcome,
        vault_index::DeltaPublishOutcome::GenerationChanged
    ));

    // Neither half moved: the published state is still the generation this
    // service published, and the live graph still does not know `New.md`.
    assert_eq!(
        reader
            .published_status()
            .expect("published status")
            .generation,
        Some(stale)
    );
    assert!(matches!(
        reader
            .resolve_link(&source_path(), "New")
            .expect("resolve after"),
        (_, Resolution::Unresolved)
    ));

    // The store is ahead of what this process published, so every SQL-backed
    // read refuses rather than mixing a foreign generation's rows with this
    // process's live graph. This refusal is the only defense against that
    // mixture, so it is asserted before the cure below removes it.
    assert!(
        matches!(
            reader.get_note(&source_path()),
            Err(IndexError::LiveStateStale(_))
        ),
        "a read must refuse while the store is ahead of the published generation"
    );

    // And no row was written either — adopting the foreign generation makes
    // the rows readable again, and `New.md` is not among them.
    fixture
        .service()
        .resync_published()
        .expect("adopt the foreign generation");
    assert!(matches!(
        reader.get_note(&path),
        Err(IndexError::NoteNotFound(_))
    ));
}

#[test]
fn a_reader_sees_the_writers_live_state() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");
    let reader = fixture.service().reader().expect("reader");

    assert_eq!(
        reader
            .published_status()
            .expect("published status")
            .live_state,
        LiveState::Starting
    );

    fixture
        .service()
        .set_live_state(LiveState::Watching)
        .expect("set live state");
    let status = reader.published_status().expect("published status");
    assert_eq!(status.live_state, LiveState::Watching);
    assert_eq!(status.runtime_error, None);
    assert_eq!(
        status.generation,
        fixture.service().current_generation().expect("generation")
    );
    // Status observation reports the live graph's generation without handing
    // out the graph itself.
    assert_eq!(status.graph_generation, status.generation);

    fixture
        .service()
        .set_runtime_error(Some("watcher fell back to polling".to_string()))
        .expect("set runtime error");
    assert_eq!(
        reader
            .published_status()
            .expect("published status")
            .runtime_error
            .as_deref(),
        Some("watcher fell back to polling")
    );
    // Neither call disturbed the published generation or its graph: reads
    // still answer.
    assert!(reader.get_note(&source_path()).is_ok());
}

#[test]
fn a_reader_answers_before_the_first_publication_with_index_unavailable() {
    let mut fixture = live_fixture();
    let reader = fixture.service().reader().expect("reader");
    assert!(matches!(
        reader.get_note(&source_path()),
        Err(IndexError::IndexUnavailable)
    ));
    assert!(matches!(
        reader.resolve_link(&source_path(), "Target"),
        Err(IndexError::IndexUnavailable)
    ));
}

#[test]
fn reader_queries_match_the_service_query_api() {
    let mut fixture = live_fixture();
    fixture.service().refresh(false).expect("cold build");
    let reader = fixture.service().reader().expect("reader");
    let path = source_path();

    assert_eq!(
        reader.list_notes(None, None).expect("reader list"),
        fixture.service().list_notes(None, None).expect("list")
    );
    assert_eq!(
        reader.get_note(&path).expect("reader note"),
        fixture.service().get_note(&path).expect("note")
    );
    assert_eq!(
        reader
            .get_backlinks(&VaultPath::new("Target.md").unwrap(), None, None)
            .expect("reader backlinks"),
        fixture
            .service()
            .get_backlinks(&VaultPath::new("Target.md").unwrap(), None, None)
            .expect("backlinks")
    );
    assert_eq!(
        reader
            .list_references(None, None, None, None)
            .expect("reader references"),
        fixture
            .service()
            .list_references(None, None, None, None)
            .expect("references")
    );
    assert_eq!(
        reader
            .get_diagnostics(None, None, None, None)
            .expect("reader diagnostics"),
        fixture
            .service()
            .get_diagnostics(None, None, None, None)
            .expect("diagnostics")
    );
    assert_eq!(
        reader.vault_info().expect("reader vault info"),
        fixture.service().vault_info().expect("vault info")
    );
    assert!(matches!(
        reader.resolve_link(&path, "Target").expect("resolve").1,
        Resolution::Resolved { .. }
    ));
}
