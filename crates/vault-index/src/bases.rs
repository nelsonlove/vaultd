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
use vault_core::{ResolutionNote, ScanError, SourceDocument, VaultPath};

use crate::error::IndexError;
use crate::inventory::ReconcileSource;
use crate::model::FileFingerprint;

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
    pub fn is_empty(&self) -> bool {
        self.replaced.is_empty() && self.removed.is_empty()
    }

    pub fn paths(&self) -> BTreeSet<VaultPath> {
        self.replaced
            .iter()
            .map(|replacement| replacement.path.clone())
            .chain(self.removed.iter().cloned())
            .collect()
    }
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
    let (text, record): (Arc<str>, BaseRecord) = match source.read_bytes(path) {
        Ok(bytes) => match SourceDocument::from_utf8(path.clone(), bytes) {
            Ok(document) => {
                let text: Arc<str> = document.text().into();
                let record = BaseRecord::parse(&text);
                (text, record)
            }
            Err(error) => (Arc::from(""), BaseRecord::unreadable(error.to_string())),
        },
        Err(ScanError::UnreadableFile { message, .. }) => {
            (Arc::from(""), BaseRecord::unreadable(message))
        }
        Err(ScanError::InaccessibleRoot { message }) => {
            return Err(IndexError::InvalidVaultRoot(message));
        }
    };
    if source.fingerprint(path)? != Some(before) {
        return Err(IndexError::VaultChangedDuringRefresh);
    }
    let revision = SourceDocument::new(path.clone(), text.clone())
        .revision()
        .as_str()
        .to_string();
    Ok(Some(BaseReplacement {
        path: path.clone(),
        revision,
        source: text,
        fingerprint: before,
        record,
    }))
}

/// The delta that brings `stored` to what is on disk for `candidates` (the
/// bases the walk saw, or the base paths a hint named). A candidate whose
/// revision did not move is left alone; a stored base that is not on disk is
/// removed. `complete` also removes every stored base the candidates do not
/// name; `verify` re-reads even an unchanged fingerprint.
///
/// A revision-identical re-read with a new fingerprint (a `touch`) is
/// dropped: its stored fingerprint stays stale until the next content
/// change, which costs one extra read per touched base per complete refresh
/// and never publishes a generation.
pub(crate) fn plan(
    source: &dyn ReconcileSource,
    stored: &BTreeMap<VaultPath, (String, FileFingerprint)>,
    candidates: &BTreeSet<VaultPath>,
    complete: bool,
    verify: bool,
) -> Result<BaseDelta, IndexError> {
    let mut delta = BaseDelta::default();
    for path in candidates {
        if !path.is_base() || path.is_hidden() {
            continue;
        }
        let known = stored.get(path);
        if !verify {
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
                    delta.removed.push(path.clone());
                }
            }
        }
    }
    if complete {
        for path in stored.keys() {
            if !candidates.contains(path) {
                delta.removed.push(path.clone());
            }
        }
    }
    Ok(delta)
}
