//! The matcher: needles, JavaScript-style case folding, byte spans into the
//! original text, and UTF-16 positions.
//!
//! A case-insensitive needle folds both sides the way JavaScript's
//! `toLowerCase` does (P3), through a map from each folded byte back to the
//! original character that produced it, so every span is a pair of character
//! boundaries of the original text, never of a folded copy.

use std::ops::Range;

/// One literal term, ready to find in a haystack.
#[derive(Debug)]
pub struct Needle {
    needle: String,
    folded: String,
    sensitive: bool,
}

impl Needle {
    /// A literal needle; `sensitive` false folds both sides.
    pub fn text(needle: &str, sensitive: bool) -> Needle {
        Needle {
            needle: needle.to_owned(),
            folded: fold_js(needle),
            sensitive,
        }
    }

    /// Every non-overlapping occurrence, as sorted byte spans into
    /// `haystack`. An empty needle answers no spans (P19).
    pub fn find_all(&self, haystack: &str) -> Vec<Range<usize>> {
        if self.needle.is_empty() {
            return Vec::new();
        }
        if !self.sensitive && haystack.is_ascii() {
            // Every ASCII character folds to one ASCII byte, so the map from
            // folded bytes to original bytes is the identity.
            return haystack
                .to_ascii_lowercase()
                .match_indices(self.folded.as_str())
                .map(|(at, m)| at..at + m.len())
                .collect();
        }
        self.find_all_reference(haystack)
    }

    pub fn is_match(&self, haystack: &str) -> bool {
        !self.find_all(haystack).is_empty()
    }

    /// The fold-and-map reference, for the fast-path property test.
    #[doc(hidden)]
    pub fn find_all_reference(&self, haystack: &str) -> Vec<Range<usize>> {
        if self.needle.is_empty() {
            return Vec::new();
        }
        if self.sensitive {
            return haystack
                .match_indices(self.needle.as_str())
                .map(|(at, m)| at..at + m.len())
                .collect();
        }
        let (folded, map) = fold_with_map(haystack);
        let mut spans: Vec<Range<usize>> = Vec::new();
        for (at, m) in folded.match_indices(self.folded.as_str()) {
            let start = map[at];
            let last = map[at + m.len() - 1];
            let end = last + haystack[last..].chars().next().map_or(0, char::len_utf8);
            match spans.last_mut() {
                Some(previous) if previous.end > start => previous.end = previous.end.max(end),
                _ => spans.push(start..end),
            }
        }
        spans
    }
}

/// JavaScript `toLowerCase` per character, with the final-sigma rule.
pub fn fold_js(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    fold_each(text, |_, piece| folded.push_str(piece));
    folded
}

/// The fold of `text` and, for each folded byte, the byte offset of the
/// original character that produced it.
fn fold_with_map(text: &str) -> (String, Vec<usize>) {
    let mut folded = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len());
    fold_each(text, |at, piece| {
        folded.push_str(piece);
        map.extend(std::iter::repeat_n(at, piece.len()));
    });
    (folded, map)
}

/// Calls `emit(at, fold)` for every character of `text`, where `at` is the
/// character's byte offset and `fold` its lowercase form. `Σ` becomes the
/// final `ς` when the previous character is alphabetic and the next one is
/// not (JavaScript's final-sigma context, approximated by `is_alphabetic`;
/// P3 lists it for capture), and `σ` otherwise.
fn fold_each(text: &str, mut emit: impl FnMut(usize, &str)) {
    let mut previous: Option<char> = None;
    let mut chars = text.char_indices().peekable();
    let mut buffer = [0u8; 4];
    while let Some((at, c)) = chars.next() {
        if c == '\u{3a3}' {
            let after_letter = previous.is_some_and(char::is_alphabetic);
            let before_letter = chars.peek().is_some_and(|&(_, next)| next.is_alphabetic());
            let sigma = if after_letter && !before_letter {
                '\u{3c2}'
            } else {
                '\u{3c3}'
            };
            emit(at, sigma.encode_utf8(&mut buffer));
        } else if c.is_ascii() {
            emit(at, c.to_ascii_lowercase().encode_utf8(&mut buffer));
        } else {
            let mut piece = String::new();
            piece.extend(c.to_lowercase());
            emit(at, &piece);
        }
        previous = Some(c);
    }
}

/// An Obsidian position: `line` zero-based, `col` and `offset` in UTF-16
/// units.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Loc {
    pub line: usize,
    pub col: usize,
    pub offset: usize,
}

/// Converts byte offsets in one text to `Loc`s.
pub struct LineIndex<'a> {
    text: &'a str,
    /// The byte offset of every line start; the first is 0.
    starts: Vec<usize>,
    /// The UTF-16 offset of the same starts.
    u16_starts: Vec<usize>,
}

impl<'a> LineIndex<'a> {
    pub fn new(text: &'a str) -> Self {
        let mut starts = vec![0];
        let mut u16_starts = vec![0];
        let mut units = 0;
        for (at, c) in text.char_indices() {
            units += c.len_utf16();
            if c == '\n' {
                starts.push(at + 1);
                u16_starts.push(units);
            }
        }
        LineIndex {
            text,
            starts,
            u16_starts,
        }
    }

    /// The position of `byte`. Panics when `byte` is not a character
    /// boundary of the text, which is a caller bug.
    pub fn loc(&self, byte: usize) -> Loc {
        let line = self.line_of(byte);
        let start = self.starts[line];
        let col = utf16_len(&self.text[start..byte]);
        Loc {
            line,
            col,
            offset: self.u16_starts[line] + col,
        }
    }

    /// The byte range of the line holding `byte`, without its line break.
    pub fn line_range(&self, byte: usize) -> Range<usize> {
        let start = self.starts[self.line_of(byte)];
        match self.text[start..].find('\n') {
            Some(at) => {
                let end = start + at;
                let end = if self.text[start..end].ends_with('\r') {
                    end - 1
                } else {
                    end
                };
                start..end
            }
            None => start..self.text.len(),
        }
    }

    fn line_of(&self, byte: usize) -> usize {
        assert!(
            self.text.is_char_boundary(byte),
            "byte offset {byte} is not a character boundary of a {}-byte text",
            self.text.len()
        );
        self.starts.partition_point(|&start| start <= byte) - 1
    }
}

/// The length of `text` in UTF-16 units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}
