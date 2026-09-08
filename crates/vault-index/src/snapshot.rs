//! Snapshot sessions: a pinned, generation-stable view a client pages
//! through with ordinary request/response calls.
//!
//! Each session owns its own query-only SQLite connection and holds one
//! long-lived deferred read transaction on it. Under WAL the writer proceeds
//! the whole time; the pinned reader sees its generation forever.
//!
//! The transaction is driven with explicit `BEGIN DEFERRED`/`ROLLBACK`
//! statements rather than a `rusqlite::Transaction`, because a `Transaction`
//! borrows its `Connection` and a struct cannot hold both. `BEGIN DEFERRED`
//! does not take the snapshot until its first read, so one generation query
//! runs immediately after it — that read is what actually pins the frames.
//!
//! **Everything a session serves comes out of that one transaction**, tree as
//! well as semantics: the schema-v3 pre-task stores a `tree_entries` row for
//! every folder, note, and non-Markdown file, so a session is coherent at one
//! generation from end to end. Nothing here walks the filesystem, hashes a
//! file, or observes anything outside the transaction — a session that did
//! would be exactly as stale as whatever moment it happened to look.

use std::collections::BTreeMap;
use std::time::Instant;

use rusqlite::Connection;

use crate::config::IndexConfig;
use crate::error::IndexError;
use crate::model::Generation;

/// What one tree entry is, mirroring `tree_entries.kind`.
///
/// Re-exported from `vault_core` rather than declared again here: the stored
/// `kind` column is written from that enum (`codec::encode_tree_entry_kind`)
/// and read back through `codec::decode_tree_entry_kind`, so a second enum
/// with the same three variants would be a copy that could only ever drift
/// from the one the schema's `CHECK` constraint actually admits.
pub use vault_core::TreeEntryKind;

/// What `open` established.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenSnapshot {
    pub snapshot_id: String,
    pub generation: Generation,
    pub note_count: u64,
    pub entry_count: u64,
}

pub(crate) struct Session {
    pub(crate) connection: Connection,
    pub(crate) generation: Generation,
    pub(crate) last_used: Instant,
}

impl Drop for Session {
    /// Release the pinned transaction even on an unwind. A session dropped
    /// without this would hold WAL frames for the life of the process.
    fn drop(&mut self) {
        let _ = self.connection.execute_batch("ROLLBACK");
    }
}

/// Every open snapshot session this process holds.
pub struct SnapshotSessions {
    config: IndexConfig,
    next_id: u64,
    sessions: BTreeMap<String, Session>,
}

