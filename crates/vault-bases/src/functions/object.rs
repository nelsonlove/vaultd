use crate::eval::EvalError;
use crate::expr::Expr;
use crate::value::Value;

use super::arity;

pub(crate) const METHODS: &[&str] = &["isEmpty", "keys", "values"];

pub(crate) fn call(
    entries: Vec<(String, Value)>,
    name: &str,
    args: &[Expr],
) -> Result<Value, EvalError> {
    if METHODS.contains(&name) {
        arity(name, args, 0, 0)?;
    }
    Ok(match name {
        "isEmpty" => Value::Boolean(entries.is_empty()),
        "keys" => Value::List(
            entries
                .into_iter()
                .map(|(key, _)| Value::String(key))
                .collect(),
        ),
        "values" => Value::List(entries.into_iter().map(|(_, value)| value).collect()),
        _ => {
            return Err(EvalError::NoSuchMethod {
                target: "object",
                name: name.to_string(),
            });
        }
    })
}
