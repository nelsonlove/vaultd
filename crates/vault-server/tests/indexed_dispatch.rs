//! Every request variant, dispatched against a configured server.
//!
//! The server owns a `RuntimeHandle` and an `IndexReader`, never an
//! `IndexService`: reads answer from the published generation on the calling
//! thread, and the one mutating request is handed to the coordinator.

use std::fs;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use tempfile::tempdir;
use vault_index::{IndexConfig, LiveState};
use vault_protocol::{
    GetDiagnosticsParams, GetNoteResponse, GetTreeEntriesParams, ListReferencesParams,
    LiveStateDto, NotePathParams, PageParams, PathPageParams, ReferenceStatusFilter, Request,
    RequestEnvelope, ResolveLinkParams, Response, ResponseEnvelope, ResponseOutcome, SeverityDto,
};
use vault_server::Server;
use vault_server::broadcast::ConnectionId;
use vault_server::runtime::{Runtime, RuntimeNotice, RuntimeOptions, RuntimeTestHooks};
use vault_server::subscriptions::SubscriptionRegistry;

/// A runtime that neither watches nor ticks: every generation in these tests
/// is one the test itself asked for.
fn quiet_options() -> RuntimeOptions {
    RuntimeOptions {
        watch: false,
        reconcile_interval: None,
        ..RuntimeOptions::default()
    }
}

struct Fixture {
    server: Server,
    _notices: Receiver<RuntimeNotice>,
    subscriptions: SubscriptionRegistry,
}

impl Fixture {
    fn handle(&mut self, envelope: RequestEnvelope) -> ResponseEnvelope {
        self.server
            .handle(ConnectionId::STANDALONE, envelope, &mut self.subscriptions)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.shutdown();
    }
}

/// Start a server over a fresh vault and wait for the cold build, so every
/// assertion below names a generation that already exists.
fn start(notes: &[(&str, &str)]) -> Fixture {
    let vault = tempdir().expect("vault");
    let index = tempdir().expect("index");
    for (name, body) in notes {
        fs::write(vault.path().join(name), body).expect("write note");
    }
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let (server, notices) = Server::start(config, quiet_options()).expect("start server");
    // The temp dirs must outlive the runtime: leak them for the test's life.
    std::mem::forget(vault);
    std::mem::forget(index);

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = server
            .reader()
            .expect("a configured server has a reader")
            .published_status()
            .expect("published status");
        if status.generation.is_some() && status.live_state == LiveState::PollingFallback {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for the cold build"
        );
        std::thread::sleep(Duration::from_millis(5));
    }

    Fixture {
        server,
        _notices: notices,
        subscriptions: SubscriptionRegistry::new(),
    }
}

fn configured_server() -> Fixture {
    start(&[
        ("Note.md", "# Note\n[[Other]]\n"),
        ("Other.md", "# Other\n"),
    ])
}

