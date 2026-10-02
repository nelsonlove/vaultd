use crate::eval::coerce::to_display_string;
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::Value;

use super::{arity, eager};

pub(crate) const METHODS: &[&str] = &[
    "contains",
    "containsAll",
    "containsAny",
    "endsWith",
    "isEmpty",
    "lower",
    "replace",
    "repeat",
    "reverse",
    "slice",
    "split",
    "startsWith",
    "title",
    "trim",
];
#[allow(
    dead_code,
    reason = "the family's published field list; no reader in this phase"
)]
pub(crate) const FIELDS: &[&str] = &["length"];

/// The longest string `repeat` builds, in UTF-8 bytes: V8's own string
/// limit is about 2^29 UTF-16 units.
const MAX_REPEAT_BYTES: u64 = 1 << 29;

fn strings(name: &str, values: Vec<Value>) -> Result<Vec<String>, EvalError> {
    values
        .into_iter()
        .map(|value| match value {
            Value::String(text) => Ok(text),
            other => Err(EvalError::Argument(format!(
                "{name} takes strings, not {}",
                other.type_name()
            ))),
        })
        .collect()
}

fn integer(name: &str, value: Option<&Value>) -> Result<Option<i64>, EvalError> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) => Ok(Some(number.trunc() as i64)),
        Some(other) => Err(EvalError::Argument(format!(
            "{name} takes a number, not {}",
            other.type_name()
        ))),
    }
}

/// JavaScript's relative index: negative counts from the end, clamped to
/// `[0, len]`.
pub(crate) fn relative_index(index: i64, len: usize) -> usize {
    if index < 0 {
        len.saturating_sub(index.unsigned_abs() as usize)
    } else {
        (index as usize).min(len)
    }
}

pub(crate) fn utf16_slice(text: &str, start: i64, end: Option<i64>) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let from = relative_index(start, units.len());
    let to = end.map_or(units.len(), |end| relative_index(end, units.len()));
    if from >= to {
        return String::new();
    }
    String::from_utf16_lossy(&units[from..to])
}

/// A JavaScript replacement string (`$1`, `$&`, `$$`) in the `regex` crate's
/// syntax (`${1}`, `${0}`, `$$`). Braces always, so `$1a` stays group 1 then
/// `a` rather than becoming a group named `1a`.
fn replacement(js: &str) -> String {
    let mut out = String::with_capacity(js.len());
    let mut chars = js.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('$') => {
                chars.next();
                out.push_str("$$");
            }
            Some('&') => {
                chars.next();
                out.push_str("${0}");
            }
            Some(d) if d.is_ascii_digit() => {
                let mut digits = String::new();
                while let Some(d) = chars.peek().copied().filter(char::is_ascii_digit) {
                    digits.push(d);
                    chars.next();
                }
                out.push_str(&format!("${{{digits}}}"));
            }
            _ => out.push_str("$$"),
        }
    }
    out
}

pub(crate) fn field(text: &str, name: &str) -> Result<Value, EvalError> {
    match name {
        "length" => Ok(Value::Number(text.encode_utf16().count() as f64)),
        _ => Err(EvalError::NoSuchField {
            target: "string",
            name: name.to_string(),
        }),
    }
}

