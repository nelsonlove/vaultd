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
            .replace_graph_rows_for_test(&self.scan.graph, &scan_only)
    }
}

pub struct FixtureService {
    pub service: vault_index::IndexService,
    pub scan: ScanReport,
    pub config: IndexConfig,
    digests_before: std::collections::BTreeMap<String, blake3::Hash>,
    vault_root: PathBuf,
    _vault_dir: Option<TempDir>,
    _index_dir: TempDir,
}

pub fn open_fixture_service() -> FixtureService {
    let index_dir = TempDir::new().expect("index tempdir");
    let config = IndexConfig::explicit(
        fixture_vault_root(),
        index_dir.path().join("fixture-index.sqlite3"),
    )
    .expect("fixture config");
    let service = vault_index::IndexService::open(config.clone()).expect("open fixture service");
    let source = FileSystemVaultSource::new(fixture_vault_root()).expect("fixture source");
    let scan = scan_vault(&source).expect("scan fixture vault");
    FixtureService {
        service,
        scan,
        config,
        digests_before: digest_tree(&fixture_vault_root()),
        vault_root: fixture_vault_root(),
        _vault_dir: None,
        _index_dir: index_dir,
    }
}

/// A small, privately-owned vault (never the shared checked-in fixture) for
/// proving delta publication: `Changed.md` starts with no outgoing
/// references, `Target.md` is its eventual link target, and
/// `Stable.md -> Other.md` is an unrelated reference whose storage identity
/// a delta touching only `Changed.md` must never disturb.
pub fn delta_publication_fixture() -> FixtureService {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("Changed.md"), "# Changed\n").expect("write Changed");
    std::fs::write(vault.path().join("Target.md"), "# Target\n").expect("write Target");
    std::fs::write(vault.path().join("Stable.md"), "[[Other]]\n").expect("write Stable");
    std::fs::write(vault.path().join("Other.md"), "# Other\n").expect("write Other");

    let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
        .expect("delta fixture config");
    let service = vault_index::IndexService::open(config.clone()).expect("delta fixture service");
    let source = FileSystemVaultSource::new(vault.path()).expect("delta fixture source");
    let scan = scan_vault(&source).expect("scan delta fixture vault");
    let vault_root = vault.path().to_path_buf();
    FixtureService {
        service,
        scan,
        config,
        digests_before: digest_tree(&vault_root),
        vault_root,
        _vault_dir: Some(vault),
        _index_dir: index_dir,
    }
}

impl FixtureService {
    /// The `note_references.id` for `path`'s `ordinal`-th outgoing reference,
    /// plus a concatenated snapshot of that reference's stored resolution
    /// columns (kind, target, subpath). Used to prove an unrelated
    /// reference's storage identity survives a delta publication untouched.
    pub fn reference_storage_identity(&self, path: &str, ordinal: u32) -> (i64, String) {
        let connection = self.service.connection_for_test();
        let reference_id: i64 = connection
            .query_row(
                "SELECT id FROM note_references WHERE note_path = ?1 AND ordinal = ?2",
                rusqlite::params![path, ordinal],
                |row| row.get(0),
            )
            .expect("reference id");
        let values: String = connection
            .query_row(
                "SELECT kind || '|' || COALESCE(target_path, '') || '|' || \
                        COALESCE(subpath_kind, '') || '|' || COALESCE(subpath_value, '') \
                 FROM resolutions WHERE reference_id = ?1",
                rusqlite::params![reference_id],
                |row| row.get(0),
            )
            .expect("resolution values");
        (reference_id, values)
    }

    /// A second `IndexStore` opened against the same on-disk cache file as
    /// `self.service`'s own store (safe under WAL, mirroring the existing
    /// `racing_services` pattern of two services sharing one file): the
    /// fixture's `service` field keeps `IndexStore` crate-private, so tests
    /// reach `IndexStore::publish_delta` this way instead.
    pub fn open_delta_store(&self) -> vault_index::IndexStore {
        vault_index::IndexStore::open_for_test(&self.config).expect("reopen store for delta")
    }

