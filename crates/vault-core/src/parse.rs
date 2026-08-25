use crate::frontmatter::parse_frontmatter;
use crate::markdown::parse_markdown;
use crate::obsidian::{scan_property_wikilinks, scan_text_ranges};
use crate::{ParsedNote, SourceDocument};

pub fn parse_note(source: SourceDocument) -> ParsedNote {
    let frontmatter = parse_frontmatter(&source);
    let markdown = parse_markdown(&source, frontmatter.body_start);
    let body = scan_text_ranges(&source, &markdown.text_ranges);
    let (property_references, property_diagnostics) =
        scan_property_wikilinks(&source, &frontmatter.properties);

    let mut note = ParsedNote::empty(source);
    note.properties = frontmatter.properties;
    note.aliases = frontmatter.aliases;
    note.headings = markdown.headings;
    note.blocks = body.blocks;

    note.tags = frontmatter.tags;
    note.tags.extend(body.tags);

    note.references = markdown.references;
    note.references.extend(body.references);
    note.references.extend(property_references);

    note.diagnostics = frontmatter.diagnostics;
    note.diagnostics.extend(markdown.diagnostics);
    note.diagnostics.extend(body.diagnostics);
    note.diagnostics.extend(property_diagnostics);
    for diagnostic in &mut note.diagnostics {
        if diagnostic.path.is_none() {
            diagnostic.path = Some(note.source.path().clone());
        }
    }

    note.aliases
        .sort_by(|a, b| (a.span, &a.value).cmp(&(b.span, &b.value)));
    note.aliases.dedup();
    note.headings
        .sort_by(|a, b| (a.span, &a.text, a.level).cmp(&(b.span, &b.text, b.level)));
    note.headings.dedup();
    note.blocks
        .sort_by(|a, b| (a.span, &a.value).cmp(&(b.span, &b.value)));
    note.blocks.dedup();
    note.tags
        .sort_by(|a, b| (a.span, &a.value).cmp(&(b.span, &b.value)));
    note.tags.dedup();
    note.references.sort_by(|a, b| {
        (a.span, a.target_span, a.kind, a.origin, &a.raw_target).cmp(&(
            b.span,
            b.target_span,
            b.kind,
            b.origin,
            &b.raw_target,
        ))
    });
    note.references.dedup();
    note.diagnostics
        .sort_by(|a, b| (a.span, a.code, &a.message).cmp(&(b.span, b.code, &b.message)));
    note.diagnostics.dedup();

    note
}