pub(crate) fn call(
    text: &str,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
    Ok(match name {
        "contains" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(text.contains(strings(name, values)?[0].as_str()))
        }
        "containsAll" => {
            arity(name, args, 1, usize::MAX)?;
            Value::Boolean(
                strings(name, values)?
                    .iter()
                    .all(|wanted| text.contains(wanted.as_str())),
            )
        }
        "containsAny" => {
            arity(name, args, 1, usize::MAX)?;
            Value::Boolean(
                strings(name, values)?
                    .iter()
                    .any(|wanted| text.contains(wanted.as_str())),
            )
        }
        "startsWith" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(text.starts_with(strings(name, values)?[0].as_str()))
        }
        "endsWith" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(text.ends_with(strings(name, values)?[0].as_str()))
        }
        "isEmpty" => {
            arity(name, args, 0, 0)?;
            Value::Boolean(text.is_empty())
        }
        "lower" => {
            arity(name, args, 0, 0)?;
            Value::String(text.to_lowercase())
        }
        "trim" => {
            arity(name, args, 0, 0)?;
            Value::String(text.trim().to_string())
        }
        "title" => {
            arity(name, args, 0, 0)?;
            let mut out = String::with_capacity(text.len());
            let mut at_word_start = true;
            for c in text.chars() {
                if at_word_start && c.is_alphabetic() {
                    out.extend(c.to_uppercase());
                } else {
                    out.push(c);
                }
                at_word_start = c.is_whitespace();
            }
            Value::String(out)
        }
        "repeat" => {
            arity(name, args, 1, 1)?;
            match integer(name, values.first())? {
                // JavaScript throws a RangeError past its string length
                // limit; refusing here keeps an absurd count from aborting
                // the process on allocation.
                Some(count)
                    if count >= 0
                        && (count as u64).saturating_mul(text.len() as u64) > MAX_REPEAT_BYTES =>
                {
                    return Err(EvalError::Argument(
                        "repeat would build too long a string".into(),
                    ));
                }
                Some(count) if count >= 0 => Value::String(text.repeat(count as usize)),
                _ => {
                    return Err(EvalError::Argument(
                        "repeat takes a non-negative count".into(),
                    ));
                }
            }
        }
        "reverse" => {
            arity(name, args, 0, 0)?;
            if text.chars().any(|c| c.len_utf16() == 2) {
                return Err(EvalError::Uncaptured("reverse:astral".into()));
            }
            Value::String(text.chars().rev().collect())
        }
        "slice" => {
            arity(name, args, 1, 2)?;
            let start = integer(name, values.first())?.unwrap_or(0);
            let end = integer(name, values.get(1))?;
            Value::String(utf16_slice(text, start, end))
        }
        "split" => {
            arity(name, args, 1, 2)?;
            let limit = integer(name, values.get(1))?.map(|n| n.max(0) as usize);
            let parts: Vec<String> = match &values[0] {
                Value::String(separator) if separator.is_empty() => text
                    .encode_utf16()
                    .map(|unit| String::from_utf16_lossy(&[unit]))
                    .collect(),
                Value::String(separator) => {
                    text.split(separator.as_str()).map(str::to_string).collect()
                }
                Value::Regexp(regexp) => {
                    if regexp.regex.captures_len() > 1 {
                        return Err(EvalError::Uncaptured("split:regexp_groups".into()));
                    }
                    regexp.regex.split(text).map(str::to_string).collect()
                }
                other => {
                    return Err(EvalError::Argument(format!(
                        "split takes a string or a regular expression, not {}",
                        other.type_name()
                    )));
                }
            };
            let kept = limit.map_or(parts.len(), |limit| limit.min(parts.len()));
            Value::List(parts.into_iter().take(kept).map(Value::String).collect())
        }
        "replace" => {
            arity(name, args, 2, 2)?;
            let with = match &values[1] {
                Value::String(with) => with.clone(),
                other => to_display_string(other)?,
            };
            match &values[0] {
                // A string pattern replaces every occurrence (the functions page).
                Value::String(pattern) => Value::String(text.replace(pattern.as_str(), &with)),
                // A regular expression replaces all only with the `g` flag.
                Value::Regexp(regexp) => {
                    let with = replacement(&with);
                    if regexp.flags.contains('g') {
                        Value::String(regexp.regex.replace_all(text, with.as_str()).into_owned())
                    } else {
                        Value::String(regexp.regex.replace(text, with.as_str()).into_owned())
                    }
                }
                other => {
                    return Err(EvalError::Argument(format!(
                        "replace takes a string or a regular expression, not {}",
                        other.type_name()
                    )));
                }
            }
        }
        _ => {
            return Err(EvalError::NoSuchMethod {
                target: "string",
                name: name.to_string(),
            });
        }
    })
}
