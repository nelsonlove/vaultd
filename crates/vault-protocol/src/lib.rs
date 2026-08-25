mod envelope;
mod error;
mod operations;
mod semantic;

pub use envelope::{
    PROTOCOL_VERSION, RequestEnvelope, ResponseEnvelope, ResponseOutcome, validate_version,
};
pub use error::{ErrorCode, ProtocolError};
pub use operations::{
    GetDiagnosticsParams, GetNoteResponse, GetVaultInfoResponse, HealthResponse,
    ListReferencesParams, NotePathParams, PageParams, PageResponse, PathPageParams,
    ReferenceStatusFilter, RefreshIndexParams, RefreshIndexResponse, Request, ResolveLinkParams,
    ResolveLinkResponse, Response,
};
pub use semantic::{
    AliasDto, BlockDto, DiagnosticDto, HeadingDto, IndexStateDto, NoteDto, NoteSummaryDto,
    PropertyDto, PropertyMappingEntryDto, PropertyValueDto, ReferenceDto, ReferenceKindDto,
    ReferenceOriginDto, ResolutionDto, SeverityDto, SpanDto, SpannedPropertyValueDto, TagDto,
};
