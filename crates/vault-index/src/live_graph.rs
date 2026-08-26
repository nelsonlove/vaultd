//! A compact, in-memory live resolution graph: the minimal per-note and
//! per-reference facts resolution needs (paths, headings, block ids, link
//! targets, and resolution outcomes), plus a reverse index from
//! `vault_core::DependencyKey` to the references that depend on it.
//!
//! Deliberately excluded: source bytes, property values, aliases, tags, and
//! full note DTOs. `retained_source_bytes` is always zero — a structural
//! guarantee, not a computed count.

use std::collections::{BTreeMap, BTreeSet};

use vault_core::{
    DependencyKey, LinkTarget, Resolution, ResolutionIdentityChange, ResolutionNote, VaultPath,
    changed_candidate_keys, reference_dependencies,
};

use crate::error::IndexError;
use crate::model::Generation;

/// A compact, per-graph-instance identity for a note. Never stable across
/// process restarts and never exposed through protocol DTOs.
///
/// Unrelated to `vault_core::NoteId` — both are crate-root re-exports that
/// happen to share a name across two different crates. A module that glob
/// imports both preludes (`use vault_core::*;` and `use vault_index::*;`)
/// will hit a name ambiguity; qualify one or both
/// (`vault_core::NoteId`/`vault_index::NoteId`) rather than relying on an
/// unqualified glob.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NoteId(u32);

/// A compact, per-graph-instance identity for one of a note's outgoing
/// references (its position in source order). Never exposed through
/// protocol DTOs.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ReferenceKey {
    pub source: NoteId,
    pub ordinal: u32,
}

/// The resolution-relevant facts about one note: its path plus heading and
/// block identity. No source bytes, properties, aliases, or tags.
#[derive(Clone, Debug)]
pub struct HydratedNote {
    pub path: VaultPath,
    pub headings: Vec<String>,
    pub blocks: Vec<String>,
}

/// The resolution-relevant facts about one outgoing reference: what it
/// points at and how it resolved. No span, display text, or raw markdown.
#[derive(Clone, Debug)]
pub struct HydratedReference {
    pub source_path: VaultPath,
    pub ordinal: u32,
    pub target: LinkTarget,
    pub resolution: Resolution,
}

#[derive(Clone, Debug, Default)]
struct NoteRecord {
    headings: Vec<String>,
    blocks: Vec<String>,
}

#[derive(Clone, Debug)]
struct ReferenceRecord {
    target: LinkTarget,
    resolution: Resolution,
    dependency_keys: Vec<DependencyKey>,
}

fn note_identity(path: &VaultPath, record: &NoteRecord) -> ResolutionNote {
    ResolutionNote {
        path: path.clone(),
        headings: record.headings.clone(),
        blocks: record.blocks.clone(),
    }
}

/// The candidate-map keys a note contributes when it is added, computed the
/// same way `dependents` keys are: only through `vault_core`'s own
/// `changed_candidate_keys`, never hand-built. Modeled as an add
/// (`old: None`) with no prior state.
fn added_candidate_keys(path: &VaultPath, record: &NoteRecord) -> BTreeSet<DependencyKey> {
    changed_candidate_keys(&ResolutionIdentityChange {
        old: None,
        new: Some(note_identity(path, record)),
    })
}

/// The candidate-map keys to retire when a note is removed: the mirror of
/// `added_candidate_keys`.
fn removed_candidate_keys(path: &VaultPath, record: &NoteRecord) -> BTreeSet<DependencyKey> {
    changed_candidate_keys(&ResolutionIdentityChange {
        old: Some(note_identity(path, record)),
        new: None,
    })
}

/// The bounded work one reconciliation cycle must redo: the references whose
/// resolution answer could have changed, plus a conservative escape hatch
/// for callers that must fall back to a complete resolution.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ImpactPlan {
    pub affected: BTreeSet<ReferenceKey>,
    /// Reserved for future overflow/uncertainty signaling (bounded dirty
    /// sets, malformed input, etc.). This task's `plan_impact` always
    /// answers from exact key lookups, so it is always `false` here.
    pub complete_resolution: bool,
}

