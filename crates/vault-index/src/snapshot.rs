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
//! **A page proves its own pin rather than asserting it.** Both pagers
//! re-read the committed generation *inside the page's own transaction* and
//! refuse ([`IndexError::SnapshotPinLost`]) when it disagrees with the
//! generation the session was opened at. The bookkeeping field alone cannot
//! evidence anything: a session whose transaction had ended would keep
//! reporting it while serving whatever rows the connection could currently
//! see, which is precisely the silent staleness this module exists to
//! prevent.
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
use vault_core::{
    Diagnostic, ListItemParent, Resolution, ResolvedReference, SourceSpan, VaultPath,
};

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

    /// End one session's pinned transaction without closing the session.
    ///
    /// The Task 14 reviewer's probe, kept as production-visible test surface
    /// rather than reconstructed per test: nothing in a query-only deferred
    /// transaction ends it on its own (SQLite's automatic-rollback cases are
    /// I/O-error class), which is exactly why a page that trusted its own
    /// bookkeeping failed silently. This is the only way to reach the state
    /// [`IndexError::SnapshotPinLost`] describes.
    #[doc(hidden)]
    pub fn end_pinned_transaction_for_test(&mut self, id: &str) -> Result<(), IndexError> {
        let session = self.session(id)?;
        session.connection.execute_batch("ROLLBACK")?;
        Ok(())
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
    /// long as it stays connected — and opening it was itself a request, so
    /// "quiet" includes a client alive only on an event stream. The
    /// dispatcher calls this on every **input** it takes, request or runtime
    /// notice, which bounds residency to one idle timeout after the last
    /// input rather than after the last snapshot call. No thread and no
    /// timer: the sweep rides on traffic that is already happening.
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
    ///
    /// The generation this page reports is re-read from the transaction
    /// serving it, never taken on trust from the session record — see
    /// [`pinned_generation`].
    pub fn tree_page(
        &mut self,
        id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<TreePage, IndexError> {
        let page_size = self.page_size(limit);
        let session = self.session(id)?;
        let generation = pinned_generation(session, id)?;
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
                    size: size.map(decode_size).transpose()?,
                    ctime_unix_ms,
                    mtime_unix_ms,
                    revision,
                });
            }
            converted
        };

        // `u32 -> usize` is lossless on every supported platform; the
        // saturating fallback keeps the conversion total rather than a cast,
        // and on a hypothetical 16-bit target it would serve a short page
        // instead of wrapping to a tiny one.
        let wanted_rows = usize::try_from(page_size).unwrap_or(usize::MAX);
        let has_more = rows.len() > wanted_rows;
        rows.truncate(wanted_rows);
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

/// Which per-note row-sets a page carries. A facet that is `false` is not
/// queried, not allocated, and absent from the row.
///
/// `Default` is every facet off, which is the documented answer to a request
/// that names no facet: a page of identities — path and revision — rather
/// than an error or a silent full hydration. A facet name this build does not
/// know never reaches here at all: the wire enum has no unknown variant, so a
/// misspelling is `invalid_request` at parse time, the same strictness every
/// other params struct gets.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct NoteFacets {
    pub metadata: bool,
    pub references: bool,
    pub resolutions: bool,
    pub backlinks: bool,
    pub sections: bool,
    pub list_items: bool,
}

/// One parsed section, from the schema-v3 `sections` rows.
///
/// `kind` is the stored string, carried through rather than decoded and
/// re-encoded: the column is written from `codec::encode_section_kind`, whose
/// `Other(s)` case stores `s` literally, so a round trip through the enum
/// could only lose the open end of that set. `block_id` is the trailing `^id`
/// anchor where the block carries one, present on every read path exactly as
/// the pre-task's DDL requires.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SectionRow {
    pub kind: String,
    pub span: SourceSpan,
    pub block_id: Option<String>,
}

/// One parsed list item, from the schema-v3 `list_items` rows.
///
/// The parent is a **line number**. A top-level item names the start line of
/// the list containing it; a nested item names its parent item's own start
/// line. Exactly one of the two is set — the stored `CHECK` constraint
/// enforces it, and this type mirrors that rather than flattening the pair
/// into one signed number. Obsidian's own `listItems[].parent` is that
/// flattening (negated for the top level), and reconstructing it is the
/// host's arithmetic, not this layer's.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListItemRow {
    pub span: SourceSpan,
    pub list_start_line: Option<u32>,
    pub parent_start_line: Option<u32>,
    /// The raw character inside the brackets, `None` for a non-task item.
    /// One character wide by construction.
    pub task: Option<String>,
}

