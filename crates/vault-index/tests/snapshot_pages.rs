//! Paging a snapshot's tree and its per-note semantics: complete, ordered,
//! and stable across a write storm — and refused outright when the pin that
//! makes those claims true is no longer held.

use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    IndexConfig, IndexError, IndexService, Mutation, NoteFacets, Precondition, SnapshotSessions,
    TreeEntryKind,
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

#[test]
fn a_notes_page_carries_only_the_facets_that_were_asked_for() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let page = sessions
        .notes_page(
            &opened.snapshot_id,
            None,
            Some(100),
            NoteFacets {
                metadata: true,
                references: false,
                resolutions: false,
                backlinks: false,
                sections: false,
                list_items: false,
            },
        )
        .expect("a notes page");
    assert_eq!(page.notes.len(), 3);
    let alpha = &page.notes[0];
    assert_eq!(alpha.path.as_str(), "Alpha.md");
    assert_eq!(
        alpha.revision,
        vault_index::revision_of(b"# Alpha\n"),
        "the page reports the snapshot's revision, not the file's current one"
    );
    assert!(alpha.metadata.is_some());
    assert!(
        alpha.references.is_none()
            && alpha.resolutions.is_none()
            && alpha.backlinks.is_none()
            && alpha.sections.is_none()
            && alpha.list_items.is_none(),
        "an unrequested facet is not read at all"
    );
    assert_eq!(
        alpha
            .metadata
            .as_ref()
            .expect("metadata was requested")
            .headings
            .len(),
        1
    );
}

/// The documented default for an absent `include`: a page of identities.
/// Every facet is absent, which is the honest answer to "you asked for none"
/// — and distinguishable on the wire from "this note has none", because the
/// field is missing rather than an empty array.
#[test]
fn asking_for_no_facet_at_all_still_pages_every_notes_path_and_revision() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let page = sessions
        .notes_page(&opened.snapshot_id, None, Some(100), NoteFacets::default())
        .expect("a notes page");
    assert_eq!(page.notes.len() as u64, opened.note_count);
    assert!(
        page.notes.iter().all(|note| note.metadata.is_none()
            && note.references.is_none()
            && note.resolutions.is_none()
            && note.backlinks.is_none()
            && note.sections.is_none()
            && note.list_items.is_none()),
        "no facet was asked for, so none is read: {:?}",
        page.notes
    );
    assert!(page.notes.iter().all(|note| !note.revision.is_empty()));
}

#[test]
fn references_resolutions_and_backlinks_agree_with_each_other() {
    let fixture = fixture();
    // Checkpoint-1 ruling B1: a reference is a `[[wikilink]]`. The brief's
    // bare `Alpha` is prose — it parses as no reference at all, so the
    // backlink this test is about would never exist.
    std::fs::write(fixture.root.join("Pointer.md"), "[[Alpha]]\n").expect("write Pointer");
    let mut service = fixture.service;
    service.refresh(false).expect("index the pointer");
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let page = sessions
        .notes_page(
            &opened.snapshot_id,
            None,
            Some(100),
            NoteFacets {
                metadata: false,
                references: true,
                resolutions: true,
                backlinks: true,
                sections: false,
                list_items: false,
            },
        )
        .expect("a notes page");

    let alpha = page
        .notes
        .iter()
        .find(|note| note.path.as_str() == "Alpha.md")
        .expect("Alpha is in the page");
    let backlinks = alpha.backlinks.as_ref().expect("backlinks were requested");
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source.as_str(), "Pointer.md");

    let pointer = page
        .notes
        .iter()
        .find(|note| note.path.as_str() == "Pointer.md")
        .expect("Pointer is in the page");
    let references = pointer
        .references
        .as_ref()
        .expect("references were requested");
    let resolutions = pointer
        .resolutions
        .as_ref()
        .expect("resolutions were requested");
    assert_eq!(references.len(), resolutions.len());
    assert_eq!(references[0].resolution, resolutions[0]);
}

