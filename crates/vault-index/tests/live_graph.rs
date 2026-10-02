mod common;

use std::collections::BTreeSet;

use common::queries_fixture;
use vault_core::{
    DependencyKey, DependencyKind, LinkTarget, Resolution, ResolutionIdentityChange,
    ResolutionNote, VaultPath,
};
use vault_index::{HydratedNote, HydratedReference};

fn vp(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid path")
}

fn note(path: &str, headings: &[&str], blocks: &[&str]) -> ResolutionNote {
    ResolutionNote {
        path: vp(path),
        headings: headings.iter().map(|h| h.to_string()).collect(),
        blocks: blocks.iter().map(|b| b.to_string()).collect(),
        views: None,
    }
}

#[test]
fn hydration_loads_resolution_state_without_source_bodies() {
    let mut fixture = queries_fixture();
    fixture.service.refresh(false).expect("cold build");
    let graph = fixture.service.hydrate_live_graph().expect("hydrate");

    assert_eq!(graph.generation().get(), 1);
    assert_eq!(graph.note_count(), 4);
    assert!(graph.contains_note(&vp("Target.md")));
    assert!(graph.reference_count() >= 5);
    assert_eq!(graph.retained_source_bytes(), 0);

    // The ambiguous `Foo` reference is indexed under its filename/stem
    // dependencies (both keyed on the same lowercase spelling, mirroring
    // Resolver::resolve_target's shared lookup key).
    assert!(
        !graph
            .dependents(&DependencyKey::new(DependencyKind::Stem, "foo"))
            .is_empty(),
        "ambiguous Foo reference should be indexed under Stem(\"foo\")"
    );
    assert!(
        !graph
            .dependents(&DependencyKey::new(
                DependencyKind::ExactPathWithExtension,
                "Foo.md"
            ))
            .is_empty(),
        "ambiguous Foo reference should be indexed under ExactPathWithExtension(\"Foo.md\")"
    );

    // `Target#Absent` is a missing-subpath resolution against Target.md, so
    // it must be indexed under ResolvedTarget("Target.md").
    assert!(
        !graph
            .dependents(&DependencyKey::new(
                DependencyKind::ResolvedTarget,
                "Target.md"
            ))
            .is_empty(),
        "Target#Absent should be indexed under ResolvedTarget(\"Target.md\")"
    );
}

// --- impact matrix --------------------------------------------------------

#[test]
fn body_only_change_selects_only_the_changed_sources_outgoing_references() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let graph = fixture.service.hydrate_live_graph().expect("hydrate");

    let hub_keys = graph.reference_keys(&vp("Hub.md"));
    let peer_keys = graph.reference_keys(&vp("Peer.md"));
    assert!(!hub_keys.is_empty());
    assert!(!peer_keys.is_empty());

    let changed_sources: BTreeSet<VaultPath> = [vp("Hub.md")].into_iter().collect();
    let plan = graph.plan_impact(&changed_sources, &[]);

    assert_eq!(
        plan.affected, hub_keys,
        "must select exactly Hub's own outgoing references"
    );
    for key in &peer_keys {
        assert!(
            !plan.affected.contains(key),
            "must not select another source's outgoing references"
        );
    }
}

#[test]
fn adding_the_note_selects_its_unresolved_dependents() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let graph = fixture.service.hydrate_live_graph().expect("hydrate");

    let foo_reference = only_reference_targeting(&graph, &vp("Hub.md"), "Foo");

    let change = ResolutionIdentityChange {
        old: None,
        new: Some(note("Foo.md", &[], &[])),
    };
    let plan = graph.plan_impact(&BTreeSet::new(), &[change]);

    assert!(
        plan.affected.contains(&foo_reference),
        "adding Foo.md must select the pending [[Foo]] reference"
    );
    assert_eq!(
        plan.affected.len(),
        1,
        "must not select unrelated references"
    );
}

#[test]
fn removing_the_note_selects_the_same_key_family_as_adding_it() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let graph = fixture.service.hydrate_live_graph().expect("hydrate");

    let foo_reference = only_reference_targeting(&graph, &vp("Hub.md"), "Foo");

    let added = ResolutionIdentityChange {
        old: None,
        new: Some(note("Foo.md", &[], &[])),
    };
    let removed = ResolutionIdentityChange {
        old: Some(note("Foo.md", &[], &[])),
        new: None,
    };

    let added_plan = graph.plan_impact(&BTreeSet::new(), &[added]);
    let removed_plan = graph.plan_impact(&BTreeSet::new(), &[removed]);

    assert_eq!(added_plan.affected, removed_plan.affected);
    assert!(added_plan.affected.contains(&foo_reference));
}

