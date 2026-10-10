use std::sync::Arc;

use vault_core::VaultPath;

/// A calendar instant, in milliseconds since the Unix epoch, plus whether it
/// carries a time of day. `date("2025-01-01")` has no time; `now()` does. The
/// flag is what `format`, `relative` and the cell model read; arithmetic
/// ignores it.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DateValue {
    pub epoch_ms: i64,
    pub has_time: bool,
}

/// A span of time. Months are kept apart from milliseconds because `+ "1M"`
/// is calendar arithmetic — `2024-12-01 + 1M` is `2025-01-01`, not 30 days on —
/// and only a date can resolve a month into milliseconds.
///
/// `timed` is whether the span was written with a time unit (hours,
/// minutes, seconds) or carries a part of a day: added to a date without a
/// time it gives a date with one (captured, Task 13: `date("2025-01-01") +
/// "24h"` shows `2025-01-02T00:00:00`, `+ "1d"` shows `2025-01-02`).
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct DurationValue {
    pub months: i64,
    pub ms: i64,
    pub timed: bool,
}

/// A link value: what it points at as written, an optional display value
/// (`link("x", icon("plus"))` displays an icon), and the path it resolved to
/// when the row source could resolve it.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkValue {
    pub target: String,
    pub display: Option<Box<Value>>,
    pub resolved: Option<VaultPath>,
}

/// A regular expression literal (`/abc/g`) or a value built from one. The
/// compiled form is shared; equality is by source and flags.
#[derive(Clone, Debug)]
pub struct RegexpValue {
    pub source: String,
    pub flags: String,
    pub regex: Arc<regex::Regex>,
}

impl PartialEq for RegexpValue {
    fn eq(&self, other: &Self) -> bool {
        self.source == other.source && self.flags == other.flags
    }
}

/// The Bases type system, as the published syntax page lists it, plus the
/// three render-only kinds (`image`, `icon`, `html`) that carry their
/// arguments to the client unrendered.
///
/// `PartialEq` here is *structural* equality for tests. The language's own
/// `==` is [`crate::eval::coerce::loose_equals`], which compares a link to a
/// file and a date to a date by instant — never use this derive for it.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    String(String),
    Number(f64),
    Boolean(bool),
    Date(DateValue),
    Duration(DurationValue),
    /// Shared storage: cloning a list (binding it to `acc`, reading a
    /// local) is O(1), never a deep copy. Build one with [`Value::list`],
    /// which also records how deep it nests.
    List(Arc<Nested<Vec<Value>>>),
    /// Shared like [`Value::List`]; build one with [`Value::object`].
    Object(Arc<Nested<Vec<(String, Value)>>>),
    Link(LinkValue),
    File(VaultPath),
    Regexp(RegexpValue),
    Image(String),
    Icon(String),
    Html(String),
}

/// The deepest a value may nest: a list, an object or a link's display is
/// one level. The same number as the expression cap
/// ([`crate::expr::MAX_DEPTH`]): that cap bounds the syntax tree, this one
/// bounds what a program builds (`xs.reduce([acc], [])` nests one level per
/// element). Every recursive walk over a value (clone, drop, compare,
/// render) stays within it; going past it is
/// [`crate::eval::EvalError::ValueTooDeep`], an error cell.
pub const MAX_VALUE_DEPTH: usize = 64;

/// A list's items or an object's entries, with how many levels the value
/// nests (one for this level plus the deepest item's), computed once when
/// it is built. Reads go through `Deref`, so `items.iter()`, `items.len()`
/// and `items[i]` work as on the `Vec`. Wrapping a value one level deeper
/// checks this number instead of walking the value, so a fold that wraps a
/// wide list on every step stays linear (Task 14 fix round: the walk made
/// `xs.reduce([xs], [])` quadratic, 5.4 s at 20,000 items).
#[derive(Clone, Debug)]
pub struct Nested<T> {
    items: T,
    depth: usize,
}

impl<T> Nested<T> {
    /// How many levels this list or object nests (at least 1).
    pub fn depth(&self) -> usize {
        self.depth
    }
}

impl<T> std::ops::Deref for Nested<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.items
    }
}

/// Structural equality is the items' (the depth follows from them).
impl<T: PartialEq> PartialEq for Nested<T> {
    fn eq(&self, other: &Self) -> bool {
        self.items == other.items
    }
}

impl Value {
    /// A list value.
    pub fn list(items: Vec<Value>) -> Value {
        let depth = 1 + items.iter().map(Value::depth).max().unwrap_or(0);
        Value::List(Arc::new(Nested { items, depth }))
    }

    /// An object value, its entries in order.
    pub fn object(entries: Vec<(String, Value)>) -> Value {
        let depth = 1 + entries
            .iter()
            .map(|(_, value)| value.depth())
            .max()
            .unwrap_or(0);
        Value::Object(Arc::new(Nested {
            items: entries,
            depth,
        }))
    }

    /// How many levels this value nests: a scalar none, a list or an object
    /// its recorded depth, a link with a display one more than its display.
    /// O(1) for lists and objects; a link walks only its display chain,
    /// which wrapping bounds by [`MAX_VALUE_DEPTH`].
    pub fn depth(&self) -> usize {
        match self {
            Value::List(items) => items.depth(),
            Value::Object(entries) => entries.depth(),
            Value::Link(link) => link
                .display
                .as_ref()
                .map_or(0, |display| 1 + display.depth()),
            _ => 0,
        }
    }

    /// Whether this value nests more than `levels` levels (a scalar nests
    /// none). Reads the recorded depth; walks nothing.
    pub fn nests_deeper_than(&self, levels: usize) -> bool {
        self.depth() > levels
    }

    /// The name `isType` compares against, and the `kind` a cell carries.
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Boolean(_) => "boolean",
            Value::Date(_) => "date",
            Value::Duration(_) => "duration",
            Value::List(_) => "list",
            Value::Object(_) => "object",
            Value::Link(_) => "link",
            Value::File(_) => "file",
            Value::Regexp(_) => "regexp",
            Value::Image(_) => "image",
            Value::Icon(_) => "icon",
            Value::Html(_) => "html",
        }
    }
}