/// `sections` and `list_items` are siblings of `metadata`, served straight
/// from the pinned schema-v3 rows: the spans as stored (UTF-16 code units,
/// never re-derived), `block_id` carried through, and the line-number parent
/// model with exactly one of its two columns set.
#[test]
fn sections_and_list_items_come_out_of_the_stored_rows_unchanged() {
    let fixture = fixture();
    std::fs::write(
        fixture.root.join("List.md"),
        "---\ntitle: List\n---\n# List\n\n- top\n    - nested\n- [x] done\n\nAnchored. ^anchor\n",
    )
    .expect("write List");
    let mut service = fixture.service;
    service.refresh(false).expect("index the list");
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let page = sessions
        .notes_page(
            &opened.snapshot_id,
            None,
            Some(100),
            NoteFacets {
                metadata: false,
                references: false,
                resolutions: false,
                backlinks: false,
                sections: true,
                list_items: true,
            },
        )
        .expect("a notes page");
    let list = page
        .notes
        .iter()
        .find(|note| note.path.as_str() == "List.md")
        .expect("List is in the page");

    let sections = list.sections.as_ref().expect("sections were requested");
    assert_eq!(
        sections.first().map(|section| section.kind.as_str()),
        Some("yaml"),
        "the frontmatter block is the first section: {sections:?}"
    );
    assert!(
        sections
            .iter()
            .any(|section| section.block_id.as_deref() == Some("anchor")),
        "a trailing ^id is carried through every read path: {sections:?}"
    );

    let items = list.list_items.as_ref().expect("list items were requested");
    assert_eq!(items.len(), 3);
    assert!(
        items
            .iter()
            .all(|item| item.list_start_line.is_some() != item.parent_start_line.is_some()),
        "exactly one parent column is ever set: {items:?}"
    );
    assert_eq!(
        items
            .iter()
            .filter(|item| item.parent_start_line.is_some())
            .count(),
        1,
        "one nested item, naming its parent item's start line: {items:?}"
    );
    assert_eq!(
        items
            .iter()
            .filter_map(|item| item.task.as_deref())
            .collect::<Vec<_>>(),
        vec!["x"],
        "a task carries the raw character inside the brackets: {items:?}"
    );
    // Spans are stored UTF-16 code-unit offsets and are served as stored.
    assert!(
        items.iter().all(|item| item.span.end() > item.span.start()),
        "{items:?}"
    );
}

#[test]
fn a_notes_page_stays_at_its_generation_and_pages_by_path() {
    let mut fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");

    fixture
        .service
        .apply_mutation(&Mutation::WriteNote {
            path: VaultPath::new("Zulu.md").expect("valid vault path"),
            content: "# Zulu\n".into(),
            expected: Precondition::Absent,
        })
        .expect("write during the snapshot");
    fixture.service.refresh(false).expect("publish the write");

    let facets = NoteFacets::default();
    let mut paths = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = sessions
            .notes_page(&opened.snapshot_id, cursor.as_deref(), Some(2), facets)
            .expect("a notes page");
        assert_eq!(page.generation, opened.generation);
        paths.extend(page.notes.iter().map(|note| note.path.as_str().to_string()));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(
        paths,
        vec![
            "Alpha.md".to_string(),
            "Folder/Beta.md".to_string(),
            "Folder/Deep/Gamma.md".to_string()
        ],
        "a note written after the snapshot opened must never appear in it"
    );
    assert_eq!(paths.len() as u64, opened.note_count);
}

#[test]
fn a_notes_cursor_from_another_session_is_refused() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let first = sessions.open().expect("first snapshot");
    let second = sessions.open().expect("second snapshot");
    let page = sessions
        .notes_page(&first.snapshot_id, None, Some(1), NoteFacets::default())
        .expect("first page");
    let cursor = page.next_cursor.expect("more pages");
    let error = sessions
        .notes_page(
            &second.snapshot_id,
            Some(&cursor),
            Some(1),
            NoteFacets::default(),
        )
        .expect_err("a cursor belongs to the session that issued it");
    assert!(
        matches!(error, IndexError::InvalidCursor(_)),
        "expected invalid_cursor, got {error:?}"
    );
}

