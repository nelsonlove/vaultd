use vault_core::{
    ListItem, ListItemParent, ParsedNote, Section, SectionKind, SourceDocument, SourceSpan,
    VaultPath,
};

#[test]
fn parsed_note_empty_yields_empty_sections_and_list_items() {
    let source = SourceDocument::new(VaultPath::new("Empty.md").expect("valid path"), "");
    let parsed = ParsedNote::empty(source);

    assert_eq!(parsed.sections, Vec::<Section>::new());
    assert_eq!(parsed.list_items, Vec::<ListItem>::new());
}

#[test]
fn section_and_nested_list_item_round_trip() {
    let source = SourceDocument::new(
        VaultPath::new("Notes/Example.md").expect("valid path"),
        "- top\n    - nested\n",
    );
    let list_span = SourceSpan::new(0, 19).expect("valid span");
    let top_span = SourceSpan::new(0, 5).expect("valid span");
    let nested_span = SourceSpan::new(10, 18).expect("valid span");

    let section = Section {
        kind: SectionKind::List,
        span: list_span,
        block_id: None,
    };
    let top_item = ListItem {
        span: top_span,
        parent: ListItemParent::Root { list_start_line: 0 },
        task: None,
    };
    let nested_item = ListItem {
        span: nested_span,
        parent: ListItemParent::Item {
            parent_start_line: 0,
        },
        task: None,
    };

    let parsed = ParsedNote {
        sections: vec![section.clone()],
        list_items: vec![top_item.clone(), nested_item.clone()],
        ..ParsedNote::empty(source)
    };

    assert_eq!(parsed.sections, vec![section]);
    assert_eq!(parsed.list_items[0], top_item);
    assert_eq!(parsed.list_items[1], nested_item);
    assert_eq!(
        parsed.list_items[1].parent,
        ListItemParent::Item {
            parent_start_line: 0
        }
    );
    assert_eq!(
        parsed.list_items[0].parent,
        ListItemParent::Root { list_start_line: 0 }
    );
}

/// Tripwire for a silent index-corruption hazard: `SectionKind::Other(s)`
/// persists `s` literally, and the index codec decodes known wire strings to
/// their named variants first — so if `node_type_name` in `markdown.rs` ever
/// emitted a string that collides with the known vocabulary, an `Other`
/// would come back from the store as the WRONG named variant with no error
/// anywhere. Both lists are duplicated here on purpose; update BOTH this
/// test and the source when either vocabulary changes, and never let them
/// intersect.
#[test]
fn other_section_names_never_collide_with_the_known_wire_vocabulary() {
    // The closed output set of `node_type_name` (crates/vault-core/src/markdown.rs).
    let other_names = [
        "definition",
        "footnoteDefinition",
        "math",
        "mdxFlowExpression",
        "mdxJsxFlowElement",
        "mdxjsEsm",
        "toml",
        "unknown",
    ];
    // The named-variant wire vocabulary (fixtures README, first capture).
    let known = [
        "yaml",
        "heading",
        "paragraph",
        "code",
        "blockquote",
        "table",
        "thematicBreak",
        "list",
        "callout",
        "html",
    ];
    for name in other_names {
        assert!(
            !known.contains(&name),
            "node_type_name output {name:?} collides with a known wire string — \
             an Other({name:?}) row would decode as the named variant"
        );
    }
}
