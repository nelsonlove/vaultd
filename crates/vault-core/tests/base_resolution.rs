use vault_core::{
    DependencyKey, DependencyKind, DiagnosticCode, LinkTarget, ParsedNote, Resolution,
    ResolutionIdentityChange, ResolutionNote, ResolvedReference, Resolver, SourceDocument, Subpath,
    VaultPath, build_graph_with_bases, changed_candidate_keys, parse_note, resolution_diagnostic,
};

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).expect("a valid path")
}

fn note(path: &str, headings: &[&str]) -> ResolutionNote {
    ResolutionNote {
        path: vp(path),
        headings: headings.iter().map(|h| h.to_string()).collect(),
        blocks: Vec::new(),
        views: None,
    }
}

fn resolver() -> Resolver {
    Resolver::from_catalog([
        note("Home.md", &["Table"]),
        ResolutionNote::base(
            vp("Views.base"),
            vec!["Table".into(), "Tâble".into(), "Cards".into()],
        ),
        ResolutionNote::base(vp("Sub/Other.base"), vec![]),
    ])
}

fn resolve(destination: &str) -> Resolution {
    resolver().resolve_target(&vp("Home.md"), &LinkTarget::parse(destination))
}

#[test]
fn a_link_to_a_base_resolves_to_the_base() {
    assert_eq!(
        resolve("Views.base"),
        Resolution::Resolved {
            target: vp("Views.base"),
            subpath: None
        }
    );
    assert_eq!(
        resolve("Sub/Other.base"),
        Resolution::Resolved {
            target: vp("Sub/Other.base"),
            subpath: None
        }
    );
    assert_eq!(
        resolve("other.base"),
        Resolution::Resolved {
            target: vp("Sub/Other.base"),
            subpath: None
        },
        "the filename stage is case-insensitive"
    );
}

#[test]
fn a_base_is_never_reached_without_its_extension() {
    assert_eq!(resolve("Views"), Resolution::Unresolved);
}

#[test]
fn a_subpath_on_a_base_is_a_view() {
    assert_eq!(
        resolve("Views.base#Table"),
        Resolution::Resolved {
            target: vp("Views.base"),
            subpath: Some(Subpath::View("Table".into()))
        }
    );
    assert_eq!(
        resolve("Views.base#Missing"),
        Resolution::MissingSubpath {
            target: vp("Views.base"),
            subpath: Subpath::View("Missing".into())
        }
    );
    assert_eq!(
        resolve("Views.base#table"),
        Resolution::MissingSubpath {
            target: vp("Views.base"),
            subpath: Subpath::View("table".into())
        },
        "view names match exactly (capture item view:case)"
    );
    assert_eq!(
        resolve("Views.base#^block"),
        Resolution::MissingSubpath {
            target: vp("Views.base"),
            subpath: Subpath::Block("block".into())
        }
    );
}

#[test]
fn a_view_name_with_unicode_resolves() {
    assert_eq!(
        resolve("Views.base#Tâble"),
        Resolution::Resolved {
            target: vp("Views.base"),
            subpath: Some(Subpath::View("Tâble".into()))
        }
    );
}

#[test]
fn a_note_heading_that_shares_a_view_name_is_still_a_heading() {
    assert_eq!(
        resolve("Home#Table"),
        Resolution::Resolved {
            target: vp("Home.md"),
            subpath: Some(Subpath::Heading("Table".into()))
        }
    );
}

#[test]
fn a_missing_view_has_its_own_diagnostic() {
    let note = parse_note(SourceDocument::new(
        vp("Home.md"),
        "![[Views.base#Missing]]\n",
    ));
    let reference = note.references[0].clone();
    let resolved = ResolvedReference {
        source: vp("Home.md"),
        source_span: reference.span,
        resolution: resolve("Views.base#Missing"),
        reference,
    };
    let diagnostic = resolution_diagnostic(&resolved).expect("a diagnostic");
    assert_eq!(diagnostic.code, DiagnosticCode::MissingView);
    assert!(
        diagnostic.message.contains("view"),
        "{}",
        diagnostic.message
    );
}

