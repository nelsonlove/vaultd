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
        // generator or the extractor changes.
        if text.lines().any(|line| !line.trim().is_empty()) {
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
