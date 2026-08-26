use std::collections::BTreeSet;
use std::time::Instant;

use vault_core::{
    Diagnostic, DiagnosticCode, ParsedNote, Resolution, Resolver, ScanError, ScanReport, Severity,
    SourceDocument, SourceError, VaultPath, build_graph, parse_note,
};

use crate::config::IndexConfig;
use crate::error::IndexError;
use crate::inventory::{FileSystemIndexSource, InventorySnapshot, ReconcileSource};
use crate::live_graph::LiveGraph;
use crate::metrics::ReconcileMetrics;
use crate::model::{FileFingerprint, Generation, IndexState};
use crate::store::{IndexStore, Publication, PublishOutcome};

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

pub struct IndexService {
    // Read by vault_info in the query layer.
    #[allow(dead_code)]
    pub(crate) config: IndexConfig,
    pub(crate) store: IndexStore,
    pub(crate) source: Box<dyn ReconcileSource>,
    pub(crate) resolver: Option<(Generation, Resolver)>,
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
        Ok(Self {
            config,
            store,
            source,
            resolver: None,
            last_metrics: None,
        })
    }

    pub fn current_generation(&self) -> Result<Option<Generation>, IndexError> {
        self.store.current_generation()
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
            self.reload_resolver(previous_generation)?;
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

        match self.store.publish(Publication {
            expected: previous,
            notes: &replaced,
            deleted: &removed,
            fingerprint_updates: &fingerprint_updates,
            graph: &report.graph,
            scan_diagnostics: &scan_diagnostics,
            diagnostics: &report.diagnostics,
        })? {
            PublishOutcome::Committed(generation, publish_metrics) => {
                metrics.stages.sqlite_write += publish_metrics.sqlite_write;
                metrics.stages.sqlite_commit += publish_metrics.sqlite_commit;
                metrics.work.resolution_rows_written +=
                    publish_metrics.graph_write.resolution_rows_written;
                metrics.work.diagnostic_rows_written +=
                    publish_metrics.graph_write.diagnostic_rows_written;
                self.reload_resolver(generation)?;
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
            PublishOutcome::GenerationChanged => Ok(TryOutcome::Retry),
        }
    }

    pub(crate) fn reload_resolver(&mut self, generation: Generation) -> Result<(), IndexError> {
        if self
            .resolver
            .as_ref()
            .is_none_or(|(cached, _)| *cached != generation)
        {
            let catalog = self.store.load_resolution_catalog()?;
            self.resolver = Some((generation, Resolver::from_catalog(catalog)));
        }
        Ok(())
    }

    #[doc(hidden)]
    pub fn snapshot_for_test(&self) -> Result<ScanReport, IndexError> {
        self.store.load_graph_for_test()
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