#[test]
fn heading_change_selects_every_reference_already_resolved_to_that_target() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let graph = fixture.service.hydrate_live_graph().expect("hydrate");

    let subpath_reference = only_reference_targeting(&graph, &vp("Hub.md"), "Sub#Heading");
    let plain_reference = only_reference_targeting(&graph, &vp("Hub.md"), "Sub");
    let unrelated_reference = only_reference_targeting(&graph, &vp("Hub.md"), "Other");

    let change = ResolutionIdentityChange {
        old: Some(note("Sub.md", &["Heading"], &["block"])),
        new: Some(note("Sub.md", &["Renamed"], &["block"])),
    };
    let plan = graph.plan_impact(&BTreeSet::new(), &[change]);

    // A heading rename tracks every reference already resolved to that
    // target (ResolvedTarget covers "any reference that already resolved to
    // a target", per vault_core::dependency::reference_dependencies), not
    // only the ones carrying a subpath.
    assert!(plan.affected.contains(&subpath_reference));
    assert!(plan.affected.contains(&plain_reference));
    // A reference resolved to a different target is untouched.
    assert!(!plan.affected.contains(&unrelated_reference));
}

#[test]
fn unrelated_paths_select_no_references() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let graph = fixture.service.hydrate_live_graph().expect("hydrate");

    let change = ResolutionIdentityChange {
        old: Some(note("Unrelated.md", &[], &[])),
        new: Some(note("Unrelated.md", &["Changed"], &[])),
    };
    let by_identity = graph.plan_impact(&BTreeSet::new(), &[change]);
    assert!(by_identity.affected.is_empty());

    let changed_sources: BTreeSet<VaultPath> = [vp("Unrelated.md")].into_iter().collect();
    let by_source = graph.plan_impact(&changed_sources, &[]);
    assert!(by_source.affected.is_empty());
}

#[test]
fn install_retires_a_stale_dependency_when_a_reference_is_updated_without_a_source_clear() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let mut graph = fixture.service.hydrate_live_graph().expect("hydrate");
    let expected_generation = graph.generation();

    let sub_key = DependencyKey::new(DependencyKind::ExactPathWithExtension, "Sub.md");
    let other_key = DependencyKey::new(DependencyKind::ExactPathWithExtension, "Other.md");
    let hub_key_before = only_reference_targeting(&graph, &vp("Hub.md"), "Sub");
    assert!(graph.dependents(&sub_key).contains(&hub_key_before));

    // A targeted, per-ordinal update: Hub.md's [[Sub]] reference (ordinal 0)
    // now resolves to Other.md instead, supplied WITHOUT listing Hub.md in
    // `replacement_notes` or `removed_paths` — only in
    // `replacement_references`, as prepare_delta's docs describe. The old
    // Sub.md dependency for this exact key must not survive as an orphan.
    let replacement_reference = HydratedReference {
        source_path: vp("Hub.md"),
        ordinal: 0,
        target: LinkTarget::parse("Other"),
        resolution: Resolution::Resolved {
            target: vp("Other.md"),
            subpath: None,
        },
    };
    let delta = graph
        .prepare_delta(expected_generation, &[], &[], &[replacement_reference])
        .expect("prepare delta");
    graph.install(delta);

    // Ordinal 0's key is stable across the update (same source, same
    // ordinal); look it up by ordinal rather than by raw target, since the
    // fixture already has an unrelated `[[Other]]` reference at another
    // ordinal and this update makes the raw target "Other" non-unique.
    let hub_key_after = *graph
        .reference_keys(&vp("Hub.md"))
        .iter()
        .find(|key| key.ordinal == hub_key_before.ordinal)
        .expect("ordinal 0 is still tracked for Hub.md");
    assert_eq!(
        hub_key_before, hub_key_after,
        "the reference key at ordinal 0 for Hub.md is unchanged"
    );
    assert!(
        !graph.dependents(&sub_key).contains(&hub_key_after),
        "the stale Sub.md dependency must not survive the replacement"
    );
    assert!(
        graph.dependents(&other_key).contains(&hub_key_after),
        "the new Other.md dependency must be indexed"
    );
}

#[test]
fn candidate_notes_appear_on_add_and_disappear_on_removal() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let mut graph = fixture.service.hydrate_live_graph().expect("hydrate");

    let filename_key = DependencyKey::new(DependencyKind::ExactPathWithExtension, "Foo.md");
    let stem_key = DependencyKey::new(DependencyKind::Stem, "foo");
    assert!(graph.candidate_notes(&filename_key).is_empty());
    assert!(graph.candidate_notes(&stem_key).is_empty());

    let expected_generation = graph.generation();
    let new_note = HydratedNote {
        path: vp("Foo.md"),
        headings: Vec::new(),
        blocks: Vec::new(),
    };
    let delta = graph
        .prepare_delta(expected_generation, &[new_note], &[], &[])
        .expect("prepare delta");
    graph.install(delta);

    assert_eq!(graph.candidate_notes(&filename_key).len(), 1);
    assert_eq!(graph.candidate_notes(&stem_key).len(), 1);

    let expected_generation = graph.generation();
    let delta = graph
        .prepare_delta(expected_generation, &[], &[vp("Foo.md")], &[])
        .expect("prepare delta");
    graph.install(delta);

    assert!(
        graph.candidate_notes(&filename_key).is_empty(),
        "removing the note must remove it from the candidate map"
    );
    assert!(graph.candidate_notes(&stem_key).is_empty());
}

