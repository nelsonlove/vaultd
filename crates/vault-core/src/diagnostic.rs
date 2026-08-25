use crate::{SourceSpan, VaultPath};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Severity {
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum DiagnosticCode {
    InaccessibleVaultRoot,
    UnreadableFile,
    InvalidUtf8,
    SymlinkOutsideVault,
    UnterminatedFrontmatter,
    MalformedFrontmatter,
    UnsupportedPropertyShape,
    MarkdownParseError,
    MalformedWikilink,
    MalformedTag,
    MalformedBlockId,
    UnresolvedReference,
    AmbiguousReference,
    MissingHeading,
    MissingBlock,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub severity: Severity,
    pub message: String,
    pub path: Option<VaultPath>,
    pub span: Option<SourceSpan>,
}

impl Diagnostic {
    pub fn new(code: DiagnosticCode, severity: Severity, message: impl Into<String>) -> Self {
        Self {
            code,
            severity,
            message: message.into(),
            path: None,
            span: None,
        }
    }

    pub fn with_path(mut self, path: VaultPath) -> Self {
        self.path = Some(path);
        self
    }

    pub fn with_span(mut self, span: SourceSpan) -> Self {
        self.span = Some(span);
        self
    }
}
