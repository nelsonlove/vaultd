//! Incremental reconciliation: resolve what an impact plan selects, never the
//! whole vault.
//!
//! The ordinary route through this module reads only the dirty paths' bodies,
//! parses only the ones whose content revision actually moved, re-resolves
//! those notes' own references plus the references the live graph's dependency
//! index selects, and publishes the result as one delta. No complete
//! inventory, no unchanged-source load, no complete resolution, no whole-graph
//! clone.
//!
//! The correctness rule is asymmetric and deliberately so: **over-selection is
//! allowed, under-selection is a bug**. A reference whose resolution answer
//! could have changed must always be re-resolved; a reference re-resolved
//! unnecessarily costs work and nothing else. Every selection decision here
//! therefore goes through `vault_core`'s own
//! `reference_dependencies`/`changed_candidate_keys` pair — the only
//! sanctioned dependency-key constructors — rather than any local
//! re-derivation of what "could matter".

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use vault_core::{
    DependencyKey, Diagnostic, DiagnosticCode, LinkTarget, ParsedNote, Resolution,
    ResolutionIdentityChange, ResolutionNote, ResolvedReference, Resolver, ScanError, Severity,
    SourceDocument, SourceError, VaultPath, changed_candidate_keys, parse_note,
    reference_dependencies, resolution_diagnostic,
};

use crate::error::IndexError;
use crate::live_graph::{HydratedNote, HydratedReference, LiveGraph, ReferenceKey};
use crate::metrics::ReconcileMetrics;
use crate::model::{FileFingerprint, Generation};
use crate::reconcile::{IndexService, MAX_RECONCILE_RETRIES};
use crate::store::{DeltaPublication, DeltaPublishOutcome, NoteReplacement, ResolutionReplacement};

/// Why a reconciliation cycle ran. Observational: nothing in this module
/// branches on it, and it is reported back so a runtime can attribute work.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChangeCause {
    Watcher,
    Startup,
    Periodic,
    Manual,
    Verified,
}

/// The *semantic* change one cycle published, by path. A path only appears
/// here when the cache's own view of it moved: a metadata-only touch (same
/// content revision) leaves every vector empty, because nothing a client can
/// observe changed. Every vector is sorted and deduplicated.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PathChanges {
    pub created: Vec<VaultPath>,
    pub modified: Vec<VaultPath>,
    pub deleted: Vec<VaultPath>,
}

/// What one targeted reconciliation cycle did.
#[derive(Clone, Debug)]
pub struct LiveRefreshReport {
    pub previous_generation: Option<Generation>,
    pub generation: Generation,
    pub cause: ChangeCause,
    pub changes: PathChanges,
    /// References selected for re-resolution: the changed sources' own
    /// outgoing references plus the dependency-selected incoming ones.
    pub affected_reference_count: u64,
    /// Whether the selective plan was abandoned for a complete re-resolution
    /// of every reference the compact graph holds (still with no body read and
    /// no re-parse of unchanged source).
    pub complete_resolution: bool,
    pub metrics: ReconcileMetrics,
}

/// The point past which selective invalidation stops paying for itself: past
/// this many selected references, re-resolving every reference the compact
/// graph already holds costs less than carrying the selection. Kept as one
/// named function (and overridable in tests) so a later tuning pass has a
/// single place to change.
pub(crate) fn complete_resolution_threshold(total_references: usize) -> usize {
    std::cmp::max(10_000, total_references / 4)
}

/// What one dirty path is on disk right now, read exactly once.
enum PathState {
    Present {
        fingerprint: FileFingerprint,
        source: SourceDocument,
    },
    Absent,
    /// Unusable: unreadable, not valid UTF-8, or metadata that cannot be read.
    /// Carries the diagnostic the complete path would have produced, plus
    /// whatever was learned about presence — `None` when even that could not
    /// be established, which suppresses the pre-publication presence check for
    /// this path rather than guessing at it.
    Unusable {
        diagnostic: Diagnostic,
        observed_present: Option<bool>,
    },
}

/// Where this cycle's scan-diagnostic set comes from.
enum ScanDiagnostics {
    /// A complete inventory produced the whole list; it replaces what is
    /// stored.
    Complete(Vec<Diagnostic>),
    /// Only the dirty paths were examined, so only their entries may be
    /// rewritten: every stored diagnostic belonging to another path (or to no
    /// path at all, e.g. a directory-walk failure) is carried over untouched.
    Patch(Vec<Diagnostic>),
}

