use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::config::{IndexConfig, IndexLocation};
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

/// How an open attempt failed, so the recovery policy can distinguish an
/// unreadable database from an obsolete-but-identified one.
enum OpenIssue {
    /// The file is not a readable SQLite database with our metadata.
    Corrupt(String),
    /// Readable, correct vault identity, but obsolete SQL or semantic version.
    Obsolete,
    /// A refusal or failure recovery must not paper over.
    Fatal(IndexError),
}

/// Open the index database, creating the schema when new and applying the
/// recovery policy otherwise: corrupt or obsolete DERIVED caches are rebuilt
/// in place (the vault is never a recovery target); an obsolete explicit
/// index with the right identity is rebuilt as well; a corrupt explicit index
/// or a wrong vault identity is refused.
pub(crate) fn open_connection(config: &IndexConfig) -> Result<Connection, IndexError> {
    if let Some(parent) = config.index_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match try_open(config) {
        Ok(connection) => Ok(connection),
        Err(OpenIssue::Corrupt(message)) => match config.location {
            IndexLocation::Derived => {
                replace_index_file(config)?;
                match try_open(config) {
                    Ok(connection) => Ok(connection),
                    Err(OpenIssue::Fatal(error)) => Err(error),
                    Err(_) => Err(IndexError::Storage(
                        "derived index could not be rebuilt".into(),
                    )),
                }
            }
            IndexLocation::Explicit => Err(IndexError::IncompatibleIndex(message)),
        },
        Err(OpenIssue::Obsolete) => {
            replace_index_file(config)?;
            match try_open(config) {
                Ok(connection) => Ok(connection),
                Err(OpenIssue::Fatal(error)) => Err(error),
                Err(_) => Err(IndexError::Storage(
                    "obsolete index could not be rebuilt".into(),
                )),
            }
        }
        Err(OpenIssue::Fatal(error)) => Err(error),
    }
}

/// Classify an open-time SQLite failure. Lock contention from a concurrent
/// process is retryable storage pressure, never evidence of corruption — a
/// busy healthy cache must not be deleted and rebuilt.
fn open_issue_from(error: rusqlite::Error) -> OpenIssue {
    let lock_contention = matches!(
        &error,
        rusqlite::Error::SqliteFailure(failure, _) if matches!(
            failure.code,
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
        )
    );
    if lock_contention {
        return OpenIssue::Fatal(IndexError::Storage(error.to_string()));
    }
    OpenIssue::Corrupt(error.to_string())
}

fn try_open(config: &IndexConfig) -> Result<Connection, OpenIssue> {
    let connection = Connection::open(&config.index_path)
        .map_err(|error| OpenIssue::Fatal(IndexError::Storage(error.to_string())))?;
    configure(&connection).map_err(open_issue_from)?;

    let user_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(open_issue_from)?;
    let has_metadata = has_metadata_table(&connection).map_err(open_issue_from)?;

    if user_version == 0 && !has_metadata {
        initialize(&connection, config).map_err(OpenIssue::Fatal)?;
        return Ok(connection);
    }
    if !has_metadata {
        return Err(OpenIssue::Corrupt(
            "index database has no metadata table".into(),
        ));
    }

    let (semantic_version, identity): (u32, String) = connection
        .query_row(
            "SELECT semantic_format_version, vault_identity FROM index_metadata \
             WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| match open_issue_from(error) {
            OpenIssue::Corrupt(message) => {
                OpenIssue::Corrupt(format!("missing metadata: {message}"))
            }
            other => other,
        })?;
    if identity != config.vault_identity {
        return Err(OpenIssue::Fatal(IndexError::IncompatibleIndex(
            "index belongs to another vault".into(),
        )));
    }
    if user_version != SQL_SCHEMA_VERSION || semantic_version != SEMANTIC_FORMAT_VERSION {
        return Err(OpenIssue::Obsolete);
    }
    Ok(connection)
}

fn configure(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

fn has_metadata_table(connection: &Connection) -> Result<bool, rusqlite::Error> {
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

/// Replace exactly the configured index file plus its `-wal`/`-shm` sidecars.
/// The target must be the configured index path and must sit outside the
/// canonical vault root; nothing else is ever deleted.
fn replace_index_file(config: &IndexConfig) -> Result<(), IndexError> {
    let target = &config.index_path;
    if target.as_os_str().is_empty() {
        return Err(IndexError::Storage("empty index path".into()));
    }
    let parent_in_vault = target
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .is_some_and(|parent| parent.starts_with(&config.canonical_vault_root));
    if parent_in_vault {
        return Err(IndexError::Storage(
            "refusing to rebuild an index inside the vault".into(),
        ));
    }
    for suffix in ["", "-wal", "-shm"] {
        let mut candidate = target.as_os_str().to_owned();
        candidate.push(suffix);
        let candidate = std::path::PathBuf::from(candidate);
        match std::fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(IndexError::Storage(error.to_string())),
        }
    }
    Ok(())
}
