//! Rename link repair.
//!
//! Two tiers, because neither layer can answer the whole question:
//!
//! * the **live graph** answers *which* references target a moved note. It
//!   stores dependency keys and reference identities and deliberately stores
//!   no spans and no spellings, so it can say "these references" and nothing
//!   more;
//! * the **durable SQL layer** answers *how to rewrite each one*.
//!   `note_references.target_span` is the byte range of the link's whole
//!   destination and `note_references.file_target` is the file half of it, so
//!   the splice below covers the file half **only** — a `#heading`, a
//!   `^block`, and display text all sit outside it and are never touched — and
//!   `notes.source_bytes` is the document those spans index.
//!
//! Each rewrite is compare-and-swap guarded against the revision the index
//! knew, so a referrer edited since the last reconciliation is skipped and
//! reported rather than clobbered with a stale body.
//!
//! **Only notes are repaired, and only *inbound* references.** The live graph
//! holds notes, so an attachment that moves takes its inbound embeds with it
//! unrepaired; and a note that is itself moving is skipped, because its own
//! outgoing links travel with it. The second exclusion is the one with a
//! visible edge: a path-form link from one note inside a renamed folder to
//! another note inside the same folder is not repaired, because judging its
//! spelling would mean resolving it from a location the note has not reached
//! yet. Shortest-form and relative spellings — the overwhelming majority —
//! keep resolving across such a move on their own.

use std::collections::{BTreeMap, BTreeSet};

use vault_core::{
    LinkTarget, Reference, ReferenceKind, Resolution, ResolutionIdentityChange, ResolutionNote,
    Resolver, VaultPath, changed_candidate_keys,
};

use crate::error::IndexError;
use crate::live_graph::LiveGraph;
use crate::mutate::{LinkRewriteFailure, MutationEngine};
use crate::store::IndexStore;

/// One referencing note's finished new body.
pub(crate) struct Rewrite {
    pub(crate) path: VaultPath,
    pub(crate) patched: String,
    pub(crate) links: u64,
}

pub(crate) struct Repair {
    pub(crate) rewrites: Vec<Rewrite>,
    pub(crate) failures: Vec<LinkRewriteFailure>,
}

/// The note identity a path carries in `graph`, as resolution sees it.
fn identity(graph: &LiveGraph, path: &VaultPath) -> Option<ResolutionNote> {
    graph.note(path).map(|note| ResolutionNote {
        path: note.path,
        headings: note.headings,
        blocks: note.blocks,
    })
}

/// The identity `path` will carry once it has moved to `destination`.
fn moved_identity(
    graph: &LiveGraph,
    path: &VaultPath,
    destination: &VaultPath,
) -> Option<ResolutionNote> {
    identity(graph, path).map(|note| ResolutionNote {
        path: destination.clone(),
        headings: note.headings,
        blocks: note.blocks,
    })
}

