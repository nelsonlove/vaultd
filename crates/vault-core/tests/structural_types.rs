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
