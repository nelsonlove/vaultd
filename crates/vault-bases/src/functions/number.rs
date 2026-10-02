use crate::eval::coerce::number_to_string;
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::Value;

use super::{arity, eager};

pub(crate) const METHODS: &[&str] = &["abs", "ceil", "floor", "isEmpty", "round", "toFixed"];

/// JavaScript's `Math.round`: halves go toward +∞, so `-2.5` rounds to `-2`.
/// The fraction is taken from the floor, which is exact, rather than by
/// adding 0.5 first, which rounds `0.49999999999999994` up to 1.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// ECMA-262 `Number.prototype.toFixed`: the integer `n` closest to
/// `value × 10^digits`, the larger on a tie, computed on the value's exact
/// binary expansion — Rust prints that expansion exactly at any precision, so
/// a 30-digit tail is enough to see whether the dropped part is a tie.
pub(crate) fn to_fixed(value: f64, digits: usize) -> String {
    // ECMA-262 steps 6 and 10: a non-finite value, and one of 10^21 or more,
    // print as `ToString` prints them.
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value.abs() >= 1e21 {
        return number_to_string(value);
    }
    let exact = format!("{:.*}", digits + 30, value.abs());
    let (whole, fraction) = exact
        .split_once('.')
        .expect("a fixed-precision float has a point");
    let kept = &fraction[..digits];
    let dropped = &fraction[digits..];
    let round_up = dropped.as_bytes()[0] >= b'5';
    let mut number: Vec<u8> = format!("{whole}{kept}").into_bytes();
    if round_up {
        let mut at = number.len();
        loop {
            if at == 0 {
                number.insert(0, b'1');
                break;
            }
            at -= 1;
            if number[at] == b'9' {
                number[at] = b'0';
            } else {
                number[at] += 1;
                break;
            }
        }
    }
    let number = String::from_utf8(number).expect("ASCII digits");
    let split = number.len() - digits;
    let body = if digits == 0 {
        number
    } else {
        format!("{}.{}", &number[..split], &number[split..])
    };
    // ECMA-262: "if x < 0, let s be "-"", so `-0.001` is `-0.00`; `-0` is
    // not below 0 and has no sign.
    if value < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

pub(crate) fn call(
    number: f64,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
    let digits = |values: &[Value]| -> Result<Option<usize>, EvalError> {
        match values.first() {
            None => Ok(None),
            Some(Value::Number(digits)) if *digits >= 0.0 && *digits <= 100.0 => {
                Ok(Some(*digits as usize))
            }
            Some(_) => Err(EvalError::Argument(format!(
                "{name} takes a digit count from 0 to 100"
            ))),
        }
    };
    Ok(match name {
        "abs" | "ceil" | "floor" | "isEmpty" => {
            arity(name, args, 0, 0)?;
            match name {
                "abs" => Value::Number(number.abs()),
                "ceil" => Value::Number(number.ceil()),
                "floor" => Value::Number(number.floor()),
                _ => Value::Boolean(false),
            }
        }
        "round" => {
            arity(name, args, 0, 1)?;
            match digits(&values)? {
                None | Some(0) => Value::Number(js_round(number)),
                Some(digits) => {
                    let scale = 10f64.powi(digits as i32);
                    Value::Number(js_round(number * scale) / scale)
                }
            }
        }
        "toFixed" => {
            arity(name, args, 0, 1)?;
            Value::String(to_fixed(number, digits(&values)?.unwrap_or(0)))
        }
        _ => {
            return Err(EvalError::NoSuchMethod {
                target: "number",
                name: name.to_string(),
            });
        }
    })
}