/// Plan every referencing note's rewrite for one set of `from -> to` moves.
///
/// A folder rename is the same problem with more moves, so both go through
/// here: a note that references two of the moved paths is rewritten once,
/// with both spans spliced.
pub(crate) fn plan_repair(
    graph: &LiveGraph,
    store: &IndexStore,
    engine: &MutationEngine,
    moves: &BTreeMap<VaultPath, VaultPath>,
) -> Result<Repair, IndexError> {
    // Tier one: which references could be reaching any moved path. Keys come
    // only from `vault_core`'s own constructor, never hand-built, so the
    // selection can never be narrower than resolution's own lookup routes.
    let moved: BTreeSet<&VaultPath> = moves.keys().collect();
    let mut selected: BTreeMap<VaultPath, BTreeSet<u32>> = BTreeMap::new();
    for (from, to) in moves {
        let change = ResolutionIdentityChange {
            old: identity(graph, from),
            new: moved_identity(graph, from, to),
        };
        for key in changed_candidate_keys(&change) {
            for reference in graph.dependents(&key) {
                let Some(source) = graph.note_path(reference.source) else {
                    continue;
                };
                // A moved note carries its own outgoing links with it; only
                // *inbound* references need retargeting.
                if moved.contains(source) {
                    continue;
                }
                selected
                    .entry(source.clone())
                    .or_default()
                    .insert(reference.ordinal);
            }
        }
    }

    // The catalog the vault will have *after* the moves, so a preserved
    // spelling is checked against the world it will actually live in.
    let mut catalog: BTreeMap<VaultPath, ResolutionNote> = BTreeMap::new();
    for path in graph.note_paths() {
        if moved.contains(&path) {
            continue;
        }
        if let Some(note) = identity(graph, &path) {
            catalog.insert(path, note);
        }
    }
    for (from, to) in moves {
        if let Some(note) = moved_identity(graph, from, to) {
            catalog.insert(to.clone(), note);
        }
    }
    let resolver = Resolver::from_catalog(catalog.into_values());

    // Tier two: the spans and spellings.
    let mut rewrites = Vec::new();
    let mut failures = Vec::new();
    for (source, ordinals) in selected {
        let Some(stored) = store.load_note(&source)? else {
            failures.push(LinkRewriteFailure {
                path: source,
                reason: "not_found".into(),
            });
            continue;
        };
        // Per-file compare-and-swap: the spans below index the bytes the
        // index knows, so a file that moved since is not one this plan can
        // safely edit.
        let indexed = stored.source.revision().as_str().to_string();
        match engine.current_revision(&source)? {
            Some(on_disk) if on_disk == indexed => {}
            _ => {
                failures.push(LinkRewriteFailure {
                    path: source,
                    reason: "revision_conflict".into(),
                });
                continue;
            }
        }

        let text = stored.source.text();
        let outgoing = store.load_outgoing_by_ordinal(&source)?;
        let mut splices: Vec<(std::ops::Range<usize>, String)> = Vec::new();
        for ordinal in ordinals {
            let Some(reference) = outgoing.get(&ordinal) else {
                continue;
            };
            let current_target = match &reference.resolution {
                Resolution::Resolved { target, .. } | Resolution::MissingSubpath { target, .. } => {
                    target.clone()
                }
                _ => continue,
            };
            let Some(destination) = moves.get(&current_target) else {
                continue;
            };
            let Some(existing) = reference.reference.file_target.as_deref() else {
                // A same-note subpath reference has no file target to
                // retarget, and moves with its own note.
                continue;
            };
            let Some(range) = file_target_span(text, &reference.reference) else {
                continue;
            };
            let spelling = preserved_spelling(&source, existing, destination, &resolver);
            let spelling = encode_for(reference.reference.kind, text, range.start, &spelling);
            if text[range.clone()] == spelling {
                continue;
            }
            splices.push((range, spelling));
        }
        if splices.is_empty() {
            continue;
        }
        // Descending, so no earlier splice invalidates a later span.
        splices.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
        let mut patched = text.to_string();
        let links = splices.len() as u64;
        for (range, spelling) in splices {
            patched.replace_range(range, &spelling);
        }
        rewrites.push(Rewrite {
            path: source,
            patched,
            links,
        });
    }
    rewrites.sort_by(|left, right| left.path.cmp(&right.path));
    failures.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(Repair { rewrites, failures })
}

/// The byte range of the **file half** of one reference's destination.
///
/// `target_span` covers the whole destination, subpath included, so splicing
/// it would swallow a `#heading` or a `^block` that the rename did not touch.
/// The file half is everything before the first `#`, and only that.
///
/// `None` when the span does not sit on a character boundary of the stored
/// body — the stored spans and the stored bytes disagreeing is a broken index
/// rather than something to guess at, and a rewrite of the wrong bytes is
/// worse than no rewrite at all.
fn file_target_span(text: &str, reference: &Reference) -> Option<std::ops::Range<usize>> {
    let start = reference.target_span.start();
    let end = reference.target_span.end();
    let destination = text.get(start..end)?;
    let length = destination.find('#').unwrap_or(destination.len());
    Some(start..start + length)
}

/// The spelling that replaces `existing` so it points at `to` from `source`.
///
/// Shape is preserved before length is: a shortest-form spelling stays
/// shortest, a path-form spelling stays a path, a relative one stays relative,
/// and a spelling that carried `.md` keeps carrying it. Ambiguity the rename
/// introduces upgrades the spelling to whatever does resolve — over-specifying
/// is safe, silently retargeting is not — so every candidate is checked
/// against the post-rename resolver before it is used, and the explicit vault
/// path is the fallback that always resolves.
fn preserved_spelling(
    source: &VaultPath,
    existing: &str,
    to: &VaultPath,
    resolver: &Resolver,
) -> String {
    let full = to.as_str();
    let filename = full.rsplit('/').next().unwrap_or(full);
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    let without_extension = full.strip_suffix(".md").unwrap_or(full);
    let kept_extension = existing.to_lowercase().ends_with(".md");
    let was_relative = existing.starts_with("./") || existing.starts_with("../");
    let was_path = !was_relative && existing.contains('/');

    let mut candidates: Vec<String> = Vec::new();
    if was_relative {
        // The one spelling that reaches `to` from this source's own folder,
        // computed rather than guessed: a link that reached up a level keeps
        // reaching up a level, and one that has to reach up two now does.
        candidates.push(relative_spelling(
            source,
            if kept_extension {
                full
            } else {
                without_extension
            },
        ));
    }
    if was_path || was_relative {
        // A path-form spelling stays a path even when the destination's stem
        // would now resolve on its own: the shape is the author's, and
        // shortening it is a rewrite they did not ask for.
        if kept_extension {
            candidates.push(full.to_string());
        } else {
            candidates.push(without_extension.to_string());
        }
    } else if kept_extension {
        candidates.push(filename.to_string());
    } else {
        candidates.push(stem.to_string());
    }
    // The over-specified fallbacks, in ascending order of how much they pin
    // down. Reached only when everything above is ambiguous or unresolved.
    candidates.push(without_extension.to_string());
    candidates.push(full.to_string());

    for candidate in candidates {
        if resolves_to(resolver, source, &candidate, to) {
            return candidate;
        }
    }
    full.to_string()
}

