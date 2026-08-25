use serde::{Deserialize, Serialize};

use crate::semantic::{
    DiagnosticDto, IndexStateDto, NoteDto, NoteSummaryDto, ReferenceDto, ResolutionDto, SeverityDto,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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
