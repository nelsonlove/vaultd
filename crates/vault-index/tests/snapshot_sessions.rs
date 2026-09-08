//! Snapshot sessions: pinned, reclaimed, capped, and released.

use std::time::Duration;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    IndexConfig, IndexError, IndexService, Mutation, Precondition, SnapshotSessions,
};

struct Fixture {
    service: IndexService,
    config: IndexConfig,
    _vault: TempDir,
    _index: TempDir,
}

fn fixture(configure: impl FnOnce(&mut IndexConfig)) -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder")).expect("create Folder");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    std::fs::write(root.join("Folder/Two.md"), "# Two\n").expect("write Two");
    std::fs::write(root.join("Folder/image.png"), [1u8, 2, 3]).expect("write an attachment");

    let mut config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("snapshot config");
    configure(&mut config);
    let mut service = IndexService::open(config.clone()).expect("snapshot service");
    service.refresh(false).expect("cold build");
    Fixture {
        service,
        config,
        _vault: vault,
        _index: index,
    }
}

#[test]
fn a_session_reports_the_generation_and_both_counts_it_opened_on() {
    let fixture = fixture(|_| {});
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    assert_eq!(
        opened.generation,
        fixture
            .service
            .current_generation()
            .expect("generation")
            .expect("published")
    );
    assert_eq!(opened.note_count, 2);
    assert_eq!(
        opened.entry_count, 4,
        "every tree_entries row: two notes, one folder, one attachment"
    );
    assert!(
        opened.entry_count >= opened.note_count,
        "the tree contains the notes, so it can never be the smaller count"
    );
    assert_eq!(sessions.len(), 1);
}

#[test]
fn a_session_stays_at_its_own_generation_while_the_writer_moves_on() {
    let mut fixture = fixture(|_| {});
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");

    for index in 0..5 {
        fixture
            .service
            .apply_mutation(&Mutation::WriteNote {
                path: VaultPath::new(format!("Storm-{index}.md")).expect("valid vault path"),
                content: format!("# Storm {index}\n"),
                expected: Precondition::Absent,
            })
            .expect("write during the snapshot");
        fixture
            .service
            .refresh(false)
            .expect("publish during the snapshot");
    }

    let after = fixture
        .service
        .current_generation()
        .expect("generation")
        .expect("published");
    assert!(
        after > opened.generation,
        "the writer must have proceeded: {after:?} vs {:?}",
        opened.generation
    );
    assert_eq!(
        sessions
            .generation_of(&opened.snapshot_id)
            .expect("the session is still open"),
        opened.generation,
        "the pinned reader sees its generation forever"
    );
    // The bookkeeping above is a struct field, which a broken pin would keep
    // answering correctly. This is the claim itself: what the session's *own
    // transaction* reads, after five committed generations landed on the same
    // database, is still the generation and the note count it opened on.
    assert_eq!(
        sessions
            .pinned_state_for_test(&opened.snapshot_id)
            .expect("the session is still open"),
        (opened.generation, opened.note_count),
        "the pinned transaction must not see a single frame the writer added"
    );
}

#[test]
fn the_concurrency_cap_refuses_rather_than_pinning_the_wal_indefinitely() {
    let fixture = fixture(|config| config.max_concurrent_snapshots = 2);
    let mut sessions = SnapshotSessions::new(&fixture.config);
    sessions.open().expect("first snapshot");
    sessions.open().expect("second snapshot");
    let error = sessions.open().expect_err("the third must be refused");
    match error {
        IndexError::TooManySnapshots { limit } => assert_eq!(limit, 2),
        other => panic!("expected too_many_snapshots, got {other:?}"),
    }
}

#[test]
fn an_idle_session_is_reclaimed_so_a_new_one_can_open() {
    let fixture = fixture(|config| {
        config.max_concurrent_snapshots = 1;
        config.snapshot_idle_timeout = Duration::from_millis(50);
    });
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let stale = sessions.open().expect("first snapshot");
    std::thread::sleep(Duration::from_millis(120));
    let fresh = sessions
        .open()
        .expect("the idle session must be reclaimed to make room");
    assert_ne!(stale.snapshot_id, fresh.snapshot_id);
    assert!(
        matches!(
            sessions.close(&stale.snapshot_id),
            Err(IndexError::SnapshotNotFound(_))
        ),
        "the reclaimed session must be gone, not merely unusable"
    );
    assert_eq!(sessions.len(), 1);
}

#[test]
fn closing_a_session_releases_it_and_closing_it_twice_is_typed() {
    let fixture = fixture(|_| {});
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    sessions.close(&opened.snapshot_id).expect("close it once");
    assert_eq!(sessions.len(), 0);
    match sessions.close(&opened.snapshot_id) {
        Err(IndexError::SnapshotNotFound(id)) => assert_eq!(id, opened.snapshot_id),
        other => panic!("expected snapshot_not_found, got {other:?}"),
    }
}

#[test]
fn closing_every_session_is_what_a_disconnect_does() {
    let fixture = fixture(|_| {});
    let mut sessions = SnapshotSessions::new(&fixture.config);
    sessions.open().expect("first snapshot");
    sessions.open().expect("second snapshot");
    sessions.close_all();
    assert_eq!(sessions.len(), 0);
    assert!(sessions.is_empty());
}
