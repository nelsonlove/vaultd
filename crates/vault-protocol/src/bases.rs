//! Bases on the wire: `evaluate_base`, `list_bases`, and the cell model.
//!
//! Additive to protocol version 1. Every enum a client decodes here carries
//! an `Unknown` catch-all, as `docs/protocol.md`'s Evolution section requires.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::semantic::{PropertyValueDto, SpanDto};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct EvaluateBaseParams {
    pub path: String,
    /// A view name; absent means the first declared view.
    #[serde(default)]
    pub view: Option<String>,
    /// The embedding note; absent means the base itself.
    #[serde(default)]
    pub this_path: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ListBasesParams {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// One declared key and its YAML value, in declared order: a view's open
/// options and a column's settings are carried the way `PropertyValueDto`
/// carries a mapping, so neither order nor a repeated key is lost.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OptionEntryDto {
    pub key: String,
    pub value: PropertyValueDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ViewDto {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    /// Every key of the view the core does not own, as declared, in order.
    pub options: Vec<OptionEntryDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ColumnDto {
    pub property: String,
    pub display_name: Option<String>,
    /// The property's declared settings other than `displayName`, in order.
    pub settings: Vec<OptionEntryDto>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowKindDto {
    Note,
    File,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ObjectEntryDto {
    pub key: String,
    pub value: CellDto,
}

/// One typed cell. The daemon renders nothing; a client turns these into a
/// table, cards, a list or a board.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CellDto {
    Null,
    String {
        value: String,
    },
    /// A finite number. A non-finite one has no JSON number, so it travels
    /// as a `string` cell holding JavaScript's text: `NaN`, `Infinity`,
    /// `-Infinity`.
    Number {
        value: serde_json::Number,
    },
    Boolean {
        value: bool,
    },
    /// ISO 8601 in the daemon's zone: `YYYY-MM-DD` without a time,
    /// `YYYY-MM-DDTHH:mm:ss.SSS±HH:MM` with one.
    Date {
        value: String,
        has_time: bool,
    },
    /// Milliseconds, plus the calendar months kept apart from them.
    Duration {
        value: i64,
        months: i64,
    },
    List {
        value: Vec<CellDto>,
    },
    /// An ordered list of entries, as `PropertyMappingEntryDto` carries a
    /// mapping.
    Object {
        value: Vec<ObjectEntryDto>,
    },
    Link {
        target: String,
        display: Option<Box<CellDto>>,
        resolved: Option<String>,
    },
    File {
        path: String,
    },
    Image {
        value: String,
    },
    Icon {
        value: String,
    },
    Html {
        value: String,
    },
    /// The expression failed on this row; the row stays.
    Error {
        message: String,
    },
    /// A cell kind this build does not know. Never produced by this server.
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RowDto {
    pub path: String,
    pub kind: RowKindDto,
    /// The group key, present exactly when the view is grouped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<CellDto>,
    /// Aligned with the response's `columns`.
    pub cells: Vec<CellDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EvaluateBaseResponse {
    pub generation: u64,
    pub view: ViewDto,
    pub columns: Vec<ColumnDto>,
    pub rows: Vec<RowDto>,
    /// Name to typed value; the name is the key the view's own `summaries`
    /// map declares the summary under.
    pub summaries: BTreeMap<String, CellDto>,
    pub total_rows: u64,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BaseStatusDto {
    Parsed,
    ParseFailed {
        message: String,
        span: Option<SpanDto>,
    },
    /// A status this build does not know. Never produced by this server.
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BaseSummaryDto {
    pub path: String,
    pub status: BaseStatusDto,
    pub views: Vec<String>,
}
