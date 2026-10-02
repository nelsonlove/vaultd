use vault_core::{LinkTarget, Resolution, ResolutionNote, Resolver, Subpath, VaultPath};

fn path(value: &str) -> VaultPath {
    VaultPath::new(value).expect("valid vault path")
}

#[test]
fn lightweight_catalog_uses_the_existing_resolution_rules() {
    let resolver = Resolver::from_catalog([
        ResolutionNote {
            path: path("Folder/Note.md"),
            headings: vec!["Exact Heading".into()],
            blocks: vec!["block-1".into()],
            views: None,
        },
        ResolutionNote {
            path: path("Other.md"),
            headings: vec![],
            blocks: vec![],
            views: None,
        },
    ]);

    assert_eq!(
        resolver.resolve_target(
            &path("Source.md"),
            &LinkTarget::parse("Folder/Note#Exact Heading"),
        ),
        Resolution::Resolved {
            target: path("Folder/Note.md"),
            subpath: Some(Subpath::Heading("Exact Heading".into())),
        }
    );
    assert_eq!(
        resolver.resolve_target(
            &path("Source.md"),
            &LinkTarget::parse("Folder/Note#^missing"),
        ),
        Resolution::MissingSubpath {
            target: path("Folder/Note.md"),
            subpath: Subpath::Block("missing".into()),
        }
    );
}

#[test]
fn destination_parser_preserves_raw_spelling_and_empty_file_targets() {
    assert_eq!(
        LinkTarget::parse("#Heading"),
        LinkTarget {
            raw_target: "#Heading".into(),
            file_target: None,
            subpath: Some(Subpath::Heading("Heading".into())),
        }
    );
}
