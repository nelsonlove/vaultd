use std::path::Path;

use vault_core::{
    DependencyKey, DependencyKind, FileSystemVaultSource, LinkTarget, Resolution,
    ResolutionIdentityChange, ResolutionNote, Subpath, VaultPath, changed_candidate_keys,
    parse_note, read_documents, reference_dependencies, resolution_diagnostic, scan_vault,
};

fn vp(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid path")
}

fn resolution_note(path: &str, headings: &[&str], blocks: &[&str]) -> ResolutionNote {
    ResolutionNote {
        path: vp(path),
        headings: headings.iter().map(|h| h.to_string()).collect(),
        blocks: blocks.iter().map(|b| b.to_string()).collect(),
    }
}

// --- reference_dependencies ---------------------------------------------

#[test]
fn unresolved_filename_reference_keeps_every_lookup_route() {
    let source = vp("Folder/Source.md");
    let target = LinkTarget::parse("Target");
    let keys = reference_dependencies(&source, &target, &Resolution::Unresolved);

    assert_eq!(
        keys,
        vec![
            DependencyKey::new(DependencyKind::ExactPath, "Target"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "Target.md"),
            DependencyKey::new(DependencyKind::Filename, "target"),
            DependencyKey::new(DependencyKind::Stem, "target"),
        ]
    );
}

#[test]
fn ambiguous_reference_keeps_every_lookup_route_without_a_resolved_target_key() {
    let source = vp("Source.md");
    let target = LinkTarget::parse("Foo");
    let resolution = Resolution::Ambiguous {
        candidates: vec![vp("One/Foo.md"), vp("Two/Foo.md")],
    };
    let keys = reference_dependencies(&source, &target, &resolution);

    assert_eq!(
        keys,
        vec![
            DependencyKey::new(DependencyKind::ExactPath, "Foo"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "Foo.md"),
            DependencyKey::new(DependencyKind::Filename, "foo"),
            DependencyKey::new(DependencyKind::Stem, "foo"),
        ]
    );
}

#[test]
fn non_vault_uri_produces_no_dependency_keys() {
    let source = vp("Source.md");
    let target = LinkTarget::parse("https://example.com");
    let keys = reference_dependencies(&source, &target, &Resolution::NonVault);

    assert!(keys.is_empty());
}

#[test]
fn same_note_heading_reference_depends_on_the_source_note() {
    let source = vp("Self.md");
    let target = LinkTarget::parse("#Heading");
    let resolution = Resolution::Resolved {
        target: source.clone(),
        subpath: Some(Subpath::Heading("Heading".to_string())),
    };
    let keys = reference_dependencies(&source, &target, &resolution);

    assert_eq!(
        keys,
        vec![DependencyKey::new(
            DependencyKind::ResolvedTarget,
            "Self.md"
        )]
    );
}

#[test]
fn same_note_block_reference_depends_on_the_source_note_exactly_once() {
    let source = vp("Self.md");
    let target = LinkTarget::parse("#^anchor");
    let resolution = Resolution::Resolved {
        target: source.clone(),
        subpath: Some(Subpath::Block("anchor".to_string())),
    };
    let keys = reference_dependencies(&source, &target, &resolution);

    // Must not be duplicated even though the resolved target equals the source.
    assert_eq!(
        keys,
        vec![DependencyKey::new(
            DependencyKind::ResolvedTarget,
            "Self.md"
        )]
    );
}

#[test]
fn resolved_reference_adds_a_resolved_target_key_on_top_of_lookup_routes() {
    let source = vp("Source.md");
    let target = LinkTarget::parse("Target");
    let resolution = Resolution::Resolved {
        target: vp("Nested/Target.md"),
        subpath: None,
    };
    let keys = reference_dependencies(&source, &target, &resolution);

    assert_eq!(
        keys,
        vec![
            DependencyKey::new(DependencyKind::ExactPath, "Target"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "Target.md"),
            DependencyKey::new(DependencyKind::Filename, "target"),
            DependencyKey::new(DependencyKind::Stem, "target"),
            DependencyKey::new(DependencyKind::ResolvedTarget, "Nested/Target.md"),
        ]
    );
}

