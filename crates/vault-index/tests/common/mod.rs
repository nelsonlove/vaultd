#![allow(dead_code)]

use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::{FileSystemVaultSource, ScanReport, scan_vault};
use vault_index::{FileFingerprint, IndexConfig, IndexStore};

pub fn fixture_vault_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/semantic-read-path/basic-vault")
}

pub struct FixtureStore {
    pub store: IndexStore,
    pub scan: ScanReport,
    _index_dir: TempDir,
}

impl FixtureStore {
    pub fn persist_complete_fixture(&mut self) -> Result<(), vault_index::IndexError> {
        let paths: Vec<_> = self.scan.graph.note_paths().into_iter().cloned().collect();
        for path in paths {
            let note = self
                .scan
                .graph
                .note(&path)
                .expect("fixture note is present")
                .clone();
            let fingerprint = FileFingerprint {
                size: note.source.text().len() as u64,
                modified_seconds: 1,
                modified_nanos: 0,
            };
            self.store.write_note_for_test(&note, fingerprint)?;
        }
        let scan_only: Vec<_> = Vec::new();
        self.store
            .replace_graph_rows_for_test(&self.scan.graph, &scan_only, &self.scan.diagnostics)
    }
}

pub fn open_fixture_store() -> FixtureStore {
    let index_dir = TempDir::new().expect("index tempdir");
    let config = IndexConfig::explicit(
        fixture_vault_root(),
        index_dir.path().join("fixture-index.sqlite3"),
    )
    .expect("fixture config");
    let store = IndexStore::open_for_test(&config).expect("open fixture store");
    let source = FileSystemVaultSource::new(fixture_vault_root()).expect("fixture source");
    let scan = scan_vault(&source).expect("scan fixture vault");
    FixtureStore {
        store,
        scan,
        _index_dir: index_dir,
    }
}
