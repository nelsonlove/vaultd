//! The value semantics every operator and function leans on.
//!
//! The functions page says "Bases functions follow JavaScript behavior";
//! where it and Obsidian differ, Obsidian wins: every rule here was settled
//! by the Task 13 runtime captures (Obsidian 1.13.7, the `Captures/`
//! bases), and the comment on each rule names what was seen.

use std::cmp::Ordering;

use crate::clock::Clock;
use crate::collate::collate;
use crate::dates::{humanize, parse_date_text};
use crate::value::{LinkValue, Value};

/// Truthiness: `null`, `false`, `0`, `NaN`, `""`, an empty list and an
/// empty object are false; everything else is true. Captured: `[].isTruthy()`
/// and `![]` say an empty list is false, and an empty frontmatter mapping's
/// `isTruthy()` is false — JavaScript would call both true.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Boolean(flag) => *flag,
        Value::Number(number) => *number != 0.0 && !number.is_nan(),
        Value::String(text) => !text.is_empty(),
        Value::List(items) => !items.is_empty(),
        Value::Object(entries) => !entries.is_empty(),
        _ => true,
    }
}

/// A link's target as written, without wikilink brackets.
fn link_target(link: &LinkValue) -> &str {
    link.target
        .strip_prefix("[[")
        .and_then(|inner| inner.strip_suffix("]]"))
        .unwrap_or(&link.target)
}

/// The syntax page: links "are equivalent as long as they point to the same
/// file, or if the file does not exist when looked up, their link text must be
/// identical." Link text is compared only when *neither* link resolves.
fn link_equals(left: &LinkValue, right: &LinkValue) -> bool {
    match (&left.resolved, &right.resolved) {
        (Some(a), Some(b)) => a == b,
        (None, None) => left.target == right.target,
        _ => false,
    }
}

/// JavaScript's `StringToNumber`, total: `""` is 0, text that is not a
/// number is NaN, and `Infinity` reads (captured: `number("Infinity")` is
/// `Infinity`).
pub fn js_to_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_space);
    match trimmed {
        "" => 0.0,
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => parse_js_number(trimmed).unwrap_or(f64::NAN),
    }
}

/// JavaScript's `WhiteSpace` and `LineTerminator` (what `trim` removes).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `==`, as captured: values of one kind compare by value (lists item by
/// item, `[1, 2] == [2, 1]` false); a number, a boolean or numeric text
/// compare as numbers (`5 == "5"`, `true == 1`, `[1] == ["1"]`); a date
/// equals text naming the same instant (`date("2025-01-01") ==
/// "2025-01-01"`); a link equals its target text or the file it resolves to,
/// and a file equals its path (`link("Other") == "Other"`, `file("Other.md")
/// == "Other.md"`); `null` equals only `null`. Every other pairing is
/// `false`, never an error.
pub fn loose_equals(left: &Value, right: &Value, clock: &Clock) -> bool {
    use Value::*;
    match (left, right) {
        (Null, Null) => true,
        (Null, _) | (_, Null) => false,
        (Number(a), Number(b)) => a == b,
        (String(a), String(b)) => a == b,
        (Boolean(a), Boolean(b)) => a == b,
        (Number(n), String(s)) | (String(s), Number(n)) => js_to_number(s) == *n,
        (Boolean(b), Number(n)) | (Number(n), Boolean(b)) => f64::from(u8::from(*b)) == *n,
        (Boolean(b), String(s)) | (String(s), Boolean(b)) => {
            js_to_number(s) == f64::from(u8::from(*b))
        }
        (Date(a), Date(b)) => a.epoch_ms == b.epoch_ms,
        (Date(date), String(text)) | (String(text), Date(date)) => {
            parse_date_text(text, clock).is_some_and(|parsed| parsed.epoch_ms == date.epoch_ms)
        }
        (Duration(a), Duration(b)) => a.months == b.months && a.ms == b.ms,
        (Link(a), Link(b)) => link_equals(a, b),
        (Link(link), File(path)) | (File(path), Link(link)) => link.resolved.as_ref() == Some(path),
        (Link(link), String(text)) | (String(text), Link(link)) => {
            link_target(link) == text
                || link
                    .resolved
                    .as_ref()
                    .is_some_and(|path| path.as_str() == text)
        }
        (File(path), String(text)) | (String(text), File(path)) => path.as_str() == text,
        (File(a), File(b)) => a == b,
        (List(a), List(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b.iter())
                    .all(|(x, y)| loose_equals(x, y, clock))
        }
        (Object(a), Object(b)) => {
            a.len() == b.len()
                && a.iter().all(|(key, value)| {
                    b.iter()
                        .find(|(other, _)| other == key)
                        .is_some_and(|(_, other)| loose_equals(value, other, clock))
                })
        }
        (Image(a), Image(b)) | (Icon(a), Icon(b)) | (Html(a), Html(b)) => a == b,
        (Regexp(a), Regexp(b)) => a == b,
        // A list against text, a number or a boolean compares as its items'
        // texts joined by commas, as JavaScript's `==` does (seen in a corpus
        // view: `type == "Some/Type"` holds for `type: [Some/Type]`).
        (List(items), other @ (String(_) | Number(_) | Boolean(_)))
        | (other @ (String(_) | Number(_) | Boolean(_)), List(items)) => {
            let text = items
                .iter()
                .map(|item| match item {
                    Null => std::string::String::new(),
                    item => to_display_string(item, clock),
                })
                .collect::<Vec<_>>()
                .join(",");
            loose_equals(&String(text), other, clock)
        }
        _ => false,
    }
}