/// A `snapshot_tree` cursor is not a `snapshot_notes` cursor even inside one
/// session: the two pagers walk different tables, and `tree_entries` holds
/// folders a notes page has no row for.
#[test]
fn a_tree_cursor_does_not_page_the_notes_listing() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let cursor = sessions
        .tree_page(&opened.snapshot_id, None, Some(1))
        .expect("a tree page")
        .next_cursor
        .expect("more tree pages");
    let error = sessions
        .notes_page(
            &opened.snapshot_id,
            Some(&cursor),
            Some(1),
            NoteFacets::default(),
        )
        .expect_err("the two listings do not share cursors");
    assert!(
        matches!(error, IndexError::InvalidCursor(_)),
        "expected invalid_cursor, got {error:?}"
    );
}

#[test]
fn paging_the_notes_of_a_closed_session_is_typed_rather_than_a_panic() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    sessions.close(&opened.snapshot_id).expect("close it");
    let error = sessions
        .notes_page(&opened.snapshot_id, None, Some(10), NoteFacets::default())
        .expect_err("a closed session cannot be paged");
    assert!(matches!(error, IndexError::SnapshotNotFound(_)));
}

/// End the session's pinned transaction the way the Task 14 reviewer's probe
/// did, then move the writer past it. Both pagers must refuse: a page whose
/// pin is gone would serve post-snapshot rows under the pinned generation
/// number, which is the one failure this whole module exists to prevent.
fn unpin_and_move_the_writer(
    fixture: &mut Fixture,
    sessions: &mut SnapshotSessions,
    id: &str,
    marker: &str,
) {
    sessions
        .end_pinned_transaction_for_test(id)
        .expect("end the pinned transaction under the session");
    fixture
        .service
        .apply_mutation(&Mutation::WriteNote {
            path: VaultPath::new(marker).expect("valid vault path"),
            content: format!("# {marker}\n"),
            expected: Precondition::Absent,
        })
        .expect("write past the snapshot");
    fixture.service.refresh(false).expect("publish past it");
}

/// The refusal, with the generation it says the connection now reads handed
/// back so a caller can say *why* the refusal had to be direct.
fn assert_pin_lost(error: IndexError, id: &str, pinned: u64) -> u64 {
    match error {
        IndexError::SnapshotPinLost {
            snapshot,
            pinned: claimed,
            observed,
        } => {
            assert_eq!(snapshot, id);
            assert_eq!(claimed, pinned);
            observed
        }
        other => panic!("expected a lost-pin refusal, got {other:?}"),
    }
}

/// Task 14 review finding M-a, demonstrated rather than hypothesised: with the
/// pinned transaction ended under it, `tree_page` used to serve post-snapshot
/// rows while still reporting `Generation(1)` from a struct field. The
/// generation is now re-read inside the page's own transaction.
#[test]
fn a_tree_page_refuses_when_its_own_transaction_no_longer_holds_the_pin() {
    let mut fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    unpin_and_move_the_writer(&mut fixture, &mut sessions, &opened.snapshot_id, "Later.md");

    let error = sessions
        .tree_page(&opened.snapshot_id, None, Some(100))
        .expect_err("a page whose pin is gone must refuse, not serve");
    let observed = assert_pin_lost(error, &opened.snapshot_id, opened.generation.get());
    assert!(
        observed > opened.generation.get(),
        "the refusal names what the transaction now reads: {observed}"
    );
}

