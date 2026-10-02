use crate::eval::coerce::{parse_js_number, truthy};
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

pub(crate) fn call(
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match name {
        // Lazy: only the chosen branch is evaluated, so
        // `if(true, 1, 1 / 0)` is 1, not an error.
        "if" => {
            arity(name, args, 2, 3)?;
            if truthy(&evaluate(&args[0], ctx, scope)?) {
                evaluate(&args[1], ctx, scope)
            } else {
                match args.get(2) {
                    Some(otherwise) => evaluate(otherwise, ctx, scope),
                    None => Ok(Value::Null),
                }
            }
        }
        "list" => {
            arity(name, args, 1, 1)?;
            Ok(match evaluate(&args[0], ctx, scope)? {
                list @ Value::List(_) => list,
                other => Value::List(vec![other]),
            })
        }
        "number" => {
            arity(name, args, 1, 1)?;
            match evaluate(&args[0], ctx, scope)? {
                Value::Number(number) => Ok(Value::Number(number)),
                Value::Boolean(flag) => Ok(Value::Number(if flag { 1.0 } else { 0.0 })),
                Value::Date(date) => Ok(Value::Number(date.epoch_ms as f64)),
                Value::String(text) if text.trim().is_empty() => {
                    Err(EvalError::Uncaptured("number:empty_string".into()))
                }
                Value::String(text) => parse_js_number(&text)
                    .map(Value::Number)
                    .ok_or_else(|| EvalError::Argument(format!("{text:?} is not a number"))),
                Value::Null => Err(EvalError::Uncaptured("number:null".into())),
                other => Err(EvalError::Argument(format!(
                    "number cannot convert {}",
                    other.type_name()
                ))),
            }
        }
        "max" | "min" => {
            let values = numbers(name, eager(args, ctx, scope)?)?;
            let pick = if name == "max" { f64::max } else { f64::min };
            Ok(Value::Number(
                values
                    .into_iter()
                    .reduce(pick)
                    .expect("at least one number"),
            ))
        }
        "random" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Number(ctx.next_random()))
        }
        "escapeHTML" => {
            let text = one_string(name, &eager(args, ctx, scope)?)?;
            let mut escaped = String::with_capacity(text.len());
            for c in text.chars() {
                match c {
                    '&' => escaped.push_str("&amp;"),
                    '<' => escaped.push_str("&lt;"),
                    '>' => escaped.push_str("&gt;"),
                    '"' => escaped.push_str("&quot;"),
                    '\'' => escaped.push_str("&#39;"),
                    other => escaped.push(other),
                }
            }
            Ok(Value::String(escaped))
        }
        "html" => Ok(Value::Html(one_string(name, &eager(args, ctx, scope)?)?)),
        "icon" => Ok(Value::Icon(one_string(name, &eager(args, ctx, scope)?)?)),
        "image" => Ok(Value::Image(one_string(name, &eager(args, ctx, scope)?)?)),
        _ => Err(EvalError::UnknownFunction(name.to_string())),
    }
}
