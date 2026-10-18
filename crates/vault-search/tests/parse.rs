use proptest::prelude::*;
use vault_search::{Node, Pattern, PropertyValueQuery, Query, Scope, Term, parse_query};

fn word(text: &str) -> Node {
    Node::Term(Term {
        pattern: Pattern::Text(text.into()),
        phrase: false,
        at: 0..0,
    })
}
fn phrase(text: &str) -> Node {
    Node::Term(Term {
        pattern: Pattern::Text(text.into()),
        phrase: true,
        at: 0..0,
    })
}
fn regex(source: &str, flags: &str) -> Node {
    Node::Term(Term {
        pattern: Pattern::Regex {
            source: source.into(),
            flags: flags.into(),
        },
        phrase: false,
        at: 0..0,
    })
}
fn and(items: Vec<Node>) -> Node {
    Node::And(items)
}
fn or(items: Vec<Node>) -> Node {
    Node::Or(items)
}
fn not(item: Node) -> Node {
    Node::Not(Box::new(item))
}
fn scoped(scope: Scope, query: Node) -> Node {
    Node::Scoped {
        scope,
        query: Box::new(query),
        at: 0..0,
    }
}
fn case(sensitive: bool, query: Node) -> Node {
    Node::Case {
        sensitive,
        query: Box::new(query),
        at: 0..0,
    }
}
fn property(name: Node, value: Option<PropertyValueQuery>) -> Node {
    Node::Property {
        name: Box::new(name),
        value,
        at: 0..0,
    }
}
fn parsed(text: &str) -> Node {
    parse_query(text)
        .unwrap_or_else(|error| panic!("{text:?}: {error:?}"))
        .strip_positions()
        .root
        .unwrap_or_else(|| panic!("{text:?} parsed to an empty query"))
}

const PUBLISHED: &[&str] = &[
    r#""star wars""#,
    r#""they said \"hello\" to each other""#,
    "meeting work",
    "meeting OR work",
    "meeting work OR meetup personal",
    "meeting (work OR meetup) personal",
    "meeting -work",
    "meeting -work -meetup",
    "meeting -(work meetup)",
    "meeting [duration:<5]",
    "meeting [duration:>5]",
    "task:(call OR email)",
    "file:.jpg",
    "file:202209",
    r#"path:"Daily notes/2022-07""#,
    r#"content:"happy cat""#,
    "match-case:HappyCat",
    "ignore-case:ikea",
    "tag:#work",
    "line:(mix flour)",
    "block:(dog cat)",
    "section:(dog cat)",
    "task:call",
    "task-todo:call",
    "task-done:call",
    "[aliases]",
    "[aliases:Name]",
    "[aliases:null]",
    "[status:Draft OR Published]",
    r"/\d{4}-\d{2}-\d{2}/",
    r"path:/\d{4}-\d{2}-\d{2}/",
    "embed OR search",
];

