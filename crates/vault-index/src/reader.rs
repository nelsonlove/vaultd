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
//! The whole-vault resolver a resolving read needs is shared by every reader
//! of one service ([`ResolverSlot`]) and built lazily, once per generation,
//! by the first resolving read of that generation: it copies the resolution
//! catalog out of the live graph under the guard, releases the guard, and
//! builds and installs the resolver outside it. The writer never builds one,
//! so a publication's cost does not depend on whether anyone resolves, and a
//! publication never waits for a build. A second read of the same generation
//! that meets the build in flight waits for it with no lock held.
//!
//! Lock order is always `publication barrier -> reader connection`,
//! `publication barrier -> resolver slot` and
//! `evaluation pool` (taken alone, before the barrier). The connection,
//! resolver slot and pool locks are leaves: none is ever held while acquiring
//! anything else. The writer never takes the resolver slot. Poisoning surfaces as `IndexError::Storage`; nothing here
//! unwraps a lock.

use std::sync::{Arc, Condvar, Mutex, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

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

/// How long a reader waits for another read's build in flight before it
/// builds its own resolver. A build for a 10k-note vault takes milliseconds
/// in release; this bound only matters if the building thread died.
const BUILD_PATIENCE: Duration = Duration::from_secs(2);

/// What the resolver over every note and base in the published live graph is
/// built from: copied under the guard, so the build itself can run outside
/// it.
fn resolution_catalog(graph: &crate::LiveGraph) -> Vec<vault_core::ResolutionNote> {
    let mut catalog: Vec<vault_core::ResolutionNote> = graph
        .note_paths()
        .into_iter()
        .filter_map(|path| {
            graph.note(&path).map(|note| vault_core::ResolutionNote {
                path,
                headings: note.headings,
                blocks: note.blocks,
                views: None,
            })
        })
        .collect();
    catalog.extend(
        graph
            .base_paths()
            .filter_map(|path| graph.base_identity(path)),
    );
    catalog
}

#[derive(Default)]
struct SlotState {
    /// The generation a read is building the resolver for, set by that read
    /// under the publication guard.
    building: Option<Generation>,
    resolver: Option<(Generation, Arc<Resolver>)>,
}

/// The resolver for the published generation, shared by every reader of one
/// service and built by the first resolving read of each generation: see the
/// module comment.
#[derive(Default)]
pub(crate) struct ResolverSlot {
    state: Mutex<SlotState>,
    settled: Condvar,
}

impl ResolverSlot {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, SlotState>, IndexError> {
        self.state
            .lock()
            .map_err(|error| IndexError::Storage(format!("resolver slot is poisoned: {error}")))
    }

    /// Install a resolver built for `generation` (unless a newer one is
    /// already there) and end any build for it.
    fn settle(&self, generation: Generation, resolver: Option<Arc<Resolver>>) {
        if let Ok(mut state) = self.lock() {
            if let Some(resolver) = resolver {
                let newer_present = state
                    .resolver
                    .as_ref()
                    .is_some_and(|(present, _)| *present > generation);
                if !newer_present {
                    state.resolver = Some((generation, resolver));
                }
            }
            if state.building == Some(generation) {
                state.building = None;
            }
        }
        self.settled.notify_all();
    }

    #[cfg(test)]
    fn generation(&self) -> Option<Generation> {
        self.lock()
            .ok()
            .and_then(|state| state.resolver.as_ref().map(|(generation, _)| *generation))
    }
}

/// A snapshot-consistent view of one published generation: query methods
/// live in `query.rs`, the locking discipline lives here.
pub struct IndexReader {
    config: IndexConfig,
    connection: Mutex<Connection>,
    published: PublicationBarrier,
    /// The resolver for the published generation, shared with every other
    /// reader of the service and built by the first resolving read of each
    /// generation.
    resolvers: Arc<ResolverSlot>,
    pause: Option<PauseHook>,
    resolver_build_pause: Option<PauseHook>,
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
        resolvers: Arc<ResolverSlot>,
    ) -> Result<Self, IndexError> {
        Ok(Self {
            config: config.clone(),
            connection: Mutex::new(crate::schema::open_reader(config)?),
            published,
            resolvers,
            pause: None,
            resolver_build_pause: None,
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

    /// Copy what a caller needs out of the published live graph, under the
    /// publication guard and for no longer: no SQL runs, and no handle on the
    /// graph escapes (the copy is `Arc` clones of parsed bases, or less).
    pub(crate) fn copy_from_graph<T>(
        &self,
        copy: impl FnOnce(&crate::LiveGraph) -> T,
    ) -> Result<(Generation, T), IndexError> {
        let published = read_published(&self.published)?;
        let generation = published.generation.ok_or(IndexError::IndexUnavailable)?;
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
        Ok((generation, copy(graph)))
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

    /// How many idle private connections the pool holds. Test-only: it is
    /// what pins that every evaluation path, the refusals included, returns
    /// its connection.
    #[doc(hidden)]
    pub fn evaluation_pool_len_for_test(&self) -> usize {
        self.evaluation_connections
            .lock()
            .map(|pool| pool.len())
            .unwrap_or(0)
    }

    /// Open and drop one evaluation read pinned to `expected`, answering the
    /// generation it pinned or the refusal. Test-only: a refusal at a
    /// generation the writer moved past is otherwise reachable only through a
    /// race.
    #[doc(hidden)]
    pub fn open_evaluation_for_test(&self, expected: u64) -> Result<u64, IndexError> {
        self.evaluation_read(Generation::new(expected), |_| ())
            .map(|(read, ())| read.generation.get())
    }

    /// Pause a resolving read that builds the resolver for its generation,
    /// after it has copied the catalog and released the publication guard,
    /// just before it builds. Test-only: it is what lets a test prove that a
    /// publication, and a second read of the same generation, do not need the
    /// build to finish (the publication) or wait for it rather than build
    /// again (the read).
    #[doc(hidden)]
    pub fn pause_resolver_builds_for_test(&mut self, hook: PauseHook) {
        self.resolver_build_pause = Some(hook);
    }

    /// The resolver for the published generation, shared by every reader of
    /// the service (see the module comment).
    ///
    /// Taken under the guard when it is already built for the published
    /// generation. Otherwise the first resolving read of that generation
    /// claims the build, copies the resolution catalog out of the live graph
    /// under the guard, releases the guard, builds the resolver from the copy
    /// and installs it for that generation; the writer never builds one, so
    /// a publication never waits for a build. A second read of the same
    /// generation meeting that build waits for it with no lock held, once per
    /// generation (it remembers the generation it waited for, so a build
    /// that never settles makes it build its own rather than wait again).
    pub(crate) fn resolver(&self) -> Result<(Generation, Arc<Resolver>), IndexError> {
        let mut waited_for: Option<Generation> = None;
        loop {
            let published = read_published(&self.published)?;
            let generation = published.generation.ok_or(IndexError::IndexUnavailable)?;
            let mut state = self.resolvers.lock()?;
            if let Some((built, resolver)) = state.resolver.as_ref() {
                if *built == generation {
                    return Ok((generation, Arc::clone(resolver)));
                }
            }
            if state.building == Some(generation) && waited_for != Some(generation) {
                // Never wait under the guard: the build needs no guard to
                // finish, but the next publication does.
                drop(published);
                let _settled = self
                    .resolvers
                    .settled
                    .wait_timeout_while(state, BUILD_PATIENCE, |state| {
                        state.building == Some(generation)
                    })
                    .map_err(|error| {
                        IndexError::Storage(format!("resolver slot is poisoned: {error}"))
                    })?;
                waited_for = Some(generation);
                continue;
            }
            state.building = Some(generation);
            drop(state);

            // Copy under the guard (the graph `Arc` never escapes it: the
            // writer installs a delta by mutating the graph in place while it
            // is the sole owner), build outside it.
            let catalog = published
                .graph
                .as_deref()
                .ok_or(IndexError::IndexUnavailable)
                .and_then(|graph| {
                    if graph.generation() == generation {
                        Ok(resolution_catalog(graph))
                    } else {
                        Err(IndexError::Storage(format!(
                            "published live graph is at generation {} but the published generation is {}",
                            graph.generation().get(),
                            generation.get()
                        )))
                    }
                });
            drop(published);
            let catalog = match catalog {
                Ok(catalog) => catalog,
                Err(error) => {
                    self.resolvers.settle(generation, None);
                    return Err(error);
                }
            };
            if let Some(hook) = &self.resolver_build_pause {
                hook();
            }
            let resolver = Arc::new(Resolver::from_catalog(catalog));
            self.resolvers
                .settle(generation, Some(Arc::clone(&resolver)));
            return Ok((generation, resolver));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_settled_resolver_is_never_replaced_by_an_older_one() {
        let slot = ResolverSlot::default();
        let resolver = Arc::new(Resolver::from_catalog(Vec::new()));
        slot.settle(Generation::new(3), Some(Arc::clone(&resolver)));
        slot.settle(Generation::new(2), Some(resolver));
        assert_eq!(slot.generation(), Some(Generation::new(3)));
    }

    #[test]
    fn settling_ends_only_the_build_for_its_own_generation() {
        let slot = ResolverSlot::default();
        slot.lock().unwrap().building = Some(Generation::new(3));
        slot.settle(Generation::new(2), None);
        assert_eq!(slot.lock().unwrap().building, Some(Generation::new(3)));
        slot.settle(Generation::new(3), None);
        assert_eq!(slot.lock().unwrap().building, None);
    }
}
