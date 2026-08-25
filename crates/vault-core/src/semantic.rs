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

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedNote {
    pub source: SourceDocument,
    pub properties: Vec<Property>,
    pub aliases: Vec<Alias>,
    pub headings: Vec<Heading>,
    pub blocks: Vec<BlockId>,
    pub tags: Vec<Tag>,
    pub references: Vec<Reference>,
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