#[test]
fn every_published_query_parses() {
    let failures: Vec<String> = PUBLISHED
        .iter()
        .filter_map(|text| {
            parse_query(text)
                .err()
                .map(|error| format!("{text:?}: {error:?}"))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "failed to parse:\n{}",
        failures.join("\n")
    );
}

#[test]
fn and_binds_tighter_than_or_as_the_help_page_shows() {
    assert_eq!(
        parsed("meeting work OR meetup personal"),
        or(vec![
            and(vec![word("meeting"), word("work")]),
            and(vec![word("meetup"), word("personal")])
        ])
    );
    assert_eq!(
        parsed("meeting (work OR meetup) personal"),
        and(vec![
            word("meeting"),
            or(vec![word("work"), word("meetup")]),
            word("personal")
        ])
    );
}

#[test]
fn negation_applies_to_words_groups_and_operators() {
    assert_eq!(
        parsed("meeting -work -meetup"),
        and(vec![
            word("meeting"),
            not(word("work")),
            not(word("meetup"))
        ])
    );
    assert_eq!(
        parsed("meeting -(work meetup)"),
        and(vec![
            word("meeting"),
            not(and(vec![word("work"), word("meetup")]))
        ])
    );
    assert_eq!(
        parsed("-line:(mix flour)"),
        not(scoped(Scope::Line, and(vec![word("mix"), word("flour")])))
    );
    assert_eq!(parsed("-file:.png"), not(scoped(Scope::File, word(".png"))));
    assert_eq!(
        parsed("well-known"),
        word("well-known"),
        "a hyphen negates only at the start"
    );
}

#[test]
fn a_hyphen_negates_the_group_or_term_right_after_it() {
    assert_eq!(
        parsed("meeting -(work meetup)"),
        and(vec![
            word("meeting"),
            not(and(vec![word("work"), word("meetup")]))
        ])
    );
    assert_eq!(parsed("-(a)"), not(word("a")));
    assert_eq!(parsed("--a"), not(not(word("a"))));
    assert_eq!(parsed(r#"-"a b""#), not(phrase("a b")));
    assert_eq!(parsed("-[aliases]"), not(property(word("aliases"), None)));
}

#[test]
fn a_phrase_unescapes_quotes_and_backslashes_only() {
    assert_eq!(
        parsed(r#""they said \"hello\" to each other""#),
        phrase(r#"they said "hello" to each other"#)
    );
    assert_eq!(parsed(r#""a\\b""#), phrase(r"a\b"));
    assert_eq!(
        parsed(r#""a\nb""#),
        phrase(r"a\nb"),
        "any other backslash is literal"
    );
}

#[test]
fn operators_take_words_phrases_regexes_and_sub_queries() {
    assert_eq!(parsed("file:.jpg"), scoped(Scope::File, word(".jpg")));
    assert_eq!(
        parsed(r#"path:"Daily notes/2022-07""#),
        scoped(Scope::Path, phrase("Daily notes/2022-07"))
    );
    assert_eq!(
        parsed(r"path:/\d{4}/"),
        scoped(Scope::Path, regex(r"\d{4}", ""))
    );
    assert_eq!(
        parsed("task:(call OR email)"),
        scoped(Scope::Task, or(vec![word("call"), word("email")]))
    );
    assert_eq!(
        parsed("task-todo:call"),
        scoped(Scope::TaskTodo, word("call"))
    );
    assert_eq!(
        parsed("task-done:call"),
        scoped(Scope::TaskDone, word("call"))
    );
    assert_eq!(parsed("tag:#work"), scoped(Scope::Tag, word("#work")));
    assert_eq!(parsed("match-case:HappyCat"), case(true, word("HappyCat")));
    assert_eq!(parsed("ignore-case:ikea"), case(false, word("ikea")));
    assert_eq!(
        parsed("content:(a OR b)"),
        scoped(Scope::Content, or(vec![word("a"), word("b")]))
    );
}

#[test]
fn property_forms_parse_with_sub_queries_null_and_comparisons() {
    assert_eq!(parsed("[aliases]"), property(word("aliases"), None));
    assert_eq!(
        parsed("[aliases:Name]"),
        property(
            word("aliases"),
            Some(PropertyValueQuery::Query(Box::new(word("Name"))))
        )
    );
    assert_eq!(
        parsed("[aliases:null]"),
        property(word("aliases"), Some(PropertyValueQuery::Null))
    );
    assert_eq!(
        parsed("[status:Draft OR Published]"),
        property(
            word("status"),
            Some(PropertyValueQuery::Query(Box::new(or(vec![
                word("Draft"),
                word("Published")
            ]))))
        )
    );
    assert_eq!(
        parsed("[duration:<5]"),
        property(word("duration"), Some(PropertyValueQuery::Less(5.0)))
    );
    assert_eq!(
        parsed("[duration:>2.5]"),
        property(word("duration"), Some(PropertyValueQuery::Greater(2.5)))
    );
    assert_eq!(
        parsed("[file:x]"),
        property(
            word("file"),
            Some(PropertyValueQuery::Query(Box::new(word("x"))))
        ),
        "no operators inside brackets"
    );
}

#[test]
fn the_lexical_provisional_rules() {
    assert_eq!(
        parsed("a or b"),
        and(vec![word("a"), word("or"), word("b")]),
        "P6: only upper-case OR"
    );
    assert_eq!(
        parsed("foo:bar"),
        word("foo:bar"),
        "P7: an unknown prefix is a word"
    );
    assert_eq!(parsed("/abc/i"), regex("abc", "i"));
    assert_eq!(
        parsed("/usr/local"),
        word("/usr/local"),
        "no word end after the closing slash: a word"
    );
    assert_eq!(parsed("/usr"), word("/usr"), "no closing slash: a word");
    assert_eq!(parsed("a/b c"), and(vec![word("a/b"), word("c")]));
    assert_eq!(parse_query("").unwrap().root, None);
    assert_eq!(parse_query("  \t ").unwrap().root, None);
}

#[test]
fn malformed_queries_are_refused_with_a_position() {
    for (text, position) in [
        ("(a b", 0),
        ("a b)", 3),
        (r#"x "abc"#, 2),
        ("[aliases", 0),
        ("()", 0),
        ("[]", 0),
        ("a -", 2),
        ("a -)", 2),
        ("a - b", 2),
        ("OR a", 0),
        ("a OR", 2),
        ("a OR )", 2),
        ("file:", 0),
        ("a file: b", 2),
        ("[duration:<five]", 10),
        ("[a)]", 2),
        ("[x:a)]", 4),
        ("[x:<nan]", 3),
        ("[x:>inf]", 3),
        ("[x:<-Infinity]", 3),
    ] {
        let error = parse_query(text).expect_err(text);
        assert_eq!(error.position, position, "{text:?}: {error:?}");
        assert!(!error.message.is_empty());
    }
    let deep = format!("{}a{}", "(".repeat(65), ")".repeat(65));
    assert_eq!(parse_query(&deep).expect_err("too deep").position, 64);
}

#[test]
fn positions_are_character_offsets() {
    let query = parse_query("é tag:x").unwrap();
    let Some(Node::And(items)) = query.root else {
        panic!("an AND")
    };
    let Node::Term(first) = &items[0] else {
        panic!("a term")
    };
    assert_eq!(first.at, 0..1);
    let Node::Scoped { at, .. } = &items[1] else {
        panic!("a scope")
    };
    assert_eq!(*at, 2..5, "the operator name, in characters");
    assert_eq!(parse_query("é (").unwrap_err().position, 2);
}

fn arb_word() -> impl Strategy<Value = String> {
    "[a-z0-9éß]{1,6}".prop_filter("not a keyword", |w| w != "null")
}

fn arb_leaf() -> impl Strategy<Value = Node> {
    prop_oneof![
        arb_word().prop_map(|w| word(&w)),
        "[a-z \"\\\\()]{1,8}".prop_map(|p| phrase(&p)),
        "[a-z0-9.]{1,5}".prop_map(|r| regex(&r, "")),
    ]
}

/// What a property's value can hold: inside `[…]` no operator and no
/// property is recognized, so the value draws from terms and the boolean
/// connectives only.
fn arb_plain() -> impl Strategy<Value = Node> {
    arb_leaf().prop_recursive(3, 12, 3, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 2..4).prop_map(Node::And),
            prop::collection::vec(inner.clone(), 2..4).prop_map(Node::Or),
            inner.prop_map(|n| Node::Not(Box::new(n))),
        ]
    })
}

fn arb_node() -> impl Strategy<Value = Node> {
    arb_leaf().prop_recursive(4, 24, 4, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 2..4).prop_map(Node::And),
            prop::collection::vec(inner.clone(), 2..4).prop_map(Node::Or),
            inner.clone().prop_map(|n| Node::Not(Box::new(n))),
            (
                prop::sample::select(vec![
                    Scope::File,
                    Scope::Path,
                    Scope::Content,
                    Scope::Tag,
                    Scope::Line,
                    Scope::Block,
                    Scope::Section,
                    Scope::Task,
                    Scope::TaskTodo,
                    Scope::TaskDone,
                ]),
                inner.clone(),
            )
                .prop_map(|(scope, n)| scoped(scope, n)),
            (any::<bool>(), inner.clone()).prop_map(|(s, n)| case(s, n)),
            (arb_word(), arb_plain()).prop_map(|(name, n)| property(
                word(&name),
                Some(PropertyValueQuery::Query(Box::new(n)))
            )),
        ]
    })
}

proptest! {
    #[test]
    fn printing_and_parsing_round_trips(node in arb_node()) {
        let query = Query { root: Some(node) }.strip_positions();
        let printed = query.to_string();
        let again = parse_query(&printed).map_err(|e| TestCaseError::fail(format!("{printed:?}: {e:?}")))?;
        prop_assert_eq!(normalize(again.strip_positions()), normalize(query), "printed as {:?}", printed);
    }
}

/// Flatten nested ANDs and ORs of the same kind, which print identically:
/// `And([a, And([b, c])])` and `And([a, b, c])` are one query.
fn normalize(query: Query) -> Query {
    fn flat(node: Node) -> Node {
        match node {
            Node::And(items) => Node::And(
                items
                    .into_iter()
                    .map(flat)
                    .flat_map(|n| match n {
                        Node::And(inner) => inner,
                        other => vec![other],
                    })
                    .collect(),
            ),
            Node::Or(items) => Node::Or(
                items
                    .into_iter()
                    .map(flat)
                    .flat_map(|n| match n {
                        Node::Or(inner) => inner,
                        other => vec![other],
                    })
                    .collect(),
            ),
            Node::Not(inner) => Node::Not(Box::new(flat(*inner))),
            Node::Scoped { scope, query, at } => Node::Scoped {
                scope,
                query: Box::new(flat(*query)),
                at,
            },
            Node::Case {
                sensitive,
                query,
                at,
            } => Node::Case {
                sensitive,
                query: Box::new(flat(*query)),
                at,
            },
            Node::Property { name, value, at } => Node::Property {
                name: Box::new(flat(*name)),
                value: value.map(|v| match v {
                    PropertyValueQuery::Query(q) => PropertyValueQuery::Query(Box::new(flat(*q))),
                    other => other,
                }),
                at,
            },
            leaf => leaf,
        }
    }
    Query {
        root: query.root.map(flat),
    }
}

/// Parse, print, parse again: the second tree equals the first, positions
/// aside.
fn assert_round_trips(text: &str) {
    let first = parse_query(text)
        .unwrap_or_else(|error| panic!("{text:?}: {error:?}"))
        .strip_positions();
    let printed = first.to_string();
    let again = parse_query(&printed)
        .unwrap_or_else(|error| panic!("{text:?} printed as {printed:?}: {error:?}"))
        .strip_positions();
    assert_eq!(again, first, "{text:?} printed as {printed:?}");
}

#[test]
fn a_group_inside_brackets_keeps_the_bracket_rules() {
    assert_eq!(
        parsed("[x:(file:a)]"),
        property(
            word("x"),
            Some(PropertyValueQuery::Query(Box::new(word("file:a"))))
        ),
        "no operator inside brackets, even inside a group"
    );
    assert_eq!(
        parsed("[status:(Draft OR Published)]"),
        parsed("[status:Draft OR Published]")
    );
    assert!(
        parse_query("[x:(-[y])]").is_err(),
        "no property inside brackets, even inside a group: `]` ends the word `[y`"
    );
    assert_round_trips("[x:(file:a)]");
    assert_round_trips("[status:(Draft OR Published)]");
    assert_round_trips("[x:(a b) OR c]");
}
