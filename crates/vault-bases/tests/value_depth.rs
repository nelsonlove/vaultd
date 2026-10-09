//! The value-depth cap: a program cannot build a value deeper than
//! `MAX_VALUE_DEPTH` levels, however long the list it folds, and folding a
//! long list is linear, not quadratic.
//!
//! Found by the Task 11 review: `xs.reduce([acc], [])` over a 20,000-item
//! frontmatter list aborted the daemon with a stack overflow (the value
//! nested one level per item and was deep-copied on every step). The
//! expression cap bounds the syntax tree, not the value a program builds.

use std::time::{Duration, Instant};

use vault_bases::eval::{EvalContext, EvalError, Scope, evaluate};
use vault_bases::expr::parse_expression;
use vault_bases::{Clock, MAX_VALUE_DEPTH, MemoryFile, MemorySource, Value, no_span, number};
use vault_core::{PropertyValue, VaultPath};

/// One note whose `xs` is `count` zeros.
fn note_with(count: usize) -> MemorySource {
    let xs = PropertyValue::Sequence((0..count).map(|_| no_span(number(0.0))).collect());
    MemorySource::new().with("Row.md", MemoryFile::note().property("xs", xs))
}

fn eval(source: &MemorySource, expr: &str) -> Result<Value, EvalError> {
    let clock = Clock::fixed(0, "UTC");
    let row = VaultPath::new("Row.md").unwrap();
    let base = VaultPath::new("Things.base").unwrap();
    let ctx = EvalContext::new(source, &clock, &base, &row);
    evaluate(&parse_expression(expr).unwrap(), &ctx, &Scope::row(&row))
}

fn on_a_one_mebibyte_stack<T: Send + 'static>(run: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(run)
        .expect("a thread")
        .join()
        .expect("no stack overflow and no panic")
}

fn depth(value: &Value) -> usize {
    (0..=MAX_VALUE_DEPTH + 1)
        .find(|levels| !value.nests_deeper_than(*levels))
        .expect("within the cap plus one")
}

/// The review's case: 20,000 items, on a 1 MiB stack, in a debug build. It
/// answers the typed error, fast, instead of aborting.
#[test]
fn a_twenty_thousand_step_nesting_reduce_answers_value_too_deep() {
    let (answer, took) = on_a_one_mebibyte_stack(|| {
        let source = note_with(20_000);
        let started = Instant::now();
        let answer = eval(&source, "xs.reduce([acc], [])");
        (answer, started.elapsed())
    });
    assert_eq!(
        answer,
        Err(EvalError::ValueTooDeep {
            max: MAX_VALUE_DEPTH
        })
    );
    assert!(took < Duration::from_secs(1), "{took:?}");
}

/// Exactly at the cap is a value; one level over is the error. `[]` is one
/// level, and each step wraps one more: 63 steps reach 64 levels.
#[test]
fn a_value_at_the_cap_is_fine_and_one_level_over_fails() {
    on_a_one_mebibyte_stack(|| {
        // Each form wraps `acc` one level deeper per step, from `[]`. (No
        // object form: an expression cannot spell an object literal, ruling
        // R1, spec ruling 7.)
        for build in ["[acc]", "[1].map(acc)"] {
            let steps = MAX_VALUE_DEPTH - 1;
            let fits = eval(&note_with(steps), &format!("xs.reduce({build}, [])")).unwrap();
            assert_eq!(depth(&fits), MAX_VALUE_DEPTH, "{build}");
            assert_eq!(
                eval(&note_with(steps + 1), &format!("xs.reduce({build}, [])")),
                Err(EvalError::ValueTooDeep {
                    max: MAX_VALUE_DEPTH
                }),
                "{build}"
            );
        }
        // A link's display is a level too: `link("a", acc)` from a string.
        let fits = eval(
            &note_with(MAX_VALUE_DEPTH),
            r#"xs.reduce(link("a", acc), "x")"#,
        )
        .unwrap();
        assert_eq!(depth(&fits), MAX_VALUE_DEPTH);
        assert_eq!(
            eval(
                &note_with(MAX_VALUE_DEPTH + 1),
                r#"xs.reduce(link("a", acc), "x")"#
            ),
            Err(EvalError::ValueTooDeep {
                max: MAX_VALUE_DEPTH
            })
        );
    });
}

/// Folding a long list is linear: the accumulator is shared, never copied
/// per step, and `unique` keeps a set of keys instead of rescanning.
#[test]
fn long_folds_and_unique_are_linear() {
    let (fold, unique, took) = on_a_one_mebibyte_stack(|| {
        let source = note_with(20_000);
        let started = Instant::now();
        // The accumulator is a 20,000-item list, rebound on every step.
        let fold = eval(&source, "xs.reduce(if(index == 0, xs, acc), []).length");
        let unique = eval(&source, "xs.map(index).unique().length");
        (fold, unique, started.elapsed())
    });
    assert_eq!(fold, Ok(Value::Number(20_000.0)));
    assert_eq!(unique, Ok(Value::Number(20_000.0)));
    assert!(took < Duration::from_secs(2), "{took:?}");
}

/// Timings for the report (run with `--ignored --nocapture`), on a large
/// stack so the old code's deep copies could finish for comparison.
#[test]
#[ignore]
fn time_reduce_and_unique() {
    for count in [5_000usize, 20_000] {
        let (nest, keep, unique) = std::thread::Builder::new()
            .stack_size(256 << 20)
            .spawn(move || {
                let source = note_with(count);
                let time = |expr: &str| {
                    let started = Instant::now();
                    let answer = eval(&source, expr)
                        .map(|_| ())
                        .map_err(|error| error.to_string());
                    (started.elapsed(), answer)
                };
                (
                    time("xs.reduce([acc], [])"),
                    time("xs.reduce(if(index == 0, xs, acc), []).length"),
                    time("xs.map(index).unique().length"),
                )
            })
            .unwrap()
            .join()
            .unwrap();
        println!("n={count} nest={nest:?} keep_shared={keep:?} unique={unique:?}");
    }
}
