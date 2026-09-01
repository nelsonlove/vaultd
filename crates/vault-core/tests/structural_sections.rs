mod support;

use proptest::prelude::*;
use serde_json::Value;
use support::{CASES, load, utf16_offset};
use vault_core::{SectionKind, SourceDocument, VaultPath, parse_note};

/// The wire string vocabulary Obsidian emits for `sections[].type`, per
/// `tests/fixtures/structural/README.md`. Used only to compare our
/// `SectionKind` against captured JSON strings; the domain type itself
/// stays a Rust enum (see `crates/vault-core/src/semantic.rs`).
fn kind_wire(kind: &SectionKind) -> String {
    match kind {
        SectionKind::Yaml => "yaml".to_string(),
        SectionKind::Heading => "heading".to_string(),
        SectionKind::Paragraph => "paragraph".to_string(),
        SectionKind::Code => "code".to_string(),
        SectionKind::Blockquote => "blockquote".to_string(),
        SectionKind::Table => "table".to_string(),
        SectionKind::ThematicBreak => "thematicBreak".to_string(),
        SectionKind::List => "list".to_string(),
        SectionKind::Callout => "callout".to_string(),
        SectionKind::Html => "html".to_string(),
        SectionKind::Other(value) => value.clone(),
    }
}

#[test]
fn every_fixture_sections_match_obsidian_exactly() {
    for &name in CASES {
        let fixture = load(name);
        let expected_sections = match &fixture.expected["sections"] {
            Value::Null => Vec::new(),
            Value::Array(items) => items
                .iter()
                // Obsidian can emit zero-width phantom sections (`text`,
                // `element`) at end-of-file after a footnote reference; the
                // fixtures README's second-capture section records why. They
                // carry no content and vault-core does not reproduce them.
                .filter(|item| {
                    item["position"]["start"]["offset"] != item["position"]["end"]["offset"]
                })
                .cloned()
                .collect(),
            other => panic!("{name}: sections is neither null nor an array: {other:?}"),
        };

        assert_eq!(
            fixture.parsed.sections.len(),
            expected_sections.len(),
            "{name}: section count mismatch (parsed: {:#?})",
            fixture.parsed.sections
        );

        for (index, (actual, expected)) in fixture
            .parsed
            .sections
            .iter()
            .zip(expected_sections.iter())
            .enumerate()
        {
            let expected_type = expected["type"]
                .as_str()
                .unwrap_or_else(|| panic!("{name}: sections[{index}].type is not a string"));
            assert_eq!(
                kind_wire(&actual.kind),
                expected_type,
                "{name}: sections[{index}] kind mismatch"
            );

            let expected_start = expected["position"]["start"]["offset"]
                .as_u64()
                .unwrap_or_else(|| panic!("{name}: sections[{index}] missing start offset"))
                as usize;
            let expected_end = expected["position"]["end"]["offset"]
                .as_u64()
                .unwrap_or_else(|| panic!("{name}: sections[{index}] missing end offset"))
                as usize;
            assert_eq!(
                utf16_offset(&fixture.source, actual.span.start()),
                expected_start,
                "{name}: sections[{index}] start offset mismatch"
            );
            assert_eq!(
                utf16_offset(&fixture.source, actual.span.end()),
                expected_end,
                "{name}: sections[{index}] end offset mismatch"
            );

            let expected_id = expected["id"].as_str().map(str::to_string);
            assert_eq!(
                actual.block_id, expected_id,
                "{name}: sections[{index}] block_id mismatch"
            );
        }
    }
}

#[test]
fn frontmatter_yaml_section_is_first_when_present() {
    let fixture = load("01-frontmatter-and-headings");
    assert_eq!(fixture.parsed.sections[0].kind, SectionKind::Yaml);
    assert_eq!(fixture.parsed.sections[0].span.start(), 0);
}

#[test]
fn list_item_block_id_does_not_surface_on_the_list_section() {
    let fixture = load("13-block-ids");
    let list_section = fixture
        .parsed
        .sections
        .iter()
        .find(|section| section.kind == SectionKind::List)
        .expect("13-block-ids has a list section");
    assert_eq!(list_section.block_id, None);
}

