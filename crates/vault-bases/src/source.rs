use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use vault_core::{PropertyValue, SourceSpan, Spanned, VaultPath};

/// What a row is: a Markdown note (it has properties) or any other file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileKind {
    Note,
    File,
}

/// The file facts every row has, notes and attachments alike.
#[derive(Clone, Debug, PartialEq)]
pub struct FileFacts {
    pub path: VaultPath,
    pub kind: FileKind,
    pub size: u64,
    pub ctime_ms: i64,
    pub mtime_ms: i64,
}

/// One outgoing link or embed, as written and as resolved.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkFact {
    pub raw_target: String,
    pub display: Option<String>,
    pub resolved: Option<VaultPath>,
}

/// A property's declared type, from the vault's `.obsidian/types.json`
/// (Obsidian's property type registry). A date-typed property's text becomes a
/// `Date` value; an undeclared property keeps the type YAML gave it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PropertyType {
    Text,
    Number,
    Checkbox,
    Date,
    DateTime,
    List,
    Tags,
    Aliases,
    Unknown,
}

/// A literal a prefilter compares a property against.
#[derive(Clone, Debug, PartialEq)]
pub enum ScalarLiteral {
    String(String),
    Number(f64),
    Boolean(bool),
}

/// A narrowing a row source can serve from an index before any expression
/// runs. Every prefilter is a **superset** of its conjunct: the conjunct still
/// runs on every row the prefilter admits (see `view::compile_view`).
#[derive(Clone, Debug, PartialEq)]
pub enum Prefilter {
    /// `file.inFolder("…")`: the folder or any subfolder.
    InFolder(String),
    /// `file.hasTag("a", "b")`: any of these tags or a nested tag under one.
    HasTag(Vec<String>),
    /// `file.ext == "…"`.
    Ext(String),
    /// `key == literal` on a note property: notes that carry `key` at all.
    PropertyEquals { key: String, value: ScalarLiteral },
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("row source failed: {0}")]
pub struct SourceError(pub String);

