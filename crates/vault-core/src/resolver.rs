use std::collections::{BTreeMap, BTreeSet};

use crate::markdown::has_uri_scheme;
use crate::{ParsedNote, Reference, SourceSpan, Subpath, VaultPath};

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
        let mut resolver = Self {
            paths: BTreeSet::new(),
            filename_ci: BTreeMap::new(),
            stem_ci: BTreeMap::new(),
            subpaths: BTreeMap::new(),
        };
        for note in notes {
            let path = note.source.path().clone();
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
            for heading in &note.headings {
                entry.heading_keys.insert(heading.text.to_lowercase());
            }
            for block in &note.blocks {
                entry.block_ids.insert(block.value.clone());
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
                resolution: self.resolve(note.source.path(), reference),
            })
            .collect()
    }

    fn resolve(&self, source: &VaultPath, reference: &Reference) -> Resolution {
        if has_uri_scheme(&reference.raw_target) {
            return Resolution::NonVault;
        }

        let Some(file_target) = reference.file_target.as_deref() else {
            return self.with_subpath(source.clone(), reference.subpath.clone());
        };

        if file_target.starts_with("./") || file_target.starts_with("../") {
            return match normalize_relative(source, file_target) {
                Some(candidate) => match self.exact_lookup(&candidate) {
                    Some(target) => self.with_subpath(target, reference.subpath.clone()),
                    None => Resolution::Unresolved,
                },
                None => Resolution::Unresolved,
            };
        }

        if let Some(target) = self.exact_lookup(file_target) {
            return self.with_subpath(target, reference.subpath.clone());
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
                reference.subpath.clone(),
            ),
            _ => Resolution::Ambiguous {
                candidates: candidates.into_iter().collect(),
            },
        }
    }

    fn exact_lookup(&self, spelling: &str) -> Option<VaultPath> {
        if let Ok(path) = VaultPath::new(spelling)
            && self.paths.contains(&path)
        {
            return Some(path);
        }
        if let Ok(path) = VaultPath::new(format!("{spelling}.md"))
            && self.paths.contains(&path)
        {
            return Some(path);
        }
        None
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

/// Normalize a `./` or `../` spelling against the source note's parent.
/// Returns `None` when the path escapes above the vault root.
fn normalize_relative(source: &VaultPath, spelling: &str) -> Option<String> {
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
