mod convert;
pub mod runtime;
pub mod stdio;
pub mod subscriptions;

use std::sync::Arc;
use std::sync::mpsc::{Receiver, sync_channel};

use vault_core::VaultPath;
use vault_index::{IndexConfig, IndexError, IndexReader, LiveState, ReferenceStatus};
use vault_protocol::{
    ErrorCode, PageResponse, ProtocolError, ReferenceStatusFilter, RefreshIndexResponse, Request,
    RequestEnvelope, ResolveLinkResponse, Response, ResponseEnvelope, SeverityDto,
    validate_version,
};

use crate::runtime::{Runtime, RuntimeHandle, RuntimeNotice, RuntimeOptions};
use crate::subscriptions::SubscriptionRegistry;

/// How many runtime notices may be in flight between the coordinator and the
/// dispatcher. The coordinator only ever `try_send`s into this, so the depth
/// bounds how long a dispatcher may be busy before a notice is dropped and
/// replaced by a resync marker — never how long the coordinator waits.
const NOTICE_CAPACITY: usize = 256;

/// One configured vault, served through the live runtime.
///
/// The server never owns an `IndexService`. Every mutation belongs to the
/// runtime's coordinator thread, and every read is answered from the
/// `IndexReader` the runtime publishes into — which is `Send + Sync`, so
/// reads need no coordination at all.
pub struct Server {
    live: Option<Live>,
}

struct Live {
    handle: RuntimeHandle,
    reader: Arc<IndexReader>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServerStartupError {
    #[error(transparent)]
    Index(#[from] IndexError),
    /// A runtime thread could not be spawned. Fatal at startup: a runtime
    /// missing its coordinator would never reconcile anything.
    #[error("failed to start a runtime thread: {0}")]
    Spawn(#[from] std::io::Error),
}

fn index_unavailable() -> ProtocolError {
    ProtocolError {
        code: ErrorCode::IndexUnavailable,
        message: "no vault is configured".into(),
        supported_version: None,
        current_generation: None,
    }
}

/// No runtime exists, so there is nothing to observe. Distinct from
/// `index_unavailable`, which says a generation is missing.
fn runtime_not_ready(message: &str) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::RuntimeNotReady,
        message: message.into(),
        supported_version: None,
        current_generation: None,
    }
}

fn parse_path(value: &str) -> Result<VaultPath, ProtocolError> {
    VaultPath::new(value).map_err(|_| ProtocolError {
        code: ErrorCode::InvalidPath,
        message: format!("invalid vault path: {value:?}"),
        supported_version: None,
        current_generation: None,
    })
}

fn status_filter(value: ReferenceStatusFilter) -> ReferenceStatus {
    match value {
        ReferenceStatusFilter::Resolved => ReferenceStatus::Resolved,
        ReferenceStatusFilter::Unresolved => ReferenceStatus::Unresolved,
        ReferenceStatusFilter::Ambiguous => ReferenceStatus::Ambiguous,
    }
}

fn severity_filter(value: SeverityDto) -> vault_core::Severity {
    match value {
        SeverityDto::Warning => vault_core::Severity::Warning,
        SeverityDto::Error => vault_core::Severity::Error,
    }
}

impl Server {
    /// A server with no vault: `health` succeeds and every indexed operation
    /// refuses. Allocation-light on purpose — no watcher, no lease, no
    /// graph, no timer, and no threads at all.
    pub fn health_only() -> Self {
        Self { live: None }
    }

    /// Serve an already-running runtime. The caller owns the notice
    /// receiver, because only the caller knows whether its transport can
    /// deliver events.
    pub fn for_runtime(handle: RuntimeHandle) -> Self {
        let reader = handle.reader();
        Self {
            live: Some(Live { handle, reader }),
        }
    }

