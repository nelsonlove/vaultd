//! Rename link repair.
//!
//! Two tiers, because neither layer can answer the whole question:
//!
//! * the **live graph** answers *which* references reach a moved path. It
//!   stores dependency keys and reference identities and deliberately stores
//!   no spans and no spellings, so it can say "these references" and nothing
//!   more;
//! * the **durable SQL layer** answers *how to rewrite each one*.
//!   `note_references.target_span` is the byte range of the link's whole
//!   destination and `note_references.file_target` is the file half of it, so
//!   an in-place splice covers the file half **only** — a `#heading`, a
//!   `^block`, and display text all sit outside it — and `notes.source_bytes`
//!   is the document those spans index.
//!
//! **Nothing is written on the strength of a spelling alone.** A candidate
//! spelling is a *target string*; what lands on disk is that string inside a
//! link syntax, and the two are not the same claim. `[[A|B]]` names `A.md`,
//! `[[Note#1.md]]` names `Note.md` — both are strings whose target half
//! validates and whose *link* means a different existing note. So every
//! candidate replacement is built, **re-parsed through the real parser**, and
//! accepted only when the reference that comes back out has the file target,
//! the subpath and the display text it was supposed to have, and resolves to
//! the intended note. A name no wikilink can spell falls back to Markdown
//! syntax, where percent-encoding can express it; a reference with no such
//! fallback — a frontmatter one, which carries wikilinks and nothing else —
//! is reported rather than corrupted.
//!
//! **What is repaired.** Every reference reaching a moved path, wherever the
//! referring note lives: outside the move, inside it (a path-form link between
//! two notes in a renamed folder breaks exactly as an outside one does), and a
//! note's reference to itself. Attachments too — the live graph carries no
//! identity for a non-note, so their lookup keys are synthesized here, but the
//! reference rows reach them and a folder rename moves them. Every reference a
//! *moving* note carries is re-validated as well, because its own location
//! changed and a relative spelling is read from where the note now is.
//!
//! **What is not.** A wikilink inside an HTML block: the parser suppresses
//! text ranges at `html_depth > 0`, so no reference row exists to repair, the
//! same way code fences, inline code and math blocks are suppressed. That is
//! inherited parser policy rather than a decision here, and it is invisible to
//! this module — there is nothing to report, because nothing was seen.
//! Everything this module *does* see and decline lands in
//! [`LinkRewriteFailure`] with a typed reason.

use std::collections::{BTreeMap, BTreeSet};

use vault_core::{
    LinkTarget, Reference, ReferenceKind, ReferenceOrigin, Resolution, ResolutionIdentityChange,
    ResolutionNote, Resolver, SourceDocument, Subpath, VaultPath, changed_candidate_keys,
    parse_note,
};

use crate::error::IndexError;
use crate::live_graph::LiveGraph;
use crate::mutate::{LinkRewriteFailure, LinkRewriteReason, MutationEngine};
use crate::store::IndexStore;

/// One referencing note's finished new body.
pub(crate) struct Rewrite {
    /// Where the patched bytes are written — the referrer's **post-move**
    /// location, which differs from where they were read when the referrer is
    /// itself inside a renamed folder.
    pub(crate) path: VaultPath,
    pub(crate) patched: String,
    /// The revision this patch was computed from. Re-compared immediately
    /// before the write, so a referrer edited or deleted since the plan is
    /// reported rather than clobbered or resurrected.
    pub(crate) expected: String,
    pub(crate) links: u64,
}

pub(crate) struct Repair {
    pub(crate) rewrites: Vec<Rewrite>,
    pub(crate) failures: Vec<LinkRewriteFailure>,
}

/// The note identity a path carries in `graph`, as resolution sees it, or a
/// synthetic one for a path the graph does not track.
///
/// A non-note — an attachment, a folder — has no headings and no block ids,
/// and that is exactly the identity `changed_candidate_keys` needs to produce
/// its exact-path, filename and stem lookup keys. The graph cannot supply one
/// because it holds notes only; the reference rows still reach the path, so
/// synthesizing it is what lets a moved attachment's embeds be found.
fn identity(graph: &LiveGraph, path: &VaultPath) -> ResolutionNote {
    graph
        .note(path)
        .map(|note| ResolutionNote {
            path: note.path,
            headings: note.headings,
            blocks: note.blocks,
        })
        .unwrap_or_else(|| ResolutionNote {
            path: path.clone(),
            headings: Vec::new(),
            blocks: Vec::new(),
        })
}

fn at_path(note: &ResolutionNote, destination: &VaultPath) -> ResolutionNote {
    ResolutionNote {
        path: destination.clone(),
        headings: note.headings.clone(),
        blocks: note.blocks.clone(),
    }
}