/// JavaScript compares strings by UTF-16 code unit, which is why `"Z" < "a"`
/// and, captured, `"10" < "9"`.
fn utf16_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// A duration's length for comparison: months at the Gregorian average.
fn duration_ms(months: i64, ms: i64) -> f64 {
    months as f64 * 30.436_875 * 86_400_000.0 + ms as f64
}

/// `<`, `<=`, `>`, `>=` between two values that are not `null` (a
/// comparison with `null` is an empty cell, captured: `missing < 1`).
/// `None` means every one of the four is false. As captured: numbers,
/// booleans and numeric text compare as numbers (`1 < "2"`, `false <
/// true`); two strings by UTF-16 code unit (`"10" < "9"`); a date against a
/// date or text naming one by instant (`date("2025-01-01") <
/// "2025-01-02"`); two lists by their text (`[1] < [2]`).
pub fn compare(left: &Value, right: &Value, clock: &Clock) -> Option<Ordering> {
    use Value::*;
    let number = |value: &Value| match value {
        Number(n) => Some(*n),
        Boolean(b) => Some(f64::from(u8::from(*b))),
        String(s) => Some(js_to_number(s)),
        _ => None,
    };
    match (left, right) {
        (String(a), String(b)) => Some(utf16_order(a, b)),
        (Number(_) | Boolean(_) | String(_), Number(_) | Boolean(_) | String(_)) => {
            number(left)?.partial_cmp(&number(right)?)
        }
        (Date(a), Date(b)) => Some(a.epoch_ms.cmp(&b.epoch_ms)),
        (Date(date), String(text)) => {
            parse_date_text(text, clock).map(|parsed| date.epoch_ms.cmp(&parsed.epoch_ms))
        }
        (String(text), Date(date)) => {
            parse_date_text(text, clock).map(|parsed| parsed.epoch_ms.cmp(&date.epoch_ms))
        }
        (Duration(a), Duration(b)) => {
            duration_ms(a.months, a.ms).partial_cmp(&duration_ms(b.months, b.ms))
        }
        // A duration against a number is its milliseconds (captured:
        // `(now() - today()) > 1000`).
        (Duration(d), Number(n)) => duration_ms(d.months, d.ms).partial_cmp(n),
        (Number(n), Duration(d)) => n.partial_cmp(&duration_ms(d.months, d.ms)),
        (List(_), List(_)) => Some(utf16_order(
            &to_display_string(left, clock),
            &to_display_string(right, clock),
        )),
        _ => None,
    }
}

/// The comparator a view's `sort` applies to two values, ascending, and the
/// order `list.sort()`, `unique()` and the date summaries use: a total order
/// by ruling R2 (2026-10-09; the project
/// picked a total order). Values first order by kind: booleans (`false`
/// before `true`), then numbers by value, then dates by instant, then every
/// other value by the collation of its text ([`crate::collate`]), and `null`
/// last.
///
/// Within the captured cases that do not mix kinds it gives Obsidian's
/// answer (the pairwise probes under `Captures/pairs/`: two numbers by
/// value, two dates by instant, texts by collation, `5` before `"abc"`).
/// Obsidian's own comparator is not transitive where a boolean meets another
/// kind (`true` ties with both `5` and `"abc"`, which do not tie), and a
/// number against text compares there by text (`-10 < -5`, `-5 < "-7"`,
/// `"-7" < -10`); a kind rank orders both, so the sort is O(n log n) and
/// `slice::sort_by` never meets a comparator that is not total (it may panic
/// on one since Rust 1.81). Numbers order numerically, with every NaN after
/// every other number and equal to any other NaN, and `-0` equal to `0`.
pub fn sort_compare(left: &Value, right: &Value, clock: &Clock) -> Ordering {
    let rank = |value: &Value| match value {
        Value::Boolean(_) => 0,
        Value::Number(_) => 1,
        Value::Date(_) => 2,
        Value::Null => 4,
        _ => 3,
    };
    rank(left)
        .cmp(&rank(right))
        .then_with(|| match (left, right) {
            (Value::Boolean(a), Value::Boolean(b)) => a.cmp(b),
            (Value::Number(a), Value::Number(b)) => number_order(*a, *b),
            (Value::Date(a), Value::Date(b)) => a.epoch_ms.cmp(&b.epoch_ms),
            (Value::Null, Value::Null) => Ordering::Equal,
            _ => collate(
                &to_display_string(left, clock),
                &to_display_string(right, clock),
            ),
        })
}

