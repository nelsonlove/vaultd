# vaultd Live Incremental Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `vaultd` into an always-live, read-only semantic runtime whose ordinary edit cost is proportional to changed notes and affected references, with atomic SQLite generations and bounded post-commit event subscriptions.

**Architecture:** A compact in-memory graph owns hot resolution and reverse-dependency state while SQLite remains the durable query snapshot. A single writer coordinator converts watcher hints into stable dirty-path batches, calculates an allocation-complete graph/SQL delta, commits only affected rows, installs the matching live generation behind a publication barrier, and then emits bounded protocol events. Periodic complete metadata reconciliation and the existing full resolver remain correctness fallbacks.

**Spec:** `docs/design/live-incremental-runtime.md` (commit `2669e7c`) — the plan argues from the spec; executors read both in full.

**Tech Stack:** Rust 2024 edition with Rust 1.85 MSRV; existing `vault-core`, `vault-index`, `vault-protocol`, and `vault-server` crates; new `vault-watch` crate; SQLite/WAL through `rusqlite 0.32.1`; `notify 8.2.0`; `fs2 0.4.3`; standard-library threads, bounded channels, locks, and time; `proptest`; existing stdio JSON-lines transport.

## Global Constraints

- Execute from an isolated worktree based on Phase 3 commit `4ca5591` or a descendant that contains `docs/design/live-incremental-runtime.md` commit `2669e7c`.
- Preserve workspace `edition = "2024"` and `rust-version = "1.85"`; every new direct dependency must pass `cargo +1.85.0 check --workspace --all-targets`.
- The ordinary Obsidian vault is authoritative and read-only. Production writes are limited to a validated SQLite cache, its SQLite sidecars, and its sibling lease file outside the canonical vault root.
- Never point destructive cache-rebuild tests, synthetic benchmarks, or explicit index paths at the maintainer's live vault or live cache.
- Keep `.permission-check` untouched and uncommitted.
- Preserve the dependency direction: `vault-core` knows no SQLite, watcher, threads, protocol, or daemon types; `vault-protocol` knows no core/index/server types; `vault-watch` only emits normalized hints; `vault-server` composes the process.
- Protocol version remains `1`. New requests, responses, optional/defaulted fields, event envelopes, and error codes are additive; existing unsubscribed response envelopes remain unchanged.
- One configured daemon holds one exclusive writer lease. SQLite compare-and-swap remains defense in depth.
- A client-visible generation exists only after SQLite commit and matching live-state installation. Events are emitted afterward.
- Hints may be duplicated, reordered, coalesced, or replaced with complete reconciliation. Incremental invalidation must be conservative; uncertainty falls back to complete resolution.
- The ordinary watcher path performs no complete vault inventory, unchanged-source load, complete resolution, aggregate-diagnostic rewrite, or whole-graph clone.
- The live graph excludes exact source bytes, property values, aliases, tags, and complete query DTOs.
- Watcher callbacks perform no file reads, parsing, SQL, protocol serialization, or blocking coordination.
- Queues, dirty sets, path payloads, and subscriber buffers are bounded. Overflow produces full reconciliation or `resync_required`, never unbounded growth.
- Rust production code may not panic on vault content, watcher input, protocol input, SQLite contents, or recoverable races.
- Retain `synchronous=NORMAL`, WAL, foreign keys, busy timeout, and indexed/keyset query behavior unless a measured change is documented and independently reviewed.
- No search, mutation, Sync, MCP, network transport, plugin runtime, UI, URI, Node, Swift, Elisp, mobile, or e-ink implementation in this phase.
- Use test-driven development for every behavior change: failing focused test, observed failure, minimal implementation, passing focused test, relevant suite, commit.
- End every task with the named focused tests, `cargo test --workspace --all-targets`, and a scoped commit. Do not combine task commits.

---

---

## Preflight gate

Run these checks before Task 1 and stop if any expectation fails:

```bash
git status --short --branch
mkdir -p "$PWD/target/tmp"
git merge-base --is-ancestor 4ca5591 HEAD
git merge-base --is-ancestor 2669e7c HEAD
test -f docs/design/live-incremental-runtime.md
test -f crates/vault-index/src/schema_v1.sql
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
```

Expected:

- worktree clean before implementation;
- both ancestry checks exit `0`;
- design and Phase 3 schema files exist;
- 114 Phase 3 tests pass;
- the Rust 1.85 check passes;
- no `.permission-check` path is staged.

If Phase 3 is not yet on `main`, keep this implementation branch based on the Phase 3 descendant. Do not copy Phase 3 files onto an older base and do not merge unrelated work.

---

## Planned file map

### Workspace and dependencies

- Modify `Cargo.toml`: add `vault-watch`, `notify = "8.2.0"`, and `fs2 = "0.4.3"`.
- Modify `Cargo.lock`: resolver output only.

### `vault-core`

- Create `crates/vault-core/src/dependency.rs`: dependency keys, note identity changes, and conservative impact-key generation.
- Modify `crates/vault-core/src/resolver.rs`: expose candidate-key helpers and selected-reference resolution without changing complete behavior.
- Modify `crates/vault-core/src/lib.rs`: export the new pure interfaces.
- Create `crates/vault-core/tests/dependency_keys.rs`: exact dependency-key contract.
- Create `crates/vault-core/tests/incremental_resolution.rs`: selected-versus-complete resolution equivalence.

### `vault-index`

- Create `crates/vault-index/src/metrics.rs`: stage durations and structural work counters.
- Create `crates/vault-index/src/live_graph.rs`: compact graph, path/reference identities, reverse indexes, impact selection, prepared in-memory deltas.
- Create `crates/vault-index/src/store/hydrate.rs`: minimal graph hydration queries.
- Create `crates/vault-index/src/store/delta.rs`: affected-row publication and write counters.
- Create `crates/vault-index/src/query/diagnostics.rs`: deterministic diagnostic union and keyset ordering.
- Create `crates/vault-index/src/reader.rs`: read connection plus shared publication barrier.
- Create `crates/vault-index/src/live_reconcile.rs`: stable dirty-path reads, classification, planning, and delta publication.
- Create `crates/vault-index/src/lease.rs`: validated sibling lease acquisition.
- Create `crates/vault-index/src/test_hook.rs`: test-only named barriers for forced interleavings.
- Create `crates/vault-index/src/schema_v2.sql`: dependency and owned-resolution-diagnostic schema.
- Modify `crates/vault-index/src/{lib,error,config,inventory,model,query,reconcile,schema,store}.rs`: compose the new focused modules and retain full reconciliation.
- Modify `crates/vault-index/src/bin/vault-bench.rs`: live cases, stage output, RSS measurement, event-latency support.
- Create focused tests under `crates/vault-index/tests/`: `stage_metrics.rs`, `live_graph.rs`, `schema_v2.rs`, `delta_publication.rs`, `live_reconciliation.rs`, `live_reader.rs`, `lease.rs`, `live_races.rs`, and `live_oracle.rs`.
- Modify `crates/vault-index/tests/common/mod.rs`: live fixtures, counters, barriers, and snapshots.

### `vault-watch`

- Create `crates/vault-watch/Cargo.toml`.
- Create `crates/vault-watch/src/lib.rs`: public hint-source boundary.
- Create `crates/vault-watch/src/filter.rs`: safe included-Markdown path normalization.
- Create `crates/vault-watch/src/debounce.rs`: bounded dirty-set coalescing and overflow latch.
- Create `crates/vault-watch/src/backend.rs`: `notify` adapter with nonblocking callback.
- Create `crates/vault-watch/tests/{filter,debounce,filesystem_smoke}.rs`.

### `vault-protocol`

- Create `crates/vault-protocol/src/events.rs`: subscription DTOs, event envelope, change sets, runtime state.
- Modify `crates/vault-protocol/src/{lib,envelope,error,operations,semantic}.rs`: additive protocol version 1 exports and optional live state.
- Create `crates/vault-protocol/tests/events.rs` and modify `tests/indexed_operations.rs`.

### `vault-server`

- Create `crates/vault-server/src/runtime.rs`: single writer command loop, startup catch-up, periodic scheduling, and runtime handle.
- Create `crates/vault-server/src/subscriptions.rs`: bounded subscribers, coalescing, and resync markers.
- Create `crates/vault-server/src/stdio.rs`: single stdout owner and response/event multiplexing.
- Modify `crates/vault-server/src/{lib,main,convert}.rs` and `Cargo.toml`.
- Create `crates/vault-server/tests/{runtime,subscriptions,live_stdio,startup}.rs` and update existing server tests.

### Documentation

- Modify `README.md`, `VAULTD-COMPATIBILITY.md`, and `docs/protocol.md`.
- Create `docs/performance/live-incremental-baseline.md`.
- Modify `docs/design/live-incremental-runtime.md` only when implementation discovers an approved factual correction; do not silently weaken the design.

---

### Task 1: Instrument the Phase 3 reconciliation path

**Files:**

- Create: `crates/vault-index/src/metrics.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Modify: `crates/vault-index/src/reconcile.rs`
- Modify: `crates/vault-index/src/store.rs`
- Modify: `crates/vault-index/src/bin/vault-bench.rs`
- Create: `crates/vault-index/tests/stage_metrics.rs`

**Interfaces:**

- Produces: `ReconcileMetrics`, `StageDurations`, `WorkCounts`, `IndexService::last_reconcile_metrics(&self) -> Option<&ReconcileMetrics>`.
- Preserves: `IndexService::refresh(bool) -> Result<RefreshReport, IndexError>` and all protocol DTOs.
- Later tasks extend the same counters; do not create a second metrics shape.

- [ ] **Step 1: Write a failing structural-metrics test**

Create `crates/vault-index/tests/stage_metrics.rs`:

```rust
mod common;

use common::counting_service_with_two_notes;

