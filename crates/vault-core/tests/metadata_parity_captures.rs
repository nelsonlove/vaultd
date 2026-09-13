//! Four cases lifted verbatim from the metadata-parity capture corpus
//! (`host/fixtures/metadata-parity/`, captured 2026-09-09 from a live, stock
//! Obsidian 1.13.4 through `app.metadataCache.getFileCache`). Each one pinned
//! a `vault-core` parser defect that the host-side parity run exposed.
//!
//! The source bytes are copied from the fixture files so these tests stand on
//! their own — `vault-core` never reads `host/`. Every expected number below is
//! the captured one. Obsidian counts offsets in **UTF-16 code units** and
//! `vault-core` spans are **bytes**, so the comparison converts vault-core's
//! byte offsets forward into UTF-16 units ([`utf16_offset`]) and never the
//! other way round; for the three all-ASCII cases the two are equal, and
//! `tag_values_keep_unicode_symbols` is the case where they differ.

use vault_core::{
    ListItemParent, ReferenceKind, ReferenceOrigin, SectionKind, SourceDocument, VaultPath,
    parse_note,
};

fn parse(name: &str, text: &str) -> vault_core::ParsedNote {
    parse_note(SourceDocument::new(
        VaultPath::new(name).expect("fixture name is a valid vault path"),
        text,
    ))
}

/// Convert a byte offset into `source` to a UTF-16 code-unit offset, the unit
/// every captured `position` is written in.
fn utf16_offset(source: &str, byte_offset: usize) -> usize {
    source[..byte_offset].encode_utf16().count()
}

/// `parity-blocks`: a `^id` written on a line of its own after a heading
/// belongs to that heading. Obsidian emits **no** section for the id line and
/// reports `blocks["heading-standalone"]` at the heading's own position
/// (line 4, offset 79) — the same fold `vault-core` already performs after a
/// paragraph (`^para-block`, whose section is 140..190 and covers both lines).
#[test]
fn standalone_block_id_line_folds_onto_the_preceding_heading() {
    let source = "# Heading with inline id ^heading-inline\n\nParagraph before the standalone id.\n\n## Heading followed by a standalone id\n\n^heading-standalone\n\nA paragraph carrying its own block id.\n^para-block\n\n- list item with a block id ^item-block\n- list item without one\n";
    let parsed = parse("parity-blocks.md", source);

    let sections: Vec<(SectionKind, usize, usize, Option<&str>)> = parsed
        .sections
        .iter()
        .map(|section| {
            (
                section.kind.clone(),
                utf16_offset(source, section.span.start()),
                utf16_offset(source, section.span.end()),
                section.block_id.as_deref(),
            )
        })
        .collect();

    assert_eq!(
        sections,
        vec![
            (SectionKind::Heading, 0, 40, Some("heading-inline")),
            (SectionKind::Paragraph, 42, 77, None),
            (SectionKind::Heading, 79, 117, Some("heading-standalone")),
            (SectionKind::Paragraph, 140, 190, Some("para-block")),
            (SectionKind::List, 192, 255, None),
        ],
        "sections must match the captured Obsidian cache exactly"
    );

    // The anchors themselves are still recorded where they are written — the
    // host maps a block id to its owning section, and the standalone anchor at
    // 119..138 is the one whose owner is the heading above it.
    let blocks: Vec<(&str, usize, usize)> = parsed
        .blocks
        .iter()
        .map(|block| {
            (
                block.value.as_str(),
                utf16_offset(source, block.span.start()),
                utf16_offset(source, block.span.end()),
            )
        })
        .collect();
    assert_eq!(
        blocks,
        vec![
            ("heading-inline", 25, 40),
            ("heading-standalone", 119, 138),
            ("para-block", 179, 190),
            ("item-block", 220, 231),
        ]
    );
}

/// One property-borne reference, flattened for comparison: kind, `raw_target`,
/// `file_target`, `display`, and the reference span in UTF-16 code units.
type PropertyReferenceRow<'a> = (
    ReferenceKind,
    &'a str,
    Option<&'a str>,
    Option<&'a str>,
    usize,
    usize,
);

/// `parity-frontmatter-links`: Obsidian reports a Markdown link written in a
/// property value under `frontmatterLinks`, with `link` percent-decoded and
/// keeping its extension (`Parity target.md`), `original` the text as written,
/// and `displayText` the label. `vault-core` scanned property values for
/// wikilinks only, so `related.1` produced no reference at all.
#[test]
fn markdown_links_in_property_values_are_scanned() {
    let source = "---\nrelated:\n  - \"[[Parity target]]\"\n  - \"[Markdown target](Parity%20target.md)\"\nsingle: \"[[Parity target|Alias text]]\"\nplain: not a link\n---\n\nBody paragraph.\n";
    let parsed = parse("parity-frontmatter-links.md", source);

    let property: Vec<PropertyReferenceRow<'_>> = parsed
        .references
        .iter()
        .filter(|reference| reference.origin == ReferenceOrigin::Property)
        .map(|reference| {
            (
                reference.kind,
                reference.raw_target.as_str(),
                reference.file_target.as_deref(),
                reference.display.as_deref(),
                utf16_offset(source, reference.span.start()),
                utf16_offset(source, reference.span.end()),
            )
        })
        .collect();

    assert_eq!(
        property,
        vec![
            (
                ReferenceKind::Wikilink,
                "Parity target",
                Some("Parity target"),
                None,
                18,
                35
            ),
            (
                ReferenceKind::MarkdownLink,
                "Parity%20target.md",
                Some("Parity target.md"),
                Some("Markdown target"),
                42,
                79
            ),
            (
                ReferenceKind::Wikilink,
                "Parity target",
                Some("Parity target"),
                Some("Alias text"),
                90,
                118
            ),
        ],
        "every property-borne reference, in document order"
    );

    let markdown = parsed
        .references
        .iter()
        .find(|reference| reference.kind == ReferenceKind::MarkdownLink)
        .expect("the property Markdown link");
    assert_eq!(
        parsed.source.slice(markdown.span),
        Some("[Markdown target](Parity%20target.md)"),
        "`original` is read back out of this span by the host"
    );
    assert_eq!(
        parsed.source.slice(markdown.target_span),
        Some("Parity%20target.md")
    );

    // The host derives `frontmatterLinks[].key` by containment in a property
    // value's span, so the reference has to fall inside `related`'s second
    // sequence element for the key to read `related.1`.
    let related = parsed
        .properties
        .iter()
        .find(|property| property.key.value == "related")
        .expect("the related property");
    let vault_core::PropertyValue::Sequence(items) = &related.value.value else {
        panic!("related is a sequence");
    };
    assert!(
        items[1].span.start() <= markdown.span.start()
            && markdown.span.end() <= items[1].span.end(),
        "the Markdown link lies inside related.1's value span"
    );
}

