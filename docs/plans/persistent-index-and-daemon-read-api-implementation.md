# vaultd Persistent Index and Daemon Read API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist an Obsidian-compatible vault's semantic graph in a generation-consistent SQLite cache and expose fast, read-only daemon operations over protocol version 1.

**Architecture:** Extract pure graph construction and lightweight resolution catalogs in `vault-core`, then add a `vault-index` crate that owns XDG cache selection, normalized SQLite persistence, reconciliation, generation-aware queries, and cursors. `vault-server` composes one optional vault/index and translates between core/index values and transport-only `vault-protocol` DTOs; vault Markdown remains authoritative and read-only.

**Tech Stack:** Rust 1.85 or newer, edition 2024, Cargo resolver 3, `rusqlite` 0.32.1 with bundled SQLite, `xdg` 3.0, `base64` 0.22.1, `clap` 4.6.6 derive, `filetime` 0.2.29, existing `blake3`/`serde`/`serde_json`/`thiserror`/`tempfile`/`proptest` dependencies, SQLite WAL, and newline-delimited JSON over stdio.

## Global Constraints

- Read `README.md`, `VAULTD-COMPATIBILITY.md`, `docs/protocol.md`, `docs/design/foundation.md`, `docs/design/semantic-read-path.md`, `docs/design/persistent-index-and-daemon-read-api.md`, and `docs/plans/semantic-read-path-implementation.md` in full before editing.
- Start only from commit `b9f0fe2` or a reviewed descendant on `main`. Confirm all 57 existing tests pass before creating implementation commits.
- Use `superpowers:using-git-worktrees` and create a fresh worktree from updated `main`. Do not implement this multi-file phase in the permanent checkout or reuse the semantic-read-path worktree.
- Follow strict red-green-refactor. For each behavior, add the focused test first, run it and confirm the intended failure, then add only enough production code to pass.
- Keep the ordinary Obsidian vault filesystem authoritative and read-only. Production writes in this phase may target only the derived index/cache path.
- One `vaultd` process serves at most one explicitly configured vault. No `--vault` means health-only mode; do not infer or auto-discover a vault.
- Keep `vault-core` independent of SQLite, XDG, protocol, server, transport, UI, plugin, and Sync types.
- Keep `vault-protocol` independent of `vault-core`, `vault-index`, and `vault-server`. Duplicate transport DTOs intentionally and convert at the server boundary.
- Preserve exact validated UTF-8 source and half-open byte spans. Never normalize Markdown, YAML, line endings, Unicode, link spelling, or property ordering.
- Default reconciliation trusts path, size, and modification time; `verify: true` hashes every included Markdown file. In both modes, parse only content revisions that changed.
- Every committed semantic snapshot is atomic and monotonically generation-numbered. Reads and cursors must never mix generations.
- Do not add watchers, subscriptions, search, vault mutation, journaling, network transports, MCP, URI handling, plugins, Node/Swift/Elisp hosts, Sync, UI, mobile, or e-ink implementation.
- Preserve the workspace's Rust 1.85 minimum. Keep `rusqlite` on the 0.32 line: current 0.40 releases target much newer Rust and are outside this milestone's MSRV.
- Do not run benchmarks against the maintainer's real vault without explicit opt-in. Never commit real-vault source, paths, note names, index contents, or benchmark samples containing them.
- Do not add a GitHub remote, push, open a pull request, merge, or delete a worktree without the maintainer's authorization.
- Leave the pre-existing untracked `.permission-check` file untouched and uncommitted.
- Use the exact scoped commit message specified for each task.

## Preflight Gate

- [ ] **Step 1: Verify the permanent checkout and prior milestone**

Run from the permanent checkout:

```bash
cd ~/repos/system/vaultd
git status --short --branch
git worktree list
git log --oneline --decorate -15
rustup toolchain list
TMPDIR=~/repos/system/vaultd/target cargo test --workspace --all-targets
```

Expected:

- `HEAD` is `b9f0fe2` or a reviewed descendant on `main`.
- The 57-test workspace suite passes.
- Rust 1.85 is available for the final explicit MSRV check; if it is absent, report that prerequisite instead of raising the project MSRV.
- Only the known `.permission-check` file is untracked in the permanent checkout.
- No unrelated implementation branch or worktree is reused.

If any expectation fails, stop and reconcile the prior milestone before implementation.

- [ ] **Step 2: Create and verify the isolated worktree**

Use `superpowers:using-git-worktrees` to create a branch named `feat/persistent-index-read-api` from the updated `main`. In that worktree, run:

```bash
git status --short --branch
TMPDIR="$PWD/target" cargo test --workspace --all-targets
```

Expected: a clean feature worktree and the same 57 passing tests.

## Planned File Map

```text
Cargo.toml
Cargo.lock
  Add MSRV-compatible SQLite, XDG, cursor, CLI, and timestamp dependencies.

crates/vault-core/src/lib.rs
crates/vault-core/src/graph.rs
crates/vault-core/src/resolver.rs
crates/vault-core/src/vault_source.rs
crates/vault-core/tests/graph_builder.rs
crates/vault-core/tests/resolution_catalog.rs
  Separate graph construction from scanning and expose a lightweight resolution catalog.

crates/vault-index/Cargo.toml
crates/vault-index/src/lib.rs
crates/vault-index/src/error.rs
crates/vault-index/src/model.rs
crates/vault-index/src/config.rs
crates/vault-index/src/schema.rs
crates/vault-index/src/schema_v1.sql
crates/vault-index/src/codec.rs
crates/vault-index/src/store.rs
crates/vault-index/src/inventory.rs
crates/vault-index/src/reconcile.rs
crates/vault-index/src/cursor.rs
crates/vault-index/src/query.rs
crates/vault-index/src/bin/vault-bench.rs
  Own all derived persistence, reconciliation, query, cursor, and benchmark behavior.

crates/vault-index/tests/common/mod.rs
crates/vault-index/tests/schema.rs
crates/vault-index/tests/round_trip.rs
crates/vault-index/tests/inventory.rs
crates/vault-index/tests/cold_reconciliation.rs
crates/vault-index/tests/incremental_reconciliation.rs
crates/vault-index/tests/recovery.rs
crates/vault-index/tests/queries.rs
crates/vault-index/tests/reconciliation_oracle.rs
crates/vault-index/tests/benchmark_smoke.rs
  Verify the index independently of protocol and daemon composition.

crates/vault-protocol/src/lib.rs
crates/vault-protocol/src/envelope.rs
crates/vault-protocol/src/error.rs
crates/vault-protocol/src/semantic.rs
crates/vault-protocol/src/operations.rs
crates/vault-protocol/tests/schema.rs
crates/vault-protocol/tests/indexed_operations.rs
  Define transport-only version 1 indexed request, response, semantic, and error shapes.

crates/vault-server/Cargo.toml
crates/vault-server/src/lib.rs
crates/vault-server/src/convert.rs
crates/vault-server/src/main.rs
crates/vault-server/tests/health.rs
crates/vault-server/tests/indexed_dispatch.rs
crates/vault-server/tests/stdio.rs
crates/vault-server/tests/docs.rs
  Compose one optional index, translate DTOs, parse CLI configuration, and dispatch stdio.

docs/protocol.md
README.md
VAULTD-COMPATIBILITY.md
docs/performance/persistent-index-baseline.md
  Record the executable contract, current compatibility status, and measured baselines.
```

---

### Task 1: Decouple graph construction and expose lightweight resolution

**Files:**

- Modify: `crates/vault-core/src/graph.rs`
- Modify: `crates/vault-core/src/resolver.rs`
- Modify: `crates/vault-core/src/vault_source.rs`
- Modify: `crates/vault-core/src/lib.rs`
- Create: `crates/vault-core/tests/graph_builder.rs`
- Create: `crates/vault-core/tests/resolution_catalog.rs`

**Interfaces:**

- Consumes: existing `ParsedNote`, `Diagnostic`, `ScanReport`, `Resolution`, `Reference`, `Subpath`, `VaultPath`, `FileSystemVaultSource`, and `scan_vault`.
- Produces:

```rust
pub fn build_graph(
    notes: Vec<ParsedNote>,
    scan_diagnostics: Vec<Diagnostic>,
) -> ScanReport;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionNote {
    pub path: VaultPath,
    pub headings: Vec<String>,
    pub blocks: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkTarget {
    pub raw_target: String,
    pub file_target: Option<String>,
    pub subpath: Option<Subpath>,
}

impl LinkTarget {
    pub fn parse(destination: impl Into<String>) -> Self;
}

impl Resolver {
    pub fn from_catalog(notes: impl IntoIterator<Item = ResolutionNote>) -> Self;
    pub fn resolve_target(&self, source: &VaultPath, target: &LinkTarget) -> Resolution;
}

impl FileSystemVaultSource {
    pub fn canonical_root(&self) -> &Path;
}
```

- `Resolver::new(&[ParsedNote])` and `resolve_note` remain available and delegate through the new catalog/target interfaces.

- [ ] **Step 1: Write failing graph-builder equivalence tests**

Create `crates/vault-core/tests/graph_builder.rs`:

```rust
use std::path::PathBuf;

use vault_core::{
    FileSystemVaultSource, build_graph, parse_note, read_documents, scan_vault,
};

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/semantic-read-path/basic-vault")
}

#[test]
fn building_from_parsed_notes_matches_scan_vault() {
    let source = FileSystemVaultSource::new(fixture_root()).expect("fixture source");
    let scanned = scan_vault(&source).expect("scan fixture");
    let documents = read_documents(&source).expect("read fixture");
    let rebuilt = build_graph(
        documents.documents.into_iter().map(parse_note).collect(),
        documents.diagnostics,
    );

    assert_eq!(rebuilt.graph.note_paths(), scanned.graph.note_paths());
    assert_eq!(rebuilt.diagnostics, scanned.diagnostics);
    for path in scanned.graph.note_paths() {
        assert_eq!(rebuilt.graph.outgoing(path), scanned.graph.outgoing(path));
        assert_eq!(rebuilt.graph.backlinks(path), scanned.graph.backlinks(path));
    }
    assert_eq!(rebuilt.graph.unresolved(), scanned.graph.unresolved());
    assert_eq!(rebuilt.graph.ambiguous(), scanned.graph.ambiguous());
}
```

- [ ] **Step 2: Run the graph test and verify the intended failure**

Run:

```bash
cargo test -p vault-core --test graph_builder
```

Expected: compilation fails because `build_graph` is not exported.

- [ ] **Step 3: Extract pure graph construction**

In `graph.rs`, move all work beginning with resolver creation into the new function:

```rust
pub fn build_graph(
    notes: Vec<ParsedNote>,
    mut diagnostics: Vec<Diagnostic>,
) -> ScanReport {
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

pub fn scan_vault(source: &impl VaultSource) -> Result<ScanReport, ScanError> {
    let documents = read_documents(source)?;
    let notes = documents.documents.into_iter().map(parse_note).collect();
    Ok(build_graph(notes, documents.diagnostics))
}
```

Keep the existing private `sort_references` helper unchanged.

Export `build_graph` from `lib.rs` and run:

```bash
cargo test -p vault-core --test graph_builder
```

Expected: PASS, proving the refactor did not change graph semantics.

- [ ] **Step 4: Write failing resolution-catalog tests**

Create `crates/vault-core/tests/resolution_catalog.rs`:

```rust
use vault_core::{
    LinkTarget, Resolution, ResolutionNote, Resolver, Subpath, VaultPath,
};

fn path(value: &str) -> VaultPath {
    VaultPath::new(value).expect("valid vault path")
}

#[test]
fn lightweight_catalog_uses_the_existing_resolution_rules() {
    let resolver = Resolver::from_catalog([
        ResolutionNote {
            path: path("Folder/Note.md"),
            headings: vec!["Exact Heading".into()],
            blocks: vec!["block-1".into()],
        },
        ResolutionNote {
            path: path("Other.md"),
            headings: vec![],
            blocks: vec![],
        },
    ]);

    assert_eq!(
        resolver.resolve_target(
            &path("Source.md"),
            &LinkTarget::parse("Folder/Note#Exact Heading"),
        ),
        Resolution::Resolved {
            target: path("Folder/Note.md"),
            subpath: Some(Subpath::Heading("Exact Heading".into())),
        }
    );
    assert_eq!(
        resolver.resolve_target(
            &path("Source.md"),
            &LinkTarget::parse("Folder/Note#^missing"),
        ),
        Resolution::MissingSubpath {
            target: path("Folder/Note.md"),
            subpath: Subpath::Block("missing".into()),
        }
    );
}

#[test]
fn destination_parser_preserves_raw_spelling_and_empty_file_targets() {
    assert_eq!(
        LinkTarget::parse("#Heading"),
        LinkTarget {
            raw_target: "#Heading".into(),
            file_target: None,
            subpath: Some(Subpath::Heading("Heading".into())),
        }
    );
}
```

