//! Generation-consistent reads.
//!
//! An `IndexReader` owns its own query-only SQLite handle and a shared
//! handle on the publication barrier. Every query runs the same sequence:
//!
//! 1. acquire the publication read guard;
//! 2. lock the reader connection;
//! 3. begin a SQLite read transaction;
//! 4. read the generation inside that transaction;
//! 5. require equality with the guard's generation;
//! 6. run the complete query and drop the transaction;
//! 7. release both locks.
//!
//! Steps 1 and 5 are what make a read generation-consistent. A writer may
//! be writing rows the whole time a read runs — those writes are
//! uncommitted and invisible — but it cannot *commit* them, because a
//! publication takes the same barrier exclusively to commit and install.
//! So the rows cannot move under a read. The equality check catches the one
//! case the barrier cannot cover — a *different process* publishing into
//! the same cache file — and refuses to answer rather than mixing a foreign
//! generation's rows with this process's live graph.
//!
//! A long read (a base evaluation) takes an eighth shape instead, so that it
//! never holds the guard or the shared connection while it runs: check out a
//! private query-only connection from the reader's pool (step 0, before the
//! guard); take the guard; begin a deferred transaction on the private
//! connection and read the generation (which pins its WAL snapshot); require
//! equality; copy out of the live graph the little the read needs (an `Arc`
//! clone of a parsed base, a `bool`), never the graph itself; release the
//! guard; then run the whole read on the private connection, which keeps
//! seeing the pinned generation's rows while the writer commits and installs
//! newer ones; roll back and return the connection to the pool.
//!
//! Lock order is always `publication barrier -> reader connection`,
//! `publication barrier -> resolver cache` and
//! `evaluation pool` (taken alone, before the barrier). The connection,
//! resolver and pool locks are leaves: none is ever held while acquiring
//! anything else, and the writer never takes any of them. Poisoning surfaces
//! as `IndexError::Storage`; nothing here unwraps a lock.

use std::sync::{Arc, Mutex, RwLockReadGuard, RwLockWriteGuard};

use rusqlite::{Connection, Transaction};
use vault_core::Resolver;

use crate::config::IndexConfig;
use crate::error::IndexError;
use crate::model::{Generation, PublicationBarrier, PublishedState, PublishedStatus};

/// A test-only rendezvous callback. Production code never installs one, so
/// the only cost on a real read or publication is one `Option` check.
#[doc(hidden)]
pub type PauseHook = Arc<dyn Fn() + Send + Sync>;

pub(crate) fn read_published(
    barrier: &PublicationBarrier,
) -> Result<RwLockReadGuard<'_, PublishedState>, IndexError> {
    barrier
        .read()
        .map_err(|error| IndexError::Storage(format!("publication barrier is poisoned: {error}")))
}

pub(crate) fn write_published(
    barrier: &PublicationBarrier,
) -> Result<RwLockWriteGuard<'_, PublishedState>, IndexError> {
    barrier
        .write()
        .map_err(|error| IndexError::Storage(format!("publication barrier is poisoned: {error}")))
}

const GENERATION_SQL: &str = "SELECT generation FROM index_metadata WHERE singleton = 1";

/// A snapshot-consistent view of one published generation: query methods
/// live in `query.rs`, the locking discipline lives here.
pub struct IndexReader {
    config: IndexConfig,
    connection: Mutex<Connection>,
    published: PublicationBarrier,
    /// The resolver for the currently published generation, built once per
    /// generation from the published live graph's own note identities. Not
    /// shared with the writer: a reader that never resolves never builds
    /// one.
    resolver: Mutex<Option<(Generation, Arc<Resolver>)>>,
    pause: Option<PauseHook>,
    /// Private query-only connections for long reads (base evaluations), so
    /// one never holds `connection` and never holds the publication guard
    /// while it runs. A leaf lock, held only to check one out or back in.
    evaluation_connections: Mutex<Vec<Connection>>,
    evaluation_pause: Option<PauseHook>,
}

/// How many idle private connections a reader keeps for evaluations. More
/// may be open at once; the ones past this are closed when they finish.
const EVALUATION_POOL: usize = 4;

/// A long read pinned to one generation on a private connection, opened by
/// [`IndexReader::evaluation_read`]. Dropping it rolls the transaction back
/// and returns the connection to the pool; a connection whose rollback
/// fails is closed instead.
pub(crate) struct EvaluationRead<'r> {
    reader: &'r IndexReader,
    connection: Option<Connection>,
    /// Whether `BEGIN` ran, so drop knows a `ROLLBACK` is owed.
    open: bool,
    pub(crate) generation: Generation,
}

