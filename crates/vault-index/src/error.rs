#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("invalid vault root: {0}")]
    InvalidVaultRoot(String),
    #[error("invalid vault path: {0}")]
    InvalidPath(String),
    #[error("index is unavailable")]
    IndexUnavailable,
    #[error("note not found: {0}")]
    NoteNotFound(String),
    #[error("invalid cursor: {0}")]
    InvalidCursor(String),
    #[error("cursor generation {cursor} does not match current generation {current}")]
    GenerationMismatch { cursor: u64, current: u64 },
    #[error("vault changed during refresh")]
    VaultChangedDuringRefresh,
    #[error("incompatible index: {0}")]
    IncompatibleIndex(String),
    #[error("storage failure: {0}")]
    Storage(String),
}

impl From<std::io::Error> for IndexError {
    fn from(error: std::io::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<rusqlite::Error> for IndexError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<serde_json::Error> for IndexError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(error.to_string())
    }
}
