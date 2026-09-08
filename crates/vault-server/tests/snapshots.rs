//! Snapshot sessions over the real transport, including the one path a unit
//! test cannot reach: a client that disconnects without closing.

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{ErrorCode, Response, ResponseOutcome, TreeEntryKindDto};

fn daemon(vault: &TempDir, index: &TempDir) -> Daemon {
    Daemon::for_vault(vault, index)
}

#[test]
fn a_client_pages_a_snapshot_and_closes_it() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(vault.path().join("Two.md"), "# Two\n").expect("write Two");

    let mut daemon = daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let opened =
        daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot_id = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(response)) => {
            assert_eq!(response.note_count, 2);
            response.snapshot_id
        }
        other => panic!("open_snapshot failed: {other:?}"),
    };

    let page = daemon.call(&format!(
        r#"{{"version":1,"id":"t","request":{{"method":"snapshot_tree","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    match page.outcome {
        ResponseOutcome::Ok(Response::SnapshotTree(response)) => {
            assert_eq!(response.entries.len(), 2);
            assert_eq!(response.next_cursor, None);
            assert!(
                response
                    .entries
                    .iter()
                    .all(|entry| entry.kind == TreeEntryKindDto::Note),
                "two notes and nothing else: {:?}",
                response.entries
            );
            assert!(
                response.entries.iter().all(|entry| entry.mtime_unix_ms > 0),
                "every entry carries the stat a host mirrors: {:?}",
                response.entries
            );
        }
        other => panic!("snapshot_tree failed: {other:?}"),
    }

    let closed = daemon.call(&format!(
        r#"{{"version":1,"id":"c","request":{{"method":"close_snapshot","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    assert!(matches!(closed.outcome, ResponseOutcome::Ok(_)));

    let again = daemon.call(&format!(
        r#"{{"version":1,"id":"c2","request":{{"method":"close_snapshot","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    match again.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::SnapshotNotFound),
        other => panic!("a second close must be refused: {other:?}"),
    }
}

/// Paging a snapshot that no longer exists is the same refusal a second close
/// gets, and it is the one a host will actually meet: a session reclaimed for
/// idleness disappears underneath a client that comes back to it.
#[test]
fn paging_a_snapshot_that_was_never_opened_is_refused_by_id() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");

    let mut daemon = daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let page = daemon.call(
        r#"{"version":1,"id":"t","request":{"method":"snapshot_tree","params":{"snapshot_id":"snap-404"}}}"#,
    );
    match page.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::SnapshotNotFound),
        other => panic!("an unknown snapshot id must be refused: {other:?}"),
    }
}

/// Health-only mode has no vault, so it has no registry to answer from. The
/// refusal must say `index_unavailable` — "there is nothing to snapshot" —
/// rather than `snapshot_not_found`, which would tell a client its id was
/// wrong.
#[test]
fn a_health_only_daemon_refuses_a_snapshot_as_unavailable_not_as_missing() {
    let mut daemon = Daemon::start(&[]);
    let opened =
        daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    match opened.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::IndexUnavailable),
        other => panic!("a health-only daemon has no snapshots to open: {other:?}"),
    }
    // The arm a paging host actually hits, and the one that used to go
    // unexercised: a page request must refuse the same way its open did.
    let page = daemon.call(
        r#"{"version":1,"id":"t","request":{"method":"snapshot_tree","params":{"snapshot_id":"snap-1"}}}"#,
    );
    match page.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::IndexUnavailable),
        other => panic!("a health-only daemon has no snapshot to page: {other:?}"),
    }
    let notes = daemon.call(
        r#"{"version":1,"id":"n","request":{"method":"snapshot_notes","params":{"snapshot_id":"snap-1"}}}"#,
    );
    match notes.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::IndexUnavailable),
        other => panic!("a health-only daemon has no semantics to page: {other:?}"),
    }
    let closed = daemon.call(
        r#"{"version":1,"id":"c","request":{"method":"close_snapshot","params":{"snapshot_id":"snap-1"}}}"#,
    );
    match closed.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::IndexUnavailable),
        other => panic!("a health-only daemon has no snapshots to close: {other:?}"),
    }
}

#[test]
fn a_client_that_disconnects_with_a_snapshot_open_does_not_wedge_the_daemon() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");

    let mut daemon = daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);

    // No close. The daemon is single-peer, so end of file is the disconnect.
    let status = daemon.disconnect();
    assert!(
        status.success(),
        "an open snapshot must not keep the daemon alive: {status:?}"
    );
}