/// One note's requested facets.
#[derive(Clone, Debug)]
pub struct SnapshotNoteRow {
    pub path: VaultPath,
    pub revision: String,
    pub metadata: Option<SnapshotMetadata>,
    pub references: Option<Vec<ResolvedReference>>,
    pub resolutions: Option<Vec<Resolution>>,
    pub backlinks: Option<Vec<ResolvedReference>>,
    pub sections: Option<Vec<SectionRow>>,
    pub list_items: Option<Vec<ListItemRow>>,
}

/// The metadata facet, body-free.
#[derive(Clone, Debug)]
pub struct SnapshotMetadata {
    pub properties: Vec<vault_core::Property>,
    pub aliases: Vec<vault_core::Alias>,
    pub headings: Vec<vault_core::Heading>,
    pub blocks: Vec<vault_core::BlockId>,
    pub tags: Vec<vault_core::Tag>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug)]
pub struct NotesPage {
    pub generation: Generation,
    pub notes: Vec<SnapshotNoteRow>,
    pub next_cursor: Option<String>,
}

impl SnapshotSessions {
    /// One page of per-note semantic row-sets, in path order, at the
    /// session's pinned generation.
    ///
    /// Bodies stay per-note through `get_note`: the metadata facet never
    /// selects `notes.source_bytes`, because a bulk hydration that dragged
    /// every body through it would defeat the point of paging facets at all.
    ///
    /// Like `tree_page`, this re-reads the pinned generation inside the
    /// page's own transaction before serving anything — see
    /// [`pinned_generation`].
    pub fn notes_page(
        &mut self,
        id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
        facets: NoteFacets,
    ) -> Result<NotesPage, IndexError> {
        let page_size = self.page_size(limit);
        let session = self.session(id)?;
        let generation = pinned_generation(session, id)?;
        let query = format!("snapshot_notes:{id}");
        let after = match cursor {
            None => String::new(),
            Some(cursor) => match decode_cursor(cursor, generation, &query)? {
                CursorPosition::SnapshotNote { path } => path,
                _ => {
                    return Err(IndexError::InvalidCursor(
                        "cursor position does not fit a note listing".into(),
                    ));
                }
            },
        };

        // One extra row, so "is there another page" needs no second query.
        let wanted = i64::from(page_size) + 1;
        let mut rows: Vec<(String, String)> = {
            let mut statement = session.connection.prepare(
                "SELECT path, content_revision FROM notes WHERE path > ?1 ORDER BY path LIMIT ?2",
            )?;
            statement
                .query_map(rusqlite::params![after.as_str(), wanted], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let wanted_rows = usize::try_from(page_size).unwrap_or(usize::MAX);
        let has_more = rows.len() > wanted_rows;
        rows.truncate(wanted_rows);

        let mut notes = Vec::with_capacity(rows.len());
        for (path, revision) in rows {
            let path = crate::codec::decode_path(&path)?;
            let metadata = if facets.metadata {
                let loaded = crate::store::load_metadata_with(&session.connection, &path)?;
                Some(SnapshotMetadata {
                    properties: loaded.properties,
                    aliases: loaded.aliases,
                    headings: loaded.headings,
                    blocks: loaded.blocks,
                    tags: loaded.tags,
                    diagnostics: loaded.diagnostics,
                })
            } else {
                None
            };
            // Loaded once when either facet is asked for: the two are the
            // same query, and `resolutions` is the answers-only projection of
            // it for a client that wants no spans or spellings.
            let outgoing = if facets.references || facets.resolutions {
                Some(crate::store::load_outgoing_with(
                    &session.connection,
                    &path,
                )?)
            } else {
                None
            };
            let resolutions = if facets.resolutions {
                outgoing.as_ref().map(|outgoing| {
                    outgoing
                        .iter()
                        .map(|resolved| resolved.resolution.clone())
                        .collect()
                })
            } else {
                None
            };
            let references = if facets.references { outgoing } else { None };
            let backlinks = if facets.backlinks {
                Some(load_backlinks(&session.connection, &path)?)
            } else {
                None
            };
            let sections = if facets.sections {
                Some(load_sections(&session.connection, &path)?)
            } else {
                None
            };
            let list_items = if facets.list_items {
                Some(load_list_items(&session.connection, &path)?)
            } else {
                None
            };
            notes.push(SnapshotNoteRow {
                path,
                revision,
                metadata,
                references,
                resolutions,
                backlinks,
                sections,
                list_items,
            });
        }

        let next_cursor = match (has_more, notes.last()) {
            (true, Some(last)) => Some(encode_cursor(
                generation,
                &query,
                CursorPosition::SnapshotNote {
                    path: last.path.as_str().to_string(),
                },
            )?),
            _ => None,
        };
        Ok(NotesPage {
            generation,
            notes,
            next_cursor,
        })
    }
}

/// Every reference that resolves to `path`, in the same stable order
/// `IndexReader::get_backlinks` uses.
fn load_backlinks(
    connection: &Connection,
    path: &VaultPath,
) -> Result<Vec<ResolvedReference>, IndexError> {
    let mut statement = connection.prepare(
        "SELECT r.id, r.kind, r.origin, r.raw_target, r.file_target, r.subpath_kind, \
                r.subpath_value, r.display, r.span_start, r.span_end, \
                r.target_span_start, r.target_span_end, \
                s.kind, s.target_path, s.subpath_kind, s.subpath_value, r.note_path \
         FROM resolutions s JOIN note_references r ON r.id = s.reference_id \
         WHERE s.target_path = ?1 AND s.kind IN ('resolved', 'missing_subpath') \
         ORDER BY r.note_path, r.span_start, r.span_end, r.id",
    )?;
    let rows = statement
        .query_map(rusqlite::params![path.as_str()], |row| {
            Ok((
                crate::store::reference_row_prefix(row)?,
                row.get::<_, String>(16)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(row, source)| {
            let source = crate::codec::decode_path(&source)?;
            crate::store::resolved_reference_from_row_with(connection, source, row)
        })
        .collect()
}

fn load_sections(connection: &Connection, path: &VaultPath) -> Result<Vec<SectionRow>, IndexError> {
    let mut statement = connection.prepare(
        "SELECT kind, span_start, span_end, block_id FROM sections \
         WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let rows = statement
        .query_map(rusqlite::params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(kind, start, end, block_id)| {
            Ok(SectionRow {
                kind,
                span: crate::codec::decode_span(
                    crate::store::i64_to_usize(start, "section span start")?,
                    crate::store::i64_to_usize(end, "section span end")?,
                )?,
                block_id,
            })
        })
        .collect()
}

fn load_list_items(
    connection: &Connection,
    path: &VaultPath,
) -> Result<Vec<ListItemRow>, IndexError> {
    let mut statement = connection.prepare(
        "SELECT span_start, span_end, list_start_line, parent_start_line, task \
         FROM list_items WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let rows = statement
        .query_map(rusqlite::params![path.as_str()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(start, end, list_start_line, parent_start_line, task)| {
            // The stored `CHECK` already guarantees exactly one parent column
            // is set, and a negative line number is not a sentinel in this
            // model. Both refusals belong to `codec::decode_list_item_parent`,
            // which is what the writer and `load_note_with` already use — a
            // second copy of that rule here would be free to disagree with
            // the one the rows were written under.
            let (list_start_line, parent_start_line) =
                match crate::codec::decode_list_item_parent(list_start_line, parent_start_line)? {
                    ListItemParent::Root { list_start_line } => (Some(list_start_line), None),
                    ListItemParent::Item { parent_start_line } => (None, Some(parent_start_line)),
                };
            Ok(ListItemRow {
                span: crate::codec::decode_span(
                    crate::store::i64_to_usize(start, "list item span start")?,
                    crate::store::i64_to_usize(end, "list item span end")?,
                )?,
                list_start_line,
                parent_start_line,
                // Through the codec for the same reason the parent columns
                // are: `load_note_with` reads this column through
                // `decode_task`, which admits exactly one character, and a
                // page that skipped it would be the second loader holding one
                // rule between them. Re-encoding is what the wire wants — a
                // one-character string — so the round trip is the validation
                // rather than a conversion for its own sake.
                task: crate::codec::encode_task(crate::codec::decode_task(task)?),
            })
        })
        .collect()
}

/// Proof that this session still holds its pin, and the generation it is
/// pinned at — refused when either half fails.
///
/// **Two checks, in order, and the first one is about the pin itself.** A
/// deferred transaction that has ended returns its connection to autocommit,
/// so `is_autocommit()` is direct evidence: it answers "am I still inside the
/// transaction that froze these frames", which is the actual question, and it
/// cannot be fooled by what the writer did or did not do meanwhile. The
/// generation re-read stays behind it as defence in depth, and names the
/// number a client needs in the refusal.
///
/// Task 14 review finding M-a is why either check exists: every page used to
/// report `session.generation` — a struct field, written once at `open` —
/// while serving whatever rows the connection could currently see, so a probe
/// that ended the transaction got three post-snapshot notes under
/// `Generation(1)` with no error and no signal.
///
/// Task 15 review finding I-3 is why the generation re-read is not enough on
/// its own. [`crate::IndexStore::touch`] commits `tree_entries` metadata (a
/// moved `mtime_unix_ms`, `size`, `ctime_unix_ms`) and note fingerprints
/// **without bumping the generation**, so an unpinned `tree_page` passed the
/// generation check and served a touched stat — the numbers a host builds
/// `TFile.stat` from — under the pinned generation number. The notes half
/// serves nothing `touch` writes and could not tear that way, but "the
/// generation determines the rows" is false for the tree, so the pin is
/// detected directly rather than inferred.
fn pinned_generation(session: &Session, id: &str) -> Result<Generation, IndexError> {
    let lost = |observed: Generation| IndexError::SnapshotPinLost {
        snapshot: id.to_string(),
        pinned: session.generation.get(),
        observed: observed.get(),
    };
    if session.connection.is_autocommit() {
        // The pin is provably gone; the generation is read only so the
        // refusal can say what this connection would have answered from.
        return Err(lost(stored_generation(&session.connection)?));
    }
    let observed = stored_generation(&session.connection)?;
    if observed != session.generation {
        return Err(lost(observed));
    }
    Ok(observed)
}

/// The committed generation one connection reads, inside whatever transaction
/// it already holds. `IndexUnavailable` when nothing has been committed.
fn stored_generation(connection: &Connection) -> Result<Generation, IndexError> {
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
    Generation::from_db(stored)
}

/// The generation, note count, and tree entry count one connection currently
/// reads — inside whatever transaction it already holds.
///
/// The tree count comes from the same pinned transaction as the note count,
/// so the number a client is told up front is the number it will actually
/// page out. `tree_entries` holds folders, notes, and non-Markdown files
/// alike, so it is always at least the note count.
fn pinned_counts(connection: &Connection) -> Result<(Generation, u64, u64), IndexError> {
    let generation = stored_generation(connection)?;
    let note_count = count(connection, "SELECT COUNT(*) FROM notes", "note count")?;
    let entry_count = count(
        connection,
        "SELECT COUNT(*) FROM tree_entries",
        "tree entry count",
    )?;
    Ok((generation, note_count, entry_count))
}

/// A stored `tree_entries.size`, refused rather than dropped when it is
/// negative.
///
/// The lenient reading (`try_from(...).ok()`) turned a corrupt row into
/// `size: None`, which is exactly how a **folder** reports itself on the
/// wire — a client would mirror a file as a directory and never know. Its two
/// neighbours in the same loop, `decode_path` and `decode_tree_entry_kind`,
/// both refuse a row they cannot read, and `count` above already refuses a
/// negative count in precisely this shape. The schema-v3 DDL carries no
/// `CHECK (size >= 0)` and is pinned, so this decoder is the guard.
fn decode_size(stored: i64) -> Result<u64, IndexError> {
    u64::try_from(stored)
        .map_err(|_| IndexError::IncompatibleIndex(format!("negative tree entry size {stored}")))
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

    /// A built index whose service has been released, so a test may reach the
    /// database directly. Returns the config and the two temp directories,
    /// which must outlive it.
    fn built_index() -> (IndexConfig, tempfile::TempDir, tempfile::TempDir) {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        let root = vault.path().canonicalize().expect("canonical vault root");
        std::fs::write(root.join("One.md"), "# One\n").expect("write One");
        let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3"))
            .expect("decode-test config");
        let mut service = crate::reconcile::IndexService::open(config.clone()).expect("service");
        service.refresh(false).expect("cold build");
        drop(service);
        (config, vault, index)
    }

    /// `size` is the one column a page used to decode leniently: a negative
    /// value became `None`, which on the wire is exactly how a **folder**
    /// reports itself. Its two neighbours in the same loop (`decode_path`,
    /// `decode_tree_entry_kind`) both refuse a corrupt row, and a negative
    /// count already refuses in `count` above, so this is the odd one out
    /// rather than a new rule. The schema-v3 DDL is pinned and carries no
    /// `CHECK (size >= 0)`, which makes the decoder the guard.
    #[test]
    fn a_negative_stored_size_is_a_decode_error_not_a_row_that_looks_like_a_folder() {
        let (config, _vault, _index) = built_index();
        let writer = Connection::open(&config.index_path).expect("open the index for writing");
        writer
            .execute(
                "UPDATE tree_entries SET size = -1 WHERE path = 'One.md'",
                [],
            )
            .expect("corrupt one size");
        drop(writer);

        let mut sessions = SnapshotSessions::new(&config);
        let opened = sessions.open().expect("open a snapshot");
        let error = sessions
            .tree_page(&opened.snapshot_id, None, Some(10))
            .expect_err("a negative size is not a size");
        match error {
            IndexError::IncompatibleIndex(message) => assert!(
                message.contains("negative tree entry size"),
                "the refusal must name what it found: {message:?}"
            ),
            other => panic!("expected incompatible_index, got {other:?}"),
        }
    }

    /// The other half of the sweep's claim: reaping does not merely forget an
    /// entry, it releases the WAL frames the session was pinning. Measured
    /// the only way it can be — a truncating checkpoint from an independent
    /// connection, which SQLite refuses (`busy = 1`) while any reader still
    /// holds a mark.
    #[test]
    fn sweeping_an_idle_session_releases_the_wal_frames_it_was_pinning() {
        let vault = tempfile::TempDir::new().expect("vault tempdir");
        let index = tempfile::TempDir::new().expect("index tempdir");
        let root = vault.path().canonicalize().expect("canonical vault root");
        std::fs::write(root.join("One.md"), "# One\n").expect("write One");
        let mut config = IndexConfig::explicit(&root, index.path().join("index.sqlite3"))
            .expect("wal-test config");
        config.snapshot_idle_timeout = std::time::Duration::from_millis(50);
        let mut service = crate::reconcile::IndexService::open(config.clone()).expect("service");
        service.refresh(false).expect("cold build");

        let mut sessions = SnapshotSessions::new(&config);
        sessions.open().expect("open a snapshot");

        // The writer has to move for there to be frames worth holding: the
        // reader's mark is what stops the checkpoint from resetting the WAL,
        // and a WAL with nothing past the mark can be truncated regardless.
        for index in 0..3 {
            service
                .apply_mutation(&crate::mutate::Mutation::WriteNote {
                    path: vault_core::VaultPath::new(format!("Storm-{index}.md"))
                        .expect("valid vault path"),
                    content: format!("# Storm {index}\n"),
                    expected: crate::mutate::Precondition::Absent,
                })
                .expect("write past the snapshot");
            service.refresh(false).expect("publish past the snapshot");
        }

        assert_eq!(
            checkpoint_busy(&config.index_path),
            1,
            "the instrument itself: a truncating checkpoint is refused while a session reads"
        );

        std::thread::sleep(std::time::Duration::from_millis(120));
        sessions.sweep();
        assert!(sessions.is_empty(), "the idle session was reclaimed");
        assert_eq!(
            checkpoint_busy(&config.index_path),
            0,
            "the reclaimed session must have released its frames, not merely left the registry"
        );
    }

    /// The `busy` column of `PRAGMA wal_checkpoint(TRUNCATE)`: 1 when a
    /// reader's mark blocks the truncation, 0 when it completes.
    fn checkpoint_busy(index_path: &std::path::Path) -> i64 {
        let connection = Connection::open(index_path).expect("open the index");
        connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .expect("run a truncating checkpoint")
    }
}
