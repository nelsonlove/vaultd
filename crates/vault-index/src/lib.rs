mod config;
mod error;
mod model;
mod schema;

pub use config::{IndexConfig, IndexLocation};
pub use error::IndexError;
pub use model::Generation;
pub use schema::{SEMANTIC_FORMAT_VERSION, SQL_SCHEMA_VERSION};

#[doc(hidden)]
pub fn open_index_for_test(config: &IndexConfig) -> Result<rusqlite::Connection, IndexError> {
    schema::open_connection(config)
}
