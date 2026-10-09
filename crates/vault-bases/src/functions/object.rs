use crate::eval::EvalError;
use crate::expr::Expr;
use crate::value::Value;

use super::arity;

pub(crate) const METHODS: &[&str] = &["isEmpty", "keys", "values"];

/// A canonical array index (`"0"`, `"17"`, never `"01"`), the keys
/// JavaScript orders before every other key.
fn is_array_index(key: &str) -> bool {
    !key.is_empty()
        && key.bytes().all(|b| b.is_ascii_digit())
        && (key == "0" || !key.starts_with('0'))
        && key.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
}

pub(crate) fn call(
    entries: &[(String, Value)],
    name: &str,
    args: &[Expr],
) -> Result<Value, EvalError> {
    if METHODS.contains(&name) {
        arity(name, args, 0, 0)?;
    }
    // Keys keep insertion order here. JavaScript lists integer-like keys
    // first, ascending; whether Obsidian's object keeps that order is not
    // published, and Obsidian 1.13.7 cannot parse an object literal, so
    // Task 13 could not capture it: an object with such a key among others
    // is still `Uncaptured`.
    if entries.len() > 1 && entries.iter().any(|(key, _)| is_array_index(key)) {
        match name {
            "keys" => return Err(EvalError::Uncaptured("keys:integer_order".into())),
            "values" => return Err(EvalError::Uncaptured("values:integer_order".into())),
            _ => {}
        }
    }
    Ok(match name {
        "isEmpty" => Value::Boolean(entries.is_empty()),
        "keys" => Value::list(
            entries
                .iter()
                .map(|(key, _)| Value::String(key.clone()))
                .collect(),
        ),
        "values" => Value::list(entries.iter().map(|(_, value)| value.clone()).collect()),
        _ => {
            return Err(EvalError::NoSuchMethod {
                target: "object",
                name: name.to_string(),
            });
        }
    })
}
