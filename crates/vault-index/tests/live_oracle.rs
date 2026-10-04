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
//!    much a bug as a content change that fails to. *Client-visible state* is
//!    both axes the cache indexes: the semantic snapshot **and** the file
//!    tree — a batch that leaves the notes exactly as they were but leaves a
//!    new folder behind did change what a client can see, and must publish.
//! 4. **Vault integrity** — the vault's own bytes change only by the
//!    operation the test performed. The index never writes into the vault.
//! 5. **Tree equivalence** — the stored file tree equals what a fresh walk
//!    would have written: same paths, same kinds, same sizes. The targeted
//!    route stats only the paths a hint named (plus the folders above them),
//!    so this is where "it converges on what a complete walk would write"
//!    stops being an assumption.
//! 6. **Scalar mirror** — `property_scalars` mirrors `properties` row for
//!    row, column for column.
//!
//! A batch normally reconciles through the targeted route (`refresh_paths`).
//! A batch that carries `CompleteRefresh` instead reconciles through the
//! complete route over the existing index (`refresh_complete_for_test`, the
//! whole-vault inventory and `begin_publish` with a previous generation), so
//! every claim above is also checked after that route.
//!
//! The operation alphabet deliberately includes the changes that are
//! invisible to the cheap signals: `Touch` moves metadata without content,
//! and `PreserveFingerprintWrite` moves content without metadata.
//!
//! It also includes the daemon's *own* writes. A mutation and an external
//! edit must be indistinguishable to the semantic layer: the same six claims
//! hold whether the bytes arrived through `std::fs` or through
//! `MutationEngine`, and a batch carrying a mutation reconciles under
//! `ChangeCause::Mutation` rather than `ChangeCause::Watcher`. The generator
//! picks paths freely, so a mutation that the engine refuses — a rename whose
//! source is gone, a copy onto an occupied path, a patch of unparseable
//! frontmatter — is an expected draw, not a failure: a refusal leaves the
//! vault untouched, and the batch still has to reconcile to a scan-equivalent
//! state.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use proptest::prelude::*;
use proptest::strategy::ValueTree;
use tempfile::TempDir;
use vault_core::{
    FileSystemVaultSource, LinkTarget, ScanReport, TreeEntryKind, VaultPath, scan_vault,
};
use vault_index::{ChangeCause, IndexConfig, IndexService};

/// The file tree as three comparable facts per entry: path, kind, and size.
///
/// Timestamps are deliberately left out. A folder's timestamps move whenever
/// anything inside it is created or removed, and nothing reads them (a folder
/// carries no `stat` in the object model), so they are not client-visible
/// state and must not make this snapshot "changed" — `TreeDelta` draws the
/// same line. A note's timestamps are the fingerprint's business, and the
/// file-tree tests cover the timestamp columns directly.
type TreeSnapshot = Vec<(String, TreeEntryKind, Option<u64>)>;

/// What a fresh walk says the tree is.
fn scanned_tree(root: &Path) -> TreeSnapshot {
    let source = FileSystemVaultSource::new(root).expect("tree scan source");
    source
        .scan()
        .expect("scan vault tree")
        .entries
        .into_iter()
        .map(|entry| (entry.path.as_str().to_string(), entry.kind, entry.size))
        .collect()
}

/// What the cache stored.
fn stored_tree(service: &IndexService) -> TreeSnapshot {
    let (_, entries) = service.tree_entries().expect("stored tree");
    entries
        .into_iter()
        .map(|entry| (entry.path.as_str().to_string(), entry.kind, entry.size))
        .collect()
}

