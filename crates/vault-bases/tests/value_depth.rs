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

/// Task 14 fix round: a fold that reads a wide property on every step, or
/// wraps it on every step, is linear. The property is converted once per
/// evaluation (memoized), and wrapping reads the depth the list carries
/// instead of walking it; before, 20,000 items took 5.4 s in release.
#[test]
fn reading_or_wrapping_a_wide_property_on_every_step_is_linear() {
    let (wrapped, read, took) = on_a_one_mebibyte_stack(|| {
        let source = note_with(20_000);
        let started = Instant::now();
        let wrapped = eval(&source, "xs.reduce([xs], []).length");
        let read = eval(&source, "xs.reduce(xs.length, 0)");
        (wrapped, read, started.elapsed())
    });
    assert_eq!(wrapped, Ok(Value::Number(1.0)));
    assert_eq!(read, Ok(Value::Number(20_000.0)));
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

/// Task 14's carry from the Task 7 fix round: `ensure_room` walks the whole
/// item it is asked to wrap, so a wide item wrapped again on every step of a
/// fold costs (width × steps). Timed at three sizes, each three times, in
/// release (`--release --ignored --nocapture`), beside the deep fold that
/// the depth cap ends early.
#[test]
#[ignore = "a timing measurement, run by Task 14"]
fn time_deep_reduce_and_wide_rewrap() {
    for count in [1_000usize, 5_000, 20_000] {
        let source = note_with(count);
        let time = |expr: &str| {
            let mut samples: Vec<f64> = (0..3)
                .map(|_| {
                    let started = Instant::now();
                    let _ = eval(&source, expr);
                    started.elapsed().as_secs_f64() * 1_000.0
                })
                .collect();
            samples.sort_by(f64::total_cmp);
            (samples[1], samples[0])
        };
        // Deep: one level per step, refused at the cap.
        let (deep, deep_min) = time("xs.reduce([acc], [])");
        // Wide: the whole `xs` re-wrapped on every step.
        let (wide, wide_min) = time("xs.reduce([xs], []).length");
        // The stage split: `xs` read on every step with no wrap at all.
        let (read, read_min) = time("xs.reduce(xs.length, 0)");
        println!(
            "n={count} deep reduce p50 {deep:.3} ms (min {deep_min:.3}); wide re-wrap p50 {wide:.3} ms (min {wide_min:.3}); read xs every step p50 {read:.3} ms (min {read_min:.3})"
        );
    }
}
