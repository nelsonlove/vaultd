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
    /// Lock contention, not damage: another connection or process holds the
    /// write lock. Always retryable, and never evidence that the cache is
    /// corrupt — split out of `Storage` so callers stop having to guess which
    /// storage failures are worth retrying.
    #[error("index storage is busy: {0}")]
    Busy(String),
    /// This process's published live state does not match what the cache has
    /// committed, because a writer it does not own moved the cache. Curable
    /// by `IndexService::resync_published`, and distinct from `Storage` for
    /// exactly that reason: a reader refusing here is behaving correctly, not
    /// reporting damage.
    #[error("published live state is stale: {0}")]
    LiveStateStale(String),
    #[error("storage failure: {0}")]
    Storage(String),
    #[error("delta publication left {0} with a reference row that has no resolution row")]
    IncompleteResolutionCoverage(String),
    /// An index path (or a path it lexically or symlink-resolves through)
    /// sits inside the canonical vault root. The vault is read-only
    /// production input, never a location for derived storage — refused
    /// before anything is created, never repaired after the fact.
    #[error("invalid index path: {0}")]
    InvalidIndexPath(String),
    /// Another process (or another `IndexService` in this one) already holds
    /// the exclusive writer lease for this cache. Never a hang, never
    /// evidence of damage — exactly one writer lease can exist at a time by
    /// construction.
    #[error("index storage is already in use by another writer")]
    IndexInUse,
    /// No session with this identifier is open — it was closed, reclaimed
    /// after its idle timeout, or never issued by this process.
    #[error("no such snapshot session: {0}")]
    SnapshotNotFound(String),
    /// A snapshot session's own read transaction no longer reads the
    /// generation the session is pinned at, so the frames that made every
    /// page's promise true are gone. Refused rather than served: a page whose
    /// pin has ended would carry post-snapshot rows under the pinned
    /// generation number, silently, which is the one failure snapshot
    /// sessions exist to prevent. A client's move is to reopen the snapshot —
    /// which is why this maps to the same wire code a stale cursor gets.
    #[error(
        "snapshot {snapshot} is pinned at generation {pinned} but its transaction reads {observed}"
    )]
    SnapshotPinLost {
        snapshot: String,
        pinned: u64,
        observed: u64,
    },
    /// The daemon already holds its maximum number of open snapshots. Each
    /// one pins WAL frames, so the cap is a resource bound rather than a
    /// policy.
    #[error("at most {limit} snapshot sessions may be open at once")]
    TooManySnapshots { limit: usize },
    /// A mutation was refused by its own preconditions, by path validation,
    /// or by a zone rule. Never damage, and never retryable by this process:
    /// the caller's model of the vault was wrong and should hear so.
    #[error("mutation refused: {0}")]
    Mutation(#[from] crate::mutate::MutationError),
}

impl From<std::io::Error> for IndexError {
    fn from(error: std::io::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

/// Whether a SQLite failure is lock contention rather than damage. The single
/// place that decision is made, so the recovery policy in `schema.rs` and the
/// `?` conversion below can never drift apart on it.
pub(crate) fn is_lock_contention(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _) if matches!(
            failure.code,
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
        )
    )
}

impl From<rusqlite::Error> for IndexError {
    fn from(error: rusqlite::Error) -> Self {
        if is_lock_contention(&error) {
            return Self::Busy(error.to_string());
        }
        Self::Storage(error.to_string())
    }
}

impl From<serde_json::Error> for IndexError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(error.to_string())
    }
}
