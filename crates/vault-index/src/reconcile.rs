use vault_core::{
    Diagnostic, DiagnosticCode, ParsedNote, Resolver, ScanError, ScanReport, Severity,
    SourceDocument, SourceError, build_graph, parse_note,
};

use crate::config::IndexConfig;
use crate::error::IndexError;
use crate::inventory::{FileSystemIndexSource, InventorySnapshot, ReconcileSource};
use crate::model::{FileFingerprint, Generation};
use crate::store::{IndexStore, PublishOutcome};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefreshReport {
    pub previous_generation: Option<Generation>,
    pub generation: Generation,
    pub added: u64,
    pub changed: u64,
    pub deleted: u64,
    pub unchanged: u64,
    pub reparsed: u64,
    pub verified: bool,
}

/// Parsed changed notes with their fingerprints, plus pre-graph diagnostics.
type ParsedBatch = (Vec<(ParsedNote, FileFingerprint)>, Vec<Diagnostic>);

pub struct IndexService {
    // Read by vault_info and rebuild validation in later tasks.
    #[allow(dead_code)]
    pub(crate) config: IndexConfig,
    pub(crate) store: IndexStore,
    pub(crate) source: Box<dyn ReconcileSource>,
    pub(crate) resolver: Option<(Generation, Resolver)>,
}

impl IndexService {
    pub fn open(config: IndexConfig) -> Result<Self, IndexError> {
        let source = FileSystemIndexSource::new(&config.canonical_vault_root)?;
        Self::open_with_source(config, Box::new(source))
    }

    pub fn open_with_source(
        config: IndexConfig,
        source: Box<dyn ReconcileSource>,
    ) -> Result<Self, IndexError> {
        let source_root = source
            .canonical_root()
            .canonicalize()
            .map_err(|error| IndexError::InvalidVaultRoot(error.to_string()))?;
        if source_root != config.canonical_vault_root {
            return Err(IndexError::InvalidVaultRoot(format!(
                "source root {} does not match the configured vault root {}",
                source_root.display(),
                config.canonical_vault_root.display()
            )));
        }
        let store = IndexStore::open(&config)?;
        Ok(Self {
            config,
            store,
            source,
            resolver: None,
        })
    }

    pub fn current_generation(&self) -> Result<Option<Generation>, IndexError> {
        self.store.current_generation()
    }

    pub fn refresh(&mut self, verify: bool) -> Result<RefreshReport, IndexError> {
        match self.current_generation()? {
            None => self.cold_refresh(verify),
            Some(previous) => self.cold_rebuild_from(previous, verify),
        }
    }

    /// Build every note from the filesystem and publish one atomic snapshot.
    fn cold_refresh(&mut self, verify: bool) -> Result<RefreshReport, IndexError> {
        let previous = self.current_generation()?;
        let first = self.source.inventory()?;
        let (notes, diagnostics) = self.read_and_parse_all(&first)?;

        let report = build_graph(
            notes.iter().map(|(note, _)| note.clone()).collect(),
            diagnostics.clone(),
        );
        let second = self.source.inventory()?;
        if first != second {
            return Err(IndexError::VaultChangedDuringRefresh);
        }

        let count = notes.len() as u64;
        let outcome = self.store.publish(
            previous,
            &notes,
            &[],
            &report.graph,
            &diagnostics,
            &report.diagnostics,
        )?;
        let generation = match outcome {
            PublishOutcome::Committed(generation) => generation,
            PublishOutcome::GenerationChanged => {
                return Err(IndexError::Storage(
                    "concurrent refresh did not stabilize".into(),
                ));
            }
        };
        self.reload_resolver(generation)?;
        Ok(RefreshReport {
            previous_generation: previous,
            generation,
            added: count,
            changed: 0,
            deleted: 0,
            unchanged: 0,
            reparsed: count,
            verified: verify,
        })
    }

    /// Placeholder incremental entry point until Task 6: rebuild everything
    /// against the current generation.
    fn cold_rebuild_from(
        &mut self,
        previous: Generation,
        verify: bool,
    ) -> Result<RefreshReport, IndexError> {
        let first = self.source.inventory()?;
        let (notes, diagnostics) = self.read_and_parse_all(&first)?;
        let report = build_graph(
            notes.iter().map(|(note, _)| note.clone()).collect(),
            diagnostics.clone(),
        );
        let second = self.source.inventory()?;
        if first != second {
            return Err(IndexError::VaultChangedDuringRefresh);
        }
        let stored_paths = self.store.stored_paths()?;
        let deleted: Vec<_> = stored_paths
            .iter()
            .filter(|path| !first.entries.contains_key(path))
            .cloned()
            .collect();
        let count = notes.len() as u64;
        let outcome = self.store.publish(
            Some(previous),
            &notes,
            &deleted,
            &report.graph,
            &diagnostics,
            &report.diagnostics,
        )?;
        let generation = match outcome {
            PublishOutcome::Committed(generation) => generation,
            PublishOutcome::GenerationChanged => {
                return Err(IndexError::Storage(
                    "concurrent refresh did not stabilize".into(),
                ));
            }
        };
        self.reload_resolver(generation)?;
        Ok(RefreshReport {
            previous_generation: Some(previous),
            generation,
            added: 0,
            changed: count,
            deleted: deleted.len() as u64,
            unchanged: 0,
            reparsed: count,
            verified: verify,
        })
    }

    fn read_and_parse_all(&self, inventory: &InventorySnapshot) -> Result<ParsedBatch, IndexError> {
        let mut notes = Vec::with_capacity(inventory.entries.len());
        let mut diagnostics = inventory.diagnostics.clone();
        for (path, fingerprint) in &inventory.entries {
            match self.source.read_bytes(path) {
                Ok(bytes) => match SourceDocument::from_utf8(path.clone(), bytes) {
                    Ok(source) => notes.push((parse_note(source), *fingerprint)),
                    Err(SourceError::InvalidUtf8 { path, error }) => diagnostics.push(
                        Diagnostic::new(
                            DiagnosticCode::InvalidUtf8,
                            Severity::Error,
                            error.to_string(),
                        )
                        .with_path(path),
                    ),
                },
                Err(ScanError::UnreadableFile { path, message }) => diagnostics.push(
                    Diagnostic::new(DiagnosticCode::UnreadableFile, Severity::Error, message)
                        .with_path(path),
                ),
                Err(ScanError::InaccessibleRoot { message }) => {
                    return Err(IndexError::InvalidVaultRoot(message));
                }
            }
        }
        Ok((notes, diagnostics))
    }

    pub(crate) fn reload_resolver(&mut self, generation: Generation) -> Result<(), IndexError> {
        if self
            .resolver
            .as_ref()
            .is_none_or(|(cached, _)| *cached != generation)
        {
            let catalog = self.store.load_resolution_catalog()?;
            self.resolver = Some((generation, Resolver::from_catalog(catalog)));
        }
        Ok(())
    }

    #[doc(hidden)]
    pub fn snapshot_for_test(&self) -> Result<ScanReport, IndexError> {
        self.store.load_graph_for_test()
    }
}
