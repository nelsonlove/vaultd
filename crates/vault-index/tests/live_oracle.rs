//! The randomized live-equivalence oracle.
//!
//! One claim, checked after every committed batch, against a clean
//! `scan_vault` of the same vault:
//!
//! 1. **State equivalence** — everything the production query API answers
//!    equals what a fresh scan would answer. Under-selection (a reference
//!    whose answer moved and was never re-resolved) has nowhere to hide.
//! 2. **Resolution equivalence** — every live `resolve_link` answer equals a
//!    `Resolver` built from the clean scan, for exact paths, relative paths,
//!    duplicate stems, heading and block subpaths, and destinations that
//!    resolve to nothing.
//! 3. **Generation exactness** — the generation advances by exactly one when
//!    client-visible state changed, and by exactly zero when it did not. Not
//!    "at least": a metadata-only touch that manufactures a generation is as
//!    much a bug as a content change that fails to.
//! 4. **Vault integrity** — the vault's own bytes change only by the
//!    operation the test performed. The index never writes into the vault.
//!
//! The operation alphabet deliberately includes the changes that are
//! invisible to the cheap signals: `Touch` moves metadata without content,
//! and `PreserveFingerprintWrite` moves content without metadata.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use proptest::prelude::*;
use proptest::strategy::ValueTree;
use tempfile::TempDir;
use vault_core::{FileSystemVaultSource, LinkTarget, ScanReport, VaultPath, scan_vault};
use vault_index::{ChangeCause, IndexConfig, IndexService};

/// Two spellings per stem plus a deeper nesting level, so relative links,
/// duplicate stems, and ambiguity transitions are all reachable from one
/// small slot set.
const SLOTS: &[&str] = &[
    "Alpha.md",
    "Beta.md",
    "Gamma.md",
    "Nested/Alpha.md",
    "Nested/Beta.md",
    "Nested/Deep/Gamma.md",
];

/// Destinations spanning every lookup route the resolver knows: exact path,
/// implicit extension, filename, stem, relative, same-note subpath, heading
/// subpath, block subpath, and one that can never match.
const DESTINATIONS: &[&str] = &[
    "Alpha",
    "Beta",
    "Gamma",
    "Alpha.md",
    "Nested/Alpha",
    "Nested/Deep/Gamma.md",
    "./Beta",
    "../Gamma",
    "Alpha#Heading",
    "Alpha#^block",
    "#Heading",
    "Nowhere",
];

#[derive(Clone, Debug)]
enum Operation {
    Write { path: String, body: String },
    Delete { path: String },
    Rename { from: String, to: String },
    Touch { path: String },
    PreserveFingerprintWrite { path: String, body: String },
    MakeInvalidUtf8 { path: String },
    RestoreUtf8 { path: String, body: String },
}

// ---------------------------------------------------------------------------
// Applying operations
// ---------------------------------------------------------------------------

fn write_file(root: &Path, name: &str, body: &str) {
    let path = root.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent directory");
    }
    std::fs::write(path, body).expect("write note");
}

fn remove_file(root: &Path, name: &str) {
    match std::fs::remove_file(root.join(name)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("remove {name}: {error}"),
    }
}

fn bump_mtime(root: &Path, name: &str) {
    let path = root.join(name);
    let Ok(metadata) = std::fs::metadata(&path) else {
        return;
    };
    let modified = filetime::FileTime::from_last_modification_time(&metadata);
    let bumped =
        filetime::FileTime::from_unix_time(modified.unix_seconds() + 5, modified.nanoseconds());
    filetime::set_file_mtime(&path, bumped).expect("bump mtime");
}

/// Replace a file's content while leaving its size and modification time
/// exactly as they were, so neither half of the fingerprint moves. The body
/// is padded with newlines or truncated to the existing length; every
/// generated body is ASCII, so truncation always lands on a char boundary.
fn write_preserving_fingerprint(root: &Path, name: &str, body: &str) {
    let path = root.join(name);
    let Ok(metadata) = std::fs::metadata(&path) else {
        return;
    };
    let size = metadata.len() as usize;
    let modified = filetime::FileTime::from_last_modification_time(&metadata);
    let mut padded = body.to_string();
    if padded.len() > size {
        padded.truncate(size);
    } else {
        while padded.len() < size {
            padded.push('\n');
        }
    }
    if padded.as_bytes() == std::fs::read(&path).expect("read note").as_slice() {
        // Nothing to do, and writing anyway would still be a no-op.
        return;
    }
    std::fs::write(&path, padded).expect("rewrite note");
    filetime::set_file_mtime(&path, modified).expect("restore mtime");
}