/// One batch of already-read dirty paths, ready to reconcile. Reading is
/// separated from reconciling so a lost compare-and-swap can re-plan against
/// the new generation without re-reading a single body.
struct DirtyBatch {
    states: BTreeMap<VaultPath, PathState>,
    scan_diagnostics: ScanDiagnostics,
}

/// The shape both `LiveRefreshReport` and the compatibility `RefreshReport`
/// are built from.
pub(crate) struct BatchOutcome {
    pub(crate) previous_generation: Generation,
    pub(crate) generation: Generation,
    pub(crate) changes: PathChanges,
    pub(crate) unchanged: u64,
    pub(crate) reparsed: u64,
    pub(crate) affected_reference_count: u64,
    pub(crate) complete_resolution: bool,
}

/// How one dirty path's stored row must move.
enum Classified {
    /// New content: the reparsed note replaces the stored one. Boxed because
    /// a `ParsedNote` dwarfs every other variant, and this enum is produced
    /// once per dirty path.
    Replaced {
        note: Box<ParsedNote>,
        fingerprint: FileFingerprint,
        existed: bool,
    },
    /// Same content, different metadata: refresh the fingerprint only.
    Fingerprint { fingerprint: FileFingerprint },
    /// Same content, same metadata: nothing at all.
    Unchanged,
    /// The stored row must go: deleted, unreadable, or no longer valid UTF-8.
    Removed,
    /// Nothing on disk and nothing stored.
    Ignored,
}

/// Everything the planning pass extracts from the published live graph, as
/// owned values. Nothing here borrows the graph: the `Arc` handle must be
/// released before publication, or `install` would deep-copy the whole graph
/// instead of mutating it in place.
struct ImpactSelection {
    /// Selected references whose source note is *not* itself being replaced.
    incoming: Vec<HydratedReference>,
    /// Every note identity the bounded resolver needs, already merged with
    /// this cycle's own additions, replacements, and removals.
    catalog: BTreeMap<VaultPath, ResolutionNote>,
    complete_resolution: bool,
}

fn unreadable_diagnostic(path: &VaultPath, message: String) -> Diagnostic {
    Diagnostic::new(DiagnosticCode::UnreadableFile, Severity::Error, message)
        .with_path(path.clone())
}

/// The canonical order for a stored scan-diagnostic set: the same key
/// `InventorySnapshot` and `build_graph` sort by. Both publication paths sort
/// before comparing and writing, so a set that did not actually change is
/// never rewritten just because two paths assembled it in different orders.
pub(crate) fn sort_scan_diagnostics(diagnostics: &mut [Diagnostic]) {
    diagnostics.sort_by(|a, b| {
        (&a.path, a.span, a.code, &a.message).cmp(&(&b.path, b.span, b.code, &b.message))
    });
}

/// The dependency keys a reference's *lookup routes* use, independent of how
/// it currently resolves. `Resolution::Unresolved` is the neutral input: it
/// contributes no `ResolvedTarget` key of its own, so what comes back is
/// exactly the exact-path/implicit-extension/filename/stem routes
/// `Resolver::resolve_target` will try (or, for a same-note subpath
/// reference, that note itself).
fn lookup_keys(source: &VaultPath, target: &LinkTarget) -> Vec<DependencyKey> {
    reference_dependencies(source, target, &Resolution::Unresolved)
}

/// The candidate-map keys a note contributes, modeled the way the live graph
/// models an addition: no prior state. Computed through `vault_core`, never
/// hand-built.
fn identity_keys(identity: &ResolutionNote) -> BTreeSet<DependencyKey> {
    changed_candidate_keys(&ResolutionIdentityChange {
        old: None,
        new: Some(identity.clone()),
    })
}

/// The graph's current identity for `path`, as resolution sees it.
fn graph_identity(graph: &LiveGraph, path: &VaultPath) -> Option<ResolutionNote> {
    graph.note(path).map(|note| ResolutionNote {
        path: note.path,
        headings: note.headings,
        blocks: note.blocks,
    })
}

fn reference_ordinal(path: &VaultPath, ordinal: usize) -> Result<u32, IndexError> {
    u32::try_from(ordinal).map_err(|_| {
        IndexError::Storage(format!(
            "{} has more references than a u32 ordinal can hold",
            path.as_str()
        ))
    })
}

