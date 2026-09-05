use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_version: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_generation: Option<u64>,
    /// The revision the target actually holds, on a `revision_conflict`. The
    /// caller's retry loop needs it, and re-reading the note to discover it
    /// would race the next writer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    IncompatibleVersion,
    InvalidRequest,
    InvalidPath,
    InvalidCursor,
    NoteNotFound,
    IndexUnavailable,
    GenerationMismatch,
    VaultChangedDuringRefresh,
    IncompatibleIndex,
    StorageFailure,
    Internal,
    IndexInUse,
    WatchUnavailable,
    SubscriptionNotFound,
    RuntimeNotReady,
    RuntimeOverloaded,
    RevisionConflict,
    NotFound,
    ParentNotFound,
    TargetExists,
    CaseCollision,
    ZoneViolation,
    PayloadTooLarge,
    ReadOnly,
    SnapshotNotFound,
    TooManySnapshots,
    /// A code this build does not know. Never produced by this server.
    Unknown,
}

impl<'de> Deserialize<'de> for ErrorCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "incompatible_version" => Self::IncompatibleVersion,
            "invalid_request" => Self::InvalidRequest,
            "invalid_path" => Self::InvalidPath,
            "invalid_cursor" => Self::InvalidCursor,
            "note_not_found" => Self::NoteNotFound,
            "index_unavailable" => Self::IndexUnavailable,
            "generation_mismatch" => Self::GenerationMismatch,
            "vault_changed_during_refresh" => Self::VaultChangedDuringRefresh,
            "incompatible_index" => Self::IncompatibleIndex,
            "storage_failure" => Self::StorageFailure,
            "internal" => Self::Internal,
            "index_in_use" => Self::IndexInUse,
            "watch_unavailable" => Self::WatchUnavailable,
            "subscription_not_found" => Self::SubscriptionNotFound,
            "runtime_not_ready" => Self::RuntimeNotReady,
            "runtime_overloaded" => Self::RuntimeOverloaded,
            "revision_conflict" => Self::RevisionConflict,
            "not_found" => Self::NotFound,
            "parent_not_found" => Self::ParentNotFound,
            "target_exists" => Self::TargetExists,
            "case_collision" => Self::CaseCollision,
            "zone_violation" => Self::ZoneViolation,
            "payload_too_large" => Self::PayloadTooLarge,
            "read_only" => Self::ReadOnly,
            "snapshot_not_found" => Self::SnapshotNotFound,
            "too_many_snapshots" => Self::TooManySnapshots,
            _ => Self::Unknown,
        })
    }
}
