use crate::{Diagnostic, Property, PropertyValue, SourceDocument, SourceSpan, Spanned};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub span: SourceSpan,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockId {
    pub value: String,
    pub span: SourceSpan,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Tag {
    pub value: String,
    pub comparison_key: String,
    pub span: SourceSpan,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Alias {
    pub value: String,
    pub span: SourceSpan,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ReferenceKind {
    MarkdownLink,
    Wikilink,
    MarkdownEmbed,
    WikiEmbed,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ReferenceOrigin {
    Body,
    Property,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Subpath {
    Heading(String),
    Block(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reference {
    pub kind: ReferenceKind,
    pub origin: ReferenceOrigin,
    pub raw_target: String,
    pub file_target: Option<String>,
    pub subpath: Option<Subpath>,
    pub display: Option<String>,
    pub span: SourceSpan,
    pub target_span: SourceSpan,
}

/// The vocabulary Obsidian's `CachedMetadata.sections[].type` emits, captured
/// from a live Obsidian 1.13.4 (see
/// `tests/fixtures/structural/README.md`), plus `Other` so an unrecognized
/// kind is preserved rather than dropped.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SectionKind {
    Yaml,
    Heading,
    Paragraph,
    Code,
    Blockquote,
    Table,
    ThematicBreak,
    List,
    Callout,
    Html,
    Other(String),
}

/// One top-level block, in document order. Mirrors an entry of Obsidian's
/// `CachedMetadata.sections`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Section {
    pub kind: SectionKind,
    pub span: SourceSpan,
    pub block_id: Option<String>,
}

/// Obsidian's `listItems[].parent` convention, modeled as a type instead of
/// the sign trick `obsidian.d.ts` uses: a nested item carries its parent
/// item's own start line (positive); a top-level item carries the negated
/// start line of its containing list. Both line numbers are 0-based source
/// lines.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ListItemParent {
    Root { list_start_line: u32 },
    Item { parent_start_line: u32 },
}

/// One list item, in document order. Mirrors an entry of Obsidian's
/// `CachedMetadata.listItems`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListItem {
    pub span: SourceSpan,
    pub parent: ListItemParent,
    pub task: Option<char>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedNote {
    pub source: SourceDocument,
    pub properties: Vec<Property>,
    pub aliases: Vec<Alias>,
    pub headings: Vec<Heading>,
    pub blocks: Vec<BlockId>,
    pub tags: Vec<Tag>,
    pub references: Vec<Reference>,
    pub sections: Vec<Section>,
    pub list_items: Vec<ListItem>,
    pub diagnostics: Vec<Diagnostic>,
}

impl ParsedNote {
    pub fn empty(source: SourceDocument) -> Self {
        Self {
            source,
            properties: Vec::new(),
            aliases: Vec::new(),
            headings: Vec::new(),
            blocks: Vec::new(),
            tags: Vec::new(),
            references: Vec::new(),
            sections: Vec::new(),
            list_items: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    pub fn source_spans(&self) -> Vec<SourceSpan> {
        fn value_spans(value: &Spanned<PropertyValue>, spans: &mut Vec<SourceSpan>) {
            spans.push(value.span);
            match &value.value {
                PropertyValue::Sequence(values) => {
                    for value in values {
                        value_spans(value, spans);
                    }
                }
                PropertyValue::Mapping(entries) => {
                    for (key, value) in entries {
                        spans.push(key.span);
                        value_spans(value, spans);
                    }
                }
                _ => {}
            }
        }

        let mut spans = Vec::new();
        for property in &self.properties {
            spans.extend([property.span, property.key.span]);
            value_spans(&property.value, &mut spans);
        }
        spans.extend(self.aliases.iter().map(|value| value.span));
        spans.extend(self.headings.iter().map(|value| value.span));
        spans.extend(self.blocks.iter().map(|value| value.span));
        spans.extend(self.tags.iter().map(|value| value.span));
        for reference in &self.references {
            spans.extend([reference.span, reference.target_span]);
        }
        spans.sort_unstable();
        spans.dedup();
        spans
    }
}