#[test]
fn a_notes_page_refuses_when_its_own_transaction_no_longer_holds_the_pin() {
    let mut fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    unpin_and_move_the_writer(&mut fixture, &mut sessions, &opened.snapshot_id, "Later.md");

    let error = sessions
        .notes_page(&opened.snapshot_id, None, Some(100), NoteFacets::default())
        .expect_err("a page whose pin is gone must refuse, not serve");
    let observed = assert_pin_lost(error, &opened.snapshot_id, opened.generation.get());
    assert!(
        observed > opened.generation.get(),
        "the refusal names what the transaction now reads: {observed}"
    );
}

/// End the pin, then make the writer commit *without* moving the generation:
/// rewriting a note with its own bytes changes its mtime, so reconciliation
/// takes `IndexStore::touch`, which commits `tree_entries` metadata and note
/// fingerprints and stamps `refreshed_at_unix_ms` — and never bumps the
/// generation.
fn unpin_and_touch_without_moving_the_generation(
    fixture: &mut Fixture,
    sessions: &mut SnapshotSessions,
    id: &str,
) {
    sessions
        .end_pinned_transaction_for_test(id)
        .expect("end the pinned transaction under the session");
    std::thread::sleep(std::time::Duration::from_millis(10));
    std::fs::write(fixture.root.join("Alpha.md"), "# Alpha\n").expect("rewrite Alpha's own bytes");
    fixture.service.refresh(false).expect("reconcile the touch");
}

/// Task 15 review finding I-3, demonstrated by the reviewer: a generation
/// re-read cannot see this. `touch` commits a moved `mtime_unix_ms` under the
/// same generation, so an unpinned tree page passed the generation check and
/// served the new stat — the number a host builds `TFile.stat` from. The pin
/// is therefore detected **directly**: a rolled-back deferred transaction
/// leaves the connection in autocommit, which is evidence about the pin
/// itself rather than about the world the pin was meant to freeze.
#[test]
fn a_tree_page_refuses_a_lost_pin_even_when_the_generation_never_moved() {
    let mut fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    unpin_and_touch_without_moving_the_generation(&mut fixture, &mut sessions, &opened.snapshot_id);

    let error = sessions
        .tree_page(&opened.snapshot_id, None, Some(100))
        .expect_err("an unpinned page must refuse even at an unchanged generation");
    let observed = assert_pin_lost(error, &opened.snapshot_id, opened.generation.get());
    assert_eq!(
        observed,
        opened.generation.get(),
        "the generation never moved, so only direct evidence of the lost pin could refuse this"
    );
}

/// The notes half serves nothing `touch` writes, so no row could tear here —
/// but a session that cannot prove it holds its pin has nothing to serve a
/// page from, and both pagers answer that the same way.
#[test]
fn a_notes_page_refuses_a_lost_pin_even_when_the_generation_never_moved() {
    let mut fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    unpin_and_touch_without_moving_the_generation(&mut fixture, &mut sessions, &opened.snapshot_id);

    let error = sessions
        .notes_page(&opened.snapshot_id, None, Some(100), NoteFacets::default())
        .expect_err("an unpinned page must refuse even at an unchanged generation");
    let observed = assert_pin_lost(error, &opened.snapshot_id, opened.generation.get());
    assert_eq!(observed, opened.generation.get());
}

/// Exactly the facets that were asked for are present, and every other one is
/// absent — asserted field by field rather than by spot check.
fn assert_row_matches_facets(note: &vault_index::SnapshotNoteRow, facets: NoteFacets) {
    assert_eq!(
        note.metadata.is_some(),
        facets.metadata,
        "metadata presence disagrees with {facets:?}: {note:?}"
    );
    assert_eq!(
        note.references.is_some(),
        facets.references,
        "references presence disagrees with {facets:?}: {note:?}"
    );
    assert_eq!(
        note.resolutions.is_some(),
        facets.resolutions,
        "resolutions presence disagrees with {facets:?}: {note:?}"
    );
    assert_eq!(
        note.backlinks.is_some(),
        facets.backlinks,
        "backlinks presence disagrees with {facets:?}: {note:?}"
    );
    assert_eq!(
        note.sections.is_some(),
        facets.sections,
        "sections presence disagrees with {facets:?}: {note:?}"
    );
    assert_eq!(
        note.list_items.is_some(),
        facets.list_items,
        "list items presence disagrees with {facets:?}: {note:?}"
    );
}