/// Decide what one dirty path's stored row must become, parsing only when the
/// content revision actually moved.
fn classify(
    state: &PathState,
    stored: Option<&(String, FileFingerprint)>,
    metrics: &mut ReconcileMetrics,
) -> Classified {
    match state {
        PathState::Absent | PathState::Unusable { .. } => {
            if stored.is_some() {
                Classified::Removed
            } else {
                Classified::Ignored
            }
        }
        PathState::Present {
            fingerprint,
            source,
        } => {
            let existed = stored.is_some();
            if let Some((revision, stored_fingerprint)) = stored {
                if revision.as_str() == source.revision().as_str() {
                    return if stored_fingerprint == fingerprint {
                        Classified::Unchanged
                    } else {
                        Classified::Fingerprint {
                            fingerprint: *fingerprint,
                        }
                    };
                }
            }
            let parse_start = Instant::now();
            let note = parse_note(source.clone());
            metrics.stages.parse += parse_start.elapsed();
            metrics.work.notes_reparsed += 1;
            Classified::Replaced {
                note: Box::new(note),
                fingerprint: *fingerprint,
                existed,
            }
        }
    }
}

/// Record one re-resolved reference in both halves of the delta at once: the
/// stored resolution (with its dependency keys and diagnostic) and the live
/// graph's compact record. Writing both from a single call site is what keeps
/// `publish_delta`'s coherence assertion satisfiable by construction.
fn push_replacement(
    resolutions: &mut Vec<ResolutionReplacement>,
    graph_references: &mut Vec<HydratedReference>,
    metrics: &mut ReconcileMetrics,
    ordinal: u32,
    target: LinkTarget,
    resolved: ResolvedReference,
) {
    let path = resolved.source.clone();
    let dependencies = reference_dependencies(&path, &target, &resolved.resolution);
    let diagnostic = resolution_diagnostic(&resolved);
    if matches!(resolved.resolution, Resolution::Resolved { .. }) {
        metrics.work.references_resolved += 1;
    }
    resolutions.push(ResolutionReplacement {
        source_path: path.clone(),
        ordinal,
        resolution: resolved.resolution.clone(),
        dependencies,
        diagnostic,
    });
    graph_references.push(HydratedReference {
        source_path: path,
        ordinal,
        target,
        resolution: resolved.resolution,
    });
}

impl IndexService {
    /// Reconcile exactly `paths` — a bounded dirty set from a watcher, a
    /// startup catch-up, or any other producer — against the published
    /// generation, and publish one delta.
    ///
    /// Never enumerates the vault: each path is fingerprinted individually,
    /// read at most once, and parsed only if its content revision moved.
    /// Requires an already-published generation; the first, cold build still
    /// goes through `refresh`.
    pub fn refresh_paths(
        &mut self,
        paths: BTreeSet<VaultPath>,
        cause: ChangeCause,
    ) -> Result<LiveRefreshReport, IndexError> {
        let mut metrics = ReconcileMetrics::default();
        let outcome = self.refresh_paths_body(&paths, &mut metrics);
        self.last_metrics = Some(metrics.clone());
        outcome.map(|batch| LiveRefreshReport {
            previous_generation: Some(batch.previous_generation),
            generation: batch.generation,
            cause,
            changes: batch.changes,
            affected_reference_count: batch.affected_reference_count,
            complete_resolution: batch.complete_resolution,
            metrics,
        })
    }

    fn refresh_paths_body(
        &mut self,
        paths: &BTreeSet<VaultPath>,
        metrics: &mut ReconcileMetrics,
    ) -> Result<BatchOutcome, IndexError> {
        if self.store.current_generation()?.is_none() {
            return Err(IndexError::IndexUnavailable);
        }

        let mut states = BTreeMap::new();
        let mut diagnostics = Vec::new();
        for path in paths {
            let state = self.read_stable_path(path, None, metrics)?;
            if let PathState::Unusable { diagnostic, .. } = &state {
                diagnostics.push(diagnostic.clone());
            }
            states.insert(path.clone(), state);
        }

        let batch = DirtyBatch {
            states,
            scan_diagnostics: ScanDiagnostics::Patch(diagnostics),
        };
        self.reconcile_batch(&batch, metrics)
    }

