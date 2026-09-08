mod convert;
pub mod runtime;
pub mod stdio;
pub mod subscriptions;

use std::sync::Arc;
use std::sync::mpsc::{Receiver, sync_channel};

use vault_core::VaultPath;
use vault_index::{IndexConfig, IndexError, IndexReader, LiveState, ReferenceStatus};
use vault_protocol::{
    CloseSnapshotResponse, ErrorCode, GenerationResponse, MutationResponse, OpenSnapshotResponse,
    PageResponse, ProtocolError, ReadFileResponse, ReferenceStatusFilter, RefreshIndexResponse,
    RenameResponse, Request, RequestEnvelope, ResolveLinkResponse, Response, ResponseEnvelope,
    SeverityDto, SnapshotNotesResponse, SnapshotTreeResponse, WriteFileResponse, validate_version,
};

use crate::runtime::{MutationReport, Runtime, RuntimeHandle, RuntimeNotice, RuntimeOptions};
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
    /// Snapshot sessions, behind a mutex so reads answer from the dispatcher
    /// thread without ever touching the coordinator. `rusqlite::Connection`
    /// is `Send` but not `Sync`, which is exactly what a `Mutex` is for.
    ///
    /// `None` in health-only mode. A registry needs an `IndexConfig` to open
    /// reader connections against, and health-only has no vault and therefore
    /// no config — so the absence is modelled rather than faked with an empty
    /// registry that would answer `snapshot_not_found` where it should answer
    /// `index_unavailable`.
    snapshots: Option<std::sync::Mutex<vault_index::SnapshotSessions>>,
    /// The engine `read_file` answers from, or `None` in health-only mode.
    ///
    /// A raw read touches no index state, takes no lock, and publishes
    /// nothing, so routing it through the coordinator would queue a pure
    /// filesystem read behind whatever write is in flight for no benefit. The
    /// engine is `Clone` and holds only the canonical root, so this is a
    /// second handle on the same rules rather than a second writer — and it is
    /// never used to mutate: every write still goes through
    /// [`Server::mutate`].
    engine: Option<vault_index::MutationEngine>,
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

/// Report a *contained* parse panic as the warning it is, and every other
/// panic exactly as before.
///
/// `vault-core` catches the upstream markdown parser's unwind and degrades the
/// note to a diagnostic, so the daemon survives a body that panics
/// `markdown 1.0.0`. What it cannot do from inside the `catch_unwind` is stop
/// the panic *hook*, which the runtime already ran on the way out: the default
/// hook prints `thread … panicked at …` and invites a backtrace. An operator
/// reading `vaultd`'s stderr then sees a crash report for a daemon that is
/// still serving — the containment works and the logs say it did not.
///
/// So the hook consults [`vault_core::in_contained_markdown_parse`], which is
/// true only while that one call is on the panicking thread's stack, and
/// prints one warning line instead. **Every other panic reaches the previous
/// hook untouched**: a hook that swallowed panics generally would hide the
/// next real defect, which is a far worse trade than a confusing line.
///
/// Installed by the daemon at startup. Idempotent in effect but not in cost —
/// calling it twice chains two hooks — so `main` calls it once.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if vault_core::in_contained_markdown_parse() {
            eprintln!(
                "vaultd: warning: the markdown parser panicked on a note body and was contained; \
                 that note's frontmatter is indexed, its body semantics are not, and the note \
                 carries a markdown_parse_error diagnostic. The daemon is unaffected."
            );
            return;
        }
        previous(info);
    }));
}

fn index_unavailable() -> ProtocolError {
    ProtocolError {
        code: ErrorCode::IndexUnavailable,
        message: "no vault is configured".into(),
        supported_version: None,
        current_generation: None,
        current_revision: None,
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
        current_revision: None,
    }
}