/// Everything evaluation needs to know about the vault. The daemon implements
/// it over its index and live graph inside one generation-consistent read; a
/// test implements it over [`MemorySource`]. Nothing in this crate touches a
/// file, a database or a graph except through these nine methods.
pub trait RowSource {
    /// Every file a view may show, in path order, narrowed by `prefilters`
    /// (a conjunction). An empty slice is every file in the vault.
    fn candidates(&self, prefilters: &[Prefilter]) -> Result<Vec<VaultPath>, SourceError>;
    fn facts(&self, path: &VaultPath) -> Result<Option<FileFacts>, SourceError>;
    /// A note's frontmatter properties in document order; empty for a file.
    fn properties(&self, path: &VaultPath) -> Result<Vec<(String, PropertyValue)>, SourceError>;
    /// A note's tags, frontmatter and body, without `#`, as written.
    fn tags(&self, path: &VaultPath) -> Result<Vec<String>, SourceError>;
    /// Outgoing links that are not embeds, body and frontmatter.
    fn links(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError>;
    fn embeds(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError>;
    /// Every file whose links or embeds resolve to `path`, in path order.
    fn backlinks(&self, path: &VaultPath) -> Result<Vec<VaultPath>, SourceError>;
    /// Resolve a link target as written in `from`, by the vault's own rules.
    fn resolve(&self, from: &VaultPath, target: &str) -> Result<Option<VaultPath>, SourceError>;
    fn property_type(&self, key: &str) -> Option<PropertyType>;
}

/// One file in a [`MemorySource`].
#[derive(Clone, Debug)]
pub struct MemoryFile {
    kind: FileKind,
    size: u64,
    ctime_ms: i64,
    mtime_ms: i64,
    properties: Vec<(String, PropertyValue)>,
    tags: Vec<String>,
    links: Vec<String>,
    embeds: Vec<String>,
}

impl MemoryFile {
    pub fn note() -> Self {
        Self {
            kind: FileKind::Note,
            size: 0,
            ctime_ms: 0,
            mtime_ms: 0,
            properties: Vec::new(),
            tags: Vec::new(),
            links: Vec::new(),
            embeds: Vec::new(),
        }
    }

    pub fn attachment(size: u64) -> Self {
        Self {
            kind: FileKind::File,
            size,
            ..Self::note()
        }
    }

    pub fn property(mut self, key: &str, value: PropertyValue) -> Self {
        self.properties.push((key.to_string(), value));
        self
    }

    pub fn tag(mut self, tag: &str) -> Self {
        self.tags.push(tag.trim_start_matches('#').to_string());
        self
    }

    pub fn link(mut self, target: &str) -> Self {
        self.links.push(target.to_string());
        self
    }

    pub fn embed(mut self, target: &str) -> Self {
        self.embeds.push(target.to_string());
        self
    }

    pub fn times(mut self, ctime_ms: i64, mtime_ms: i64) -> Self {
        self.ctime_ms = ctime_ms;
        self.mtime_ms = mtime_ms;
        self
    }

    pub fn size(mut self, size: u64) -> Self {
        self.size = size;
        self
    }
}

/// An in-memory vault for tests: no I/O, resolution by the stages
/// `vault_core::Resolver` uses — a same-file link (`[[#heading]]`) is the
/// writing note; a `./` or `../` link is an exact path relative to the
/// writing note's folder (nothing when it climbs above the root); otherwise
/// an exact path, path plus `.md`, or a unique case-insensitive file name or
/// stem. An ambiguous name resolves to nothing here, as it does there.
///
/// It also records what it was asked ([`MemorySource::log`]), so a test can
/// show that a prefilter narrowed the rows the source had to read, not only
/// that the answer was right. A clone shares the record.
#[derive(Clone, Debug, Default)]
pub struct MemorySource {
    files: BTreeMap<VaultPath, MemoryFile>,
    types: BTreeMap<String, PropertyType>,
    log: Arc<Mutex<SourceLog>>,
}

/// What a [`MemorySource`] was asked, since it was built or last cleared.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceLog {
    /// The prefilters of every `candidates` call, in call order.
    pub candidates: Vec<Vec<Prefilter>>,
    /// Every path a per-file question (`facts`, `properties`, `tags`,
    /// `links`, `embeds`, `backlinks`) was asked about.
    pub rows_read: BTreeSet<VaultPath>,
}

/// A folder argument as `file.inFolder` reads it: without leading or
/// trailing `/`, so `"/Notes/"` and `"Notes"` name the same folder and `""`
/// is the vault root. The prefilter extractor and [`MemorySource`] use it,
/// so a prefilter admits exactly the folder its conjunct tests.
pub(crate) fn folder_key(folder: &str) -> &str {
    folder.trim_matches('/')
}

/// A text property value with an empty span — the span is never read by
/// evaluation.
pub fn text(value: &str) -> PropertyValue {
    PropertyValue::String(value.to_string())
}

pub fn number(value: f64) -> PropertyValue {
    PropertyValue::Float(value)
}

/// An empty span, for building spanned values by hand.
pub fn no_span<T>(value: T) -> Spanned<T> {
    Spanned::new(
        value,
        SourceSpan::new(0, 0).expect("an empty span is ordered"),
    )
}

fn vault_path(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap_or_else(|error| panic!("{path:?}: {error}"))
}

impl MemorySource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, path: &str, file: MemoryFile) -> Self {
        self.files.insert(vault_path(path), file);
        self
    }

    pub fn typed(mut self, key: &str, kind: PropertyType) -> Self {
        self.types.insert(key.to_string(), kind);
        self
    }

    /// What this source has been asked so far.
    pub fn log(&self) -> SourceLog {
        self.record().clone()
    }

    /// Forget what this source has been asked.
    pub fn clear_log(&self) {
        *self.record() = SourceLog::default();
    }

    fn record(&self) -> std::sync::MutexGuard<'_, SourceLog> {
        self.log
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn file(&self, path: &VaultPath) -> Option<&MemoryFile> {
        self.record().rows_read.insert(path.clone());
        self.files.get(path)
    }

    fn lookup(&self, from: &VaultPath, target: &str) -> Option<VaultPath> {
        let spelled = target
            .trim_start_matches("[[")
            .trim_end_matches("]]")
            .split('|')
            .next()
            .unwrap_or_default();
        let file_part = spelled.split('#').next().unwrap_or_default();
        // A same-file link (`[[#heading]]`) is the note that wrote it.
        if file_part.is_empty() {
            return spelled.starts_with('#').then(|| from.clone());
        }
        // `./` and `../` are relative to the writing note's folder, and only
        // an exact path (or path plus `.md`) answers them.
        if file_part.starts_with("./") || file_part.starts_with("../") {
            let relative = relative_to(from, file_part)?;
            return [relative.clone(), format!("{relative}.md")]
                .into_iter()
                .filter_map(|spelling| VaultPath::new(spelling).ok())
                .find(|path| self.files.contains_key(path));
        }
        for spelling in [file_part.to_string(), format!("{file_part}.md")] {
            if let Ok(path) = VaultPath::new(spelling) {
                if self.files.contains_key(&path) {
                    return Some(path);
                }
            }
        }
        let wanted = file_part.to_lowercase();
        let mut matches = self.files.keys().filter(|path| {
            let name = path.name().to_lowercase();
            name == wanted || name.strip_suffix(".md") == Some(wanted.as_str())
        });
        let first = matches.next()?.clone();
        matches.next().is_none().then_some(first)
    }

    fn admits(&self, path: &VaultPath, file: &MemoryFile, prefilter: &Prefilter) -> bool {
        match prefilter {
            Prefilter::InFolder(folder) => {
                let folder = folder_key(folder);
                folder.is_empty() || path.as_str().starts_with(&format!("{folder}/"))
            }
            Prefilter::HasTag(tags) => file.tags.iter().any(|have| {
                let have = have.to_lowercase();
                tags.iter().any(|want| {
                    let want = want.trim_start_matches('#').to_lowercase();
                    have == want || have.starts_with(&format!("{want}/"))
                })
            }),
            Prefilter::Ext(ext) => crate::source::extension(path) == ext.as_str(),
            Prefilter::PropertyEquals { key, .. } => {
                file.properties.iter().any(|(have, _)| have == key)
            }
        }
    }
}

