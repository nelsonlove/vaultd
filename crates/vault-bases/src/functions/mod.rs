//! Dispatch from a name to a function family.
//!
//! Each family module exports `GLOBALS` (the global functions it owns),
//! `METHODS` and `FIELDS` (by receiver type), so [`is_known_global`] and
//! [`is_known_method`] are the union of what is implemented — the compile
//! step (Task 7) answers `unsupported_function` for anything outside it.

mod any;
mod global;

use vault_core::PropertyValue;

use crate::eval::{EvalContext, EvalError, Scope, property_value};
use crate::expr::{BinaryOp, Expr};
use crate::value::Value;

/// A property value with its declared type applied. Task 5 adds dates and
/// Task 6 adds frontmatter links; until then, the YAML type.
pub(crate) fn typed_property(_ctx: &EvalContext<'_>, _key: &str, value: &PropertyValue) -> Value {
    property_value(value)
}

/// Date and duration arithmetic, when either side is a date or a duration.
/// `Ok(None)` hands the operation back to plain arithmetic. Task 5 fills it.
pub(crate) fn date_arithmetic(
    _op: BinaryOp,
    _left: &Value,
    _right: &Value,
    _ctx: &EvalContext<'_>,
) -> Result<Option<Value>, EvalError> {
    Ok(None)
}

pub(crate) fn call_global(
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    if global::GLOBALS.contains(&name) {
        return global::call(name, args, ctx, scope);
    }
    Err(EvalError::UnknownFunction(name.to_string()))
}

pub(crate) fn call_method(
    target: Value,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    if any::METHODS.contains(&name) {
        return any::call(&target, name, args, ctx, scope);
    }
    Err(EvalError::NoSuchMethod {
        target: target.type_name(),
        name: name.to_string(),
    })
}

pub(crate) fn field(
    target: &Value,
    name: &str,
    _ctx: &EvalContext<'_>,
) -> Result<Value, EvalError> {
    match target {
        Value::Null => Ok(Value::Null),
        other => Err(EvalError::NoSuchField {
            target: other.type_name(),
            name: name.to_string(),
        }),
    }
}

pub fn is_known_global(name: &str) -> bool {
    global::GLOBALS.contains(&name)
}

pub fn is_known_method(name: &str) -> bool {
    any::METHODS.contains(&name)
}

/// Evaluate every argument eagerly — the default for every function except
/// the lazy ones (`if`, and the list methods that bind `value`).
pub(crate) fn eager(
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Vec<Value>, EvalError> {
    args.iter()
        .map(|arg| crate::eval::evaluate(arg, ctx, scope))
        .collect()
}

pub(crate) fn arity(name: &str, args: &[Expr], least: usize, most: usize) -> Result<(), EvalError> {
    if args.len() < least || args.len() > most {
        return Err(EvalError::Argument(format!(
            "{name} takes {least}{} arguments, not {}",
            if most == least {
                String::new()
            } else if most == usize::MAX {
                " or more".into()
            } else {
                format!(" to {most}")
            },
            args.len()
        )));
    }
    Ok(())
}
