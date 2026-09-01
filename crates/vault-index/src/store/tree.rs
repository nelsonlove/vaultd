//! The vault file tree's stored rows.
//!
//! `tree_entries` records every non-hidden entry the scan sees — folders,
//! notes, and other files — with the `size`/`ctime`/`mtime` a host needs to
//! serve a file's stat. It is deliberately *not* keyed to `notes`: a folder
//! and an attachment have no note row, and a note's tree row is a projection
//! of the same observation `notes.observed_*` already records.
//!
//! Every write in this module is scoped by an explicit `path` (or by that
//! path's own subtree range), never table-wide, so a targeted cycle's tree
//! write costs what the change costs — the same discipline the resolution
//! delta holds to.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use vault_core::{TreeEntry, TreeEntryKind, VaultPath};

use crate::codec;
use crate::error::IndexError;
use crate::store::u64_to_i64;

/// One stored `tree_entries` row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredTreeEntry {
    pub path: VaultPath,
    pub kind: TreeEntryKind,
    /// `None` for folders.
    pub size: Option<u64>,
    pub ctime_unix_ms: i64,
    pub mtime_unix_ms: i64,
    /// Reserved: nothing computes a revision for a non-note file today, and
    /// a note's revision lives on `notes`. Always `None` until a consumer
    /// needs one.
    pub content_revision: Option<String>,
}

impl StoredTreeEntry {
    /// Whether a freshly observed entry says anything this row does not.
    /// `content_revision` is deliberately not compared: no observation
    /// produces one, so it can never be the reason a row is rewritten.
    fn agrees_with(&self, entry: &TreeEntry) -> bool {
        self.path == entry.path
            && self.kind == entry.kind
            && self.size == entry.size
            && self.ctime_unix_ms == entry.ctime_unix_ms
            && self.mtime_unix_ms == entry.mtime_unix_ms
    }
}

/// What one cycle must apply to `tree_entries`, and whether applying it is
/// something a client can only learn about from a new generation.
///
/// A removal takes the named row *and everything beneath it*: a folder that
/// left the vault takes its contents with it, and no separate hint names
/// them.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TreeDelta {
    upserts: Vec<TreeEntry>,
    removals: Vec<VaultPath>,
    created: Vec<VaultPath>,
    modified: Vec<VaultPath>,
    generational: bool,
}

impl TreeDelta {
    pub fn is_empty(&self) -> bool {
        self.upserts.is_empty() && self.removals.is_empty()
    }

    /// Whether this delta changes anything a client can observe, and so must
    /// ride a new generation.
    ///
    /// Three things are client-visible: a path appearing, a path
    /// disappearing, and a **file**'s `size`/`ctime`/`mtime` moving — a host
    /// serves exactly those as `TFile.stat`. Two things are not, and neither
    /// advances anything on its own:
    ///
    /// * a **note** row's metadata, which is a projection of the same
    ///   observation `notes.observed_*` records, and which the ordinary
    ///   metadata-only touch already refreshes without publishing; and
    /// * a **folder** row's timestamps, which nothing reads — a folder in the
    ///   Obsidian object model carries no `stat` at all, only an identity.
    ///
    /// Without the second exemption every file written inside a folder would
    /// publish a second, contentless generation for the folder's own mtime.
    pub fn is_generational(&self) -> bool {
        self.generational
    }

    /// Paths whose row this delta adds.
    pub fn created(&self) -> &[VaultPath] {
        &self.created
    }

    /// Paths whose row this delta changes in a way a client can observe.
    pub fn modified(&self) -> &[VaultPath] {
        &self.modified
    }

    /// Paths whose row (and subtree) this delta removes.
    pub fn removed(&self) -> &[VaultPath] {
        &self.removals
    }

    fn record_upsert(&mut self, stored: Option<&StoredTreeEntry>, entry: TreeEntry) {
        match stored {
            None => {
                self.generational = true;
                self.created.push(entry.path.clone());
                self.upserts.push(entry);
            }
            Some(row) => {
                if row.agrees_with(&entry) {
                    return;
                }
                // A folder that became a file or a note is not one row
                // changing kind: the folder ceased to exist, and everything
                // stored beneath it ceased to exist with it. A bare upsert
                // would replace the folder's own row and orphan every
                // descendant — rows a complete walk would have removed, left
                // behind to be served as a subtree that is not there. Recorded
                // as a removal followed by a creation, which is both what the
                // filesystem did and the order `apply` writes.
                if row.kind == TreeEntryKind::Folder && entry.kind != TreeEntryKind::Folder {
                    self.record_removal(entry.path.clone());
                    self.created.push(entry.path.clone());
                    self.upserts.push(entry);
                    return;
                }
                if row.kind != entry.kind || entry.kind == TreeEntryKind::File {
                    self.generational = true;
                    self.modified.push(entry.path.clone());
                }
                self.upserts.push(entry);
            }
        }
    }

    fn record_removal(&mut self, path: VaultPath) {
        self.generational = true;
        self.removals.push(path);
    }
}

