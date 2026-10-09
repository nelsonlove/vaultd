use crate::dates::{
    add, format_date, parse_date_text, parse_duration_text, relative, start_of_day, zoned,
};
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::{BinaryOp, Expr};
use crate::value::{DateValue, DurationValue, Value};

use super::{arity, eager};

pub(crate) const GLOBALS: &[&str] = &["date", "duration", "now", "today"];
pub(crate) const METHODS: &[&str] = &["date", "format", "time", "relative", "isEmpty"];
#[allow(
    dead_code,
    reason = "the family's published field list; no reader in this phase"
)]
pub(crate) const FIELDS: &[&str] = &[
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "millisecond",
];

pub(crate) fn call_global(
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match name {
        "now" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Date(DateValue {
                epoch_ms: ctx.clock.now_ms,
                has_time: true,
            }))
        }
        "today" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Date(start_of_day(ctx.clock.now_ms, ctx.clock)))
        }
        // Text that is not a date, or not a duration, is an empty cell
        // (captured, Task 13: `date("not a date")`, `duration("soon")`).
        "date" => match eager(args, ctx, scope)?.as_slice() {
            [Value::String(text)] => Ok(parse_date_text(text, ctx.clock)
                .map(Value::Date)
                .unwrap_or(Value::Null)),
            [Value::Date(date)] => Ok(Value::Date(*date)),
            // An empty property gives an empty date (captured:
            // `date(missing)` is empty and `date(missing).isEmpty()` true).
            [Value::Null] => Ok(Value::Null),
            _ => Err(EvalError::Argument("date takes one string".into())),
        },
        "duration" => match eager(args, ctx, scope)?.as_slice() {
            [Value::String(text)] => Ok(parse_duration_text(text)
                .map(Value::Duration)
                .unwrap_or(Value::Null)),
            [Value::Duration(duration)] => Ok(Value::Duration(*duration)),
            [Value::Null] => Ok(Value::Null),
            _ => Err(EvalError::Argument("duration takes one string".into())),
        },
        _ => Err(EvalError::UnknownFunction(name.to_string())),
    }
}

pub(crate) fn field(
    date: DateValue,
    name: &str,
    ctx: &EvalContext<'_>,
) -> Result<Value, EvalError> {
    let at = zoned(date, ctx.clock);
    Ok(Value::Number(match name {
        "year" => f64::from(at.year()),
        "month" => f64::from(at.month()),
        "day" => f64::from(at.day()),
        "hour" => f64::from(at.hour()),
        "minute" => f64::from(at.minute()),
        "second" => f64::from(at.second()),
        "millisecond" => f64::from(at.millisecond()),
        _ => {
            return Err(EvalError::NoSuchField {
                target: "date",
                name: name.to_string(),
            });
        }
    }))
}

pub(crate) fn call(
    date: DateValue,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match name {
        "date" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Date(start_of_day(date.epoch_ms, ctx.clock)))
        }
        "format" => match eager(args, ctx, scope)?.as_slice() {
            [Value::String(format)] => format_date(date, format, ctx.clock).map(Value::String),
            _ => Err(EvalError::Argument("format takes one format string".into())),
        },
        "time" => {
            arity(name, args, 0, 0)?;
            format_date(date, "HH:mm:ss", ctx.clock).map(Value::String)
        }
        "relative" => {
            arity(name, args, 0, 0)?;
            Ok(Value::String(relative(date, ctx.clock)))
        }
        "isEmpty" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Boolean(false))
        }
        _ => Err(EvalError::NoSuchMethod {
            target: "date",
            name: name.to_string(),
        }),
    }
}

/// A duration's fields. Captured (Task 13): `duration("1d").days` is 1, a
/// one-day span's `milliseconds` is 86400000, and in a corpus view a span's
/// `days.round(0)` rounds a fraction of a day, so each field is
/// the whole span in that unit, with its fraction, and months and years
/// come from the calendar part. Provisional beyond those.
pub(crate) fn duration_field(duration: DurationValue, name: &str) -> Result<Value, EvalError> {
    let ms = duration.ms as f64;
    Ok(Value::Number(match name {
        "years" => duration.months as f64 / 12.0,
        "months" => duration.months as f64,
        "weeks" => ms / (7.0 * 86_400_000.0),
        "days" => ms / 86_400_000.0,
        "hours" => ms / 3_600_000.0,
        "minutes" => ms / 60_000.0,
        "seconds" => ms / 1_000.0,
        "milliseconds" => ms,
        _ => {
            return Err(EvalError::NoSuchField {
                target: "duration",
                name: name.to_string(),
            });
        }
    }))
}