impl SnapshotSessions {
    pub fn new(config: &IndexConfig) -> Self {
        Self {
            config: config.clone(),
            next_id: 0,
            sessions: BTreeMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// Open a session pinned at the current generation.
    pub fn open(&mut self) -> Result<OpenSnapshot, IndexError> {
        self.reap(Instant::now());
        if self.sessions.len() >= self.config.max_concurrent_snapshots {
            return Err(IndexError::TooManySnapshots {
                limit: self.config.max_concurrent_snapshots,
            });
        }

        let connection = crate::schema::open_reader(&self.config)?;
        connection.execute_batch("BEGIN DEFERRED")?;
        // The first read is what takes the snapshot. Everything after this
        // statement sees exactly these frames, however far the writer moves.
        let (generation, note_count, entry_count) = pinned_counts(&connection)?;

        self.next_id += 1;
        let snapshot_id = format!("snap-{}", self.next_id);
        self.sessions.insert(
            snapshot_id.clone(),
            Session {
                connection,
                generation,
                last_used: Instant::now(),
            },
        );
        Ok(OpenSnapshot {
            snapshot_id,
            generation,
            note_count,
            entry_count,
        })
    }

    /// The generation `id` is pinned at, refreshing its idle deadline.
    pub fn generation_of(&mut self, id: &str) -> Result<Generation, IndexError> {
        Ok(self.session(id)?.generation)
    }

    /// What the session's own pinned transaction says the committed
    /// generation and note count are *now*.
    ///
    /// The pin is the whole claim of this module, and the bookkeeping fields
    /// above cannot evidence it: they would keep answering correctly on a
    /// session whose transaction had silently ended. Tests read through the
    /// connection instead, after the writer has committed further
    /// generations onto the same database.
    #[doc(hidden)]
    pub fn pinned_state_for_test(&mut self, id: &str) -> Result<(Generation, u64), IndexError> {
        let session = self.session(id)?;
        let (generation, note_count, _) = pinned_counts(&session.connection)?;
        Ok((generation, note_count))
    }

    /// Borrow one live session, refreshing its idle deadline. Every paging
    /// call goes through here, which is what makes "idle" mean "no page for
    /// this long" rather than "open for this long".
    pub(crate) fn session(&mut self, id: &str) -> Result<&mut Session, IndexError> {
        self.reap(Instant::now());
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| IndexError::SnapshotNotFound(id.to_string()))?;
        session.last_used = Instant::now();
        Ok(session)
    }

    pub fn close(&mut self, id: &str) -> Result<(), IndexError> {
        match self.sessions.remove(id) {
            // Dropping the session rolls its transaction back.
            Some(_) => Ok(()),
            None => Err(IndexError::SnapshotNotFound(id.to_string())),
        }
    }

    /// Release every session. The daemon is single-peer today, so a client
    /// disconnect (stdio end of file) releases everything — designed for
    /// here rather than discovered later.
    pub fn close_all(&mut self) {
        self.sessions.clear();
    }

    /// Drop every session whose last page is older than the idle timeout.
    fn reap(&mut self, now: Instant) {
        let timeout = self.config.snapshot_idle_timeout;
        self.sessions
            .retain(|_, session| now.duration_since(session.last_used) < timeout);
    }

    /// The page size a request gets: the configured default when it asks for
    /// none, and its own ask clamped to the configured maximum otherwise.
    ///
    /// Unused until Tasks 14 and 15 page out of these sessions; it belongs
    /// with the two `IndexConfig` fields it reads rather than with either
    /// pager, since both must answer the same way.
    #[allow(dead_code)]
    pub(crate) fn page_size(&self, requested: Option<u32>) -> u32 {
        match requested {
            None => self.config.snapshot_page_size,
            Some(requested) => requested.clamp(1, self.config.max_snapshot_page_size),
        }
    }
}

/// The generation, note count, and tree entry count one connection currently
/// reads — inside whatever transaction it already holds.
///
/// The tree count comes from the same pinned transaction as the note count,
/// so the number a client is told up front is the number it will actually
/// page out. `tree_entries` holds folders, notes, and non-Markdown files
/// alike, so it is always at least the note count.
fn pinned_counts(connection: &Connection) -> Result<(Generation, u64, u64), IndexError> {
    let stored: Option<i64> = connection.query_row(
        "SELECT generation FROM index_metadata WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    let Some(stored) = stored else {
        // Nothing committed: there is no snapshot to pin. Only `open` can
        // reach this — a session that exists pinned a committed generation —
        // and its connection has not been handed to a `Session` yet, so
        // closing it here is what ends the transaction.
        return Err(IndexError::IndexUnavailable);
    };
    let generation = Generation::from_db(stored)?;
    let note_count = count(connection, "SELECT COUNT(*) FROM notes", "note count")?;
    let entry_count = count(
        connection,
        "SELECT COUNT(*) FROM tree_entries",
        "tree entry count",
    )?;
    Ok((generation, note_count, entry_count))
}

fn count(connection: &Connection, sql: &str, what: &str) -> Result<u64, IndexError> {
    let counted: i64 = connection.query_row(sql, [], |row| row.get(0))?;
    u64::try_from(counted).map_err(|_| IndexError::IncompatibleIndex(format!("negative {what}")))
}