    /// The dirty-path engine behind `refresh(false)`/`refresh(true)` once a
    /// generation exists: inventory metadata (normal) or read every body
    /// (verified), calculate the dirty set, and hand it to the same targeted
    /// reconciliation `refresh_paths` uses. Verified mode reads every body but
    /// still reparses only the revisions that moved.
    pub(crate) fn refresh_dirty_paths(
        &mut self,
        expected: Generation,
        verify: bool,
        metrics: &mut ReconcileMetrics,
    ) -> Result<BatchOutcome, IndexError> {
        self.republish_current(expected)?;

        let inventory_start = Instant::now();
        let inventory = self.source.inventory()?;
        metrics.stages.inventory += inventory_start.elapsed();
        metrics.work.complete_inventories += 1;
        let stored = self.store.stored_fingerprints()?;

        // The `bool` is what the inventory just claimed about the path.
        // `read_stable_path` requires the point fingerprint to agree, which is
        // what replaces the complete path's second whole-vault inventory: a
        // vault that moved under the reconciliation is still caught, now at
        // O(dirty) cost instead of O(vault).
        let mut dirty: BTreeMap<VaultPath, bool> = BTreeMap::new();
        let mut unchanged = 0u64;
        for (path, fingerprint) in &inventory.entries {
            match stored.get(path) {
                Some(known) if known == fingerprint && !verify => unchanged += 1,
                _ => {
                    dirty.insert(path.clone(), true);
                }
            }
        }
        for path in stored.keys() {
            if !inventory.entries.contains_key(path) {
                dirty.insert(path.clone(), false);
            }
        }

        let mut states = BTreeMap::new();
        let mut diagnostics = inventory.diagnostics.clone();
        for (path, present) in &dirty {
            let state = self.read_stable_path(path, Some(*present), metrics)?;
            if let PathState::Unusable { diagnostic, .. } = &state {
                diagnostics.push(diagnostic.clone());
            }
            states.insert(path.clone(), state);
        }

        let batch = DirtyBatch {
            states,
            scan_diagnostics: ScanDiagnostics::Complete(diagnostics),
        };
        let mut outcome = self.reconcile_batch(&batch, metrics)?;
        outcome.unchanged += unchanged;
        Ok(outcome)
    }

    /// Read one path so that what is parsed provably belongs to one coherent
    /// on-disk state: fingerprint, read once, fingerprint again, and require
    /// the two to agree. A file rewritten mid-read yields
    /// `VaultChangedDuringRefresh` and stays eligible for the caller's next
    /// dirty set, rather than being silently indexed half-old.
    fn read_stable_path(
        &mut self,
        path: &VaultPath,
        expected_present: Option<bool>,
        metrics: &mut ReconcileMetrics,
    ) -> Result<PathState, IndexError> {
        let before = match self.source.fingerprint(path) {
            Ok(before) => before,
            Err(error) => {
                return Ok(PathState::Unusable {
                    diagnostic: unreadable_diagnostic(path, error.to_string()),
                    observed_present: None,
                });
            }
        };
        if let Some(expected) = expected_present {
            if expected != before.is_some() {
                return Err(IndexError::VaultChangedDuringRefresh);
            }
        }
        let Some(fingerprint) = before else {
            return Ok(PathState::Absent);
        };

        let read_start = Instant::now();
        let read = self.source.read_bytes(path);
        metrics.stages.body_read += read_start.elapsed();
        metrics.work.body_reads += 1;
        let bytes = match read {
            Ok(bytes) => bytes,
            Err(ScanError::UnreadableFile { path, message }) => {
                return Ok(PathState::Unusable {
                    diagnostic: unreadable_diagnostic(&path, message),
                    observed_present: Some(true),
                });
            }
            Err(ScanError::InaccessibleRoot { message }) => {
                return Err(IndexError::InvalidVaultRoot(message));
            }
        };

        let source = match SourceDocument::from_utf8(path.clone(), bytes) {
            Ok(source) => source,
            Err(SourceError::InvalidUtf8 { path, error }) => {
                return Ok(PathState::Unusable {
                    diagnostic: Diagnostic::new(
                        DiagnosticCode::InvalidUtf8,
                        Severity::Error,
                        error.to_string(),
                    )
                    .with_path(path),
                    observed_present: Some(true),
                });
            }
        };

        let after = self
            .source
            .fingerprint(path)
            .map_err(|_| IndexError::VaultChangedDuringRefresh)?;
        if after != Some(fingerprint) {
            return Err(IndexError::VaultChangedDuringRefresh);
        }
        Ok(PathState::Present {
            fingerprint,
            source,
        })
    }

