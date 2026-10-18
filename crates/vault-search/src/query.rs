//! The query tree and its printer.

use std::fmt;
use std::ops::Range;

/// A parsed search query. `root` is `None` for an empty or all-whitespace
/// query.
#[derive(Clone, Debug, PartialEq)]
pub struct Query {
    pub root: Option<Node>,
}

/// One node of the query tree. Every `at` is a range of character offsets
/// into the query string.
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    /// A word, phrase or regex, in the default scope.
    Term(Term),
    /// `file:` `path:` `content:` `tag:` `line:` `block:` `section:`
    /// `task:` `task-todo:` `task-done:`; `at` covers the operator's name.
    Scoped {
        scope: Scope,
        query: Box<Node>,
        at: Range<usize>,
    },
    /// `match-case:` and `ignore-case:`; `at` covers the operator's name.
    Case {
        sensitive: bool,
        query: Box<Node>,
        at: Range<usize>,
    },
    /// `[name]` or `[name:value]`; `at` covers the brackets.
    Property {
        name: Box<Node>,
        value: Option<PropertyValueQuery>,
        at: Range<usize>,
    },
}

/// A word, a quoted phrase, or a regular expression.
#[derive(Clone, Debug, PartialEq)]
pub struct Term {
    pub pattern: Pattern,
    pub phrase: bool,
    pub at: Range<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pattern {
    Text(String),
    Regex { source: String, flags: String },
}

/// The scope an operator restricts its operand to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    File,
    Path,
    Content,
    Tag,
    Line,
    Block,
    Section,
    Task,
    TaskTodo,
    TaskDone,
}

const SCOPES: [(Scope, &str); 10] = [
    (Scope::File, "file"),
    (Scope::Path, "path"),
    (Scope::Content, "content"),
    (Scope::Tag, "tag"),
    (Scope::Line, "line"),
    (Scope::Block, "block"),
    (Scope::Section, "section"),
    (Scope::Task, "task"),
    (Scope::TaskTodo, "task-todo"),
    (Scope::TaskDone, "task-done"),
];

impl Scope {
    /// The operator's name as the query spells it, without the colon.
    pub fn name(self) -> &'static str {
        SCOPES
            .iter()
            .find(|(scope, _)| *scope == self)
            .map(|(_, name)| *name)
            .expect("every scope has a name")
    }

    /// The inverse of [`Scope::name`].
    pub fn from_name(name: &str) -> Option<Scope> {
        SCOPES
            .iter()
            .find(|(_, known)| *known == name)
            .map(|(scope, _)| *scope)
    }
}

/// What a property's value is tested against.
#[derive(Clone, Debug, PartialEq)]
pub enum PropertyValueQuery {
    Null,
    Query(Box<Node>),
    Less(f64),
    Greater(f64),
}

/// A query that does not parse, with the character offset where the problem
/// was found.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("{message} (at character {position})")]
pub struct QueryError {
    pub message: String,
    pub position: usize,
}

impl Query {
    /// The same tree with every position set to `0..0`, so trees parsed from
    /// different spellings compare equal.
    pub fn strip_positions(&self) -> Query {
        Query {
            root: self.root.as_ref().map(strip),
        }
    }
}

fn strip(node: &Node) -> Node {
    match node {
        Node::And(items) => Node::And(items.iter().map(strip).collect()),
        Node::Or(items) => Node::Or(items.iter().map(strip).collect()),
        Node::Not(inner) => Node::Not(Box::new(strip(inner))),
        Node::Term(term) => Node::Term(Term {
            pattern: term.pattern.clone(),
            phrase: term.phrase,
            at: 0..0,
        }),
        Node::Scoped { scope, query, .. } => Node::Scoped {
            scope: *scope,
            query: Box::new(strip(query)),
            at: 0..0,
        },
        Node::Case {
            sensitive, query, ..
        } => Node::Case {
            sensitive: *sensitive,
            query: Box::new(strip(query)),
            at: 0..0,
        },
        Node::Property { name, value, .. } => Node::Property {
            name: Box::new(strip(name)),
            value: value.as_ref().map(|value| match value {
                PropertyValueQuery::Query(query) => {
                    PropertyValueQuery::Query(Box::new(strip(query)))
                }
                other => other.clone(),
            }),
            at: 0..0,
        },
    }
}

