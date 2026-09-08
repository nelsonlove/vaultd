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
