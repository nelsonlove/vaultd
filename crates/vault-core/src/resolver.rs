use std::collections::{BTreeMap, BTreeSet};

use crate::markdown::has_uri_scheme;
use crate::{
    Diagnostic, DiagnosticCode, ParsedNote, Reference, Severity, SourceSpan, Subpath, VaultPath,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Resolution {
    Resolved {
        target: VaultPath,
        subpath: Option<Subpath>,
    },
    MissingSubpath {
        target: VaultPath,
        subpath: Subpath,
    },
    Unresolved,
    Ambiguous {
        candidates: Vec<VaultPath>,
    },
    NonVault,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedReference {
    pub source: VaultPath,
    pub source_span: SourceSpan,
    pub reference: Reference,
    pub resolution: Resolution,
}

/// The lightweight per-note inputs resolution actually needs: the path plus
/// heading and block identity. A resolver can be rebuilt from these without
/// reparsing any note body.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionNote {
    pub path: VaultPath,
    pub headings: Vec<String>,
    pub blocks: Vec<String>,
}

impl From<&ParsedNote> for ResolutionNote {
    fn from(note: &ParsedNote) -> Self {
        Self {
            path: note.source.path().clone(),
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
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkTarget {
    pub raw_target: String,
    pub file_target: Option<String>,
    pub subpath: Option<Subpath>,
}

impl LinkTarget {
    pub fn parse(destination: impl Into<String>) -> Self {
        let raw_target = destination.into();
        let (file, fragment) = match raw_target.split_once('#') {
            Some((file, fragment)) => (file, Some(fragment)),
            None => (raw_target.as_str(), None),
        };
        let file_target = (!file.is_empty()).then(|| file.to_string());
        let subpath = fragment.and_then(|fragment| {
            if fragment.is_empty() {
                None
            } else if let Some(block) = fragment.strip_prefix('^') {
                Some(Subpath::Block(block.to_string()))
            } else {
                Some(Subpath::Heading(fragment.to_string()))
            }
        });
        Self {
            raw_target,
            file_target,
            subpath,
        }
    }
}

impl From<&Reference> for LinkTarget {
    fn from(reference: &Reference) -> Self {
        Self {
            raw_target: reference.raw_target.clone(),
            file_target: reference.file_target.clone(),
            subpath: reference.subpath.clone(),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct NoteSubpaths {
    heading_keys: BTreeSet<String>,
    block_ids: BTreeSet<String>,
}

pub struct Resolver {
    paths: BTreeSet<VaultPath>,
    filename_ci: BTreeMap<String, BTreeSet<VaultPath>>,
    stem_ci: BTreeMap<String, BTreeSet<VaultPath>>,
    subpaths: BTreeMap<VaultPath, NoteSubpaths>,
}

impl Resolver {
    pub fn new(notes: &[ParsedNote]) -> Self {
        Self::from_catalog(notes.iter().map(ResolutionNote::from))
    }

    pub fn from_catalog(notes: impl IntoIterator<Item = ResolutionNote>) -> Self {
        let mut resolver = Self {
            paths: BTreeSet::new(),
            filename_ci: BTreeMap::new(),
            stem_ci: BTreeMap::new(),
            subpaths: BTreeMap::new(),
        };
        for note in notes {
            let path = note.path;
            let filename = path
                .as_str()
                .rsplit('/')
                .next()
                .expect("split always yields one part")
                .to_lowercase();
            if let Some(stem) = filename.strip_suffix(".md") {
                resolver
                    .stem_ci
                    .entry(stem.to_string())
                    .or_default()
                    .insert(path.clone());
            }
            resolver
                .filename_ci
                .entry(filename)
                .or_default()
                .insert(path.clone());

            let entry = resolver.subpaths.entry(path.clone()).or_default();
            for heading in note.headings {
                entry.heading_keys.insert(heading.to_lowercase());
            }
            for block in note.blocks {
                entry.block_ids.insert(block);
            }
            resolver.paths.insert(path);
        }
        resolver
    }

    pub fn resolve_note(&self, note: &ParsedNote) -> Vec<ResolvedReference> {
        note.references
            .iter()
            .map(|reference| ResolvedReference {
                source: note.source.path().clone(),
                source_span: reference.span,
                reference: reference.clone(),
                resolution: self.resolve_target(note.source.path(), &LinkTarget::from(reference)),
            })
            .collect()
    }

    pub fn resolve_target(&self, source: &VaultPath, target: &LinkTarget) -> Resolution {
        if has_uri_scheme(&target.raw_target) {
            return Resolution::NonVault;
        }

        let Some(file_target) = target.file_target.as_deref() else {
            return self.with_subpath(source.clone(), target.subpath.clone());
        };

        if file_target.starts_with("./") || file_target.starts_with("../") {
            return match normalize_relative(source, file_target) {
                Some(candidate) => match self.exact_lookup(&candidate) {
                    Some(resolved) => self.with_subpath(resolved, target.subpath.clone()),
                    None => Resolution::Unresolved,
                },
                None => Resolution::Unresolved,
            };
        }

        if let Some(resolved) = self.exact_lookup(file_target) {
            return self.with_subpath(resolved, target.subpath.clone());
        }

        let key = file_target.to_lowercase();
        let mut candidates: BTreeSet<VaultPath> = BTreeSet::new();
        if let Some(matches) = self.filename_ci.get(&key) {
            candidates.extend(matches.iter().cloned());
        }
        if let Some(matches) = self.stem_ci.get(&key) {
            candidates.extend(matches.iter().cloned());
        }
        match candidates.len() {
            0 => Resolution::Unresolved,
            1 => self.with_subpath(
                candidates
                    .into_iter()
                    .next()
                    .expect("one candidate is present"),
                target.subpath.clone(),
            ),
            _ => Resolution::Ambiguous {
                candidates: candidates.into_iter().collect(),
            },
        }
    }

    fn exact_lookup(&self, spelling: &str) -> Option<VaultPath> {
        VaultPath::new(spelling)
            .ok()
            .filter(|path| self.paths.contains(path))
            .or_else(|| {
                VaultPath::new(format!("{spelling}.md"))
                    .ok()
                    .filter(|path| self.paths.contains(path))
            })
    }

    fn with_subpath(&self, target: VaultPath, subpath: Option<Subpath>) -> Resolution {
        let Some(subpath) = subpath else {
            return Resolution::Resolved {
                target,
                subpath: None,
            };
        };
        let known = self.subpaths.get(&target);
        let found = match &subpath {
            Subpath::Heading(heading) => {
                known.is_some_and(|entry| entry.heading_keys.contains(&heading.to_lowercase()))
            }
            Subpath::Block(block) => known.is_some_and(|entry| entry.block_ids.contains(block)),
        };
        if found {
            Resolution::Resolved {
                target,
                subpath: Some(subpath),
            }
        } else {
            Resolution::MissingSubpath { target, subpath }
        }
    }
}

/// Construct the single diagnostic a resolved reference produces, if any.
/// `build_graph` calls this for every reference instead of constructing
/// diagnostics inline, so incremental resolution (which resolves a subset of
/// references outside `build_graph`) cannot drift from the complete path's
/// messages, codes, severities, paths, or spans.
pub fn resolution_diagnostic(resolved: &ResolvedReference) -> Option<Diagnostic> {
    match &resolved.resolution {
        Resolution::Resolved { .. } | Resolution::NonVault => None,
        Resolution::MissingSubpath { target, subpath } => {
            let (code, kind) = match subpath {
                Subpath::Heading(_) => (DiagnosticCode::MissingHeading, "heading"),
                Subpath::Block(_) => (DiagnosticCode::MissingBlock, "block"),
            };
            Some(
                Diagnostic::new(
                    code,
                    Severity::Warning,
                    format!(
                        "{:?} resolves to {:?} but the {kind} subpath is missing",
                        resolved.reference.raw_target,
                        target.as_str()
                    ),
                )
                .with_path(resolved.source.clone())
                .with_span(resolved.source_span),
            )
        }
        Resolution::Unresolved => Some(
            Diagnostic::new(
                DiagnosticCode::UnresolvedReference,
                Severity::Warning,
                format!(
                    "{:?} does not resolve to any note",
                    resolved.reference.raw_target
                ),
            )
            .with_path(resolved.source.clone())
            .with_span(resolved.source_span),
        ),
        Resolution::Ambiguous { candidates } => Some(
            Diagnostic::new(
                DiagnosticCode::AmbiguousReference,
                Severity::Warning,
                format!(
                    "{:?} matches {} notes",
                    resolved.reference.raw_target,
                    candidates.len()
                ),
            )
            .with_path(resolved.source.clone())
            .with_span(resolved.source_span),
        ),
    }
}

/// Normalize a `./` or `../` spelling against the source note's parent.
/// Returns `None` when the path escapes above the vault root.
pub(crate) fn normalize_relative(source: &VaultPath, spelling: &str) -> Option<String> {
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
    if stack.is_empty() {
        return None;
    }
    Some(stack.join("/"))
}
