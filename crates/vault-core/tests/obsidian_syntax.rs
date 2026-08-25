use vault_core::{
    DiagnosticCode, ReferenceKind, ReferenceOrigin, SourceDocument, Subpath, VaultPath, parse_note,
};

fn parse(text: &str) -> vault_core::ParsedNote {
    parse_note(SourceDocument::new(
        VaultPath::new("Notes/Source.md").expect("valid path"),
        text,
    ))
}

#[test]
fn parses_wikilinks_embeds_displays_and_subpaths() {
    let text = "[[Target|Shown]] ![[Other#Heading]] [[#^local-block]]";
    let parsed = parse(text);

    assert_eq!(parsed.references.len(), 3);
    assert_eq!(parsed.references[0].origin, ReferenceOrigin::Body);
    assert_eq!(parsed.references[0].kind, ReferenceKind::Wikilink);
    assert_eq!(parsed.references[0].display.as_deref(), Some("Shown"));
    assert_eq!(parsed.references[1].kind, ReferenceKind::WikiEmbed);
    assert_eq!(
        parsed.references[1].subpath,
        Some(Subpath::Heading("Heading".into()))
    );
    assert_eq!(parsed.references[2].file_target, None);
    assert_eq!(
        parsed.references[2].subpath,
        Some(Subpath::Block("local-block".into()))
    );
}

#[test]
fn parses_nested_tags_and_block_ids_only_from_prose() {
    let text = "Text #Project/PhaseOne ^decision\n\n`#Code ^fake`\n";
    let parsed = parse(text);

    assert_eq!(parsed.tags.len(), 1);
    assert_eq!(parsed.tags[0].value, "Project/PhaseOne");
    assert_eq!(parsed.blocks.len(), 1);
    assert_eq!(parsed.blocks[0].value, "decision");
}

#[test]
fn property_strings_can_contribute_references() {
    let parsed = parse("---\nrelated: '[[Target]]'\n---\nBody\n");

    assert_eq!(parsed.references.len(), 1);
    assert_eq!(parsed.references[0].origin, ReferenceOrigin::Property);
    assert_eq!(parsed.references[0].kind, ReferenceKind::Wikilink);
    assert_eq!(parsed.references[0].raw_target, "Target");
    assert_eq!(
        parsed.source.slice(parsed.references[0].target_span),
        Some("Target")
    );
}

#[test]
fn malformed_wikilinks_are_diagnostics_not_panics() {
    let parsed = parse("Before [[never closed\nAfter\n");

    assert!(
        parsed
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == DiagnosticCode::MalformedWikilink })
    );
}