impl EvaluationRead<'_> {
    pub(crate) fn connection(&self) -> &Connection {
        self.connection
            .as_ref()
            .expect("the connection is only taken on drop")
    }
}

impl Drop for EvaluationRead<'_> {
    fn drop(&mut self) {
        let Some(connection) = self.connection.take() else {
            return;
        };
        if self.open && connection.execute_batch("ROLLBACK").is_err() {
            return;
        }
        self.reader.return_evaluation_connection(connection);
    }
}

impl std::fmt::Debug for IndexReader {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IndexReader")
            .field("index_path", &self.config.index_path)
            .finish_non_exhaustive()
    }
}

impl IndexReader {
    pub(crate) fn open(
        config: &IndexConfig,
        published: PublicationBarrier,
    ) -> Result<Self, IndexError> {
        Ok(Self {
            config: config.clone(),
            connection: Mutex::new(crate::schema::open_reader(config)?),
            published,
            resolver: Mutex::new(None),
            pause: None,
            evaluation_connections: Mutex::new(Vec::new()),
            evaluation_pause: None,
        })
    }

    pub(crate) fn config(&self) -> &IndexConfig {
        &self.config
    }

    /// The publication state as of this instant, without the live graph:
    /// the published generation, the installed graph's generation, the
    /// runtime's live state, and its last runtime error. The copy-free way
    /// to observe publication — prefer it to `published_state`.
    pub fn published_status(&self) -> Result<PublishedStatus, IndexError> {
        Ok(read_published(&self.published)?.status())
    }

    /// A full copy of the publication state, live graph handle included.
    ///
    /// The returned handle co-owns the graph: while it is alive the writer
    /// is no longer the graph's sole owner, so the next delta install has to
    /// copy the whole graph instead of mutating it in place. Use
    /// `published_status` unless the graph itself is genuinely needed, and
    /// drop the handle as soon as it is not.
    pub fn published_state(&self) -> Result<PublishedState, IndexError> {
        Ok(read_published(&self.published)?.clone())
    }

    /// Pause every read this reader performs at step 1/2 — after the
    /// publication read guard is held, before the connection is locked.
    /// Test-only; the hook is what lets a test hold the barrier open while
    /// a writer tries to publish.
    #[doc(hidden)]
    pub fn pause_reads_for_test(&mut self, hook: PauseHook) {
        self.pause = Some(hook);
    }

