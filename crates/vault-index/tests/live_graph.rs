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
    }
}