    /// Write `body` to `path`, resolve its outgoing references against the
    /// fixture's current resolution catalog, and publish the result as one
    /// delta — the "targeted read/plan/resolve" steps a real incremental
    /// caller performs, done by hand here since this task only builds the
    /// write path itself (wiring it into `IndexService::refresh` is a later
    /// task).
    pub fn publish_changed_note(
        &mut self,
        path: &str,
        body: &str,
    ) -> vault_index::DeltaPublishOutcome {
        std::fs::write(self.vault_root.join(path), body).expect("write changed note");
        let source = FileSystemVaultSource::new(&self.vault_root).expect("rescan source");
        let scan = scan_vault(&source).expect("rescan vault");
        let vault_path = vault_core::VaultPath::new(path).expect("vault path");
        let note = scan
            .graph
            .note(&vault_path)
            .expect("changed note present in rescan")
            .clone();
        let fingerprint = vault_index::FileFingerprint {
            size: note.source.text().len() as u64,
            modified_seconds: 1,
            modified_nanos: 0,
        };
        let resolutions: Vec<vault_index::ResolutionReplacement> = scan
            .graph
            .outgoing(&vault_path)
            .iter()
            .enumerate()
            .map(|(ordinal, resolved)| {
                let target = vault_core::LinkTarget::from(&resolved.reference);
                vault_index::ResolutionReplacement {
                    source_path: vault_path.clone(),
                    ordinal: ordinal as u32,
                    resolution: resolved.resolution.clone(),
                    dependencies: vault_core::reference_dependencies(
                        &vault_path,
                        &target,
                        &resolved.resolution,
                    ),
                    diagnostic: vault_core::resolution_diagnostic(resolved),
                }
            })
            .collect();
        let expected = self
            .service
            .current_generation()
            .expect("current generation")
            .expect("delta publication requires a prior generation");
        let notes = vec![vault_index::NoteReplacement { note, fingerprint }];
        let mut store = self.open_delta_store();
        let outcome = store
            .publish_delta(vault_index::DeltaPublication {
                expected,
                notes: &notes,
                deleted: &[],
                fingerprint_updates: &[],
                resolutions: &resolutions,
                scan_diagnostics: None,
            })
            .expect("publish delta");
        drop(store);
        // The delta was published through a store handle the fixture's
        // service does not own, so the service's published state is a
        // generation behind — exactly the case `resync_published` exists
        // for. Without it the service's readers would (correctly) refuse to
        // answer from rows whose live state they never installed.
        self.service
            .resync_published()
            .expect("resync after an out-of-band delta");
        self.scan = scan;
        outcome
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

    fn fingerprint(
        &self,
        path: &vault_core::VaultPath,
    ) -> Result<Option<vault_index::FileFingerprint>, vault_index::IndexError> {
        self.inner.fingerprint(path)
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

    fn fingerprint(
        &self,
        path: &vault_core::VaultPath,
    ) -> Result<Option<vault_index::FileFingerprint>, vault_index::IndexError> {
        self.inner.fingerprint(path)
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

    fn fingerprint(
        &self,
        path: &vault_core::VaultPath,
    ) -> Result<Option<vault_index::FileFingerprint>, vault_index::IndexError> {
        self.inner.fingerprint(path)
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
    hook: std::cell::RefCell<Option<Box<dyn FnMut() + Send>>>,
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

    fn fingerprint(
        &self,
        path: &vault_core::VaultPath,
    ) -> Result<Option<vault_index::FileFingerprint>, vault_index::IndexError> {
        self.inner.fingerprint(path)
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
        // A second writer against the very cache `service` below already
        // holds the lease for — deliberately: this proves the
        // compare-and-swap in `publish` (not the lease) is what keeps a
        // lost race safe. `open_unleased_for_cas_test` is exactly the
        // escape hatch for that, and only for that.
        let mut other = IndexService::open_unleased_for_cas_test(config).expect("racer service");
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

pub struct ManyNotesService {
    pub service: IndexService,
    vault: TempDir,
    _index_dir: TempDir,
}

impl ManyNotesService {
    pub fn add_note(&self, name: &str, body: &str) {
        std::fs::write(self.vault.path().join(name), body).expect("write note");
    }
}

pub fn service_with_many_notes(count: usize) -> ManyNotesService {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    for index in 0..count {
        std::fs::write(
            vault.path().join(format!("Note-{index}.md")),
            format!("# Note {index}\n"),
        )
        .expect("write note");
    }
    let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
        .expect("many-notes config");
    let service = IndexService::open(config).expect("many-notes service");
    ManyNotesService {
        service,
        vault,
        _index_dir: index_dir,
    }
}

pub struct QueriesFixture {
    pub service: IndexService,
    pub config: IndexConfig,
    _vault: TempDir,
    _index_dir: TempDir,
}

/// A small vault exercising every resolution state: resolved, unresolved,
/// ambiguous, missing subpath, and a non-vault reference; the target note
/// carries a `title` property while the source only has a heading.
pub fn queries_fixture() -> QueriesFixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    std::fs::write(
        vault.path().join("Source.md"),
        "# Source\n\n[[Target]] [[Missing]] [[Foo]] [[Target#Absent]]\n\n[site](https://example.com)\n",
    )
    .expect("write Source");
    std::fs::write(
        vault.path().join("Target.md"),
        "---\ntitle: The Target\n---\n# Target\n",
    )
    .expect("write Target");
    std::fs::create_dir_all(vault.path().join("Ambiguous")).expect("create Ambiguous");
    std::fs::create_dir_all(vault.path().join("Other")).expect("create Other");
    std::fs::write(vault.path().join("Ambiguous/Foo.md"), "one\n").expect("write Foo one");
    std::fs::write(vault.path().join("Other/Foo.md"), "two\n").expect("write Foo two");

    let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
        .expect("queries config");
    let service = IndexService::open(config.clone()).expect("queries service");
    QueriesFixture {
        service,
        config,
        _vault: vault,
        _index_dir: index_dir,
    }
}

pub struct LiveGraphFixture {
    pub service: vault_index::IndexService,
    vault: TempDir,
    _index_dir: TempDir,
}

impl LiveGraphFixture {
    pub fn write_note(&self, name: &str, body: &str) {
        std::fs::write(self.vault.path().join(name), body).expect("write note");
    }

    pub fn delete_note(&self, name: &str) {
        std::fs::remove_file(self.vault.path().join(name)).expect("delete note");
    }
}

/// A small vault exercising the live-graph impact matrix: `Sub.md` carries a
/// heading and a block that other notes reference by subpath and by plain
/// file link; `Hub.md` reaches `Sub.md` both ways plus an unresolved `[[Foo]]`
/// and a resolved `[[Other]]`; `Peer.md` also links `Sub.md` (to prove
/// source-scoped invalidation does not leak across notes); `Unrelated.md`
/// stands alone.
pub fn live_graph_fixture() -> LiveGraphFixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index_dir = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("Sub.md"), "# Heading\n^block\n").expect("write Sub");
    std::fs::write(
        vault.path().join("Hub.md"),
        "[[Sub]]\n[[Sub#Heading]]\n[[Foo]]\n[[Other]]\n",
    )
    .expect("write Hub");
    std::fs::write(vault.path().join("Other.md"), "# Other\n").expect("write Other");
    std::fs::write(vault.path().join("Peer.md"), "[[Sub]]\n").expect("write Peer");
    std::fs::write(vault.path().join("Unrelated.md"), "# Unrelated\n").expect("write Unrelated");

    let config = IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
        .expect("live graph config");
    let service = vault_index::IndexService::open(config).expect("live graph service");
    LiveGraphFixture {
        service,
        vault,
        _index_dir: index_dir,
    }
}

#[derive(Debug, PartialEq)]
pub struct SemanticSnapshot {
    pub notes: Vec<vault_core::ParsedNote>,
    pub outgoing: Vec<(vault_core::VaultPath, Vec<vault_core::ResolvedReference>)>,
    pub backlinks: Vec<(vault_core::VaultPath, Vec<vault_core::ResolvedReference>)>,
    pub unresolved: Vec<vault_core::ResolvedReference>,
    pub ambiguous: Vec<vault_core::ResolvedReference>,
    pub diagnostics: Vec<vault_core::Diagnostic>,
}

pub fn snapshot_from_scan(report: &vault_core::ScanReport) -> SemanticSnapshot {
    let graph = &report.graph;
    SemanticSnapshot {
        notes: graph.notes().cloned().collect(),
        outgoing: graph
            .note_paths()
            .into_iter()
            .map(|path| (path.clone(), graph.outgoing(path).to_vec()))
            .collect(),
        backlinks: graph
            .note_paths()
            .into_iter()
            .map(|path| (path.clone(), graph.backlinks(path).to_vec()))
            .collect(),
        unresolved: graph.unresolved().to_vec(),
        ambiguous: graph.ambiguous().to_vec(),
        diagnostics: report.diagnostics.clone(),
    }
}

/// Extract the same shape through the PRODUCTION public query API only:
/// pagination, exact-path note loads, backlinks, status-filtered reference
/// listings, and unfiltered diagnostics. Never scans the vault.
pub fn snapshot_from_index(service: &vault_index::IndexService) -> SemanticSnapshot {
    let mut paths = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = service
            .list_notes(cursor.as_deref(), Some(3))
            .expect("list notes page");
        paths.extend(page.items.iter().map(|item| item.path.clone()));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    let mut notes = Vec::new();
    let mut outgoing = Vec::new();
    let mut backlinks = Vec::new();
    for path in &paths {
        let indexed = service.get_note(path).expect("indexed note");
        notes.push(indexed.note);
        outgoing.push((path.clone(), indexed.outgoing));

        let mut incoming = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = service
                .get_backlinks(path, cursor.as_deref(), Some(3))
                .expect("backlinks page");
            incoming.extend(page.items);
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        backlinks.push((path.clone(), incoming));
    }

    let collect_status = |status: vault_index::ReferenceStatus| {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = service
                .list_references(None, Some(status), cursor.as_deref(), Some(3))
                .expect("references page");
            items.extend(page.items);
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        items
    };
    let unresolved = collect_status(vault_index::ReferenceStatus::Unresolved);
    let ambiguous = collect_status(vault_index::ReferenceStatus::Ambiguous);

    let mut diagnostics = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = service
            .get_diagnostics(None, None, cursor.as_deref(), Some(3))
            .expect("diagnostics page");
        diagnostics.extend(page.items);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    SemanticSnapshot {
        notes,
        outgoing,
        backlinks,
        unresolved,
        ambiguous,
        diagnostics,
    }
}
