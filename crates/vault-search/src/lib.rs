//! Obsidian's search grammar and a matcher over documents. No I/O, no
//! SQLite, no protocol types: the daemon feeds it documents, and a test
//! feeds it `MemoryDocument`s.

mod compile;
mod document;
mod evaluate;
mod parse;
mod query;
mod sort;
pub mod text;

pub use compile::{CompileError, CompiledQuery, Needs, compile};
pub use document::{DocumentKind, MemoryDocument, SearchDocument, TagFact};
pub use evaluate::{ContentMatch, FileHit, MAX_MATCHES_PER_FILE, evaluate};
pub use parse::{MAX_DEPTH, parse_query};
pub use query::*;
pub use sort::{SortOrder, Times, sort_hits};