/// The whole point of the session, end to end over the transport: one open,
/// one tree page, one notes page carrying every facet, one close — and no
/// per-note request anywhere.
#[test]
fn a_host_hydrates_the_whole_vault_from_one_session() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join("Folder")).expect("create Folder");
    // Ruling B1: a reference is a `[[wikilink]]`. The brief's bare `Two` is
    // prose and would leave both the reference and the backlink below at zero.
    std::fs::write(
        vault.path().join("One.md"),
        "---\ntitle: One\n---\n# One\n[[Folder/Two]]\n\n- [ ] a task\n",
    )
    .expect("write One");
    std::fs::write(vault.path().join("Folder/Two.md"), "# Two\n").expect("write Two");
    std::fs::write(vault.path().join("Folder/image.png"), [1u8, 2, 3])
        .expect("write an attachment");

    let mut daemon = daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let opened =
        daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot_id = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(response)) => response.snapshot_id,
        other => panic!("open_snapshot failed: {other:?}"),
    };

    // The tree half and the semantic half come out of one session, at one
    // generation, in one client's hands — which is the claim the whole
    // subsystem exists to make.
    let tree = daemon.call(&format!(
        r#"{{"version":1,"id":"t","request":{{"method":"snapshot_tree","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    let tree_generation = match tree.outcome {
        ResponseOutcome::Ok(Response::SnapshotTree(response)) => {
            assert_eq!(
                response
                    .entries
                    .iter()
                    .map(|entry| entry.path.as_str())
                    .collect::<Vec<_>>(),
                vec!["Folder", "Folder/Two.md", "Folder/image.png", "One.md"],
                "folders and attachments page with the notes"
            );
            response.generation
        }
        other => panic!("snapshot_tree failed: {other:?}"),
    };

    let notes = daemon.call(&format!(
        r#"{{"version":1,"id":"n","request":{{"method":"snapshot_notes","params":{{"snapshot_id":"{snapshot_id}","include":["metadata","references","resolutions","backlinks","sections","list_items"]}}}}}}"#
    ));
    match notes.outcome {
        ResponseOutcome::Ok(Response::SnapshotNotes(response)) => {
            assert_eq!(
                response.generation, tree_generation,
                "one session, one generation for tree and semantics alike"
            );
            assert_eq!(response.notes.len(), 2);
            let one = response
                .notes
                .iter()
                .find(|note| note.path == "One.md")
                .expect("One is in the page");
            let metadata = one.metadata.as_ref().expect("metadata was requested");
            assert_eq!(metadata.properties.len(), 1);
            assert_eq!(
                one.references
                    .as_ref()
                    .expect("references were requested")
                    .len(),
                1
            );
            assert_eq!(
                one.resolutions
                    .as_ref()
                    .expect("resolutions were requested")
                    .len(),
                1
            );
            assert!(
                one.sections.is_some(),
                "sections is an ordinary top-level facet, a sibling of metadata"
            );
            assert!(one.list_items.is_some());
            assert!(
                one.sections
                    .as_ref()
                    .expect("sections were requested")
                    .iter()
                    .any(|section| section.kind == "yaml"),
                "the frontmatter block is the first section, which is what tasknotes reads"
            );
            let items = one.list_items.as_ref().expect("list items were requested");
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].task.as_deref(), Some(" "));
            assert!(
                items[0].list_start_line.is_some() && items[0].parent_start_line.is_none(),
                "a top-level item names its list's start line and nothing else: {items:?}"
            );

            let two = response
                .notes
                .iter()
                .find(|note| note.path == "Folder/Two.md")
                .expect("Two is in the page");
            assert_eq!(
                two.backlinks
                    .as_ref()
                    .expect("backlinks were requested")
                    .len(),
                1
            );
        }
        other => panic!("snapshot_notes failed: {other:?}"),
    }

    daemon.call(&format!(
        r#"{{"version":1,"id":"c","request":{{"method":"close_snapshot","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
}

/// The default an `include`-less request gets, stated at the wire: a page of
/// identities. Every facet is **absent** rather than an empty array, so a
/// client can tell "you asked for none" from "this note has none" — and a
/// facet name this build does not know is `invalid_request` rather than a
/// silently facet-less page, which is the resolution of the Task 3 deferral.
#[test]
fn an_include_less_page_carries_identities_and_a_misspelled_facet_is_refused() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");

    let mut daemon = daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let opened =
        daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot_id = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(response)) => response.snapshot_id,
        other => panic!("open_snapshot failed: {other:?}"),
    };

    let notes = daemon.call(&format!(
        r#"{{"version":1,"id":"n","request":{{"method":"snapshot_notes","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    match notes.outcome {
        ResponseOutcome::Ok(Response::SnapshotNotes(response)) => {
            assert_eq!(response.notes.len(), 1);
            let one = &response.notes[0];
            assert_eq!(one.path, "One.md");
            assert!(!one.revision.is_empty());
            assert!(
                one.metadata.is_none()
                    && one.references.is_none()
                    && one.resolutions.is_none()
                    && one.backlinks.is_none()
                    && one.sections.is_none()
                    && one.list_items.is_none(),
                "no facet was asked for, so none is served: {one:?}"
            );
        }
        other => panic!("snapshot_notes failed: {other:?}"),
    }

    let misspelled = daemon.call(&format!(
        r#"{{"version":1,"id":"m","request":{{"method":"snapshot_notes","params":{{"snapshot_id":"{snapshot_id}","include":["metdata"]}}}}}}"#
    ));
    match misspelled.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::InvalidRequest),
        other => panic!("a facet this build does not know must be refused: {other:?}"),
    }

    daemon.call(&format!(
        r#"{{"version":1,"id":"c","request":{{"method":"close_snapshot","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
}
