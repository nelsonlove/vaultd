//! Which views a committed generation may have changed.
//!
//! The rule is coarse and cheap, runs on the dispatcher (never on the
//! coordinator), and is memoized per generation, so N connections pay for it
//! once. It may say a view changed when it did not; it must never say a view
//! is fresh when it changed. A view is stale at generation G when
//!
//! 1. its base's path is in G's change set (a deleted folder counts for
//!    every base under it); or
//! 2. a changed path is in the row set the view last answered, for any
//!    `this_path` (a deleted folder counts for every row under it); or
//! 3. a changed path that exists at G passes every one of the view's
//!    prefilters (a view with none passes every path); or
//! 4. the view reads formulas or backlinks, and any note changed; or it
//!    reads links (`file()`, `link()`, `asFile()`, `file.links` reach
//!    attachments too), and any file changed; or
//! 5. the view reads `this`, and any file changed: `this` is an embedding
//!    note, the rule runs per view, not per embedding, and
//!    `this.file.links[…].asFile()` reaches attachments; or
//! 6. a note whose references re-resolved to a different answer at G
//!    (`LiveRefreshReport::reresolved`) counts as changed for clauses 2 to 5.
//!
//! Clauses 5 and 6 are this daemon's additions to the spec's four; both only
//! ever add events. A deleted path that is not a note may have been a folder
//! holding notes, so it counts as a changed note for clauses 4 and 5.
//!
//! A generation decided once is never decided again over the state its
//! decision pruned. A dispatcher can reach a generation's notice long after
//! another decided it (a connection inbox holds hundreds of notices), and an
//! evaluation recorded late makes the newer decisions it missed void; either
//! way the memo has no answer for a generation at or below the newest one
//! decided, and the answer is conservative instead: every view the catalog
//! knows, every view any client was answered, and every view a decision for
//! that generation or a newer one named.
//!
//! Not covered, and accepted: a view that reads `now()` or `today()` moves
//! with the clock, not with a generation. Its cached answer (and the instant
//! it was computed at) is kept until the next generation or until the cache
//! evicts it, whatever the client does (a re-ask at the same generation is a
//! cache hit), and no event marks the day turning over.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use vault_bases::Prefilter;
use vault_core::VaultPath;
use vault_index::{BaseViewDependencies, IndexReader, LiveRefreshReport, PrefilterFacts};
use vault_protocol::ViewsInvalidatedEventDto;

/// How many generations' decisions are kept, so a connection whose
/// dispatcher runs a few generations behind another still finds its answer.
/// A dispatcher further behind gets the conservative answer.
const DECIDED_GENERATIONS: usize = 16;

/// How many generations behind the newest decided one a dispatcher can
/// still be: a connection's notice inbox, then its input mailbox, then the
/// notice in hand. A retired name older than this can no longer be asked
/// for, so it is forgotten.
const RETIRED_WINDOW: u64 =
    (crate::broadcast::CONNECTION_NOTICE_CAPACITY + crate::connection::INPUT_CAPACITY + 1) as u64;

type ViewKey = (VaultPath, String);

#[derive(Default)]
struct Catalog {
    /// Every base's views and their dependencies; `None` until first needed.
    dependencies: Option<BTreeMap<VaultPath, BaseViewDependencies>>,
    /// The generation the catalog reflects at least: every base change at or
    /// below it is in `dependencies`.
    at: u64,
    decided: BTreeMap<u64, Arc<Vec<ViewsInvalidatedEventDto>>>,
    /// The newest generation ever decided, whether its decision is still in
    /// `decided` or not.
    newest_decided: Option<u64>,
    /// Views no longer in `decided` or in the rows that a decision named or a
    /// prune dropped, each with the newest generation it was retired at, so
    /// a conservative answer for an older generation still names them (a
    /// deleted base is in neither the catalog nor the rows any more).
    /// Bounded by [`RETIRED_WINDOW`].
    retired: BTreeMap<ViewKey, u64>,
}

impl Catalog {
    fn retire(&mut self, generation: u64, keys: impl IntoIterator<Item = ViewKey>) {
        for key in keys {
            let at = self.retired.entry(key).or_insert(generation);
            *at = (*at).max(generation);
        }
    }

