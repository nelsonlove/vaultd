//! A scannerless recursive-descent parser over `Vec<char>`, so every
//! position is a character offset into the query string.

use crate::query::{Node, Pattern, PropertyValueQuery, Query, QueryError, Scope, Term};

pub const MAX_DEPTH: usize = 64;

const OPERATORS: [&str; 12] = [
    "file",
    "path",
    "content",
    "tag",
    "line",
    "block",
    "section",
    "task",
    "task-todo",
    "task-done",
    "match-case",
    "ignore-case",
];

/// Where a sub-expression stops, beyond whitespace and parentheses.
#[derive(Clone, Copy, PartialEq)]
enum Within {
    /// Outside `[…]`, at the top level or in a group: operators and
    /// properties are recognized, and `]` and `:` are word characters.
    Plain,
    /// A property's name: `]` and `:` end a word and the expression.
    PropertyName,
    /// A property's value: `]` ends a word and the expression.
    PropertyValue,
    /// A group anywhere inside `[…]`: still no operator or property, and
    /// `]` ends a word, but `:` is a word character.
    PropertyGroup,
}

impl Within {
    fn in_property(self) -> bool {
        matches!(
            self,
            Within::PropertyName | Within::PropertyValue | Within::PropertyGroup
        )
    }

    /// The context inside a group opened here.
    fn group(self) -> Within {
        if self.in_property() {
            Within::PropertyGroup
        } else {
            Within::Plain
        }
    }
}

struct Parser {
    chars: Vec<char>,
    at: usize,
    depth: usize,
}

pub fn parse_query(text: &str) -> Result<Query, QueryError> {
    let mut p = Parser {
        chars: text.chars().collect(),
        at: 0,
        depth: 0,
    };
    p.skip_ws();
    if p.done() {
        return Ok(Query { root: None });
    }
    let root = p.or_expr(Within::Plain)?;
    p.skip_ws();
    if !p.done() {
        return Err(p.error(p.at, "unmatched `)`"));
    }
    Ok(Query { root: Some(root) })
}

