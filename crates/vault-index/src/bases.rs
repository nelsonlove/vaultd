//! `.base` files as an indexed kind.
//!
//! A base is read like a note — fingerprint, read once, fingerprint again —
//! and parsed into a [`BaseRecord`]; its row lands in `bases` and its record
//! in the live graph in the same transaction and install as every note of
//! the same generation. The set of bases is what the file-tree walk saw: a
//! [`crate::ReconcileSource`] that observes no tree reconciles no bases.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use vault_bases::{BaseFile, BaseParseError, parse_base};
use vault_core::{ResolutionNote, ScanError, SourceDocument, TreeEntry, TreeEntryKind, VaultPath};

use crate::error::IndexError;
use crate::inventory::ReconcileSource;
use crate::model::FileFingerprint;
use crate::store::TreeDelta;

/// One parsed base as the index holds it: the parsed file (for evaluation),
/// its view names (for resolution), and the parse error when it did not
/// parse. A base that failed to parse has no file and no views, and still
/// resolves — a link to it is a link to a file that exists.
#[derive(Clone, Debug, PartialEq)]
pub struct BaseRecord {
    pub file: Option<Arc<BaseFile>>,
    pub views: Vec<String>,
    pub error: Option<BaseParseError>,
}

impl BaseRecord {
    /// Parse `text`; never panics, a parse error is kept on the record.
    pub fn parse(text: &str) -> Self {
        match parse_base(text) {
            Ok(file) => Self {
                views: file.view_names(),
                file: Some(Arc::new(file)),
                error: None,
            },
            Err(error) => Self {
                file: None,
                views: Vec::new(),
                error: Some(error),
            },
        }
    }

    /// A base whose bytes could not be read or are not UTF-8.
    pub(crate) fn unreadable(message: String) -> Self {
        Self {
            file: None,
            views: Vec::new(),
            error: Some(BaseParseError {
                message,
                span: None,
            }),
        }
    }

    /// The base's identity as resolution sees it: its path and its views.
    pub fn identity(&self, path: &VaultPath) -> ResolutionNote {
        ResolutionNote::base(path.clone(), self.views.clone())
    }
}

/// One base to write: its row and its parsed record.
#[derive(Clone, Debug)]
pub struct BaseReplacement {
    pub path: VaultPath,
    pub revision: String,
    pub source: Arc<str>,
    pub fingerprint: FileFingerprint,
    pub record: BaseRecord,
}

/// The bases one publication replaces and removes.
#[derive(Clone, Debug, Default)]
pub struct BaseDelta {
    pub replaced: Vec<BaseReplacement>,
    pub removed: Vec<VaultPath>,
}

impl BaseDelta {
    /// Whether this delta moves no base at all.
    pub fn is_empty(&self) -> bool {
        self.replaced.is_empty() && self.removed.is_empty()
    }

    /// This delta minus what `stored` already says: a replacement whose
    /// stored revision is already its own and a removal whose row is already
    /// gone are dropped. A publish attempt that lost its compare-and-swap to
    /// a writer that applied the same change then publishes nothing for it.
    pub(crate) fn unapplied(
        &self,
        stored: &BTreeMap<VaultPath, (String, FileFingerprint)>,
    ) -> Self {
        Self {
            replaced: self
                .replaced
                .iter()
                .filter(|replacement| {
                    stored
                        .get(&replacement.path)
                        .map(|(revision, _)| revision.as_str())
                        != Some(replacement.revision.as_str())
                })
                .cloned()
                .collect(),
            removed: self
                .removed
                .iter()
                .filter(|path| stored.contains_key(*path))
                .cloned()
                .collect(),
        }
    }
}

/// The parser generation a stored base row was parsed by. It prefixes every
/// stored `content_revision`, so a row parsed by another generation never
/// equals a fresh read: [`plan`] re-reads it and hydration trusts its fresh
/// parse over its stored status. The crate version is the workspace version
/// `vault-bases` shares; the trailing number is bumped by hand when the
/// parser's output changes within one version.
pub(crate) const BASE_PARSER_VERSION: &str =
    concat!("vault-bases/", env!("CARGO_PKG_VERSION"), "#1");