    fn retire_decision(&mut self, generation: u64, events: &[ViewsInvalidatedEventDto]) {
        let keys: Vec<ViewKey> = events
            .iter()
            .filter_map(|event| {
                VaultPath::new(event.base.as_str())
                    .ok()
                    .map(|base| (base, event.view.clone()))
            })
            .collect();
        self.retire(generation, keys);
    }
}

/// The per-server memory the rule needs: what each view last answered, and
/// every base's views with what they read.
///
/// Lock order: `catalog`, then `rows`; `late` is a leaf. A `record` takes
/// `rows` and then `late`, never `catalog`, and a decision takes `rows` only
/// after its two index reads, so a request's `record` never waits for a
/// decision's index reads.
pub(crate) struct ViewTracker {
    /// The rows each (base, view) answered, over every `this_path` and every
    /// evaluation since the paths were last pruned. Only ever grows between
    /// prunes, so a record from a newer generation can never hide a row a
    /// client still holds from an older one.
    rows: Mutex<BTreeMap<ViewKey, BTreeSet<VaultPath>>>,
    catalog: Mutex<Catalog>,
    /// The oldest generation a late record answered at: every decision newer
    /// than it is void, and the next decision retires them.
    late: Mutex<Option<u64>>,
    /// How many decisions `catalog.decided` keeps.
    memo: usize,
}

impl Default for ViewTracker {
    fn default() -> Self {
        Self::with_memo(DECIDED_GENERATIONS)
    }
}

/// Whether `path`, with `facts` at the current generation, passes one
/// prefilter. A superset of the index row source's own narrowing for the
/// same prefilter (`PropertyEquals` asks only for the key), which is the
/// direction that can only add events.
fn passes(prefilter: &Prefilter, path: &VaultPath, facts: &PrefilterFacts) -> bool {
    match prefilter {
        Prefilter::InFolder(folder) => {
            let folder = folder.trim_matches('/');
            folder.is_empty() || path.as_str().starts_with(&format!("{folder}/"))
        }
        Prefilter::Ext(ext) => vault_bases::extension(path) == ext.as_str(),
        Prefilter::HasTag(tags) => facts.tags.iter().any(|have| {
            tags.iter().any(|want| {
                let want = want.trim_start_matches('#').to_lowercase();
                *have == want || have.starts_with(&format!("{want}/"))
            })
        }),
        Prefilter::PropertyEquals { key, .. } => facts.keys.contains(&key.to_lowercase()),
    }
}

/// Whether `path` is `deleted` or lies under it (a deleted folder implies
/// its subtree).
fn under(path: &VaultPath, deleted: &VaultPath) -> bool {
    path == deleted
        || path
            .as_str()
            .strip_prefix(deleted.as_str())
            .is_some_and(|rest| rest.starts_with('/'))
}

fn events_at(generation: u64, keys: BTreeSet<ViewKey>) -> Vec<ViewsInvalidatedEventDto> {
    keys.into_iter()
        .map(|(base, view)| ViewsInvalidatedEventDto {
            base: base.as_str().to_string(),
            view,
            generation,
        })
        .collect()
}

impl ViewTracker {
    /// A tracker that memoizes `memo` decisions (at least one).
    pub(crate) fn with_memo(memo: usize) -> Self {
        Self {
            rows: Mutex::default(),
            catalog: Mutex::default(),
            late: Mutex::default(),
            memo: memo.max(1),
        }
    }

    /// Remember what a view answered at `generation`, for clause 2.
    ///
    /// An evaluation that raced a commit can be recorded after another
    /// connection's dispatcher already decided a newer generation without
    /// it. Those decisions are void from here on: the next decision retires
    /// them, so the dispatcher that serves this answer's client (which
    /// handles the newer generations only after this response) gets the
    /// conservative answer for them, which names this view.
    pub(crate) fn record(
        &self,
        base: &VaultPath,
        view: &str,
        generation: u64,
        rows: impl Iterator<Item = VaultPath>,
    ) {
        self.rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry((base.clone(), view.to_string()))
            .or_default()
            .extend(rows);
        let mut late = self
            .late
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *late = Some(late.map_or(generation, |oldest| oldest.min(generation)));
    }

    /// Every view this tracker knows (the catalog's and every answered
    /// one), named at `generation`: what a change no generation carries
    /// (the declared property types) invalidates.
    pub(crate) fn every_known_view(&self, generation: u64) -> Vec<ViewsInvalidatedEventDto> {
        let catalog = self
            .catalog
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rows = self
            .rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut keys: BTreeSet<ViewKey> = rows.keys().cloned().collect();
        for (base, views) in catalog.dependencies.iter().flatten() {
            for (view, _) in views {
                keys.insert((base.clone(), view.clone()));
            }
        }
        events_at(generation, keys)
    }

