use std::collections::BTreeMap;

use crate::vault_source::read_documents;
use crate::{
    Diagnostic, DiagnosticCode, ParsedNote, Resolution, ResolvedReference, Resolver, ScanError,
    Severity, Subpath, VaultPath, VaultSource, parse_note,
};

#[derive(Clone, Debug)]
pub struct SemanticGraph {
    notes: BTreeMap<VaultPath, ParsedNote>,
    outgoing: BTreeMap<VaultPath, Vec<ResolvedReference>>,
    backlinks: BTreeMap<VaultPath, Vec<ResolvedReference>>,
    unresolved: Vec<ResolvedReference>,
    ambiguous: Vec<ResolvedReference>,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug)]
pub struct ScanReport {
    pub graph: SemanticGraph,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn scan_vault(source: &impl VaultSource) -> Result<ScanReport, ScanError> {
    let documents = read_documents(source)?;
    let notes = documents.documents.into_iter().map(parse_note).collect();
    Ok(build_graph(notes, documents.diagnostics))
}

pub fn build_graph(notes: Vec<ParsedNote>, mut diagnostics: Vec<Diagnostic>) -> ScanReport {
    let resolver = Resolver::new(&notes);

    let mut outgoing: BTreeMap<VaultPath, Vec<ResolvedReference>> = BTreeMap::new();
    let mut backlinks: BTreeMap<VaultPath, Vec<ResolvedReference>> = BTreeMap::new();
    let mut unresolved = Vec::new();
    let mut ambiguous = Vec::new();

    for note in &notes {
        let path = note.source.path().clone();
        for diagnostic in &note.diagnostics {
            let mut diagnostic = diagnostic.clone();
            if diagnostic.path.is_none() {
                diagnostic.path = Some(path.clone());
            }
            diagnostics.push(diagnostic);
        }

        let resolved = resolver.resolve_note(note);
        for reference in &resolved {
            match &reference.resolution {
                Resolution::Resolved { target, .. } => {
                    backlinks
                        .entry(target.clone())
                        .or_default()
                        .push(reference.clone());
                }
                Resolution::MissingSubpath { target, subpath } => {
                    backlinks
                        .entry(target.clone())
                        .or_default()
                        .push(reference.clone());
                    let (code, kind) = match subpath {
                        Subpath::Heading(_) => (DiagnosticCode::MissingHeading, "heading"),
                        Subpath::Block(_) => (DiagnosticCode::MissingBlock, "block"),
                    };
                    diagnostics.push(
                        Diagnostic::new(
                            code,
                            Severity::Warning,
                            format!(
                                "{:?} resolves to {:?} but the {kind} subpath is missing",
                                reference.reference.raw_target,
                                target.as_str()
                            ),
                        )
                        .with_path(reference.source.clone())
                        .with_span(reference.source_span),
                    );
                }
                Resolution::Unresolved => {
                    unresolved.push(reference.clone());
                    diagnostics.push(
                        Diagnostic::new(
                            DiagnosticCode::UnresolvedReference,
                            Severity::Warning,
                            format!(
                                "{:?} does not resolve to any note",
                                reference.reference.raw_target
                            ),
                        )
                        .with_path(reference.source.clone())
                        .with_span(reference.source_span),
                    );
                }
                Resolution::Ambiguous { candidates } => {
                    ambiguous.push(reference.clone());
                    diagnostics.push(
                        Diagnostic::new(
                            DiagnosticCode::AmbiguousReference,
                            Severity::Warning,
                            format!(
                                "{:?} matches {} notes",
                                reference.reference.raw_target,
                                candidates.len()
                            ),
                        )
                        .with_path(reference.source.clone())
                        .with_span(reference.source_span),
                    );
                }
                Resolution::NonVault => {}
            }
        }
        outgoing.insert(path, resolved);
    }

    sort_references(&mut unresolved);
    sort_references(&mut ambiguous);
    for references in backlinks.values_mut() {
        sort_references(references);
    }
    diagnostics.sort_by(|a, b| {
        (&a.path, a.span, a.code, &a.message).cmp(&(&b.path, b.span, b.code, &b.message))
    });

    let graph = SemanticGraph {
        notes: notes
            .into_iter()
            .map(|note| (note.source.path().clone(), note))
            .collect(),
        outgoing,
        backlinks,
        unresolved,
        ambiguous,
        diagnostics: diagnostics.clone(),
    };
    ScanReport { graph, diagnostics }
}

fn sort_references(references: &mut [ResolvedReference]) {
    references.sort_by(|a, b| {
        (&a.source, a.source_span, &a.reference.raw_target).cmp(&(
            &b.source,
            b.source_span,
            &b.reference.raw_target,
        ))
    });
}

impl SemanticGraph {
    pub fn notes(&self) -> impl ExactSizeIterator<Item = &ParsedNote> {
        self.notes.values()
    }

    pub fn note_paths(&self) -> Vec<&VaultPath> {
        self.notes.keys().collect()
    }

    pub fn note(&self, path: &VaultPath) -> Option<&ParsedNote> {
        self.notes.get(path)
    }

    pub fn outgoing(&self, path: &VaultPath) -> &[ResolvedReference] {
        self.outgoing.get(path).map_or(&[], Vec::as_slice)
    }

    pub fn backlinks(&self, path: &VaultPath) -> &[ResolvedReference] {
        self.backlinks.get(path).map_or(&[], Vec::as_slice)
    }

    pub fn unresolved(&self) -> &[ResolvedReference] {
        &self.unresolved
    }

    pub fn ambiguous(&self) -> &[ResolvedReference] {
        &self.ambiguous
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }
}
