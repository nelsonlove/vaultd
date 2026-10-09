use vault_bases::{Direction, FilterNode, parse_base};
use vault_core::PropertyValue;

/// The example on `obsidian.md/help/bases/syntax`, verbatim.
const SYNTAX_PAGE_EXAMPLE: &str = r#"filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
"#;

#[test]
fn parses_the_syntax_page_example() {
    let base = parse_base(SYNTAX_PAGE_EXAMPLE).expect("the published example parses");

    let FilterNode::Or(arms) = base.filters.as_ref().expect("global filters") else {
        panic!("the top of the global filter is `or`: {:?}", base.filters);
    };
    assert_eq!(arms.len(), 3);
    assert_eq!(arms[0], FilterNode::Expr(r#"file.hasTag("tag")"#.into()));
    assert_eq!(
        arms[1],
        FilterNode::And(vec![
            FilterNode::Expr(r#"file.hasTag("book")"#.into()),
            FilterNode::Expr(r#"file.hasLink("Textbook")"#.into()),
        ])
    );
    assert!(matches!(&arms[2], FilterNode::Not(items) if items.len() == 2));

    assert_eq!(
        base.formulas,
        vec![
            (
                "formatted_price".to_string(),
                r#"if(price, price.toFixed(2) + " dollars")"#.to_string()
            ),
            ("ppu".to_string(), "(price / age).toFixed(2)".to_string()),
        ]
    );
    let names: Vec<(&str, Option<&str>)> = base
        .properties
        .iter()
        .map(|(key, settings)| (key.as_str(), settings.display_name.as_deref()))
        .collect();
    assert_eq!(
        names,
        vec![
            ("status", Some("Status")),
            ("formula.formatted_price", Some("Price")),
            ("file.ext", Some("Extension")),
        ]
    );
    assert_eq!(
        base.summaries,
        vec![(
            "customAverage".to_string(),
            "values.mean().round(3)".to_string()
        )]
    );

    assert_eq!(base.views.len(), 1);
    let view = &base.views[0];
    assert_eq!(view.kind, "table");
    assert_eq!(view.name, "My table");
    assert_eq!(view.limit, Some(10));
    let group = view.group_by.as_ref().expect("groupBy");
    assert_eq!(group.property, "note.age");
    assert_eq!(group.direction, Direction::Desc);
    assert_eq!(
        view.order,
        vec![
            "file.name",
            "file.ext",
            "note.age",
            "formula.ppu",
            "formula.formatted_price"
        ]
    );
    assert_eq!(
        view.summaries,
        vec![("formula.ppu".to_string(), "Average".to_string())]
    );
    assert!(matches!(&view.filters, Some(FilterNode::And(items)) if items.len() == 2));
    assert!(
        view.options.is_empty(),
        "every key of this view is a core key"
    );
    assert_eq!(base.view_names(), vec!["My table".to_string()]);
    assert!(base.view(None).is_some(), "absent names the first view");
    assert!(base.view(Some("My table")).is_some());
    assert!(
        base.view(Some("my table")).is_none(),
        "view names match exactly"
    );
}

#[test]
fn a_view_keeps_unknown_keys_and_unknown_types_as_declared() {
    let base = parse_base(
        "views:\n  - type: fileclass-table\n    name: Classes\n    fileClass: Person\n    columns:\n      - a\n      - b\n    sort:\n      - property: file.mtime\n        direction: desc\n",
    )
    .expect("a plugin view parses");
    let view = &base.views[0];
    assert_eq!(view.kind, "fileclass-table");
    assert_eq!(view.sort.len(), 1);
    assert_eq!(view.sort[0].property, "file.mtime");
    assert_eq!(view.sort[0].direction, Direction::Desc);
    let keys: Vec<&str> = view.options.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, vec!["fileClass", "columns"], "declared order is kept");
    assert_eq!(view.options[0].1, PropertyValue::String("Person".into()));
}

#[test]
fn a_filter_may_be_a_single_statement_string() {
    let base = parse_base("filters: 'file.ext == \"md\"'\nviews:\n  - type: table\n    name: T\n")
        .expect("a one-statement filter parses");
    assert_eq!(
        base.filters,
        Some(FilterNode::Expr(r#"file.ext == "md""#.into()))
    );
}

#[test]
fn an_empty_document_is_a_base_with_nothing_declared() {
    let base = parse_base("").expect("empty parses");
    assert!(base.views.is_empty());
    assert!(base.filters.is_none());
    assert!(base.view(None).is_none());
}

#[test]
fn shapes_that_are_yaml_but_not_a_base_fail_with_a_position() {
    for (text, needle) in [
        ("- a\n- b\n", "mapping"),
        ("views: 3\n", "views"),
        ("views:\n  - name: T\n", "type"),
        ("views:\n  - type: table\n", "name"),
        ("filters: 3\n", "filter"),
        ("filters:\n  xor:\n    - a\n", "and, or, or not"),
        ("formulas:\n  a:\n    - 1\n", "formula"),
        (
            "views:\n  - type: table\n    name: T\n    limit: -1\n",
            "limit",
        ),
        (
            "views:\n  - type: table\n    name: T\n    sort:\n      - direction: ASC\n",
            "property",
        ),
        (
            "views:\n  - type: table\n    name: T\n    groupBy:\n      property: a\n      direction: SIDEWAYS\n",
            "direction",
        ),
        // Captured (Task 13): Obsidian refuses a base whose `groupBy` has
        // no direction.
        (
            "views:\n  - type: table\n    name: T\n    groupBy:\n      property: a\n",
            "direction",
        ),
    ] {
        let error = parse_base(text).expect_err(text);
        assert!(
            error.message.contains(needle),
            "{text:?}: {:?} should mention {needle:?}",
            error.message
        );
        let span = error
            .span
            .unwrap_or_else(|| panic!("{text:?} carries a position"));
        assert!(
            span.end() <= text.len(),
            "{text:?}: span {span:?} is inside the text"
        );
    }
}

#[test]
fn invalid_yaml_fails_with_the_yaml_position() {
    let text = "views:\n  - type: table\n    name: [unclosed\n";
    let error = parse_base(text).expect_err("broken YAML");
    let span = error.span.expect("a position");
    assert!(span.start() >= text.find("[unclosed").unwrap(), "{span:?}");
}

#[test]
fn byte_spans_survive_multibyte_text() {
    // "Tâble" is 6 bytes and 5 chars: a char-indexed span would point one
    // byte early at everything after it.
    let text = "views:\n  - type: table\n    name: Tâble\n    limit: x\n";
    let error = parse_base(text).expect_err("limit must be a number");
    let span = error.span.expect("a position");
    assert_eq!(&text[span.start()..span.end()], "x");
}

#[test]
fn a_yaml_syntax_error_after_multibyte_text_reports_a_byte_position() {
    // "☃" is 3 bytes and 1 char, so a char index would land 2 bytes early.
    // saphyr stops at the end of the text, so the error sits at the last byte.
    let text = "a: \u{2603}\u{2603}\u{2603}\nb: [1, 2";
    let error = parse_base(text).expect_err("an unclosed flow sequence");
    let span = error.span.expect("a position");
    assert_eq!(span.start(), text.len(), "{span:?} is a byte offset");
    assert!(text.is_char_boundary(span.start()));
}

#[test]
fn a_property_keeps_its_unknown_settings_in_order() {
    let base = parse_base(
        "properties:\n  status:\n    width: 120\n    displayName: Status\n    wrap: true\n",
    )
    .expect("a property with view settings parses");
    let (key, settings) = &base.properties[0];
    assert_eq!(key, "status");
    assert_eq!(settings.display_name.as_deref(), Some("Status"));
    assert_eq!(
        settings.options,
        vec![
            ("width".to_string(), PropertyValue::Integer(120)),
            ("wrap".to_string(), PropertyValue::Boolean(true)),
        ]
    );
}

#[test]
fn an_empty_section_is_accepted_as_empty() {
    for section in ["filters", "formulas", "properties", "summaries", "views"] {
        let text = format!("{section}:\n");
        let base = parse_base(&text).unwrap_or_else(|error| panic!("{text:?}: {error:?}"));
        assert_eq!(base, vault_bases::BaseFile::default(), "{text:?}");
    }
}

#[test]
fn an_empty_view_section_is_accepted_as_empty() {
    for section in ["filters", "order", "sort", "groupBy", "summaries", "limit"] {
        let text = format!("views:\n  - type: table\n    name: T\n    {section}:\n");
        let base = parse_base(&text).unwrap_or_else(|error| panic!("{text:?}: {error:?}"));
        let view = &base.views[0];
        assert!(view.filters.is_none(), "{text:?}");
        // An empty or absent `order` is the one column `file.name`
        // (captured, Task 13).
        assert_eq!(view.order, vec!["file.name".to_string()], "{text:?}");
        assert!(view.sort.is_empty(), "{text:?}");
        assert!(view.group_by.is_none(), "{text:?}");
        assert!(view.summaries.is_empty(), "{text:?}");
        assert!(view.limit.is_none(), "{text:?}");
        assert!(view.options.is_empty(), "{text:?}");
    }
}

#[test]
fn a_duplicate_key_inside_a_view_is_last_wins() {
    let base = parse_base(
        "views:\n  - type: table\n    name: First\n    limit: 1\n    name: Second\n    extra: a\n    extra: b\n",
    )
    .expect("duplicate keys parse");
    let view = &base.views[0];
    assert_eq!(view.name, "Second");
    assert_eq!(view.limit, Some(1));
    assert_eq!(
        view.options,
        vec![("extra".to_string(), PropertyValue::String("b".into()))]
    );
}

#[test]
fn a_duplicate_key_at_the_top_level_is_last_wins() {
    let base = parse_base(
        "formulas:\n  a: '1'\n  a: '2'\nformulas:\n  b: '3'\n  b: '4'\nviews:\n  - type: table\n    name: T\n",
    )
    .expect("duplicate keys parse");
    assert_eq!(base.formulas, vec![("b".to_string(), "4".to_string())]);
}

#[test]
fn parses_the_syntax_page_single_and_snippet() {
    // The one snippet on `obsidian.md/help/bases/syntax` that is not part of
    // the full example above, verbatim.
    let base = parse_base("filters:\n  and:\n    - file.hasTag(\"tag\")\n")
        .expect("the published snippet parses");
    assert_eq!(
        base.filters,
        Some(FilterNode::And(vec![FilterNode::Expr(
            r#"file.hasTag("tag")"#.into()
        )]))
    );
    assert!(base.views.is_empty());
}

/// A property declared with nothing under it (`properties:\n  x:`) is the
/// empty-settings case under the empty-section rule, not an error; a
/// declared neighbour keeps its settings.
#[test]
fn a_property_with_null_settings_has_empty_settings() {
    let base = parse_base("properties:\n  x:\n  y:\n    displayName: Why\n").expect("parses");
    assert_eq!(
        base.properties,
        vec![
            ("x".to_string(), vault_bases::PropertySettings::default()),
            (
                "y".to_string(),
                vault_bases::PropertySettings {
                    display_name: Some("Why".into()),
                    options: Vec::new(),
                }
            ),
        ]
    );
}
