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
//! 4. the view reads formulas, links or backlinks, and any note changed; or
//! 5. the view reads `this`, and any note changed: `this` is an embedding
//!    note, and the rule runs per view, not per embedding; or
//! 6. a note whose references re-resolved to a different answer at G
//!    (`LiveRefreshReport::reresolved`) counts as changed for clauses 2 to 5.
//!
//! Clauses 5 and 6 are this daemon's additions to the spec's four; both only
//! ever add events. A deleted path that is not a note may have been a folder
//! holding notes, so it counts as a changed note for clauses 4 and 5.
//!
//! Not covered, and accepted: a view that reads `now()` or `today()` moves
//! with the clock, not with a generation. Its cached answer (and the
//! instant it was computed at) is kept for the whole generation, and no
//! event marks the day turning over; a client that shows such a view
//! re-asks on its own schedule.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use vault_bases::Prefilter;
use vault_core::VaultPath;
use vault_index::{BaseViewDependencies, IndexReader, LiveRefreshReport, PrefilterFacts};
use vault_protocol::ViewsInvalidatedEventDto;

/// How many generations' decisions are kept, so a connection whose
/// dispatcher runs a few generations behind another still finds its answer.
const DECIDED_GENERATIONS: usize = 16;

type ViewKey = (VaultPath, String);

#[derive(Default)]
struct Catalog {
    /// Every base's views and their dependencies; `None` until first needed.
    dependencies: Option<BTreeMap<VaultPath, BaseViewDependencies>>,
    /// The generation the catalog reflects at least: every base change at or
    /// below it is in `dependencies`.
    at: u64,
    decided: BTreeMap<u64, Arc<Vec<ViewsInvalidatedEventDto>>>,
}

/// The per-server memory the rule needs: what each view last answered, and
/// every base's views with what they read.
#[derive(Default)]
pub(crate) struct ViewTracker {
    /// The rows each (base, view) answered, over every `this_path` and every
    /// evaluation since the paths were last pruned. Only ever grows between
    /// prunes, so a record from a newer generation can never hide a row a
    /// client still holds from an older one.
    rows: Mutex<BTreeMap<ViewKey, BTreeSet<VaultPath>>>,
    catalog: Mutex<Catalog>,
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

impl ViewTracker {
    /// Remember what a view answered at `generation`, for clause 2.
    ///
    /// An evaluation that raced a commit can be recorded after another
    /// connection's dispatcher already decided a newer generation without
    /// it. Those decisions are forgotten here, so the dispatcher that serves
    /// this answer's client (which handles the newer generations only after
    /// this response) decides them again, with these rows.
    pub(crate) fn record(
        &self,
        base: &VaultPath,
        view: &str,
        generation: u64,
        rows: impl Iterator<Item = VaultPath>,
    ) {
        {
            let mut recorded = self
                .rows
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            recorded
                .entry((base.clone(), view.to_string()))
                .or_default()
                .extend(rows);
        }
        // Never nested inside the rows lock: `stale_views` takes the catalog
        // first and the rows second.
        self.catalog
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .decided
            .retain(|decided, _| *decided <= generation);
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
        if let Some(events) = catalog.decided.get(&generation) {
            return events.as_ref().clone();
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

        // The views of a base that just vanished still need their event, so
        // their names are taken from the previous catalog before it is
        // refreshed.
        let previous = catalog.dependencies.take();
        // The views any client was answered are known from the rows they
        // were answered with, whatever the catalog knew: the first
        // generation this tracker decides may be the one that deletes a base.
        let rows = self
            .rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let answered_bases: BTreeSet<&VaultPath> = rows.keys().map(|(base, _)| base).collect();
        let mut changed_bases: BTreeSet<VaultPath> = changed
            .iter()
            .filter(|path| path.is_base())
            .cloned()
            .collect();
        for base in previous
            .iter()
            .flat_map(|known| known.keys())
            .chain(answered_bases.iter().copied())
        {
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
        // When the index cannot answer, every known view is stale: the one
        // failure that may never become a false negative.
        let facts = reader
            .prefilter_facts(&changed)
            .ok()
            .map(|(_, facts)| facts);
        let (current, facts) = match refreshed {
            Ok((at, current)) => {
                catalog.at = at;
                (current, facts)
            }
            Err(_) => (previous.clone().unwrap_or_default(), None),
        };

        let mut stale: BTreeSet<ViewKey> = BTreeSet::new();
        for path in &changed_bases {
            let before = previous.as_ref().and_then(|known| known.get(path));
            for (view, _) in before.into_iter().chain(current.get(path)).flatten() {
                stale.insert((path.clone(), view.clone()));
            }
            for (base, view) in rows.keys() {
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
                        let reads_notes = reads.reads_formulas
                            || reads.reads_links
                            || reads.reads_backlinks
                            || reads.reads_this;
                        row_changed || passes_prefilters() || (reads_notes && note_changed)
                    }
                };
                if is_stale {
                    stale.insert(key);
                }
            }
        }
        drop(rows);
        self.prune(&changed_bases, &current, &deleted);

        let events: Vec<ViewsInvalidatedEventDto> = stale
            .into_iter()
            .map(|(base, view)| ViewsInvalidatedEventDto {
                base: base.as_str().to_string(),
                view,
                generation,
            })
            .collect();
        catalog.dependencies = Some(current);
        catalog.decided.insert(generation, Arc::new(events.clone()));
        while catalog.decided.len() > DECIDED_GENERATIONS {
            catalog.decided.pop_first();
        }
        events
    }

    /// Forget the rows of the views a changed base no longer declares, and
    /// every row a deletion removed. Sound after the generation is decided:
    /// each client holding such a row was just told (clause 1 or 2), and an
    /// evaluation at an older generation that records one later also forgets
    /// the newer decisions, which are then made again with it. Only changed
    /// bases are pruned: a base missing from a catalog that lags the index is
    /// not gone.
    fn prune(
        &self,
        changed_bases: &BTreeSet<VaultPath>,
        current: &BTreeMap<VaultPath, BaseViewDependencies>,
        deleted: &[&VaultPath],
    ) {
        let mut rows = self
            .rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        rows.retain(|(base, view), _| {
            !changed_bases.contains(base)
                || current
                    .get(base)
                    .is_some_and(|views| views.iter().any(|(name, _)| name == view))
        });
        if !deleted.is_empty() {
            for answered in rows.values_mut() {
                answered.retain(|row| !deleted.iter().any(|gone| under(row, gone)));
            }
        }
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
