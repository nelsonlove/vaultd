use crate::eval::coerce::{is_js_space, js_to_number, truthy};
use crate::eval::{EvalContext, EvalError, Scope, evaluate};
use crate::expr::Expr;
use crate::value::Value;

use super::{arity, eager};

pub(crate) const GLOBALS: &[&str] = &[
    "if",
    "list",
    "number",
    "max",
    "min",
    "random",
    "escapeHTML",
    "html",
    "icon",
    "image",
];

fn one_string(name: &str, values: &[Value]) -> Result<String, EvalError> {
    match values {
        [Value::String(text)] => Ok(text.clone()),
        [Value::File(path)] => Ok(path.as_str().to_string()),
        _ => Err(EvalError::Argument(format!("{name} takes one string"))),
    }
}

fn numbers(name: &str, values: Vec<Value>) -> Result<Vec<f64>, EvalError> {
    if values.is_empty() {
        return Err(EvalError::Argument(format!(
            "{name} needs at least one number"
        )));
    }
    values
        .into_iter()
        .map(|value| match value {
            Value::Number(number) => Ok(number),
            other => Err(EvalError::Argument(format!(
                "{name} takes numbers, not {}",
                other.type_name()
            ))),
        })
        .collect()
}

/// One global function call. Each function is its own small
/// `#[inline(never)]` function rather than an arm of one large `match`: a
/// nested call such as `max(max(…))` re-enters the evaluator through this
/// frame once per level, and in a debug build one large `match` gives every
/// level the frame of its largest arm.
pub(crate) fn call(
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match name {
        "if" => if_(args, ctx, scope),
        "list" => list(args, ctx, scope),
        "number" => number(args, ctx, scope),
        "max" => extreme(name, true, args, ctx, scope),
        "min" => extreme(name, false, args, ctx, scope),
        "random" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Number(ctx.next_random()))
        }
        "escapeHTML" => escape_html(args, ctx, scope),
        "html" => Ok(Value::Html(string_argument(name, args, ctx, scope)?)),
        "icon" => Ok(Value::Icon(string_argument(name, args, ctx, scope)?)),
        "image" => Ok(Value::Image(string_argument(name, args, ctx, scope)?)),
        _ => Err(EvalError::UnknownFunction(name.to_string())),
    }
}

/// Lazy: only the chosen branch is evaluated, so `if(true, 1, 1 / 0)` is 1,
/// not an error.
#[inline(never)]
fn if_(args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    arity("if", args, 2, 3)?;
    if truthy(&evaluate(&args[0], ctx, scope)?) {
        evaluate(&args[1], ctx, scope)
    } else {
        match args.get(2) {
            Some(otherwise) => evaluate(otherwise, ctx, scope),
            None => Ok(Value::Null),
        }
    }
}

#[inline(never)]
fn list(args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    arity("list", args, 1, 1)?;
    Ok(match evaluate(&args[0], ctx, scope)? {
        list @ Value::List(_) => list,
        other => crate::eval::built_list(vec![other])?,
    })
}

#[inline(never)]
fn number(args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    arity("number", args, 1, 1)?;
    // Captured: `number("")` and `number("abc")` are errors ("Unable to
    // parse … as a number"), `number("Infinity")` is Infinity, and
    // `number(missing)` is empty.
    match evaluate(&args[0], ctx, scope)? {
        Value::Number(number) => Ok(Value::Number(number)),
        Value::Boolean(flag) => Ok(Value::Number(if flag { 1.0 } else { 0.0 })),
        Value::Date(date) => Ok(Value::Number(date.epoch_ms as f64)),
        Value::String(text) => {
            let number = js_to_number(&text);
            if text.trim_matches(is_js_space).is_empty() || number.is_nan() {
                Err(EvalError::Argument(format!(
                    "Unable to parse {text:?} as a number."
                )))
            } else {
                Ok(Value::Number(number))
            }
        }
        Value::Null => Ok(Value::Null),
        other => Err(EvalError::Argument(format!(
            "number cannot convert {}",
            other.type_name()
        ))),
    }
}

/// `max` and `min`. Like JavaScript's `Math.max` and `Math.min`, a NaN
/// operand makes the answer NaN (`f64::max` would drop it).
#[inline(never)]
fn extreme(
    name: &str,
    largest: bool,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let values = numbers(name, eager(args, ctx, scope)?)?;
    let pick = |a: f64, b: f64| {
        if a.is_nan() || b.is_nan() {
            f64::NAN
        } else if largest {
            a.max(b)
        } else {
            a.min(b)
        }
    };
    Ok(Value::Number(
        values
            .into_iter()
            .reduce(pick)
            .expect("at least one number"),
    ))
}

#[inline(never)]
fn escape_html(args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    let text = string_argument("escapeHTML", args, ctx, scope)?;
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            // Captured: a single quote is kept.
            other => escaped.push(other),
        }
    }
    Ok(Value::String(escaped))
}

#[inline(never)]
fn string_argument(
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<String, EvalError> {
    one_string(name, &eager(args, ctx, scope)?)
}