- [ ] **Step 5: Run the catalog test and verify the intended failure**

Run:

```bash
cargo test -p vault-core --test resolution_catalog
```

Expected: compilation fails because `LinkTarget`, `ResolutionNote`, `from_catalog`, and `resolve_target` do not exist.

- [ ] **Step 6: Implement the catalog without duplicating resolution policy**

In `resolver.rs`:

1. Add the exact public types/signatures from the Interfaces block.
2. Implement `From<&ParsedNote> for ResolutionNote` by copying path, heading text, and block identifiers.
3. Make `Resolver::new` call `Resolver::from_catalog(notes.iter().map(ResolutionNote::from))`.
4. Make `resolve_note` convert each `Reference` to a `LinkTarget` and call `resolve_target`.
5. Move the existing `has_uri_scheme`, relative-path, exact-path, filename/stem, ambiguity, and subpath logic into `resolve_target` unchanged.
6. Implement `LinkTarget::parse` by splitting once at `#`; `#^id` becomes `Subpath::Block`, `#heading` becomes `Subpath::Heading`, and an empty file part becomes `None`.

Use this conversion so parsed-note and ad hoc resolution share one implementation:

```rust
impl From<&Reference> for LinkTarget {
    fn from(reference: &Reference) -> Self {
        Self {
            raw_target: reference.raw_target.clone(),
            file_target: reference.file_target.clone(),
            subpath: reference.subpath.clone(),
        }
    }
}
```

Add `FileSystemVaultSource::canonical_root` in `vault_source.rs` and export the new resolver types in `lib.rs`.

- [ ] **Step 7: Run focused and core regression tests**

Run:

```bash
cargo test -p vault-core --test resolution_catalog
cargo test -p vault-core --test resolution
cargo test -p vault-core --test semantic_graph
cargo test -p vault-core --all-targets
```

Expected: all tests pass; existing resolution ordering and diagnostics remain unchanged.

- [ ] **Step 8: Commit the core seam**

```bash
git add crates/vault-core/src/lib.rs crates/vault-core/src/graph.rs crates/vault-core/src/resolver.rs crates/vault-core/src/vault_source.rs crates/vault-core/tests/graph_builder.rs crates/vault-core/tests/resolution_catalog.rs
git commit -m "refactor(core): separate graph construction from scanning"
```

---

### Task 2: Add the index crate, cache configuration, and SQLite schema

**Files:**

- Modify: `Cargo.toml`
- Update through Cargo: `Cargo.lock`
- Create: `crates/vault-index/Cargo.toml`
- Create: `crates/vault-index/src/lib.rs`
- Create: `crates/vault-index/src/error.rs`
- Create: `crates/vault-index/src/model.rs`
- Create: `crates/vault-index/src/config.rs`
- Create: `crates/vault-index/src/schema.rs`
- Create: `crates/vault-index/src/schema_v1.sql`
- Create: `crates/vault-index/tests/schema.rs`

**Interfaces:**

- Consumes: `vault-core` domain and semantic types; XDG cache conventions.
- Produces:

```rust
pub const SQL_SCHEMA_VERSION: u32 = 1;
pub const SEMANTIC_FORMAT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Generation(u64);

impl Generation {
    pub fn new(value: u64) -> Self;
    pub fn get(self) -> u64;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IndexLocation {
    Derived,
    Explicit,
}

#[derive(Clone, Debug)]
pub struct IndexConfig {
    pub canonical_vault_root: PathBuf,
    pub vault_identity: String,
    pub index_path: PathBuf,
    pub location: IndexLocation,
}

impl IndexConfig {
    pub fn derived(vault_root: impl AsRef<Path>) -> Result<Self, IndexError>;
    pub fn explicit(
        vault_root: impl AsRef<Path>,
        index_path: impl AsRef<Path>,
    ) -> Result<Self, IndexError>;
}
```

- Internal `IndexStore::open(&IndexConfig) -> Result<IndexStore, IndexError>` configures SQLite and validates metadata.

- [ ] **Step 1: Add the crate and pinned workspace dependencies**

Change the workspace member list and dependencies in the root `Cargo.toml` to include:

```toml
[workspace]
members = [
    "crates/vault-core",
    "crates/vault-index",
    "crates/vault-protocol",
    "crates/vault-server",
]
resolver = "3"

[workspace.dependencies]
base64 = "0.22.1"
clap = { version = "4.6.6", features = ["derive"] }
filetime = "0.2.29"
rusqlite = { version = "0.32.1", features = ["bundled"] }
xdg = "3.0"
```

Keep every existing dependency exactly once.

Create `crates/vault-index/Cargo.toml`:

```toml
[package]
name = "vault-index"
version.workspace = true
edition.workspace = true
rust-version.workspace = true

[dependencies]
base64.workspace = true
blake3.workspace = true
clap.workspace = true
filetime.workspace = true
rusqlite.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
vault-core = { path = "../vault-core" }
xdg.workspace = true

[dev-dependencies]
proptest.workspace = true
tempfile.workspace = true
```

- [ ] **Step 2: Write failing cache and schema tests**

Create `crates/vault-index/tests/schema.rs`:

```rust
use std::fs;

use tempfile::tempdir;
use vault_index::{
    IndexConfig, IndexLocation, SEMANTIC_FORMAT_VERSION, SQL_SCHEMA_VERSION,
    open_index_for_test,
};

#[test]
fn derived_config_uses_xdg_cache_and_binds_the_canonical_vault() {
    let vault = tempdir().expect("vault tempdir");
    let cache = tempdir().expect("cache tempdir");
    let old = std::env::var_os("XDG_CACHE_HOME");
    unsafe { std::env::set_var("XDG_CACHE_HOME", cache.path()) };

    let config = IndexConfig::derived(vault.path()).expect("derived config");

    match old {
        Some(value) => unsafe { std::env::set_var("XDG_CACHE_HOME", value) },
        None => unsafe { std::env::remove_var("XDG_CACHE_HOME") },
    }
    assert_eq!(config.location, IndexLocation::Derived);
    assert!(config.index_path.starts_with(cache.path().join("vaultd/vaults")));
    assert_eq!(
        config.index_path.file_name().and_then(|value| value.to_str()),
        Some("semantic-v1.sqlite3")
    );
    assert!(!config.index_path.starts_with(vault.path()));
}

#[test]
fn schema_records_versions_identity_and_required_pragmas() {
    let vault = tempdir().expect("vault tempdir");
    let index_dir = tempdir().expect("index tempdir");
    let config =
        IndexConfig::explicit(vault.path(), index_dir.path().join("index.sqlite3"))
            .expect("explicit config");
    let connection = open_index_for_test(&config).expect("open schema");

    let user_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("user_version");
    let foreign_keys: u32 = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .expect("foreign_keys");
    let journal_mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .expect("journal_mode");
    let (semantic_version, identity): (u32, String) = connection
        .query_row(
            "SELECT semantic_format_version, vault_identity FROM index_metadata WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("index metadata");

    assert_eq!(user_version, SQL_SCHEMA_VERSION);
    assert_eq!(semantic_version, SEMANTIC_FORMAT_VERSION);
    assert_eq!(identity, config.vault_identity);
    assert_eq!(foreign_keys, 1);
    assert_eq!(journal_mode.to_lowercase(), "wal");
    assert!(fs::metadata(&config.index_path).expect("database exists").is_file());
}
```

Because environment mutation is process-global, keep the first test in this integration binary and do not add another environment-mutating test to the same file. Rust 2024 requires the explicit `unsafe` blocks shown.

- [ ] **Step 3: Run the schema test and verify the intended failure**

Run:

```bash
cargo test -p vault-index --test schema -- --test-threads=1
```

Expected: compilation fails because the crate and exported configuration/schema helpers do not exist.

- [ ] **Step 4: Define index errors and public model primitives**

In `error.rs` define:

```rust
#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("invalid vault root: {0}")]
    InvalidVaultRoot(String),
    #[error("invalid vault path: {0}")]
    InvalidPath(String),
    #[error("index is unavailable")]
    IndexUnavailable,
    #[error("note not found: {0}")]
    NoteNotFound(String),
    #[error("invalid cursor: {0}")]
    InvalidCursor(String),
    #[error("cursor generation {cursor} does not match current generation {current}")]
    GenerationMismatch { cursor: u64, current: u64 },
    #[error("vault changed during refresh")]
    VaultChangedDuringRefresh,
    #[error("incompatible index: {0}")]
    IncompatibleIndex(String),
    #[error("storage failure: {0}")]
    Storage(String),
}
```

Add private conversions from `std::io::Error`, `rusqlite::Error`, and `serde_json::Error` to `Storage` without exposing underlying error types publicly.

In `model.rs` implement `Generation` exactly as declared in the Interfaces block. Reject database values below zero when converting from `i64`.

- [ ] **Step 5: Implement canonical identity and XDG path selection**

In `config.rs`:

```rust
fn canonical_root(root: &Path) -> Result<PathBuf, IndexError> {
    let canonical = root
        .canonicalize()
        .map_err(|error| IndexError::InvalidVaultRoot(format!("{}: {error}", root.display())))?;
    if !canonical.is_dir() {
        return Err(IndexError::InvalidVaultRoot(format!(
            "{} is not a directory",
            root.display()
        )));
    }
    if canonical.to_str().is_none() {
        return Err(IndexError::InvalidVaultRoot(
            "vault root must be valid UTF-8".into(),
        ));
    }
    Ok(canonical)
}

fn identity_for(canonical: &Path) -> String {
    blake3::hash(canonical.to_string_lossy().as_bytes())
        .to_hex()
        .to_string()
}
```

`IndexConfig::derived` uses `xdg::BaseDirectories::with_prefix("vaultd")` and:

```rust
let index_path = xdg
    .get_cache_file(format!("vaults/{vault_identity}/semantic-v1.sqlite3"));
```

`IndexConfig::explicit` preserves the supplied index path but records `IndexLocation::Explicit`. Neither constructor creates a file inside the vault.

- [ ] **Step 6: Create the complete normalized schema**

Create `schema_v1.sql` with:

```sql
CREATE TABLE index_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    semantic_format_version INTEGER NOT NULL,
    vault_identity TEXT NOT NULL,
    generation INTEGER,
    created_at_unix_ms INTEGER NOT NULL,
    refreshed_at_unix_ms INTEGER,
    last_refresh_error TEXT
);

CREATE TABLE notes (
    path TEXT PRIMARY KEY,
    content_revision TEXT NOT NULL,
    source_bytes BLOB NOT NULL,
    filename_comparison_key TEXT NOT NULL,
    stem_comparison_key TEXT NOT NULL,
    observed_size INTEGER NOT NULL CHECK (observed_size >= 0),
    observed_mtime_seconds INTEGER NOT NULL,
    observed_mtime_nanos INTEGER NOT NULL
        CHECK (observed_mtime_nanos >= 0 AND observed_mtime_nanos < 1000000000)
);

CREATE TABLE properties (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    key_text TEXT NOT NULL,
    value_json TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    key_span_start INTEGER NOT NULL,
    key_span_end INTEGER NOT NULL,
    value_span_start INTEGER NOT NULL,
    value_span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE aliases (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    value TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE headings (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    level INTEGER NOT NULL,
    text TEXT NOT NULL,
    comparison_key TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE blocks (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    identifier TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE tags (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    value TEXT NOT NULL,
    comparison_key TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE note_references (
    id INTEGER PRIMARY KEY,
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    raw_target TEXT NOT NULL,
    file_target TEXT,
    subpath_kind TEXT,
    subpath_value TEXT,
    display TEXT,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    target_span_start INTEGER NOT NULL,
    target_span_end INTEGER NOT NULL,
    UNIQUE (note_path, ordinal)
);

CREATE TABLE resolutions (
    reference_id INTEGER PRIMARY KEY
        REFERENCES note_references(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_path TEXT,
    subpath_kind TEXT,
    subpath_value TEXT
);

CREATE TABLE resolution_candidates (
    reference_id INTEGER NOT NULL
        REFERENCES note_references(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    candidate_path TEXT NOT NULL,
    PRIMARY KEY (reference_id, ordinal)
);

CREATE TABLE note_diagnostics (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    path TEXT,
    span_start INTEGER,
    span_end INTEGER,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE scan_diagnostics (
    ordinal INTEGER PRIMARY KEY,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    path TEXT,
    span_start INTEGER,
    span_end INTEGER
);

CREATE TABLE diagnostics (
    id INTEGER PRIMARY KEY,
    ordinal INTEGER NOT NULL,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    path TEXT,
    span_start INTEGER,
    span_end INTEGER
);

CREATE INDEX headings_lookup ON headings(note_path, comparison_key);
CREATE INDEX blocks_lookup ON blocks(note_path, identifier);
CREATE INDEX tags_lookup ON tags(comparison_key, note_path, ordinal);
CREATE INDEX notes_filename_lookup ON notes(filename_comparison_key, path);
CREATE INDEX notes_stem_lookup ON notes(stem_comparison_key, path);
CREATE INDEX references_source_order
    ON note_references(note_path, span_start, span_end, id);
CREATE INDEX resolutions_target
    ON resolutions(target_path, kind, reference_id);
CREATE INDEX resolutions_kind
    ON resolutions(kind, reference_id);
CREATE INDEX diagnostics_path_order
    ON diagnostics(path, span_start, span_end, code, message, id);
CREATE INDEX diagnostics_severity_order
    ON diagnostics(severity, path, span_start, span_end, id);
```