    /// Plan, resolve, and publish one already-read batch, retrying the plan
    /// (never the reads) if the compare-and-swap loses to another writer.
    fn reconcile_batch(
        &mut self,
        batch: &DirtyBatch,
        metrics: &mut ReconcileMetrics,
    ) -> Result<BatchOutcome, IndexError> {
        for _ in 0..MAX_RECONCILE_RETRIES {
            if let Some(outcome) = self.try_reconcile_batch(batch, metrics)? {
                return Ok(outcome);
            }
        }
        Err(IndexError::Storage(
            "concurrent publication did not stabilize".into(),
        ))
    }

    /// One reconciliation attempt against the current generation. `Ok(None)`
    /// means the compare-and-swap lost and the caller should re-plan.
    fn try_reconcile_batch(
        &mut self,
        batch: &DirtyBatch,
        metrics: &mut ReconcileMetrics,
    ) -> Result<Option<BatchOutcome>, IndexError> {
        // Attempt-scoped counters. Reads and inventories happened once, before
        // this loop, and must survive a retry; everything recomputed inside an
        // attempt is reset so a retry reports the work of the attempt that
        // actually published, not the sum of all of them.
        metrics.work.notes_reparsed = 0;
        metrics.work.changed_notes = 0;
        metrics.work.affected_references = 0;
        metrics.work.references_resolved = 0;

        let expected = self
            .store
            .current_generation()?
            .ok_or(IndexError::IndexUnavailable)?;
        self.republish_current(expected)?;

        let mut replaced: Vec<(ParsedNote, FileFingerprint)> = Vec::new();
        let mut removed: Vec<VaultPath> = Vec::new();
        let mut fingerprint_updates: Vec<(VaultPath, FileFingerprint)> = Vec::new();
        let mut changes = PathChanges::default();
        let mut unchanged = 0u64;
        let mut reparsed = 0u64;

        for (path, state) in &batch.states {
            let stored = self.store.stored_note_metadata(path)?;
            match classify(state, stored.as_ref(), metrics) {
                Classified::Replaced {
                    note,
                    fingerprint,
                    existed,
                } => {
                    reparsed += 1;
                    if existed {
                        changes.modified.push(path.clone());
                    } else {
                        changes.created.push(path.clone());
                    }
                    replaced.push((*note, fingerprint));
                }
                Classified::Fingerprint { fingerprint } => {
                    unchanged += 1;
                    fingerprint_updates.push((path.clone(), fingerprint));
                }
                Classified::Unchanged => unchanged += 1,
                Classified::Removed => {
                    changes.deleted.push(path.clone());
                    removed.push(path.clone());
                }
                Classified::Ignored => {}
            }
        }

        metrics.work.changed_notes = changes.created.len() as u64 + changes.modified.len() as u64;

        let stored_scan_diagnostics = self.store.load_scan_diagnostics()?;
        let scan_diagnostics = merge_scan_diagnostics(batch, &stored_scan_diagnostics);
        let scan_diagnostics_changed = scan_diagnostics != stored_scan_diagnostics;

        if replaced.is_empty() && removed.is_empty() && !scan_diagnostics_changed {
            self.store.touch(&fingerprint_updates)?;
            self.republish_current(expected)?;
            return Ok(Some(BatchOutcome {
                previous_generation: expected,
                generation: expected,
                changes: PathChanges::default(),
                unchanged,
                reparsed: 0,
                affected_reference_count: 0,
                complete_resolution: false,
            }));
        }

        // Everything the live graph is needed for happens inside this block,
        // and the handle is released at its end. A clone still alive when
        // `publish_delta` installs would turn `Arc::make_mut` into a
        // whole-graph deep copy — precisely the cost this design exists to
        // avoid.
        let planning_start = Instant::now();
        let selection = {
            let graph = self.published_graph(expected)?;
            self.select_impact(&graph, &replaced, &removed)
        };
        metrics.stages.impact_planning += planning_start.elapsed();

        let mut affected_reference_count = selection.incoming.len() as u64;
        for (note, _) in &replaced {
            affected_reference_count += note.references.len() as u64;
        }
        metrics.work.affected_references = affected_reference_count;

        let resolution_start = Instant::now();
        let resolver = Resolver::from_catalog(selection.catalog.into_values());
        let mut resolutions: Vec<ResolutionReplacement> = Vec::new();
        let mut graph_references: Vec<HydratedReference> = Vec::new();

        for (note, _) in &replaced {
            let path = note.source.path().clone();
            for (ordinal, reference) in note.references.iter().enumerate() {
                let ordinal = reference_ordinal(&path, ordinal)?;
                let target = LinkTarget::from(reference);
                let resolution = resolver.resolve_target(&path, &target);
                let resolved = ResolvedReference {
                    source: path.clone(),
                    source_span: reference.span,
                    reference: reference.clone(),
                    resolution,
                };
                push_replacement(
                    &mut resolutions,
                    &mut graph_references,
                    metrics,
                    ordinal,
                    target,
                    resolved,
                );
            }
        }

        // A selected incoming reference keeps its stored spelling and span —
        // only the *answer* can have moved — so the full reference is loaded
        // per affected source note: an indexed read bounded by the selection,
        // never by the vault.
        let mut by_source: BTreeMap<VaultPath, Vec<u32>> = BTreeMap::new();
        for reference in &selection.incoming {
            by_source
                .entry(reference.source_path.clone())
                .or_default()
                .push(reference.ordinal);
        }
        for (path, ordinals) in &by_source {
            // Keyed by stored ordinal, never by position: the loader's join to
            // `resolutions` is an INNER JOIN, so a reference missing its
            // resolution row drops out of the result rather than leaving a
            // hole, and a positional lookup would hand this ordinal the
            // *next* reference's spelling — resolving the wrong target and
            // committing that answer under the ordinal asked for.
            let stored = self.store.load_outgoing_by_ordinal(path)?;
            for &ordinal in ordinals {
                // An absent ordinal means the store's own guarantee (every
                // reference row has a resolution row, enforced on write by
                // `IncompleteResolutionCoverage`) is already broken. Skipping
                // it would leave a selected reference un-re-resolved — the one
                // direction conservative invalidation forbids — and nothing
                // later would notice, so it fails loudly instead (the same
                // choice `LiveGraph::from_hydrated` makes for a torn read).
                let Some(existing) = stored.get(&ordinal) else {
                    return Err(IndexError::Storage(format!(
                        "selected reference {}#{ordinal} is absent from the stored index",
                        path.as_str()
                    )));
                };
                let target = LinkTarget::from(&existing.reference);
                let resolution = resolver.resolve_target(path, &target);
                let resolved = ResolvedReference {
                    source: path.clone(),
                    source_span: existing.source_span,
                    reference: existing.reference.clone(),
                    resolution,
                };
                push_replacement(
                    &mut resolutions,
                    &mut graph_references,
                    metrics,
                    ordinal,
                    target,
                    resolved,
                );
            }
        }
        metrics.stages.resolution += resolution_start.elapsed();

        // The last thing before the barrier: every path this delta claims to
        // create, replace, or delete must still be in the state the plan
        // assumed. One point fingerprint each — no inventory.
        self.confirm_planned_presence(batch, &replaced, &removed)?;

        let notes: Vec<NoteReplacement> = replaced
            .iter()
            .map(|(note, fingerprint)| NoteReplacement {
                note: note.clone(),
                fingerprint: *fingerprint,
            })
            .collect();
        let hydrated_notes: Vec<HydratedNote> = replaced
            .iter()
            .map(|(note, _)| HydratedNote {
                path: note.source.path().clone(),
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
            })
            .collect();

        let outcome = self.publish_delta(
            DeltaPublication {
                expected,
                notes: &notes,
                deleted: &removed,
                fingerprint_updates: &fingerprint_updates,
                resolutions: &resolutions,
                scan_diagnostics: scan_diagnostics_changed.then_some(scan_diagnostics.as_slice()),
            },
            &hydrated_notes,
            &removed,
            &graph_references,
        )?;

        match outcome {
            DeltaPublishOutcome::Committed {
                generation,
                counts,
                timings,
            } => {
                metrics.work.merge_delta(&counts);
                // Stage for stage with the complete path: the SQLite halves
                // come from inside the delta transaction, `live_install`
                // covers the graph delta's preparation and installation and
                // nothing else.
                metrics.stages.sqlite_write += timings.sqlite_write;
                metrics.stages.sqlite_commit += timings.sqlite_commit;
                metrics.stages.live_install += timings.live_install;
                Ok(Some(BatchOutcome {
                    previous_generation: expected,
                    generation,
                    changes,
                    unchanged,
                    reparsed,
                    affected_reference_count,
                    complete_resolution: selection.complete_resolution,
                }))
            }
            DeltaPublishOutcome::GenerationChanged => Ok(None),
        }
    }