    /// The answer for a generation decided once whose decision is gone (past
    /// the memo, or void after a late record): every view the catalog knows,
    /// every answered view, and every view a decision at or after
    /// `generation` named.
    fn conservative(&self, catalog: &Catalog, generation: u64) -> Vec<ViewsInvalidatedEventDto> {
        let mut keys: BTreeSet<ViewKey> = self
            .rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        for (base, views) in catalog.dependencies.iter().flatten() {
            for (view, _) in views {
                keys.insert((base.clone(), view.clone()));
            }
        }
        for (key, at) in &catalog.retired {
            if *at >= generation {
                keys.insert(key.clone());
            }
        }
        for (_, events) in catalog.decided.range(generation..) {
            for event in events.iter() {
                if let Ok(base) = VaultPath::new(event.base.as_str()) {
                    keys.insert((base, event.view.clone()));
                }
            }
        }
        events_at(generation, keys)
    }

    /// The views `report`'s generation may have changed, one event each.
    pub(crate) fn stale_views(
        &self,
        reader: &IndexReader,
        report: &LiveRefreshReport,
    ) -> Vec<ViewsInvalidatedEventDto> {
        let generation = report.generation.get();
        let mut catalog = self
            .catalog
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let late = self
            .late
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(after) = late {
            let void = catalog.decided.split_off(&(after + 1));
            for (at, events) in void {
                catalog.retire_decision(at, &events);
            }
        }
        if let Some(events) = catalog.decided.get(&generation) {
            return events.as_ref().clone();
        }
        if catalog
            .newest_decided
            .is_some_and(|newest| generation <= newest)
        {
            return self.conservative(&catalog, generation);
        }

        let changes = &report.changes;
        let changed: BTreeSet<VaultPath> = changes
            .created
            .iter()
            .chain(&changes.modified)
            .chain(&changes.deleted)
            .chain(&report.reresolved)
            .cloned()
            .collect();
        let deleted: Vec<&VaultPath> = changes.deleted.iter().collect();
        let note_changed = changed.iter().any(VaultPath::is_markdown)
            || deleted.iter().any(|path| !path.is_base());
        let file_changed = !changed.is_empty();

        // The views of a base that just vanished still need their event, so
        // their names are taken from the previous catalog before it is
        // refreshed.
        let previous = catalog.dependencies.take();
        let mut changed_bases: BTreeSet<VaultPath> = changed
            .iter()
            .filter(|path| path.is_base())
            .cloned()
            .collect();
        for base in previous.iter().flat_map(|known| known.keys()) {
            if deleted.iter().any(|gone| under(base, gone)) {
                changed_bases.insert(base.clone());
            }
        }
        // Patched in place only when the catalog already reflects every
        // generation up to this report's predecessor; after any gap (a
        // generation no dispatcher saw, a resync, the first call) it is
        // reloaded whole, so a base created in the gap is never missed.
        let continuous = previous.is_some()
            && report
                .previous_generation
                .is_some_and(|before| catalog.at >= before.get());
        let refreshed = match &previous {
            Some(known) if continuous => {
                if changed_bases.is_empty() {
                    Ok((generation, known.clone()))
                } else {
                    reader
                        .base_dependencies(Some(&changed_bases))
                        .map(|(_, fresh)| {
                            let mut merged = known.clone();
                            for path in &changed_bases {
                                merged.remove(path);
                            }
                            merged.extend(fresh);
                            (generation.max(catalog.at), merged)
                        })
                }
            }
            _ => reader
                .base_dependencies(None)
                .map(|(at, all)| (at.get(), all)),
        };
        let facts = reader
            .prefilter_facts(&changed)
            .ok()
            .map(|(_, facts)| facts);
        // When the index cannot answer, every known view is stale: the one
        // failure that may never become a false negative.
        let (current, facts, reloaded) = match refreshed {
            Ok((at, current)) => {
                catalog.at = at;
                (current, facts, !continuous)
            }
            Err(_) => (previous.clone().unwrap_or_default(), None, false),
        };

        // The rows only now, after both index reads: a request's `record`
        // never waits for them.
        let rows = self
            .rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The views any client was answered are known from the rows they
        // were answered with, whatever the catalog knew: the first
        // generation this tracker decides may be the one that deletes a base.
        for (base, _) in rows.keys().chain(catalog.retired.keys()) {
            if deleted.iter().any(|gone| under(base, gone)) {
                changed_bases.insert(base.clone());
            }
        }
        let mut stale: BTreeSet<ViewKey> = BTreeSet::new();
        if facts.is_none() {
            stale.extend(rows.keys().cloned());
        }
        for path in &changed_bases {
            let before = previous.as_ref().and_then(|known| known.get(path));
            for (view, _) in before.into_iter().chain(current.get(path)).flatten() {
                stale.insert((path.clone(), view.clone()));
            }
            // A view whose rows a reload already pruned (its base was
            // missing from a catalog read ahead of this generation) is
            // retired, not forgotten.
            for (base, view) in rows.keys().chain(catalog.retired.keys()) {
                if base == path {
                    stale.insert((base.clone(), view.clone()));
                }
            }
        }
        for (base, views) in &current {
            for (view, dependencies) in views {
                let key = (base.clone(), view.clone());
                if stale.contains(&key) {
                    continue;
                }
                let is_stale = match (dependencies, &facts) {
                    (None, _) | (_, None) => true,
                    (Some(reads), Some(facts)) => {
                        let row_changed = rows.get(&key).is_some_and(|answered| {
                            changed.iter().any(|path| answered.contains(path))
                                || answered
                                    .iter()
                                    .any(|row| deleted.iter().any(|gone| under(row, gone)))
                        });
                        let passes_prefilters = || {
                            facts.iter().any(|(path, facts)| {
                                reads.prefilters.iter().all(|p| passes(p, path, facts))
                            })
                        };
                        let reads_files = reads.reads_links || reads.reads_this;
                        let reads_notes = reads.reads_formulas || reads.reads_backlinks;
                        row_changed
                            || passes_prefilters()
                            || (reads_files && file_changed)
                            || (reads_notes && note_changed)
                    }
                };
                if is_stale {
                    stale.insert(key);
                }
            }
        }
        drop(rows);
        let reloaded = reloaded.then_some(&current);
        let dropped = self.prune(&changed_bases, &current, reloaded, &deleted);
        catalog.retire(generation, dropped);

        let events = events_at(generation, stale);
        catalog.dependencies = Some(current);
        catalog.decided.insert(generation, Arc::new(events.clone()));
        catalog.newest_decided = Some(generation);
        while catalog.decided.len() > self.memo {
            if let Some((at, events)) = catalog.decided.pop_first() {
                catalog.retire_decision(at, &events);
            }
        }
        let floor = generation.saturating_sub(RETIRED_WINDOW);
        catalog.retired.retain(|_, at| *at >= floor);
        events
    }