    /// Start the live runtime over `config` and serve it. Returns as soon as
    /// reads are answerable from the last committed generation — the startup
    /// catch-up runs on the coordinator thread behind it.
    pub fn start(
        config: IndexConfig,
        options: RuntimeOptions,
    ) -> Result<(Self, Receiver<RuntimeNotice>), ServerStartupError> {
        let (sink, notices) = sync_channel(NOTICE_CAPACITY);
        let handle = Runtime::start(config, options, sink)?;
        Ok((Self::for_runtime(handle), notices))
    }

    /// The shared reader every read answers from, or `None` in health-only
    /// mode. `IndexReader` is `Send + Sync`, so a caller may query it from
    /// any thread without coordinating with this server.
    pub fn reader(&self) -> Option<Arc<IndexReader>> {
        self.live.as_ref().map(|live| Arc::clone(&live.reader))
    }

    /// Stop the runtime and join every thread it owns. Idempotent, and
    /// implied by dropping the server.
    pub fn shutdown(&self) {
        if let Some(live) = &self.live {
            live.handle.shutdown();
        }
    }

    /// The runtime's observational state, with stopped-ness derived from the
    /// handle as well as the barrier.
    ///
    /// Belt and braces on purpose: a coordinator that panicked never got to
    /// publish `Stopped`, so the barrier can be left reporting `Watching`
    /// forever. The handle knows the threads were joined, so it is the
    /// authority on "stopped" even when the barrier disagrees.
    fn live_state(&self, live: &Live) -> Result<LiveState, IndexError> {
        let published = live.reader.published_status()?.live_state;
        if live.handle.is_stopped() {
            return Ok(LiveState::Stopped);
        }
        Ok(published)
    }

    fn subscribe(
        &self,
        subscriptions: &mut SubscriptionRegistry,
    ) -> Result<Response, ProtocolError> {
        let live = self
            .live
            .as_ref()
            .ok_or_else(|| runtime_not_ready("no vault is configured, so there is no runtime"))?;
        let mut status = live
            .reader
            .published_status()
            .map_err(convert::index_error)?;
        if live.handle.is_stopped() {
            return Err(runtime_not_ready("the runtime has stopped"));
        }
        status.live_state = self.live_state(live).map_err(convert::index_error)?;
        Ok(Response::SubscribeEvents(subscriptions.subscribe(&status)))
    }