    /// Select every reference whose answer could have moved, and the note
    /// identities needed to answer them, as owned values.
    fn select_impact(
        &self,
        graph: &LiveGraph,
        replaced: &[(ParsedNote, FileFingerprint)],
        removed: &[VaultPath],
    ) -> ImpactSelection {
        let changed_sources: BTreeSet<VaultPath> = replaced
            .iter()
            .map(|(note, _)| note.source.path().clone())
            .collect();
        let removed_set: BTreeSet<VaultPath> = removed.iter().cloned().collect();

        let new_identities: BTreeMap<VaultPath, ResolutionNote> = replaced
            .iter()
            .map(|(note, _)| (note.source.path().clone(), ResolutionNote::from(note)))
            .collect();

        let mut identity_changes: Vec<ResolutionIdentityChange> = Vec::new();
        for (path, identity) in &new_identities {
            identity_changes.push(ResolutionIdentityChange {
                old: graph_identity(graph, path),
                new: Some(identity.clone()),
            });
        }
        for path in &removed_set {
            if let Some(old) = graph_identity(graph, path) {
                identity_changes.push(ResolutionIdentityChange {
                    old: Some(old),
                    new: None,
                });
            }
        }

        let plan = graph.plan_impact(&changed_sources, &identity_changes);
        let selected: Vec<ReferenceKey> = plan
            .affected
            .iter()
            .copied()
            .filter(|key| match graph.note_path(key.source) {
                Some(path) => !changed_sources.contains(path) && !removed_set.contains(path),
                None => false,
            })
            .collect();

        let threshold = self
            .live_threshold_override
            .unwrap_or_else(|| complete_resolution_threshold(graph.reference_count()));
        let complete_resolution = plan.complete_resolution || selected.len() > threshold;

        let incoming: Vec<HydratedReference> = if complete_resolution {
            graph
                .note_paths()
                .into_iter()
                .filter(|path| !changed_sources.contains(path) && !removed_set.contains(path))
                .flat_map(|path| graph.outgoing(&path))
                .collect()
        } else {
            selected
                .iter()
                .filter_map(|key| graph.reference(*key))
                .collect()
        };

        let catalog = if complete_resolution {
            // Every surviving note, with this cycle's identities applied. Still
            // no body load and no re-parse: the compact graph already holds
            // exactly the heading/block facts resolution needs.
            let mut catalog: BTreeMap<VaultPath, ResolutionNote> = BTreeMap::new();
            for path in graph.note_paths() {
                if removed_set.contains(&path) || changed_sources.contains(&path) {
                    continue;
                }
                if let Some(identity) = graph_identity(graph, &path) {
                    catalog.insert(path, identity);
                }
            }
            catalog.extend(new_identities);
            catalog
        } else {
            bounded_catalog(
                graph,
                replaced,
                &incoming,
                &new_identities,
                &changed_sources,
                &removed_set,
            )
        };

        ImpactSelection {
            incoming,
            catalog,
            complete_resolution,
        }
    }