/// [`sort_compare`] where no view's clock is at hand (`list.sort()`,
/// `unique()`, the date summaries): a date's text, the only clock-dependent
/// one, is read in UTC.
pub fn sort_order(left: &Value, right: &Value) -> Ordering {
    sort_compare(left, right, &Clock::fixed(0, "UTC"))
}

/// Numbers for sorting: NaN last and equal to NaN, the rest by value.
fn number_order(left: f64, right: f64) -> Ordering {
    match (left.is_nan(), right.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => left
            .partial_cmp(&right)
            .expect("two numbers that are not NaN are ordered"),
    }
}

/// ECMAScript `Number::toString` (ECMA-262 §6.1.6.1.20), over Rust's shortest
/// round-trip digits, which are the digits that algorithm specifies.
///
/// Total: NaN is `NaN` and the infinities are `Infinity` and `-Infinity`, as
/// in JavaScript and as a cell shows them (captured).
pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
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

/// JavaScript's `StringToNumber` grammar for non-empty numeric text, minus
/// `Infinity` (see [`js_to_number`] for the total form).
///
/// Known corners that still differ from JavaScript: `0b…` and `0o…` are
/// refused (JavaScript: binary and octal), and a hex string over 64 bits is
/// refused (JavaScript: a rounded number).
pub fn parse_js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim_matches(is_js_space);
    if trimmed.is_empty() {
        return None;
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
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

/// A value's text, as `toString()`, concatenation and a cell show it
/// (captured, Task 13): `null` is `null`; a number is JavaScript's text; a
/// date is `YYYY-MM-DDTHH:mm:ss` in the clock's zone, or `YYYY-MM-DD`
/// without a time; a duration is Moment's `humanize` (`a day`); a list is
/// its items' texts joined by `", "` (nested lists flatten: `[1, [2, 3]]` is
/// `1, 2, 3`); an object is JSON whose values are their items' texts; a
/// link is `[[target]]` or `[[target|display]]`, a URL link its URL; a file
/// is its path; an image is `![](url)`.
pub fn to_display_string(value: &Value, clock: &Clock) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(text) => text.clone(),
        Value::Number(number) => number_to_string(*number),
        Value::Boolean(flag) => flag.to_string(),
        Value::Date(date) => {
            let zoned = crate::dates::zoned(*date, clock);
            if date.has_time {
                zoned.strftime("%Y-%m-%dT%H:%M:%S").to_string()
            } else {
                zoned.strftime("%Y-%m-%d").to_string()
            }
        }
        Value::Duration(duration) => humanize(*duration),
        Value::List(items) => items
            .iter()
            .map(|item| to_display_string(item, clock))
            .collect::<Vec<_>>()
            .join(", "),
        // Written by hand to keep the entries' order (a `serde_json::Map`
        // sorts its keys in this workspace).
        Value::Object(entries) => {
            let body: Vec<String> = entries
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        json_string(key),
                        json_string(&to_display_string(value, clock))
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Link(link) => {
            let target = link_target(link);
            if crate::functions::is_url(target) {
                return target.to_string();
            }
            // An empty display shows no display (seen in a corpus view:
            // `file.asLink(x)` for a note with no `x`).
            match link.display.as_deref() {
                Some(Value::Null) | None => format!("[[{target}]]"),
                Some(display) => format!("[[{target}|{}]]", to_display_string(display, clock)),
            }
        }
        Value::File(path) => path.as_str().to_string(),
        Value::Regexp(regexp) => format!("/{}/{}", regexp.source, regexp.flags),
        Value::Image(url) => format!("![]({url})"),
        Value::Icon(text) | Value::Html(text) => text.clone(),
    }
}

/// `text` as a JSON string literal.
fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
