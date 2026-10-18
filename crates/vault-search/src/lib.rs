//! Obsidian's search grammar and a matcher over documents. No I/O, no
//! SQLite, no protocol types: the daemon feeds it documents, and a test
//! feeds it `MemoryDocument`s.

mod parse;
mod query;
pub mod text;

pub use parse::{MAX_DEPTH, parse_query};
pub use query::*;
