//! The snapshot `metadata` facet's diagnostics must be the same union
//! `get_note` reports for the same note at the same generation. Both read
//! through `note_diagnostics` (`crates/vault-index/src/query/diagnostics.rs`),
//! which unions `note_diagnostics`, `resolution_diagnostics`, and
//! `scan_diagnostics` — a wikilink to a note that does not exist stores an
//! `unresolved_reference` row in `resolution_diagnostics` only, so a facet
//! read that misses that table silently drops it while `get_note` still
//! reports it. A client that hydrates from snapshots and refreshes single
//! notes via `get_note` must never see two different answers for one note.

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{Response, ResponseOutcome};

fn daemon(vault: &TempDir, index: &TempDir) -> Daemon {
    Daemon::for_vault(vault, index)
}

#[test]
fn the_metadata_facets_diagnostics_equal_get_notes() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    // X.md references a note that is never created, so the graph carries an
    // `unresolved_reference` diagnostic against X.md in `resolution_diagnostics`
    // — a table `note_diagnostics` alone does not cover.
    std::fs::write(vault.path().join("X.md"), "# X\n[[Y]]\n").expect("write X");

    let mut daemon = daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let get_note = daemon
        .call(r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"X.md"}}}"#);
    let (get_note_generation, get_note_diagnostics) = match get_note.outcome {
        ResponseOutcome::Ok(Response::GetNote(response)) => {
            (response.generation, response.note.diagnostics)
        }
        other => panic!("get_note failed: {other:?}"),
    };
    assert!(
        !get_note_diagnostics.is_empty(),
        "X.md references a note that does not exist, so get_note must carry \
         at least the unresolved_reference diagnostic"
    );
    assert!(
        get_note_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "unresolved_reference"),
        "get_note's diagnostics must include unresolved_reference: {get_note_diagnostics:?}"
    );

    let opened =
        daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot_id = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(response)) => response.snapshot_id,
        other => panic!("open_snapshot failed: {other:?}"),
    };

    let notes = daemon.call(&format!(
        r#"{{"version":1,"id":"n","request":{{"method":"snapshot_notes","params":{{"snapshot_id":"{snapshot_id}","include":["metadata"]}}}}}}"#
    ));
    match notes.outcome {
        ResponseOutcome::Ok(Response::SnapshotNotes(response)) => {
            assert_eq!(
                response.generation, get_note_generation,
                "the snapshot must be pinned to the same generation get_note answered from"
            );
            let x = response
                .notes
                .iter()
                .find(|note| note.path == "X.md")
                .expect("X.md is in the page");
            let metadata = x.metadata.as_ref().expect("metadata was requested");
            assert_eq!(
                metadata.diagnostics, get_note_diagnostics,
                "the metadata facet's diagnostics must equal get_note's diagnostics, \
                 element for element — a snapshot-only reader must not miss the \
                 unresolved_reference diagnostic get_note reports"
            );
        }
        other => panic!("snapshot_notes failed: {other:?}"),
    }

    daemon.call(&format!(
        r#"{{"version":1,"id":"c","request":{{"method":"close_snapshot","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
}
