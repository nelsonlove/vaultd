mod domain;
mod source;

pub use domain::{DomainError, NoteId, NoteRef, Revision, SourceSpan, VaultPath};
pub use source::{SourceDocument, SourceError, Spanned};