    /// Forget the rows of the views a changed base no longer declares, the
    /// rows of every base missing from a reloaded catalog (a base deleted
    /// through a resync, which no change set names), and every row a
    /// deletion removed; answer the views whose rows were forgotten, so the
    /// caller retires them.
    ///
    /// Sound after the generation is decided: each client holding such a row
    /// was just told (clause 1 or 2) or was told to re-read everything (the
    /// resync); a dispatcher that reaches this generation or an older one
    /// later gets the conservative answer, which names every retired view;
    /// and a reloaded catalog is read at the published generation, which may
    /// lead this one, so a base it lacks may be deleted only at a later
    /// generation, whose decision names the retired views of a changed base.
    ///
    /// Bound: `rows` holds at most (views answered) × (paths in their
    /// answers since the last prune); a row is dropped only when it is
    /// deleted or its view goes, so a long-lived daemon whose clients answer
    /// many large views holds every such row until then.
    fn prune(
        &self,
        changed_bases: &BTreeSet<VaultPath>,
        current: &BTreeMap<VaultPath, BaseViewDependencies>,
        reloaded: Option<&BTreeMap<VaultPath, BaseViewDependencies>>,
        deleted: &[&VaultPath],
    ) -> Vec<ViewKey> {
        let mut rows = self
            .rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut dropped = Vec::new();
        rows.retain(|(base, view), _| {
            let declared = |catalog: &BTreeMap<VaultPath, BaseViewDependencies>| {
                catalog
                    .get(base)
                    .is_some_and(|views| views.iter().any(|(name, _)| name == view))
            };
            let keep = (!changed_bases.contains(base) || declared(current))
                && reloaded.is_none_or(|catalog| catalog.contains_key(base));
            if !keep {
                dropped.push((base.clone(), view.clone()));
            }
            keep
        });
        if !deleted.is_empty() {
            for answered in rows.values_mut() {
                answered.retain(|row| !deleted.iter().any(|gone| under(row, gone)));
            }
        }
        dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vp(path: &str) -> VaultPath {
        VaultPath::new(path).unwrap()
    }

    fn scratch() -> tempfile::TempDir {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::TempDir::new_in(root.canonicalize().unwrap()).unwrap()
    }

    /// A vault with `Books/A.md`, `Other/U.md` and a base whose one view
    /// reads `Books`, its service, and a reader.
    fn indexed() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        vault_index::IndexService,
        IndexReader,
    ) {
        let vault = scratch();
        let index = scratch();
        std::fs::create_dir_all(vault.path().join("Books")).unwrap();
        std::fs::create_dir_all(vault.path().join("Other")).unwrap();
        std::fs::write(vault.path().join("Books/A.md"), "a\n").unwrap();
        std::fs::write(vault.path().join("Other/U.md"), "u\n").unwrap();
        std::fs::write(
            vault.path().join("V.base"),
            "views:\n  - type: table\n    name: InBooks\n    filters: 'file.inFolder(\"Books\")'\n",
        )
        .unwrap();
        let config =
            vault_index::IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
                .unwrap();
        let mut service = vault_index::IndexService::open(config).unwrap();
        service.refresh(false).unwrap();
        let reader = service.reader().unwrap();
        (vault, index, service, reader)
    }

