use serde::{Deserialize, Serialize};

use crate::bases::{BaseSummaryDto, EvaluateBaseParams, EvaluateBaseResponse, ListBasesParams};
use crate::events::LiveStateDto;
use crate::mutations::{
    CopyFileParams, DeleteFolderParams, DeleteNoteParams, FolderParams, GenerationResponse,
    MutationResponse, PatchFrontmatterParams, ReadDirParams, ReadDirResponse, ReadFileParams,
    ReadFileResponse, RenameFolderParams, RenameNoteParams, RenameResponse, WriteFileParams,
    WriteFileResponse, WriteNoteParams,
};
use crate::semantic::{
    DiagnosticDto, IndexStateDto, NoteDto, NoteSummaryDto, ReferenceDto, ResolutionDto, SeverityDto,
};
use crate::snapshots::{
    CloseSnapshotParams, CloseSnapshotResponse, NoteFacetDto, OpenSnapshotParams,
    OpenSnapshotResponse, SnapshotNotesParams, SnapshotNotesResponse, SnapshotTreeParams,
    SnapshotTreeResponse, TreeEntryDto,
};

// `Eq` is not derivable here: `PatchFrontmatter` carries `PatchValueDto`,
// which holds an `f64` for the JSON-number-with-a-fraction case, and `f64`
// has no total order. `PartialEq` is enough — nothing hashes or sorts a
// `Request`.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Request {
    Health,
    GetVaultInfo,
    ListNotes(PageParams),
    GetNote(NotePathParams),
    GetTreeEntries(GetTreeEntriesParams),
    ResolveLink(ResolveLinkParams),
    GetBacklinks(PathPageParams),
    ListReferences(ListReferencesParams),
    GetDiagnostics(GetDiagnosticsParams),
    RefreshIndex(RefreshIndexParams),
    SubscribeEvents(SubscribeEventsParams),
    Unsubscribe(UnsubscribeParams),
    WriteNote(WriteNoteParams),
    CreateFolder(FolderParams),
    RenameNote(RenameNoteParams),
    RenameFolder(RenameFolderParams),
    CopyFile(CopyFileParams),
    DeleteNote(DeleteNoteParams),
    DeleteFolder(DeleteFolderParams),
    PatchFrontmatter(PatchFrontmatterParams),
    WriteFile(WriteFileParams),
    ReadFile(ReadFileParams),
    ReadDir(ReadDirParams),
    OpenSnapshot(OpenSnapshotParams),
    SnapshotTree(SnapshotTreeParams),
    SnapshotNotes(SnapshotNotesParams),
    CloseSnapshot(CloseSnapshotParams),
    EvaluateBase(EvaluateBaseParams),
    ListBases(ListBasesParams),
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageParams {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `get_note`'s parameters.
///
/// `include` names the **structural** row-sets to serve alongside the note:
/// `sections` and `list_items`, spelled with the same [`NoteFacetDto`] names
/// `snapshot_notes` uses, because a client that has learned one set of facet
/// names should not have to learn a second. Only those two are accepted here —
/// `metadata`, `references`, `resolutions`, and `backlinks` are `get_note`'s
/// own fields already, so naming one is `invalid_request` rather than a
/// silently redundant ask. An omitted `include` asks for nothing and the
/// answer is byte-identical to the one this operation has always given.
///
/// The list is `#[serde(default)]` rather than an `Option`, exactly as
/// `SnapshotNotesParams::include` is: "asked for no facet" and "did not
/// mention facets" are the same request, and a facet name this build does not
/// know fails the decode instead of degrading to an empty ask.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NotePathParams {
    pub path: String,
    #[serde(default)]
    pub include: Vec<NoteFacetDto>,
}