/// Several spellings per stem across three nesting levels, so relative links,
/// duplicate stems, and ambiguity transitions are all reachable from one
/// small slot set.
///
/// `Alpha` deliberately has **three** spellings, one of them at the root. An
/// exact vault path wins outright, so while root `Alpha.md` exists `[[Alpha]]`
/// resolves to it and nothing is ambiguous; ambiguity appears only once the
/// root spelling is gone and the two nested ones are left competing. Two
/// spellings alone can never produce it, which
/// `the_generators_reach_every_interesting_state` is what caught.
const SLOTS: &[&str] = &[
    "Alpha.md",
    "Beta.md",
    "Gamma.md",
    "Nested/Alpha.md",
    "Nested/Beta.md",
    "Nested/Deep/Gamma.md",
    "Other/Alpha.md",
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
    Write {
        path: String,
        body: String,
    },
    Delete {
        path: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Touch {
        path: String,
    },
    PreserveFingerprintWrite {
        path: String,
        body: String,
    },
    MakeInvalidUtf8 {
        path: String,
    },
    RestoreUtf8 {
        path: String,
        body: String,
    },
    /// The same content change as `Write`, routed through the mutation
    /// engine instead of `std::fs`. The oracle's whole point here: the
    /// semantic layer must not be able to tell the two apart.
    MutateWrite {
        path: String,
        body: String,
    },
    MutateDelete {
        path: String,
    },
    MutateRename {
        from: String,
        to: String,
    },
    MutatePatch {
        path: String,
        value: Option<String>,
    },
    /// A write through the engine at a case-folded spelling of a root slot.
    /// The engine refuses it while the stored spelling exists — a caller who
    /// spells `alpha.md` beside a stored `Alpha.md` is naming a file this
    /// vault does not hold. The refusal is part of the equivalence claim:
    /// both sides then have to agree that nothing changed at all.
    MutateWriteCaseVariant {
        path: String,
        body: String,
    },
    /// A write through the engine at a hidden path, which is unindexable and
    /// always refused. Same claim: a refused mutation moves nothing, and the
    /// batch still reconciles to a scan-equivalent state with no generation.
    MutateWriteHidden {
        path: String,
        body: String,
    },
    /// Not a change to the vault: the batch that carries it reconciles
    /// through the complete route over the existing index instead of the
    /// targeted one. Every claim must hold after either route.
    CompleteRefresh,
}

/// What the mutation engine answered, for the operations that ask it
/// anything. `None` is a `std::fs` arm, which asks it nothing.
///
/// This exists because the reachability test cannot infer "the engine ran"
/// from the bytes on disk: `Write` and `MutateWrite` draw from the same slot
/// and body space, so a refused `MutateWrite` very often returns to a file
/// that already holds exactly the bytes it meant to write. Recording the
/// engine's own answer is the only signal another arm cannot forge.
#[derive(Clone, Debug)]
enum MutationAnswer {
    Accepted,
    Refused(vault_index::MutationError),
}

/// What one applied operation did: the paths a perfect watcher would have
/// hinted, and what the engine answered if the operation asked it anything.
struct Applied {
    touched: BTreeSet<VaultPath>,
    answer: Option<MutationAnswer>,
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
/// would have hinted, plus whatever the mutation engine answered.
///
/// The mutation arms hint the same paths their `std::fs` twins do, on purpose:
/// this oracle's claim is about reconciliation, so the hint set is the test's
/// own, never the engine's `changed_paths`. What an outcome reports is the
/// coordinator's business, and `vault-server`'s `tests/mutation_oracle.rs`
/// checks it where it is actually consumed. The engine's *answer* is carried
/// out for the reachability test alone — see [`MutationAnswer`] for why the
/// bytes on disk cannot stand in for it.
fn apply(root: &Path, engine: &vault_index::MutationEngine, operation: &Operation) -> Applied {
    fn touch(name: &str, touched: &mut BTreeSet<VaultPath>) {
        touched.insert(VaultPath::new(name).expect("valid vault path"));
    }
    fn answer(
        outcome: Result<vault_index::MutationOutcome, vault_index::MutationError>,
    ) -> Option<MutationAnswer> {
        Some(match outcome {
            Ok(_) => MutationAnswer::Accepted,
            Err(error) => MutationAnswer::Refused(error),
        })
    }
    let mut touched = BTreeSet::new();
    let mut engine_answer = None;
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
        Operation::MutateWrite { path, body } => {
            let vault_path = VaultPath::new(path).expect("valid vault path");
            // The parent is created first so this arm is a *write* test rather
            // than a parent-existence test: with the folder in place and an
            // unconditional precondition, the engine has no refusal left to
            // give here, and every draw lands. The two refusal cells below are
            // where a refused mutation is the point.
            if let Some(parent) = std::path::Path::new(path).parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(root.join(parent)).expect("create parent directory");
                }
            }
            engine_answer = answer(engine.apply(&vault_index::Mutation::WriteNote {
                path: vault_path,
                content: body.clone(),
                expected: vault_index::Precondition::Any,
            }));
            touch(path, &mut touched);
        }
        Operation::MutateDelete { path } => {
            engine_answer = answer(engine.apply(&vault_index::Mutation::DeleteNote {
                path: VaultPath::new(path).expect("valid vault path"),
                mode: Some(vault_index::DeleteMode::Permanent),
                expected: vault_index::Precondition::Any,
            }));
            touch(path, &mut touched);
        }
        Operation::MutateRename { from, to } => {
            if from != to {
                if let Some(parent) = std::path::Path::new(to).parent() {
                    if !parent.as_os_str().is_empty() {
                        std::fs::create_dir_all(root.join(parent))
                            .expect("create parent directory");
                    }
                }
                engine_answer = answer(engine.apply(&vault_index::Mutation::RenameNote {
                    from: VaultPath::new(from).expect("valid vault path"),
                    to: VaultPath::new(to).expect("valid vault path"),
                    expected: vault_index::Precondition::Any,
                    // Repair is exercised by `tests/rename_repair.rs`; here
                    // the claim is that a moved file reconciles exactly like
                    // an externally moved one.
                    rewrite_links: false,
                }));
            }
            touch(from, &mut touched);
            touch(to, &mut touched);
        }
        Operation::MutatePatch { path, value } => {
            engine_answer = answer(engine.apply(&vault_index::Mutation::PatchFrontmatter {
                path: VaultPath::new(path).expect("valid vault path"),
                patch: vec![vault_index::FrontmatterEdit {
                    key_path: vec!["title".to_string()],
                    value: value.clone().map(vault_index::PatchValue::String),
                }],
                expected: vault_index::Precondition::Any,
            }));
            touch(path, &mut touched);
        }
        // The two refusal cells. Neither creates its parent and neither is
        // expected to land: what they exercise is that a refusal really is
        // inert — the vault stays byte-identical (claim 4) and no generation
        // appears (claim 3, in its zero direction).
        //
        // **They hint nothing, and that is the honest hint.** A refused
        // mutation writes nothing, so a perfect watcher sees no filesystem
        // event and emits no path. Hinting the caller's spelling instead
        // would be out of contract in a way that matters: every real hint is
        // a *stored* spelling — the watcher reads them off the filesystem and
        // `MutationOutcome::changed_paths` documents at length why it reports
        // the stored spelling rather than the caller's — while `seed.md` is
        // precisely a spelling this vault does not store. Feeding one in
        // manufactures a generation for a vault that did not change, which is
        // an out-of-contract input producing an out-of-contract answer, not a
        // defect these cells are entitled to report.
        Operation::MutateWriteCaseVariant { path, body }
        | Operation::MutateWriteHidden { path, body } => {
            engine_answer = answer(engine.apply(&vault_index::Mutation::WriteNote {
                path: VaultPath::new(path).expect("valid vault path"),
                content: body.clone(),
                expected: vault_index::Precondition::Any,
            }));
        }
        // Nothing to apply: the batch's reconciliation route is the change.
        Operation::CompleteRefresh => {}
    }
    Applied {
        touched,
        answer: engine_answer,
    }
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

