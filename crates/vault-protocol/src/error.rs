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
    /// Where in the query a `query_invalid` or `unsupported_operator` refusal
    /// found the problem, counted in Unicode scalar values (not UTF-16 code
    /// units, so a JavaScript string index differs after any astral character).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<u64>,
}

impl ProtocolError {
    /// An error with `code` and `message` and every optional field absent.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            supported_version: None,
            current_generation: None,
            current_revision: None,
            position: None,
        }
    }
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
    /// The base exists but its YAML does not parse; the message carries the
    /// position.
    BaseInvalid,
    /// The base declares no view of that name; the message names the views
    /// it does declare.
    ViewNotFound,
    /// A filter the view reads does not parse. A formula or a summary that
    /// does not parse is an error cell instead, not this code.
    ExpressionInvalid,
    /// A filter the view reads calls a function or method this evaluator
    /// does not implement. In a formula or a summary it is an error cell.
    UnsupportedFunction,
    /// The search query does not parse; the error carries `position`
    /// (Unicode scalar values). A regular expression is refused as
    /// `UnsupportedOperator` in this build, not here.
    QueryInvalid,
    /// The search query uses an operator this build does not support; the
    /// message names it, and the error carries `position` (Unicode scalar
    /// values).
    UnsupportedOperator,
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
            "base_invalid" => Self::BaseInvalid,
            "view_not_found" => Self::ViewNotFound,
            "expression_invalid" => Self::ExpressionInvalid,
            "unsupported_function" => Self::UnsupportedFunction,
            "query_invalid" => Self::QueryInvalid,
            "unsupported_operator" => Self::UnsupportedOperator,
            _ => Self::Unknown,
        })
    }
}