#[test]
fn configured_server_dispatches_indexed_reads_and_refresh() {
    let mut fixture = start(&[("Note.md", "# Note\n")]);

    let response = fixture.handle(RequestEnvelope::new(
        "note-1",
        Request::GetNote(NotePathParams {
            path: "Note.md".into(),
            include: Vec::new(),
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
    let server = Server::health_only();
    let mut subscriptions = SubscriptionRegistry::new();
    let response = server.handle(
        ConnectionId::STANDALONE,
        RequestEnvelope::new(
            "note-2",
            Request::GetNote(NotePathParams {
                path: "Note.md".into(),
                include: Vec::new(),
            }),
        ),
        &mut subscriptions,
    );
    assert!(matches!(
        response.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::IndexUnavailable
    ));

    // `get_tree_entries` takes the same arm, and this is the one branch of it
    // `tests/tree_entries.rs` cannot reach: that suite always has a vault. A
    // read with no index behind it answers `index_unavailable` rather than an
    // empty answer, because "nothing is there" and "I cannot tell you" are
    // different statements and only one of them is safe to act on.
    let response = server.handle(
        ConnectionId::STANDALONE,
        RequestEnvelope::new(
            "tree-2",
            Request::GetTreeEntries(GetTreeEntriesParams {
                paths: vec!["Note.md".into()],
            }),
        ),
        &mut subscriptions,
    );
    assert!(matches!(
        response.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::IndexUnavailable
    ));
}

#[test]
fn every_remaining_request_variant_dispatches() {
    let mut fixture = configured_server();

    let health = fixture.handle(RequestEnvelope::new("d-health", Request::Health));
    assert!(matches!(
        health.outcome,
        ResponseOutcome::Ok(Response::Health(_))
    ));

    let info = fixture.handle(RequestEnvelope::new("d-info", Request::GetVaultInfo));
    match info.outcome {
        ResponseOutcome::Ok(Response::GetVaultInfo(info)) => {
            assert_eq!(info.generation, 1);
            assert_eq!(info.note_count, 2);
            assert_eq!(
                info.live_state,
                Some(LiveStateDto::PollingFallback),
                "a configured server reports the runtime's own state"
            );
        }
        other => panic!("unexpected vault info: {other:?}"),
    }

    let list = fixture.handle(RequestEnvelope::new(
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

    let resolve = fixture.handle(RequestEnvelope::new(
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

    let backlinks = fixture.handle(RequestEnvelope::new(
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

    let references = fixture.handle(RequestEnvelope::new(
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

    let diagnostics = fixture.handle(RequestEnvelope::new(
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

    let refresh = fixture.handle(RequestEnvelope::new(
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

    let subscribe = fixture.handle(RequestEnvelope::new(
        "d-subscribe",
        Request::SubscribeEvents(vault_protocol::SubscribeEventsParams {}),
    ));
    let id = match subscribe.outcome {
        ResponseOutcome::Ok(Response::SubscribeEvents(subscribed)) => {
            assert_eq!(subscribed.generation, Some(1));
            assert_eq!(subscribed.live_state, LiveStateDto::PollingFallback);
            subscribed.subscription_id
        }
        other => panic!("unexpected subscribe: {other:?}"),
    };

    let unsubscribe = fixture.handle(RequestEnvelope::new(
        "d-unsubscribe",
        Request::Unsubscribe(vault_protocol::UnsubscribeParams {
            subscription_id: id.clone(),
        }),
    ));
    match unsubscribe.outcome {
        ResponseOutcome::Ok(Response::Unsubscribe(released)) => {
            assert_eq!(released.subscription_id, id);
        }
        other => panic!("unexpected unsubscribe: {other:?}"),
    }
}

#[test]
fn invalid_paths_and_missing_notes_map_to_stable_errors() {
    let mut fixture = configured_server();

    let invalid = fixture.handle(RequestEnvelope::new(
        "d-invalid",
        Request::GetNote(NotePathParams {
            path: "../escape.md".into(),
            include: Vec::new(),
        }),
    ));
    assert!(matches!(
        invalid.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::InvalidPath
    ));

    let missing = fixture.handle(RequestEnvelope::new(
        "d-missing",
        Request::GetNote(NotePathParams {
            path: "Nope.md".into(),
            include: Vec::new(),
        }),
    ));
    assert!(matches!(
        missing.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::NoteNotFound
    ));
}

/// A stopped runtime refuses the requests that need it, with codes that say
/// which kind of unavailability this is.
#[test]
fn a_stopped_runtime_reports_runtime_not_ready() {
    let mut fixture = configured_server();
    fixture.server.shutdown();

    let refresh = fixture.handle(RequestEnvelope::new(
        "d-refresh-stopped",
        Request::RefreshIndex(vault_protocol::RefreshIndexParams { verify: false }),
    ));
    assert!(matches!(
        refresh.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::RuntimeNotReady
    ));

    let subscribe = fixture.handle(RequestEnvelope::new(
        "d-subscribe-stopped",
        Request::SubscribeEvents(vault_protocol::SubscribeEventsParams {}),
    ));
    assert!(matches!(
        subscribe.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::RuntimeNotReady
    ));

    // Reads keep answering from the last published generation, and the state
    // they report is the runtime's real one — the barrier's own `Stopped`,
    // corroborated by the joined handle.
    let info = fixture.handle(RequestEnvelope::new(
        "d-info-stopped",
        Request::GetVaultInfo,
    ));
    match info.outcome {
        ResponseOutcome::Ok(Response::GetVaultInfo(info)) => {
            assert_eq!(info.live_state, Some(LiveStateDto::Stopped));
        }
        other => panic!("unexpected vault info: {other:?}"),
    }
}

/// A coordinator that panics never reaches `publish_state(Stopped)`, so the
/// publication barrier is left asserting whatever it last published —
/// `catching_up` or `watching` — forever. Reads are still answerable from the
/// last committed generation, and must stay answerable, but the runtime's
/// *state* must not keep claiming to be live: a client would subscribe
/// successfully to a stream that can never produce anything.
///
/// This is the case the defence-in-depth residual named: stopped-ness is
/// derived from the runtime handle as well as the barrier.
#[test]
fn a_panicked_coordinator_is_reported_as_stopped() {
    let vault = tempdir().expect("vault");
    let index = tempdir().expect("index");
    fs::write(vault.path().join("Note.md"), "# Note\n").expect("write note");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    // Generation 1 exists before the runtime opens, so reads stay answerable
    // after the panic and there is something for the barrier to be stale
    // about.
    {
        let mut service = vault_index::IndexService::open(config.clone()).expect("open service");
        service.refresh(false).expect("cold build");
    }

    let (sink, notices) = std::sync::mpsc::sync_channel(64);
    let handle = Runtime::start_with_hooks(
        config,
        quiet_options(),
        sink,
        RuntimeTestHooks {
            // Sequence 0 is the startup catch-up. Panicking there unwinds the
            // coordinator out of `run` without it ever publishing `Stopped`.
            mutation_fault: Some(std::sync::Arc::new(|sequence| {
                assert_ne!(sequence, 0, "injected coordinator panic");
                None
            })),
            ..RuntimeTestHooks::default()
        },
    )
    .expect("start runtime");
    std::mem::forget(vault);
    std::mem::forget(index);

    let deadline = Instant::now() + Duration::from_secs(10);
    while !handle.is_stopped() {
        assert!(
            Instant::now() < deadline,
            "a panicked coordinator must be visible as stopped"
        );
        std::thread::sleep(Duration::from_millis(5));
    }

    // The barrier itself is stale, which is exactly why the handle has to be
    // consulted too.
    let published = handle
        .reader()
        .published_status()
        .expect("the barrier is not poisoned by the panic");
    assert_ne!(
        published.live_state,
        LiveState::Stopped,
        "this test is only meaningful while the barrier is stale"
    );

    let mut fixture = Fixture {
        server: Server::for_runtime(handle),
        _notices: notices,
        subscriptions: SubscriptionRegistry::new(),
    };

    let info = fixture.handle(RequestEnvelope::new("panic-info", Request::GetVaultInfo));
    match info.outcome {
        ResponseOutcome::Ok(Response::GetVaultInfo(info)) => {
            assert_eq!(info.generation, 1, "reads stay answerable");
            assert_eq!(
                info.live_state,
                Some(LiveStateDto::Stopped),
                "a dead coordinator must never be reported as live"
            );
        }
        other => panic!("unexpected vault info: {other:?}"),
    }

    let subscribe = fixture.handle(RequestEnvelope::new(
        "panic-subscribe",
        Request::SubscribeEvents(vault_protocol::SubscribeEventsParams {}),
    ));
    assert!(
        matches!(
            subscribe.outcome,
            ResponseOutcome::Err(ref error)
                if error.code == vault_protocol::ErrorCode::RuntimeNotReady
        ),
        "subscribing to a stream that can never produce anything must be refused"
    );
}
