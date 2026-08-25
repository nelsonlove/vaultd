use vault_core::{ReferenceKind, ReferenceOrigin, SourceDocument, VaultPath, parse_note};

fn parse(text: &str) -> vault_core::ParsedNote {
    parse_note(SourceDocument::new(
        VaultPath::new("Folder/Current.md").expect("valid path"),
        text,
    ))
}

#[test]
fn extracts_headings_with_source_spans() {
    let text = "# Café heading\n\n## Second *heading*\n";
    let parsed = parse(text);

    assert_eq!(parsed.headings.len(), 2);
    assert_eq!(parsed.headings[0].level, 1);
    assert_eq!(parsed.headings[0].text, "Café heading");
    assert_eq!(
        parsed.source.slice(parsed.headings[0].span),
        Some("# Café heading")
    );
    assert_eq!(parsed.headings[1].text, "Second heading");
}

#[test]
fn extracts_markdown_links_and_embeds_without_rewriting_targets() {
    let text = "[label](../Target%20Note.md#Section) ![alt](asset.png)";
    let parsed = parse(text);

    assert_eq!(parsed.references.len(), 2);
    assert_eq!(parsed.references[0].origin, ReferenceOrigin::Body);
    assert_eq!(parsed.references[0].kind, ReferenceKind::MarkdownLink);
    assert_eq!(
        parsed.references[0].raw_target,
        "../Target%20Note.md#Section"
    );
    assert_eq!(
        parsed.references[0].file_target.as_deref(),
        Some("../Target Note.md")
    );
    assert_eq!(
        parsed.source.slice(parsed.references[0].target_span),
        Some("../Target%20Note.md#Section")
    );
    assert_eq!(parsed.references[1].kind, ReferenceKind::MarkdownEmbed);
    assert_eq!(
        parsed.source.slice(parsed.references[1].span),
        Some("![alt](asset.png)")
    );
}

#[test]
fn void_html_elements_do_not_suppress_later_prose_scanning() {
    let text = "Line one<br>\n\nLater paragraph with #realtag and [[RealLink]].\n\nAfter <img src=\"x.png\"> more #tag2.\n";
    let parsed = parse(text);

    assert_eq!(
        parsed
            .tags
            .iter()
            .map(|tag| tag.value.as_str())
            .collect::<Vec<_>>(),
        ["realtag", "tag2"]
    );
    assert_eq!(parsed.references.len(), 1);
    assert_eq!(parsed.references[0].raw_target, "RealLink");
}

#[test]
fn html_comments_with_tag_shaped_text_do_not_suppress_later_prose_scanning() {
    let text = "<!-- <span> is inert -->\n\nLater prose with #realtag and [[RealLink]].\n";
    let parsed = parse(text);

    assert_eq!(
        parsed
            .tags
            .iter()
            .map(|tag| tag.value.as_str())
            .collect::<Vec<_>>(),
        ["realtag"]
    );
    assert_eq!(parsed.references.len(), 1);
    assert_eq!(parsed.references[0].raw_target, "RealLink");
}

#[test]
fn obsidian_extensions_inside_code_html_and_link_labels_are_not_scanned() {
    let text = "`[[Code]]` <span>#html</span> [#label](Target.md)\n\n```md\n[[Fence]] #tag\n```\n";
    let parsed = parse(text);

    assert!(parsed.tags.is_empty());
    assert_eq!(parsed.references.len(), 1);
    assert_eq!(parsed.references[0].raw_target, "Target.md");
}
