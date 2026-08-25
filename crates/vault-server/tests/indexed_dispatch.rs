use std::fs;

use tempfile::tempdir;
use vault_index::{IndexConfig, IndexService};
use vault_protocol::{
    GetDiagnosticsParams, GetNoteResponse, ListReferencesParams, NotePathParams, PageParams,
    PathPageParams, ReferenceStatusFilter, Request, RequestEnvelope, ResolveLinkParams, Response,
    ResponseOutcome, SeverityDto,
};
use vault_server::Server;

fn configured_server() -> Server {
    let vault = tempdir().expect("vault");
    let index = tempdir().expect("index");
    fs::write(vault.path().join("Note.md"), "# Note\n[[Other]]\n").expect("write note");
    fs::write(vault.path().join("Other.md"), "# Other\n").expect("write other");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    // The temp dirs must outlive the server: leak them for the test's lifetime.
    std::mem::forget(vault);
    std::mem::forget(index);
    Server::for_index(service)
}

#[test]
fn configured_server_dispatches_indexed_reads_and_refresh() {
    let vault = tempdir().expect("vault");
    let index = tempdir().expect("index");
    fs::write(vault.path().join("Note.md"), "# Note\n").expect("write note");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let mut server = Server::for_index(service);

    let response = server.handle(RequestEnvelope::new(
        "note-1",
        Request::GetNote(NotePathParams {
            path: "Note.md".into(),
        }),
    ));

    match response.outcome {
        ResponseOutcome::Ok(Response::GetNote(GetNoteResponse { generation, note })) => {
            assert_eq!(generation, 1);
            assert_eq!(note.source, "# Note\n");
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

#[test]
fn health_only_server_keeps_health_and_refuses_indexed_reads() {
    let mut server = Server::health_only();
    let response = server.handle(RequestEnvelope::new(
        "note-2",
        Request::GetNote(NotePathParams {
            path: "Note.md".into(),
        }),
    ));
    assert!(matches!(
        response.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::IndexUnavailable
    ));
}

#[test]
fn every_remaining_request_variant_dispatches() {
    let mut server = configured_server();

    let health = server.handle(RequestEnvelope::new("d-health", Request::Health));
    assert!(matches!(
        health.outcome,
        ResponseOutcome::Ok(Response::Health(_))
    ));

    let info = server.handle(RequestEnvelope::new("d-info", Request::GetVaultInfo));
    match info.outcome {
        ResponseOutcome::Ok(Response::GetVaultInfo(info)) => {
            assert_eq!(info.generation, 1);
            assert_eq!(info.note_count, 2);
        }
        other => panic!("unexpected vault info: {other:?}"),
    }

    let list = server.handle(RequestEnvelope::new(
        "d-list",
        Request::ListNotes(PageParams {
            cursor: None,
            limit: Some(10),
        }),
    ));
    match list.outcome {
        ResponseOutcome::Ok(Response::ListNotes(page)) => {
            assert_eq!(page.items.len(), 2);
            assert_eq!(page.items[0].path, "Note.md");
        }
        other => panic!("unexpected list: {other:?}"),
    }

    let resolve = server.handle(RequestEnvelope::new(
        "d-resolve",
        Request::ResolveLink(ResolveLinkParams {
            source_path: "Note.md".into(),
            destination: "Other".into(),
        }),
    ));
    match resolve.outcome {
        ResponseOutcome::Ok(Response::ResolveLink(resolved)) => {
            assert!(matches!(
                resolved.resolution,
                vault_protocol::ResolutionDto::Resolved { ref target, .. }
                    if target == "Other.md"
            ));
        }
        other => panic!("unexpected resolve: {other:?}"),
    }

    let backlinks = server.handle(RequestEnvelope::new(
        "d-backlinks",
        Request::GetBacklinks(PathPageParams {
            path: "Other.md".into(),
            cursor: None,
            limit: Some(10),
        }),
    ));
    match backlinks.outcome {
        ResponseOutcome::Ok(Response::GetBacklinks(page)) => {
            assert_eq!(page.items.len(), 1);
            assert_eq!(page.items[0].source_path, "Note.md");
        }
        other => panic!("unexpected backlinks: {other:?}"),
    }

    let references = server.handle(RequestEnvelope::new(
        "d-references",
        Request::ListReferences(ListReferencesParams {
            source_path: None,
            status: Some(ReferenceStatusFilter::Resolved),
            cursor: None,
            limit: Some(10),
        }),
    ));
    match references.outcome {
        ResponseOutcome::Ok(Response::ListReferences(page)) => {
            assert_eq!(page.items.len(), 1);
        }
        other => panic!("unexpected references: {other:?}"),
    }

    let diagnostics = server.handle(RequestEnvelope::new(
        "d-diagnostics",
        Request::GetDiagnostics(GetDiagnosticsParams {
            path: None,
            severity: Some(SeverityDto::Warning),
            cursor: None,
            limit: Some(10),
        }),
    ));
    assert!(matches!(
        diagnostics.outcome,
        ResponseOutcome::Ok(Response::GetDiagnostics(_))
    ));

    let refresh = server.handle(RequestEnvelope::new(
        "d-refresh",
        Request::RefreshIndex(vault_protocol::RefreshIndexParams { verify: true }),
    ));
    match refresh.outcome {
        ResponseOutcome::Ok(Response::RefreshIndex(report)) => {
            assert_eq!(report.generation, 1);
            assert!(report.verified);
        }
        other => panic!("unexpected refresh: {other:?}"),
    }
}

#[test]
fn invalid_paths_and_missing_notes_map_to_stable_errors() {
    let mut server = configured_server();

    let invalid = server.handle(RequestEnvelope::new(
        "d-invalid",
        Request::GetNote(NotePathParams {
            path: "../escape.md".into(),
        }),
    ));
    assert!(matches!(
        invalid.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::InvalidPath
    ));

    let missing = server.handle(RequestEnvelope::new(
        "d-missing",
        Request::GetNote(NotePathParams {
            path: "Nope.md".into(),
        }),
    ));
    assert!(matches!(
        missing.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::NoteNotFound
    ));
}
