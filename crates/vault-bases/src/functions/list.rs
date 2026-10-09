use std::collections::HashSet;

use crate::eval::coerce::{loose_equals, number_to_string, sort_order, to_display_string, truthy};
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
    "sum",
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

/// The key `unique` keeps one item per: the same value of the same kind (a
/// number and its text are two items, though `==` makes them equal), or
/// `None` for an item always kept (a list, an object, NaN: captured, NaN is
/// never a duplicate). A resolved link and the file it resolves to share a
/// key; an unresolved link shares one only with the same text; a date
/// compares by instant. Provisional across kinds: no capture mixes them.
fn equality_key(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => "null".into(),
        Value::Boolean(flag) => format!("b:{flag}"),
        Value::Number(number) if number.is_nan() => return None,
        // `-0 == 0`; ToString writes both as `0`.
        Value::Number(number) => format!("n:{}", number_to_string(*number)),
        Value::String(text) => format!("s:{text}"),
        Value::Date(date) => format!("d:{}", date.epoch_ms),
        Value::Duration(duration) => format!("u:{}:{}", duration.months, duration.ms),
        Value::Link(link) => match &link.resolved {
            Some(path) => format!("f:{}", path.as_str()),
            None => format!("k:{}", link.target),
        },
        Value::File(path) => format!("f:{}", path.as_str()),
        Value::Regexp(regexp) => format!("r:{}/{}", regexp.flags, regexp.source),
        Value::Image(text) => format!("i:{text}"),
        Value::Icon(text) => format!("c:{text}"),
        Value::Html(text) => format!("h:{text}"),
        Value::List(_) | Value::Object(_) => return None,
    })
}

/// Whether a list item is `wanted` for `contains` and its kin: `==`, and a
/// tag written with its `#` is the same tag without it (captured, Task 13:
/// a tags property `[alpha]` both `contains("alpha")` and
/// `contains("#alpha")`).
///
/// Provisional beyond the captures: any text item starting `#` is read as a
/// tag, whether or not a tags property wrote it.
fn holds(item: &Value, wanted: &Value, ctx: &EvalContext<'_>) -> bool {
    if loose_equals(item, wanted, ctx.clock) {
        return true;
    }
    // A tag (an item a tags property wrote with its `#`) holds a tag the way
    // `hasTag` does, nested tags included and without case (seen in a corpus
    // view: a tags property `[a/b]` `contains("a")`).
    match (item, wanted) {
        (Value::String(item), Value::String(wanted)) if item.starts_with('#') => {
            let item = item.trim_start_matches('#').to_lowercase();
            let wanted = wanted.trim_start_matches('#').to_lowercase();
            item == wanted || item.starts_with(&format!("{wanted}/"))
        }
        _ => false,
    }
}

/// The total of the numbers among `items`, from 0.
fn number_total(items: &[Value]) -> f64 {
    items
        .iter()
        .filter_map(|item| match item {
            Value::Number(number) => Some(*number),
            _ => None,
        })
        .fold(0.0, |total, number| total + number)
}

/// Every item of `items` and of the lists in it, at every level. A list
/// nests at most `MAX_VALUE_DEPTH` levels, so the recursion is bounded.
fn flatten_into(items: &[Value], out: &mut Vec<Value>) {
    for item in items {
        match item {
            Value::List(inner) => flatten_into(inner, out),
            other => out.push(other.clone()),
        }
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
    items: &[Value],
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
    items: &[Value],
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    arity(name, args, 1, 1)?;
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let inner = scope
            .bind("value", item.clone())
            .bind("index", Value::Number(index as f64));
        let result = evaluate(&args[0], ctx, &inner)?;
        if name == "map" {
            out.push(result);
        } else if truthy(&result) {
            out.push(item.clone());
        }
    }
    // `map` nests what the lambda answered one level deeper; `filter` keeps
    // items that already fit in a list.
    if name == "map" {
        crate::eval::built_list(out)
    } else {
        Ok(Value::list(out))
    }
}

