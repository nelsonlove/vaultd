mod diagnostic;
mod domain;
mod frontmatter;
mod parse;
mod property;
mod semantic;
mod source;

pub use diagnostic::{Diagnostic, DiagnosticCode, Severity};
pub use domain::{DomainError, NoteId, NoteRef, Revision, SourceSpan, VaultPath};
pub use parse::parse_note;
pub use property::{Property, PropertyValue};
pub use semantic::{
    Alias, BlockId, Heading, ParsedNote, Reference, ReferenceKind, ReferenceOrigin, Subpath, Tag,
};
pub use source::{SourceDocument, SourceError, Spanned};
