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
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct DurationValue {
    pub months: i64,
    pub ms: i64,
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
    List(Vec<Value>),
    Object(Vec<(String, Value)>),
    Link(LinkValue),
    File(VaultPath),
    Regexp(RegexpValue),
    Image(String),
    Icon(String),
    Html(String),
}

impl Value {
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
