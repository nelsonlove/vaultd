use thiserror::Error;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct VaultPath(String);

impl VaultPath {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = value.into();
        let invalid = value.is_empty()
            || value.starts_with('/')
            || value.contains('\\')
            || value
                .split('/')
                .any(|part| part.is_empty() || part == ".." || part == ".");
        if invalid {
            return Err(DomainError::InvalidVaultPath(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether the vault scan excludes this path for being hidden: any
    /// component *but the last* starting with a dot.
    ///
    /// The last component is deliberately not tested here, because the answer
    /// depends on what it is: a hidden *directory* is excluded, a hidden
    /// *file* (`.hidden-note.md`) is not, and nothing lexical can tell them
    /// apart. A caller that has stat-ed the path applies the directory half
    /// itself.
    pub fn is_hidden(&self) -> bool {
        let mut components = self.0.split('/').peekable();
        while let Some(component) = components.next() {
            if components.peek().is_none() {
                return false;
            }
            if component.starts_with('.') {
                return true;
            }
        }
        false
    }

    /// The last component of this path — its file or folder name.
    pub fn name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or(&self.0)
    }

    /// Whether this path names a Markdown note.
    ///
    /// The single spelling of the `.md` test the vault scan, the watcher
    /// filter, and the file-tree kind classification all share, so none of
    /// them can drift from the others.
    pub fn is_markdown(&self) -> bool {
        std::path::Path::new(self.name())
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    }

    /// Whether this path names an Obsidian base (`.base`, any case).
    pub fn is_base(&self) -> bool {
        std::path::Path::new(self.name())
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("base"))
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NoteId(String);

impl NoteId {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = value.into();
        if value.is_empty() {
            return Err(DomainError::EmptyNoteId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Revision(String);

impl Revision {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = value.into();
        if value.is_empty() {
            return Err(DomainError::EmptyRevision);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SourceSpan {
    start: usize,
    end: usize,
}

impl SourceSpan {
    pub fn new(start: usize, end: usize) -> Result<Self, DomainError> {
        if start > end {
            return Err(DomainError::InvalidSourceSpan { start, end });
        }
        Ok(Self { start, end })
    }

    pub fn start(&self) -> usize {
        self.start
    }

    pub fn end(&self) -> usize {
        self.end
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteRef {
    runtime_id: Option<NoteId>,
    path: VaultPath,
    semantic_id: Option<String>,
}

impl NoteRef {
    pub fn new(runtime_id: Option<NoteId>, path: VaultPath, semantic_id: Option<String>) -> Self {
        Self {
            runtime_id,
            path,
            semantic_id,
        }
    }

    pub fn runtime_id(&self) -> Option<&NoteId> {
        self.runtime_id.as_ref()
    }

    pub fn path(&self) -> &VaultPath {
        &self.path
    }

    pub fn semantic_id(&self) -> Option<&str> {
        self.semantic_id.as_deref()
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum DomainError {
    #[error("invalid vault-relative path: {0}")]
    InvalidVaultPath(String),
    #[error("note id cannot be empty")]
    EmptyNoteId,
    #[error("revision cannot be empty")]
    EmptyRevision,
    #[error("source span start {start} exceeds end {end}")]
    InvalidSourceSpan { start: usize, end: usize },
}