fn as_duration(value: &Value) -> Option<DurationValue> {
    match value {
        Value::Duration(duration) => Some(*duration),
        Value::String(text) => parse_duration_text(text),
        _ => None,
    }
}

/// Every arithmetic form with a date or a duration in it. `Ok(None)` means
/// "not a date operation" and hands the pair back to plain arithmetic.
pub(crate) fn arithmetic(
    op: BinaryOp,
    left: &Value,
    right: &Value,
    ctx: &EvalContext<'_>,
) -> Result<Option<Value>, EvalError> {
    let date_plus =
        |date: DateValue, value: &Value, sign: i64| -> Result<Option<Value>, EvalError> {
            match as_duration(value) {
                Some(duration) => {
                    add(date, duration, sign, ctx.clock).map(|moved| Some(Value::Date(moved)))
                }
                None => match value {
                    Value::String(text) => {
                        Err(EvalError::Argument(format!("{text:?} is not a duration")))
                    }
                    _ => Ok(None),
                },
            }
        };
    // Checked: two huge durations would overflow (a panic in a debug build).
    let too_long = || EvalError::Argument("the duration is out of range".into());
    match (op, left, right) {
        (BinaryOp::Add, Value::Date(date), other) => date_plus(*date, other, 1),
        // A duration, as captured (Task 13: one day apart shows `a day`,
        // and its `milliseconds` is 86400000), not the number of
        // milliseconds the syntax page describes.
        (BinaryOp::Sub, Value::Date(a), Value::Date(b)) => {
            Ok(Some(Value::Duration(DurationValue {
                months: 0,
                ms: a.epoch_ms.checked_sub(b.epoch_ms).ok_or_else(too_long)?,
                timed: true,
            })))
        }
        (BinaryOp::Sub, Value::Date(date), other) => date_plus(*date, other, -1),
        (BinaryOp::Add, Value::Duration(a), Value::Duration(b)) => {
            Ok(Some(Value::Duration(DurationValue {
                months: a.months.checked_add(b.months).ok_or_else(too_long)?,
                ms: a.ms.checked_add(b.ms).ok_or_else(too_long)?,
                timed: a.timed || b.timed,
            })))
        }
        (BinaryOp::Sub, Value::Duration(a), Value::Duration(b)) => {
            Ok(Some(Value::Duration(DurationValue {
                months: a.months.checked_sub(b.months).ok_or_else(too_long)?,
                ms: a.ms.checked_sub(b.ms).ok_or_else(too_long)?,
                timed: a.timed || b.timed,
            })))
        }
        // A duration scaled by a number stays a duration (captured, Task 13:
        // `duration('5h') * 2` shows `10 hours`; a day divided by 86400000
        // shows `a few seconds`).
        (BinaryOp::Mul | BinaryOp::Div, Value::Duration(duration), Value::Number(factor)) => {
            let factor = if op == BinaryOp::Div {
                1.0 / factor
            } else {
                *factor
            };
            let scale = |amount: i64| {
                let scaled = (amount as f64 * factor).round();
                (scaled.is_finite() && scaled.abs() < i64::MAX as f64)
                    .then_some(scaled as i64)
                    .ok_or_else(too_long)
            };
            let ms = scale(duration.ms)?;
            Ok(Some(Value::Duration(DurationValue {
                months: scale(duration.months)?,
                ms,
                timed: duration.timed || ms % 86_400_000 != 0,
            })))
        }
        // The functions page: "the duration must be on the left".
        (BinaryOp::Mul, Value::Number(_), Value::Duration(_)) => Err(EvalError::Argument(
            "a duration must be on the left of `*`: write duration(…) * n".into(),
        )),
        _ => Ok(None),
    }
}
