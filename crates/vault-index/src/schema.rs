use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::config::IndexConfig;
use crate::error::IndexError;

pub const SQL_SCHEMA_VERSION: u32 = 1;
pub const SEMANTIC_FORMAT_VERSION: u32 = 1;

const SCHEMA_V1: &str = include_str!("schema_v1.sql");

pub(crate) fn now_unix_ms() -> Result<i64, IndexError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| IndexError::Storage(error.to_string()))?;
    i64::try_from(elapsed.as_millis())
        .map_err(|_| IndexError::Storage("current time exceeds the epoch range".into()))
}

/// Open the index database at the configured path, creating the schema when
/// the database is new and validating versions and vault identity otherwise.
pub(crate) fn open_connection(config: &IndexConfig) -> Result<Connection, IndexError> {
    if let Some(parent) = config.index_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(&config.index_path)?;
    configure(&connection)?;

    let user_version: u32 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version == 0 && !has_metadata_table(&connection)? {
        initialize(&connection, config)?;
    } else {
        validate(&connection, config, user_version)?;
    }
    Ok(connection)
}

fn configure(connection: &Connection) -> Result<(), IndexError> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

fn has_metadata_table(connection: &Connection) -> Result<bool, IndexError> {
    let count: u32 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'index_metadata'",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn initialize(connection: &Connection, config: &IndexConfig) -> Result<(), IndexError> {
    connection.execute_batch(SCHEMA_V1)?;
    connection.pragma_update(None, "user_version", SQL_SCHEMA_VERSION)?;
    connection.execute(
        "INSERT INTO index_metadata \
         (singleton, semantic_format_version, vault_identity, generation, created_at_unix_ms) \
         VALUES (1, ?1, ?2, NULL, ?3)",
        rusqlite::params![
            SEMANTIC_FORMAT_VERSION,
            config.vault_identity,
            now_unix_ms()?
        ],
    )?;
    connection.execute_batch("PRAGMA optimize;")?;
    Ok(())
}

fn validate(
    connection: &Connection,
    config: &IndexConfig,
    user_version: u32,
) -> Result<(), IndexError> {
    if user_version != SQL_SCHEMA_VERSION {
        return Err(IndexError::IncompatibleIndex(format!(
            "sql schema version {user_version} does not match {SQL_SCHEMA_VERSION}"
        )));
    }
    let (semantic_version, identity): (u32, String) = connection
        .query_row(
            "SELECT semantic_format_version, vault_identity FROM index_metadata WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| IndexError::IncompatibleIndex(format!("missing metadata: {error}")))?;
    if semantic_version != SEMANTIC_FORMAT_VERSION {
        return Err(IndexError::IncompatibleIndex(format!(
            "semantic format version {semantic_version} does not match {SEMANTIC_FORMAT_VERSION}"
        )));
    }
    if identity != config.vault_identity {
        return Err(IndexError::IncompatibleIndex(
            "index belongs to another vault".into(),
        ));
    }
    Ok(())
}
