use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::config::{IndexConfig, IndexLocation};
use crate::error::IndexError;

pub const SQL_SCHEMA_VERSION: u32 = 2;
pub const SEMANTIC_FORMAT_VERSION: u32 = 2;

const SCHEMA_V2: &str = include_str!("schema_v2.sql");

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
    // Parent-directory creation lives in `IndexConfig::prepare_storage`,
    // which every production open runs before this: by the time a real
    // writer reaches here, the directory exists, is canonicalized, and has
    // already been checked against the vault root. Direct test-only entry
    // points that skip `prepare_storage` are expected to pass a path whose
    // parent already exists.
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
    if crate::error::is_lock_contention(&error) {
        return OpenIssue::Fatal(IndexError::Busy(error.to_string()));
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

/// Open a query-only handle on an existing cache.
///
/// Unlike `open_connection` this never creates, initializes, rebuilds, or
/// deletes anything: a missing, corrupt, obsolete, or foreign cache is an
/// error, because a reader has no authority to decide a cache's fate. The
/// handle is opened read/write at the OS level (WAL readers must be able to
/// write the `-shm` index) but is pinned `query_only`, so no statement
/// issued through it can modify the database.
pub(crate) fn open_reader(config: &IndexConfig) -> Result<Connection, IndexError> {
    let connection = Connection::open_with_flags(
        &config.index_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| IndexError::Storage(error.to_string()))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;

    let user_version: u32 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !has_metadata_table(&connection)? {
        return Err(IndexError::IncompatibleIndex(
            "index database has no metadata table".into(),
        ));
    }
    let (semantic_version, identity): (u32, String) = connection.query_row(
        "SELECT semantic_format_version, vault_identity FROM index_metadata WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if identity != config.vault_identity {
        return Err(IndexError::IncompatibleIndex(
            "index belongs to another vault".into(),
        ));
    }
    if user_version != SQL_SCHEMA_VERSION || semantic_version != SEMANTIC_FORMAT_VERSION {
        return Err(IndexError::IncompatibleIndex(format!(
            "index is at SQL version {user_version} semantic version {semantic_version}, \
             expected {SQL_SCHEMA_VERSION}/{SEMANTIC_FORMAT_VERSION}"
        )));
    }

    // Last, so the validation reads above still run against a database that
    // needs no recovery: from here on the handle cannot write at all.
    connection.pragma_update(None, "query_only", "ON")?;
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
    connection.execute_batch(SCHEMA_V2)?;
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
