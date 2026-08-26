use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use fs2::FileExt;

use crate::config::IndexConfig;
use crate::error::IndexError;

/// An exclusive advisory lock on the sibling `.lock` file next to the index
/// database, held for the lifetime of one production `IndexService`.
///
/// Holding it — not merely acquiring and dropping it — is the whole point: a
/// second writer for the same cache must fail immediately, on open, never
/// hang and never corrupt the cache. The lock releases when this value
/// drops (closing the file releases the OS advisory lock), and also on
/// process death, since advisory locks are tied to the open file
/// description rather than to any explicit unlock call.
#[derive(Debug)]
pub struct IndexLease {
    /// Never read after acquisition: held purely so the OS advisory lock
    /// stays taken until this value drops and closes the file descriptor.
    _file: File,
    path: PathBuf,
}

impl IndexLease {
    /// Open (creating if needed) the cache's lease file and take an
    /// exclusive advisory lock on it. Never truncates or deletes the lock
    /// file — its content, if any, is not this type's concern. Contention
    /// maps to `IndexError::IndexInUse`; every other I/O failure is a
    /// storage failure.
    pub fn acquire(config: &IndexConfig) -> Result<Self, IndexError> {
        let path = config.lease_path();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self { _file: file, path }),
            Err(error) if is_lock_contended(&error) => Err(IndexError::IndexInUse),
            Err(error) => Err(IndexError::Storage(error.to_string())),
        }
    }

    /// The lease file's path, for diagnostics.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// `fs2` reports contention with `WouldBlock` on every supported platform,
/// but its own `lock_contended_error` is the authoritative comparison —
/// checking both keeps this correct even where the raw `ErrorKind` alone
/// would be ambiguous (e.g. an `Other`-kind OS error carrying the same
/// underlying errno).
fn is_lock_contended(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || error.kind() == fs2::lock_contended_error().kind()
}