`schema.rs` must create only the index parent directory, open the connection, set `foreign_keys = ON`, a five-second busy timeout, `journal_mode = WAL`, and `synchronous = NORMAL`, set `PRAGMA user_version = 1`, insert the singleton metadata row with a nullable generation, run `PRAGMA optimize` after initial schema creation, and validate schema version, semantic version, and vault identity on later opens.

Expose `open_index_for_test` under `#[doc(hidden)]` so integration tests inspect the real configuration path.

- [ ] **Step 7: Run schema and workspace tests**

Run:

```bash
cargo test -p vault-index --test schema -- --test-threads=1
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: schema tests pass, the crate builds under the workspace MSRV, and prior crates remain green.

- [ ] **Step 8: Commit the index foundation**

```bash
git add Cargo.toml Cargo.lock crates/vault-index
git commit -m "feat(index): add sqlite cache foundation"
```

---

### Task 3: Round-trip exact parsed semantics through normalized rows

**Files:**

- Create: `crates/vault-index/src/codec.rs`
- Create: `crates/vault-index/src/store.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Create: `crates/vault-index/tests/common/mod.rs`
- Create: `crates/vault-index/tests/round_trip.rs`

**Interfaces:**

- Consumes: `IndexStore`, `FileFingerprint`, all public `vault-core` parsed-note and resolution values.
- Produces internal storage methods:

```rust
impl IndexStore {
    pub(crate) fn replace_note(
        transaction: &rusqlite::Transaction<'_>,
        note: &ParsedNote,
        fingerprint: FileFingerprint,
    ) -> Result<(), IndexError>;

    pub(crate) fn load_note(&self, path: &VaultPath)
        -> Result<Option<ParsedNote>, IndexError>;

    pub(crate) fn load_all_notes(&self)
        -> Result<Vec<ParsedNote>, IndexError>;

    pub(crate) fn replace_graph_rows(
        transaction: &rusqlite::Transaction<'_>,
        graph: &SemanticGraph,
        scan_diagnostics: &[Diagnostic],
        diagnostics: &[Diagnostic],
    ) -> Result<(), IndexError>;
}
```

- [ ] **Step 1: Define the fingerprint and write failing round-trip tests**

Add to `model.rs`:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileFingerprint {
    pub size: u64,
    pub modified_seconds: i64,
    pub modified_nanos: u32,
}
```

Create `tests/common/mod.rs` with helpers that open a temporary explicit index and parse `fixtures/semantic-read-path/basic-vault` through `scan_vault`.

Create `tests/round_trip.rs`:

```rust
mod common;

use vault_core::VaultPath;
use vault_index::FileFingerprint;

#[test]
fn parsed_note_round_trip_preserves_source_semantics_spans_and_order() {
    let mut fixture = common::open_fixture_store();
    let path = VaultPath::new("Properties and aliases.md").expect("valid path");
    let original = fixture
        .scan
        .graph
        .note(&path)
        .expect("fixture note")
        .clone();
    let fingerprint = FileFingerprint {
        size: original.source.text().len() as u64,
        modified_seconds: 123,
        modified_nanos: 456,
    };

    fixture
        .store
        .write_note_for_test(&original, fingerprint)
        .expect("persist note");
    let loaded = fixture
        .store
        .load_note_for_test(&path)
        .expect("load note")
        .expect("stored note");

    assert_eq!(loaded.source, original.source);
    assert_eq!(loaded.properties, original.properties);
    assert_eq!(loaded.aliases, original.aliases);
    assert_eq!(loaded.headings, original.headings);
    assert_eq!(loaded.blocks, original.blocks);
    assert_eq!(loaded.tags, original.tags);
    assert_eq!(loaded.references, original.references);
    assert_eq!(loaded.diagnostics, original.diagnostics);
}

#[test]
fn graph_round_trip_preserves_resolutions_candidates_and_diagnostics() {
    let mut fixture = common::open_fixture_store();
    fixture.persist_complete_fixture().expect("persist graph");
    let loaded = fixture.store.load_graph_for_test().expect("load graph");

    assert_eq!(loaded.diagnostics, fixture.scan.diagnostics);
    for path in fixture.scan.graph.note_paths() {
        assert_eq!(loaded.graph.outgoing(path), fixture.scan.graph.outgoing(path));
        assert_eq!(loaded.graph.backlinks(path), fixture.scan.graph.backlinks(path));
    }
    assert_eq!(loaded.graph.unresolved(), fixture.scan.graph.unresolved());
    assert_eq!(loaded.graph.ambiguous(), fixture.scan.graph.ambiguous());
}
```

The `#[doc(hidden)]` test helpers must call the same private store functions used by reconciliation rather than contain a second persistence implementation.

- [ ] **Step 2: Run the round-trip test and verify the intended failure**

Run:

```bash
cargo test -p vault-index --test round_trip
```

Expected: compilation fails because note/graph persistence and test facades do not exist.

- [ ] **Step 3: Implement a lossless private property-value codec**

In `codec.rs` define:

```rust
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
enum StoredPropertyValue {
    Null,
    Boolean(bool),
    Integer(i64),
    FloatBits(u64),
    String(String),
    Sequence(Vec<StoredSpannedValue>),
    Mapping(Vec<StoredMappingEntry>),
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredSpan {
    start: usize,
    end: usize,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredSpannedValue {
    value: StoredPropertyValue,
    span: StoredSpan,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredMappingEntry {
    key: String,
    key_span: StoredSpan,
    value: StoredSpannedValue,
}
```

Use `f64::to_bits` and `f64::from_bits`. Validate every decoded span through `SourceSpan::new` and every decoded path/revision through public core constructors. Never deserialize unvalidated SQLite integers with unchecked `as` casts.

Add private exhaustive string codecs for `DiagnosticCode`, `Severity`, `ReferenceKind`, `ReferenceOrigin`, `Subpath`, and `Resolution`. Reject unknown stored strings with `IndexError::IncompatibleIndex`.

- [ ] **Step 4: Implement transactional note row replacement and reconstruction**

In `store.rs`:

1. Delete the existing `notes` row for the path so foreign-key cascades clear child source rows.
2. Insert exact `source.text().as_bytes()`, revision, lowercased filename/stem comparison keys using the same spelling rules as `Resolver`, and fingerprint.
3. Insert every property, alias, heading, block, tag, reference, and `note_diagnostics` parse row with its stable ordinal.
4. Reconstruct a `SourceDocument` from `source_bytes` and require its derived revision to equal the stored revision.
5. Reconstruct all children ordered by `ordinal`.

Use checked conversion helpers:

```rust
fn usize_to_i64(value: usize, field: &str) -> Result<i64, IndexError>;
fn u64_to_i64(value: u64, field: &str) -> Result<i64, IndexError>;
fn i64_to_usize(value: i64, field: &str) -> Result<usize, IndexError>;
```

- [ ] **Step 5: Persist and reload graph-wide rows**

`replace_graph_rows` deletes prior resolution, candidate, `scan_diagnostics`, and aggregate `diagnostics` rows inside the publication transaction; maps each `ResolvedReference` to its source `(note_path, ordinal)`; inserts deterministic resolution/candidate rows; stores the reconciler's pre-graph scan diagnostics in `scan_diagnostics`; and inserts complete `ScanReport::diagnostics` order. `load_note` reconstructs only the owning `note_diagnostics` rows, warm reconciliation compares the dedicated scan rows, and global diagnostic queries read the aggregate table.

`load_graph_for_test` loads parsed notes, rebuilds through `build_graph`, and verifies that the persisted resolution/diagnostic rows equal the rebuilt public graph. It is a verification facade, not the production query path.

- [ ] **Step 6: Run focused tests and validate foreign keys**

Run:

```bash
cargo test -p vault-index --test round_trip
cargo test -p vault-index --test schema
cargo test -p vault-index --all-targets
```

Expected: all semantic fixture values round-trip exactly, and deleting a note leaves no orphan child, resolution, candidate, or parse-diagnostic row.

- [ ] **Step 7: Commit semantic persistence**

```bash
git add crates/vault-index/src crates/vault-index/tests/common crates/vault-index/tests/round_trip.rs
git commit -m "feat(index): persist semantic graph rows"
```

---

### Task 4: Inventory vault files without reading unchanged bodies

**Files:**

- Create: `crates/vault-index/src/inventory.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Create: `crates/vault-index/tests/inventory.rs`

**Interfaces:**

- Consumes: `FileSystemVaultSource::markdown_paths`, `read_bytes`, and `canonical_root`.
- Produces:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InventoryEntry {
    pub path: VaultPath,
    pub fingerprint: FileFingerprint,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InventorySnapshot {
    pub entries: BTreeMap<VaultPath, FileFingerprint>,
    pub diagnostics: Vec<Diagnostic>,
}

pub trait ReconcileSource {
    fn canonical_root(&self) -> &Path;
    fn inventory(&self) -> Result<InventorySnapshot, IndexError>;
    fn read_bytes(&self, path: &VaultPath) -> Result<Vec<u8>, ScanError>;
}

pub struct FileSystemIndexSource {
    source: FileSystemVaultSource,
}

impl FileSystemIndexSource {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, IndexError>;
}
```

- [ ] **Step 1: Write failing filesystem inventory tests**

Create `crates/vault-index/tests/inventory.rs`:

```rust
use std::fs;

use tempfile::tempdir;
use vault_core::VaultPath;
use vault_index::{FileSystemIndexSource, ReconcileSource};

#[test]
fn inventory_is_sorted_and_contains_only_lightweight_fingerprints() {
    let vault = tempdir().expect("vault tempdir");
    fs::create_dir_all(vault.path().join("Folder")).expect("create folder");
    fs::create_dir_all(vault.path().join(".obsidian")).expect("create hidden folder");
    fs::write(vault.path().join("z.md"), b"# Z").expect("write z");
    fs::write(vault.path().join("Folder/a.md"), b"# A").expect("write a");
    fs::write(vault.path().join(".obsidian/ignored.md"), b"# ignored")
        .expect("write ignored");

    let source = FileSystemIndexSource::new(vault.path()).expect("index source");
    let snapshot = source.inventory().expect("inventory");
    let paths: Vec<_> = snapshot.entries.keys().map(VaultPath::as_str).collect();

    assert_eq!(paths, vec!["Folder/a.md", "z.md"]);
    assert_eq!(snapshot.entries[&VaultPath::new("z.md").unwrap()].size, 3);
}

#[test]
fn reading_is_explicit_and_reuses_core_containment_checks() {
    let vault = tempdir().expect("vault tempdir");
    fs::write(vault.path().join("Note.md"), b"exact bytes").expect("write note");
    let source = FileSystemIndexSource::new(vault.path()).expect("index source");

    assert_eq!(
        source
            .read_bytes(&VaultPath::new("Note.md").unwrap())
            .expect("read note"),
        b"exact bytes"
    );
}
```

- [ ] **Step 2: Run the inventory test and verify the intended failure**

Run:

```bash
cargo test -p vault-index --test inventory
```

Expected: compilation fails because inventory types and `FileSystemIndexSource` do not exist.

- [ ] **Step 3: Implement inventory as a wrapper around core enumeration**

`FileSystemIndexSource::inventory` must:

1. call the existing `FileSystemVaultSource::markdown_paths` so hidden-directory and symlink policy remains single-sourced;
2. call `std::fs::metadata(source.root().join(path.as_str()))` for each returned path;
3. derive modification components through `filetime::FileTime::from_last_modification_time`:

```rust
let modified = filetime::FileTime::from_last_modification_time(&metadata);
let fingerprint = FileFingerprint {
    size: metadata.len(),
    modified_seconds: modified.unix_seconds(),
    modified_nanos: modified.nanoseconds(),
};
```

4. retain listing and metadata failures as sorted diagnostics when a usable path exists;
5. never call `read_bytes` from `inventory`.

Delegate `ReconcileSource::read_bytes` to the core source so canonical containment is checked again at read time and per-file `ScanError::UnreadableFile` can remain a diagnostic rather than abort the entire vault.

