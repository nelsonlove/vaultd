mod envelope;
mod error;
mod events;
mod mutations;
mod operations;
mod semantic;

pub use envelope::{
    PROTOCOL_VERSION, RequestEnvelope, ResponseEnvelope, ResponseOutcome, validate_version,
};
pub use error::{ErrorCode, ProtocolError};
pub use events::{
    ChangeSetDto, EventEnvelope, GenerationCauseDto, GenerationCommittedEventDto, LiveStateDto,
    ResyncReasonDto, ResyncRequiredEventDto, RuntimeEventDto, RuntimeStateChangedEventDto,
};
pub use mutations::{
    CopyConflictDto, CopyFileParams, DeleteFolderParams, DeleteModeDto, DeleteNoteParams,
    ExpectedDto, FolderParams, FrontmatterEditDto, GenerationResponse, LinkRewriteFailureDto,
    MutationResponse, PatchFrontmatterParams, PatchValueDto, ReadFileParams, ReadFileResponse,
    RenameFolderParams, RenameNoteParams, RenameResponse, WriteFileParams, WriteFileResponse,
    WriteNoteParams,
};
pub use operations::{
    GetDiagnosticsParams, GetNoteResponse, GetVaultInfoResponse, HealthResponse,
    ListReferencesParams, NotePathParams, PageParams, PageResponse, PathPageParams,
    ReferenceStatusFilter, RefreshIndexParams, RefreshIndexResponse, Request, ResolveLinkParams,
    ResolveLinkResponse, Response, SubscribeEventsParams, SubscribeEventsResponse,
    UnsubscribeParams, UnsubscribeResponse,
};
pub use semantic::{
    AliasDto, BlockDto, DiagnosticDto, HeadingDto, IndexStateDto, NoteDto, NoteSummaryDto,
    PropertyDto, PropertyMappingEntryDto, PropertyValueDto, ReferenceDto, ReferenceKindDto,
    ReferenceOriginDto, ResolutionDto, SeverityDto, SpanDto, SpannedPropertyValueDto, SubpathDto,
    TagDto,
};