/// Apply one operation and report every path whose state a perfect watcher
/// would have hinted.
fn apply(root: &Path, operation: &Operation) -> BTreeSet<VaultPath> {
    fn touch(name: &str, touched: &mut BTreeSet<VaultPath>) {
        touched.insert(VaultPath::new(name).expect("valid vault path"));
    }
    let mut touched = BTreeSet::new();
    match operation {
        Operation::Write { path, body } => {
            write_file(root, path, body);
            touch(path, &mut touched);
        }
        Operation::Delete { path } => {
            remove_file(root, path);
            touch(path, &mut touched);
        }
        Operation::Rename { from, to } => {
            if from != to {
                if let Ok(bytes) = std::fs::read(root.join(from)) {
                    remove_file(root, from);
                    let destination = root.join(to);
                    if let Some(parent) = destination.parent() {
                        std::fs::create_dir_all(parent).expect("create parent directory");
                    }
                    std::fs::write(destination, bytes).expect("write renamed note");
                }
            }
            touch(from, &mut touched);
            touch(to, &mut touched);
        }
        Operation::Touch { path } => {
            bump_mtime(root, path);
            touch(path, &mut touched);
        }
        Operation::PreserveFingerprintWrite { path, body } => {
            write_preserving_fingerprint(root, path, body);
            touch(path, &mut touched);
        }
        Operation::MakeInvalidUtf8 { path } => {
            let target = root.join(path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("create parent directory");
            }
            std::fs::write(target, [0xffu8, 0xfe, 0x00, 0x80]).expect("write invalid bytes");
            touch(path, &mut touched);
        }
        Operation::RestoreUtf8 { path, body } => {
            write_file(root, path, body);
            touch(path, &mut touched);
        }
    }
    touched
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

struct Oracle {
    service: IndexService,
    root: PathBuf,
    /// The scan-derived truth as of the last verified batch, for the
    /// "advanced exactly once iff something changed" comparison.
    expected: common::SemanticSnapshot,
    generation: u64,
    _vault: TempDir,
    _index: TempDir,
}

impl Oracle {
    fn open() -> Self {
        let vault = TempDir::new().expect("vault tempdir");
        let index = TempDir::new().expect("index tempdir");
        let root = vault.path().to_path_buf();

        // A note that is never generated against, so every batch is checked
        // against stable incoming references as well as its own outgoing ones.
        write_file(
            &root,
            "Seed.md",
            "# Seed\n[[Alpha]]\n[[Beta#Heading]]\n[[Gamma#^block]]\n[[Nested/Alpha.md]]\n\
             [[Nowhere]]\n[site](https://example.com)\n",
        );
        write_file(&root, "Alpha.md", "# Heading\n\ntext ^block\n");
        write_file(&root, "Beta.md", "# Heading\n[[Alpha]]\n");

        let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3"))
            .expect("oracle config");
        let mut service = IndexService::open(config).expect("oracle service");
        service.refresh(false).expect("cold build");
        let generation = service
            .current_generation()
            .expect("generation")
            .expect("cold build published")
            .get();
        let expected = common::snapshot_from_scan(&scan(&root));

        Self {
            service,
            root,
            expected,
            generation,
            _vault: vault,
            _index: index,
        }
    }

    /// Apply one batch, reconcile exactly the paths it touched, and check
    /// every claim in this module's header.
    fn run_batch(&mut self, batch: &[Operation]) -> Result<(), TestCaseError> {
        let mut touched: BTreeSet<VaultPath> = BTreeSet::new();
        for operation in batch {
            touched.extend(apply(&self.root, operation));
        }
        let vault_after_operations = common::digest_tree(&self.root);

        let truth = scan(&self.root);
        let expected = common::snapshot_from_scan(&truth);
        let changed = expected != self.expected;

        let report = self
            .service
            .refresh_paths(touched, ChangeCause::Watcher)
            .map_err(|error| TestCaseError::fail(format!("targeted refresh failed: {error}")))?;

        // (3) Generation exactness, in both directions.
        let wanted = if changed {
            self.generation + 1
        } else {
            self.generation
        };
        prop_assert_eq!(
            report.generation.get(),
            wanted,
            "generation must advance exactly once iff client-visible state changed \
             (changed = {}) after {:?}",
            changed,
            batch
        );

        // (1) State equivalence through the production query API.
        prop_assert_eq!(
            &common::snapshot_from_index(&self.service),
            &expected,
            "indexed state diverged from a clean scan after {:?}",
            batch
        );

        // (2) Resolution equivalence, route by route.
        self.assert_resolution_matches(&truth, batch)?;

        // (4) The vault changed only by the operation itself.
        prop_assert_eq!(
            common::digest_tree(&self.root),
            vault_after_operations,
            "the index wrote into the vault while reconciling {:?}",
            batch
        );

        self.expected = expected;
        self.generation = report.generation.get();
        Ok(())
    }

    fn assert_resolution_matches(
        &self,
        truth: &ScanReport,
        batch: &[Operation],
    ) -> Result<(), TestCaseError> {
        let resolver = common::resolver_from_scan(truth);
        let mut sources: Vec<VaultPath> = SLOTS
            .iter()
            .map(|name| VaultPath::new(*name).expect("valid vault path"))
            .collect();
        sources.push(VaultPath::new("Seed.md").expect("valid vault path"));

        for source in &sources {
            for destination in DESTINATIONS {
                let (generation, live) =
                    self.service
                        .resolve_link(source, destination)
                        .map_err(|error| {
                            TestCaseError::fail(format!("resolve_link failed: {error}"))
                        })?;
                prop_assert_eq!(generation.get(), self.published_generation());
                prop_assert_eq!(
                    live,
                    resolver.resolve_target(source, &LinkTarget::parse(*destination)),
                    "live resolution of {:?} from {:?} diverged after {:?}",
                    destination,
                    source.as_str(),
                    batch
                );
            }
        }
        Ok(())
    }

    fn published_generation(&self) -> u64 {
        self.service
            .current_generation()
            .expect("generation")
            .expect("published")
            .get()
    }
}

fn scan(root: &Path) -> ScanReport {
    let source = FileSystemVaultSource::new(root).expect("scan source");
    scan_vault(&source).expect("scan vault")
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

fn slot() -> impl Strategy<Value = String> {
    (0usize..SLOTS.len()).prop_map(|index| SLOTS[index].to_string())
}

/// Bodies covering exact links, implicit extensions, relative links, heading
/// and block subpaths, same-note subpaths, unresolvable targets, non-vault
/// links, and a note with broken frontmatter.
fn body() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("# Heading\n\ntext ^block\n".to_string()),
        Just("plain text with no structure at all\n".to_string()),
        Just("# Heading\n[[#Heading]]\n[[#Missing]]\n".to_string()),
        Just("---\nbroken: [\n---\n[[Nowhere]]\n[site](https://example.com)\n".to_string()),
        (0usize..SLOTS.len()).prop_map(|index| format!("# Heading\n[[{}]]\n", stem(SLOTS[index]))),
        (0usize..SLOTS.len()).prop_map(|index| format!("[[{}]]\n^block\n", SLOTS[index])),
        (0usize..SLOTS.len()).prop_map(|index| format!("[[{}#Heading]]\n", stem(SLOTS[index]))),
        (0usize..SLOTS.len()).prop_map(|index| format!("[[{}#^block]]\n", stem(SLOTS[index]))),
        (0usize..SLOTS.len()).prop_map(|index| {
            let stem = stem(SLOTS[index]);
            format!("[[./{stem}]]\n[[../{stem}]]\n")
        }),
    ]
}