    fn names(events: &[ViewsInvalidatedEventDto]) -> Vec<String> {
        events
            .iter()
            .map(|event| format!("{}#{}", event.base, event.view))
            .collect()
    }

    /// The watcher route names a deleted folder alone; every row under it
    /// counts for clause 2 (the mutation route names each descendant, so the
    /// wire tests cannot tell the two apart).
    #[test]
    fn a_folder_deleted_alone_stales_the_views_with_rows_under_it() {
        let (vault, _index, mut service, reader) = indexed();
        let tracker = ViewTracker::default();
        let at = reader.published_status().unwrap().generation.unwrap().get();
        tracker.record(&vp("V.base"), "InBooks", at, [vp("Books/A.md")].into_iter());
        std::fs::remove_dir_all(vault.path().join("Books")).unwrap();
        let mut report = service
            .refresh_paths(
                [vp("Books"), vp("Books/A.md")].into(),
                vault_index::ChangeCause::Watcher,
            )
            .unwrap();
        report.changes = vault_index::PathChanges {
            created: Vec::new(),
            modified: Vec::new(),
            deleted: vec![vp("Books")],
        };
        assert_eq!(
            names(&tracker.stale_views(&reader, &report)),
            ["V.base#InBooks"]
        );
    }

    /// An evaluation that raced a commit is recorded after another
    /// dispatcher decided the newer generation without it: the record
    /// forgets that decision, and deciding it again sees the row.
    #[test]
    fn a_late_record_forgets_the_newer_decisions_it_missed() {
        let (vault, _index, mut service, reader) = indexed();
        let before = reader.published_status().unwrap().generation.unwrap().get();
        std::fs::remove_file(vault.path().join("Books/A.md")).unwrap();
        let report = service
            .refresh_paths([vp("Books/A.md")].into(), vault_index::ChangeCause::Watcher)
            .unwrap();
        let tracker = ViewTracker::default();
        assert!(
            tracker.stale_views(&reader, &report).is_empty(),
            "decided before anyone recorded the row"
        );
        tracker.record(
            &vp("V.base"),
            "InBooks",
            before,
            [vp("Books/A.md")].into_iter(),
        );
        assert_eq!(
            names(&tracker.stale_views(&reader, &report)),
            ["V.base#InBooks"],
            "decided again with the late row"
        );
    }

    /// Publish `count` unrelated generations (one new note each under
    /// `Other/`) and let `tracker` decide each one, as a fast dispatcher
    /// would.
    fn decide_more(
        vault: &tempfile::TempDir,
        service: &mut vault_index::IndexService,
        reader: &IndexReader,
        tracker: &ViewTracker,
        count: usize,
    ) {
        for at in 0..count {
            let name = format!("Other/N{at}.md");
            std::fs::write(vault.path().join(&name), "n\n").unwrap();
            let report = service
                .refresh_paths([vp(&name)].into(), vault_index::ChangeCause::Watcher)
                .unwrap();
            tracker.stale_views(reader, &report);
        }
    }

