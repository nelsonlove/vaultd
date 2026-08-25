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

pub struct FixtureService {
    pub service: vault_index::IndexService,
    pub scan: ScanReport,
    digests_before: std::collections::BTreeMap<String, blake3::Hash>,
    _index_dir: TempDir,
}

pub fn open_fixture_service() -> FixtureService {
    let index_dir = TempDir::new().expect("index tempdir");
    let config = IndexConfig::explicit(
        fixture_vault_root(),
        index_dir.path().join("fixture-index.sqlite3"),
    )
    .expect("fixture config");
    let service = vault_index::IndexService::open(config).expect("open fixture service");
    let source = FileSystemVaultSource::new(fixture_vault_root()).expect("fixture source");
    let scan = scan_vault(&source).expect("scan fixture vault");
    FixtureService {
        service,
        scan,
        digests_before: digest_tree(&fixture_vault_root()),
        _index_dir: index_dir,
    }
}

fn digest_tree(root: &std::path::Path) -> std::collections::BTreeMap<String, blake3::Hash> {
    fn visit(
        root: &std::path::Path,
        directory: &std::path::Path,
        digests: &mut std::collections::BTreeMap<String, blake3::Hash>,
    ) {
        for entry in std::fs::read_dir(directory).expect("read fixture directory") {
            let entry = entry.expect("fixture directory entry");
            let path = entry.path();
            if path.is_dir() {
                visit(root, &path, digests);
            } else if path.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .expect("inside fixture root")
                    .to_string_lossy()
                    .replace('\\', "/");
                let bytes = std::fs::read(&path).expect("read fixture file");
                digests.insert(relative, blake3::hash(&bytes));
            }
        }
    }
    let mut digests = std::collections::BTreeMap::new();
    visit(root, root, &mut digests);
    digests
}

pub fn assert_semantically_equivalent(indexed: &ScanReport, scan: &ScanReport) {
    assert_eq!(indexed.diagnostics, scan.diagnostics);
    assert_eq!(indexed.graph.note_paths(), scan.graph.note_paths());
    for path in scan.graph.note_paths() {
        assert_eq!(indexed.graph.note(path), scan.graph.note(path));
        assert_eq!(indexed.graph.outgoing(path), scan.graph.outgoing(path));
        assert_eq!(indexed.graph.backlinks(path), scan.graph.backlinks(path));
    }
    assert_eq!(indexed.graph.unresolved(), scan.graph.unresolved());
    assert_eq!(indexed.graph.ambiguous(), scan.graph.ambiguous());
}

pub fn assert_vault_digest_unchanged(fixture: &FixtureService) {
    assert_eq!(digest_tree(&fixture_vault_root()), fixture.digests_before);
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
