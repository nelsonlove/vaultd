//! Search on the wire.
//!
//! Additive to protocol version 1; the response's `kind` carries an `Unknown`
//! catch-all, the request's `sort` and `context` do not, because an unknown
//! value a client chose is refused.

use serde::{Deserialize, Serialize};

use crate::semantic::SpanDto;

/// The `search` request: a query in Obsidian's syntax, the Match case
/// toggle, the sort order, what each match carries, and the collection
/// paging.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct SearchParams {
    pub query: String,
    #[serde(default)]
    pub match_case: bool,
    #[serde(default)]
    pub sort: SearchSortDto,
    #[serde(default)]
    pub context: SearchContextDto,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Obsidian's six sort orders. A closed set the client chooses from, so an
/// unknown value is `invalid_request`, not `Unknown`.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchSortDto {
    #[default]
    FileNameAsc,
    FileNameDesc,
    ModifiedDesc,
    ModifiedAsc,
    CreatedDesc,
    CreatedAsc,
}

/// What each content match carries beyond its positions: nothing, or the
/// line text. A closed set the client chooses from.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchContextDto {
    None,
    #[default]
    Line,
}

/// The `search` answer: the counts over the whole answer at `generation`,
/// one page of files, and the cursor to the next page.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SearchResponse {
    pub generation: u64,
    pub total_files: u64,
    pub total_matches: u64,
    pub items: Vec<SearchHitDto>,
    pub next_cursor: Option<String>,
}

/// One matched file. `path_matches` are in UTF-16 units of the path string;
/// `matches_truncated` says the file had more content matches than the
/// per-file cap.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SearchHitDto {
    pub path: String,
    pub kind: DocumentKindDto,
    pub path_matches: Vec<Utf16SpanDto>,
    pub content_matches: Vec<ContentMatchDto>,
    pub matches_truncated: bool,
}

/// What a searched document is. `Canvas` is reserved and never produced in
/// this phase (Ruling 4, issue #3).
///
/// Open-ended for the same reason `TreeEntryKindDto` is: this flows
/// server-to-client and is plausibly extensible, so a kind this build has not
/// heard of must degrade to [`DocumentKindDto::Unknown`] rather than fail the
/// whole page. `Deserialize` is hand-written because `#[serde(other)]` is
/// rejected on an externally tagged enum, which is what a plain unit-variant
/// enum is.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKindDto {
    Note,
    Canvas,
    File,
    /// A kind this build does not know. Never produced by this server.
    Unknown,
}

impl<'de> Deserialize<'de> for DocumentKindDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "note" => Self::Note,
            "canvas" => Self::Canvas,
            "file" => Self::File,
            _ => Self::Unknown,
        })
    }
}

/// A half-open span in UTF-16 units.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Utf16SpanDto {
    pub start: u64,
    pub end: u64,
}

/// An Obsidian `Loc`: `line` zero-based, `col` and `offset` in UTF-16 units.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocDto {
    pub line: u64,
    pub col: u64,
    pub offset: u64,
}

/// One content match: `span` in half-open UTF-8 byte offsets into the exact
/// source, `start` and `end` as Obsidian `Loc`s, and with `context: line`
/// the line holding the match start and that cut's byte offset.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContentMatchDto {
    pub span: SpanDto,
    pub start: LocDto,
    pub end: LocDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_text_start: Option<u64>,
}
