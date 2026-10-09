use std::cmp::Ordering;

use vault_bases::Value;
use vault_bases::eval::coerce::{compare, number_to_string, parse_js_number, sort_order};
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
fn the_coercion_table_holds() {
    assert_family("coercion");
}

#[test]
fn the_global_functions_of_this_task_hold() {
    assert_family("global");
}

#[test]
fn the_any_methods_hold() {
    assert_family("any");
}

#[test]
fn number_to_string_follows_the_ecmascript_algorithm() {
    for (value, text) in [
        (0.0, "0"),
        (-0.0, "0"),
        (3.0, "3"),
        (-2.5, "-2.5"),
        (1e21, "1e+21"),
        (123456789012345680000.0, "123456789012345680000"),
        (1.5e-7, "1.5e-7"),
        (0.000001, "0.000001"),
        (1.0 / 3.0, "0.3333333333333333"),
        (1e-7, "1e-7"),
    ] {
        assert_eq!(number_to_string(value), text, "{value:e}");
    }
}

#[test]
fn only_the_javascript_number_grammar_parses() {
    assert_eq!(parse_js_number(" 3.4 "), Some(3.4));
    assert_eq!(parse_js_number("-1e3"), Some(-1000.0));
    assert_eq!(parse_js_number(".5"), Some(0.5));
    assert_eq!(parse_js_number("0x1F"), Some(31.0));
    for refused in ["NaN", "inf", "Infinity", "1,000", "abc", "1.2.3", ""] {
        assert_eq!(parse_js_number(refused), None, "{refused:?}");
    }
}

#[test]
fn comparison_of_mixed_types_is_captured_and_sort_order_is_total() {
    // Captured (Task 13): `1 < "2"` compares as numbers.
    let clock = vault_bases::Clock::fixed(0, "UTC");
    assert_eq!(
        compare(&Value::Number(1.0), &Value::String("2".into()), &clock),
        Some(Ordering::Less)
    );
    assert_eq!(
        sort_order(&Value::Number(1.0), &Value::String("1".into())),
        Ordering::Less,
        "the total order puts numbers before text"
    );
    assert_eq!(
        sort_order(&Value::Null, &Value::Number(-1e300)),
        Ordering::Greater,
        "null sorts last"
    );
}
