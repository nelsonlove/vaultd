//! The documents a query is evaluated against.

use std::ops::Range;

use vault_core::VaultPath;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum DocumentKind {
    Note,
    /// Reserved: never produced in this phase (Ruling 4, issue #3).
    Canvas,
    File,
}

/// One tag of a note: its value without `#`, that value folded as
/// JavaScript's `toLowerCase` folds it ([`crate::text::fold_js`], which is
/// the index's stored `comparison_key`), and its byte span in the text.
/// `tag:` matches on `folded`, so a search folds no tag.
#[derive(Clone, Debug, PartialEq)]
pub struct TagFact {
    pub value: String,
    pub folded: String,
    pub span: Range<usize>,
}

impl TagFact {
    /// A tag whose fold is computed here.
    pub fn new(value: &str, span: Range<usize>) -> Self {
        TagFact {
            value: value.to_owned(),
            folded: crate::text::fold_js(value),
            span,
        }
    }
}

/// What a query reads of one file.
pub trait SearchDocument {
    fn path(&self) -> &VaultPath;
    fn kind(&self) -> DocumentKind;
    /// The searchable text; `None` for a non-note file, or when not loaded.
    fn text(&self) -> Option<&str>;
    fn tags(&self) -> &[TagFact];
}

/// An in-memory document, for tests and for callers that hold the facts.
#[derive(Clone, Debug)]
pub struct MemoryDocument {
    pub path: VaultPath,
    pub kind: DocumentKind,
    pub text: Option<String>,
    pub tags: Vec<TagFact>,
}

impl MemoryDocument {
    /// A note with its text. Panics on an invalid vault path.
    pub fn note(path: &str, text: &str) -> Self {
        MemoryDocument {
            path: VaultPath::new(path).expect("a valid vault path"),
            kind: DocumentKind::Note,
            text: Some(text.to_owned()),
            tags: Vec::new(),
        }
    }

    /// A non-note file, which has no searchable text. Panics on an invalid
    /// vault path.
    pub fn file(path: &str) -> Self {
        MemoryDocument {
            path: VaultPath::new(path).expect("a valid vault path"),
            kind: DocumentKind::File,
            text: None,
            tags: Vec::new(),
        }
    }

    /// The same document with one more tag.
    pub fn with_tag(mut self, value: &str, span: Range<usize>) -> Self {
        self.tags.push(TagFact::new(value, span));
        self
    }
}

impl SearchDocument for MemoryDocument {
    fn path(&self) -> &VaultPath {
        &self.path
    }

    fn kind(&self) -> DocumentKind {
        self.kind
    }

    fn text(&self) -> Option<&str> {
        self.text.as_deref()
    }

    fn tags(&self) -> &[TagFact] {
        &self.tags
    }
}

/// The file name: the last path segment, extension included.
pub(crate) fn file_name(path: &VaultPath) -> &str {
    let path = path.as_str();
    match path.rfind('/') {
        Some(at) => &path[at + 1..],
        None => path,
    }
}
