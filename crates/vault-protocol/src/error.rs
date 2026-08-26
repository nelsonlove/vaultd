use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_version: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_generation: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
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
}