/// Plan every referencing note's rewrite for one set of `from -> to` moves.
///
/// A folder rename is the same problem with more moves, so both go through
/// here: a note that references two of the moved paths is rewritten once,
/// with both spans spliced.
///
/// Runs **before** the movement, against the index's pre-move rows and the
/// pre-move bytes on disk, and records each rewrite's post-move write target.
/// The coordinator moves first and writes second, so a movement that is
/// refused has cost nothing but this plan.
pub(crate) fn plan_repair(
    graph: &LiveGraph,
    store: &IndexStore,
    engine: &MutationEngine,
    moves: &BTreeMap<VaultPath, VaultPath>,
) -> Result<Repair, IndexError> {
    // Tier one, part one: which references could be reaching any moved path.
    // Keys come only from `vault_core`'s own constructor, never hand-built, so
    // the selection can never be narrower than resolution's own lookup routes.
    let mut selected: BTreeMap<VaultPath, BTreeSet<u32>> = BTreeMap::new();
    for (from, to) in moves {
        let old = identity(graph, from);
        let change = ResolutionIdentityChange {
            new: Some(at_path(&old, to)),
            old: Some(old),
        };
        for key in changed_candidate_keys(&change) {
            for reference in graph.dependents(&key) {
                let Some(source) = graph.note_path(reference.source) else {
                    continue;
                };
                selected
                    .entry(source.clone())
                    .or_default()
                    .insert(reference.ordinal);
            }
        }
    }
    // Tier one, part two: every reference a *moving* note carries. Its own
    // location changes, and a relative spelling is read from where the note
    // is, so a link that reached up one level may now have to reach up two.
    for from in moves.keys() {
        for key in graph.reference_keys(from) {
            selected
                .entry(from.clone())
                .or_default()
                .insert(key.ordinal);
        }
    }

    // The catalog the vault will have *after* the moves, so a preserved
    // spelling is checked against the world it will actually live in. Notes
    // only: a resolver answers about notes, and putting an attachment in it
    // would invent a note that does not exist.
    let mut catalog: BTreeMap<VaultPath, ResolutionNote> = BTreeMap::new();
    for path in graph.note_paths() {
        if moves.contains_key(&path) {
            continue;
        }
        catalog.insert(path.clone(), identity(graph, &path));
    }
    let mut note_destinations: BTreeSet<VaultPath> = BTreeSet::new();
    for (from, to) in moves {
        if let Some(note) = graph.note(from) {
            catalog.insert(
                to.clone(),
                at_path(
                    &ResolutionNote {
                        path: note.path,
                        headings: note.headings,
                        blocks: note.blocks,
                    },
                    to,
                ),
            );
            note_destinations.insert(to.clone());
        }
    }
    note_destinations.extend(catalog.keys().cloned());
    let resolver = Resolver::from_catalog(catalog.into_values());

    // Tier two: the spans and the spellings.
    let mut rewrites = Vec::new();
    let mut failures = Vec::new();
    for (source, ordinals) in selected {
        // Where the patched bytes will be written. A referrer inside a renamed
        // folder is read here and written there.
        let write_target = moves
            .get(&source)
            .cloned()
            .unwrap_or_else(|| source.clone());

        let Some(stored) = store.load_note(&source)? else {
            failures.push(LinkRewriteFailure {
                path: source,
                reason: LinkRewriteReason::NotIndexed,
            });
            continue;
        };
        // Per-file compare-and-swap: the spans below index the bytes the index
        // knows, so a file that moved since is not one this plan can safely
        // edit. Re-checked again immediately before the write; this one keeps
        // the whole plan honest, that one closes the window.
        let indexed = stored.source.revision().as_str().to_string();
        match engine.current_revision(&source)? {
            Some(on_disk) if on_disk == indexed => {}
            _ => {
                failures.push(LinkRewriteFailure {
                    path: source,
                    reason: LinkRewriteReason::RevisionConflict,
                });
                continue;
            }
        }

        let text = stored.source.text();
        let outgoing = store.load_outgoing_by_ordinal(&source)?;
        let mut splices: Vec<(std::ops::Range<usize>, String)> = Vec::new();
        for ordinal in ordinals {
            let Some(reference) = outgoing.get(&ordinal) else {
                // `load_outgoing_by_ordinal` documents an absent key as a
                // broken invariant rather than a reference to skip.
                failures.push(LinkRewriteFailure {
                    path: source.clone(),
                    reason: LinkRewriteReason::ReferenceMissing,
                });
                continue;
            };
            let Some(existing) = reference.reference.file_target.as_deref() else {
                // A same-note subpath reference names no file, so there is
                // nothing to retarget: it travels with its own note whether
                // that note moves or not.
                continue;
            };
            // What this reference means to point at, and where that will be.
            let Some(intended) = intended_target(&source, existing, reference, moves) else {
                continue;
            };
            let destination = moves.get(&intended).cloned().unwrap_or(intended.clone());
            if destination == intended && write_target == source {
                // Neither end of this reference moved.
                continue;
            }
            let Some(file_range) = file_target_span(text, &reference.reference) else {
                failures.push(LinkRewriteFailure {
                    path: source.clone(),
                    reason: LinkRewriteReason::SpanMismatch,
                });
                continue;
            };
            match emit(
                Emission {
                    text,
                    reference,
                    file_range,
                    source: &write_target,
                    destination: &destination,
                    resolver: &resolver,
                    resolver_governs: note_destinations.contains(&destination),
                },
                existing,
            ) {
                Emitted::Unchanged => {}
                Emitted::Splice(range, bytes) => splices.push((range, bytes)),
                Emitted::Impossible => failures.push(LinkRewriteFailure {
                    path: source.clone(),
                    reason: LinkRewriteReason::UnwritableSpelling,
                }),
            }
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
            path: write_target,
            patched,
            expected: indexed,
            links,
        });
    }
    rewrites.sort_by(|left, right| left.path.cmp(&right.path));
    failures.sort_by(|left, right| {
        (&left.path, left.reason.as_str()).cmp(&(&right.path, right.reason.as_str()))
    });
    Ok(Repair { rewrites, failures })
}