- [ ] **Step 4: Add an instrumented-source unit test**

Inside `inventory.rs` under `#[cfg(test)]`, define a small `CountingSource` implementation whose `inventory` increments one counter and whose `read_bytes` increments another. Assert that taking two inventories leaves the body-read count at zero. This counter becomes the fast-startup proof used by Task 6.

- [ ] **Step 5: Run inventory and core filesystem tests**

Run:

```bash
cargo test -p vault-index --test inventory
cargo test -p vault-index inventory
cargo test -p vault-core --test vault_source
```

Expected: all pass; vault inclusion and containment behavior remain owned by `vault-core`.

- [ ] **Step 6: Commit inventory support**

```bash
git add crates/vault-index/src/inventory.rs crates/vault-index/src/lib.rs crates/vault-index/tests/inventory.rs
git commit -m "feat(index): inventory vault fingerprints"
```

---

### Task 5: Build and atomically publish the first generation

**Files:**

- Create: `crates/vault-index/src/reconcile.rs`
- Modify: `crates/vault-index/src/store.rs`
- Modify: `crates/vault-index/src/model.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Create: `crates/vault-index/tests/cold_reconciliation.rs`

**Interfaces:**

- Consumes: `IndexConfig`, `IndexStore`, `ReconcileSource`, `build_graph`, `parse_note`, persisted note/graph methods.
- Produces:

```rust
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

pub struct IndexService {
    config: IndexConfig,
    store: IndexStore,
    source: Box<dyn ReconcileSource>,
    resolver: Option<(Generation, Resolver)>,
}

impl IndexService {
    pub fn open(config: IndexConfig) -> Result<Self, IndexError>;
    pub fn open_with_source(
        config: IndexConfig,
        source: Box<dyn ReconcileSource>,
    ) -> Result<Self, IndexError>;
    pub fn current_generation(&self) -> Result<Option<Generation>, IndexError>;
    pub fn refresh(&mut self, verify: bool) -> Result<RefreshReport, IndexError>;
}
```

- Internal `IndexStore::publish(expected_generation, snapshot, graph, counts)` performs one compare-and-swap transaction.
- `open_with_source` canonicalizes/compares `source.canonical_root()` with `config.canonical_vault_root` and returns `InvalidVaultRoot` on any mismatch; a test source cannot redirect reads after index identity validation.
- A `#[doc(hidden)] IndexService::snapshot_for_test() -> Result<ScanReport, IndexError>` delegates to Task 3's production row decoders and graph verification facade; it never scans the vault.

- [ ] **Step 1: Write failing cold-build tests**

Create `crates/vault-index/tests/cold_reconciliation.rs`:

```rust
mod common;

use std::fs;

use tempfile::tempdir;
use vault_index::{Generation, IndexConfig, IndexService};

#[test]
fn cold_refresh_publishes_generation_one_atomically() {
    let vault = tempdir().expect("vault tempdir");
    let index = tempdir().expect("index tempdir");
    fs::write(vault.path().join("A.md"), "# A\n[[B]]\n").expect("write A");
    fs::write(vault.path().join("B.md"), "# B\n").expect("write B");
    let config =
        IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
            .expect("config");
    let mut service = IndexService::open(config).expect("open service");

    assert_eq!(service.current_generation().expect("generation"), None);
    let report = service.refresh(false).expect("cold refresh");

    assert_eq!(report.previous_generation, None);
    assert_eq!(report.generation, Generation::new(1));
    assert_eq!(report.added, 2);
    assert_eq!(report.reparsed, 2);
    assert_eq!(service.current_generation().unwrap(), Some(Generation::new(1)));
    let snapshot = service.snapshot_for_test().expect("stored graph");
    let a = snapshot
        .graph
        .note(&vault_core::VaultPath::new("A.md").unwrap())
        .expect("stored A");
    assert_eq!(a.source.text(), "# A\n[[B]]\n");
    assert_eq!(
        snapshot
            .graph
            .outgoing(&vault_core::VaultPath::new("A.md").unwrap())
            .len(),
        1
    );
}

#[test]
fn fixture_cold_build_matches_the_core_scan_oracle() {
    let mut fixture = common::open_fixture_service();
    let report = fixture.service.refresh(false).expect("cold refresh");
    let indexed = fixture.service.snapshot_for_test().expect("indexed snapshot");

    assert_eq!(report.generation, Generation::new(1));
    common::assert_semantically_equivalent(&indexed, &fixture.scan);
    common::assert_vault_digest_unchanged(&fixture);
}
```

Add the referenced service, snapshot, equivalence, and digest helpers to `tests/common/mod.rs`. The equivalence helper compares every public note field, outgoing reference, backlink, unresolved/ambiguous set, and diagnostic in deterministic order.

- [ ] **Step 2: Run the cold-build test and verify the intended failure**

Run:

```bash
cargo test -p vault-index --test cold_reconciliation
```

Expected: compilation fails because `RefreshReport`, `IndexService`, publication, and test queries do not exist.

- [ ] **Step 3: Implement cold reconciliation before general incremental logic**

For a database with no generation:

```rust
let first = self.source.inventory()?;
let mut notes = Vec::with_capacity(first.entries.len());
let mut diagnostics = first.diagnostics.clone();
for (path, fingerprint) in &first.entries {
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
let report = build_graph(
    notes.iter().map(|(note, _)| note.clone()).collect(),
    diagnostics.clone(),
);
let second = self.source.inventory()?;
if first != second {
    return Err(IndexError::VaultChangedDuringRefresh);
}
```

Pass the notes, fingerprints, graph, pre-graph scan diagnostics, complete report diagnostics, and expected `None` generation to a single publication transaction. Do not open a transaction during filesystem reads or parsing.

- [ ] **Step 4: Implement compare-and-swap publication**

Inside one `rusqlite::Transaction`:

1. re-read `index_metadata.generation`;
2. require it to equal the caller's expected generation;
3. replace added/changed/deleted note rows;
4. replace graph-wide resolution/candidate/diagnostic rows;
5. write `generation = 1` for the first build;
6. set `refreshed_at_unix_ms` and clear `last_refresh_error`;
7. commit.

Return a private `PublishOutcome::GenerationChanged` if another process advanced the generation between build and commit. The reconciler will retry in Task 6.

After a successful publish, build `Resolver::from_catalog` from lightweight note metadata loaded from the database and store it with the committed generation in `IndexService.resolver`. Opening an existing complete index and an unchanged refresh must also load this catalog if the cached tuple is absent or names another generation.

- [ ] **Step 5: Run cold-build and persistence tests**

Run:

```bash
cargo test -p vault-index --test cold_reconciliation
cargo test -p vault-index --test round_trip
cargo test -p vault-index --all-targets
```

Expected: generation 1 appears only after complete publication; fixture source digests are unchanged.

- [ ] **Step 6: Commit cold reconciliation**

```bash
git add crates/vault-index/src crates/vault-index/tests/common crates/vault-index/tests/cold_reconciliation.rs
git commit -m "feat(index): publish cold semantic generations"
```

---

### Task 6: Reconcile incrementally, verify content, and recover safely

**Files:**

- Modify: `crates/vault-index/src/schema.rs`
- Modify: `crates/vault-index/src/store.rs`
- Modify: `crates/vault-index/src/reconcile.rs`
- Modify: `crates/vault-index/src/model.rs`
- Create: `crates/vault-index/tests/incremental_reconciliation.rs`
- Create: `crates/vault-index/tests/recovery.rs`

**Interfaces:**

- Consumes: Task 5 `IndexService::refresh` and compare-and-swap publisher.
- Produces complete normal/verified incremental behavior, `IndexState`, and refresh-failure recording:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IndexState {
    Ready,
    Stale { last_error: String },
    Unavailable { last_error: Option<String> },
}

impl IndexService {
    pub fn state(&self) -> Result<IndexState, IndexError>;
    pub fn record_refresh_failure(&mut self, error: &IndexError)
        -> Result<(), IndexError>;
}
```

- [ ] **Step 1: Write the incremental behavior matrix as failing tests**

Create `incremental_reconciliation.rs` with one focused test for each row:

| Change | Normal body reads | Normal parses | Verified body reads | Generation |
| --- | ---: | ---: | ---: | --- |
| none | 0 | 0 | all | unchanged |
| metadata-only touch | 1 | 0 | all | unchanged |
| content edit | 1 | 1 | all | +1 |
| add | 1 | 1 | all | +1 |
| delete | 0 | 0 | all remaining | +1 |
| same-size/same-mtime edit | 0 | 0 | all | normal unchanged, verified +1 |

Use a `CountingSource` in `tests/common/mod.rs` for body-read counts and assert `RefreshReport::reparsed` for parse counts. Use `filetime::FileTime::from_last_modification_time` plus `filetime::set_file_mtime` for the same-size/same-mtime integration case.

The key unchanged-startup test must assert:

```rust
#[test]
fn unchanged_normal_refresh_reads_and_parses_no_bodies() {
    let mut fixture = common::counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.reset_counts();

    let report = fixture.service.refresh(false).expect("warm refresh");

    assert_eq!(fixture.body_reads(), 0);
    assert_eq!(report.reparsed, 0);
    assert_eq!(report.previous_generation, Some(report.generation));
    assert_eq!(report.unchanged, 2);
}
```

- [ ] **Step 2: Run the incremental test and verify failures**

Run:

```bash
cargo test -p vault-index --test incremental_reconciliation
```

Expected: the cold-only implementation fails the warm-path and change-matrix cases.

- [ ] **Step 3: Implement inventory diffing and content-revision reuse**

Add a private diff:

```rust
struct InventoryDiff {
    added: Vec<VaultPath>,
    metadata_changed: Vec<VaultPath>,
    deleted: Vec<VaultPath>,
    unchanged: Vec<VaultPath>,
}
```

Normal refresh:

- load stored fingerprints and notes;
- compare current inventory diagnostics with the stored scan-diagnostic component; a diagnostic-only change rebuilds/publishes graph diagnostics without reading unchanged bodies;
- skip reads for `unchanged`;
- read `added` and `metadata_changed`;
- construct a `SourceDocument` to obtain its revision before parsing;
- reuse the stored `ParsedNote` when the revision is identical;
- parse only a new revision.

An unreadable or invalid-UTF-8 changed file is excluded from the candidate note set and contributes the same structured core diagnostic as `read_documents`. If that path had an older indexed note, publication removes the stale note. A per-file content failure does not abort other notes; an inaccessible root remains a refresh error.

Verified refresh reads every current path, compares content revisions, and parses only new revisions. It still uses the initial and final inventories as a race check.

For any client-visible change, combine changed parsed notes with unchanged `ParsedNote` values loaded from SQLite, call `build_graph` once for the complete usable note set, and replace all resolution/candidate/aggregate-diagnostic rows in the publication transaction. Never reparse an unchanged note to recompute global resolution.

If only fingerprints/refreshed time changed, update those operational fields transactionally without advancing the semantic generation or invalidating cursors.

Every successful refresh, including an unchanged refresh, updates `refreshed_at_unix_ms` and clears `last_refresh_error` without changing generation unless client-visible semantic or diagnostic state changed.

Run `PRAGMA optimize` after a cold build and after any reconciliation that replaces at least 1,000 note or relationship rows. Do not run `ANALYZE` unconditionally on unchanged startup.

- [ ] **Step 4: Implement stable snapshot checks and concurrent publication retry**

At the end of every changed or verified reconciliation, take a second inventory. Any difference in paths, fingerprints, or scan diagnostics returns `VaultChangedDuringRefresh` and publishes nothing.

On `PublishOutcome::GenerationChanged`, discard the built snapshot and retry from the current database state. Use:

```rust
const MAX_RECONCILE_RETRIES: usize = 3;
```

After three compare-and-swap losses, return `IndexError::Storage("concurrent refresh did not stabilize".into())`. Never publish a graph built from a stale database generation.

- [ ] **Step 5: Write failing rollback and recovery tests**

Create `recovery.rs`:

```rust
mod common;

use std::fs;

use tempfile::tempdir;
use vault_index::{Generation, IndexConfig, IndexError, IndexService, IndexState};

#[test]
fn vault_change_between_inventories_preserves_previous_generation() {
    let mut fixture = common::source_that_changes_on_second_inventory();
    fixture.service.refresh(false).expect("initial build");
    fixture.arm_change();

    let error = fixture.service.refresh(false).expect_err("refresh must fail");

    assert!(matches!(error, IndexError::VaultChangedDuringRefresh));
    assert_eq!(
        fixture.service.current_generation().unwrap(),
        Some(Generation::new(1))
    );
}