#[inline(never)]
fn reduce(
    items: &[Value],
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    arity("reduce", args, 2, 2)?;
    let mut acc = evaluate(&args[1], ctx, scope)?;
    // `acc` is moved into the scope, never deep-copied: lists and objects
    // are shared, so binding and reading it are O(1). Whatever the lambda
    // builds from it is checked against MAX_VALUE_DEPTH where it is built.
    for (index, item) in items.iter().enumerate() {
        let inner = scope
            .bind("value", item.clone())
            .bind("index", Value::Number(index as f64))
            .bind("acc", acc);
        acc = evaluate(&args[0], ctx, &inner)?;
    }
    Ok(acc)
}

#[inline(never)]
fn eager_method(
    items: &[Value],
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
    Ok(match name {
        // `==` decides what a list holds (captured: `[1, 2].contains("1")`).
        "contains" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(items.iter().any(|item| holds(item, &values[0], ctx)))
        }
        // Captured: `[1].containsAll()` with nothing to look for is true.
        "containsAll" => Value::Boolean(
            values
                .iter()
                .all(|wanted| items.iter().any(|item| holds(item, wanted, ctx))),
        ),
        "containsAny" => {
            arity(name, args, 1, usize::MAX)?;
            Value::Boolean(
                values
                    .iter()
                    .any(|wanted| items.iter().any(|item| holds(item, wanted, ctx))),
            )
        }
        // Every level (captured: `[1, [2, [3, [4]]]].flat()` is `1, 2, 3, 4`).
        "flat" => {
            arity(name, args, 0, 0)?;
            let mut flat = Vec::with_capacity(items.len());
            flatten_into(items, &mut flat);
            Value::list(flat)
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
                Some(other) => to_display_string(other, ctx.clock),
            };
            Value::String(
                items
                    .iter()
                    .map(|item| match item {
                        Value::Null => String::new(),
                        other => to_display_string(other, ctx.clock),
                    })
                    .collect::<Vec<_>>()
                    .join(&separator),
            )
        }
        "reverse" => {
            arity(name, args, 0, 0)?;
            Value::list(items.iter().rev().cloned().collect())
        }
        "slice" => {
            arity(name, args, 1, 2)?;
            let len = items.len();
            let from = relative_index(index_arg(name, values.first())?.unwrap_or(0), len);
            let to = index_arg(name, values.get(1))?.map_or(len, |end| relative_index(end, len));
            Value::list(if from < to {
                items[from..to].to_vec()
            } else {
                Vec::new()
            })
        }
        "sort" => {
            arity(name, args, 0, 0)?;
            let mut sorted = items.to_vec();
            sorted.sort_by(sort_order);
            Value::list(sorted)
        }
        // The distinct items, in sorted order (captured: `[3, 1, 3, 2]` is
        // `1, 2, 3`, `[2, 1, 2]` is `1, 2`; NaN is never a duplicate).
        "unique" => {
            arity(name, args, 0, 0)?;
            // One pass with a set of equality keys, not a scan of everything
            // kept so far per item (quadratic on a long list).
            let mut seen = HashSet::new();
            let mut kept: Vec<Value> = Vec::with_capacity(items.len());
            for item in items {
                let fresh = match equality_key(item) {
                    Some(key) => seen.insert(key),
                    None => true,
                };
                if fresh {
                    kept.push(item.clone());
                }
            }
            kept.sort_by(sort_order);
            Value::list(kept)
        }
        // The numbers' total over every item's count (captured: `[1, "a",
        // 3].mean()` is 1.3333333333333333), and empty for an empty list.
        "mean" => {
            arity(name, args, 0, 0)?;
            if items.is_empty() {
                return Ok(Value::Null);
            }
            Value::Number(number_total(items) / items.len() as f64)
        }
        // The total of the numbers (captured: `[1, 2, "3"].sum()` is 3).
        "sum" => {
            arity(name, args, 0, 0)?;
            Value::Number(number_total(items))
        }
        _ => {
            return Err(EvalError::NoSuchMethod {
                target: "list",
                name: name.to_string(),
            });
        }
    })
}
