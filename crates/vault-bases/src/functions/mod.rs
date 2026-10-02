//! Dispatch from a name to a function family.
//!
//! Each family module exports `GLOBALS` (the global functions it owns),
//! `METHODS` and `FIELDS` (by receiver type), so [`is_known_global`] and
//! [`is_known_method`] are the union of what is implemented — the compile
//! step (Task 7) answers `unsupported_function` for anything outside it.

mod any;
mod date;
mod global;
mod list;
mod number;
mod object;
mod regexp;
mod string;

use vault_core::PropertyValue;

use crate::eval::{EvalContext, EvalError, Scope, property_value};
use crate::expr::{BinaryOp, Expr};
use crate::source::PropertyType;
use crate::value::Value;

/// A property value with its declared type applied: a date- or
/// datetime-typed property's text becomes a date (text that does not parse
/// stays text, as Obsidian shows it). Task 6 adds frontmatter links.
pub(crate) fn typed_property(ctx: &EvalContext<'_>, key: &str, value: &PropertyValue) -> Value {
    let plain = property_value(value);
    match (ctx.source.property_type(key), &plain) {
        (Some(PropertyType::Date | PropertyType::DateTime), Value::String(text)) => {
            crate::dates::parse_date_text(text, ctx.clock)
                .map(Value::Date)
                .unwrap_or(plain)
        }
        _ => plain,
    }
}

/// Date and duration arithmetic, when either side is a date or a duration.
/// `Ok(None)` hands the operation back to plain arithmetic.
pub(crate) fn date_arithmetic(
    op: BinaryOp,
    left: &Value,
    right: &Value,
    ctx: &EvalContext<'_>,
) -> Result<Option<Value>, EvalError> {
    date::arithmetic(op, left, right, ctx)
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
    if date::GLOBALS.contains(&name) {
        return date::call_global(name, args, ctx, scope);
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
    match target {
        // A missing property is `null`. `isEmpty` is true for it (the
        // string and number entries: "or is not present"); every other
        // method on it is an error cell — "a missing property in a method
        // call", in the spec's words.
        Value::Null if name == "isEmpty" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Boolean(true))
        }
        Value::String(text) => string::call(&text, name, args, ctx, scope),
        Value::Number(number) => number::call(number, name, args, ctx, scope),
        Value::List(items) => list::call(items, name, args, ctx, scope),
        Value::Object(entries) => object::call(entries, name, args),
        Value::Regexp(regexp) => regexp::call(&regexp, name, args, ctx, scope),
        Value::Date(date) => date::call(date, name, args, ctx, scope),
        other => Err(EvalError::NoSuchMethod {
            target: other.type_name(),
            name: name.to_string(),
        }),
    }
}

pub(crate) fn field(target: &Value, name: &str, ctx: &EvalContext<'_>) -> Result<Value, EvalError> {
    match target {
        Value::Null => Ok(Value::Null),
        Value::String(text) => string::field(text, name),
        Value::List(items) => list::field(items, name),
        Value::Date(date) => date::field(*date, name, ctx),
        other => Err(EvalError::NoSuchField {
            target: other.type_name(),
            name: name.to_string(),
        }),
    }
}

pub fn is_known_global(name: &str) -> bool {
    global::GLOBALS.contains(&name) || date::GLOBALS.contains(&name)
}

pub fn is_known_method(name: &str) -> bool {
    [
        any::METHODS,
        string::METHODS,
        number::METHODS,
        list::METHODS,
        object::METHODS,
        regexp::METHODS,
        date::METHODS,
    ]
    .iter()
    .any(|methods| methods.contains(&name))
}

/// Evaluate every argument eagerly — the default for every function except
/// the lazy ones (`if`, and the list methods that bind `value`).
pub(crate) fn eager(
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Vec<Value>, EvalError> {
    // A plain loop, not an iterator `collect`: in a debug build the
    // iterator adapters add several frames per nesting level.
    let mut values = Vec::with_capacity(args.len());
    for arg in args {
        values.push(crate::eval::evaluate(arg, ctx, scope)?);
    }
    Ok(values)
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