/// `parity-list-nested-3deep`: an item nested under an **ordered** parent
/// starts at its own marker (line 10 col 4 / offset 147), not one column early
/// on the last space of the indent. Items nested under an unordered parent
/// keep the two leftover indent columns Obsidian includes there (cols 2 and 6).
#[test]
fn nested_ordered_list_item_spans_start_at_the_marker() {
    let source = "# Nested list\n\n- level one a\n    - level two a\n        - level three a\n        - level three b\n    - level two b\n- level one b\n\n1. ordered one\n    1. ordered two\n        1. ordered three\n";
    let parsed = parse("parity-list-nested-3deep.md", source);

    let items: Vec<(usize, usize, i64)> = parsed
        .list_items
        .iter()
        .map(|item| {
            let parent = match item.parent {
                ListItemParent::Root { list_start_line } => {
                    if list_start_line == 0 {
                        -1
                    } else {
                        -(list_start_line as i64)
                    }
                }
                ListItemParent::Item { parent_start_line } => parent_start_line as i64,
            };
            (
                utf16_offset(source, item.span.start()),
                utf16_offset(source, item.span.end()),
                parent,
            )
        })
        .collect();

    assert_eq!(
        items,
        vec![
            (15, 28, -2),
            (31, 46, 2),
            (53, 70, 3),
            (77, 94, 3),
            (97, 112, 2),
            (113, 126, -2),
            (128, 142, -9),
            (147, 161, 9),
            (170, 186, 10),
        ],
        "every captured list-item position, in document order"
    );
}

/// `parity-tags-nested-unicode`: Obsidian keeps a Unicode **symbol** inside a
/// tag value — `#tag-🙂` is one tag, not `#tag-` — while still ending the tag
/// before the sentence's full stop in `#parent/child/grandchild.`.
#[test]
fn tag_values_keep_unicode_symbols() {
    let source = "Nested depth: #parent/child/grandchild.\n\nAccented: #café and #niño.\n\nCJK: #日本語 and #中文/标签.\n\nEmoji: #tag-🙂 at the end.\n";
    let parsed = parse("parity-tags-nested-unicode.md", source);

    let tags: Vec<(String, usize, usize)> = parsed
        .tags
        .iter()
        .map(|tag| {
            (
                format!("#{}", tag.value),
                utf16_offset(source, tag.span.start()),
                utf16_offset(source, tag.span.end()),
            )
        })
        .collect();

    assert_eq!(
        tags,
        vec![
            ("#parent/child/grandchild".to_string(), 14, 38),
            ("#café".to_string(), 51, 56),
            ("#niño".to_string(), 61, 66),
            ("#日本語".to_string(), 74, 78),
            ("#中文/标签".to_string(), 83, 89),
            ("#tag-🙂".to_string(), 99, 106),
        ],
        "every captured tag value and position"
    );
}

/// The character set the tag scanner accepts, stated as a test so the ruling
/// is visible where it is enforced.
///
/// The capture pins exactly one symbol — U+1F642 inside `#tag-🙂` — so the set
/// is Obsidian's documented one (letters, numbers, `_`, `-`, `/`) **plus the
/// Unicode Symbol categories**, which is the smallest class containing the
/// captured character without admitting a category no evidence supports. It is
/// a category question and not an astral-plane one: `#tag-☺` (U+263A, BMP,
/// category `So`) and `#tag-🙂` (U+1F642, astral, `So`) must behave alike,
/// while `#tag-𝐀` (U+1D400, astral, `Lu`) was always accepted.
///
/// Punctuation stays out: the captured `#parent/child/grandchild.` ends before
/// its full stop, and a tag must not swallow ordinary sentence punctuation.
#[test]
fn tag_character_set_is_the_documented_set_plus_unicode_symbols() {
    let parsed = parse(
        "Tags.md",
        "#tag-☺ #tag-🙂 #tag-𝐀 #tag-a, #tag-b. #tag-c! #tag-d?\n",
    );
    let values: Vec<&str> = parsed.tags.iter().map(|tag| tag.value.as_str()).collect();

    assert_eq!(
        values,
        vec![
            "tag-☺", "tag-🙂", "tag-𝐀", "tag-a", "tag-b", "tag-c", "tag-d"
        ],
        "symbols join a tag value; sentence punctuation ends it"
    );
}
