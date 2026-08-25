use vault_core::{
    Alias, Diagnostic, DiagnosticCode, ParsedNote, Property, PropertyValue, Reference,
    ReferenceKind, ReferenceOrigin, Severity, SourceDocument, SourceSpan, Spanned, Subpath, Tag,
    VaultPath,
};

#[test]
fn public_model_preserves_source_spelling_and_order() {
    let path = VaultPath::new("Notes/Example.md").expect("valid path");
    let source = SourceDocument::new(path, "aliases: [Alpha, Beta]");
    let alpha = SourceSpan::new(10, 15).expect("valid span");
    let beta = SourceSpan::new(17, 21).expect("valid span");

    let parsed = ParsedNote {
        aliases: vec![
            Alias {
                value: "Alpha".into(),
                span: alpha,
            },
            Alias {
                value: "Beta".into(),
                span: beta,
            },
        ],
        ..ParsedNote::empty(source)
    };

    assert_eq!(parsed.aliases[0].value, "Alpha");
    assert_eq!(parsed.aliases[1].value, "Beta");
}

#[test]
fn property_values_preserve_nested_sequence_spans() {
    let value = PropertyValue::Sequence(vec![Spanned::new(
        PropertyValue::String("project".into()),
        SourceSpan::new(8, 15).expect("valid span"),
    )]);
    let property = Property {
        key: Spanned::new("tags".into(), SourceSpan::new(0, 4).expect("valid span")),
        value: Spanned::new(value, SourceSpan::new(6, 16).expect("valid span")),
        span: SourceSpan::new(0, 16).expect("valid span"),
    };

    assert_eq!(property.key.value, "tags");
}

#[test]
fn references_distinguish_syntax_origin_and_subpath() {
    let reference = Reference {
        kind: ReferenceKind::Wikilink,
        origin: ReferenceOrigin::Body,
        raw_target: "Plan#^decision".into(),
        file_target: Some("Plan".into()),
        subpath: Some(Subpath::Block("decision".into())),
        display: None,
        span: SourceSpan::new(4, 22).expect("valid span"),
        target_span: SourceSpan::new(6, 20).expect("valid target span"),
    };

    assert_eq!(reference.subpath, Some(Subpath::Block("decision".into())));
}

#[test]
fn diagnostics_are_structured_and_source_addressable() {
    let diagnostic = Diagnostic::new(
        DiagnosticCode::MalformedWikilink,
        Severity::Warning,
        "unclosed wikilink",
    )
    .with_path(VaultPath::new("Broken.md").expect("valid path"))
    .with_span(SourceSpan::new(0, 8).expect("valid span"));

    assert_eq!(diagnostic.code, DiagnosticCode::MalformedWikilink);
    assert_eq!(diagnostic.span.expect("span").start(), 0);
}

#[test]
fn tags_preserve_original_spelling() {
    let tag = Tag {
        value: "Project/PhaseOne".into(),
        comparison_key: "project/phaseone".into(),
        span: SourceSpan::new(0, 17).expect("valid span"),
    };
    assert_eq!(tag.value, "Project/PhaseOne");
}
