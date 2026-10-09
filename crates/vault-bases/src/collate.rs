//! Text order for `sort`: an approximation of the collation Obsidian sorts
//! with (`localeCompare` with numeric ordering, locale `en`), as the
//! Task 13 captures show it: case does not separate words (`abc` before
//! `Zed`), a run of digits orders by its number (`5` before `10`), and
//! punctuation sorts before digits, digits before letters.
//!
//! The levels are ICU's: first the base characters (letters without case
//! or accent, digit runs by value, punctuation by the CLDR root order),
//! then accents, then case (lower before upper), and last the code points,
//! so two different strings are never equal. Characters outside Latin are
//! ordered by code point after the Latin letters — exact enough for the
//! names and titles a base sorts, not a full Unicode collation.

use std::cmp::Ordering;

/// The CLDR root order of ASCII whitespace, punctuation and symbols, all of
/// which sort before digits.
const PUNCTUATION: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum Primary {
    /// Whitespace, punctuation and symbols, by [`PUNCTUATION`] position,
    /// then other non-letters by code point.
    Symbol(u32),
    /// A run of digits, by value: its significant digits' count, then them.
    Number(usize, Vec<u8>),
    /// A letter folded to lower case without its accent.
    Letter(u32),
    /// Any other character, by code point.
    Other(u32),
}

/// A Latin letter with an accent, as its base letter (lower case), for the
/// letters Latin-1 and Latin Extended-A hold.
fn base_letter(c: char) -> Option<char> {
    let lower = c.to_lowercase().next().unwrap_or(c);
    Some(match lower {
        'à'..='å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è'..='ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' | 'ħ' => 'h',
        'ì'..='ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò'..='ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ţ' | 'ť' | 'ŧ' => 't',
        'ù'..='ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        other if other.is_ascii_lowercase() => other,
        _ => return None,
    })
}

/// Characters a collation passes over: the zero-width and format
/// characters, the soft hyphen, and the variation selectors.
fn is_ignorable(c: char) -> bool {
    matches!(
        c,
        '\u{ad}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{feff}'
            | '\u{fe00}'..='\u{fe0f}'
            | '\u{e0000}'..='\u{e007f}'
    )
}

/// One collation element: its primary weight, whether it carried an accent,
/// and whether it was upper case.
struct Element {
    primary: Primary,
    accent: bool,
    upper: bool,
}

fn elements(text: &str) -> Vec<Element> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            let mut digits = vec![c as u8 - b'0'];
            while let Some(&next) = chars.peek() {
                if !next.is_ascii_digit() {
                    break;
                }
                digits.push(next as u8 - b'0');
                chars.next();
            }
            let first = digits.iter().position(|d| *d != 0).unwrap_or(digits.len());
            let significant = digits[first..].to_vec();
            out.push(Element {
                primary: Primary::Number(significant.len(), significant),
                accent: false,
                upper: false,
            });
            continue;
        }
        if is_ignorable(c) {
            continue;
        }
        let element = if let Some(at) = PUNCTUATION.find(c) {
            Element {
                primary: Primary::Symbol(at as u32),
                accent: false,
                upper: false,
            }
        } else if let Some(base) = base_letter(c) {
            Element {
                primary: Primary::Letter(base as u32),
                accent: !c.is_ascii(),
                upper: c.is_uppercase(),
            }
        } else if c.is_whitespace() {
            Element {
                primary: Primary::Symbol(PUNCTUATION.find(' ').unwrap_or(0) as u32),
                accent: false,
                upper: false,
            }
        } else if !c.is_alphanumeric() {
            // Punctuation and symbols outside ASCII (dashes, emoji) sort with
            // the ASCII ones, before digits, by code point among themselves.
            Element {
                primary: Primary::Symbol(PUNCTUATION.len() as u32 + c as u32),
                accent: false,
                upper: false,
            }
        } else if c.is_alphabetic() {
            let lower = c.to_lowercase().next().unwrap_or(c);
            Element {
                primary: Primary::Other(lower as u32),
                accent: false,
                upper: c != lower,
            }
        } else {
            Element {
                primary: Primary::Other(c as u32),
                accent: false,
                upper: false,
            }
        };
        out.push(element);
    }
    out
}

/// Compare two strings as `sort` does: base letters only, so strings that
/// differ only in case or accents are equal and a stable sort keeps them in
/// the order they came (seen in a corpus view, Task 13: two notes whose
/// names differ only in case stay in path order).
pub fn collate(left: &str, right: &str) -> Ordering {
    let (a, b) = (elements(left), elements(right));
    a.iter()
        .map(|element| &element.primary)
        .cmp(b.iter().map(|element| &element.primary))
}

/// [`collate`], then case and accents (lower case and plain letters first),
/// then code points: a total order in which only equal strings tie, for
/// orders that must not depend on input order (a view's path order).
pub fn collate_strictly(left: &str, right: &str) -> Ordering {
    let (a, b) = (elements(left), elements(right));
    collate(left, right)
        .then_with(|| {
            a.iter()
                .map(|element| element.accent)
                .cmp(b.iter().map(|element| element.accent))
        })
        .then_with(|| {
            a.iter()
                .map(|element| element.upper)
                .cmp(b.iter().map(|element| element.upper))
        })
        .then_with(|| left.cmp(right))
}

#[cfg(test)]
mod tests {
    use super::collate;
    use std::cmp::Ordering::*;

    #[test]
    fn case_digits_and_punctuation_order_as_captured() {
        assert_eq!(collate("abc", "Zed"), Less);
        assert_eq!(collate("5", "10"), Less);
        assert_eq!(collate("2", "2025-01-01"), Less);
        assert_eq!(collate("2025-01-01", "abc"), Less);
        assert_eq!(collate("{\"k\":\"1\"}", "2"), Less);
        assert_eq!(collate("", "a"), Less);
        assert_eq!(collate("b, a", "Zed"), Less);
        assert_eq!(collate("a", "A"), Equal);
        assert_eq!(collate("é", "f"), Less);
        assert_eq!(collate("e", "é"), Equal);
        assert_eq!(collate("a\u{200b}b", "ab"), Equal);
        assert_eq!(super::collate_strictly("a", "A"), Less);
        assert_eq!(super::collate_strictly("e", "é"), Less);
        assert_eq!(collate("x2", "x10"), Less);
        assert_eq!(collate("same", "same"), Equal);
    }
}
