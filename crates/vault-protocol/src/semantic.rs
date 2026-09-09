use serde::{Deserialize, Serialize};

use crate::snapshots::{ListItemDto, SectionDto};

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

/// One note in full: its bytes, its metadata, and its outgoing references.
///
/// `sections` and `list_items` are the two **structural** row-sets, and the
/// only two fields here a caller has to ask for: they are present exactly when
/// the request's `include` named them, `Some(vec![])` when named and empty,
/// and absent otherwise. That is the snapshot pager's own convention — absent
/// is not empty, so "I did not ask" and "there are none" stay distinguishable —
/// carried onto the per-note read so a mirror can refetch one note's structure
/// after an edit without paging the whole vault. Every other field is
/// unconditional, and a request that names no facet serializes byte-identically
/// to what this operation has always answered.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<Vec<SectionDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_items: Option<Vec<ListItemDto>>,
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
            // The structural facets are opt-in, and this constructor asks for
            // nothing: `None` is "not requested", which is what a caller that
            // named no facet gets.
            sections: None,
            list_items: None,
        }
    }
}
