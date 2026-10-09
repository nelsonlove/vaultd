use vault_bases::expr::{BinaryOp, Expr, UnaryOp, parse_expression};

/// Every expression on the published syntax, functions and views pages,
/// transcribed 2026-10-02, but those in [`PUBLISHED_BUT_REFUSED`]. Each one
/// must parse; what it evaluates to is pinned per family in Tasks 3 to 7.
const PUBLISHED: &[&str] = &[
    r#"file.hasTag("tag")"#,
    r#"file.hasTag("book")"#,
    r#"file.hasLink("Textbook")"#,
    r#"file.inFolder("Required Reading")"#,
    r#"if(price, price.toFixed(2) + " dollars")"#,
    "(price / age).toFixed(2)",
    "values.mean().round(3)",
    r#"status != "done""#,
    "formula.ppu > 5",
    "price > 2.1",
    r#"file.ext == "md""#,
    "note.price",
    r#"note["price"]"#,
    "note.author",
    "author",
    "file.size",
    "file.ext",
    "file.hasLink()",
    "formula.formatted_price",
    "this.file.folder",
    "this.file.name",
    "file.hasLink(this.file)",
    "radius * (2 * 3.14)",
    r#"date + "1M""#,
    r#"date - "2h""#,
    r#"now() + "1 day""#,
    r#"file.mtime > now() - "1 week""#,
    r#"date("2024-12-01") + "1M" + "4h" + "3m""#,
    "now() - file.ctime",
    "datetime.date()",
    r#"datetime.format("YYYY-MM-DD")"#,
    r#""message""#,
    "1",
    "(2.5)",
    "true",
    "false",
    r#"date("2025-01-01 12:00:00")"#,
    r#"now() + "1 hour""#,
    r#"today() + "7d""#,
    r#"(now() + "1d") - now()"#,
    "now().hour",
    "now.time()",
    "property[0]",
    "property.subprop",
    r#"property["subprop"]"#,
    r#"link("filename")"#,
    r#"link("https://obsidian.md")"#,
    "link(file.ctime.date().toString())",
    r#"link("filename", "display")"#,
    r#"link("filename", icon("plus"))"#,
    "file.asLink()",
    "author == this",
    "authors.contains(this)",
    "now() + '1d'",
    "now() + (duration('1d') * 2)",
    "duration('5h') * 2",
    "2 * duration('5h')",
    r#"file(link("[[filename]]"))"#,
    r#"file("path to file")"#,
    r#"if(isModified, "Modified", "Unmodified")"#,
    "image(image-property)",
    r#"image("https://obsidian.md/images/obsidian-logo-gradient.svg")"#,
    r#"icon("arrow-right")"#,
    r#"list("value")"#,
    r#"number("3.4")"#,
    r#""example".isType("string")"#,
    r#"true.isType("boolean")"#,
    r#"now().date().format("YYYY-MM-DD HH:mm:ss")"#,
    r#"date.format("YYYY-MM-DD")"#,
    "now().time()",
    "file.mtime.relative()",
    r#""hello".contains("ell")"#,
    r#""hello".containsAll("h", "e")"#,
    r#""hello".containsAny("x", "y", "e")"#,
    r#""hello".endsWith("lo")"#,
    r#""Hello world".isEmpty()"#,
    r#""".isEmpty()"#,
    r#""a:b:c:d".replace(/:/, "-")"#,
    r#""a:b:c:d".replace(/:/g, "-")"#,
    r#""John Smith".replace(/(\w+) (\w+)/, "$2, $1")"#,
    r#""123".repeat(2)"#,
    r#""hello".reverse()"#,
    r#""hello".slice(1, 4)"#,
    r#""a,b,c,d".split(",", 3)"#,
    r#""a,b,c,d".split(/,/, 3)"#,
    r#""hello".startsWith("he")"#,
    r#""hello world".title()"#,
    r#""  hi  ".trim()"#,
    "(-5).abs()",
    "(2.1).ceil()",
    "(2.9).floor()",
    "(2.5).round()",
    "(2.3333).round(2)",
    "(3.14159).toFixed(2)",
    "[1,2,3].contains(2)",
    "[1,2,3].containsAll(2,3)",
    "[1,2,3].containsAny(3,4)",
    "[1,2,3,4].filter(value > 2)",
    "[1,[2,3]].flat()",
    "[1,2,3].isEmpty()",
    r#"[1,2,3].join(",")"#,
    "[1,2,3,4].map(value + 1)",
    "[1,2,3].reduce(acc + value, 0)",
    r#"values.filter(value.isType("number")).reduce(if(acc == null || value > acc, value, acc), null)"#,
    "[1,2,3].reverse()",
    "[1,2,3,4].slice(1,3)",
    "[3, 1, 2].sort()",
    r#"["c", "a", "b"].sort()"#,
    "[1,2,2,3].unique()",
    r#"link("[[filename]]").asFile()"#,
    "file.hasLink(otherFile)",
    r#"file.hasTag("tag1", "tag2")"#,
    r#"file.inFolder("notes")"#,
    r#"/abc/.matches("abcde")"#,
];