struct Oracle {
    service: IndexService,
    root: PathBuf,
    /// The daemon's own writer, over the same vault. Held here rather than
    /// built per batch because a `MutationEngine` is just a canonical root
    /// and a policy, and rebuilding it would re-canonicalize on every
    /// operation for nothing.
    engine: vault_index::MutationEngine,
    /// The scan-derived truth as of the last verified batch, for the
    /// "advanced exactly once iff something changed" comparison.
    expected: common::SemanticSnapshot,
    /// The other half of that truth: the file tree the same walk saw.
    expected_tree: TreeSnapshot,
    generation: u64,
    /// How many batches actually took the complete-resolution fallback. The
    /// witness that forcing the threshold to zero did what it claims: without
    /// it, "the fallback is equivalent to a scan" could pass while never
    /// entering the branch at all.
    complete_resolutions: usize,
    _vault: TempDir,
    _index: TempDir,
}

impl Oracle {
    fn open() -> Self {
        Self::open_with(false)
    }

    /// An oracle whose every selecting batch abandons the incremental plan
    /// and re-resolves every reference the compact graph holds.
    ///
    /// This is the conservative-invalidation safety net — the branch taken
    /// when selection stops paying for itself — and the production threshold
    /// (`max(10_000, references / 4)`) puts it far out of reach of any
    /// fixture small enough to assert on. Forcing it to zero is what makes
    /// the branch reachable, and every claim `run_batch` checks then applies
    /// to it unchanged.
    fn open_forcing_complete_resolution() -> Self {
        Self::open_with(true)
    }

