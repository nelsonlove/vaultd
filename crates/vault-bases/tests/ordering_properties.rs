use std::cmp::Ordering;

use proptest::prelude::*;
use vault_bases::eval::EvalContext;
use vault_bases::eval::coerce::sort_order;
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
        let scope = vault_bases::eval::Scope::default().bind("x", Value::List(items.clone()));
        let expr = vault_bases::expr::parse_expression("list(x)").unwrap();
        prop_assert_eq!(vault_bases::eval::evaluate(&expr, &ctx, &scope).unwrap(), Value::List(items));
    }

    /// Review Focus 1: a prefilter selects a superset of what its conjunct
    /// accepts, so a view evaluated with prefilters equals the same view
    /// evaluated without them.
    #[test]
    fn a_prefilter_never_drops_a_row_its_conjunct_keeps(
        notes in prop::collection::vec(
            ("[AB]", "[xy]", prop::option::of("[pq]"), prop::option::of(0i32..3), prop::bool::ANY),
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
        ],
    ) {
        let mut source = MemorySource::new();
        for (index, (folder, tag, status, rank, list_status)) in notes.iter().enumerate() {
            let mut note = MemoryFile::note().tag(tag);
            if let Some(status) = status {
                note = note.property(
                    "status",
                    if *list_status { vault_core::PropertyValue::Sequence(vec![vault_bases::no_span(text(status))]) } else { text(status) },
                );
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
