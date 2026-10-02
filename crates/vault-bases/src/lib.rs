//! Obsidian Bases, evaluated outside Obsidian.
//!
//! This crate takes a `.base` document and a [`RowSource`] and produces a
//! view's rows. It does no I/O, opens no database and knows no protocol type:
//! the daemon implements `RowSource` over its index and live graph, and a
//! test implements it over [`MemorySource`]. Every behaviour that is not
//! fixed by the published reference (`obsidian.md/help/bases/…`) is fixed by
//! a runtime capture under `tests/fixtures/captures/`, and where neither
//! exists the evaluator answers a typed error rather than a guess.

pub mod expr;
mod file;
mod value;

pub use file::{
    BaseFile, BaseParseError, Direction, FilterNode, GroupBy, PropertySettings, SortKey, ViewDecl,
    parse_base,
};
pub use value::{DateValue, DurationValue, LinkValue, RegexpValue, Value};
