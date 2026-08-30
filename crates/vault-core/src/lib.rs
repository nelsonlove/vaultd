mod dependency;
mod diagnostic;
mod domain;
mod frontmatter;
mod graph;
mod markdown;
mod obsidian;
mod parse;
mod property;
mod resolver;
mod semantic;
mod source;
mod vault_source;

pub use dependency::{
    DependencyKey, DependencyKind, ResolutionIdentityChange, changed_candidate_keys,
    reference_dependencies,
};
pub use diagnostic::{Diagnostic, DiagnosticCode, Severity};
pub use domain::{DomainError, NoteId, NoteRef, Revision, SourceSpan, VaultPath};
pub use graph::{ScanReport, SemanticGraph, build_graph, scan_vault};
pub use parse::parse_note;
pub use property::{Property, PropertyValue};
pub use resolver::{
    LinkTarget, Resolution, ResolutionNote, ResolvedReference, Resolver, resolution_diagnostic,
};
pub use semantic::{
    Alias, BlockId, Heading, ListItem, ListItemParent, ParsedNote, Reference, ReferenceKind,
    ReferenceOrigin, Section, SectionKind, Subpath, Tag,
};
pub use source::{SourceDocument, SourceError, Spanned};
pub use vault_source::{
    FileSystemVaultSource, ScanError, VaultDocuments, VaultListing, VaultSource, read_documents,
};
