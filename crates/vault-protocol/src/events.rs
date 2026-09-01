//! Protocol v1 live-generation event DTOs.
//!
//! These describe the runtime's observational state and the semantic change
//! one committed generation carries, on the wire, as distinct
//! [`EventEnvelope`] lines multiplexed on stdout alongside
//! [`crate::ResponseEnvelope`] lines. Nothing here knows about
//! `vault-index` or `vault-server` types; a boundary conversion (owned by
//! the server crate) maps runtime notices onto these DTOs.
//!
//! Wire stability: every type in this module is additive to protocol
//! version 1. No existing envelope shape, field, or spelling changes.

use serde::{Deserialize, Serialize};

use crate::envelope::PROTOCOL_VERSION;

/// The runtime's observational status, mirroring `vault_index::LiveState`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveStateDto {
    Starting,
    CatchingUp,
    Watching,
    PollingFallback,
    Stopped,
}

/// Why a generation advanced, mirroring `vault_index::live_reconcile::ChangeCause`.
///
/// Only `Watcher` is reachable on the wire through the live runtime today
/// (Task 10/11); the others become reachable through a future
/// `vault-index` API handoff. All five are defined now because the DTO
/// enum must be complete and additive from the start.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationCauseDto {
    Watcher,
    Startup,
    Periodic,
    Manual,
    Verified,
}

/// The semantic change one committed generation carries. Detailed path
/// lists are used up to the transport's detail limit; larger generations
/// fall back to a counts-only summary followed by a
/// `resync_required { reason: oversized_change_set }` event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChangeSetDto {
    Detailed {
        created: Vec<String>,
        modified: Vec<String>,
        deleted: Vec<String>,
    },
    CountsOnly {
        created: u64,
        modified: u64,
        deleted: u64,
    },
}

/// Why per-path detail is unavailable for a generation move, mirroring
/// `vault_server::runtime::ResyncReason` plus the two dispatcher-only
/// reasons a subscription layer produces on its own (`subscriber_lag`,
/// `oversized_change_set`).
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResyncReasonDto {
    /// A subscriber's bounded event queue fell behind and incremental
    /// events were coalesced. Dispatcher-produced (Task 12).
    SubscriberLag,
    /// A generation's change set exceeded the transport's detail limit and
    /// was reported as counts-only. Dispatcher-produced (Task 12).
    OversizedChangeSet,
    /// The runtime advanced the generation through a path that produces no
    /// per-path change set (startup catch-up, periodic tick, manual
    /// refresh, or a watcher-failure recovery).
    RuntimeRecovered,
    /// The watcher lost events (kernel overflow, storming, or a structural
    /// change it could not name).
    WatcherOverflow,
    /// The vault root itself was removed or renamed.
    RootInvalidated,
}

/// One committed generation's change, addressed to a subscription.
///
/// `changes` spans both axes the cache indexes: a note whose semantic rows
/// moved, and a file or folder whose file-tree row moved. A path here is
/// therefore not necessarily a note, while `affected_note_count` counts notes
/// alone — a generation that moved only the file tree reports zero.
///
/// A folder in `changes.deleted` implies its whole subtree; see
/// `docs/protocol.md` for the rule and for why the two reconciliation routes
/// spell the same deletion at different resolutions.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GenerationCommittedEventDto {
    pub previous_generation: Option<u64>,
    pub generation: u64,
    pub cause: GenerationCauseDto,
    pub changes: ChangeSetDto,
    pub affected_note_count: u64,
    pub affected_reference_count: u64,
}

/// A change in the runtime's observational status.
///
/// `error_code` is reserved for a future typed error code. The runtime's
/// `RuntimeNotice::State.error` today is display-only (`Option<String>`);
/// this field is defined so a typed code can be added later without
/// widening the wire shape again, but it is never populated by Task 11 or
/// Task 12 — it always serializes as absent until the runtime carries a
/// typed code.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeStateChangedEventDto {
    pub generation: Option<u64>,
    pub live_state: LiveStateDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A generation move that no per-path change set describes: an incremental
/// observer must re-read current state rather than apply a delta.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResyncRequiredEventDto {
    pub current_generation: Option<u64>,
    pub reason: ResyncReasonDto,
}

/// One event delivered to a subscription.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum RuntimeEventDto {
    GenerationCommitted(GenerationCommittedEventDto),
    RuntimeStateChanged(RuntimeStateChangedEventDto),
    ResyncRequired(ResyncRequiredEventDto),
}

/// The stdio transport's second top-level envelope shape, distinct from
/// [`crate::ResponseEnvelope`]: no `id`, no `outcome`. Events are
/// unsolicited, ordered per subscription, and never interleave with
/// response envelopes at the byte level.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EventEnvelope {
    pub version: u16,
    pub subscription_id: String,
    pub event: RuntimeEventDto,
}

impl EventEnvelope {
    pub fn new(subscription_id: impl Into<String>, event: RuntimeEventDto) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            subscription_id: subscription_id.into(),
            event,
        }
    }
}
