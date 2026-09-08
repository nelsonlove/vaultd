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
//!
//! **A session takes no publication barrier, deliberately.** Every other read
//! path acquires the barrier before touching its connection (see the lock
//! order note in `reconcile.rs`); a session reads SQLite directly, so it may
//! observe a committed generation a hair before that generation's live-graph
//! install finishes. That is benign and intended: the SQL commit *is* the
//! authoritative publish — rows and the `index_metadata` generation bump land
//! in one transaction — and a session serves nothing but SQL rows, never the
//! live graph. Taking no lock is also strictly safer for the deadlock
//! argument, since a session can never be holding one when the writer wants
//! it.

use std::collections::BTreeMap;
use std::time::Instant;

use rusqlite::Connection;

use crate::config::IndexConfig;
use crate::cursor::{CursorPosition, decode_cursor, encode_cursor};
use crate::error::IndexError;
use crate::model::Generation;
use vault_core::VaultPath;

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

    /// Reclaim every session that has gone idle, without being asked for
    /// anything else.
    ///
    /// `reap` otherwise runs only inside a call *about* a session, so a
    /// client that opens one and then goes quiet holds its WAL frames for as
    /// long as it stays connected. The dispatcher calls this on every request
    /// it takes — of any kind — which bounds residency to one idle timeout
    /// after the last request rather than after the last snapshot call. No
    /// thread and no timer: the sweep rides on traffic that is already
    /// happening.
    pub fn sweep(&mut self) {
        self.reap(Instant::now());
    }

    /// Drop every session whose last page is older than the idle timeout.
    fn reap(&mut self, now: Instant) {
        let timeout = self.config.snapshot_idle_timeout;
        self.sessions
            .retain(|_, session| now.duration_since(session.last_used) < timeout);
    }

    /// The page size a request gets: the configured default when it asks for
    /// none, and its own ask otherwise — both bounded by the configured
    /// maximum, and neither ever zero.
    ///
    /// It belongs with the two `IndexConfig` fields it reads rather than with
    /// either pager, since `snapshot_tree` and `snapshot_notes` must answer
    /// the same way.
    ///
    /// The ceiling is `max(1)`'d before it is used because both fields are
    /// `pub` and nothing validates them: `Ord::clamp` panics when its low
    /// bound exceeds its high one, so a `max_snapshot_page_size` of 0 would
    /// abort the daemon on the next page rather than refuse a request. The
    /// default is bounded by the same ceiling, so a configuration whose
    /// default exceeds its own maximum cannot serve a page larger than the
    /// maximum it advertises.
    pub(crate) fn page_size(&self, requested: Option<u32>) -> u32 {
        let ceiling = self.config.max_snapshot_page_size.max(1);
        requested
            .unwrap_or(self.config.snapshot_page_size)
            .clamp(1, ceiling)
    }
}

/// One tree entry as a page reports it, straight out of `tree_entries`.
///
/// `ctime_unix_ms` and `mtime_unix_ms` are the pre-task's stored timestamps —
/// birthtime where the platform has one, mtime where it does not — and are
/// what a host serves `TFile.stat = { ctime, mtime, size }` from. Reading them
/// from the row rather than from disk is what keeps a page answerable at the
/// pinned generation.
///
/// `revision` is present for a note and absent for everything else. A folder
/// has no bytes; an attachment has bytes the index stores no revision for
/// (`tree_entries.content_revision` is written NULL for every kind — the
/// column is reserved for a future consumer that hashes them), so only the
/// join onto `notes` ever produces one.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreeEntryRow {
    pub path: VaultPath,
    pub kind: TreeEntryKind,
    pub size: Option<u64>,
    pub ctime_unix_ms: i64,
    pub mtime_unix_ms: i64,
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreePage {
    pub generation: Generation,
    pub entries: Vec<TreeEntryRow>,
    pub next_cursor: Option<String>,
}