    /// Run `query` against one published generation, following the seven
    /// steps documented at the top of this module.
    pub(crate) fn read<T>(
        &self,
        query: impl FnOnce(&Transaction<'_>, Generation) -> Result<T, IndexError>,
    ) -> Result<T, IndexError> {
        let published = read_published(&self.published)?;
        let generation = published.generation.ok_or(IndexError::IndexUnavailable)?;
        if let Some(hook) = &self.pause {
            hook();
        }

        let connection = self.connection.lock().map_err(|error| {
            IndexError::Storage(format!("reader connection is poisoned: {error}"))
        })?;
        // A deferred read transaction: its first read pins a WAL snapshot
        // for every statement that follows, so the generation checked below
        // is the generation the rest of the query reads from.
        let transaction = connection.unchecked_transaction()?;
        let stored: Option<i64> = transaction.query_row(GENERATION_SQL, [], |row| row.get(0))?;
        let stored = stored.map(Generation::from_db).transpose()?;
        if stored != Some(generation) {
            // A writer this process does not own moved the cache. Refusing is
            // correct — answering would mix a foreign generation's rows with
            // this process's live graph — and it is curable, by
            // `IndexService::resync_published`. Typed as such so a caller can
            // tell "run resync" apart from "storage is damaged".
            return Err(IndexError::LiveStateStale(format!(
                "stored generation {} does not match the published generation {}",
                stored.map_or_else(|| "none".to_string(), |value| value.get().to_string()),
                generation.get()
            )));
        }

        let answer = query(&transaction, generation);
        // Read-only: nothing to commit, and dropping rolls back a
        // transaction that wrote nothing.
        drop(transaction);
        drop(connection);
        drop(published);
        answer
    }

    /// Pause every evaluation this reader starts right after it has released
    /// the publication guard and before it evaluates. Test-only; the hook is
    /// what lets a test prove that a publication, or another read on this
    /// reader, completes while an evaluation is in flight.
    #[doc(hidden)]
    pub fn pause_evaluations_for_test(&mut self, hook: PauseHook) {
        self.evaluation_pause = Some(hook);
    }

    /// Open a long read on a private connection, pinned to the published
    /// generation: the eighth shape at the top of this module.
    ///
    /// Under the publication guard and only there: the generation must equal
    /// `expected` (the resolver's), the private connection begins a deferred
    /// transaction and reads the stored generation (which pins its WAL
    /// snapshot) and must find the guard's, and `under_guard` copies out of
    /// the live graph what the caller needs. Then the guard is released, and
    /// the returned [`EvaluationRead`] keeps reading that generation's rows
    /// while the writer commits and installs newer ones.
    pub(crate) fn evaluation_read<T>(
        &self,
        expected: Generation,
        under_guard: impl FnOnce(&crate::LiveGraph) -> T,
    ) -> Result<(EvaluationRead<'_>, T), IndexError> {
        // The checkout (and an open, when the pool is empty) happens before
        // the guard: opening a connection checks the cache's metadata, which
        // a publication never needs to wait for.
        let mut read = EvaluationRead {
            reader: self,
            connection: Some(self.check_out_evaluation_connection()?),
            open: false,
            generation: expected,
        };
        let published = read_published(&self.published)?;
        let generation = published.generation.ok_or(IndexError::IndexUnavailable)?;
        if generation != expected {
            return Err(IndexError::LiveStateStale(format!(
                "the resolver is at {} but the publication is at {}",
                expected.get(),
                generation.get()
            )));
        }
        let graph = published
            .graph
            .as_deref()
            .ok_or(IndexError::IndexUnavailable)?;
        if graph.generation() != generation {
            return Err(IndexError::LiveStateStale(format!(
                "the published graph is at {} but the publication is at {}",
                graph.generation().get(),
                generation.get()
            )));
        }
        read.connection().execute_batch("BEGIN DEFERRED")?;
        read.open = true;
        let stored: Option<i64> = read
            .connection()
            .query_row(GENERATION_SQL, [], |row| row.get(0))?;
        let stored = stored.map(Generation::from_db).transpose()?;
        if stored != Some(generation) {
            return Err(IndexError::LiveStateStale(format!(
                "stored generation {} does not match the published generation {}",
                stored.map_or_else(|| "none".to_string(), |value| value.get().to_string()),
                generation.get()
            )));
        }
        let extracted = under_guard(graph);
        drop(published);
        if let Some(hook) = &self.evaluation_pause {
            hook();
        }
        Ok((read, extracted))
    }

    fn check_out_evaluation_connection(&self) -> Result<Connection, IndexError> {
        let pooled = self
            .evaluation_connections
            .lock()
            .map_err(|error| {
                IndexError::Storage(format!("evaluation connection pool is poisoned: {error}"))
            })?
            .pop();
        match pooled {
            Some(connection) => Ok(connection),
            None => crate::schema::open_reader(&self.config),
        }
    }

    fn return_evaluation_connection(&self, connection: Connection) {
        if let Ok(mut pool) = self.evaluation_connections.lock() {
            if pool.len() < EVALUATION_POOL {
                pool.push(connection);
            }
        }
    }

    /// The resolver for the published generation, built from the published
    /// live graph rather than from SQL.
    ///
    /// The graph `Arc` deliberately never escapes the read guard here: the
    /// writer installs a delta by mutating the published graph in place
    /// (which is only possible while it is the sole owner), so a handle kept
    /// alive past the guard would force the writer into a whole-graph copy.
    /// No reader other than `published_state` lets the `Arc` escape; a
    /// caller that holds one pays a whole-graph copy on the next install.
    /// Building the resolver under the guard costs one pass over the note
    /// identities, once per generation per reader.
    pub(crate) fn resolver(&self) -> Result<(Generation, Arc<Resolver>), IndexError> {
        let published = read_published(&self.published)?;
        let generation = published.generation.ok_or(IndexError::IndexUnavailable)?;
        let mut cache = self
            .resolver
            .lock()
            .map_err(|error| IndexError::Storage(format!("resolver cache is poisoned: {error}")))?;
        if let Some((cached, resolver)) = cache.as_ref() {
            if *cached == generation {
                return Ok((generation, Arc::clone(resolver)));
            }
        }

        let graph = published
            .graph
            .as_ref()
            .ok_or(IndexError::IndexUnavailable)?;
        if graph.generation() != generation {
            return Err(IndexError::Storage(format!(
                "published live graph is at generation {} but the published generation is {}",
                graph.generation().get(),
                generation.get()
            )));
        }
        let notes = graph.note_paths().into_iter().filter_map(|path| {
            graph.note(&path).map(|note| vault_core::ResolutionNote {
                path,
                headings: note.headings,
                blocks: note.blocks,
                views: None,
            })
        });
        let bases: Vec<vault_core::ResolutionNote> = graph
            .base_paths()
            .filter_map(|path| graph.base_identity(path))
            .collect();
        let resolver = Arc::new(Resolver::from_catalog(notes.chain(bases)));
        *cache = Some((generation, Arc::clone(&resolver)));
        Ok((generation, resolver))
    }
}