/// A fully-allocated replacement for part of a `LiveGraph`, produced by
/// `prepare_delta` and applied by `install`. Building this does all the
/// allocation and dependency-key computation; `install` only swaps,
/// removes, and inserts already-built records.
#[derive(Clone, Debug)]
pub struct PreparedGraphDelta {
    generation: Generation,
    next_note_id: u32,
    new_note_ids: BTreeMap<VaultPath, NoteId>,
    note_updates: BTreeMap<VaultPath, (NoteId, NoteRecord)>,
    reference_updates: BTreeMap<VaultPath, Vec<(u32, ReferenceRecord)>>,
    removed_paths: Vec<VaultPath>,
    candidate_additions: BTreeMap<NoteId, Vec<DependencyKey>>,
    candidate_removals: BTreeMap<NoteId, Vec<DependencyKey>>,
}

/// The compact live resolution graph: path interning in both directions
/// (`paths`/`path_by_id`), a forward candidate index (dependency key ->
/// notes that could satisfy a reference using that key), per-source
/// references (grouped implicitly by `ReferenceKey` ordering), and a reverse
/// index from dependency key to the references that depend on it.
#[derive(Clone, Debug)]
pub struct LiveGraph {
    generation: Generation,
    next_note_id: u32,
    paths: BTreeMap<VaultPath, NoteId>,
    path_by_id: BTreeMap<NoteId, VaultPath>,
    notes: BTreeMap<NoteId, NoteRecord>,
    references: BTreeMap<ReferenceKey, ReferenceRecord>,
    dependents: BTreeMap<DependencyKey, BTreeSet<ReferenceKey>>,
    candidates: BTreeMap<DependencyKey, BTreeSet<NoteId>>,
}

impl LiveGraph {
    fn empty(generation: Generation) -> Self {
        Self {
            generation,
            next_note_id: 0,
            paths: BTreeMap::new(),
            path_by_id: BTreeMap::new(),
            notes: BTreeMap::new(),
            references: BTreeMap::new(),
            dependents: BTreeMap::new(),
            candidates: BTreeMap::new(),
        }
    }

    /// Build a graph from a complete set of hydrated notes and references,
    /// as read by `IndexStore::hydrate_live_graph`. Dependency keys are
    /// computed here, once, from each reference's own target and resolution.
    ///
    /// Fails if a reference names a `source_path` outside `notes` — that can
    /// only mean the caller handed us an inconsistent snapshot (e.g. a torn
    /// read), and silently dropping the reference would under-select it
    /// forever (it would never appear in `dependents`), which conservative
    /// invalidation forbids.
    pub(crate) fn from_hydrated(
        generation: Generation,
        notes: Vec<HydratedNote>,
        references: Vec<HydratedReference>,
    ) -> Result<Self, IndexError> {
        let mut graph = Self::empty(generation);
        for note in notes {
            let id = NoteId(graph.next_note_id);
            graph.next_note_id += 1;
            let record = NoteRecord {
                headings: note.headings,
                blocks: note.blocks,
            };
            for key in added_candidate_keys(&note.path, &record) {
                graph.candidates.entry(key).or_default().insert(id);
            }
            graph.notes.insert(id, record);
            graph.path_by_id.insert(id, note.path.clone());
            graph.paths.insert(note.path, id);
        }
        for reference in references {
            let &note_id = graph.paths.get(&reference.source_path).ok_or_else(|| {
                IndexError::Storage(format!(
                    "reference for unknown note {}",
                    reference.source_path.as_str()
                ))
            })?;
            let dependency_keys = reference_dependencies(
                &reference.source_path,
                &reference.target,
                &reference.resolution,
            );
            let key = ReferenceKey {
                source: note_id,
                ordinal: reference.ordinal,
            };
            graph.insert_reference(
                key,
                ReferenceRecord {
                    target: reference.target,
                    resolution: reference.resolution,
                    dependency_keys,
                },
            );
        }
        Ok(graph)
    }

    pub fn generation(&self) -> Generation {
        self.generation
    }

    pub fn note_count(&self) -> usize {
        self.paths.len()
    }

    pub fn reference_count(&self) -> usize {
        self.references.len()
    }

    pub fn contains_note(&self, path: &VaultPath) -> bool {
        self.paths.contains_key(path)
    }

    pub fn note_paths(&self) -> BTreeSet<VaultPath> {
        self.paths.keys().cloned().collect()
    }

    /// `id`'s path, if `id` is currently tracked — the O(1) inverse of
    /// looking a path up to get its `NoteId`. Intended for consumers that
    /// hold a `NoteId`/`ReferenceKey` from `candidate_notes`/`dependents`/
    /// `ImpactPlan::affected` and need to resolve it without a whole-graph
    /// scan.
    pub fn note_path(&self, id: NoteId) -> Option<&VaultPath> {
        self.path_by_id.get(&id)
    }

