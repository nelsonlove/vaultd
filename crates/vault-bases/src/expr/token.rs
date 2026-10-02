use super::ExpressionError;

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
        message: message.into(),
        position,
    }
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
        if c.is_ascii_digit() {
            let mut end = start;
            let mut seen_dot = false;
            let mut seen_exponent = false;
            while let Some(&(at, d)) = chars.peek() {
                if d.is_ascii_digit() {
                    end = at + 1;
                    chars.next();
                } else if d == '.' && !seen_dot && !seen_exponent {
                    // A dot continues the number only when a digit follows:
                    // `5.isEmpty()` is a method on 5, `2.5` is a decimal.
                    let next_is_digit = text[at + 1..]
                        .chars()
                        .next()
                        .is_some_and(|n| n.is_ascii_digit());
                    if !next_is_digit {
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
            while let Some((_, d)) = chars.next() {
                if d == c {
                    closed = true;
                    break;
                }
                if d == '\\' {
                    let Some((escape_at, escaped)) = chars.next() else {
                        break;
                    };
                    match escaped {
                        'n' => value.push('\n'),
                        't' => value.push('\t'),
                        'r' => value.push('\r'),
                        '0' => value.push('\0'),
                        'u' => {
                            let hex: String = (0..4)
                                .filter_map(|_| chars.next().map(|(_, h)| h))
                                .collect();
                            let code = u32::from_str_radix(&hex, 16)
                                .ok()
                                .and_then(char::from_u32)
                                .ok_or_else(|| error(escape_at, "malformed \\u escape"))?;
                            value.push(code);
                        }
                        other => value.push(other),
                    }
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
