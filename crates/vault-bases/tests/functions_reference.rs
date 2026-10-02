use vault_bases::fixtures::check_family;

fn assert_family(family: &str) {
    let failures = check_family(family);
    assert!(
        failures.is_empty(),
        "{} {family} rows disagree:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn string_functions() {
    assert_family("string");
}

#[test]
fn number_functions() {
    assert_family("number");
}

#[test]
fn list_functions() {
    assert_family("list");
}

#[test]
fn object_functions() {
    assert_family("object");
}

#[test]
fn regexp_functions() {
    assert_family("regexp");
}

#[test]
fn string_indices_count_utf16_units_and_never_split_a_char() {
    use vault_bases::eval::{EvalContext, Scope, evaluate};
    use vault_bases::expr::parse_expression;
    use vault_bases::{Clock, MemorySource, Value};
    use vault_core::VaultPath;

    let source = MemorySource::new();
    let clock = Clock::fixed(0, "UTC");
    let path = VaultPath::new("A.md").unwrap();
    let ctx = EvalContext::new(&source, &clock, &path, &path);
    let run = |text: &str| evaluate(&parse_expression(text).unwrap(), &ctx, &Scope::default());

    // "🙂" is two UTF-16 units; slicing through its middle must not panic,
    // and the half it keeps becomes U+FFFD rather than a broken string.
    assert_eq!(
        run(r#""🙂ab".slice(1)"#).unwrap(),
        Value::String("\u{FFFD}ab".into())
    );
    assert_eq!(
        run(r#""é🙂".slice(0, 1)"#).unwrap(),
        Value::String("é".into())
    );
    assert_eq!(
        run(r#""ab".slice(5)"#).unwrap(),
        Value::String(String::new())
    );
    assert_eq!(run(r#""Tâble".length"#).unwrap(), Value::Number(5.0));
}

fn run_on_empty_vault(text: &str) -> Result<vault_bases::Value, vault_bases::eval::EvalError> {
    use vault_bases::eval::{EvalContext, Scope, evaluate};
    use vault_bases::expr::parse_expression;
    use vault_bases::{Clock, MemorySource};
    use vault_core::VaultPath;

    let source = MemorySource::new();
    let clock = Clock::fixed(0, "UTC");
    let path = VaultPath::new("A.md").unwrap();
    let ctx = EvalContext::new(&source, &clock, &path, &path);
    let expr = parse_expression(text).unwrap_or_else(|error| panic!("{text}: {}", error.message));
    evaluate(&expr, &ctx, &Scope::default())
}

#[test]
fn wrong_arity_wrong_types_and_bad_regexps_are_typed_errors() {
    use vault_bases::eval::EvalError;

    // Wrong arity, one per family: an argument error naming the method.
    for text in [
        r#""a".contains()"#,
        r#""a".lower(1)"#,
        r#""a".replace("a")"#,
        "(1).abs(2)",
        "(1).toFixed(1, 2)",
        "[1].map()",
        "[1].reduce(acc)",
        "[1].unique(1)",
        "{}.keys(1)",
        "/a/.matches()",
        "missing.isEmpty(1)",
    ] {
        match run_on_empty_vault(text) {
            Err(EvalError::Argument(message)) => {
                assert!(message.contains("takes"), "{text}: {message}")
            }
            other => panic!("{text}: expected an argument error, got {other:?}"),
        }
    }
    // A receiver of the wrong type: no such method on that type.
    for (text, target) in [
        ("true.lower()", "boolean"),
        ("(1).flat()", "number"),
        (r#""a".keys()"#, "string"),
        (r#""a".matches("a")"#, "string"),
        ("[1].toFixed(2)", "list"),
        ("{}.join()", "object"),
        ("missing.trim()", "null"),
    ] {
        match run_on_empty_vault(text) {
            Err(EvalError::NoSuchMethod { target: got, .. }) => assert_eq!(got, target, "{text}"),
            other => panic!("{text}: expected no such method, got {other:?}"),
        }
    }
    // An argument of the wrong type.
    for text in [
        r#""a".contains(1)"#,
        r#""a".split(1)"#,
        "/a/.matches(1)",
        r#"(1).round("2")"#,
    ] {
        assert!(
            matches!(run_on_empty_vault(text), Err(EvalError::Argument(_))),
            "{text}"
        );
    }
    // A bad flag, a pattern that does not compile, and one the regex crate
    // cannot express are argument errors, not parse errors or panics.
    for text in [
        r#"/a/q.matches("a")"#,
        r#"/a(/.matches("a")"#,
        r#"/(?<=a)b/.matches("ab")"#,
    ] {
        match run_on_empty_vault(text) {
            Err(EvalError::Argument(message)) => {
                assert!(message.contains("regular expression"), "{text}: {message}")
            }
            other => panic!("{text}: expected an argument error, got {other:?}"),
        }
    }
    assert_eq!(
        run_on_empty_vault(r#""a1b".split(/(\d)/)"#),
        Err(EvalError::Uncaptured("split:regexp_groups".into()))
    );
}

#[test]
fn start_and_end_checks_are_not_interchangeable() {
    use vault_bases::Value;
    for (text, expected) in [
        (r#""hello".startsWith("he")"#, true),
        (r#""hello".startsWith("lo")"#, false),
        (r#""hello".endsWith("lo")"#, true),
        (r#""hello".endsWith("he")"#, false),
    ] {
        assert_eq!(
            run_on_empty_vault(text),
            Ok(Value::Boolean(expected)),
            "{text}"
        );
    }
}

#[test]
fn nested_list_lambdas_fit_a_two_mebibyte_stack_at_the_nesting_cap() {
    use vault_bases::Value;
    use vault_bases::expr::{MAX_DEPTH, parse_expression};

    // The deepest `[1].map([1].map(…value…))` chain the parser accepts, and
    // the same through `filter` and `reduce`: each level re-enters the
    // evaluator from inside a list method.
    fn deepest(open: &str, inner: &str, close: &str) -> (usize, String) {
        let mut best = None;
        for levels in 1..=MAX_DEPTH {
            let text = format!("{}{inner}{}", open.repeat(levels), close.repeat(levels));
            if parse_expression(&text).is_err() {
                break;
            }
            best = Some((levels, text));
        }
        best.expect("one level parses")
    }
    let handle = std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(|| {
            let (levels, map) = deepest("[1].map(", "value", ")");
            assert!(levels > 1, "the parser accepts nesting");
            let mut at = run_on_empty_vault(&map).expect("nested maps");
            let mut depth = 0;
            while let Value::List(mut items) = at {
                assert_eq!(items.len(), 1);
                depth += 1;
                at = items.remove(0);
            }
            assert_eq!((depth, at), (levels, Value::Number(1.0)));
            let (_, filter) = deepest("[1].filter(", "true", ")");
            assert!(matches!(run_on_empty_vault(&filter), Ok(Value::List(_))));
            let (_, reduce) = deepest("[1].reduce(", "acc", ", 0)");
            assert!(run_on_empty_vault(&reduce).is_ok(), "nested reduces");
        })
        .expect("spawn");
    handle.join().expect("no stack overflow and no panic");
}
