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
use crate::lease::IndexLease;
use crate::live_graph::{HydratedNote, HydratedReference, LiveGraph};
use crate::metrics::ReconcileMetrics;
use crate::model::{
    FileFingerprint, Generation, IndexState, LiveState, PublicationBarrier, PublishedState,
};
use crate::reader::{IndexReader, PauseHook, write_published};
use crate::store::{
    BeginOutcome, DeltaPublication, DeltaPublishOutcome, IndexStore, Publication, TreeDelta, tree,
};

pub(crate) const MAX_RECONCILE_RETRIES: usize = 3;

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
    /// The exclusive writer lease for this cache, held for as long as this
    /// service exists. `None` only for `open_unleased_for_cas_test`, which
    /// exists so a compare-and-swap test can put two writers on the same
    /// cache on purpose; every production constructor populates it.
    _lease: Option<IndexLease>,
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
    pub(crate) last_metrics: Option<ReconcileMetrics>,
    /// Test-only override for `complete_resolution_threshold`, so the
    /// fallback branch can be exercised without a ten-thousand-reference
    /// vault.
    pub(crate) live_threshold_override: Option<usize>,
    /// Test-only rendezvous points inside one reconciliation cycle. `None`
    /// in every production build; see [`crate::test_hook`].
    pub(crate) test_hook: crate::test_hook::InstalledHook,
    /// The one engine that writes into this vault. Owned by the service so
    /// that a write and the reconciliation that publishes it happen on the
    /// same thread, under the same single-writer guarantee everything else
    /// here has.
    engine: crate::mutate::MutationEngine,
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

    /// Open a production service: validate and prepare the cache's storage
    /// location, take its exclusive writer lease, then open (and recover, if
    /// needed) the SQLite database and wire up the reader. A second
    /// production service for the same cache fails here — at the lease —
    /// before SQLite recovery ever runs.
    pub fn open_with_source(
        mut config: IndexConfig,
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
        config.prepare_storage()?;
        let lease = IndexLease::acquire(&config)?;
        Self::assemble(config, source, Some(lease))
    }

    /// Open a service against the same cache another production
    /// `IndexService` already holds the lease for, bypassing lease
    /// acquisition entirely. Exists only for the compare-and-swap defense
    /// test in `tests/recovery.rs` (`racing_services`), which puts two
    /// writers on one cache on purpose to prove `publish`'s
    /// compare-and-swap — not the lease — is what keeps a lost race safe.
    /// Storage-path validation still runs.
    #[doc(hidden)]
    pub fn open_unleased_for_cas_test(mut config: IndexConfig) -> Result<Self, IndexError> {
        config.prepare_storage()?;
        let source = FileSystemIndexSource::new(&config.canonical_vault_root)?;
        Self::assemble(config, Box::new(source), None)
    }

    fn assemble(
        config: IndexConfig,
        source: Box<dyn ReconcileSource>,
        lease: Option<IndexLease>,
    ) -> Result<Self, IndexError> {
        let store = IndexStore::open(&config)?;
        let published: PublicationBarrier = Arc::new(RwLock::new(PublishedState::starting()));
        seed_published(&store, &published)?;
        let reader = IndexReader::open(&config, Arc::clone(&published))?;
        // Built before the struct literal because `config` is moved into it.
        let engine = crate::mutate::MutationEngine::new(&config.canonical_vault_root);
        Ok(Self {
            config,
            store,
            source,
            _lease: lease,
            published,
            reader,
            publication_pause: None,
            row_write_pause: None,
            last_metrics: None,
            live_threshold_override: None,
            test_hook: None,
            engine,
        })
    }

    /// Apply one mutation to the vault. Filesystem-only: publishing what it
    /// changed is the caller's next step, through `refresh_paths`.
    ///
    /// Everything except a link-repairing rename is pure filesystem work and
    /// goes straight to the engine. A repairing rename is the one operation
    /// that needs the index — the live graph to know *which* references point
    /// at the moved note, the durable rows to know *how* to rewrite them — so
    /// it runs here, as one burst, serialized against every other mutation by
    /// the coordinator that owns this service.
    pub fn apply_mutation(
        &mut self,
        mutation: &crate::mutate::Mutation,
    ) -> Result<crate::mutate::MutationOutcome, IndexError> {
        // Read-only is checked **first**, above every other consideration.
        // `MutationEngine::apply` checks it too, but a repairing rename does
        // work before it reaches `apply`: it enumerates a folder's notes and
        // reads the index, so on a read-only daemon a rename of a folder that
        // does not exist would fail with a filesystem error — surfacing as
        // `storage_failure` — instead of the dedicated `read_only` code the
        // flag exists to produce. Refuse here, before any path is touched.
        if self.engine.is_read_only() {
            return Err(crate::mutate::MutationError::ReadOnly.into());
        }
        match mutation {
            crate::mutate::Mutation::RenameNote {
                from,
                to,
                expected,
                rewrite_links: true,
            } => self.rename_with_repair(from, to, Some(expected)),
            crate::mutate::Mutation::RenameFolder {
                from,
                to,
                rewrite_links: true,
            } => self.rename_with_repair(from, to, None),
            other => Ok(self.engine.apply(other)?),
        }
    }

    /// Rewrite every referencing note, then move the file — in that order,
    /// and never the reverse.
    ///
    /// A crash in between leaves references pointing at a path the note has
    /// not reached yet: visible as an incomplete rename, convergent when the
    /// client retries, and never the failure mode the other order produces —
    /// a moved note whose stale inbound links still *look* resolved. That
    /// failure mode is not hypothetical: with a same-basename note elsewhere
    /// in the vault, a `[[Alpha]]` left un-rewritten after `Alpha.md` moved
    /// resolves cleanly at `Archive/Alpha.md`, which is a different note.
    ///
    /// **The destination is reserved first**, which is what makes this order
    /// affordable. A rename used to discover `target_exists` at move time,
    /// after the whole vault had been edited for it. Now the name is claimed
    /// with `create_atomically` before a single referrer is touched, so a
    /// foreign writer racing for it is refused while every referrer is still
    /// byte-identical — and the repaired links, if a crash intervenes, point
    /// at a placeholder this burst owns rather than at somebody else's note.
    /// The retry moves over its own leftover.
    ///
    /// Every exit between the reservation and the move gives the reservation
    /// back, or a refused rename would leave a placeholder note in the vault.
    ///
    /// A repair that fails *after* the move does not un-land it. That is the
    /// `link_rewrite_failures` contract: a rename reports what it moved and,
    /// separately, every reference it could not retarget and why.
    ///
    /// `expected` present means the note shape, absent the folder one. The
    /// movement goes back through the engine, so the repairing and
    /// non-repairing renames move bytes through exactly the same code — the
    /// same `rename_paths` primitive, the same guards, the same
    /// `MutationOutcome`. Only `changed_paths`, `links_rewritten`, and
    /// `link_rewrite_failures` are this function's own; `revision` and
    /// `semantic` are read off that outcome rather than restated here, because
    /// restating them is how a folder rename ends up claiming a revision it
    /// has no bytes to hash.
    fn rename_with_repair(
        &mut self,
        from: &VaultPath,
        to: &VaultPath,
        expected: Option<&crate::mutate::Precondition>,
    ) -> Result<crate::mutate::MutationOutcome, IndexError> {
        // Every refusal the index-side work could trip over, before that work
        // runs. This is `rename_paths`'s own guard set, run for its refusals
        // only; the movement below re-runs it with nothing in between.
        self.engine
            .preflight_rename_adopting(from, to, expected.is_none())?;
        if let Some(expected) = expected {
            self.engine.check_rename_source(from, expected)?;
        }

        // Claimed before anything is rewritten.
        let reservation = self
            .engine
            .reserve_rename_destination(to, from, expected.is_none())?;
        let mut rewritten = 0u64;
        let outcome = self.repair_then_move(from, to, expected, &reservation, &mut rewritten);

        // The claim is given back on failure **only while nothing points at
        // it**. Once a referrer has been rewritten it names the reserved path,
        // and removing the placeholder is then the exact corruption the
        // reservation exists to prevent: with a same-basename note elsewhere
        // in the vault, `[[Renamed]]` stops resolving at the placeholder and
        // starts resolving at `Archive/Renamed.md` — a different note, and
        // resolved, which is the one state this ordering forbids.
        //
        // So a refusal that arrives after the rewrites leaves the placeholder
        // standing. It carries a line saying what it is, the repaired links
        // point at it rather than at a namesake, and the client's retry adopts
        // it and completes. Visibly incomplete beats quietly wrong.
        if outcome.is_err() && rewritten == 0 {
            self.engine.release_rename_destination(to, &reservation);
        }
        outcome
    }

    /// The body of a repairing rename, from a held reservation to a completed
    /// move. Split out so its caller can decide the reservation's fate on
    /// every failure without an exit path forgetting to.
    ///
    /// `rewritten` is an out-parameter rather than part of the return value
    /// because the caller needs it **on the error path**, where there is no
    /// outcome to read it off: whether any referrer already points at the
    /// reserved name is exactly what decides whether the reservation may be
    /// released.
    fn repair_then_move(
        &mut self,
        from: &VaultPath,
        to: &VaultPath,
        expected: Option<&crate::mutate::Precondition>,
        reservation: &crate::mutate::Reservation,
        rewritten: &mut u64,
    ) -> Result<crate::mutate::MutationOutcome, IndexError> {
        let moves = self.repair_moves(from, to, expected.is_some())?;
        let mut changed_paths: BTreeSet<VaultPath> = BTreeSet::new();
        let mut failures: Vec<crate::mutate::LinkRewriteFailure> = Vec::new();

        // Planned against the index's pre-move rows and the pre-move bytes on
        // disk. Nothing is written yet.
        let planned = match self.store.current_generation()? {
            Some(generation) => {
                self.republish_current(generation)?;
                // The graph handle is released at the end of this block, before
                // anything publishes: a live clone would force the next delta
                // install to copy the whole graph.
                let repair = {
                    let graph = self.published_graph(generation)?;
                    crate::mutate::rename::plan_repair(&graph, &self.store, &self.engine, &moves)?
                };
                failures = repair.failures;
                repair.rewrites
            }
            // Nothing has ever been published, so there is no graph to ask
            // which references point here. The move still happens — refusing
            // it would make an unbuilt index block a filesystem operation —
            // but the answer says so, because `links_rewritten: 0` with no
            // failures is an affirmative claim that nothing needed repair.
            // This is the one burst-scoped failure code, and its `path` names
            // the rename's own subject because no referrer could be found to
            // name instead.
            None => {
                failures.push(crate::mutate::LinkRewriteFailure {
                    path: from.clone(),
                    reason: crate::mutate::LinkRewriteReason::IndexUnavailable,
                });
                Vec::new()
            }
        };

        self.reach(crate::HookPoint::BeforeLinkRewrites);
        for rewrite in planned {
            // Write-time compare-and-swap, with nothing between it and the
            // write. The plan's own check is old by the standards of this loop
            // — every preceding referrer's write sits inside that window — so
            // a referrer edited since is reported, and one *deleted* since is
            // left deleted: `resolve` answers `Ok` for an absent path by
            // design, so an unguarded write here would resurrect a note
            // somebody removed.
            let reason = match self.engine.current_revision(&rewrite.path)? {
                Some(current) if current == rewrite.expected => None,
                Some(_) => Some(crate::mutate::LinkRewriteReason::RevisionConflict),
                None => Some(crate::mutate::LinkRewriteReason::SourceAbsent),
            };
            if let Some(reason) = reason {
                failures.push(crate::mutate::LinkRewriteFailure {
                    path: rewrite.path,
                    reason,
                });
                continue;
            }
            let resolved = self.engine.resolve(&rewrite.path)?;
            match crate::mutate::write_atomically(&resolved, rewrite.patched.as_bytes()) {
                Ok(()) => {
                    *rewritten += rewrite.links;
                    changed_paths.insert(rewrite.path);
                }
                Err(error) => failures.push(crate::mutate::LinkRewriteFailure {
                    path: rewrite.path,
                    reason: crate::mutate::LinkRewriteReason::WriteFailed(
                        crate::mutate::IoKind::of(&error),
                    ),
                }),
            }
        }
        failures.sort_by(|left, right| {
            (&left.path, left.reason.as_str()).cmp(&(&right.path, right.reason.as_str()))
        });

        self.reach(crate::HookPoint::BeforeRenameMove);
        let moved = self.engine.rename_onto_reservation(
            &match expected {
                Some(expected) => crate::mutate::Mutation::RenameNote {
                    from: from.clone(),
                    to: to.clone(),
                    expected: expected.clone(),
                    rewrite_links: false,
                },
                None => crate::mutate::Mutation::RenameFolder {
                    from: from.clone(),
                    to: to.clone(),
                    rewrite_links: false,
                },
            },
            reservation,
        )?;
        changed_paths.extend(moved.changed_paths);

        Ok(crate::mutate::MutationOutcome {
            changed_paths,
            revision: moved.revision,
            links_rewritten: *rewritten,
            link_rewrite_failures: failures,
            // A rewritten referrer is a note by construction, so a burst that
            // repaired anything moved the semantic layer even in the shape
            // where the thing that *moved* was not itself a note.
            semantic: moved.semantic || *rewritten > 0,
        })
    }

    /// The `from -> to` map link repair works from: one entry for a note
    /// rename, one per contained path for a folder rename.
    ///
    /// **Every kind, not only the notes.** `paths_under` reports attachments
    /// and subfolders too, and they stay: a folder rename moves an attachment
    /// as surely as it moves a note, and `![[Folder/img.png]]` is a reference
    /// row that reaches it. The live graph carries no identity for a non-note,
    /// so the planner synthesizes one for its lookup keys; a path nothing
    /// references simply selects nothing and costs one candidate-key sweep.
    ///
    /// The **source** side is the stored spelling, because that is what the
    /// index and the graph are keyed by: a caller's `nested/` against a stored
    /// `Nested/` would produce a map matching no note at all. The
    /// **destination** side is the caller's own spelling, because the
    /// destination does not exist yet and there is nothing to canonicalize —
    /// so on a filesystem that normalizes Unicode, `changed_paths` (which
    /// `rename_paths` canonicalizes after the move) and a repaired link can
    /// disagree about how the destination is spelled. Both reach the same
    /// file; only the spelling differs, and the next reconciliation of that
    /// path settles it.
    fn repair_moves(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        is_note: bool,
    ) -> Result<std::collections::BTreeMap<VaultPath, VaultPath>, IndexError> {
        let mut moves = std::collections::BTreeMap::new();
        let stored_from = self.engine.stored_spelling(from)?;
        if is_note {
            moves.insert(stored_from, to.clone());
            return Ok(moves);
        }
        for path in crate::mutate::paths_under(&self.config.canonical_vault_root, &stored_from)? {
            let Some(suffix) = path
                .as_str()
                .strip_prefix(stored_from.as_str())
                .and_then(|rest| rest.strip_prefix('/'))
            else {
                continue;
            };
            let destination = VaultPath::new(format!("{}/{suffix}", to.as_str()))
                .map_err(|error| IndexError::InvalidPath(error.to_string()))?;
            moves.insert(path, destination);
        }
        Ok(moves)
    }

    /// Refuse every mutation. Reads, snapshots, and reconciliation are
    /// unaffected.
    pub fn set_read_only(&mut self, read_only: bool) {
        self.engine = self.engine.clone().with_read_only(read_only);
    }

    pub fn mutation_engine(&self) -> &crate::mutate::MutationEngine {
        &self.engine
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

    /// Lower the selected-reference count at which incremental reconciliation
    /// gives up and re-resolves everything the compact graph holds. Test-only:
    /// the production threshold starts at ten thousand references, so the
    /// fallback branch would otherwise be unreachable in any fixture small
    /// enough to assert on.
    #[doc(hidden)]
    pub fn set_complete_resolution_threshold_for_test(&mut self, threshold: usize) {
        self.live_threshold_override = Some(threshold);
    }

    /// Install the rendezvous hook every [`crate::HookPoint`] fires into.
    /// Test-only: production leaves the slot empty and pays one `Option`
    /// check per point.
    #[doc(hidden)]
    pub fn install_test_hook(&mut self, hook: std::sync::Arc<dyn crate::TestHook>) {
        self.engine = self.engine.clone().with_test_hook(Arc::clone(&hook));
        self.test_hook = Some(hook);
    }

    /// Fire one hook point, if a test installed a hook.
    pub(crate) fn reach(&self, point: crate::HookPoint) {
        if let Some(hook) = &self.test_hook {
            hook.reach(point);
        }
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
        self.refresh_with(verify, Self::try_refresh)
    }

    /// Run the complete path even when a generation already exists — the same
    /// whole-vault inventory, read, resolve, and publish the cold build runs.
    ///
    /// Test-only. `refresh` routes every warm call through the incremental
    /// engine, so the complete path's own publication window (rows written and
    /// its transaction open, with no barrier held) is otherwise reachable only
    /// on a cold build, where there is no previous generation for a reader to
    /// keep answering from.
    #[doc(hidden)]
    pub fn refresh_complete_for_test(&mut self, verify: bool) -> Result<RefreshReport, IndexError> {
        self.refresh_with(verify, |service, verify| {
            let mut metrics = ReconcileMetrics::default();
            let outcome = service.try_complete_refresh(verify, &mut metrics);
            service.last_metrics = Some(metrics);
            outcome
        })
    }

    fn refresh_with(
        &mut self,
        verify: bool,
        mut attempt: impl FnMut(&mut Self, bool) -> Result<TryOutcome, IndexError>,
    ) -> Result<RefreshReport, IndexError> {
        for _ in 0..MAX_RECONCILE_RETRIES {
            match attempt(self, verify)? {
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

    /// Route one refresh attempt. Once a generation exists, both normal and
    /// verified refresh calculate a dirty set and hand it to the same targeted
    /// engine `refresh_paths` uses, so an ordinary refresh no longer loads,
    /// parses, or re-resolves anything the change did not select. The cold,
    /// first-ever build stays on the complete path below — there is nothing to
    /// be incremental against.
    fn try_refresh_body(
        &mut self,
        verify: bool,
        metrics: &mut ReconcileMetrics,
    ) -> Result<TryOutcome, IndexError> {
        if let Some(expected) = self.current_generation()? {
            let outcome = self.refresh_dirty_paths(expected, verify, metrics)?;
            return Ok(TryOutcome::Done(RefreshReport {
                previous_generation: Some(outcome.previous_generation),
                generation: outcome.generation,
                // Note counts, not the merged change set: `refresh_index`
                // has always answered "how many notes moved", and a folder
                // appearing must not be reported as a note added.
                added: outcome.note_changes.created,
                changed: outcome.note_changes.modified,
                deleted: outcome.note_changes.deleted,
                unchanged: outcome.unchanged,
                reparsed: outcome.reparsed,
                verified: verify,
            }));
        }
        self.try_complete_refresh(verify, metrics)
    }

    /// The complete path: one whole-vault inventory, every added or changed
    /// body read (every body in verified mode), and one whole-vault
    /// resolution. This is the cold build — and the only path that can run
    /// without a published generation to be incremental against.
    fn try_complete_refresh(
        &mut self,
        verify: bool,
        metrics: &mut ReconcileMetrics,
    ) -> Result<TryOutcome, IndexError> {
        let previous = self.current_generation()?;
        let inventory_start = Instant::now();
        // One walk, both products: the note inventory and the file tree the
        // same walk saw.
        let (first, observed_tree) = self.source.inventory_and_tree()?;
        metrics.stages.inventory += inventory_start.elapsed();
        metrics.work.complete_inventories += 1;
        let stored = self.store.stored_fingerprints()?;
        let tree_delta = if self.source.observes_tree() {
            tree::diff_scan(&self.store.stored_tree_map()?, &observed_tree)
        } else {
            TreeDelta::default()
        };

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

        // Canonical order, matching what the delta path stores, so a set that
        // did not change is never rewritten just because the two paths
        // assembled it in different orders.
        crate::live_reconcile::sort_scan_diagnostics(&mut diagnostics);

        if !semantic_change && diagnostics != self.store.load_scan_diagnostics()? {
            semantic_change = true;
        }
        // A file appearing, disappearing, or restating itself is a change a
        // tree client can only learn from a new generation, even when no note
        // moved at all.
        if tree_delta.is_generational() {
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
                tree_delta,
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
            // The tree delta here can only be the non-generational kind — a
            // note's or a folder's own metadata — which rides the same
            // non-publishing refresh the note fingerprints do.
            self.store.touch(&fingerprint_updates, &tree_delta)?;
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
            tree_delta,
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
        tree_delta: TreeDelta,
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
            tree: &tree_delta,
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
        let prepare_start = Instant::now();
        let prepared = Arc::new(live_graph_from_semantic(next_generation, &report.graph)?);
        metrics.stages.live_install += prepare_start.elapsed();

        // Only now the barrier, and only for the commit plus the install.
        // The commit is the one place a lock is deliberately held across
        // SQLite I/O, because that is the whole point: rows and live graph
        // become visible together or not at all, so no reader can catch a
        // generation whose two halves disagree.
        //
        // Not a cheap section, and not claimed to be: `wal_autocheckpoint`
        // defaults to 1000 pages, so a whole-vault snapshot's commit runs a
        // passive checkpoint here. The exclusive section is therefore commit
        // plus checkpoint I/O proportional to the snapshot just written,
        // then a pointer swap for the install — strictly smaller than before
        // the begin/commit split, which held the barrier across the row
        // writes as well. Tuning `wal_autocheckpoint` (or checkpointing
        // deliberately outside the barrier) is a known follow-up.
        //
        // Lock order here is SQLite write transaction -> publication
        // barrier, the reverse of a reader's barrier -> SQLite read
        // snapshot. That cannot deadlock, for three reasons, none of which
        // is "WAL readers never block":
        //
        // (a) A thread waiting on the barrier holds no SQLite lock at all.
        //     `IndexReader::read` takes the barrier guard first, then the
        //     connection mutex, then begins its transaction, and unwinds in
        //     the reverse order — so the commit below never waits on a
        //     thread that is itself waiting for the barrier.
        // (b) Reader connections are `query_only` and use `BEGIN DEFERRED`,
        //     so an in-flight read never contends for the writer's lock in
        //     the ordinary path.
        // (c) The corner cases where a WAL reader does take a lock (shm
        //     recovery, a checkpointer holding read marks) are bounded by
        //     `busy_timeout(5s)`: they can stall a publication, never wedge
        //     it.
        //
        // A snapshot session (`snapshot.rs`) is the one reader that takes no
        // barrier at all, deliberately: it serves SQL rows only, never the
        // live graph, so the commit below is its authoritative publish and it
        // may see a generation a hair before that generation's install
        // finishes. Taking no lock only strengthens (a) — such a reader can
        // never be the thread this commit waits on.
        let mut published = write_published(&self.published)?;
        let (generation, publish_metrics) = pending.commit()?;
        if let Some(hook) = &self.publication_pause {
            hook();
        }
        let install_start = Instant::now();
        published.generation = Some(generation);
        published.graph = Some(prepared);
        metrics.stages.live_install += install_start.elapsed();
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
    /// The graph delta is prepared — every fallible allocation included —
    /// before the write guard is taken. The guard then spans the *whole* row
    /// delta, not just its commit: unlike the full path, this holds the
    /// barrier across `IndexStore::publish_delta` in its entirety (the
    /// compare-and-swap read, every scoped write, and the commit), because
    /// that path owns its transaction from open to commit and has no
    /// begin/commit split.
    ///
    /// That is a deliberate asymmetry, not an oversight. A delta's writes
    /// are bounded by the delta itself — every statement is scoped by an
    /// explicit `note_path` or `reference_id` drawn from the caller's own
    /// change set — so the exclusive section scales with what changed, not
    /// with the size of the vault. The full path had to be split because a
    /// whole-vault rewrite under the barrier would freeze every reader for
    /// the length of that rewrite; a delta has no such window to remove.
    ///
    /// Either way both halves land together or neither does, and a lost
    /// compare-and-swap leaves the published graph exactly as it was.
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
        let prepare_start = Instant::now();
        let delta = {
            let graph = self.published_graph(expected)?;
            graph.prepare_delta(
                expected,
                replacement_notes,
                removed_paths,
                replacement_references,
            )?
        };
        let prepare = prepare_start.elapsed();
        // Everything fallible is prepared and nothing is committed: the last
        // instant at which a foreign writer can still steal this generation.
        self.reach(crate::HookPoint::BeforeDeltaPublication);

        let mut published = write_published(&self.published)?;
        let outcome = self.store.publish_delta(publication)?;
        match outcome {
            DeltaPublishOutcome::Committed {
                generation,
                counts,
                mut timings,
            } => {
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
                //
                // The tripwire below is what keeps that a documented claim
                // rather than a hope: nothing else in the process would ever
                // report the copy, so a leaked handle would show up only as
                // unexplained latency.
                debug_assert_eq!(
                    Arc::strong_count(graph),
                    1,
                    "a held published_state() handle forces a whole-graph copy at install"
                );
                let install_start = Instant::now();
                Arc::make_mut(graph).install(delta);
                timings.live_install = prepare + install_start.elapsed();
                published.generation = Some(generation);
                drop(published);
                Ok(DeltaPublishOutcome::Committed {
                    generation,
                    counts,
                    timings,
                })
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
    pub(crate) fn published_graph(
        &self,
        expected: Generation,
    ) -> Result<Arc<LiveGraph>, IndexError> {
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
    pub(crate) fn republish_current(&mut self, generation: Generation) -> Result<(), IndexError> {
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
