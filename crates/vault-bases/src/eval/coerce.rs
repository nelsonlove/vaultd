//! The value semantics every operator and function leans on.
//!
//! The functions page says "Bases functions follow JavaScript behavior", so
//! where a JavaScript rule answers the question (truthiness of primitives,
//! number-to-string, string concatenation, UTF-16 string comparison) it is
//! followed and cited. Where no published rule answers it (`5 == "5"`, the
//! order of a number against a string) the answer is
//! [`EvalError::Uncaptured`] naming the case, until a runtime capture fixes
//! it (Task 13 of the implementation plan).

use std::cmp::Ordering;

use crate::eval::EvalError;
use crate::value::{LinkValue, Value};

/// JavaScript truthiness: `null`, `false`, `0`, `NaN` and `""` are falsy;
/// every other primitive is truthy, and every object (a list, an object, a
/// date, a link, a file) is truthy.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Boolean(flag) => *flag,
        Value::Number(number) => *number != 0.0 && !number.is_nan(),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn case(prefix: &str, left: &Value, right: &Value) -> EvalError {
    let (a, b) = if left.type_name() <= right.type_name() {
        (left.type_name(), right.type_name())
    } else {
        (right.type_name(), left.type_name())
    };
    EvalError::Uncaptured(format!("{prefix}:{a}:{b}"))
}

/// The syntax page: links "are equivalent as long as they point to the same
/// file, or if the file does not exist when looked up, their link text must be
/// identical."
fn link_equals(left: &LinkValue, right: &LinkValue) -> bool {
    match (&left.resolved, &right.resolved) {
        (Some(a), Some(b)) => a == b,
        _ => left.target == right.target,
    }
}

/// `==`. Same-type values compare by value; `null` equals only `null` (the
/// published `reduce` example relies on `acc == null` being true for the
/// initial `null` and false for a number); a link equals a file it resolves to
/// (the syntax page: `author == this`). Every other pairing is uncaptured.
pub fn loose_equals(left: &Value, right: &Value) -> Result<bool, EvalError> {
    use Value::*;
    Ok(match (left, right) {
        (Null, Null) => true,
        (Null, _) | (_, Null) => false,
        (Number(a), Number(b)) => a == b,
        (String(a), String(b)) => a == b,
        (Boolean(a), Boolean(b)) => a == b,
        (Date(a), Date(b)) => a.epoch_ms == b.epoch_ms,
        (Duration(a), Duration(b)) => a == b,
        (Link(a), Link(b)) => link_equals(a, b),
        (Link(link), File(path)) | (File(path), Link(link)) => link.resolved.as_ref() == Some(path),
        (File(a), File(b)) => a == b,
        (Image(a), Image(b)) | (Icon(a), Icon(b)) | (Html(a), Html(b)) => a == b,
        (Regexp(a), Regexp(b)) => a == b,
        // `case` sorts the two kind names, so `5 == "5"` and `"5" == 5` are
        // both `eq:number:string`.
        _ => return Err(case("eq", left, right)),
    })
}

/// JavaScript compares strings by UTF-16 code unit, which is why `"Z" < "a"`.
fn utf16_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `<`, `<=`, `>`, `>=`: numbers, strings, dates, durations without months,
/// and booleans (`false < true`). Every other pairing is uncaptured.
pub fn compare(left: &Value, right: &Value) -> Result<Ordering, EvalError> {
    use Value::*;
    match (left, right) {
        (Number(a), Number(b)) => a
            .partial_cmp(b)
            .ok_or_else(|| EvalError::Type("cannot compare NaN".into())),
        (String(a), String(b)) => Ok(utf16_order(a, b)),
        (Date(a), Date(b)) => Ok(a.epoch_ms.cmp(&b.epoch_ms)),
        (Duration(a), Duration(b)) if a.months == 0 && b.months == 0 => Ok(a.ms.cmp(&b.ms)),
        (Boolean(a), Boolean(b)) => Ok(a.cmp(b)),
        _ => Err(EvalError::Uncaptured("cmp:mixed".into())),
    }
}

