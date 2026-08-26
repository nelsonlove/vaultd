use std::collections::BTreeSet;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use vault_core::{
    Diagnostic, DiagnosticCode, LinkTarget, ParsedNote, Resolution, ScanError, ScanReport,
    SemanticGraph, Severity, SourceDocument, SourceError, VaultPath, build_graph, parse_note,
};

use crate::config::IndexConfig;
use crate::error::IndexError;
use crate::inventory::{FileSystemIndexSource, InventorySnapshot, ReconcileSource};
use crate::live_graph::{HydratedNote, HydratedReference, LiveGraph};
use crate::metrics::ReconcileMetrics;
use crate::model::{
    FileFingerprint, Generation, IndexState, LiveState, PublicationBarrier, PublishedState,
};
use crate::reader::{IndexReader, PauseHook, write_published};
use crate::store::{BeginOutcome, DeltaPublication, DeltaPublishOutcome, IndexStore, Publication};

const MAX_RECONCILE_RETRIES: usize = 3;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefreshReport {
    pub previous_generation: Option<Generation>,
    pub generation: Generation,
    pub added: u64,
    pub changed: u64,
    pub deleted: u64,
    pub unchanged: u64,
    pub reparsed: u64,
    pub verified: bool,
}

/// The writer. Owns the vault source, the writer's SQLite connection, and
/// the publication barrier; hands out `IndexReader`s that answer from
/// whatever it has last published.
pub struct IndexService {
    pub(crate) config: IndexConfig,
    pub(crate) store: IndexStore,
    pub(crate) source: Box<dyn ReconcileSource>,
    published: PublicationBarrier,
    /// The service's own reader, backing the compatibility query methods in
    /// `query.rs`. A separate query-only connection, exactly like one a
    /// server would own — the writer's connection answers no queries.
    reader: IndexReader,
    /// Test-only pause between the SQLite commit and the live-state
    /// installation, invoked while the publication write guard is held.
    publication_pause: Option<PauseHook>,
    /// Test-only pause after a full publication has written every row but
    /// before it takes the barrier, invoked with NO guard held.
    row_write_pause: Option<PauseHook>,
    last_metrics: Option<ReconcileMetrics>,
}

enum TryOutcome {
    Done(RefreshReport),
    Retry,
}

impl IndexService {
    pub fn open(config: IndexConfig) -> Result<Self, IndexError> {
        let source = FileSystemIndexSource::new(&config.canonical_vault_root)?;
        Self::open_with_source(config, Box::new(source))
    }

    pub fn open_with_source(
        config: IndexConfig,
        source: Box<dyn ReconcileSource>,
    ) -> Result<Self, IndexError> {
        let source_root = source
            .canonical_root()
            .canonicalize()
            .map_err(|error| IndexError::InvalidVaultRoot(error.to_string()))?;
        if source_root != config.canonical_vault_root {
            return Err(IndexError::InvalidVaultRoot(format!(
                "source root {} does not match the configured vault root {}",
                source_root.display(),
                config.canonical_vault_root.display()
            )));
        }
        let store = IndexStore::open(&config)?;
        let published: PublicationBarrier = Arc::new(RwLock::new(PublishedState::starting()));
        seed_published(&store, &published)?;
        let reader = IndexReader::open(&config, Arc::clone(&published))?;
        Ok(Self {
            config,
            store,
            source,
            published,
            reader,
            publication_pause: None,
            row_write_pause: None,
            last_metrics: None,
        })
    }

    pub fn current_generation(&self) -> Result<Option<Generation>, IndexError> {
        self.store.current_generation()
    }

    /// A fresh reader over the same cache and the same publication barrier,
    /// for a server or runtime that owns its reads. Each reader carries its
    /// own query-only connection, so readers never contend with the writer
    /// for a connection lock.
    pub fn reader(&self) -> Result<IndexReader, IndexError> {
        IndexReader::open(&self.config, Arc::clone(&self.published))
    }

    pub(crate) fn reader_handle(&self) -> &IndexReader {
        &self.reader
    }

    /// Record what the live runtime is currently doing. Observational only:
    /// it never changes the published generation or graph.
    pub fn set_live_state(&mut self, state: LiveState) -> Result<(), IndexError> {
        let mut published = write_published(&self.published)?;
        published.live_state = state;
        Ok(())
    }