fn parse_path(value: &str) -> Result<VaultPath, ProtocolError> {
    VaultPath::new(value).map_err(|_| ProtocolError {
        code: ErrorCode::InvalidPath,
        message: format!("invalid vault path: {value:?}"),
        supported_version: None,
        current_generation: None,
        current_revision: None,
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
        Self {
            live: None,
            snapshots: None,
            engine: None,
        }
    }

    /// Serve an already-running runtime. The caller owns the notice
    /// receiver, because only the caller knows whether its transport can
    /// deliver events.
    pub fn for_runtime(handle: RuntimeHandle) -> Self {
        let reader = handle.reader();
        let config = handle.config();
        let snapshots = std::sync::Mutex::new(vault_index::SnapshotSessions::new(&config));
        // The same canonical root the runtime's own engine was built from, so
        // a raw read resolves and contains a path exactly as a write does.
        let engine = vault_index::MutationEngine::new(&config.canonical_vault_root);
        Self {
            live: Some(Live { handle, reader }),
            snapshots: Some(snapshots),
            engine: Some(engine),
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
        // Sessions first: each one pins WAL frames until its transaction is
        // rolled back, and a disconnect is what reaches this on the ordinary
        // path — the daemon is single-peer, so end of input means every
        // session that client held is abandoned.
        if let Some(sessions) = self.snapshots.as_ref() {
            sessions
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .close_all();
        }
        if let Some(live) = &self.live {
            live.handle.shutdown();
        }
    }

    /// Reclaim snapshot sessions that have gone idle.
    ///
    /// Called by the transport on **every input it takes** — requests and
    /// runtime notices alike. The registry otherwise only reaps inside a call
    /// about a session, so a client that opens one and then stops asking
    /// would pin WAL frames for the life of the connection: opening was a
    /// request, and after it the client can stay alive on the notice path
    /// indefinitely. Sweeping on both arms bounds residency to one idle
    /// timeout after the last *input*, with no thread and no timer.
    ///
    /// Crate-visible: the transport is the only caller, and a sweep is not
    /// something a client can ask for.
    pub(crate) fn sweep_snapshots(&self) {
        if let Some(sessions) = self.snapshots.as_ref() {
            sessions
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .sweep();
        }
    }

    /// How many sessions are live, without reaping first.
    ///
    /// Test-only, and the only honest instrument for the sweep: every entry
    /// point a client can reach (`open`, any page, `close`) reaps before it
    /// answers, so no response distinguishes a swept registry from an unswept
    /// one. `SnapshotSessions::len` deliberately does not reap either, which
    /// is what lets a test assert the "not yet" half as well as the "now".
    #[cfg(test)]
    pub(crate) fn snapshot_session_count(&self) -> usize {
        self.snapshots.as_ref().map_or(0, |sessions| {
            sessions
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len()
        })
    }

    /// The runtime's observational state, with stopped-ness derived from the
    /// handle as well as the barrier.
    ///
    /// Belt and braces on purpose. The barrier records what the coordinator
    /// last *said*; the handle records whether it is still there to say
    /// anything. They disagree exactly when the coordinator stopped without
    /// announcing it — a panic unwinds it out of `run` before it can publish
    /// `Stopped`, leaving the barrier asserting `Watching` for the life of
    /// the process. `RuntimeHandle::is_stopped` covers that through a drop
    /// guard on the coordinator thread, so it is the authority here.
    fn live_state(&self, live: &Live) -> Result<LiveState, IndexError> {
        let published = live.reader.published_status()?.live_state;
        if live.handle.is_stopped() {
            return Ok(LiveState::Stopped);
        }
        Ok(published)
    }

    /// Send one mutation to the coordinator and wait for it to be published.
    /// Every mutation arm below shares this, so "reconcile before you answer"
    /// is one decision rather than ten.
    fn mutate(&self, mutation: vault_index::Mutation) -> Result<MutationReport, ProtocolError> {
        let live = self
            .live
            .as_ref()
            .ok_or_else(|| runtime_not_ready("no vault is configured, so there is no runtime"))?;
        live.handle
            .mutate(mutation)
            .map_err(convert::mutation_failure)
    }

    /// Read raw bytes out of the vault, off the coordinator thread.
    ///
    /// A read is not a mutation: it takes no lease, publishes nothing, and
    /// cannot fail a precondition, so it needs neither the coordinator's
    /// serialization nor a generation to be true at. What it does need is the
    /// engine's containment — `resolve` refuses a NUL, a traversal, and a
    /// symlink out of the vault — which is why it goes through the engine
    /// rather than through `std::fs` here.
    fn read_file(&self, path: &VaultPath) -> Result<(Vec<u8>, String), ProtocolError> {
        let engine = self
            .engine
            .as_ref()
            .ok_or_else(|| runtime_not_ready("no vault is configured"))?;
        engine.read_file(path).map_err(convert::mutation_error)
    }

    /// The generation a mutation response reports. `None` means nothing has
    /// ever been committed, which a client cannot act on — every mutation
    /// that reaches a running runtime has a generation, so this is a
    /// last-resort refusal rather than a shape a caller must handle.
    fn mutation_generation(report: &MutationReport) -> Result<u64, ProtocolError> {
        report
            .generation
            .map(vault_index::Generation::get)
            .ok_or_else(index_unavailable)
    }

    /// The revision a `MutationResponse` reports. Every operation answering
    /// with that shape wrote bytes, so the engine always has a revision for
    /// it, and a missing one is an engine invariant violation rather than a
    /// state a client should be handed.
    ///
    /// It refuses rather than defaulting because `MutationResponse.revision`
    /// is a bare `String`: `unwrap_or_default` would put `""` on the wire,
    /// which is a *well-formed* revision as far as the schema is concerned
    /// and which a client would then compare-and-swap against. That is the
    /// same empty-string spelling checkpoint-1 ruled out for
    /// `RenameResponse` — a thing with no revision reports no revision. Here
    /// there is no key to omit, so the honest answer is to fail. The message
    /// is deliberately contentless: an invariant violation tells a client
    /// nothing it can act on, and internals stay off the wire.
    fn mutation_revision(report: &MutationReport) -> Result<String, ProtocolError> {
        report.revision.clone().ok_or_else(|| ProtocolError {
            code: ErrorCode::Internal,
            message: "the mutation reported no content revision".into(),
            supported_version: None,
            current_generation: None,
            current_revision: None,
        })
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
            Request::WriteNote(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match convert::precondition(params.expected.as_ref()) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(expected) => match self.mutate(vault_index::Mutation::WriteNote {
                        path,
                        content: params.content,
                        expected,
                    }) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(report) => match (
                            Self::mutation_generation(&report),
                            Self::mutation_revision(&report),
                        ) {
                            (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                            (Ok(generation), Ok(revision)) => ResponseEnvelope::success(
                                id,
                                Response::WriteNote(MutationResponse {
                                    generation,
                                    revision,
                                }),
                            ),
                        },
                    },
                },
            },
            Request::CreateFolder(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match self.mutate(vault_index::Mutation::CreateFolder { path }) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(report) => match Self::mutation_generation(&report) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(generation) => ResponseEnvelope::success(
                            id,
                            Response::CreateFolder(GenerationResponse { generation }),
                        ),
                    },
                },
            },
            Request::RenameNote(params) => {
                match (parse_path(&params.from), parse_path(&params.to)) {
                    (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                    (Ok(from), Ok(to)) => match convert::precondition(params.expected.as_ref()) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(expected) => match self.mutate(vault_index::Mutation::RenameNote {
                            from,
                            to,
                            expected,
                            rewrite_links: params.rewrite_links,
                        }) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(report) => match Self::mutation_generation(&report) {
                                Err(error) => ResponseEnvelope::error(id, error),
                                Ok(generation) => ResponseEnvelope::success(
                                    id,
                                    Response::RenameNote(RenameResponse {
                                        generation,
                                        revision: report.revision,
                                        links_rewritten: report.links_rewritten,
                                        link_rewrite_failures: convert::link_rewrite_failures(
                                            report.link_rewrite_failures,
                                        ),
                                    }),
                                ),
                            },
                        },
                    },
                }
            }
            Request::RenameFolder(params) => {
                match (parse_path(&params.from), parse_path(&params.to)) {
                    (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                    (Ok(from), Ok(to)) => match self.mutate(vault_index::Mutation::RenameFolder {
                        from,
                        to,
                        rewrite_links: params.rewrite_links,
                    }) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(report) => match Self::mutation_generation(&report) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            // A folder has no bytes to hash, so the engine
                            // reports no revision and the key is omitted
                            // outright rather than sent as an empty string.
                            Ok(generation) => ResponseEnvelope::success(
                                id,
                                Response::RenameFolder(RenameResponse {
                                    generation,
                                    revision: report.revision,
                                    links_rewritten: report.links_rewritten,
                                    link_rewrite_failures: convert::link_rewrite_failures(
                                        report.link_rewrite_failures,
                                    ),
                                }),
                            ),
                        },
                    },
                }
            }
            Request::CopyFile(params) => match (parse_path(&params.from), parse_path(&params.to)) {
                (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                (Ok(from), Ok(to)) => {
                    match convert::precondition(params.expected_source.as_ref()) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(expected_source) => match self.mutate(vault_index::Mutation::CopyFile {
                            from,
                            to,
                            expected_source,
                            if_exists: convert::copy_conflict(params.if_exists),
                        }) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(report) => match (
                                Self::mutation_generation(&report),
                                Self::mutation_revision(&report),
                            ) {
                                (Err(error), _) | (_, Err(error)) => {
                                    ResponseEnvelope::error(id, error)
                                }
                                (Ok(generation), Ok(revision)) => ResponseEnvelope::success(
                                    id,
                                    Response::CopyFile(MutationResponse {
                                        generation,
                                        revision,
                                    }),
                                ),
                            },
                        },
                    }
                }
            },
            Request::DeleteNote(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match convert::precondition(params.expected.as_ref()) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(expected) => match self.mutate(vault_index::Mutation::DeleteNote {
                        path,
                        mode: params.mode.map(convert::delete_mode),
                        expected,
                    }) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(report) => match Self::mutation_generation(&report) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(generation) => ResponseEnvelope::success(
                                id,
                                Response::DeleteNote(GenerationResponse { generation }),
                            ),
                        },
                    },
                },
            },
            Request::DeleteFolder(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match self.mutate(vault_index::Mutation::DeleteFolder {
                    path,
                    mode: params.mode.map(convert::delete_mode),
                    recursive: params.recursive,
                }) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(report) => match Self::mutation_generation(&report) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(generation) => ResponseEnvelope::success(
                            id,
                            Response::DeleteFolder(GenerationResponse { generation }),
                        ),
                    },
                },
            },
            Request::PatchFrontmatter(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match (
                    convert::precondition(params.expected.as_ref()),
                    convert::frontmatter_edits(&params.patch),
                ) {
                    (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                    (Ok(expected), Ok(patch)) => {
                        match self.mutate(vault_index::Mutation::PatchFrontmatter {
                            path,
                            patch,
                            expected,
                        }) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(report) => match (
                                Self::mutation_generation(&report),
                                Self::mutation_revision(&report),
                            ) {
                                (Err(error), _) | (_, Err(error)) => {
                                    ResponseEnvelope::error(id, error)
                                }
                                (Ok(generation), Ok(revision)) => ResponseEnvelope::success(
                                    id,
                                    Response::PatchFrontmatter(MutationResponse {
                                        generation,
                                        revision,
                                    }),
                                ),
                            },
                        }
                    }
                },
            },
            Request::WriteFile(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match (
                    convert::precondition(params.expected.as_ref()),
                    convert::decode_base64(&params.content_base64),
                ) {
                    (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                    (Ok(expected), Ok(content)) => {
                        // The wire's `semantic` answers "is this path inside
                        // the indexed universe", which is a question about the
                        // path — *not* `MutationOutcome::semantic`, which
                        // answers "did indexed rows move" and is always
                        // `false` for a raw write. The indexed universe is
                        // what the scan lists, so a hidden path is outside it
                        // exactly as the configuration zone is. Computed
                        // before `path` is moved into the mutation.
                        let indexed = !vault_index::is_unindexable(&path);
                        match self.mutate(vault_index::Mutation::WriteFile {
                            path,
                            content,
                            expected,
                        }) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            // `mutation_revision` rather than a default: this
                            // response's `revision` is a bare `String`, and
                            // `""` would reach a client as a well-formed
                            // revision it could then compare-and-swap against.
                            // A raw write always has one, so this is an
                            // invariant guard, not a shape a caller meets.
                            Ok(report) => match Self::mutation_revision(&report) {
                                Err(error) => ResponseEnvelope::error(id, error),
                                Ok(revision) => ResponseEnvelope::success(
                                    id,
                                    Response::WriteFile(WriteFileResponse {
                                        // Absent for a write the index does
                                        // not track: no generation contains
                                        // it, and claiming one would be a lie
                                        // a client could act on. For an
                                        // attachment it is the generation the
                                        // write itself published — the file
                                        // tree moved, so the client can read
                                        // its own write back.
                                        generation: indexed
                                            .then(|| {
                                                report.generation.map(vault_index::Generation::get)
                                            })
                                            .flatten(),
                                        revision,
                                        semantic: indexed,
                                    }),
                                ),
                            },
                        }
                    }
                },
            },
            Request::ReadFile(params) => match (self.reader(), parse_path(&params.path)) {
                (None, _) => ResponseEnvelope::error(id, index_unavailable()),
                (_, Err(error)) => ResponseEnvelope::error(id, error),
                (Some(_), Ok(path)) => match self.read_file(&path) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok((bytes, revision)) => ResponseEnvelope::success(
                        id,
                        Response::ReadFile(ReadFileResponse {
                            content_base64: convert::encode_base64(&bytes),
                            revision,
                        }),
                    ),
                },
            },
            Request::OpenSnapshot(_) => match self.snapshots.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(sessions) => {
                    let mut sessions = sessions.lock().unwrap_or_else(|error| error.into_inner());
                    match sessions.open() {
                        Ok(opened) => ResponseEnvelope::success(
                            id,
                            Response::OpenSnapshot(OpenSnapshotResponse {
                                snapshot_id: opened.snapshot_id,
                                generation: opened.generation.get(),
                                note_count: opened.note_count,
                                entry_count: opened.entry_count,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
            Request::SnapshotTree(params) => match self.snapshots.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(sessions) => {
                    let mut sessions = sessions.lock().unwrap_or_else(|error| error.into_inner());
                    match sessions.tree_page(
                        &params.snapshot_id,
                        params.cursor.as_deref(),
                        params.limit,
                    ) {
                        Ok(page) => ResponseEnvelope::success(
                            id,
                            Response::SnapshotTree(SnapshotTreeResponse {
                                snapshot_id: params.snapshot_id,
                                generation: page.generation.get(),
                                entries: page.entries.iter().map(convert::tree_entry).collect(),
                                next_cursor: page.next_cursor,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
            Request::CloseSnapshot(params) => match self.snapshots.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(sessions) => {
                    let mut sessions = sessions.lock().unwrap_or_else(|error| error.into_inner());
                    match sessions.close(&params.snapshot_id) {
                        Ok(()) => ResponseEnvelope::success(
                            id,
                            Response::CloseSnapshot(CloseSnapshotResponse {
                                snapshot_id: params.snapshot_id,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
            Request::SnapshotNotes(params) => match self.snapshots.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(sessions) => {
                    let mut sessions = sessions.lock().unwrap_or_else(|error| error.into_inner());
                    match sessions.notes_page(
                        &params.snapshot_id,
                        params.cursor.as_deref(),
                        params.limit,
                        convert::note_facets(&params.include),
                    ) {
                        Ok(page) => ResponseEnvelope::success(
                            id,
                            Response::SnapshotNotes(SnapshotNotesResponse {
                                snapshot_id: params.snapshot_id,
                                generation: page.generation.get(),
                                notes: page.notes.iter().map(convert::snapshot_note).collect(),
                                next_cursor: page.next_cursor,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(revision: Option<&str>) -> MutationReport {
        MutationReport {
            generation: None,
            revision: revision.map(str::to_string),
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic: true,
        }
    }

    /// Reachable only by doctoring the report, because every engine operation
    /// that answers with a `MutationResponse` sets a revision — which is
    /// exactly why the guard is worth having: the invariant is enforced here
    /// rather than assumed here and stated somewhere else. A fabricated `""`
    /// would be worse than an error, because `""` is a well-formed revision
    /// on the wire and a client would compare-and-swap against it.
    #[test]
    fn a_content_mutation_with_no_revision_is_an_internal_error_not_an_empty_string() {
        let error = Server::mutation_revision(&report(None))
            .expect_err("a missing content revision must never be defaulted");
        assert_eq!(error.code, ErrorCode::Internal);
        assert!(
            !error.message.is_empty() && error.current_revision.is_none(),
            "the refusal says nothing a client could act on, and leaks nothing: {error:?}"
        );
    }

    #[test]
    fn a_content_mutation_reports_the_revision_it_wrote() {
        assert_eq!(
            Server::mutation_revision(&report(Some("blake3:abc"))).expect("a revision is present"),
            "blake3:abc"
        );
    }
}