    /// The current record for `key`, if it is tracked — the O(1) inverse of
    /// `reference_keys`/`outgoing`, for a consumer that already holds a
    /// `ReferenceKey` (e.g. from `ImpactPlan::affected` or `dependents`) and
    /// needs its content without a whole-graph scan. Returned as an owned
    /// `HydratedReference` (the graph does not store one keyed by
    /// `ReferenceKey` directly — only a `target`/`resolution` pair plus its
    /// dependency keys — so there is nothing to hand back a `&` to; building
    /// one is still two `BTreeMap` lookups, not an iteration).
    pub fn reference(&self, key: ReferenceKey) -> Option<HydratedReference> {
        let record = self.references.get(&key)?;
        let source_path = self.path_by_id.get(&key.source)?.clone();
        Some(HydratedReference {
            source_path,
            ordinal: key.ordinal,
            target: record.target.clone(),
            resolution: record.resolution.clone(),
        })
    }

    /// The resolution-relevant facts the graph retains for `path`, if it is
    /// tracked.
    pub fn note(&self, path: &VaultPath) -> Option<HydratedNote> {
        let note_id = self.paths.get(path)?;
        let record = self.notes.get(note_id)?;
        Some(HydratedNote {
            path: path.clone(),
            headings: record.headings.clone(),
            blocks: record.blocks.clone(),
        })
    }

    /// Always zero: the live graph never retains source bytes. A structural
    /// guarantee rather than a computed measurement.
    pub fn retained_source_bytes(&self) -> usize {
        0
    }

    /// The reference keys the live graph tracks for `path`'s outgoing
    /// references, in ordinal order.
    pub fn reference_keys(&self, path: &VaultPath) -> BTreeSet<ReferenceKey> {
        let Some(&note_id) = self.paths.get(path) else {
            return BTreeSet::new();
        };
        self.outgoing_keys(note_id).collect()
    }

    /// `path`'s outgoing references, reconstructed from their compact
    /// records, in ordinal order.
    pub fn outgoing(&self, path: &VaultPath) -> Vec<HydratedReference> {
        let Some(&note_id) = self.paths.get(path) else {
            return Vec::new();
        };
        self.outgoing_keys(note_id)
            .filter_map(|key| {
                self.references.get(&key).map(|record| HydratedReference {
                    source_path: path.clone(),
                    ordinal: key.ordinal,
                    target: record.target.clone(),
                    resolution: record.resolution.clone(),
                })
            })
            .collect()
    }

    /// The references currently indexed under `key`: exactly the reverse of
    /// `vault_core::reference_dependencies` for each tracked reference.
    pub fn dependents(&self, key: &DependencyKey) -> BTreeSet<ReferenceKey> {
        self.dependents.get(key).cloned().unwrap_or_default()
    }

    /// The notes that could satisfy a reference looked up under `key`: the
    /// forward counterpart to `dependents`, populated from
    /// `vault_core::changed_candidate_keys` applied to each note's own
    /// identity (an add with no prior state). This is what a future
    /// consumer can use to resolve a reference's lookup routes without
    /// rebuilding the whole-vault `Resolver`.
    pub fn candidate_notes(&self, key: &DependencyKey) -> BTreeSet<NoteId> {
        self.candidates.get(key).cloned().unwrap_or_default()
    }

    /// The bounded set of references that could need re-resolution given a
    /// batch of directly-changed source bodies and note-identity changes.
    ///
    /// `changed_sources` conservatively selects an entire changed source's
    /// own current outgoing references (its new reference set replaces them
    /// via `prepare_delta`/`install` anyway). `identity_changes` selects,
    /// for every other note, exactly the references whose own dependency
    /// keys (from `reference_dependencies`) intersect
    /// `vault_core::changed_candidate_keys(change)` — the documented
    /// contract those functions were built to satisfy.
    pub fn plan_impact(
        &self,
        changed_sources: &BTreeSet<VaultPath>,
        identity_changes: &[ResolutionIdentityChange],
    ) -> ImpactPlan {
        let mut affected = BTreeSet::new();

        for source in changed_sources {
            if let Some(&note_id) = self.paths.get(source) {
                affected.extend(self.outgoing_keys(note_id));
            }
        }

        for change in identity_changes {
            for key in changed_candidate_keys(change) {
                if let Some(dependents) = self.dependents.get(&key) {
                    affected.extend(dependents.iter().copied());
                }
            }
        }

        ImpactPlan {
            affected,
            complete_resolution: false,
        }
    }

