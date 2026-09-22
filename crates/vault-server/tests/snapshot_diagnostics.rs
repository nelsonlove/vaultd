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

/// The single-diagnostic case above cannot distinguish a union from a
/// replacement: `get_note` and the snapshot facet could each read only
/// `resolution_diagnostics` and still agree, because that table alone holds
/// every diagnostic the note has. This case carries a `note_diagnostics` row
/// too — `malformed_block_id`, from a `^bad` marker with trailing prose on
/// its line, which `resolution_diagnostics` never stores — alongside the
/// same unresolved `[[Missing]]` wikilink. If the snapshot facet's query
/// were narrowed to `resolution_diagnostics` only (a "replacement" read
/// rather than the union `get_note` uses), this note would still produce a
/// non-empty diagnostics list — `unresolved_reference` alone — so the
/// emptiness check the first case relies on would not catch the regression;
/// only comparing against `get_note`'s full two-element list does, since
/// `malformed_block_id` would then be missing from the snapshot side and the
/// `assert_eq!` below would fail on length and content, not just presence.
///
/// The wikilink sits on an earlier line than the block marker, so the two
/// diagnostics' `span_start` values are strictly ordered and the union's
/// `ORDER BY (path, span_start, span_end, code, message, owner_kind,
/// owner_id)` (`crates/vault-index/src/query/diagnostics.rs`) puts
/// `unresolved_reference` first deterministically — pinning ordering, not
/// just set membership.
#[test]
fn the_metadata_facet_unions_a_note_local_diagnostic_with_a_resolution_diagnostic() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(
        vault.path().join("X.md"),
        "# X\n[[Missing]]\npara ^bad extra\n",
    )
    .expect("write X");

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
    assert_eq!(
        get_note_diagnostics.len(),
        2,
        "one note-local diagnostic (malformed_block_id) plus one resolution \
         diagnostic (unresolved_reference): {get_note_diagnostics:?}"
    );
    assert_eq!(
        get_note_diagnostics[0].code, "unresolved_reference",
        "the wikilink's span starts before the block marker's, so the union \
         orders it first: {get_note_diagnostics:?}"
    );
    assert_eq!(
        get_note_diagnostics[1].code, "malformed_block_id",
        "{get_note_diagnostics:?}"
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
                "the metadata facet must carry both the note-local \
                 malformed_block_id diagnostic and the resolution \
                 unresolved_reference diagnostic, in the same order \
                 get_note reports them — a union, not a replacement of one \
                 table by the other: {:?}",
                metadata.diagnostics
            );
        }
        other => panic!("snapshot_notes failed: {other:?}"),
    }

    daemon.call(&format!(
        r#"{{"version":1,"id":"c","request":{{"method":"close_snapshot","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
}
