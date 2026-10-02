use crate::eval::coerce::{sort_order, strict_equals, to_display_string, truthy};
use crate::eval::{EvalContext, EvalError, Scope, evaluate};
use crate::expr::Expr;
use crate::value::Value;

use super::string::relative_index;
use super::{arity, eager};

pub(crate) const METHODS: &[&str] = &[
    "contains",
    "containsAll",
    "containsAny",
    "filter",
    "flat",
    "isEmpty",
    "join",
    "map",
    "reduce",
    "reverse",
    "slice",
    "sort",
    "unique",
    "mean",
];
#[allow(
    dead_code,
    reason = "the family's published field list; no reader in this phase"
)]
pub(crate) const FIELDS: &[&str] = &["length"];

pub(crate) fn field(items: &[Value], name: &str) -> Result<Value, EvalError> {
    match name {
        "length" => Ok(Value::Number(items.len() as f64)),
        _ => Err(EvalError::NoSuchField {
            target: "list",
            name: name.to_string(),
        }),
    }
}

fn index_arg(name: &str, value: Option<&Value>) -> Result<Option<i64>, EvalError> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) => Ok(Some(number.trunc() as i64)),
        Some(other) => Err(EvalError::Argument(format!(
            "{name} takes a number, not {}",
            other.type_name()
        ))),
    }
}

/// The three lambda methods evaluate their expression per element with
/// `value` and `index` bound (and `acc` for reduce); everything else takes
/// its arguments eagerly. Each kind is its own small frame: a lambda
/// re-enters [`evaluate`], so nested `map` calls stack one of these frames
/// per level, and the nesting cap must still fit a 2 MiB stack in a debug
/// build (`nested_list_lambdas_fit_a_two_mebibyte_stack_at_the_nesting_cap`).
pub(crate) fn call(
    items: Vec<Value>,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match name {
        "filter" | "map" => filter_or_map(items, name, args, ctx, scope),
        "reduce" => reduce(items, args, ctx, scope),
        _ => eager_method(items, name, args, ctx, scope),
    }
}

#[inline(never)]
fn filter_or_map(
    items: Vec<Value>,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    arity(name, args, 1, 1)?;
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        let inner = scope
            .bind("value", item.clone())
            .bind("index", Value::Number(index as f64));
        let result = evaluate(&args[0], ctx, &inner)?;
        if name == "map" {
            out.push(result);
        } else if truthy(&result) {
            out.push(item);
        }
    }
    Ok(Value::List(out))
}

#[inline(never)]
fn reduce(
    items: Vec<Value>,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    arity("reduce", args, 2, 2)?;
    let mut acc = evaluate(&args[1], ctx, scope)?;
    for (index, item) in items.into_iter().enumerate() {
        let inner = scope
            .bind("value", item)
            .bind("index", Value::Number(index as f64))
            .bind("acc", acc);
        acc = evaluate(&args[0], ctx, &inner)?;
    }
    Ok(acc)
}

#[inline(never)]
fn eager_method(
    items: Vec<Value>,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
    Ok(match name {
        "contains" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(items.iter().any(|item| strict_equals(item, &values[0])))
        }
        "containsAll" => {
            arity(name, args, 1, usize::MAX)?;
            Value::Boolean(
                values
                    .iter()
                    .all(|wanted| items.iter().any(|item| strict_equals(item, wanted))),
            )
        }
        "containsAny" => {
            arity(name, args, 1, usize::MAX)?;
            Value::Boolean(
                values
                    .iter()
                    .any(|wanted| items.iter().any(|item| strict_equals(item, wanted))),
            )
        }
        "flat" => {
            arity(name, args, 0, 0)?;
            Value::List(
                items
                    .into_iter()
                    .flat_map(|item| match item {
                        Value::List(inner) => inner,
                        other => vec![other],
                    })
                    .collect(),
            )
        }
        "isEmpty" => {
            arity(name, args, 0, 0)?;
            Value::Boolean(items.is_empty())
        }
        "join" => {
            arity(name, args, 0, 1)?;
            let separator = match values.first() {
                None => ",".to_string(),
                Some(Value::String(separator)) => separator.clone(),
                Some(other) => to_display_string(other)?,
            };
            Value::String(
                items
                    .iter()
                    .map(|item| match item {
                        Value::Null => Ok(String::new()),
                        other => to_display_string(other),
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .join(&separator),
            )
        }
        "reverse" => {
            arity(name, args, 0, 0)?;
            Value::List(items.into_iter().rev().collect())
        }
        "slice" => {
            arity(name, args, 1, 2)?;
            let len = items.len();
            let from = relative_index(index_arg(name, values.first())?.unwrap_or(0), len);
            let to = index_arg(name, values.get(1))?.map_or(len, |end| relative_index(end, len));
            Value::List(if from < to {
                items[from..to].to_vec()
            } else {
                Vec::new()
            })
        }
        "sort" => {
            arity(name, args, 0, 0)?;
            let mut sorted = items;
            sorted.sort_by(sort_order);
            Value::List(sorted)
        }
        "unique" => {
            arity(name, args, 0, 0)?;
            let mut kept: Vec<Value> = Vec::with_capacity(items.len());
            for item in items {
                if !kept.iter().any(|have| strict_equals(have, &item)) {
                    kept.push(item);
                }
            }
            Value::List(kept)
        }
        // The syntax page's summary example (`values.mean()`, "the same as
        // the default Average"): the mean of the numbers, skipping the rest
        // the way `Average` is described ("all numbers from the input values").
        "mean" => {
            arity(name, args, 0, 0)?;
            let numbers: Vec<f64> = items
                .iter()
                .filter_map(|item| match item {
                    Value::Number(number) => Some(*number),
                    _ => None,
                })
                .collect();
            if numbers.is_empty() {
                return Err(EvalError::Uncaptured("mean:empty".into()));
            }
            Value::Number(numbers.iter().sum::<f64>() / numbers.len() as f64)
        }
        _ => {
            return Err(EvalError::NoSuchMethod {
                target: "list",
                name: name.to_string(),
            });
        }
    })
}
