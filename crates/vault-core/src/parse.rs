use crate::frontmatter::parse_frontmatter;
use crate::markdown::parse_markdown;
use crate::obsidian::{scan_property_references, scan_text_ranges};
use crate::{BlockId, ParsedNote, Section, SectionKind, SourceDocument};

/// Parse a document's frontmatter properties and nothing else.
///
/// For a caller that needs properties and has no use for body semantics —
/// `patch_frontmatter` is the one in tree, since a frontmatter edit never
/// looks at the body. It is not only cheaper than [`parse_note`]: the body
/// parse is where arbitrary user content meets an upstream Markdown parser,
/// and a caller with no use for the result should not be exposed to it at
/// all. (`parse_markdown` contains that parser's panics, so this is defence
/// in depth rather than the only guard.)
pub fn parse_properties(document: &SourceDocument) -> Vec<crate::Property> {
    parse_frontmatter(document).properties
}

pub fn parse_note(source: SourceDocument) -> ParsedNote {
    let frontmatter = parse_frontmatter(&source);
    let markdown = parse_markdown(&source, frontmatter.body_start);
    let body = scan_text_ranges(&source, &markdown.text_ranges);
    let (property_references, property_diagnostics) =
        scan_property_references(&source, &frontmatter.properties);

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
    fold_standalone_block_id_sections(&mut note.sections, note.source.text());

    note.list_items = markdown.list_items;

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

/// Fold a `^id` written on a line of its own onto the block it names.
///
/// Obsidian attaches a standalone anchor to the **preceding** block and emits
/// no section for the anchor line itself: `parity-blocks` captures
/// `## Heading followed by a standalone id` (line 4, 79..117) carrying
/// `id: "heading-standalone"` with nothing between it and the next paragraph,
/// and `blocks["heading-standalone"]` reported at the heading's own position.
/// This is the form Obsidian itself writes when a block link is copied from a
/// heading, a table, or a list.
///
/// [`attach_section_block_ids`] already folds the no-blank-line form, where the
/// anchor is a lazy continuation of the paragraph above it and mdast hands back
/// one section covering both lines (`^para-block`, 140..190 in the same
/// capture). The blank-line form reaches mdast as a paragraph of its own, which
/// is the inconsistency this closes.
///
/// The anchor's own [`BlockId`] span is untouched — it still points at the
/// `^id` text, which is where it was written — so a caller that wants the
/// owning block's extent reads it off the section that now declares the id.
///
/// Three shapes decline the fold, and **no capture covers any of them**. Each
/// is left exactly as it parsed before this pass existed, which is the
/// conservative choice where there is no evidence either way:
///
/// - **After a `List`.** A list section never carries a block id — an id
///   written inside a list item surfaces on the `ListItem`
///   (`13-block-ids`) — so folding here would hand the id to a section that
///   cannot declare one. Note that `13-block-ids` settles only the *inline*
///   form; a standalone anchor line after a list is a different shape, and
///   the corpus is silent on it. Both branches are guesses; this one keeps
///   the id reachable on a section of its own.
/// - **After the `yaml` section.** No capture ever shows an `id` on `yaml`,
///   and folding there would report the block at the frontmatter's own span.
/// - **Onto a section that already declares an id.** `Para one. ^inline-id`
///   followed by a standalone `^standalone-id` would otherwise overwrite the
///   inline id and leave it with no declaring section. Both ids keep theirs.
///
/// A section already folded away is never a fold target either: two anchor
/// lines in a row would otherwise put the second id on a section that no
/// longer exists, losing it.
fn fold_standalone_block_id_sections(sections: &mut Vec<Section>, text: &str) {
    let mut folded = vec![false; sections.len()];
    let mut any = false;
    for index in 0..sections.len() {
        let Some(id) = sections[index].block_id.clone() else {
            continue;
        };
        if !matches!(sections[index].kind, SectionKind::Paragraph) {
            continue;
        }
        let Some(slice) = text.get(sections[index].span.start()..sections[index].span.end()) else {
            continue;
        };
        // The whole section is this one anchor and nothing else.
        if slice.trim_end().strip_prefix('^') != Some(id.as_str()) {
            continue;
        }
        let Some(previous) = index.checked_sub(1) else {
            continue;
        };
        if matches!(
            sections[previous].kind,
            SectionKind::List | SectionKind::Yaml
        ) || sections[previous].block_id.is_some()
            || folded[previous]
        {
            continue;
        }
        sections[previous].block_id = Some(id);
        folded[index] = true;
        any = true;
    }
    if !any {
        return;
    }
    let mut index = 0;
    sections.retain(|_| {
        let keep = !folded[index];
        index += 1;
        keep
    });
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