/// The vault path this reference means to point at, if the repair can name one.
///
/// A resolved reference names its own target. An **unresolved** one still can:
/// an attachment is not a note, so `![[Folder/img.png]]` never resolves, and
/// its spelling — normalized against the source when it is relative — is the
/// only thing that says what it meant. That spelling counts only when it names
/// a path this rename is actually moving, so an ordinarily-broken link is not
/// mistaken for something to repair.
fn intended_target(
    source: &VaultPath,
    existing: &str,
    reference: &vault_core::ResolvedReference,
    moves: &BTreeMap<VaultPath, VaultPath>,
) -> Option<VaultPath> {
    match &reference.resolution {
        Resolution::Resolved { target, .. } | Resolution::MissingSubpath { target, .. } => {
            Some(target.clone())
        }
        _ => {
            let spelled = if existing.starts_with("./") || existing.starts_with("../") {
                relative_to_absolute(source, existing)?
            } else {
                existing.to_string()
            };
            let path = VaultPath::new(spelled).ok()?;
            moves.contains_key(&path).then_some(path)
        }
    }
}

/// Everything one reference's replacement is built from.
struct Emission<'a> {
    text: &'a str,
    reference: &'a vault_core::ResolvedReference,
    file_range: std::ops::Range<usize>,
    /// The referring note's **post-move** location: a relative spelling is
    /// read from where the note will be, not where it is.
    source: &'a VaultPath,
    destination: &'a VaultPath,
    resolver: &'a Resolver,
    /// Whether `resolver` can answer about `destination` at all. False for an
    /// attachment, which no resolver holds; then the re-parse equality is the
    /// whole check and the spelling is taken on its shape.
    resolver_governs: bool,
}

enum Emitted {
    Unchanged,
    Splice(std::ops::Range<usize>, String),
    Impossible,
}

/// Build the replacement for one reference and prove it means what it should.
///
/// Candidate spellings are tried in shape-preserving order, and each is tried
/// in the reference's **own syntax** first and then, if that syntax cannot
/// spell it, as a Markdown link. Every attempt is re-parsed and checked; the
/// first that survives wins.
fn emit(emission: Emission<'_>, existing: &str) -> Emitted {
    for candidate in candidates(emission.source, existing, emission.destination) {
        for replacement in [
            in_place(&emission, &candidate),
            as_markdown_link(&emission, &candidate),
        ]
        .into_iter()
        .flatten()
        {
            if !means_what_it_should(&emission, &replacement) {
                continue;
            }
            if emission.text[replacement.range.clone()] == replacement.bytes {
                return Emitted::Unchanged;
            }
            return Emitted::Splice(replacement.range, replacement.bytes);
        }
    }
    Emitted::Impossible
}

struct Replacement {
    /// The byte range of `text` this replaces — the file-target half for an
    /// in-place rewrite, the whole reference when the syntax has to change.
    range: std::ops::Range<usize>,
    bytes: String,
    /// The file target the emitted link is supposed to carry, decoded.
    intended_file: String,
    /// The display text the emitted link is supposed to carry. The original's
    /// for an in-place rewrite; for a syntax change it is *created*, because
    /// `[[X]]` shows its target and `[](X)` has nowhere to show one, so it
    /// cannot be compared against the original's `None`.
    intended_display: Option<String>,
}