#[test]
fn note_path_round_trips_and_forgets_removed_notes() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let mut graph = fixture.service.hydrate_live_graph().expect("hydrate");

    // Every note registers its own full path under ExactPathWithExtension
    // (see `added_candidate_keys`), so this is an O(1) way to recover a
    // path's `NoteId` from existing accessors without a whole-graph scan.
    let note_id_of = |graph: &vault_index::LiveGraph, path: &VaultPath| -> vault_index::NoteId {
        let key = DependencyKey::new(DependencyKind::ExactPathWithExtension, path.as_str());
        *graph
            .candidate_notes(&key)
            .iter()
            .next()
            .expect("every tracked note registers its own exact-path key")
    };

    let mut ids_by_path = std::collections::BTreeMap::new();
    for path in graph.note_paths() {
        let id = note_id_of(&graph, &path);
        assert_eq!(
            graph.note_path(id),
            Some(&path),
            "note_path must round-trip for {path:?}"
        );
        ids_by_path.insert(path, id);
    }

    let removed_id = ids_by_path[&vp("Unrelated.md")];
    let expected_generation = graph.generation();
    let delta = graph
        .prepare_delta(expected_generation, &[], &[vp("Unrelated.md")], &[])
        .expect("prepare delta");
    graph.install(delta);

    assert_eq!(
        graph.note_path(removed_id),
        None,
        "a removed note's id must no longer resolve to a path"
    );
    for (path, id) in &ids_by_path {
        if path == &vp("Unrelated.md") {
            continue;
        }
        assert_eq!(
            graph.note_path(*id),
            Some(path),
            "unaffected notes must still round-trip after an unrelated removal"
        );
    }
}

#[test]
fn reference_returns_the_current_record_after_a_per_ordinal_replacement() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let mut graph = fixture.service.hydrate_live_graph().expect("hydrate");
    let expected_generation = graph.generation();

    let hub_sub_key = only_reference_targeting(&graph, &vp("Hub.md"), "Sub");
    let before = graph
        .reference(hub_sub_key)
        .expect("reference exists before replacement");
    assert_eq!(before.target.raw_target, "Sub");
    assert_eq!(before.source_path, vp("Hub.md"));

    let replacement_reference = HydratedReference {
        source_path: vp("Hub.md"),
        ordinal: hub_sub_key.ordinal,
        target: LinkTarget::parse("Other"),
        resolution: Resolution::Resolved {
            target: vp("Other.md"),
            subpath: None,
        },
    };
    let delta = graph
        .prepare_delta(expected_generation, &[], &[], &[replacement_reference])
        .expect("prepare delta");
    graph.install(delta);

    let after = graph
        .reference(hub_sub_key)
        .expect("reference still exists after replacement");
    assert_eq!(after.target.raw_target, "Other");
    assert_eq!(
        after.resolution,
        Resolution::Resolved {
            target: vp("Other.md"),
            subpath: None,
        }
    );
}

#[test]
fn install_after_prepare_delta_matches_a_fresh_hydration() {
    let mut fixture = common::live_graph_fixture();
    fixture.service.refresh(false).expect("cold build");
    let mut graph = fixture.service.hydrate_live_graph().expect("hydrate");
    let expected_generation = graph.generation();

    fixture.write_note("Fresh.md", "# Fresh\n[[Sub]]\n");
    fixture.service.refresh(false).expect("warm refresh");
    let fresh_graph = fixture.service.hydrate_live_graph().expect("rehydrate");

    let new_note = HydratedNote {
        path: vp("Fresh.md"),
        headings: vec!["Fresh".to_string()],
        blocks: Vec::new(),
    };
    let new_reference = HydratedReference {
        source_path: vp("Fresh.md"),
        ordinal: 0,
        target: LinkTarget::parse("Sub"),
        resolution: Resolution::Resolved {
            target: vp("Sub.md"),
            subpath: None,
        },
    };
    let delta = graph
        .prepare_delta(expected_generation, &[new_note], &[], &[new_reference])
        .expect("prepare delta");
    graph.install(delta);

    assert_graphs_equivalent(&graph, &fresh_graph);
}