/// The provisional order of value kinds when a sort meets two different
/// kinds. **Not evidence**: it exists so `sort` is total and deterministic
/// (the spec's property tests demand transitivity) until the `sort:mixed`
/// capture fixes Obsidian's real order; `null` is last because an empty cell
/// sorting after every value is the one placement the views page implies
/// ("sort … by any property"). Task 13 replaces this table.
pub const MIXED_TYPE_RANK: [&str; 14] = [
    "number", "date", "string", "boolean", "duration", "link", "file", "list", "object", "regexp",
    "image", "icon", "html", "null",
];

fn rank(value: &Value) -> usize {
    MIXED_TYPE_RANK
        .iter()
        .position(|name| *name == value.type_name())
        .expect("every type name is ranked")
}

/// A total order for `sort`: same-kind values by [`compare`] (falling back to
/// equal where that is uncaptured, so a stable sort keeps their input order),
/// different kinds by [`MIXED_TYPE_RANK`].
pub fn sort_order(left: &Value, right: &Value) -> Ordering {
    let by_rank = rank(left).cmp(&rank(right));
    if by_rank != Ordering::Equal {
        return by_rank;
    }
    match (left, right) {
        (Value::Link(a), Value::Link(b)) => utf16_order(&a.target, &b.target),
        (Value::File(a), Value::File(b)) => utf16_order(a.as_str(), b.as_str()),
        (Value::Duration(a), Value::Duration(b)) => (a.months, a.ms).cmp(&(b.months, b.ms)),
        _ => compare(left, right).unwrap_or(Ordering::Equal),
    }
}

/// ECMAScript `Number::toString` (ECMA-262 §6.1.6.1.20), over Rust's shortest
/// round-trip digits, which are the digits that algorithm specifies.
pub fn number_to_string(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("LowerExp always writes an exponent");
    let exponent: i32 = exponent.parse().expect("an integer exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    if value < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// JavaScript's `StringToNumber` grammar, minus `Infinity` (a cell cannot
/// hold a non-finite number) and minus the empty string (JavaScript says 0;
/// whether Bases does is the uncaptured `number:empty_string`).
pub fn parse_js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return u64::from_str_radix(hex, 16).ok().map(|value| value as f64);
    }
    let unsigned = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let mantissa_ok = {
        let mut parts = mantissa.splitn(2, '.');
        let whole = parts.next().unwrap_or_default();
        let fraction = parts.next();
        whole.chars().all(|c| c.is_ascii_digit())
            && fraction.is_none_or(|f| f.chars().all(|c| c.is_ascii_digit()))
            && !(whole.is_empty() && fraction.is_none_or(str::is_empty))
    };
    let exponent_ok = exponent.is_none_or(|e| {
        let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
        !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
    });
    if !mantissa_ok || !exponent_ok {
        return None;
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

/// JavaScript `ToString`, for concatenation and `toString()`, on the kinds
/// where that is the published rule. Dates, links, files, objects and null
/// are uncaptured: JavaScript's answers there (`"[object Object]"`, a long
/// `Date` string) are not what a Bases cell shows.
pub fn to_display_string(value: &Value) -> Result<String, EvalError> {
    Ok(match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number_to_string(*number),
        Value::Boolean(flag) => flag.to_string(),
        Value::List(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => Ok(String::new()),
                other => to_display_string(other),
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(","),
        Value::Icon(name) | Value::Image(name) | Value::Html(name) => name.clone(),
        Value::Regexp(regexp) => format!("/{}/{}", regexp.source, regexp.flags),
        other => {
            return Err(EvalError::Uncaptured(format!(
                "tostring:{}",
                other.type_name()
            )));
        }
    })
}

/// Equality without coercion, for `contains`, `containsAll`, `containsAny`
/// and `unique`. JavaScript's `Array.prototype.includes` uses SameValueZero,
/// so a number never equals a string there; pairings `==` leaves uncaptured
/// are simply unequal here. A link still equals the file it resolves to (the
/// syntax page: `authors.contains(this)`).
pub fn strict_equals(left: &Value, right: &Value) -> bool {
    loose_equals(left, right).unwrap_or(false)
}