    /// Allocate a fully-built replacement for `replacement_notes`,
    /// `removed_paths`, and `replacement_references` without mutating
    /// `self`. Fails if `expected` does not match this graph's current
    /// generation (the same compare-and-swap discipline `IndexStore::publish`
    /// uses against the SQLite generation).
    ///
    /// Listing a note's path in `replacement_notes` replaces that source's
    /// *entire* tracked reference set: `install` clears every existing
    /// reference for that source before applying whatever
    /// `replacement_references` supplies for it, so a re-parsed note's
    /// caller must supply its complete new reference list, not a subset.
    ///
    /// A source path that appears in `replacement_references` *without*
    /// also appearing in `replacement_notes` is a targeted, per-ordinal
    /// update instead (e.g. one existing reference's resolution changed
    /// without a re-parse of its source): existing ordinals for that source
    /// that are absent from `replacement_references` are left untouched,
    /// and ordinals that are present are safely overwritten (their old
    /// dependency keys are retired, never left dangling).
    pub fn prepare_delta(
        &self,
        expected: Generation,
        replacement_notes: &[HydratedNote],
        removed_paths: &[VaultPath],
        replacement_references: &[HydratedReference],
    ) -> Result<PreparedGraphDelta, IndexError> {
        if expected != self.generation {
            return Err(IndexError::IncompatibleIndex(format!(
                "live graph generation {} does not match expected {}",
                self.generation.get(),
                expected.get()
            )));
        }

        let mut next_note_id = self.next_note_id;
        let mut new_note_ids: BTreeMap<VaultPath, NoteId> = BTreeMap::new();
        let mut note_updates: BTreeMap<VaultPath, (NoteId, NoteRecord)> = BTreeMap::new();
        let mut candidate_additions: BTreeMap<NoteId, Vec<DependencyKey>> = BTreeMap::new();
        for note in replacement_notes {
            let note_id = if let Some(&existing) = self.paths.get(&note.path) {
                existing
            } else if let Some(&pending) = new_note_ids.get(&note.path) {
                pending
            } else {
                let id = NoteId(next_note_id);
                next_note_id += 1;
                new_note_ids.insert(note.path.clone(), id);
                id
            };
            let record = NoteRecord {
                headings: note.headings.clone(),
                blocks: note.blocks.clone(),
            };
            candidate_additions.insert(
                note_id,
                added_candidate_keys(&note.path, &record)
                    .into_iter()
                    .collect(),
            );
            note_updates.insert(note.path.clone(), (note_id, record));
        }

        let mut candidate_removals: BTreeMap<NoteId, Vec<DependencyKey>> = BTreeMap::new();
        for path in removed_paths {
            if let Some(&note_id) = self.paths.get(path) {
                if let Some(record) = self.notes.get(&note_id) {
                    candidate_removals.insert(
                        note_id,
                        removed_candidate_keys(path, record).into_iter().collect(),
                    );
                }
            }
        }

        let mut reference_updates: BTreeMap<VaultPath, Vec<(u32, ReferenceRecord)>> =
            BTreeMap::new();
        for reference in replacement_references {
            let dependency_keys = reference_dependencies(
                &reference.source_path,
                &reference.target,
                &reference.resolution,
            );
            reference_updates
                .entry(reference.source_path.clone())
                .or_default()
                .push((
                    reference.ordinal,
                    ReferenceRecord {
                        target: reference.target.clone(),
                        resolution: reference.resolution.clone(),
                        dependency_keys,
                    },
                ));
        }

        Ok(PreparedGraphDelta {
            generation: Generation::new(expected.get() + 1),
            next_note_id,
            new_note_ids,
            note_updates,
            reference_updates,
            removed_paths: removed_paths.to_vec(),
            candidate_additions,
            candidate_removals,
        })
    }

