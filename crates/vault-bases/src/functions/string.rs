use crate::eval::coerce::to_display_string;
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::{RegexpValue, Value};

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

/// ECMA-262 `GetSubstitution`: expand a JavaScript replacement template for
/// one match at `found` (byte offsets into `text`) onto `out`.
///
/// **Provisional** (capture-settled): Obsidian runs JavaScript, so its rule
/// is the one used. `$$` is `$`; `$&` the match; `` $` `` and `$'` the text
/// before and after it; `$n` and `$nn` a group, two digits when that group
/// exists and otherwise one digit then a literal digit, an unmatched group
/// being empty and a group that does not exist (`$0` included) staying
/// literal; `$<name>` a named group, only when the pattern has named groups.
/// A string pattern has no groups, so only `$$`, `$&`, `` $` `` and `$'`
/// expand.
fn substitute(
    template: &str,
    text: &str,
    found: (usize, usize),
    caps: Option<&regex::Captures<'_>>,
    named: bool,
    out: &mut String,
) {
    let groups = caps.map_or(0, |caps| caps.len() - 1);
    let group = |index: usize| {
        caps.and_then(|caps| caps.get(index))
            .map_or("", |m| m.as_str())
    };
    let bytes = template.as_bytes();
    let mut at = 0;
    while at < template.len() {
        let Some(dollar) = template[at..].find('$') else {
            out.push_str(&template[at..]);
            break;
        };
        out.push_str(&template[at..at + dollar]);
        at += dollar;
        match bytes.get(at + 1).copied() {
            Some(b'$') => {
                out.push('$');
                at += 2;
            }
            Some(b'&') => {
                out.push_str(&text[found.0..found.1]);
                at += 2;
            }
            Some(b'`') => {
                out.push_str(&text[..found.0]);
                at += 2;
            }
            Some(b'\'') => {
                out.push_str(&text[found.1..]);
                at += 2;
            }
            Some(first) if first.is_ascii_digit() => {
                let mut digits = 1;
                let mut index = usize::from(first - b'0');
                if let Some(second) = bytes.get(at + 2).copied().filter(u8::is_ascii_digit) {
                    let two = index * 10 + usize::from(second - b'0');
                    if two <= groups {
                        digits = 2;
                        index = two;
                    }
                }
                if (1..=groups).contains(&index) {
                    out.push_str(group(index));
                } else {
                    out.push_str(&template[at..at + 1 + digits]);
                }
                at += 1 + digits;
            }
            Some(b'<') if named => match template[at + 2..].find('>') {
                None => {
                    out.push_str("$<");
                    at += 2;
                }
                Some(close) => {
                    let name = &template[at + 2..at + 2 + close];
                    out.push_str(
                        caps.and_then(|caps| caps.name(name))
                            .map_or("", |m| m.as_str()),
                    );
                    at += 2 + close + 1;
                }
            },
            _ => {
                out.push('$');
                at += 1;
            }
        }
    }
}

/// The byte offset one character past `at`, or past the end when `at` is
/// the end: where JavaScript's `AdvanceStringIndex` moves after an empty
/// match.
fn advance(text: &str, at: usize) -> usize {
    text[at..]
        .chars()
        .next()
        .map_or(at + 1, |c| at + c.len_utf8())
}

/// `String.prototype.replace` with a regular expression: the first match, or
/// with the `g` flag every match found the way `RegExp.prototype[@@replace]`
/// finds them — an empty match moves one character on, and an empty match
/// right after a non-empty one still counts (`"baaac"` with `/a*/g` has four
/// matches, where the `regex` crate's iterator finds three).
#[inline(never)]
fn replace_regexp(text: &str, regexp: &RegexpValue, template: &str) -> String {
    let global = regexp.flags.contains('g');
    let named = regexp.regex.capture_names().flatten().next().is_some();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at <= text.len() {
        let Some(caps) = regexp.regex.captures_at(text, at) else {
            break;
        };
        let whole = caps.get(0).expect("group 0 is the whole match");
        out.push_str(&text[copied..whole.start()]);
        substitute(
            template,
            text,
            (whole.start(), whole.end()),
            Some(&caps),
            named,
            &mut out,
        );
        copied = whole.end();
        if !global {
            break;
        }
        at = if whole.is_empty() {
            advance(text, whole.end())
        } else {
            whole.end()
        };
    }
    out.push_str(&text[copied..]);
    out
}

/// `String.prototype.split` with a regular expression, as ECMA-262's
/// `RegExp.prototype[@@split]` walks it: no split at an empty match where
/// the last piece ended, so `"abc".split(/x*/)` is `a, b, c` with no empty
/// ends (the `regex` crate's `split` answers `, a, b, c, `). Each group's
/// text follows the piece before its match, as in JavaScript (a group that
/// took no part is empty text). `limit` is already applied by the caller
/// when it is 0.
#[inline(never)]
fn split_regexp(text: &str, regex: &regex::Regex, limit: Option<usize>) -> Vec<String> {
    if text.is_empty() {
        return if regex.is_match(text) {
            Vec::new()
        } else {
            vec![String::new()]
        };
    }
    let mut parts = Vec::new();
    let mut piece = 0;
    let mut at = 0;
    while at < text.len() {
        let Some(groups) = regex.captures_at(text, at) else {
            break;
        };
        let found = groups.get(0).expect("group 0 is the whole match");
        if found.start() >= text.len() {
            break;
        }
        if found.end() == piece {
            at = advance(text, found.start());
            continue;
        }
        parts.push(text[piece..found.start()].to_string());
        if Some(parts.len()) == limit {
            return parts;
        }
        for group in groups.iter().skip(1) {
            parts.push(group.map_or_else(String::new, |group| group.as_str().to_string()));
            if Some(parts.len()) == limit {
                return parts;
            }
        }
        piece = found.end();
        at = piece;
    }
    parts.push(text[piece..].to_string());
    parts
}

