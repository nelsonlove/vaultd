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
///
/// Open-ended: a client that meets a status a later `vaultd` introduced must
/// see [`LiveStateDto::Unknown`], never a deserialization failure that takes
/// the whole line — and with it the subscription — down. `Deserialize` is
/// hand-written because `#[serde(other)]` is rejected on an externally
/// tagged enum, which is what a plain unit-variant enum is.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveStateDto {
    Starting,
    CatchingUp,
    Watching,
    PollingFallback,
    Stopped,
    /// A status this build does not know. Never produced by this server.
    Unknown,
}

impl<'de> Deserialize<'de> for LiveStateDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "starting" => Self::Starting,
            "catching_up" => Self::CatchingUp,
            "watching" => Self::Watching,
            "polling_fallback" => Self::PollingFallback,
            "stopped" => Self::Stopped,
            _ => Self::Unknown,
        })
    }
}

/// Why a generation advanced, mirroring `vault_index::live_reconcile::ChangeCause`.
///
/// Only `Watcher` is reachable on the wire through the live runtime today
/// (Task 10/11); the others become reachable through a future
/// `vault-index` API handoff. All five are defined now because the DTO
/// enum must be complete and additive from the start.
///
/// Open-ended for the same reason [`LiveStateDto`] is: `mutation` was added
/// after the first subscribers shipped, and any later cause must degrade
/// rather than fail.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationCauseDto {
    Watcher,
    Startup,
    Periodic,
    Manual,
    Verified,
    /// A cause this build does not know. Never produced by this server.
    Unknown,
}

impl<'de> Deserialize<'de> for GenerationCauseDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "watcher" => Self::Watcher,
            "startup" => Self::Startup,
            "periodic" => Self::Periodic,
            "manual" => Self::Manual,
            "verified" => Self::Verified,
            _ => Self::Unknown,
        })
    }
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
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
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
    /// A reason this build does not know. Never produced by this server.
    Unknown,
}

impl<'de> Deserialize<'de> for ResyncReasonDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "subscriber_lag" => Self::SubscriberLag,
            "oversized_change_set" => Self::OversizedChangeSet,
            "runtime_recovered" => Self::RuntimeRecovered,
            "watcher_overflow" => Self::WatcherOverflow,
            "root_invalidated" => Self::RootInvalidated,
            _ => Self::Unknown,
        })
    }
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
///
/// Open-ended on its own tag: an event kind a later `vaultd` introduces
/// deserializes as [`RuntimeEventDto::Unknown`], with its payload discarded,
/// rather than failing the line.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum RuntimeEventDto {
    GenerationCommitted(GenerationCommittedEventDto),
    RuntimeStateChanged(RuntimeStateChangedEventDto),
    ResyncRequired(ResyncRequiredEventDto),
    /// An event kind this build does not know. Never produced by this server.
    Unknown,
}

/// Hand-written because serde's derive rejects `#[serde(other)]` on an
/// adjacently tagged enum's own tag. The visitor reads exactly the
/// `{"type": …, "value": …}` shape the derived `Serialize` above produces,
/// and turns an unrecognized `type` into [`RuntimeEventDto::Unknown`] after
/// discarding its payload with `IgnoredAny`. A *known* type whose payload is
/// malformed or missing still fails: tolerance is for variants this build has
/// never heard of, not for lines this build should have understood.
impl<'de> Deserialize<'de> for RuntimeEventDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(RuntimeEventVisitor)
    }
}

struct RuntimeEventVisitor;

impl<'de> serde::de::Visitor<'de> for RuntimeEventVisitor {
    type Value = RuntimeEventDto;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a runtime event with a `type` tag and a `value` payload")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        let mut kind: Option<String> = None;
        let mut event: Option<RuntimeEventDto> = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "type" => {
                    if kind.is_some() {
                        return Err(serde::de::Error::duplicate_field("type"));
                    }
                    kind = Some(map.next_value()?);
                }
                "value" => {
                    let Some(named) = kind.as_deref() else {
                        return Err(serde::de::Error::custom(
                            "`value` must follow `type` in a runtime event",
                        ));
                    };
                    event = Some(match named {
                        "generation_committed" => {
                            RuntimeEventDto::GenerationCommitted(map.next_value()?)
                        }
                        "runtime_state_changed" => {
                            RuntimeEventDto::RuntimeStateChanged(map.next_value()?)
                        }
                        "resync_required" => RuntimeEventDto::ResyncRequired(map.next_value()?),
                        _ => {
                            map.next_value::<serde::de::IgnoredAny>()?;
                            RuntimeEventDto::Unknown
                        }
                    });
                }
                _ => {
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        match event {
            Some(event) => Ok(event),
            None => match kind.as_deref() {
                Some("generation_committed" | "runtime_state_changed" | "resync_required") => {
                    Err(serde::de::Error::missing_field("value"))
                }
                Some(_) => Ok(RuntimeEventDto::Unknown),
                None => Err(serde::de::Error::missing_field("type")),
            },
        }
    }
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