#[test]
fn missing_subpath_reference_adds_a_resolved_target_key() {
    let source = vp("Source.md");
    let target = LinkTarget::parse("Target#Absent");
    let resolution = Resolution::MissingSubpath {
        target: vp("Target.md"),
        subpath: Subpath::Heading("Absent".to_string()),
    };
    let keys = reference_dependencies(&source, &target, &resolution);

    assert_eq!(
        keys,
        vec![
            DependencyKey::new(DependencyKind::ExactPath, "Target"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "Target.md"),
            DependencyKey::new(DependencyKind::Filename, "target"),
            DependencyKey::new(DependencyKind::Stem, "target"),
            DependencyKey::new(DependencyKind::ResolvedTarget, "Target.md"),
        ]
    );
}

#[test]
fn relative_target_keeps_only_the_exact_path_routes() {
    let source = vp("A/B/Source.md");
    let target = LinkTarget::parse("../Target");
    let keys = reference_dependencies(&source, &target, &Resolution::Unresolved);

    assert_eq!(
        keys,
        vec![
            DependencyKey::new(DependencyKind::ExactPath, "A/Target"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "A/Target.md"),
        ]
    );
}

#[test]
fn relative_target_escaping_the_vault_root_produces_no_keys() {
    let source = vp("Source.md");
    let target = LinkTarget::parse("../Outside");
    let keys = reference_dependencies(&source, &target, &Resolution::Unresolved);

    assert!(keys.is_empty());
}

// --- changed_candidate_keys ----------------------------------------------

#[test]
fn body_only_edits_with_identical_resolution_notes_produce_no_keys() {
    let old = resolution_note("Target.md", &["Heading"], &["block"]);
    let new = old.clone();
    let change = ResolutionIdentityChange {
        old: Some(old),
        new: Some(new),
    };

    assert!(changed_candidate_keys(&change).is_empty());
}

#[test]
fn adding_a_note_yields_its_exact_filename_and_stem_keys() {
    let change = ResolutionIdentityChange {
        old: None,
        new: Some(resolution_note("Folder/Target.md", &[], &[])),
    };
    let keys = changed_candidate_keys(&change);

    assert_eq!(
        keys.into_iter().collect::<Vec<_>>(),
        vec![
            DependencyKey::new(DependencyKind::ExactPath, "Folder/Target.md"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "Folder/Target.md"),
            DependencyKey::new(DependencyKind::Filename, "target.md"),
            DependencyKey::new(DependencyKind::Stem, "target"),
        ]
    );
}

#[test]
fn removing_a_note_yields_its_exact_filename_and_stem_keys() {
    let change = ResolutionIdentityChange {
        old: Some(resolution_note("Target.md", &[], &[])),
        new: None,
    };
    let keys = changed_candidate_keys(&change);

    assert_eq!(
        keys.into_iter().collect::<Vec<_>>(),
        vec![
            DependencyKey::new(DependencyKind::ExactPath, "Target.md"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "Target.md"),
            DependencyKey::new(DependencyKind::Filename, "target.md"),
            DependencyKey::new(DependencyKind::Stem, "target"),
        ]
    );
}

#[test]
fn renaming_a_note_yields_keys_for_both_old_and_new_paths() {
    let change = ResolutionIdentityChange {
        old: Some(resolution_note("Old.md", &["H"], &[])),
        new: Some(resolution_note("New.md", &["H"], &[])),
    };
    let keys = changed_candidate_keys(&change);

    assert_eq!(
        keys.into_iter().collect::<Vec<_>>(),
        vec![
            DependencyKey::new(DependencyKind::ExactPath, "New.md"),
            DependencyKey::new(DependencyKind::ExactPath, "Old.md"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "New.md"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "Old.md"),
            DependencyKey::new(DependencyKind::Filename, "new.md"),
            DependencyKey::new(DependencyKind::Filename, "old.md"),
            DependencyKey::new(DependencyKind::Stem, "new"),
            DependencyKey::new(DependencyKind::Stem, "old"),
        ]
    );
}

#[test]
fn heading_change_with_stable_path_yields_only_a_resolved_target_key() {
    let change = ResolutionIdentityChange {
        old: Some(resolution_note("Target.md", &["Old Heading"], &["block"])),
        new: Some(resolution_note("Target.md", &["New Heading"], &["block"])),
    };
    let keys = changed_candidate_keys(&change);

    assert_eq!(
        keys.into_iter().collect::<Vec<_>>(),
        vec![DependencyKey::new(
            DependencyKind::ResolvedTarget,
            "Target.md"
        )]
    );
}