/// JavaScript's `WhiteSpace` and `LineTerminator`, the set `trim` removes.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Title case, as captured: a word starts after whitespace only, its first
/// character upper case and the rest lower (`"hello-world"` is
/// `Hello-world`, `"hELLO"` is `Hello`).
#[inline(never)]
fn title(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous: Option<char> = None;
    for c in text.chars() {
        if previous.is_none_or(char::is_whitespace) {
            out.extend(c.to_uppercase());
        } else {
            out.extend(c.to_lowercase());
        }
        previous = Some(c);
    }
    out
}

/// Whether `text` holds `wanted`, letters compared without case.
fn contains_folded(text: &str, wanted: &str) -> bool {
    text.to_lowercase().contains(&wanted.to_lowercase())
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
        // Without case. Provisional: inferred from one corpus view; the
        // probes `t_contains_case` and `t_contains_any_case` in `generate`
        // settle it, and the fixture row `contains:case` tracks it.
        "contains" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(contains_folded(text, &strings(name, values)?[0]))
        }
        "containsAll" => {
            arity(name, args, 1, usize::MAX)?;
            Value::Boolean(
                strings(name, values)?
                    .iter()
                    .all(|wanted| contains_folded(text, wanted)),
            )
        }
        "containsAny" => {
            arity(name, args, 1, usize::MAX)?;
            Value::Boolean(
                strings(name, values)?
                    .iter()
                    .any(|wanted| contains_folded(text, wanted)),
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
            // JavaScript's set (captured: a leading U+FEFF is trimmed).
            arity(name, args, 0, 0)?;
            Value::String(text.trim_matches(is_js_whitespace).to_string())
        }
        "title" => {
            arity(name, args, 0, 0)?;
            Value::String(title(text))
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
            // By UTF-16 unit, as JavaScript reverses (captured: `"a🙂"` gives
            // the two halves of the emoji swapped, then `a`); a half that is
            // left alone is U+FFFD, the only way a Rust string can hold it.
            arity(name, args, 0, 0)?;
            let mut units: Vec<u16> = text.encode_utf16().collect();
            units.reverse();
            Value::String(String::from_utf16_lossy(&units))
        }
        "slice" => {
            arity(name, args, 1, 2)?;
            let start = integer(name, values.first())?.unwrap_or(0);
            let end = integer(name, values.get(1))?;
            Value::String(utf16_slice(text, start, end))
        }
        "split" => {
            arity(name, args, 1, 2)?;
            // Provisional (JavaScript's rule): an absent or negative limit
            // means no limit, and a limit of 0 gives an empty list.
            let limit = integer(name, values.get(1))?
                .filter(|n| *n >= 0)
                .map(|n| n as usize);
            if limit == Some(0) {
                return match &values[0] {
                    Value::String(_) | Value::Regexp(_) => Ok(Value::list(Vec::new())),
                    other => Err(EvalError::Argument(format!(
                        "split takes a string or a regular expression, not {}",
                        other.type_name()
                    ))),
                };
            }
            let parts: Vec<String> = match &values[0] {
                Value::String(separator) if separator.is_empty() => text
                    .encode_utf16()
                    .map(|unit| String::from_utf16_lossy(&[unit]))
                    .collect(),
                Value::String(separator) => {
                    text.split(separator.as_str()).map(str::to_string).collect()
                }
                // A group's text joins the pieces, as in JavaScript
                // (captured: `"a1b".split(/(\d)/)` is `a, 1, b`).
                Value::Regexp(regexp) => split_regexp(text, &regexp.regex, limit),
                other => {
                    return Err(EvalError::Argument(format!(
                        "split takes a string or a regular expression, not {}",
                        other.type_name()
                    )));
                }
            };
            let kept = limit.map_or(parts.len(), |limit| limit.min(parts.len()));
            Value::list(parts.into_iter().take(kept).map(Value::String).collect())
        }
        "replace" => {
            arity(name, args, 2, 2)?;
            let with = match &values[1] {
                Value::String(with) => with.clone(),
                other => to_display_string(other, ctx.clock),
            };
            match &values[0] {
                // A text pattern's replacement is literal (captured:
                // `"a.b".replace(".", "$&$&")` is `a$&$&b`).
                Value::String(pattern) => Value::String(text.replace(pattern.as_str(), &with)),
                // A regular expression replaces all only with the `g` flag.
                Value::Regexp(regexp) => Value::String(replace_regexp(text, regexp, &with)),
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