    /// Answer one request.
    ///
    /// `subscriptions` is passed in rather than owned because the transport,
    /// not the server, decides whether events can be delivered at all: a
    /// transport that cannot multiplex them simply never activates the
    /// subscriptions it reserves, and nothing is ever queued.
    pub fn handle(
        &self,
        request: RequestEnvelope,
        subscriptions: &mut SubscriptionRegistry,
    ) -> ResponseEnvelope {
        let id = request.id;
        if let Err(error) = validate_version(request.version) {
            return ResponseEnvelope::error(id, error);
        }
        let reader = self.live.as_ref().map(|live| live.reader.as_ref());

        match request.request {
            Request::Health => ResponseEnvelope::success(id, Response::health("vaultd")),
            Request::GetVaultInfo => match (reader, self.live.as_ref()) {
                (Some(reader), Some(live)) => match reader.vault_info() {
                    Ok(info) => {
                        let state = self.live_state(live).ok().map(subscriptions::live_state);
                        ResponseEnvelope::success(
                            id,
                            Response::GetVaultInfo(convert::vault_info(info, state)),
                        )
                    }
                    Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                },
                _ => ResponseEnvelope::error(id, index_unavailable()),
            },
            Request::ListNotes(params) => match reader {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(reader) => match reader.list_notes(params.cursor.as_deref(), params.limit) {
                    Ok(page) => ResponseEnvelope::success(
                        id,
                        Response::ListNotes(PageResponse {
                            generation: page.generation.get(),
                            items: page.items.iter().map(convert::note_summary).collect(),
                            next_cursor: page.next_cursor,
                        }),
                    ),
                    Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                },
            },
            Request::GetNote(params) => match reader {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(reader) => match parse_path(&params.path) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(path) => match reader.get_note(&path) {
                        Ok(indexed) => {
                            let generation = indexed.generation.get();
                            ResponseEnvelope::success(
                                id,
                                Response::GetNote(vault_protocol::GetNoteResponse {
                                    generation,
                                    note: convert::note(indexed),
                                }),
                            )
                        }
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    },
                },
            },
            Request::ResolveLink(params) => match reader {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(reader) => match parse_path(&params.source_path) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(source) => match reader.resolve_link(&source, &params.destination) {
                        Ok((generation, resolution)) => ResponseEnvelope::success(
                            id,
                            Response::ResolveLink(ResolveLinkResponse {
                                generation: generation.get(),
                                resolution: convert::resolution(&resolution),
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    },
                },
            },
            Request::GetBacklinks(params) => match reader {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(reader) => match parse_path(&params.path) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(path) => {
                        match reader.get_backlinks(&path, params.cursor.as_deref(), params.limit) {
                            Ok(page) => ResponseEnvelope::success(
                                id,
                                Response::GetBacklinks(PageResponse {
                                    generation: page.generation.get(),
                                    items: page.items.iter().map(convert::reference).collect(),
                                    next_cursor: page.next_cursor,
                                }),
                            ),
                            Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                        }
                    }
                },
            },
            Request::ListReferences(params) => match reader {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(reader) => {
                    let source = match params.source_path.as_deref().map(parse_path).transpose() {
                        Ok(source) => source,
                        Err(error) => return ResponseEnvelope::error(id, error),
                    };
                    match reader.list_references(
                        source.as_ref(),
                        params.status.map(status_filter),
                        params.cursor.as_deref(),
                        params.limit,
                    ) {
                        Ok(page) => ResponseEnvelope::success(
                            id,
                            Response::ListReferences(PageResponse {
                                generation: page.generation.get(),
                                items: page.items.iter().map(convert::reference).collect(),
                                next_cursor: page.next_cursor,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
            Request::GetDiagnostics(params) => match reader {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(reader) => {
                    let path = match params.path.as_deref().map(parse_path).transpose() {
                        Ok(path) => path,
                        Err(error) => return ResponseEnvelope::error(id, error),
                    };
                    match reader.get_diagnostics(
                        path.as_ref(),
                        params.severity.map(severity_filter),
                        params.cursor.as_deref(),
                        params.limit,
                    ) {
                        Ok(page) => ResponseEnvelope::success(
                            id,
                            Response::GetDiagnostics(PageResponse {
                                generation: page.generation.get(),
                                items: page.items.iter().map(convert::diagnostic).collect(),
                                next_cursor: page.next_cursor,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
            // The one request that mutates. It blocks this request — and
            // only this request — while the coordinator answers it; queued
            // hints are published first, so mailbox order stays mutation
            // order.
            Request::RefreshIndex(params) => match self.live.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(live) => match live.handle.refresh(params.verify) {
                    Ok(report) => ResponseEnvelope::success(
                        id,
                        Response::RefreshIndex(RefreshIndexResponse {
                            previous_generation: report
                                .previous_generation
                                .map(vault_index::Generation::get),
                            generation: report.generation.get(),
                            added: report.added,
                            changed: report.changed,
                            deleted: report.deleted,
                            unchanged: report.unchanged,
                            reparsed: report.reparsed,
                            verified: report.verified,
                        }),
                    ),
                    // The coordinator records its own refresh failures, so
                    // nothing is recorded here — doing it again from a
                    // reader-side thread would race the writer it belongs to.
                    Err(failure) => ResponseEnvelope::error(id, convert::refresh_failure(failure)),
                },
            },
            Request::SubscribeEvents(_) => match self.subscribe(subscriptions) {
                Ok(response) => ResponseEnvelope::success(id, response),
                Err(error) => ResponseEnvelope::error(id, error),
            },
            Request::Unsubscribe(params) => {
                match subscriptions.unsubscribe(&params.subscription_id) {
                    Ok(response) => ResponseEnvelope::success(id, Response::Unsubscribe(response)),
                    Err(error) => ResponseEnvelope::error(id, error),
                }
            }
        }
    }
}