/// The same syntax, with only the file-target bytes changed.
fn in_place(emission: &Emission<'_>, candidate: &str) -> Option<Replacement> {
    Some(Replacement {
        range: emission.file_range.clone(),
        bytes: encode_for(emission.reference.reference.kind, candidate),
        intended_file: candidate.to_string(),
        intended_display: emission.reference.reference.display.clone(),
    })
}

/// A Markdown link over the whole reference, for a name the reference's own
/// syntax cannot spell.
///
/// Only reachable for a body reference: frontmatter carries wikilinks and
/// nothing else, so a Markdown link written there would be a plain string.
fn as_markdown_link(emission: &Emission<'_>, candidate: &str) -> Option<Replacement> {
    let reference = &emission.reference.reference;
    if reference.origin != ReferenceOrigin::Body {
        return None;
    }
    let embed = matches!(
        reference.kind,
        ReferenceKind::WikiEmbed | ReferenceKind::MarkdownEmbed
    );
    let display = reference
        .display
        .clone()
        .unwrap_or_else(|| stem_of(candidate).to_string());
    let mut destination = encode_for(ReferenceKind::MarkdownLink, candidate);
    if let Some(subpath) = &reference.subpath {
        destination.push('#');
        destination.push_str(&encode_for(
            ReferenceKind::MarkdownLink,
            &match subpath {
                Subpath::Heading(heading) => heading.clone(),
                Subpath::Block(block) => format!("^{block}"),
            },
        ));
    }
    Some(Replacement {
        range: reference.span.start()..reference.span.end(),
        bytes: format!(
            "{}[{}]({destination})",
            if embed { "!" } else { "" },
            escape_display(&display)
        ),
        intended_file: candidate.to_string(),
        intended_display: Some(display),
    })
}

/// Re-parse the candidate replacement and require the reference it yields to
/// be the one that was intended: same file target (decoded), same subpath,
/// same display text, and — when a resolver can answer about the destination —
/// resolving to it.
///
/// This is the guard, not the spelling check before it. A target string can
/// validate and still mean another note once it sits between `[[` and `]]`.
fn means_what_it_should(emission: &Emission<'_>, replacement: &Replacement) -> bool {
    let original = &emission.reference.reference;
    // The reference's own text with this replacement applied, parsed on its
    // own. Only the reference is parsed, so the cost is per-link and not
    // per-document.
    let span = original.span.start()..original.span.end();
    let Some(whole) = emission.text.get(span.clone()) else {
        return false;
    };
    let snippet = if replacement.range == span {
        replacement.bytes.clone()
    } else {
        let Some(start) = replacement.range.start.checked_sub(span.start) else {
            return false;
        };
        let end = replacement.range.end - span.start;
        let Some(prefix) = whole.get(..start) else {
            return false;
        };
        let Some(suffix) = whole.get(end..) else {
            return false;
        };
        format!("{prefix}{}{suffix}", replacement.bytes)
    };

    let probe = parse_note(SourceDocument::new(
        emission.source.clone(),
        format!("{snippet}\n"),
    ));
    let [parsed] = probe.references.as_slice() else {
        return false;
    };
    if parsed.file_target.as_deref() != Some(replacement.intended_file.as_str())
        || parsed.subpath != original.subpath
        || parsed.display != replacement.intended_display
        || parsed.kind != expected_kind(original.kind, replacement, &span)
    {
        return false;
    }
    if !emission.resolver_governs {
        return true;
    }
    matches!(
        emission
            .resolver
            .resolve_target(emission.source, &LinkTarget::from(parsed)),
        Resolution::Resolved { target, .. } | Resolution::MissingSubpath { target, .. }
            if &target == emission.destination
    )
}

