//! Obsidian Bases, evaluated outside Obsidian.
//!
//! This crate takes a `.base` document and a [`RowSource`] and produces a
//! view's rows. It does no I/O, opens no database and knows no protocol type:
//! the daemon implements `RowSource` over its index and live graph, and a
//! test implements it over [`MemorySource`]. Every behaviour that is not
//! fixed by the published reference (`obsidian.md/help/bases/…`) is fixed by
//! a runtime capture under `tests/fixtures/captures/`, and where neither
//! exists the evaluator answers a typed error rather than a guess.

mod clock;
pub mod collate;
mod dates;
pub mod eval;
pub mod expr;
mod file;
#[cfg(feature = "fixtures")]
pub mod fixtures;
pub mod functions;
mod source;
mod value;
pub mod view;

pub use clock::Clock;
pub use dates::{format_date, humanize};
pub use file::{
    BaseFile, BaseParseError, Direction, FilterNode, GroupBy, PropertySettings, SortKey, ViewDecl,
    parse_base,
};
pub use source::{
    FileFacts, FileKind, LinkFact, MemoryFile, MemorySource, Prefilter, PropertyType, RowSource,
    ScalarLiteral, SourceError, SourceLog, extension, no_span, number, text,
};
pub use value::{DateValue, DurationValue, LinkValue, MAX_VALUE_DEPTH, RegexpValue, Value};