/// The `./` or `../` spelling that reaches `destination` from `source`'s own
/// folder, in the shape [`vault_core`]'s resolver normalizes.
fn relative_spelling(source: &VaultPath, destination: &str) -> String {
    let mut folder: Vec<&str> = source.as_str().split('/').collect();
    folder.pop();
    let target: Vec<&str> = destination.split('/').collect();
    let shared = folder
        .iter()
        .zip(target.iter())
        // The last target component is the file name, never a shared folder.
        .take(target.len().saturating_sub(1))
        .take_while(|(left, right)| left == right)
        .count();

    let mut spelling = String::new();
    if folder.len() == shared {
        spelling.push_str("./");
    } else {
        for _ in shared..folder.len() {
            spelling.push_str("../");
        }
    }
    spelling.push_str(&target[shared..].join("/"));
    spelling
}

/// `spelling`, escaped so it survives the syntax it is being spliced into.
///
/// A wikilink target is literal and needs nothing. A Markdown destination is
/// delimited by `(` and `)` and split on whitespace, so those three characters
/// are percent-encoded — unless the destination is already inside the `<...>`
/// form, where they are legal as written.
fn encode_for(kind: ReferenceKind, text: &str, start: usize, spelling: &str) -> String {
    let markdown = matches!(
        kind,
        ReferenceKind::MarkdownLink | ReferenceKind::MarkdownEmbed
    );
    if !markdown || text[..start].ends_with('<') {
        return spelling.to_string();
    }
    let mut encoded = String::with_capacity(spelling.len());
    for character in spelling.chars() {
        match character {
            ' ' => encoded.push_str("%20"),
            '(' => encoded.push_str("%28"),
            ')' => encoded.push_str("%29"),
            other => encoded.push(other),
        }
    }
    encoded
}

fn resolves_to(resolver: &Resolver, source: &VaultPath, candidate: &str, to: &VaultPath) -> bool {
    match resolver.resolve_target(source, &LinkTarget::parse(candidate)) {
        Resolution::Resolved { target, .. } | Resolution::MissingSubpath { target, .. } => {
            &target == to
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vp(spelling: &str) -> VaultPath {
        VaultPath::new(spelling).expect("valid path")
    }

    #[test]
    fn a_relative_spelling_reaches_up_exactly_as_far_as_it_must() {
        assert_eq!(
            relative_spelling(&vp("Nested/A.md"), "Renamed"),
            "../Renamed"
        );
        assert_eq!(
            relative_spelling(&vp("Nested/A.md"), "Nested/Renamed"),
            "./Renamed"
        );
        assert_eq!(
            relative_spelling(&vp("A/B/C.md"), "A/X/Y.md"),
            "../X/Y.md",
            "a shared folder prefix is not climbed past"
        );
        assert_eq!(relative_spelling(&vp("Top.md"), "Sub/Deep"), "./Sub/Deep");
    }

    /// The whole promise in one assertion: the splice covers the file half and
    /// stops at the `#`.
    #[test]
    fn the_file_half_of_a_destination_stops_at_its_subpath() {
        let text = "[[Alpha#Heading|shown]]\n";
        let reference = Reference {
            kind: ReferenceKind::Wikilink,
            origin: vault_core::ReferenceOrigin::Body,
            raw_target: "Alpha#Heading".into(),
            file_target: Some("Alpha".into()),
            subpath: None,
            display: Some("shown".into()),
            span: vault_core::SourceSpan::new(0, 23).expect("ordered"),
            target_span: vault_core::SourceSpan::new(2, 15).expect("ordered"),
        };
        let range = file_target_span(text, &reference).expect("a file half");
        assert_eq!(&text[range], "Alpha");
    }

    #[test]
    fn a_markdown_destination_escapes_what_its_syntax_would_swallow() {
        assert_eq!(
            encode_for(ReferenceKind::MarkdownLink, "[a](", 4, "My Note.md"),
            "My%20Note.md"
        );
        assert_eq!(
            encode_for(ReferenceKind::MarkdownLink, "[a](<", 5, "My Note.md"),
            "My Note.md",
            "the angle-bracket form takes spaces literally"
        );
        assert_eq!(
            encode_for(ReferenceKind::Wikilink, "[[", 2, "My Note"),
            "My Note",
            "a wikilink target is literal"
        );
    }
}
