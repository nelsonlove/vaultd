use std::collections::BTreeSet;
use std::path::Path;

use vault_core::{
    DependencyKey, FileSystemVaultSource, LinkTarget, ParsedNote, ResolutionIdentityChange,
    ResolutionNote, Resolver, SourceDocument, VaultPath, build_graph, changed_candidate_keys,
    parse_note, read_documents, reference_dependencies,
};

fn fixture_root() -> &'static Path {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/semantic-read-path/basic-vault"
    ))
}

fn load_notes() -> Vec<ParsedNote> {
    let source = FileSystemVaultSource::new(fixture_root()).expect("fixture root");
    let documents = read_documents(&source).expect("read fixture documents");
    documents.documents.into_iter().map(parse_note).collect()
}

fn note(path: &str, text: &str) -> ParsedNote {
    parse_note(SourceDocument::new(
        VaultPath::new(path).expect("valid path"),
        text,
    ))
}

/// Selects references from `before` whose dependency keys intersect any key
/// produced by `changes`, resolves only those against a resolver built from
/// `after`, and checks the result against the complete `after` resolution.
/// Fails if any reference whose complete answer changed was not selected.
///
/// References are paired between `before` and `after` by `(raw_target,
/// source_span)`, not by list position: when a note's own body changes, its
/// outgoing-reference list can differ in length or order from the one
/// computed before the change, and pairing by index would silently truncate
/// (dropping a trailing reference outright) or compare mismatched pairs
/// (masking a real change behind an unrelated one at the same index). A
/// reference whose raw target and source span are unchanged between the two
/// graphs is the same syntactic reference; one with no match in `after` was
/// itself edited away or moved and is outside what this dependency-key
/// harness checks (a source note's own edit is always fully re-resolved by
/// the ordinary changed-note path, independent of dependency-key selection).
fn assert_selected_matches_complete(
    before: &[ParsedNote],
    after: &[ParsedNote],
    changes: &[ResolutionIdentityChange],
) {
    let before_report = build_graph(before.to_vec(), Vec::new());
    let after_report = build_graph(after.to_vec(), Vec::new());
    let after_resolver = Resolver::new(after);

    let selected_keys: BTreeSet<DependencyKey> =
        changes.iter().flat_map(changed_candidate_keys).collect();

    let mut checked_any = false;

    for before_note in before {
        let path = before_note.source.path();
        let before_refs = before_report.graph.outgoing(path);
        let after_refs = after_report.graph.outgoing(path);

        for before_ref in before_refs {
            let Some(after_ref) = after_refs.iter().find(|candidate| {
                candidate.reference.raw_target == before_ref.reference.raw_target
                    && candidate.source_span == before_ref.source_span
            }) else {
                continue;
            };

            checked_any = true;
            let target = LinkTarget::from(&before_ref.reference);
            let keys = reference_dependencies(path, &target, &before_ref.resolution);
            let is_selected = keys.iter().any(|key| selected_keys.contains(key));

            if before_ref.resolution != after_ref.resolution {
                assert!(
                    is_selected,
                    "reference {:?} in {:?} changed from {:?} to {:?} but no dependency key selected it (keys: {:?})",
                    before_ref.reference.raw_target,
                    path.as_str(),
                    before_ref.resolution,
                    after_ref.resolution,
                    keys
                );
            }

            if is_selected {
                let recomputed = after_resolver.resolve_target(path, &target);
                assert_eq!(
                    recomputed,
                    after_ref.resolution,
                    "selected reference {:?} in {:?} recomputed differently than the complete graph",
                    before_ref.reference.raw_target,
                    path.as_str()
                );
            }
        }
    }

    assert!(checked_any, "test exercised no references at all");
}

#[test]
fn adding_a_note_resolves_previously_unresolved_references() {
    let before = load_notes();
    let mut after = before.clone();
    let new_note = note("Missing note.md", "# Missing note\n");
    after.push(new_note.clone());

    let change = ResolutionIdentityChange {
        old: None,
        new: Some(ResolutionNote::from(&new_note)),
    };

    assert_selected_matches_complete(&before, &after, &[change]);
}

#[test]
fn adding_a_note_is_detected_even_when_a_referencing_notes_own_reference_list_grows() {
    let before = load_notes();
    let mut after = before.clone();

    // Add the note that resolves the existing "[[Missing note]]" reference
    // in Wikilinks.md.
    let new_note = note("Missing note.md", "# Missing note\n");
    after.push(new_note.clone());

    // Also grow Wikilinks.md's own outgoing-reference list by inserting an
    // unrelated new reference BETWEEN two of its existing references (right
    // before "[[Foo]]", after "[[Missing note]]"). Wikilinks.md already has
    // outgoing references — including the one that must be re-selected
    // above — so this both changes that note's reference count AND shifts
    // the byte offset of every reference after the insertion point between
    // `before` and `after`. Pairing by list position would misalign here:
    // "[[Foo]]" (unaffected) would be compared against the new "[[Tags]]"
    // reference at the same index, producing a spurious mismatch, while the
    // still-unaffected "[[Foo]]" pair and the real "[[Missing note]]"
    // change risk being masked or dropped by truncation.
    let wikilinks_path = VaultPath::new("Wikilinks.md").expect("valid path");
    let index = after
        .iter()
        .position(|candidate| candidate.source.path() == &wikilinks_path)
        .expect("fixture contains Wikilinks.md");
    let original_text = after[index].source.text().to_string();
    let split_point = original_text
        .find("[[Foo]]")
        .expect("Wikilinks.md fixture contains [[Foo]]");
    let grown_text = format!(
        "{}[[Tags]]\n{}",
        &original_text[..split_point],
        &original_text[split_point..]
    );
    after[index] = note("Wikilinks.md", &grown_text);

    let change = ResolutionIdentityChange {
        old: None,
        new: Some(ResolutionNote::from(&new_note)),
    };

    assert_selected_matches_complete(&before, &after, &[change]);
}

#[test]
fn deleting_a_note_unresolves_previously_resolved_references() {
    let before = load_notes();
    let removed_path = VaultPath::new("Unicode café.md").expect("valid path");
    let removed_note = before
        .iter()
        .find(|candidate| candidate.source.path() == &removed_path)
        .expect("fixture contains Unicode café.md")
        .clone();
    let after: Vec<ParsedNote> = before
        .iter()
        .filter(|candidate| candidate.source.path() != &removed_path)
        .cloned()
        .collect();

    let change = ResolutionIdentityChange {
        old: Some(ResolutionNote::from(&removed_note)),
        new: None,
    };

    assert_selected_matches_complete(&before, &after, &[change]);
}

#[test]
fn heading_rename_invalidates_subpath_resolutions_pointing_at_it() {
    let before = load_notes();
    let target_path = VaultPath::new("Headings and blocks.md").expect("valid path");
    let old_note = before
        .iter()
        .find(|candidate| candidate.source.path() == &target_path)
        .expect("fixture contains Headings and blocks.md")
        .clone();

    let mut after = before.clone();
    let index = after
        .iter()
        .position(|candidate| candidate.source.path() == &target_path)
        .expect("fixture contains Headings and blocks.md");
    after[index] = note(
        "Headings and blocks.md",
        "# Headings and blocks\n\n## Choice\n\nKeep the filesystem authoritative. ^decision\n",
    );

    let change = ResolutionIdentityChange {
        old: Some(ResolutionNote::from(&old_note)),
        new: Some(ResolutionNote::from(&after[index])),
    };

    assert_selected_matches_complete(&before, &after, &[change]);
}