#[test]
fn wrong_vault_explicit_index_is_refused() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let index_dir = tempdir().unwrap();
    let index = index_dir.path().join("shared.sqlite3");
    let first_config = IndexConfig::explicit(first.path(), &index).unwrap();
    IndexService::open(first_config).unwrap();

    let second_config = IndexConfig::explicit(second.path(), &index).unwrap();
    let error = match IndexService::open(second_config) {
        Ok(_) => panic!("wrong-vault index must be refused"),
        Err(error) => error,
    };

    assert!(matches!(error, IndexError::IncompatibleIndex(_)));
}

#[test]
fn failed_refresh_with_a_generation_becomes_stale_but_readable() {
    let mut fixture = common::service_with_injected_refresh_failure();
    fixture.service.refresh(false).expect("initial build");
    let error = fixture.service.refresh(false).expect_err("injected failure");
    fixture.service.record_refresh_failure(&error).unwrap();

    assert!(matches!(fixture.service.state().unwrap(), IndexState::Stale { .. }));
    assert!(fixture.service.snapshot_for_test().is_ok());
}
```

Also test:

- missing cache builds cleanly;
- derived cache containing non-SQLite bytes is replaced and rebuilt;
- explicit corrupt cache returns `IncompatibleIndex`;
- SQL/semantic version mismatch rebuilds derived data;
- a publication failure injected immediately before commit leaves all old rows and generation intact;
- two services racing from the same expected generation force one compare-and-swap retry and converge on one complete semantic generation without lost rows;
- no completed generation yields `IndexState::Unavailable` and indexed queries return `IndexUnavailable`.

- [ ] **Step 6: Implement derived-cache rebuild and failure-state policy**

`schema.rs` distinguishes `IndexLocation::Derived` from `Explicit`:

- missing: create;
- compatible: open;
- obsolete schema/semantic version with the expected vault identity: rebuild at either derived or explicit index path;
- corrupt derived cache: close, replace only that derived cache file, recreate schema;
- wrong recorded vault identity: always `IncompatibleIndex`;
- corrupt explicit path: `IncompatibleIndex`.

Rebuild helpers must validate that the target equals `config.index_path` and is outside `config.canonical_vault_root` before replacing it. For a corrupt derived database, close every connection and replace only the exact main file plus its exact `-wal` and `-shm` sidecars if present; do not glob or recurse. Never accept a broad directory, unresolved environment variable, or vault-relative target. An obsolete readable database may drop/recreate derived tables in one controlled transaction after identity validation.

`record_refresh_failure` stores only the stable display message. It does not advance generation. `state` is `Stale` when a generation exists and `Unavailable` otherwise.

- [ ] **Step 7: Run the reconciliation and recovery suite**

Run:

```bash
cargo test -p vault-index --test incremental_reconciliation
cargo test -p vault-index --test recovery
cargo test -p vault-index --all-targets
```

Expected: the full matrix, rollback, rebuild, identity, and stale-read tests pass.

- [ ] **Step 8: Commit incremental reconciliation**

```bash
git add crates/vault-index/src crates/vault-index/tests/incremental_reconciliation.rs crates/vault-index/tests/recovery.rs crates/vault-index/tests/common
git commit -m "feat(index): reconcile vault changes incrementally"
```

---

### Task 7: Add generation-aware indexed queries and opaque cursors

**Files:**

- Create: `crates/vault-index/src/cursor.rs`
- Create: `crates/vault-index/src/query.rs`
- Modify: `crates/vault-index/src/model.rs`
- Modify: `crates/vault-index/src/store.rs`
- Modify: `crates/vault-index/src/reconcile.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Create: `crates/vault-index/tests/queries.rs`

**Interfaces:**

- Consumes: a complete current generation, normalized rows, cached `Resolver` catalog.
- Produces:

```rust
pub const DEFAULT_PAGE_LIMIT: u32 = 100;
pub const MAX_PAGE_LIMIT: u32 = 1_000;

#[derive(Clone, Debug, PartialEq)]
pub struct Page<T> {
    pub generation: Generation,
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteSummary {
    pub path: VaultPath,
    pub revision: Revision,
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndexedNote {
    pub generation: Generation,
    pub note: ParsedNote,
    pub diagnostics: Vec<Diagnostic>,
    pub outgoing: Vec<ResolvedReference>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceStatus {
    Resolved,
    Unresolved,
    Ambiguous,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultInfo {
    pub canonical_root: PathBuf,
    pub vault_identity: String,
    pub state: IndexState,
    pub generation: Generation,
    pub note_count: u64,
    pub refreshed_at_unix_ms: Option<u64>,
}

impl IndexService {
    pub fn vault_info(&self) -> Result<VaultInfo, IndexError>;
    pub fn list_notes(&self, cursor: Option<&str>, limit: Option<u32>)
        -> Result<Page<NoteSummary>, IndexError>;
    pub fn get_note(&self, path: &VaultPath) -> Result<IndexedNote, IndexError>;
    pub fn resolve_link(
        &mut self,
        source: &VaultPath,
        destination: &str,
    ) -> Result<(Generation, Resolution), IndexError>;
    pub fn get_backlinks(
        &self,
        path: &VaultPath,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Page<ResolvedReference>, IndexError>;
    pub fn list_references(
        &self,
        source: Option<&VaultPath>,
        status: Option<ReferenceStatus>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Page<ResolvedReference>, IndexError>;
    pub fn get_diagnostics(
        &self,
        path: Option<&VaultPath>,
        severity: Option<Severity>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Page<Diagnostic>, IndexError>;
}
```

- [ ] **Step 1: Write failing query and cursor tests**

Create `queries.rs` and build a three-note fixture with resolved, unresolved, ambiguous, and missing-subpath references. Cover every public query. Include:

```rust
#[test]
fn pagination_is_stable_and_rejects_a_cursor_after_generation_changes() {
    let mut fixture = common::service_with_many_notes(5);
    fixture.service.refresh(false).expect("initial refresh");
    let first = fixture
        .service
        .list_notes(None, Some(2))
        .expect("first page");
    assert_eq!(first.items.len(), 2);
    let cursor = first.next_cursor.expect("next cursor");

    fixture.add_note("ZZZ.md", "# changed");
    fixture.service.refresh(false).expect("next generation");
    let error = fixture
        .service
        .list_notes(Some(&cursor), Some(2))
        .expect_err("mixed generation must fail");

    assert!(matches!(error, IndexError::GenerationMismatch { .. }));
}

#[test]
fn get_note_returns_exact_source_semantics_diagnostics_and_resolutions() {
    let mut fixture = common::open_fixture_service();
    fixture.service.refresh(false).expect("refresh");
    let path = VaultPath::new("Wikilinks.md").unwrap();
    let indexed = fixture.service.get_note(&path).expect("indexed note");
    let oracle = fixture.scan.graph.note(&path).expect("oracle note");

    assert_eq!(&indexed.note, oracle);
    assert_eq!(indexed.outgoing, fixture.scan.graph.outgoing(&path));
    assert_eq!(
        indexed.diagnostics,
        fixture
            .scan
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.path.as_ref() == Some(&path))
            .cloned()
            .collect::<Vec<_>>()
    );
}
```

Also assert:

- summaries sort by path and choose string `title` property before first heading;
- limit zero and above 1,000 return `InvalidCursor`;
- backlinks include missing-subpath references to the resolved file;
- resolved filtering includes `Resolved` and `MissingSubpath`;
- non-vault references are excluded from `list_references`;
- diagnostics path/severity filters preserve stable order;
- `resolve_link` matches the existing core fixture resolution;
- after resetting a `CountingSource`, every query leaves its body-read count at zero;
- a missing exact path returns `NoteNotFound`;
- a query without a generation returns `IndexUnavailable`.

- [ ] **Step 2: Run the query test and verify the intended failure**

Run:

```bash
cargo test -p vault-index --test queries
```

Expected: compilation fails because query models, cursor code, and public methods do not exist.

- [ ] **Step 3: Implement cursor encoding and validation**

In `cursor.rs`:

```rust
#[derive(serde::Serialize, serde::Deserialize)]
struct CursorPayload {
    generation: u64,
    query: String,
    position: CursorPosition,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CursorPosition {
    Note { path: String },
    Reference { source: String, start: u64, end: u64, id: i64 },
    Diagnostic {
        path: Option<String>,
        start: Option<u64>,
        end: Option<u64>,
        code: String,
        message: String,
        id: i64,
    },
}
```

Serialize to JSON bytes and encode with:

```rust
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload)?);
```

Decode strictly. Reject malformed base64/JSON, the wrong cursor position for an operation, a query fingerprint that does not match all filters, and invalid keys as `InvalidCursor`. Check generation before running the page SQL and return `GenerationMismatch` with both values.

- [ ] **Step 4: Implement all reads in one SQLite snapshot**

Each query:

1. opens a read transaction;
2. reads and validates current generation;
3. decodes and validates the cursor;
4. executes prepared SQL ordered by the cursor's complete stable key;
5. requests `limit + 1` rows to determine `next_cursor`;
6. reconstructs public core values through the Task 3 codecs;
7. returns the same transaction generation with the data.

`get_note` loads the parsed note, all diagnostics for its path, and outgoing resolution rows. Mutable `resolve_link` uses the generation-matched in-memory `Resolver`; if its cached generation differs from the database generation, rebuild the lightweight catalog before resolving.

Do not load or rebuild a complete `SemanticGraph` for a warm read.

- [ ] **Step 5: Add query-plan assertions**

In `queries.rs`, use the real connection test facade and `EXPLAIN QUERY PLAN` for:

- `notes WHERE path > ? ORDER BY path LIMIT ?`;
- backlink join by `resolutions.target_path`;
- reference status join by `resolutions.kind`;
- diagnostic path/severity page.

Assert the details use the `notes.path` primary-key autoindex, `resolutions_target`/`resolutions_kind`, and `diagnostics_*` indexes. Accept SQLite's `SCAN ... USING INDEX` wording for ordered index traversal; reject an unindexed `SCAN` of relationship tables.

- [ ] **Step 6: Run query and full index tests**

Run:

```bash
cargo test -p vault-index --test queries
cargo test -p vault-index --all-targets
cargo clippy -p vault-index --all-targets -- -D warnings
```

Expected: all queries are generation-consistent, page-bounded, and plan-tested.

- [ ] **Step 7: Commit indexed reads**

```bash
git add crates/vault-index/src crates/vault-index/tests/queries.rs crates/vault-index/tests/common
git commit -m "feat(index): query semantic generations"
```

---

### Task 8: Define additive protocol version 1 indexed operations

**Files:**

- Modify: `crates/vault-protocol/src/lib.rs`
- Create: `crates/vault-protocol/src/envelope.rs`
- Create: `crates/vault-protocol/src/error.rs`
- Create: `crates/vault-protocol/src/semantic.rs`
- Create: `crates/vault-protocol/src/operations.rs`
- Modify: `crates/vault-protocol/tests/schema.rs`
- Create: `crates/vault-protocol/tests/indexed_operations.rs`

**Interfaces:**

- Consumes: existing version 1 envelope, health, version validation, and JSON tagging conventions.
- Produces transport-only DTOs and these exact request variants:

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Request {
    Health,
    GetVaultInfo,
    ListNotes(PageParams),
    GetNote(NotePathParams),
    ResolveLink(ResolveLinkParams),
    GetBacklinks(PathPageParams),
    ListReferences(ListReferencesParams),
    GetDiagnostics(GetDiagnosticsParams),
    RefreshIndex(RefreshIndexParams),
}
```

- Produces one response variant per request, stable indexed errors, and no dependency on core/index crates.

- [ ] **Step 1: Write failing request/response schema tests**

Create `indexed_operations.rs`:

```rust
use vault_protocol::{
    ErrorCode, GetDiagnosticsParams, GetNoteResponse, ListReferencesParams,
    NoteDto, NotePathParams, PageParams, PathPageParams, ReferenceStatusFilter,
    Request, RequestEnvelope, ResolveLinkParams, Response, ResponseEnvelope,
    ResponseOutcome, SeverityDto, SpanDto,
};

#[test]
fn every_indexed_request_round_trips_under_protocol_version_one() {
    let requests = [
        Request::GetVaultInfo,
        Request::ListNotes(PageParams {
            cursor: None,
            limit: Some(100),
        }),
        Request::GetNote(NotePathParams {
            path: "Folder/Note.md".into(),
        }),
        Request::ResolveLink(ResolveLinkParams {
            source_path: "Folder/Note.md".into(),
            destination: "Other#Heading".into(),
        }),
        Request::GetBacklinks(PathPageParams {
            path: "Folder/Note.md".into(),
            cursor: None,
            limit: Some(50),
        }),
        Request::ListReferences(ListReferencesParams {
            source_path: Some("Folder/Note.md".into()),
            status: Some(ReferenceStatusFilter::Resolved),
            cursor: None,
            limit: Some(50),
        }),
        Request::GetDiagnostics(GetDiagnosticsParams {
            path: None,
            severity: Some(SeverityDto::Warning),
            cursor: None,
            limit: Some(50),
        }),
        Request::RefreshIndex(vault_protocol::RefreshIndexParams { verify: true }),
    ];

    for (index, request) in requests.into_iter().enumerate() {
        let envelope = RequestEnvelope::new(format!("indexed-{index}"), request);
        let json = serde_json::to_string(&envelope).expect("serialize request");
        let decoded: RequestEnvelope =
            serde_json::from_str(&json).expect("deserialize request");
        assert_eq!(decoded, envelope);
    }
}

