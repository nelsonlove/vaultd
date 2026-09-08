//! Paging a snapshot's tree: complete, ordered, and stable across a write
//! storm.

use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    IndexConfig, IndexError, IndexService, Mutation, Precondition, SnapshotSessions, TreeEntryKind,
};

struct Fixture {
    service: IndexService,
    config: IndexConfig,
    _vault: TempDir,
    _index: TempDir,
    root: PathBuf,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder/Deep")).expect("create Folder/Deep");
    std::fs::write(root.join("Alpha.md"), "# Alpha\n").expect("write Alpha");
    std::fs::write(root.join("Folder/Beta.md"), "# Beta\n").expect("write Beta");
    std::fs::write(root.join("Folder/Deep/Gamma.md"), "# Gamma\n").expect("write Gamma");
    std::fs::write(root.join("Folder/image.png"), [1u8, 2, 3, 4]).expect("write an attachment");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("page config");
    let mut service = IndexService::open(config.clone()).expect("page service");
    service.refresh(false).expect("cold build");
    Fixture {
        service,
        config,
        _vault: vault,
        _index: index,
        root,
    }
}

fn drain(sessions: &mut SnapshotSessions, id: &str, limit: u32) -> Vec<(String, TreeEntryKind)> {
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = sessions
            .tree_page(id, cursor.as_deref(), Some(limit))
            .expect("a tree page");
        all.extend(
            page.entries
                .into_iter()
                .map(|entry| (entry.path.as_str().to_string(), entry.kind)),
        );
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    all
}

#[test]
fn a_tree_page_covers_folders_notes_and_attachments_in_path_order() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let entries = drain(&mut sessions, &opened.snapshot_id, 2);

    assert_eq!(
        entries,
        vec![
            ("Alpha.md".to_string(), TreeEntryKind::Note),
            ("Folder".to_string(), TreeEntryKind::Folder),
            ("Folder/Beta.md".to_string(), TreeEntryKind::Note),
            ("Folder/Deep".to_string(), TreeEntryKind::Folder),
            ("Folder/Deep/Gamma.md".to_string(), TreeEntryKind::Note),
            ("Folder/image.png".to_string(), TreeEntryKind::File),
        ]
    );
    assert_eq!(entries.len() as u64, opened.entry_count);
}

#[test]
fn a_note_entry_carries_the_snapshots_own_revision_size_and_stat() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let page = sessions
        .tree_page(&opened.snapshot_id, None, Some(100))
        .expect("one page");
    let alpha = page
        .entries
        .iter()
        .find(|entry| entry.path.as_str() == "Alpha.md")
        .expect("Alpha is in the tree");
    assert_eq!(
        alpha.revision.as_deref(),
        Some(vault_index::revision_of(b"# Alpha\n").as_str()),
        "a note's revision comes from `notes`, joined onto its tree row"
    );
    assert_eq!(
        alpha.size,
        Some(
            std::fs::metadata(fixture.root.join("Alpha.md"))
                .expect("stat Alpha")
                .len()
        ),
        "the stored size is the file's real size, not a re-derivation"
    );
    assert!(
        alpha.ctime_unix_ms > 0 && alpha.mtime_unix_ms > 0,
        "the host serves TFile.stat from these: {alpha:?}"
    );

    let attachment = page
        .entries
        .iter()
        .find(|entry| entry.path.as_str() == "Folder/image.png")
        .expect("the attachment is in the tree");
    assert_eq!(attachment.size, Some(4));
    // Checkpoint-1 ruling B5 (spec correction #13): the index stores **no**
    // content revision for a non-Markdown file — `tree_entries.content_revision`
    // is written NULL for every kind, and a note's revision lives on `notes`.
    // So only a note entry carries one. The brief predates that ruling and
    // asserted `is_some` here; the DTO doc (`TreeEntryDto`) already states the
    // divergence, and this is the assertion that matches the schema.
    assert!(
        attachment.revision.is_none(),
        "no revision is stored for an attachment, and a page hashes nothing: {attachment:?}"
    );

    let folder = page
        .entries
        .iter()
        .find(|entry| entry.path.as_str() == "Folder")
        .expect("Folder is in the tree");
    assert_eq!(folder.size, None);
    assert_eq!(folder.revision, None);
    assert!(
        folder.mtime_unix_ms > 0,
        "a folder has no size and no revision, but it does have timestamps"
    );
}

#[test]
fn a_session_pages_to_completion_at_its_own_generation_under_a_write_storm() {
    let mut fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");

    // One page in, then a storm, then the rest. The storm must be invisible.
    let first = sessions
        .tree_page(&opened.snapshot_id, None, Some(2))
        .expect("first page");
    for index in 0..10 {
        fixture
            .service
            .apply_mutation(&Mutation::WriteNote {
                path: VaultPath::new(format!("Storm-{index}.md")).expect("valid vault path"),
                content: format!("# Storm {index}\n"),
                expected: Precondition::Absent,
            })
            .expect("write during the snapshot");
    }
    fixture.service.refresh(false).expect("publish the storm");

    let mut entries: Vec<String> = first
        .entries
        .iter()
        .map(|entry| entry.path.as_str().to_string())
        .collect();
    let mut cursor = first.next_cursor;
    while let Some(current) = cursor {
        let page = sessions
            .tree_page(&opened.snapshot_id, Some(&current), Some(2))
            .expect("a later page");
        assert_eq!(
            page.generation, opened.generation,
            "every page answers at the pinned generation"
        );
        entries.extend(
            page.entries
                .iter()
                .map(|entry| entry.path.as_str().to_string()),
        );
        cursor = page.next_cursor;
    }
    assert!(
        entries.iter().all(|path| !path.starts_with("Storm-")),
        "a note written after the snapshot opened must never appear in it: {entries:?}"
    );
    assert_eq!(entries.len() as u64, opened.entry_count);
}

#[test]
fn a_cursor_from_another_session_is_refused() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let first = sessions.open().expect("first snapshot");
    let second = sessions.open().expect("second snapshot");
    let page = sessions
        .tree_page(&first.snapshot_id, None, Some(1))
        .expect("first page");
    let cursor = page.next_cursor.expect("more pages");
    let error = sessions
        .tree_page(&second.snapshot_id, Some(&cursor), Some(1))
        .expect_err("a cursor belongs to the session that issued it");
    assert!(
        matches!(error, IndexError::InvalidCursor(_)),
        "expected invalid_cursor, got {error:?}"
    );
}

#[test]
fn paging_a_closed_session_is_typed_rather_than_a_panic() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    sessions.close(&opened.snapshot_id).expect("close it");
    let error = sessions
        .tree_page(&opened.snapshot_id, None, Some(10))
        .expect_err("a closed session cannot be paged");
    assert!(matches!(error, IndexError::SnapshotNotFound(_)));
}