#[test]
fn phase_three_one_file_refresh_reports_its_global_work() {
    let mut fixture = counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.reset_counts();
    fixture.write_note("One.md", "# One changed\n");

    fixture.service.refresh(false).expect("incremental refresh");
    let metrics = fixture
        .service
        .last_reconcile_metrics()
        .expect("refresh metrics");

    assert_eq!(fixture.body_reads(), 1);
    assert_eq!(metrics.work.body_reads, 1);
    assert_eq!(metrics.work.notes_reparsed, 1);
    assert_eq!(metrics.work.complete_inventories, 2);
    assert!(metrics.work.references_resolved >= 1);
    assert!(metrics.work.resolution_rows_written >= 1);
}
```

- [ ] **Step 2: Run the focused test and observe the missing API**

Run:

```bash
cargo test -p vault-index --test stage_metrics -- --nocapture
```

Expected: compilation fails because `last_reconcile_metrics` and the metrics types do not exist.

- [ ] **Step 3: Add one reusable metrics model**

Create `metrics.rs` with this public shape:

```rust
use std::time::Duration;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StageDurations {
    pub inventory: Duration,
    pub body_read: Duration,
    pub parse: Duration,
    pub impact_planning: Duration,
    pub resolution: Duration,
    pub candidate_build: Duration,
    pub sqlite_write: Duration,
    pub sqlite_commit: Duration,
    pub live_install: Duration,
    pub event_enqueue: Duration,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WorkCounts {
    pub complete_inventories: u64,
    pub body_reads: u64,
    pub notes_reparsed: u64,
    pub changed_notes: u64,
    pub affected_references: u64,
    pub references_resolved: u64,
    pub note_rows_written: u64,
    pub reference_rows_written: u64,
    pub resolution_rows_written: u64,
    pub dependency_rows_written: u64,
    pub diagnostic_rows_written: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReconcileMetrics {
    pub stages: StageDurations,
    pub work: WorkCounts,
}
```

Add `last_metrics: Option<ReconcileMetrics>` to `IndexService`, initialize it to `None`, set it for successful and failed refresh attempts, and export the three types from `lib.rs`.

- [ ] **Step 4: Instrument existing stages without changing behavior**

Use `Instant` around inventory, reads, parses, `build_graph`, graph-row replacement, and commit. Change `replace_graph_rows` to return a private `GraphWriteCounts` containing resolution and diagnostic rows written, and merge those counts into `ReconcileMetrics`.

Keep timing collection observational: no threshold changes behavior, errors remain the existing errors, and metrics allocation cannot fail a refresh.

- [ ] **Step 5: Add metrics to benchmark JSON**

Add a `work` object for each live-relevant sample and stage p50/p95 groups. Preserve all existing Phase 3 JSON keys so the committed baseline remains readable.

- [ ] **Step 6: Run focused and workspace verification**

Run:

```bash
cargo test -p vault-index --test stage_metrics -- --nocapture
cargo test -p vault-index --test incremental_reconciliation
cargo test --workspace --all-targets
```

Expected: all pass; the test documents the expensive global baseline before optimization.

- [ ] **Step 7: Commit**

```bash
git add crates/vault-index
git commit -m "perf(index): instrument reconciliation stages"
```

---

### Task 2: Define pure resolution dependency keys

**Files:**

- Create: `crates/vault-core/src/dependency.rs`
- Modify: `crates/vault-core/src/resolver.rs`
- Modify: `crates/vault-core/src/lib.rs`
- Create: `crates/vault-core/tests/dependency_keys.rs`
- Create: `crates/vault-core/tests/incremental_resolution.rs`

**Interfaces:**

- Consumes: existing `LinkTarget`, `Resolution`, `ResolutionNote`, `Resolver`, `Subpath`, and `VaultPath`.
- Produces: `DependencyKind`, `DependencyKey`, `ResolutionIdentityChange`, `reference_dependencies`, `changed_candidate_keys`, and `resolution_diagnostic`.
- Later `LiveGraph` indexes these exact keys; SQLite persists their string encodings without reimplementing lookup semantics.

- [ ] **Step 1: Write exact dependency-key tests**

Create `dependency_keys.rs` with table cases covering exact paths, implicit `.md`, filename/stem fallback, relative targets, same-note headings, resolved subpaths, ambiguous references, unresolved references, and non-vault URIs. Use this representative assertion:

```rust
use vault_core::{
    DependencyKey, DependencyKind, LinkTarget, Resolution, VaultPath, reference_dependencies,
};

#[test]
fn unresolved_filename_reference_keeps_every_lookup_route() {
    let source = VaultPath::new("Folder/Source.md").unwrap();
    let target = LinkTarget::parse("Target");
    let keys = reference_dependencies(&source, &target, &Resolution::Unresolved);

    assert_eq!(
        keys,
        vec![
            DependencyKey::new(DependencyKind::ExactPath, "Target"),
            DependencyKey::new(DependencyKind::ExactPathWithExtension, "Target.md"),
            DependencyKey::new(DependencyKind::Filename, "target"),
            DependencyKey::new(DependencyKind::Stem, "target"),
        ]
    );
}
```

For `https://example.com`, assert an empty vector. For `#Heading`, assert a `ResolvedTarget` key for the source path.

- [ ] **Step 2: Observe the missing dependency module**

Run:

```bash
cargo test -p vault-core --test dependency_keys
```

Expected: compilation fails on missing exports.

- [ ] **Step 3: Implement the key model and single-source normalization**

Use an ordered, hashable public model:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum DependencyKind {
    ExactPath,
    ExactPathWithExtension,
    Filename,
    Stem,
    ResolvedTarget,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DependencyKey {
    pub kind: DependencyKind,
    pub comparison_key: String,
}

impl DependencyKey {
    pub fn new(kind: DependencyKind, comparison_key: impl Into<String>) -> Self {
        Self { kind, comparison_key: comparison_key.into() }
    }
}
```

Move relative-target normalization from a private resolver-only helper to a `pub(crate)` helper used by both resolution and dependency generation. Return sorted/deduplicated keys. Preserve the resolver's current exact-before-filename/stem behavior byte-for-byte.

- [ ] **Step 4: Define old/new candidate identity changes**

Add:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionIdentityChange {
    pub old: Option<ResolutionNote>,
    pub new: Option<ResolutionNote>,
}

pub fn changed_candidate_keys(
    change: &ResolutionIdentityChange,
) -> std::collections::BTreeSet<DependencyKey>;
```

The returned set includes old and new exact path spellings, implicit-extension spellings, filename/stem keys, and `ResolvedTarget` when heading/block membership changed. Body-only edits with identical `ResolutionNote` values return an empty set.

- [ ] **Step 5: Extract the single resolution-diagnostic constructor**

Add to `resolver.rs`:

```rust
pub fn resolution_diagnostic(resolved: &ResolvedReference) -> Option<Diagnostic>;
```

Move the unresolved/ambiguous/missing-heading/missing-block diagnostic construction out of `build_graph` into this function and make `build_graph` call it, so incremental resolution cannot drift from the complete path's messages, codes, severities, paths, or spans. Pin message identity with a test that compares `resolution_diagnostic` output against the diagnostics `build_graph` emits for the semantic fixture.

- [ ] **Step 6: Prove selected resolution equals complete resolution**

Create `incremental_resolution.rs`. Build the semantic fixture graph, select references by dependency keys for add/delete/heading-change scenarios, resolve only those with `Resolver::resolve_target`, and compare every selected result with `build_graph` after the same change.

Use a helper with an exact signature:

```rust
fn assert_selected_matches_complete(
    before: &[vault_core::ParsedNote],
    after: &[vault_core::ParsedNote],
    changes: &[vault_core::ResolutionIdentityChange],
)
```

The helper must fail if any reference whose complete answer changed is absent from the dependency-selected set.

- [ ] **Step 7: Run core regression suites**

```bash
cargo test -p vault-core --test dependency_keys
cargo test -p vault-core --test incremental_resolution
cargo test -p vault-core --test resolution
cargo test -p vault-core --test semantic_graph
cargo test --workspace --all-targets
```

Expected: all pass and existing golden resolution output remains unchanged.

- [ ] **Step 8: Commit**

```bash
git add crates/vault-core
git commit -m "feat(core): model incremental resolution dependencies"
```

---

### Task 3: Build the compact live graph

**Files:**

- Create: `crates/vault-index/src/live_graph.rs`
- Create: `crates/vault-index/src/store/hydrate.rs`
- Modify: `crates/vault-index/src/store.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Create: `crates/vault-index/tests/live_graph.rs`
- Modify: `crates/vault-index/tests/common/mod.rs`

**Interfaces:**

- Consumes: Task 2 dependency keys and Phase 3 persisted note/reference/resolution rows.
- Produces: `ReferenceKey`, `HydratedNote`, `HydratedReference`, `LiveGraph`, `ImpactPlan`, `PreparedGraphDelta`, `IndexStore::hydrate_live_graph`.
- Excludes: source bytes, property values, aliases, tags, full note DTOs, and materialized backlink vectors.

- [ ] **Step 1: Write a hydration-content test**

Create `live_graph.rs`:

```rust
mod common;

use common::queries_fixture;
use vault_core::VaultPath;

#[test]
fn hydration_loads_resolution_state_without_source_bodies() {
    let mut fixture = queries_fixture();
    fixture.service.refresh(false).expect("cold build");
    let graph = fixture.service.hydrate_live_graph().expect("hydrate");

    assert_eq!(graph.generation().get(), 1);
    assert_eq!(graph.note_count(), 4);
    assert!(graph.contains_note(&VaultPath::new("Target.md").unwrap()));
    assert!(graph.reference_count() >= 5);
    assert_eq!(graph.retained_source_bytes(), 0);
}
```

Also assert that the ambiguous `Foo` reference is indexed under its filename/stem dependencies and `Target#Absent` is indexed under `ResolvedTarget("Target.md")`.

- [ ] **Step 2: Run and observe missing graph APIs**

```bash
cargo test -p vault-index --test live_graph
```

Expected: compilation fails on `hydrate_live_graph` and `LiveGraph`.

- [ ] **Step 3: Define compact identities**

Implement these exact public/test-visible shapes in `live_graph.rs`:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NoteId(u32);

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ReferenceKey {
    pub source: NoteId,
    pub ordinal: u32,
}

#[derive(Clone, Debug)]
pub struct HydratedNote {
    pub path: vault_core::VaultPath,
    pub headings: Vec<String>,
    pub blocks: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct HydratedReference {
    pub source_path: vault_core::VaultPath,
    pub ordinal: u32,
    pub target: vault_core::LinkTarget,
    pub resolution: vault_core::Resolution,
}
```

`LiveGraph` owns path interning, candidate maps, per-source references, per-dependency reverse sets, and resolved-target/subpath reverse sets. Use compact IDs internally but deterministic `BTreeSet<ReferenceKey>` results. Never expose `NoteId` or `ReferenceKey` through protocol DTOs.

- [ ] **Step 4: Hydrate with narrow SQL**

Implement:

```rust
impl IndexStore {
    pub(crate) fn hydrate_live_graph(
        &self,
        generation: Generation,
    ) -> Result<LiveGraph, IndexError>;
}
```

The queries select only paths, headings, blocks, note-reference target columns, stored resolution columns, candidates, and dependency inputs. At this task, schema version 1 has no dependency rows: hydration computes each reference's keys in memory with Task 2's `reference_dependencies` from the hydrated `LinkTarget` and stored resolution. They must not select `source_bytes`, properties, aliases, or tags. Add a test-only SQL trace/counter assertion that hydration never names `source_bytes`.

- [ ] **Step 5: Add impact and prepared-delta APIs**

Expose:

```rust
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ImpactPlan {
    pub affected: std::collections::BTreeSet<ReferenceKey>,
    pub complete_resolution: bool,
}

impl LiveGraph {
    pub fn plan_impact(
        &self,
        changed_sources: &std::collections::BTreeSet<vault_core::VaultPath>,
        identity_changes: &[vault_core::ResolutionIdentityChange],
    ) -> ImpactPlan;

    pub fn prepare_delta(
        &self,
        expected: Generation,
        replacement_notes: &[HydratedNote],
        removed_paths: &[vault_core::VaultPath],
        replacement_references: &[HydratedReference],
    ) -> Result<PreparedGraphDelta, IndexError>;

    pub fn install(&mut self, delta: PreparedGraphDelta);
}
```

`prepare_delta` allocates replacement maps/sets before publication. `install` performs only swaps/removals/inserts with reserved capacity and cannot return a recoverable error.

- [ ] **Step 6: Cover add/delete/heading/body impact matrices**

Add tests proving:

- body-only identity equality selects only the changed source's outgoing references;
- heading change selects incoming subpath references but not ordinary incoming file references;
- adding `Foo.md` selects unresolved/resolved/ambiguous `Foo` dependencies;
- deleting it selects the same key family;
- unrelated paths select no unrelated references;
- `LiveGraph` after `install` resolves exactly like a newly hydrated graph.

- [ ] **Step 7: Run focused and full verification**

```bash
cargo test -p vault-index --test live_graph -- --nocapture
cargo test -p vault-index --test round_trip
cargo test --workspace --all-targets
```

- [ ] **Step 8: Commit**

```bash
git add crates/vault-index
git commit -m "feat(index): build compact live resolution graph"
```

---

### Task 4: Introduce schema version 2 and owned diagnostics

**Files:**

- Create: `crates/vault-index/src/schema_v2.sql`
- Create: `crates/vault-index/src/query/diagnostics.rs`
- Modify: `crates/vault-index/src/schema.rs`
- Modify: `crates/vault-index/src/store.rs`
- Modify: `crates/vault-index/src/query.rs`
- Modify: `crates/vault-index/src/cursor.rs`
- Modify: `crates/vault-index/src/codec.rs`
- Create: `crates/vault-index/tests/schema_v2.rs`
- Modify: `crates/vault-index/tests/queries.rs`
- Modify: `crates/vault-index/tests/recovery.rs`

**Interfaces:**

- Consumes: Task 2 `reference_dependencies` and `resolution_diagnostic`, Task 3 hydration inputs.
- Produces: SQL schema/semantic version `2`, `resolution_dependencies`, `resolution_diagnostics`, diagnostic-union query, generation-bound union cursor, and `#[doc(hidden)] IndexService::connection_for_test(&self) -> &rusqlite::Connection` (the accessor the schema tests use; it does not exist yet).
- Removes: the globally materialized aggregate `diagnostics` table from new caches.
- Preserves: public `get_diagnostics` and `get_note` results and ordering.

- [ ] **Step 1: Write schema-shape and diagnostic-equivalence failures**

Create `schema_v2.rs`:

```rust
mod common;

use common::{open_fixture_service, snapshot_from_index, snapshot_from_scan};
use vault_index::{SEMANTIC_FORMAT_VERSION, SQL_SCHEMA_VERSION};

#[test]
fn schema_two_owns_dependencies_and_resolution_diagnostics() {
    assert_eq!(SQL_SCHEMA_VERSION, 2);
    assert_eq!(SEMANTIC_FORMAT_VERSION, 2);

    let mut fixture = open_fixture_service();
    fixture.service.refresh(false).expect("cold build");
    let connection = fixture.service.connection_for_test();
    for table in ["resolution_dependencies", "resolution_diagnostics"] {
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "missing {table}");
    }
    let aggregate: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='diagnostics'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(aggregate, 0);

    assert_eq!(snapshot_from_index(&fixture.service), snapshot_from_scan(&fixture.scan));
}
```

Add a query test whose page size is `1` and whose diagnostics include: a note diagnostic with no stored path, a global scan diagnostic, an unresolved reference, an ambiguous reference, and a missing subpath. Assert no duplicates or skipped rows across cursors.

- [ ] **Step 2: Run tests and observe version/table failures**

```bash
cargo test -p vault-index --test schema_v2
cargo test -p vault-index --test queries diagnostics -- --nocapture
```

Expected: schema constants remain `1`, new tables are absent, and current diagnostic SQL requires the removed aggregate table.

- [ ] **Step 3: Create the complete version-2 schema**

Start `schema_v2.sql` from the exact version-1 table definitions. Retain all note-local and resolution tables, omit `diagnostics`, and add:

```sql
CREATE TABLE resolution_dependencies (
    reference_id INTEGER NOT NULL
        REFERENCES note_references(id) ON DELETE CASCADE,
    dependency_kind TEXT NOT NULL,
    comparison_key TEXT NOT NULL,
    PRIMARY KEY (reference_id, dependency_kind, comparison_key)
);

CREATE TABLE resolution_diagnostics (
    reference_id INTEGER PRIMARY KEY
        REFERENCES note_references(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    path TEXT,
    span_start INTEGER,
    span_end INTEGER
);

CREATE INDEX resolution_dependencies_lookup
    ON resolution_dependencies(dependency_kind, comparison_key, reference_id);
CREATE INDEX resolution_dependencies_reference
    ON resolution_dependencies(reference_id, dependency_kind, comparison_key);
CREATE INDEX resolution_diagnostics_order
    ON resolution_diagnostics(path, span_start, span_end, code, message, reference_id);
```

Keep the existing path, filename/stem, heading/block, source-reference, resolution-target, scan-diagnostic, and note-diagnostic indexes. Set both version constants to `2` and initialize from `SCHEMA_V2`.

- [ ] **Step 4: Make complete publication populate owned rows**

During cold/full graph publication, for every `ResolvedReference`:

1. insert its resolution;
2. insert ordered candidates;
3. call `reference_dependencies(source, LinkTarget::from(reference), resolution)` and insert each key using stable string encodings;
4. call `resolution_diagnostic` and insert zero or one `resolution_diagnostics` row.

Change `replace_graph_rows` to accept only `graph` and semantic scan diagnostics. Remove its aggregate-diagnostics argument. Update the existing test-only `load_graph_for_test` facade so its aggregate-diagnostic verification reads through the same union as queries.

- [ ] **Step 5: Implement the deterministic diagnostic union**

Create one SQL CTE used by `get_diagnostics` and the diagnostics portion of `get_note`:

```sql
WITH all_diagnostics AS (
    SELECT COALESCE(path, note_path) AS path,
           span_start, span_end, code, severity, message,
           'note' AS owner_kind, ordinal AS owner_id
      FROM note_diagnostics
    UNION ALL
    SELECT path, span_start, span_end, code, severity, message,
           'resolution' AS owner_kind, reference_id AS owner_id
      FROM resolution_diagnostics
    UNION ALL
    SELECT path, span_start, span_end, code, severity, message,
           'scan' AS owner_kind, ordinal AS owner_id
      FROM scan_diagnostics
)
```

Sort by nullable path, nullable start/end, code, message, owner kind, and owner ID. In `CursorPosition::Diagnostic`, replace the aggregate-table `id: i64` field with `owner_kind: String` and `owner_id: i64`; cursors are opaque and generation-bound, so removing the old field is not a compatibility change.

- [ ] **Step 6: Add dependency and union query-plan assertions**

Use `EXPLAIN QUERY PLAN` to assert:

- dependency lookup uses `resolution_dependencies_lookup`;
- per-reference cleanup uses the primary key/reference index;
- path/severity diagnostic filters use indexed component scans and do not scan `notes` or `note_references` wholesale;
- backlink and existing list plans remain indexed.

Do not assert unstable numeric SQLite plan IDs; assert table/index names and absence of forbidden full scans.

Also assert, for the semantic fixture, that every stored `resolution_dependencies` row set equals a fresh `reference_dependencies` computation for that reference — stored keys and computed keys must never diverge, because hydration may use either.

- [ ] **Step 7: Prove obsolete-cache rebuild behavior**

Update recovery tests so a valid version-1 derived or explicit cache with matching identity is replaced by schema version 2, while a wrong-vault explicit cache is still refused and busy storage is still never treated as corruption.

- [ ] **Step 8: Verify**

```bash
cargo test -p vault-index --test schema_v2 -- --nocapture
cargo test -p vault-index --test queries
cargo test -p vault-index --test recovery
cargo test -p vault-index --test round_trip
cargo test --workspace --all-targets
```

- [ ] **Step 9: Commit**

```bash
git add crates/vault-index
git commit -m "feat(index): own resolution dependencies in schema two"
```

---

### Task 5: Publish affected SQLite rows only

**Files:**

- Create: `crates/vault-index/src/store/delta.rs`
- Modify: `crates/vault-index/src/store.rs`
- Modify: `crates/vault-index/src/metrics.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Create: `crates/vault-index/tests/delta_publication.rs`
- Modify: `crates/vault-index/tests/common/mod.rs`

**Interfaces:**

- Consumes: schema version 2 and `PreparedGraphDelta`.
- Produces: `NoteReplacement`, `ResolutionReplacement`, `DeltaPublication`, `DeltaPublishOutcome`, `DeltaWriteCounts`, and `IndexStore::publish_delta`.
- Preserves: compare-and-swap expected generation and one-transaction publication.

- [ ] **Step 1: Write a failing unaffected-row-identity test**

Create `delta_publication.rs` with a vault containing `Changed.md`, `Target.md`, and unrelated `Stable.md -> Other.md`. Record the SQLite `note_references.id` and `resolutions.rowid` for `Stable.md`, publish a delta affecting only `Changed.md`, and assert both unrelated IDs and values remain identical.

Add these exact helpers to `tests/common/mod.rs`: `FixtureService::reference_storage_identity(&self, path: &str, ordinal: u32) -> (i64, String)` returning the `note_references.id` and the concatenated resolution-row values for that reference, and `FixtureService::publish_changed_note(&mut self, path: &str, body: &str) -> DeltaPublishOutcome` which writes the file, runs the targeted read/plan/resolve steps, and calls `publish_delta`. Use this structural assertion:

```rust
let before = fixture.reference_storage_identity("Stable.md", 0);
let outcome = fixture.publish_changed_note("Changed.md", "# Changed\n[[Target]]\n");
assert_eq!(outcome.counts.notes_replaced, 1);
assert_eq!(outcome.counts.references_replaced, 1);
assert_eq!(fixture.reference_storage_identity("Stable.md", 0), before);
assert_eq!(outcome.counts.unaffected_references_touched, 0);
```

- [ ] **Step 2: Run and observe missing delta APIs**

```bash
cargo test -p vault-index --test delta_publication
```

Expected: compilation fails because delta publication does not exist.

- [ ] **Step 3: Define exact publication input types**

Add:

```rust
pub struct NoteReplacement {
    pub note: vault_core::ParsedNote,
    pub fingerprint: FileFingerprint,
}

pub struct ResolutionReplacement {
    pub source_path: vault_core::VaultPath,
    pub ordinal: u32,
    pub resolution: vault_core::Resolution,
    pub dependencies: Vec<vault_core::DependencyKey>,
    pub diagnostic: Option<vault_core::Diagnostic>,
}

pub struct DeltaPublication<'a> {
    pub expected: Generation,
    pub notes: &'a [NoteReplacement],
    pub deleted: &'a [vault_core::VaultPath],
    pub fingerprint_updates: &'a [(vault_core::VaultPath, FileFingerprint)],
    pub resolutions: &'a [ResolutionReplacement],
    pub scan_diagnostics: Option<&'a [vault_core::Diagnostic]>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DeltaWriteCounts {
    pub notes_replaced: u64,
    pub notes_deleted: u64,
    pub fingerprints_updated: u64,
    pub references_replaced: u64,
    pub resolutions_replaced: u64,
    pub dependencies_replaced: u64,
    pub diagnostics_replaced: u64,
    pub unaffected_references_touched: u64,
}

pub enum DeltaPublishOutcome {
    Committed { generation: Generation, counts: DeltaWriteCounts },
    GenerationChanged,
}
```

- [ ] **Step 4: Implement transaction ordering**

Inside one transaction:

1. read and compare the current generation;
2. delete removed notes;
3. replace changed note rows, which recreates their source-local reference rows;
4. update metadata-only fingerprints;
5. for each `ResolutionReplacement`, look up `note_references.id` by `(note_path, ordinal)`;
6. delete and insert only that reference's resolution, candidates, dependency keys, and resolution diagnostic;
7. replace scan diagnostics only when `Some` and changed;
8. update generation, refresh time, and last error;
9. commit and return exact row counts.

Prepare SQL statements once per transaction. Do not execute `DELETE FROM resolutions`, `DELETE FROM resolution_candidates`, or any table-wide diagnostic delete in this path.

- [ ] **Step 5: Add rollback and compare-and-swap tests**

Inject failures after changed-note rows and after affected-resolution rows. Assert generation and every public query remain at the prior snapshot. Advance the generation from a second raw connection before publication and assert `GenerationChanged` with zero committed row changes.

- [ ] **Step 6: Add SQL trace forbidden-statement assertions**

In a test-only trace collector, reject exact table-wide deletes and count paths touched. The body-only fixture must prove unrelated `note_references`, `resolutions`, `resolution_candidates`, `resolution_dependencies`, and diagnostics are untouched.

- [ ] **Step 7: Merge write counts into Task 1 metrics**

Map `DeltaWriteCounts` into `WorkCounts` without changing protocol responses. Keep full-publication counters available for fallback benchmark comparison.

- [ ] **Step 8: Verify**

```bash
cargo test -p vault-index --test delta_publication -- --nocapture
cargo test -p vault-index --test schema_v2
cargo test -p vault-index --test recovery
cargo test --workspace --all-targets
```

- [ ] **Step 9: Commit**

```bash
git add crates/vault-index
git commit -m "feat(index): publish semantic row deltas atomically"
```

---

### Task 6: Separate read snapshots from the writer

**Files:**

- Create: `crates/vault-index/src/reader.rs`
- Modify: `crates/vault-index/src/model.rs`
- Modify: `crates/vault-index/src/query.rs`
- Modify: `crates/vault-index/src/reconcile.rs`
- Modify: `crates/vault-index/src/schema.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Create: `crates/vault-index/tests/live_reader.rs`
- Modify: `crates/vault-index/tests/queries.rs`

**Interfaces:**

- Produces: `LiveState`, `PublishedState`, `PublicationBarrier`, `IndexReader`, `IndexService::reader`.
- Read methods move to or delegate through `IndexReader`; existing `IndexService` query calls remain source-compatible for Phase 3 tests.
- `resolve_link` uses the published compact graph and no longer needs `&mut self`.

- [ ] **Step 1: Write a failing old-or-new generation read test**

Create `live_reader.rs` with a test barrier that pauses publication after SQLite commit and before live installation. Start a read during that pause and assert it blocks; after release it returns the new generation and new resolution. A read started before the writer acquires the barrier must finish entirely at the old generation.

```rust
assert_eq!(old_read.generation.get(), old_generation.get());
assert_eq!(new_read.generation.get(), old_generation.get() + 1);
assert_ne!(old_read.note.revision, new_read.note.revision);
```

- [ ] **Step 2: Observe missing reader/barrier APIs**

```bash
cargo test -p vault-index --test live_reader
```

- [ ] **Step 3: Define publication state**

Add to `model.rs`:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveState {
    Starting,
    CatchingUp,
    Watching,
    PollingFallback,
    Stopped,
}

#[derive(Clone)]
pub struct PublishedState {
    pub generation: Option<Generation>,
    pub graph: Option<std::sync::Arc<crate::LiveGraph>>,
    pub live_state: LiveState,
    pub runtime_error: Option<String>,
}

pub type PublicationBarrier =
    std::sync::Arc<std::sync::RwLock<PublishedState>>;
```

Handle poisoned locks as `IndexError::Storage`; do not `unwrap` production locks.

- [ ] **Step 4: Add a read-only connection opener**

Implement `schema::open_reader(config)` using SQLite read/write access to the same WAL database without schema initialization, rebuild, or recovery deletion. It validates schema version and vault identity and applies foreign keys, busy timeout, and read-query pragmas. Opening a reader must never create or replace a cache.

- [ ] **Step 5: Move query execution behind `IndexReader`**

Define:

```rust
pub struct IndexReader {
    config: IndexConfig,
    connection: std::sync::Mutex<rusqlite::Connection>,
    published: PublicationBarrier,
}
```

For every query:

1. acquire the publication read guard;
2. lock the reader connection;
3. begin a SQLite read transaction;
4. read the generation inside that transaction;
5. require equality with the guard generation;
6. execute the complete query and commit/drop the transaction;
7. release locks.

Use the lock order `publication barrier -> reader connection` everywhere. The writer never takes the reader-connection mutex.

- [ ] **Step 6: Publish full and delta paths through the barrier**

Before either SQLite publication begins, prepare the graph state. Hold the publication write guard across writer-connection commit and installation of the matching `Arc<LiveGraph>`. Release it before event work. A crash-only allocation failure after commit is acceptable; ordinary fallible allocation must happen before the barrier.

- [ ] **Step 7: Preserve existing query API tests**

Keep `IndexService::{vault_info,list_notes,get_note,get_backlinks,list_references,get_diagnostics,resolve_link}` as delegating compatibility methods for existing tests. Add `IndexService::reader() -> Result<IndexReader, IndexError>` for server/runtime ownership.

- [ ] **Step 8: Verify concurrent snapshots and regression queries**

```bash
cargo test -p vault-index --test live_reader -- --nocapture
cargo test -p vault-index --test queries
cargo test -p vault-index --test indexed_operations
cargo test --workspace --all-targets
```

- [ ] **Step 9: Commit**

```bash
git add crates/vault-index
git commit -m "refactor(index): isolate generation-consistent readers"
```

---

### Task 7: Reconcile stable dirty paths incrementally

**Files:**

- Create: `crates/vault-index/src/live_reconcile.rs`
- Modify: `crates/vault-index/src/inventory.rs`
- Modify: `crates/vault-index/src/reconcile.rs`
- Modify: `crates/vault-index/src/live_graph.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Modify: `crates/vault-index/tests/common/mod.rs`
- Create: `crates/vault-index/tests/live_reconciliation.rs`

**Interfaces:**

- Consumes: Tasks 2–6.
- Produces: `ChangeCause`, `PathChanges`, `LiveRefreshReport`, `ReconcileSource::fingerprint`, and `IndexService::refresh_paths`.
- Preserves: `refresh(false)` and `refresh(true)`; once hydrated, their discovered dirty sets use the same planner/delta publisher.

- [ ] **Step 1: Write the 100k-path structural contract as a small deterministic test**

Create `live_reconciliation.rs`:

```rust
mod common;

use std::collections::BTreeSet;
use common::counting_service_with_two_notes;
use vault_core::VaultPath;
use vault_index::ChangeCause;

#[test]
fn body_only_dirty_path_avoids_global_work() {
    let mut fixture = counting_service_with_two_notes();
    fixture.service.refresh(false).expect("cold build");
    fixture.service.hydrate_live_graph().expect("hydrate");
    fixture.reset_counts();
    fixture.write_note("One.md", "# One changed\n");

    let paths = BTreeSet::from([VaultPath::new("One.md").unwrap()]);
    let report = fixture
        .service
        .refresh_paths(paths, ChangeCause::Watcher)
        .expect("live refresh");

    assert_eq!(report.metrics.work.complete_inventories, 0);
    assert_eq!(report.metrics.work.body_reads, 1);
    assert_eq!(report.metrics.work.notes_reparsed, 1);
    assert_eq!(report.metrics.work.changed_notes, 1);
    assert_eq!(report.metrics.work.unaffected_references_touched, 0);
}
```

Add a note with no outgoing references so the expected `affected_references` count is exactly zero.

- [ ] **Step 2: Run and observe missing targeted reconciliation**

```bash
cargo test -p vault-index --test live_reconciliation body_only -- --nocapture
```

- [ ] **Step 3: Add point fingerprinting**

Extend `ReconcileSource`:

```rust
fn fingerprint(
    &self,
    path: &vault_core::VaultPath,
) -> Result<Option<FileFingerprint>, IndexError>;
```

`FileSystemIndexSource` returns `None` only for `NotFound`; other metadata errors become stable diagnostics/errors according to existing policy. Update every fake source explicitly.

- [ ] **Step 4: Define reports and exact change-set semantics**

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChangeCause { Watcher, Startup, Periodic, Manual, Verified }

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PathChanges {
    pub created: Vec<vault_core::VaultPath>,
    pub modified: Vec<vault_core::VaultPath>,
    pub deleted: Vec<vault_core::VaultPath>,
}

pub struct LiveRefreshReport {
    pub previous_generation: Option<Generation>,
    pub generation: Generation,
    pub cause: ChangeCause,
    pub changes: PathChanges,
    pub affected_reference_count: u64,
    pub complete_resolution: bool,
    pub metrics: ReconcileMetrics,
}
```

Sort/deduplicate all path vectors. A metadata-only fingerprint update with identical revision returns the same generation and empty semantic `PathChanges`.

- [ ] **Step 5: Implement stable path reading**

For each dirty path:

1. fingerprint before read;
2. if absent, classify deletion;
3. read bytes exactly once;
4. validate UTF-8 and create `SourceDocument`/revision;
5. fingerprint after read;
6. require equality or return `VaultChangedDuringRefresh` with the path eligible for retry;
7. compare revision before parsing;
8. parse only changed revisions.

Immediately before acquiring the publication barrier, fingerprint every changed path once more and require the planned present/absent state. No complete inventory is permitted in `refresh_paths`.

- [ ] **Step 6: Construct and publish the candidate**

Build old/new `ResolutionIdentityChange` values, update a candidate resolver catalog with additions/removals, select the conservative `ImpactPlan`, resolve the changed sources plus affected incoming references, generate dependencies/diagnostics, create `DeltaPublication` and `PreparedGraphDelta`, then publish/install through Task 6's barrier.

If the estimated affected set exceeds the initial policy `max(10_000, total_references / 4)`, set `complete_resolution = true` and resolve every stored reference from the compact graph. Keep the threshold in one named function and expose the chosen cardinalities in metrics so Task 14 can tune it.

- [ ] **Step 7: Route normal and verified refresh through dirty sets**

Keep cold build on the complete path. When a live graph exists:

- normal refresh inventories metadata, calculates dirty paths, and calls the same targeted engine;
- verified refresh reads/hashes all bodies, identifies changed revisions, and calls the same targeted engine without reparsing identical bodies;
- full resolution fallback uses compact stored references and does not load or parse unchanged source.

- [ ] **Step 8: Cover the invalidation matrix**

Add exact tests for body-only, outgoing reference, heading/block add/remove, note add, delete, rename-as-delete-plus-add, unresolved-to-resolved, resolved-to-ambiguous, ambiguous-to-resolved, unreadable, invalid UTF-8, permanently unusable no-generation churn, metadata-only touch, and fingerprint instability.

After each case compare `snapshot_from_index` with a clean `scan_vault` snapshot.

- [ ] **Step 9: Verify structural counters and equivalence**

```bash
cargo test -p vault-index --test live_reconciliation -- --nocapture
cargo test -p vault-index --test incremental_reconciliation
cargo test -p vault-index --test reconciliation_oracle
cargo test -p vault-index --test queries
cargo test --workspace --all-targets
```

- [ ] **Step 10: Commit**

```bash
git add crates/vault-index
git commit -m "feat(index): reconcile dirty paths incrementally"
```

---

### Task 8: Validate storage paths and hold the writer lease

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `crates/vault-index/Cargo.toml`
- Create: `crates/vault-index/src/lease.rs`
- Modify: `crates/vault-index/src/config.rs`
- Modify: `crates/vault-index/src/error.rs`
- Modify: `crates/vault-index/src/reconcile.rs`
- Modify: `crates/vault-index/src/schema.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Modify: `crates/vault-server/src/convert.rs`
- Create: `crates/vault-index/tests/lease.rs`
- Modify: `crates/vault-index/tests/recovery.rs`
- Modify: `crates/vault-index/tests/common/mod.rs`

**Interfaces:**

- Adds dependency: `fs2 = "0.4.3"` (verified during planning: compiles and locks on Rust 1.85 with `try_lock_exclusive`).
- Produces: `IndexLease`, `IndexConfig::prepare_storage`, `IndexConfig::lease_path`, `IndexError::IndexInUse`.
- Production `IndexService::open*` holds the lease for its lifetime; test-only raw/CAS helpers are explicitly named and hidden.

- [ ] **Step 1: Write path-safety and contention tests**

Create `lease.rs`:

```rust
use vault_index::{IndexConfig, IndexError, IndexLease};

#[test]
fn explicit_index_and_lease_inside_vault_are_refused_before_creation() {
    let vault = tempfile::tempdir().unwrap();
    let inside = vault.path().join(".derived/index.sqlite3");
    let error = IndexConfig::explicit(vault.path(), &inside).unwrap_err();
    assert!(matches!(error, IndexError::InvalidIndexPath(_)));
    assert!(!inside.exists());
    assert!(!inside.with_extension("sqlite3.lock").exists());
}

#[test]
fn exactly_one_exclusive_lease_can_be_held() {
    let vault = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut config = IndexConfig::explicit(
        vault.path(),
        cache.path().join("index.sqlite3"),
    ).unwrap();
    config.prepare_storage().unwrap();
    let first = IndexLease::acquire(&config).unwrap();
    let second = IndexLease::acquire(&config).unwrap_err();
    assert!(matches!(second, IndexError::IndexInUse));
    drop(first);
    IndexLease::acquire(&config).expect("lease released with file handle");
}
```

Add symlink-parent and relative-path cases so a lexical path outside the vault that resolves through a symlink into the vault is refused.

- [ ] **Step 2: Run and observe missing validation/lease behavior**

```bash
cargo test -p vault-index --test lease -- --nocapture
```

- [ ] **Step 3: Pin `fs2` and verify its API on Rust 1.85**

Add:

```toml
[workspace.dependencies]
fs2 = "0.4.3"
```

and `fs2.workspace = true` to `vault-index`. Run:

```bash
cargo +1.85.0 check -p vault-index --all-targets
```

Expected: pass before implementation continues.

- [ ] **Step 4: Validate storage before any create**

Add `InvalidIndexPath(String)` to `IndexError`. `IndexConfig::explicit` must:

1. canonicalize the vault root;
2. convert a relative index path to an absolute lexical path;
3. normalize `.` and `..` without following the nonexistent final file;
4. reject a path lexically inside the canonical vault;
5. retain the normalized path without creating anything.

`prepare_storage(&mut self)` must create the parent, canonicalize it, reject a canonical/symlink-resolved parent inside the vault, and replace `index_path` with `canonical_parent.join(file_name)`. Derived XDG paths go through the same post-create attestation.

Use an `OsString` suffix append for the lease path so `index.sqlite3` becomes `index.sqlite3.lock` without assuming UTF-8.

- [ ] **Step 5: Acquire and retain an advisory lease**

Implement:

```rust
pub struct IndexLease {
    file: std::fs::File,
    path: std::path::PathBuf,
}

impl IndexLease {
    pub fn acquire(config: &IndexConfig) -> Result<Self, IndexError>;
    pub fn path(&self) -> &std::path::Path;
}
```

Open the already-validated sibling path read/write/create, call `fs2::FileExt::try_lock_exclusive`, map `WouldBlock` and `fs2::lock_contended_error().kind()` to `IndexInUse`, and retain the file. Never truncate or delete the lock file. Other I/O failures remain storage failures.

The server's exhaustive `convert::index_error` match must gain arms in this task or it stops compiling: map `InvalidIndexPath` to the protocol `InvalidPath` code, and map `IndexInUse` to `StorageFailure` as an interim value; Task 12 re-maps `IndexInUse` to its dedicated Task 11 code before anything user-visible ships.

- [ ] **Step 6: Make production service opening leased**

Add `_lease: IndexLease` to `IndexService`. Order opening as `prepare storage -> acquire lease -> open/recover SQLite -> create reader/live state`. A second production service for the same index fails before SQLite recovery.

Keep one `#[doc(hidden)] open_unleased_for_cas_test` constructor used only by the existing compare-and-swap defense test. Rename/update that test so the production exclusivity and underlying CAS behavior are both explicit.

- [ ] **Step 7: Verify busy/corrupt recovery remains safe**

Run:

```bash
cargo test -p vault-index --test lease -- --nocapture
cargo test -p vault-index --test recovery
cargo test -p vault-index --test incremental_reconciliation concurrent
cargo +1.85.0 check --workspace --all-targets
cargo test --workspace --all-targets
```

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml Cargo.lock crates/vault-index
git commit -m "feat(index): hold a validated exclusive writer lease"
```

---

### Task 9: Add the bounded filesystem watcher adapter

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Create: `crates/vault-watch/Cargo.toml`
- Create: `crates/vault-watch/src/lib.rs`
- Create: `crates/vault-watch/src/filter.rs`
- Create: `crates/vault-watch/src/debounce.rs`
- Create: `crates/vault-watch/src/backend.rs`
- Create: `crates/vault-watch/tests/filter.rs`
- Create: `crates/vault-watch/tests/debounce.rs`
- Create: `crates/vault-watch/tests/filesystem_smoke.rs`

**Interfaces:**

- Adds dependency: `notify = "8.2.0"` (verified during planning: `recommended_watcher` + `RecursiveMode` compile on Rust 1.85).
- Produces: `ChangeHint`, `WatchConfig`, `WatchError`, `WatchStream::start`, `WatchStream::recv_timeout`, and path-filter helpers.
- Consumes: `vault_core::VaultPath` only; no dependency on index, protocol, or server.

- [ ] **Step 1: Scaffold the crate through failing filter/debounce tests**

Add `crates/vault-watch` to workspace members and create its manifest:

```toml
[package]
name = "vault-watch"
version.workspace = true
edition.workspace = true
rust-version.workspace = true

[dependencies]
notify.workspace = true
thiserror.workspace = true
vault-core = { path = "../vault-core" }

[dev-dependencies]
tempfile.workspace = true
```

Create tests that import missing public types, then run `cargo test -p vault-watch` and observe compile failure.

- [ ] **Step 2: Pin `notify` and pass the MSRV check immediately**

Add `notify = "8.2.0"` to workspace dependencies and run:

```bash
cargo +1.85.0 check -p vault-watch --all-targets
```

Expected: the empty/scaffolded crate compiles on 1.85 before watcher code is added.

- [ ] **Step 3: Define the watcher boundary**

In `lib.rs` export:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChangeHint {
    Paths(std::collections::BTreeSet<vault_core::VaultPath>),
    Overflow,
    RootInvalidated,
    WatcherFailed(String),
}

#[derive(Clone, Debug)]
pub struct WatchConfig {
    pub debounce: std::time::Duration,
    pub max_dirty_paths: usize,
    pub callback_queue: usize,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            debounce: std::time::Duration::from_millis(100),
            max_dirty_paths: 8_192,
            callback_queue: 1_024,
        }
    }
}

pub struct WatchStream;

impl WatchStream {
    pub fn start(root: impl AsRef<std::path::Path>, config: WatchConfig)
        -> Result<Self, WatchError>;
    pub fn recv_timeout(&mut self, timeout: std::time::Duration)
        -> Result<Option<ChangeHint>, WatchError>;
}
```

`WatchStream` owns the `notify::RecommendedWatcher`; dropping it stops watching and releases its sender.

- [ ] **Step 4: Implement safe event-path filtering**

`filter.rs` exposes a crate-public function:

```rust
pub(crate) fn normalize_included_markdown(
    canonical_root: &std::path::Path,
    event_path: &std::path::Path,
) -> Result<Option<vault_core::VaultPath>, WatchError>;
```

It supports nonexistent/deleted paths through lexical normalization, rejects `..` escape, rejects non-UTF-8 relative paths, ignores `.obsidian`, hidden directory components, and non-`.md` files, and returns paths using `/`. Existing `FileSystemVaultSource` inclusion fixtures must have parallel watcher assertions.

- [ ] **Step 5: Implement bounded debounce and overflow latching**

`Debouncer` owns a `BTreeSet<VaultPath>`, first/last hint instants, and overflow flag. Its exact behavior:

- insert duplicate paths once;
- emit after no new path for the configured debounce duration;
- when `max_dirty_paths` would be exceeded, clear detail and emit one `Overflow`;
- once overflowed, ignore detailed paths until that overflow is consumed;
- root invalidation outranks paths;
- watcher failure is emitted without unbounded string accumulation.

Use a fake clock in unit tests; do not sleep in debounce unit tests.

- [ ] **Step 6: Implement the nonblocking `notify` callback**

Use:

```rust
let mut watcher = notify::recommended_watcher(move |result| {
    if callback_tx.try_send(result).is_err() {
        overflow_latch.store(true, std::sync::atomic::Ordering::Release);
    }
})?;
watcher.watch(&canonical_root, notify::RecursiveMode::Recursive)?;
```

The actual channel is a bounded `sync_channel`; adapt the closure to its `TrySendError` API. Map create/modify/remove/rename/any events to paths, access-only events to no hint, root removal/rename to `RootInvalidated`, backend errors to `WatcherFailed`, and a set overflow latch to `Overflow` before processing more detail.

- [ ] **Step 7: Add one tolerant real-filesystem smoke test**

Create/modify/delete a Markdown file under a temporary watched root and wait with an overall two-second deadline for a `Paths` hint containing it. Do not assert raw event count, order, or rename pairing. Keep deterministic behavior in fake/debounce tests.

- [ ] **Step 8: Verify**

```bash
cargo test -p vault-watch --test filter
cargo test -p vault-watch --test debounce
cargo test -p vault-watch --test filesystem_smoke -- --nocapture
cargo +1.85.0 check --workspace --all-targets
cargo test --workspace --all-targets
```

- [ ] **Step 9: Commit**

```bash
git add Cargo.toml Cargo.lock crates/vault-watch
git commit -m "feat(watch): emit bounded normalized change hints"
```

---

### Task 10: Run startup catch-up and all mutations through one coordinator

**Files:**

- Create: `crates/vault-server/src/runtime.rs`
- Modify: `crates/vault-server/Cargo.toml`
- Modify: `crates/vault-server/src/lib.rs`
- Modify: `crates/vault-server/src/convert.rs`
- Modify: `crates/vault-index/src/model.rs`
- Modify: `crates/vault-index/src/live_reconcile.rs`
- Create: `crates/vault-server/tests/runtime.rs`
- Create: `crates/vault-server/tests/startup.rs`

**Interfaces:**

- Consumes: `WatchStream`, leased `IndexService`, `IndexReader`, `refresh_paths`, and full refresh.
- Produces: `RuntimeOptions`, `RuntimeCommand`, `RuntimeNotice`, `RuntimeHandle`, and `Runtime::start(config: IndexConfig, options: RuntimeOptions, notices: std::sync::mpsc::SyncSender<RuntimeNotice>) -> Result<RuntimeHandle, ServerStartupError>`.
- Later subscription code consumes `RuntimeNotice`; it does not receive protocol DTOs.

- [ ] **Step 1: Write cached-read-before-catch-up and serialization tests**

Create a valid index, stop its service, change a vault note, then start a runtime with a test barrier before catch-up. Assert:

- an `IndexReader` query immediately returns the previous committed generation;
- live state is `CatchingUp`;
- after releasing catch-up, the changed note publishes one new generation;
- a manual refresh queued during catch-up runs afterward, never concurrently.

Record the maximum active mutation count with an atomic test counter and assert it is `1`.

- [ ] **Step 2: Run and observe missing runtime APIs**

```bash
cargo test -p vault-server --test runtime -- --nocapture
cargo test -p vault-server --test startup -- --nocapture
```

- [ ] **Step 3: Define runtime configuration and commands**

```rust
#[derive(Clone, Debug)]
pub struct RuntimeOptions {
    pub watch: bool,
    pub watch_config: vault_watch::WatchConfig,
    pub reconcile_interval: Option<std::time::Duration>,
    pub command_capacity: usize,
}

impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            watch: true,
            watch_config: vault_watch::WatchConfig::default(),
            reconcile_interval: Some(std::time::Duration::from_secs(60)),
            command_capacity: 256,
        }
    }
}

pub enum RuntimeCommand {
    Hint(vault_watch::ChangeHint),
    Refresh {
        verify: bool,
        reply: std::sync::mpsc::SyncSender<Result<vault_index::RefreshReport, vault_index::IndexError>>,
    },
    Stop,
}

#[derive(Clone, Debug)]
pub enum RuntimeNotice {
    Generation(vault_index::LiveRefreshReport),
    State {
        generation: Option<vault_index::Generation>,
        state: vault_index::LiveState,
        error: Option<String>,
    },
    ResyncRequired {
        generation: Option<vault_index::Generation>,
        reason: ResyncReason,
    },
}
```

`ResyncReason` is internal and has `WatcherOverflow`, `RootInvalidated`, and `RuntimeRecovered` variants.

- [ ] **Step 4: Make the coordinator the only mutation owner**

`Runtime::start(config, options, notice_sink)` opens the leased writer and reader, returns a clonable handle, then moves the writer into one named coordinator thread. Only this thread calls refresh, live graph hydration, or publication.

Use one bounded `sync_channel<RuntimeCommand>`. A watcher-forwarder thread and periodic timer send commands; neither owns index state. On callback/command saturation, set an atomic overflow latch and ensure the next accepted command is `Hint(Overflow)`.

- [ ] **Step 5: Implement startup ordering**

The coordinator must:

1. expose the last committed `IndexReader` immediately;
2. publish `CatchingUp`;
3. install/start the watcher before inventory catch-up when watching is enabled;
4. hydrate the compact graph without source bodies;
5. run normal metadata reconciliation;
6. drain queued hints;
7. publish `Watching`, or `PollingFallback` if watcher installation failed;
8. start periodic ticks only after initial catch-up ordering is established.

With no existing generation, only health/state is available until cold build publishes generation 1.

- [ ] **Step 6: Implement deletion grace without blocking all work**

When a hinted path is absent, store it in `pending_deletions` with `deadline = now + debounce`. Use `recv_timeout` until the nearest deadline. At the deadline, fingerprint again: reappeared paths become modification candidates; still-absent paths enter one batch as deletions. A later hint updates/coalesces the same entry.

- [ ] **Step 7: Serialize manual and periodic refreshes**

`RuntimeHandle::refresh(verify)` sends a command and waits for its one-shot reply. Earlier hints are processed before the command according to mailbox order; later hints remain queued. Periodic ticks use normal refresh and are skipped/coalesced when one is already pending. A zero/`None` interval creates no timer thread.

- [ ] **Step 8: Degrade safely when watching fails**

Watcher installation or later backend failure publishes `PollingFallback` plus a stable error and retains periodic/manual reconciliation. Overflow/root invalidation publishes `CatchingUp`, runs complete metadata reconciliation plus conservative resolution, sends `ResyncRequired`, and returns to `Watching` if the stream remains usable.

- [ ] **Step 9: Implement clean shutdown**

Dropping the final `RuntimeHandle` or explicit `shutdown` sends `Stop`, joins coordinator/forwarder/timer threads, drops the watcher, changes state to `Stopped`, and releases the lease. No production thread may be detached silently.

- [ ] **Step 10: Verify**

```bash
cargo test -p vault-server --test runtime -- --nocapture
cargo test -p vault-server --test startup -- --nocapture
cargo test -p vault-index --test lease
cargo test -p vault-index --test live_reconciliation
cargo test --workspace --all-targets
```

- [ ] **Step 11: Commit**

```bash
git add crates/vault-index crates/vault-server
git commit -m "feat(server): coordinate live vault reconciliation"
```

---

### Task 11: Add protocol version 1 subscription and event DTOs

**Files:**

- Create: `crates/vault-protocol/src/events.rs`
- Modify: `crates/vault-protocol/src/lib.rs`
- Modify: `crates/vault-protocol/src/envelope.rs`
- Modify: `crates/vault-protocol/src/error.rs`
- Modify: `crates/vault-protocol/src/operations.rs`
- Modify: `crates/vault-protocol/src/semantic.rs`
- Create: `crates/vault-protocol/tests/events.rs`
- Modify: `crates/vault-protocol/tests/indexed_operations.rs`
- Modify: `crates/vault-protocol/tests/schema.rs`

**Interfaces:**

- Consumes: no core/index/server types.
- Produces: subscription request/response DTOs, `LiveStateDto`, `GenerationCauseDto`, `ChangeSetDto`, `RuntimeEventDto`, `EventEnvelope`, and new stable error codes.
- Preserves: `PROTOCOL_VERSION == 1`, `ResponseEnvelope`, response IDs, and all existing serialized request/response fixtures.

- [ ] **Step 1: Write exact JSON schema tests**

Create `events.rs` with round trips for these exact shapes:

```json
{"version":1,"id":"s1","request":{"method":"subscribe_events","params":{}}}
```

```json
{"version":1,"subscription_id":"sub-1","event":{"type":"generation_committed","value":{"previous_generation":7,"generation":8,"cause":"watcher","changes":{"kind":"detailed","created":[],"modified":["Note.md"],"deleted":[]},"affected_note_count":1,"affected_reference_count":3}}}
```

```json
{"version":1,"subscription_id":"sub-1","event":{"type":"resync_required","value":{"current_generation":8,"reason":"subscriber_lag"}}}
```

Also round-trip `generation: null` for a runtime-state event before the first build.

- [ ] **Step 2: Run and observe missing DTOs**

```bash
cargo test -p vault-protocol --test events -- --nocapture
```

- [ ] **Step 3: Define additive operation types**

Add:

```rust
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct SubscribeEventsParams {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UnsubscribeParams {
    pub subscription_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SubscribeEventsResponse {
    pub subscription_id: String,
    pub generation: Option<u64>,
    pub live_state: LiveStateDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UnsubscribeResponse {
    pub subscription_id: String,
}
```

Add `Request::SubscribeEvents(SubscribeEventsParams)` and `Request::Unsubscribe(UnsubscribeParams)`, with matching response variants.

- [ ] **Step 4: Define runtime state and event DTOs**

In `events.rs`:

```rust
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveStateDto { Starting, CatchingUp, Watching, PollingFallback, Stopped }

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationCauseDto { Watcher, Startup, Periodic, Manual, Verified }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChangeSetDto {
    Detailed { created: Vec<String>, modified: Vec<String>, deleted: Vec<String> },
    CountsOnly { created: u64, modified: u64, deleted: u64 },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResyncReasonDto { SubscriberLag, OversizedChangeSet, RuntimeRecovered }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum RuntimeEventDto {
    GenerationCommitted(GenerationCommittedEventDto),
    RuntimeStateChanged(RuntimeStateChangedEventDto),
    ResyncRequired(ResyncRequiredEventDto),
}
```

Define the three value structs with exactly the fields in the JSON fixtures/design.

- [ ] **Step 5: Add the distinct event envelope**

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EventEnvelope {
    pub version: u16,
    pub subscription_id: String,
    pub event: RuntimeEventDto,
}

impl EventEnvelope {
    pub fn new(subscription_id: impl Into<String>, event: RuntimeEventDto) -> Self {
        Self { version: PROTOCOL_VERSION, subscription_id: subscription_id.into(), event }
    }
}
```

Do not add `id` or `outcome` to event envelopes.

- [ ] **Step 6: Add optional live state to vault info safely**

Append to `GetVaultInfoResponse`:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub live_state: Option<LiveStateDto>,
```

Prove an old JSON fixture without the field still deserializes and serializes without a synthetic field. Prove existing clients may ignore the new field under Serde's default unknown-field behavior.

- [ ] **Step 7: Add stable error variants**

Append `IndexInUse`, `WatchUnavailable`, `SubscriptionNotFound`, `RuntimeNotReady`, and `RuntimeOverloaded` to `ErrorCode`. Update conversion/schema tests; do not alter existing spellings.

- [ ] **Step 8: Verify the entire protocol surface**

```bash
cargo test -p vault-protocol --test events -- --nocapture
cargo test -p vault-protocol --test indexed_operations
cargo test -p vault-protocol --test schema
cargo test --workspace --all-targets
```

- [ ] **Step 9: Commit**

```bash
git add crates/vault-protocol
git commit -m "feat(protocol): describe live generation events"
```

---

### Task 12: Multiplex bounded subscriptions over stdio

**Files:**

- Create: `crates/vault-server/src/subscriptions.rs`
- Create: `crates/vault-server/src/stdio.rs`
- Modify: `crates/vault-server/src/runtime.rs`
- Modify: `crates/vault-server/src/lib.rs`
- Modify: `crates/vault-server/src/main.rs`
- Modify: `crates/vault-server/src/convert.rs`
- Create: `crates/vault-server/tests/subscriptions.rs`
- Create: `crates/vault-server/tests/live_stdio.rs`
- Modify: `crates/vault-server/tests/stdio.rs`
- Modify: `crates/vault-server/tests/indexed_dispatch.rs`
- Modify: `crates/vault-server/tests/docs.rs`

**Interfaces:**

- Consumes: Task 10 `RuntimeHandle`/`RuntimeNotice` and Task 11 DTOs.
- Produces: `SubscriptionRegistry`, `ServerInput`, `OutputEnvelope`, `run_stdio`, runtime-notice conversion.
- Guarantees: one stdout owner, subscribe-response-before-event, unsubscribe-response-after-queued-events, 64-event subscription bound, no events for unsubscribed clients.

- [ ] **Step 1: Write subscription ordering and unchanged-stdio failures**

Create tests that run the real binary with a temporary vault/index:

1. send `subscribe_events`;
2. parse and retain the subscription response;
3. edit one note;
4. assert the next matching event names a greater committed generation;
5. issue `get_note` and assert its generation/source match the event;
6. unsubscribe and prove no later event uses that subscription ID.

Retain the existing `vaultd_with_explicit_vault_serves_note_then_refresh_requests` test and assert that an unsubscribed stream contains only `ResponseEnvelope` lines with byte-compatible top-level keys.

- [ ] **Step 2: Run and observe missing server event support**

```bash
cargo test -p vault-server --test subscriptions -- --nocapture
cargo test -p vault-server --test live_stdio -- --nocapture
```

- [ ] **Step 3: Define the bounded registry**

```rust
const SUBSCRIBER_CAPACITY: usize = 64;
const DETAILED_PATH_LIMIT: usize = 1_024;

struct Subscription {
    id: String,
    queue: std::collections::VecDeque<vault_protocol::EventEnvelope>,
    lagged_at: Option<u64>,
    active: bool,
}

pub struct SubscriptionRegistry {
    next_id: u64,
    subscriptions: std::collections::BTreeMap<String, Subscription>,
}
```

`subscribe` allocates `sub-{counter}` within the process. The identifier is opaque, not a security token. `enqueue_notice` converts detailed paths when total paths are at most 1,024; otherwise it enqueues counts-only generation plus `ResyncRequired(OversizedChangeSet)`.

- [ ] **Step 4: Implement lag coalescing**

When a subscription queue would exceed 64:

1. remove queued generation events;
2. retain at most the newest runtime-state event;
3. enqueue one `ResyncRequired { current_generation, SubscriberLag }`;
4. record the latest generation and ignore additional generation detail until that marker drains;
5. resume future events after it drains.

Unit tests push 1,000 notices without draining and assert queue length never exceeds 64 and the marker names the latest generation.

- [ ] **Step 5: Use one dispatcher input channel**

Define:

```rust
pub enum ServerInput {
    Request(RawRequestEnvelope),
    Notice(RuntimeNotice),
    InputClosed,
    FatalInput(String),
}

pub enum OutputEnvelope {
    Response(vault_protocol::ResponseEnvelope),
    Event(vault_protocol::EventEnvelope),
}
```

The stdin reader thread and runtime notice sink both feed one bounded dispatcher channel. The dispatcher owns `Server` and `SubscriptionRegistry`. The stdout writer thread is the only code that serializes/writes output lines.

- [ ] **Step 6: Enforce subscribe/unsubscribe ordering**

For subscribe:

1. reserve the ID but keep it inactive;
2. enqueue the successful response to the single output stream;
3. activate the subscription at the returned generation;
4. only then deliver later notices.

For unsubscribe:

1. drain already-queued events for that ID to the output stream;
2. mark it inactive/remove it;
3. enqueue the successful response;
4. reject later enqueue attempts.

Because requests and notices share the dispatcher order, registration is definitively before or after each commit notice.

While no committed generation exists, do not emit `resync_required` (its `current_generation` field is non-optional); the first `generation_committed` after the cold build supersedes any pending resynchronization.

- [ ] **Step 7: Route server operations through the runtime handle**

Refactor configured `Server` to own `RuntimeHandle`/`IndexReader`, not a mutable `IndexService`. Read operations call the reader. `refresh_index` calls the coordinator and blocks only that request for its reply. Health-only mode remains allocation-light and creates no watcher, lease, graph, or timer.

Convert `IndexError::IndexInUse` and runtime errors to Task 11 codes. `get_vault_info` fills optional live state from the handle.

- [ ] **Step 8: Add CLI flags and range checks**

Extend `Cli` with:

```rust
#[arg(long, default_value_t = false)]
no_watch: bool,
#[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u64).range(10..=5_000))]
watch_debounce_ms: u64,
#[arg(long, default_value_t = 60)]
reconcile_interval_seconds: u64,
```

Map interval `0` to `None`. Keep `--index` requiring `--vault` and start no runtime in health-only mode.

- [ ] **Step 9: Preserve malformed/future/unknown-input behavior**

Retain two-stage version validation. Unknown version-1 methods return `invalid_request` and the process continues. A structurally malformed top-level input still prints `vaultd: ...` and exits `2` with no partial JSON line. Writer errors and stdin closure perform clean runtime shutdown.

- [ ] **Step 10: Verify**

```bash
cargo test -p vault-server --test subscriptions -- --nocapture
cargo test -p vault-server --test live_stdio -- --nocapture
cargo test -p vault-server --test stdio
cargo test -p vault-server --test indexed_dispatch
cargo test -p vault-server --test health
cargo test --workspace --all-targets
```

- [ ] **Step 11: Commit**

```bash
git add crates/vault-server
git commit -m "feat(server): stream bounded post-commit events"
```

---

### Task 13: Force races, recovery paths, and randomized live equivalence

**Files:**

- Create: `crates/vault-index/src/test_hook.rs`
- Create: `crates/vault-index/tests/live_races.rs`
- Create: `crates/vault-index/tests/live_oracle.rs`
- Modify: `crates/vault-index/tests/common/mod.rs`
- Modify: `crates/vault-index/src/live_reconcile.rs`
- Modify: `crates/vault-index/src/store/delta.rs`
- Modify: `crates/vault-server/tests/runtime.rs`
- Modify: `crates/vault-server/tests/subscriptions.rs`
- Modify: `crates/vault-watch/tests/debounce.rs`

**Interfaces:**

- Produces test-only `TestHook`/`HookPoint` injection under `cfg(test)` or the existing doc-hidden integration-test feature boundary.
- Production builds contain no sleeps, global mutable hooks, or timing-dependent race logic.
- Proves every design interleaving and randomized incremental/full equivalence.

- [ ] **Step 1: Define deterministic hook points**

Add:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum HookPoint {
    BeforeBodyRead,
    AfterBodyRead,
    BeforeStabilityRecheck,
    BeforeSqlTransaction,
    BeforeSqlCommit,
    AfterSqlCommit,
    BeforeLiveInstall,
    AfterLiveInstall,
    BeforeEventEnqueue,
}

pub trait TestHook: Send + Sync {
    fn reach(&self, point: HookPoint);
}
```

Production constructors use a no-op private implementation. Tests use paired barriers/channels and time out after five seconds with named failure messages.

- [ ] **Step 2: Write one test per crash/publication boundary**

Force and assert:

- failure before commit leaves SQLite/live graph/event generation at `G`;
- a read begun before publication completes at `G`;
- a read begun after writer barrier waits and returns `G+1`;
- simulated process stop after commit/before live install reopens from SQLite at `G+1` with no false prior event assumption;
- stop after live install/before event reconnects at `G+1`;
- no event can be observed before Task 6 state equality.

Use state inspection and public queries, not sleeps.

- [ ] **Step 3: Force filesystem races**

At `AfterBodyRead`, rewrite the file and assert the fingerprint recheck rejects publication/requeues it. Force delete/recreate across the deletion grace deadline and assert only one modification generation. Deliver duplicate/reversed paths and prove one deterministic batch.

- [ ] **Step 4: Force command/subscription races**

Register a subscription at the commit boundary and assert it either returns `G` then receives `G+1`, or returns `G+1` and receives no duplicate `G+1`. Queue manual verified refresh during watcher publication and assert maximum concurrent mutation count `1`. Saturate command and subscriber queues and assert overflow/resync behavior without blocking the coordinator.

- [ ] **Step 5: Add the randomized live oracle**

Use `proptest` with a fixed persisted regression seed plus generated sequences of:

```rust
enum Operation {
    Write { path: String, body: String },
    Delete { path: String },
    Rename { from: String, to: String },
    Touch { path: String },
    PreserveFingerprintWrite { path: String, body: String },
    MakeInvalidUtf8 { path: String },
    RestoreUtf8 { path: String, body: String },
}
```

Generate exact/relative links, duplicate stems, headings, blocks, unresolved/ambiguous transitions, and bursts. After every stable committed batch:

1. compare `snapshot_from_index` to clean `scan_vault`;
2. compare every live `resolve_link` result to `Resolver` from the clean scan;
3. assert generation advances exactly once iff client-visible source/semantic/diagnostic state changed;
4. assert the vault digest changed only by the operation itself, never by vaultd.

- [ ] **Step 6: Add missed-hint and overflow convergence tests**

Drop one fake watcher hint, run a periodic inventory, and prove convergence. Overflow/root invalidation must choose complete reconciliation, emit a resync notice, preserve unchanged source-body parse counts, and finish equivalent to a clean scan.

- [ ] **Step 7: Run stress suites repeatedly**

```bash
cargo test -p vault-index --test live_races -- --nocapture
PROPTEST_CASES=256 cargo test -p vault-index --test live_oracle -- --nocapture
cargo test -p vault-server --test runtime -- --nocapture
cargo test -p vault-server --test subscriptions -- --nocapture
for run in 1 2 3 4 5; do cargo test -p vault-index --test live_races; done
cargo test --workspace --all-targets
```

Expected: deterministic passes; no ignored/flaky annotation is accepted.

- [ ] **Step 8: Commit**

```bash
git add crates/vault-index crates/vault-server crates/vault-watch
git commit -m "test(runtime): prove live publication race safety"
```

---

### Task 14: Benchmark, document, verify, and independently review Phase 4

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `crates/vault-index/Cargo.toml`
- Modify: `crates/vault-index/src/bin/vault-bench.rs`
- Create: `crates/vault-server/src/bin/vault-live-bench.rs`
- Modify: `crates/vault-server/Cargo.toml`
- Modify: `README.md`
- Modify: `VAULTD-COMPATIBILITY.md`
- Modify: `docs/protocol.md`
- Create: `docs/performance/live-incremental-baseline.md`
- Modify when factually required: `docs/design/live-incremental-runtime.md`

**Interfaces:**

- Consumes every Phase 4 interface.
- Produces reproducible internal-stage and end-to-end watcher reports, RSS measurement, final public documentation, verification evidence, and independent review resolution.
- Does not enforce machine-specific wall-clock thresholds in CI.

- [ ] **Step 1: Add benchmark cases before tuning**

Extend `vault-bench` with internal cases at 10k/100k:

- body-only edit with zero outgoing references;
- outgoing-reference edit;
- heading add/remove with fan-out 0, 10, 100, and high fan-out;
- unresolved-to-resolved and resolved-to-ambiguous filename transitions;
- delete reversals;
- rename;
- 100-note burst;
- complete fallback after overflow;
- compact graph hydration.

Create `vault-live-bench` for actual watcher hint-to-event latency, cached-read availability, catch-up, subscriber delivery, and lag recovery. It must use temporary synthetic vault/cache paths and parse real protocol/runtime events.

- [ ] **Step 2: Add machine-readable stage and memory output**

Add `libc = "0.2.189"` as a direct workspace/index benchmark dependency (verified during planning: compiles on Rust 1.85) and re-run the 1.85 check after wiring. In the benchmark binary only, use `getrusage(RUSAGE_SELF)` behind `cfg(unix)` with documented `unsafe` calls; convert macOS `ru_maxrss` bytes and Linux `ru_maxrss` KiB to `peak_rss_bytes`. Other platforms emit JSON `null`.

Each case reports:

```json
{
  "case": "body_only_edit",
  "notes": 100000,
  "affected_references": 0,
  "timings_ms": {"p50": 0.0, "p95": 0.0, "samples": []},
  "stages_ms": {},
  "work": {},
  "peak_rss_bytes": null
}
```

The shown zeros/empty arrays describe the fixed JSON shape, not expected measurements. Validate reports with `python3 -m json.tool`.

- [ ] **Step 3: Add benchmark smoke tests**

Small `--notes 25 --repeats 2` runs must assert JSON schema, structural counters, detailed event generation, and nonzero/optional RSS fields without timing thresholds.

- [ ] **Step 4: Profile before any tuning change**

Run release baselines and inspect stage distributions:

```bash
cargo build --release -p vault-index --bin vault-bench
cargo build --release -p vault-server --bin vault-live-bench
./target/release/vault-bench --notes 10000 --repeats 7 --live > /tmp/vaultd-live-10k.json
./target/release/vault-bench --notes 100000 --repeats 7 --live > /tmp/vaultd-live-100k.json
./target/release/vault-live-bench --notes 100000 --repeats 7 > /tmp/vaultd-events-100k.json
python3 -m json.tool /tmp/vaultd-live-10k.json >/dev/null
python3 -m json.tool /tmp/vaultd-live-100k.json >/dev/null
python3 -m json.tool /tmp/vaultd-events-100k.json >/dev/null
```

Record observed stage costs before changing maps, SQL, batching, pragmas, or thresholds.

- [ ] **Step 5: Tune only measured bottlenecks**

Allowed focused tuning includes reserved capacities, prepared-statement reuse, key interning/sharing, hash versus tree lookup internally, transaction batch ordering, and the incremental/full planner threshold. Any SQLite pragma change needs a before/after report, retains atomic generation guarantees, and is documented.

After each tuning patch, rerun its focused correctness suite and both relevant benchmark scales. Keep deterministic output sorting even if internal maps become unordered.

- [ ] **Step 6: Evaluate the design targets honestly**

On the Apple M2 baseline, record rather than hide:

- cached read availability under/over 100 ms p50;
- body-only processing under/over 50 ms p50 after debounce;
- hint-to-committed-event under/over 250 ms p50 and 500 ms p95;
- note/backlink read p50;
- exact body reads, parses, inventories, affected refs, and SQL rows;
- compact live-state peak RSS against 512 MiB.

High-fan-out cases report time per affected reference. CI asserts structural work only.

- [ ] **Step 7: Update documentation to shipped behavior**

`README.md` marks live incremental runtime completed and names the next recommended consumer milestone. `docs/protocol.md` documents subscribe/unsubscribe, event envelopes, ordering, reconnect/resync, optional live state, and errors with complete JSON examples. `VAULTD-COMPATIBILITY.md` updates only implemented interface-tier statements. The performance document includes environment, commits, commands, full JSON reports or summarized distributions, structural proof, target comparison, and known limits.

- [ ] **Step 8: Run the final verification matrix**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
cargo doc --workspace --no-deps
cargo +1.85.0 check --workspace --all-targets
cargo +1.85.0 test --workspace --all-targets
git diff --check
git status --short --branch
```

Also run the live-race suite five times and the randomized oracle with `PROPTEST_CASES=1024`. Expected: every command succeeds, tree contains only intentional documentation changes before the final commit, and `.permission-check` is neither staged nor modified.

- [ ] **Step 9: Request an independent fresh-context review**

Use `superpowers:requesting-code-review` or a fresh review subagent that did not implement the code. Review the complete Phase 4 diff for:

- missed invalidation paths;
- mixed SQLite/live generations;
- commit/event ordering;
- file/path/lease safety;
- busy-cache versus corruption handling;
- queue bounds and shutdown leaks;
- protocol compatibility;
- benchmark honesty;
- Rust 1.85 compatibility.

Record each real finding, write a failing regression test first, fix it in a focused `fix(...)` commit, and have the same reviewer re-check. Do not self-declare the independent review clean.

- [ ] **Step 10: Commit final docs and any review fixes separately**

For documentation:

```bash
git add README.md VAULTD-COMPATIBILITY.md docs/protocol.md docs/performance/live-incremental-baseline.md docs/design/live-incremental-runtime.md
git commit -m "docs: document live incremental runtime"
```

Omit an unchanged design file from `git add`. Each review correction gets its own `fix(...)` commit naming the defect.

- [ ] **Step 11: Produce the handoff report**

Report:

- branch and commit list;
- final test count and all verification commands;
- independent review outcome and fix commits;
- 10k/100k structural counters and p50/p95 results;
- memory measurement;
- deviations from the design/plan with reasons;
- known performance limits;
- confirmation that vault files and `.permission-check` were untouched;
- local-only status unless the maintainer separately authorizes push/PR/merge.

Do not push, open a PR, merge, or delete a worktree without explicit authorization.

---

## Spec coverage matrix

| Design requirement | Implementation task |
|---|---:|
| Stage-level evidence before optimization | 1 |
| Single-sourced dependency keys and conservative impact | 2 |
| Compact source-free live graph and reverse indexes | 3 |
| Schema v2 dependencies and owned diagnostics | 4 |
| Affected-row-only atomic persistence | 5 |
| Generation-consistent readers/publication barrier | 6 |
| Stable dirty-path reads and partial resolution | 7 |
| Validated out-of-vault storage and writer lease | 8 |
| Bounded watcher normalization/debounce/overflow | 9 |
| Startup catch-up, deletion grace, periodic/manual serialization | 10 |
| Additive protocol subscription/event contract | 11 |
| Bounded stdio subscriptions and ordering | 12 |
| Forced races, missed hints, randomized equivalence | 13 |
| 10k/100k performance, memory, docs, MSRV, independent review | 14 |

---

## Execution checkpoints

After Tasks 3, 7, 10, 12, and 13, pause for a fresh-context review of that checkpoint before continuing. A reviewer should reject the checkpoint if interfaces diverge from this plan, tests cannot prove the named invariant, or work becomes proportional to the whole vault on an ordinary path.

The final implementation remains local-only until the maintainer chooses the GitHub/merge workflow. The plan authorizes implementation and local commits, not external publication or worktree deletion.