/// `get_tree_entries`' parameters: the exact paths a caller wants tree rows
/// for, in the order it wants them answered.
///
/// Deliberately not a page and not a filter. The mirror this serves knows
/// precisely which paths a change set named and wants their rows, so a cursor
/// would only make it page through an answer it already sized. The count is
/// capped at the transport's own per-generation detail limit (1024 paths), so
/// a caller that has to ask about more than one generation's worth of detail
/// meets a refusal rather than an unbounded read.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetTreeEntriesParams {
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PathPageParams {
    pub path: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResolveLinkParams {
    pub source_path: String,
    pub destination: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceStatusFilter {
    Resolved,
    Unresolved,
    Ambiguous,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ListReferencesParams {
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub status: Option<ReferenceStatusFilter>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetDiagnosticsParams {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub severity: Option<SeverityDto>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct RefreshIndexParams {
    #[serde(default)]
    pub verify: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct SubscribeEventsParams {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UnsubscribeParams {
    pub subscription_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Response {
    Health(HealthResponse),
    GetVaultInfo(GetVaultInfoResponse),
    ListNotes(PageResponse<NoteSummaryDto>),
    GetNote(GetNoteResponse),
    GetTreeEntries(GetTreeEntriesResponse),
    ResolveLink(ResolveLinkResponse),
    GetBacklinks(PageResponse<ReferenceDto>),
    ListReferences(PageResponse<ReferenceDto>),
    GetDiagnostics(PageResponse<DiagnosticDto>),
    RefreshIndex(RefreshIndexResponse),
    SubscribeEvents(SubscribeEventsResponse),
    Unsubscribe(UnsubscribeResponse),
    WriteNote(MutationResponse),
    CreateFolder(GenerationResponse),
    RenameNote(RenameResponse),
    RenameFolder(RenameResponse),
    CopyFile(MutationResponse),
    DeleteNote(GenerationResponse),
    DeleteFolder(GenerationResponse),
    PatchFrontmatter(MutationResponse),
    WriteFile(WriteFileResponse),
    ReadFile(ReadFileResponse),
    ReadDir(ReadDirResponse),
    OpenSnapshot(OpenSnapshotResponse),
    SnapshotTree(SnapshotTreeResponse),
    SnapshotNotes(SnapshotNotesResponse),
    CloseSnapshot(CloseSnapshotResponse),
    EvaluateBase(EvaluateBaseResponse),
    ListBases(PageResponse<BaseSummaryDto>),
}

impl Response {
    pub fn health(service: impl Into<String>) -> Self {
        Self::Health(HealthResponse {
            service: service.into(),
            status: "ok".into(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HealthResponse {
    pub service: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageResponse<T> {
    pub generation: u64,
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetVaultInfoResponse {
    pub generation: u64,
    pub canonical_root: String,
    pub vault_identity: String,
    pub state: IndexStateDto,
    pub note_count: u64,
    pub refreshed_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_state: Option<LiveStateDto>,
    /// Where this daemon is listening, so a client on one connection can tell
    /// another where to knock. Absent — the key is skipped, never `null` —
    /// when the daemon has no socket, which keeps a version 1 client's bytes
    /// exactly what they were.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetNoteResponse {
    pub generation: u64,
    pub note: NoteDto,
}

/// `get_tree_entries`' answer, at one generation.
///
/// `entries` holds the rows that exist, in the order the request named them,
/// with the absentees left out; `absent` names those, in request order too.
/// A path with no row is **not** an error: the mirror asking about it is
/// working from a change set that may have named a path the index never listed
/// (a hidden file, a path the scan skipped) or one that has since gone, and
/// "there is nothing there at generation N" is exactly the answer it needs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetTreeEntriesResponse {
    pub generation: u64,
    pub entries: Vec<TreeEntryDto>,
    pub absent: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResolveLinkResponse {
    pub generation: u64,
    pub resolution: ResolutionDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RefreshIndexResponse {
    pub previous_generation: Option<u64>,
    pub generation: u64,
    pub added: u64,
    pub changed: u64,
    pub deleted: u64,
    pub unchanged: u64,
    pub reparsed: u64,
    pub verified: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SubscribeEventsResponse {
    pub subscription_id: String,
    pub generation: Option<u64>,
    pub live_state: LiveStateDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UnsubscribeResponse {
    pub subscription_id: String,
}
