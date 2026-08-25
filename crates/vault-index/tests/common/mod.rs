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

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use vault_index::{FileSystemIndexSource, IndexService, InventorySnapshot, ReconcileSource};

struct CountingSource {
    inner: FileSystemIndexSource,
    body_reads: Arc<AtomicU64>,
}

impl ReconcileSource for CountingSource {
    fn canonical_root(&self) -> &std::path::Path {
        self.inner.canonical_root()
    }

    fn inventory(&self) -> Result<InventorySnapshot, vault_index::IndexError> {
        self.inner.inventory()
    }

    fn read_bytes(&self, path: &vault_core::VaultPath) -> Result<Vec<u8>, vault_core::ScanError> {
        self.body_reads.fetch_add(1, Ordering::SeqCst);
        self.inner.read_bytes(path)
    }
}

pub struct CountingService {
    pub service: IndexService,
    pub vault: TempDir,
    body_reads: Arc<AtomicU64>,
    _index_dir: TempDir,
}

impl CountingService {
    pub fn reset_counts(&self) {
        self.body_reads.store(0, Ordering::SeqCst);
    }

    pub fn body_reads(&self) -> u64 {
        self.body_reads.load(Ordering::SeqCst)
    }

    pub fn write_note(&self, name: &str, body: &str) {
        std::fs::write(self.vault.path().join(name), body).expect("write note");
    }

    pub fn delete_note(&self, name: &str) {
        std::fs::remove_file(self.vault.path().join(name)).expect("delete note");
    }

    /// Bump only the modification time, leaving content identical.
    pub fn touch_note(&self, name: &str) {
        let path = self.vault.path().join(name);
        let metadata = std::fs::metadata(&path).expect("note metadata");
        let modified = filetime::FileTime::from_last_modification_time(&metadata);
        let bumped =
            filetime::FileTime::from_unix_time(modified.unix_seconds() + 5, modified.nanoseconds());
        filetime::set_file_mtime(&path, bumped).expect("bump mtime");
    }

    /// Replace content with a same-length body and restore the original
    /// modification time, making the edit invisible to fingerprints.
    pub fn write_note_preserving_fingerprint(&self, name: &str, body: &str) {
        let path = self.vault.path().join(name);
        let metadata = std::fs::metadata(&path).expect("note metadata");
        assert_eq!(
            metadata.len(),
            body.len() as u64,
            "fingerprint-preserving edits must keep the size"
        );
        let modified = filetime::FileTime::from_last_modification_time(&metadata);
        std::fs::write(&path, body).expect("rewrite note");
        filetime::set_file_mtime(&path, modified).expect("restore mtime");
    }
}

pub fn counting_service_with_two_notes() -> CountingService {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One WITH BODY\n").expect("write One");
    std::fs::write(vault.path().join("Two.md"), "# Two\n[[One]]\n").expect("write Two");
    let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
        .expect("counting config");
    let body_reads = Arc::new(AtomicU64::new(0));
    let source = CountingSource {
        inner: FileSystemIndexSource::new(vault.path()).expect("counting inner source"),
        body_reads: Arc::clone(&body_reads),
    };
    let service =
        IndexService::open_with_source(config, Box::new(source)).expect("counting service");
    CountingService {
        service,
        vault,
        body_reads,
        _index_dir: index_dir,
    }
}

struct PhantomOnSecondInventorySource {
    inner: FileSystemIndexSource,
    armed: Arc<AtomicBool>,
    calls_since_armed: AtomicU64,
}

impl ReconcileSource for PhantomOnSecondInventorySource {
    fn canonical_root(&self) -> &std::path::Path {
        self.inner.canonical_root()
    }

    fn inventory(&self) -> Result<InventorySnapshot, vault_index::IndexError> {
        let mut snapshot = self.inner.inventory()?;
        if self.armed.load(Ordering::SeqCst) {
            let call = self.calls_since_armed.fetch_add(1, Ordering::SeqCst);
            if call % 2 == 0 {
                snapshot.entries.insert(
                    vault_core::VaultPath::new("Phantom.md").expect("phantom path"),
                    vault_index::FileFingerprint {
                        size: 1,
                        modified_seconds: 1,
                        modified_nanos: 0,
                    },
                );
            }
        }
        Ok(snapshot)
    }

    fn read_bytes(&self, path: &vault_core::VaultPath) -> Result<Vec<u8>, vault_core::ScanError> {
        self.inner.read_bytes(path)
    }
}

pub struct ChangingService {
    pub service: IndexService,
    armed: Arc<AtomicBool>,
    _vault: TempDir,
    _index_dir: TempDir,
}