#[test]
fn embed_and_link_inside_a_list_item_still_surface_as_references() {
    let fixture = load("10-list-with-link-and-embed");
    assert!(
        fixture
            .parsed
            .references
            .iter()
            .any(|reference| reference.raw_target == "Target Note"),
        "expected the wikilink reference to survive section extraction"
    );
    assert!(
        fixture
            .parsed
            .references
            .iter()
            .any(|reference| reference.raw_target == "Some Image.png"),
        "expected the embed reference to survive section extraction"
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn arbitrary_markdown_yields_sane_section_spans(
        chars in proptest::collection::vec(any::<char>(), 0..=512)
    ) {
        let text: String = chars.into_iter().collect();
        let document = SourceDocument::new(
            VaultPath::new("Fuzz.md").expect("valid path"),
            text.clone(),
        );
        let parsed = parse_note(document);

        // Non-vacuity guard: any input with a non-blank line must yield at
        // least one section, so this test cannot silently go vacuous if the
        // generator or the extractor changes. Blankness is judged after
        // stripping a leading U+FEFF: micromark skips a byte-order mark, so
        // a BOM-only input is semantically empty (committed seed).
        let content = text.strip_prefix('\u{feff}').unwrap_or(&text);
        if content.lines().any(|line| !line.trim().is_empty()) {
            prop_assert!(
                !parsed.sections.is_empty(),
                "non-blank input produced zero sections"
            );
        }

        let mut previous_end: Option<usize> = None;
        for section in &parsed.sections {
            prop_assert!(section.span.start() <= section.span.end());
            prop_assert!(section.span.end() <= text.len());
            prop_assert!(text.is_char_boundary(section.span.start()));
            prop_assert!(text.is_char_boundary(section.span.end()));
            prop_assert!(parsed.source.slice(section.span).is_some());
            if let Some(previous_end) = previous_end {
                prop_assert!(section.span.start() >= previous_end);
            }
            previous_end = Some(section.span.end());
        }

        // List items: spans slice cleanly and starts ascend in document
        // order (containment is legal — a parent item's span includes its
        // descendants — so only starts are monotonic, not ranges).
        let mut previous_start: Option<usize> = None;
        for item in &parsed.list_items {
            prop_assert!(item.span.start() <= item.span.end());
            prop_assert!(item.span.end() <= text.len());
            prop_assert!(text.is_char_boundary(item.span.start()));
            prop_assert!(text.is_char_boundary(item.span.end()));
            prop_assert!(parsed.source.slice(item.span).is_some());
            if let Some(previous_start) = previous_start {
                prop_assert!(item.span.start() >= previous_start);
            }
            previous_start = Some(item.span.start());
        }
    }
}

/// Enabling math parsing is this branch's one deliberate change to
/// pre-existing reference extraction: a wikilink inside a `$$…$$` block no
/// longer produces a reference, exactly as fixture 22's captured `links: []`
/// records. The fixture loaders ignore captured links, so this test is the
/// executable pin — a Walker that re-descends math nodes fails here.
#[test]
fn a_wikilink_inside_a_math_block_produces_no_reference() {
    let fixture = load("22-indented-callout-and-math-link");
    assert!(
        fixture.source.contains("[[Math Link Target]]"),
        "fixture 22 must keep its math-body wikilink for this pin to bite"
    );
    assert_eq!(
        fixture.expected["links"],
        serde_json::json!([]),
        "the capture must still record zero links for the math wikilink"
    );
    assert!(
        fixture
            .parsed
            .references
            .iter()
            .all(|reference| reference.raw_target != "Math Link Target"),
        "a math-block wikilink leaked into reference extraction"
    );

    let math_only = load("18-math-block");
    assert!(
        math_only.parsed.references.is_empty(),
        "a pure math note must extract no references"
    );
    assert!(
        math_only.parsed.tags.is_empty(),
        "a pure math note must extract no tags"
    );
}

/// micromark skips a leading U+FEFF byte-order mark, so a BOM-only note is
/// semantically empty — zero sections — while a BOM followed by content
/// still yields its sections. Surfaced by the property above (the committed
/// seed re-runs the BOM-only case first on every run); pinned here
/// deterministically. This states micromark's behavior, not a captured
/// Obsidian parity claim.
#[test]
fn a_leading_byte_order_mark_is_not_content() {
    let bom_only = parse_note(SourceDocument::new(
        VaultPath::new("Bom.md").expect("valid path"),
        "\u{feff}".to_string(),
    ));
    assert!(
        bom_only.sections.is_empty(),
        "a BOM-only note must yield zero sections"
    );

    let bom_then_text = parse_note(SourceDocument::new(
        VaultPath::new("Bom.md").expect("valid path"),
        "\u{feff}hello".to_string(),
    ));
    assert_eq!(
        bom_then_text.sections.len(),
        1,
        "a BOM followed by content must still yield its section"
    );
}