impl Parser {
    fn done(&self) -> bool {
        self.at >= self.chars.len()
    }
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }
    fn skip_ws(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.at += 1;
        }
    }
    fn error(&self, position: usize, message: &str) -> QueryError {
        QueryError {
            message: message.to_string(),
            position,
        }
    }

    /// Does a word end before `chars[at]`?
    fn ends_word(&self, at: usize, within: Within) -> bool {
        match self.chars.get(at) {
            None => true,
            Some(c) if c.is_whitespace() || *c == '(' || *c == ')' => true,
            Some(']') => within.in_property(),
            Some(':') => within == Within::PropertyName,
            Some(_) => false,
        }
    }

    /// Does the current expression end here?
    fn stops(&self, within: Within) -> bool {
        match self.peek() {
            None | Some(')') => true,
            Some(']') => within.in_property(),
            Some(':') => within == Within::PropertyName,
            Some(_) => false,
        }
    }

    fn at_or(&self, within: Within) -> bool {
        self.chars.get(self.at) == Some(&'O')
            && self.chars.get(self.at + 1) == Some(&'R')
            && self.ends_word(self.at + 2, within)
    }

    fn deeper(&mut self, opener: usize) -> Result<(), QueryError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.error(opener, "the query nests more than 64 levels deep"));
        }
        Ok(())
    }

    fn or_expr(&mut self, within: Within) -> Result<Node, QueryError> {
        let mut items = vec![self.and_expr(within)?];
        loop {
            self.skip_ws();
            if !self.at_or(within) {
                break;
            }
            let or_at = self.at;
            self.at += 2;
            self.skip_ws();
            if self.stops(within) || self.at_or(within) {
                return Err(self.error(or_at, "`OR` needs a term after it"));
            }
            items.push(self.and_expr(within)?);
        }
        Ok(if items.len() == 1 {
            items.pop().expect("one item")
        } else {
            Node::Or(items)
        })
    }

    fn and_expr(&mut self, within: Within) -> Result<Node, QueryError> {
        let mut items = Vec::new();
        loop {
            self.skip_ws();
            if self.stops(within) || self.at_or(within) {
                break;
            }
            items.push(self.unary(within)?);
        }
        match items.len() {
            0 if self.at_or(within) => Err(self.error(self.at, "`OR` needs a term before it")),
            0 if self.peek() == Some(')') => Err(self.error(self.at, "unmatched `)`")),
            0 => Err(self.error(self.at, "expected a term")),
            1 => Ok(items.pop().expect("one item")),
            _ => Ok(Node::And(items)),
        }
    }

    fn unary(&mut self, within: Within) -> Result<Node, QueryError> {
        if self.peek() != Some('-') {
            return self.primary(within);
        }
        let start = self.at;
        // Only the end of the query, whitespace or `)` (and, inside `[…]`,
        // `]` or `:`) leave a `-` dangling. `(` and another `-` begin the
        // term it negates, so `-(a b)` is a negated group; `ends_word` would
        // refuse `(`, which is why it is not used here.
        let dangling = match self.chars.get(start + 1) {
            None => true,
            Some(c) if c.is_whitespace() || *c == ')' => true,
            Some(']' | ':') => within.in_property(),
            Some(_) => false,
        };
        if dangling {
            return Err(self.error(start, "`-` needs a term after it"));
        }
        self.at += 1;
        self.deeper(start)?;
        let inner = self.unary(within)?;
        self.depth -= 1;
        Ok(Node::Not(Box::new(inner)))
    }

    fn primary(&mut self, within: Within) -> Result<Node, QueryError> {
        let start = self.at;
        match self.peek() {
            Some('(') => self.group(within),
            Some('[') if !within.in_property() => self.property(),
            Some('"') => self.phrase().map(Node::Term),
            Some('/') => Ok(Node::Term(self.regex_or_word(within))),
            _ => {
                if !within.in_property() {
                    if let Some((name, after)) = self.operator_name() {
                        return self.operator(name, start, after, within);
                    }
                }
                Ok(Node::Term(self.word(within)))
            }
        }
    }

    fn group(&mut self, within: Within) -> Result<Node, QueryError> {
        let opener = self.at;
        self.at += 1;
        self.deeper(opener)?;
        self.skip_ws();
        if self.peek() == Some(')') {
            return Err(self.error(opener, "empty `()`"));
        }
        if self.done() {
            return Err(self.error(opener, "unmatched `(`"));
        }
        let inner = self.or_expr(within.group())?;
        self.skip_ws();
        if self.peek() != Some(')') {
            return Err(self.error(opener, "unmatched `(`"));
        }
        self.at += 1;
        self.depth -= 1;
        Ok(inner)
    }

    /// An operator name followed by `:`, and the position after the colon.
    fn operator_name(&self) -> Option<(&'static str, usize)> {
        let mut end = self.at;
        while self
            .chars
            .get(end)
            .is_some_and(|c| c.is_ascii_lowercase() || *c == '-')
        {
            end += 1;
        }
        if self.chars.get(end) != Some(&':') {
            return None;
        }
        let name: String = self.chars[self.at..end].iter().collect();
        OPERATORS
            .iter()
            .find(|known| **known == name)
            .map(|known| (*known, end + 1))
    }

    fn operator(
        &mut self,
        name: &'static str,
        start: usize,
        after: usize,
        within: Within,
    ) -> Result<Node, QueryError> {
        let at = start..after - 1;
        self.at = after;
        if self.ends_word(self.at, within) && self.peek() != Some('(') {
            return Err(self.error(start, "an operator needs a term after it"));
        }
        let operand = match self.peek() {
            Some('(') => self.group(within)?,
            Some('"') => Node::Term(self.phrase()?),
            Some('/') => Node::Term(self.regex_or_word(within)),
            _ => Node::Term(self.word(within)),
        };
        let query = Box::new(operand);
        Ok(match name {
            "match-case" => Node::Case {
                sensitive: true,
                query,
                at,
            },
            "ignore-case" => Node::Case {
                sensitive: false,
                query,
                at,
            },
            other => Node::Scoped {
                scope: Scope::from_name(other).expect("a known scope"),
                query,
                at,
            },
        })
    }

    fn word(&mut self, within: Within) -> Term {
        let start = self.at;
        while !self.ends_word(self.at, within) {
            self.at += 1;
        }
        Term {
            pattern: Pattern::Text(self.chars[start..self.at].iter().collect()),
            phrase: false,
            at: start..self.at,
        }
    }

    fn phrase(&mut self) -> Result<Term, QueryError> {
        let start = self.at;
        self.at += 1;
        let mut text = String::new();
        loop {
            match self.peek() {
                None => return Err(self.error(start, "unterminated quote")),
                Some('\\') if matches!(self.chars.get(self.at + 1), Some('"') | Some('\\')) => {
                    text.push(self.chars[self.at + 1]);
                    self.at += 2;
                }
                Some('"') => {
                    self.at += 1;
                    return Ok(Term {
                        pattern: Pattern::Text(text),
                        phrase: true,
                        at: start..self.at,
                    });
                }
                Some(c) => {
                    text.push(c);
                    self.at += 1;
                }
            }
        }
    }

    /// `/source/flags` when an unescaped closing slash follows and the flags
    /// end a word; an ordinary word otherwise.
    fn regex_or_word(&mut self, within: Within) -> Term {
        let start = self.at;
        let mut at = start + 1;
        while let Some(c) = self.chars.get(at) {
            if *c == '\\' {
                at += 2;
                continue;
            }
            if *c == '/' {
                let mut end = at + 1;
                // JavaScript's flag letters only, so `/usr/local` stays a word.
                while self.chars.get(end).is_some_and(|c| "dgimsuyv".contains(*c)) {
                    end += 1;
                }
                if self.ends_word(end, within) {
                    let source = self.chars[start + 1..at].iter().collect();
                    let flags = self.chars[at + 1..end].iter().collect();
                    self.at = end;
                    return Term {
                        pattern: Pattern::Regex { source, flags },
                        phrase: false,
                        at: start..end,
                    };
                }
                break;
            }
            at += 1;
        }
        self.word(within)
    }

    fn property(&mut self) -> Result<Node, QueryError> {
        let opener = self.at;
        self.at += 1;
        self.deeper(opener)?;
        self.skip_ws();
        if self.peek() == Some(']') {
            return Err(self.error(opener, "empty `[]`"));
        }
        if self.done() {
            return Err(self.error(opener, "unmatched `[`"));
        }
        let name = self.or_expr(Within::PropertyName)?;
        self.skip_ws();
        let mut value = None;
        if self.peek() == Some(':') {
            self.at += 1;
            self.skip_ws();
            value = Some(self.property_value(opener)?);
        }
        self.skip_ws();
        if self.peek() != Some(']') {
            return Err(self.error(opener, "unmatched `[`"));
        }
        self.at += 1;
        self.depth -= 1;
        Ok(Node::Property {
            name: Box::new(name),
            value,
            at: opener..self.at,
        })
    }

    fn property_value(&mut self, opener: usize) -> Result<PropertyValueQuery, QueryError> {
        if let Some(op) = self.peek().filter(|c| *c == '<' || *c == '>') {
            let op_at = self.at;
            self.at += 1;
            let start = self.at;
            while self.peek().is_some_and(|c| c != ']' && !c.is_whitespace()) {
                self.at += 1;
            }
            let text: String = self.chars[start..self.at].iter().collect();
            let number: f64 = text
                .parse()
                .map_err(|_| self.error(op_at, "a comparison needs a number"))?;
            return Ok(if op == '<' {
                PropertyValueQuery::Less(number)
            } else {
                PropertyValueQuery::Greater(number)
            });
        }
        if self.null_value() {
            self.at += 4;
            return Ok(PropertyValueQuery::Null);
        }
        if self.peek() == Some(']') || self.done() {
            return Err(self.error(opener, "a property value is missing after `:`"));
        }
        Ok(PropertyValueQuery::Query(Box::new(
            self.or_expr(Within::PropertyValue)?,
        )))
    }

    /// `null`, then only whitespace before the closing `]`.
    fn null_value(&self) -> bool {
        let word: String = self.chars.iter().skip(self.at).take(4).collect();
        if word != "null" {
            return false;
        }
        let mut after = self.at + 4;
        while self.chars.get(after).is_some_and(|c| c.is_whitespace()) {
            after += 1;
        }
        self.chars.get(after) == Some(&']')
    }
}
