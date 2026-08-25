use vault_core::{DiagnosticCode, PropertyValue, SourceDocument, VaultPath, parse_note};

fn parse(text: &str) -> vault_core::ParsedNote {
    let path = VaultPath::new("Properties.md").expect("valid path");
    parse_note(SourceDocument::new(path, text))
}

#[test]
fn parses_properties_aliases_and_tags_with_exact_spans() {
    let text = "---\r\ntitle: Café\r\naliases: [Coffee, Java]\r\ntags:\r\n  - Project/PhaseOne\r\nscore: 4.5\r\n---\r\nBody\r\n";
    let parsed = parse(text);

    assert_eq!(parsed.properties.len(), 4);
    assert_eq!(
        parsed
            .aliases
            .iter()
            .map(|a| a.value.as_str())
            .collect::<Vec<_>>(),
        ["Coffee", "Java"]
    );
    assert_eq!(parsed.tags[0].value, "Project/PhaseOne");
    assert_eq!(parsed.tags[0].comparison_key, "project/phaseone");
    assert_eq!(parsed.source.slice(parsed.aliases[0].span), Some("Coffee"));
    assert!(
        matches!(parsed.properties[3].value.value, PropertyValue::Float(value) if value == 4.5)
    );
    assert!(parsed.diagnostics.is_empty());
}

#[test]
fn flow_and_block_property_value_spans_slice_their_exact_source() {
    let text = "---\nlist: [a, b]\nmap: {k: v}\nseq:\n  - one\n---\nBody\n";
    let parsed = parse(text);

    assert_eq!(parsed.properties.len(), 3);
    assert_eq!(
        parsed.source.slice(parsed.properties[0].value.span),
        Some("[a, b]")
    );
    assert_eq!(
        parsed.source.slice(parsed.properties[1].value.span),
        Some("{k: v}")
    );
    assert_eq!(
        parsed.source.slice(parsed.properties[2].value.span),
        Some("- one")
    );
    assert_eq!(
        parsed.source.slice(parsed.properties[0].span),
        Some("list: [a, b]")
    );
}

#[test]
fn malformed_closed_frontmatter_recovers_the_markdown_body() {
    let text = "---\ntags: [broken\n---\n# Recoverable\n";
    let parsed = parse(text);

    assert!(parsed.source.text().ends_with("# Recoverable\n"));
    assert!(
        parsed
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == DiagnosticCode::MalformedFrontmatter })
    );
}

#[test]
fn unterminated_frontmatter_is_diagnosed_without_discarding_source() {
    let text = "---\ntitle: Never closed\n# Still source\n";
    let parsed = parse(text);

    assert_eq!(parsed.source.text(), text);
    assert!(
        parsed
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == DiagnosticCode::UnterminatedFrontmatter })
    );
}