/// The link kind the emitted bytes must parse back as: the original's when the
/// splice stayed inside it, and the Markdown twin when the whole reference was
/// replaced. Checked so a wikilink that silently stopped being one — an
/// unbalanced bracket in a name, say — is refused rather than written.
fn expected_kind(
    original: ReferenceKind,
    replacement: &Replacement,
    span: &std::ops::Range<usize>,
) -> ReferenceKind {
    if replacement.range != *span {
        return original;
    }
    match original {
        ReferenceKind::WikiEmbed | ReferenceKind::MarkdownEmbed => ReferenceKind::MarkdownEmbed,
        ReferenceKind::Wikilink | ReferenceKind::MarkdownLink => ReferenceKind::MarkdownLink,
    }
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

/// The spellings that could replace `existing` so it points at `to` from
/// `source`, in shape-preserving order.
///
/// Shape is preserved before length is: a shortest-form spelling stays
/// shortest, a path-form spelling stays a path, a relative one stays relative,
/// and a spelling that carried `.md` keeps carrying it. The over-specified
/// forms follow, so ambiguity the rename introduces upgrades the spelling
/// rather than silently retargeting it. The full vault path is always last and
/// is the one that pins the target down completely — but it is a *candidate*,
/// checked like every other, never an unchecked fallback.
fn candidates(source: &VaultPath, existing: &str, to: &VaultPath) -> Vec<String> {
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
        candidates.push(if kept_extension {
            full.to_string()
        } else {
            without_extension.to_string()
        });
    } else if kept_extension {
        candidates.push(filename.to_string());
    } else {
        candidates.push(stem.to_string());
    }
    candidates.push(without_extension.to_string());
    candidates.push(full.to_string());
    candidates.dedup();
    candidates
}

fn stem_of(spelling: &str) -> &str {
    let filename = spelling.rsplit('/').next().unwrap_or(spelling);
    filename.strip_suffix(".md").unwrap_or(filename)
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

/// The inverse: a `./` or `../` spelling read as a vault path from `source`.
fn relative_to_absolute(source: &VaultPath, spelling: &str) -> Option<String> {
    let mut stack: Vec<&str> = source.as_str().split('/').collect();
    stack.pop();
    for component in spelling.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                stack.pop()?;
            }
            component => stack.push(component),
        }
    }
    (!stack.is_empty()).then(|| stack.join("/"))
}

/// `spelling`, escaped so it survives the syntax it is being spliced into.
///
/// A wikilink target is literal — there is no escape at all, which is why a
/// name a wikilink cannot spell has to change syntax rather than be encoded.
/// A Markdown destination is delimited by `(`/`)`, split on whitespace, and
/// cut at `#`, so every one of those is percent-encoded. `%` goes first, or
/// encoding the rest would double-encode it; `|`, `<` and `>` follow because a
/// table cell and the angle-bracket destination form would otherwise end the
/// link early.
fn encode_for(kind: ReferenceKind, spelling: &str) -> String {
    if matches!(kind, ReferenceKind::Wikilink | ReferenceKind::WikiEmbed) {
        return spelling.to_string();
    }
    let mut encoded = String::with_capacity(spelling.len());
    for character in spelling.chars() {
        match character {
            '%' => encoded.push_str("%25"),
            ' ' => encoded.push_str("%20"),
            '(' => encoded.push_str("%28"),
            ')' => encoded.push_str("%29"),
            '#' => encoded.push_str("%23"),
            '|' => encoded.push_str("%7C"),
            '<' => encoded.push_str("%3C"),
            '>' => encoded.push_str("%3E"),
            other => encoded.push(other),
        }
    }
    encoded
}

/// Display text, escaped so the closing `]` of a Markdown link is the one this
/// code wrote.
fn escape_display(display: &str) -> String {
    let mut escaped = String::with_capacity(display.len());
    for character in display.chars() {
        if matches!(character, '\\' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
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
            origin: ReferenceOrigin::Body,
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
    fn a_markdown_destination_escapes_everything_its_syntax_would_eat() {
        assert_eq!(
            encode_for(ReferenceKind::MarkdownLink, "My Note (draft).md"),
            "My%20Note%20%28draft%29.md"
        );
        assert_eq!(
            encode_for(ReferenceKind::MarkdownLink, "Note#1.md"),
            "Note%231.md",
            "an unescaped # would cut the destination into a file and a subpath"
        );
        assert_eq!(
            encode_for(ReferenceKind::MarkdownLink, "100%.md"),
            "100%25.md",
            "the escape character is escaped first, or every other escape doubles"
        );
        assert_eq!(
            encode_for(ReferenceKind::Wikilink, "A|B"),
            "A|B",
            "a wikilink target is literal; a name it cannot spell changes syntax instead"
        );
    }

    #[test]
    fn display_text_cannot_close_the_link_early() {
        assert_eq!(escape_display("a [b] c"), "a \\[b\\] c");
    }

    #[test]
    fn a_relative_spelling_reads_back_to_the_path_it_names() {
        assert_eq!(
            relative_to_absolute(&vp("Nested/A.md"), "../Folder/img.png").as_deref(),
            Some("Folder/img.png")
        );
        assert_eq!(
            relative_to_absolute(&vp("A.md"), "../escapes").as_deref(),
            None
        );
    }
}
