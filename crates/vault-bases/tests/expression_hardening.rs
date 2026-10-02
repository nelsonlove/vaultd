//! The parser on hostile and edge-case input: the nesting cap, JavaScript
//! string escapes, number forms, trailing commas, and a fuzz run.
//!
//! Rows marked "provisional" follow a ruling of 2026-10-02 (N1 escapes, N2
//! number forms, N3 trailing commas) that Task 13's runtime capture settles;
//! if the capture differs, the capture wins and these rows change.

use vault_bases::expr::{
    BinaryOp, Expr, ExpressionError, ExpressionErrorKind, MAX_DEPTH, parse_expression,
};

/// The default stack of a spawned Rust thread, and of a test thread.
const SMALL_STACK: usize = 2 << 20;

/// Runs `body` on a thread with a 2 MiB stack, so that a stack overflow in
/// the parser (or in dropping its tree) would abort this test run.
fn on_small_stack<T: Send + 'static>(body: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(SMALL_STACK)
        .spawn(body)
        .expect("spawn")
        .join()
        .expect("no panic")
}

fn assert_position_is_sound(text: &str, error: &ExpressionError) {
    assert!(error.position <= text.len(), "{error:?}");
    assert!(text.is_char_boundary(error.position), "{error:?}");
}

fn id(name: &str) -> Box<Expr> {
    Box::new(Expr::Identifier(name.into()))
}

#[test]
fn deep_input_is_a_typed_error_on_a_two_mebibyte_stack() {
    let cases: Vec<(&str, String)> = vec![
        ("a.b x100,000", format!("a{}", ".b".repeat(100_000))),
        ("a+a x100,000", format!("a{}", "+a".repeat(100_000))),
        ("a[0] x100,000", format!("a{}", "[0]".repeat(100_000))),
        ("a.b() x100,000", format!("a{}", ".b()".repeat(100_000))),
        (
            "parentheses x10,000",
            format!("{}a{}", "(".repeat(10_000), ")".repeat(10_000)),
        ),
        ("unclosed parentheses x10,000", "(".repeat(10_000)),
        ("! x10,000", format!("{}a", "!".repeat(10_000))),
        ("- x10,000", format!("{}a", "-".repeat(10_000))),
        (
            "[ x10,000",
            format!("{}1{}", "[".repeat(10_000), "]".repeat(10_000)),
        ),
        (
            "{a: x10,000",
            format!("{}1{}", "{a:".repeat(10_000), "}".repeat(10_000)),
        ),
        (
            "f( x10,000",
            format!("{}1{}", "f(".repeat(10_000), ")".repeat(10_000)),
        ),
        (
            "x.m( x10,000",
            format!("{}1{}", "x.m(".repeat(10_000), ")".repeat(10_000)),
        ),
    ];
    on_small_stack(move || {
        for (label, text) in cases {
            let error = parse_expression(&text).expect_err(label);
            assert_eq!(
                error.kind,
                ExpressionErrorKind::ExpressionTooDeep { max: MAX_DEPTH },
                "{label}: {}",
                error.message
            );
            assert!(error.message.contains("too deeply"), "{label}");
            assert_position_is_sound(&text, &error);
        }
    });
}

#[test]
fn the_cap_is_exactly_max_depth_levels() {
    assert_eq!(MAX_DEPTH, 64);
    let levels = MAX_DEPTH;
    // A leaf is one level and each wrapper adds one. Parentheses add no
    // node, but each open one is a level of the parser's own recursion,
    // counted from the whole expression as level one.
    for (label, at_cap, over_cap) in [
        (
            "member chain",
            format!("a{}", ".b".repeat(levels - 1)),
            format!("a{}", ".b".repeat(levels)),
        ),
        (
            "binary chain",
            format!("a{}", "+a".repeat(levels - 1)),
            format!("a{}", "+a".repeat(levels)),
        ),
        (
            "prefix chain",
            format!("{}a", "!".repeat(levels - 1)),
            format!("{}a", "!".repeat(levels)),
        ),
        (
            "parentheses",
            format!("{}a{}", "(".repeat(levels - 1), ")".repeat(levels - 1)),
            format!("{}a{}", "(".repeat(levels), ")".repeat(levels)),
        ),
        (
            "nested lists",
            format!("{}1{}", "[".repeat(levels - 1), "]".repeat(levels - 1)),
            format!("{}1{}", "[".repeat(levels), "]".repeat(levels)),
        ),
    ] {
        on_small_stack(move || {
            assert!(parse_expression(&at_cap).is_ok(), "{label} at the cap");
            let error = parse_expression(&over_cap).expect_err(label);
            assert_eq!(
                error.kind,
                ExpressionErrorKind::ExpressionTooDeep { max: MAX_DEPTH },
                "{label} over the cap"
            );
        });
    }
}