/// The delta that carries the stored tree to exactly what a whole-vault walk
/// just observed.
///
/// A stored row is removed only when nothing observed lives beneath it, so
/// the subtree semantics of a removal can never take a path the walk did
/// report — the case that arises when a folder's own metadata could not be
/// read but its children's could.
pub(crate) fn diff_scan(
    stored: &BTreeMap<VaultPath, StoredTreeEntry>,
    observed: &[TreeEntry],
) -> TreeDelta {
    let mut delta = TreeDelta::default();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for entry in observed {
        seen.insert(entry.path.as_str());
        delta.record_upsert(stored.get(&entry.path), entry.clone());
    }
    for path in stored.keys() {
        if seen.contains(path.as_str()) {
            continue;
        }
        // "Did the walk report anything beneath this path?" — answered by the
        // first observed path at or after `<path>/`, not by scanning every
        // observed path once per removal. The two are equivalent because the
        // set is ordered: every descendant sorts into the `<path>/…` range, so
        // the first candidate in it settles the question.
        let prefix = format!("{}/", path.as_str());
        let has_descendant = seen
            .range(prefix.as_str()..)
            .next()
            .is_some_and(|seen| seen.starts_with(&prefix));
        if has_descendant {
            continue;
        }
        delta.record_removal(path.clone());
    }
    delta
}

/// Fold one already-observed path into a delta: `Some(entry)` upserts it when
/// it says something new, `None` removes it (and its subtree) when a row
/// exists.
pub(crate) fn diff_one(
    stored: Option<&StoredTreeEntry>,
    observed: Option<TreeEntry>,
    delta: &mut TreeDelta,
) {
    match (stored, observed) {
        (_, Some(entry)) => delta.record_upsert(stored, entry),
        (Some(row), None) => delta.record_removal(row.path.clone()),
        (None, None) => {}
    }
}

/// Apply one delta inside an already-open transaction. Removals run first, so
/// a path that was removed and re-created in the same cycle ends up with the
/// row the observation described.
pub(crate) fn apply(transaction: &Transaction<'_>, delta: &TreeDelta) -> Result<(), IndexError> {
    for path in &delta.removals {
        remove_subtree(transaction, path)?;
    }
    for entry in &delta.upserts {
        upsert(transaction, entry)?;
    }
    Ok(())
}

fn upsert(transaction: &Transaction<'_>, entry: &TreeEntry) -> Result<(), IndexError> {
    let size = entry
        .size
        .map(|size| u64_to_i64(size, "tree entry size"))
        .transpose()?;
    // `content_revision` is deliberately left alone on update: nothing
    // observes one, so an observation must never clear a value some later
    // writer put there.
    transaction.execute(
        "INSERT INTO tree_entries \
         (path, kind, size, ctime_unix_ms, mtime_unix_ms, content_revision) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL) \
         ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, size = excluded.size, \
         ctime_unix_ms = excluded.ctime_unix_ms, mtime_unix_ms = excluded.mtime_unix_ms",
        params![
            entry.path.as_str(),
            codec::encode_tree_entry_kind(entry.kind),
            size,
            entry.ctime_unix_ms,
            entry.mtime_unix_ms,
        ],
    )?;
    Ok(())
}

/// Delete one row and every row beneath it, as a primary-key range rather
/// than a `LIKE` pattern: a path containing `%` or `_` is an ordinary vault
/// path, and a pattern match would silently take the wrong rows.
fn remove_subtree(transaction: &Transaction<'_>, path: &VaultPath) -> Result<(), IndexError> {
    let lower = format!("{}/", path.as_str());
    // `/` is 0x2F and `0` is 0x30, so `<lower excluded>` is exactly the set of
    // paths that begin with `<path>/`.
    let upper = format!("{}0", path.as_str());
    transaction.execute(
        "DELETE FROM tree_entries WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        params![path.as_str(), lower, upper],
    )?;
    Ok(())
}

fn row_to_entry(
    path: String,
    kind: String,
    size: Option<i64>,
    ctime_unix_ms: i64,
    mtime_unix_ms: i64,
    content_revision: Option<String>,
) -> Result<StoredTreeEntry, IndexError> {
    let size = size
        .map(|size| {
            u64::try_from(size)
                .map_err(|_| IndexError::IncompatibleIndex("negative tree entry size".into()))
        })
        .transpose()?;
    Ok(StoredTreeEntry {
        path: codec::decode_path(&path)?,
        kind: codec::decode_tree_entry_kind(&kind)?,
        size,
        ctime_unix_ms,
        mtime_unix_ms,
        content_revision,
    })
}

const SELECT_COLUMNS: &str =
    "path, kind, size, ctime_unix_ms, mtime_unix_ms, content_revision FROM tree_entries";

/// Every stored row, in path order. Runs against a plain connection or a
/// reader's transaction (`&Transaction` derefs to `&Connection`), so both
/// sides run byte-identical SQL.
pub(crate) fn load_all(connection: &Connection) -> Result<Vec<StoredTreeEntry>, IndexError> {
    let mut statement = connection.prepare(&format!("SELECT {SELECT_COLUMNS} ORDER BY path"))?;
    let rows = statement
        .query_map([], |row| {
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
    rows.into_iter()
        .map(|(path, kind, size, ctime, mtime, revision)| {
            row_to_entry(path, kind, size, ctime, mtime, revision)
        })
        .collect()
}

pub(crate) fn load_map(
    connection: &Connection,
) -> Result<BTreeMap<VaultPath, StoredTreeEntry>, IndexError> {
    Ok(load_all(connection)?
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect())
}

pub(crate) fn load_one(
    connection: &Connection,
    path: &VaultPath,
) -> Result<Option<StoredTreeEntry>, IndexError> {
    let row = connection
        .query_row(
            &format!("SELECT {SELECT_COLUMNS} WHERE path = ?1"),
            params![path.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((path, kind, size, ctime, mtime, revision)) = row else {
        return Ok(None);
    };
    Ok(Some(row_to_entry(
        path, kind, size, ctime, mtime, revision,
    )?))
}