fn stem(slot: &str) -> &str {
    let name = slot.rsplit('/').next().expect("a file name");
    name.strip_suffix(".md").unwrap_or(name)
}

fn operation() -> impl Strategy<Value = Operation> {
    prop_oneof![
        6 => (slot(), body()).prop_map(|(path, body)| Operation::Write { path, body }),
        3 => slot().prop_map(|path| Operation::Delete { path }),
        2 => (slot(), slot()).prop_map(|(from, to)| Operation::Rename { from, to }),
        2 => slot().prop_map(|path| Operation::Touch { path }),
        2 => (slot(), body())
            .prop_map(|(path, body)| Operation::PreserveFingerprintWrite { path, body }),
        1 => slot().prop_map(|path| Operation::MakeInvalidUtf8 { path }),
        1 => (slot(), body()).prop_map(|(path, body)| Operation::RestoreUtf8 { path, body }),
    ]
}

/// Batches of one to three operations, so bursts — several changes landing
/// inside one debounce window — are exercised alongside single edits.
fn batch() -> impl Strategy<Value = Vec<Operation>> {
    prop::collection::vec(operation(), 1..=3)
}

// ---------------------------------------------------------------------------
// The persisted regression scenario
// ---------------------------------------------------------------------------

/// A fixed, checked-in sequence covering every operation in the alphabet and
/// every transition that has historically been able to break incremental
/// resolution: an unresolved reference becoming resolved, a resolved one
/// becoming ambiguous and back, a heading and a block id appearing and
/// disappearing, a rename delivered as one batch, a content change invisible
/// to the fingerprint, and a note leaving and rejoining the UTF-8 world.
///
/// Kept as an ordinary test rather than a proptest seed on purpose: a seed
/// only reproduces against the exact generator it was drawn from, so it stops
/// meaning anything the moment the strategies here are tuned. A scripted
/// scenario keeps its meaning.
#[test]
fn the_regression_scenario_stays_equivalent_to_a_fresh_scan() {
    let mut oracle = Oracle::open();
    let scenario: Vec<Vec<Operation>> = vec![
        // A brand-new note resolves a reference that was waiting for it.
        vec![Operation::Write {
            path: "Gamma.md".into(),
            body: "# Heading\n\ntext ^block\n".into(),
        }],
        // A second spelling of the same stem makes `[[Alpha]]` ambiguous.
        vec![Operation::Write {
            path: "Nested/Alpha.md".into(),
            body: "# Heading\n[[../Beta]]\n".into(),
        }],
        // ...and removing it resolves the reference again.
        vec![Operation::Delete {
            path: "Nested/Alpha.md".into(),
        }],
        // A heading disappears under a subpath reference.
        vec![Operation::Write {
            path: "Beta.md".into(),
            body: "no heading here\n[[Alpha]]\n".into(),
        }],
        // A metadata-only touch must move nothing at all.
        vec![Operation::Touch {
            path: "Alpha.md".into(),
        }],
        // Content that moves without the fingerprint moving.
        vec![Operation::PreserveFingerprintWrite {
            path: "Alpha.md".into(),
            body: "# Other\n\nplain ^mark\n".into(),
        }],
        // A rename arrives as one batch holding both spellings.
        vec![Operation::Rename {
            from: "Gamma.md".into(),
            to: "Nested/Deep/Gamma.md".into(),
        }],
        // A note stops being valid UTF-8, then comes back.
        vec![Operation::MakeInvalidUtf8 {
            path: "Beta.md".into(),
        }],
        vec![Operation::RestoreUtf8 {
            path: "Beta.md".into(),
            body: "# Heading\n[[Nested/Deep/Gamma.md]]\n".into(),
        }],
        // A burst: three changes inside one window.
        vec![
            Operation::Write {
                path: "Alpha.md".into(),
                body: "# Heading\n\ntext ^block\n".into(),
            },
            Operation::Delete {
                path: "Nested/Beta.md".into(),
            },
            Operation::Write {
                path: "Nested/Beta.md".into(),
                body: "[[./Alpha]]\n[[../Alpha]]\n".into(),
            },
        ],
    ];

    for batch in &scenario {
        oracle
            .run_batch(batch)
            .unwrap_or_else(|error| panic!("regression scenario failed: {error}"));
    }
}