#[test]
fn a_changed_view_list_invalidates_references_to_that_base() {
    let keys = changed_candidate_keys(&ResolutionIdentityChange {
        old: Some(ResolutionNote::base(vp("Views.base"), vec!["Table".into()])),
        new: Some(ResolutionNote::base(vp("Views.base"), vec!["Cards".into()])),
    });
    assert!(keys.contains(&DependencyKey::new(
        DependencyKind::ResolvedTarget,
        "Views.base"
    )));
}

#[test]
fn the_complete_graph_resolves_through_bases() {
    let notes: Vec<ParsedNote> = vec![parse_note(SourceDocument::new(
        vp("Home.md"),
        "![[Views.base#Table]] and [[Views.base#Nope]]\n",
    ))];
    let report = build_graph_with_bases(
        notes,
        vec![ResolutionNote::base(vp("Views.base"), vec!["Table".into()])],
        Vec::new(),
    );
    let outgoing = report.graph.outgoing(&vp("Home.md"));
    assert_eq!(
        outgoing[0].resolution,
        Resolution::Resolved {
            target: vp("Views.base"),
            subpath: Some(Subpath::View("Table".into()))
        }
    );
    assert!(matches!(
        outgoing[1].resolution,
        Resolution::MissingSubpath { .. }
    ));
    assert_eq!(report.graph.backlinks(&vp("Views.base")).len(), 2);
    assert!(
        report
            .diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::MissingView)
    );
}

#[test]
fn is_base_reads_the_extension() {
    assert!(vp("Views.base").is_base());
    assert!(vp("Sub/V.BASE").is_base());
    assert!(!vp("Views.md").is_base());
    assert!(!vp("base").is_base());
}

#[test]
fn a_note_and_a_base_with_one_stem_resolve_by_the_written_extension() {
    let resolver = Resolver::from_catalog([
        note("Foo.md", &["Table"]),
        ResolutionNote::base(vp("Foo.base"), vec!["Table".into()]),
    ]);
    let resolve =
        |destination: &str| resolver.resolve_target(&vp("Foo.md"), &LinkTarget::parse(destination));
    assert_eq!(
        resolve("Foo"),
        Resolution::Resolved {
            target: vp("Foo.md"),
            subpath: None
        }
    );
    assert_eq!(
        resolve("foo"),
        Resolution::Resolved {
            target: vp("Foo.md"),
            subpath: None
        }
    );
    assert_eq!(
        resolve("Foo.md"),
        Resolution::Resolved {
            target: vp("Foo.md"),
            subpath: None
        }
    );
    assert_eq!(
        resolve("Foo.base"),
        Resolution::Resolved {
            target: vp("Foo.base"),
            subpath: None
        }
    );
    assert_eq!(
        resolve("foo.base"),
        Resolution::Resolved {
            target: vp("Foo.base"),
            subpath: None
        }
    );
    assert_eq!(
        resolve("Foo#Table"),
        Resolution::Resolved {
            target: vp("Foo.md"),
            subpath: Some(Subpath::Heading("Table".into()))
        }
    );
    assert_eq!(
        resolve("Foo.base#Table"),
        Resolution::Resolved {
            target: vp("Foo.base"),
            subpath: Some(Subpath::View("Table".into()))
        }
    );
}

#[test]
fn two_bases_with_one_filename_are_ambiguous_like_notes() {
    let resolver = Resolver::from_catalog([
        ResolutionNote::base(vp("A/Views.base"), vec![]),
        ResolutionNote::base(vp("B/Views.base"), vec![]),
    ]);
    assert_eq!(
        resolver.resolve_target(&vp("Home.md"), &LinkTarget::parse("Views.base")),
        Resolution::Ambiguous {
            candidates: vec![vp("A/Views.base"), vp("B/Views.base")]
        }
    );
}

#[test]
fn a_note_resolution_carries_no_view() {
    assert!(!note("Home.md", &[]).is_base());
    assert!(ResolutionNote::base(vp("Views.base"), vec![]).is_base());
}
