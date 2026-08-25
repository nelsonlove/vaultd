use vault_core::{Resolution, Resolver, SourceDocument, Subpath, VaultPath, parse_note};

fn note(path: &str, text: &str) -> vault_core::ParsedNote {
    parse_note(SourceDocument::new(
        VaultPath::new(path).expect("valid path"),
        text,
    ))
}

#[test]
fn resolves_exact_root_and_md_omitted_paths_first() {
    let notes = vec![
        note("Folder/Source.md", "[[Target]] [[Folder/Target.md]]"),
        note("Folder/Target.md", "# Target"),
        note("Target.md", "# Root"),
    ];
    let resolver = Resolver::new(&notes);
    let results = resolver.resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Resolved { target, .. } if target.as_str() == "Target.md"
    ));
    assert!(matches!(
        &results[1].resolution,
        Resolution::Resolved { target, .. } if target.as_str() == "Folder/Target.md"
    ));
}

#[test]
fn resolves_explicit_relative_paths_against_the_source_parent() {
    let notes = vec![
        note("A/B/Source.md", "[up](../Target.md)"),
        note("A/Target.md", "# Target"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Resolved { target, .. } if target.as_str() == "A/Target.md"
    ));
}

#[test]
fn returns_all_candidates_for_an_ambiguous_unique_name_stage() {
    let notes = vec![
        note("Source.md", "[[Foo]]"),
        note("One/Foo.md", "one"),
        note("Two/Foo.md", "two"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Ambiguous { candidates }
            if candidates.iter().map(|p| p.as_str()).collect::<Vec<_>>()
                == ["One/Foo.md", "Two/Foo.md"]
    ));
}

#[test]
fn resolves_unique_names_case_insensitively_for_filename_and_stem() {
    let notes = vec![
        note("Source.md", "[[deep target]] [[DEEP TARGET.md]]"),
        note("Nested/Deep Target.md", "# Deep"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Resolved { target, .. } if target.as_str() == "Nested/Deep Target.md"
    ));
    assert!(matches!(
        &results[1].resolution,
        Resolution::Resolved { target, .. } if target.as_str() == "Nested/Deep Target.md"
    ));
}

#[test]
fn empty_file_wikilink_subpaths_resolve_to_the_source_note() {
    let notes = vec![note(
        "Self.md",
        "# Local\n\n[[#Local]] [[#^anchor]]\n\nBody ^anchor\n",
    )];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Resolved { target, subpath: Some(Subpath::Heading(heading)) }
            if target.as_str() == "Self.md" && heading == "Local"
    ));
    assert!(matches!(
        &results[1].resolution,
        Resolution::Resolved { target, subpath: Some(Subpath::Block(block)) }
            if target.as_str() == "Self.md" && block == "anchor"
    ));
}

#[test]
fn resolved_files_match_headings_case_insensitively() {
    let notes = vec![
        note("Source.md", "[[Target#decision record]]"),
        note("Target.md", "## Decision Record\n"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Resolved { target, subpath: Some(Subpath::Heading(_)) }
            if target.as_str() == "Target.md"
    ));
}

#[test]
fn resolved_files_match_block_ids_exactly() {
    let notes = vec![
        note("Source.md", "[[Target#^Block-One]]"),
        note("Target.md", "Body ^Block-One\n"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::Resolved { target, subpath: Some(Subpath::Block(_)) }
            if target.as_str() == "Target.md"
    ));
}

#[test]
fn missing_heading_or_block_is_missing_subpath_not_unresolved() {
    let notes = vec![
        note("Source.md", "[[Target#Absent]] [[Target#^absent]]"),
        note("Target.md", "# Present\n\nBody ^present\n"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert!(matches!(
        &results[0].resolution,
        Resolution::MissingSubpath { target, subpath: Subpath::Heading(_) }
            if target.as_str() == "Target.md"
    ));
    assert!(matches!(
        &results[1].resolution,
        Resolution::MissingSubpath { target, subpath: Subpath::Block(_) }
            if target.as_str() == "Target.md"
    ));
}

#[test]
fn external_uri_schemes_are_non_vault() {
    let notes = vec![note(
        "Source.md",
        "[site](https://example.com) [mail](mailto:someone@example.com) [app](obsidian://open)",
    )];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert_eq!(results.len(), 3);
    for result in &results {
        assert_eq!(result.resolution, Resolution::NonVault);
    }
}

#[test]
fn aliases_are_not_implicit_link_destinations() {
    let notes = vec![
        note("Source.md", "[[Props]]"),
        note("Aliased.md", "---\naliases: [Props]\n---\n# Aliased\n"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert_eq!(results[0].resolution, Resolution::Unresolved);
}

#[test]
fn relative_paths_escaping_the_vault_root_are_unresolved() {
    let notes = vec![
        note("Source.md", "[out](../Outside.md)"),
        note("Outside.md", "# Inside actually"),
    ];
    let results = Resolver::new(&notes).resolve_note(&notes[0]);

    assert_eq!(results[0].resolution, Resolution::Unresolved);
}