/// Task 15 review finding I-1: every earlier test that asked for
/// `resolutions` also asked for `references`, so serving `references`
/// unconditionally whenever `outgoing` was loaded passed the whole suite. The
/// leak that hides there is the expensive one — `resolutions` exists so a
/// client can have the answers *without* the spans and spellings, and a leak
/// ships exactly the payload it asked not to receive. Each facet is therefore
/// requested alone, and every other facet asserted absent.
#[test]
fn each_facet_requested_alone_carries_itself_and_nothing_else() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("Pointer.md"), "[[Alpha]]\n- [ ] task\n")
        .expect("write Pointer");
    let mut service = fixture.service;
    service.refresh(false).expect("index the pointer");
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");

    let singles = [
        NoteFacets {
            metadata: true,
            ..NoteFacets::default()
        },
        NoteFacets {
            references: true,
            ..NoteFacets::default()
        },
        NoteFacets {
            resolutions: true,
            ..NoteFacets::default()
        },
        NoteFacets {
            backlinks: true,
            ..NoteFacets::default()
        },
        NoteFacets {
            sections: true,
            ..NoteFacets::default()
        },
        NoteFacets {
            list_items: true,
            ..NoteFacets::default()
        },
    ];
    // The pairs that share a query or a loader, where a leak is likeliest.
    let combinations = [
        NoteFacets {
            references: true,
            resolutions: true,
            ..NoteFacets::default()
        },
        NoteFacets {
            metadata: true,
            sections: true,
            ..NoteFacets::default()
        },
        NoteFacets {
            resolutions: true,
            backlinks: true,
            ..NoteFacets::default()
        },
        NoteFacets {
            metadata: true,
            references: true,
            resolutions: true,
            backlinks: true,
            sections: true,
            list_items: true,
        },
    ];

    for facets in singles.into_iter().chain(combinations) {
        let page = sessions
            .notes_page(&opened.snapshot_id, None, Some(100), facets)
            .expect("a notes page");
        assert_eq!(page.notes.len() as u64, opened.note_count);
        for note in &page.notes {
            assert_row_matches_facets(note, facets);
        }
    }
}

/// Task 15 review finding L-1: `load_note_with` routes the stored `task`
/// column through `codec::decode_task`, which admits exactly one character.
/// The page loader must apply the same rule — the DTO promises a
/// one-character string on the wire, and two loaders holding one rule between
/// them is the hazard the parent-column decoding already avoids. Our writer
/// cannot store this row; the refusal is what proves the rule is applied.
#[test]
fn a_stored_task_marker_that_is_not_one_character_is_refused_rather_than_served() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("List.md"), "- [x] done\n").expect("write List");
    let mut service = fixture.service;
    service.refresh(false).expect("index the list");
    drop(service);

    let connection =
        vault_index::open_index_for_test(&fixture.config).expect("open the index for writing");
    let changed = connection
        .execute(
            "UPDATE list_items SET task = 'xy' WHERE note_path = 'List.md'",
            [],
        )
        .expect("corrupt one task marker");
    assert_eq!(changed, 1, "the fixture must have written one list item");
    drop(connection);

    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let error = sessions
        .notes_page(
            &opened.snapshot_id,
            None,
            Some(100),
            NoteFacets {
                list_items: true,
                ..NoteFacets::default()
            },
        )
        .expect_err("a two-character task marker is not a task marker");
    match error {
        IndexError::IncompatibleIndex(message) => assert!(
            message.contains("task"),
            "the refusal must name what it found: {message:?}"
        ),
        other => panic!("expected incompatible_index, got {other:?}"),
    }
}