/// The bounds every generated body respects, asserted rather than assumed:
/// truncating a non-ASCII body in `write_preserving_fingerprint` would panic
/// on a char boundary, and the failure would look like a resolution bug.
#[test]
fn every_generated_body_is_ascii() {
    let mut runner = proptest::test_runner::TestRunner::deterministic();
    let strategy = body();
    for _ in 0..256 {
        let value = strategy
            .new_tree(&mut runner)
            .expect("generate a body")
            .current();
        assert!(value.is_ascii(), "generated a non-ASCII body: {value:?}");
    }
}

// ---------------------------------------------------------------------------
// The randomized oracle
// ---------------------------------------------------------------------------

proptest! {
    // The default is what every `cargo test` run pays for; `PROPTEST_CASES`
    // raises it for a deeper sweep (256 cases runs in a few seconds).
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn incremental_reconciliation_matches_a_fresh_scan_after_every_batch(
        batches in prop::collection::vec(batch(), 1..=8)
    ) {
        let mut oracle = Oracle::open();
        for batch in &batches {
            oracle.run_batch(batch)?;
        }
    }
}

/// Slot bookkeeping the oracle relies on: every generated destination has to
/// be reachable from the slot set, or the resolution comparison silently
/// degenerates into "both sides answer unresolved".
#[test]
fn the_destination_set_reaches_the_slot_set() {
    let root = TempDir::new().expect("vault tempdir");
    for name in SLOTS {
        write_file(root.path(), name, "# Heading\n\ntext ^block\n");
    }
    let truth = scan(root.path());
    let resolver = common::resolver_from_scan(&truth);
    // Both a root-level and a nested source, because the two relative routes
    // are reachable from opposite ends: `./Beta` needs a root-level source,
    // `../Gamma` a nested one.
    let sources = [
        VaultPath::new("Alpha.md").expect("valid vault path"),
        VaultPath::new("Nested/Beta.md").expect("valid vault path"),
    ];

    let mut resolved: BTreeMap<&str, bool> = BTreeMap::new();
    for destination in DESTINATIONS {
        let hit = sources.iter().any(|source| {
            !matches!(
                resolver.resolve_target(source, &LinkTarget::parse(*destination)),
                vault_core::Resolution::Unresolved
            )
        });
        resolved.insert(destination, hit);
    }
    assert_eq!(
        resolved.get("Nowhere"),
        Some(&false),
        "`Nowhere` must stay unresolvable, or the negative case is not covered"
    );
    let reachable = resolved.values().filter(|hit| **hit).count();
    assert!(
        reachable >= DESTINATIONS.len() - 1,
        "every destination but `Nowhere` must reach a slot: {resolved:?}"
    );
}