#[test]
fn indexed_note_response_carries_generation_and_exact_spans() {
    let response = ResponseEnvelope::success(
        "note-1",
        Response::GetNote(GetNoteResponse {
            generation: 7,
            note: NoteDto::empty_for_test(
                "Folder/Note.md",
                "blake3:abc",
                "# Note\n",
                SpanDto { start: 0, end: 6 },
            ),
        }),
    );
    let json = serde_json::to_string(&response).expect("serialize response");
    let decoded: ResponseEnvelope =
        serde_json::from_str(&json).expect("deserialize response");

    assert_eq!(decoded, response);
    assert!(matches!(
        decoded.outcome,
        ResponseOutcome::Ok(Response::GetNote(_))
    ));
    assert!(json.contains("\"generation\":7"));
}

#[test]
fn indexed_error_codes_are_stable_snake_case_values() {
    assert_eq!(
        serde_json::to_string(&ErrorCode::GenerationMismatch).unwrap(),
        "\"generation_mismatch\""
    );
    assert_eq!(
        serde_json::to_string(&ErrorCode::VaultChangedDuringRefresh).unwrap(),
        "\"vault_changed_during_refresh\""
    );
}
```

Create `NoteDto::empty_for_test` as a `#[doc(hidden)]` constructor in `semantic.rs`; it initializes every real field and does not bypass serialization.

- [ ] **Step 2: Run the protocol test and verify the intended failure**

Run:

```bash
cargo test -p vault-protocol --test indexed_operations
```

Expected: compilation fails because indexed protocol types and variants do not exist.

- [ ] **Step 3: Split the protocol module without changing health JSON**

Move existing definitions into:

- `envelope.rs`: `PROTOCOL_VERSION`, `RequestEnvelope`, `ResponseEnvelope`, `ResponseOutcome`, `validate_version`;
- `error.rs`: `ProtocolError` and `ErrorCode`;
- `operations.rs`: `Request`, `Response`, operation params/responses, `HealthResponse`;
- `semantic.rs`: semantic DTOs.

`lib.rs` contains private `mod` declarations and exhaustive public re-exports. Run the original `schema.rs` and server stdio tests immediately after the move; their serialized health shapes must be byte-compatible.

- [ ] **Step 4: Define operation parameters, filters, pages, and response variants**

In `operations.rs`:

```rust
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageParams {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NotePathParams {
    pub path: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PathPageParams {
    pub path: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResolveLinkParams {
    pub source_path: String,
    pub destination: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceStatusFilter {
    Resolved,
    Unresolved,
    Ambiguous,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ListReferencesParams {
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub status: Option<ReferenceStatusFilter>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetDiagnosticsParams {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub severity: Option<SeverityDto>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct RefreshIndexParams {
    #[serde(default)]
    pub verify: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Response {
    Health(HealthResponse),
    GetVaultInfo(GetVaultInfoResponse),
    ListNotes(PageResponse<NoteSummaryDto>),
    GetNote(GetNoteResponse),
    ResolveLink(ResolveLinkResponse),
    GetBacklinks(PageResponse<ReferenceDto>),
    ListReferences(PageResponse<ReferenceDto>),
    GetDiagnostics(PageResponse<DiagnosticDto>),
    RefreshIndex(RefreshIndexResponse),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageResponse<T> {
    pub generation: u64,
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetVaultInfoResponse {
    pub generation: u64,
    pub canonical_root: String,
    pub vault_identity: String,
    pub state: IndexStateDto,
    pub note_count: u64,
    pub refreshed_at_unix_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GetNoteResponse {
    pub generation: u64,
    pub note: NoteDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResolveLinkResponse {
    pub generation: u64,
    pub resolution: ResolutionDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RefreshIndexResponse {
    pub previous_generation: Option<u64>,
    pub generation: u64,
    pub added: u64,
    pub changed: u64,
    pub deleted: u64,
    pub unchanged: u64,
    pub reparsed: u64,
    pub verified: bool,
}
```

Keep `Response::health` as the existing convenience constructor.

- [ ] **Step 5: Define complete semantic DTOs**

In `semantic.rs` define these shapes with `snake_case` enum serialization:

```rust
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SpanDto {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum PropertyValueDto {
    Null,
    Boolean(bool),
    Integer(i64),
    Float(String),
    String(String),
    Sequence(Vec<SpannedPropertyValueDto>),
    Mapping(Vec<PropertyMappingEntryDto>),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SpannedPropertyValueDto {
    pub value: PropertyValueDto,
    pub span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PropertyMappingEntryDto {
    pub key: String,
    pub key_span: SpanDto,
    pub value: SpannedPropertyValueDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PropertyDto {
    pub key: String,
    pub value: PropertyValueDto,
    pub span: SpanDto,
    pub key_span: SpanDto,
    pub value_span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AliasDto {
    pub value: String,
    pub span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HeadingDto {
    pub level: u8,
    pub text: String,
    pub span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlockDto {
    pub value: String,
    pub span: SpanDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TagDto {
    pub value: String,
    pub comparison_key: String,
    pub span: SpanDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKindDto {
    MarkdownLink,
    Wikilink,
    MarkdownEmbed,
    WikiEmbed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceOriginDto {
    Body,
    Property,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SubpathDto {
    Heading(String),
    Block(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolutionDto {
    Resolved {
        target: String,
        subpath: Option<SubpathDto>,
    },
    MissingSubpath {
        target: String,
        subpath: SubpathDto,
    },
    Unresolved,
    Ambiguous {
        candidates: Vec<String>,
    },
    NonVault,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReferenceDto {
    pub source_path: String,
    pub kind: ReferenceKindDto,
    pub origin: ReferenceOriginDto,
    pub raw_target: String,
    pub file_target: Option<String>,
    pub subpath: Option<SubpathDto>,
    pub display: Option<String>,
    pub span: SpanDto,
    pub target_span: SpanDto,
    pub resolution: ResolutionDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeverityDto {
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DiagnosticDto {
    pub code: String,
    pub severity: SeverityDto,
    pub message: String,
    pub path: Option<String>,
    pub span: Option<SpanDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "value", rename_all = "snake_case")]
pub enum IndexStateDto {
    Ready,
    Stale { last_error: String },
    Unavailable { last_error: Option<String> },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NoteSummaryDto {
    pub path: String,
    pub revision: String,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NoteDto {
    pub path: String,
    pub revision: String,
    pub source: String,
    pub properties: Vec<PropertyDto>,
    pub aliases: Vec<AliasDto>,
    pub headings: Vec<HeadingDto>,
    pub blocks: Vec<BlockDto>,
    pub tags: Vec<TagDto>,
    pub diagnostics: Vec<DiagnosticDto>,
    pub outgoing: Vec<ReferenceDto>,
}
```

Represent finite floats using Rust's round-trippable `f64::to_string` and special values as exact strings `"nan"`, `"infinity"`, and `"-infinity"` in the server converter. JSON never carries a non-finite numeric token.

- [ ] **Step 6: Extend stable protocol errors compatibly**

`ErrorCode` becomes:

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    IncompatibleVersion,
    InvalidRequest,
    InvalidPath,
    InvalidCursor,
    NoteNotFound,
    IndexUnavailable,
    GenerationMismatch,
    VaultChangedDuringRefresh,
    IncompatibleIndex,
    StorageFailure,
    Internal,
}
```

Add to `ProtocolError`:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub current_generation: Option<u64>,
```

Add the same `default/skip_serializing_if` attributes to `supported_version`. Update existing constructors so absent optional fields remain absent in JSON, keeping existing health/version examples compatible.

- [ ] **Step 7: Run protocol and unchanged server tests**

Run:

```bash
cargo test -p vault-protocol --all-targets
cargo test -p vault-server --test health
cargo test -p vault-server --test stdio
```

Expected: indexed JSON round trips pass and the existing health/version/unknown-method daemon behavior remains unchanged.

- [ ] **Step 8: Commit the protocol contract**

```bash
git add crates/vault-protocol
git commit -m "feat(protocol): add indexed read operations"
```

---

### Task 9: Compose one vault in the daemon and dispatch every read operation

**Files:**

- Modify: `crates/vault-server/Cargo.toml`
- Modify: `crates/vault-server/src/lib.rs`
- Create: `crates/vault-server/src/convert.rs`
- Modify: `crates/vault-server/src/main.rs`
- Modify: `crates/vault-server/tests/health.rs`
- Create: `crates/vault-server/tests/indexed_dispatch.rs`
- Modify: `crates/vault-server/tests/stdio.rs`

**Interfaces:**

- Consumes: `IndexConfig`, `IndexService` queries/refresh, all protocol DTOs.
- Produces:

```rust
pub struct Server {
    index: Option<IndexService>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServerStartupError {
    #[error(transparent)]
    Index(#[from] IndexError),
}

impl Server {
    pub fn health_only() -> Self;
    pub fn for_index(index: IndexService) -> Self;
    pub fn open(config: IndexConfig) -> Result<Self, ServerStartupError>;
    pub fn handle(&mut self, request: RequestEnvelope) -> ResponseEnvelope;
}
```

- The stdio process accepts `--vault <PATH> [--index <PATH>]` and preserves health-only startup without arguments.

- [ ] **Step 1: Add server dependencies and write failing dispatch tests**

Add:

```toml
[dependencies]
clap.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
vault-core = { path = "../vault-core" }
vault-index = { path = "../vault-index" }
vault-protocol = { path = "../vault-protocol" }

[dev-dependencies]
tempfile.workspace = true
```

Create `indexed_dispatch.rs`:

```rust
use std::fs;

use tempfile::tempdir;
use vault_index::{IndexConfig, IndexService};
use vault_protocol::{
    GetNoteResponse, NotePathParams, Request, RequestEnvelope, Response, ResponseOutcome,
};
use vault_server::Server;

#[test]
fn configured_server_dispatches_indexed_reads_and_refresh() {
    let vault = tempdir().expect("vault");
    let index = tempdir().expect("index");
    fs::write(vault.path().join("Note.md"), "# Note\n").expect("write note");
    let config =
        IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let mut server = Server::for_index(service);

    let response = server.handle(RequestEnvelope::new(
        "note-1",
        Request::GetNote(NotePathParams {
            path: "Note.md".into(),
        }),
    ));

    match response.outcome {
        ResponseOutcome::Ok(Response::GetNote(GetNoteResponse {
            generation,
            note,
        })) => {
            assert_eq!(generation, 1);
            assert_eq!(note.source, "# Note\n");
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

#[test]
fn health_only_server_keeps_health_and_refuses_indexed_reads() {
    let mut server = Server::health_only();
    let response = server.handle(RequestEnvelope::new(
        "note-2",
        Request::GetNote(NotePathParams {
            path: "Note.md".into(),
        }),
    ));
    assert!(matches!(
        response.outcome,
        ResponseOutcome::Err(ref error)
            if error.code == vault_protocol::ErrorCode::IndexUnavailable
    ));
}
```

Add a focused dispatch case for all remaining request variants so no match arm is untested.

- [ ] **Step 2: Run dispatch tests and verify the intended failure**

Run:

```bash
cargo test -p vault-server --test indexed_dispatch
```

Expected: compilation fails because server composition/conversions are not implemented.

- [ ] **Step 3: Implement exhaustive boundary conversions**

In `convert.rs` add small pure functions:

```rust
fn span(value: SourceSpan) -> SpanDto;
fn property_value(value: &PropertyValue) -> PropertyValueDto;
fn diagnostic(value: &Diagnostic) -> DiagnosticDto;
fn resolution(value: &Resolution) -> ResolutionDto;
fn reference(value: &ResolvedReference) -> ReferenceDto;
fn note(value: IndexedNote) -> NoteDto;
fn index_error(value: IndexError) -> ProtocolError;
```

Every core/index enum match must be exhaustive. Convert `usize` span offsets with `u64::try_from`. Convert protocol paths through `VaultPath::new` and return `InvalidPath` on failure.

`index_error` maps:

