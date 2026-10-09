//! The evaluator on every expression form, on its typed errors, and at the
//! parser's nesting cap.
//!
//! The fixture families in `coercion.rs` pin the value semantics row by row;
//! this file pins that every `Expr` variant the parser builds reaches a
//! defined answer through [`evaluate`] on a [`MemorySource`], that an error
//! is a typed [`EvalError`] value and never a panic, and that the walk fits a
//! 2 MiB stack at [`MAX_DEPTH`] levels in a debug build.

use vault_bases::eval::{EvalContext, EvalError, Formulas, Scope, evaluate};
use vault_bases::expr::{MAX_DEPTH, parse_expression};
use vault_bases::{Clock, MemoryFile, MemorySource, Value, no_span, number, text};
use vault_core::{PropertyValue, VaultPath};

const ROW: &str = "Row.md";
const THIS: &str = "Here.md";
const BASE: &str = "Things.base";

fn path(text: &str) -> VaultPath {
    VaultPath::new(text).expect("a valid path")
}

fn source() -> MemorySource {
    let list = PropertyValue::Sequence(vec![no_span(text("x")), no_span(text("y"))]);
    let object = PropertyValue::Mapping(vec![(no_span("sub".to_string()), no_span(text("s")))]);
    MemorySource::new()
        .with(
            ROW,
            MemoryFile::note()
                .property("price", number(2.5))
                .property("age", number(0.0))
                .property("x", number(3.0))
                .property("flag", PropertyValue::Boolean(true))
                .property("my prop", list)
                .property("obj", object),
        )
        .with(THIS, MemoryFile::note())
}

fn run(expr: &str, scope: &Scope, formulas: Option<&dyn Formulas>) -> Result<Value, EvalError> {
    let source = source();
    let clock = Clock::fixed(0, "UTC");
    let (base, this) = (path(BASE), path(THIS));
    let mut ctx = EvalContext::new(&source, &clock, &base, &this);
    if let Some(formulas) = formulas {
        ctx = ctx.with_formulas(formulas);
    }
    let parsed = parse_expression(expr).unwrap_or_else(|error| panic!("{expr:?}: {error:?}"));
    evaluate(&parsed, &ctx, scope)
}

fn on_row(expr: &str) -> Result<Value, EvalError> {
    run(expr, &Scope::row(&path(ROW)), None)
}

fn string(text: &str) -> Value {
    Value::String(text.into())
}

/// A formula table with one formula, `ppu`, that reads the row's price.
struct OneFormula;

impl Formulas for OneFormula {
    fn formula(
        &self,
        name: &str,
        ctx: &EvalContext<'_>,
        scope: &Scope,
    ) -> Result<Value, EvalError> {
        match name {
            "ppu" => evaluate(&parse_expression("price * 2").unwrap(), ctx, scope),
            other => Err(EvalError::UnknownFormula(other.into())),
        }
    }
}