    /// Record (or clear) the runtime's last error, alongside the state it
    /// was in. Observational only.
    pub fn set_runtime_error(&mut self, error: Option<String>) -> Result<(), IndexError> {
        let mut published = write_published(&self.published)?;
        published.runtime_error = error;
        Ok(())
    }

    /// Pause every publication between its SQLite commit and its live-state
    /// installation, while the publication write guard is held. Test-only:
    /// it is what lets a test prove a read cannot observe the half-installed
    /// generation in between.
    #[doc(hidden)]
    pub fn pause_publication_for_test(&mut self, hook: PauseHook) {
        self.publication_pause = Some(hook);
    }

    /// Pause a full publication once every row is written and its
    /// transaction is open, before the barrier is taken. Test-only: it is
    /// what lets a test prove reads keep answering during the row-writing
    /// window.
    #[doc(hidden)]
    pub fn pause_row_writes_for_test(&mut self, hook: PauseHook) {
        self.row_write_pause = Some(hook);
    }

    pub fn state(&self) -> Result<IndexState, IndexError> {
        let generation = self.current_generation()?;
        let last_error = self.store.last_refresh_error()?;
        Ok(match (generation, last_error) {
            (Some(_), None) => IndexState::Ready,
            (Some(_), Some(last_error)) => IndexState::Stale { last_error },
            (None, last_error) => IndexState::Unavailable { last_error },
        })
    }

    pub fn record_refresh_failure(&mut self, error: &IndexError) -> Result<(), IndexError> {
        self.store.record_refresh_failure(&error.to_string())
    }

    /// Stage timings and structural work counters from the most recent
    /// `refresh` attempt (successful or failed). `None` before the first
    /// call.
    pub fn last_reconcile_metrics(&self) -> Option<&ReconcileMetrics> {
        self.last_metrics.as_ref()
    }

    pub fn refresh(&mut self, verify: bool) -> Result<RefreshReport, IndexError> {
        for _ in 0..MAX_RECONCILE_RETRIES {
            match self.try_refresh(verify)? {
                TryOutcome::Done(report) => return Ok(report),
                TryOutcome::Retry => {}
            }
        }
        Err(IndexError::Storage(
            "concurrent refresh did not stabilize".into(),
        ))
    }

    /// One reconciliation attempt against the current database generation.
    /// Observational instrumentation only: metrics are recorded for both
    /// successful and failed attempts, and their collection can never itself
    /// fail a refresh.
    fn try_refresh(&mut self, verify: bool) -> Result<TryOutcome, IndexError> {
        let mut metrics = ReconcileMetrics::default();
        let outcome = self.try_refresh_body(verify, &mut metrics);
        self.last_metrics = Some(metrics);
        outcome
    }