| Index error | Protocol code |
| --- | --- |
| `InvalidPath` | `InvalidPath` |
| `InvalidCursor` | `InvalidCursor` |
| `NoteNotFound` | `NoteNotFound` |
| `IndexUnavailable` | `IndexUnavailable` |
| `GenerationMismatch { current, .. }` | `GenerationMismatch` plus `current_generation` |
| `VaultChangedDuringRefresh` | `VaultChangedDuringRefresh` |
| `IncompatibleIndex` | `IncompatibleIndex` |
| `Storage` | `StorageFailure` |
| invalid root during an already-running request | `StorageFailure` |

Do not include SQL strings, cache paths, or backtraces in messages.

- [ ] **Step 4: Replace the unit server with optional index composition**

Make `Server::handle` take `&mut self` because refresh mutates the index. Keep version validation first.

Each indexed match arm:

- obtains `self.index.as_mut()` for `RefreshIndex` and `ResolveLink`, and `as_ref()` for the other reads;
- returns `IndexUnavailable` when health-only;
- converts filters and validated paths;
- calls exactly one `IndexService` method;
- converts success or `IndexError` into the matching protocol response.

Update existing health tests from `Server.handle(...)` to:

```rust
let mut server = Server::health_only();
let response = server.handle(request);
```

- [ ] **Step 5: Add CLI configuration without changing stdio framing**

In `main.rs`:

```rust
use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "vaultd", version, about)]
struct Cli {
    #[arg(long, value_name = "PATH")]
    vault: Option<PathBuf>,
    #[arg(long, value_name = "PATH", requires = "vault")]
    index: Option<PathBuf>,
}

fn configured_server(cli: &Cli) -> Result<Server, Box<dyn Error>> {
    match (&cli.vault, &cli.index) {
        (None, None) => Ok(Server::health_only()),
        (Some(vault), None) => Server::open(IndexConfig::derived(vault)).map_err(Into::into),
        (Some(vault), Some(index)) => {
            Server::open(IndexConfig::explicit(vault, index)).map_err(Into::into)
        }
        (None, Some(_)) => unreachable!("clap enforces --index requires --vault"),
    }
}
```

`Server::open` opens the service and attempts `refresh(false)`. If refresh fails, record it and still start when the index can represent `Stale` or `Unavailable`. Invalid root, wrong-vault explicit index, or failure to open storage remains a clear startup error.

Keep the two-stage raw envelope parse exactly as implemented. Pass `&mut Server` through `respond`.

- [ ] **Step 6: Extend stdio process tests**

Update the process helper to accept an argument slice. Add:

```rust
#[test]
fn vaultd_with_explicit_vault_serves_note_then_refresh_requests() {
    let vault = tempfile::tempdir().expect("vault");
    let index = tempfile::tempdir().expect("index");
    std::fs::write(vault.path().join("Note.md"), "# Note\n").unwrap();
    let index_path = index.path().join("index.sqlite3");
    let requests = [
        r#"{"version":1,"id":"n","request":{"method":"get_note","params":{"path":"Note.md"}}}"#,
        r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{"verify":false}}}"#,
    ];
    let output = run_vaultd(
        &[
            "--vault",
            vault.path().to_str().unwrap(),
            "--index",
            index_path.to_str().unwrap(),
        ],
        &requests,
    );

    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let responses = parse_responses(&output);
    assert_eq!(responses.len(), 2);
    assert!(matches!(
        responses[0].outcome,
        ResponseOutcome::Ok(Response::GetNote(_))
    ));
    assert!(matches!(
        responses[1].outcome,
        ResponseOutcome::Ok(Response::RefreshIndex(_))
    ));
}
```

Preserve and rerun future-version unknown-method, supported-version unknown-method, malformed-envelope, and health-only tests.

- [ ] **Step 7: Run server and workspace tests**

Run:

```bash
cargo test -p vault-server --all-targets
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: configured and health-only modes both work; request errors do not kill the stdio loop.

- [ ] **Step 8: Commit daemon composition**

```bash
git add crates/vault-server Cargo.lock
git commit -m "feat(server): serve indexed vault reads"
```

---

### Task 10: Prove incremental reconciliation equals a clean full scan

**Files:**

- Modify: `crates/vault-index/tests/common/mod.rs`
- Create: `crates/vault-index/tests/reconciliation_oracle.rs`

**Interfaces:**

- Consumes: complete `IndexService`, `scan_vault`, temporary filesystem fixtures, `proptest`.
- Produces a canonical test-only `SemanticSnapshot` used to compare incremental SQLite state with a fresh core scan after arbitrary supported changes.

- [ ] **Step 1: Add canonical snapshot helpers**

In `tests/common/mod.rs` define:

```rust
#[derive(Debug, PartialEq)]
pub struct SemanticSnapshot {
    pub notes: Vec<vault_core::ParsedNote>,
    pub outgoing: Vec<(vault_core::VaultPath, Vec<vault_core::ResolvedReference>)>,
    pub backlinks: Vec<(vault_core::VaultPath, Vec<vault_core::ResolvedReference>)>,
    pub unresolved: Vec<vault_core::ResolvedReference>,
    pub ambiguous: Vec<vault_core::ResolvedReference>,
    pub diagnostics: Vec<vault_core::Diagnostic>,
}

pub fn snapshot_from_scan(report: &vault_core::ScanReport) -> SemanticSnapshot;
pub fn snapshot_from_index(service: &vault_index::IndexService) -> SemanticSnapshot;
```

`snapshot_from_index` uses the production public query methods enumerated in Step 4. It must not call `scan_vault`, a hidden full-snapshot shortcut, or the vault source.

- [ ] **Step 2: Write a failing deterministic change-sequence oracle test**

Create `reconciliation_oracle.rs`:

```rust
mod common;

use std::fs;

use tempfile::tempdir;
use vault_core::{FileSystemVaultSource, scan_vault};
use vault_index::{IndexConfig, IndexService};

fn assert_matches_fresh_scan(service: &IndexService, root: &std::path::Path) {
    let source = FileSystemVaultSource::new(root).expect("fresh scan source");
    let fresh = scan_vault(&source).expect("fresh scan");
    assert_eq!(
        common::snapshot_from_index(service),
        common::snapshot_from_scan(&fresh),
    );
}

#[test]
fn mixed_changes_match_a_fresh_scan_after_every_generation() {
    let vault = tempdir().expect("vault");
    let index = tempdir().expect("index");
    fs::write(vault.path().join("A.md"), "# A\n[[B]]\n").unwrap();
    fs::write(vault.path().join("B.md"), "# B\n").unwrap();
    let config =
        IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();

    service.refresh(false).unwrap();
    assert_matches_fresh_scan(&service, vault.path());

    fs::write(vault.path().join("B.md"), "# B changed\n[[Missing]]\n").unwrap();
    service.refresh(false).unwrap();
    assert_matches_fresh_scan(&service, vault.path());

    fs::write(vault.path().join("C.md"), "# C\n[[A#A]]\n").unwrap();
    service.refresh(false).unwrap();
    assert_matches_fresh_scan(&service, vault.path());

    fs::remove_file(vault.path().join("A.md")).unwrap();
    service.refresh(false).unwrap();
    assert_matches_fresh_scan(&service, vault.path());
}
```

- [ ] **Step 3: Run the oracle test and verify the intended failure**

Run:

```bash
cargo test -p vault-index --test reconciliation_oracle
```

Expected: compilation fails until canonical snapshot extraction is available, or assertions expose any row/ordering mismatch.

- [ ] **Step 4: Implement snapshot extraction and fix discrepancies at their owning layer**

Implement the helper using:

- `list_notes` until `next_cursor` is `None`;
- `get_note` for each exact path;
- `get_backlinks` for each exact path;
- `list_references` filtered to unresolved and ambiguous;
- `get_diagnostics` without filters.

Normalize only container shape, never spelling, spans, or order. If the oracle finds a mismatch, fix `codec.rs`, `store.rs`, `reconcile.rs`, or `query.rs` rather than weakening the comparison.

- [ ] **Step 5: Add randomized operation sequences**

Define:

```rust
#[derive(Clone, Debug)]
enum Change {
    Write { slot: u8, body: String },
    Delete { slot: u8 },
}

fn body_strategy() -> impl proptest::strategy::Strategy<Value = String> {
    proptest::prop_oneof![
        proptest::strategy::Just("# Heading\n".to_string()),
        (0u8..8).prop_map(|slot| format!("# Note\n[[Note-{slot}]]\n")),
        (0u8..8).prop_map(|slot| format!("---\ntags: [tag/{slot}]\n---\n# Tagged\n")),
        proptest::strategy::Just("---\nbroken: [\n---\n[[Missing]]\n".to_string()),
    ]
}

fn change_strategy() -> impl proptest::strategy::Strategy<Value = Change> {
    proptest::prop_oneof![
        (0u8..8, body_strategy()).prop_map(|(slot, body)| Change::Write { slot, body }),
        (0u8..8).prop_map(|slot| Change::Delete { slot }),
    ]
}
```

Import `proptest::prelude::*`. Generate vectors of 1 through 30 changes. Apply each change to `Note-{slot}.md` in a temporary vault, call verified refresh, and compare with a clean full scan after every successful generation. A delete of a nonexistent note is a no-op.

Use a bounded case count suitable for CI:

```rust
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn incremental_state_matches_full_scan(
        changes in prop::collection::vec(change_strategy(), 1..=30)
    ) {
        let vault = tempfile::tempdir().expect("vault");
        let index = tempfile::tempdir().expect("index");
        let config = vault_index::IndexConfig::explicit(
            vault.path(),
            index.path().join("index.sqlite3"),
        )
        .expect("config");
        let mut service = vault_index::IndexService::open(config).expect("service");

        for change in changes {
            match change {
                Change::Write { slot, body } => {
                    std::fs::write(
                        vault.path().join(format!("Note-{slot}.md")),
                        body,
                    )
                    .expect("write generated note");
                }
                Change::Delete { slot } => {
                    match std::fs::remove_file(
                        vault.path().join(format!("Note-{slot}.md")),
                    ) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => panic!("delete generated note: {error}"),
                    }
                }
            }
            service.refresh(true).expect("verified incremental refresh");
            assert_matches_fresh_scan(&service, vault.path());
        }
    }
}
```

The randomized oracle uses verified refresh so same-size writes cannot depend on host filesystem timestamp granularity. Task 6's deterministic matrix separately proves the normal metadata fast path.

- [ ] **Step 6: Run deterministic, randomized, and no-panic suites**

Run:

```bash
cargo test -p vault-index --test reconciliation_oracle
cargo test -p vault-index --test reconciliation_oracle -- --nocapture
cargo test -p vault-core --test no_panics
cargo test --workspace --all-targets
```

Expected: every generated incremental state equals a fresh scan and arbitrary parser input still cannot panic.

- [ ] **Step 7: Commit the oracle**

```bash
git add crates/vault-index/tests/common crates/vault-index/tests/reconciliation_oracle.rs
git commit -m "test(index): compare reconciliation with full scans"
```

---

### Task 11: Add deterministic synthetic and opt-in real-vault benchmarks

**Files:**

- Modify: `crates/vault-index/Cargo.toml`
- Create: `crates/vault-index/src/bin/vault-bench.rs`
- Create: `crates/vault-index/tests/benchmark_smoke.rs`
- Create: `docs/performance/persistent-index-baseline.md`

**Interfaces:**

- Consumes: public `IndexConfig`/`IndexService` queries and refresh.
- Produces a `vault-bench` binary that prints exactly one JSON report to stdout:

```rust
#[derive(serde::Serialize)]
struct BenchmarkReport {
    schema: u32,
    mode: String,
    note_count: usize,
    repeats: usize,
    timings_ms: BenchmarkTimings,
    work: BenchmarkWork,
}

#[derive(serde::Serialize)]
struct BenchmarkTimings {
    cold_index: Distribution,
    warm_startup: Distribution,
    one_file_refresh: Distribution,
    verified_refresh: Distribution,
    get_note: Distribution,
    backlinks: Distribution,
    list_100: Distribution,
}

#[derive(serde::Serialize)]
struct Distribution {
    samples: Vec<f64>,
    p50: f64,
    p95: f64,
}

#[derive(serde::Serialize)]
struct BenchmarkWork {
    warm_startup_body_reads: u64,
    warm_startup_reparsed: u64,
    one_file_refresh_body_reads: u64,
    one_file_refresh_reparsed: u64,
}
```

- [ ] **Step 1: Add the binary target and write a failing smoke test**

Add to `crates/vault-index/Cargo.toml`:

```toml
[[bin]]
name = "vault-bench"
path = "src/bin/vault-bench.rs"
```

Create `benchmark_smoke.rs`:

```rust
use std::process::Command;