/// The canonical spelling: parsing it gives back the same tree, positions
/// aside.
impl fmt::Display for Query {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.root {
            None => Ok(()),
            Some(node) => write_node(f, node, Context::Top, false),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Context {
    Top,
    InOr,
    Tight,
}

/// `in_value` is true inside a property's value, where the parser
/// recognizes no operator and `:` is an ordinary word character.
fn write_node(
    f: &mut fmt::Formatter<'_>,
    node: &Node,
    context: Context,
    in_value: bool,
) -> fmt::Result {
    match node {
        Node::Or(items) => write_joined(
            f,
            items,
            " OR ",
            Context::InOr,
            context != Context::Top,
            in_value,
        ),
        Node::And(items) => write_joined(
            f,
            items,
            " ",
            Context::Tight,
            context == Context::Tight,
            in_value,
        ),
        Node::Not(inner) => {
            f.write_str("-")?;
            write_node(f, inner, Context::Tight, in_value)
        }
        Node::Term(term) => write_term(f, term, in_value),
        Node::Scoped { scope, query, .. } => {
            write!(f, "{}:", scope.name())?;
            write_operand(f, query)
        }
        Node::Case {
            sensitive, query, ..
        } => {
            f.write_str(if *sensitive {
                "match-case:"
            } else {
                "ignore-case:"
            })?;
            write_operand(f, query)
        }
        Node::Property { name, value, .. } => {
            f.write_str("[")?;
            write_node(f, name, Context::Top, false)?;
            match value {
                None => {}
                Some(PropertyValueQuery::Null) => f.write_str(":null")?,
                Some(PropertyValueQuery::Less(n)) => write!(f, ":<{n}")?,
                Some(PropertyValueQuery::Greater(n)) => write!(f, ":>{n}")?,
                Some(PropertyValueQuery::Query(q)) => {
                    f.write_str(":")?;
                    write_node(f, q, Context::Top, true)?;
                }
            }
            f.write_str("]")
        }
    }
}

fn write_joined(
    f: &mut fmt::Formatter<'_>,
    items: &[Node],
    separator: &str,
    child: Context,
    parenthesize: bool,
    in_value: bool,
) -> fmt::Result {
    if parenthesize {
        f.write_str("(")?;
    }
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            f.write_str(separator)?;
        }
        write_node(f, item, child, in_value)?;
    }
    if parenthesize {
        f.write_str(")")?;
    }
    Ok(())
}

/// An operator's operand: a term bare, anything else in parentheses.
fn write_operand(f: &mut fmt::Formatter<'_>, node: &Node) -> fmt::Result {
    match node {
        Node::Term(term) => write_term(f, term, false),
        other => {
            f.write_str("(")?;
            write_node(f, other, Context::Top, false)?;
            f.write_str(")")
        }
    }
}

fn write_term(f: &mut fmt::Formatter<'_>, term: &Term, in_value: bool) -> fmt::Result {
    match &term.pattern {
        Pattern::Regex { source, flags } => write!(f, "/{source}/{flags}"),
        Pattern::Text(text) if !term.phrase && is_safe_word(text, in_value) => f.write_str(text),
        Pattern::Text(text) => {
            f.write_str("\"")?;
            for c in text.chars() {
                if c == '"' || c == '\\' {
                    f.write_str("\\")?;
                }
                write!(f, "{c}")?;
            }
            f.write_str("\"")
        }
    }
}

/// Text the parser reads back as this one bare word. Inside a property's
/// value `:` is an ordinary word character.
fn is_safe_word(text: &str, in_value: bool) -> bool {
    !text.is_empty()
        && !text.chars().any(|c| {
            c.is_whitespace()
                || matches!(c, '(' | ')' | '[' | ']' | '"' | '\\')
                || (c == ':' && !in_value)
        })
        && !text.starts_with('-')
        && !text.starts_with('/')
        && text != "OR"
        && text != "null"
}