#[test]
fn every_expression_form_evaluates_on_a_memory_source() {
    let cases: Vec<(&str, Result<Value, EvalError>)> = vec![
        // Literals.
        ("null", Ok(Value::Null)),
        ("true", Ok(Value::Boolean(true))),
        ("2.5", Ok(Value::Number(2.5))),
        (r#"'it\'s' + "a""#, Ok(string("it'sa"))),
        (
            r#"[1, "a", null, [true]]"#,
            Ok(Value::list(vec![
                Value::Number(1.0),
                string("a"),
                Value::Null,
                Value::list(vec![Value::Boolean(true)]),
            ])),
        ),
        (
            r#"{"a": 1, b: 2}"#,
            Ok(Value::object(vec![
                ("a".into(), Value::Number(1.0)),
                ("b".into(), Value::Number(2.0)),
            ])),
        ),
        // Identifiers: a bare property, `this`, `file`, a missing name.
        ("price", Ok(Value::Number(2.5))),
        ("this", Ok(Value::File(path(THIS)))),
        ("file", Ok(Value::File(path(ROW)))),
        ("missing", Ok(Value::Null)),
        // Member and index, through `note`, objects and lists.
        ("note.price", Ok(Value::Number(2.5))),
        (
            r#"note["my prop"]"#,
            Ok(Value::list(vec![string("x"), string("y")])),
        ),
        (r#"note["my prop"][1]"#, Ok(string("y"))),
        (r#"note["my prop"][-1]"#, Ok(Value::Null)),
        ("obj.sub", Ok(string("s"))),
        (r#"obj["sub"]"#, Ok(string("s"))),
        ("note.obj.sub", Ok(string("s"))),
        ("missing.sub", Ok(Value::Null)),
        (
            r#"note["my prop"][0].nope"#,
            Err(EvalError::NoSuchField {
                target: "string",
                name: "nope".into(),
            }),
        ),
        ("formula.ppu", Err(EvalError::UnknownFormula("ppu".into()))),
        // Calls and methods.
        ("if(price, 1, 2)", Ok(Value::Number(1.0))),
        ("nowish()", Err(EvalError::UnknownFunction("nowish".into()))),
        ("x.isTruthy()", Ok(Value::Boolean(true))),
        // Unary.
        ("-x", Ok(Value::Number(-3.0))),
        ("!flag", Ok(Value::Boolean(false))),
        ("!!flag", Ok(Value::Boolean(true))),
        // Every binary operator.
        ("x + 1", Ok(Value::Number(4.0))),
        ("x - 1", Ok(Value::Number(2.0))),
        ("x * 2", Ok(Value::Number(6.0))),
        ("x / 2", Ok(Value::Number(1.5))),
        ("x % 2", Ok(Value::Number(1.0))),
        ("x == 3", Ok(Value::Boolean(true))),
        ("x != 3", Ok(Value::Boolean(false))),
        ("x < 3", Ok(Value::Boolean(false))),
        ("x <= 3", Ok(Value::Boolean(true))),
        ("x > 3", Ok(Value::Boolean(false))),
        ("x >= 3", Ok(Value::Boolean(true))),
        ("flag && x", Ok(Value::Boolean(true))),
        ("age || missing", Ok(Value::Boolean(false))),
        // Short-circuit: the right side would be an error.
        ("age && 1 / 0", Ok(Value::Boolean(false))),
        ("flag || 1 / 0", Ok(Value::Boolean(true))),
        ("x + 2 * 3 == 9 && !(x > 4)", Ok(Value::Boolean(true))),
    ];
    let mut failures = Vec::new();
    for (expr, expected) in cases {
        let got = on_row(expr);
        if got != expected {
            failures.push(format!("{expr:?}: expected {expected:?}, got {got:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_regular_expression_literal_compiles_and_a_bad_flag_is_an_argument_error() {
    let Ok(Value::Regexp(regexp)) = on_row("/a+b/i") else {
        panic!("a regexp value");
    };
    assert_eq!(
        (regexp.source.as_str(), regexp.flags.as_str()),
        ("a+b", "i")
    );
    assert!(regexp.regex.is_match("xAAB"), "the i flag is applied");
    assert!(matches!(on_row("/a/q"), Err(EvalError::Argument(_))));
    assert!(
        matches!(on_row("/(?<=a)b/"), Err(EvalError::Argument(_))),
        "look-behind is refused, not silently changed"
    );
}

#[test]
fn formulas_and_locals_resolve_through_the_scope() {
    let row = Scope::row(&path(ROW));
    assert_eq!(
        run("formula.ppu", &row, Some(&OneFormula)),
        Ok(Value::Number(5.0))
    );
    assert_eq!(
        run("formula.nope", &row, Some(&OneFormula)),
        Err(EvalError::UnknownFormula("nope".into()))
    );
    let bound = row.bind("value", Value::Number(7.0));
    assert_eq!(run("value + 1", &bound, None), Ok(Value::Number(8.0)));
    let shadowed = bound.bind("value", Value::Number(1.0));
    assert_eq!(
        run("value", &shadowed, None),
        Ok(Value::Number(1.0)),
        "an inner binding shadows an outer one"
    );
    let note = row.bind(
        "note",
        Value::object(vec![("price".into(), Value::Number(9.0))]),
    );
    assert_eq!(
        run("note.price", &note, None),
        Ok(Value::Number(9.0)),
        "a local named note shadows the row's note"
    );
    assert_eq!(
        run("price", &Scope::default(), None),
        Ok(Value::Null),
        "a scope with no row has no properties"
    );
}

#[test]
fn errors_are_typed_values_never_panics() {
    for (expr, expected) in [
        (
            "frobnicate(1)",
            EvalError::UnknownFunction("frobnicate".into()),
        ),
        (
            "5.frobnicate()",
            EvalError::NoSuchMethod {
                target: "number",
                name: "frobnicate".into(),
            },
        ),
    ] {
        assert_eq!(on_row(expr), Err(expected), "{expr:?}");
    }
    for expr in [
        r#"-"a""#,
        "[1] - 1",
        "obj - 1",
        "1 + true",
        "true * 2",
        r#""5" * 2"#,
    ] {
        assert!(
            matches!(on_row(expr), Err(EvalError::Type(_))),
            "{expr:?}: {:?}",
            on_row(expr)
        );
    }
    assert!(
        matches!(
            run("file", &Scope::default(), None),
            Err(EvalError::Type(_))
        ),
        "`file` without a row is a type error"
    );
}

/// Captured (Task 13): arithmetic follows JavaScript where Obsidian does —
/// a division by zero is Infinity, a remainder by zero NaN, an overflow
/// Infinity — and an empty side is empty.
#[test]
fn captured_arithmetic_answers_values() {
    let number = |expr: &str| match on_row(expr) {
        Ok(Value::Number(number)) => number,
        other => panic!("{expr:?}: {other:?}"),
    };
    assert_eq!(number("1 / 0"), f64::INFINITY);
    assert!(number("7 % 0").is_nan());
    assert_eq!(number("1e308 * 10"), f64::INFINITY);
    assert_eq!(number(r#"number("Infinity")"#), f64::INFINITY);
    assert_eq!(number(r#"number(" -Infinity ")"#), f64::NEG_INFINITY);
    assert_eq!(on_row("1 + missing"), Ok(Value::Null));
    assert_eq!(on_row(r#""a" + missing"#), Ok(Value::String("a".into())));
    assert_eq!(
        on_row("[1] + [2]"),
        Ok(Value::list(vec![Value::Number(1.0), Value::Number(2.0)]))
    );
}

/// The deepest expression built from `open` × k, `inner`, `close` × k that
/// the parser accepts, and the same with one more level, which it must
/// refuse as too deep.
fn deepest(open: &str, inner: &str, close: &str) -> (String, String) {
    let build = |levels: usize| format!("{}{inner}{}", open.repeat(levels), close.repeat(levels));
    let mut levels = 0;
    while parse_expression(&build(levels + 1)).is_ok() {
        levels += 1;
        assert!(levels <= MAX_DEPTH, "{open:?} nests past the cap");
    }
    (build(levels), build(levels + 1))
}

/// Every recursive shape at the nesting cap: the deepest form the parser
/// accepts evaluates to `expected`, and one level more is the typed
/// too-deep error. Eager calls (`max(`, `escapeHTML(`) cost the most stack
/// per level, and list lambdas re-enter the evaluator from a list method.
fn every_shape_at_the_cap() {
    use vault_bases::expr::ExpressionErrorKind;

    let shapes: [(&str, &str, &str, Option<Value>); 18] = [
        ("1+", "1", "", None),
        ("-", "1", "", None),
        ("!", "true", "", None),
        ("(", "1", ")", Some(Value::Number(1.0))),
        ("", "missing", ".sub", Some(Value::Null)),
        ("if(true, ", "1", ")", Some(Value::Number(1.0))),
        ("[", "1", "]", None),
        ("{a: ", "1", "}", None),
        ("max(", "1", ")", Some(Value::Number(1.0))),
        ("min(2, ", "1", ")", Some(Value::Number(1.0))),
        ("escapeHTML(", "\"x\"", ")", Some(Value::String("x".into()))),
        ("true && ", "true", "", Some(Value::Boolean(true))),
        ("[1].map(", "value", ")", None),
        ("[1].filter(", "true", ")", None),
        ("[1].reduce(", "acc", ", 0)", None),
        ("date(", "now()", ")", None),
        ("duration(", "\"1d\"", ")", None),
        ("", "now()", ".date()", None),
    ];
    for (open, inner, close, expected) in shapes {
        let (at_cap, over_cap) = deepest(open, inner, close);
        let got = on_row(&at_cap);
        match &expected {
            Some(value) => assert_eq!(got.as_ref(), Ok(value), "{open:?} at the cap"),
            None => assert!(got.is_ok(), "{open:?} at the cap: {got:?}"),
        }
        let error = parse_expression(&over_cap).expect_err("one level over the cap");
        assert_eq!(
            error.kind,
            ExpressionErrorKind::ExpressionTooDeep { max: MAX_DEPTH },
            "{open:?} over the cap"
        );
    }
}

fn on_stack(bytes: usize, body: fn()) {
    std::thread::Builder::new()
        .stack_size(bytes)
        .spawn(body)
        .expect("spawn")
        .join()
        .expect("no stack overflow and no panic");
}

/// The daemon's connection threads have 2 MiB; a debug build at the cap must
/// fit that with room to spare.
#[test]
fn the_walk_fits_a_two_mebibyte_stack_at_the_nesting_cap() {
    assert_eq!(MAX_DEPTH, 64);
    on_stack(2 << 20, every_shape_at_the_cap);
}

/// The headroom proof: the same shapes fit half the daemon's stack.
#[test]
fn the_walk_fits_a_one_mebibyte_stack_at_the_nesting_cap() {
    on_stack(1 << 20, every_shape_at_the_cap);
}

/// A source whose one note has the YAML non-finite numbers, parsed by
/// `vault_core` exactly as the daemon parses a note.
fn yaml_source() -> MemorySource {
    let text = "---\ninf: .inf\nninf: -.inf\nnan: .nan\nhuge: 1e400\n---\n";
    let document = vault_core::SourceDocument::new(path(ROW), text);
    let mut note = MemoryFile::note();
    for property in vault_core::parse_properties(&document) {
        note = note.property(&property.key.value, property.value.value);
    }
    MemorySource::new().with(ROW, note)
}

fn on_yaml(expr: &str) -> Result<Value, EvalError> {
    let source = yaml_source();
    let clock = Clock::fixed(0, "UTC");
    let (base, this) = (path(BASE), path(THIS));
    let ctx = EvalContext::new(&source, &clock, &base, &this);
    let parsed = parse_expression(expr).unwrap_or_else(|error| panic!("{expr:?}: {error:?}"));
    evaluate(&parsed, &ctx, &Scope::row(&path(ROW)))
}

#[test]
fn yaml_non_finite_numbers_reach_the_evaluator_and_format_as_javascript_does() {
    for (expr, text) in [
        ("inf.toString()", "Infinity"),
        ("ninf.toString()", "-Infinity"),
        ("nan.toString()", "NaN"),
        ("huge.toString()", "Infinity"),
        ("[inf, nan].toString()", "Infinity, NaN"),
        ("(1e400).toString()", "Infinity"),
        ("inf + \"\"", "Infinity"),
    ] {
        assert_eq!(on_yaml(expr), Ok(Value::String(text.into())), "{expr}");
    }
    let Ok(Value::Number(nan)) = on_yaml("nan") else {
        panic!("a .nan property is a number");
    };
    assert!(nan.is_nan());
    let clock = Clock::fixed(0, "UTC");
    assert_eq!(
        vault_bases::fixtures::render_text(&Value::Number(nan), &clock),
        "NaN"
    );
    assert_eq!(
        on_yaml("max(1, nan).toString()"),
        Ok(Value::String("NaN".into())),
        "a NaN operand makes max NaN, as Math.max does"
    );
}

/// JavaScript: NaN is falsy (M6 in the Task 3 review).
#[test]
fn nan_is_falsy() {
    assert_eq!(on_yaml("nan.isTruthy()"), Ok(Value::Boolean(false)));
    assert_eq!(on_yaml("!nan"), Ok(Value::Boolean(true)));
    assert_eq!(on_yaml("if(nan, 1, 2)"), Ok(Value::Number(2.0)));
    assert_eq!(on_yaml("inf.isTruthy()"), Ok(Value::Boolean(true)));
}

/// `false < true`, as JavaScript orders booleans (M7 in the Task 3 review).
#[test]
fn booleans_order_false_before_true() {
    for (expr, expected) in [
        ("false < true", true),
        ("true < false", false),
        ("true > false", true),
        ("false >= true", false),
        ("true <= true", true),
    ] {
        assert_eq!(on_row(expr), Ok(Value::Boolean(expected)), "{expr}");
    }
}

/// The syntax page's `author == this`: a link equals the file it resolves to
/// (M9 in the Task 3 review), and link text is compared only when neither
/// side resolves, so `==` stays transitive.
#[test]
fn a_link_equals_the_file_it_resolves_to() {
    use vault_bases::LinkValue;
    use vault_bases::eval::coerce::loose_equals;

    let link = |target: &str, resolved: Option<&str>| {
        Value::Link(LinkValue {
            target: target.into(),
            display: None,
            resolved: resolved.map(path),
        })
    };
    let clock = vault_bases::Clock::fixed(0, "UTC");
    let equals = |a: &Value, b: &Value| loose_equals(a, b, &clock);
    let file = Value::File(path("A.md"));
    let resolved = link("A", Some("A.md"));
    let unresolved = link("A", None);
    assert!(equals(&resolved, &file));
    assert!(equals(&file, &resolved));
    assert!(!equals(&link("B", Some("B.md")), &file));
    assert!(!equals(&unresolved, &file));
    assert!(
        !equals(&unresolved, &resolved),
        "an unresolved link is not equal to a resolved one with the same text"
    );
    assert!(equals(&unresolved, &link("A", None)));
    assert!(!equals(&unresolved, &link("a", None)));
}

/// Every numeric corner through formatting, arithmetic, comparison and the
/// number functions: each answer is a value or a typed error, never a panic,
/// and every value renders as a cell.
#[test]
fn every_numeric_corner_is_a_value_or_a_typed_error() {
    let corners = [
        "0",
        "(-0)",
        "1",
        "(-1)",
        "0.5",
        "1e21",
        "1e-7",
        "5e-324",
        "1.7976931348623157e308",
        "1e400",
        "(-1e400)",
        "inf",
        "ninf",
        "nan",
        "huge",
    ];
    let unary = [
        "({a}).toString()",
        "({a}) + \"\"",
        "-({a})",
        "!({a})",
        "({a}).isTruthy()",
        "number({a})",
        "({a}).toFixed(2)",
        "({a}).round()",
        "({a}).abs()",
        "({a}).ceil()",
        "({a}).floor()",
        "if({a}, 1, 2)",
        "list({a})",
    ];
    let binary = [
        "({a}) + ({b})",
        "({a}) - ({b})",
        "({a}) * ({b})",
        "({a}) / ({b})",
        "({a}) % ({b})",
        "({a}) < ({b})",
        "({a}) >= ({b})",
        "({a}) == ({b})",
        "({a}) != ({b})",
        "max({a}, {b})",
        "min({a}, {b})",
        "[{a}, {b}].sort()",
        "[{a}, {b}].toString()",
        "[{a}, {b}].mean()",
    ];
    let clock = Clock::fixed(0, "UTC");
    let mut count = 0;
    for a in corners {
        let mut exprs: Vec<String> = unary.iter().map(|t| t.replace("{a}", a)).collect();
        for b in corners {
            exprs.extend(binary.iter().map(|t| t.replace("{a}", a).replace("{b}", b)));
        }
        for expr in exprs {
            if let Ok(value) = on_yaml(&expr) {
                vault_bases::fixtures::render_text(&value, &clock);
            }
            count += 1;
        }
    }
    assert_eq!(
        count,
        corners.len() * (unary.len() + corners.len() * binary.len())
    );
}

mod sort_order_is_total {
    use std::cmp::Ordering;

    use proptest::prelude::*;
    use vault_bases::eval::coerce::sort_order;
    use vault_bases::{DateValue, DurationValue, LinkValue, Value};
    use vault_core::VaultPath;

    fn number() -> impl Strategy<Value = f64> {
        prop_oneof![
            Just(f64::NAN),
            Just(-f64::NAN),
            Just(f64::INFINITY),
            Just(f64::NEG_INFINITY),
            Just(0.0),
            Just(-0.0),
            -3.0..3.0f64,
            any::<f64>(),
        ]
    }

    fn value() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            number().prop_map(Value::Number),
            "[a-cA-C]{0,3}".prop_map(Value::String),
            any::<bool>().prop_map(Value::Boolean),
            (-3i64..3, any::<bool>())
                .prop_map(|(epoch_ms, has_time)| Value::Date(DateValue { epoch_ms, has_time })),
            (-2i64..2, -2i64..2).prop_map(|(months, ms)| {
                Value::Duration(DurationValue {
                    months,
                    ms,
                    timed: false,
                })
            }),
            "[ab]{1,2}".prop_map(|name| Value::File(VaultPath::new(format!("{name}.md")).unwrap())),
            ("[ab]{1,2}", any::<bool>()).prop_map(|(target, resolves)| Value::Link(LinkValue {
                resolved: resolves.then(|| VaultPath::new(format!("{target}.md")).unwrap()),
                target,
                display: None,
            })),
            "[ab]{0,2}".prop_map(Value::Icon),
        ];
        leaf.prop_recursive(2, 8, 3, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..3).prop_map(Value::list),
                prop::collection::vec(("[ab]", inner), 0..2).prop_map(Value::object),
            ]
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        #[test]
        fn antisymmetric(a in value(), b in value()) {
            prop_assert_eq!(sort_order(&a, &b), sort_order(&b, &a).reverse());
            prop_assert_eq!(sort_order(&a, &a), Ordering::Equal);
        }

        #[test]
        fn transitive(a in value(), b in value(), c in value()) {
            let (ab, bc, ac) = (sort_order(&a, &b), sort_order(&b, &c), sort_order(&a, &c));
            if ab != Ordering::Greater && bc != Ordering::Greater {
                prop_assert_ne!(ac, Ordering::Greater, "{:?} {:?} {:?}", a, b, c);
            }
            if ab == Ordering::Equal && bc == Ordering::Equal {
                prop_assert_eq!(ac, Ordering::Equal, "{:?} {:?} {:?}", a, b, c);
            }
        }

        /// Numbers alone, so a NaN lands between two numbers often.
        #[test]
        fn transitive_over_numbers(a in number(), b in number(), c in number()) {
            let (a, b, c) = (Value::Number(a), Value::Number(b), Value::Number(c));
            let (ab, bc, ac) = (sort_order(&a, &b), sort_order(&b, &c), sort_order(&a, &c));
            if ab != Ordering::Greater && bc != Ordering::Greater {
                prop_assert_ne!(ac, Ordering::Greater, "{:?} {:?} {:?}", a, b, c);
            }
        }

        #[test]
        fn sort_by_never_panics_and_sorts(mut values in prop::collection::vec(value(), 0..40)) {
            values.sort_by(sort_order);
            for pair in values.windows(2) {
                prop_assert_ne!(sort_order(&pair[0], &pair[1]), Ordering::Greater);
            }
        }
    }

    #[test]
    fn nan_sorts_after_every_number_and_equal_to_nan() {
        for number in [f64::NEG_INFINITY, -1.0, -0.0, 0.0, 1e308, f64::INFINITY] {
            assert_eq!(
                sort_order(&Value::Number(f64::NAN), &Value::Number(number)),
                Ordering::Greater
            );
        }
        assert_eq!(
            sort_order(&Value::Number(f64::NAN), &Value::Number(-f64::NAN)),
            Ordering::Equal
        );
        assert_eq!(
            sort_order(&Value::Number(-0.0), &Value::Number(0.0)),
            Ordering::Equal
        );
    }
}
