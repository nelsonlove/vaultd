mod codec;
mod config;
mod cursor;
mod error;
mod inventory;
mod live_graph;
mod metrics;
mod model;
mod query;
mod reconcile;
mod schema;
mod store;

pub use config::{IndexConfig, IndexLocation};
pub use error::IndexError;
pub use inventory::{FileSystemIndexSource, InventoryEntry, InventorySnapshot, ReconcileSource};
pub use live_graph::{
    HydratedNote, HydratedReference, ImpactPlan, LiveGraph, NoteId, PreparedGraphDelta,
    ReferenceKey,
};
pub use metrics::{ReconcileMetrics, StageDurations, WorkCounts};
pub use model::{FileFingerprint, Generation, IndexState};
pub use query::{
    DEFAULT_PAGE_LIMIT, IndexedNote, MAX_PAGE_LIMIT, NoteSummary, Page, ReferenceStatus, VaultInfo,
};
pub use reconcile::{IndexService, RefreshReport};
pub use schema::{SEMANTIC_FORMAT_VERSION, SQL_SCHEMA_VERSION};
pub use store::IndexStore;

#[doc(hidden)]
pub fn open_index_for_test(config: &IndexConfig) -> Result<rusqlite::Connection, IndexError> {
    schema::open_connection(config)
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
