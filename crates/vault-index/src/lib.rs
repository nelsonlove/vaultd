mod codec;
mod config;
mod cursor;
mod error;
mod inventory;
mod lease;
mod live_graph;
mod live_reconcile;
mod metrics;
mod model;
mod mutate;
mod query;
mod reader;
mod reconcile;
mod schema;
mod snapshot;
mod store;
mod test_hook;

pub use config::{IndexConfig, IndexLocation};
pub use error::IndexError;
pub use inventory::{FileSystemIndexSource, InventoryEntry, InventorySnapshot, ReconcileSource};
pub use lease::IndexLease;
pub use live_graph::{
    HydratedNote, HydratedReference, ImpactPlan, LiveGraph, NoteId, PreparedGraphDelta,
    ReferenceKey,
};
pub use live_reconcile::{ChangeCause, LiveRefreshReport, NoteChangeCounts, PathChanges};
pub use metrics::{ReconcileMetrics, StageDurations, WorkCounts};
pub use model::{
    FileFingerprint, Generation, IndexState, LiveState, PublicationBarrier, PublishedState,
    PublishedStatus,
};
pub use mutate::{
    CONFIG_ZONE, CopyConflict, DEFAULT_MAX_FILE_BYTES, DeleteMode, FrontmatterEdit, IoKind,
    LOCAL_TRASH, LinkRewriteFailure, LinkRewriteReason, Mutation, MutationEngine, MutationError,
    MutationOutcome, PatchValue, Precondition, Reservation, in_config_zone, is_unindexable,
    is_unindexable_folder, patch_source, revision_of,
};
pub use query::{
    DEFAULT_PAGE_LIMIT, IndexedNote, MAX_PAGE_LIMIT, NoteSummary, Page, ReferenceStatus,
    StructuralFacets, VaultInfo,
};
pub use reader::IndexReader;
#[doc(hidden)]
pub use reader::PauseHook;
pub use reconcile::{IndexService, RefreshReport};
pub use schema::{SEMANTIC_FORMAT_VERSION, SQL_SCHEMA_VERSION};
pub use snapshot::{
    ListItemRow, NoteFacets, NotesPage, OpenSnapshot, SectionRow, SnapshotMetadata,
    SnapshotNoteRow, SnapshotSessions, TreeEntryKind, TreeEntryRow, TreePage,
};
pub use store::{
    DeltaPublication, DeltaPublishOutcome, DeltaPublishTimings, DeltaWriteCounts, IndexStore,
    NoteReplacement, ResolutionReplacement, StoredTreeEntry, TreeDelta,
};
#[doc(hidden)]
pub use test_hook::{HookPoint, TestHook};

#[doc(hidden)]
pub fn open_index_for_test(config: &IndexConfig) -> Result<rusqlite::Connection, IndexError> {
    schema::open_connection(config)
}

/// Open a query-only handle the way `IndexReader` does, so tests can prove
/// what that path refuses: creating a cache, and writing through it.
#[doc(hidden)]
pub fn open_reader_for_test(config: &IndexConfig) -> Result<rusqlite::Connection, IndexError> {
    schema::open_reader(config)
}

/// Decode a stored `(dependency_kind, comparison_key)` pair back into a
/// `vault_core::DependencyKey`, so tests can prove stored dependency rows
/// equal a fresh `vault_core::reference_dependencies` computation without
/// duplicating the crate's private string encoding.
#[doc(hidden)]
pub fn decode_dependency_key_for_test(
    kind: &str,
    comparison_key: &str,
) -> Result<vault_core::DependencyKey, IndexError> {
    codec::decode_dependency_key(kind, comparison_key)
}
