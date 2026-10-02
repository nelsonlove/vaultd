use std::collections::BTreeSet;

use crate::resolver::normalize_relative;
use crate::{LinkTarget, Resolution, ResolutionNote, VaultPath};

/// The lookup route a dependency key represents. Mirrors the resolver's
/// stages exactly: `ExactPath` and `ExactPathWithExtension` are the two
/// spellings `Resolver::exact_lookup` tries; `Filename`/`Stem` are the
/// case-insensitive name-stage maps; `ResolvedTarget` covers same-note
/// subpath references and any reference that already resolved to a target
/// (so heading/block membership changes on that target can be tracked).
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum DependencyKind {
    ExactPath,
    ExactPathWithExtension,
    Filename,
    Stem,
    ResolvedTarget,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DependencyKey {
    pub kind: DependencyKind,
    pub comparison_key: String,
}

impl DependencyKey {
    pub fn new(kind: DependencyKind, comparison_key: impl Into<String>) -> Self {
        Self {
            kind,
            comparison_key: comparison_key.into(),
        }
    }
}

/// The dependency keys a reference's resolution answer depends on, mirroring
/// the exact lookup routes `Resolver::resolve_target` takes for `target`'s
/// spelling. A note change is relevant to this reference only if it touches
/// one of these keys.
pub fn reference_dependencies(
    source: &VaultPath,
    target: &LinkTarget,
    resolution: &Resolution,
) -> Vec<DependencyKey> {
    if matches!(resolution, Resolution::NonVault) {
        return Vec::new();
    }

    let mut keys: BTreeSet<DependencyKey> = BTreeSet::new();

    match target.file_target.as_deref() {
        None => {
            // Same-note subpath reference: resolves to the source note itself.
            keys.insert(DependencyKey::new(
                DependencyKind::ResolvedTarget,
                source.as_str(),
            ));
        }
        Some(file_target) if file_target.starts_with("./") || file_target.starts_with("../") => {
            // Relative spellings normalize against the source's parent, then
            // only the exact-lookup routes apply (the resolver never falls
            // through to the name stage for a relative spelling).
            if let Some(candidate) = normalize_relative(source, file_target) {
                keys.insert(DependencyKey::new(
                    DependencyKind::ExactPath,
                    candidate.clone(),
                ));
                keys.insert(DependencyKey::new(
                    DependencyKind::ExactPathWithExtension,
                    format!("{candidate}.md"),
                ));
            }
        }
        Some(file_target) => {
            keys.insert(DependencyKey::new(
                DependencyKind::ExactPath,
                file_target.to_string(),
            ));
            keys.insert(DependencyKey::new(
                DependencyKind::ExactPathWithExtension,
                format!("{file_target}.md"),
            ));
            let lowered = file_target.to_lowercase();
            keys.insert(DependencyKey::new(
                DependencyKind::Filename,
                lowered.clone(),
            ));
            keys.insert(DependencyKey::new(DependencyKind::Stem, lowered));
        }
    }

    if let Resolution::Resolved { target, .. } | Resolution::MissingSubpath { target, .. } =
        resolution
    {
        keys.insert(DependencyKey::new(
            DependencyKind::ResolvedTarget,
            target.as_str(),
        ));
    }

    keys.into_iter().collect()
}

/// The before/after identity of a single note, as seen by resolution. `None`
/// means the note did not exist on that side (added when `old` is `None`,
/// removed when `new` is `None`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionIdentityChange {
    pub old: Option<ResolutionNote>,
    pub new: Option<ResolutionNote>,
}

/// The dependency keys a note identity change can invalidate. A reference is
/// a candidate for re-resolution exactly when one of its own
/// `reference_dependencies` keys appears in this set.
///
/// - When the note's path is added, removed, or renamed, every exact-path,
///   implicit-extension, filename, and stem key for the affected path(s) is
///   included, since any reference reaching that path via any lookup route
///   could change its answer.
/// - When the path is stable but heading/block membership changed, only the
///   `ResolvedTarget` key for that path is included: exact/filename/stem
///   lookup outcomes for other references cannot change, but subpath
///   resolutions (missing-heading, missing-block) against this target can.
/// - Identical old/new values (a body-only edit) yield an empty set.
pub fn changed_candidate_keys(change: &ResolutionIdentityChange) -> BTreeSet<DependencyKey> {
    let mut keys = BTreeSet::new();

    if change.old == change.new {
        return keys;
    }

    let path_changed = match (&change.old, &change.new) {
        (Some(old), Some(new)) => old.path != new.path,
        _ => true,
    };

    if path_changed {
        if let Some(old) = &change.old {
            add_identity_keys(old, &mut keys);
        }
        if let Some(new) = &change.new {
            add_identity_keys(new, &mut keys);
        }
    }

    if let (Some(old), Some(new)) = (&change.old, &change.new) {
        if old.path == new.path
            && (old.headings != new.headings || old.blocks != new.blocks || old.views != new.views)
        {
            keys.insert(DependencyKey::new(
                DependencyKind::ResolvedTarget,
                old.path.as_str(),
            ));
        }
    }

    keys
}

fn add_identity_keys(note: &ResolutionNote, keys: &mut BTreeSet<DependencyKey>) {
    let path_str = note.path.as_str();
    keys.insert(DependencyKey::new(DependencyKind::ExactPath, path_str));
    keys.insert(DependencyKey::new(
        DependencyKind::ExactPathWithExtension,
        path_str,
    ));

    let filename = path_str
        .rsplit('/')
        .next()
        .expect("split always yields one part")
        .to_lowercase();
    if let Some(stem) = filename.strip_suffix(".md") {
        keys.insert(DependencyKey::new(DependencyKind::Stem, stem.to_string()));
    }
    keys.insert(DependencyKey::new(DependencyKind::Filename, filename));
}