    /// Re-fingerprint every path this delta will create, replace, or delete
    /// and require the presence the plan assumed. Cheap (one `stat` each) and
    /// bounded by the change, which is what makes it affordable immediately
    /// before the barrier — where the complete path can only afford a second
    /// whole-vault inventory.
    fn confirm_planned_presence(
        &self,
        batch: &DirtyBatch,
        replaced: &[(ParsedNote, FileFingerprint)],
        removed: &[VaultPath],
    ) -> Result<(), IndexError> {
        let mut expectations: BTreeMap<&VaultPath, bool> = BTreeMap::new();
        for (note, _) in replaced {
            expectations.insert(note.source.path(), true);
        }
        for path in removed {
            let expected = match batch.states.get(path) {
                Some(PathState::Absent) => Some(false),
                Some(PathState::Present { .. }) => Some(true),
                Some(PathState::Unusable {
                    observed_present, ..
                }) => *observed_present,
                None => None,
            };
            if let Some(expected) = expected {
                expectations.insert(path, expected);
            }
        }
        for (path, expected) in expectations {
            let present = self.source.fingerprint(path)?.is_some();
            if present != expected {
                return Err(IndexError::VaultChangedDuringRefresh);
            }
        }
        Ok(())
    }
}

/// The scan-diagnostic set this cycle should store.
///
/// A complete inventory replaces the whole list. A targeted cycle patches it:
/// entries belonging to a path this cycle examined are recomputed, every other
/// entry — including entries with no path at all — survives untouched, because
/// nothing was learned about them.
fn merge_scan_diagnostics(batch: &DirtyBatch, stored: &[Diagnostic]) -> Vec<Diagnostic> {
    let mut merged = match &batch.scan_diagnostics {
        ScanDiagnostics::Complete(diagnostics) => diagnostics.clone(),
        ScanDiagnostics::Patch(fresh) => {
            let touched: BTreeSet<&VaultPath> = batch.states.keys().collect();
            let mut merged: Vec<Diagnostic> = stored
                .iter()
                .filter(|diagnostic| {
                    !diagnostic
                        .path
                        .as_ref()
                        .is_some_and(|path| touched.contains(path))
                })
                .cloned()
                .collect();
            merged.extend(fresh.iter().cloned());
            merged
        }
    };
    sort_scan_diagnostics(&mut merged);
    merged
}

