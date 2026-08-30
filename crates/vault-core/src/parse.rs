use crate::frontmatter::parse_frontmatter;
use crate::markdown::parse_markdown;
use crate::obsidian::{scan_property_wikilinks, scan_text_ranges};
use crate::{BlockId, ParsedNote, Section, SectionKind, SourceDocument};

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

    note.sections = Vec::with_capacity(markdown.sections.len() + 1);
    if let Some(span) = frontmatter.frontmatter_span {
        note.sections.push(Section {
            kind: SectionKind::Yaml,
            span,
            block_id: None,
        });
    }
    note.sections.extend(markdown.sections);
    attach_section_block_ids(&mut note.sections, &note.blocks);

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

/// Carry a trailing `^id` through to the owning top-level section, reusing
/// the block-id spans `ParsedNote.blocks` already has (never re-parsing
/// them). Matches captured Obsidian behavior: a block id nested inside a
/// list item surfaces on the `ListItem`, never on the enclosing `list`
/// section (see `tests/fixtures/structural/README.md`, case
/// `13-block-ids`) — so `List` sections are skipped here entirely.
fn attach_section_block_ids(sections: &mut [Section], blocks: &[BlockId]) {
    for section in sections.iter_mut() {
        if matches!(section.kind, SectionKind::List) {
            continue;
        }
        section.block_id = blocks
            .iter()
            .filter(|block| {
                block.span.start() >= section.span.start() && block.span.end() <= section.span.end()
            })
            .max_by_key(|block| block.span.start())
            .map(|block| block.value.clone());
    }
}
