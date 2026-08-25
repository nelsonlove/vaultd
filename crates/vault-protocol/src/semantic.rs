use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SpanDto {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum PropertyValueDto {
    Null,
    Boolean(bool),
    Integer(i64),
    Float(String),
    String(String),
    Sequence(Vec<SpannedPropertyValueDto>),
    Mapping(Vec<PropertyMappingEntryDto>),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SpannedPropertyValueDto {
    pub value: PropertyValueDto,
    pub span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PropertyMappingEntryDto {
    pub key: String,
    pub key_span: SpanDto,
    pub value: SpannedPropertyValueDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PropertyDto {
    pub key: String,
    pub value: PropertyValueDto,
    pub span: SpanDto,
    pub key_span: SpanDto,
    pub value_span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AliasDto {
    pub value: String,
    pub span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HeadingDto {
    pub level: u8,
    pub text: String,
    pub span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlockDto {
    pub value: String,
    pub span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TagDto {
    pub value: String,
    pub comparison_key: String,
    pub span: SpanDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKindDto {
    MarkdownLink,
    Wikilink,
    MarkdownEmbed,
    WikiEmbed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceOriginDto {
    Body,
    Property,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SubpathDto {
    Heading(String),
    Block(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolutionDto {
    Resolved {
        target: String,
        subpath: Option<SubpathDto>,
    },
    MissingSubpath {
        target: String,
        subpath: SubpathDto,
    },
    Unresolved,
    Ambiguous {
        candidates: Vec<String>,
    },
    NonVault,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReferenceDto {
    pub source_path: String,
    pub kind: ReferenceKindDto,
    pub origin: ReferenceOriginDto,
    pub raw_target: String,
    pub file_target: Option<String>,
    pub subpath: Option<SubpathDto>,
    pub display: Option<String>,
    pub span: SpanDto,
    pub target_span: SpanDto,
    pub resolution: ResolutionDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeverityDto {
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DiagnosticDto {
    pub code: String,
    pub severity: SeverityDto,
    pub message: String,
    pub path: Option<String>,
    pub span: Option<SpanDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "value", rename_all = "snake_case")]
pub enum IndexStateDto {
    Ready,
    Stale { last_error: String },
    Unavailable { last_error: Option<String> },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NoteSummaryDto {
    pub path: String,
    pub revision: String,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NoteDto {
    pub path: String,
    pub revision: String,
    pub source: String,
    pub properties: Vec<PropertyDto>,
    pub aliases: Vec<AliasDto>,
    pub headings: Vec<HeadingDto>,
    pub blocks: Vec<BlockDto>,
    pub tags: Vec<TagDto>,
    pub diagnostics: Vec<DiagnosticDto>,
    pub outgoing: Vec<ReferenceDto>,
}

impl NoteDto {
    /// Test-only constructor with one heading and otherwise empty
    /// collections. Every real field is initialized; nothing bypasses
    /// serialization.
    #[doc(hidden)]
    pub fn empty_for_test(
        path: impl Into<String>,
        revision: impl Into<String>,
        source: impl Into<String>,
        heading_span: SpanDto,
    ) -> Self {
        let source = source.into();
        Self {
            path: path.into(),
            revision: revision.into(),
            source,
            properties: Vec::new(),
            aliases: Vec::new(),
            headings: vec![HeadingDto {
                level: 1,
                text: "Note".into(),
                span: heading_span,
            }],
            blocks: Vec::new(),
            tags: Vec::new(),
            diagnostics: Vec::new(),
            outgoing: Vec::new(),
        }
    }
}