/// The smallest note set that answers every reference this cycle re-resolves
/// identically to a whole-vault `Resolver`.
///
/// For each reference, the lookup routes it will actually try are asked of the
/// live graph's forward candidate index, merged with this cycle's own
/// additions and removals. A note reachable by *any* of those routes is
/// included, so exact-path, implicit-extension, filename, and stem matches —
/// and therefore ambiguity counts — come out the same as they would against
/// the complete catalog. Each reference's own source note is always included,
/// because a same-note subpath reference (`[[#Heading]]`) resolves against the
/// source itself and reaches the candidate index through no lookup route at
/// all.
fn bounded_catalog(
    graph: &LiveGraph,
    replaced: &[(ParsedNote, FileFingerprint)],
    incoming: &[HydratedReference],
    new_identities: &BTreeMap<VaultPath, ResolutionNote>,
    changed_sources: &BTreeSet<VaultPath>,
    removed_set: &BTreeSet<VaultPath>,
) -> BTreeMap<VaultPath, ResolutionNote> {
    let mut added_by_key: BTreeMap<DependencyKey, BTreeSet<VaultPath>> = BTreeMap::new();
    for (path, identity) in new_identities {
        for key in identity_keys(identity) {
            added_by_key.entry(key).or_default().insert(path.clone());
        }
    }

    let mut wanted: BTreeSet<VaultPath> = BTreeSet::new();
    let collect = |source: &VaultPath, target: &LinkTarget, wanted: &mut BTreeSet<VaultPath>| {
        wanted.insert(source.clone());
        for key in lookup_keys(source, target) {
            for id in graph.candidate_notes(&key) {
                if let Some(path) = graph.note_path(id) {
                    if !removed_set.contains(path) && !changed_sources.contains(path) {
                        wanted.insert(path.clone());
                    }
                }
            }
            if let Some(paths) = added_by_key.get(&key) {
                wanted.extend(paths.iter().cloned());
            }
        }
    };

    for (note, _) in replaced {
        let path = note.source.path().clone();
        for reference in &note.references {
            collect(&path, &LinkTarget::from(reference), &mut wanted);
        }
        wanted.insert(path);
    }
    for reference in incoming {
        collect(&reference.source_path, &reference.target, &mut wanted);
    }

    let mut catalog: BTreeMap<VaultPath, ResolutionNote> = BTreeMap::new();
    for path in wanted {
        if removed_set.contains(&path) {
            continue;
        }
        if let Some(identity) = new_identities.get(&path) {
            catalog.insert(path, identity.clone());
        } else if let Some(identity) = graph_identity(graph, &path) {
            catalog.insert(path, identity);
        }
    }
    catalog
}
