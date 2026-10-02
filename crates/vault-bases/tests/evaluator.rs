//! The evaluator on every expression form, on its typed errors, and at the
//! parser's nesting cap.
//!
//! The fixture families in `coercion.rs` pin the value semantics row by row;
//! this file pins that every `Expr` variant the parser builds reaches a
//! defined answer through [`evaluate`] on a [`MemorySource`], that an error
//! is a typed [`EvalError`] value and never a panic, and that the walk fits a
//! 2 MiB stack at [`MAX_EXPRESSION_DEPTH`] levels in a debug build.

use vault_bases::eval::{EvalContext, EvalError, Formulas, Scope, evaluate};
use vault_bases::expr::{MAX_EXPRESSION_DEPTH, parse_expression};
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
            Ok(Value::List(vec![
                Value::Number(1.0),
                string("a"),
                Value::Null,
                Value::List(vec![Value::Boolean(true)]),
            ])),
        ),
        (
            r#"{"a": 1, b: 2}"#,
            Ok(Value::Object(vec![
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
            Ok(Value::List(vec![string("x"), string("y")])),
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
        ("today()", Err(EvalError::UnknownFunction("today".into()))),
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
        Value::Object(vec![("price".into(), Value::Number(9.0))]),
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
        ("1 / 0", EvalError::DivisionByZero),
        ("7 % 0", EvalError::DivisionByZero),
        ("price / age", EvalError::DivisionByZero),
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
        ("1 + missing", EvalError::Uncaptured("arith:null".into())),
    ] {
        assert_eq!(on_row(expr), Err(expected), "{expr:?}");
    }
    for expr in [r#"-"a""#, "true * 2", "[1] - 1", "obj - 1"] {
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
    assert!(
        matches!(on_row("1e308 * 10"), Err(EvalError::Type(_))),
        "an infinite result is an error, not a cell holding Infinity"
    );
}

/// A debug build needs a 2 MiB stack for the parser at 256 levels; the
/// evaluator adds a frame per level, so it must fit the same stack.
#[test]
fn the_walk_fits_a_two_mebibyte_stack_at_the_nesting_cap() {
    let handle = std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(|| {
            let levels = MAX_EXPRESSION_DEPTH;
            let cases = [
                (
                    format!("1{}", "+1".repeat(levels - 1)),
                    Value::Number(levels as f64),
                ),
                (format!("{}1", "-".repeat(levels - 1)), Value::Number(-1.0)),
                (
                    format!("{}true", "!".repeat(levels - 1)),
                    Value::Boolean(false),
                ),
                (
                    format!("{}1{}", "(".repeat(levels - 1), ")".repeat(levels - 1)),
                    Value::Number(1.0),
                ),
                (format!("missing{}", ".sub".repeat(levels - 1)), Value::Null),
                (
                    format!(
                        "{}1{}",
                        "if(true, ".repeat(levels - 1),
                        ")".repeat(levels - 1)
                    ),
                    Value::Number(1.0),
                ),
            ];
            for (expr, expected) in cases {
                assert_eq!(on_row(&expr), Ok(expected), "{} bytes", expr.len());
            }
            let nested = on_row(&format!(
                "{}1{}",
                "[".repeat(levels - 1),
                "]".repeat(levels - 1)
            ))
            .expect("a nested list");
            let mut depth = 1;
            let mut at = &nested;
            while let Value::List(items) = at {
                depth += 1;
                at = &items[0];
            }
            assert_eq!(depth, levels);
        })
        .expect("spawn");
    handle.join().expect("no stack overflow and no panic");
}