    fn open_with(force_complete_resolution: bool) -> Self {
        let vault = TempDir::new().expect("vault tempdir");
        let index = TempDir::new().expect("index tempdir");
        let root = vault.path().to_path_buf();

        seed_vault(&root);

        let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3"))
            .expect("oracle config");
        let mut service = IndexService::open(config).expect("oracle service");
        service.refresh(false).expect("cold build");
        if force_complete_resolution {
            service.set_complete_resolution_threshold_for_test(0);
        }
        let generation = service
            .current_generation()
            .expect("generation")
            .expect("cold build published")
            .get();
        let expected = common::snapshot_from_scan(&scan(&root));
        let expected_tree = scanned_tree(&root);

        let engine =
            vault_index::MutationEngine::new(root.canonicalize().expect("canonical vault root"));

        Self {
            service,
            root,
            engine,
            expected,
            expected_tree,
            generation,
            complete_resolutions: 0,
            _vault: vault,
            _index: index,
        }
    }

    /// Apply one batch, reconcile exactly the paths it touched, and check
    /// every claim in this module's header.
    fn run_batch(&mut self, batch: &[Operation]) -> Result<(), TestCaseError> {
        let mut touched: BTreeSet<VaultPath> = BTreeSet::new();
        for operation in batch {
            touched.extend(apply(&self.root, &self.engine, operation).touched);
        }
        let vault_after_operations = common::digest_tree(&self.root);

        let truth = scan(&self.root);
        let expected = common::snapshot_from_scan(&truth);
        let expected_tree = scanned_tree(&self.root);
        let changed = expected != self.expected || expected_tree != self.expected_tree;

        // A batch the daemon caused reconciles as the daemon's own write, so a
        // subscriber can tell a change it asked for from one it must react to.
        // Every claim below is the same either way — that is the point.
        let cause = if batch.iter().any(|operation| {
            matches!(
                operation,
                Operation::MutateWrite { .. }
                    | Operation::MutateDelete { .. }
                    | Operation::MutateRename { .. }
                    | Operation::MutatePatch { .. }
                    | Operation::MutateWriteCaseVariant { .. }
                    | Operation::MutateWriteHidden { .. }
            )
        }) {
            ChangeCause::Mutation
        } else {
            ChangeCause::Watcher
        };
        let complete_route = batch
            .iter()
            .any(|operation| matches!(operation, Operation::CompleteRefresh));
        let (generation, complete_resolution) = if complete_route {
            // The complete route over the existing index: a whole-vault
            // inventory published through `begin_publish` with a previous
            // generation. It carries no cause; the claims below are the same.
            // An unverified complete refresh trusts every fingerprint, so a
            // batch whose content moved under an unchanged fingerprint asks
            // for the verified mode, which reads every body; every other
            // batch takes the unverified mode, so both modes are driven.
            let verify = batch
                .iter()
                .any(|operation| matches!(operation, Operation::PreserveFingerprintWrite { .. }));
            let report = self
                .service
                .refresh_complete_for_test(verify)
                .map_err(|error| {
                    TestCaseError::fail(format!("complete refresh failed: {error}"))
                })?;
            (report.generation, false)
        } else {
            let report = self
                .service
                .refresh_paths(touched, cause)
                .map_err(|error| {
                    TestCaseError::fail(format!("targeted refresh failed: {error}"))
                })?;
            prop_assert_eq!(
                report.cause,
                cause,
                "the report must carry the cause the batch was reconciled under after {:?}",
                batch
            );
            (report.generation, report.complete_resolution)
        };

        // (3) Generation exactness, in both directions.
        let wanted = if changed {
            self.generation + 1
        } else {
            self.generation
        };
        prop_assert_eq!(
            generation.get(),
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

        // (5) Tree equivalence: the targeted route stated only the paths the
        // batch named and the folders above them, and still landed exactly
        // where a complete walk would have.
        prop_assert_eq!(
            stored_tree(&self.service),
            expected_tree.clone(),
            "the stored file tree diverged from a clean walk after {:?}",
            batch
        );

        // (4) The vault changed only by the operation itself.
        prop_assert_eq!(
            common::digest_tree(&self.root),
            vault_after_operations,
            "the index wrote into the vault while reconciling {:?}",
            batch
        );

        // (6) The scalar index mirrors the properties it is derived from.
        if let Err(message) = common::property_scalars_mirror(self.service.connection_for_test()) {
            return Err(TestCaseError::fail(format!("{message} after {batch:?}")));
        }

        if complete_resolution {
            self.complete_resolutions += 1;
        }
        self.expected = expected;
        self.expected_tree = expected_tree;
        self.generation = generation.get();
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

/// The starting vault every oracle run shares. `Seed.md` is never generated
/// against, so every batch is checked against stable *incoming* references as
/// well as its own outgoing ones.
fn seed_vault(root: &Path) {
    write_file(
        root,
        "Seed.md",
        "# Seed\n[[Alpha]]\n[[Beta#Heading]]\n[[Gamma#^block]]\n[[Nested/Alpha.md]]\n\
         [[Nowhere]]\n[site](https://example.com)\n",
    );
    write_file(root, "Alpha.md", "# Heading\n\ntext ^block\n");
    write_file(root, "Beta.md", "# Heading\n[[Alpha]]\n");
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
        3 => (slot(), body()).prop_map(|(path, body)| Operation::MutateWrite { path, body }),
        2 => slot().prop_map(|path| Operation::MutateDelete { path }),
        1 => (slot(), slot()).prop_map(|(from, to)| Operation::MutateRename { from, to }),
        1 => (slot(), prop::option::of("[a-z]{1,6}"))
            .prop_map(|(path, value)| Operation::MutatePatch { path, value }),
        1 => (case_variant_slot(), body())
            .prop_map(|(path, body)| Operation::MutateWriteCaseVariant { path, body }),
        1 => (hidden_slot(), body())
            .prop_map(|(path, body)| Operation::MutateWriteHidden { path, body }),
        2 => Just(Operation::CompleteRefresh),
    ]
}

/// Case variants of `Seed.md`, and only of `Seed.md`.
///
/// Two properties make this the one safe spelling to fold. It is the note no
/// generated operation ever names, so it always exists and the cell is a
/// guaranteed collision on every draw rather than one that depends on what
/// the run has deleted so far. And it is at the root, so the parent always
/// exists — a folded nested spelling (`nested/deep/gamma.md`) would be
/// refused for its missing parent long before the case rule was consulted,
/// and the cell would prove only that a missing folder is a missing folder.
///
/// Folding a slot instead would sometimes *land*, creating a second stored
/// spelling on a case-insensitive filesystem and dragging case-only
/// reconciliation — a real gap, deliberately left to its own task — into a
/// cell that is meant to check one refusal.
fn case_variant_slot() -> impl Strategy<Value = String> {
    const VARIANTS: &[&str] = &["seed.md", "SEED.md", "sEeD.md"];
    (0usize..VARIANTS.len()).prop_map(|index| VARIANTS[index].to_string())
}

/// Paths with a hidden component, which the scan excludes and the engine
/// refuses to write into. `.obsidian` is the configuration zone the engine
/// guards by name; the other two are ordinary dot-directories.
fn hidden_slot() -> impl Strategy<Value = String> {
    const HIDDEN: &[&str] = &[
        ".obsidian/Alpha.md",
        ".hidden/Alpha.md",
        ".trash/Nested/Alpha.md",
    ];
    (0usize..HIDDEN.len()).prop_map(|index| HIDDEN[index].to_string())
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
fn regression_scenario() -> Vec<Vec<Operation>> {
    vec![
        // A brand-new note resolves a reference that was waiting for it.
        vec![Operation::Write {
            path: "Gamma.md".into(),
            body: "# Heading\n\ntext ^block\n".into(),
        }],
        // A second spelling of the same stem appears alongside the root
        // spelling. Exact-path-wins keeps `[[Alpha]]` resolving to root
        // `Alpha.md` — this is not the ambiguity transition, just a second
        // candidate coexisting harmlessly with the exact match.
        vec![Operation::Write {
            path: "Nested/Alpha.md".into(),
            body: "# Heading\n[[../Beta]]\n".into(),
        }],
        // ...and removing it again leaves the resolution unchanged.
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
        // From here the same transitions again, driven by the daemon's own
        // writer instead of by `std::fs`. Scripted rather than seeded for the
        // reason above, and doubly so here: a shrunken seed is drawn against
        // one exact generator, and this alphabet is the one most likely to be
        // reweighted next.
        //
        // A mutation write that answers a reference which was waiting for it.
        // This is the case an under-selecting engine gets wrong, and it is
        // what caught the deliberate under-selection this alphabet was
        // validated against.
        vec![Operation::MutateWrite {
            path: "Gamma.md".into(),
            body: "# Heading\n\ntext ^block\n".into(),
        }],
        // Frontmatter surgery through the engine: the note's bytes and its
        // revision move, and everything pointing at it has to follow.
        vec![Operation::MutatePatch {
            path: "Beta.md".into(),
            value: Some("titled".into()),
        }],
        // ...and the deletion spelling, which removes the key again.
        vec![Operation::MutatePatch {
            path: "Beta.md".into(),
            value: None,
        }],
        // A mutation delete drops the exact spelling, so the reference falls
        // back to the nested one — a resolution moving under a note that did
        // not itself change.
        vec![Operation::MutateDelete {
            path: "Gamma.md".into(),
        }],
        // A mutation rename: the vacated path and the occupied one both have
        // to reconcile, exactly as they do for an external move.
        vec![Operation::MutateRename {
            from: "Nested/Deep/Gamma.md".into(),
            to: "Gamma.md".into(),
        }],
        // One batch holding both kinds of write. The cause is `Mutation`, and
        // every claim is the same as it would be for either alone.
        vec![
            Operation::Write {
                path: "Nested/Alpha.md".into(),
                body: "# Heading\n[[../Gamma]]\n".into(),
            },
            Operation::MutateDelete {
                path: "Alpha.md".into(),
            },
        ],
        // Two refused mutations, scripted so the inert case is pinned rather
        // than left to the draw: a case-variant spelling of a note this vault
        // stores under another case, and a write into a hidden zone. Both
        // must leave the vault byte-identical and the generation still.
        vec![Operation::MutateWriteCaseVariant {
            path: "seed.md".into(),
            body: "# Heading\n\ntext ^block\n".into(),
        }],
        vec![Operation::MutateWriteHidden {
            path: ".obsidian/Alpha.md".into(),
            body: "# Heading\n\ntext ^block\n".into(),
        }],
    ]
}

fn run_regression_scenario(oracle: &mut Oracle) {
    for batch in regression_scenario() {
        oracle
            .run_batch(&batch)
            .unwrap_or_else(|error| panic!("regression scenario failed: {error}"));
    }
}

#[test]
fn the_regression_scenario_stays_equivalent_to_a_fresh_scan() {
    let mut oracle = Oracle::open();
    run_regression_scenario(&mut oracle);
}

/// The same scenario with the complete-resolution fallback forced on.
///
/// The fallback is the conservative-invalidation safety net: when selection
/// stops paying for itself the plan is abandoned and every reference the
/// compact graph holds is re-resolved. It has to land on exactly the state
/// the selective path lands on, or the "safety net" is a source of divergence
/// rather than a defence against one — and the production threshold
/// (`max(10_000, references / 4)`) puts it out of reach of every fixture in
/// this workspace.
#[test]
fn the_regression_scenario_stays_equivalent_under_the_complete_resolution_fallback() {
    let mut oracle = Oracle::open_forcing_complete_resolution();
    run_regression_scenario(&mut oracle);
    assert!(
        oracle.complete_resolutions > 0,
        "the fallback branch was never entered, so this proved nothing"
    );
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

    /// The same sweep with the complete-resolution fallback forced on, so the
    /// safety net gets the identical ground-truth comparison the selective
    /// path gets. Every claim in this module's header applies unchanged: the
    /// fallback re-resolves far more, and must still answer the same.
    #[test]
    fn the_complete_resolution_fallback_matches_a_fresh_scan_after_every_batch(
        batches in prop::collection::vec(batch(), 1..=8)
    ) {
        let mut oracle = Oracle::open_forcing_complete_resolution();
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

// ---------------------------------------------------------------------------
// Generator reachability
// ---------------------------------------------------------------------------

/// The states this oracle exists to exercise. A generator that stops reaching
/// one of these keeps passing while quietly testing less, which is the
/// failure mode a randomized suite is worst at reporting on its own.
const INTERESTING_STATES: &[&str] = &[
    "a reference is ambiguous",
    "a reference is unresolved",
    "a note is not valid UTF-8",
    "a referenced note is deleted",
    "a note is renamed to a different path",
    "content moves while the fingerprint does not",
    "an unresolved reference becomes resolved without its own note changing",
    "a resolved reference becomes unresolved without its own note changing",
    "a note is written through the mutation engine",
    "a note is deleted through the mutation engine",
    "a note is renamed through the mutation engine",
    "frontmatter is patched through the mutation engine",
    "the mutation engine refuses a case-variant spelling",
    "the mutation engine refuses a hidden path",
    "a batch reconciles through the complete route",
];

/// The interesting state one mutation operation reached, judged from the
/// engine's own answer rather than from the vault's bytes.
///
/// The refusal cells name the refusal they exist for, so a cell that starts
/// being refused for some *other* reason — a missing parent, a read-only
/// engine, a size limit — stops counting rather than quietly standing in for
/// the rule it was written to exercise.
fn mutation_state(operation: &Operation, answer: Option<&MutationAnswer>) -> Option<&'static str> {
    use vault_index::MutationError;
    match (operation, answer?) {
        (Operation::MutateWrite { .. }, MutationAnswer::Accepted) => {
            Some("a note is written through the mutation engine")
        }
        (Operation::MutateDelete { .. }, MutationAnswer::Accepted) => {
            Some("a note is deleted through the mutation engine")
        }
        (Operation::MutateRename { .. }, MutationAnswer::Accepted) => {
            Some("a note is renamed through the mutation engine")
        }
        (Operation::MutatePatch { .. }, MutationAnswer::Accepted) => {
            Some("frontmatter is patched through the mutation engine")
        }
        (
            Operation::MutateWriteCaseVariant { .. },
            MutationAnswer::Refused(MutationError::CaseCollision { .. }),
        ) => Some("the mutation engine refuses a case-variant spelling"),
        (
            Operation::MutateWriteHidden { .. },
            MutationAnswer::Refused(MutationError::ZoneViolation { .. }),
        ) => Some("the mutation engine refuses a hidden path"),
        _ => None,
    }
}

/// Whether any reference belonging to a note that did **not** itself change
/// flipped its resolution answer. Restricting to unchanged notes is what
/// makes this honest: ordinals are then stable, so a flip is necessarily
/// caused by some *other* note moving — the invalidation case the whole
/// engine is built around.
fn stable_resolution_flips(before: &ScanReport, after: &ScanReport) -> (bool, bool) {
    let (mut gained, mut lost) = (false, false);
    for path in after.graph.note_paths() {
        let old_note = match before.graph.note(path) {
            Some(note) => note,
            None => continue,
        };
        let new_note = match after.graph.note(path) {
            Some(note) => note,
            None => continue,
        };
        if old_note.source.revision().as_str() != new_note.source.revision().as_str() {
            continue;
        }
        let old = before.graph.outgoing(path);
        let new = after.graph.outgoing(path);
        if old.len() != new.len() {
            continue;
        }
        for (was, is) in old.iter().zip(new.iter()) {
            let was = matches!(was.resolution, vault_core::Resolution::Resolved { .. });
            let is = matches!(is.resolution, vault_core::Resolution::Resolved { .. });
            gained |= !was && is;
            lost |= was && !is;
        }
    }
    (gained, lost)
}

/// The generators actually reach every state the oracle claims to cover.
///
/// Written in the style of `every_generated_body_is_ascii`: a deterministic
/// runner samples batches, applies them to a scratch vault, and records which
/// interesting states the resulting vault passed through. Without this, tuning
/// a weight or a body strategy could silently stop producing ambiguity flips
/// or invalid UTF-8 and nothing would ever say so — the oracle would keep
/// passing on a strictly smaller world.
#[test]
fn the_generators_reach_every_interesting_state() {
    const SAMPLES: usize = 300;

    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().to_path_buf();
    seed_vault(&root);
    // This test builds its own scratch vault, so it needs its own writer over
    // that vault rather than the `Oracle`'s.
    let engine = vault_index::MutationEngine::new(root.canonicalize().expect("canonical root"));

    let mut runner = proptest::test_runner::TestRunner::deterministic();
    let strategy = batch();
    let mut reached: BTreeSet<&'static str> = BTreeSet::new();
    let mut before = scan(&root);

    for _ in 0..SAMPLES {
        let batch = strategy
            .new_tree(&mut runner)
            .expect("generate a batch")
            .current();

        for operation in &batch {
            // Observations that need the world as it stands *before* the
            // operation lands.
            match operation {
                Operation::Delete { path } => {
                    let vault_path = VaultPath::new(path).expect("valid vault path");
                    let is_note = before.graph.note(&vault_path).is_some();
                    if is_note && !before.graph.backlinks(&vault_path).is_empty() {
                        reached.insert("a referenced note is deleted");
                    }
                    apply(&root, &engine, operation);
                }
                Operation::Rename { from, to } => {
                    if from != to && root.join(from).is_file() {
                        reached.insert("a note is renamed to a different path");
                    }
                    apply(&root, &engine, operation);
                }
                Operation::PreserveFingerprintWrite { path, .. } => {
                    let bytes = std::fs::read(root.join(path)).ok();
                    apply(&root, &engine, operation);
                    if bytes.is_some() && bytes != std::fs::read(root.join(path)).ok() {
                        reached.insert("content moves while the fingerprint does not");
                    }
                }
                // Every mutation state is recorded from the engine's own
                // answer, never from the vault's bytes. Bytes cannot carry
                // this claim: `Write` and `MutateWrite` draw from the same
                // slot and body space, so a file very often already holds
                // exactly what a *refused* `MutateWrite` meant to write, and
                // an engine that refused everything would still be reported
                // as reached. Reading the `Ok`/`Err` the engine returned is
                // the one signal no other arm can forge — so an arm that
                // decays into refusals fails this test, which is the whole
                // reason the states exist.
                Operation::MutateWrite { .. }
                | Operation::MutateDelete { .. }
                | Operation::MutateRename { .. }
                | Operation::MutatePatch { .. }
                | Operation::MutateWriteCaseVariant { .. }
                | Operation::MutateWriteHidden { .. } => {
                    let applied = apply(&root, &engine, operation);
                    if let Some(state) = mutation_state(operation, applied.answer.as_ref()) {
                        reached.insert(state);
                    }
                }
                Operation::CompleteRefresh => {
                    reached.insert("a batch reconciles through the complete route");
                    apply(&root, &engine, operation);
                }
                _ => {
                    apply(&root, &engine, operation);
                }
            }
        }

        let after = scan(&root);
        if !after.graph.ambiguous().is_empty() {
            reached.insert("a reference is ambiguous");
        }
        if !after.graph.unresolved().is_empty() {
            reached.insert("a reference is unresolved");
        }
        if after
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == vault_core::DiagnosticCode::InvalidUtf8)
        {
            reached.insert("a note is not valid UTF-8");
        }
        let (gained, lost) = stable_resolution_flips(&before, &after);
        if gained {
            reached
                .insert("an unresolved reference becomes resolved without its own note changing");
        }
        if lost {
            reached.insert("a resolved reference becomes unresolved without its own note changing");
        }
        before = after;
    }

    let missed: Vec<&&str> = INTERESTING_STATES
        .iter()
        .filter(|state| !reached.contains(**state))
        .collect();
    assert!(
        missed.is_empty(),
        "the generators no longer reach {missed:?} within {SAMPLES} batches — \
         the oracle is now testing a smaller world than it claims to"
    );
}