impl ChangingService {
    pub fn arm_change(&self) {
        self.armed.store(true, Ordering::SeqCst);
    }
}

pub fn source_that_changes_on_second_inventory() -> ChangingService {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("Base.md"), "# Base\n[[Other]]\n").expect("write Base");
    let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
        .expect("changing config");
    let armed = Arc::new(AtomicBool::new(false));
    let source = PhantomOnSecondInventorySource {
        inner: FileSystemIndexSource::new(vault.path()).expect("changing inner source"),
        armed: Arc::clone(&armed),
        calls_since_armed: AtomicU64::new(0),
    };
    let service =
        IndexService::open_with_source(config, Box::new(source)).expect("changing service");
    ChangingService {
        service,
        armed,
        _vault: vault,
        _index_dir: index_dir,
    }
}

struct FailingInventorySource {
    inner: FileSystemIndexSource,
    calls: AtomicU64,
    fail_from_call: u64,
}

impl ReconcileSource for FailingInventorySource {
    fn canonical_root(&self) -> &std::path::Path {
        self.inner.canonical_root()
    }

    fn inventory(&self) -> Result<InventorySnapshot, vault_index::IndexError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call >= self.fail_from_call {
            return Err(vault_index::IndexError::Storage(
                "injected refresh failure".into(),
            ));
        }
        self.inner.inventory()
    }

    fn read_bytes(&self, path: &vault_core::VaultPath) -> Result<Vec<u8>, vault_core::ScanError> {
        self.inner.read_bytes(path)
    }
}

pub struct FailingService {
    pub service: IndexService,
    _vault: TempDir,
    _index_dir: TempDir,
}

pub fn service_with_injected_refresh_failure() -> FailingService {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("Base.md"), "# Base\n").expect("write Base");
    let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
        .expect("failing config");
    let source = FailingInventorySource {
        inner: FileSystemIndexSource::new(vault.path()).expect("failing inner source"),
        calls: AtomicU64::new(0),
        fail_from_call: 3,
    };
    let service =
        IndexService::open_with_source(config, Box::new(source)).expect("failing service");
    FailingService {
        service,
        _vault: vault,
        _index_dir: index_dir,
    }
}

struct RaceOnInventorySource {
    inner: FileSystemIndexSource,
    hook: std::cell::RefCell<Option<Box<dyn FnMut()>>>,
}

impl ReconcileSource for RaceOnInventorySource {
    fn canonical_root(&self) -> &std::path::Path {
        self.inner.canonical_root()
    }

    fn inventory(&self) -> Result<InventorySnapshot, vault_index::IndexError> {
        if let Some(mut hook) = self.hook.borrow_mut().take() {
            hook();
        }
        self.inner.inventory()
    }

    fn read_bytes(&self, path: &vault_core::VaultPath) -> Result<Vec<u8>, vault_core::ScanError> {
        self.inner.read_bytes(path)
    }
}

pub struct RacingService {
    pub service: IndexService,
    _vault: TempDir,
    _index_dir: TempDir,
}

/// A service whose next refresh loses one compare-and-swap round: during its
/// first inventory a second service publishes a new generation, and a further
/// vault change forces the retried refresh to publish again.
pub fn racing_services() -> RacingService {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("Base.md"), "# Base\n").expect("write Base");
    let index_path = index_dir.path().join("index.sqlite3");

    {
        let config = IndexConfig::explicit(vault.path(), &index_path).expect("initial config");
        let mut initial = IndexService::open(config).expect("initial service");
        initial.refresh(false).expect("initial cold build");
    }

    let vault_path = vault.path().to_path_buf();
    let other_index_path = index_path.clone();
    let hook = Box::new(move || {
        std::fs::write(vault_path.join("Racer.md"), "# Racer\n").expect("write Racer");
        let config = IndexConfig::explicit(&vault_path, &other_index_path).expect("racer config");
        let mut other = IndexService::open(config).expect("racer service");
        other.refresh(false).expect("racer refresh");
        std::fs::write(vault_path.join("Racer2.md"), "# Racer two\n").expect("write Racer2");
    });

    let config = IndexConfig::explicit(vault.path(), &index_path).expect("racing config");
    let source = RaceOnInventorySource {
        inner: FileSystemIndexSource::new(vault.path()).expect("racing inner source"),
        hook: std::cell::RefCell::new(Some(hook)),
    };
    let service = IndexService::open_with_source(config, Box::new(source)).expect("racing service");
    RacingService {
        service,
        _vault: vault,
        _index_dir: index_dir,
    }
}
