mod codec;
mod config;
mod error;
mod inventory;
mod model;
mod schema;
mod store;

pub use config::{IndexConfig, IndexLocation};
pub use error::IndexError;
pub use inventory::{FileSystemIndexSource, InventoryEntry, InventorySnapshot, ReconcileSource};
pub use model::{FileFingerprint, Generation};
pub use schema::{SEMANTIC_FORMAT_VERSION, SQL_SCHEMA_VERSION};
pub use store::IndexStore;

#[doc(hidden)]
pub fn open_index_for_test(config: &IndexConfig) -> Result<rusqlite::Connection, IndexError> {
    schema::open_connection(config)
}
