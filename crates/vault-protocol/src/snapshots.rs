//! Snapshot-session DTOs.
//!
//! A snapshot session is a pinned, generation-stable view a client pages
//! through with ordinary request/response calls, so hydration costs a
//! handful of round trips instead of thousands and never tears across
//! generations. Nothing here introduces new framing.

use serde::{Deserialize, Serialize};

use crate::semantic::{
    AliasDto, BlockDto, DiagnosticDto, HeadingDto, PropertyDto, ReferenceDto, ResolutionDto,
    SpanDto, TagDto,
};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct OpenSnapshotParams {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OpenSnapshotResponse {
    pub snapshot_id: String,
    pub generation: u64,
    pub note_count: u64,
    /// Every tree entry the session will page out: folders, notes, and
    /// non-Markdown files. Always at least `note_count`.
    pub entry_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotTreeParams {
    pub snapshot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// What one tree entry is. `Note` is an indexed Markdown file; `File` is any
/// other vault file (attachments), which carries bytes but no semantics.
///
/// Open-ended for the same reason `LiveStateDto` is: this flows
/// server-to-client on a `snapshot_tree` page and is plausibly extensible (a
/// future `canvas` or `base` kind), so a kind this build has not heard of
/// must degrade to [`TreeEntryKindDto::Unknown`] rather than fail the whole
/// page. `Deserialize` is hand-written because `#[serde(other)]` is rejected
/// on an externally tagged enum, which is what a plain unit-variant enum is.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TreeEntryKindDto {
    Folder,
    Note,
    File,
    /// A kind this build does not know. Never produced by this server.
    Unknown,
}

impl<'de> Deserialize<'de> for TreeEntryKindDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "folder" => Self::Folder,
            "note" => Self::Note,
            "file" => Self::File,
            _ => Self::Unknown,
        })
    }
}

/// One entry of the vault tree, read from the pre-task's `tree_entries` table
/// inside the session's pinned transaction.
///
/// `size` and `revision` are absent for a folder, which has neither, and
/// `revision` is also absent for a non-note file: the index stores no
/// content revision for attachments (a recorded pre-task divergence), so
/// only `note` entries carry one. The two
/// timestamps are never absent: they are **the source a host serves
/// `TFile.stat = { ctime, mtime, size }` from**, which is why they are stored
/// per entry rather than restated from the filesystem at read time. Both are
/// Unix milliseconds; `ctime_unix_ms` is filesystem birthtime where the
/// platform provides it and mtime where it does not.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TreeEntryDto {
    pub path: String,
    pub kind: TreeEntryKindDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub ctime_unix_ms: i64,
    pub mtime_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotTreeResponse {
    pub snapshot_id: String,
    pub generation: u64,
    pub entries: Vec<TreeEntryDto>,
    pub next_cursor: Option<String>,
}

/// Which per-note row-sets a page carries. A facet a client does not ask for
/// is not read, not serialized, and absent from the response.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteFacetDto {
    Metadata,
    References,
    /// The resolution answers, in the same ordinal order as `references`.
    /// Redundant with `references` (whose entries carry their own
    /// resolution) and cheaper: a client that wants answers without spans or
    /// spellings asks for this alone.
    Resolutions,
    Backlinks,
    /// Block-level sections, from the schema-v3 `sections` rows. A **sibling
    /// of `metadata`, never nested inside it** — the pre-task pins that, and a
    /// client asks for it by name or does not get it.
    Sections,
    /// List items, from the schema-v3 `list_items` rows. A sibling of
    /// `metadata` for the same reason.
    ListItems,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotNotesParams {
    pub snapshot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default)]
    pub include: Vec<NoteFacetDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NoteMetadataDto {
    pub properties: Vec<PropertyDto>,
    pub aliases: Vec<AliasDto>,
    pub headings: Vec<HeadingDto>,
    pub blocks: Vec<BlockDto>,
    pub tags: Vec<TagDto>,
    pub diagnostics: Vec<DiagnosticDto>,
}

/// One parsed document section, from the schema-v3 `sections` rows.
/// `block_id` is the trailing `^id` anchor when the block carries one.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SectionDto {
    pub kind: String,
    pub span: SpanDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
}

/// One parsed list item, from the schema-v3 `list_items` rows.
///
/// The parent is a **line number**, never an array index and never a sentinel:
/// a top-level item names the start line of the list that contains it
/// (`list_start_line`), a nested item names its parent item's own start line
/// (`parent_start_line`), and exactly one of the two is set. This mirrors the
/// pre-task's pinned DDL column-for-column. A host reconstructing Obsidian's
/// single `listItems[].parent` number negates `list_start_line` and passes
/// `parent_start_line` through unchanged — the widening lives here so the
/// negation is the consumer's arithmetic rather than this protocol's sign
/// trick.
///
/// `task` is the raw character inside the brackets when the item is a task
/// and absent otherwise: `Option<String>` in the domain, a one-character
/// string on the wire.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ListItemDto {
    pub span: SpanDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

/// One note's requested facets. Bodies stay per-note through `get_note`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotNoteDto {
    pub path: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<NoteMetadataDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<ReferenceDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolutions: Option<Vec<ResolutionDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backlinks: Option<Vec<ReferenceDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<Vec<SectionDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_items: Option<Vec<ListItemDto>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotNotesResponse {
    pub snapshot_id: String,
    pub generation: u64,
    pub notes: Vec<SnapshotNoteDto>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloseSnapshotParams {
    pub snapshot_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloseSnapshotResponse {
    pub snapshot_id: String,
}