/// Whether a stored revision was written by this parser generation.
pub(crate) fn revision_is_current(revision: &str) -> bool {
    revision
        .strip_prefix(BASE_PARSER_VERSION)
        .is_some_and(|rest| rest.starts_with(' '))
}

/// The stored revision for one read outcome. Readable text is the parser
/// generation and the text's own content revision; an unreadable or
/// non-UTF-8 file is marked as such and hashes what was learned instead (the
/// raw bytes, or the error), so it can never share a revision with a
/// readable file — an empty base included.
fn base_revision(path: &VaultPath, outcome: &ReadOutcome) -> String {
    match outcome {
        ReadOutcome::Text(text) => format!(
            "{BASE_PARSER_VERSION} {}",
            SourceDocument::new(path.clone(), text.clone())
                .revision()
                .as_str()
        ),
        ReadOutcome::NotUtf8(bytes) => format!(
            "{BASE_PARSER_VERSION} unreadable:bytes:blake3:{}",
            blake3::hash(bytes)
        ),
        ReadOutcome::Unreadable(message) => format!(
            "{BASE_PARSER_VERSION} unreadable:error:blake3:{}",
            blake3::hash(message.as_bytes())
        ),
    }
}

enum ReadOutcome {
    Text(Arc<str>),
    NotUtf8(Vec<u8>),
    Unreadable(String),
}

/// Read one base as it is on disk now, `None` when it is absent. A base
/// whose bytes are not UTF-8 or cannot be read still indexes, as a parse
/// failure naming why — it exists, so a link to it resolves.
fn read_base(
    source: &dyn ReconcileSource,
    path: &VaultPath,
) -> Result<Option<BaseReplacement>, IndexError> {
    let Some(before) = source.fingerprint(path)? else {
        return Ok(None);
    };
    let outcome = match source.read_bytes(path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => ReadOutcome::Text(text.into()),
            Err(error) => ReadOutcome::NotUtf8(error.into_bytes()),
        },
        Err(ScanError::UnreadableFile { message, .. }) => ReadOutcome::Unreadable(message),
        Err(ScanError::InaccessibleRoot { message }) => {
            return Err(IndexError::InvalidVaultRoot(message));
        }
    };
    if source.fingerprint(path)? != Some(before) {
        return Err(IndexError::VaultChangedDuringRefresh);
    }
    let revision = base_revision(path, &outcome);
    let (source_text, record) = match outcome {
        ReadOutcome::Text(text) => {
            let record = BaseRecord::parse(&text);
            (text, record)
        }
        ReadOutcome::NotUtf8(_) => (
            Arc::from(""),
            BaseRecord::unreadable(format!("{} is not valid UTF-8", path.as_str())),
        ),
        ReadOutcome::Unreadable(message) => (Arc::from(""), BaseRecord::unreadable(message)),
    };
    Ok(Some(BaseReplacement {
        path: path.clone(),
        revision,
        source: source_text,
        fingerprint: before,
        record,
    }))
}

/// What one route knows about the base paths it reconciles.
#[derive(Debug, Default)]
pub(crate) struct BaseCandidates {
    /// Paths that are base files now: the walk's `File` entries, or hinted
    /// paths whose tree entry says `File`.
    pub(crate) files: BTreeSet<VaultPath>,
    /// Paths known not to be base files now: hinted paths with no tree entry,
    /// or one that is a folder or excluded (a symlink). A stored row for one
    /// is removed.
    pub(crate) absent: BTreeSet<VaultPath>,
    /// Files whose tree row (size, ctime and mtime in milliseconds) did not
    /// move in this walk. A stored, current-generation row for one is trusted
    /// without a `stat`.
    pub(crate) settled: BTreeSet<VaultPath>,
    /// The candidates are a complete walk: a stored base not among `files`
    /// is removed.
    pub(crate) complete: bool,
}