fn only_reference_targeting(
    graph: &vault_index::LiveGraph,
    source: &VaultPath,
    raw_target: &str,
) -> vault_index::ReferenceKey {
    let outgoing = graph.outgoing(source);
    let matches: Vec<_> = outgoing
        .iter()
        .filter(|reference| reference.target.raw_target == raw_target)
        .collect();
    assert_eq!(matches.len(), 1, "raw target must be unique in the fixture");
    let ordinal = matches[0].ordinal;
    let keys = graph.reference_keys(source);
    *keys
        .iter()
        .find(|key| key.ordinal == ordinal)
        .expect("a reference key exists for this ordinal")
}

/// Translate a raw `affected` set into an ID-independent shape. `NoteId` is
/// assigned by each graph's own build/install history (arrival order for an
/// incrementally-installed note vs. alphabetical-at-hydration-time for a
/// freshly rehydrated one), so two independently-built graphs over the same
/// logical content are not guaranteed to assign the same `NoteId` to the
/// same path — comparing raw `ReferenceKey`/`ImpactPlan` values across them
/// would be comparing incomparable numberings, not a meaningful equivalence
/// check. Resolving each key back to `(path, ordinal)` via `note_path`
/// (O(1) per key — no whole-graph scan) restores a comparable,
/// path-addressed shape.
fn resolve_keys(
    graph: &vault_index::LiveGraph,
    keys: &BTreeSet<vault_index::ReferenceKey>,
) -> BTreeSet<(VaultPath, u32)> {
    keys.iter()
        .filter_map(|key| {
            graph
                .note_path(key.source)
                .map(|path| (path.clone(), key.ordinal))
        })
        .collect()
}

fn assert_graphs_equivalent(left: &vault_index::LiveGraph, right: &vault_index::LiveGraph) {
    assert_eq!(left.generation(), right.generation());
    assert_eq!(left.note_paths(), right.note_paths());
    for path in left.note_paths() {
        let mut left_outgoing: Vec<_> = left
            .outgoing(&path)
            .into_iter()
            .map(|r| (r.ordinal, r.target, r.resolution))
            .collect();
        let mut right_outgoing: Vec<_> = right
            .outgoing(&path)
            .into_iter()
            .map(|r| (r.ordinal, r.target, r.resolution))
            .collect();
        left_outgoing.sort_by_key(|(ordinal, _, _)| *ordinal);
        right_outgoing.sort_by_key(|(ordinal, _, _)| *ordinal);
        assert_eq!(
            left_outgoing, right_outgoing,
            "outgoing references for {path:?} differ"
        );

        let left_note = left.note(&path).expect("left tracks this note");
        let right_note = right.note(&path).expect("right tracks this note");
        assert_eq!(
            left_note.headings, right_note.headings,
            "headings for {path:?} differ"
        );
        assert_eq!(
            left_note.blocks, right_note.blocks,
            "blocks for {path:?} differ"
        );

        // Compare the reverse index (the only thing `plan_impact` reads) via
        // both channels, since neither the outgoing-content check above nor
        // the note-identity check exercises `dependents`/`candidates` at all.
        let identity = ResolutionIdentityChange {
            old: None,
            new: Some(ResolutionNote {
                path: path.clone(),
                headings: left_note.headings.clone(),
                blocks: left_note.blocks.clone(),
                views: None,
            }),
        };
        let left_by_identity = left.plan_impact(&BTreeSet::new(), std::slice::from_ref(&identity));
        let right_by_identity =
            right.plan_impact(&BTreeSet::new(), std::slice::from_ref(&identity));
        assert_eq!(
            left_by_identity.complete_resolution, right_by_identity.complete_resolution,
            "identity-channel complete_resolution for {path:?} differs"
        );
        assert_eq!(
            resolve_keys(left, &left_by_identity.affected),
            resolve_keys(right, &right_by_identity.affected),
            "identity-channel impact for {path:?} differs"
        );

        let changed_sources: BTreeSet<VaultPath> = [path.clone()].into_iter().collect();
        let left_by_source = left.plan_impact(&changed_sources, &[]);
        let right_by_source = right.plan_impact(&changed_sources, &[]);
        assert_eq!(
            left_by_source.complete_resolution, right_by_source.complete_resolution,
            "changed-source complete_resolution for {path:?} differs"
        );
        assert_eq!(
            resolve_keys(left, &left_by_source.affected),
            resolve_keys(right, &right_by_source.affected),
            "changed-source impact for {path:?} differs"
        );

        // Compare the forward candidate index for every key derivable from
        // this note's identity, by size only (NoteId numbering across the
        // two independently-built graphs is not comparable — see
        // `resolve_keys`).
        for key in vault_core::changed_candidate_keys(&identity) {
            assert_eq!(
                left.candidate_notes(&key).len(),
                right.candidate_notes(&key).len(),
                "candidate set size for {key:?} differs"
            );
        }
    }
}
