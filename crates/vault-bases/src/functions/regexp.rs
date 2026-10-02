use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::{RegexpValue, Value};

use super::{arity, eager};

pub(crate) const METHODS: &[&str] = &["matches"];

pub(crate) fn call(
    regexp: &RegexpValue,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match name {
        "matches" => {
            arity(name, args, 1, 1)?;
            match eager(args, ctx, scope)?.as_slice() {
                [Value::String(text)] => Ok(Value::Boolean(regexp.regex.is_match(text))),
                _ => Err(EvalError::Argument("matches takes one string".into())),
            }
        }
        _ => Err(EvalError::NoSuchMethod {
            target: "regexp",
            name: name.to_string(),
        }),
    }
}
