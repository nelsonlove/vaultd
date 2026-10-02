use std::iter::Peekable;
use std::str::CharIndices;

use super::{ExpressionError, ExpressionErrorKind};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Token {
    Number(f64),
    String(String),
    Regexp { source: String, flags: String },
    Ident(String),
    Punct(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Spanned {
    pub token: Token,
    pub start: usize,
}

const PUNCTUATION: [&str; 23] = [
    "&&", "||", "==", "!=", "<=", ">=", "(", ")", "[", "]", "{", "}", ",", ".", ":", "!", "<", ">",
    "+", "-", "*", "/", "%",
];

fn error(position: usize, message: impl Into<String>) -> ExpressionError {
    ExpressionError {
        kind: ExpressionErrorKind::Syntax,
        message: message.into(),
        position,
    }
}

type Chars<'a> = Peekable<CharIndices<'a>>;

/// Exactly `count` hexadecimal digits, consumed; `None` (with nothing
/// consumed past the first non-digit) when fewer follow. `from_str_radix`
/// alone is not enough: it takes a leading `+`.
fn hex_digits(chars: &mut Chars<'_>, count: usize) -> Option<u32> {
    let mut code = 0;
    for _ in 0..count {
        let digit = chars.peek()?.1.to_digit(16)?;
        chars.next();
        code = code * 16 + digit;
    }
    Some(code)
}

/// The text of one `\u` escape after the `u`: `HHHH` or `{H…}`.
fn unicode_escape(chars: &mut Chars<'_>) -> Option<u32> {
    if chars.peek().map(|&(_, c)| c) != Some('{') {
        return hex_digits(chars, 4);
    }
    chars.next();
    let mut code: u32 = 0;
    let mut digits = 0;
    loop {
        let (_, c) = chars.next()?;
        if c == '}' {
            return (digits > 0).then_some(code);
        }
        code = code.checked_mul(16)?.checked_add(c.to_digit(16)?)?;
        if code > 0x10FFFF {
            return None;
        }
        digits += 1;
    }
}

/// One escape sequence after its backslash, read as JavaScript reads it:
/// `\n \t \r \b \f \v \0`, `\xHH`, `\uHHHH`, `\u{H…}` (a surrogate pair of
/// two `\uHHHH` combines), and any other character stands for itself.
/// Provisional (ruling N1, 2026-10-02): Task 13's capture settles it.
fn escape(chars: &mut Chars<'_>, backslash: usize, escaped: char) -> Result<char, ExpressionError> {
    let code = match escaped {
        'n' => return Ok('\n'),
        't' => return Ok('\t'),
        'r' => return Ok('\r'),
        'b' => return Ok('\u{8}'),
        'f' => return Ok('\u{c}'),
        'v' => return Ok('\u{b}'),
        '0' => return Ok('\0'),
        'x' => hex_digits(chars, 2).ok_or_else(|| error(backslash, "malformed \\x escape"))?,
        'u' => {
            let malformed = || error(backslash, "malformed \\u escape");
            let code = unicode_escape(chars).ok_or_else(malformed)?;
            if (0xD800..0xDC00).contains(&code) {
                // A high surrogate must be followed by `\u` and a low one.
                let mut ahead = chars.clone();
                let low = match (ahead.next(), ahead.next()) {
                    (Some((_, '\\')), Some((_, 'u'))) => hex_digits(&mut ahead, 4),
                    _ => None,
                };
                let Some(low) = low.filter(|low| (0xDC00..0xE000).contains(low)) else {
                    return Err(error(backslash, "lone surrogate in \\u escape"));
                };
                *chars = ahead;
                0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
            } else {
                code
            }
        }
        other => return Ok(other),
    };
    char::from_u32(code).ok_or_else(|| error(backslash, "lone surrogate in \\u escape"))
}

fn is_ident_start(c: char) -> bool {
    c == '_' || c == '$' || c.is_alphabetic()
}

fn is_ident_continue(c: char) -> bool {
    is_ident_start(c) || c.is_numeric()
}

/// Whether a `/` at this point starts a regular expression rather than
/// dividing. The JavaScript rule of thumb: after something that ends a value
/// (a name, a number, a string, a closing bracket) it divides; anywhere else
/// it opens a literal.
fn slash_starts_regexp(previous: Option<&Token>) -> bool {
    !matches!(
        previous,
        Some(Token::Number(_))
            | Some(Token::String(_))
            | Some(Token::Regexp { .. })
            | Some(Token::Ident(_))
            | Some(Token::Punct(")"))
            | Some(Token::Punct("]"))
            | Some(Token::Punct("}"))
    )
}

pub(crate) fn tokenize(text: &str) -> Result<Vec<Spanned>, ExpressionError> {
    let mut tokens: Vec<Spanned> = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some(&(start, c)) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        // `.5` is a number, as in JavaScript. Provisional (ruling N2,
        // 2026-10-02): Task 13's capture settles it.
        let leading_dot = c == '.'
            && text[start + 1..]
                .chars()
                .next()
                .is_some_and(|n| n.is_ascii_digit());
        if c.is_ascii_digit() || leading_dot {
            let mut end = start;
            let mut seen_dot = false;
            let mut seen_exponent = false;
            while let Some(&(at, d)) = chars.peek() {
                if d.is_ascii_digit() {
                    end = at + 1;
                    chars.next();
                } else if d == '.' && !seen_dot && !seen_exponent {
                    // A dot continues the number unless a name follows:
                    // `5.isEmpty()` is a method on 5, `2.5` is a decimal,
                    // and `1.` alone is 1, as in JavaScript (provisional,
                    // ruling N2).
                    let name_follows = text[at + 1..].chars().next().is_some_and(is_ident_start);
                    if name_follows {
                        break;
                    }
                    seen_dot = true;
                    end = at + 1;
                    chars.next();
                } else if (d == 'e' || d == 'E') && !seen_exponent {
                    let rest = &text[at + 1..];
                    let digits_follow = rest
                        .strip_prefix(['+', '-'])
                        .unwrap_or(rest)
                        .chars()
                        .next()
                        .is_some_and(|n| n.is_ascii_digit());
                    if !digits_follow {
                        break;
                    }
                    seen_exponent = true;
                    chars.next();
                    if let Some(&(sign_at, sign)) = chars.peek() {
                        if sign == '+' || sign == '-' {
                            chars.next();
                            end = sign_at + 1;
                        }
                    }
                    end = end.max(at + 1);
                } else {
                    break;
                }
            }
            let number: f64 = text[start..end]
                .parse()
                .map_err(|_| error(start, "malformed number"))?;
            tokens.push(Spanned {
                token: Token::Number(number),
                start,
            });
            continue;
        }
        if c == '"' || c == '\'' {
            chars.next();
            let mut value = String::new();
            let mut closed = false;
            while let Some((at, d)) = chars.next() {
                if d == c {
                    closed = true;
                    break;
                }
                if d == '\\' {
                    let Some((_, escaped)) = chars.next() else {
                        break;
                    };
                    value.push(escape(&mut chars, at, escaped)?);
                    continue;
                }
                value.push(d);
            }
            if !closed {
                return Err(error(start, "unterminated string"));
            }
            tokens.push(Spanned {
                token: Token::String(value),
                start,
            });
            continue;
        }
        if c == '/' && slash_starts_regexp(tokens.last().map(|spanned| &spanned.token)) {
            chars.next();
            let mut source = String::new();
            let mut in_class = false;
            let mut closed = false;
            while let Some((_, d)) = chars.next() {
                match d {
                    '\\' => {
                        source.push('\\');
                        if let Some((_, escaped)) = chars.next() {
                            source.push(escaped);
                        }
                    }
                    '[' => {
                        in_class = true;
                        source.push(d);
                    }
                    ']' => {
                        in_class = false;
                        source.push(d);
                    }
                    '/' if !in_class => {
                        closed = true;
                        break;
                    }
                    '\n' => break,
                    _ => source.push(d),
                }
            }
            if !closed {
                return Err(error(start, "unterminated regular expression"));
            }
            let mut flags = String::new();
            while let Some(&(_, f)) = chars.peek() {
                if f.is_ascii_alphabetic() {
                    flags.push(f);
                    chars.next();
                } else {
                    break;
                }
            }
            tokens.push(Spanned {
                token: Token::Regexp { source, flags },
                start,
            });
            continue;
        }
        if is_ident_start(c) {
            let mut end = start;
            while let Some(&(at, d)) = chars.peek() {
                if is_ident_continue(d) {
                    end = at + d.len_utf8();
                    chars.next();
                } else {
                    break;
                }
            }
            tokens.push(Spanned {
                token: Token::Ident(text[start..end].to_string()),
                start,
            });
            continue;
        }
        let rest = &text[start..];
        let Some(punct) = PUNCTUATION.iter().find(|p| rest.starts_with(**p)) else {
            return Err(error(start, format!("unexpected character {c:?}")));
        };
        for _ in 0..punct.chars().count() {
            chars.next();
        }
        tokens.push(Spanned {
            token: Token::Punct(punct),
            start,
        });
    }
    Ok(tokens)
}