#[test]
fn a_syntax_error_has_the_syntax_kind() {
    let error = parse_expression("1 +").expect_err("dangling operator");
    assert_eq!(error.kind, ExpressionErrorKind::Syntax);
}

fn string(text: &str) -> Result<String, ExpressionError> {
    match parse_expression(text)? {
        Expr::String(value) => Ok(value),
        other => panic!("{text}: not a string: {other:?}"),
    }
}

/// Provisional (ruling N1): string escapes follow JavaScript.
#[test]
fn provisional_string_escapes_follow_javascript() {
    for (text, expected) in [
        (r#""a\nb""#, "a\nb"),
        (r#""a\tb""#, "a\tb"),
        (r#""a\rb""#, "a\rb"),
        (r#""\\""#, "\\"),
        (r#""\"""#, "\""),
        (r#"'\''"#, "'"),
        (r#""\b\f\v""#, "\u{8}\u{c}\u{b}"),
        (r#""\0""#, "\0"),
        (r#""\x41""#, "A"),
        (r#""A""#, "A"),
        (r#""é""#, "é"),
        (r#""\u{41}""#, "A"),
        (r#""\u{1F600}""#, "\u{1F600}"),
        (r#""😀""#, "\u{1F600}"),
        (r#""\q""#, "q"),
    ] {
        assert_eq!(string(text).expect(text), expected, "{text}");
    }
}

/// The source text `"<backslash>u<hex>…"`, built from a `char` so that no
/// editor or transcription can turn the escape into the literal character.
fn u_escapes(hex: &[&str]) -> String {
    let backslash = '\\';
    let body: String = hex.iter().map(|h| format!("{backslash}u{h}")).collect();
    format!("\"{body}\"")
}

/// Provisional (ruling N1): a four-digit `\uHHHH` escape is one character.
#[test]
fn provisional_a_four_digit_u_escape_is_one_character() {
    for (hex, expected) in [("0041", "A"), ("00e9", "\u{e9}"), ("20AC", "\u{20ac}")] {
        let text = u_escapes(&[hex]);
        assert_eq!(text.len(), 8, "{text} is the escape, not the character");
        assert_eq!(string(&text).expect(&text), expected, "{text}");
    }
}

/// Provisional (ruling N1): a high and a low surrogate escape combine into
/// one character, as JavaScript's UTF-16 strings do.
#[test]
fn provisional_a_surrogate_pair_combines_into_one_character() {
    let text = u_escapes(&["D83D", "DE00"]);
    assert_eq!(text.len(), 14, "{text} is the escapes, not the character");
    let value = string(&text).expect(&text);
    assert_eq!(value, "\u{1F600}");
    assert_eq!(value.chars().count(), 1);
}

/// Provisional (ruling N1): a malformed `\x` or `\u` escape is a typed
/// error at the backslash, never accepted.
#[test]
fn provisional_malformed_escapes_are_errors_at_the_backslash() {
    for text in [
        r#""\u+041""#,
        r#""\u12""#,
        r#""\u12G4""#,
        r#""\u{}""#,
        r#""\u{110000}""#,
        r#""\u{41""#,
        r#""\uD83D""#,
        r#""\uD83Dx""#,
        r#""\uD83DA""#,
        r#""\uDE00""#,
        r#""\x4""#,
        r#""\xZZ""#,
    ] {
        let error = string(text).expect_err(text);
        assert_eq!(error.kind, ExpressionErrorKind::Syntax, "{text}");
        assert_eq!(error.position, 1, "{text}: {}", error.message);
        assert!(
            error.message.contains("escape"),
            "{text}: {}",
            error.message
        );
    }
}

/// Provisional (ruling N2): `1.` and `.5` are numbers.
#[test]
fn provisional_a_trailing_or_leading_dot_is_part_of_a_number() {
    assert_eq!(parse_expression("1.").unwrap(), Expr::Number(1.0));
    assert_eq!(parse_expression(".5").unwrap(), Expr::Number(0.5));
    assert_eq!(
        parse_expression("[.5, 1.]").unwrap(),
        Expr::List(vec![Expr::Number(0.5), Expr::Number(1.0)])
    );
    assert_eq!(
        parse_expression("1..b").unwrap(),
        Expr::Member {
            target: Box::new(Expr::Number(1.0)),
            name: "b".into()
        },
        "as in JavaScript, `1.` then `.b`"
    );
    assert_eq!(
        parse_expression("5.isEmpty()").unwrap(),
        Expr::Method {
            target: Box::new(Expr::Number(5.0)),
            name: "isEmpty".into(),
            args: vec![],
            position: 2,
        },
        "a name after the dot still makes a method call"
    );
}

/// Provisional (ruling N3): a call's arguments may end in a comma.
#[test]
fn provisional_a_trailing_comma_is_accepted_in_call_arguments_only() {
    assert_eq!(
        parse_expression("f(a,)").unwrap(),
        Expr::Call {
            name: "f".into(),
            args: vec![Expr::Identifier("a".into())],
            position: 0
        }
    );
    assert_eq!(
        parse_expression("x.m(1, 2,)").unwrap(),
        Expr::Method {
            target: id("x"),
            name: "m".into(),
            args: vec![Expr::Number(1.0), Expr::Number(2.0)],
            position: 2,
        }
    );
    for text in ["f(,)", "f(a,,)", "[1, 2,]", "{a: 1,}"] {
        let error = parse_expression(text).expect_err(text);
        assert_eq!(error.kind, ExpressionErrorKind::Syntax, "{text}");
    }
}

#[test]
fn a_slash_after_a_closing_bracket_divides() {
    assert_eq!(
        parse_expression("a[0] / 2").unwrap(),
        Expr::Binary {
            op: BinaryOp::Div,
            left: Box::new(Expr::Index {
                target: id("a"),
                index: Box::new(Expr::Number(0.0)),
            }),
            right: Box::new(Expr::Number(2.0)),
        }
    );
}

#[test]
fn a_slash_inside_a_class_does_not_end_a_regexp() {
    assert_eq!(
        parse_expression("/[/]/").unwrap(),
        Expr::Regexp {
            source: "[/]".into(),
            flags: "".into()
        }
    );
}

/// A small deterministic generator (xorshift64), so the fuzz run needs no
/// dependency and repeats exactly.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}

const FRAGMENTS: &[&str] = &[
    "a", "b1", "é", "😀", "1", "2.5", ".5", "1.", "1e3", "\"s\"", "'t'", "\"", "'", "\\", "\\u",
    "\\u{", "\\x4", "/", "/re/g", "[", "]", "(", ")", "{", "}", ",", ".", ":", "!", "-", "+", "*",
    "%", "==", "!=", "<", "<=", ">", ">=", "&&", "||", "=", "#", "?", " ", "null", "true", "f(",
    "x.m(", "[0]",
];

/// Twenty thousand random inputs: never a panic or an overflow, and every
/// error position inside the text on a character boundary. Ignored by
/// default because it is a sweep, not a pin; run it with `--ignored`.
#[test]
#[ignore = "a fuzz sweep; run with --ignored"]
fn fuzz_never_panics_and_positions_are_sound() {
    on_small_stack(|| {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for round in 0..20_000 {
            let text = if round % 2 == 0 {
                let bytes: Vec<u8> = (0..rng.below(40)).map(|_| rng.next() as u8).collect();
                String::from_utf8_lossy(&bytes).into_owned()
            } else {
                (0..1 + rng.below(30))
                    .map(|_| FRAGMENTS[rng.below(FRAGMENTS.len())])
                    .collect()
            };
            if let Err(error) = parse_expression(&text) {
                assert_position_is_sound(&text, &error);
            }
        }
    });
}