    /// H2: a dispatcher that reaches a generation after the fast one has
    /// decided it and `later` more still hears that a recorded row was
    /// deleted there, though the row has since been pruned.
    fn a_lagging_dispatcher_names_a_deleted_row(tracker: ViewTracker, later: usize) {
        let (vault, _index, mut service, reader) = indexed();
        let at = reader.published_status().unwrap().generation.unwrap().get();
        tracker.record(&vp("V.base"), "InBooks", at, [vp("Books/A.md")].into_iter());
        std::fs::remove_file(vault.path().join("Books/A.md")).unwrap();
        let deleted = service
            .refresh_paths([vp("Books/A.md")].into(), vault_index::ChangeCause::Watcher)
            .unwrap();
        assert_eq!(
            names(&tracker.stale_views(&reader, &deleted)),
            ["V.base#InBooks"],
            "the fast dispatcher"
        );
        decide_more(&vault, &mut service, &reader, &tracker, later);
        assert_eq!(
            names(&tracker.stale_views(&reader, &deleted)),
            ["V.base#InBooks"],
            "the lagging dispatcher, {later} generations later"
        );
    }

    #[test]
    fn a_dispatcher_past_the_memo_still_names_a_deleted_row() {
        a_lagging_dispatcher_names_a_deleted_row(ViewTracker::default(), DECIDED_GENERATIONS);
    }

    /// The window itself: with a memo of one generation, a dispatcher two
    /// generations behind already misses the memo.
    #[test]
    fn a_dispatcher_just_past_a_memo_of_one_still_names_a_deleted_row() {
        a_lagging_dispatcher_names_a_deleted_row(ViewTracker::with_memo(1), 1);
    }

    /// H2 for a base deleted at the generation the lagging dispatcher
    /// reaches: its views are gone from the catalog and from the rows.
    #[test]
    fn a_dispatcher_past_the_memo_still_names_a_deleted_bases_views() {
        let (vault, _index, mut service, reader) = indexed();
        let tracker = ViewTracker::default();
        let at = reader.published_status().unwrap().generation.unwrap().get();
        tracker.record(&vp("V.base"), "InBooks", at, [vp("Books/A.md")].into_iter());
        std::fs::remove_file(vault.path().join("V.base")).unwrap();
        let deleted = service
            .refresh_paths([vp("V.base")].into(), vault_index::ChangeCause::Watcher)
            .unwrap();
        assert_eq!(
            names(&tracker.stale_views(&reader, &deleted)),
            ["V.base#InBooks"],
            "the fast dispatcher"
        );
        decide_more(&vault, &mut service, &reader, &tracker, DECIDED_GENERATIONS);
        assert_eq!(
            names(&tracker.stale_views(&reader, &deleted)),
            ["V.base#InBooks"],
            "the lagging dispatcher"
        );
    }

    #[test]
    fn a_deleted_folder_covers_its_subtree_and_nothing_beside_it() {
        assert!(under(&vp("Books/A.md"), &vp("Books")));
        assert!(under(&vp("Books"), &vp("Books")));
        assert!(!under(&vp("Bookshelf/A.md"), &vp("Books")));
    }

    #[test]
    fn prefilters_pass_by_folder_extension_tag_and_key() {
        let facts = PrefilterFacts {
            tags: vec!["book/fiction".into()],
            keys: vec!["status".into()],
        };
        let path = vp("Books/A.md");
        assert!(passes(
            &Prefilter::InFolder("/Books/".into()),
            &path,
            &facts
        ));
        assert!(!passes(&Prefilter::InFolder("Book".into()), &path, &facts));
        assert!(passes(&Prefilter::Ext("md".into()), &path, &facts));
        assert!(passes(
            &Prefilter::HasTag(vec!["#Book".into()]),
            &path,
            &facts
        ));
        assert!(!passes(
            &Prefilter::HasTag(vec!["boo".into()]),
            &path,
            &facts
        ));
        assert!(passes(
            &Prefilter::PropertyEquals {
                key: "Status".into(),
                value: vault_bases::ScalarLiteral::String("x".into()),
            },
            &path,
            &facts
        ));
    }
}
