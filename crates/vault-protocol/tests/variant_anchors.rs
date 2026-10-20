//! Exhaustiveness anchors for the open-ended wire enums (checkpoint-1 I2).
//!
//! Every enum below pairs a derived `Serialize` with a hand-written tolerant
//! `Deserialize`, maintained independently. Nothing else in the suite forces
//! the decoder to grow when a variant is added: the server would emit the new
//! spelling and its own clients would silently degrade it to `Unknown`, suite
//! green. These witnesses make variant addition a **compile error** in this
//! file; the required fix is to extend the matching round-trip table (in
//! `events.rs`, `schema.rs`, `wire_tolerance.rs`, `snapshots.rs`,
//! `bases_wire.rs`, or `search_wire.rs`) with the
//! new variant — never just the match arm here — so the decoder arm and its
//! test land in the same change.

use vault_protocol::{
    DirEntryKindDto, DocumentKindDto, ErrorCode, GenerationCauseDto, LiveStateDto, ResyncReasonDto,
    RuntimeEventDto, TreeEntryKindDto,
};

#[test]
fn every_open_ended_enum_variant_is_anchored_to_a_round_trip_table() {
    fn witness_error_code(code: &ErrorCode) {
        match code {
            ErrorCode::IncompatibleVersion
            | ErrorCode::InvalidRequest
            | ErrorCode::InvalidPath
            | ErrorCode::InvalidCursor
            | ErrorCode::NoteNotFound
            | ErrorCode::IndexUnavailable
            | ErrorCode::GenerationMismatch
            | ErrorCode::VaultChangedDuringRefresh
            | ErrorCode::IncompatibleIndex
            | ErrorCode::StorageFailure
            | ErrorCode::Internal
            | ErrorCode::IndexInUse
            | ErrorCode::WatchUnavailable
            | ErrorCode::SubscriptionNotFound
            | ErrorCode::RuntimeNotReady
            | ErrorCode::RuntimeOverloaded
            | ErrorCode::RevisionConflict
            | ErrorCode::NotFound
            | ErrorCode::ParentNotFound
            | ErrorCode::TargetExists
            | ErrorCode::CaseCollision
            | ErrorCode::ZoneViolation
            | ErrorCode::PayloadTooLarge
            | ErrorCode::ReadOnly
            | ErrorCode::SnapshotNotFound
            | ErrorCode::TooManySnapshots
            // Round-tripped in `bases_wire.rs`.
            | ErrorCode::BaseInvalid
            | ErrorCode::ViewNotFound
            | ErrorCode::ExpressionInvalid
            | ErrorCode::UnsupportedFunction
            // Round-tripped in search_wire.rs.
            | ErrorCode::QueryInvalid
            | ErrorCode::UnsupportedOperator
            | ErrorCode::Unknown => {}
        }
    }
    fn witness_live_state(state: &LiveStateDto) {
        match state {
            LiveStateDto::Starting
            | LiveStateDto::CatchingUp
            | LiveStateDto::Watching
            | LiveStateDto::PollingFallback
            | LiveStateDto::Stopped
            | LiveStateDto::Unknown => {}
        }
    }
    fn witness_cause(cause: &GenerationCauseDto) {
        match cause {
            GenerationCauseDto::Watcher
            | GenerationCauseDto::Startup
            | GenerationCauseDto::Periodic
            | GenerationCauseDto::Manual
            | GenerationCauseDto::Verified
            | GenerationCauseDto::Mutation
            | GenerationCauseDto::Unknown => {}
        }
    }
    fn witness_reason(reason: &ResyncReasonDto) {
        match reason {
            ResyncReasonDto::SubscriberLag
            | ResyncReasonDto::OversizedChangeSet
            | ResyncReasonDto::RuntimeRecovered
            | ResyncReasonDto::WatcherOverflow
            | ResyncReasonDto::RootInvalidated
            | ResyncReasonDto::Unknown => {}
        }
    }
    fn witness_tree_kind(kind: &TreeEntryKindDto) {
        match kind {
            TreeEntryKindDto::Folder
            | TreeEntryKindDto::Note
            | TreeEntryKindDto::File
            | TreeEntryKindDto::Unknown => {}
        }
    }
    fn witness_dir_kind(kind: &DirEntryKindDto) {
        match kind {
            DirEntryKindDto::File
            | DirEntryKindDto::Folder
            | DirEntryKindDto::Symlink
            | DirEntryKindDto::Other
            | DirEntryKindDto::Unknown => {}
        }
    }
    fn witness_document_kind(kind: &DocumentKindDto) {
        match kind {
            DocumentKindDto::Note
            | DocumentKindDto::Canvas
            | DocumentKindDto::File
            | DocumentKindDto::Unknown => {}
        }
    }
    fn witness_event(event: &RuntimeEventDto) {
        match event {
            RuntimeEventDto::GenerationCommitted(_)
            | RuntimeEventDto::RuntimeStateChanged(_)
            | RuntimeEventDto::ResyncRequired(_)
            | RuntimeEventDto::ConfigChanged(_)
            | RuntimeEventDto::ViewsInvalidated(_)
            | RuntimeEventDto::Unknown => {}
        }
    }

    witness_error_code(&ErrorCode::Internal);
    witness_live_state(&LiveStateDto::Watching);
    witness_cause(&GenerationCauseDto::Watcher);
    witness_reason(&ResyncReasonDto::SubscriberLag);
    witness_tree_kind(&TreeEntryKindDto::Note);
    witness_dir_kind(&DirEntryKindDto::Symlink);
    witness_document_kind(&DocumentKindDto::Note);
    witness_event(&RuntimeEventDto::Unknown);
}