#[test]
fn benchmark_emits_machine_readable_metrics() {
    let output = Command::new(env!("CARGO_BIN_EXE_vault-bench"))
        .args(["--notes", "100", "--repeats", "2"])
        .output()
        .expect("run benchmark smoke test");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("JSON report");

    assert_eq!(report["schema"], 1);
    assert_eq!(report["mode"], "synthetic");
    assert_eq!(report["note_count"], 100);
    for metric in [
        "cold_index",
        "warm_startup",
        "one_file_refresh",
        "verified_refresh",
        "get_note",
        "backlinks",
        "list_100",
    ] {
        assert!(report["timings_ms"][metric]["p50"].is_number(), "{metric}");
        assert!(report["timings_ms"][metric]["p95"].is_number(), "{metric}");
    }
    assert_eq!(report["work"]["warm_startup_body_reads"], 0);
    assert_eq!(report["work"]["warm_startup_reparsed"], 0);
}
```

- [ ] **Step 2: Run the smoke test and verify the intended failure**

Run:

```bash
cargo test -p vault-index --test benchmark_smoke
```

Expected: Cargo fails because `vault-bench.rs` does not exist.

- [ ] **Step 3: Implement deterministic synthetic vault generation**

Use `clap::Parser`:

```rust
#[derive(clap::Parser)]
struct Args {
    #[arg(long, default_value_t = 10_000)]
    notes: usize,
    #[arg(long, default_value_t = 7)]
    repeats: usize,
    #[arg(long, value_name = "PATH", conflicts_with = "notes")]
    vault: Option<std::path::PathBuf>,
}
```

Because a defaulted `notes` conflicts poorly with `vault`, implement the actual CLI as:

```rust
#[derive(clap::Parser)]
struct Args {
    #[arg(long, value_name = "COUNT", default_value_t = 10_000)]
    notes: usize,
    #[arg(long, default_value_t = 7)]
    repeats: usize,
    #[arg(long, value_name = "PATH")]
    vault: Option<std::path::PathBuf>,
}
```

When `vault` is present, ignore `notes` and report the enumerated count. Document this in `--help`. Require `notes > 0` and `repeats >= 2` with clear errors.

Synthetic note `i` is deterministic:

```rust
fn synthetic_note(index: usize, count: usize) -> String {
    let next = (index + 1) % count;
    let previous = (index + count - 1) % count;
    format!(
        "---\ntitle: Note {index:06}\ntags: [synthetic/group-{group}]\n---\n\
         # Note {index:06}\n\
         [[Note-{next:06}]]\n\
         [[Note-{previous:06}#Note {previous:06}]]\n",
        group = index % 100,
    )
}
```

Write synthetic notes into a `tempfile::TempDir` named `Note-{index:06}.md` and index into a separate temporary directory. Real-vault mode also always uses a temporary index, so measurement cannot disturb the normal daemon cache.

- [ ] **Step 4: Measure the exact workload contract**

Use `std::time::Instant` and a helper:

```rust
fn distribution(mut samples: Vec<f64>) -> Distribution {
    assert!(!samples.is_empty(), "timed distributions require samples");
    samples.sort_by(f64::total_cmp);
    let percentile = |fraction: f64| {
        let index = ((samples.len() - 1) as f64 * fraction).ceil() as usize;
        samples[index]
    };
    Distribution {
        p50: percentile(0.50),
        p95: percentile(0.95),
        samples,
    }
}

fn empty_distribution() -> Distribution {
    Distribution {
        samples: Vec::new(),
        p50: 0.0,
        p95: 0.0,
    }
}
```

Measure:

1. cold index: new temporary DB plus `refresh(false)`;
2. warm startup: close/reopen `IndexService` and `refresh(false)`;
3. one-file refresh: alternate one synthetic note between two same-shape bodies, set a monotonically increasing modification time with `filetime::set_file_mtime` after each write, restore it after each sample, and refresh normally;
4. verified refresh: `refresh(true)` without changes;
5. `get_note` for the middle note;
6. `get_backlinks` for the middle note with limit 100;
7. first `list_notes` page with limit 100.

Wrap `FileSystemIndexSource` in a benchmark-local `CountingSource` and reset its body-read count immediately before warm startup and one-file refresh. Capture `RefreshReport::reparsed` for the corresponding parse-work fields. Perform one untimed warm-up for each warm query. Emit only JSON to stdout; progress and warnings go to stderr. Real-vault mode performs no source writes, so use `empty_distribution()` for one-file refresh, set its two work counters to zero, and print a stderr explanation.

- [ ] **Step 5: Run the smoke test and both required synthetic scales**

Run:

```bash
cargo test -p vault-index --test benchmark_smoke
cargo build --release -p vault-index --bin vault-bench
./target/release/vault-bench --notes 10000 --repeats 7 > /tmp/vaultd-bench-10k.json
./target/release/vault-bench --notes 100000 --repeats 7 > /tmp/vaultd-bench-100k.json
python3 -m json.tool /tmp/vaultd-bench-10k.json
python3 -m json.tool /tmp/vaultd-bench-100k.json
```

Expected: both reports parse, contain all metrics, and show zero note-body reads/parses in the benchmark's instrumented warm-startup counters. The benchmark may take minutes at 100,000 notes; do not add a CI wall-clock assertion.

- [ ] **Step 6: Record reproducible baselines without real-vault data**

Create `docs/performance/persistent-index-baseline.md` with:

- date, OS, architecture, CPU model, RAM, Rust version, build profile, commit;
- the exact 10,000-note and 100,000-note commands from Step 5;
- the complete pretty-printed 10k and 100k JSON outputs;
- a note that absolute timings are observational, while the structural warm-path counters are contractual;
- the documented opt-in command:

```bash
./target/release/vault-bench --vault /path/to/vault --repeats 7
```

Do not add a real-vault result to the committed file. Do not claim stock-Obsidian superiority.

Add a stock-Obsidian comparison rubric without fabricated results:

- same machine, power state, vault snapshot, and at least seven runs per product;
- cold means no reusable metadata/index cache; warm means each product's normal persistent cache is retained;
- startup ends when Obsidian's metadata cache reports resolution complete or `vaultd` finishes startup reconciliation;
- compare exact-note retrieval and backlinks for the same predetermined paths;
- report p50/p95 separately for startup and queries;
- disclose measurement instrumentation and any disposable vault copy;
- make a “faster than stock Obsidian” claim only when warm query latency and repeated-startup work both win under that rubric.

- [ ] **Step 7: Commit benchmark tooling and synthetic baselines**

```bash
git add crates/vault-index/Cargo.toml crates/vault-index/src/bin/vault-bench.rs crates/vault-index/tests/benchmark_smoke.rs docs/performance/persistent-index-baseline.md
git commit -m "perf(index): benchmark persistent read paths"
```

---

### Task 12: Update contracts, verify the milestone, and obtain independent review

**Files:**

- Modify: `README.md`
- Modify: `VAULTD-COMPATIBILITY.md`
- Modify: `docs/protocol.md`
- Modify: `crates/vault-server/tests/docs.rs`

**Interfaces:**

- Consumes: the complete executable behavior from Tasks 1–11.
- Produces an accurate public milestone status and verified, reviewed implementation branch.

- [ ] **Step 1: Write failing documentation-contract assertions**

Extend `crates/vault-server/tests/docs.rs`:

```rust
#[test]
fn persistent_index_documents_declare_the_executable_contract() {
    assert_document_contains(
        "README.md",
        &[
            "persistent SQLite",
            "startup and manual reconciliation",
            "filesystem watcher",
        ],
    );
    assert_document_contains(
        "VAULTD-COMPATIBILITY.md",
        &[
            "get_vault_info",
            "get_note",
            "refresh_index",
            "filesystem remains authoritative",
        ],
    );
    assert_document_contains(
        "docs/protocol.md",
        &[
            "generation_mismatch",
            "vault_changed_during_refresh",
            "list_references",
            "verify",
        ],
    );
}
```

- [ ] **Step 2: Run the docs test and verify the intended failure**

Run:

```bash
cargo test -p vault-server --test docs
```

Expected: failure because milestone documentation still describes only health as executable.

- [ ] **Step 3: Update README and compatibility status**

In `README.md`:

- retain the north star and six architectural boundaries;
- mark the persistent-index/read-API milestone complete;
- list normalized SQLite, generations, normal/verified reconciliation, and all eight indexed operations;
- state that startup/manual refresh exist but watcher/events do not;
- link the new design, implementation plan, protocol, and performance baseline;
- retain explicit non-goals for vault mutation, plugins, UI, and Sync.

In `VAULTD-COMPATIBILITY.md`:

- keep Tier 0 storage authority unchanged;
- keep Tier 1 semantic claims evidence-bound;
- change Tier 2 current status from health-only to the exact implemented read operations;
- state that mutation, transactions, events, CLI commands beyond configuration, and URI handling remain targets;
- update the consumer matrix status without claiming any consumer implementation;
- include the literal phrase `filesystem remains authoritative` required by the test.

- [ ] **Step 4: Rewrite protocol documentation to match executable version 1**

`docs/protocol.md` must include:

- unchanged envelope/version-first dispatch;
- `--vault`/`--index` configuration and health-only mode;
- one request and response JSON example for each operation:
  `health`, `get_vault_info`, `list_notes`, `get_note`, `resolve_link`,
  `get_backlinks`, `list_references`, `get_diagnostics`, `refresh_index`;
- all DTO fields and enum spellings;
- default/max page limits and opaque generation-bound cursor rules;
- normal versus verified refresh behavior;
- all stable error codes and when each occurs;
- stale/unavailable behavior;
- reserved `query`, `search`, mutation, transaction, and `subscribe` families;
- additive version 1 evolution rules.

Generate examples from `vault-protocol` values in a small test helper or existing schema tests and paste their actual serialization. Do not hand-invent JSON that the types do not emit.

- [ ] **Step 5: Run complete verification**

Run from the feature worktree:

```bash
cargo fmt --all -- --check
TMPDIR="$PWD/target" cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --workspace --no-deps
cargo +1.85.0 check --workspace --all-targets
git diff --check main...HEAD
git status --short --branch
```

Expected:

- formatting, every unit/integration/property/process/smoke test, Clippy, docs, and an explicit Rust 1.85 check pass;
- no warning is suppressed to make Clippy green;
- only intended milestone files are tracked;
- `.permission-check` is absent from the feature worktree or remains untracked and unstaged in the permanent checkout.

Audit the vault-authority boundary:

```bash
rg -n "fs::(write|remove_file|rename)|OpenOptions|File::create" crates/vault-core crates/vault-index crates/vault-server
rg -n "watch|subscribe|search|apply_mutation|begin_transaction" crates
```

Expected:

- `vault-core` has no production write path;
- `vault-index` production writes target only validated cache/index paths; source writes appear only in tests and the synthetic benchmark generator;
- no watcher, subscription, search, or mutation operation is accidentally implemented.

- [ ] **Step 6: Commit contract documentation**

```bash
git add README.md VAULTD-COMPATIBILITY.md docs/protocol.md crates/vault-server/tests/docs.rs
git commit -m "docs: document persistent indexed reads"
```

- [ ] **Step 7: Request independent code review**

Use `superpowers:requesting-code-review` in a fresh context. Review the complete diff from `main` with emphasis on:

- cache/vault path separation and rebuild target validation;
- transaction atomicity and generation compare-and-swap;
- fast-startup proof and verified-refresh correctness;
- exact source/span/property round trips;
- cursor query binding and generation mismatch;
- SQL query plans and bounded pages;
- protocol/core separation and exhaustive error mapping;
- daemon survival after request-level errors;
- real-vault privacy in benchmark tooling/docs.

For every high-confidence finding, add a focused regression test first, implement the fix, rerun the relevant focused suite plus complete verification, inspect `git diff --name-only`, stage only those reviewed fix files, and commit:

```bash
git add -u
git commit -m "fix: address independent review findings"
```

If a regression test is a newly created file, add its exact path explicitly before the commit; never use `git add .`.

- [ ] **Step 8: Re-run the final clean-tree gate**

```bash
cargo fmt --all -- --check
TMPDIR="$PWD/target" cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --workspace --no-deps
cargo +1.85.0 check --workspace --all-targets
git diff --check main...HEAD
git log --oneline --decorate main..HEAD
git status --short --branch
```

Expected: all checks pass after review fixes and the feature branch is ready for the maintainer's chosen integration workflow. Do not push, open a PR, merge, or remove the worktree without authorization.

## Execution Handoff

Give this file and `docs/design/persistent-index-and-daemon-read-api.md` to Claude Code in a fresh isolated worktree. The recommended execution mode is `superpowers:subagent-driven-development` with a fresh implementation context and review gate per task; `superpowers:executing-plans` is acceptable when Claude Code will execute sequential batches with explicit checkpoints.

The first executable action is the Preflight Gate. Stop at any failed expectation, unexpected existing worktree, dependency/MSRV conflict, destructive target ambiguity, real-vault benchmark request, or change that would expand into watchers, search, mutation, plugins, UI, or Sync.
