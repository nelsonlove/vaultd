use crate::frontmatter::parse_frontmatter;
use crate::{ParsedNote, SourceDocument};

pub fn parse_note(source: SourceDocument) -> ParsedNote {
    let frontmatter = parse_frontmatter(&source);
    let mut note = ParsedNote::empty(source);
    note.properties = frontmatter.properties;
    note.aliases = frontmatter.aliases;
    note.tags = frontmatter.tags;
    note.diagnostics = frontmatter.diagnostics;
    note
}