/// The delta that brings `stored` to what is on disk for `candidates`.
///
/// A file whose stored row is current is skipped without a read when its
/// tree row is settled, or when its fingerprint still equals the stored
/// one; `verify` reads every file. A read whose revision equals the stored
/// one is dropped: the bases row and the live graph do not move, though the
/// file's tree row may (a `touch` still publishes a tree generation), and
/// the stored fingerprint stays stale, so the file is re-read on each refresh
/// that does not see its tree row settled until its content changes.
pub(crate) fn plan(
    source: &dyn ReconcileSource,
    stored: &BTreeMap<VaultPath, (String, FileFingerprint)>,
    candidates: &BaseCandidates,
    verify: bool,
) -> Result<BaseDelta, IndexError> {
    let mut delta = BaseDelta::default();
    let mut removed: BTreeSet<VaultPath> = BTreeSet::new();
    for path in &candidates.files {
        if !path.is_base() || path.is_hidden() {
            continue;
        }
        let known = stored.get(path);
        let current = known.is_some_and(|(revision, _)| revision_is_current(revision));
        if current && !verify {
            if candidates.settled.contains(path) {
                continue;
            }
            if let (Some((_, fingerprint)), Some(now)) = (known, source.fingerprint(path)?) {
                if *fingerprint == now {
                    continue;
                }
            }
        }
        match read_base(source, path)? {
            Some(replacement) => {
                if known.map(|(revision, _)| revision.as_str())
                    != Some(replacement.revision.as_str())
                {
                    delta.replaced.push(replacement);
                }
            }
            None => {
                if known.is_some() {
                    removed.insert(path.clone());
                }
            }
        }
    }
    for path in &candidates.absent {
        if stored.contains_key(path) {
            removed.insert(path.clone());
        }
    }
    if candidates.complete {
        for path in stored.keys() {
            if !candidates.files.contains(path) {
                removed.insert(path.clone());
            }
        }
    }
    delta.removed = removed.into_iter().collect();
    Ok(delta)
}

/// The candidates a complete walk gives: every `File` entry ending in
/// `.base`, settled unless this walk's tree delta created or modified its row.
pub(crate) fn walk_candidates(observed: &[TreeEntry], tree: &TreeDelta) -> BaseCandidates {
    let moved: BTreeSet<&VaultPath> = tree.created().iter().chain(tree.modified()).collect();
    let files: BTreeSet<VaultPath> = observed
        .iter()
        .filter(|entry| entry.kind == TreeEntryKind::File && entry.path.is_base())
        .map(|entry| entry.path.clone())
        .collect();
    let settled = files
        .iter()
        .filter(|path| !moved.contains(path))
        .cloned()
        .collect();
    BaseCandidates {
        files,
        absent: BTreeSet::new(),
        settled,
        complete: true,
    }
}

/// Whether `path` is a base file in the tree right now — what the walk would
/// list. A folder named `X.base`, a symlink and an absent path are not.
pub(crate) fn is_base_file(
    source: &dyn ReconcileSource,
    path: &VaultPath,
) -> Result<bool, IndexError> {
    Ok(source
        .tree_entry(path)?
        .is_some_and(|entry| entry.kind == TreeEntryKind::File))
}

/// The candidates a hint gives: each hinted, non-hidden `.base` path is a
/// file when its tree entry says so, and absent otherwise.
pub(crate) fn hint_candidates(
    source: &dyn ReconcileSource,
    hinted: &BTreeSet<VaultPath>,
) -> Result<BaseCandidates, IndexError> {
    let mut candidates = BaseCandidates::default();
    for path in hinted {
        if !path.is_base() || path.is_hidden() {
            continue;
        }
        if is_base_file(source, path)? {
            candidates.files.insert(path.clone());
        } else {
            candidates.absent.insert(path.clone());
        }
    }
    Ok(candidates)
}

/// Whether a stored revision marks a file that could not be read as text
/// (stored with no bytes). Every parser generation writes the same marker.
pub(crate) fn revision_is_unreadable(revision: &str) -> bool {
    revision.contains(" unreadable:")
}