    /// Apply a previously prepared delta: swaps, removals, and inserts only.
    /// Cannot fail — every fallible check already happened in
    /// `prepare_delta`.
    ///
    /// Precondition: exactly one prepared delta may be installed per
    /// generation step. `prepare_delta` validates `expected` against
    /// `self.generation` at *preparation* time only, so two deltas prepared
    /// from the same starting generation (e.g. from concurrent callers) can
    /// both validate successfully; installing both would silently regress
    /// or duplicate the generation counter. The real guard against that is
    /// the caller's own barrier (one delta in flight per generation) — the
    /// debug assertion below is only a local tripwire that fires in this
    /// crate's own tests and any debug-build caller, never a substitute for
    /// that barrier.
    pub fn install(&mut self, delta: PreparedGraphDelta) {
        debug_assert_eq!(
            delta.generation.get(),
            self.generation.get() + 1,
            "stale delta installed: prepared against a generation this graph has moved past"
        );

        for (note_id, keys) in &delta.candidate_removals {
            for key in keys {
                if let Some(set) = self.candidates.get_mut(key) {
                    set.remove(note_id);
                    if set.is_empty() {
                        self.candidates.remove(key);
                    }
                }
            }
        }

        for path in &delta.removed_paths {
            if let Some(note_id) = self.paths.remove(path) {
                self.clear_outgoing(note_id);
                self.notes.remove(&note_id);
                self.path_by_id.remove(&note_id);
            }
        }

        for path in delta.note_updates.keys() {
            if let Some(&note_id) = self.paths.get(path) {
                self.clear_outgoing(note_id);
            }
        }

        for (path, id) in delta.new_note_ids {
            self.path_by_id.insert(id, path.clone());
            self.paths.insert(path, id);
        }
        self.next_note_id = delta.next_note_id;

        for (path, (note_id, record)) in delta.note_updates {
            self.path_by_id.insert(note_id, path.clone());
            self.paths.insert(path, note_id);
            self.notes.insert(note_id, record);
        }

        for (note_id, keys) in delta.candidate_additions {
            for key in keys {
                self.candidates.entry(key).or_default().insert(note_id);
            }
        }

        for (path, refs) in delta.reference_updates {
            if let Some(&note_id) = self.paths.get(&path) {
                for (ordinal, record) in refs {
                    self.insert_reference(
                        ReferenceKey {
                            source: note_id,
                            ordinal,
                        },
                        record,
                    );
                }
            }
        }

        self.generation = delta.generation;
    }

    fn outgoing_keys(&self, note_id: NoteId) -> impl Iterator<Item = ReferenceKey> + '_ {
        let start = ReferenceKey {
            source: note_id,
            ordinal: 0,
        };
        let end = ReferenceKey {
            source: note_id,
            ordinal: u32::MAX,
        };
        self.references.range(start..=end).map(|(key, _)| *key)
    }

    /// Idempotent: if `key` already holds a record (its resolution or target
    /// changed without a full source clear), that record's dependency keys
    /// are retired from `dependents` first, so no stale entry can ever
    /// outlive the reference it was indexing.
    fn insert_reference(&mut self, key: ReferenceKey, record: ReferenceRecord) {
        self.remove_reference(key);
        for dependency_key in &record.dependency_keys {
            self.dependents
                .entry(dependency_key.clone())
                .or_default()
                .insert(key);
        }
        self.references.insert(key, record);
    }

    fn remove_reference(&mut self, key: ReferenceKey) {
        if let Some(record) = self.references.remove(&key) {
            for dependency_key in &record.dependency_keys {
                if let Some(set) = self.dependents.get_mut(dependency_key) {
                    set.remove(&key);
                    if set.is_empty() {
                        self.dependents.remove(dependency_key);
                    }
                }
            }
        }
    }

    fn clear_outgoing(&mut self, note_id: NoteId) {
        let keys: Vec<ReferenceKey> = self.outgoing_keys(note_id).collect();
        for key in keys {
            self.remove_reference(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vp(spelling: &str) -> VaultPath {
        VaultPath::new(spelling).expect("valid path")
    }

    /// A torn read (or any other inconsistency between the note set and the
    /// reference set) must fail loudly, never silently drop the reference:
    /// a dropped reference is never in `dependents`, so nothing would ever
    /// select it again — the one forbidden (under-selective) direction for
    /// conservative invalidation.
    #[test]
    fn from_hydrated_rejects_a_reference_for_an_unknown_note() {
        let notes = vec![HydratedNote {
            path: vp("Known.md"),
            headings: Vec::new(),
            blocks: Vec::new(),
        }];
        let references = vec![HydratedReference {
            source_path: vp("Unknown.md"),
            ordinal: 0,
            target: LinkTarget::parse("Known"),
            resolution: Resolution::Resolved {
                target: vp("Known.md"),
                subpath: None,
            },
        }];

        let result = LiveGraph::from_hydrated(Generation::new(1), notes, references);
        assert!(matches!(result, Err(IndexError::Storage(_))));
    }
}