/// Published examples Obsidian 1.13.7 itself cannot parse (captured: it
/// shows such a cell empty): a method on a bare number literal and an object
/// literal. vaultd refuses them too (ruling R1, spec ruling 7).
const PUBLISHED_BUT_REFUSED: &[&str] = &[
    "1.isTruthy()",
    "123.toString()",
    "5.isEmpty()",
    "{}.isEmpty()",
];

#[test]
fn published_examples_obsidian_cannot_parse_are_refused() {
    for text in PUBLISHED_BUT_REFUSED {
        assert!(parse_expression(text).is_err(), "{text:?}");
    }
}

#[test]
fn every_published_expression_parses() {
    let mut failures = Vec::new();
    for text in PUBLISHED {
        if let Err(error) = parse_expression(text) {
            failures.push(format!("{text:?}: {} at {}", error.message, error.position));
        }
    }
    assert!(
        failures.is_empty(),
        "{} failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn id(name: &str) -> Box<Expr> {
    Box::new(Expr::Identifier(name.into()))
}

#[test]
fn multiplication_binds_tighter_than_addition_and_comparison_tighter_than_logic() {
    let parsed = parse_expression("a + b * c > d && !e || f").expect("parses");
    let expected = Expr::Binary {
        op: BinaryOp::Or,
        left: Box::new(Expr::Binary {
            op: BinaryOp::And,
            left: Box::new(Expr::Binary {
                op: BinaryOp::Gt,
                left: Box::new(Expr::Binary {
                    op: BinaryOp::Add,
                    left: id("a"),
                    right: Box::new(Expr::Binary {
                        op: BinaryOp::Mul,
                        left: id("b"),
                        right: id("c"),
                    }),
                }),
                right: id("d"),
            }),
            right: Box::new(Expr::Unary {
                op: UnaryOp::Not,
                operand: id("e"),
            }),
        }),
        right: id("f"),
    };
    assert_eq!(parsed, expected);
}

#[test]
fn subtraction_and_division_associate_to_the_left() {
    assert_eq!(
        parse_expression("a - b - c").unwrap(),
        Expr::Binary {
            op: BinaryOp::Sub,
            left: Box::new(Expr::Binary {
                op: BinaryOp::Sub,
                left: id("a"),
                right: id("b")
            }),
            right: id("c"),
        }
    );
    assert_eq!(
        parse_expression("a / b / c").unwrap(),
        Expr::Binary {
            op: BinaryOp::Div,
            left: Box::new(Expr::Binary {
                op: BinaryOp::Div,
                left: id("a"),
                right: id("b")
            }),
            right: id("c"),
        }
    );
}

/// Ruling R1 (spec ruling 7): what Obsidian 1.13.7 cannot parse, vaultd
/// refuses too (captured, the `x_*` syntax probes and the family rows of
/// kind `invalid`): exponent literals, a method on a bare number literal,
/// object literals, a regular expression literal JavaScript refuses, and a
/// raw line or paragraph separator inside a string.
#[test]
fn what_obsidian_cannot_parse_is_refused() {
    for text in [
        "1e3",
        "1.5e3",
        "1E-7",
        "(1e21).toString()",
        "5.isEmpty()",
        "0.isTruthy()",
        "{}",
        r#"{"a": 1, b: 2}"#,
        "{}.isEmpty()",
        "/a/q",
        "/a/gg",
        "/a(/",
        "\"a\u{2028}\"",
        "'a\u{2029}'",
    ] {
        assert!(parse_expression(text).is_err(), "{text:?}");
    }
    // The forms next to them still parse.
    assert_eq!(
        parse_expression("(5).isEmpty()").unwrap(),
        Expr::Method {
            target: Box::new(Expr::Number(5.0)),
            name: "isEmpty".into(),
            args: vec![],
            position: 4,
        }
    );
    assert_eq!(parse_expression("2.5").unwrap(), Expr::Number(2.5));
    assert!(parse_expression("e3").is_ok(), "a name, not a number");
    assert!(
        parse_expression(r#""a\u2028""#).is_ok(),
        "the escape is fine"
    );
    assert!(
        parse_expression("/(?<=a)b/").is_ok(),
        "JavaScript reads a look-behind"
    );
    assert!(parse_expression("/a/gimsuy").is_ok());
}

#[test]
fn a_slash_after_a_value_divides_and_elsewhere_starts_a_regexp() {
    assert!(matches!(
        parse_expression("price / age").unwrap(),
        Expr::Binary {
            op: BinaryOp::Div,
            ..
        }
    ));
    let Expr::Method { args, .. } = parse_expression(r#""a:b".replace(/:/g, "-")"#).unwrap() else {
        panic!("a method call");
    };
    assert_eq!(
        args[0],
        Expr::Regexp {
            source: ":".into(),
            flags: "g".into()
        }
    );
    let Expr::Method { args, .. } = parse_expression(r#""x".replace(/a\/b[/]c/, "")"#).unwrap()
    else {
        panic!("a method call");
    };
    assert_eq!(
        args[0],
        Expr::Regexp {
            source: r"a\/b[/]c".into(),
            flags: "".into()
        },
        "an escaped slash and a slash in a class do not end the literal"
    );
}

#[test]
fn indexing_member_access_and_calls_chain_left_to_right() {
    assert_eq!(
        parse_expression(r#"note["my prop"][0].length"#).unwrap(),
        Expr::Member {
            target: Box::new(Expr::Index {
                target: Box::new(Expr::Index {
                    target: id("note"),
                    index: Box::new(Expr::String("my prop".into())),
                }),
                index: Box::new(Expr::Number(0.0)),
            }),
            name: "length".into(),
        }
    );
    assert_eq!(
        parse_expression("today()").unwrap(),
        Expr::Call {
            name: "today".into(),
            args: vec![],
            position: 0
        }
    );
}

#[test]
fn literals_cover_strings_with_escapes_lists_and_null() {
    assert_eq!(
        parse_expression(r#"'it\'s' + "a\"b\né""#).unwrap(),
        Expr::Binary {
            op: BinaryOp::Add,
            left: Box::new(Expr::String("it's".into())),
            right: Box::new(Expr::String("a\"b\né".into())),
        }
    );
    assert_eq!(
        parse_expression(r#"[1, "a", null, [true]]"#).unwrap(),
        Expr::List(vec![
            Expr::Number(1.0),
            Expr::String("a".into()),
            Expr::Null,
            Expr::List(vec![Expr::Boolean(true)]),
        ])
    );
    assert_eq!(
        parse_expression("-x").unwrap(),
        Expr::Unary {
            op: UnaryOp::Negate,
            operand: id("x")
        }
    );
}

#[test]
fn unicode_identifiers_and_strings_parse_and_positions_are_bytes() {
    assert_eq!(
        parse_expression("prioritét").unwrap(),
        Expr::Identifier("prioritét".into())
    );
    let error = parse_expression(r#""é" +"#).expect_err("dangling operator");
    assert_eq!(
        error.position,
        r#""é" +"#.len(),
        "the end of input, in bytes"
    );
}

#[test]
fn errors_name_what_went_wrong_and_where() {
    for (text, position, needle) in [
        ("1 +", 3, "expected an expression"),
        (r#""open"#, 0, "unterminated string"),
        ("f(1,", 4, "expected an expression"),
        ("(1", 2, "expected `)`"),
        ("a..b", 2, "expected a name"),
        ("1 2", 2, "unexpected"),
        ("/open", 0, "unterminated regular expression"),
        ("#", 0, "unexpected character"),
        ("a = b", 2, "unexpected character"),
    ] {
        let error = parse_expression(text).expect_err(text);
        assert_eq!(error.position, position, "{text:?}: {}", error.message);
        assert!(
            error.message.contains(needle),
            "{text:?}: {:?}",
            error.message
        );
    }
}

fn bin(op: BinaryOp, left: Box<Expr>, right: Box<Expr>) -> Box<Expr> {
    Box::new(Expr::Binary { op, left, right })
}

/// Every operator of the precedence table, by level, lowest first. Each pair
/// of neighbouring levels is checked in both orders, so a swap of any two
/// levels changes at least one expected tree.
#[test]
fn every_precedence_level_binds_tighter_than_the_one_below_it() {
    let levels: [&[(&str, BinaryOp)]; 6] = [
        &[("||", BinaryOp::Or)],
        &[("&&", BinaryOp::And)],
        &[("==", BinaryOp::Eq), ("!=", BinaryOp::Ne)],
        &[
            ("<", BinaryOp::Lt),
            ("<=", BinaryOp::Le),
            (">", BinaryOp::Gt),
            (">=", BinaryOp::Ge),
        ],
        &[("+", BinaryOp::Add), ("-", BinaryOp::Sub)],
        &[
            ("*", BinaryOp::Mul),
            ("/", BinaryOp::Div),
            ("%", BinaryOp::Rem),
        ],
    ];
    for pair in levels.windows(2) {
        for &(low_text, low) in pair[0] {
            for &(high_text, high) in pair[1] {
                let text = format!("a {low_text} b {high_text} c");
                assert_eq!(
                    Box::new(parse_expression(&text).unwrap()),
                    bin(low, id("a"), bin(high, id("b"), id("c"))),
                    "{text}"
                );
                let text = format!("a {high_text} b {low_text} c");
                assert_eq!(
                    Box::new(parse_expression(&text).unwrap()),
                    bin(low, bin(high, id("a"), id("b")), id("c")),
                    "{text}"
                );
            }
        }
    }
    for level in levels {
        for &(first_text, first) in level {
            for &(second_text, second) in level {
                let text = format!("a {first_text} b {second_text} c");
                assert_eq!(
                    Box::new(parse_expression(&text).unwrap()),
                    bin(second, bin(first, id("a"), id("b")), id("c")),
                    "{text}: one level associates to the left"
                );
            }
        }
    }
}

#[test]
fn prefix_operators_bind_tighter_than_binary_and_looser_than_postfix() {
    assert_eq!(
        Box::new(parse_expression("-a * b").unwrap()),
        bin(
            BinaryOp::Mul,
            Box::new(Expr::Unary {
                op: UnaryOp::Negate,
                operand: id("a")
            }),
            id("b")
        )
    );
    assert_eq!(
        Box::new(parse_expression("!a == b").unwrap()),
        bin(
            BinaryOp::Eq,
            Box::new(Expr::Unary {
                op: UnaryOp::Not,
                operand: id("a")
            }),
            id("b")
        )
    );
    assert_eq!(
        parse_expression("-a.b").unwrap(),
        Expr::Unary {
            op: UnaryOp::Negate,
            operand: Box::new(Expr::Member {
                target: id("a"),
                name: "b".into()
            }),
        }
    );
    assert_eq!(
        parse_expression("!a.b()").unwrap(),
        Expr::Unary {
            op: UnaryOp::Not,
            operand: Box::new(Expr::Method {
                target: id("a"),
                name: "b".into(),
                args: vec![],
                position: 3,
            }),
        }
    );
    assert_eq!(
        parse_expression("!!a").unwrap(),
        Expr::Unary {
            op: UnaryOp::Not,
            operand: Box::new(Expr::Unary {
                op: UnaryOp::Not,
                operand: id("a")
            }),
        }
    );
}
