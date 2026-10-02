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
        "date" => match eager(args, ctx, scope)?.as_slice() {
            [Value::String(text)] => parse_date_text(text, ctx.clock)
                .map(Value::Date)
                .ok_or_else(|| EvalError::Argument(format!("{text:?} is not a date"))),
            [Value::Date(date)] => Ok(Value::Date(*date)),
            _ => Err(EvalError::Argument("date takes one string".into())),
        },
        "duration" => match eager(args, ctx, scope)?.as_slice() {
            [Value::String(text)] => parse_duration_text(text)
                .map(Value::Duration)
                .ok_or_else(|| EvalError::Argument(format!("{text:?} is not a duration"))),
            [Value::Duration(duration)] => Ok(Value::Duration(*duration)),
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
        // The syntax page: "the millisecond difference between the two" — a
        // number, so `(a - b) / 86400000` and `a - b > n` work. Whole
        // milliseconds, so there is nothing to round.
        (BinaryOp::Sub, Value::Date(a), Value::Date(b)) => {
            Ok(Some(Value::Number((a.epoch_ms - b.epoch_ms) as f64)))
        }
        (BinaryOp::Sub, Value::Date(date), other) => date_plus(*date, other, -1),
        (BinaryOp::Add, Value::Duration(a), Value::Duration(b)) => {
            Ok(Some(Value::Duration(DurationValue {
                months: a.months.checked_add(b.months).ok_or_else(too_long)?,
                ms: a.ms.checked_add(b.ms).ok_or_else(too_long)?,
            })))
        }
        (BinaryOp::Sub, Value::Duration(a), Value::Duration(b)) => {
            Ok(Some(Value::Duration(DurationValue {
                months: a.months.checked_sub(b.months).ok_or_else(too_long)?,
                ms: a.ms.checked_sub(b.ms).ok_or_else(too_long)?,
            })))
        }
        (BinaryOp::Mul, Value::Duration(duration), Value::Number(factor)) => {
            Ok(Some(Value::Duration(DurationValue {
                months: (duration.months as f64 * factor).round() as i64,
                ms: (duration.ms as f64 * factor).round() as i64,
            })))
        }
        // The functions page: "the duration must be on the left".
        (BinaryOp::Mul, Value::Number(_), Value::Duration(_)) => Err(EvalError::Argument(
            "a duration must be on the left of `*`: write duration(…) * n".into(),
        )),
        _ => Ok(None),
    }
}
