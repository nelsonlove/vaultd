use crate::eval::coerce::{to_display_string, truthy};
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::Value;

use super::{arity, eager};

/// Methods every value has. `isEmpty` is per type (string, number, date,
/// list, object) and lives with those families.
pub(crate) const METHODS: &[&str] = &["isTruthy", "isType", "toString"];

pub(crate) fn call(
    target: &Value,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match name {
        "isTruthy" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Boolean(truthy(target)))
        }
        "isType" => {
            let wanted = match eager(args, ctx, scope)?.as_slice() {
                [Value::String(wanted)] => wanted.clone(),
                _ => return Err(EvalError::Argument("isType takes one type name".into())),
            };
            Ok(Value::Boolean(target.type_name() == wanted))
        }
        "toString" => {
            // Captured: `missing.toString()` is the text `null`.
            arity(name, args, 0, 0)?;
            Ok(Value::String(to_display_string(target, ctx.clock)))
        }
        _ => Err(EvalError::NoSuchMethod {
            target: target.type_name(),
            name: name.to_string(),
        }),
    }
}
