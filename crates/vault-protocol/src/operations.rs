use serde::{Deserialize, Serialize};

use crate::events::LiveStateDto;
use crate::mutations::{
    CopyFileParams, DeleteFolderParams, DeleteNoteParams, FolderParams, GenerationResponse,
    MutationResponse, PatchFrontmatterParams, ReadFileParams, ReadFileResponse, RenameFolderParams,
    RenameNoteParams, RenameResponse, WriteFileParams, WriteFileResponse, WriteNoteParams,
};
use crate::semantic::{
    DiagnosticDto, IndexStateDto, NoteDto, NoteSummaryDto, ReferenceDto, ResolutionDto, SeverityDto,
};
use crate::snapshots::{
    CloseSnapshotParams, CloseSnapshotResponse, OpenSnapshotParams, OpenSnapshotResponse,
    SnapshotNotesParams, SnapshotNotesResponse, SnapshotTreeParams, SnapshotTreeResponse,
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
    OpenSnapshot(OpenSnapshotParams),
    SnapshotTree(SnapshotTreeParams),
    SnapshotNotes(SnapshotNotesParams),
    CloseSnapshot(CloseSnapshotParams),
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageParams {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NotePathParams {
    pub path: String,
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
    OpenSnapshot(OpenSnapshotResponse),
    SnapshotTree(SnapshotTreeResponse),
    SnapshotNotes(SnapshotNotesResponse),
    CloseSnapshot(CloseSnapshotResponse),
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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetNoteResponse {
    pub generation: u64,
    pub note: NoteDto,
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