#[test]
fn block_change_with_stable_path_yields_only_a_resolved_target_key() {
    let change = ResolutionIdentityChange {
        old: Some(resolution_note("Target.md", &["Heading"], &["old-block"])),
        new: Some(resolution_note("Target.md", &["Heading"], &["new-block"])),
    };
    let keys = changed_candidate_keys(&change);

    assert_eq!(
        keys.into_iter().collect::<Vec<_>>(),
        vec![DependencyKey::new(
            DependencyKind::ResolvedTarget,
            "Target.md"
        )]
    );
}

// --- resolution_diagnostic -------------------------------------------------

fn fixture_root() -> &'static Path {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/semantic-read-path/basic-vault"
    ))
}

#[test]
fn resolution_diagnostic_matches_build_graph_output_for_every_resolved_reference() {
    let source = FileSystemVaultSource::new(fixture_root()).expect("fixture root");
    let documents = read_documents(&source).expect("read fixture documents");
    let notes: Vec<_> = documents.documents.into_iter().map(parse_note).collect();

    let report = scan_vault(&source).expect("scan fixture");

    let mut expected_from_build_graph: Vec<_> = report
        .graph
        .notes()
        .flat_map(|note| report.graph.outgoing(note.source.path()))
        .filter(|resolved| {
            !matches!(
                resolved.resolution,
                Resolution::Resolved { .. } | Resolution::NonVault
            )
        })
        .cloned()
        .collect();
    expected_from_build_graph.sort_by(|a, b| {
        (&a.source, a.source_span, &a.reference.raw_target).cmp(&(
            &b.source,
            b.source_span,
            &b.reference.raw_target,
        ))
    });

    let resolver = vault_core::Resolver::new(&notes);
    let mut recomputed: Vec<_> = notes
        .iter()
        .flat_map(|note| resolver.resolve_note(note))
        .filter(|resolved| {
            !matches!(
                resolved.resolution,
                Resolution::Resolved { .. } | Resolution::NonVault
            )
        })
        .collect();
    recomputed.sort_by(|a, b| {
        (&a.source, a.source_span, &a.reference.raw_target).cmp(&(
            &b.source,
            b.source_span,
            &b.reference.raw_target,
        ))
    });

    assert_eq!(expected_from_build_graph.len(), recomputed.len());
    assert!(
        !expected_from_build_graph.is_empty(),
        "fixture exercises no diagnostics"
    );

    for (from_graph, resolved) in expected_from_build_graph.iter().zip(recomputed.iter()) {
        let single = resolution_diagnostic(resolved).expect("a diagnostic for this resolution");
        let matching = report
            .diagnostics
            .iter()
            .find(|diagnostic| {
                diagnostic.path.as_ref() == Some(&from_graph.source)
                    && diagnostic.span == Some(from_graph.source_span)
                    && diagnostic.code == single.code
            })
            .expect("build_graph emitted a matching diagnostic");

        assert_eq!(single.code, matching.code);
        assert_eq!(single.severity, matching.severity);
        assert_eq!(single.message, matching.message);
        assert_eq!(single.path, matching.path);
        assert_eq!(single.span, matching.span);
    }
}

#[test]
fn resolution_diagnostic_is_none_for_resolved_and_non_vault() {
    let resolved = vault_core::ResolvedReference {
        source: vp("Source.md"),
        source_span: vault_core::SourceSpan::new(0, 1).expect("valid span"),
        reference: vault_core::Reference {
            kind: vault_core::ReferenceKind::Wikilink,
            origin: vault_core::ReferenceOrigin::Body,
            raw_target: "Target".to_string(),
            file_target: Some("Target".to_string()),
            subpath: None,
            display: None,
            span: vault_core::SourceSpan::new(0, 1).expect("valid span"),
            target_span: vault_core::SourceSpan::new(0, 1).expect("valid span"),
        },
        resolution: Resolution::Resolved {
            target: vp("Target.md"),
            subpath: None,
        },
    };
    assert!(resolution_diagnostic(&resolved).is_none());

    let non_vault = vault_core::ResolvedReference {
        resolution: Resolution::NonVault,
        ..resolved
    };
    assert!(resolution_diagnostic(&non_vault).is_none());
}
