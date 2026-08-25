use crate::frontmatter::parse_frontmatter;
use crate::markdown::parse_markdown;
use crate::{ParsedNote, SourceDocument};

pub fn parse_note(source: SourceDocument) -> ParsedNote {
    let frontmatter = parse_frontmatter(&source);
    let markdown = parse_markdown(&source, frontmatter.body_start);

    let mut note = ParsedNote::empty(source);
    note.properties = frontmatter.properties;
    note.aliases = frontmatter.aliases;
    note.tags = frontmatter.tags;
    note.headings = markdown.headings;
    note.references = markdown.references;
    note.diagnostics = frontmatter.diagnostics;
    note.diagnostics.extend(markdown.diagnostics);
    note
}