    /// Reads only added/changed bodies in normal mode and every body in
    /// verified mode; parses only new content revisions; publishes one atomic
    /// compare-and-swap snapshot when anything client-visible changed.
    fn try_refresh_body(
        &mut self,
        verify: bool,
        metrics: &mut ReconcileMetrics,
    ) -> Result<TryOutcome, IndexError> {
        let previous = self.current_generation()?;
        let inventory_start = Instant::now();
        let first = self.source.inventory()?;
        metrics.stages.inventory += inventory_start.elapsed();
        metrics.work.complete_inventories += 1;
        let stored = self.store.stored_fingerprints()?;

        let mut unchanged_paths = Vec::new();
        let mut to_read: Vec<VaultPath> = Vec::new();
        for (path, fingerprint) in &first.entries {
            match stored.get(path) {
                None => to_read.push(path.clone()),
                Some(known) if known == fingerprint => {
                    unchanged_paths.push(path.clone());
                    if verify {
                        to_read.push(path.clone());
                    }
                }
                Some(_) => to_read.push(path.clone()),
            }
        }
        let deleted: Vec<VaultPath> = stored
            .keys()
            .filter(|path| !first.entries.contains_key(*path))
            .cloned()
            .collect();

        let mut diagnostics = first.diagnostics.clone();
        let mut replaced: Vec<(ParsedNote, FileFingerprint)> = Vec::new();
        let mut fingerprint_updates: Vec<(VaultPath, FileFingerprint)> = Vec::new();
        let mut removed: Vec<VaultPath> = deleted.clone();
        let mut added = 0u64;
        let mut changed = 0u64;
        let mut unchanged = unchanged_paths.len() as u64;
        let mut reparsed = 0u64;
        // A path that is merely enumerated does not by itself change client
        // state: an added file that never becomes a usable note must not
        // advance the generation on every refresh. Content replacement,
        // removal, deletion, and the scan-diagnostics diff are the real
        // signals.
        let mut semantic_change = previous.is_none() || !deleted.is_empty();

        for path in &to_read {
            let fingerprint = first.entries[path];
            let stored_fingerprint = stored.get(path).copied();
            let read_start = Instant::now();
            let read_result = self.source.read_bytes(path);
            metrics.stages.body_read += read_start.elapsed();
            metrics.work.body_reads += 1;
            match read_result {
                Ok(bytes) => match SourceDocument::from_utf8(path.clone(), bytes) {
                    Ok(source) => {
                        let stored_revision = if stored_fingerprint.is_some() {
                            self.store.stored_revision(path)?
                        } else {
                            None
                        };
                        if stored_revision.as_deref() == Some(source.revision().as_str()) {
                            if stored_fingerprint != Some(fingerprint) {
                                fingerprint_updates.push((path.clone(), fingerprint));
                                unchanged += 1;
                            }
                        } else {
                            reparsed += 1;
                            metrics.work.notes_reparsed += 1;
                            if stored_fingerprint.is_none() {
                                added += 1;
                            } else {
                                changed += 1;
                            }
                            semantic_change = true;
                            let parse_start = Instant::now();
                            let parsed = parse_note(source);
                            metrics.stages.parse += parse_start.elapsed();
                            metrics.work.affected_references += parsed.references.len() as u64;
                            replaced.push((parsed, fingerprint));
                        }
                    }
                    Err(SourceError::InvalidUtf8 { path, error }) => {
                        diagnostics.push(
                            Diagnostic::new(
                                DiagnosticCode::InvalidUtf8,
                                Severity::Error,
                                error.to_string(),
                            )
                            .with_path(path.clone()),
                        );
                        if stored_fingerprint.is_some() {
                            semantic_change = true;
                            removed.push(path);
                        }
                    }
                },
                Err(ScanError::UnreadableFile { path, message }) => {
                    diagnostics.push(
                        Diagnostic::new(DiagnosticCode::UnreadableFile, Severity::Error, message)
                            .with_path(path.clone()),
                    );
                    if stored_fingerprint.is_some() {
                        semantic_change = true;
                        removed.push(path);
                    }
                }
                Err(ScanError::InaccessibleRoot { message }) => {
                    return Err(IndexError::InvalidVaultRoot(message));
                }
            }
        }

        metrics.work.changed_notes = added + changed;

        if !semantic_change && diagnostics != self.store.load_scan_diagnostics()? {
            semantic_change = true;
        }

        let Some(previous_generation) = previous else {
            return self.publish_snapshot(
                first,
                None,
                replaced,
                removed,
                fingerprint_updates,
                diagnostics,
                RefreshCounts {
                    added,
                    changed,
                    deleted: 0,
                    unchanged,
                    reparsed,
                    verified: verify,
                },
                metrics,
            );
        };

        if !semantic_change {
            self.store.touch(&fingerprint_updates)?;
            self.republish_current(previous_generation)?;
            return Ok(TryOutcome::Done(RefreshReport {
                previous_generation: Some(previous_generation),
                generation: previous_generation,
                added: 0,
                changed: 0,
                deleted: 0,
                unchanged,
                reparsed: 0,
                verified: verify,
            }));
        }

        self.publish_snapshot(
            first,
            Some(previous_generation),
            replaced,
            removed,
            fingerprint_updates,
            diagnostics,
            RefreshCounts {
                added,
                changed,
                deleted: deleted.len() as u64,
                unchanged,
                reparsed,
                verified: verify,
            },
            metrics,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn publish_snapshot(
        &mut self,
        first: InventorySnapshot,
        previous: Option<Generation>,
        replaced: Vec<(ParsedNote, FileFingerprint)>,
        removed: Vec<VaultPath>,
        fingerprint_updates: Vec<(VaultPath, FileFingerprint)>,
        scan_diagnostics: Vec<Diagnostic>,
        counts: RefreshCounts,
        metrics: &mut ReconcileMetrics,
    ) -> Result<TryOutcome, IndexError> {
        let replaced_paths: BTreeSet<VaultPath> = replaced
            .iter()
            .map(|(note, _)| note.source.path().clone())
            .collect();
        let removed_set: BTreeSet<VaultPath> = removed.iter().cloned().collect();

        let mut all_notes: Vec<ParsedNote> =
            replaced.iter().map(|(note, _)| note.clone()).collect();
        for path in first.entries.keys() {
            if replaced_paths.contains(path) || removed_set.contains(path) {
                continue;
            }
            if let Some(note) = self.store.load_note(path)? {
                all_notes.push(note);
            }
        }

        let resolution_start = Instant::now();
        let report = build_graph(all_notes, scan_diagnostics.clone());
        metrics.stages.resolution += resolution_start.elapsed();
        metrics.work.references_resolved += report
            .graph
            .note_paths()
            .into_iter()
            .map(|path| {
                report
                    .graph
                    .outgoing(path)
                    .iter()
                    .filter(|resolved| matches!(resolved.resolution, Resolution::Resolved { .. }))
                    .count() as u64
            })
            .sum::<u64>();

        let inventory_start = Instant::now();
        let second = self.source.inventory()?;
        metrics.stages.inventory += inventory_start.elapsed();
        metrics.work.complete_inventories += 1;
        if first != second {
            return Err(IndexError::VaultChangedDuringRefresh);
        }

        // Write every row of the new snapshot with NO barrier held. The
        // transaction stays open, so under WAL none of it is visible to any
        // other connection yet and readers keep answering at the old
        // generation throughout — a whole-vault rewrite must not freeze
        // reads.
        let pending = match self.store.begin_publish(Publication {
            expected: previous,
            notes: &replaced,
            deleted: &removed,
            fingerprint_updates: &fingerprint_updates,
            graph: &report.graph,
            scan_diagnostics: &scan_diagnostics,
        })? {
            BeginOutcome::Prepared(pending) => pending,
            BeginOutcome::GenerationChanged => return Ok(TryOutcome::Retry),
        };
        if let Some(hook) = &self.row_write_pause {
            hook();
        }

        // Also outside the barrier: everything fallible about the new live
        // state. The generation a successful publication will claim is
        // already fixed by the compare-and-swap above, so the matching graph
        // can be built — and can fail — before the guard is taken.
        let next_generation = pending.generation();
        let prepared = Arc::new(live_graph_from_semantic(next_generation, &report.graph)?);

        // Only now the barrier, and only for the commit plus the install.
        // The commit is the one place a lock is deliberately held across
        // SQLite I/O, because that is the whole point: rows and live graph
        // become visible together or not at all, so no reader can catch a
        // generation whose two halves disagree. The install after it is a
        // pointer swap.
        //
        // Lock order here is SQLite write transaction -> publication
        // barrier, the reverse of a reader's barrier -> SQLite read
        // snapshot. That cannot deadlock: under WAL a reader never waits on
        // a writer, so a reader holding the barrier always makes progress
        // and releases it.
        let mut published = write_published(&self.published)?;
        let (generation, publish_metrics) = pending.commit()?;
        if let Some(hook) = &self.publication_pause {
            hook();
        }
        published.generation = Some(generation);
        published.graph = Some(prepared);
        drop(published);

        metrics.stages.sqlite_write += publish_metrics.sqlite_write;
        metrics.stages.sqlite_commit += publish_metrics.sqlite_commit;
        metrics.work.resolution_rows_written += publish_metrics.graph_write.resolution_rows_written;
        metrics.work.dependency_rows_written += publish_metrics.graph_write.dependency_rows_written;
        metrics.work.diagnostic_rows_written += publish_metrics.graph_write.diagnostic_rows_written;
        Ok(TryOutcome::Done(RefreshReport {
            previous_generation: previous,
            generation,
            added: counts.added,
            changed: counts.changed,
            deleted: counts.deleted,
            unchanged: counts.unchanged,
            reparsed: counts.reparsed,
            verified: counts.verified,
        }))
    }

    /// Apply one delta to both halves of the published state at once: the
    /// row delta to SQLite, the matching graph delta to the published live
    /// graph.
    ///
    /// The graph delta is described by its inputs rather than handed over
    /// pre-prepared, and this method prepares it from the published graph
    /// itself. That is not a convenience: a `PreparedGraphDelta` carries
    /// `NoteId`s allocated by the graph it was prepared from, and each
    /// graph numbers notes by its own build history, so a delta prepared
    /// against any other instance — a fresh hydration of the same
    /// generation included — would install the wrong identities. Preparing
    /// here makes that mistake unrepresentable.
    ///
    /// Same barrier discipline as the full path: the delta is prepared —
    /// every fallible allocation included — before the write guard is taken,
    /// and the guard then spans the commit and the install alone, so both
    /// halves land together or neither does. A lost compare-and-swap leaves
    /// the published graph exactly as it was.
    pub fn publish_delta(
        &mut self,
        publication: DeltaPublication<'_>,
        replacement_notes: &[HydratedNote],
        removed_paths: &[VaultPath],
        replacement_references: &[HydratedReference],
    ) -> Result<DeltaPublishOutcome, IndexError> {
        let expected = publication.expected;
        // The two halves must describe the same change. A caller that fills
        // in one and forgets the other would commit rows and install a graph
        // that disagree — precisely the state this module exists to make
        // unreachable — and no later check would notice, because each half
        // is internally consistent. A debug tripwire, like
        // `LiveGraph::install`'s own: the real guarantee is that callers
        // derive both halves from one change set.
        debug_assert_eq!(
            publication
                .notes
                .iter()
                .map(|replacement| replacement.note.source.path().clone())
                .chain(publication.deleted.iter().cloned())
                .collect::<BTreeSet<VaultPath>>(),
            replacement_notes
                .iter()
                .map(|note| note.path.clone())
                .chain(removed_paths.iter().cloned())
                .collect::<BTreeSet<VaultPath>>(),
            "the row delta and the graph delta must describe the same paths"
        );

        // Prepared outside the barrier. The borrowed handle is released
        // again before the guard is taken, so the writer is once more the
        // graph's only owner when it installs — nothing here forces a copy.
        // Only this method publishes, and it needs `&mut self`, so no other
        // in-process writer can move the published graph in between; a
        // foreign process that moves the *cache* is caught by the
        // compare-and-swap below.
        let delta = {
            let graph = self.published_graph(expected)?;
            graph.prepare_delta(
                expected,
                replacement_notes,
                removed_paths,
                replacement_references,
            )?
        };

        let mut published = write_published(&self.published)?;
        let outcome = self.store.publish_delta(publication)?;
        match outcome {
            DeltaPublishOutcome::Committed { generation, counts } => {
                if let Some(hook) = &self.publication_pause {
                    hook();
                }
                let graph = published
                    .graph
                    .as_mut()
                    .ok_or(IndexError::IndexUnavailable)?;
                // In place whenever the writer is the graph's only owner,
                // which is the ordinary case: readers resolve under the read
                // guard and never let the `Arc` escape it, so a delta never
                // copies the whole graph. No reader other than
                // `IndexReader::published_state` lets the handle escape; a
                // caller that holds one pays a whole-graph copy here. The
                // copy `make_mut` takes then is a correctness fallback, not
                // a normal cost.
                Arc::make_mut(graph).install(delta);
                published.generation = Some(generation);
                drop(published);
                Ok(DeltaPublishOutcome::Committed { generation, counts })
            }
            DeltaPublishOutcome::GenerationChanged => {
                drop(published);
                Ok(DeltaPublishOutcome::GenerationChanged)
            }
        }
    }

    /// The published live graph, checked against the generation a caller is
    /// about to build on. The returned handle is a temporary co-owner: drop
    /// it before publishing, or the install has to copy the graph instead of
    /// mutating it.
    fn published_graph(&self, expected: Generation) -> Result<Arc<LiveGraph>, IndexError> {
        let published = crate::reader::read_published(&self.published)?;
        let graph = published
            .graph
            .as_ref()
            .ok_or(IndexError::IndexUnavailable)?;
        if graph.generation() != expected {
            return Err(IndexError::Storage(format!(
                "published live graph is at generation {} but the delta expects {}",
                graph.generation().get(),
                expected.get()
            )));
        }
        Ok(Arc::clone(graph))
    }

    /// Adopt whatever generation this cache has already committed, by
    /// hydrating the live graph that matches it.
    ///
    /// Needed when the cache was advanced by a writer this service does not
    /// own — another process, or a delta published through a separate store
    /// handle. Until it runs, this process's readers refuse to answer at
    /// all, which is the intended behavior: they have rows for a generation
    /// whose live state they never installed. Returns the generation now
    /// published, or `None` if the cache has published nothing yet.
    pub fn resync_published(&mut self) -> Result<Option<Generation>, IndexError> {
        let Some(generation) = self.store.current_generation()? else {
            return Ok(None);
        };
        self.republish_current(generation)?;
        Ok(Some(generation))
    }

    /// Make the published state agree with a generation that is already
    /// committed but was never installed here — a service that opened an
    /// existing cache, or one whose seeding failed. Ordinarily a no-op: the
    /// hydration below only runs when the published generation is actually
    /// behind, and it runs before the barrier is taken.
    fn republish_current(&mut self, generation: Generation) -> Result<(), IndexError> {
        if crate::reader::read_published(&self.published)?.generation == Some(generation) {
            return Ok(());
        }
        let graph = Arc::new(self.store.hydrate_live_graph()?);
        if graph.generation() != generation {
            return Err(IndexError::Storage(format!(
                "hydrated generation {} does not match the committed generation {}",
                graph.generation().get(),
                generation.get()
            )));
        }
        let mut published = write_published(&self.published)?;
        published.generation = Some(generation);
        published.graph = Some(graph);
        Ok(())
    }

    #[doc(hidden)]
    pub fn snapshot_for_test(&self) -> Result<ScanReport, IndexError> {
        self.store.load_graph_for_test()
    }

    /// Raw connection access for schema-shape and query-plan assertions.
    #[doc(hidden)]
    pub fn connection_for_test(&self) -> &rusqlite::Connection {
        &self.store.connection
    }

    /// Hydrate a compact live resolution graph from one consistent snapshot
    /// of the current committed generation. Fails with
    /// `IndexError::IndexUnavailable` before the first successful
    /// `refresh`. The generation is read inside the same transaction as
    /// every other row, so a concurrent publish cannot hand back notes and
    /// references from different generations.
    pub fn hydrate_live_graph(&self) -> Result<LiveGraph, IndexError> {
        self.store.hydrate_live_graph()
    }
}

struct RefreshCounts {
    added: u64,
    changed: u64,
    deleted: u64,
    unchanged: u64,
    reparsed: u64,
    verified: bool,
}

/// Install whatever an already-populated cache has committed, so a service
/// that opens an existing index can serve reads before it refreshes.
///
/// A cache with nothing published stays unpublished (readers answer
/// `IndexUnavailable` until the first refresh). A cache that cannot be
/// hydrated also stays unpublished rather than failing the open: the
/// generation is left unclaimed — so no reader can answer from rows whose
/// live graph is missing — and the reason is recorded as the runtime error
/// for an operator to see. The next successful refresh replaces both.
fn seed_published(store: &IndexStore, published: &PublicationBarrier) -> Result<(), IndexError> {
    let Some(generation) = store.current_generation()? else {
        return Ok(());
    };
    let mut state = write_published(published)?;
    match store.hydrate_live_graph() {
        Ok(graph) if graph.generation() == generation => {
            state.generation = Some(generation);
            state.graph = Some(Arc::new(graph));
        }
        Ok(graph) => {
            state.runtime_error = Some(format!(
                "cache hydrated at generation {} but committed generation {}",
                graph.generation().get(),
                generation.get()
            ));
        }
        Err(error) => state.runtime_error = Some(error.to_string()),
    }
    Ok(())
}

/// The live-graph counterpart of the rows a full publication is about to
/// write, built from the same in-memory graph rather than by reading back
/// what was just written: same paths, same heading and block identities,
/// same per-source reference ordinals (`replace_note` numbers a note's
/// references by their position in exactly this order).
fn live_graph_from_semantic(
    generation: Generation,
    graph: &SemanticGraph,
) -> Result<LiveGraph, IndexError> {
    let mut notes = Vec::new();
    let mut references = Vec::new();
    for path in graph.note_paths() {
        let note = graph.note(path).ok_or_else(|| {
            IndexError::Storage(format!("graph has no note for {}", path.as_str()))
        })?;
        notes.push(HydratedNote {
            path: path.clone(),
            headings: note
                .headings
                .iter()
                .map(|heading| heading.text.clone())
                .collect(),
            blocks: note
                .blocks
                .iter()
                .map(|block| block.value.clone())
                .collect(),
        });
        for (ordinal, resolved) in graph.outgoing(path).iter().enumerate() {
            references.push(HydratedReference {
                source_path: path.clone(),
                ordinal: u32::try_from(ordinal).map_err(|_| {
                    IndexError::Storage(format!(
                        "{} has more references than a u32 ordinal can hold",
                        path.as_str()
                    ))
                })?,
                target: LinkTarget::from(&resolved.reference),
                resolution: resolved.resolution.clone(),
            });
        }
    }
    LiveGraph::from_hydrated(generation, notes, references)
}