/// `spelling` (`./x` or `../x`) against the folder of `from`, as
/// `vault_core`'s resolver normalises it; `None` above the vault root.
fn relative_to(from: &VaultPath, spelling: &str) -> Option<String> {
    let mut stack: Vec<&str> = from.as_str().split('/').collect();
    stack.pop();
    for component in spelling.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                stack.pop()?;
            }
            component => stack.push(component),
        }
    }
    if stack.is_empty() {
        return None;
    }
    Some(stack.join("/"))
}

/// A path's extension without the dot, `""` when it has none — the same
/// definition `file.ext` uses.
pub fn extension(path: &VaultPath) -> &str {
    let name = path.name();
    match name.rfind('.') {
        Some(0) | None => "",
        Some(dot) => &name[dot + 1..],
    }
}

impl RowSource for MemorySource {
    fn candidates(&self, prefilters: &[Prefilter]) -> Result<Vec<VaultPath>, SourceError> {
        self.record().candidates.push(prefilters.to_vec());
        Ok(self
            .files
            .iter()
            .filter(|(path, file)| prefilters.iter().all(|p| self.admits(path, file, p)))
            .map(|(path, _)| path.clone())
            .collect())
    }

    fn facts(&self, path: &VaultPath) -> Result<Option<FileFacts>, SourceError> {
        Ok(self.file(path).map(|file| FileFacts {
            path: path.clone(),
            kind: file.kind,
            size: file.size,
            ctime_ms: file.ctime_ms,
            mtime_ms: file.mtime_ms,
        }))
    }

    fn properties(&self, path: &VaultPath) -> Result<Vec<(String, PropertyValue)>, SourceError> {
        Ok(self
            .file(path)
            .map(|file| file.properties.clone())
            .unwrap_or_default())
    }

    fn tags(&self, path: &VaultPath) -> Result<Vec<String>, SourceError> {
        Ok(self
            .file(path)
            .map(|file| file.tags.clone())
            .unwrap_or_default())
    }

    fn links(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError> {
        Ok(self
            .file(path)
            .map(|file| {
                file.links
                    .iter()
                    .map(|target| LinkFact {
                        raw_target: target.clone(),
                        display: None,
                        resolved: self.lookup(path, target),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn embeds(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError> {
        Ok(self
            .file(path)
            .map(|file| {
                file.embeds
                    .iter()
                    .map(|target| LinkFact {
                        raw_target: target.clone(),
                        display: None,
                        resolved: self.lookup(path, target),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn backlinks(&self, path: &VaultPath) -> Result<Vec<VaultPath>, SourceError> {
        self.record().rows_read.insert(path.clone());
        Ok(self
            .files
            .iter()
            .filter(|(source, file)| {
                file.links
                    .iter()
                    .chain(file.embeds.iter())
                    .any(|target| self.lookup(source, target).as_ref() == Some(path))
            })
            .map(|(source, _)| source.clone())
            .collect())
    }

    fn resolve(&self, from: &VaultPath, target: &str) -> Result<Option<VaultPath>, SourceError> {
        Ok(self.lookup(from, target))
    }

    fn property_type(&self, key: &str) -> Option<PropertyType> {
        self.types.get(key).copied()
    }
}