impl SnapshotSessions {
    /// One page of the vault tree, in path order, at the session's pinned
    /// generation.
    ///
    /// One keyset query over `tree_entries`, which already holds every
    /// folder, note, and non-Markdown file. The only join is onto `notes`,
    /// and only for a revision: a note carries its revision there, and
    /// duplicating it onto the tree row would give the two copies somewhere
    /// to disagree. `COALESCE` picks whichever of the two the row actually
    /// has, which today is always the `notes` side.
    ///
    /// Nothing here touches the filesystem. An attachment's size and
    /// timestamps were recorded when the scan or the watcher observed it, so
    /// they belong to the pinned generation like everything else — the
    /// earlier draft's per-page hashing was a workaround for a tree that did
    /// not exist yet.
    ///
    /// The cursor is bound to both the pinned generation and this session's
    /// own query fingerprint, so a cursor issued by another session is
    /// `invalid_cursor` rather than a page of somebody else's listing.
    pub fn tree_page(
        &mut self,
        id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<TreePage, IndexError> {
        let page_size = self.page_size(limit);
        let session = self.session(id)?;
        let generation = session.generation;
        let query = format!("snapshot_tree:{id}");
        let after = match cursor {
            None => String::new(),
            Some(cursor) => match decode_cursor(cursor, generation, &query)? {
                CursorPosition::TreeEntry { path } => path,
                _ => {
                    return Err(IndexError::InvalidCursor(
                        "cursor position does not fit a tree listing".into(),
                    ));
                }
            },
        };

        // One extra row, so "is there another page" needs no second query.
        let wanted = i64::from(page_size) + 1;
        let mut rows: Vec<TreeEntryRow> = {
            let mut statement = session.connection.prepare(
                "SELECT t.path, t.kind, t.size, t.ctime_unix_ms, t.mtime_unix_ms, \
                        COALESCE(t.content_revision, n.content_revision) \
                 FROM tree_entries t LEFT JOIN notes n ON n.path = t.path \
                 WHERE t.path > ?1 ORDER BY t.path LIMIT ?2",
            )?;
            let raw = statement
                .query_map(rusqlite::params![after.as_str(), wanted], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut converted = Vec::with_capacity(raw.len());
            for (path, kind, size, ctime_unix_ms, mtime_unix_ms, revision) in raw {
                converted.push(TreeEntryRow {
                    path: crate::codec::decode_path(&path)?,
                    kind: crate::codec::decode_tree_entry_kind(&kind)?,
                    size: size.and_then(|size| u64::try_from(size).ok()),
                    ctime_unix_ms,
                    mtime_unix_ms,
                    revision,
                });
            }
            converted
        };

        let has_more = rows.len() > page_size as usize;
        rows.truncate(page_size as usize);
        let next_cursor = match (has_more, rows.last()) {
            (true, Some(last)) => Some(encode_cursor(
                generation,
                &query,
                CursorPosition::TreeEntry {
                    path: last.path.as_str().to_string(),
                },
            )?),
            _ => None,
        };
        Ok(TreePage {
            generation,
            entries: rows,
            next_cursor,
        })
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

/// The page-size decision is crate-private and reached only through a live
/// session everywhere else, so its edges are pinned here rather than through
/// a database: the two fields it reads are `pub` and unvalidated, and one of
/// those edges used to be a panic.
#[cfg(test)]
mod tests {
    use super::*;

    fn sessions(default: u32, max: u32) -> SnapshotSessions {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        let mut config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
            .expect("page-size config");
        config.snapshot_page_size = default;
        config.max_snapshot_page_size = max;
        SnapshotSessions::new(&config)
    }

    #[test]
    fn a_page_size_is_the_default_when_none_is_asked_for_and_the_ask_when_one_is() {
        let sessions = sessions(500, 2_000);
        assert_eq!(sessions.page_size(None), 500);
        assert_eq!(sessions.page_size(Some(7)), 7);
        assert_eq!(sessions.page_size(Some(9_999)), 2_000);
        assert_eq!(sessions.page_size(Some(0)), 1, "a page is never empty");
    }

    #[test]
    fn a_maximum_of_zero_refuses_to_serve_nothing_rather_than_panicking() {
        // `Ord::clamp` panics when its low bound exceeds its high one, so a
        // misconfigured ceiling used to take the daemon down on the next page.
        let sessions = sessions(500, 0);
        assert_eq!(sessions.page_size(None), 1);
        assert_eq!(sessions.page_size(Some(50)), 1);
    }

    #[test]
    fn a_default_larger_than_the_maximum_is_bounded_by_the_maximum_it_advertises() {
        let sessions = sessions(5_000, 100);
        assert_eq!(sessions.page_size(None), 100);
    }
}
