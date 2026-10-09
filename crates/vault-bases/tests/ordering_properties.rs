use std::cmp::Ordering;

use proptest::prelude::*;
use vault_bases::eval::EvalContext;
use vault_bases::eval::coerce::{sort_compare, sort_order};
use vault_bases::fixtures::{FIXTURE_NOW_MS, FIXTURE_ZONE};
use vault_bases::view::{compile_view, evaluate_view};
use vault_bases::{Clock, DateValue, MemoryFile, MemorySource, Value, number, parse_base, text};
use vault_core::VaultPath;

fn value() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Boolean),
        (-1000i32..1000).prop_map(|n| Value::Number(f64::from(n) / 4.0)),
        "[a-cA-C🙂]{0,3}".prop_map(Value::String),
        (0i64..10_000).prop_map(|ms| Value::Date(DateValue {
            epoch_ms: ms * 1000,
            has_time: true
        })),
    ]
}

proptest! {
    #[test]
    fn sort_order_is_antisymmetric(a in value(), b in value()) {
        prop_assert_eq!(sort_order(&a, &b), sort_order(&b, &a).reverse());
    }

    #[test]
    fn sort_order_is_transitive(a in value(), b in value(), c in value()) {
        if sort_order(&a, &b) != Ordering::Greater && sort_order(&b, &c) != Ordering::Greater {
            prop_assert_ne!(sort_order(&a, &c), Ordering::Greater);
        }
    }

    #[test]
    fn sorting_is_stable(keys in prop::collection::vec(0u8..3, 0..20)) {
        let mut tagged: Vec<(Value, usize)> =
            keys.iter().enumerate().map(|(at, key)| (Value::Number(f64::from(*key)), at)).collect();
        tagged.sort_by(|a, b| sort_order(&a.0, &b.0));
        for pair in tagged.windows(2) {
            if sort_order(&pair[0].0, &pair[1].0) == Ordering::Equal {
                prop_assert!(pair[0].1 < pair[1].1, "equal keys keep input order");
            }
        }
    }

    #[test]
    fn list_round_trips(items in prop::collection::vec(value(), 0..6)) {
        let source = MemorySource::new();
        let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
        let path = VaultPath::new("A.md").unwrap();
        let ctx = EvalContext::new(&source, &clock, &path, &path);
        let scope = vault_bases::eval::Scope::default().bind("x", Value::list(items.clone()));
        let expr = vault_bases::expr::parse_expression("list(x)").unwrap();
        prop_assert_eq!(vault_bases::eval::evaluate(&expr, &ctx, &scope).unwrap(), Value::list(items));
    }

    /// Review Focus 1: a prefilter selects a superset of what its conjunct
    /// accepts, so a view evaluated with prefilters equals the same view
    /// evaluated without them.
    #[test]
    fn a_prefilter_never_drops_a_row_its_conjunct_keeps(
        notes in prop::collection::vec(
            // The status's text, then its shape: 0 absent, 1 text, 2 a
            // list, 3 a mapping, 4 a number, 5 null.
            ("[AB]", "[xy]", "[pq]", 0u8..6, prop::option::of(0i32..3)),
            1..12,
        ),
        filter in prop_oneof![
            Just(r#"file.inFolder("A")"#),
            Just(r#"file.hasTag("x")"#),
            Just(r#"file.hasTag("X")"#),
            Just(r#"file.ext == "md""#),
            Just(r#"status == "p""#),
            Just(r#"status == "P""#),
            Just("rank == 1"),
            Just(r#"file.inFolder("A") && status == "q""#),
            // Forms that must lift no prefilter (the review's R4 and R11).
            Just(r#"!file.inFolder("A")"#),
            Just(r#"!(status == "p")"#),
            Just(r#"this.file.ext == "base""#),
            Just(r#"file.inFolder("A") || status == "p""#),
            Just(r#"status == "p" && !file.hasTag("x")"#),
        ],
    ) {
        let mut source = MemorySource::new();
        for (index, (folder, tag, status, shape, rank)) in notes.iter().enumerate() {
            let mut note = MemoryFile::note().tag(tag);
            let value = match shape {
                1 => Some(text(status)),
                2 => Some(vault_core::PropertyValue::Sequence(vec![vault_bases::no_span(text(status))])),
                3 => Some(vault_core::PropertyValue::Mapping(vec![(vault_bases::no_span("k".to_string()), vault_bases::no_span(text(status)))])),
                4 => Some(number(1.0)),
                5 => Some(vault_core::PropertyValue::Null),
                _ => None,
            };
            if let Some(value) = value {
                note = note.property("status", value);
            }
            if let Some(rank) = rank {
                note = note.property("rank", number(f64::from(*rank)));
            }
            source = source.with(&format!("{folder}/N{index}.md"), note);
        }
        let base = parse_base(&format!("views:\n  - type: table\n    name: T\n    filters: '{filter}'\n")).unwrap();
        let compiled = compile_view(&base, None).unwrap();
        let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
        let base_path = VaultPath::new("T.base").unwrap();
        let ctx = EvalContext::new(&source, &clock, &base_path, &base_path);
        let with: Vec<String> = evaluate_view(&compiled, &ctx).unwrap().rows.iter().map(|row| row.path.as_str().to_string()).collect();
        let without: Vec<String> = evaluate_view(&compiled.without_prefilters(), &ctx).unwrap().rows.iter().map(|row| row.path.as_str().to_string()).collect();
        prop_assert_eq!(with, without);
    }
}

/// Every kind a cell can hold, numeric-looking text, durations, objects,
/// links and `-0` included: the mix the review's M1 cycle came from (`-10`,
/// `-5`, `"-7"`).
fn mixed_value() -> impl Strategy<Value = Value> {
    let link = (
        "[a-cA-C]{0,2}",
        prop::option::of("[ab]\\.md"),
        prop::option::of("[a-c]{0,2}"),
    )
        .prop_map(|(target, resolved, display)| {
            Value::Link(vault_bases::LinkValue {
                target,
                display: display.map(|text| Box::new(Value::String(text))),
                resolved: resolved.map(|path| VaultPath::new(path).unwrap()),
            })
        });
    let object = prop::collection::vec(("[ab]", value()), 0..3).prop_map(Value::object);
    prop_oneof![
        value(),
        "-?[0-9]{1,2}(\\.[0-9])?".prop_map(Value::String),
        (-20i32..20).prop_map(|n| Value::Number(f64::from(n))),
        Just(Value::Number(f64::NAN)),
        Just(Value::Number(f64::INFINITY)),
        Just(Value::Number(-0.0)),
        Just(Value::Number(0.0)),
        link,
        object,
        (0i64..5, -3_600_000i64..3_600_000).prop_map(|(months, ms)| Value::Duration(
            vault_bases::DurationValue {
                months,
                ms,
                timed: true
            }
        )),
        prop::collection::vec(value(), 0..3).prop_map(Value::list),
    ]
}

proptest! {
    /// Ruling R2 (a total order): a view's sort comparator is antisymmetric
    /// and transitive over every kind mixed together.
    #[test]
    fn sort_compare_is_a_total_order_over_mixed_kinds(
        a in mixed_value(), b in mixed_value(), c in mixed_value()
    ) {
        let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
        let cmp = |x: &Value, y: &Value| sort_compare(x, y, &clock);
        prop_assert_eq!(cmp(&a, &b), cmp(&b, &a).reverse());
        prop_assert_eq!(cmp(&a, &a), Ordering::Equal);
        if cmp(&a, &b) != Ordering::Greater && cmp(&b, &c) != Ordering::Greater {
            prop_assert_ne!(cmp(&a, &c), Ordering::Greater);
        }
        if cmp(&a, &b) == Ordering::Equal && cmp(&b, &c) == Ordering::Equal {
            prop_assert_eq!(cmp(&a, &c), Ordering::Equal);
        }
    }
}

/// The review's M1 cycle (`-10 < -5`, `-5 < "-7"`, `"-7" < -10`) is gone:
/// numbers order before text.
#[test]
fn a_number_against_text_orders_by_kind() {
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let (low, high, text) = (
        Value::Number(-10.0),
        Value::Number(-5.0),
        Value::String("-7".into()),
    );
    assert_eq!(sort_compare(&low, &high, &clock), Ordering::Less);
    assert_eq!(sort_compare(&high, &text, &clock), Ordering::Less);
    assert_eq!(sort_compare(&low, &text, &clock), Ordering::Less);
}

/// Ruling R2: one `false` in a text column no longer makes the sort
/// quadratic (the review's H3 measured 11.6 s at 10k rows). The view with
/// it sorts in about the time of the view without it.
#[test]
fn one_boolean_in_a_text_column_sorts_in_about_the_time_of_a_plain_sort() {
    let time = |with_false: bool| {
        let mut source = MemorySource::new();
        for index in 0..10_000 {
            let value = if with_false && index == 5_000 {
                vault_core::PropertyValue::Boolean(false)
            } else {
                // Reversed text: the worst case for an insertion sort.
                text(&format!("t{:05}", 10_000 - index))
            };
            source = source.with(
                &format!("N{index:05}.md"),
                MemoryFile::note().property("k", value),
            );
        }
        let base = parse_base(
            "views:\n  - type: table\n    name: T\n    order: [k]\n    sort:\n      - property: k\n",
        )
        .unwrap();
        let compiled = compile_view(&base, None).unwrap();
        let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
        let base_path = VaultPath::new("T.base").unwrap();
        let ctx = EvalContext::new(&source, &clock, &base_path, &base_path);
        let started = std::time::Instant::now();
        let rows = evaluate_view(&compiled, &ctx).unwrap().rows;
        let elapsed = started.elapsed();
        assert_eq!(rows.len(), 10_000);
        if with_false {
            assert_eq!(
                rows[0].path.as_str(),
                "N05000.md",
                "the boolean ranks first"
            );
        }
        elapsed
    };
    let plain = time(false);
    let mixed = time(true);
    // Generous: the quadratic sort was hundreds of times slower.
    assert!(
        mixed <= plain * 3 + std::time::Duration::from_millis(250),
        "with one false {mixed:?}, without {plain:?}"
    );
}
