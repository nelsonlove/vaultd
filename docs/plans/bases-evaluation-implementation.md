# vaultd Bases Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `vaultd` to parse every `.base` file as an indexed file kind, resolve links to bases and to their views, and answer `evaluate_base` and `list_bases` with a view's rows as paths plus typed cells, computed at the current generation, cached per generation, and kept live by a coarse `views_invalidated` event.

**Architecture:** A new pure crate, `vault-bases`, owns the file model (`BaseFile`), the expression language (a tokenizer, a Pratt parser and a tree-walking evaluator over a typed `Value`), the date model, the view pipeline (prefilters, filters, formulas, sort, group, limit, summaries) and a `RowSource` trait; it does no I/O. `vault-core` gains a YAML-document entry point the base parser reuses, a `view` subpath, and base targets in the resolver. `vault-index` gains schema version 4 (`bases`, `property_scalars`), reconciles `.base` files in the same generation as notes on both routes, holds each parsed `BaseFile` in the live graph, and implements `RowSource` inside one generation-consistent read. `vault-server` adds the two operations, the per-generation LRU, the staleness rule and the event, all additive to protocol version 1.

**Tech Stack:** Rust 2024 edition, MSRV 1.85; `saphyr` 0.0.12 (already in the workspace) through `vault-core`'s new `parse_yaml_document`; `regex` 1.x for `Regexp` values; `jiff` 0.2 (new workspace dependency, MSRV 1.70, checked on crates.io 2026-10-02 at 0.2.37) for time zones, calendar arithmetic and the system tz database; `rusqlite` bundled SQLite with JSON1 for the diagnostics union; `proptest` for the ordering properties. Host side: Node ≥ 24 scripts under `host/scripts` only, driving the `obsidian` CLI (`base:query`, `eval`, `vault`) against a scratch vault.

**Spec:** [vaultd Bases Evaluation Design](../design/bases-evaluation.md) — its trailing **Rulings** section wins over its body. Predecessor plan, for house style: [vaultd Socket Transport Implementation Plan](vaultd-socket-transport-implementation.md). Wire authority: [docs/protocol.md](../protocol.md). Published language reference, transcribed into the checklists of Tasks 2 to 7: `https://obsidian.md/help/bases/syntax`, `https://obsidian.md/help/bases/functions`, `https://obsidian.md/help/bases/views` (their raw Markdown is at `https://publish-01.obsidian.md/access/f786db9fac45774fa4f0d8112e232d67/Bases/Bases%20syntax.md`, `…/Bases/Functions.md` and `…/Bases/Views.md`, fetched 2026-10-02).

## Global Constraints

- Rust MSRV 1.85 (gate: `rustup run 1.85.0 cargo check --workspace`); **never let-chains** (`if let … && …`) — nest the `if let` instead; `cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo fmt --all -- --check` clean.
- Rust tests run under `TMPDIR="$PWD/target/tmp"`: `TMPDIR="$PWD/target/tmp" cargo test -p <crate> …`. **Never `std::env::temp_dir()` in any test.** `tempfile::TempDir::new()` reads `TMPDIR`, so the prefix is the whole mechanism.
- Host (only the harness and the spike client change): Node ≥ 24; `npm --prefix host run lint` covers `host/scripts`; vitest only through `npm --prefix host test -- <files>`, never two at once; **nothing under `host/packages/host/src` changes in this phase.**
- **Never point any process, test, fixture or path at `~/vault`**, except the one corpus-copy script (Task 13), run by hand by the vault's owner, which reads `.base` files and the notes they name and writes them under `target/tmp/bases-corpus/`; the daemon, the tests and the captures use only that copy.
- Parity comes from runtime captures (the `obsidian` CLI driving a scratch vault the maintainer opened) and the published pages, never from `app.asar`; where a capture is missing, the behaviour is a typed diagnostic, never an invention. Where a published page states a rule ("Bases functions follow JavaScript behavior", Moment.js format syntax), the rule is evidence and is cited in the code comment that relies on it; such fixture rows are marked `"source":"published"` until Task 13 replaces them with `"source":"captured"`.
- **Every gate reports its PROCESS EXIT CODE**; a suite that prints passed while exiting 1 is red. Every run command below ends with `; echo "exit=$?"` and the expected line names the code.
- The protocol changes only additively: two operations (`evaluate_base`, `list_bases`), one event (`views_invalidated`), one `SubpathDto` kind (`view`), new error codes (`base_invalid`, `view_not_found`, `expression_invalid`, `unsupported_function`); no envelope or existing-operation change; unknown-variant tolerance as documented (each new enum a client decodes carries an `Unknown` catch-all, and the Evolution paragraph of `docs/protocol.md` names them).
- One commit per task on `feat/bases-evaluation`; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` only. **Never push, never merge.**
- Prose in this plan and in every document it writes is one paragraph per line, never hard-wrapped; Rust doc comments follow the crate's wrapped style.
- Gate before every Rust commit: the touched crates' tests, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`, each with its exit code. Gate before every host-script commit: `npm --prefix host run lint`.
- No agent and no script started by this plan reads anything under the guarded private folder of the vault (`Private/`); the corpus-copy script excludes that subtree unconditionally (Task 13).

## Review Focus

1. **A prefilter that drops a row the full filter would keep.** Prefilters run before any expression, so a narrowing that is not a superset (case-folded tag comparison, a property whose value is a list, a number literal compared to a string property) silently loses rows. Expected: every extracted prefilter selects a superset of the rows its conjunct accepts, and the conjunct still runs per row. Pinned by `a_prefilter_never_drops_a_row_its_conjunct_keeps` (Task 7, a property test over the in-memory source) and `property_equality_prefilter_keeps_list_and_mixed_case_values` (Task 11, over SQLite).
2. **A `.base` file that is valid YAML but not a base** (a top-level list, `views: 3`, a view with no `type`, a `filters:` that is a number). Expected: `parse_failed` with a position for every shape the file model cannot read, never a panic and never a silently empty view list. Pinned in Task 1 by `shapes_that_are_yaml_but_not_a_base_fail_with_a_position`.
3. **Formula cycles and self-reference** (`a: formula.b`, `b: formula.a`). Expected: the formula's cell is an `error` cell naming the cycle, every other cell of the row is computed, and evaluation terminates. Pinned in Task 7 by `a_formula_cycle_is_an_error_cell_not_a_hang`.
4. **Unicode in property values, tags and view names** (`#tag-🙂`, `name: "Tâble"`, `![[Views.base#Tâble]]`, a `slice` across a multi-byte character). Expected: string `length` and `slice` count UTF-16 code units the way JavaScript does (the published "follow JavaScript behavior" rule); `reverse` on a string with an astral character is `Uncaptured("reverse:astral")` until Task 13 captures it, and Task 13 then adds the UTF-16 test that pins what was captured; view names match exactly; nothing panics on a char boundary. Pinned in Task 4 by `string_indices_count_utf16_units_and_never_split_a_char` and the `reverse:astral` row, and in Task 8 by `a_view_name_with_unicode_resolves`.
5. **A view evaluated while the vault changes under it** (a cursor from generation N asked at N+1; a base deleted between `list_bases` and `evaluate_base`; the `this_path` note deleted). Expected: `generation_mismatch` for the cursor, `not_found` for the vanished base, `invalid_request` for the vanished `this_path`, and the cache never answers a generation that is not current. Pinned in Task 11 by `a_cursor_from_an_older_generation_is_generation_mismatch` and `a_deleted_base_is_not_found`, and in Task 12 by `the_cache_hits_at_one_generation_and_misses_at_the_next`.

---

## Preflight

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git status --short --branch
git log --oneline -1
cargo --version
rustup run 1.85.0 cargo --version
node --version
mkdir -p target/tmp
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
```

Expected: a clean tree on `feat/bases-evaluation` at this plan's commit (over `dc1e3c9`, the spec), `cargo` at 1.85 or above, the 1.85 toolchain installed, `node` at v24 or above, and the whole workspace suite green with `exit=0`. If the suite is red before Task 1, stop and report the failing test — every later task's proof is partly "the existing suite stays green".

**Facts this plan relies on that differ from the brief's reading of the tree,** checked against the code on 2026-10-02: the current schema is **version 3** (`crates/vault-index/src/schema.rs:7`, `schema_v3.sql`), not 2, and `tree_entries` lives in `schema_v3.sql`; so the new schema is `schema_v4.sql` and the version moves 3 → 4. An obsolete cache is **rebuilt, never migrated** (`schema.rs:12-15`), so "migration" in this plan means a version bump plus the cold-build and obsolete-rebuild tests, exactly as v2 → v3 did. The live graph holds **no properties or tags** (`live_graph.rs:1-8`), so the row source reads those from SQLite inside the reader's transaction; that transaction is crate-private to `vault-index`, so the `RowSource` implementation lives in `vault-index` (`src/query/bases.rs`) rather than in `vault-server`, and the server owns the operations, the cache, the cursor and the conversion.

---

## Shared names

Every name below crosses a task boundary. A task's **Interfaces** block repeats the ones it consumes and produces; this table is the one place they are all listed, and the self-review at the end checks every task against it.

| Name | Kind | Defined in | Used by |
| --- | --- | --- | --- |
| `vault_core::parse_yaml_document(text: &str) -> Result<Option<Spanned<PropertyValue>>, YamlDocumentError>` | fn | 1 | 1 |
| `vault_core::YamlDocumentError { message: String, span: SourceSpan }` | struct | 1 | 1 |
| `vault_bases::BaseFile { filters, formulas, properties, summaries, views }` | struct | 1 | 6, 7, 10, 11, 12 |
| `vault_bases::FilterNode::{Expr(String), And(Vec<FilterNode>), Or(Vec<FilterNode>), Not(Vec<FilterNode>)}` | enum | 1 | 7 |
| `vault_bases::ViewDecl { kind, name, filters, order, sort, group_by, limit, summaries, options }` | struct | 1 | 7, 11 |
| `vault_bases::{SortKey, Direction, GroupBy, PropertySettings}` | structs, enum | 1 | 7, 11 |
| `vault_bases::parse_base(text: &str) -> Result<BaseFile, BaseParseError>` | fn | 1 | 10 |
| `vault_bases::BaseParseError { message: String, span: Option<SourceSpan> }` | struct | 1 | 10, 11 |
| `vault_bases::{Value, DateValue, DurationValue, LinkValue, RegexpValue}` | enum, structs | 1 | 2–7, 11 |
| `vault_bases::expr::{Expr, BinaryOp, UnaryOp, parse_expression, ExpressionError}` | types, fn | 2 | 3–7 |
| `vault_bases::{RowSource, FileFacts, FileKind, LinkFact, PropertyType, SourceError, Prefilter, ScalarLiteral, extension}` | trait, types | 3 | 4–7, 11, 12 |
| `vault_bases::{MemorySource, MemoryFile}` | test-support source | 3 | 3–7 |
| `vault_bases::Clock { now_ms: i64, zone: jiff::tz::TimeZone }` | struct | 3 | 5, 7, 11, 13 |
| `vault_bases::eval::{EvalContext, EvalError, Scope, evaluate}` | types, fn | 3 | 4–7 |
| `vault_bases::functions::{is_known_global, is_known_method}` | fns | 3, extended 4–6 | 7 |
| `vault_bases::fixtures::{CaptureRow, load_captures, render_text, check_family, capture_vault, FIXTURE_NOW_MS, FIXTURE_ZONE}` | test support | 3 (`capture_vault` in 6) | 3–7, 13 |
| `vault_bases::view::{compile_view, CompiledView, CompileError, ViewDependencies, evaluate_view, ViewResult, RowResult, SummaryResult, ColumnDecl, Cell, property_ref, BUILTIN_SUMMARIES}` | types, fns | 7 | 11, 12 |
| `vault_bases::format_date`, `EvalContext::reborrow` | fns | 5, 7 | 7, 11 |
| `functions::typed_property(ctx, row, key, value)` | fn | 3 (three parameters), 6 (four) | 3–7 |
| `vault_core::Subpath::View(String)` | variant | 8 | 8, 10, 11 |
| `vault_core::ResolutionNote.views: Option<Vec<String>>`, `ResolutionNote::base(path, views)` | field, fn | 8 | 10 |
| `vault_core::build_graph_with_bases(notes, bases, diagnostics) -> ScanReport` | fn | 8 | 10 |
| `vault_core::DiagnosticCode::{MissingView, MalformedBase}` | variants | 8 | 8, 10 |
| `vault_protocol::SubpathDto::{View(String), Unknown}` | variants | 8 | 8, 11 |
| `vault_core::VaultPath::is_base()` | fn | 8 | 9, 10, 11 |
| `SQL_SCHEMA_VERSION = 4`, `SEMANTIC_FORMAT_VERSION = 4`, `schema_v4.sql` | consts, file | 9 | 10 |
| `codec::{StoredScalar, property_scalar}` | type, fn | 9 | 9, 11 |
| `vault_index::BaseRecord { file: Option<Arc<BaseFile>>, views: Vec<String>, error: Option<BaseParseError> }` | struct | 10 | 11, 12 |
| `LiveGraph::{base, base_paths, base_identity, candidate_bases}` | fns | 10 | 10, 11, 12 |
| `vault_index::{BaseReplacement, BaseDelta}` | structs | 10 | 10 |
| `IndexReader::{list_bases, evaluate_base, read_with_graph}`, `BaseQuery`, `BaseAnswer`, `BaseQueryError`, `BaseSummary`, `BaseStatus`, `parse_property_types` | fns, types | 11 | 11, 12, 13 |
| `LiveRefreshReport.reresolved`, `BatchOutcome.reresolved` | fields | 12 | 12 |
| `fixtures::{TemplateFacts, fill_template}`, `CaptureRow.{expect_from, template}` | test support | 13 | 13 |
| `tests/common::scratch_root()` (vault-index), `scratch()` (each new vault-server test file) | test helpers | 9, 11 | 9–14 |
| `view::verdict` (three-valued filter) | fn | 7 | 7 |
| `IndexReader::{prefilter_facts, base_dependencies}`, `PrefilterFacts` | fns, type | 12 | 12 |
| `vault_protocol::{EvaluateBaseParams, EvaluateBaseResponse, ListBasesParams, BaseSummaryDto, BaseStatusDto, ViewDto, ColumnDto, RowDto, RowKindDto, CellDto, ObjectEntryDto}` | DTOs | 11 | 11, 12, 14, 15 |
| `ErrorCode::{BaseInvalid, ViewNotFound, ExpressionInvalid, UnsupportedFunction}` | variants | 11 | 11, 16 |
| `vault_protocol::{ViewsInvalidatedEventDto, RuntimeEventDto::ViewsInvalidated}` | DTO, variant | 12 | 12, 15 |
| `vault_server::bases::{BaseCache, DEFAULT_BASE_CACHE_ENTRIES, evaluate_base, list_bases, query_error}` | type, const, fns | 11 (single-generation cache; `evaluate_base(reader, cache, types, params)`), 12 (LRU bound and knob; `tracker` joins `evaluate_base` after `cache`) | 12, 14 |
| `vault_server::views::ViewTracker` | type | 12 | 12 |
| `Server::set_base_cache_entries(n)`, `--bases-cache-entries` | fn, flag | 12 | 14 |
| `host/scripts/bases-corpus-copy.js`, `host/scripts/bases-capture.js` | scripts | 13 | 13 |
| `crates/vault-bases/tests/fixtures/captures/*.jsonl` | fixtures | 3–7 (published), 13 (captured) | 3–7, 13 |

---

## Planned file map

### `crates/vault-bases` (new crate)

- Create `Cargo.toml` — depends on `vault-core`, `regex`, `jiff`, `thiserror`, `serde_json` (fixture support only, behind the `fixtures` feature the crate's own tests enable); dev-depends on `proptest`.
- Create `src/lib.rs` — module list and re-exports; the crate's one-paragraph contract (no I/O, no SQLite, no protocol types).
- Create `src/value.rs` — `Value` and its four payload structs, `Value::type_name`.
- Create `src/file.rs` — `BaseFile`, `FilterNode`, `ViewDecl`, `SortKey`, `Direction`, `GroupBy`, `PropertySettings`, `parse_base`, `BaseParseError`.
- Create `src/expr/mod.rs`, `src/expr/token.rs`, `src/expr/parse.rs` — tokens, the Pratt parser, `Expr`.
- Create `src/source.rs` — `RowSource`, `FileFacts`, `FileKind`, `LinkFact`, `PropertyType`, `SourceError`, `MemorySource`, `MemoryFile`.
- Create `src/clock.rs` — `Clock`.
- Create `src/eval/mod.rs` — `EvalContext`, `Scope`, `EvalError`, `evaluate`, the operator semantics.
- Create `src/eval/coerce.rs` — truthiness, equality, the mixed-type order, `to_display_string`.
- Create `src/functions/mod.rs` and one file per family: `global.rs`, `any.rs`, `string.rs`, `number.rs`, `list.rs`, `object.rs`, `regexp.rs`, `date.rs`, `link.rs`, `file.rs`.
- Create `src/dates.rs` — date and duration parsing, calendar arithmetic, Moment-token `format`, `relative`.
- Create `src/view/mod.rs`, `src/view/prefilter.rs`, `src/view/summary.rs` — compile and evaluate a view.
- Create `src/fixtures.rs` (behind the `fixtures` feature) — the capture-row reader and the cell-text renderer every capture comparison uses.
- Create `tests/file_model.rs`, `tests/syntax_examples.rs`, `tests/coercion.rs`, `tests/functions_reference.rs`, `tests/dates.rs`, `tests/files_and_links.rs`, `tests/views.rs`, `tests/ordering_properties.rs` and `tests/fixtures/captures/{coercion,global,any,string,number,list,object,regexp,date,link,file}.jsonl`.

### `crates/vault-core`

- Modify `src/frontmatter.rs` — `parse_yaml_document` over the existing `CharToByte` and `convert_value`.
- Modify `src/semantic.rs` — `Subpath::View`.
- Modify `src/resolver.rs` — `ResolutionNote.views`, base targets, view subpaths, `MissingSubpath` with `View`.
- Modify `src/dependency.rs` — a view-set change produces the `ResolvedTarget` key.
- Modify `src/graph.rs` — `build_graph_with_bases`.
- Modify `src/diagnostic.rs` — `MissingView`, `MalformedBase`.
- Modify `src/domain.rs` — `VaultPath::is_base`.
- Modify `src/lib.rs` — exports.
- Modify every `ResolutionNote { … }` struct literal (the compiler lists them; 21 today across `vault-core` and `vault-index`, tests included) — add `views: None`.

### `crates/vault-index`

- Create `src/schema_v4.sql` — v3 plus `property_scalars` and `bases`.
- Modify `src/schema.rs` — version 4.
- Modify `src/codec.rs` — `property_scalar`, the `view` subpath, the two diagnostic codes.
- Modify `src/store.rs` — `replace_note` writes `property_scalars`; `replace_base`; stored base fingerprints; `Publication.bases`.
- Modify `src/store/delta.rs` — `DeltaPublication.bases`.
- Modify `src/store/hydrate.rs` — load bases.
- Modify `src/live_graph.rs` — `BaseRecord`, the bases map, base candidates, `PreparedGraphDelta::with_bases`.
- Modify `src/live_reconcile.rs` and `src/reconcile.rs` — `.base` files on both routes; resolution through bases.
- Modify `src/reader.rs` — the resolver catalog includes bases.
- Modify `src/mutate/rename.rs` — repair through bases; the `View` arm.
- Modify `src/query/diagnostics.rs` — the `base` branch of the union.
- Create `src/query/bases.rs` — `IndexRowSource`, `list_bases`, `evaluate_base`, `prefilter_facts`, `base_dependencies`.
- Create `tests/property_scalars.rs`, `tests/bases_index.rs`, `tests/bases_query.rs`.

### `crates/vault-protocol`

- Modify `Cargo.toml` — `serde_json` becomes a normal dependency (cell numbers are `serde_json::Number`, which is `Eq`, so `Response` keeps its `Eq` derive; view options are `serde_json::Value`).
- Modify `src/semantic.rs` — `SubpathDto::View`, `SubpathDto::Unknown`.
- Create `src/bases.rs` — every Bases DTO.
- Modify `src/operations.rs` — `Request::{EvaluateBase, ListBases}`, `Response::{EvaluateBase, ListBases}`.
- Modify `src/error.rs` — four codes.
- Modify `src/events.rs` — `ViewsInvalidated`.
- Modify `src/lib.rs` — exports.

### `crates/vault-server`

- Create `src/bases.rs` — `BaseCache`, the cursor, the two handlers.
- Create `src/views.rs` — `ViewTracker`, the staleness rule.
- Modify `src/lib.rs` — dispatch arms, the cache and tracker on `Server`, `set_base_cache_entries`.
- Modify `src/convert.rs` — `cell`, the `subpath` arm, diagnostic codes, the four error codes.
- Modify `src/connection.rs` — the dispatcher's notice arm enqueues `views_invalidated`.
- Modify `src/subscriptions.rs` — `enqueue_views_invalidated`, the `event_generation` arm.
- Modify `src/main.rs` — `--bases-cache-entries`.
- Modify `tests/conformance.rs`, `tests/fixtures/conformance.jsonl` — the base fixtures.
- Create `tests/bases_ops.rs`, `tests/bases_freshness.rs`, `tests/bases_replay.rs`.
- Modify `tests/docs.rs` — pins.

### Host scripts and the spike

- Create `host/scripts/bases-corpus-copy.js`, `host/scripts/bases-capture.js`.
- Modify `host/scripts/socket-transport-baseline.js` — `--base`.
- On branch `spike/htmx-client` only: modify `spikes/htmx-client/server.js` and `spikes/htmx-client/smoke.js`.

### Documentation

- Modify `docs/protocol.md`, `docs/design/semantic-read-path.md`, `README.md`, `VAULTD-COMPATIBILITY.md`; create `docs/performance/bases-evaluation-baseline.md`.

---
### Task 1: The `vault-bases` crate, the value model, and the `.base` file model

Create the crate, give it its value model, and parse a `.base` document into `BaseFile` with typed parse errors. `vault-core` gains one public function, `parse_yaml_document`, so the base parser reuses the workspace's one `saphyr` adapter (its char-to-byte table and its container-span repair) instead of growing a second.

**Files:**

- Create: `crates/vault-bases/Cargo.toml`, `crates/vault-bases/src/lib.rs`, `crates/vault-bases/src/value.rs`, `crates/vault-bases/src/file.rs`
- Create: `crates/vault-bases/tests/file_model.rs`
- Modify: `Cargo.toml` (workspace members; `jiff` in `[workspace.dependencies]`)
- Modify: `crates/vault-core/src/frontmatter.rs` (append `parse_yaml_document` and `YamlDocumentError`), `crates/vault-core/src/lib.rs` (`mod frontmatter;` stays private; add `pub use frontmatter::{YamlDocumentError, parse_yaml_document};`)

**Interfaces:**

- Consumes: `vault_core::{PropertyValue, Spanned, SourceSpan, VaultPath}`; the private `CharToByte`, `span_from_marked`, `convert_value` in `crates/vault-core/src/frontmatter.rs`.
- Produces:

```rust
// vault-core
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YamlDocumentError { pub message: String, pub span: SourceSpan }
pub fn parse_yaml_document(text: &str) -> Result<Option<Spanned<PropertyValue>>, YamlDocumentError>;

// vault-bases
pub struct BaseFile {
    pub filters: Option<FilterNode>,
    pub formulas: Vec<(String, String)>,
    pub properties: Vec<(String, PropertySettings)>,
    pub summaries: Vec<(String, String)>,
    pub views: Vec<ViewDecl>,
}
pub enum FilterNode { Expr(String), And(Vec<FilterNode>), Or(Vec<FilterNode>), Not(Vec<FilterNode>) }
pub struct PropertySettings { pub display_name: Option<String>, pub options: Vec<(String, PropertyValue)> }
pub struct ViewDecl {
    pub kind: String, pub name: String, pub filters: Option<FilterNode>, pub order: Vec<String>,
    pub sort: Vec<SortKey>, pub group_by: Option<GroupBy>, pub limit: Option<u64>,
    pub summaries: Vec<(String, String)>, pub options: Vec<(String, PropertyValue)>,
}
pub struct SortKey { pub property: String, pub direction: Direction }
pub struct GroupBy { pub property: String, pub direction: Direction }
pub enum Direction { Asc, Desc }
pub struct BaseParseError { pub message: String, pub span: Option<SourceSpan> }
pub fn parse_base(text: &str) -> Result<BaseFile, BaseParseError>;
impl BaseFile { pub fn view_names(&self) -> Vec<String>; pub fn view(&self, name: Option<&str>) -> Option<&ViewDecl>; }

pub enum Value { Null, String(String), Number(f64), Boolean(bool), Date(DateValue), Duration(DurationValue),
    List(Vec<Value>), Object(Vec<(String, Value)>), Link(LinkValue), File(VaultPath), Regexp(RegexpValue),
    Image(String), Icon(String), Html(String) }
pub struct DateValue { pub epoch_ms: i64, pub has_time: bool }
pub struct DurationValue { pub months: i64, pub ms: i64 }
pub struct LinkValue { pub target: String, pub display: Option<Box<Value>>, pub resolved: Option<VaultPath> }
pub struct RegexpValue { pub source: String, pub flags: String, pub regex: std::sync::Arc<regex::Regex> }
impl Value { pub fn type_name(&self) -> &'static str; }
```

- [ ] **Step 1: Add the crate to the workspace**

In the root `Cargo.toml`, add `"crates/vault-bases",` as the first entry of `members`, and add to `[workspace.dependencies]`:

```toml
jiff = "0.2"
```

Create `crates/vault-bases/Cargo.toml`:

```toml
[package]
name = "vault-bases"
version.workspace = true
edition.workspace = true
rust-version.workspace = true

[features]
# The capture-fixture reader and the cell-text renderer. Off in production
# builds; the crate's own tests and `vault-server`'s replay suite enable it.
fixtures = ["dep:serde_json"]

[dependencies]
jiff.workspace = true
regex.workspace = true
serde_json = { workspace = true, optional = true }
thiserror.workspace = true
vault-core = { path = "../vault-core" }

[dev-dependencies]
proptest.workspace = true
serde_json.workspace = true
vault-bases = { path = ".", features = ["fixtures"] }
```

Create `crates/vault-bases/src/lib.rs`:

```rust
//! Obsidian Bases, evaluated outside Obsidian.
//!
//! This crate takes a `.base` document and a [`RowSource`] and produces a
//! view's rows. It does no I/O, opens no database and knows no protocol type:
//! the daemon implements `RowSource` over its index and live graph, and a
//! test implements it over [`MemorySource`]. Every behaviour that is not
//! fixed by the published reference (`obsidian.md/help/bases/…`) is fixed by
//! a runtime capture under `tests/fixtures/captures/`, and where neither
//! exists the evaluator answers a typed error rather than a guess.

mod file;
mod value;

pub use file::{
    BaseFile, BaseParseError, Direction, FilterNode, GroupBy, PropertySettings, SortKey, ViewDecl,
    parse_base,
};
pub use value::{DateValue, DurationValue, LinkValue, RegexpValue, Value};
```

- [ ] **Step 2: Write the failing tests**

Create `crates/vault-bases/tests/file_model.rs`:

```rust
use vault_bases::{Direction, FilterNode, parse_base};
use vault_core::PropertyValue;

/// The example on `obsidian.md/help/bases/syntax`, verbatim.
const SYNTAX_PAGE_EXAMPLE: &str = r#"filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
"#;

#[test]
fn parses_the_syntax_page_example() {
    let base = parse_base(SYNTAX_PAGE_EXAMPLE).expect("the published example parses");

    let FilterNode::Or(arms) = base.filters.as_ref().expect("global filters") else {
        panic!("the top of the global filter is `or`: {:?}", base.filters);
    };
    assert_eq!(arms.len(), 3);
    assert_eq!(arms[0], FilterNode::Expr(r#"file.hasTag("tag")"#.into()));
    assert_eq!(
        arms[1],
        FilterNode::And(vec![
            FilterNode::Expr(r#"file.hasTag("book")"#.into()),
            FilterNode::Expr(r#"file.hasLink("Textbook")"#.into()),
        ])
    );
    assert!(matches!(&arms[2], FilterNode::Not(items) if items.len() == 2));

    assert_eq!(
        base.formulas,
        vec![
            (
                "formatted_price".to_string(),
                r#"if(price, price.toFixed(2) + " dollars")"#.to_string()
            ),
            ("ppu".to_string(), "(price / age).toFixed(2)".to_string()),
        ]
    );
    let names: Vec<(&str, Option<&str>)> = base
        .properties
        .iter()
        .map(|(key, settings)| (key.as_str(), settings.display_name.as_deref()))
        .collect();
    assert_eq!(
        names,
        vec![
            ("status", Some("Status")),
            ("formula.formatted_price", Some("Price")),
            ("file.ext", Some("Extension")),
        ]
    );
    assert_eq!(
        base.summaries,
        vec![("customAverage".to_string(), "values.mean().round(3)".to_string())]
    );

    assert_eq!(base.views.len(), 1);
    let view = &base.views[0];
    assert_eq!(view.kind, "table");
    assert_eq!(view.name, "My table");
    assert_eq!(view.limit, Some(10));
    let group = view.group_by.as_ref().expect("groupBy");
    assert_eq!(group.property, "note.age");
    assert_eq!(group.direction, Direction::Desc);
    assert_eq!(
        view.order,
        vec!["file.name", "file.ext", "note.age", "formula.ppu", "formula.formatted_price"]
    );
    assert_eq!(
        view.summaries,
        vec![("formula.ppu".to_string(), "Average".to_string())]
    );
    assert!(matches!(&view.filters, Some(FilterNode::And(items)) if items.len() == 2));
    assert!(view.options.is_empty(), "every key of this view is a core key");
    assert_eq!(base.view_names(), vec!["My table".to_string()]);
    assert!(base.view(None).is_some(), "absent names the first view");
    assert!(base.view(Some("My table")).is_some());
    assert!(base.view(Some("my table")).is_none(), "view names match exactly");
}

#[test]
fn a_view_keeps_unknown_keys_and_unknown_types_as_declared() {
    let base = parse_base(
        "views:\n  - type: fileclass-table\n    name: Classes\n    fileClass: Person\n    columns:\n      - a\n      - b\n    sort:\n      - property: file.mtime\n        direction: desc\n",
    )
    .expect("a plugin view parses");
    let view = &base.views[0];
    assert_eq!(view.kind, "fileclass-table");
    assert_eq!(view.sort.len(), 1);
    assert_eq!(view.sort[0].property, "file.mtime");
    assert_eq!(view.sort[0].direction, Direction::Desc);
    let keys: Vec<&str> = view.options.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, vec!["fileClass", "columns"], "declared order is kept");
    assert_eq!(view.options[0].1, PropertyValue::String("Person".into()));
}

#[test]
fn a_filter_may_be_a_single_statement_string() {
    let base = parse_base("filters: 'file.ext == \"md\"'\nviews:\n  - type: table\n    name: T\n")
        .expect("a one-statement filter parses");
    assert_eq!(
        base.filters,
        Some(FilterNode::Expr(r#"file.ext == "md""#.into()))
    );
}

#[test]
fn an_empty_document_is_a_base_with_nothing_declared() {
    let base = parse_base("").expect("empty parses");
    assert!(base.views.is_empty());
    assert!(base.filters.is_none());
    assert!(base.view(None).is_none());
}

#[test]
fn shapes_that_are_yaml_but_not_a_base_fail_with_a_position() {
    for (text, needle) in [
        ("- a\n- b\n", "mapping"),
        ("views: 3\n", "views"),
        ("views:\n  - name: T\n", "type"),
        ("views:\n  - type: table\n", "name"),
        ("filters: 3\n", "filter"),
        ("filters:\n  xor:\n    - a\n", "and, or, or not"),
        ("formulas:\n  a:\n    - 1\n", "formula"),
        ("views:\n  - type: table\n    name: T\n    limit: -1\n", "limit"),
        ("views:\n  - type: table\n    name: T\n    sort:\n      - direction: ASC\n", "property"),
        ("views:\n  - type: table\n    name: T\n    groupBy:\n      property: a\n      direction: SIDEWAYS\n", "direction"),
    ] {
        let error = parse_base(text).expect_err(text);
        assert!(
            error.message.contains(needle),
            "{text:?}: {:?} should mention {needle:?}",
            error.message
        );
        let span = error.span.unwrap_or_else(|| panic!("{text:?} carries a position"));
        assert!(span.end() <= text.len(), "{text:?}: span {span:?} is inside the text");
    }
}

#[test]
fn invalid_yaml_fails_with_the_yaml_position() {
    let text = "views:\n  - type: table\n    name: [unclosed\n";
    let error = parse_base(text).expect_err("broken YAML");
    let span = error.span.expect("a position");
    assert!(span.start() >= text.find("[unclosed").unwrap(), "{span:?}");
}

#[test]
fn byte_spans_survive_multibyte_text() {
    // "Tâble" is 6 bytes and 5 chars: a char-indexed span would point one
    // byte early at everything after it.
    let text = "views:\n  - type: table\n    name: Tâble\n    limit: x\n";
    let error = parse_base(text).expect_err("limit must be a number");
    let span = error.span.expect("a position");
    assert_eq!(&text[span.start()..span.end()], "x");
}
```

Append to the `#[cfg(test)] mod tests` block at the end of `crates/vault-core/src/frontmatter.rs`:

```rust
    #[test]
    fn a_yaml_document_reports_byte_spans_past_multibyte_text() {
        let text = "name: Tâble\nlimit: 10\n";
        let root = super::parse_yaml_document(text)
            .expect("parses")
            .expect("non-empty");
        let crate::PropertyValue::Mapping(entries) = &root.value else {
            panic!("a mapping: {root:?}");
        };
        let (key, value) = &entries[1];
        assert_eq!(key.value, "limit");
        assert_eq!(&text[value.span.start()..value.span.end()], "10");
    }

    #[test]
    fn a_yaml_document_error_names_where_it_broke() {
        let text = "a: [1, 2\n";
        let error = super::parse_yaml_document(text).expect_err("unclosed flow");
        assert!(error.span.start() <= text.len());
        assert!(!error.message.is_empty());
    }
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test file_model; echo "exit=$?"`

Expected: `error[E0583]: file not found for module` for `file` and `value` (declared in `lib.rs`, not yet written), and `exit=101`.

- [ ] **Step 4: Add `parse_yaml_document` to `vault-core`**

Append to `crates/vault-core/src/frontmatter.rs`, above the test module:

```rust
/// A YAML document that could not be read, with where it broke.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YamlDocumentError {
    pub message: String,
    pub span: SourceSpan,
}

/// Parse a whole YAML document — not a frontmatter payload — into the same
/// spanned value model frontmatter properties use.
///
/// The base parser is the caller: a `.base` file is one YAML document from its
/// first byte, so the payload offset is zero and every span this returns
/// indexes `text` directly, in bytes. It reuses this module's `CharToByte`
/// table and container-span repair rather than a second `saphyr` adapter, so
/// the two readers cannot disagree about where a value sits.
///
/// `Ok(None)` is an empty (or whitespace-only, or `null`) document.
pub fn parse_yaml_document(
    text: &str,
) -> Result<Option<Spanned<PropertyValue>>, YamlDocumentError> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let table = CharToByte::new(text);
    let documents = MarkedYaml::load_from_str(text).map_err(|error| {
        // saphyr's scan error carries the char index it stopped at; convert
        // it like every other marker.
        let at = table.byte(error.marker().index());
        YamlDocumentError {
            message: error.to_string(),
            span: SourceSpan::new(at, at).expect("an empty span is ordered"),
        }
    })?;
    let whole = SourceSpan::new(0, text.len()).expect("the whole text is ordered");
    let root = match documents.as_slice() {
        [] => return Ok(None),
        [root] => root,
        _ => {
            return Err(YamlDocumentError {
                message: "expected one YAML document".into(),
                span: whole,
            });
        }
    };
    if matches!(root.data, YamlData::Value(Scalar::Null)) {
        return Ok(None);
    }
    convert_value(root, &table, 0, text)
        .map(Some)
        .map_err(|diagnostic| YamlDocumentError {
            message: diagnostic.message,
            span: diagnostic.span.unwrap_or(whole),
        })
}
```

If `error.marker()` does not compile against saphyr 0.0.12, the accessor that returns the scan error's `Marker` is the one to use: find it with `grep -n "pub fn marker\|pub fn info" ~/.cargo/registry/src/*/saphyr-parser-*/src/scanner.rs` and use it in the same position; nothing else changes.

In `crates/vault-core/src/lib.rs`, below the existing `pub use diagnostic::…` line, add:

```rust
pub use frontmatter::{YamlDocumentError, parse_yaml_document};
```

- [ ] **Step 5: Write the value model**

Create `crates/vault-bases/src/value.rs`:

```rust
use std::sync::Arc;

use vault_core::VaultPath;

/// A calendar instant, in milliseconds since the Unix epoch, plus whether it
/// carries a time of day. `date("2025-01-01")` has no time; `now()` does. The
/// flag is what `format`, `relative` and the cell model read; arithmetic
/// ignores it.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DateValue {
    pub epoch_ms: i64,
    pub has_time: bool,
}

/// A span of time. Months are kept apart from milliseconds because `+ "1M"`
/// is calendar arithmetic — `2024-12-01 + 1M` is `2025-01-01`, not 30 days on —
/// and only a date can resolve a month into milliseconds.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct DurationValue {
    pub months: i64,
    pub ms: i64,
}

/// A link value: what it points at as written, an optional display value
/// (`link("x", icon("plus"))` displays an icon), and the path it resolved to
/// when the row source could resolve it.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkValue {
    pub target: String,
    pub display: Option<Box<Value>>,
    pub resolved: Option<VaultPath>,
}

/// A regular expression literal (`/abc/g`) or a value built from one. The
/// compiled form is shared; equality is by source and flags.
#[derive(Clone, Debug)]
pub struct RegexpValue {
    pub source: String,
    pub flags: String,
    pub regex: Arc<regex::Regex>,
}

impl PartialEq for RegexpValue {
    fn eq(&self, other: &Self) -> bool {
        self.source == other.source && self.flags == other.flags
    }
}

/// The Bases type system, as the published syntax page lists it, plus the
/// three render-only kinds (`image`, `icon`, `html`) that carry their
/// arguments to the client unrendered.
///
/// `PartialEq` here is *structural* equality for tests. The language's own
/// `==` is [`crate::eval::coerce::loose_equals`], which compares a link to a
/// file and a date to a date by instant — never use this derive for it.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    String(String),
    Number(f64),
    Boolean(bool),
    Date(DateValue),
    Duration(DurationValue),
    List(Vec<Value>),
    Object(Vec<(String, Value)>),
    Link(LinkValue),
    File(VaultPath),
    Regexp(RegexpValue),
    Image(String),
    Icon(String),
    Html(String),
}

impl Value {
    /// The name `isType` compares against, and the `kind` a cell carries.
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Boolean(_) => "boolean",
            Value::Date(_) => "date",
            Value::Duration(_) => "duration",
            Value::List(_) => "list",
            Value::Object(_) => "object",
            Value::Link(_) => "link",
            Value::File(_) => "file",
            Value::Regexp(_) => "regexp",
            Value::Image(_) => "image",
            Value::Icon(_) => "icon",
            Value::Html(_) => "html",
        }
    }
}
```

- [ ] **Step 6: Write the file model**

Create `crates/vault-bases/src/file.rs`:

```rust
use vault_core::{PropertyValue, SourceSpan, Spanned, parse_yaml_document};

/// A `.base` file, read but not compiled: every expression is still text.
///
/// Compilation happens per view (`view::compile_view`), so a base whose
/// formula does not parse still indexes, still lists its views, and answers
/// `expression_invalid` only for the view that reads the broken formula.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BaseFile {
    pub filters: Option<FilterNode>,
    /// Formula name to expression text, in declared order.
    pub formulas: Vec<(String, String)>,
    /// Per-property display settings, in declared order.
    pub properties: Vec<(String, PropertySettings)>,
    /// Custom summary name to expression text over `values`.
    pub summaries: Vec<(String, String)>,
    pub views: Vec<ViewDecl>,
}

/// The recursive filter tree the syntax page defines: a single statement, or
/// one of `and`, `or`, `not` over a heterogeneous list of statements and
/// trees. `not` means "none of the following are true" (the views page).
#[derive(Clone, Debug, PartialEq)]
pub enum FilterNode {
    Expr(String),
    And(Vec<FilterNode>),
    Or(Vec<FilterNode>),
    Not(Vec<FilterNode>),
}

/// One `properties:` entry. `displayName` is the one key the core reads;
/// every other key is kept, in order, so a view's own settings survive.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PropertySettings {
    pub display_name: Option<String>,
    pub options: Vec<(String, PropertyValue)>,
}

/// One entry of `views:`. Every key the core plugin owns is a field; every
/// other key is kept in `options`, in declared order, so a plugin's view
/// (`fileclass-table`) survives the round trip. An unknown `type` is kept as
/// declared and never interpreted.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewDecl {
    pub kind: String,
    pub name: String,
    pub filters: Option<FilterNode>,
    pub order: Vec<String>,
    pub sort: Vec<SortKey>,
    pub group_by: Option<GroupBy>,
    pub limit: Option<u64>,
    /// Property name to summary name (a built-in such as `Average`, or a key
    /// of the base's own `summaries`).
    pub summaries: Vec<(String, String)>,
    pub options: Vec<(String, PropertyValue)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SortKey {
    pub property: String,
    pub direction: Direction,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GroupBy {
    pub property: String,
    pub direction: Direction,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Asc,
    Desc,
}

/// Why a document is not a base, and where. `span` is a byte range into the
/// document; it is `None` only when the whole document is the culprit and no
/// narrower position exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BaseParseError {
    pub message: String,
    pub span: Option<SourceSpan>,
}

impl BaseParseError {
    fn at(span: SourceSpan, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            span: Some(span),
        }
    }
}

impl BaseFile {
    /// The declared view names, in order.
    pub fn view_names(&self) -> Vec<String> {
        self.views.iter().map(|view| view.name.clone()).collect()
    }

    /// The named view, matched exactly, or the first view when `name` is
    /// `None` (the views page: "The first view in your list of views will
    /// load by default").
    pub fn view(&self, name: Option<&str>) -> Option<&ViewDecl> {
        match name {
            None => self.views.first(),
            Some(name) => self.views.iter().find(|view| view.name == name),
        }
    }
}

type Entries<'a> = &'a [(Spanned<String>, Spanned<PropertyValue>)];

fn mapping<'a>(value: &'a Spanned<PropertyValue>, what: &str) -> Result<Entries<'a>, BaseParseError> {
    match &value.value {
        PropertyValue::Mapping(entries) => Ok(entries),
        _ => Err(BaseParseError::at(value.span, format!("{what} must be a mapping"))),
    }
}

/// A scalar read as expression text. Formulas and filter statements are
/// "always stored as strings in YAML" (the syntax page), but an unquoted
/// `true` or `5` is YAML's to type, so it is read back as the text it was.
fn expression_text(value: &Spanned<PropertyValue>, what: &str) -> Result<String, BaseParseError> {
    match &value.value {
        PropertyValue::String(text) => Ok(text.clone()),
        PropertyValue::Boolean(flag) => Ok(flag.to_string()),
        PropertyValue::Integer(number) => Ok(number.to_string()),
        PropertyValue::Float(number) => Ok(number.to_string()),
        _ => Err(BaseParseError::at(
            value.span,
            format!("{what} must be an expression string"),
        )),
    }
}

fn plain_string(value: &Spanned<PropertyValue>, what: &str) -> Result<String, BaseParseError> {
    match &value.value {
        PropertyValue::String(text) => Ok(text.clone()),
        PropertyValue::Integer(number) => Ok(number.to_string()),
        PropertyValue::Float(number) => Ok(number.to_string()),
        PropertyValue::Boolean(flag) => Ok(flag.to_string()),
        _ => Err(BaseParseError::at(value.span, format!("{what} must be a string"))),
    }
}

fn direction(value: &Spanned<PropertyValue>) -> Result<Direction, BaseParseError> {
    let text = plain_string(value, "direction")?;
    match text.to_ascii_uppercase().as_str() {
        "ASC" => Ok(Direction::Asc),
        "DESC" => Ok(Direction::Desc),
        _ => Err(BaseParseError::at(
            value.span,
            format!("direction must be ASC or DESC, not {text:?}"),
        )),
    }
}

fn filter(value: &Spanned<PropertyValue>) -> Result<FilterNode, BaseParseError> {
    match &value.value {
        PropertyValue::String(_) => Ok(FilterNode::Expr(expression_text(value, "a filter statement")?)),
        PropertyValue::Mapping(entries) => {
            let [(key, items)] = entries.as_slice() else {
                return Err(BaseParseError::at(
                    value.span,
                    "a filter object holds exactly one of and, or, or not",
                ));
            };
            let PropertyValue::Sequence(list) = &items.value else {
                return Err(BaseParseError::at(
                    items.span,
                    format!("filter `{}` must be a list", key.value),
                ));
            };
            let children = list.iter().map(filter).collect::<Result<Vec<_>, _>>()?;
            match key.value.as_str() {
                "and" => Ok(FilterNode::And(children)),
                "or" => Ok(FilterNode::Or(children)),
                "not" => Ok(FilterNode::Not(children)),
                other => Err(BaseParseError::at(
                    key.span,
                    format!("a filter object holds one of and, or, or not — not {other:?}"),
                )),
            }
        }
        _ => Err(BaseParseError::at(
            value.span,
            "a filter must be a statement string or an and/or/not object",
        )),
    }
}

fn named_expressions(
    value: &Spanned<PropertyValue>,
    what: &str,
) -> Result<Vec<(String, String)>, BaseParseError> {
    mapping(value, what)?
        .iter()
        .map(|(key, value)| Ok((key.value.clone(), expression_text(value, what)?)))
        .collect()
}

fn options_of(entries: Entries<'_>, core: &[&str]) -> Vec<(String, PropertyValue)> {
    entries
        .iter()
        .filter(|(key, _)| !core.contains(&key.value.as_str()))
        .map(|(key, value)| (key.value.clone(), value.value.clone()))
        .collect()
}

/// The keys the core Bases plugin owns on a view. Everything else is a view
/// type's own option and is kept verbatim.
const VIEW_KEYS: [&str; 8] = [
    "type", "name", "filters", "order", "sort", "groupBy", "limit", "summaries",
];

fn view(value: &Spanned<PropertyValue>, index: usize) -> Result<ViewDecl, BaseParseError> {
    let entries = mapping(value, "a view")?;
    let get = |name: &str| entries.iter().find(|(key, _)| key.value == name).map(|(_, v)| v);
    let kind = match get("type") {
        Some(kind) => plain_string(kind, "a view type")?,
        None => return Err(BaseParseError::at(value.span, format!("view {index} has no type"))),
    };
    let name = match get("name") {
        Some(name) => plain_string(name, "a view name")?,
        None => return Err(BaseParseError::at(value.span, format!("view {index} has no name"))),
    };
    let filters = get("filters").map(filter).transpose()?;
    let order = match get("order") {
        None => Vec::new(),
        Some(order) => match &order.value {
            PropertyValue::Sequence(items) => items
                .iter()
                .map(|item| plain_string(item, "an order entry"))
                .collect::<Result<_, _>>()?,
            _ => return Err(BaseParseError::at(order.span, "order must be a list")),
        },
    };
    let sort = match get("sort") {
        None => Vec::new(),
        Some(sort) => match &sort.value {
            PropertyValue::Sequence(items) => items
                .iter()
                .map(|item| {
                    let entries = mapping(item, "a sort key")?;
                    let property = entries
                        .iter()
                        .find(|(key, _)| key.value == "property")
                        .ok_or_else(|| BaseParseError::at(item.span, "a sort key needs a property"))?;
                    let direction_value = entries.iter().find(|(key, _)| key.value == "direction");
                    Ok(SortKey {
                        property: plain_string(&property.1, "a sort property")?,
                        direction: match direction_value {
                            Some((_, value)) => direction(value)?,
                            None => Direction::Asc,
                        },
                    })
                })
                .collect::<Result<_, BaseParseError>>()?,
            _ => return Err(BaseParseError::at(sort.span, "sort must be a list")),
        },
    };
    let group_by = match get("groupBy") {
        None => None,
        Some(group) => {
            let entries = mapping(group, "groupBy")?;
            let property = entries
                .iter()
                .find(|(key, _)| key.value == "property")
                .ok_or_else(|| BaseParseError::at(group.span, "groupBy needs a property"))?;
            let direction_value = entries.iter().find(|(key, _)| key.value == "direction");
            Some(GroupBy {
                property: plain_string(&property.1, "a groupBy property")?,
                direction: match direction_value {
                    Some((_, value)) => direction(value)?,
                    None => Direction::Asc,
                },
            })
        }
    };
    let limit = match get("limit") {
        None => None,
        Some(limit) => match &limit.value {
            PropertyValue::Integer(count) if *count >= 0 => Some(*count as u64),
            _ => {
                return Err(BaseParseError::at(
                    limit.span,
                    "limit must be a non-negative integer",
                ));
            }
        },
    };
    let summaries = match get("summaries") {
        None => Vec::new(),
        Some(summaries) => mapping(summaries, "a view's summaries")?
            .iter()
            .map(|(key, value)| Ok((key.value.clone(), plain_string(value, "a summary name")?)))
            .collect::<Result<_, BaseParseError>>()?,
    };
    Ok(ViewDecl {
        kind,
        name,
        filters,
        order,
        sort,
        group_by,
        limit,
        summaries,
        options: options_of(entries, &VIEW_KEYS),
    })
}

/// Read a `.base` document.
///
/// Unknown **top-level** keys are ignored (a later Obsidian may add one; the
/// file still opens there). Unknown **view** keys are kept in
/// [`ViewDecl::options`]. Every shape the model cannot read is an error with a
/// byte position — never a silently empty base.
pub fn parse_base(text: &str) -> Result<BaseFile, BaseParseError> {
    let root = match parse_yaml_document(text) {
        Ok(Some(root)) => root,
        Ok(None) => return Ok(BaseFile::default()),
        Err(error) => return Err(BaseParseError::at(error.span, error.message)),
    };
    let entries = mapping(&root, "a base")?;
    let mut base = BaseFile::default();
    for (key, value) in entries {
        match key.value.as_str() {
            "filters" => base.filters = Some(filter(value)?),
            "formulas" => base.formulas = named_expressions(value, "a formula")?,
            "summaries" => base.summaries = named_expressions(value, "a summary formula")?,
            "properties" => {
                for (property, settings) in mapping(value, "properties")? {
                    let settings_entries = mapping(settings, "a property's settings")?;
                    let display_name = settings_entries
                        .iter()
                        .find(|(key, _)| key.value == "displayName")
                        .map(|(_, value)| plain_string(value, "displayName"))
                        .transpose()?;
                    base.properties.push((
                        property.value.clone(),
                        PropertySettings {
                            display_name,
                            options: options_of(settings_entries, &["displayName"]),
                        },
                    ));
                }
            }
            "views" => match &value.value {
                PropertyValue::Sequence(items) => {
                    for (index, item) in items.iter().enumerate() {
                        base.views.push(view(item, index)?);
                    }
                }
                PropertyValue::Null => {}
                _ => return Err(BaseParseError::at(value.span, "views must be a list")),
            },
            _ => {}
        }
    }
    Ok(base)
}
```

Several of the messages are asserted by Step 2 through substrings: `"must be a mapping"` contains `mapping`, `"filter … must be …"` contains `filter`. Keep the wording or keep the substrings.

- [ ] **Step 7: Run the tests and see them pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test file_model; echo "exit=$?"`

Expected: `test result: ok. 7 passed`, `exit=0`.

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-core frontmatter; echo "exit=$?"`

Expected: the two new tests plus the existing one pass, `exit=0`.

- [ ] **Step 8: The gates**

Run, each separately:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-core; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
```

Expected: `exit=0` four times.

- [ ] **Step 9: Commit**

```bash
git add Cargo.toml Cargo.lock crates/vault-bases crates/vault-core/src/frontmatter.rs crates/vault-core/src/lib.rs
git commit -F - <<'COMMIT'
feat(bases): the vault-bases crate, its value model and the .base file model

A new pure crate reads a .base document into BaseFile: the filter tree, formulas, property display settings, custom summaries and views with their sort, groupBy, limit, summaries and every other key kept as an open map, so a plugin view survives. Every shape the model cannot read fails with a byte position. vault-core gains parse_yaml_document so the base parser reuses the one saphyr adapter and its char-to-byte table.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 2: The expression language — tokenizer and Pratt parser

A tokenizer and a Pratt parser turn one expression string into an `Expr` tree: literals (string, number, boolean, `null`, regular expression, list, object), property references in every published spelling, member access, indexing, global calls, method calls, and the operators `+ - * / %`, `== != < <= > >=`, `! && ||`. The proof is every expression printed on the three published pages, parsed.

**Files:**

- Create: `crates/vault-bases/src/expr/mod.rs`, `crates/vault-bases/src/expr/token.rs`, `crates/vault-bases/src/expr/parse.rs`
- Create: `crates/vault-bases/tests/syntax_examples.rs`
- Modify: `crates/vault-bases/src/lib.rs` (add `pub mod expr;`)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:

```rust
pub mod expr {
    #[derive(Clone, Debug, PartialEq)]
    pub enum Expr {
        Null, Boolean(bool), Number(f64), String(String),
        Regexp { source: String, flags: String },
        List(Vec<Expr>), Object(Vec<(String, Expr)>),
        /// A bare name: a note property (`price`), or one of the reserved
        /// roots `note`, `file`, `formula`, `this`, `values`, `value`, `index`, `acc`.
        Identifier(String),
        Member { target: Box<Expr>, name: String },
        Index { target: Box<Expr>, index: Box<Expr> },
        /// A global function call; `position` is the byte offset of the name.
        Call { name: String, args: Vec<Expr>, position: usize },
        /// A method call; `position` is the byte offset of the method name.
        Method { target: Box<Expr>, name: String, args: Vec<Expr>, position: usize },
        Unary { op: UnaryOp, operand: Box<Expr> },
        Binary { op: BinaryOp, left: Box<Expr>, right: Box<Expr> },
    }
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum UnaryOp { Not, Negate }
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum BinaryOp { Add, Sub, Mul, Div, Rem, Eq, Ne, Lt, Le, Gt, Ge, And, Or }
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ExpressionError { pub message: String, pub position: usize }
    pub fn parse_expression(text: &str) -> Result<Expr, ExpressionError>;
}
```

**The published-syntax checklist** — every expression on the three pages, transcribed 2026-10-02. Step 1 pins one parse per line; nothing here is evaluated yet (evaluation is Tasks 3 to 7, each against its own checklist).

- Syntax page, filters and formulas: `file.hasTag("tag")`, `file.hasTag("book")`, `file.hasLink("Textbook")`, `file.inFolder("Required Reading")`, `if(price, price.toFixed(2) + " dollars")`, `(price / age).toFixed(2)`, `values.mean().round(3)`, `status != "done"`, `formula.ppu > 5`, `price > 2.1`, `file.ext == "md"`.
- Syntax page, properties and `this`: `note.price`, `note["price"]`, `note.author`, `author`, `file.size`, `file.ext`, `file.hasLink()`, `formula.formatted_price`, `this.file.folder`, `this.file.name`, `file.hasLink(this.file)`.
- Syntax page, operators and dates: `radius * (2 * 3.14)`, `date + "1M"`, `date - "2h"`, `now() + "1 day"`, `file.mtime > now() - "1 week"`, `date("2024-12-01") + "1M" + "4h" + "3m"`, `now() - file.ctime`, `datetime.date()`, `datetime.format("YYYY-MM-DD")`.
- Syntax page, types: `"message"`, `1`, `(2.5)`, `true`, `false`, `date("2025-01-01 12:00:00")`, `now() + "1 hour"`, `today() + "7d"`, `(now() + "1d") - now()`, `now().hour`, `now.time()`, `property[0]`, `property.subprop`, `property["subprop"]`, `link("filename")`, `link("https://obsidian.md")`, `link(file.ctime.date().toString())`, `link("filename", "display")`, `link("filename", icon("plus"))`, `file.asLink()`, `author == this`, `authors.contains(this)`.
- Functions page, global: `now() + '1d'`, `now() + (duration('1d') * 2)`, `duration('5h') * 2`, `2 * duration('5h')`, `file(link("[[filename]]"))`, `file("path to file")`, `if(isModified, "Modified", "Unmodified")`, `image(image-property)`, `image("https://obsidian.md/images/obsidian-logo-gradient.svg")`, `icon("arrow-right")`, `list("value")`, `number("3.4")`.
- Functions page, any and date: `1.isTruthy()`, `"example".isType("string")`, `true.isType("boolean")`, `123.toString()`, `now().date().format("YYYY-MM-DD HH:mm:ss")`, `date.format("YYYY-MM-DD")`, `now().time()`, `file.mtime.relative()`.
- Functions page, string: `"hello".contains("ell")`, `"hello".containsAll("h", "e")`, `"hello".containsAny("x", "y", "e")`, `"hello".endsWith("lo")`, `"Hello world".isEmpty()`, `"".isEmpty()`, `"a:b:c:d".replace(/:/, "-")`, `"a:b:c:d".replace(/:/g, "-")`, `"John Smith".replace(/(\w+) (\w+)/, "$2, $1")`, `"123".repeat(2)`, `"hello".reverse()`, `"hello".slice(1, 4)`, `"a,b,c,d".split(",", 3)`, `"a,b,c,d".split(/,/, 3)`, `"hello".startsWith("he")`, `"hello world".title()`, `"  hi  ".trim()`.
- Functions page, number: `(-5).abs()`, `(2.1).ceil()`, `(2.9).floor()`, `5.isEmpty()`, `(2.5).round()`, `(2.3333).round(2)`, `(3.14159).toFixed(2)`.
- Functions page, list: `[1,2,3].contains(2)`, `[1,2,3].containsAll(2,3)`, `[1,2,3].containsAny(3,4)`, `[1,2,3,4].filter(value > 2)`, `[1,[2,3]].flat()`, `[1,2,3].isEmpty()`, `[1,2,3].join(",")`, `[1,2,3,4].map(value + 1)`, `[1,2,3].reduce(acc + value, 0)`, `values.filter(value.isType("number")).reduce(if(acc == null || value > acc, value, acc), null)`, `[1,2,3].reverse()`, `[1,2,3,4].slice(1,3)`, `[3, 1, 2].sort()`, `["c", "a", "b"].sort()`, `[1,2,2,3].unique()`.
- Functions page, link, file, object, regexp: `link("[[filename]]").asFile()`, `file.asLink()`, `file.hasLink(otherFile)`, `file.hasTag("tag1", "tag2")`, `file.inFolder("notes")`, `{}.isEmpty()`, `/abc/.matches("abcde")`.

One published example is ambiguous by construction and is recorded here rather than resolved: `image(image-property)` reads, under JavaScript's grammar (the functions page: "Bases functions follow JavaScript behavior"), as `image(image - property)`. This parser follows JavaScript, so a hyphen is never part of an identifier; the capture `hyphenated_identifier` in Task 13 records what Obsidian does, and a difference is a finding Task 13 reports rather than a silent change here.

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-bases/tests/syntax_examples.rs`:

```rust
use vault_bases::expr::{BinaryOp, Expr, UnaryOp, parse_expression};

/// Every expression on the published syntax, functions and views pages,
/// transcribed 2026-10-02. Each one must parse; what it evaluates to is
/// pinned per family in Tasks 3 to 7.
const PUBLISHED: &[&str] = &[
    r#"file.hasTag("tag")"#,
    r#"file.hasTag("book")"#,
    r#"file.hasLink("Textbook")"#,
    r#"file.inFolder("Required Reading")"#,
    r#"if(price, price.toFixed(2) + " dollars")"#,
    "(price / age).toFixed(2)",
    "values.mean().round(3)",
    r#"status != "done""#,
    "formula.ppu > 5",
    "price > 2.1",
    r#"file.ext == "md""#,
    "note.price",
    r#"note["price"]"#,
    "note.author",
    "author",
    "file.size",
    "file.ext",
    "file.hasLink()",
    "formula.formatted_price",
    "this.file.folder",
    "this.file.name",
    "file.hasLink(this.file)",
    "radius * (2 * 3.14)",
    r#"date + "1M""#,
    r#"date - "2h""#,
    r#"now() + "1 day""#,
    r#"file.mtime > now() - "1 week""#,
    r#"date("2024-12-01") + "1M" + "4h" + "3m""#,
    "now() - file.ctime",
    "datetime.date()",
    r#"datetime.format("YYYY-MM-DD")"#,
    r#""message""#,
    "1",
    "(2.5)",
    "true",
    "false",
    r#"date("2025-01-01 12:00:00")"#,
    r#"now() + "1 hour""#,
    r#"today() + "7d""#,
    r#"(now() + "1d") - now()"#,
    "now().hour",
    "now.time()",
    "property[0]",
    "property.subprop",
    r#"property["subprop"]"#,
    r#"link("filename")"#,
    r#"link("https://obsidian.md")"#,
    "link(file.ctime.date().toString())",
    r#"link("filename", "display")"#,
    r#"link("filename", icon("plus"))"#,
    "file.asLink()",
    "author == this",
    "authors.contains(this)",
    "now() + '1d'",
    "now() + (duration('1d') * 2)",
    "duration('5h') * 2",
    "2 * duration('5h')",
    r#"file(link("[[filename]]"))"#,
    r#"file("path to file")"#,
    r#"if(isModified, "Modified", "Unmodified")"#,
    "image(image-property)",
    r#"image("https://obsidian.md/images/obsidian-logo-gradient.svg")"#,
    r#"icon("arrow-right")"#,
    r#"list("value")"#,
    r#"number("3.4")"#,
    "1.isTruthy()",
    r#""example".isType("string")"#,
    r#"true.isType("boolean")"#,
    "123.toString()",
    r#"now().date().format("YYYY-MM-DD HH:mm:ss")"#,
    r#"date.format("YYYY-MM-DD")"#,
    "now().time()",
    "file.mtime.relative()",
    r#""hello".contains("ell")"#,
    r#""hello".containsAll("h", "e")"#,
    r#""hello".containsAny("x", "y", "e")"#,
    r#""hello".endsWith("lo")"#,
    r#""Hello world".isEmpty()"#,
    r#""".isEmpty()"#,
    r#""a:b:c:d".replace(/:/, "-")"#,
    r#""a:b:c:d".replace(/:/g, "-")"#,
    r#""John Smith".replace(/(\w+) (\w+)/, "$2, $1")"#,
    r#""123".repeat(2)"#,
    r#""hello".reverse()"#,
    r#""hello".slice(1, 4)"#,
    r#""a,b,c,d".split(",", 3)"#,
    r#""a,b,c,d".split(/,/, 3)"#,
    r#""hello".startsWith("he")"#,
    r#""hello world".title()"#,
    r#""  hi  ".trim()"#,
    "(-5).abs()",
    "(2.1).ceil()",
    "(2.9).floor()",
    "5.isEmpty()",
    "(2.5).round()",
    "(2.3333).round(2)",
    "(3.14159).toFixed(2)",
    "[1,2,3].contains(2)",
    "[1,2,3].containsAll(2,3)",
    "[1,2,3].containsAny(3,4)",
    "[1,2,3,4].filter(value > 2)",
    "[1,[2,3]].flat()",
    "[1,2,3].isEmpty()",
    r#"[1,2,3].join(",")"#,
    "[1,2,3,4].map(value + 1)",
    "[1,2,3].reduce(acc + value, 0)",
    r#"values.filter(value.isType("number")).reduce(if(acc == null || value > acc, value, acc), null)"#,
    "[1,2,3].reverse()",
    "[1,2,3,4].slice(1,3)",
    "[3, 1, 2].sort()",
    r#"["c", "a", "b"].sort()"#,
    "[1,2,2,3].unique()",
    r#"link("[[filename]]").asFile()"#,
    "file.hasLink(otherFile)",
    r#"file.hasTag("tag1", "tag2")"#,
    r#"file.inFolder("notes")"#,
    "{}.isEmpty()",
    r#"/abc/.matches("abcde")"#,
];

#[test]
fn every_published_expression_parses() {
    let mut failures = Vec::new();
    for text in PUBLISHED {
        if let Err(error) = parse_expression(text) {
            failures.push(format!("{text:?}: {} at {}", error.message, error.position));
        }
    }
    assert!(failures.is_empty(), "{} failed:\n{}", failures.len(), failures.join("\n"));
}

fn id(name: &str) -> Box<Expr> {
    Box::new(Expr::Identifier(name.into()))
}

#[test]
fn multiplication_binds_tighter_than_addition_and_comparison_tighter_than_logic() {
    let parsed = parse_expression("a + b * c > d && !e || f").expect("parses");
    let expected = Expr::Binary {
        op: BinaryOp::Or,
        left: Box::new(Expr::Binary {
            op: BinaryOp::And,
            left: Box::new(Expr::Binary {
                op: BinaryOp::Gt,
                left: Box::new(Expr::Binary {
                    op: BinaryOp::Add,
                    left: id("a"),
                    right: Box::new(Expr::Binary {
                        op: BinaryOp::Mul,
                        left: id("b"),
                        right: id("c"),
                    }),
                }),
                right: id("d"),
            }),
            right: Box::new(Expr::Unary {
                op: UnaryOp::Not,
                operand: id("e"),
            }),
        }),
        right: id("f"),
    };
    assert_eq!(parsed, expected);
}

#[test]
fn subtraction_and_division_associate_to_the_left() {
    assert_eq!(
        parse_expression("a - b - c").unwrap(),
        Expr::Binary {
            op: BinaryOp::Sub,
            left: Box::new(Expr::Binary { op: BinaryOp::Sub, left: id("a"), right: id("b") }),
            right: id("c"),
        }
    );
    assert_eq!(
        parse_expression("a / b / c").unwrap(),
        Expr::Binary {
            op: BinaryOp::Div,
            left: Box::new(Expr::Binary { op: BinaryOp::Div, left: id("a"), right: id("b") }),
            right: id("c"),
        }
    );
}

#[test]
fn a_method_on_a_number_literal_is_a_method_not_a_decimal() {
    assert_eq!(
        parse_expression("5.isEmpty()").unwrap(),
        Expr::Method {
            target: Box::new(Expr::Number(5.0)),
            name: "isEmpty".into(),
            args: vec![],
            position: 2,
        }
    );
    assert_eq!(parse_expression("2.5").unwrap(), Expr::Number(2.5));
    assert_eq!(parse_expression("1e3").unwrap(), Expr::Number(1000.0));
}

#[test]
fn a_slash_after_a_value_divides_and_elsewhere_starts_a_regexp() {
    assert!(matches!(
        parse_expression("price / age").unwrap(),
        Expr::Binary { op: BinaryOp::Div, .. }
    ));
    let Expr::Method { args, .. } = parse_expression(r#""a:b".replace(/:/g, "-")"#).unwrap() else {
        panic!("a method call");
    };
    assert_eq!(
        args[0],
        Expr::Regexp { source: ":".into(), flags: "g".into() }
    );
    let Expr::Method { args, .. } =
        parse_expression(r#""x".replace(/a\/b[/]c/, "")"#).unwrap()
    else {
        panic!("a method call");
    };
    assert_eq!(
        args[0],
        Expr::Regexp { source: r"a\/b[/]c".into(), flags: "".into() },
        "an escaped slash and a slash in a class do not end the literal"
    );
}

#[test]
fn indexing_member_access_and_calls_chain_left_to_right() {
    assert_eq!(
        parse_expression(r#"note["my prop"][0].length"#).unwrap(),
        Expr::Member {
            target: Box::new(Expr::Index {
                target: Box::new(Expr::Index {
                    target: id("note"),
                    index: Box::new(Expr::String("my prop".into())),
                }),
                index: Box::new(Expr::Number(0.0)),
            }),
            name: "length".into(),
        }
    );
    assert_eq!(
        parse_expression("today()").unwrap(),
        Expr::Call { name: "today".into(), args: vec![], position: 0 }
    );
}

#[test]
fn literals_cover_strings_with_escapes_lists_objects_and_null() {
    assert_eq!(
        parse_expression(r#"'it\'s' + "a\"b\né""#).unwrap(),
        Expr::Binary {
            op: BinaryOp::Add,
            left: Box::new(Expr::String("it's".into())),
            right: Box::new(Expr::String("a\"b\né".into())),
        }
    );
    assert_eq!(
        parse_expression(r#"[1, "a", null, [true]]"#).unwrap(),
        Expr::List(vec![
            Expr::Number(1.0),
            Expr::String("a".into()),
            Expr::Null,
            Expr::List(vec![Expr::Boolean(true)]),
        ])
    );
    assert_eq!(
        parse_expression(r#"{"a": 1, b: 2}"#).unwrap(),
        Expr::Object(vec![
            ("a".into(), Expr::Number(1.0)),
            ("b".into(), Expr::Number(2.0)),
        ])
    );
    assert_eq!(
        parse_expression("-x").unwrap(),
        Expr::Unary { op: UnaryOp::Negate, operand: id("x") }
    );
}

#[test]
fn unicode_identifiers_and_strings_parse_and_positions_are_bytes() {
    assert_eq!(parse_expression("prioritét").unwrap(), Expr::Identifier("prioritét".into()));
    let error = parse_expression(r#""é" +"#).expect_err("dangling operator");
    assert_eq!(error.position, r#""é" +"#.len(), "the end of input, in bytes");
}

#[test]
fn errors_name_what_went_wrong_and_where() {
    for (text, position, needle) in [
        ("1 +", 3, "expected an expression"),
        (r#""open"#, 0, "unterminated string"),
        ("f(1,", 4, "expected an expression"),
        ("(1", 2, "expected `)`"),
        ("a..b", 2, "expected a name"),
        ("1 2", 2, "unexpected"),
        ("/open", 0, "unterminated regular expression"),
        ("#", 0, "unexpected character"),
        ("a = b", 2, "unexpected character"),
    ] {
        let error = parse_expression(text).expect_err(text);
        assert_eq!(error.position, position, "{text:?}: {}", error.message);
        assert!(error.message.contains(needle), "{text:?}: {:?}", error.message);
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test syntax_examples; echo "exit=$?"`

Expected: `error[E0432]: unresolved import vault_bases::expr`, `exit=101`.

- [ ] **Step 3: Write the tokenizer**

Create `crates/vault-bases/src/expr/token.rs`:

```rust
use super::ExpressionError;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Token {
    Number(f64),
    String(String),
    Regexp { source: String, flags: String },
    Ident(String),
    Punct(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Spanned {
    pub token: Token,
    pub start: usize,
}

const PUNCTUATION: [&str; 23] = [
    "&&", "||", "==", "!=", "<=", ">=", "(", ")", "[", "]", "{", "}", ",", ".", ":", "!", "<",
    ">", "+", "-", "*", "/", "%",
];

fn error(position: usize, message: impl Into<String>) -> ExpressionError {
    ExpressionError {
        message: message.into(),
        position,
    }
}

fn is_ident_start(c: char) -> bool {
    c == '_' || c == '$' || c.is_alphabetic()
}

fn is_ident_continue(c: char) -> bool {
    is_ident_start(c) || c.is_numeric()
}

/// Whether a `/` at this point starts a regular expression rather than
/// dividing. The JavaScript rule of thumb: after something that ends a value
/// (a name, a number, a string, a closing bracket) it divides; anywhere else
/// it opens a literal.
fn slash_starts_regexp(previous: Option<&Token>) -> bool {
    !matches!(
        previous,
        Some(Token::Number(_))
            | Some(Token::String(_))
            | Some(Token::Regexp { .. })
            | Some(Token::Ident(_))
            | Some(Token::Punct(")"))
            | Some(Token::Punct("]"))
            | Some(Token::Punct("}"))
    )
}

pub(crate) fn tokenize(text: &str) -> Result<Vec<Spanned>, ExpressionError> {
    let mut tokens: Vec<Spanned> = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some(&(start, c)) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c.is_ascii_digit() {
            let mut end = start;
            let mut seen_dot = false;
            let mut seen_exponent = false;
            while let Some(&(at, d)) = chars.peek() {
                if d.is_ascii_digit() {
                    end = at + 1;
                    chars.next();
                } else if d == '.' && !seen_dot && !seen_exponent {
                    // A dot continues the number only when a digit follows:
                    // `5.isEmpty()` is a method on 5, `2.5` is a decimal.
                    let next_is_digit = text[at + 1..].chars().next().is_some_and(|n| n.is_ascii_digit());
                    if !next_is_digit {
                        break;
                    }
                    seen_dot = true;
                    end = at + 1;
                    chars.next();
                } else if (d == 'e' || d == 'E') && !seen_exponent {
                    let rest = &text[at + 1..];
                    let digits_follow = rest
                        .strip_prefix(['+', '-'])
                        .unwrap_or(rest)
                        .chars()
                        .next()
                        .is_some_and(|n| n.is_ascii_digit());
                    if !digits_follow {
                        break;
                    }
                    seen_exponent = true;
                    chars.next();
                    if let Some(&(sign_at, sign)) = chars.peek() {
                        if sign == '+' || sign == '-' {
                            chars.next();
                            end = sign_at + 1;
                        }
                    }
                    end = end.max(at + 1);
                } else {
                    break;
                }
            }
            let number: f64 = text[start..end]
                .parse()
                .map_err(|_| error(start, "malformed number"))?;
            tokens.push(Spanned { token: Token::Number(number), start });
            continue;
        }
        if c == '"' || c == '\'' {
            chars.next();
            let mut value = String::new();
            let mut closed = false;
            while let Some((_, d)) = chars.next() {
                if d == c {
                    closed = true;
                    break;
                }
                if d == '\\' {
                    let Some((escape_at, escaped)) = chars.next() else {
                        break;
                    };
                    match escaped {
                        'n' => value.push('\n'),
                        't' => value.push('\t'),
                        'r' => value.push('\r'),
                        '0' => value.push('\0'),
                        'u' => {
                            let hex: String = (0..4).filter_map(|_| chars.next().map(|(_, h)| h)).collect();
                            let code = u32::from_str_radix(&hex, 16)
                                .ok()
                                .and_then(char::from_u32)
                                .ok_or_else(|| error(escape_at, "malformed \\u escape"))?;
                            value.push(code);
                        }
                        other => value.push(other),
                    }
                    continue;
                }
                value.push(d);
            }
            if !closed {
                return Err(error(start, "unterminated string"));
            }
            tokens.push(Spanned { token: Token::String(value), start });
            continue;
        }
        if c == '/' && slash_starts_regexp(tokens.last().map(|spanned| &spanned.token)) {
            chars.next();
            let mut source = String::new();
            let mut in_class = false;
            let mut closed = false;
            while let Some((_, d)) = chars.next() {
                match d {
                    '\\' => {
                        source.push('\\');
                        if let Some((_, escaped)) = chars.next() {
                            source.push(escaped);
                        }
                    }
                    '[' => {
                        in_class = true;
                        source.push(d);
                    }
                    ']' => {
                        in_class = false;
                        source.push(d);
                    }
                    '/' if !in_class => {
                        closed = true;
                        break;
                    }
                    '\n' => break,
                    _ => source.push(d),
                }
            }
            if !closed {
                return Err(error(start, "unterminated regular expression"));
            }
            let mut flags = String::new();
            while let Some(&(_, f)) = chars.peek() {
                if f.is_ascii_alphabetic() {
                    flags.push(f);
                    chars.next();
                } else {
                    break;
                }
            }
            tokens.push(Spanned { token: Token::Regexp { source, flags }, start });
            continue;
        }
        if is_ident_start(c) {
            let mut end = start;
            while let Some(&(at, d)) = chars.peek() {
                if is_ident_continue(d) {
                    end = at + d.len_utf8();
                    chars.next();
                } else {
                    break;
                }
            }
            tokens.push(Spanned { token: Token::Ident(text[start..end].to_string()), start });
            continue;
        }
        let rest = &text[start..];
        let Some(punct) = PUNCTUATION.iter().find(|p| rest.starts_with(**p)) else {
            return Err(error(start, format!("unexpected character {c:?}")));
        };
        for _ in 0..punct.chars().count() {
            chars.next();
        }
        tokens.push(Spanned { token: Token::Punct(punct), start });
    }
    Ok(tokens)
}
```

`PUNCTUATION` lists the two-character operators first so `<=` is never read as `<` then `=`. A lone `=` is not in the list and is therefore "unexpected character" — Bases has no assignment.

- [ ] **Step 4: Write the parser and the tree**

Create `crates/vault-bases/src/expr/mod.rs`:

```rust
//! The Bases expression language: one string to one tree.
//!
//! The grammar is the one the published syntax page describes, read with
//! JavaScript's precedence (the functions page: "Bases functions follow
//! JavaScript behavior"): `||` < `&&` < `== !=` < `< <= > >=` < `+ -` <
//! `* / %` < prefix `! -` < postfix `.name`, `[index]`, `(args)`.

mod parse;
mod token;

pub use parse::parse_expression;

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Null,
    Boolean(bool),
    Number(f64),
    String(String),
    Regexp { source: String, flags: String },
    List(Vec<Expr>),
    Object(Vec<(String, Expr)>),
    /// A bare name: a note property (`price`), or one of the reserved roots
    /// `note`, `file`, `formula`, `this`, `values`, `value`, `index`, `acc`.
    Identifier(String),
    Member { target: Box<Expr>, name: String },
    Index { target: Box<Expr>, index: Box<Expr> },
    /// A global function call; `position` is the byte offset of the name.
    Call { name: String, args: Vec<Expr>, position: usize },
    /// A method call; `position` is the byte offset of the method name.
    Method { target: Box<Expr>, name: String, args: Vec<Expr>, position: usize },
    Unary { op: UnaryOp, operand: Box<Expr> },
    Binary { op: BinaryOp, left: Box<Expr>, right: Box<Expr> },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnaryOp {
    Not,
    Negate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

/// An expression that does not parse, with the byte offset into the
/// expression text where the parser gave up.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExpressionError {
    pub message: String,
    pub position: usize,
}
```

Create `crates/vault-bases/src/expr/parse.rs`:

```rust
use super::token::{Spanned, Token, tokenize};
use super::{BinaryOp, Expr, ExpressionError, UnaryOp};

struct Parser {
    tokens: Vec<Spanned>,
    at: usize,
    end: usize,
}

fn binary(token: &Token) -> Option<(BinaryOp, u8)> {
    let Token::Punct(punct) = token else {
        return None;
    };
    Some(match *punct {
        "||" => (BinaryOp::Or, 1),
        "&&" => (BinaryOp::And, 2),
        "==" => (BinaryOp::Eq, 3),
        "!=" => (BinaryOp::Ne, 3),
        "<" => (BinaryOp::Lt, 4),
        "<=" => (BinaryOp::Le, 4),
        ">" => (BinaryOp::Gt, 4),
        ">=" => (BinaryOp::Ge, 4),
        "+" => (BinaryOp::Add, 5),
        "-" => (BinaryOp::Sub, 5),
        "*" => (BinaryOp::Mul, 6),
        "/" => (BinaryOp::Div, 6),
        "%" => (BinaryOp::Rem, 6),
        _ => return None,
    })
}

const PREFIX_POWER: u8 = 7;

impl Parser {
    fn peek(&self) -> Option<&Spanned> {
        self.tokens.get(self.at)
    }

    fn position(&self) -> usize {
        self.peek().map_or(self.end, |spanned| spanned.start)
    }

    fn error(&self, message: impl Into<String>) -> ExpressionError {
        ExpressionError {
            message: message.into(),
            position: self.position(),
        }
    }

    fn eat(&mut self, punct: &str) -> bool {
        if matches!(self.peek(), Some(Spanned { token: Token::Punct(p), .. }) if *p == punct) {
            self.at += 1;
            return true;
        }
        false
    }

    fn expect(&mut self, punct: &str) -> Result<(), ExpressionError> {
        if self.eat(punct) {
            return Ok(());
        }
        Err(self.error(format!("expected `{punct}`")))
    }

    fn expression(&mut self, minimum: u8) -> Result<Expr, ExpressionError> {
        let mut left = self.prefix()?;
        while let Some(spanned) = self.peek() {
            let Some((op, power)) = binary(&spanned.token) else {
                break;
            };
            if power < minimum {
                break;
            }
            self.at += 1;
            // Left-associative: the right operand binds strictly tighter.
            let right = self.expression(power + 1)?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn arguments(&mut self, close: &str) -> Result<Vec<Expr>, ExpressionError> {
        let mut args = Vec::new();
        if self.eat(close) {
            return Ok(args);
        }
        loop {
            args.push(self.expression(1)?);
            if self.eat(close) {
                return Ok(args);
            }
            self.expect(",")?;
        }
    }

    fn prefix(&mut self) -> Result<Expr, ExpressionError> {
        let Some(spanned) = self.peek().cloned() else {
            return Err(self.error("expected an expression"));
        };
        self.at += 1;
        let primary = match spanned.token {
            Token::Number(number) => Expr::Number(number),
            Token::String(text) => Expr::String(text),
            Token::Regexp { source, flags } => Expr::Regexp { source, flags },
            Token::Ident(name) => match name.as_str() {
                "true" => Expr::Boolean(true),
                "false" => Expr::Boolean(false),
                "null" => Expr::Null,
                _ => {
                    if self.eat("(") {
                        let args = self.arguments(")")?;
                        Expr::Call {
                            name,
                            args,
                            position: spanned.start,
                        }
                    } else {
                        Expr::Identifier(name)
                    }
                }
            },
            Token::Punct("(") => {
                let inner = self.expression(1)?;
                self.expect(")")?;
                inner
            }
            Token::Punct("[") => Expr::List(self.arguments("]")?),
            Token::Punct("{") => {
                let mut entries = Vec::new();
                if !self.eat("}") {
                    loop {
                        let key = match self.peek().cloned() {
                            Some(Spanned { token: Token::String(key), .. })
                            | Some(Spanned { token: Token::Ident(key), .. }) => key,
                            _ => return Err(self.error("expected an object key")),
                        };
                        self.at += 1;
                        self.expect(":")?;
                        entries.push((key, self.expression(1)?));
                        if self.eat("}") {
                            break;
                        }
                        self.expect(",")?;
                    }
                }
                Expr::Object(entries)
            }
            Token::Punct("!") => Expr::Unary {
                op: UnaryOp::Not,
                operand: Box::new(self.expression(PREFIX_POWER)?),
            },
            Token::Punct("-") => Expr::Unary {
                op: UnaryOp::Negate,
                operand: Box::new(self.expression(PREFIX_POWER)?),
            },
            Token::Punct(_) => {
                self.at -= 1;
                return Err(self.error("expected an expression"));
            }
        };
        self.postfix(primary)
    }

    fn postfix(&mut self, mut target: Expr) -> Result<Expr, ExpressionError> {
        loop {
            if self.eat(".") {
                let Some(Spanned { token: Token::Ident(name), start }) = self.peek().cloned() else {
                    return Err(self.error("expected a name after `.`"));
                };
                self.at += 1;
                if self.eat("(") {
                    let args = self.arguments(")")?;
                    target = Expr::Method {
                        target: Box::new(target),
                        name,
                        args,
                        position: start,
                    };
                } else {
                    target = Expr::Member {
                        target: Box::new(target),
                        name,
                    };
                }
            } else if self.eat("[") {
                let index = self.expression(1)?;
                self.expect("]")?;
                target = Expr::Index {
                    target: Box::new(target),
                    index: Box::new(index),
                };
            } else {
                return Ok(target);
            }
        }
    }
}

/// Parse one expression string. The whole input must be one expression:
/// trailing tokens are an error naming where they start.
pub fn parse_expression(text: &str) -> Result<Expr, ExpressionError> {
    let mut parser = Parser {
        tokens: tokenize(text)?,
        at: 0,
        end: text.len(),
    };
    let expr = parser.expression(1)?;
    if parser.peek().is_some() {
        return Err(parser.error("unexpected token after the expression"));
    }
    Ok(expr)
}
```

The error message for `a..b` is "expected a name after `.`", which contains the asserted `expected a name`; the message for `1 2` is "unexpected token after the expression", which contains `unexpected`.

Add `pub mod expr;` to `crates/vault-bases/src/lib.rs` below `mod file;`.

- [ ] **Step 5: Run the tests and see them pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test syntax_examples; echo "exit=$?"`

Expected: `test result: ok. 9 passed`, `exit=0`. If `every_published_expression_parses` fails, the assertion lists each failing expression with its message and position; fix the parser, never the list.

- [ ] **Step 6: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-bases; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check -p vault-bases; echo "exit=$?"
```

Expected: `exit=0` four times.

- [ ] **Step 7: Commit**

```bash
git add crates/vault-bases
git commit -F - <<'COMMIT'
feat(bases): the expression tokenizer and Pratt parser

One expression string becomes one Expr tree: literals including regular expressions, lists and objects; property references in every published spelling; member access, indexing, global and method calls; and the arithmetic, comparison and boolean operators at JavaScript's precedence. Every expression printed on the published syntax, functions and views pages parses, pinned one by one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 3: The evaluator core — row source, scopes, coercion, operators, `if`, and the `any` methods

A tree walker evaluates an `Expr` against one row of a `RowSource`, with `this`, `file`, `note`, `formula`, bare property names and the lambda locals (`value`, `index`, `acc`, `values`) resolved through a `Scope`. This task fixes the semantics every later family leans on — truthiness, equality, comparison, the total sort order, arithmetic and string concatenation, number-to-string — plus the global functions that are not about dates or files (`if`, `list`, `number`, `max`, `min`, `random`, `escapeHTML`, `html`, `icon`, `image`) and the three `any` methods (`isTruthy`, `isType`, `toString`). It also creates the capture-fixture machinery: one JSON line per case, each marked `published` (fixed by a published page or standard — JavaScript semantics, which the functions page names) or `uncaptured` (no published rule, so the evaluator answers an `error` cell naming the case until Task 13's capture fills it).

**Files:**

- Create: `crates/vault-bases/src/source.rs`, `crates/vault-bases/src/clock.rs`, `crates/vault-bases/src/eval/mod.rs`, `crates/vault-bases/src/eval/coerce.rs`, `crates/vault-bases/src/functions/mod.rs`, `crates/vault-bases/src/functions/global.rs`, `crates/vault-bases/src/functions/any.rs`, `crates/vault-bases/src/fixtures.rs`
- Create: `crates/vault-bases/tests/coercion.rs`, `crates/vault-bases/tests/fixtures/captures/coercion.jsonl`, `crates/vault-bases/tests/fixtures/captures/global.jsonl`, `crates/vault-bases/tests/fixtures/captures/any.jsonl`
- Modify: `crates/vault-bases/src/lib.rs`

**Interfaces:**

- Consumes: `Value` and friends (Task 1); `Expr`, `BinaryOp`, `UnaryOp`, `parse_expression` (Task 2).
- Produces:

```rust
// source.rs
#[derive(Clone, Copy, Debug, Eq, PartialEq)] pub enum FileKind { Note, File }
#[derive(Clone, Debug, PartialEq)] pub struct FileFacts { pub path: VaultPath, pub kind: FileKind, pub size: u64, pub ctime_ms: i64, pub mtime_ms: i64 }
#[derive(Clone, Debug, PartialEq)] pub struct LinkFact { pub raw_target: String, pub display: Option<String>, pub resolved: Option<VaultPath> }
#[derive(Clone, Copy, Debug, Eq, PartialEq)] pub enum PropertyType { Text, Number, Checkbox, Date, DateTime, List, Tags, Aliases, Unknown }
#[derive(Clone, Debug, PartialEq)] pub enum ScalarLiteral { String(String), Number(f64), Boolean(bool) }
#[derive(Clone, Debug, PartialEq)] pub enum Prefilter { InFolder(String), HasTag(Vec<String>), Ext(String), PropertyEquals { key: String, value: ScalarLiteral } }
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)] #[error("row source failed: {0}")] pub struct SourceError(pub String);
pub trait RowSource {
    fn candidates(&self, prefilters: &[Prefilter]) -> Result<Vec<VaultPath>, SourceError>;
    fn facts(&self, path: &VaultPath) -> Result<Option<FileFacts>, SourceError>;
    fn properties(&self, path: &VaultPath) -> Result<Vec<(String, PropertyValue)>, SourceError>;
    fn tags(&self, path: &VaultPath) -> Result<Vec<String>, SourceError>;
    fn links(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError>;
    fn embeds(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError>;
    fn backlinks(&self, path: &VaultPath) -> Result<Vec<VaultPath>, SourceError>;
    fn resolve(&self, from: &VaultPath, target: &str) -> Result<Option<VaultPath>, SourceError>;
    fn property_type(&self, key: &str) -> Option<PropertyType>;
}
pub struct MemorySource { /* files, types */ }
impl MemorySource { pub fn new() -> Self; pub fn with(self, path: &str, file: MemoryFile) -> Self; pub fn typed(self, key: &str, kind: PropertyType) -> Self; }
pub struct MemoryFile { /* kind, size, times, properties, tags, links, embeds */ }
impl MemoryFile { pub fn note() -> Self; pub fn attachment(size: u64) -> Self; pub fn property(self, key: &str, value: PropertyValue) -> Self;
    pub fn tag(self, tag: &str) -> Self; pub fn link(self, target: &str) -> Self; pub fn embed(self, target: &str) -> Self; pub fn times(self, ctime_ms: i64, mtime_ms: i64) -> Self; }
pub fn text(value: &str) -> PropertyValue; pub fn number(value: f64) -> PropertyValue;  // test conveniences

// clock.rs
#[derive(Clone, Debug)] pub struct Clock { pub now_ms: i64, pub zone: jiff::tz::TimeZone }
impl Clock { pub fn system() -> Self; pub fn fixed(now_ms: i64, zone: &str) -> Self; }

// eval
pub trait Formulas { fn formula(&self, name: &str, ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError>; }
pub struct NoFormulas;
pub struct EvalContext<'a> { pub source: &'a dyn RowSource, pub clock: &'a Clock, pub base_path: &'a VaultPath, pub this_path: &'a VaultPath, pub formulas: &'a dyn Formulas, /* random state */ }
impl<'a> EvalContext<'a> { pub fn new(source: &'a dyn RowSource, clock: &'a Clock, base_path: &'a VaultPath, this_path: &'a VaultPath) -> Self; pub fn with_formulas(self, formulas: &'a dyn Formulas) -> Self; }
#[derive(Clone, Debug, Default)] pub struct Scope { pub row: Option<VaultPath>, pub locals: Vec<(String, Value)> }
impl Scope { pub fn row(path: &VaultPath) -> Self; pub fn bind(&self, name: &str, value: Value) -> Self; }
#[derive(Clone, Debug, PartialEq, thiserror::Error)] pub enum EvalError { Type(String), DivisionByZero, UnknownFunction(String),
    NoSuchMethod { target: &'static str, name: String }, NoSuchField { target: &'static str, name: String }, UnknownFormula(String),
    FormulaCycle(String), Uncaptured(String), UnsupportedFormatToken(String), Argument(String), Source(SourceError) }
pub fn evaluate(expr: &Expr, ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError>;
pub mod coerce { pub fn truthy(&Value) -> bool; pub fn loose_equals(&Value, &Value) -> Result<bool, EvalError>;
    pub fn compare(&Value, &Value) -> Result<std::cmp::Ordering, EvalError>; pub fn sort_order(&Value, &Value) -> std::cmp::Ordering;
    pub fn number_to_string(f64) -> String; pub fn to_display_string(&Value) -> Result<String, EvalError>; pub fn parse_js_number(&str) -> Option<f64>; }

// functions
pub fn is_known_global(name: &str) -> bool;
pub fn is_known_method(name: &str) -> bool;

// fixtures (feature "fixtures")
pub struct CaptureRow { pub family: String, pub case: String, pub expr: String, pub kind: String, pub text: Option<String>, pub source: String, pub props: Vec<(String, PropertyValue)>, pub now_ms: Option<i64>, pub zone: Option<String> }
pub fn load_captures(family: &str) -> Vec<CaptureRow>;
pub fn render_text(value: &Value, clock: &Clock) -> String;
pub fn check_family(family: &str) -> Vec<String>;   // one line per failing row; empty when every row agrees
pub const FIXTURE_NOW_MS: i64; pub const FIXTURE_ZONE: &str;
```

**This task's checklist** (published functions it implements; each has at least one fixture row): global `if`, `list`, `number`, `max`, `min`, `random`, `escapeHTML`, `html`, `icon`, `image`; any `isTruthy`, `isType`, `toString`; the operators `+ - * / %` on numbers and strings, `== != < <= > >=` on primitives, `! && ||`.

**The named uncaptured cases this task leaves for Task 13** (each answers `EvalError::Uncaptured("<case>")`, which a view renders as an error cell): `eq:number:string`, `eq:boolean:number`, `eq:list:list`, `eq:object:object`, `cmp:mixed`, `add:string:null`, `arith:null`, `tostring:null`, `tostring:date`, `tostring:link`, `tostring:file`, `tostring:object`, `number:empty_string`, `number:null`, `index:string`, `sort:mixed` (the provisional mixed-type rank `MIXED_TYPE_RANK`, which keeps `sort` total and deterministic until the capture replaces it).

- [ ] **Step 1: Write the fixture files**

Create `crates/vault-bases/tests/fixtures/captures/coercion.jsonl` (one JSON object per line; `kind` is the value's `type_name`, or `error`; `text` is the cell text `render_text` produces, absent for `error`):

```json
{"family":"coercion","case":"truthy:empty_string","expr":"\"\".isTruthy()","kind":"boolean","text":"false","source":"published"}
{"family":"coercion","case":"truthy:string","expr":"\"a\".isTruthy()","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"truthy:zero","expr":"0.isTruthy()","kind":"boolean","text":"false","source":"published"}
{"family":"coercion","case":"truthy:null","expr":"missing.isTruthy()","kind":"boolean","text":"false","source":"published"}
{"family":"coercion","case":"truthy:empty_list","expr":"[].isTruthy()","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"not:empty_string","expr":"!\"\"","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"and:boolean","expr":"1 && \"x\"","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"or:boolean","expr":"0 || \"\"","kind":"boolean","text":"false","source":"published"}
{"family":"coercion","case":"eq:number","expr":"1 == 1.0","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"eq:string_case","expr":"\"a\" == \"A\"","kind":"boolean","text":"false","source":"published"}
{"family":"coercion","case":"eq:null_null","expr":"missing == null","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"eq:number_null","expr":"5 == null","kind":"boolean","text":"false","source":"published"}
{"family":"coercion","case":"ne:number","expr":"1 != 2","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"eq:number:string","expr":"5 == \"5\"","kind":"error","source":"uncaptured"}
{"family":"coercion","case":"eq:boolean:number","expr":"true == 1","kind":"error","source":"uncaptured"}
{"family":"coercion","case":"eq:list:list","expr":"[1] == [1]","kind":"error","source":"uncaptured"}
{"family":"coercion","case":"eq:object:object","expr":"{} == {}","kind":"error","source":"uncaptured"}
{"family":"coercion","case":"cmp:number","expr":"1 < 2","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"cmp:string","expr":"\"apple\" < \"banana\"","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"cmp:string_utf16","expr":"\"Z\" < \"a\"","kind":"boolean","text":"true","source":"published"}
{"family":"coercion","case":"cmp:mixed","expr":"1 < \"2\"","kind":"error","source":"uncaptured"}
{"family":"coercion","case":"add:number","expr":"1 + 2","kind":"number","text":"3","source":"published"}
{"family":"coercion","case":"add:float","expr":"0.1 + 0.2","kind":"number","text":"0.30000000000000004","source":"published"}
{"family":"coercion","case":"add:string","expr":"\"a\" + \"b\"","kind":"string","text":"ab","source":"published"}
{"family":"coercion","case":"add:string_number","expr":"\"a\" + 1","kind":"string","text":"a1","source":"published"}
{"family":"coercion","case":"add:number_string","expr":"1 + \"a\"","kind":"string","text":"1a","source":"published"}
{"family":"coercion","case":"add:string_boolean","expr":"\"is \" + true","kind":"string","text":"is true","source":"published"}
{"family":"coercion","case":"add:string:null","expr":"\"a\" + missing","kind":"error","source":"uncaptured"}
{"family":"coercion","case":"arith:null","expr":"1 + missing","kind":"error","source":"uncaptured"}
{"family":"coercion","case":"sub:number","expr":"5 - 7","kind":"number","text":"-2","source":"published"}
{"family":"coercion","case":"mul:number","expr":"radius * (2 * 3.14)","props":{"radius":2},"kind":"number","text":"12.56","source":"published"}
{"family":"coercion","case":"rem:number","expr":"7 % 3","kind":"number","text":"1","source":"published"}
{"family":"coercion","case":"div:zero","expr":"1 / 0","kind":"error","source":"published"}
{"family":"coercion","case":"rem:zero","expr":"1 % 0","kind":"error","source":"published"}
{"family":"coercion","case":"negate:number","expr":"-(2.5)","kind":"number","text":"-2.5","source":"published"}
{"family":"coercion","case":"number_text:exponent","expr":"(1e21).toString()","kind":"string","text":"1e+21","source":"published"}
{"family":"coercion","case":"number_text:small","expr":"(0.00000015).toString()","kind":"string","text":"1.5e-7","source":"published"}
{"family":"coercion","case":"property:bare","expr":"price","props":{"price":2.5},"kind":"number","text":"2.5","source":"published"}
{"family":"coercion","case":"property:note_prefix","expr":"note.price","props":{"price":2.5},"kind":"number","text":"2.5","source":"published"}
{"family":"coercion","case":"property:note_index","expr":"note[\"my prop\"]","props":{"my prop":"x"},"kind":"string","text":"x","source":"published"}
{"family":"coercion","case":"property:missing","expr":"missing","kind":"null","text":"","source":"published"}
{"family":"coercion","case":"property:object_member","expr":"property.subprop","props":{"property":{"subprop":"s"}},"kind":"string","text":"s","source":"published"}
{"family":"coercion","case":"property:object_index","expr":"property[\"subprop\"]","props":{"property":{"subprop":"s"}},"kind":"string","text":"s","source":"published"}
{"family":"coercion","case":"property:list_index","expr":"property[0]","props":{"property":["a","b"]},"kind":"string","text":"a","source":"published"}
{"family":"coercion","case":"property:list_index_out_of_range","expr":"property[5]","props":{"property":["a"]},"kind":"null","text":"","source":"published"}
{"family":"coercion","case":"index:string","expr":"\"abc\"[0]","kind":"error","source":"uncaptured"}
```

Create `crates/vault-bases/tests/fixtures/captures/global.jsonl`:

```json
{"family":"global","case":"if:true","expr":"if(true, \"a\", \"b\")","kind":"string","text":"a","source":"published"}
{"family":"global","case":"if:falsy_no_else","expr":"if(0, \"a\")","kind":"null","text":"","source":"published"}
{"family":"global","case":"if:published","expr":"if(isModified, \"Modified\", \"Unmodified\")","props":{"isModified":false},"kind":"string","text":"Unmodified","source":"published"}
{"family":"global","case":"if:lazy","expr":"if(true, 1, 1 / 0)","kind":"number","text":"1","source":"published"}
{"family":"global","case":"list:wraps","expr":"list(\"value\")","kind":"list","text":"value","source":"published"}
{"family":"global","case":"list:keeps_list","expr":"list([1, 2])[1]","kind":"number","text":"2","source":"published"}
{"family":"global","case":"number:string","expr":"number(\"3.4\")","kind":"number","text":"3.4","source":"published"}
{"family":"global","case":"number:boolean","expr":"number(true)","kind":"number","text":"1","source":"published"}
{"family":"global","case":"number:invalid","expr":"number(\"abc\")","kind":"error","source":"published"}
{"family":"global","case":"number:empty_string","expr":"number(\"\")","kind":"error","source":"uncaptured"}
{"family":"global","case":"number:null","expr":"number(missing)","kind":"error","source":"uncaptured"}
{"family":"global","case":"max:numbers","expr":"max(1, 5, 3)","kind":"number","text":"5","source":"published"}
{"family":"global","case":"min:numbers","expr":"min(4, -1, 3)","kind":"number","text":"-1","source":"published"}
{"family":"global","case":"max:not_a_number","expr":"max(1, \"a\")","kind":"error","source":"published"}
{"family":"global","case":"random:range","expr":"random() >= 0 && random() < 1","kind":"boolean","text":"true","source":"published"}
{"family":"global","case":"escapeHTML:five","expr":"escapeHTML(\"<a href='x'>&\\\"</a>\")","kind":"string","text":"&lt;a href=&#39;x&#39;&gt;&amp;&quot;&lt;/a&gt;","source":"published"}
{"family":"global","case":"html:kind","expr":"html(\"<b>x</b>\")","kind":"html","text":"<b>x</b>","source":"published"}
{"family":"global","case":"icon:kind","expr":"icon(\"arrow-right\")","kind":"icon","text":"arrow-right","source":"published"}
{"family":"global","case":"image:url","expr":"image(\"https://obsidian.md/images/obsidian-logo-gradient.svg\")","kind":"image","text":"https://obsidian.md/images/obsidian-logo-gradient.svg","source":"published"}
{"family":"global","case":"unknown_function","expr":"frobnicate(1)","kind":"error","source":"published"}
```

`escapeHTML`'s five characters (`& < > " '`) are the published HTML-escaping standard (the HTML specification's text and attribute escaping), which is what "safe for inclusion in HTML" means; the capture confirms Obsidian's exact output for `'`.

Create `crates/vault-bases/tests/fixtures/captures/any.jsonl`:

```json
{"family":"any","case":"isTruthy:published","expr":"1.isTruthy()","kind":"boolean","text":"true","source":"published"}
{"family":"any","case":"isType:string","expr":"\"example\".isType(\"string\")","kind":"boolean","text":"true","source":"published"}
{"family":"any","case":"isType:boolean","expr":"true.isType(\"boolean\")","kind":"boolean","text":"true","source":"published"}
{"family":"any","case":"isType:number_not_string","expr":"5.isType(\"string\")","kind":"boolean","text":"false","source":"published"}
{"family":"any","case":"isType:list","expr":"[1].isType(\"list\")","kind":"boolean","text":"true","source":"published"}
{"family":"any","case":"toString:number","expr":"123.toString()","kind":"string","text":"123","source":"published"}
{"family":"any","case":"toString:list","expr":"[1, \"a\"].toString()","kind":"string","text":"1,a","source":"published"}
{"family":"any","case":"tostring:null","expr":"missing.toString()","kind":"error","source":"uncaptured"}
{"family":"any","case":"no_such_method","expr":"5.frobnicate()","kind":"error","source":"published"}
```

- [ ] **Step 2: Write the failing test**

Create `crates/vault-bases/tests/coercion.rs`:

```rust
use std::cmp::Ordering;

use vault_bases::Value;
use vault_bases::eval::coerce::{compare, number_to_string, parse_js_number, sort_order};
use vault_bases::fixtures::check_family;

fn assert_family(family: &str) {
    let failures = check_family(family);
    assert!(
        failures.is_empty(),
        "{} {family} rows disagree:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn the_coercion_table_holds() {
    assert_family("coercion");
}

#[test]
fn the_global_functions_of_this_task_hold() {
    assert_family("global");
}

#[test]
fn the_any_methods_hold() {
    assert_family("any");
}

#[test]
fn number_to_string_follows_the_ecmascript_algorithm() {
    for (value, text) in [
        (0.0, "0"),
        (-0.0, "0"),
        (3.0, "3"),
        (-2.5, "-2.5"),
        (1e21, "1e+21"),
        (123456789012345680000.0, "123456789012345680000"),
        (1.5e-7, "1.5e-7"),
        (0.000001, "0.000001"),
        (1.0 / 3.0, "0.3333333333333333"),
        (1e-7, "1e-7"),
    ] {
        assert_eq!(number_to_string(value), text, "{value:e}");
    }
}

#[test]
fn only_the_javascript_number_grammar_parses() {
    assert_eq!(parse_js_number(" 3.4 "), Some(3.4));
    assert_eq!(parse_js_number("-1e3"), Some(-1000.0));
    assert_eq!(parse_js_number(".5"), Some(0.5));
    assert_eq!(parse_js_number("0x1F"), Some(31.0));
    for refused in ["NaN", "inf", "Infinity", "1,000", "abc", "1.2.3", ""] {
        assert_eq!(parse_js_number(refused), None, "{refused:?}");
    }
}

#[test]
fn comparison_of_mixed_types_is_uncaptured_but_sort_order_is_total() {
    assert!(compare(&Value::Number(1.0), &Value::String("1".into())).is_err());
    assert_eq!(
        sort_order(&Value::Number(1.0), &Value::String("1".into())),
        Ordering::Less,
        "the provisional rank puts numbers before strings"
    );
    assert_eq!(
        sort_order(&Value::Null, &Value::Number(-1e300)),
        Ordering::Greater,
        "null sorts last"
    );
}
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test coercion; echo "exit=$?"`

Expected: `error[E0432]: unresolved import vault_bases::eval`, `exit=101`.

- [ ] **Step 4: Write the row source and the clock**

Create `crates/vault-bases/src/clock.rs`:

```rust
/// The evaluator's notion of "now" and of local time.
///
/// Obsidian evaluates in the device's local zone (`today()` is local
/// midnight), so the daemon passes [`Clock::system`] and every test passes
/// [`Clock::fixed`] with an explicit IANA zone: a test that read the machine's
/// zone would pass on one desk and fail on another.
#[derive(Clone, Debug)]
pub struct Clock {
    pub now_ms: i64,
    pub zone: jiff::tz::TimeZone,
}

impl Clock {
    pub fn system() -> Self {
        Self {
            now_ms: jiff::Timestamp::now().as_millisecond(),
            zone: jiff::tz::TimeZone::system(),
        }
    }

    /// A clock stopped at `now_ms` in the named zone. Panics on an unknown
    /// zone name: that is a test-authoring error, not an input.
    pub fn fixed(now_ms: i64, zone: &str) -> Self {
        Self {
            now_ms,
            zone: jiff::tz::TimeZone::get(zone)
                .unwrap_or_else(|error| panic!("unknown time zone {zone:?}: {error}")),
        }
    }
}
```

Create `crates/vault-bases/src/source.rs`:

```rust
use std::collections::BTreeMap;

use vault_core::{PropertyValue, SourceSpan, Spanned, VaultPath};

/// What a row is: a Markdown note (it has properties) or any other file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileKind {
    Note,
    File,
}

/// The file facts every row has, notes and attachments alike.
#[derive(Clone, Debug, PartialEq)]
pub struct FileFacts {
    pub path: VaultPath,
    pub kind: FileKind,
    pub size: u64,
    pub ctime_ms: i64,
    pub mtime_ms: i64,
}

/// One outgoing link or embed, as written and as resolved.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkFact {
    pub raw_target: String,
    pub display: Option<String>,
    pub resolved: Option<VaultPath>,
}

/// A property's declared type, from the vault's `.obsidian/types.json`
/// (Obsidian's property type registry). A date-typed property's text becomes a
/// `Date` value; an undeclared property keeps the type YAML gave it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PropertyType {
    Text,
    Number,
    Checkbox,
    Date,
    DateTime,
    List,
    Tags,
    Aliases,
    Unknown,
}

/// A literal a prefilter compares a property against.
#[derive(Clone, Debug, PartialEq)]
pub enum ScalarLiteral {
    String(String),
    Number(f64),
    Boolean(bool),
}

/// A narrowing a row source can serve from an index before any expression
/// runs. Every prefilter is a **superset** of its conjunct: the conjunct still
/// runs on every row the prefilter admits (see `view::compile_view`).
#[derive(Clone, Debug, PartialEq)]
pub enum Prefilter {
    /// `file.inFolder("…")`: the folder or any subfolder.
    InFolder(String),
    /// `file.hasTag("a", "b")`: any of these tags or a nested tag under one.
    HasTag(Vec<String>),
    /// `file.ext == "…"`.
    Ext(String),
    /// `key == literal` on a note property: notes that carry `key` at all.
    PropertyEquals { key: String, value: ScalarLiteral },
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("row source failed: {0}")]
pub struct SourceError(pub String);

/// Everything evaluation needs to know about the vault. The daemon implements
/// it over its index and live graph inside one generation-consistent read; a
/// test implements it over [`MemorySource`]. Nothing in this crate touches a
/// file, a database or a graph except through these nine methods.
pub trait RowSource {
    /// Every file a view may show, in path order, narrowed by `prefilters`
    /// (a conjunction). An empty slice is every file in the vault.
    fn candidates(&self, prefilters: &[Prefilter]) -> Result<Vec<VaultPath>, SourceError>;
    fn facts(&self, path: &VaultPath) -> Result<Option<FileFacts>, SourceError>;
    /// A note's frontmatter properties in document order; empty for a file.
    fn properties(&self, path: &VaultPath) -> Result<Vec<(String, PropertyValue)>, SourceError>;
    /// A note's tags, frontmatter and body, without `#`, as written.
    fn tags(&self, path: &VaultPath) -> Result<Vec<String>, SourceError>;
    /// Outgoing links that are not embeds, body and frontmatter.
    fn links(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError>;
    fn embeds(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError>;
    /// Every file whose links or embeds resolve to `path`, in path order.
    fn backlinks(&self, path: &VaultPath) -> Result<Vec<VaultPath>, SourceError>;
    /// Resolve a link target as written in `from`, by the vault's own rules.
    fn resolve(&self, from: &VaultPath, target: &str) -> Result<Option<VaultPath>, SourceError>;
    fn property_type(&self, key: &str) -> Option<PropertyType>;
}

/// One file in a [`MemorySource`].
#[derive(Clone, Debug)]
pub struct MemoryFile {
    kind: FileKind,
    size: u64,
    ctime_ms: i64,
    mtime_ms: i64,
    properties: Vec<(String, PropertyValue)>,
    tags: Vec<String>,
    links: Vec<String>,
    embeds: Vec<String>,
}

impl MemoryFile {
    pub fn note() -> Self {
        Self {
            kind: FileKind::Note,
            size: 0,
            ctime_ms: 0,
            mtime_ms: 0,
            properties: Vec::new(),
            tags: Vec::new(),
            links: Vec::new(),
            embeds: Vec::new(),
        }
    }

    pub fn attachment(size: u64) -> Self {
        Self {
            kind: FileKind::File,
            size,
            ..Self::note()
        }
    }

    pub fn property(mut self, key: &str, value: PropertyValue) -> Self {
        self.properties.push((key.to_string(), value));
        self
    }

    pub fn tag(mut self, tag: &str) -> Self {
        self.tags.push(tag.trim_start_matches('#').to_string());
        self
    }

    pub fn link(mut self, target: &str) -> Self {
        self.links.push(target.to_string());
        self
    }

    pub fn embed(mut self, target: &str) -> Self {
        self.embeds.push(target.to_string());
        self
    }

    pub fn times(mut self, ctime_ms: i64, mtime_ms: i64) -> Self {
        self.ctime_ms = ctime_ms;
        self.mtime_ms = mtime_ms;
        self
    }

    pub fn size(mut self, size: u64) -> Self {
        self.size = size;
        self
    }
}

/// An in-memory vault for tests: no I/O, resolution by exact path, path plus
/// `.md`, or a unique case-insensitive file name or stem — the same three
/// stages `vault_core::Resolver` uses, enough to make link tests meaningful.
#[derive(Clone, Debug, Default)]
pub struct MemorySource {
    files: BTreeMap<VaultPath, MemoryFile>,
    types: BTreeMap<String, PropertyType>,
}

/// A text property value with an empty span — the span is never read by
/// evaluation.
pub fn text(value: &str) -> PropertyValue {
    PropertyValue::String(value.to_string())
}

pub fn number(value: f64) -> PropertyValue {
    PropertyValue::Float(value)
}

/// An empty span, for building spanned values by hand.
pub fn no_span<T>(value: T) -> Spanned<T> {
    Spanned::new(value, SourceSpan::new(0, 0).expect("an empty span is ordered"))
}

fn vault_path(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap_or_else(|error| panic!("{path:?}: {error}"))
}

impl MemorySource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, path: &str, file: MemoryFile) -> Self {
        self.files.insert(vault_path(path), file);
        self
    }

    pub fn typed(mut self, key: &str, kind: PropertyType) -> Self {
        self.types.insert(key.to_string(), kind);
        self
    }

    fn file(&self, path: &VaultPath) -> Option<&MemoryFile> {
        self.files.get(path)
    }

    fn lookup(&self, target: &str) -> Option<VaultPath> {
        let file_part = target
            .trim_start_matches("[[")
            .trim_end_matches("]]")
            .split(['#', '|'])
            .next()
            .unwrap_or_default();
        for spelling in [file_part.to_string(), format!("{file_part}.md")] {
            if let Ok(path) = VaultPath::new(spelling) {
                if self.files.contains_key(&path) {
                    return Some(path);
                }
            }
        }
        let wanted = file_part.to_lowercase();
        let mut matches = self.files.keys().filter(|path| {
            let name = path.name().to_lowercase();
            name == wanted || name.strip_suffix(".md") == Some(wanted.as_str())
        });
        let first = matches.next()?.clone();
        matches.next().is_none().then_some(first)
    }

    fn admits(&self, path: &VaultPath, file: &MemoryFile, prefilter: &Prefilter) -> bool {
        match prefilter {
            Prefilter::InFolder(folder) => {
                let folder = folder.trim_end_matches('/');
                folder.is_empty() || path.as_str().starts_with(&format!("{folder}/"))
            }
            Prefilter::HasTag(tags) => file.tags.iter().any(|have| {
                let have = have.to_lowercase();
                tags.iter().any(|want| {
                    let want = want.trim_start_matches('#').to_lowercase();
                    have == want || have.starts_with(&format!("{want}/"))
                })
            }),
            Prefilter::Ext(ext) => crate::source::extension(path) == ext.as_str(),
            Prefilter::PropertyEquals { key, .. } => {
                file.properties.iter().any(|(have, _)| have == key)
            }
        }
    }
}

/// A path's extension without the dot, `""` when it has none — the same
/// definition `file.ext` uses.
pub fn extension(path: &VaultPath) -> &str {
    let name = path.name();
    match name.rfind('.') {
        Some(0) | None => "",
        Some(dot) => &name[dot + 1..],
    }
}

impl RowSource for MemorySource {
    fn candidates(&self, prefilters: &[Prefilter]) -> Result<Vec<VaultPath>, SourceError> {
        Ok(self
            .files
            .iter()
            .filter(|(path, file)| prefilters.iter().all(|p| self.admits(path, file, p)))
            .map(|(path, _)| path.clone())
            .collect())
    }

    fn facts(&self, path: &VaultPath) -> Result<Option<FileFacts>, SourceError> {
        Ok(self.file(path).map(|file| FileFacts {
            path: path.clone(),
            kind: file.kind,
            size: file.size,
            ctime_ms: file.ctime_ms,
            mtime_ms: file.mtime_ms,
        }))
    }

    fn properties(&self, path: &VaultPath) -> Result<Vec<(String, PropertyValue)>, SourceError> {
        Ok(self.file(path).map(|file| file.properties.clone()).unwrap_or_default())
    }

    fn tags(&self, path: &VaultPath) -> Result<Vec<String>, SourceError> {
        Ok(self.file(path).map(|file| file.tags.clone()).unwrap_or_default())
    }

    fn links(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError> {
        Ok(self
            .file(path)
            .map(|file| {
                file.links
                    .iter()
                    .map(|target| LinkFact {
                        raw_target: target.clone(),
                        display: None,
                        resolved: self.lookup(target),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn embeds(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError> {
        Ok(self
            .file(path)
            .map(|file| {
                file.embeds
                    .iter()
                    .map(|target| LinkFact {
                        raw_target: target.clone(),
                        display: None,
                        resolved: self.lookup(target),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn backlinks(&self, path: &VaultPath) -> Result<Vec<VaultPath>, SourceError> {
        Ok(self
            .files
            .iter()
            .filter(|(_, file)| {
                file.links
                    .iter()
                    .chain(file.embeds.iter())
                    .any(|target| self.lookup(target).as_ref() == Some(path))
            })
            .map(|(source, _)| source.clone())
            .collect())
    }

    fn resolve(&self, _from: &VaultPath, target: &str) -> Result<Option<VaultPath>, SourceError> {
        Ok(self.lookup(target))
    }

    fn property_type(&self, key: &str) -> Option<PropertyType> {
        self.types.get(key).copied()
    }
}
```

- [ ] **Step 5: Write coercion**

Create `crates/vault-bases/src/eval/coerce.rs`:

```rust
//! The value semantics every operator and function leans on.
//!
//! The functions page says "Bases functions follow JavaScript behavior", so
//! where a JavaScript rule answers the question (truthiness of primitives,
//! number-to-string, string concatenation, UTF-16 string comparison) it is
//! followed and cited. Where no published rule answers it (`5 == "5"`, the
//! order of a number against a string) the answer is
//! [`EvalError::Uncaptured`] naming the case, until a runtime capture fixes
//! it (Task 13 of the implementation plan).

use std::cmp::Ordering;

use crate::eval::EvalError;
use crate::value::{LinkValue, Value};

/// JavaScript truthiness: `null`, `false`, `0`, `NaN` and `""` are falsy;
/// every other primitive is truthy, and every object (a list, an object, a
/// date, a link, a file) is truthy.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Boolean(flag) => *flag,
        Value::Number(number) => *number != 0.0 && !number.is_nan(),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn case(prefix: &str, left: &Value, right: &Value) -> EvalError {
    let (a, b) = if left.type_name() <= right.type_name() {
        (left.type_name(), right.type_name())
    } else {
        (right.type_name(), left.type_name())
    };
    EvalError::Uncaptured(format!("{prefix}:{a}:{b}"))
}

/// The syntax page: links "are equivalent as long as they point to the same
/// file, or if the file does not exist when looked up, their link text must be
/// identical."
fn link_equals(left: &LinkValue, right: &LinkValue) -> bool {
    match (&left.resolved, &right.resolved) {
        (Some(a), Some(b)) => a == b,
        _ => left.target == right.target,
    }
}

/// `==`. Same-type values compare by value; `null` equals only `null` (the
/// published `reduce` example relies on `acc == null` being true for the
/// initial `null` and false for a number); a link equals a file it resolves to
/// (the syntax page: `author == this`). Every other pairing is uncaptured.
pub fn loose_equals(left: &Value, right: &Value) -> Result<bool, EvalError> {
    use Value::*;
    Ok(match (left, right) {
        (Null, Null) => true,
        (Null, _) | (_, Null) => false,
        (Number(a), Number(b)) => a == b,
        (String(a), String(b)) => a == b,
        (Boolean(a), Boolean(b)) => a == b,
        (Date(a), Date(b)) => a.epoch_ms == b.epoch_ms,
        (Duration(a), Duration(b)) => a == b,
        (Link(a), Link(b)) => link_equals(a, b),
        (Link(link), File(path)) | (File(path), Link(link)) => link.resolved.as_ref() == Some(path),
        (File(a), File(b)) => a == b,
        (Image(a), Image(b)) | (Icon(a), Icon(b)) | (Html(a), Html(b)) => a == b,
        (Regexp(a), Regexp(b)) => a == b,
        // `case` sorts the two kind names, so `5 == "5"` and `"5" == 5` are
        // both `eq:number:string`.
        _ => return Err(case("eq", left, right)),
    })
}

/// JavaScript compares strings by UTF-16 code unit, which is why `"Z" < "a"`.
fn utf16_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `<`, `<=`, `>`, `>=`: numbers, strings, dates, durations without months,
/// and booleans (`false < true`). Every other pairing is uncaptured.
pub fn compare(left: &Value, right: &Value) -> Result<Ordering, EvalError> {
    use Value::*;
    match (left, right) {
        (Number(a), Number(b)) => a
            .partial_cmp(b)
            .ok_or_else(|| EvalError::Type("cannot compare NaN".into())),
        (String(a), String(b)) => Ok(utf16_order(a, b)),
        (Date(a), Date(b)) => Ok(a.epoch_ms.cmp(&b.epoch_ms)),
        (Duration(a), Duration(b)) if a.months == 0 && b.months == 0 => Ok(a.ms.cmp(&b.ms)),
        (Boolean(a), Boolean(b)) => Ok(a.cmp(b)),
        _ => Err(EvalError::Uncaptured("cmp:mixed".into())),
    }
}

/// The provisional order of value kinds when a sort meets two different
/// kinds. **Not evidence**: it exists so `sort` is total and deterministic
/// (the spec's property tests demand transitivity) until the `sort:mixed`
/// capture fixes Obsidian's real order; `null` is last because an empty cell
/// sorting after every value is the one placement the views page implies
/// ("sort … by any property"). Task 13 replaces this table.
pub const MIXED_TYPE_RANK: [&str; 14] = [
    "number", "date", "string", "boolean", "duration", "link", "file", "list", "object",
    "regexp", "image", "icon", "html", "null",
];

fn rank(value: &Value) -> usize {
    MIXED_TYPE_RANK
        .iter()
        .position(|name| *name == value.type_name())
        .expect("every type name is ranked")
}

/// A total order for `sort`: same-kind values by [`compare`] (falling back to
/// equal where that is uncaptured, so a stable sort keeps their input order),
/// different kinds by [`MIXED_TYPE_RANK`].
pub fn sort_order(left: &Value, right: &Value) -> Ordering {
    let by_rank = rank(left).cmp(&rank(right));
    if by_rank != Ordering::Equal {
        return by_rank;
    }
    match (left, right) {
        (Value::Link(a), Value::Link(b)) => utf16_order(&a.target, &b.target),
        (Value::File(a), Value::File(b)) => utf16_order(a.as_str(), b.as_str()),
        (Value::Duration(a), Value::Duration(b)) => (a.months, a.ms).cmp(&(b.months, b.ms)),
        _ => compare(left, right).unwrap_or(Ordering::Equal),
    }
}

/// ECMAScript `Number::toString` (ECMA-262 §6.1.6.1.20), over Rust's shortest
/// round-trip digits, which are the digits that algorithm specifies.
pub fn number_to_string(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("LowerExp always writes an exponent");
    let exponent: i32 = exponent.parse().expect("an integer exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    if value < 0.0 { format!("-{body}") } else { body }
}

/// JavaScript's `StringToNumber` grammar, minus `Infinity` (a cell cannot
/// hold a non-finite number) and minus the empty string (JavaScript says 0;
/// whether Bases does is the uncaptured `number:empty_string`).
pub fn parse_js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok().map(|value| value as f64);
    }
    let unsigned = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let mantissa_ok = {
        let mut parts = mantissa.splitn(2, '.');
        let whole = parts.next().unwrap_or_default();
        let fraction = parts.next();
        whole.chars().all(|c| c.is_ascii_digit())
            && fraction.is_none_or(|f| f.chars().all(|c| c.is_ascii_digit()))
            && !(whole.is_empty() && fraction.is_none_or(str::is_empty))
    };
    let exponent_ok = exponent.is_none_or(|e| {
        let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
        !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
    });
    if !mantissa_ok || !exponent_ok {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// JavaScript `ToString`, for concatenation and `toString()`, on the kinds
/// where that is the published rule. Dates, links, files, objects and null
/// are uncaptured: JavaScript's answers there (`"[object Object]"`, a long
/// `Date` string) are not what a Bases cell shows.
pub fn to_display_string(value: &Value) -> Result<String, EvalError> {
    Ok(match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number_to_string(*number),
        Value::Boolean(flag) => flag.to_string(),
        Value::List(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => Ok(String::new()),
                other => to_display_string(other),
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(","),
        Value::Icon(name) | Value::Image(name) | Value::Html(name) => name.clone(),
        Value::Regexp(regexp) => format!("/{}/{}", regexp.source, regexp.flags),
        other => return Err(EvalError::Uncaptured(format!("tostring:{}", other.type_name()))),
    })
}
```

`Option::is_none_or` is stable since Rust 1.82, inside the 1.85 floor.

- [ ] **Step 6: Write the evaluator**

Create `crates/vault-bases/src/eval/mod.rs`:

```rust
//! The tree walker.
//!
//! One call evaluates one expression for one row. Errors are values the
//! caller decides about: a filter treats an error as "row excluded" only
//! where Task 7's capture says so, and a cell renders it as an error cell —
//! never a dropped row (the spec's error-handling section).

pub mod coerce;

use std::cell::Cell;

use vault_core::{PropertyValue, VaultPath};

use crate::clock::Clock;
use crate::expr::{BinaryOp, Expr, UnaryOp};
use crate::functions;
use crate::source::{RowSource, SourceError};
use crate::value::{RegexpValue, Value};

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum EvalError {
    #[error("{0}")]
    Type(String),
    #[error("division by zero")]
    DivisionByZero,
    #[error("unknown function {0}")]
    UnknownFunction(String),
    #[error("{target} has no method {name}")]
    NoSuchMethod { target: &'static str, name: String },
    #[error("{target} has no field {name}")]
    NoSuchField { target: &'static str, name: String },
    #[error("no formula named {0}")]
    UnknownFormula(String),
    #[error("formula cycle through {0}")]
    FormulaCycle(String),
    #[error("{0} is not captured yet")]
    Uncaptured(String),
    #[error("unsupported format token {0}")]
    UnsupportedFormatToken(String),
    #[error("{0}")]
    Argument(String),
    #[error(transparent)]
    Source(#[from] SourceError),
}

/// How `formula.x` is answered. A view supplies a memoizing table (Task 7);
/// a bare expression has none.
pub trait Formulas {
    fn formula(&self, name: &str, ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError>;
}

/// The answer when there is no formula table.
pub struct NoFormulas;

impl Formulas for NoFormulas {
    fn formula(&self, name: &str, _: &EvalContext<'_>, _: &Scope) -> Result<Value, EvalError> {
        Err(EvalError::UnknownFormula(name.to_string()))
    }
}

/// Everything constant across one evaluation of a view.
pub struct EvalContext<'a> {
    pub source: &'a dyn RowSource,
    pub clock: &'a Clock,
    pub base_path: &'a VaultPath,
    /// The embedding note, or the base itself when nothing embeds it.
    pub this_path: &'a VaultPath,
    pub formulas: &'a dyn Formulas,
    random_state: Cell<u64>,
}

impl<'a> EvalContext<'a> {
    pub fn new(
        source: &'a dyn RowSource,
        clock: &'a Clock,
        base_path: &'a VaultPath,
        this_path: &'a VaultPath,
    ) -> Self {
        Self {
            source,
            clock,
            base_path,
            this_path,
            formulas: &NoFormulas,
            // Any non-zero seed; xorshift never leaves zero once off it.
            random_state: Cell::new((clock.now_ms as u64) | 1),
        }
    }

    pub fn with_formulas(mut self, formulas: &'a dyn Formulas) -> Self {
        self.formulas = formulas;
        self
    }

    /// A number in `[0, 1)`. The functions page: "The number generation
    /// refreshes whenever a view is loaded" — so it is seeded per evaluation,
    /// and determinism across clients is a non-goal (the spec).
    pub(crate) fn next_random(&self) -> f64 {
        let mut x = self.random_state.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.random_state.set(x);
        (x >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The names in scope for one evaluation: the row being evaluated (absent
/// for a summary over `values`) and the lambda locals a list method binds.
#[derive(Clone, Debug, Default)]
pub struct Scope {
    pub row: Option<VaultPath>,
    pub locals: Vec<(String, Value)>,
}

impl Scope {
    pub fn row(path: &VaultPath) -> Self {
        Self {
            row: Some(path.clone()),
            locals: Vec::new(),
        }
    }

    /// This scope plus one more local, shadowing an outer one of that name.
    pub fn bind(&self, name: &str, value: Value) -> Self {
        let mut next = self.clone();
        next.locals.retain(|(have, _)| have != name);
        next.locals.push((name.to_string(), value));
        next
    }

    fn local(&self, name: &str) -> Option<&Value> {
        self.locals.iter().rev().find(|(have, _)| have == name).map(|(_, value)| value)
    }
}

/// A YAML property value as a Bases value. A declared date type is applied
/// by `functions::date::typed_property` (Task 5); links in frontmatter by
/// `functions::link::frontmatter_links` (Task 6). Here: the YAML types.
pub(crate) fn property_value(value: &PropertyValue) -> Value {
    match value {
        PropertyValue::Null => Value::Null,
        PropertyValue::Boolean(flag) => Value::Boolean(*flag),
        PropertyValue::Integer(number) => Value::Number(*number as f64),
        PropertyValue::Float(number) => Value::Number(*number),
        PropertyValue::String(text) => Value::String(text.clone()),
        PropertyValue::Sequence(items) => {
            Value::List(items.iter().map(|item| property_value(&item.value)).collect())
        }
        PropertyValue::Mapping(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, value)| (key.value.clone(), property_value(&value.value)))
                .collect(),
        ),
    }
}

/// A note property of the current row, by exact key. Missing is `null`.
pub(crate) fn row_property(
    ctx: &EvalContext<'_>,
    scope: &Scope,
    key: &str,
) -> Result<Value, EvalError> {
    let Some(row) = &scope.row else {
        return Ok(Value::Null);
    };
    let properties = ctx.source.properties(row)?;
    Ok(properties
        .iter()
        .find(|(have, _)| have == key)
        .map(|(_, value)| functions::typed_property(ctx, key, value))
        .unwrap_or(Value::Null))
}

fn row_file(scope: &Scope) -> Result<Value, EvalError> {
    scope
        .row
        .clone()
        .map(Value::File)
        .ok_or_else(|| EvalError::Type("`file` has no row here".into()))
}

fn arithmetic(op: BinaryOp, left: Value, right: Value, ctx: &EvalContext<'_>) -> Result<Value, EvalError> {
    if let Some(value) = functions::date_arithmetic(op, &left, &right, ctx)? {
        return Ok(value);
    }
    let finite = |number: f64| {
        if number.is_finite() {
            Ok(Value::Number(number))
        } else {
            Err(EvalError::Type("the result is not a finite number".into()))
        }
    };
    match (op, &left, &right) {
        (BinaryOp::Add, Value::Number(a), Value::Number(b)) => finite(a + b),
        (BinaryOp::Sub, Value::Number(a), Value::Number(b)) => finite(a - b),
        (BinaryOp::Mul, Value::Number(a), Value::Number(b)) => finite(a * b),
        (BinaryOp::Div, Value::Number(_), Value::Number(b)) if *b == 0.0 => Err(EvalError::DivisionByZero),
        (BinaryOp::Rem, Value::Number(_), Value::Number(b)) if *b == 0.0 => Err(EvalError::DivisionByZero),
        (BinaryOp::Div, Value::Number(a), Value::Number(b)) => finite(a / b),
        (BinaryOp::Rem, Value::Number(a), Value::Number(b)) => finite(a % b),
        (BinaryOp::Add, Value::String(_), Value::Null) | (BinaryOp::Add, Value::Null, Value::String(_)) => {
            Err(EvalError::Uncaptured("add:string:null".into()))
        }
        (BinaryOp::Add, Value::String(_), _) | (BinaryOp::Add, _, Value::String(_)) => Ok(Value::String(
            coerce::to_display_string(&left)? + &coerce::to_display_string(&right)?,
        )),
        (_, Value::Null, _) | (_, _, Value::Null) => Err(EvalError::Uncaptured("arith:null".into())),
        _ => Err(EvalError::Type(format!(
            "cannot apply {op:?} to {} and {}",
            left.type_name(),
            right.type_name()
        ))),
    }
}

/// Compile a regular expression literal. The `regex` crate has no
/// look-around and no back-references; a pattern that needs them is an
/// argument error naming the pattern, never a silently different match.
pub(crate) fn compile_regexp(source: &str, flags: &str) -> Result<RegexpValue, EvalError> {
    let mut builder = regex::RegexBuilder::new(source);
    for flag in flags.chars() {
        match flag {
            'i' => {
                builder.case_insensitive(true);
            }
            'm' => {
                builder.multi_line(true);
            }
            's' => {
                builder.dot_matches_new_line(true);
            }
            'g' | 'u' | 'y' | 'd' => {}
            other => return Err(EvalError::Argument(format!("unknown regular expression flag {other:?}"))),
        }
    }
    let regex = builder
        .build()
        .map_err(|error| EvalError::Argument(format!("unsupported regular expression /{source}/: {error}")))?;
    Ok(RegexpValue {
        source: source.to_string(),
        flags: flags.to_string(),
        regex: std::sync::Arc::new(regex),
    })
}

/// Evaluate `expr` for one row.
pub fn evaluate(expr: &Expr, ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    match expr {
        Expr::Null => Ok(Value::Null),
        Expr::Boolean(flag) => Ok(Value::Boolean(*flag)),
        Expr::Number(number) => Ok(Value::Number(*number)),
        Expr::String(text) => Ok(Value::String(text.clone())),
        Expr::Regexp { source, flags } => compile_regexp(source, flags).map(Value::Regexp),
        Expr::List(items) => Ok(Value::List(
            items.iter().map(|item| evaluate(item, ctx, scope)).collect::<Result<_, _>>()?,
        )),
        Expr::Object(entries) => Ok(Value::Object(
            entries
                .iter()
                .map(|(key, value)| Ok((key.clone(), evaluate(value, ctx, scope)?)))
                .collect::<Result<_, EvalError>>()?,
        )),
        Expr::Identifier(name) => {
            if let Some(value) = scope.local(name) {
                return Ok(value.clone());
            }
            match name.as_str() {
                "this" => Ok(Value::File(ctx.this_path.clone())),
                "file" => row_file(scope),
                "note" => {
                    let Some(row) = &scope.row else {
                        return Ok(Value::Null);
                    };
                    Ok(Value::Object(
                        ctx.source
                            .properties(row)?
                            .iter()
                            .map(|(key, value)| (key.clone(), functions::typed_property(ctx, key, value)))
                            .collect(),
                    ))
                }
                _ => row_property(ctx, scope, name),
            }
        }
        Expr::Member { target, name } => {
            if let Expr::Identifier(root) = target.as_ref() {
                if scope.local(root).is_none() {
                    match root.as_str() {
                        "note" => return row_property(ctx, scope, name),
                        "formula" => return ctx.formulas.formula(name, ctx, scope),
                        _ => {}
                    }
                }
            }
            let value = evaluate(target, ctx, scope)?;
            match value {
                Value::Object(entries) => Ok(entries
                    .into_iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value)
                    .unwrap_or(Value::Null)),
                other => functions::field(&other, name, ctx),
            }
        }
        Expr::Index { target, index } => {
            if let (Expr::Identifier(root), Expr::String(key)) = (target.as_ref(), index.as_ref()) {
                if root == "note" && scope.local(root).is_none() {
                    return row_property(ctx, scope, key);
                }
            }
            let value = evaluate(target, ctx, scope)?;
            let index = evaluate(index, ctx, scope)?;
            match (value, index) {
                (Value::List(items), Value::Number(at)) => Ok(if at >= 0.0 && at.fract() == 0.0 {
                    items.get(at as usize).cloned().unwrap_or(Value::Null)
                } else {
                    Value::Null
                }),
                (Value::Object(entries), Value::String(key)) => Ok(entries
                    .into_iter()
                    .find(|(have, _)| *have == key)
                    .map(|(_, value)| value)
                    .unwrap_or(Value::Null)),
                (Value::Null, _) => Ok(Value::Null),
                (Value::String(_), _) => Err(EvalError::Uncaptured("index:string".into())),
                (target, index) => Err(EvalError::Type(format!(
                    "cannot index {} with {}",
                    target.type_name(),
                    index.type_name()
                ))),
            }
        }
        Expr::Call { name, args, .. } => functions::call_global(name, args, ctx, scope),
        Expr::Method { target, name, args, .. } => {
            let value = evaluate(target, ctx, scope)?;
            functions::call_method(value, name, args, ctx, scope)
        }
        Expr::Unary { op, operand } => {
            let value = evaluate(operand, ctx, scope)?;
            match op {
                UnaryOp::Not => Ok(Value::Boolean(!coerce::truthy(&value))),
                UnaryOp::Negate => match value {
                    Value::Number(number) => Ok(Value::Number(-number)),
                    other => Err(EvalError::Type(format!("cannot negate {}", other.type_name()))),
                },
            }
        }
        Expr::Binary { op, left, right } => match op {
            // The syntax page: boolean operators result "in a true or false
            // value" — so these return booleans, not JavaScript's operands,
            // and short-circuit.
            BinaryOp::And => {
                let left = evaluate(left, ctx, scope)?;
                if !coerce::truthy(&left) {
                    return Ok(Value::Boolean(false));
                }
                Ok(Value::Boolean(coerce::truthy(&evaluate(right, ctx, scope)?)))
            }
            BinaryOp::Or => {
                let left = evaluate(left, ctx, scope)?;
                if coerce::truthy(&left) {
                    return Ok(Value::Boolean(true));
                }
                Ok(Value::Boolean(coerce::truthy(&evaluate(right, ctx, scope)?)))
            }
            BinaryOp::Eq | BinaryOp::Ne => {
                let equal = coerce::loose_equals(&evaluate(left, ctx, scope)?, &evaluate(right, ctx, scope)?)?;
                Ok(Value::Boolean(if *op == BinaryOp::Eq { equal } else { !equal }))
            }
            BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
                let ordering = coerce::compare(&evaluate(left, ctx, scope)?, &evaluate(right, ctx, scope)?)?;
                Ok(Value::Boolean(match op {
                    BinaryOp::Lt => ordering.is_lt(),
                    BinaryOp::Le => ordering.is_le(),
                    BinaryOp::Gt => ordering.is_gt(),
                    _ => ordering.is_ge(),
                }))
            }
            _ => arithmetic(*op, evaluate(left, ctx, scope)?, evaluate(right, ctx, scope)?, ctx),
        },
    }
}
```

`compare` of a date against a date works here already; a date against a duration string (`file.mtime > now() - "1 week"`) works once Task 5's `date_arithmetic` turns the right side into a date.

- [ ] **Step 7: Write the function dispatch, the global functions of this task, and the `any` methods**

Create `crates/vault-bases/src/functions/mod.rs`:

```rust
//! Dispatch from a name to a function family.
//!
//! Each family module exports `GLOBALS` (the global functions it owns),
//! `METHODS` and `FIELDS` (by receiver type), so [`is_known_global`] and
//! [`is_known_method`] are the union of what is implemented — the compile
//! step (Task 7) answers `unsupported_function` for anything outside it.

mod any;
mod global;

use vault_core::PropertyValue;

use crate::eval::{EvalContext, EvalError, Scope, property_value};
use crate::expr::{BinaryOp, Expr};
use crate::value::Value;

/// A property value with its declared type applied. Task 5 adds dates and
/// Task 6 adds frontmatter links; until then, the YAML type.
pub(crate) fn typed_property(_ctx: &EvalContext<'_>, _key: &str, value: &PropertyValue) -> Value {
    property_value(value)
}

/// Date and duration arithmetic, when either side is a date or a duration.
/// `Ok(None)` hands the operation back to plain arithmetic. Task 5 fills it.
pub(crate) fn date_arithmetic(
    _op: BinaryOp,
    _left: &Value,
    _right: &Value,
    _ctx: &EvalContext<'_>,
) -> Result<Option<Value>, EvalError> {
    Ok(None)
}

pub(crate) fn call_global(
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    if global::GLOBALS.contains(&name) {
        return global::call(name, args, ctx, scope);
    }
    Err(EvalError::UnknownFunction(name.to_string()))
}

pub(crate) fn call_method(
    target: Value,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    if any::METHODS.contains(&name) {
        return any::call(&target, name, args, ctx, scope);
    }
    Err(EvalError::NoSuchMethod {
        target: target.type_name(),
        name: name.to_string(),
    })
}

pub(crate) fn field(target: &Value, name: &str, _ctx: &EvalContext<'_>) -> Result<Value, EvalError> {
    match target {
        Value::Null => Ok(Value::Null),
        other => Err(EvalError::NoSuchField {
            target: other.type_name(),
            name: name.to_string(),
        }),
    }
}

pub fn is_known_global(name: &str) -> bool {
    global::GLOBALS.contains(&name)
}

pub fn is_known_method(name: &str) -> bool {
    any::METHODS.contains(&name)
}

/// Evaluate every argument eagerly — the default for every function except
/// the lazy ones (`if`, and the list methods that bind `value`).
pub(crate) fn eager(args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Vec<Value>, EvalError> {
    args.iter().map(|arg| crate::eval::evaluate(arg, ctx, scope)).collect()
}

pub(crate) fn arity(name: &str, args: &[Expr], least: usize, most: usize) -> Result<(), EvalError> {
    if args.len() < least || args.len() > most {
        return Err(EvalError::Argument(format!(
            "{name} takes {least}{} arguments, not {}",
            if most == least { String::new() } else if most == usize::MAX { " or more".into() } else { format!(" to {most}") },
            args.len()
        )));
    }
    Ok(())
}
```

Create `crates/vault-bases/src/functions/global.rs`:

```rust
use crate::eval::coerce::{parse_js_number, truthy};
use crate::eval::{EvalContext, EvalError, Scope, evaluate};
use crate::expr::Expr;
use crate::value::Value;

use super::{arity, eager};

pub(crate) const GLOBALS: &[&str] = &[
    "if", "list", "number", "max", "min", "random", "escapeHTML", "html", "icon", "image",
];

fn one_string(name: &str, values: &[Value]) -> Result<String, EvalError> {
    match values {
        [Value::String(text)] => Ok(text.clone()),
        [Value::File(path)] => Ok(path.as_str().to_string()),
        _ => Err(EvalError::Argument(format!("{name} takes one string"))),
    }
}

fn numbers(name: &str, values: Vec<Value>) -> Result<Vec<f64>, EvalError> {
    if values.is_empty() {
        return Err(EvalError::Argument(format!("{name} needs at least one number")));
    }
    values
        .into_iter()
        .map(|value| match value {
            Value::Number(number) => Ok(number),
            other => Err(EvalError::Argument(format!("{name} takes numbers, not {}", other.type_name()))),
        })
        .collect()
}

pub(crate) fn call(name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    match name {
        // Lazy: only the chosen branch is evaluated, so
        // `if(true, 1, 1 / 0)` is 1, not an error.
        "if" => {
            arity(name, args, 2, 3)?;
            if truthy(&evaluate(&args[0], ctx, scope)?) {
                evaluate(&args[1], ctx, scope)
            } else {
                match args.get(2) {
                    Some(otherwise) => evaluate(otherwise, ctx, scope),
                    None => Ok(Value::Null),
                }
            }
        }
        "list" => {
            arity(name, args, 1, 1)?;
            Ok(match evaluate(&args[0], ctx, scope)? {
                list @ Value::List(_) => list,
                other => Value::List(vec![other]),
            })
        }
        "number" => {
            arity(name, args, 1, 1)?;
            match evaluate(&args[0], ctx, scope)? {
                Value::Number(number) => Ok(Value::Number(number)),
                Value::Boolean(flag) => Ok(Value::Number(if flag { 1.0 } else { 0.0 })),
                Value::Date(date) => Ok(Value::Number(date.epoch_ms as f64)),
                Value::String(text) if text.trim().is_empty() => {
                    Err(EvalError::Uncaptured("number:empty_string".into()))
                }
                Value::String(text) => parse_js_number(&text)
                    .map(Value::Number)
                    .ok_or_else(|| EvalError::Argument(format!("{text:?} is not a number"))),
                Value::Null => Err(EvalError::Uncaptured("number:null".into())),
                other => Err(EvalError::Argument(format!("number cannot convert {}", other.type_name()))),
            }
        }
        "max" | "min" => {
            let values = numbers(name, eager(args, ctx, scope)?)?;
            let pick = if name == "max" { f64::max } else { f64::min };
            Ok(Value::Number(values.into_iter().reduce(pick).expect("at least one number")))
        }
        "random" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Number(ctx.next_random()))
        }
        "escapeHTML" => {
            let text = one_string(name, &eager(args, ctx, scope)?)?;
            let mut escaped = String::with_capacity(text.len());
            for c in text.chars() {
                match c {
                    '&' => escaped.push_str("&amp;"),
                    '<' => escaped.push_str("&lt;"),
                    '>' => escaped.push_str("&gt;"),
                    '"' => escaped.push_str("&quot;"),
                    '\'' => escaped.push_str("&#39;"),
                    other => escaped.push(other),
                }
            }
            Ok(Value::String(escaped))
        }
        "html" => Ok(Value::Html(one_string(name, &eager(args, ctx, scope)?)?)),
        "icon" => Ok(Value::Icon(one_string(name, &eager(args, ctx, scope)?)?)),
        "image" => Ok(Value::Image(one_string(name, &eager(args, ctx, scope)?)?)),
        _ => Err(EvalError::UnknownFunction(name.to_string())),
    }
}
```

Create `crates/vault-bases/src/functions/any.rs`:

```rust
use crate::eval::coerce::{to_display_string, truthy};
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::Value;

use super::{arity, eager};

/// Methods every value has. `isEmpty` is per type (string, number, date,
/// list, object) and lives with those families.
pub(crate) const METHODS: &[&str] = &["isTruthy", "isType", "toString"];

pub(crate) fn call(
    target: &Value,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    match name {
        "isTruthy" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Boolean(truthy(target)))
        }
        "isType" => {
            let wanted = match eager(args, ctx, scope)?.as_slice() {
                [Value::String(wanted)] => wanted.clone(),
                _ => return Err(EvalError::Argument("isType takes one type name".into())),
            };
            Ok(Value::Boolean(target.type_name() == wanted))
        }
        "toString" => {
            arity(name, args, 0, 0)?;
            if matches!(target, Value::Null) {
                return Err(EvalError::Uncaptured("tostring:null".into()));
            }
            Ok(Value::String(to_display_string(target)?))
        }
        _ => Err(EvalError::NoSuchMethod {
            target: target.type_name(),
            name: name.to_string(),
        }),
    }
}
```

`list:keeps_list` reads index 1 because a wrapped list (`[[1, 2]]`) has no element there, so the row tells "returned unmodified" apart from "wrapped". The published `if(price, price.toFixed(2) + " dollars")` example needs `toFixed`, so it is pinned in Task 4's `number.jsonl`, not here.

- [ ] **Step 8: Write the fixture support**

Create `crates/vault-bases/src/fixtures.rs`:

```rust
//! Capture fixtures: one JSON line per case, compared against the evaluator.
//!
//! Compiled only with the `fixtures` feature (the crate's own tests and
//! `vault-server`'s replay suite turn it on). A row is `published` (a
//! published page or standard fixes it), `uncaptured` (no published rule;
//! the evaluator must answer an error naming the case), or `captured` (Task
//! 13 recorded Obsidian's answer).

use std::path::PathBuf;

use serde_json::Value as Json;
use vault_core::{PropertyValue, VaultPath};

use crate::clock::Clock;
use crate::eval::coerce::number_to_string;
use crate::eval::{EvalContext, Scope, evaluate};
use crate::expr::parse_expression;
use crate::source::{MemoryFile, MemorySource, no_span};
use crate::value::Value;

/// 2026-01-15T10:30:00-05:00: a Thursday, mid-month, outside DST, so a
/// fixture's weekday, month and offset are all unambiguous.
pub const FIXTURE_NOW_MS: i64 = 1_768_491_000_000;
pub const FIXTURE_ZONE: &str = "America/New_York";

#[derive(Clone, Debug)]
pub struct CaptureRow {
    pub family: String,
    pub case: String,
    pub expr: String,
    pub kind: String,
    pub text: Option<String>,
    pub source: String,
    pub props: Vec<(String, PropertyValue)>,
    pub now_ms: Option<i64>,
    pub zone: Option<String>,
}

fn property_from_json(value: &Json) -> PropertyValue {
    match value {
        Json::Null => PropertyValue::Null,
        Json::Bool(flag) => PropertyValue::Boolean(*flag),
        Json::Number(number) => match number.as_i64() {
            Some(integer) => PropertyValue::Integer(integer),
            None => PropertyValue::Float(number.as_f64().expect("a JSON number is an f64")),
        },
        Json::String(text) => PropertyValue::String(text.clone()),
        Json::Array(items) => PropertyValue::Sequence(items.iter().map(|item| no_span(property_from_json(item))).collect()),
        Json::Object(entries) => PropertyValue::Mapping(
            entries
                .iter()
                .map(|(key, value)| (no_span(key.clone()), no_span(property_from_json(value))))
                .collect(),
        ),
    }
}

fn captures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/captures")
}

/// Every row of `tests/fixtures/captures/<family>.jsonl`. Panics on a
/// malformed line, naming it: a broken fixture is a test bug.
pub fn load_captures(family: &str) -> Vec<CaptureRow> {
    let path = captures_dir().join(format!("{family}.jsonl"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(number, line)| {
            let row: Json = serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("{}:{}: {error}", path.display(), number + 1));
            let field = |name: &str| row.get(name).and_then(Json::as_str).map(str::to_string);
            CaptureRow {
                family: field("family").unwrap_or_else(|| family.to_string()),
                case: field("case").unwrap_or_else(|| panic!("{}:{}: no case", path.display(), number + 1)),
                expr: field("expr").unwrap_or_else(|| panic!("{}:{}: no expr", path.display(), number + 1)),
                kind: field("kind").unwrap_or_else(|| panic!("{}:{}: no kind", path.display(), number + 1)),
                text: field("text"),
                source: field("source").unwrap_or_else(|| "published".into()),
                props: row
                    .get("props")
                    .and_then(Json::as_object)
                    .map(|props| props.iter().map(|(key, value)| (key.clone(), property_from_json(value))).collect())
                    .unwrap_or_default(),
                now_ms: row.get("now_ms").and_then(Json::as_i64),
                zone: field("zone"),
            }
        })
        .collect()
}

/// The text a table cell shows for `value`.
///
/// **Provisional where marked.** Strings, numbers and booleans follow
/// JavaScript's `ToString` (published). How a cell shows a date, a list, a
/// link and a file is what Task 13's view captures settle; until then the
/// rules below are the renderer's, and a disagreement with a capture is
/// fixed here, in one place.
pub fn render_text(value: &Value, clock: &Clock) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Number(number) => number_to_string(*number),
        Value::Boolean(flag) => flag.to_string(),
        // Provisional: ISO date, or date and minutes in the clock's zone.
        Value::Date(date) => {
            let zoned = jiff::Timestamp::from_millisecond(date.epoch_ms)
                .expect("a representable instant")
                .to_zoned(clock.zone.clone());
            if date.has_time {
                zoned.strftime("%Y-%m-%d %H:%M").to_string()
            } else {
                zoned.strftime("%Y-%m-%d").to_string()
            }
        }
        // Provisional: milliseconds, as the cell model carries them.
        Value::Duration(duration) => duration.ms.to_string(),
        // Provisional: items joined by ", ".
        Value::List(items) => items.iter().map(|item| render_text(item, clock)).collect::<Vec<_>>().join(", "),
        Value::Object(entries) => entries
            .iter()
            .map(|(key, value)| format!("{key}: {}", render_text(value, clock)))
            .collect::<Vec<_>>()
            .join(", "),
        // Provisional: the display text, else the target as written.
        Value::Link(link) => match &link.display {
            Some(display) => render_text(display, clock),
            None => link.target.trim_start_matches("[[").trim_end_matches("]]").to_string(),
        },
        // Provisional: the file name without a `.md` extension.
        Value::File(path) => path.name().strip_suffix(".md").unwrap_or(path.name()).to_string(),
        Value::Regexp(regexp) => format!("/{}/{}", regexp.source, regexp.flags),
        Value::Image(text) | Value::Icon(text) | Value::Html(text) => text.clone(),
    }
}

/// Evaluate every row of one family file against a one-note vault
/// (`Capture.md`, carrying the row's `props`) and return one line per row
/// that disagrees. Empty means the whole family holds.
pub fn check_family(family: &str) -> Vec<String> {
    let mut failures = Vec::new();
    for row in load_captures(family) {
        let clock = Clock::fixed(row.now_ms.unwrap_or(FIXTURE_NOW_MS), row.zone.as_deref().unwrap_or(FIXTURE_ZONE));
        let mut note = MemoryFile::note().times(FIXTURE_NOW_MS - 86_400_000, FIXTURE_NOW_MS - 3_600_000).size(42);
        for (key, value) in &row.props {
            note = note.property(key, value.clone());
        }
        let source = MemorySource::new()
            .with("Capture.md", note)
            .with("Other.md", MemoryFile::note());
        let row_path = VaultPath::new("Capture.md").expect("a valid path");
        let base_path = VaultPath::new("Captures.base").expect("a valid path");
        let ctx = EvalContext::new(&source, &clock, &base_path, &row_path);
        let outcome = parse_expression(&row.expr)
            .map_err(|error| format!("parse: {} at {}", error.message, error.position))
            .and_then(|expr| evaluate(&expr, &ctx, &Scope::row(&row_path)).map_err(|error| error.to_string()));
        let label = format!("[{}] {} `{}`", row.source, row.case, row.expr);
        match (row.kind.as_str(), outcome) {
            ("error", Err(error)) => {
                if row.source == "uncaptured" && !error.contains("not captured yet") {
                    failures.push(format!("{label}: an uncaptured case must answer Uncaptured, got {error}"));
                }
            }
            ("error", Ok(value)) => failures.push(format!("{label}: expected an error, got {value:?}")),
            (_, Err(error)) => failures.push(format!("{label}: expected {}, got error {error}", row.kind)),
            (kind, Ok(value)) => {
                if value.type_name() != kind {
                    failures.push(format!("{label}: expected kind {kind}, got {} ({value:?})", value.type_name()));
                } else if let Some(text) = &row.text {
                    let rendered = render_text(&value, &clock);
                    if &rendered != text {
                        failures.push(format!("{label}: expected text {text:?}, got {rendered:?}"));
                    }
                }
            }
        }
    }
    failures
}
```

Replace `crates/vault-bases/src/lib.rs` with:

```rust
//! Obsidian Bases, evaluated outside Obsidian.
//!
//! This crate takes a `.base` document and a [`RowSource`] and produces a
//! view's rows. It does no I/O, opens no database and knows no protocol type:
//! the daemon implements `RowSource` over its index and live graph, and a
//! test implements it over [`MemorySource`]. Every behaviour that is not
//! fixed by the published reference (`obsidian.md/help/bases/…`) is fixed by
//! a runtime capture under `tests/fixtures/captures/`, and where neither
//! exists the evaluator answers a typed error rather than a guess.

mod clock;
pub mod eval;
pub mod expr;
mod file;
#[cfg(feature = "fixtures")]
pub mod fixtures;
pub mod functions;
mod source;
mod value;

pub use clock::Clock;
pub use file::{
    BaseFile, BaseParseError, Direction, FilterNode, GroupBy, PropertySettings, SortKey, ViewDecl,
    parse_base,
};
pub use source::{
    FileFacts, FileKind, LinkFact, MemoryFile, MemorySource, Prefilter, PropertyType, RowSource,
    ScalarLiteral, SourceError, extension, no_span, number, text,
};
pub use value::{DateValue, DurationValue, LinkValue, RegexpValue, Value};
```

- [ ] **Step 9: Run the tests and see them pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test coercion; echo "exit=$?"`

Expected: `test result: ok. 6 passed`, `exit=0`. A failing family test prints every disagreeing row with its source tag; fix the evaluator for a `published` row, and for an `uncaptured` row make sure the evaluator answers `Uncaptured` — never edit a published row to match the code.

- [ ] **Step 10: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-bases; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo clippy -p vault-bases --all-targets --no-default-features -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check -p vault-bases; echo "exit=$?"
```

Expected: `exit=0` five times. The third line proves the crate builds without the `fixtures` feature (the production shape).

- [ ] **Step 11: Commit**

```bash
git add crates/vault-bases
git commit -F - <<'COMMIT'
feat(bases): the evaluator core, the row source and the capture fixtures

A tree walker evaluates one expression for one row of a RowSource, resolving this, file, note, formula, bare properties and lambda locals through a Scope. Truthiness, equality, comparison, a total sort order, arithmetic, concatenation and ECMAScript number-to-string follow the published JavaScript rule where one exists; every pairing no published rule settles answers Uncaptured naming the case, for the capture task to fill. The global if, list, number, max, min, random, escapeHTML, html, icon and image and the any methods land with one fixture row per case.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 4: The string, number, list, object and regular-expression functions

Every method on the published reference for those five types, each pinned by at least one fixture row taken from the reference's own example, plus the edge rows the spec names for the function captures (null, empty, mixed types, lists of lists). String positions count UTF-16 code units, as JavaScript does.

**Files:**

- Create: `crates/vault-bases/src/functions/string.rs`, `number.rs`, `list.rs`, `object.rs`, `regexp.rs`
- Modify: `crates/vault-bases/src/functions/mod.rs` (dispatch), `crates/vault-bases/src/eval/coerce.rs` (`strict_equals`)
- Create: `crates/vault-bases/tests/functions_reference.rs`, `crates/vault-bases/tests/fixtures/captures/{string,number,list,object,regexp}.jsonl`

**Interfaces:**

- Consumes: `evaluate`, `EvalContext`, `Scope::bind`, `EvalError`, `coerce::{truthy, loose_equals, sort_order, to_display_string, number_to_string}`, `functions::{eager, arity}`, `fixtures::check_family` (Task 3).
- Produces: `coerce::strict_equals(&Value, &Value) -> bool`; the family modules' `METHODS`/`FIELDS` constants; `is_known_method` now answers for all five families.

**This task's checklist** (one fixture row at least per item; the reference's own example is always one of them):

- String — field `length`; methods `contains`, `containsAll`, `containsAny`, `endsWith`, `isEmpty`, `lower`, `replace`, `repeat`, `reverse`, `slice`, `split`, `startsWith`, `title`, `trim`.
- Number — `abs`, `ceil`, `floor`, `isEmpty`, `round`, `toFixed`.
- List — field `length`; methods `contains`, `containsAll`, `containsAny`, `filter`, `flat`, `isEmpty`, `join`, `map`, `reduce`, `reverse`, `slice`, `sort`, `unique`; and `mean`, which the syntax page uses in its summary example (`values.mean().round(3)`, "the same as the default `Average`") though the functions page does not list it.
- Object — `isEmpty`, `keys`, `values`.
- Regular expression — `matches`.

New uncaptured cases: `reverse:astral` (JavaScript's `split('').reverse()` would split a surrogate pair; whether Obsidian reverses by code unit or code point is not published), `mean:empty`, `split:regexp_groups` (a regular expression separator with capture groups).

- [ ] **Step 1: Write the fixture files**

Create `crates/vault-bases/tests/fixtures/captures/string.jsonl`:

```json
{"family":"string","case":"length","expr":"\"hello\".length","kind":"number","text":"5","source":"published"}
{"family":"string","case":"length:utf16","expr":"\"🙂a\".length","kind":"number","text":"3","source":"published"}
{"family":"string","case":"contains","expr":"\"hello\".contains(\"ell\")","kind":"boolean","text":"true","source":"published"}
{"family":"string","case":"containsAll","expr":"\"hello\".containsAll(\"h\", \"e\")","kind":"boolean","text":"true","source":"published"}
{"family":"string","case":"containsAll:missing","expr":"\"hello\".containsAll(\"h\", \"z\")","kind":"boolean","text":"false","source":"published"}
{"family":"string","case":"containsAny","expr":"\"hello\".containsAny(\"x\", \"y\", \"e\")","kind":"boolean","text":"true","source":"published"}
{"family":"string","case":"endsWith","expr":"\"hello\".endsWith(\"lo\")","kind":"boolean","text":"true","source":"published"}
{"family":"string","case":"isEmpty:false","expr":"\"Hello world\".isEmpty()","kind":"boolean","text":"false","source":"published"}
{"family":"string","case":"isEmpty:true","expr":"\"\".isEmpty()","kind":"boolean","text":"true","source":"published"}
{"family":"string","case":"isEmpty:not_present","expr":"missing.isEmpty()","kind":"boolean","text":"true","source":"published"}
{"family":"string","case":"lower","expr":"\"HeLLo\".lower()","kind":"string","text":"hello","source":"published"}
{"family":"string","case":"replace:string_all","expr":"\"a:b:c:d\".replace(\":\", \"-\")","kind":"string","text":"a-b-c-d","source":"published"}
{"family":"string","case":"replace:regexp_first","expr":"\"a:b:c:d\".replace(/:/, \"-\")","kind":"string","text":"a-b:c:d","source":"published"}
{"family":"string","case":"replace:regexp_global","expr":"\"a:b:c:d\".replace(/:/g, \"-\")","kind":"string","text":"a-b-c-d","source":"published"}
{"family":"string","case":"replace:groups","expr":"\"John Smith\".replace(/(\\w+) (\\w+)/, \"$2, $1\")","kind":"string","text":"Smith, John","source":"published"}
{"family":"string","case":"repeat","expr":"\"123\".repeat(2)","kind":"string","text":"123123","source":"published"}
{"family":"string","case":"repeat:negative","expr":"\"a\".repeat(-1)","kind":"error","source":"published"}
{"family":"string","case":"reverse","expr":"\"hello\".reverse()","kind":"string","text":"olleh","source":"published"}
{"family":"string","case":"reverse:astral","expr":"\"a🙂\".reverse()","kind":"error","source":"uncaptured"}
{"family":"string","case":"slice","expr":"\"hello\".slice(1, 4)","kind":"string","text":"ell","source":"published"}
{"family":"string","case":"slice:to_end","expr":"\"hello\".slice(2)","kind":"string","text":"llo","source":"published"}
{"family":"string","case":"slice:negative","expr":"\"hello\".slice(-3, -1)","kind":"string","text":"ll","source":"published"}
{"family":"string","case":"split:string","expr":"\"a,b,c,d\".split(\",\", 3)","kind":"list","text":"a, b, c","source":"published"}
{"family":"string","case":"split:regexp","expr":"\"a,b,c,d\".split(/,/, 3)","kind":"list","text":"a, b, c","source":"published"}
{"family":"string","case":"split:no_limit","expr":"\"a,b\".split(\",\").length","kind":"number","text":"2","source":"published"}
{"family":"string","case":"split:regexp_groups","expr":"\"a1b\".split(/(\\d)/)","kind":"error","source":"uncaptured"}
{"family":"string","case":"startsWith","expr":"\"hello\".startsWith(\"he\")","kind":"boolean","text":"true","source":"published"}
{"family":"string","case":"title","expr":"\"hello world\".title()","kind":"string","text":"Hello World","source":"published"}
{"family":"string","case":"trim","expr":"\"  hi  \".trim()","kind":"string","text":"hi","source":"published"}
{"family":"string","case":"method_on_missing","expr":"missing.contains(\"x\")","kind":"error","source":"published"}
```

Create `crates/vault-bases/tests/fixtures/captures/number.jsonl`:

```json
{"family":"number","case":"abs","expr":"(-5).abs()","kind":"number","text":"5","source":"published"}
{"family":"number","case":"ceil","expr":"(2.1).ceil()","kind":"number","text":"3","source":"published"}
{"family":"number","case":"floor","expr":"(2.9).floor()","kind":"number","text":"2","source":"published"}
{"family":"number","case":"isEmpty","expr":"5.isEmpty()","kind":"boolean","text":"false","source":"published"}
{"family":"number","case":"round","expr":"(2.5).round()","kind":"number","text":"3","source":"published"}
{"family":"number","case":"round:negative_half","expr":"(-2.5).round()","kind":"number","text":"-2","source":"published"}
{"family":"number","case":"round:digits","expr":"(2.3333).round(2)","kind":"number","text":"2.33","source":"published"}
{"family":"number","case":"toFixed","expr":"(3.14159).toFixed(2)","kind":"string","text":"3.14","source":"published"}
{"family":"number","case":"toFixed:tie","expr":"(0.125).toFixed(2)","kind":"string","text":"0.13","source":"published"}
{"family":"number","case":"toFixed:binary","expr":"(1.005).toFixed(2)","kind":"string","text":"1.00","source":"published"}
{"family":"number","case":"toFixed:pad","expr":"3.toFixed(2)","kind":"string","text":"3.00","source":"published"}
{"family":"number","case":"formatted_price","expr":"if(price, price.toFixed(2) + \" dollars\")","props":{"price":3},"kind":"string","text":"3.00 dollars","source":"published"}
{"family":"number","case":"ppu","expr":"(price / age).toFixed(2)","props":{"price":10,"age":3},"kind":"string","text":"3.33","source":"published"}
```

`toFixed` ties follow ECMA-262's `Number.prototype.toFixed` ("if there are two such n, pick the larger n"), on the exact binary value — which is why `0.125` (exact) rounds up and `1.005` (stored as 1.00499…) does not.

Create `crates/vault-bases/tests/fixtures/captures/list.jsonl`:

```json
{"family":"list","case":"length","expr":"[1, 2, 3].length","kind":"number","text":"3","source":"published"}
{"family":"list","case":"contains","expr":"[1,2,3].contains(2)","kind":"boolean","text":"true","source":"published"}
{"family":"list","case":"contains:mixed","expr":"[1, \"a\"].contains(\"a\")","kind":"boolean","text":"true","source":"published"}
{"family":"list","case":"contains:strict","expr":"[1, 2].contains(\"1\")","kind":"boolean","text":"false","source":"published"}
{"family":"list","case":"containsAll","expr":"[1,2,3].containsAll(2,3)","kind":"boolean","text":"true","source":"published"}
{"family":"list","case":"containsAny","expr":"[1,2,3].containsAny(3,4)","kind":"boolean","text":"true","source":"published"}
{"family":"list","case":"filter","expr":"[1,2,3,4].filter(value > 2)","kind":"list","text":"3, 4","source":"published"}
{"family":"list","case":"filter:index","expr":"[\"a\",\"b\",\"c\"].filter(index != 1)","kind":"list","text":"a, c","source":"published"}
{"family":"list","case":"flat","expr":"[1,[2,3]].flat()","kind":"list","text":"1, 2, 3","source":"published"}
{"family":"list","case":"flat:one_level","expr":"[1,[2,[3]]].flat().length","kind":"number","text":"3","source":"published"}
{"family":"list","case":"isEmpty","expr":"[1,2,3].isEmpty()","kind":"boolean","text":"false","source":"published"}
{"family":"list","case":"isEmpty:true","expr":"[].isEmpty()","kind":"boolean","text":"true","source":"published"}
{"family":"list","case":"join","expr":"[1,2,3].join(\",\")","kind":"string","text":"1,2,3","source":"published"}
{"family":"list","case":"map","expr":"[1,2,3,4].map(value + 1)","kind":"list","text":"2, 3, 4, 5","source":"published"}
{"family":"list","case":"reduce:sum","expr":"[1,2,3].reduce(acc + value, 0)","kind":"number","text":"6","source":"published"}
{"family":"list","case":"reduce:max","expr":"values.filter(value.isType(\"number\")).reduce(if(acc == null || value > acc, value, acc), null)","props":{"values":[3,"x",7,1]},"kind":"number","text":"7","source":"published"}
{"family":"list","case":"reduce:max_none","expr":"values.filter(value.isType(\"number\")).reduce(if(acc == null || value > acc, value, acc), null)","props":{"values":["x"]},"kind":"null","text":"","source":"published"}
{"family":"list","case":"reverse","expr":"[1,2,3].reverse()","kind":"list","text":"3, 2, 1","source":"published"}
{"family":"list","case":"slice","expr":"[1,2,3,4].slice(1,3)","kind":"list","text":"2, 3","source":"published"}
{"family":"list","case":"slice:to_end","expr":"[1,2,3,4].slice(2)","kind":"list","text":"3, 4","source":"published"}
{"family":"list","case":"sort:numbers","expr":"[3, 1, 2].sort()","kind":"list","text":"1, 2, 3","source":"published"}
{"family":"list","case":"sort:numeric_not_lexical","expr":"[10, 9, 1].sort()","kind":"list","text":"1, 9, 10","source":"published"}
{"family":"list","case":"sort:strings","expr":"[\"c\", \"a\", \"b\"].sort()","kind":"list","text":"a, b, c","source":"published"}
{"family":"list","case":"unique","expr":"[1,2,2,3].unique()","kind":"list","text":"1, 2, 3","source":"published"}
{"family":"list","case":"mean","expr":"[1, 2, 6].mean()","kind":"number","text":"3","source":"published"}
{"family":"list","case":"mean:skips_non_numbers","expr":"[1, \"a\", 3].mean()","kind":"number","text":"2","source":"published"}
{"family":"list","case":"mean:empty","expr":"[].mean()","kind":"error","source":"uncaptured"}
{"family":"list","case":"list_of_lists_length","expr":"[[1], [2, 3]].map(value.length)","kind":"list","text":"1, 2","source":"published"}
```

`sort:numeric_not_lexical` pins the functions page's own wording — "Sorts list elements from smallest to largest" — over JavaScript's default `Array.prototype.sort`, which would compare as strings and answer `1, 10, 9`; the published sentence is the stronger evidence, and the capture confirms.

Create `crates/vault-bases/tests/fixtures/captures/object.jsonl`:

```json
{"family":"object","case":"isEmpty:true","expr":"{}.isEmpty()","kind":"boolean","text":"true","source":"published"}
{"family":"object","case":"isEmpty:false","expr":"{\"a\": 1}.isEmpty()","kind":"boolean","text":"false","source":"published"}
{"family":"object","case":"keys","expr":"{\"a\": 1, \"b\": 2}.keys()","kind":"list","text":"a, b","source":"published"}
{"family":"object","case":"values","expr":"{\"a\": 1, \"b\": 2}.values()","kind":"list","text":"1, 2","source":"published"}
{"family":"object","case":"property_object","expr":"meta.keys()","props":{"meta":{"x":1,"y":2}},"kind":"list","text":"x, y","source":"published"}
```

Create `crates/vault-bases/tests/fixtures/captures/regexp.jsonl`:

```json
{"family":"regexp","case":"matches","expr":"/abc/.matches(\"abcde\")","kind":"boolean","text":"true","source":"published"}
{"family":"regexp","case":"matches:false","expr":"/^x/.matches(\"abc\")","kind":"boolean","text":"false","source":"published"}
{"family":"regexp","case":"matches:case_flag","expr":"/ABC/i.matches(\"abc\")","kind":"boolean","text":"true","source":"published"}
{"family":"regexp","case":"lookbehind_unsupported","expr":"/(?<=a)b/.matches(\"ab\")","kind":"error","source":"published"}
```

`lookbehind_unsupported` is published in the sense that matters: the `regex` crate documents that it has no look-around, so the evaluator refuses the pattern by name rather than matching it differently.

- [ ] **Step 2: Write the failing test**

Create `crates/vault-bases/tests/functions_reference.rs`:

```rust
use vault_bases::fixtures::check_family;

fn assert_family(family: &str) {
    let failures = check_family(family);
    assert!(
        failures.is_empty(),
        "{} {family} rows disagree:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn string_functions() {
    assert_family("string");
}

#[test]
fn number_functions() {
    assert_family("number");
}

#[test]
fn list_functions() {
    assert_family("list");
}

#[test]
fn object_functions() {
    assert_family("object");
}

#[test]
fn regexp_functions() {
    assert_family("regexp");
}

#[test]
fn string_indices_count_utf16_units_and_never_split_a_char() {
    use vault_bases::eval::{EvalContext, Scope, evaluate};
    use vault_bases::expr::parse_expression;
    use vault_bases::{Clock, MemorySource, Value};
    use vault_core::VaultPath;

    let source = MemorySource::new();
    let clock = Clock::fixed(0, "UTC");
    let path = VaultPath::new("A.md").unwrap();
    let ctx = EvalContext::new(&source, &clock, &path, &path);
    let run = |text: &str| evaluate(&parse_expression(text).unwrap(), &ctx, &Scope::default());

    // "🙂" is two UTF-16 units; slicing through its middle must not panic,
    // and the half it keeps becomes U+FFFD rather than a broken string.
    assert_eq!(run(r#""🙂ab".slice(1)"#).unwrap(), Value::String("\u{FFFD}ab".into()));
    assert_eq!(run(r#""é🙂".slice(0, 1)"#).unwrap(), Value::String("é".into()));
    assert_eq!(run(r#""ab".slice(5)"#).unwrap(), Value::String(String::new()));
    assert_eq!(run(r#""Tâble".length"#).unwrap(), Value::Number(5.0));
}
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test functions_reference; echo "exit=$?"`

Expected: every family test fails with rows such as `[published] length "hello".length: expected number, got error string has no field length`, and `exit=101`.

- [ ] **Step 4: Add strict equality**

Append to `crates/vault-bases/src/eval/coerce.rs`:

```rust
/// Equality without coercion, for `contains`, `containsAll`, `containsAny`
/// and `unique`. JavaScript's `Array.prototype.includes` uses SameValueZero,
/// so a number never equals a string there; pairings `==` leaves uncaptured
/// are simply unequal here. A link still equals the file it resolves to (the
/// syntax page: `authors.contains(this)`).
pub fn strict_equals(left: &Value, right: &Value) -> bool {
    loose_equals(left, right).unwrap_or(false)
}
```

- [ ] **Step 5: Write the five families**

Create `crates/vault-bases/src/functions/string.rs`:

```rust
use crate::eval::coerce::to_display_string;
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::Value;

use super::{arity, eager};

pub(crate) const METHODS: &[&str] = &[
    "contains", "containsAll", "containsAny", "endsWith", "isEmpty", "lower", "replace", "repeat",
    "reverse", "slice", "split", "startsWith", "title", "trim",
];
pub(crate) const FIELDS: &[&str] = &["length"];

fn strings(name: &str, values: Vec<Value>) -> Result<Vec<String>, EvalError> {
    values
        .into_iter()
        .map(|value| match value {
            Value::String(text) => Ok(text),
            other => Err(EvalError::Argument(format!("{name} takes strings, not {}", other.type_name()))),
        })
        .collect()
}

fn integer(name: &str, value: Option<&Value>) -> Result<Option<i64>, EvalError> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) => Ok(Some(number.trunc() as i64)),
        Some(other) => Err(EvalError::Argument(format!("{name} takes a number, not {}", other.type_name()))),
    }
}

/// JavaScript's relative index: negative counts from the end, clamped to
/// `[0, len]`.
pub(crate) fn relative_index(index: i64, len: usize) -> usize {
    if index < 0 {
        len.saturating_sub(index.unsigned_abs() as usize)
    } else {
        (index as usize).min(len)
    }
}

pub(crate) fn utf16_slice(text: &str, start: i64, end: Option<i64>) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let from = relative_index(start, units.len());
    let to = end.map_or(units.len(), |end| relative_index(end, units.len()));
    if from >= to {
        return String::new();
    }
    String::from_utf16_lossy(&units[from..to])
}

/// A JavaScript replacement string (`$1`, `$&`, `$$`) in the `regex` crate's
/// syntax (`${1}`, `${0}`, `$$`). Braces always, so `$1a` stays group 1 then
/// `a` rather than becoming a group named `1a`.
fn replacement(js: &str) -> String {
    let mut out = String::with_capacity(js.len());
    let mut chars = js.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('$') => {
                chars.next();
                out.push_str("$$");
            }
            Some('&') => {
                chars.next();
                out.push_str("${0}");
            }
            Some(d) if d.is_ascii_digit() => {
                let mut digits = String::new();
                while let Some(d) = chars.peek().copied().filter(char::is_ascii_digit) {
                    digits.push(d);
                    chars.next();
                }
                out.push_str(&format!("${{{digits}}}"));
            }
            _ => out.push_str("$$"),
        }
    }
    out
}

pub(crate) fn field(text: &str, name: &str) -> Result<Value, EvalError> {
    match name {
        "length" => Ok(Value::Number(text.encode_utf16().count() as f64)),
        _ => Err(EvalError::NoSuchField { target: "string", name: name.to_string() }),
    }
}

pub(crate) fn call(text: &str, name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
    Ok(match name {
        "contains" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(text.contains(strings(name, values)?[0].as_str()))
        }
        "containsAll" => Value::Boolean(strings(name, values)?.iter().all(|wanted| text.contains(wanted.as_str()))),
        "containsAny" => Value::Boolean(strings(name, values)?.iter().any(|wanted| text.contains(wanted.as_str()))),
        "startsWith" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(text.starts_with(strings(name, values)?[0].as_str()))
        }
        "endsWith" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(text.ends_with(strings(name, values)?[0].as_str()))
        }
        "isEmpty" => Value::Boolean(text.is_empty()),
        "lower" => Value::String(text.to_lowercase()),
        "trim" => Value::String(text.trim().to_string()),
        "title" => {
            let mut out = String::with_capacity(text.len());
            let mut at_word_start = true;
            for c in text.chars() {
                if at_word_start && c.is_alphabetic() {
                    out.extend(c.to_uppercase());
                } else {
                    out.push(c);
                }
                at_word_start = c.is_whitespace();
            }
            Value::String(out)
        }
        "repeat" => {
            arity(name, args, 1, 1)?;
            match integer(name, values.first())? {
                Some(count) if count >= 0 => Value::String(text.repeat(count as usize)),
                _ => return Err(EvalError::Argument("repeat takes a non-negative count".into())),
            }
        }
        "reverse" => {
            if text.chars().any(|c| c.len_utf16() == 2) {
                return Err(EvalError::Uncaptured("reverse:astral".into()));
            }
            Value::String(text.chars().rev().collect())
        }
        "slice" => {
            arity(name, args, 1, 2)?;
            let start = integer(name, values.first())?.unwrap_or(0);
            let end = integer(name, values.get(1))?;
            Value::String(utf16_slice(text, start, end))
        }
        "split" => {
            arity(name, args, 1, 2)?;
            let limit = integer(name, values.get(1))?.map(|n| n.max(0) as usize);
            let parts: Vec<String> = match &values[0] {
                Value::String(separator) if separator.is_empty() => {
                    text.encode_utf16().map(|unit| String::from_utf16_lossy(&[unit])).collect()
                }
                Value::String(separator) => text.split(separator.as_str()).map(str::to_string).collect(),
                Value::Regexp(regexp) => {
                    if regexp.regex.captures_len() > 1 {
                        return Err(EvalError::Uncaptured("split:regexp_groups".into()));
                    }
                    regexp.regex.split(text).map(str::to_string).collect()
                }
                other => return Err(EvalError::Argument(format!("split takes a string or a regular expression, not {}", other.type_name()))),
            };
            let kept = limit.map_or(parts.len(), |limit| limit.min(parts.len()));
            Value::List(parts.into_iter().take(kept).map(Value::String).collect())
        }
        "replace" => {
            arity(name, args, 2, 2)?;
            let with = match &values[1] {
                Value::String(with) => with.clone(),
                other => to_display_string(other)?,
            };
            match &values[0] {
                // A string pattern replaces every occurrence (the functions page).
                Value::String(pattern) => Value::String(text.replace(pattern.as_str(), &with)),
                // A regular expression replaces all only with the `g` flag.
                Value::Regexp(regexp) => {
                    let with = replacement(&with);
                    if regexp.flags.contains('g') {
                        Value::String(regexp.regex.replace_all(text, with.as_str()).into_owned())
                    } else {
                        Value::String(regexp.regex.replace(text, with.as_str()).into_owned())
                    }
                }
                other => return Err(EvalError::Argument(format!("replace takes a string or a regular expression, not {}", other.type_name()))),
            }
        }
        _ => return Err(EvalError::NoSuchMethod { target: "string", name: name.to_string() }),
    })
}
```

Create `crates/vault-bases/src/functions/number.rs`:

```rust
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::Value;

use super::{arity, eager};

pub(crate) const METHODS: &[&str] = &["abs", "ceil", "floor", "isEmpty", "round", "toFixed"];

/// JavaScript's `Math.round`: halves go toward +∞, so `-2.5` rounds to `-2`.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// ECMA-262 `Number.prototype.toFixed`: the integer `n` closest to
/// `value × 10^digits`, the larger on a tie, computed on the value's exact
/// binary expansion — Rust prints that expansion exactly at any precision, so
/// a 30-digit tail is enough to see whether the dropped part is a tie.
pub(crate) fn to_fixed(value: f64, digits: usize) -> String {
    let exact = format!("{:.*}", digits + 30, value.abs());
    let (whole, fraction) = exact.split_once('.').expect("a fixed-precision float has a point");
    let kept = &fraction[..digits];
    let dropped = &fraction[digits..];
    let round_up = dropped.as_bytes()[0] >= b'5';
    let mut number: Vec<u8> = format!("{whole}{kept}").into_bytes();
    if round_up {
        let mut at = number.len();
        loop {
            if at == 0 {
                number.insert(0, b'1');
                break;
            }
            at -= 1;
            if number[at] == b'9' {
                number[at] = b'0';
            } else {
                number[at] += 1;
                break;
            }
        }
    }
    let number = String::from_utf8(number).expect("ASCII digits");
    let split = number.len() - digits;
    let body = if digits == 0 { number } else { format!("{}.{}", &number[..split], &number[split..]) };
    if value < 0.0 && body.chars().any(|c| c.is_ascii_digit() && c != '0') {
        format!("-{body}")
    } else {
        body
    }
}

pub(crate) fn call(number: f64, name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
    let digits = |values: &[Value]| -> Result<Option<usize>, EvalError> {
        match values.first() {
            None => Ok(None),
            Some(Value::Number(digits)) if *digits >= 0.0 && *digits <= 100.0 => Ok(Some(*digits as usize)),
            Some(_) => Err(EvalError::Argument(format!("{name} takes a digit count from 0 to 100"))),
        }
    };
    Ok(match name {
        "abs" => Value::Number(number.abs()),
        "ceil" => Value::Number(number.ceil()),
        "floor" => Value::Number(number.floor()),
        "isEmpty" => Value::Boolean(false),
        "round" => {
            arity(name, args, 0, 1)?;
            match digits(&values)? {
                None | Some(0) => Value::Number(js_round(number)),
                Some(digits) => {
                    let scale = 10f64.powi(digits as i32);
                    Value::Number(js_round(number * scale) / scale)
                }
            }
        }
        "toFixed" => {
            arity(name, args, 0, 1)?;
            Value::String(to_fixed(number, digits(&values)?.unwrap_or(0)))
        }
        _ => return Err(EvalError::NoSuchMethod { target: "number", name: name.to_string() }),
    })
}
```

Create `crates/vault-bases/src/functions/list.rs`:

```rust
use crate::eval::coerce::{sort_order, strict_equals, to_display_string, truthy};
use crate::eval::{EvalContext, EvalError, Scope, evaluate};
use crate::expr::Expr;
use crate::value::Value;

use super::{arity, eager};
use super::string::relative_index;

pub(crate) const METHODS: &[&str] = &[
    "contains", "containsAll", "containsAny", "filter", "flat", "isEmpty", "join", "map", "reduce",
    "reverse", "slice", "sort", "unique", "mean",
];
pub(crate) const FIELDS: &[&str] = &["length"];

pub(crate) fn field(items: &[Value], name: &str) -> Result<Value, EvalError> {
    match name {
        "length" => Ok(Value::Number(items.len() as f64)),
        _ => Err(EvalError::NoSuchField { target: "list", name: name.to_string() }),
    }
}

fn index_arg(name: &str, value: Option<&Value>) -> Result<Option<i64>, EvalError> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) => Ok(Some(number.trunc() as i64)),
        Some(other) => Err(EvalError::Argument(format!("{name} takes a number, not {}", other.type_name()))),
    }
}

pub(crate) fn call(items: Vec<Value>, name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    // The three lambda methods evaluate their expression per element with
    // `value` and `index` bound (and `acc` for reduce); everything else takes
    // its arguments eagerly.
    match name {
        "filter" | "map" => {
            arity(name, args, 1, 1)?;
            let mut out = Vec::with_capacity(items.len());
            for (index, item) in items.into_iter().enumerate() {
                let inner = scope.bind("value", item.clone()).bind("index", Value::Number(index as f64));
                let result = evaluate(&args[0], ctx, &inner)?;
                if name == "map" {
                    out.push(result);
                } else if truthy(&result) {
                    out.push(item);
                }
            }
            return Ok(Value::List(out));
        }
        "reduce" => {
            arity(name, args, 2, 2)?;
            let mut acc = evaluate(&args[1], ctx, scope)?;
            for (index, item) in items.into_iter().enumerate() {
                let inner = scope
                    .bind("value", item)
                    .bind("index", Value::Number(index as f64))
                    .bind("acc", acc);
                acc = evaluate(&args[0], ctx, &inner)?;
            }
            return Ok(acc);
        }
        _ => {}
    }
    let values = eager(args, ctx, scope)?;
    Ok(match name {
        "contains" => {
            arity(name, args, 1, 1)?;
            Value::Boolean(items.iter().any(|item| strict_equals(item, &values[0])))
        }
        "containsAll" => Value::Boolean(values.iter().all(|wanted| items.iter().any(|item| strict_equals(item, wanted)))),
        "containsAny" => Value::Boolean(values.iter().any(|wanted| items.iter().any(|item| strict_equals(item, wanted)))),
        "flat" => Value::List(
            items
                .into_iter()
                .flat_map(|item| match item {
                    Value::List(inner) => inner,
                    other => vec![other],
                })
                .collect(),
        ),
        "isEmpty" => Value::Boolean(items.is_empty()),
        "join" => {
            arity(name, args, 0, 1)?;
            let separator = match values.first() {
                None => ",".to_string(),
                Some(Value::String(separator)) => separator.clone(),
                Some(other) => to_display_string(other)?,
            };
            Value::String(
                items
                    .iter()
                    .map(|item| match item {
                        Value::Null => Ok(String::new()),
                        other => to_display_string(other),
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .join(&separator),
            )
        }
        "reverse" => Value::List(items.into_iter().rev().collect()),
        "slice" => {
            arity(name, args, 1, 2)?;
            let len = items.len();
            let from = relative_index(index_arg(name, values.first())?.unwrap_or(0), len);
            let to = index_arg(name, values.get(1))?.map_or(len, |end| relative_index(end, len));
            Value::List(if from < to { items[from..to].to_vec() } else { Vec::new() })
        }
        "sort" => {
            let mut sorted = items;
            sorted.sort_by(sort_order);
            Value::List(sorted)
        }
        "unique" => {
            let mut kept: Vec<Value> = Vec::with_capacity(items.len());
            for item in items {
                if !kept.iter().any(|have| strict_equals(have, &item)) {
                    kept.push(item);
                }
            }
            Value::List(kept)
        }
        // The syntax page's summary example (`values.mean()`, "the same as
        // the default Average"): the mean of the numbers, skipping the rest
        // the way `Average` is described ("all numbers from the input values").
        "mean" => {
            let numbers: Vec<f64> = items
                .iter()
                .filter_map(|item| match item {
                    Value::Number(number) => Some(*number),
                    _ => None,
                })
                .collect();
            if numbers.is_empty() {
                return Err(EvalError::Uncaptured("mean:empty".into()));
            }
            Value::Number(numbers.iter().sum::<f64>() / numbers.len() as f64)
        }
        _ => return Err(EvalError::NoSuchMethod { target: "list", name: name.to_string() }),
    })
}
```

Create `crates/vault-bases/src/functions/object.rs`:

```rust
use crate::eval::EvalError;
use crate::value::Value;

pub(crate) const METHODS: &[&str] = &["isEmpty", "keys", "values"];

pub(crate) fn call(entries: Vec<(String, Value)>, name: &str) -> Result<Value, EvalError> {
    Ok(match name {
        "isEmpty" => Value::Boolean(entries.is_empty()),
        "keys" => Value::List(entries.into_iter().map(|(key, _)| Value::String(key)).collect()),
        "values" => Value::List(entries.into_iter().map(|(_, value)| value).collect()),
        _ => return Err(EvalError::NoSuchMethod { target: "object", name: name.to_string() }),
    })
}
```

Create `crates/vault-bases/src/functions/regexp.rs`:

```rust
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::{RegexpValue, Value};

use super::{arity, eager};

pub(crate) const METHODS: &[&str] = &["matches"];

pub(crate) fn call(regexp: &RegexpValue, name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    match name {
        "matches" => {
            arity(name, args, 1, 1)?;
            match eager(args, ctx, scope)?.as_slice() {
                [Value::String(text)] => Ok(Value::Boolean(regexp.regex.is_match(text))),
                _ => Err(EvalError::Argument("matches takes one string".into())),
            }
        }
        _ => Err(EvalError::NoSuchMethod { target: "regexp", name: name.to_string() }),
    }
}
```

- [ ] **Step 6: Route the families**

In `crates/vault-bases/src/functions/mod.rs`, replace the module list at the top with:

```rust
mod any;
mod global;
mod list;
mod number;
mod object;
mod regexp;
mod string;
```

and replace `call_method`, `field` and `is_known_method` with:

```rust
pub(crate) fn call_method(
    target: Value,
    name: &str,
    args: &[Expr],
    ctx: &EvalContext<'_>,
    scope: &Scope,
) -> Result<Value, EvalError> {
    if any::METHODS.contains(&name) {
        return any::call(&target, name, args, ctx, scope);
    }
    match target {
        // A missing property is `null`. `isEmpty` is true for it (the
        // string and number entries: "or is not present"); every other
        // method on it is an error cell — "a missing property in a method
        // call", in the spec's words.
        Value::Null if name == "isEmpty" => Ok(Value::Boolean(true)),
        Value::String(text) => string::call(&text, name, args, ctx, scope),
        Value::Number(number) => number::call(number, name, args, ctx, scope),
        Value::List(items) => list::call(items, name, args, ctx, scope),
        Value::Object(entries) => object::call(entries, name),
        Value::Regexp(regexp) => regexp::call(&regexp, name, args, ctx, scope),
        other => Err(EvalError::NoSuchMethod {
            target: other.type_name(),
            name: name.to_string(),
        }),
    }
}

pub(crate) fn field(target: &Value, name: &str, _ctx: &EvalContext<'_>) -> Result<Value, EvalError> {
    match target {
        Value::Null => Ok(Value::Null),
        Value::String(text) => string::field(text, name),
        Value::List(items) => list::field(items, name),
        other => Err(EvalError::NoSuchField {
            target: other.type_name(),
            name: name.to_string(),
        }),
    }
}

pub fn is_known_method(name: &str) -> bool {
    [
        any::METHODS,
        string::METHODS,
        number::METHODS,
        list::METHODS,
        object::METHODS,
        regexp::METHODS,
    ]
    .iter()
    .any(|methods| methods.contains(&name))
}
```

`string::FIELDS` and `list::FIELDS` are each family's published field list, kept beside `METHODS` for the reader that names a family's surface; no task in this phase reads them, so each carries `#[allow(dead_code, reason = "the family's published field list; no reader in this phase")]` on its own line above the `const` (lint reasons are stable since Rust 1.81, inside the 1.85 floor), and keeps it.

- [ ] **Step 7: Run the tests and see them pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test functions_reference; echo "exit=$?"`

Expected: `test result: ok. 6 passed`, `exit=0`.

- [ ] **Step 8: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-bases; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check -p vault-bases; echo "exit=$?"
```

Expected: `exit=0` four times.

- [ ] **Step 9: Commit**

```bash
git add crates/vault-bases
git commit -F - <<'COMMIT'
feat(bases): the string, number, list, object and regexp functions

Every method the functions page lists for those five types, plus mean from the syntax page's summary example, each pinned by the reference's own example and by the edge rows the captures will confirm. String positions count UTF-16 units as JavaScript does; toFixed follows ECMA-262's tie rule on the exact binary value; contains and unique compare without coercion; a regular expression the regex crate cannot express is refused by name.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 5: Dates and durations — `date()`, `duration()`, `now()`, `today()`, the date fields and methods, Moment formatting, `relative()`, and date arithmetic

The date model: a `DateValue` is an instant plus a has-time flag, interpreted in the `Clock`'s IANA zone; a `DurationValue` keeps calendar months apart from exact milliseconds. `+ "1M"` is calendar arithmetic (the syntax page: `date("2024-12-01") + "1M" + "4h" + "3m"` is `2025-01-01 04:03:00`); `+ "1 day"` on a date with a time is exactly 24 hours (the syntax page: "returns a datetime exactly 24 hours from the time of execution"); on a date without a time, whole days move the calendar date so it stays a date. `format()` implements Moment.js tokens from the Moment documentation, and any other letter is `UnsupportedFormatToken` (the spec's `unsupported_format_token` diagnostic). `relative()` is Moment's `fromNow` algorithm with its default thresholds.

**Files:**

- Create: `crates/vault-bases/src/dates.rs`, `crates/vault-bases/src/functions/date.rs`
- Modify: `crates/vault-bases/src/functions/mod.rs` (`typed_property`, `date_arithmetic`, dispatch), `crates/vault-bases/src/lib.rs` (`mod dates;`)
- Create: `crates/vault-bases/tests/dates.rs`, `crates/vault-bases/tests/fixtures/captures/date.jsonl`

**Interfaces:**

- Consumes: `Clock`, `DateValue`, `DurationValue`, `EvalContext`, `EvalError::{Argument, UnsupportedFormatToken}`, `PropertyType::{Date, DateTime}`, `functions::{eager, arity}`, `fixtures::check_family`.
- Produces (crate-internal unless marked):

```rust
// dates.rs
pub(crate) fn parse_date_text(text: &str, clock: &Clock) -> Option<DateValue>;
pub(crate) fn parse_duration_text(text: &str) -> Option<DurationValue>;
pub(crate) fn add(date: DateValue, duration: DurationValue, sign: i64, clock: &Clock) -> Result<DateValue, EvalError>;
pub(crate) fn zoned(date: DateValue, clock: &Clock) -> jiff::Zoned;
pub(crate) fn start_of_day(epoch_ms: i64, clock: &Clock) -> DateValue;
pub fn format_date(date: DateValue, format: &str, clock: &Clock) -> Result<String, EvalError>;   // pub: the server's cell model reuses it for ISO text
pub(crate) fn relative(date: DateValue, clock: &Clock) -> String;
```

**This task's checklist:** global `date()`, `duration()`, `now()`, `today()`; date fields `year`, `month`, `day`, `hour`, `minute`, `second`, `millisecond`; date methods `date()`, `format()`, `time()`, `relative()`, `isEmpty()`; date arithmetic (date ± duration string, date ± `duration()`, date − date, duration × number, duration ± duration, and the published refusal of number × duration); date comparison; date-typed properties.

**Moment tokens implemented** (from the Moment.js "Format" documentation, locale `en`): `YYYY YY Q MMMM MMM MM M Do DDDD DDD DD D dddd ddd dd d HH H hh h mm m ss s SSS SS S A a ZZ Z X x` and `[escaped text]`. Every other ASCII letter is `UnsupportedFormatToken`, named; Task 13's captures extend the list only where the maintainer's bases use a token.

New uncaptured case: none — every row below is published; `cmp:mixed` (Task 3) already covers a date compared with a string.

- [ ] **Step 1: Write the fixture file**

Create `crates/vault-bases/tests/fixtures/captures/date.jsonl` (the clock is `FIXTURE_NOW_MS`, 2026-01-15 10:30:00 in America/New_York, a Thursday):

```json
{"family":"date","case":"date:parse_datetime","expr":"date(\"2025-01-01 12:00:00\").format(\"YYYY-MM-DD HH:mm:ss\")","kind":"string","text":"2025-01-01 12:00:00","source":"published"}
{"family":"date","case":"date:parse_date","expr":"date(\"2025-05-27\").format(\"YYYY-MM-DD\")","kind":"string","text":"2025-05-27","source":"published"}
{"family":"date","case":"date:invalid","expr":"date(\"not a date\")","kind":"error","source":"published"}
{"family":"date","case":"arith:month_then_hours","expr":"(date(\"2024-12-01\") + \"1M\" + \"4h\" + \"3m\").format(\"YYYY-MM-DD HH:mm:ss\")","kind":"string","text":"2025-01-01 04:03:00","source":"published"}
{"family":"date","case":"now","expr":"now().format(\"YYYY-MM-DD HH:mm\")","kind":"string","text":"2026-01-15 10:30","source":"published"}
{"family":"date","case":"today","expr":"today().format(\"YYYY-MM-DD HH:mm:ss\")","kind":"string","text":"2026-01-15 00:00:00","source":"published"}
{"family":"date","case":"date_method","expr":"now().date().format(\"YYYY-MM-DD HH:mm:ss\")","kind":"string","text":"2026-01-15 00:00:00","source":"published"}
{"family":"date","case":"time","expr":"now().time()","kind":"string","text":"10:30:00","source":"published"}
{"family":"date","case":"isEmpty","expr":"now().isEmpty()","kind":"boolean","text":"false","source":"published"}
{"family":"date","case":"arith:date_minus_date","expr":"(now() + \"1d\") - now()","kind":"duration","text":"86400000","source":"published"}
{"family":"date","case":"arith:one_day_spelled","expr":"(now() + \"1 day\").format(\"YYYY-MM-DD HH:mm\")","kind":"string","text":"2026-01-16 10:30","source":"published"}
{"family":"date","case":"arith:seven_days","expr":"(today() + \"7d\").format(\"YYYY-MM-DD\")","kind":"string","text":"2026-01-22","source":"published"}
{"family":"date","case":"arith:week_back","expr":"(now() - \"1 week\").format(\"YYYY-MM-DD\")","kind":"string","text":"2026-01-08","source":"published"}
{"family":"date","case":"arith:minus_hours","expr":"(now() - \"2h\").format(\"HH:mm\")","kind":"string","text":"08:30","source":"published"}
{"family":"date","case":"arith:duration_times","expr":"(now() + (duration('1d') * 2)).format(\"YYYY-MM-DD\")","kind":"string","text":"2026-01-17","source":"published"}
{"family":"date","case":"duration:times_number","expr":"duration('5h') * 2","kind":"duration","text":"36000000","source":"published"}
{"family":"date","case":"duration:number_on_left","expr":"2 * duration('5h')","kind":"error","source":"published"}
{"family":"date","case":"duration:invalid","expr":"duration(\"soon\")","kind":"error","source":"published"}
{"family":"date","case":"arith:exact_day_across_dst","expr":"(date(\"2026-03-07 12:00:00\") + \"1d\").format(\"YYYY-MM-DD HH:mm\")","kind":"string","text":"2026-03-08 13:00","source":"published"}
{"family":"date","case":"arith:calendar_day_without_time","expr":"(date(\"2026-03-07\") + \"1d\").format(\"YYYY-MM-DD HH:mm\")","kind":"string","text":"2026-03-08 00:00","source":"published"}
{"family":"date","case":"field:year","expr":"now().year","kind":"number","text":"2026","source":"published"}
{"family":"date","case":"field:month","expr":"now().month","kind":"number","text":"1","source":"published"}
{"family":"date","case":"field:day","expr":"now().day","kind":"number","text":"15","source":"published"}
{"family":"date","case":"field:hour","expr":"now().hour","kind":"number","text":"10","source":"published"}
{"family":"date","case":"field:minute","expr":"now().minute","kind":"number","text":"30","source":"published"}
{"family":"date","case":"field:second","expr":"now().second","kind":"number","text":"0","source":"published"}
{"family":"date","case":"field:millisecond","expr":"now().millisecond","kind":"number","text":"0","source":"published"}
{"family":"date","case":"compare","expr":"date(\"2024-01-01\") < date(\"2024-02-01\")","kind":"boolean","text":"true","source":"published"}
{"family":"date","case":"equal_instant","expr":"date(\"2024-01-01 00:00:00\") == date(\"2024-01-01\")","kind":"boolean","text":"true","source":"published"}
{"family":"date","case":"format:long","expr":"date(\"2025-05-27 14:05:09\").format(\"dddd, MMMM Do YYYY, h:mm:ss a\")","kind":"string","text":"Tuesday, May 27th 2025, 2:05:09 pm","source":"published"}
{"family":"date","case":"format:short_names","expr":"date(\"2025-05-27\").format(\"ddd MMM D, YY\")","kind":"string","text":"Tue May 27, 25","source":"published"}
{"family":"date","case":"format:escaped_and_quarter","expr":"date(\"2025-05-27\").format(\"[Quarter] Q\")","kind":"string","text":"Quarter 2","source":"published"}
{"family":"date","case":"format:offset","expr":"now().format(\"Z ZZ\")","kind":"string","text":"-05:00 -0500","source":"published"}
{"family":"date","case":"format:day_of_year_and_weekday_number","expr":"date(\"2025-02-01\").format(\"DDDD d\")","kind":"string","text":"032 6","source":"published"}
{"family":"date","case":"format:unsupported_token","expr":"now().format(\"W\")","kind":"error","source":"published"}
{"family":"date","case":"relative:days_ago","expr":"(now() - \"3d\").relative()","kind":"string","text":"3 days ago","source":"published"}
{"family":"date","case":"relative:in_hours","expr":"(now() + \"2h\").relative()","kind":"string","text":"in 2 hours","source":"published"}
{"family":"date","case":"relative:few_seconds","expr":"(now() - \"30s\").relative()","kind":"string","text":"a few seconds ago","source":"published"}
{"family":"date","case":"relative:a_minute","expr":"(now() - \"50s\").relative()","kind":"string","text":"a minute ago","source":"published"}
{"family":"date","case":"relative:a_month","expr":"(now() - \"30d\").relative()","kind":"string","text":"a month ago","source":"published"}
{"family":"date","case":"relative:years","expr":"(now() - \"2y\").relative()","kind":"string","text":"2 years ago","source":"published"}
```

`arith:exact_day_across_dst` is where the two published rules meet: 2026-03-08 is the US spring-forward day, so "exactly 24 hours" after noon on the 7th is 13:00 local on the 8th, while `arith:calendar_day_without_time` keeps a date that has no time on the calendar. The capture confirms both.

- [ ] **Step 2: Write the failing test**

Create `crates/vault-bases/tests/dates.rs`:

```rust
use vault_bases::eval::{EvalContext, Scope, evaluate};
use vault_bases::expr::parse_expression;
use vault_bases::fixtures::{FIXTURE_NOW_MS, FIXTURE_ZONE, check_family};
use vault_bases::{Clock, MemoryFile, MemorySource, PropertyType, Value, text};
use vault_core::VaultPath;

#[test]
fn the_date_family_holds() {
    let failures = check_family("date");
    assert!(failures.is_empty(), "{} date rows disagree:\n{}", failures.len(), failures.join("\n"));
}

fn run(source: &MemorySource, expression: &str) -> Value {
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let row = VaultPath::new("Task.md").unwrap();
    let base = VaultPath::new("Tasks.base").unwrap();
    let ctx = EvalContext::new(source, &clock, &base, &row);
    evaluate(&parse_expression(expression).unwrap(), &ctx, &Scope::row(&row)).unwrap()
}

#[test]
fn a_date_typed_property_is_a_date_and_an_untyped_one_stays_text() {
    let source = MemorySource::new()
        .with(
            "Task.md",
            MemoryFile::note()
                .property("due", text("2025-01-01"))
                .property("stamp", text("2025-01-01T10:15:00"))
                .property("memo", text("2025-01-01")),
        )
        .typed("due", PropertyType::Date)
        .typed("stamp", PropertyType::DateTime);
    assert_eq!(run(&source, "due.isType(\"date\")"), Value::Boolean(true));
    assert_eq!(run(&source, "due.format(\"YYYY-MM-DD\")"), Value::String("2025-01-01".into()));
    assert_eq!(run(&source, "stamp.format(\"HH:mm\")"), Value::String("10:15".into()));
    assert_eq!(run(&source, "memo.isType(\"string\")"), Value::Boolean(true));
    assert_eq!(run(&source, "due < today()"), Value::Boolean(true));
}

#[test]
fn a_date_typed_property_that_does_not_parse_stays_text() {
    let source = MemorySource::new()
        .with("Task.md", MemoryFile::note().property("due", text("someday")))
        .typed("due", PropertyType::Date);
    assert_eq!(run(&source, "due"), Value::String("someday".into()));
}
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test dates; echo "exit=$?"`

Expected: every date row fails with `unknown function date` or `unknown function now`, the typed-property tests panic on `unwrap()` of an `UnknownFunction`/`NoSuchMethod` error, `exit=101`.

- [ ] **Step 4: Write the date model**

Create `crates/vault-bases/src/dates.rs`:

```rust
//! Dates, durations, Moment formatting and Moment's `fromNow`.
//!
//! An instant is interpreted in the [`Clock`]'s zone, as Obsidian
//! interprets it in the device's. Two published rules govern arithmetic and
//! they are both kept: months and years are calendar arithmetic (the syntax
//! page's `2024-12-01 + 1M = 2025-01-01`), while days, weeks, hours,
//! minutes and seconds are exact milliseconds (the syntax page: `now() +
//! "1 day"` "returns a datetime exactly 24 hours from the time of
//! execution") — except that whole days added to a date *without* a time
//! move its calendar date, so a date stays a date across a DST change.

use jiff::civil::DateTime;
use jiff::{Span, Timestamp, Zoned};

use crate::clock::Clock;
use crate::eval::EvalError;
use crate::value::{DateValue, DurationValue};

const DAY_MS: i64 = 86_400_000;

pub(crate) fn zoned(date: DateValue, clock: &Clock) -> Zoned {
    Timestamp::from_millisecond(date.epoch_ms)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned(clock.zone.clone())
}

/// Local midnight of the day containing `epoch_ms`, without a time.
pub(crate) fn start_of_day(epoch_ms: i64, clock: &Clock) -> DateValue {
    let day = zoned(DateValue { epoch_ms, has_time: true }, clock);
    let midnight = day.start_of_day().unwrap_or(day);
    DateValue {
        epoch_ms: midnight.timestamp().as_millisecond(),
        has_time: false,
    }
}

fn number(text: &str) -> Option<i32> {
    (!text.is_empty() && text.chars().all(|c| c.is_ascii_digit())).then(|| text.parse().ok()).flatten()
}

/// `YYYY-MM-DD`, then optionally `[ T]HH:mm[:ss[.SSS]]`, in local time — the
/// form the functions page names for `date()` (`YYYY-MM-DD HH:mm:ss`) and the
/// forms Obsidian's date and date-time properties store.
pub(crate) fn parse_date_text(text: &str, clock: &Clock) -> Option<DateValue> {
    let text = text.trim();
    let (day, time) = match text.find([' ', 'T']) {
        Some(at) => (&text[..at], Some(text[at + 1..].trim())),
        None => (text, None),
    };
    let mut parts = day.split('-');
    let year = number(parts.next()?)?;
    let month = number(parts.next()?)?;
    let date = number(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    let (hour, minute, second, millis) = match time {
        None => (0, 0, 0, 0),
        Some(time) => {
            let (clock_part, fraction) = match time.split_once('.') {
                Some((clock_part, fraction)) => (clock_part, Some(fraction)),
                None => (time, None),
            };
            let mut fields = clock_part.split(':');
            let hour = number(fields.next()?)?;
            let minute = number(fields.next()?)?;
            let second = match fields.next() {
                Some(second) => number(second)?,
                None => 0,
            };
            if fields.next().is_some() {
                return None;
            }
            let millis = match fraction {
                Some(fraction) => number(&format!("{fraction:0<3}")[..3])?,
                None => 0,
            };
            (hour, minute, second, millis)
        }
    };
    let civil = DateTime::new(
        i16::try_from(year).ok()?,
        i8::try_from(month).ok()?,
        i8::try_from(date).ok()?,
        i8::try_from(hour).ok()?,
        i8::try_from(minute).ok()?,
        i8::try_from(second).ok()?,
        millis * 1_000_000,
    )
    .ok()?;
    let local = civil.to_zoned(clock.zone.clone()).ok()?;
    Some(DateValue {
        epoch_ms: local.timestamp().as_millisecond(),
        has_time: time.is_some(),
    })
}

/// One `<number><unit>` component, the space optional and the sign allowed:
/// `1M`, `4h`, `1 day`, `-2 weeks`. The units are the syntax page's table;
/// `M` is months and `m` minutes, so the match is case-sensitive.
pub(crate) fn parse_duration_text(text: &str) -> Option<DurationValue> {
    let text = text.trim();
    let split = text
        .char_indices()
        .find(|(at, c)| *at > 0 && !c.is_ascii_digit() && *c != '.')
        .map(|(at, _)| at)?;
    let amount: f64 = text[..split].trim().parse().ok()?;
    let unit = text[split..].trim();
    let whole = |scale: i64| Some(DurationValue { months: 0, ms: (amount * scale as f64).round() as i64 });
    match unit {
        "y" | "year" | "years" => (amount.fract() == 0.0).then(|| DurationValue { months: amount as i64 * 12, ms: 0 }),
        "M" | "month" | "months" => (amount.fract() == 0.0).then(|| DurationValue { months: amount as i64, ms: 0 }),
        "w" | "week" | "weeks" => whole(7 * DAY_MS),
        "d" | "day" | "days" => whole(DAY_MS),
        "h" | "hour" | "hours" => whole(3_600_000),
        "m" | "minute" | "minutes" => whole(60_000),
        "s" | "second" | "seconds" => whole(1_000),
        _ => None,
    }
}

/// `date ± duration`.
pub(crate) fn add(date: DateValue, duration: DurationValue, sign: i64, clock: &Clock) -> Result<DateValue, EvalError> {
    let overflow = || EvalError::Argument("the date is out of range".into());
    let mut moved = zoned(date, clock);
    if duration.months != 0 {
        moved = moved
            .checked_add(Span::new().months(duration.months * sign))
            .map_err(|_| overflow())?;
    }
    let ms = duration.ms * sign;
    if ms == 0 {
        return Ok(DateValue { epoch_ms: moved.timestamp().as_millisecond(), has_time: date.has_time });
    }
    if !date.has_time && ms % DAY_MS == 0 {
        moved = moved.checked_add(Span::new().days(ms / DAY_MS)).map_err(|_| overflow())?;
        return Ok(DateValue { epoch_ms: moved.timestamp().as_millisecond(), has_time: false });
    }
    Ok(DateValue {
        epoch_ms: moved.timestamp().as_millisecond().checked_add(ms).ok_or_else(overflow)?,
        has_time: true,
    })
}

const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
];
const WEEKDAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// The tokens, longest first within each letter, so `MMMM` wins over `MM`.
const TOKENS: [&str; 33] = [
    "YYYY", "YY", "Q", "MMMM", "MMM", "MM", "M", "Do", "DDDD", "DDD", "DD", "D", "dddd", "ddd",
    "dd", "d", "HH", "H", "hh", "h", "mm", "m", "ss", "s", "SSS", "SS", "S", "A", "a", "ZZ", "Z",
    "X", "x",
];

fn ordinal(day: i32) -> String {
    let suffix = match (day % 100, day % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{day}{suffix}")
}

/// Moment.js `format`, locale `en`.
pub fn format_date(date: DateValue, format: &str, clock: &Clock) -> Result<String, EvalError> {
    let at = zoned(date, clock);
    let hour = i32::from(at.hour());
    let twelve = if hour % 12 == 0 { 12 } else { hour % 12 };
    let weekday = usize::from(at.weekday().to_sunday_zero_offset() as u8);
    let offset = at.offset().seconds();
    let (sign, offset) = if offset < 0 { ('-', -offset) } else { ('+', offset) };
    let millis = i32::from(at.millisecond());
    let mut out = String::new();
    let mut rest = format;
    while let Some(c) = rest.chars().next() {
        if c == '[' {
            let close = rest.find(']').unwrap_or(rest.len());
            out.push_str(&rest[1..close]);
            rest = &rest[(close + 1).min(rest.len())..];
            continue;
        }
        if !c.is_ascii_alphabetic() {
            out.push(c);
            rest = &rest[c.len_utf8()..];
            continue;
        }
        let Some(token) = TOKENS.iter().find(|token| rest.starts_with(**token)) else {
            let run: String = rest.chars().take_while(|d| *d == c).collect();
            return Err(EvalError::UnsupportedFormatToken(run));
        };
        let year = i32::from(at.year());
        let month = i32::from(at.month());
        let day = i32::from(at.day());
        let text = match *token {
            "YYYY" => format!("{year:04}"),
            "YY" => format!("{:02}", year.rem_euclid(100)),
            "Q" => ((month - 1) / 3 + 1).to_string(),
            "MMMM" => MONTHS[(month - 1) as usize].to_string(),
            "MMM" => MONTHS[(month - 1) as usize][..3].to_string(),
            "MM" => format!("{month:02}"),
            "M" => month.to_string(),
            "Do" => ordinal(day),
            "DDDD" => format!("{:03}", at.day_of_year()),
            "DDD" => at.day_of_year().to_string(),
            "DD" => format!("{day:02}"),
            "D" => day.to_string(),
            "dddd" => WEEKDAYS[weekday].to_string(),
            "ddd" => WEEKDAYS[weekday][..3].to_string(),
            "dd" => WEEKDAYS[weekday][..2].to_string(),
            "d" => weekday.to_string(),
            "HH" => format!("{hour:02}"),
            "H" => hour.to_string(),
            "hh" => format!("{twelve:02}"),
            "h" => twelve.to_string(),
            "mm" => format!("{:02}", at.minute()),
            "m" => at.minute().to_string(),
            "ss" => format!("{:02}", at.second()),
            "s" => at.second().to_string(),
            "SSS" => format!("{millis:03}"),
            "SS" => format!("{:02}", millis / 10),
            "S" => (millis / 100).to_string(),
            "A" => (if hour < 12 { "AM" } else { "PM" }).to_string(),
            "a" => (if hour < 12 { "am" } else { "pm" }).to_string(),
            "ZZ" => format!("{sign}{:02}{:02}", offset / 3600, offset % 3600 / 60),
            "Z" => format!("{sign}{:02}:{:02}", offset / 3600, offset % 3600 / 60),
            "X" => date.epoch_ms.div_euclid(1000).to_string(),
            "x" => date.epoch_ms.to_string(),
            _ => unreachable!("every token in TOKENS has an arm"),
        };
        out.push_str(&text);
        rest = &rest[token.len()..];
    }
    Ok(out)
}

/// JavaScript's `Math.round`.
fn round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// Moment's `fromNow` with its default thresholds (`ss` 44, `s` 45, `m` 45,
/// `h` 22, `d` 26, `M` 11), locale `en`: the duration is measured in each
/// unit and rounded, and the first threshold that holds picks the wording.
pub(crate) fn relative(date: DateValue, clock: &Clock) -> String {
    let difference = date.epoch_ms - clock.now_ms;
    let ms = difference.unsigned_abs() as f64;
    let seconds = round(ms / 1000.0);
    let minutes = round(ms / 60_000.0);
    let hours = round(ms / 3_600_000.0);
    let days_exact = ms / DAY_MS as f64;
    let days = round(days_exact);
    let months_exact = days_exact * 4800.0 / 146_097.0;
    let months = round(months_exact);
    let years = round(months_exact / 12.0);
    let phrase = if seconds <= 44 {
        "a few seconds".to_string()
    } else if seconds < 45 {
        format!("{seconds} seconds")
    } else if minutes <= 1 {
        "a minute".to_string()
    } else if minutes < 45 {
        format!("{minutes} minutes")
    } else if hours <= 1 {
        "an hour".to_string()
    } else if hours < 22 {
        format!("{hours} hours")
    } else if days <= 1 {
        "a day".to_string()
    } else if days < 26 {
        format!("{days} days")
    } else if months <= 1 {
        "a month".to_string()
    } else if months < 11 {
        format!("{months} months")
    } else if years <= 1 {
        "a year".to_string()
    } else {
        format!("{years} years")
    };
    if difference > 0 { format!("in {phrase}") } else { format!("{phrase} ago") }
}
```

`Weekday::to_sunday_zero_offset` returns an `i8`; the `as u8` before `usize::from` is that conversion. If a jiff accessor's integer type differs in the resolved 0.2.x (they are `i16` year, `i8` month/day/hour/minute/second, `i16` millisecond, `i16` day_of_year in 0.2.37), convert with `i32::from` at the use site as shown; nothing else changes.

- [ ] **Step 5: Write the date functions and route them**

Create `crates/vault-bases/src/functions/date.rs`:

```rust
use crate::dates::{add, format_date, parse_date_text, parse_duration_text, relative, start_of_day, zoned};
use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::{BinaryOp, Expr};
use crate::value::{DateValue, DurationValue, Value};

use super::{arity, eager};

pub(crate) const GLOBALS: &[&str] = &["date", "duration", "now", "today"];
pub(crate) const METHODS: &[&str] = &["date", "format", "time", "relative", "isEmpty"];
pub(crate) const FIELDS: &[&str] = &["year", "month", "day", "hour", "minute", "second", "millisecond"];

pub(crate) fn call_global(name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    match name {
        "now" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Date(DateValue { epoch_ms: ctx.clock.now_ms, has_time: true }))
        }
        "today" => {
            arity(name, args, 0, 0)?;
            Ok(Value::Date(start_of_day(ctx.clock.now_ms, ctx.clock)))
        }
        "date" => match eager(args, ctx, scope)?.as_slice() {
            [Value::String(text)] => parse_date_text(text, ctx.clock)
                .map(Value::Date)
                .ok_or_else(|| EvalError::Argument(format!("{text:?} is not a date"))),
            [Value::Date(date)] => Ok(Value::Date(*date)),
            _ => Err(EvalError::Argument("date takes one string".into())),
        },
        "duration" => match eager(args, ctx, scope)?.as_slice() {
            [Value::String(text)] => parse_duration_text(text)
                .map(Value::Duration)
                .ok_or_else(|| EvalError::Argument(format!("{text:?} is not a duration"))),
            [Value::Duration(duration)] => Ok(Value::Duration(*duration)),
            _ => Err(EvalError::Argument("duration takes one string".into())),
        },
        _ => Err(EvalError::UnknownFunction(name.to_string())),
    }
}

pub(crate) fn field(date: DateValue, name: &str, ctx: &EvalContext<'_>) -> Result<Value, EvalError> {
    let at = zoned(date, ctx.clock);
    Ok(Value::Number(match name {
        "year" => f64::from(at.year()),
        "month" => f64::from(at.month()),
        "day" => f64::from(at.day()),
        "hour" => f64::from(at.hour()),
        "minute" => f64::from(at.minute()),
        "second" => f64::from(at.second()),
        "millisecond" => f64::from(at.millisecond()),
        _ => return Err(EvalError::NoSuchField { target: "date", name: name.to_string() }),
    }))
}

pub(crate) fn call(date: DateValue, name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    match name {
        "date" => Ok(Value::Date(start_of_day(date.epoch_ms, ctx.clock))),
        "format" => match eager(args, ctx, scope)?.as_slice() {
            [Value::String(format)] => format_date(date, format, ctx.clock).map(Value::String),
            _ => Err(EvalError::Argument("format takes one format string".into())),
        },
        "time" => {
            arity(name, args, 0, 0)?;
            format_date(date, "HH:mm:ss", ctx.clock).map(Value::String)
        }
        "relative" => {
            arity(name, args, 0, 0)?;
            Ok(Value::String(relative(date, ctx.clock)))
        }
        "isEmpty" => Ok(Value::Boolean(false)),
        _ => Err(EvalError::NoSuchMethod { target: "date", name: name.to_string() }),
    }
}

fn as_duration(value: &Value) -> Option<DurationValue> {
    match value {
        Value::Duration(duration) => Some(*duration),
        Value::String(text) => parse_duration_text(text),
        _ => None,
    }
}

/// Every arithmetic form with a date or a duration in it. `Ok(None)` means
/// "not a date operation" and hands the pair back to plain arithmetic.
pub(crate) fn arithmetic(op: BinaryOp, left: &Value, right: &Value, ctx: &EvalContext<'_>) -> Result<Option<Value>, EvalError> {
    let date_plus = |date: DateValue, value: &Value, sign: i64| -> Result<Option<Value>, EvalError> {
        match as_duration(value) {
            Some(duration) => add(date, duration, sign, ctx.clock).map(|moved| Some(Value::Date(moved))),
            None => match value {
                Value::String(text) => Err(EvalError::Argument(format!("{text:?} is not a duration"))),
                _ => Ok(None),
            },
        }
    };
    match (op, left, right) {
        (BinaryOp::Add, Value::Date(date), other) => date_plus(*date, other, 1),
        (BinaryOp::Sub, Value::Date(a), Value::Date(b)) => Ok(Some(Value::Duration(DurationValue {
            months: 0,
            ms: a.epoch_ms - b.epoch_ms,
        }))),
        (BinaryOp::Sub, Value::Date(date), other) => date_plus(*date, other, -1),
        (BinaryOp::Add, Value::Duration(a), Value::Duration(b)) => Ok(Some(Value::Duration(DurationValue {
            months: a.months + b.months,
            ms: a.ms + b.ms,
        }))),
        (BinaryOp::Sub, Value::Duration(a), Value::Duration(b)) => Ok(Some(Value::Duration(DurationValue {
            months: a.months - b.months,
            ms: a.ms - b.ms,
        }))),
        (BinaryOp::Mul, Value::Duration(duration), Value::Number(factor)) => Ok(Some(Value::Duration(DurationValue {
            months: (duration.months as f64 * factor).round() as i64,
            ms: (duration.ms as f64 * factor).round() as i64,
        }))),
        // The functions page: "the duration must be on the left".
        (BinaryOp::Mul, Value::Number(_), Value::Duration(_)) => Err(EvalError::Argument(
            "a duration must be on the left of `*`: write duration(…) * n".into(),
        )),
        _ => Ok(None),
    }
}
```

In `crates/vault-bases/src/functions/mod.rs`:

- add `mod date;` to the module list;
- replace `typed_property` with:

```rust
/// A property value with its declared type applied: a date- or
/// datetime-typed property's text becomes a date (text that does not parse
/// stays text, as Obsidian shows it). Task 6 adds frontmatter links.
pub(crate) fn typed_property(ctx: &EvalContext<'_>, key: &str, value: &PropertyValue) -> Value {
    let plain = property_value(value);
    match (ctx.source.property_type(key), &plain) {
        (Some(PropertyType::Date | PropertyType::DateTime), Value::String(text)) => {
            crate::dates::parse_date_text(text, ctx.clock).map(Value::Date).unwrap_or(plain)
        }
        _ => plain,
    }
}
```

  with `use crate::source::PropertyType;` added to the imports;
- replace `date_arithmetic` with:

```rust
pub(crate) fn date_arithmetic(
    op: BinaryOp,
    left: &Value,
    right: &Value,
    ctx: &EvalContext<'_>,
) -> Result<Option<Value>, EvalError> {
    date::arithmetic(op, left, right, ctx)
}
```

- in `call_global`, before the final `Err`, add:

```rust
    if date::GLOBALS.contains(&name) {
        return date::call_global(name, args, ctx, scope);
    }
```

- in `call_method`, add the arm `Value::Date(date) => date::call(date, name, args, ctx, scope),` above `other =>`;
- in `field`, add the arm `Value::Date(date) => date::field(*date, name, ctx),` above `other =>`, and rename the `_ctx` parameter to `ctx`;
- `is_known_global` becomes `global::GLOBALS.contains(&name) || date::GLOBALS.contains(&name)`, and `date::METHODS` joins the array in `is_known_method`.

`date::FIELDS` carries the same `#[allow(dead_code, reason = "the family's published field list; no reader in this phase")]` the string and list `FIELDS` carry.

Add `mod dates;` to `crates/vault-bases/src/lib.rs` and `pub use dates::format_date;` beside the other re-exports.

- [ ] **Step 6: Run the tests and see them pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test dates; echo "exit=$?"`

Expected: `test result: ok. 3 passed`, `exit=0`. If only `arith:exact_day_across_dst` fails, check that the zone database is present (`ls /usr/share/zoneinfo/America/New_York`): `jiff::tz::TimeZone::get` reads the system database, and a machine without it fails `Clock::fixed` loudly rather than silently using UTC.

- [ ] **Step 7: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-bases; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check -p vault-bases; echo "exit=$?"
```

Expected: `exit=0` four times.

- [ ] **Step 8: Commit**

```bash
git add crates/vault-bases
git commit -F - <<'COMMIT'
feat(bases): dates, durations, Moment formatting and relative()

date(), duration(), now() and today(), the seven date fields, and the date methods date, format, time, relative and isEmpty. Months and years are calendar arithmetic and the smaller units exact milliseconds, as the syntax page states both; whole days on a date without a time keep it on the calendar. format() implements the Moment tokens and names any other; relative() is Moment's fromNow with its default thresholds. Date-typed properties become dates.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 6: Files and links — the `file` fields and methods, `link()`, `file()`, `asFile`, `linksTo`, frontmatter links, and `this`

Every row is a file. This task gives the `File` value its fields (the functions page's eleven, plus the syntax page's `backlinks`, `embeds` and `file`) and methods, gives the `Link` value its two methods, adds the global `link()` and `file()`, and turns wikilinks written in frontmatter into `Link` values ("Wikilinks in frontmatter properties are automatically recognized as Link objects"). `this` (Task 3) is already the embedding note's `File`; this task proves `this.file.*`, `file.hasLink(this.file)`, `author == this` and `authors.contains(this)` against it.

**Files:**

- Create: `crates/vault-bases/src/functions/file.rs`, `crates/vault-bases/src/functions/link.rs`
- Modify: `crates/vault-bases/src/functions/mod.rs` (dispatch; `typed_property` gains the row), `crates/vault-bases/src/eval/mod.rs` (the two `typed_property` call sites), `crates/vault-bases/src/fixtures.rs` (the capture vault grows)
- Create: `crates/vault-bases/tests/files_and_links.rs`, `crates/vault-bases/tests/fixtures/captures/file.jsonl`, `crates/vault-bases/tests/fixtures/captures/link.jsonl`

**Interfaces:**

- Consumes: `RowSource::{facts, properties, tags, links, embeds, backlinks, resolve}`, `FileFacts`, `LinkFact`, `LinkValue`, `DateValue`, `coerce::strict_equals`, `functions::{eager, arity, typed_property}`, `fixtures::check_family`.
- Produces: `typed_property(ctx: &EvalContext<'_>, row: Option<&VaultPath>, key: &str, value: &PropertyValue) -> Value` (signature widened); `functions::file::{FIELDS, METHODS}`, `functions::link::{GLOBALS, METHODS}`; `fixtures::capture_vault(props: &[(String, PropertyValue)]) -> MemorySource` (the fixed vault every family row runs against from here on, with `props` on `Capture.md`).

**This task's checklist:** global `link()`, `file()`; link methods `asFile`, `linksTo`; file fields `name`, `basename`, `path`, `folder`, `ext`, `size`, `properties`, `tags`, `links`, `ctime`, `mtime`, and from the syntax page `backlinks`, `embeds`, `file`; file methods `asLink`, `hasLink`, `hasProperty`, `hasTag`, `inFolder`; frontmatter links; `this`.

New uncaptured cases: `folder:root` (the folder of a file at the vault root: `""` or `"/"`), `tags:spelling` (whether `file.tags` items carry their `#`), `hasLink:embed` (whether an embed counts as a link for `hasLink`), `file:missing` (what `file()` answers for a path that names nothing). Each answers `Uncaptured` only when the case actually arises — a root note's other fields, a note with no tags, and a `hasLink` that a plain link already satisfies all answer normally.

Two published rules decide behaviour here and are cited where they are used: tags compare case-insensitively (Obsidian's Tags help: tags are case-insensitive) and match nested tags (the functions page: `hasTag("tag1")` "also includes any nested tags, such as `#tag1/a`"); `inFolder` is "the specified folder or one of its sub-folders".

- [ ] **Step 1: Grow the capture vault**

In `crates/vault-bases/src/fixtures.rs`, add above `check_family`:

```rust
/// The vault every capture row runs against, from Task 6 on. `Capture.md`
/// is the row (and `this`); the others exist to be linked, embedded and
/// listed. A row's `props` are added to `Capture.md`.
pub fn capture_vault(props: &[(String, PropertyValue)]) -> MemorySource {
    let mut capture = MemoryFile::note()
        .times(FIXTURE_NOW_MS - 86_400_000, FIXTURE_NOW_MS - 3_600_000)
        .size(42)
        .tag("book")
        .tag("Project/Active")
        .link("Other")
        .link("Missing")
        .embed("Folder/image.png");
    for (key, value) in props {
        capture = capture.property(key, value.clone());
    }
    MemorySource::new()
        .with("Capture.md", capture)
        .with(
            "Other.md",
            MemoryFile::note().property("status", crate::source::text("done")).link("Capture"),
        )
        .with("Folder/image.png", MemoryFile::attachment(1000))
        .with("Folder/Deep/Inner.md", MemoryFile::note())
}
```

and in `check_family`, replace the seven lines that build `note` and `source` (from `let mut note = MemoryFile::note()` through `.with("Other.md", MemoryFile::note());`) with:

```rust
        let source = capture_vault(&row.props);
```

Every earlier family keeps passing: none of their rows reads a file fact, a tag or a link.

- [ ] **Step 2: Write the fixture files**

Create `crates/vault-bases/tests/fixtures/captures/file.jsonl` (the row and `this` are `Capture.md`):

```json
{"family":"file","case":"name","expr":"file.name","kind":"string","text":"Capture.md","source":"published"}
{"family":"file","case":"basename","expr":"file.basename","kind":"string","text":"Capture","source":"published"}
{"family":"file","case":"path","expr":"file.path","kind":"string","text":"Capture.md","source":"published"}
{"family":"file","case":"folder:root","expr":"file.folder","kind":"error","source":"uncaptured"}
{"family":"file","case":"ext","expr":"file.ext","kind":"string","text":"md","source":"published"}
{"family":"file","case":"ext_filter","expr":"file.ext == \"md\"","kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"size","expr":"file.size","kind":"number","text":"42","source":"published"}
{"family":"file","case":"ctime","expr":"file.ctime.format(\"YYYY-MM-DD HH:mm\")","kind":"string","text":"2026-01-14 10:30","source":"published"}
{"family":"file","case":"mtime_within_week","expr":"file.mtime > now() - \"1 week\"","kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"age","expr":"now() - file.ctime","kind":"duration","text":"86400000","source":"published"}
{"family":"file","case":"properties","expr":"file.properties.keys()","props":{"a":1,"b":2},"kind":"list","text":"a, b","source":"published"}
{"family":"file","case":"tags:spelling","expr":"file.tags","kind":"error","source":"uncaptured"}
{"family":"file","case":"links","expr":"file.links.length","kind":"number","text":"2","source":"published"}
{"family":"file","case":"links_resolve","expr":"file.links[0].asFile().path","kind":"string","text":"Other.md","source":"published"}
{"family":"file","case":"embeds","expr":"file.embeds.length","kind":"number","text":"1","source":"published"}
{"family":"file","case":"backlinks","expr":"file.backlinks[0].name","kind":"string","text":"Other.md","source":"published"}
{"family":"file","case":"file_field","expr":"file.file.path","kind":"string","text":"Capture.md","source":"published"}
{"family":"file","case":"asLink","expr":"file.asLink()","kind":"link","text":"Capture.md","source":"published"}
{"family":"file","case":"asLink:display","expr":"file.asLink(\"Display\")","kind":"link","text":"Display","source":"published"}
{"family":"file","case":"hasLink:string","expr":"file.hasLink(\"Other\")","kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"hasLink:link","expr":"file.hasLink(link(\"Other\"))","kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"hasLink:absent","expr":"file.hasLink(\"Folder/Deep/Inner.md\")","kind":"boolean","text":"false","source":"published"}
{"family":"file","case":"hasLink:embed","expr":"file.hasLink(\"Folder/image.png\")","kind":"error","source":"uncaptured"}
{"family":"file","case":"hasLink:this","expr":"file.hasLink(this.file)","kind":"boolean","text":"false","source":"published"}
{"family":"file","case":"hasProperty","expr":"file.hasProperty(\"a\")","props":{"a":1},"kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"hasProperty:absent","expr":"file.hasProperty(\"b\")","props":{"a":1},"kind":"boolean","text":"false","source":"published"}
{"family":"file","case":"hasTag","expr":"file.hasTag(\"book\")","kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"hasTag:case","expr":"file.hasTag(\"BOOK\")","kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"hasTag:nested","expr":"file.hasTag(\"project\")","kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"hasTag:prefix_is_not_nesting","expr":"file.hasTag(\"proj\")","kind":"boolean","text":"false","source":"published"}
{"family":"file","case":"hasTag:any_of","expr":"file.hasTag(\"tag1\", \"#book\")","kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"inFolder:not","expr":"file.inFolder(\"Folder\")","kind":"boolean","text":"false","source":"published"}
{"family":"file","case":"this_name","expr":"this.file.name","kind":"string","text":"Capture.md","source":"published"}
{"family":"file","case":"frontmatter_link_equals_this","expr":"author == this","props":{"author":"[[Capture]]"},"kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"frontmatter_links_contain_this","expr":"authors.contains(this)","props":{"authors":["[[Other]]","[[Capture]]"]},"kind":"boolean","text":"true","source":"published"}
{"family":"file","case":"frontmatter_link_display","expr":"author","props":{"author":"[[Other|The other]]"},"kind":"link","text":"The other","source":"published"}
```

Create `crates/vault-bases/tests/fixtures/captures/link.jsonl`:

```json
{"family":"link","case":"link","expr":"link(\"Other\")","kind":"link","text":"Other","source":"published"}
{"family":"link","case":"link:display","expr":"link(\"Other\", \"display\")","kind":"link","text":"display","source":"published"}
{"family":"link","case":"link:icon_display","expr":"link(\"Other\", icon(\"plus\"))","kind":"link","text":"plus","source":"published"}
{"family":"link","case":"link:url","expr":"link(\"https://obsidian.md\")","kind":"link","text":"https://obsidian.md","source":"published"}
{"family":"link","case":"link:from_date_string","expr":"link(file.ctime.date().toString())","kind":"error","source":"uncaptured"}
{"family":"link","case":"asFile","expr":"link(\"[[Other]]\").asFile().path","kind":"string","text":"Other.md","source":"published"}
{"family":"link","case":"asFile:unresolved","expr":"link(\"Nowhere\").asFile()","kind":"null","text":"","source":"published"}
{"family":"link","case":"asFile:url","expr":"link(\"https://obsidian.md\").asFile()","kind":"null","text":"","source":"published"}
{"family":"link","case":"linksTo","expr":"link(\"Other\").linksTo(this)","kind":"boolean","text":"true","source":"published"}
{"family":"link","case":"linksTo:not","expr":"link(\"Other\").linksTo(file(\"Folder/image.png\"))","kind":"boolean","text":"false","source":"published"}
{"family":"link","case":"file:from_link","expr":"file(link(\"[[Other]]\")).path","kind":"string","text":"Other.md","source":"published"}
{"family":"link","case":"file:from_path","expr":"file(\"Other.md\").name","kind":"string","text":"Other.md","source":"published"}
{"family":"link","case":"file:missing","expr":"file(\"path to file\")","kind":"error","source":"uncaptured"}
{"family":"link","case":"equal:same_file","expr":"link(\"Other\") == link(\"[[Other]]\")","kind":"boolean","text":"true","source":"published"}
{"family":"link","case":"equal:unresolved_same_text","expr":"link(\"Nowhere\") == link(\"Nowhere\")","kind":"boolean","text":"true","source":"published"}
{"family":"link","case":"equal:file","expr":"link(\"Other\") == file(\"Other.md\")","kind":"boolean","text":"true","source":"published"}
```

- [ ] **Step 3: Write the failing test**

Create `crates/vault-bases/tests/files_and_links.rs`:

```rust
use vault_bases::eval::{EvalContext, Scope, evaluate};
use vault_bases::expr::parse_expression;
use vault_bases::fixtures::{FIXTURE_NOW_MS, FIXTURE_ZONE, capture_vault, check_family};
use vault_bases::{Clock, Value};
use vault_core::VaultPath;

fn assert_family(family: &str) {
    let failures = check_family(family);
    assert!(failures.is_empty(), "{} {family} rows disagree:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn file_fields_and_methods() {
    assert_family("file");
}

#[test]
fn link_functions() {
    assert_family("link");
}

fn on_row(row: &str, expression: &str) -> Value {
    let source = capture_vault(&[]);
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let row = VaultPath::new(row).unwrap();
    let base = VaultPath::new("Captures.base").unwrap();
    let this = VaultPath::new("Capture.md").unwrap();
    let ctx = EvalContext::new(&source, &clock, &base, &this);
    evaluate(&parse_expression(expression).unwrap(), &ctx, &Scope::row(&row)).unwrap()
}

#[test]
fn in_folder_means_the_folder_or_a_subfolder_and_nothing_that_only_shares_a_prefix() {
    let inner = "Folder/Deep/Inner.md";
    assert_eq!(on_row(inner, r#"file.inFolder("Folder")"#), Value::Boolean(true));
    assert_eq!(on_row(inner, r#"file.inFolder("Folder/Deep")"#), Value::Boolean(true));
    assert_eq!(on_row(inner, r#"file.inFolder("Folder/Deep/")"#), Value::Boolean(true));
    assert_eq!(on_row(inner, r#"file.inFolder("Fold")"#), Value::Boolean(false));
    assert_eq!(on_row(inner, "file.folder"), Value::String("Folder/Deep".into()));
}

#[test]
fn an_attachment_is_a_row_with_file_facts_and_no_note_facts() {
    let image = "Folder/image.png";
    assert_eq!(on_row(image, "file.ext"), Value::String("png".into()));
    assert_eq!(on_row(image, "file.size"), Value::Number(1000.0));
    assert_eq!(on_row(image, "file.properties.isEmpty()"), Value::Boolean(true));
    assert_eq!(on_row(image, "file.tags"), Value::List(vec![]));
    assert_eq!(on_row(image, "file.backlinks.length"), Value::Number(1.0));
    assert_eq!(on_row(image, r#"file.hasTag("book")"#), Value::Boolean(false));
}
```

- [ ] **Step 4: Run it to see it fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test files_and_links; echo "exit=$?"`

Expected: rows fail with `file has no field name`, `unknown function link`; `exit=101`.

- [ ] **Step 5: Write the two families**

Create `crates/vault-bases/src/functions/link.rs`:

```rust
use vault_core::VaultPath;

use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::value::{LinkValue, Value};

use super::{arity, eager};

pub(crate) const GLOBALS: &[&str] = &["link", "file"];
pub(crate) const METHODS: &[&str] = &["asFile", "linksTo"];

/// `[[Target|Display]]` or `[[Target]]` as written in a property, else
/// `None`. The display half is kept; the subpath stays in the target text.
pub(crate) fn parse_wikilink(text: &str) -> Option<(String, Option<String>)> {
    let inner = text.trim().strip_prefix("[[")?.strip_suffix("]]")?;
    Some(match inner.split_once('|') {
        Some((target, display)) => (target.to_string(), Some(display.to_string())),
        None => (inner.to_string(), None),
    })
}

fn is_url(text: &str) -> bool {
    text.split_once("://").is_some_and(|(scheme, _)| !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.'))
}

/// A link value for `target` written in `from`: a URL never resolves; a
/// wikilink spelling has its brackets taken off before resolution.
pub(crate) fn make_link(
    ctx: &EvalContext<'_>,
    from: &VaultPath,
    target: &str,
    display: Option<Value>,
) -> Result<LinkValue, EvalError> {
    let (target, written_display) = match parse_wikilink(target) {
        Some((target, display)) => (target, display),
        None => (target.to_string(), None),
    };
    let resolved = if is_url(&target) { None } else { ctx.source.resolve(from, &target)? };
    Ok(LinkValue {
        target,
        display: display.or(written_display.map(Value::String)).map(Box::new),
        resolved,
    })
}

pub(crate) fn call_global(name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
    match name {
        // Resolved from the base file: a formula's link has no note of its own.
        "link" => {
            arity(name, args, 1, 2)?;
            let display = values.get(1).cloned();
            match &values[0] {
                Value::String(target) => Ok(Value::Link(make_link(ctx, ctx.base_path, target, display)?)),
                Value::File(path) => Ok(Value::Link(LinkValue {
                    target: path.as_str().to_string(),
                    display: display.map(Box::new),
                    resolved: Some(path.clone()),
                })),
                other => Err(EvalError::Argument(format!("link takes a path or a file, not {}", other.type_name()))),
            }
        }
        "file" => {
            arity(name, args, 1, 1)?;
            match &values[0] {
                Value::File(path) => Ok(Value::File(path.clone())),
                Value::Link(link) => link
                    .resolved
                    .clone()
                    .map(Value::File)
                    .ok_or_else(|| EvalError::Uncaptured("file:missing".into())),
                Value::String(spelling) => {
                    let exact = VaultPath::new(spelling.as_str()).ok().filter(|path| {
                        ctx.source.facts(path).ok().flatten().is_some()
                    });
                    let found = match exact {
                        Some(path) => Some(path),
                        None => make_link(ctx, ctx.base_path, spelling, None)?.resolved,
                    };
                    found.map(Value::File).ok_or_else(|| EvalError::Uncaptured("file:missing".into()))
                }
                other => Err(EvalError::Argument(format!("file takes a path, a link or a file, not {}", other.type_name()))),
            }
        }
        _ => Err(EvalError::UnknownFunction(name.to_string())),
    }
}

pub(crate) fn call(link: &LinkValue, name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    match name {
        "asFile" => {
            arity(name, args, 0, 0)?;
            Ok(link.resolved.clone().map(Value::File).unwrap_or(Value::Null))
        }
        // The functions page: true "if the file represented by link has a
        // link to file".
        "linksTo" => {
            arity(name, args, 1, 1)?;
            let Some(from) = &link.resolved else {
                return Ok(Value::Boolean(false));
            };
            let wanted = match eager(args, ctx, scope)?.into_iter().next() {
                Some(Value::File(path)) => Some(path),
                Some(Value::Link(other)) => other.resolved,
                Some(Value::String(spelling)) => ctx.source.resolve(from, &spelling)?,
                _ => return Err(EvalError::Argument("linksTo takes a file".into())),
            };
            let Some(wanted) = wanted else {
                return Ok(Value::Boolean(false));
            };
            Ok(Value::Boolean(
                ctx.source.links(from)?.iter().any(|fact| fact.resolved.as_ref() == Some(&wanted)),
            ))
        }
        _ => Err(EvalError::NoSuchMethod { target: "link", name: name.to_string() }),
    }
}
```

Create `crates/vault-bases/src/functions/file.rs`:

```rust
use vault_core::VaultPath;

use crate::eval::{EvalContext, EvalError, Scope};
use crate::expr::Expr;
use crate::source::{FileKind, LinkFact, extension};
use crate::value::{DateValue, LinkValue, Value};

use super::{arity, eager, typed_property};

pub(crate) const METHODS: &[&str] = &["asLink", "hasLink", "hasProperty", "hasTag", "inFolder"];
#[allow(dead_code, reason = "the family's published field list; no reader in this phase")]
pub(crate) const FIELDS: &[&str] = &[
    "name", "basename", "path", "folder", "ext", "size", "properties", "tags", "links", "ctime",
    "mtime", "backlinks", "embeds", "file",
];

fn link_values(facts: Vec<LinkFact>) -> Value {
    Value::List(
        facts
            .into_iter()
            .map(|fact| {
                Value::Link(LinkValue {
                    target: fact.raw_target,
                    display: fact.display.map(|display| Box::new(Value::String(display))),
                    resolved: fact.resolved,
                })
            })
            .collect(),
    )
}

/// Whether `tag` is `wanted` or a nested tag under it, ignoring case — tags
/// are case-insensitive in Obsidian, and the functions page says `hasTag`
/// "also includes any nested tags".
fn tag_matches(tag: &str, wanted: &str) -> bool {
    let tag = tag.trim_start_matches('#').to_lowercase();
    let wanted = wanted.trim_start_matches('#').to_lowercase();
    tag == wanted || tag.starts_with(&format!("{wanted}/"))
}

pub(crate) fn field(path: &VaultPath, name: &str, ctx: &EvalContext<'_>) -> Result<Value, EvalError> {
    let facts = || -> Result<_, EvalError> {
        ctx.source
            .facts(path)?
            .ok_or_else(|| EvalError::Type(format!("{} is not in the vault", path.as_str())))
    };
    Ok(match name {
        "file" => Value::File(path.clone()),
        "path" => Value::String(path.as_str().to_string()),
        "name" => Value::String(path.name().to_string()),
        "basename" => {
            let file_name = path.name();
            Value::String(match file_name.rfind('.') {
                Some(dot) if dot > 0 => file_name[..dot].to_string(),
                _ => file_name.to_string(),
            })
        }
        "ext" => Value::String(extension(path).to_string()),
        "folder" => match path.as_str().rsplit_once('/') {
            Some((folder, _)) => Value::String(folder.to_string()),
            None => return Err(EvalError::Uncaptured("folder:root".into())),
        },
        "size" => Value::Number(facts()?.size as f64),
        "ctime" => Value::Date(DateValue { epoch_ms: facts()?.ctime_ms, has_time: true }),
        "mtime" => Value::Date(DateValue { epoch_ms: facts()?.mtime_ms, has_time: true }),
        "properties" => Value::Object(
            ctx.source
                .properties(path)?
                .iter()
                .map(|(key, value)| (key.clone(), typed_property(ctx, Some(path), key, value)))
                .collect(),
        ),
        "tags" => {
            let tags = ctx.source.tags(path)?;
            if !tags.is_empty() {
                return Err(EvalError::Uncaptured("tags:spelling".into()));
            }
            Value::List(Vec::new())
        }
        "links" => link_values(ctx.source.links(path)?),
        "embeds" => link_values(ctx.source.embeds(path)?),
        "backlinks" => Value::List(ctx.source.backlinks(path)?.into_iter().map(Value::File).collect()),
        _ => return Err(EvalError::NoSuchField { target: "file", name: name.to_string() }),
    })
}

fn target_path(ctx: &EvalContext<'_>, from: &VaultPath, value: Value) -> Result<Option<VaultPath>, EvalError> {
    Ok(match value {
        Value::File(path) => Some(path),
        Value::Link(link) => link.resolved,
        Value::String(spelling) => ctx.source.resolve(from, &spelling)?,
        other => return Err(EvalError::Argument(format!("expected a file or a path, not {}", other.type_name()))),
    })
}

pub(crate) fn call(path: &VaultPath, name: &str, args: &[Expr], ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
    let values = eager(args, ctx, scope)?;
    Ok(match name {
        "asLink" => {
            arity(name, args, 0, 1)?;
            Value::Link(LinkValue {
                target: path.as_str().to_string(),
                display: values.into_iter().next().map(Box::new),
                resolved: Some(path.clone()),
            })
        }
        "hasLink" => {
            arity(name, args, 1, 1)?;
            let Some(wanted) = target_path(ctx, path, values.into_iter().next().expect("one argument"))? else {
                return Ok(Value::Boolean(false));
            };
            let reaches = |facts: Vec<LinkFact>| facts.iter().any(|fact| fact.resolved.as_ref() == Some(&wanted));
            if reaches(ctx.source.links(path)?) {
                Value::Boolean(true)
            } else if reaches(ctx.source.embeds(path)?) {
                return Err(EvalError::Uncaptured("hasLink:embed".into()));
            } else {
                Value::Boolean(false)
            }
        }
        "hasProperty" => match values.as_slice() {
            [Value::String(key)] => Value::Boolean(ctx.source.properties(path)?.iter().any(|(have, _)| have == key)),
            _ => return Err(EvalError::Argument("hasProperty takes one property name".into())),
        },
        "hasTag" => {
            let wanted: Vec<String> = values
                .into_iter()
                .map(|value| match value {
                    Value::String(tag) => Ok(tag),
                    other => Err(EvalError::Argument(format!("hasTag takes tag names, not {}", other.type_name()))),
                })
                .collect::<Result<_, _>>()?;
            let tags = ctx.source.tags(path)?;
            Value::Boolean(tags.iter().any(|tag| wanted.iter().any(|want| tag_matches(tag, want))))
        }
        "inFolder" => match values.as_slice() {
            [Value::String(folder)] => {
                let folder = folder.trim_matches('/');
                Value::Boolean(folder.is_empty() || path.as_str().starts_with(&format!("{folder}/")))
            }
            _ => return Err(EvalError::Argument("inFolder takes one folder path".into())),
        },
        _ => return Err(EvalError::NoSuchMethod { target: "file", name: name.to_string() }),
    })
}

/// Whether a row is a note, for the row's `kind`.
pub(crate) fn kind_of(ctx: &EvalContext<'_>, path: &VaultPath) -> Result<FileKind, EvalError> {
    Ok(ctx.source.facts(path)?.map_or(FileKind::File, |facts| facts.kind))
}
```

`kind_of` is read by Task 7's view evaluation; until then it carries `#[allow(dead_code, reason = "read by view::evaluate_view from Task 7")]`, which Task 7 deletes.

- [ ] **Step 6: Route them, and give `typed_property` the row**

In `crates/vault-bases/src/functions/mod.rs`:

- add `pub(crate) mod file;` and `mod link;` to the module list (`file` is `pub(crate)` because `view` reads `file::kind_of`);
- replace `typed_property` with:

```rust
/// A property value with its declared type applied, and with every wikilink
/// written in frontmatter as a `Link` — the syntax page: "Wikilinks in
/// frontmatter properties are automatically recognized as Link objects."
/// Links resolve from `row`, the note that wrote them.
pub(crate) fn typed_property(
    ctx: &EvalContext<'_>,
    row: Option<&VaultPath>,
    key: &str,
    value: &PropertyValue,
) -> Value {
    fn links_in(ctx: &EvalContext<'_>, row: Option<&VaultPath>, value: Value) -> Value {
        match value {
            Value::String(text) => match (row, link::parse_wikilink(&text)) {
                (Some(row), Some(_)) => link::make_link(ctx, row, &text, None)
                    .map(Value::Link)
                    .unwrap_or(Value::String(text)),
                _ => Value::String(text),
            },
            Value::List(items) => Value::List(items.into_iter().map(|item| links_in(ctx, row, item)).collect()),
            other => other,
        }
    }
    let plain = property_value(value);
    match (ctx.source.property_type(key), &plain) {
        (Some(PropertyType::Date | PropertyType::DateTime), Value::String(text)) => {
            crate::dates::parse_date_text(text, ctx.clock).map(Value::Date).unwrap_or(plain)
        }
        _ => links_in(ctx, row, plain),
    }
}
```

  adding `use vault_core::VaultPath;` to the imports;
- in `call_global`, before the final `Err`, add:

```rust
    if link::GLOBALS.contains(&name) {
        return link::call_global(name, args, ctx, scope);
    }
```

- in `call_method`, add the arms `Value::File(path) => file::call(&path, name, args, ctx, scope),` and `Value::Link(link) => link::call(&link, name, args, ctx, scope),` above `other =>`;
- in `field`, add `Value::File(path) => file::field(path, name, ctx),` above `other =>`;
- `is_known_global` adds `|| link::GLOBALS.contains(&name)`; `is_known_method`'s array adds `file::METHODS` and `link::METHODS`.

In `crates/vault-bases/src/eval/mod.rs`, the two call sites become `functions::typed_property(ctx, scope.row.as_ref(), key, value)` (in `row_property`, with `key` the looked-up key) and `functions::typed_property(ctx, Some(row), key, value)` (in the `note` identifier arm).

- [ ] **Step 7: Run the tests and see them pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test files_and_links; echo "exit=$?"`

Expected: `test result: ok. 4 passed`, `exit=0`.

- [ ] **Step 8: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-bases; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check -p vault-bases; echo "exit=$?"
```

Expected: `exit=0` four times; the whole crate suite, every earlier family included, stays green on the grown capture vault.

- [ ] **Step 9: Commit**

```bash
git add crates/vault-bases
git commit -F - <<'COMMIT'
feat(bases): file fields and methods, links, link() and file(), and this

Every row is a file: the File value gains the functions page's eleven fields plus backlinks, embeds and file from the syntax page, and asLink, hasLink, hasProperty, hasTag and inFolder. Links gain asFile and linksTo; link() and file() land; frontmatter wikilinks become Link values that equal the file they resolve to, so author == this and authors.contains(this) hold. Tags compare case-insensitively with nesting. Four cases no published rule settles answer Uncaptured by name.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 7: Views — compile, prefilters, filters, memoized formulas, sort, groupBy, limit, summaries

A view is compiled once per evaluation (find it, combine the global and view filters as one conjunction, parse every expression the view reads, refuse unknown functions, extract prefilters) and evaluated in the spec's order: prefilters, then the filters, then formulas memoized per row, then `sort` (stable), then `limit`, then `groupBy`, then summaries over the surviving rows. A cell that fails is an error cell and its row stays. Every view type — `table`, `cards`, `list`, `kanban`, `map`, and a plugin's `fileclass-table` — evaluates to the same row data; the declared options travel with it uninterpreted.

**Files:**

- Create: `crates/vault-bases/src/view/mod.rs`, `crates/vault-bases/src/view/prefilter.rs`, `crates/vault-bases/src/view/summary.rs`
- Modify: `crates/vault-bases/src/lib.rs` (`pub mod view;`), `crates/vault-bases/src/functions/file.rs` (delete the `#[allow(dead_code, …)]` on `kind_of`, which `evaluate_view` now reads; every `FIELDS` allow stays)
- Create: `crates/vault-bases/tests/views.rs`, `crates/vault-bases/tests/ordering_properties.rs`

**Interfaces:**

- Consumes: `BaseFile`, `ViewDecl`, `FilterNode`, `SortKey`, `Direction`, `GroupBy`, `PropertySettings` (Task 1); `Expr`, `parse_expression`, `ExpressionError` (Task 2); `RowSource`, `Prefilter`, `ScalarLiteral`, `FileKind`, `EvalContext`, `Formulas`, `Scope`, `evaluate`, `EvalError`, `coerce::{truthy, sort_order, strict_equals}`, `functions::{is_known_global, is_known_method}`, `eval::row_property` (Task 3); `functions::file::{field, kind_of}` (Task 6).
- Produces:

```rust
pub mod view {
    pub enum PropertyRef { File(String), Formula(String), Note(String) }
    pub fn property_ref(key: &str) -> PropertyRef;
    #[derive(Clone, Debug, PartialEq)] pub struct ColumnDecl { pub property: String, pub display_name: Option<String>, pub settings: Vec<(String, vault_core::PropertyValue)> }
    #[derive(Clone, Debug, PartialEq)] pub enum CompileError {
        ViewNotFound { declared: Vec<String> },
        ExpressionInvalid { expression: String, message: String, position: usize },
        UnsupportedFunction { name: String },
    }
    #[derive(Clone, Debug, Default, PartialEq)] pub struct ViewDependencies { pub prefilters: Vec<Prefilter>, pub reads_formulas: bool, pub reads_links: bool, pub reads_backlinks: bool, pub reads_this: bool, pub reads_properties: bool }
    pub struct CompiledView { /* … */ }
    impl CompiledView { pub fn decl(&self) -> &ViewDecl; pub fn columns(&self) -> &[ColumnDecl]; pub fn prefilters(&self) -> &[Prefilter]; pub fn dependencies(&self) -> &ViewDependencies; #[doc(hidden)] pub fn without_prefilters(&self) -> CompiledView; }
    pub fn compile_view(base: &BaseFile, view: Option<&str>) -> Result<CompiledView, CompileError>;
    pub type Cell = Result<Value, EvalError>;
    #[derive(Clone, Debug)] pub struct RowResult { pub path: VaultPath, pub kind: FileKind, pub group: Option<Cell>, pub cells: Vec<Cell> }
    #[derive(Clone, Debug)] pub struct SummaryResult { pub property: String, pub name: String, pub value: Cell }
    #[derive(Clone, Debug)] pub struct ViewResult { pub rows: Vec<RowResult>, pub summaries: Vec<SummaryResult>, pub total_rows: usize }
    pub fn evaluate_view(view: &CompiledView, ctx: &EvalContext<'_>) -> Result<ViewResult, SourceError>;
    pub const BUILTIN_SUMMARIES: [&str; 14];
}
```

**This task's checklist:** filters (`and`, `or`, `not` as "none of"), the global-and-view conjunction, formulas with memoization and cycle detection, `sort` (multi-key, stable, per-key direction), `limit` (after sort, before grouping), `groupBy` (direction), summaries — the syntax page's default summaries `Average`, `Min`, `Max`, `Sum`, `Range` (numbers and dates), `Median`, `Stddev`, `Earliest`, `Latest`, `Checked`, `Unchecked`, `Empty`, `Filled`, `Unique` — and custom summary formulas over `values`; the view types `table`, `cards`, `list`, `kanban`, `map` as row data plus declared options (the views page's layout table), and an unknown type kept as declared.

New uncaptured or capture-confirmed items for Task 13, named here so that task can find them: `filter:error_row` (a statement that errors is *unknown* — three-valued: `and` is false if any child is false, `or` is true if any child is true, `not` is false if any child is true, and unknown otherwise — and an unknown verdict excludes the row, inside `not` as anywhere else; provisional, the capture settles it), `sort:default` (with no `sort`, rows keep path order), `summary:stddev` (population standard deviation, the definition the syntax page's "standard deviation of all numbers" reads as; the capture confirms the divisor), `limit:before_group` (the spec's stated order, "as Obsidian does; the captures settle it").

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-bases/tests/views.rs`:

```rust
use vault_bases::eval::EvalContext;
use vault_bases::fixtures::{FIXTURE_NOW_MS, FIXTURE_ZONE};
use vault_bases::view::{CompileError, ViewResult, compile_view, evaluate_view};
use vault_bases::{
    Clock, FileKind, MemoryFile, MemorySource, Prefilter, ScalarLiteral, Value, number, parse_base, text,
};
use vault_core::VaultPath;

fn books() -> MemorySource {
    MemorySource::new()
        .with("Books/Dune.md", MemoryFile::note().tag("book").property("price", number(10.0)).property("age", number(2.0)).property("status", text("reading")))
        .with("Books/Emma.md", MemoryFile::note().tag("book").property("price", number(3.0)).property("age", number(1.0)).property("status", text("done")))
        .with("Books/Ulysses.md", MemoryFile::note().tag("book").property("price", number(30.0)).property("age", number(3.0)).property("status", text("queued")))
        .with("Required Reading/Kafka.md", MemoryFile::note().tag("book").property("price", number(8.0)).property("age", number(2.0)))
        .with("Notes/Textbook.md", MemoryFile::note().tag("tag"))
        .with("Notes/Lecture.md", MemoryFile::note().tag("book").link("Textbook").property("price", number(5.0)).property("age", number(1.0)))
        .with("Images/cover.png", MemoryFile::attachment(2048))
}

fn run(source: &MemorySource, base_yaml: &str, view: Option<&str>) -> ViewResult {
    let base = parse_base(base_yaml).expect("the base parses");
    let compiled = compile_view(&base, view).expect("the view compiles");
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let base_path = VaultPath::new("Books.base").unwrap();
    let ctx = EvalContext::new(source, &clock, &base_path, &base_path);
    evaluate_view(&compiled, &ctx).expect("the source answers")
}

fn paths(result: &ViewResult) -> Vec<&str> {
    result.rows.iter().map(|row| row.path.as_str()).collect()
}

fn cell(result: &ViewResult, row: usize, column: usize) -> Value {
    result.rows[row].cells[column].clone().expect("a value, not an error cell")
}

const SYNTAX_PAGE_EXAMPLE: &str = r#"filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
"#;

#[test]
fn the_syntax_page_example_evaluates() {
    let result = run(&books(), SYNTAX_PAGE_EXAMPLE, None);
    // Global filter: Textbook (#tag), Lecture (#book and links Textbook), the
    // attachment (neither #book nor in Required Reading). View filter: status
    // is not "done" (missing status is not "done"), and ppu > 5 or price > 2.1;
    // the attachment has no price, so `price > 2.1` compares null and errors,
    // and an erroring filter excludes the row (`filter:error_row`).
    assert_eq!(paths(&result), vec!["Notes/Lecture.md"]);
    assert_eq!(cell(&result, 0, 0), Value::String("Lecture.md".into()));
    assert_eq!(cell(&result, 0, 1), Value::String("md".into()));
    assert_eq!(cell(&result, 0, 2), Value::Number(1.0));
    assert_eq!(cell(&result, 0, 3), Value::String("5.00".into()));
    assert_eq!(cell(&result, 0, 4), Value::String("5.00 dollars".into()));
    assert_eq!(result.rows[0].kind, FileKind::Note);
    assert_eq!(result.rows[0].group.clone().unwrap().unwrap(), Value::Number(1.0));
    assert_eq!(result.summaries.len(), 1);
    assert_eq!(result.summaries[0].property, "formula.ppu");
    assert_eq!(result.summaries[0].name, "Average");
}

#[test]
fn sort_is_stable_multi_key_and_directional_and_limit_applies_before_grouping() {
    let yaml = "views:\n  - type: table\n    name: T\n    filters: 'file.hasTag(\"book\")'\n    order: [file.name, price]\n    sort:\n      - property: note.age\n        direction: DESC\n      - property: price\n        direction: ASC\n    limit: 3\n    groupBy:\n      property: note.age\n      direction: ASC\n";
    let result = run(&books(), yaml, None);
    // Sorted by age desc then price asc: Ulysses(3,30), Kafka(2,8), Dune(2,10),
    // Emma(1,3), Lecture(1,5). Limit 3 keeps the first three; grouping by age
    // ascending then puts the age-2 group before the age-3 group, keeping the
    // sorted order inside each group.
    assert_eq!(paths(&result), vec!["Required Reading/Kafka.md", "Books/Dune.md", "Books/Ulysses.md"]);
    assert_eq!(result.total_rows, 3);
}

#[test]
fn without_a_sort_rows_keep_path_order() {
    let result = run(&books(), "views:\n  - type: list\n    name: L\n    filters: 'file.inFolder(\"Books\")'\n", None);
    assert_eq!(paths(&result), vec!["Books/Dune.md", "Books/Emma.md", "Books/Ulysses.md"]);
}

#[test]
fn not_means_none_of_the_following() {
    let result = run(
        &books(),
        "views:\n  - type: table\n    name: T\n    filters:\n      not:\n        - file.hasTag(\"book\")\n        - file.ext == \"png\"\n",
        None,
    );
    assert_eq!(paths(&result), vec!["Notes/Textbook.md"]);
}

#[test]
fn an_error_inside_not_excludes_the_row() {
    // `price > 2` errors on the two files with no price; `not` must not turn
    // that error into an admitted row, and every priced note is over 2.
    let result = run(
        &books(),
        "views:\n  - type: table\n    name: T\n    filters:\n      not:\n        - 'price > 2'\n",
        None,
    );
    assert_eq!(paths(&result), Vec::<&str>::new());
}

#[test]
fn built_in_and_custom_summaries() {
    let yaml = "summaries:\n  rounded: 'values.mean().round(3)'\nviews:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [price, status, file.mtime]\n    summaries:\n      price: Average\n      status: Filled\n      note.price: rounded\n";
    let result = run(&books(), yaml, None);
    let summary = |property: &str| {
        result
            .summaries
            .iter()
            .find(|summary| summary.property == property)
            .unwrap_or_else(|| panic!("a summary for {property}"))
            .value
            .clone()
            .expect("a value")
    };
    assert_eq!(summary("price"), Value::Number(43.0 / 3.0));
    assert_eq!(summary("status"), Value::Number(3.0));
    assert_eq!(summary("note.price"), Value::Number(14.333));
}

#[test]
fn every_builtin_summary_has_a_definition() {
    let yaml = "views:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [price]\n    summaries:\n      price: Median\n";
    let result = run(&books(), yaml, None);
    assert_eq!(result.summaries[0].value.clone().unwrap(), Value::Number(10.0));
    for name in vault_bases::view::BUILTIN_SUMMARIES {
        let yaml = format!("views:\n  - type: table\n    name: T\n    order: [price]\n    summaries:\n      price: {name}\n");
        let base = parse_base(&yaml).unwrap();
        assert!(compile_view(&base, None).is_ok(), "{name} compiles");
    }
}

#[test]
fn a_cell_that_fails_is_an_error_cell_and_its_row_stays() {
    let yaml = "formulas:\n  broken: 'price / 0'\nviews:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [file.name, formula.broken]\n";
    let result = run(&books(), yaml, None);
    assert_eq!(result.rows.len(), 3);
    for row in &result.rows {
        assert!(row.cells[0].is_ok());
        assert!(row.cells[1].is_err(), "division by zero is an error cell");
    }
}

#[test]
fn a_formula_cycle_is_an_error_cell_not_a_hang() {
    let yaml = "formulas:\n  a: 'formula.b + 1'\n  b: 'formula.a + 1'\n  c: '2'\nviews:\n  - type: table\n    name: T\n    filters: 'file.inFolder(\"Books\")'\n    order: [formula.a, formula.c]\n";
    let result = run(&books(), yaml, None);
    let error = result.rows[0].cells[0].clone().unwrap_err();
    assert!(error.to_string().contains("cycle"), "{error}");
    assert_eq!(cell(&result, 0, 1), Value::Number(2.0));
}

#[test]
fn compile_errors_name_what_is_wrong() {
    let base = parse_base("views:\n  - type: table\n    name: A\n  - type: cards\n    name: B\n").unwrap();
    assert_eq!(
        compile_view(&base, Some("C")).unwrap_err(),
        CompileError::ViewNotFound { declared: vec!["A".into(), "B".into()] }
    );
    let base = parse_base("formulas:\n  bad: 'price +'\nviews:\n  - type: table\n    name: T\n    order: [formula.bad]\n").unwrap();
    assert!(matches!(
        compile_view(&base, None).unwrap_err(),
        CompileError::ExpressionInvalid { expression, position: 7, .. } if expression == "price +"
    ));
    let base = parse_base("views:\n  - type: table\n    name: T\n    filters: 'frobnicate(price)'\n").unwrap();
    assert_eq!(
        compile_view(&base, None).unwrap_err(),
        CompileError::UnsupportedFunction { name: "frobnicate".into() }
    );
    let base = parse_base("views:\n  - type: table\n    name: T\n    filters: 'price.frobnicate()'\n").unwrap();
    assert_eq!(
        compile_view(&base, None).unwrap_err(),
        CompileError::UnsupportedFunction { name: "frobnicate".into() }
    );
}

#[test]
fn a_broken_formula_fails_only_the_views_that_read_it() {
    let base = parse_base("formulas:\n  bad: 'price +'\nviews:\n  - type: table\n    name: Reads\n    order: [formula.bad]\n  - type: table\n    name: Ignores\n    order: [file.name]\n").unwrap();
    assert!(compile_view(&base, Some("Reads")).is_err());
    assert!(compile_view(&base, Some("Ignores")).is_ok());
}

#[test]
fn prefilters_come_only_from_the_top_level_conjunction() {
    let base = parse_base("filters:\n  and:\n    - file.inFolder(\"Books\")\n    - 'file.ext == \"md\" && status == \"done\"'\n    - or:\n        - file.hasTag(\"x\")\n        - file.hasTag(\"y\")\nviews:\n  - type: table\n    name: T\n    filters: 'file.hasTag(\"book\", \"novel\")'\n").unwrap();
    let compiled = compile_view(&base, None).unwrap();
    assert_eq!(
        compiled.prefilters(),
        &[
            Prefilter::InFolder("Books".into()),
            Prefilter::Ext("md".into()),
            Prefilter::PropertyEquals { key: "status".into(), value: ScalarLiteral::String("done".into()) },
            Prefilter::HasTag(vec!["book".into(), "novel".into()]),
        ]
    );
    // A falsy literal is never a prefilter: `x == false` may hold for a note
    // that lacks `x` under some coercion, and a prefilter must be a superset.
    let base = parse_base("views:\n  - type: table\n    name: T\n    filters: 'done == false'\n").unwrap();
    assert!(compile_view(&base, None).unwrap().prefilters().is_empty());
}

#[test]
fn every_view_type_is_row_data_with_its_options_kept() {
    for kind in ["table", "cards", "list", "kanban", "map", "fileclass-table"] {
        let yaml = format!("views:\n  - type: {kind}\n    name: V\n    filters: 'file.inFolder(\"Books\")'\n    image: cover\n");
        let base = parse_base(&yaml).unwrap();
        let compiled = compile_view(&base, None).unwrap();
        assert_eq!(compiled.decl().kind, kind);
        assert_eq!(compiled.decl().options[0].0, "image");
        assert_eq!(run(&books(), &yaml, None).rows.len(), 3);
    }
}

#[test]
fn this_in_a_filter_is_the_embedding_note() {
    let source = books();
    let base = parse_base("views:\n  - type: list\n    name: Backlinks\n    filters: 'file.hasLink(this.file)'\n").unwrap();
    let compiled = compile_view(&base, None).unwrap();
    let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
    let base_path = VaultPath::new("Books.base").unwrap();
    let this = VaultPath::new("Notes/Textbook.md").unwrap();
    let ctx = EvalContext::new(&source, &clock, &base_path, &this);
    let result = evaluate_view(&compiled, &ctx).unwrap();
    assert_eq!(paths(&result), vec!["Notes/Lecture.md"]);
    assert!(compiled.dependencies().reads_this);
    assert!(compiled.dependencies().reads_links);
}

#[test]
fn dependencies_name_what_the_staleness_rule_needs() {
    let base = parse_base(SYNTAX_PAGE_EXAMPLE).unwrap();
    let dependencies = compile_view(&base, None).unwrap().dependencies().clone();
    assert!(dependencies.reads_formulas);
    assert!(dependencies.reads_links, "file.hasLink in the global filter");
    assert!(!dependencies.reads_backlinks);
    assert!(dependencies.reads_properties);
}
```

Create `crates/vault-bases/tests/ordering_properties.rs`:

```rust
use std::cmp::Ordering;

use proptest::prelude::*;
use vault_bases::eval::EvalContext;
use vault_bases::eval::coerce::sort_order;
use vault_bases::fixtures::{FIXTURE_NOW_MS, FIXTURE_ZONE};
use vault_bases::view::{compile_view, evaluate_view};
use vault_bases::{Clock, DateValue, MemoryFile, MemorySource, Value, number, parse_base, text};
use vault_core::VaultPath;

fn value() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Boolean),
        (-1000i32..1000).prop_map(|n| Value::Number(f64::from(n) / 4.0)),
        "[a-cA-C🙂]{0,3}".prop_map(Value::String),
        (0i64..10_000).prop_map(|ms| Value::Date(DateValue { epoch_ms: ms * 1000, has_time: true })),
    ]
}

proptest! {
    #[test]
    fn sort_order_is_antisymmetric(a in value(), b in value()) {
        prop_assert_eq!(sort_order(&a, &b), sort_order(&b, &a).reverse());
    }

    #[test]
    fn sort_order_is_transitive(a in value(), b in value(), c in value()) {
        if sort_order(&a, &b) != Ordering::Greater && sort_order(&b, &c) != Ordering::Greater {
            prop_assert_ne!(sort_order(&a, &c), Ordering::Greater);
        }
    }

    #[test]
    fn sorting_is_stable(keys in prop::collection::vec(0u8..3, 0..20)) {
        let mut tagged: Vec<(Value, usize)> =
            keys.iter().enumerate().map(|(at, key)| (Value::Number(f64::from(*key)), at)).collect();
        tagged.sort_by(|a, b| sort_order(&a.0, &b.0));
        for pair in tagged.windows(2) {
            if sort_order(&pair[0].0, &pair[1].0) == Ordering::Equal {
                prop_assert!(pair[0].1 < pair[1].1, "equal keys keep input order");
            }
        }
    }

    #[test]
    fn list_round_trips(items in prop::collection::vec(value(), 0..6)) {
        let source = MemorySource::new();
        let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
        let path = VaultPath::new("A.md").unwrap();
        let ctx = EvalContext::new(&source, &clock, &path, &path);
        let scope = vault_bases::eval::Scope::default().bind("x", Value::List(items.clone()));
        let expr = vault_bases::expr::parse_expression("list(x)").unwrap();
        prop_assert_eq!(vault_bases::eval::evaluate(&expr, &ctx, &scope).unwrap(), Value::List(items));
    }

    /// Review Focus 1: a prefilter selects a superset of what its conjunct
    /// accepts, so a view evaluated with prefilters equals the same view
    /// evaluated without them.
    #[test]
    fn a_prefilter_never_drops_a_row_its_conjunct_keeps(
        notes in prop::collection::vec(
            ("[AB]", "[xy]", prop::option::of("[pq]"), prop::option::of(0i32..3), prop::bool::ANY),
            1..12,
        ),
        filter in prop_oneof![
            Just(r#"file.inFolder("A")"#),
            Just(r#"file.hasTag("x")"#),
            Just(r#"file.hasTag("X")"#),
            Just(r#"file.ext == "md""#),
            Just(r#"status == "p""#),
            Just(r#"status == "P""#),
            Just("rank == 1"),
            Just(r#"file.inFolder("A") && status == "q""#),
        ],
    ) {
        let mut source = MemorySource::new();
        for (index, (folder, tag, status, rank, list_status)) in notes.iter().enumerate() {
            let mut note = MemoryFile::note().tag(tag);
            if let Some(status) = status {
                note = note.property(
                    "status",
                    if *list_status { vault_core::PropertyValue::Sequence(vec![vault_bases::no_span(text(status))]) } else { text(status) },
                );
            }
            if let Some(rank) = rank {
                note = note.property("rank", number(f64::from(*rank)));
            }
            source = source.with(&format!("{folder}/N{index}.md"), note);
        }
        let base = parse_base(&format!("views:\n  - type: table\n    name: T\n    filters: '{filter}'\n")).unwrap();
        let compiled = compile_view(&base, None).unwrap();
        let clock = Clock::fixed(FIXTURE_NOW_MS, FIXTURE_ZONE);
        let base_path = VaultPath::new("T.base").unwrap();
        let ctx = EvalContext::new(&source, &clock, &base_path, &base_path);
        let with: Vec<String> = evaluate_view(&compiled, &ctx).unwrap().rows.iter().map(|row| row.path.as_str().to_string()).collect();
        let without: Vec<String> = evaluate_view(&compiled.without_prefilters(), &ctx).unwrap().rows.iter().map(|row| row.path.as_str().to_string()).collect();
        prop_assert_eq!(with, without);
    }
}
```

`MemorySource::with` takes `self`; the loop rebinds `source` each time as written.

- [ ] **Step 2: Run them to see them fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test views --test ordering_properties; echo "exit=$?"`

Expected: `error[E0432]: unresolved import vault_bases::view`, `exit=101`.

- [ ] **Step 3: Write prefilter extraction**

Create `crates/vault-bases/src/view/prefilter.rs`:

```rust
use crate::expr::{BinaryOp, Expr};
use crate::source::{Prefilter, ScalarLiteral};

/// The roots that are not note properties.
const RESERVED: [&str; 8] = ["file", "note", "formula", "this", "values", "value", "index", "acc"];

fn note_key(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Identifier(name) if !RESERVED.contains(&name.as_str()) => Some(name.clone()),
        Expr::Member { target, name } if matches!(target.as_ref(), Expr::Identifier(root) if root == "note") => Some(name.clone()),
        Expr::Index { target, index } if matches!(target.as_ref(), Expr::Identifier(root) if root == "note") => match index.as_ref() {
            Expr::String(key) => Some(key.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// A literal a note lacking the property can never equal: a non-empty
/// string, a non-zero number, `true`. A falsy literal is refused, because
/// whether `null` equals `false`, `0` or `""` is not published, and a
/// prefilter that guessed would be able to drop a row.
fn truthy_literal(expr: &Expr) -> Option<ScalarLiteral> {
    match expr {
        Expr::String(text) if !text.is_empty() => Some(ScalarLiteral::String(text.clone())),
        Expr::Number(number) if *number != 0.0 => Some(ScalarLiteral::Number(*number)),
        Expr::Boolean(true) => Some(ScalarLiteral::Boolean(true)),
        _ => None,
    }
}

fn is_file_member(expr: &Expr, field: &str) -> bool {
    matches!(expr, Expr::Member { target, name } if name == field && matches!(target.as_ref(), Expr::Identifier(root) if root == "file"))
}

/// The prefilters one top-level conjunct contributes. `&&` splits; anything
/// else contributes nothing and simply runs per row.
pub(crate) fn extract(expr: &Expr, out: &mut Vec<Prefilter>) {
    match expr {
        Expr::Binary { op: BinaryOp::And, left, right } => {
            extract(left, out);
            extract(right, out);
        }
        Expr::Method { target, name, args, .. } if matches!(target.as_ref(), Expr::Identifier(root) if root == "file") => {
            let strings: Option<Vec<String>> = args
                .iter()
                .map(|arg| match arg {
                    Expr::String(text) => Some(text.clone()),
                    _ => None,
                })
                .collect();
            match (name.as_str(), strings) {
                ("inFolder", Some(folders)) if folders.len() == 1 => out.push(Prefilter::InFolder(folders[0].clone())),
                ("hasTag", Some(tags)) if !tags.is_empty() => out.push(Prefilter::HasTag(tags)),
                _ => {}
            }
        }
        Expr::Binary { op: BinaryOp::Eq, left, right } => {
            if is_file_member(left, "ext") {
                if let Expr::String(ext) = right.as_ref() {
                    out.push(Prefilter::Ext(ext.clone()));
                    return;
                }
            }
            if is_file_member(right, "ext") {
                if let Expr::String(ext) = left.as_ref() {
                    out.push(Prefilter::Ext(ext.clone()));
                    return;
                }
            }
            let pair = match (note_key(left), truthy_literal(right)) {
                (Some(key), Some(value)) => Some((key, value)),
                _ => match (note_key(right), truthy_literal(left)) {
                    (Some(key), Some(value)) => Some((key, value)),
                    _ => None,
                },
            };
            if let Some((key, value)) = pair {
                out.push(Prefilter::PropertyEquals { key, value });
            }
        }
        _ => {}
    }
}
```

- [ ] **Step 4: Write the summaries**

Create `crates/vault-bases/src/view/summary.rs`:

```rust
use crate::eval::coerce::{sort_order, strict_equals};
use crate::eval::EvalError;
use crate::value::{DateValue, DurationValue, Value};

/// The syntax page's "Default Summary Formulas" table. `Range` appears there
/// twice (numbers, dates); one name serves both and the input decides.
pub const BUILTIN_SUMMARIES: [&str; 14] = [
    "Average", "Min", "Max", "Sum", "Range", "Median", "Stddev", "Earliest", "Latest", "Checked",
    "Unchecked", "Empty", "Filled", "Unique",
];

fn numbers(values: &[Value]) -> Vec<f64> {
    values
        .iter()
        .filter_map(|value| match value {
            Value::Number(number) => Some(*number),
            _ => None,
        })
        .collect()
}

fn dates(values: &[Value]) -> Vec<DateValue> {
    values
        .iter()
        .filter_map(|value| match value {
            Value::Date(date) => Some(*date),
            _ => None,
        })
        .collect()
}

fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::List(items) => items.is_empty(),
        Value::Object(entries) => entries.is_empty(),
        _ => false,
    }
}

/// One built-in summary over one column's values. An aggregate over no
/// qualifying input is `null` (an empty summary cell), never a number made up.
pub(crate) fn builtin(name: &str, values: &[Value]) -> Result<Value, EvalError> {
    let numbers = numbers(values);
    let none = |collection_empty: bool, value: Value| if collection_empty { Value::Null } else { value };
    Ok(match name {
        "Average" => none(numbers.is_empty(), Value::Number(numbers.iter().sum::<f64>() / numbers.len().max(1) as f64)),
        "Sum" => Value::Number(numbers.iter().sum()),
        "Min" => none(numbers.is_empty(), Value::Number(numbers.iter().copied().fold(f64::INFINITY, f64::min))),
        "Max" => none(numbers.is_empty(), Value::Number(numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max))),
        "Median" => {
            let mut sorted = numbers.clone();
            sorted.sort_by(|a, b| a.total_cmp(b));
            let n = sorted.len();
            none(n == 0, Value::Number(if n % 2 == 1 { sorted[n / 2] } else if n > 0 { (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0 } else { 0.0 }))
        }
        // Population standard deviation (`summary:stddev` confirms the divisor).
        "Stddev" => {
            let n = numbers.len() as f64;
            let mean = numbers.iter().sum::<f64>() / n.max(1.0);
            none(numbers.is_empty(), Value::Number((numbers.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n.max(1.0)).sqrt()))
        }
        "Range" => {
            let dates = dates(values);
            if numbers.is_empty() && !dates.is_empty() {
                let earliest = dates.iter().map(|d| d.epoch_ms).min().expect("non-empty");
                let latest = dates.iter().map(|d| d.epoch_ms).max().expect("non-empty");
                Value::Duration(DurationValue { months: 0, ms: latest - earliest })
            } else {
                none(
                    numbers.is_empty(),
                    Value::Number(numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max) - numbers.iter().copied().fold(f64::INFINITY, f64::min)),
                )
            }
        }
        "Earliest" | "Latest" => {
            let mut dates = dates(values);
            dates.sort_by(|a, b| sort_order(&Value::Date(*a), &Value::Date(*b)));
            let pick = if name == "Earliest" { dates.first() } else { dates.last() };
            pick.map_or(Value::Null, |date| Value::Date(*date))
        }
        "Checked" => Value::Number(values.iter().filter(|value| matches!(value, Value::Boolean(true))).count() as f64),
        "Unchecked" => Value::Number(values.iter().filter(|value| matches!(value, Value::Boolean(false))).count() as f64),
        "Empty" => Value::Number(values.iter().filter(|value| is_empty(value)).count() as f64),
        "Filled" => Value::Number(values.iter().filter(|value| !is_empty(value)).count() as f64),
        "Unique" => {
            let mut seen: Vec<&Value> = Vec::new();
            for value in values {
                if !seen.iter().any(|have| strict_equals(have, value)) {
                    seen.push(value);
                }
            }
            Value::Number(seen.len() as f64)
        }
        _ => return Err(EvalError::UnknownFunction(name.to_string())),
    })
}
```

- [ ] **Step 5: Write compile and evaluate**

Create `crates/vault-bases/src/view/mod.rs`:

```rust
//! One view, compiled and evaluated.
//!
//! Evaluation order is the spec's: prefilters, then the global filters and
//! the view's filters as one conjunction, then formulas (memoized per row),
//! then `sort` (stable), then `limit`, then `groupBy`, then summaries over the
//! surviving rows. The daemon renders nothing: a row is a path, a kind, an
//! optional group key and one cell per column.

mod prefilter;
mod summary;

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use vault_core::{PropertyValue, VaultPath};

use crate::eval::coerce::{sort_order, truthy};
use crate::eval::{EvalContext, EvalError, Formulas, Scope, evaluate, row_property};
use crate::expr::{Expr, parse_expression};
use crate::file::{BaseFile, Direction, FilterNode, ViewDecl};
use crate::functions::{self, is_known_global, is_known_method};
use crate::source::{FileKind, Prefilter, SourceError};
use crate::value::Value;

pub use summary::BUILTIN_SUMMARIES;

pub type Cell = Result<Value, EvalError>;

/// Where a column, sort key or group key reads from. Keys are names, not
/// expressions: `note.my prop` is a property called "my prop".
#[derive(Clone, Debug, PartialEq)]
pub enum PropertyRef {
    File(String),
    Formula(String),
    Note(String),
}

pub fn property_ref(key: &str) -> PropertyRef {
    if let Some(field) = key.strip_prefix("file.") {
        PropertyRef::File(field.to_string())
    } else if let Some(name) = key.strip_prefix("formula.") {
        PropertyRef::Formula(name.to_string())
    } else if let Some(name) = key.strip_prefix("note.") {
        PropertyRef::Note(name.to_string())
    } else {
        PropertyRef::Note(key.to_string())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ColumnDecl {
    pub property: String,
    pub display_name: Option<String>,
    pub settings: Vec<(String, PropertyValue)>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CompileError {
    ViewNotFound { declared: Vec<String> },
    ExpressionInvalid { expression: String, message: String, position: usize },
    UnsupportedFunction { name: String },
}

/// What the per-commit staleness rule needs to know about a view.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ViewDependencies {
    pub prefilters: Vec<Prefilter>,
    pub reads_formulas: bool,
    pub reads_links: bool,
    pub reads_backlinks: bool,
    pub reads_this: bool,
    pub reads_properties: bool,
}

#[derive(Clone, Debug)]
enum Filter {
    Expr(Expr),
    And(Vec<Filter>),
    Or(Vec<Filter>),
    Not(Vec<Filter>),
}

#[derive(Clone, Debug)]
pub struct CompiledView {
    decl: ViewDecl,
    filters: Vec<Filter>,
    formulas: BTreeMap<String, Expr>,
    columns: Vec<ColumnDecl>,
    sort: Vec<(PropertyRef, Direction)>,
    group: Option<(PropertyRef, Direction)>,
    summaries: Vec<(String, PropertyRef, String, Option<Expr>)>,
    prefilters: Vec<Prefilter>,
    dependencies: ViewDependencies,
}

impl CompiledView {
    pub fn decl(&self) -> &ViewDecl {
        &self.decl
    }
    pub fn columns(&self) -> &[ColumnDecl] {
        &self.columns
    }
    pub fn prefilters(&self) -> &[Prefilter] {
        &self.prefilters
    }
    pub fn dependencies(&self) -> &ViewDependencies {
        &self.dependencies
    }
    /// The same view with no prefilters: what the superset property test
    /// compares against. Not for production use.
    #[doc(hidden)]
    pub fn without_prefilters(&self) -> CompiledView {
        let mut copy = self.clone();
        copy.prefilters.clear();
        copy
    }
}

fn parse(text: &str) -> Result<Expr, CompileError> {
    parse_expression(text).map_err(|error| CompileError::ExpressionInvalid {
        expression: text.to_string(),
        message: error.message,
        position: error.position,
    })
}

fn compile_filter(node: &FilterNode) -> Result<Filter, CompileError> {
    Ok(match node {
        FilterNode::Expr(text) => Filter::Expr(parse(text)?),
        FilterNode::And(items) => Filter::And(items.iter().map(compile_filter).collect::<Result<_, _>>()?),
        FilterNode::Or(items) => Filter::Or(items.iter().map(compile_filter).collect::<Result<_, _>>()?),
        FilterNode::Not(items) => Filter::Not(items.iter().map(compile_filter).collect::<Result<_, _>>()?),
    })
}

fn filter_exprs<'a>(filter: &'a Filter, out: &mut Vec<&'a Expr>) {
    match filter {
        Filter::Expr(expr) => out.push(expr),
        Filter::And(items) | Filter::Or(items) | Filter::Not(items) => items.iter().for_each(|item| filter_exprs(item, out)),
    }
}

/// Walk an expression, checking names and noting what it reads.
fn scan(expr: &Expr, deps: &mut ViewDependencies, formulas: &mut BTreeSet<String>) -> Result<(), CompileError> {
    match expr {
        Expr::Call { name, args, .. } => {
            if !is_known_global(name) {
                return Err(CompileError::UnsupportedFunction { name: name.clone() });
            }
            if name == "link" || name == "file" {
                deps.reads_links = true;
            }
            for arg in args {
                scan(arg, deps, formulas)?;
            }
        }
        Expr::Method { target, name, args, .. } => {
            if !is_known_method(name) {
                return Err(CompileError::UnsupportedFunction { name: name.clone() });
            }
            if matches!(name.as_str(), "hasLink" | "linksTo" | "asFile") {
                deps.reads_links = true;
            }
            if name == "hasProperty" {
                deps.reads_properties = true;
            }
            scan(target, deps, formulas)?;
            for arg in args {
                scan(arg, deps, formulas)?;
            }
        }
        Expr::Member { target, name } => {
            match target.as_ref() {
                Expr::Identifier(root) if root == "formula" => {
                    deps.reads_formulas = true;
                    formulas.insert(name.clone());
                }
                Expr::Identifier(root) if root == "note" => deps.reads_properties = true,
                _ => {}
            }
            match name.as_str() {
                "links" | "embeds" => deps.reads_links = true,
                "backlinks" => deps.reads_backlinks = true,
                "properties" => deps.reads_properties = true,
                _ => {}
            }
            scan(target, deps, formulas)?;
        }
        Expr::Identifier(name) => match name.as_str() {
            "this" => deps.reads_this = true,
            "file" | "formula" | "values" | "value" | "index" | "acc" => {}
            _ => deps.reads_properties = true,
        },
        Expr::Index { target, index } => {
            scan(target, deps, formulas)?;
            scan(index, deps, formulas)?;
        }
        Expr::List(items) => {
            for item in items {
                scan(item, deps, formulas)?;
            }
        }
        Expr::Object(entries) => {
            for (_, value) in entries {
                scan(value, deps, formulas)?;
            }
        }
        Expr::Unary { operand, .. } => scan(operand, deps, formulas)?,
        Expr::Binary { left, right, .. } => {
            scan(left, deps, formulas)?;
            scan(right, deps, formulas)?;
        }
        Expr::Null | Expr::Boolean(_) | Expr::Number(_) | Expr::String(_) | Expr::Regexp { .. } => {}
    }
    Ok(())
}

fn note_ref(reference: &PropertyRef, deps: &mut ViewDependencies, formulas: &mut BTreeSet<String>) {
    match reference {
        PropertyRef::Formula(name) => {
            deps.reads_formulas = true;
            formulas.insert(name.clone());
        }
        PropertyRef::Note(_) => deps.reads_properties = true,
        PropertyRef::File(field) => match field.as_str() {
            "links" | "embeds" => deps.reads_links = true,
            "backlinks" => deps.reads_backlinks = true,
            "properties" => deps.reads_properties = true,
            _ => {}
        },
    }
}

pub fn compile_view(base: &BaseFile, view: Option<&str>) -> Result<CompiledView, CompileError> {
    let decl = base
        .view(view)
        .cloned()
        .ok_or_else(|| CompileError::ViewNotFound { declared: base.view_names() })?;
    let mut filters = Vec::new();
    if let Some(global) = &base.filters {
        filters.push(compile_filter(global)?);
    }
    if let Some(local) = &decl.filters {
        filters.push(compile_filter(local)?);
    }

    let mut deps = ViewDependencies::default();
    let mut wanted: BTreeSet<String> = BTreeSet::new();
    let mut exprs = Vec::new();
    for filter in &filters {
        filter_exprs(filter, &mut exprs);
    }
    for expr in &exprs {
        scan(expr, &mut deps, &mut wanted)?;
    }

    let columns: Vec<ColumnDecl> = decl
        .order
        .iter()
        .map(|property| {
            let settings = base.properties.iter().find(|(key, _)| key == property).map(|(_, settings)| settings.clone());
            ColumnDecl {
                property: property.clone(),
                display_name: settings.as_ref().and_then(|settings| settings.display_name.clone()),
                settings: settings.map(|settings| settings.options).unwrap_or_default(),
            }
        })
        .collect();
    let sort: Vec<(PropertyRef, Direction)> = decl.sort.iter().map(|key| (property_ref(&key.property), key.direction)).collect();
    let group = decl.group_by.as_ref().map(|group| (property_ref(&group.property), group.direction));
    for reference in columns
        .iter()
        .map(|column| property_ref(&column.property))
        .chain(sort.iter().map(|(reference, _)| reference.clone()))
        .chain(group.iter().map(|(reference, _)| reference.clone()))
    {
        note_ref(&reference, &mut deps, &mut wanted);
    }

    let mut summaries = Vec::new();
    for (property, name) in &decl.summaries {
        let reference = property_ref(property);
        note_ref(&reference, &mut deps, &mut wanted);
        let custom = match base.summaries.iter().find(|(key, _)| key == name) {
            Some((_, text)) => {
                let expr = parse(text)?;
                scan(&expr, &mut deps, &mut wanted)?;
                Some(expr)
            }
            None if BUILTIN_SUMMARIES.contains(&name.as_str()) => None,
            None => return Err(CompileError::UnsupportedFunction { name: name.clone() }),
        };
        summaries.push((property.clone(), reference, name.clone(), custom));
    }

    // Formulas the view reads, transitively. One that does not parse fails
    // this view; one no view reads fails nothing.
    let mut formulas = BTreeMap::new();
    let mut queue: Vec<String> = wanted.iter().cloned().collect();
    while let Some(name) = queue.pop() {
        if formulas.contains_key(&name) {
            continue;
        }
        let Some((_, text)) = base.formulas.iter().find(|(key, _)| *key == name) else {
            // An undeclared formula is an error cell per row, not a compile
            // failure: Obsidian keeps the column and shows nothing usable.
            continue;
        };
        let expr = parse(text)?;
        let mut more = BTreeSet::new();
        scan(&expr, &mut deps, &mut more)?;
        queue.extend(more.into_iter().filter(|next| !formulas.contains_key(next)));
        formulas.insert(name, expr);
    }

    let mut prefilters = Vec::new();
    for filter in &filters {
        top_level_prefilters(filter, &mut prefilters);
    }
    deps.prefilters = prefilters.clone();
    Ok(CompiledView { decl, filters, formulas, columns, sort, group, summaries, prefilters, dependencies: deps })
}

/// Only conjuncts at the top of the tree may narrow: an `and`'s children and
/// a bare statement. Nothing under `or` or `not` is a prefilter.
fn top_level_prefilters(filter: &Filter, out: &mut Vec<Prefilter>) {
    match filter {
        Filter::Expr(expr) => prefilter::extract(expr, out),
        Filter::And(items) => items.iter().for_each(|item| top_level_prefilters(item, out)),
        Filter::Or(_) | Filter::Not(_) => {}
    }
}

/// `formula.x`, memoized per row, with cycle detection.
struct FormulaTable<'v> {
    formulas: &'v BTreeMap<String, Expr>,
    memo: RefCell<BTreeMap<(VaultPath, String), Cell>>,
    active: RefCell<Vec<String>>,
}

impl Formulas for FormulaTable<'_> {
    fn formula(&self, name: &str, ctx: &EvalContext<'_>, scope: &Scope) -> Result<Value, EvalError> {
        let Some(row) = &scope.row else {
            return Err(EvalError::UnknownFormula(name.to_string()));
        };
        let key = (row.clone(), name.to_string());
        if let Some(done) = self.memo.borrow().get(&key) {
            return done.clone();
        }
        if self.active.borrow().iter().any(|active| active == name) {
            return Err(EvalError::FormulaCycle(name.to_string()));
        }
        let Some(expr) = self.formulas.get(name) else {
            return Err(EvalError::UnknownFormula(name.to_string()));
        };
        self.active.borrow_mut().push(name.to_string());
        // Formulas see the row and nothing a lambda bound around the caller.
        let result = evaluate(expr, ctx, &Scope::row(row));
        self.active.borrow_mut().pop();
        self.memo.borrow_mut().insert(key, result.clone());
        result
    }
}

fn read(reference: &PropertyRef, ctx: &EvalContext<'_>, scope: &Scope) -> Cell {
    let row = scope.row.as_ref().expect("a row scope");
    match reference {
        PropertyRef::File(field) => functions::field(&Value::File(row.clone()), field, ctx),
        PropertyRef::Formula(name) => ctx.formulas.formula(name, ctx, scope),
        PropertyRef::Note(key) => row_property(ctx, scope, key),
    }
}

/// A filter's verdict for one row, three-valued: `None` is a statement that
/// errored. An error is "unknown", not "false" — otherwise `not` would turn
/// an erroring statement into an admitted row. `and` is false if any child is
/// false, else unknown if any is unknown; `or` is true if any child is true,
/// else unknown if any is unknown; `not` (the views page: "results will not
/// be shown if any of the conditions in the filter group are met") is false
/// if any child is true, else unknown if any is unknown. An unknown verdict
/// at the top excludes the row. **Provisional** — `filter:error_row` (Task
/// 13) settles whether Obsidian shows such a row.
fn verdict(filter: &Filter, ctx: &EvalContext<'_>, scope: &Scope) -> Option<bool> {
    let children = |items: &[Filter]| -> Vec<Option<bool>> {
        items.iter().map(|item| verdict(item, ctx, scope)).collect()
    };
    match filter {
        Filter::Expr(expr) => evaluate(expr, ctx, scope).ok().map(|value| truthy(&value)),
        Filter::And(items) => {
            let all = children(items);
            if all.contains(&Some(false)) {
                Some(false)
            } else if all.contains(&None) {
                None
            } else {
                Some(true)
            }
        }
        Filter::Or(items) => {
            let all = children(items);
            if all.contains(&Some(true)) {
                Some(true)
            } else if all.contains(&None) {
                None
            } else {
                Some(false)
            }
        }
        Filter::Not(items) => {
            let all = children(items);
            if all.contains(&Some(true)) {
                Some(false)
            } else if all.contains(&None) {
                None
            } else {
                Some(true)
            }
        }
    }
}

fn admits(filter: &Filter, ctx: &EvalContext<'_>, scope: &Scope) -> bool {
    verdict(filter, ctx, scope) == Some(true)
}

fn order(a: &Cell, b: &Cell) -> std::cmp::Ordering {
    // An error cell sorts with the empty values, last.
    sort_order(a.as_ref().unwrap_or(&Value::Null), b.as_ref().unwrap_or(&Value::Null))
}

#[derive(Clone, Debug)]
pub struct RowResult {
    pub path: VaultPath,
    pub kind: FileKind,
    pub group: Option<Cell>,
    pub cells: Vec<Cell>,
}

#[derive(Clone, Debug)]
pub struct SummaryResult {
    pub property: String,
    pub name: String,
    pub value: Cell,
}

#[derive(Clone, Debug)]
pub struct ViewResult {
    pub rows: Vec<RowResult>,
    pub summaries: Vec<SummaryResult>,
    pub total_rows: usize,
}

/// Evaluate one compiled view. Only a row-source failure is an `Err`: every
/// expression failure is an error cell, a filtered-out row, or an error
/// summary, as the spec's error-handling section lays out.
pub fn evaluate_view(view: &CompiledView, ctx: &EvalContext<'_>) -> Result<ViewResult, SourceError> {
    let table = FormulaTable { formulas: &view.formulas, memo: RefCell::new(BTreeMap::new()), active: RefCell::new(Vec::new()) };
    let ctx = ctx.reborrow().with_formulas(&table);

    let mut kept: Vec<VaultPath> = Vec::new();
    for path in ctx.source.candidates(&view.prefilters)? {
        let scope = Scope::row(&path);
        if view.filters.iter().all(|filter| admits(filter, &ctx, &scope)) {
            kept.push(path);
        }
    }

    let mut rows: Vec<(VaultPath, Vec<Cell>, Option<Cell>)> = kept
        .into_iter()
        .map(|path| {
            let scope = Scope::row(&path);
            let keys: Vec<Cell> = view.sort.iter().map(|(reference, _)| read(reference, &ctx, &scope)).collect();
            let group = view.group.as_ref().map(|(reference, _)| read(reference, &ctx, &scope));
            (path, keys, group)
        })
        .collect();
    rows.sort_by(|a, b| {
        for (index, (_, direction)) in view.sort.iter().enumerate() {
            let ordering = order(&a.1[index], &b.1[index]);
            let ordering = if *direction == Direction::Desc { ordering.reverse() } else { ordering };
            if ordering.is_ne() {
                return ordering;
            }
        }
        std::cmp::Ordering::Equal
    });
    if let Some(limit) = view.decl.limit {
        rows.truncate(limit as usize);
    }
    if let Some((_, direction)) = &view.group {
        rows.sort_by(|a, b| {
            let ordering = order(a.2.as_ref().expect("grouped"), b.2.as_ref().expect("grouped"));
            if *direction == Direction::Desc { ordering.reverse() } else { ordering }
        });
    }

    let mut results = Vec::with_capacity(rows.len());
    for (path, _, group) in rows {
        let scope = Scope::row(&path);
        let kind = functions::file::kind_of(&ctx, &path).map_err(|error| match error {
            EvalError::Source(error) => error,
            other => SourceError(other.to_string()),
        })?;
        let cells = view.columns.iter().map(|column| read(&property_ref(&column.property), &ctx, &scope)).collect();
        results.push(RowResult { path, kind, group, cells });
    }

    let summaries = view
        .summaries
        .iter()
        .map(|(property, reference, name, custom)| {
            let values: Vec<Value> = results
                .iter()
                .map(|row| read(reference, &ctx, &Scope::row(&row.path)).unwrap_or(Value::Null))
                .collect();
            let value = match custom {
                Some(expr) => evaluate(expr, &ctx, &Scope::default().bind("values", Value::List(values))),
                None => summary::builtin(name, &values),
            };
            SummaryResult { property: property.clone(), name: name.clone(), value }
        })
        .collect();

    Ok(ViewResult { total_rows: results.len(), rows: results, summaries })
}
```

`evaluate_view` needs a copy of the caller's context with a different formula table (`random_state` is private to `eval`, so the copy is made there). Add to `EvalContext` in `crates/vault-bases/src/eval/mod.rs`:

```rust
impl<'a> EvalContext<'a> {
    /// The same context, borrowed for a shorter life, so a view can swap in
    /// its own formula table without the caller giving theirs up.
    pub fn reborrow(&self) -> EvalContext<'_> {
        EvalContext {
            source: self.source,
            clock: self.clock,
            base_path: self.base_path,
            this_path: self.this_path,
            formulas: self.formulas,
            random_state: std::cell::Cell::new(self.random_state.get()),
        }
    }
}
```

`row_property` stays `pub(crate)`: `view` is inside the crate.

Stable sorting: `slice::sort_by` is stable, which is what the second `sort_by` (grouping) relies on to keep the sorted order inside each group.

Add `pub mod view;` to `crates/vault-bases/src/lib.rs`.

- [ ] **Step 6: Run the tests and see them pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-bases --test views --test ordering_properties; echo "exit=$?"`

Expected: `views` 15 passed, `ordering_properties` 5 passed, `exit=0`.

The expected Median is `10` (prices 3, 10, 30 under `Books/`); `Average` of 10, 3 and 30 is `43 / 3`; `Filled` counts three statuses; `rounded` is `values.mean().round(3)` = `14.333`.

- [ ] **Step 7: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-bases; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check -p vault-bases; echo "exit=$?"
```

Expected: `exit=0` four times.

- [ ] **Step 8: Commit**

```bash
git add crates/vault-bases
git commit -F - <<'COMMIT'
feat(bases): compile and evaluate a view

A view compiles once: the global and view filters as one conjunction, every expression it reads parsed, unknown functions refused by name, formulas read transitively, and prefilters taken only from the top-level conjunction and only where they are a superset of their conjunct. Evaluation runs the spec's order — prefilters, filters, memoized formulas with cycle detection, stable multi-key sort, limit, groupBy, then the syntax page's fourteen default summaries and custom summaries over values. Every view type is row data with its options kept; a failing cell is an error cell and its row stays.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 8: The resolver — `.base` targets, the `view` subpath, `missing_subpath`, and the wire spelling

The link resolver learns non-note targets: a catalog entry may now be a base, carrying its view names. A reference whose file target reaches a `.base` resolves to it; a subpath on a base is a view name, matched exactly — `![[X.base#Table]]` resolves to `{ target: "X.base", subpath: { kind: "view", value: "Table" } }` when the view exists and to `missing_subpath` when it does not. This is the whole of the resolution change, in `vault-core`, plus its stored and wire spellings; Task 10 feeds bases into the catalog from the index.

**Files:**

- Modify: `crates/vault-core/src/semantic.rs` (`Subpath::View`), `crates/vault-core/src/resolver.rs` (`ResolutionNote.views`, `ResolutionNote::base`, base targets, view subpaths, the diagnostic), `crates/vault-core/src/dependency.rs` (a view-set change), `crates/vault-core/src/graph.rs` (`build_graph_with_bases`), `crates/vault-core/src/diagnostic.rs` (`MissingView`, `MalformedBase`), `crates/vault-core/src/domain.rs` (`VaultPath::is_base`), `crates/vault-core/src/lib.rs` (exports)
- Modify: every `ResolutionNote { … }` struct literal in the workspace — add `views: None` (the compiler names each; today they are in `crates/vault-core/tests/{resolution_catalog,dependency_keys}.rs`, `crates/vault-core/src/resolver.rs`, `crates/vault-index/tests/{live_reader,live_graph}.rs`, `crates/vault-index/src/{reader,live_graph,live_reconcile,store}.rs` and `crates/vault-index/src/mutate/rename.rs`)
- Modify: `crates/vault-index/src/codec.rs` (`view` subpath; the two diagnostic codes), `crates/vault-index/src/mutate/rename.rs:670-674` (the `View` arm)
- Modify: `crates/vault-protocol/src/semantic.rs` (`SubpathDto::View`, `SubpathDto::Unknown`, its `Deserialize`)
- Modify: `crates/vault-server/src/convert.rs` (`subpath`, `diagnostic_code`)
- Create: `crates/vault-core/tests/base_resolution.rs`, `crates/vault-protocol/tests/subpath_view.rs`

**Interfaces:**

- Consumes: `Resolver`, `ResolutionNote`, `LinkTarget`, `Resolution`, `resolution_diagnostic`, `changed_candidate_keys`, `build_graph` as they are.
- Produces:

```rust
// vault-core
pub enum Subpath { Heading(String), Block(String), View(String) }
pub struct ResolutionNote { pub path: VaultPath, pub headings: Vec<String>, pub blocks: Vec<String>, pub views: Option<Vec<String>> }
impl ResolutionNote { pub fn base(path: VaultPath, views: Vec<String>) -> Self; pub fn is_base(&self) -> bool; }
pub fn build_graph_with_bases(notes: Vec<ParsedNote>, bases: Vec<ResolutionNote>, diagnostics: Vec<Diagnostic>) -> ScanReport;
pub enum DiagnosticCode { /* … */ MissingView, MalformedBase }
impl VaultPath { pub fn is_base(&self) -> bool; }

// vault-protocol
pub enum SubpathDto { Heading(String), Block(String), View(String), Unknown }
```

The view-name match is **exact** (case and Unicode as written). Whether Obsidian folds case for a view embed is the capture item `view:case` in Task 13.

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-core/tests/base_resolution.rs`:

```rust
use vault_core::{
    DependencyKey, DependencyKind, DiagnosticCode, LinkTarget, ParsedNote, Resolution,
    ResolutionIdentityChange, ResolutionNote, Resolver, ResolvedReference, SourceDocument, Subpath,
    VaultPath, build_graph_with_bases, changed_candidate_keys, parse_note, resolution_diagnostic,
};

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).expect("a valid path")
}

fn note(path: &str, headings: &[&str]) -> ResolutionNote {
    ResolutionNote {
        path: vp(path),
        headings: headings.iter().map(|h| h.to_string()).collect(),
        blocks: Vec::new(),
        views: None,
    }
}

fn resolver() -> Resolver {
    Resolver::from_catalog([
        note("Home.md", &["Table"]),
        ResolutionNote::base(vp("Views.base"), vec!["Table".into(), "Tâble".into(), "Cards".into()]),
        ResolutionNote::base(vp("Sub/Other.base"), vec![]),
    ])
}

fn resolve(destination: &str) -> Resolution {
    resolver().resolve_target(&vp("Home.md"), &LinkTarget::parse(destination))
}

#[test]
fn a_link_to_a_base_resolves_to_the_base() {
    assert_eq!(resolve("Views.base"), Resolution::Resolved { target: vp("Views.base"), subpath: None });
    assert_eq!(resolve("Sub/Other.base"), Resolution::Resolved { target: vp("Sub/Other.base"), subpath: None });
    assert_eq!(resolve("other.base"), Resolution::Resolved { target: vp("Sub/Other.base"), subpath: None }, "the filename stage is case-insensitive");
}

#[test]
fn a_base_is_never_reached_without_its_extension() {
    assert_eq!(resolve("Views"), Resolution::Unresolved);
}

#[test]
fn a_subpath_on_a_base_is_a_view() {
    assert_eq!(
        resolve("Views.base#Table"),
        Resolution::Resolved { target: vp("Views.base"), subpath: Some(Subpath::View("Table".into())) }
    );
    assert_eq!(
        resolve("Views.base#Missing"),
        Resolution::MissingSubpath { target: vp("Views.base"), subpath: Subpath::View("Missing".into()) }
    );
    assert_eq!(
        resolve("Views.base#table"),
        Resolution::MissingSubpath { target: vp("Views.base"), subpath: Subpath::View("table".into()) },
        "view names match exactly (capture item view:case)"
    );
    assert_eq!(
        resolve("Views.base#^block"),
        Resolution::MissingSubpath { target: vp("Views.base"), subpath: Subpath::Block("block".into()) }
    );
}

#[test]
fn a_view_name_with_unicode_resolves() {
    assert_eq!(
        resolve("Views.base#Tâble"),
        Resolution::Resolved { target: vp("Views.base"), subpath: Some(Subpath::View("Tâble".into())) }
    );
}

#[test]
fn a_note_heading_that_shares_a_view_name_is_still_a_heading() {
    assert_eq!(
        resolve("Home#Table"),
        Resolution::Resolved { target: vp("Home.md"), subpath: Some(Subpath::Heading("Table".into())) }
    );
}

#[test]
fn a_missing_view_has_its_own_diagnostic() {
    let note = parse_note(SourceDocument::new(vp("Home.md"), "![[Views.base#Missing]]\n"));
    let reference = note.references[0].clone();
    let resolved = ResolvedReference {
        source: vp("Home.md"),
        source_span: reference.span,
        resolution: resolve("Views.base#Missing"),
        reference,
    };
    let diagnostic = resolution_diagnostic(&resolved).expect("a diagnostic");
    assert_eq!(diagnostic.code, DiagnosticCode::MissingView);
    assert!(diagnostic.message.contains("view"), "{}", diagnostic.message);
}

#[test]
fn a_changed_view_list_invalidates_references_to_that_base() {
    let keys = changed_candidate_keys(&ResolutionIdentityChange {
        old: Some(ResolutionNote::base(vp("Views.base"), vec!["Table".into()])),
        new: Some(ResolutionNote::base(vp("Views.base"), vec!["Cards".into()])),
    });
    assert!(keys.contains(&DependencyKey::new(DependencyKind::ResolvedTarget, "Views.base")));
}

#[test]
fn the_complete_graph_resolves_through_bases() {
    let notes: Vec<ParsedNote> = vec![parse_note(SourceDocument::new(
        vp("Home.md"),
        "![[Views.base#Table]] and [[Views.base#Nope]]\n",
    ))];
    let report = build_graph_with_bases(
        notes,
        vec![ResolutionNote::base(vp("Views.base"), vec!["Table".into()])],
        Vec::new(),
    );
    let outgoing = report.graph.outgoing(&vp("Home.md"));
    assert_eq!(
        outgoing[0].resolution,
        Resolution::Resolved { target: vp("Views.base"), subpath: Some(Subpath::View("Table".into())) }
    );
    assert!(matches!(outgoing[1].resolution, Resolution::MissingSubpath { .. }));
    assert_eq!(report.graph.backlinks(&vp("Views.base")).len(), 2);
    assert!(report.diagnostics.iter().any(|d| d.code == DiagnosticCode::MissingView));
}

#[test]
fn is_base_reads_the_extension() {
    assert!(vp("Views.base").is_base());
    assert!(vp("Sub/V.BASE").is_base());
    assert!(!vp("Views.md").is_base());
    assert!(!vp("base").is_base());
}
```

Create `crates/vault-protocol/tests/subpath_view.rs`:

```rust
use vault_protocol::{ResolutionDto, SubpathDto};

#[test]
fn a_view_subpath_has_its_own_kind() {
    let resolution = ResolutionDto::Resolved {
        target: "Views.base".into(),
        subpath: Some(SubpathDto::View("Table".into())),
    };
    let text = serde_json::to_string(&resolution).unwrap();
    assert_eq!(text, r#"{"kind":"resolved","target":"Views.base","subpath":{"kind":"view","value":"Table"}}"#);
    assert_eq!(serde_json::from_str::<ResolutionDto>(&text).unwrap(), resolution);
}

#[test]
fn the_existing_kinds_read_back_byte_for_byte() {
    for (dto, text) in [
        (SubpathDto::Heading("H".into()), r#"{"kind":"heading","value":"H"}"#),
        (SubpathDto::Block("b".into()), r#"{"kind":"block","value":"b"}"#),
    ] {
        assert_eq!(serde_json::to_string(&dto).unwrap(), text);
        assert_eq!(serde_json::from_str::<SubpathDto>(text).unwrap(), dto);
    }
}

#[test]
fn an_unknown_subpath_kind_is_tolerated_not_fatal() {
    let text = r#"{"kind":"missing_subpath","target":"X.base","subpath":{"kind":"shape","value":{"x":1}}}"#;
    let resolution: ResolutionDto = serde_json::from_str(text).expect("the line decodes");
    assert_eq!(
        resolution,
        ResolutionDto::MissingSubpath { target: "X.base".into(), subpath: SubpathDto::Unknown }
    );
}

#[test]
fn a_known_kind_with_a_missing_value_still_fails() {
    assert!(serde_json::from_str::<SubpathDto>(r#"{"kind":"view"}"#).is_err());
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-core --test base_resolution; echo "exit=$?"`

Expected: compile errors naming `ResolutionNote::base`, `Subpath::View`, `build_graph_with_bases`, `DiagnosticCode::MissingView`, the `views` field and `is_base`; `exit=101`.

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol --test subpath_view; echo "exit=$?"`

Expected: `no variant named View`/`Unknown`, `exit=101`.

- [ ] **Step 3: The `vault-core` changes**

In `crates/vault-core/src/semantic.rs`, the enum becomes:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Subpath {
    Heading(String),
    Block(String),
    /// A view of a base. Never produced by the parser — a `#fragment` parses
    /// as a heading — only by resolution, when the target is a base.
    View(String),
}
```

In `crates/vault-core/src/domain.rs`, beside `is_markdown`:

```rust
    /// Whether this path names an Obsidian base (`.base`, any case).
    pub fn is_base(&self) -> bool {
        std::path::Path::new(self.name())
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("base"))
    }
```

In `crates/vault-core/src/diagnostic.rs`, append `MissingView,` and `MalformedBase,` to `DiagnosticCode` after `MissingBlock`.

In `crates/vault-core/src/resolver.rs`:

1. `ResolutionNote` gains the field and two functions:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionNote {
    pub path: VaultPath,
    pub headings: Vec<String>,
    pub blocks: Vec<String>,
    /// `Some` for a base: its declared view names, in order. A base has no
    /// headings or blocks; a subpath on it names a view.
    pub views: Option<Vec<String>>,
}

impl ResolutionNote {
    pub fn base(path: VaultPath, views: Vec<String>) -> Self {
        Self { path, headings: Vec::new(), blocks: Vec::new(), views: Some(views) }
    }

    pub fn is_base(&self) -> bool {
        self.views.is_some()
    }
}
```

   and `From<&ParsedNote>` sets `views: None`.

2. `NoteSubpaths` gains `views: Option<Vec<String>>`, and `from_catalog`'s loop, after the block loop, sets `entry.views = note.views;` (the move is the last use of `note`).

3. `with_subpath` becomes:

```rust
    fn with_subpath(&self, target: VaultPath, subpath: Option<Subpath>) -> Resolution {
        let Some(subpath) = subpath else {
            return Resolution::Resolved { target, subpath: None };
        };
        let known = self.subpaths.get(&target);
        // A subpath on a base names a view, matched exactly; a block on a base
        // names nothing. A view subpath on a note names nothing either.
        if let Some(views) = known.and_then(|entry| entry.views.as_ref()) {
            let resolved = match &subpath {
                Subpath::Heading(name) | Subpath::View(name) => {
                    let as_view = Subpath::View(name.clone());
                    if views.iter().any(|view| view == name) {
                        return Resolution::Resolved { target, subpath: Some(as_view) };
                    }
                    as_view
                }
                Subpath::Block(_) => subpath,
            };
            return Resolution::MissingSubpath { target, subpath: resolved };
        }
        let found = match &subpath {
            Subpath::Heading(heading) => known.is_some_and(|entry| entry.heading_keys.contains(&heading.to_lowercase())),
            Subpath::Block(block) => known.is_some_and(|entry| entry.block_ids.contains(block)),
            Subpath::View(_) => false,
        };
        if found {
            Resolution::Resolved { target, subpath: Some(subpath) }
        } else {
            Resolution::MissingSubpath { target, subpath }
        }
    }
```

4. In `resolution_diagnostic`, the `(code, kind)` match gains `Subpath::View(_) => (DiagnosticCode::MissingView, "view"),`.

In `crates/vault-core/src/dependency.rs`, in `changed_candidate_keys`, the stable-path condition becomes `old.path == new.path && (old.headings != new.headings || old.blocks != new.blocks || old.views != new.views)`.

In `crates/vault-core/src/graph.rs`, replace `build_graph`'s first line and add the new function:

```rust
pub fn build_graph(notes: Vec<ParsedNote>, diagnostics: Vec<Diagnostic>) -> ScanReport {
    build_graph_with_bases(notes, Vec::new(), diagnostics)
}

/// The complete graph with bases in the resolution catalog: every reference
/// may resolve to a note or to a base (and a base's views), and a base
/// collects backlinks like a note does. Bases carry no references of their
/// own, so they add catalog entries and nothing else.
pub fn build_graph_with_bases(
    notes: Vec<ParsedNote>,
    bases: Vec<ResolutionNote>,
    mut diagnostics: Vec<Diagnostic>,
) -> ScanReport {
    let resolver = Resolver::from_catalog(
        notes.iter().map(ResolutionNote::from).chain(bases),
    );
```

  — the rest of the old `build_graph` body follows unchanged (it already began with `let resolver = Resolver::new(&notes);`, which this line replaces), and `ResolutionNote` joins the `use crate::{…}` list.

In `crates/vault-core/src/lib.rs`, `pub use graph::{ScanReport, SemanticGraph, build_graph, build_graph_with_bases, scan_vault};`.

Then let the compiler list every `ResolutionNote` literal that lacks the field:

```bash
cargo check --workspace --all-targets 2>&1 | grep -A3 "missing field \`views\`"; echo "exit=$?"
```

Add `views: None,` to each one it names, and nowhere else — a base identity is built only with `ResolutionNote::base`, and Task 10 is where the index starts building them. Re-run until the grep prints nothing (`exit=1` from `grep` is the success here: no match).

The new variants also make some `match` statements in test helpers non-exhaustive; the compiler names them (today `dto_subpath` and `core_subpath` in `crates/vault-server/tests/mutation_oracle.rs`, and any twin in `crates/vault-index/tests/`). Give each the arms that keep its string form distinct — `Some(SubpathDto::View(name)) => format!(" #view {name}")`, `Some(SubpathDto::Unknown) => " #unknown".to_string()`, `Some(Subpath::View(name)) => format!(" #view {name}")` — so a view never compares equal to a heading of the same name.

- [ ] **Step 4: The stored and wire spellings**

In `crates/vault-index/src/codec.rs`:

- `encode_subpath` gains `Subpath::View(value) => ("view", value),`;
- `decode_subpath` gains `(Some("view"), Some(value)) => Ok(Some(Subpath::View(value.to_string()))),`;
- `encode_diagnostic_code` gains `DiagnosticCode::MissingView => "missing_view",` and `DiagnosticCode::MalformedBase => "malformed_base",`; `decode_diagnostic_code` gains the two reverse arms.

In `crates/vault-index/src/mutate/rename.rs`, the match at lines 670-674 gains `Subpath::View(view) => view.clone(),` — a reference's own subpath is parsed text and is never a view, but the match must be exhaustive and a view name is written exactly as a heading would be.

In `crates/vault-server/src/convert.rs`, `subpath` gains `Subpath::View(text) => SubpathDto::View(text.clone()),` and `diagnostic_code` gains the two codes with the spellings above.

In `crates/vault-protocol/src/semantic.rs`, replace the `SubpathDto` definition:

```rust
/// A reference's subpath. Open-ended like every enum a client decodes from
/// an event or a response it did not ask to be strict about: a kind this
/// build does not know is [`SubpathDto::Unknown`], with its value discarded,
/// rather than a failed line. `view` arrived in protocol version 1 additively
/// with Bases evaluation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SubpathDto {
    Heading(String),
    Block(String),
    View(String),
    /// A kind this build does not know. Never produced by this server.
    #[serde(skip_serializing)]
    Unknown,
}

impl<'de> Deserialize<'de> for SubpathDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Raw {
            kind: String,
            #[serde(default)]
            value: Option<serde_json::Value>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let text = |value: Option<serde_json::Value>| match value {
            Some(serde_json::Value::String(text)) => Ok(text),
            _ => Err(serde::de::Error::custom(format!("a `{}` subpath needs a string value", raw.kind))),
        };
        Ok(match raw.kind.as_str() {
            "heading" => SubpathDto::Heading(text(raw.value)?),
            "block" => SubpathDto::Block(text(raw.value)?),
            "view" => SubpathDto::View(text(raw.value)?),
            _ => SubpathDto::Unknown,
        })
    }
}
```

The closure borrows `raw.kind` while `raw.value` is moved into it; if the borrow checker objects, bind `let kind = raw.kind;` first and use `kind` in both the message and the match. `serde_json` becomes a normal dependency of `vault-protocol` in this task (Task 11 needs it too): in `crates/vault-protocol/Cargo.toml`, move `serde_json.workspace = true` from `[dev-dependencies]` to `[dependencies]` (keep it in `[dev-dependencies]` as well — harmless — or remove it there; either compiles).

- [ ] **Step 5: Run the tests and see them pass**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-core --test base_resolution; echo "exit=$?"
TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol --test subpath_view; echo "exit=$?"
```

Expected: 9 passed with `exit=0`, then 4 passed with `exit=0`.

- [ ] **Step 6: The gates — the whole workspace, because the struct literal and the enum reached four crates**

```bash
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
```

Expected: `exit=0` four times. No existing test's expectation changes: with no base in any catalog yet, every resolution answer is what it was.

- [ ] **Step 7: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(core): resolve links to bases and to their views

A resolution catalog entry may now be a base with its view names. A link reaching a .base resolves to it, and a subpath on a base is a view matched exactly: present, it resolves with a view subpath; absent, it is missing_subpath with a missing_view diagnostic. A changed view list invalidates the references that reached the base. The view subpath gets its stored spelling and its wire kind, and SubpathDto tolerates a kind it does not know.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 9: Schema version 4 — `property_scalars` beside `properties`, and the `bases` table's shape

The index moves to SQL and semantic version 4. Two tables arrive: `property_scalars`, one row per stored property (same `(note_path, ordinal)` key as `properties`), classifying its value as `string`, `number`, `boolean`, `date`, `null`, `list` or `object` with the scalar in a typed column, maintained by the one write path every note row goes through (`IndexStore::replace_note`, which both publication routes call); and `bases`, whose rows Task 10 writes. As with v2 → v3, an older cache is **rebuilt, never migrated** (`schema.rs:11-15`), so this task's proof is the cold build, the obsolete-v3 rebuild, and an oracle that `property_scalars` mirrors `properties` after every batch the live oracle already fuzzes.

**Files:**

- Create: `crates/vault-index/src/schema_v4.sql` (a copy of `schema_v3.sql` with the two tables appended)
- Modify: `crates/vault-index/src/schema.rs` (versions and the `include_str!`), `crates/vault-index/src/codec.rs` (`StoredScalar`, `property_scalar`), `crates/vault-index/src/store.rs` (`replace_note` writes the scalars)
- Modify: `crates/vault-index/tests/schema_v3.rs:79-96` (the "current version" assertions move to 4), `crates/vault-index/tests/recovery.rs:226-265` (that test's `3` becomes `4`; a v3-cache test joins it), `crates/vault-index/tests/common/mod.rs` (the mirror check), `crates/vault-index/tests/live_oracle.rs` (claim 6)
- Create: `crates/vault-index/tests/property_scalars.rs`

**Interfaces:**

- Consumes: `IndexStore::replace_note`, `vault_core::PropertyValue`, `IndexService::{open, refresh, refresh_paths, connection_for_test}`.
- Produces:

```rust
pub const SQL_SCHEMA_VERSION: u32 = 4;
pub const SEMANTIC_FORMAT_VERSION: u32 = 4;
pub(crate) struct StoredScalar { pub kind: &'static str, pub string_value: Option<String>, pub number_value: Option<f64> }
pub(crate) fn property_scalar(value: &PropertyValue) -> StoredScalar;
// tests/common
pub fn property_scalars_mirror(connection: &rusqlite::Connection) -> Result<(), String>;
```

The `date` kind is lexical — a string shaped `YYYY-MM-DD`, optionally followed by `[ T]HH:mm[:ss[.fff]]` — because the index has no property types; the row source (Task 11) applies the declared type at evaluation, and the prefilter only ever narrows to "notes that carry this key" (Task 7), so the kind column is a read optimisation and never a correctness input.

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-index/tests/property_scalars.rs`:

```rust
mod common;

use std::collections::BTreeSet;
use std::fs;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{ChangeCause, IndexConfig, IndexService};

fn open(vault: &TempDir, index: &TempDir) -> IndexService {
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).expect("config");
    let mut service = IndexService::open(config).expect("service");
    service.refresh(false).expect("cold build");
    service
}

fn scalars(service: &IndexService, path: &str) -> Vec<(i64, String, String, Option<String>, Option<f64>)> {
    let connection = service.connection_for_test();
    let mut statement = connection
        .prepare(
            "SELECT ordinal, key_text, kind, string_value, number_value FROM property_scalars \
             WHERE note_path = ?1 ORDER BY ordinal",
        )
        .unwrap();
    statement
        .query_map([path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn a_cold_build_classifies_every_property() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    fs::write(
        vault.path().join("Kinds.md"),
        "---\ntitle: Dune\nprice: 12.5\ncount: 3\ndone: true\ndue: 2025-01-01\nstamp: 2025-01-01T10:15\nempty:\ntags: [a, b]\nmeta:\n  x: 1\n---\n",
    )
    .unwrap();
    let service = open(&vault, &index);
    assert_eq!(
        scalars(&service, "Kinds.md"),
        vec![
            (0, "title".into(), "string".into(), Some("Dune".into()), None),
            (1, "price".into(), "number".into(), None, Some(12.5)),
            (2, "count".into(), "number".into(), None, Some(3.0)),
            (3, "done".into(), "boolean".into(), None, Some(1.0)),
            (4, "due".into(), "date".into(), Some("2025-01-01".into()), None),
            (5, "stamp".into(), "date".into(), Some("2025-01-01T10:15".into()), None),
            (6, "empty".into(), "null".into(), None, None),
            (7, "tags".into(), "list".into(), None, None),
            (8, "meta".into(), "object".into(), None, None),
        ]
    );
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror");
}

#[test]
fn an_edit_and_a_delete_move_the_scalars_with_the_note() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    fs::write(vault.path().join("A.md"), "---\nstatus: open\n---\n").unwrap();
    let mut service = open(&vault, &index);
    assert_eq!(scalars(&service, "A.md")[0].3.as_deref(), Some("open"));

    fs::write(vault.path().join("A.md"), "---\nstatus: closed\nrank: 2\n---\n").unwrap();
    let paths: BTreeSet<VaultPath> = [VaultPath::new("A.md").unwrap()].into();
    service.refresh_paths(paths.clone(), ChangeCause::Watcher).unwrap();
    let after = scalars(&service, "A.md");
    assert_eq!(after.len(), 2);
    assert_eq!(after[0].3.as_deref(), Some("closed"));
    assert_eq!(after[1].4, Some(2.0));
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror after edit");

    fs::remove_file(vault.path().join("A.md")).unwrap();
    service.refresh_paths(paths, ChangeCause::Watcher).unwrap();
    assert!(scalars(&service, "A.md").is_empty(), "the rows cascade with the note");
    common::property_scalars_mirror(service.connection_for_test()).expect("mirror after delete");
}

#[test]
fn a_fresh_index_has_both_new_tables() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    let service = open(&vault, &index);
    for table in ["property_scalars", "bases"] {
        let count: i64 = service
            .connection_for_test()
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "{table} exists");
    }
}
```

Append to `crates/vault-index/tests/common/mod.rs`:

```rust
/// The in-repo scratch root, derived from this crate's manifest directory —
/// never from `TMPDIR` alone, so a bare `cargo test` cannot reach the OS temp
/// directory. Every new test in this phase makes its directories here.
pub fn scratch_root() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
    std::fs::create_dir_all(&root).expect("create the scratch root");
    root.canonicalize().expect("canonicalize the scratch root")
}

/// Claim 6 of the live oracle: `property_scalars` holds exactly one row per
/// `properties` row, under the same `(note_path, ordinal)` and key, and no
/// row of its own. Checked in SQL both ways, so a missed insert and a missed
/// delete are both caught.
pub fn property_scalars_mirror(connection: &rusqlite::Connection) -> Result<(), String> {
    let missing: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM properties p LEFT JOIN property_scalars s \
             ON s.note_path = p.note_path AND s.ordinal = p.ordinal \
             WHERE s.note_path IS NULL OR s.key_text != p.key_text",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let stray: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM property_scalars s LEFT JOIN properties p \
             ON s.note_path = p.note_path AND s.ordinal = p.ordinal \
             WHERE p.note_path IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if missing == 0 && stray == 0 {
        Ok(())
    } else {
        Err(format!("{missing} properties rows without a matching scalar, {stray} scalars without a property"))
    }
}
```

In `crates/vault-index/tests/live_oracle.rs`, add a sixth claim to the module header ("6. **Scalar mirror** — `property_scalars` mirrors `properties` row for row") and, in `Oracle::run_batch`, after the `(4)` vault-integrity assertion:

```rust
        // (6) The scalar index mirrors the properties it is derived from.
        if let Err(message) = common::property_scalars_mirror(self.service.connection_for_test()) {
            return Err(TestCaseError::fail(format!("{message} after {batch:?}")));
        }
```

In `crates/vault-index/tests/schema_v3.rs`, rename `schema_version_constants_are_three` to `schema_version_constants_are_four` and make its two assertions `4`; in `a_fresh_index_carries_the_structural_tables`, the `assert_eq!(user_version, 3)` becomes `4` (the v3 tables are still there in v4, which is what that test now proves). In `crates/vault-index/tests/recovery.rs`, rename `a_genuine_version_two_cache_is_replaced_by_schema_three` to `a_genuine_version_two_cache_is_replaced_by_the_current_schema` and change its `assert_eq!(user_version, 3);` to `assert_eq!(user_version, 4);`, then append:

```rust
#[test]
fn a_genuine_version_three_cache_is_replaced_by_schema_four() {
    let vault = tempfile::tempdir_in(common::scratch_root()).unwrap();
    let index_dir = tempfile::tempdir_in(common::scratch_root()).unwrap();
    fs::write(vault.path().join("Note.md"), "---\nstatus: open\n---\n# Note\n").unwrap();
    let index_path = index_dir.path().join("derived.sqlite3");

    let mut config = IndexConfig::explicit(vault.path(), &index_path).unwrap();
    config.location = IndexLocation::Derived;
    {
        let connection = rusqlite::Connection::open(&index_path).unwrap();
        connection.execute_batch(include_str!("../src/schema_v3.sql")).unwrap();
        connection.pragma_update(None, "user_version", 3).unwrap();
        connection
            .execute(
                "INSERT INTO index_metadata \
                 (singleton, semantic_format_version, vault_identity, generation, created_at_unix_ms) \
                 VALUES (1, 3, ?1, NULL, 0)",
                rusqlite::params![config.vault_identity],
            )
            .unwrap();
    }

    let mut service = IndexService::open(config).unwrap();
    assert_eq!(service.current_generation().unwrap(), None, "the v3 cache was discarded");
    service.refresh(false).unwrap();
    let connection = service.connection_for_test();
    let user_version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(user_version, 4);
    let scalars: i64 = connection
        .query_row("SELECT COUNT(*) FROM property_scalars WHERE note_path = 'Note.md'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(scalars, 1, "the rebuilt cache indexes the scalar");
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test property_scalars --test schema_v3 --test recovery; echo "exit=$?"`

Expected: `no such table: property_scalars` failures, the version tests failing on `3 != 4`, `exit=101`.

- [ ] **Step 3: The schema**

Create `crates/vault-index/src/schema_v4.sql` as an exact copy of `schema_v3.sql` (`cp crates/vault-index/src/schema_v3.sql crates/vault-index/src/schema_v4.sql`), then append:

```sql

-- property_scalars: one row per `properties` row, same key, classifying the
-- value for indexed narrowing. `string_value` is set for `string` and `date`
-- (the text as written); `number_value` for `number` (and 1/0 for
-- `boolean`). Lists and objects are recorded by kind only and evaluated per
-- row. `key_fold` is the lowercased key, the lookup column. The `date` kind
-- is lexical: the index knows no property types (those live in
-- `.obsidian/types.json` and are applied at evaluation).
CREATE TABLE property_scalars (
    note_path    TEXT    NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal      INTEGER NOT NULL,
    key_text     TEXT    NOT NULL,
    key_fold     TEXT    NOT NULL,
    kind         TEXT    NOT NULL
        CHECK (kind IN ('string','number','boolean','date','null','list','object')),
    string_value TEXT,
    number_value REAL,
    PRIMARY KEY (note_path, ordinal)
);
CREATE INDEX property_scalars_by_key ON property_scalars (key_fold, note_path);

-- bases: one row per `.base` file the scan sees, reconciled in the same
-- generation as any other change. `source_bytes` lets hydration re-parse a
-- base without reading the vault; `view_names_json` is a JSON array in
-- declared order; `diagnostics_json` is a JSON array of
-- {code, severity, message, span_start, span_end} (the parse failure, when
-- `parse_status` is 'parse_failed'), read into `get_diagnostics` by the
-- `base` branch of the diagnostic union.
CREATE TABLE bases (
    path                   TEXT PRIMARY KEY,
    content_revision       TEXT    NOT NULL,
    source_bytes           BLOB    NOT NULL,
    observed_size          INTEGER NOT NULL CHECK (observed_size >= 0),
    observed_mtime_seconds INTEGER NOT NULL,
    observed_mtime_nanos   INTEGER NOT NULL
        CHECK (observed_mtime_nanos >= 0 AND observed_mtime_nanos < 1000000000),
    parse_status           TEXT    NOT NULL CHECK (parse_status IN ('parsed','parse_failed')),
    view_names_json        TEXT    NOT NULL,
    diagnostics_json       TEXT    NOT NULL
);
```

In `crates/vault-index/src/schema.rs`: both constants become `4`; the doc comment above the schema constant reads "`schema_v1.sql`, `schema_v2.sql` and `schema_v3.sql` stay in the tree as the authentic older shapes the recovery tests build a genuine obsolete cache from — never as a migration source"; `const SCHEMA_V3` becomes `const SCHEMA_V4: &str = include_str!("schema_v4.sql");` and `initialize` executes `SCHEMA_V4`.

- [ ] **Step 4: Classify and write the scalars**

Append to `crates/vault-index/src/codec.rs`:

```rust
/// One `property_scalars` row's value columns.
pub(crate) struct StoredScalar {
    pub kind: &'static str,
    pub string_value: Option<String>,
    pub number_value: Option<f64>,
}

fn digits(text: &[u8]) -> bool {
    !text.is_empty() && text.iter().all(u8::is_ascii_digit)
}

/// `YYYY-MM-DD`, optionally followed by `[ T]HH:mm[:ss[.fff]]`.
fn looks_like_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 10 || !(digits(&bytes[0..4]) && bytes[4] == b'-' && digits(&bytes[5..7]) && bytes[7] == b'-' && digits(&bytes[8..10])) {
        return false;
    }
    let rest = &bytes[10..];
    if rest.is_empty() {
        return true;
    }
    if !(rest[0] == b' ' || rest[0] == b'T') || rest.len() < 6 {
        return false;
    }
    let time = &rest[1..];
    if !(digits(&time[0..2]) && time[2] == b':' && digits(&time[3..5])) {
        return false;
    }
    let tail = &time[5..];
    match tail {
        [] => true,
        [b':', seconds @ ..] => {
            let (whole, fraction) = match seconds.iter().position(|b| *b == b'.') {
                Some(at) => (&seconds[..at], Some(&seconds[at + 1..])),
                None => (seconds, None),
            };
            whole.len() == 2 && digits(whole) && fraction.is_none_or(digits)
        }
        _ => false,
    }
}

pub(crate) fn property_scalar(value: &PropertyValue) -> StoredScalar {
    let (kind, string_value, number_value) = match value {
        PropertyValue::Null => ("null", None, None),
        PropertyValue::Boolean(flag) => ("boolean", None, Some(if *flag { 1.0 } else { 0.0 })),
        PropertyValue::Integer(number) => ("number", None, Some(*number as f64)),
        PropertyValue::Float(number) => ("number", None, Some(*number)),
        PropertyValue::String(text) if looks_like_date(text) => ("date", Some(text.clone()), None),
        PropertyValue::String(text) => ("string", Some(text.clone()), None),
        PropertyValue::Sequence(_) => ("list", None, None),
        PropertyValue::Mapping(_) => ("object", None, None),
    };
    StoredScalar { kind, string_value, number_value }
}
```

In `crates/vault-index/src/store.rs`, inside `replace_note`'s `for (ordinal, property) in note.properties.iter().enumerate()` loop, after the `INSERT INTO properties` statement, add:

```rust
            let scalar = codec::property_scalar(&property.value.value);
            transaction.execute(
                "INSERT INTO property_scalars \
                 (note_path, ordinal, key_text, key_fold, kind, string_value, number_value) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    path,
                    usize_to_i64(ordinal, "property ordinal")?,
                    property.key.value,
                    property.key.value.to_lowercase(),
                    scalar.kind,
                    scalar.string_value,
                    scalar.number_value,
                ],
            )?;
```

Both publication routes reach this loop — `begin_publish` (complete) and `publish_delta` (targeted) each call `replace_note` — and a deleted note's rows go by `ON DELETE CASCADE` like every other per-note table, so no other write site exists. `stored_note_metadata` and the `notes` fingerprint machinery are untouched: a metadata-only touch writes no scalar.

- [ ] **Step 5: Run the tests and see them pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test property_scalars --test schema_v3 --test recovery; echo "exit=$?"`

Expected: every test in the three files passes, `exit=0`.

Run the live oracle with its sixth claim — it is a proptest and takes minutes, so in the background with a bound:

```bash
TMPDIR="$PWD/target/tmp" timeout 900 cargo test -p vault-index --test live_oracle > target/tmp/t9-live-oracle.log 2>&1; echo "exit=$?" >> target/tmp/t9-live-oracle.log
```

Expected: the log ends `exit=0`.

- [ ] **Step 6: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index; echo "exit=$?"
TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
```

Expected: `exit=0` five times. `vault-server` runs because its daemons open fresh caches at the new version.

- [ ] **Step 7: Commit**

```bash
git add crates/vault-index
git commit -F - <<'COMMIT'
feat(index): schema version four, with property_scalars and the bases table

property_scalars mirrors properties row for row, classifying each value as string, number, boolean, date, null, list or object with the scalar in a typed column, written by the one replace_note path both publication routes share and removed by cascade. The bases table's shape lands for the next task to fill. An older cache is rebuilt, never migrated, as before; the live oracle gains a sixth claim, that the scalars mirror the properties after every fuzzed batch.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 10: The base as an indexed file — reconciliation on both routes, the live graph, hydration, resolution through bases, diagnostics, and link repair

`.base` joins `.md` as a parsed kind. Every route that reconciles notes now reconciles bases in the **same generation**: the complete route reads every `.base` the walk saw whose revision moved, the targeted route reads every `.base` a hint names, and both write the `bases` row, install the parsed `BaseFile` into the live graph, and re-resolve exactly the references whose answer the base's arrival, departure or view list could change. Hydration re-parses the stored bytes, so a restart never reads the vault for a base. A base that does not parse indexes anyway, with `parse_failed` and a `malformed_base` diagnostic under its path in `get_diagnostics`. A renamed base's inbound links are repaired like a note's.

**Files:**

- Create: `crates/vault-index/src/bases.rs`
- Modify: `crates/vault-index/Cargo.toml` (`vault-bases = { path = "../vault-bases" }`), `crates/vault-index/src/lib.rs` (`mod bases;`, re-exports)
- Modify: `crates/vault-index/src/live_graph.rs` (the bases map, base candidates, `PreparedGraphDelta::with_bases`)
- Modify: `crates/vault-index/src/store.rs` (`Publication.bases`, `replace_base`, `delete_base`, `stored_bases`, `load_base_records`), `crates/vault-index/src/store/delta.rs` (`DeltaPublication.bases`), `crates/vault-index/src/store/hydrate.rs`
- Modify: `crates/vault-index/src/reconcile.rs` (the complete route, `publish_snapshot`, `publish_delta`'s graph half, `live_graph_from_semantic`), `crates/vault-index/src/live_reconcile.rs` (both dirty routes, `DirtyBatch.bases`, `select_impact`, `bounded_catalog`, the nothing-changed early return)
- Modify: `crates/vault-index/src/reader.rs` (the resolver catalog), `crates/vault-index/src/mutate/rename.rs` (`identity`, the post-move catalog), `crates/vault-index/src/query/diagnostics.rs` (the `base` branch)
- Create: `crates/vault-index/tests/bases_index.rs`

**Interfaces:**

- Consumes: `vault_bases::{BaseFile, BaseParseError, parse_base}` (Task 1); `ResolutionNote::base`, `build_graph_with_bases`, `DiagnosticCode::MalformedBase`, `VaultPath::is_base` (Task 8); the v4 `bases` table (Task 9).
- Produces:

```rust
// crates/vault-index/src/bases.rs, re-exported from the crate root
#[derive(Clone, Debug, PartialEq)]
pub struct BaseRecord { pub file: Option<std::sync::Arc<vault_bases::BaseFile>>, pub views: Vec<String>, pub error: Option<vault_bases::BaseParseError> }
impl BaseRecord { pub fn parse(text: &str) -> Self; pub fn identity(&self, path: &VaultPath) -> vault_core::ResolutionNote; }
#[derive(Clone, Debug)]
pub struct BaseReplacement { pub path: VaultPath, pub revision: String, pub source: std::sync::Arc<str>, pub fingerprint: FileFingerprint, pub record: BaseRecord }
#[derive(Clone, Debug, Default)]
pub struct BaseDelta { pub replaced: Vec<BaseReplacement>, pub removed: Vec<VaultPath> }
impl BaseDelta { pub fn is_empty(&self) -> bool; pub fn paths(&self) -> std::collections::BTreeSet<VaultPath>; }

// LiveGraph
pub fn base(&self, path: &VaultPath) -> Option<&BaseRecord>;
pub fn base_paths(&self) -> impl Iterator<Item = &VaultPath>;
pub fn base_identity(&self, path: &VaultPath) -> Option<ResolutionNote>;
pub fn candidate_bases(&self, key: &DependencyKey) -> BTreeSet<VaultPath>;
pub(crate) fn install_bases(&mut self, replaced: Vec<(VaultPath, BaseRecord)>, removed: &[VaultPath]);
impl PreparedGraphDelta { pub(crate) fn with_bases(self, delta: &BaseDelta) -> Self; }

// IndexStore
pub(crate) fn stored_bases(&self) -> Result<BTreeMap<VaultPath, (String, FileFingerprint)>, IndexError>;
pub(crate) fn load_base_records(connection: &Connection) -> Result<Vec<(VaultPath, BaseRecord)>, IndexError>;  // free fn, reader and writer alike
pub(crate) fn apply_bases(transaction: &Transaction<'_>, delta: &BaseDelta) -> Result<(), IndexError>;   // free fn, both publication routes
pub(crate) fn connection(&self) -> &Connection;   // IndexStore, for the complete route's base reload

// IndexService::publish_delta gains `bases: &BaseDelta` as its last parameter
```

`BaseRecord.views` is the parsed file's view names, and empty for a base that failed to parse — such a base still **resolves** (a link to it is a link to a file that exists), and every view subpath on it is `missing_subpath`.

The routes that do not observe a tree (`ReconcileSource::observes_tree() == false`, test sources only) do not reconcile bases: the base set comes from the walk. Stated in `bases.rs`'s module comment.

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-index/tests/bases_index.rs`:

```rust
use std::collections::BTreeSet;
use std::fs;

mod common;

use tempfile::TempDir;
use vault_core::{Resolution, Subpath, VaultPath};
use vault_index::{ChangeCause, IndexConfig, IndexService, Mutation, Precondition};

const VIEWS: &str = "views:\n  - type: table\n    name: Table\n  - type: cards\n    name: Cards\n";

struct Fixture {
    service: IndexService,
    root: std::path::PathBuf,
    index: TempDir,
    _vault: TempDir,
}

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap()
}

fn fixture(files: &[(&str, &str)]) -> Fixture {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    for (path, text) in files {
        let full = vault.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    let root = vault.path().canonicalize().unwrap();
    let config = IndexConfig::explicit(&root, index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    Fixture { service, root, index, _vault: vault }
}

impl Fixture {
    fn write(&self, path: &str, text: &str) {
        fs::write(self.root.join(path), text).unwrap();
    }

    fn touch(&mut self, paths: &[&str]) -> u64 {
        let set: BTreeSet<VaultPath> = paths.iter().map(|p| vp(p)).collect();
        self.service.refresh_paths(set, ChangeCause::Watcher).unwrap().generation.get()
    }

    fn generation(&self) -> u64 {
        self.service.current_generation().unwrap().unwrap().get()
    }

    fn base_row(&self, path: &str) -> Option<(String, String)> {
        self.service
            .connection_for_test()
            .query_row("SELECT parse_status, view_names_json FROM bases WHERE path = ?1", [path], |row| Ok((row.get(0)?, row.get(1)?)))
            .ok()
    }

    fn resolution(&self, source: &str, destination: &str) -> Resolution {
        self.service.reader().unwrap().resolve_link(&vp(source), destination).unwrap().1
    }

    fn outgoing(&self, path: &str) -> Vec<Resolution> {
        let reader = self.service.reader().unwrap();
        reader.get_note(&vp(path)).unwrap().outgoing.into_iter().map(|r| r.resolution).collect()
    }
}

fn resolved(path: &str) -> Resolution {
    Resolution::Resolved { target: vp(path), subpath: None }
}

#[test]
fn a_cold_build_indexes_bases_with_their_views() {
    let fixture = fixture(&[("Views.base", VIEWS), ("Home.md", "![[Views.base#Table]]\n")]);
    assert_eq!(fixture.base_row("Views.base"), Some(("parsed".into(), r#"["Table","Cards"]"#.into())));
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![Resolution::Resolved { target: vp("Views.base"), subpath: Some(Subpath::View("Table".into())) }]
    );
    assert_eq!(fixture.resolution("Home.md", "Views.base"), resolved("Views.base"));
}

#[test]
fn a_base_create_change_and_delete_each_move_the_generation_on_the_targeted_route() {
    let mut fixture = fixture(&[("Home.md", "![[Views.base#Table]]\n")]);
    assert_eq!(fixture.outgoing("Home.md"), vec![Resolution::Unresolved]);
    let start = fixture.generation();

    fixture.write("Views.base", VIEWS);
    assert_eq!(fixture.touch(&["Views.base"]), start + 1, "a created base publishes");
    assert!(fixture.base_row("Views.base").is_some());
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![Resolution::Resolved { target: vp("Views.base"), subpath: Some(Subpath::View("Table".into())) }],
        "the incoming reference re-resolved without its source changing"
    );

    fixture.write("Views.base", "views:\n  - type: table\n    name: Other\n");
    assert_eq!(fixture.touch(&["Views.base"]), start + 2, "a changed base publishes");
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![Resolution::MissingSubpath { target: vp("Views.base"), subpath: Subpath::View("Table".into()) }],
        "a view leaving the list moves the answer"
    );

    fs::remove_file(fixture.root.join("Views.base")).unwrap();
    assert_eq!(fixture.touch(&["Views.base"]), start + 3, "a deleted base publishes");
    assert!(fixture.base_row("Views.base").is_none());
    assert_eq!(fixture.outgoing("Home.md"), vec![Resolution::Unresolved]);
}

#[test]
fn the_complete_route_reconciles_bases_too() {
    let mut fixture = fixture(&[("Views.base", VIEWS), ("Home.md", "[[Views.base]]\n")]);
    let start = fixture.generation();
    fixture.write("Views.base", "views:\n  - type: list\n    name: Only\n");
    let report = fixture.service.refresh(false).unwrap();
    assert_eq!(report.generation.get(), start + 1);
    assert_eq!(fixture.base_row("Views.base").unwrap().1, r#"["Only"]"#);
    let unchanged = fixture.service.refresh(false).unwrap();
    assert_eq!(unchanged.generation.get(), start + 1, "an unchanged base publishes nothing");
}

#[test]
fn parse_diagnostics_appear_and_clear() {
    let mut fixture = fixture(&[("Broken.base", "views: [unclosed\n")]);
    assert_eq!(fixture.base_row("Broken.base").unwrap().0, "parse_failed");
    let reader = fixture.service.reader().unwrap();
    let page = reader.get_diagnostics(Some(&vp("Broken.base")), None, None, None).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].code, vault_core::DiagnosticCode::MalformedBase);
    assert!(page.items[0].span.is_some(), "the YAML position travels");
    assert_eq!(fixture.resolution("Broken.base", "Broken.base"), resolved("Broken.base"), "a broken base still resolves");

    fixture.write("Broken.base", VIEWS);
    fixture.touch(&["Broken.base"]);
    let reader = fixture.service.reader().unwrap();
    assert!(reader.get_diagnostics(Some(&vp("Broken.base")), None, None, None).unwrap().items.is_empty());
    assert_eq!(fixture.base_row("Broken.base").unwrap().0, "parsed");
}

#[test]
fn hydration_restores_the_parsed_base_without_reading_the_vault() {
    let fixture = fixture(&[("Views.base", VIEWS)]);
    let root = fixture.root.clone();
    let index_path = fixture.index.path().join("index.sqlite3");
    let Fixture { service, index: _index, _vault, .. } = fixture;
    drop(service);
    // The vault copy of the base is replaced with garbage: a restart that
    // re-read it would index a parse failure; one that hydrates does not.
    fs::write(root.join("Views.base"), "garbage: [").unwrap();
    let config = IndexConfig::explicit(&root, &index_path).unwrap();
    let reopened = IndexService::open(config).unwrap();
    let state = reopened.reader().unwrap().published_state().unwrap();
    let graph = state.graph.expect("a hydrated graph");
    let record = graph.base(&vp("Views.base")).expect("the base is in the graph");
    assert_eq!(record.views, vec!["Table".to_string(), "Cards".to_string()]);
    assert!(record.file.is_some());
}

#[test]
fn renaming_a_base_repairs_the_links_to_it() {
    let mut fixture = fixture(&[("Views.base", VIEWS), ("Home.md", "![[Views.base#Table]]\n")]);
    fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: vp("Views.base"),
            to: vp("Renamed.base"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .unwrap();
    assert_eq!(fs::read_to_string(fixture.root.join("Home.md")).unwrap(), "![[Renamed.base#Table]]\n");
    assert_eq!(
        fixture.outgoing("Home.md"),
        vec![Resolution::Resolved { target: vp("Renamed.base"), subpath: Some(Subpath::View("Table".into())) }]
    );
    assert!(fixture.base_row("Views.base").is_none());
    assert!(fixture.base_row("Renamed.base").is_some());
}

#[test]
fn a_hidden_base_is_never_indexed() {
    let fixture = fixture(&[(".trash/Old.base", VIEWS)]);
    assert!(fixture.base_row(".trash/Old.base").is_none());
}
```

`Precondition::Any` is the unconditional precondition (`mutate.rs:71-79`).

- [ ] **Step 2: Run them to see them fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test bases_index; echo "exit=$?"`

Expected: `no method named base` on `LiveGraph`, then (once it compiles) every test failing on an empty `bases` table; `exit=101`.

- [ ] **Step 3: The base record and the delta**

Add `vault-bases = { path = "../vault-bases" }` to `crates/vault-index/Cargo.toml` `[dependencies]`.

Create `crates/vault-index/src/bases.rs`:

```rust
//! `.base` files as an indexed kind.
//!
//! A base is read like a note — fingerprint, read once, fingerprint again —
//! and parsed into a [`BaseRecord`]; its row lands in `bases` and its record
//! in the live graph in the same transaction and install as every note of
//! the same generation. The set of bases is what the file-tree walk saw: a
//! [`crate::ReconcileSource`] that observes no tree reconciles no bases.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use vault_bases::{BaseFile, BaseParseError, parse_base};
use vault_core::{ResolutionNote, ScanError, SourceDocument, VaultPath};

use crate::error::IndexError;
use crate::inventory::ReconcileSource;
use crate::model::FileFingerprint;

#[derive(Clone, Debug, PartialEq)]
pub struct BaseRecord {
    pub file: Option<Arc<BaseFile>>,
    pub views: Vec<String>,
    pub error: Option<BaseParseError>,
}

impl BaseRecord {
    pub fn parse(text: &str) -> Self {
        match parse_base(text) {
            Ok(file) => Self { views: file.view_names(), file: Some(Arc::new(file)), error: None },
            Err(error) => Self { file: None, views: Vec::new(), error: Some(error) },
        }
    }

    fn unreadable(message: String) -> Self {
        Self { file: None, views: Vec::new(), error: Some(BaseParseError { message, span: None }) }
    }

    pub fn identity(&self, path: &VaultPath) -> ResolutionNote {
        ResolutionNote::base(path.clone(), self.views.clone())
    }
}

#[derive(Clone, Debug)]
pub struct BaseReplacement {
    pub path: VaultPath,
    pub revision: String,
    pub source: Arc<str>,
    pub fingerprint: FileFingerprint,
    pub record: BaseRecord,
}

#[derive(Clone, Debug, Default)]
pub struct BaseDelta {
    pub replaced: Vec<BaseReplacement>,
    pub removed: Vec<VaultPath>,
}

impl BaseDelta {
    pub fn is_empty(&self) -> bool {
        self.replaced.is_empty() && self.removed.is_empty()
    }

    pub fn paths(&self) -> BTreeSet<VaultPath> {
        self.replaced.iter().map(|r| r.path.clone()).chain(self.removed.iter().cloned()).collect()
    }
}

/// Read one base as it is on disk now, `None` when it is absent. A base
/// whose bytes are not UTF-8 or cannot be read still indexes, as a parse
/// failure naming why — it exists, so a link to it resolves.
fn read_base(source: &dyn ReconcileSource, path: &VaultPath) -> Result<Option<BaseReplacement>, IndexError> {
    let Some(before) = source.fingerprint(path)? else {
        return Ok(None);
    };
    let (text, record): (Arc<str>, BaseRecord) = match source.read_bytes(path) {
        Ok(bytes) => match SourceDocument::from_utf8(path.clone(), bytes) {
            Ok(document) => {
                let text: Arc<str> = document.text().into();
                let record = BaseRecord::parse(&text);
                (text, record)
            }
            Err(error) => (Arc::from(""), BaseRecord::unreadable(error.to_string())),
        },
        Err(ScanError::UnreadableFile { message, .. }) => (Arc::from(""), BaseRecord::unreadable(message)),
        Err(ScanError::InaccessibleRoot { message }) => return Err(IndexError::InvalidVaultRoot(message)),
    };
    if source.fingerprint(path)? != Some(before) {
        return Err(IndexError::VaultChangedDuringRefresh);
    }
    let revision = SourceDocument::new(path.clone(), text.clone()).revision().as_str().to_string();
    Ok(Some(BaseReplacement { path: path.clone(), revision, source: text, fingerprint: before, record }))
}

/// The delta that brings `stored` to what is on disk for `candidates` (the
/// bases the walk saw, or the base paths a hint named). A candidate whose
/// revision did not move is left alone; a stored base that is not on disk is
/// removed. `verify` re-reads even an unchanged fingerprint.
pub(crate) fn plan(
    source: &dyn ReconcileSource,
    stored: &BTreeMap<VaultPath, (String, FileFingerprint)>,
    candidates: &BTreeSet<VaultPath>,
    complete: bool,
    verify: bool,
) -> Result<BaseDelta, IndexError> {
    let mut delta = BaseDelta::default();
    for path in candidates {
        if !path.is_base() || path.is_hidden() {
            continue;
        }
        let known = stored.get(path);
        if !verify {
            if let (Some((_, fingerprint)), Some(now)) = (known, source.fingerprint(path)?) {
                if *fingerprint == now {
                    continue;
                }
            }
        }
        match read_base(source, path)? {
            Some(replacement) => {
                if known.map(|(revision, _)| revision.as_str()) != Some(replacement.revision.as_str()) {
                    delta.replaced.push(replacement);
                }
            }
            None => {
                if known.is_some() {
                    delta.removed.push(path.clone());
                }
            }
        }
    }
    if complete {
        for path in stored.keys() {
            if !candidates.contains(path) {
                delta.removed.push(path.clone());
            }
        }
    }
    Ok(delta)
}
```

A revision-identical re-read with a new fingerprint (a `touch`) is dropped from the delta above; its stored fingerprint stays stale until the next content change, which costs one extra read per touched base per complete refresh and never publishes a generation. That is the accepted trade for not adding a base fingerprint-only write path; it is stated here so a reviewer does not take it for an oversight.

In `crates/vault-index/src/lib.rs`: `mod bases;` and `pub use bases::{BaseDelta, BaseRecord, BaseReplacement};`.

- [ ] **Step 4: The live graph holds bases**

In `crates/vault-index/src/live_graph.rs`:

- import `crate::bases::{BaseDelta, BaseRecord}`;
- `LiveGraph` gains `bases: BTreeMap<VaultPath, BaseRecord>` and `base_candidates: BTreeMap<DependencyKey, BTreeSet<VaultPath>>`, both empty in `LiveGraph::empty`;
- `PreparedGraphDelta` gains `base_updates: Vec<(VaultPath, BaseRecord)>` and `base_removals: Vec<VaultPath>`, both empty where `prepare_delta` builds it;
- add:

```rust
impl PreparedGraphDelta {
    /// This delta plus a base delta, installed together by `install`.
    pub(crate) fn with_bases(mut self, delta: &BaseDelta) -> Self {
        self.base_updates = delta.replaced.iter().map(|r| (r.path.clone(), r.record.clone())).collect();
        self.base_removals = delta.removed.clone();
        self
    }
}

impl LiveGraph {
    pub fn base(&self, path: &VaultPath) -> Option<&BaseRecord> {
        self.bases.get(path)
    }

    pub fn base_paths(&self) -> impl Iterator<Item = &VaultPath> {
        self.bases.keys()
    }

    /// A base's identity as resolution sees it: its path and its views.
    pub fn base_identity(&self, path: &VaultPath) -> Option<ResolutionNote> {
        self.bases.get(path).map(|record| record.identity(path))
    }

    /// The bases a reference looked up under `key` could reach — the base
    /// counterpart of `candidate_notes`.
    pub fn candidate_bases(&self, key: &DependencyKey) -> BTreeSet<VaultPath> {
        self.base_candidates.get(key).cloned().unwrap_or_default()
    }

    /// Replace and remove base records, keeping the candidate index exact.
    pub(crate) fn install_bases(&mut self, replaced: Vec<(VaultPath, BaseRecord)>, removed: &[VaultPath]) {
        let retire = |graph: &mut Self, path: &VaultPath| {
            if let Some(old) = graph.bases.remove(path) {
                for key in changed_candidate_keys(&ResolutionIdentityChange { old: Some(old.identity(path)), new: None }) {
                    if let Some(set) = graph.base_candidates.get_mut(&key) {
                        set.remove(path);
                        if set.is_empty() {
                            graph.base_candidates.remove(&key);
                        }
                    }
                }
            }
        };
        for path in removed {
            retire(self, path);
        }
        for (path, record) in replaced {
            retire(self, &path);
            for key in changed_candidate_keys(&ResolutionIdentityChange { old: None, new: Some(record.identity(&path)) }) {
                self.base_candidates.entry(key).or_default().insert(path.clone());
            }
            self.bases.insert(path, record);
        }
    }
}
```

- at the end of `install`, before `self.generation = delta.generation;`: `self.install_bases(delta.base_updates, &delta.base_removals);` (move the two fields out of `delta` with the other moves; `delta` is consumed by value).

`changed_candidate_keys` keys a removed or added identity by every lookup route (`add_identity_keys`), which for a base is exact path, implicit extension and file name — never stem, because a base's name does not end in `.md`. That is what makes `[[Views]]` never reach `Views.base` in the bounded catalog either.

- [ ] **Step 5: The store writes and reads bases**

In `crates/vault-index/src/store.rs`, add the two free functions both routes use, beside `note_revision_with`:

```rust
fn diagnostics_json(record: &BaseRecord) -> String {
    match &record.error {
        None => "[]".to_string(),
        Some(error) => serde_json::json!([{
            "code": codec::encode_diagnostic_code(vault_core::DiagnosticCode::MalformedBase),
            "severity": codec::encode_severity(vault_core::Severity::Warning),
            "message": format!("base failed to parse: {}", error.message),
            "span_start": error.span.map(|span| span.start()),
            "span_end": error.span.map(|span| span.end()),
        }])
        .to_string(),
    }
}

/// Apply one base delta inside a publication's transaction.
pub(crate) fn apply_bases(transaction: &Transaction<'_>, delta: &BaseDelta) -> Result<(), IndexError> {
    for path in &delta.removed {
        transaction.execute("DELETE FROM bases WHERE path = ?1", params![path.as_str()])?;
    }
    for base in &delta.replaced {
        transaction.execute(
            "INSERT OR REPLACE INTO bases (path, content_revision, source_bytes, observed_size, \
             observed_mtime_seconds, observed_mtime_nanos, parse_status, view_names_json, diagnostics_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                base.path.as_str(),
                base.revision,
                base.source.as_bytes(),
                u64_to_i64(base.fingerprint.size, "observed size")?,
                base.fingerprint.modified_seconds,
                i64::from(base.fingerprint.modified_nanos),
                if base.record.error.is_some() { "parse_failed" } else { "parsed" },
                serde_json::to_string(&base.record.views)?,
                diagnostics_json(&base.record),
            ],
        )?;
    }
    Ok(())
}

/// Every stored base, re-parsed from its stored bytes — hydration and the
/// complete route both read this, so neither reads the vault for a base it
/// already knows.
pub(crate) fn load_base_records(connection: &Connection) -> Result<Vec<(VaultPath, BaseRecord)>, IndexError> {
    let mut statement = connection.prepare("SELECT path, source_bytes, parse_status FROM bases ORDER BY path")?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?, row.get::<_, String>(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(path, bytes, _status)| {
            let path = codec::decode_path(&path)?;
            let text = String::from_utf8_lossy(&bytes);
            Ok((path, BaseRecord::parse(&text)))
        })
        .collect()
}
```

A base stored as unreadable (`source_bytes` empty, the read failed) re-parses as an empty base on hydration — it parses, with no views — so a hydrated graph can hold `parsed` where the row says `parse_failed`. Close that by keeping the stored status: when `_status == "parse_failed"` and the re-parse succeeds, return `BaseRecord { file: None, views: Vec::new(), error: Some(BaseParseError { message: "unreadable when indexed".into(), span: None }) }` instead. Write the `match` on `_status` (and rename it `status`) so the two agree.

and on `IndexStore`:

```rust
    pub(crate) fn stored_bases(&self) -> Result<BTreeMap<VaultPath, (String, FileFingerprint)>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT path, content_revision, observed_size, observed_mtime_seconds, observed_mtime_nanos FROM bases",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(path, revision, size, seconds, nanos)| {
                Ok((
                    codec::decode_path(&path)?,
                    (
                        revision,
                        FileFingerprint {
                            size: u64::try_from(size).map_err(|_| IndexError::IncompatibleIndex("negative size".into()))?,
                            modified_seconds: seconds,
                            modified_nanos: u32::try_from(nanos).map_err(|_| IndexError::IncompatibleIndex("bad nanos".into()))?,
                        },
                    ),
                ))
            })
            .collect()
    }
```

`serde_json::to_string(&base.record.views)?` relies on `impl From<serde_json::Error> for IndexError` (`error.rs:107`).

`Publication` gains `pub bases: &'a BaseDelta`, and `begin_publish` calls `apply_bases(&transaction, bases)?;` right after `tree::apply(&transaction, tree)?;`. `DeltaPublication` gains `pub bases: &'a BaseDelta`, and `publish_delta` (in `store/delta.rs`) calls `super::apply_bases(&transaction, bases)?;` right after its `super::tree::apply(&transaction, tree)?;`. The compiler names every struct literal that needs the new field (the two routes, plus tests in `store/delta.rs` and `tests/delta_publication.rs`); pass `&BaseDelta::default()` in every test literal.

In `crates/vault-index/src/store/hydrate.rs`, at the end of `hydrate_live_graph`, replace `LiveGraph::from_hydrated(generation, notes, references)` with:

```rust
    let bases = crate::store::load_base_records(&transaction)?;
    let mut graph = LiveGraph::from_hydrated(generation, notes, references)?;
    graph.install_bases(bases, &[]);
    Ok(graph)
```

`hydration_never_selects_full_note_bodies_or_metadata` in that file asserts which tables hydration reads; add `bases` to its allowed list with the comment "a base's bytes are its whole state, and re-parsing them is what keeps a restart from reading the vault".

- [ ] **Step 6: The complete route**

In `crates/vault-index/src/reconcile.rs`, the imports become:

```rust
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use vault_core::{
    Diagnostic, DiagnosticCode, LinkTarget, ParsedNote, Resolution, ResolutionNote, ScanError,
    ScanReport, SemanticGraph, Severity, SourceDocument, SourceError, TreeEntryKind, VaultPath,
    build_graph_with_bases, parse_note,
};

use crate::bases::{BaseDelta, BaseRecord};
```

(the other `use crate::…` lines stay; `build_graph` leaves the import because its one use in this file, `reconcile.rs:857`, becomes `build_graph_with_bases` below).

Add to `impl IndexStore` in `crates/vault-index/src/store.rs`, beside `hydrate_live_graph`:

```rust
    /// The writer's own connection, for the reads a publication makes between
    /// its plan and its write (the stored base records).
    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }
```

In `try_complete_refresh`, immediately after the `let tree_delta = if self.source.observes_tree() { … };` statement:

```rust
        // The bases the walk saw. A source that observes no tree reconciles
        // no bases (see `bases.rs`).
        let observed_bases: BTreeSet<VaultPath> = observed_tree
            .iter()
            .filter(|entry| entry.kind == TreeEntryKind::File && entry.path.is_base())
            .map(|entry| entry.path.clone())
            .collect();
        let base_delta = if self.source.observes_tree() {
            crate::bases::plan(self.source.as_ref(), &self.store.stored_bases()?, &observed_bases, true, verify)?
        } else {
            BaseDelta::default()
        };
```

immediately after the existing

```rust
        if tree_delta.is_generational() {
            semantic_change = true;
        }
```

add

```rust
        // A base moving is a change a client can only learn from a new
        // generation, exactly like a note's.
        if !base_delta.is_empty() {
            semantic_change = true;
        }
```

and in **both** `self.publish_snapshot(` calls, insert one argument line `base_delta,` directly after the `tree_delta,` line. (The `!semantic_change` early return in between never sees a non-empty base delta: one sets `semantic_change`.)

`publish_snapshot` gains the parameter `base_delta: BaseDelta,` directly after `tree_delta: TreeDelta,`. Inside it, directly before `let resolution_start = Instant::now();`:

```rust
        // Every base the new snapshot holds: the stored ones this walk did
        // not remove, overlaid with the ones it replaced. Their identities
        // join the resolution catalog; their records join the live graph.
        let removed_bases: BTreeSet<&VaultPath> = base_delta.removed.iter().collect();
        let mut base_records: BTreeMap<VaultPath, BaseRecord> =
            crate::store::load_base_records(self.store.connection())?
                .into_iter()
                .filter(|(path, _)| !removed_bases.contains(path))
                .collect();
        for replacement in &base_delta.replaced {
            base_records.insert(replacement.path.clone(), replacement.record.clone());
        }
        let base_identities: Vec<ResolutionNote> = base_records
            .iter()
            .map(|(path, record)| record.identity(path))
            .collect();
```

then replace `let report = build_graph(all_notes, scan_diagnostics.clone());` with

```rust
        let report = build_graph_with_bases(all_notes, base_identities, scan_diagnostics.clone());
```

add `bases: &base_delta,` as the last field of the `Publication { … }` literal, and replace

```rust
        let prepared = Arc::new(live_graph_from_semantic(next_generation, &report.graph)?);
```

with

```rust
        let prepared = Arc::new(live_graph_from_semantic(
            next_generation,
            &report.graph,
            base_records.into_iter().collect(),
        )?);
```

`live_graph_from_semantic` becomes (its loop over notes is unchanged; only the signature and the tail move):

```rust
fn live_graph_from_semantic(
    generation: Generation,
    graph: &SemanticGraph,
    bases: Vec<(VaultPath, BaseRecord)>,
) -> Result<LiveGraph, IndexError> {
    let mut notes = Vec::new();
    let mut references = Vec::new();
    for path in graph.note_paths() {
        // … unchanged: push each HydratedNote and its HydratedReferences …
    }
    let mut live = LiveGraph::from_hydrated(generation, notes, references)?;
    live.install_bases(bases, &[]);
    Ok(live)
}
```

where the elided loop is the existing body of the function from `for path in graph.note_paths() {` to its closing `}`, copied as it stands.

`IndexService::publish_delta` gains the parameter `bases: &BaseDelta,` directly after `replacement_references: &[HydratedReference],`. After its existing `debug_assert_eq!(…);` add:

```rust
        debug_assert!(
            std::ptr::eq(publication.bases, bases),
            "the row delta and the graph delta must carry the same base delta"
        );
```

and replace the preparation

```rust
            graph.prepare_delta(
                expected,
                replacement_notes,
                removed_paths,
                replacement_references,
            )?
```

with

```rust
            graph
                .prepare_delta(
                    expected,
                    replacement_notes,
                    removed_paths,
                    replacement_references,
                )?
                .with_bases(bases)
```

Every other caller of `IndexService::publish_delta` the compiler names (tests under `crates/vault-index/tests/`) passes `&vault_index::BaseDelta::default()` as the new last argument, and every `DeltaPublication { … }` literal there gains `bases: &BaseDelta::default(),` — the reference must outlive the call, so bind `let no_bases = BaseDelta::default();` first and pass `&no_bases` to both, which also satisfies the `ptr::eq` tripwire.

- [ ] **Step 7: The targeted routes**

In `crates/vault-index/src/live_reconcile.rs`, add `use crate::bases::BaseDelta;` and `TreeEntryKind` to the `vault_core` import, then:

`DirtyBatch` gains a field:

```rust
    /// The bases this cycle read, planned against the stored ones. Read once,
    /// with the bodies, so a re-planned attempt re-reads no base.
    bases: BaseDelta,
```

In `refresh_paths_body`, replace

```rust
        let batch = DirtyBatch {
            states,
            scan_diagnostics: ScanDiagnostics::Patch(diagnostics),
            tree: self.observe_tree_paths(paths)?,
        };
```

with

```rust
        // The `.base` paths the hint named, read and planned beside the notes.
        let hinted_bases: BTreeSet<VaultPath> = paths
            .iter()
            .filter(|path| path.is_base() && !path.is_hidden())
            .cloned()
            .collect();
        let bases = if self.source.observes_tree() && !hinted_bases.is_empty() {
            crate::bases::plan(self.source.as_ref(), &self.store.stored_bases()?, &hinted_bases, false, false)?
        } else {
            BaseDelta::default()
        };
        let batch = DirtyBatch {
            states,
            scan_diagnostics: ScanDiagnostics::Patch(diagnostics),
            tree: self.observe_tree_paths(paths)?,
            bases,
        };
```

In `refresh_dirty_paths`, replace

```rust
        let batch = DirtyBatch {
            states,
            scan_diagnostics: ScanDiagnostics::Complete(diagnostics),
            tree,
        };
```

with

```rust
        let observed_bases: BTreeSet<VaultPath> = observed_tree
            .iter()
            .filter(|entry| entry.kind == TreeEntryKind::File && entry.path.is_base())
            .map(|entry| entry.path.clone())
            .collect();
        let bases = if self.source.observes_tree() {
            crate::bases::plan(self.source.as_ref(), &self.store.stored_bases()?, &observed_bases, true, verify)?
        } else {
            BaseDelta::default()
        };
        let batch = DirtyBatch {
            states,
            scan_diagnostics: ScanDiagnostics::Complete(diagnostics),
            tree,
            bases,
        };
```

In `try_reconcile_batch`, the nothing-changed condition becomes

```rust
        if replaced.is_empty()
            && removed.is_empty()
            && !scan_diagnostics_changed
            && !batch.tree.is_generational()
            && batch.bases.is_empty()
        {
```

the selection call becomes `self.select_impact(&graph, &replaced, &removed, &batch.bases)`, the `DeltaPublication { … }` literal gains `bases: &batch.bases,` after `tree: &batch.tree,`, and the `self.publish_delta(…)` call gains `&batch.bases` as its last argument.

`select_impact` gains the parameter `bases: &BaseDelta` after `removed: &[VaultPath]`, and its first lines become

```rust
        let changed_sources: BTreeSet<VaultPath> = replaced
            .iter()
            .map(|(note, _)| note.source.path().clone())
            .collect();
        // A removed base leaves the catalog like a removed note; a replaced
        // base enters it with its new views. Bases carry no references, so they
        // are never changed sources.
        let mut removed_set: BTreeSet<VaultPath> = removed.iter().cloned().collect();
        removed_set.extend(bases.removed.iter().cloned());

        let mut new_identities: BTreeMap<VaultPath, ResolutionNote> = replaced
            .iter()
            .map(|(note, _)| (note.source.path().clone(), ResolutionNote::from(note)))
            .collect();
        new_identities.extend(
            bases
                .replaced
                .iter()
                .map(|replacement| (replacement.path.clone(), replacement.record.identity(&replacement.path))),
        );
```

— the two `identity_changes` loops that follow already cover bases, because they go through `graph_identity`, which now answers for a base too. In the complete-resolution catalog branch, directly before `catalog.extend(new_identities);`, add:

```rust
            for path in graph.base_paths() {
                if removed_set.contains(path) || new_identities.contains_key(path) {
                    continue;
                }
                if let Some(identity) = graph.base_identity(path) {
                    catalog.insert(path.clone(), identity);
                }
            }
```

`graph_identity` becomes:

```rust
/// The graph's current identity for `path`, as resolution sees it: a note's
/// headings and blocks, or a base's views.
fn graph_identity(graph: &LiveGraph, path: &VaultPath) -> Option<ResolutionNote> {
    graph
        .note(path)
        .map(|note| ResolutionNote {
            path: note.path,
            headings: note.headings,
            blocks: note.blocks,
            views: None,
        })
        .or_else(|| graph.base_identity(path))
}
```

In `bounded_catalog`'s `collect` closure, directly after the `for id in graph.candidate_notes(&key) { … }` loop:

```rust
            for path in graph.candidate_bases(&key) {
                if !removed_set.contains(&path) {
                    wanted.insert(path);
                }
            }
```

(a replaced base is already reached through `added_by_key`, built from `new_identities`, and the final catalog fill goes through `graph_identity`).

`confirm_planned_presence`, directly before its final `for (path, expected) in expectations {` loop:

```rust
        for replacement in &batch.bases.replaced {
            expectations.insert(&replacement.path, true);
        }
        for path in &batch.bases.removed {
            expectations.insert(path, false);
        }
```

`PathChanges` needs nothing: a base is a file, so its tree row moving already puts its path in `changes` through `merge_tree_changes` — which is what Task 12's staleness rule reads.

- [ ] **Step 8: The reader, link repair, and the diagnostics union**

In `crates/vault-index/src/reader.rs`, `resolver()`'s catalog construction becomes:

```rust
        let notes = graph.note_paths().into_iter().filter_map(|path| {
            graph.note(&path).map(|note| vault_core::ResolutionNote {
                path,
                headings: note.headings,
                blocks: note.blocks,
                views: None,
            })
        });
        let bases: Vec<vault_core::ResolutionNote> = graph
            .base_paths()
            .filter_map(|path| graph.base_identity(path))
            .collect();
        let resolver = Arc::new(Resolver::from_catalog(notes.chain(bases)));
```

In `crates/vault-index/src/mutate/rename.rs`, `identity` and `at_path` become:

```rust
/// The identity a path carries in `graph`, as resolution sees it: a note's
/// headings and blocks, a base's views, or — for an attachment or a folder —
/// a synthetic identity with neither, which is exactly what
/// `changed_candidate_keys` needs to produce its lookup keys.
fn identity(graph: &LiveGraph, path: &VaultPath) -> ResolutionNote {
    graph
        .note(path)
        .map(|note| ResolutionNote {
            path: note.path,
            headings: note.headings,
            blocks: note.blocks,
            views: None,
        })
        .or_else(|| graph.base_identity(path))
        .unwrap_or_else(|| ResolutionNote {
            path: path.clone(),
            headings: Vec::new(),
            blocks: Vec::new(),
            views: None,
        })
}

fn at_path(note: &ResolutionNote, destination: &VaultPath) -> ResolutionNote {
    ResolutionNote {
        path: destination.clone(),
        headings: note.headings.clone(),
        blocks: note.blocks.clone(),
        views: note.views.clone(),
    }
}
```

In `plan_repair`, the comment above the post-move catalog becomes "The catalog the vault will have *after* the moves, so a preserved spelling is checked against the world it will actually live in: notes and bases, never attachments — putting an attachment in a resolver would invent a note that does not exist." Directly after its `for path in graph.note_paths() { … }` loop, add:

```rust
    for path in graph.base_paths() {
        if moves.contains_key(path) {
            continue;
        }
        if let Some(base) = graph.base_identity(path) {
            catalog.insert(path.clone(), base);
        }
    }
```

and inside the `for (from, to) in moves {` loop, after its `if let Some(note) = graph.note(from) { … }` block:

```rust
        if graph.base(from).is_some() {
            catalog.insert(to.clone(), at_path(&identity(graph, from), to));
            note_destinations.insert(to.clone());
        }
```

The move itself goes through the existing coordinator path, whose reconciliation of `from` and `to` is a targeted refresh naming two `.base` paths — Step 7's route.

In `crates/vault-index/src/query/diagnostics.rs`, `DIAGNOSTIC_UNION_CTE` gains a fourth branch before its closing `)`:

```sql
    UNION ALL \
    SELECT b.path, json_extract(d.value, '$.span_start'), json_extract(d.value, '$.span_end'), \
           json_extract(d.value, '$.code'), json_extract(d.value, '$.severity'), \
           json_extract(d.value, '$.message'), 'base' AS owner_kind, CAST(d.key AS INTEGER) AS owner_id \
      FROM bases b, json_each(b.diagnostics_json) d \
```

`rusqlite`'s bundled SQLite includes JSON1. The cursor's `owner_kind` is a free string, so the paging tie-break over `(path, …, owner_kind, owner_id)` stays total.

- [ ] **Step 9: Run the tests and see them pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test bases_index; echo "exit=$?"`

Expected: `test result: ok. 7 passed`, `exit=0`.

Then the oracles, backgrounded with a bound — they now also see `.base` paths only if their generators produce them (they do not; Task 10 does not widen them), so they prove the note behaviour is unchanged:

```bash
TMPDIR="$PWD/target/tmp" timeout 1200 cargo test -p vault-index --test live_oracle --test reconciliation_oracle --test rename_repair > target/tmp/t10-oracles.log 2>&1; echo "exit=$?" >> target/tmp/t10-oracles.log
```

Expected: the log ends `exit=0`.

- [ ] **Step 10: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index; echo "exit=$?"
TMPDIR="$PWD/target/tmp" cargo test -p vault-server; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
```

Expected: `exit=0` five times.

- [ ] **Step 11: Commit**

```bash
git add crates/vault-index
git commit -F - <<'COMMIT'
feat(index): reconcile .base files as an indexed kind on both routes

Every route that reconciles notes now reconciles bases in the same generation: the bases row is written, the parsed BaseFile installed in the live graph, and exactly the references a base's arrival, departure or view list could move are re-resolved, on the complete route through build_graph_with_bases and on the targeted routes through the dependency keys. Hydration re-parses stored bytes, so a restart never reads the vault for a base. A base that does not parse indexes with parse_failed and a malformed_base diagnostic in get_diagnostics; a renamed base's inbound links are repaired.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 11: `evaluate_base` and `list_bases` — the row source over the index, the wire types, the handlers, paging, every error code, and conformance over both transports

The daemon implements `RowSource` inside one generation-consistent read: SQLite (through the reader's own query-only transaction) answers facts, properties, tags, links, embeds, backlinks and the prefilter narrowing; the published live graph answers the base itself and resolution. Two requests are added to protocol version 1: `evaluate_base` (rows with typed cells at a generation, paged) and `list_bases` (the bases with their view names and parse status, paged). A result is computed once per (base, view, `this_path`, generation) and its pages are served from that one computation, so `now()` and `random()` cannot shift between pages; Task 12 bounds that store and gives it the knob.

**Files:**

- Create: `crates/vault-index/src/query/bases.rs`; modify `crates/vault-index/src/query.rs` (`pub(crate) mod bases;`), `crates/vault-index/src/reader.rs` (`read_with_graph`), `crates/vault-index/src/cursor.rs` (`CursorPosition::Base`), `crates/vault-index/src/lib.rs` (re-exports)
- Create: `crates/vault-index/tests/bases_query.rs`
- Create: `crates/vault-protocol/src/bases.rs`; modify `crates/vault-protocol/src/operations.rs`, `crates/vault-protocol/src/error.rs`, `crates/vault-protocol/src/lib.rs`
- Create: `crates/vault-server/src/bases.rs`; modify `crates/vault-server/src/lib.rs` (two dispatch arms, the cache on `Server`), `crates/vault-server/src/convert.rs` (`cell`, `view_options`, `index_error` gains nothing), `crates/vault-server/Cargo.toml` (`vault-bases`)
- Create: `crates/vault-server/tests/bases_ops.rs`
- Modify: `crates/vault-server/tests/conformance.rs` (`build_vault`), `crates/vault-server/tests/fixtures/conformance.jsonl`

**Interfaces:**

- Consumes: `LiveGraph::{base, base_paths, contains_note}`, `BaseRecord` (Task 10); `compile_view`, `evaluate_view`, `CompiledView`, `ViewResult`, `RowResult`, `SummaryResult`, `ColumnDecl`, `CompileError`, `Cell`, `RowSource`, `Prefilter`, `PropertyType`, `Clock`, `format_date`, `EvalError` (Tasks 3–7); `IndexReader::{read, resolver}`, `codec::{decode_path, decode_property_value}`, `encode_cursor`/`decode_cursor`, `effective_limit` (existing).
- Produces:

```rust
// vault-index
pub struct BaseQuery<'a> { pub path: &'a VaultPath, pub view: Option<&'a str>, pub this_path: Option<&'a VaultPath>, pub types: &'a BTreeMap<String, PropertyType> }
pub struct BaseAnswer { pub generation: Generation, pub view: ViewDecl, pub columns: Vec<ColumnDecl>, pub result: ViewResult, pub dependencies: ViewDependencies }
pub enum BaseQueryError { Index(IndexError), NotFound(VaultPath), Invalid(BaseParseError), Compile(CompileError), ThisPath(String) }
pub struct BaseSummary { pub path: VaultPath, pub status: BaseStatus, pub views: Vec<String> }
pub enum BaseStatus { Parsed, ParseFailed(BaseParseError) }
impl IndexReader {
    pub fn list_bases(&self, cursor: Option<&str>, limit: Option<u32>) -> Result<Page<BaseSummary>, IndexError>;
    pub fn evaluate_base(&self, query: &BaseQuery<'_>, clock: &Clock) -> Result<BaseAnswer, BaseQueryError>;
}
pub fn parse_property_types(json: &str) -> BTreeMap<String, PropertyType>;   // `.obsidian/types.json`

// vault-protocol (all Serialize + Deserialize + Clone + Debug + Eq + PartialEq)
pub struct EvaluateBaseParams { pub path: String, pub view: Option<String>, pub this_path: Option<String>, pub cursor: Option<String>, pub limit: Option<u32> }
pub struct EvaluateBaseResponse { pub generation: u64, pub view: ViewDto, pub columns: Vec<ColumnDto>, pub rows: Vec<RowDto>, pub summaries: BTreeMap<String, CellDto>, pub total_rows: u64, pub next_cursor: Option<String> }
pub struct ViewDto { #[serde(rename = "type")] pub kind: String, pub name: String, pub options: serde_json::Value }
pub struct ColumnDto { pub property: String, pub display_name: Option<String>, pub settings: serde_json::Value }
pub struct RowDto { pub path: String, pub kind: RowKindDto, pub group: Option<CellDto> /* skipped when None */, pub cells: Vec<CellDto> }
pub enum RowKindDto { Note, File, Unknown }
pub enum CellDto { Null, String { value }, Number { value: serde_json::Number }, Boolean { value }, Date { value: String, has_time: bool },
    Duration { value: i64, months: i64 }, List { value: Vec<CellDto> }, Object { value: Vec<ObjectEntryDto> },
    Link { target: String, display: Option<Box<CellDto>>, resolved: Option<String> }, File { path: String },
    Image { value }, Icon { value }, Html { value }, Error { message: String }, Unknown }
pub struct ObjectEntryDto { pub key: String, pub value: CellDto }
pub struct ListBasesParams { pub cursor: Option<String>, pub limit: Option<u32> }
pub struct BaseSummaryDto { pub path: String, pub status: BaseStatusDto, pub views: Vec<String> }
pub enum BaseStatusDto { Parsed, ParseFailed { message: String, span: Option<SpanDto> }, Unknown }
Request::{EvaluateBase(EvaluateBaseParams), ListBases(ListBasesParams)}; Response::{EvaluateBase(EvaluateBaseResponse), ListBases(PageResponse<BaseSummaryDto>)}
ErrorCode::{BaseInvalid, ViewNotFound, ExpressionInvalid, UnsupportedFunction}

// vault-server
pub const DEFAULT_BASE_CACHE_ENTRIES: usize = 64;
pub(crate) struct BaseCache { /* one generation's results */ }
pub(crate) fn evaluate_base(
    reader: &IndexReader,
    cache: &BaseCache,
    types: impl FnOnce() -> BTreeMap<String, vault_bases::PropertyType>,
    params: EvaluateBaseParams,
) -> Result<EvaluateBaseResponse, ProtocolError>;   // Task 12 adds `tracker: &ViewTracker` after `cache`
pub(crate) fn list_bases(reader: &IndexReader, params: ListBasesParams) -> Result<PageResponse<BaseSummaryDto>, ProtocolError>;
pub(crate) fn query_error(value: BaseQueryError) -> ProtocolError;
```

Wire shapes, settled here and documented in Task 16: a cell is internally tagged by `kind` (`{"kind":"string","value":"x"}`, `{"kind":"date","value":"2025-01-01","has_time":false}`, `{"kind":"duration","value":86400000,"months":0}`, `{"kind":"link","target":"Other","display":null,"resolved":"Other.md"}`, `{"kind":"error","message":"division by zero"}`); a duration carries `months` beside its milliseconds because the published reference's duration units include months (the syntax page's table: `M`, `month`, `months`), which no millisecond count can represent; an object is an ordered list of `{key, value}` entries, as the protocol's existing property DTO already represents mappings (`PropertyMappingEntryDto`), and the spec's cell model is amended to say so (a fact correction, in this plan's commit); a date's `value` is ISO 8601 in the daemon's zone — `YYYY-MM-DD` without a time, `YYYY-MM-DDTHH:mm:ss.SSS±HH:MM` with one; `summaries` is a JSON object from name to typed value, as the spec says; the name is the key the view's own `summaries` map declares the summary under (`summaries: {price: Average}` answers `"summaries": {"price": {"kind":"number","value":14.3}}`), because that key is unique within a view while two properties may share a summary function, and the function each key names is already in the view's declaration; `next_cursor` is absent-or-null exactly as every other page.

Property types come from the vault's `.obsidian/types.json` (`{"types": {"<key>": "date" | "datetime" | "number" | "checkbox" | "text" | "multitext" | "tags" | "aliases"}}`), read by the server through its raw read engine on each cache miss (one small file per evaluation), because that is where Obsidian declares them; a missing or unreadable file means no declared types. The spec does not mention this file; the plan's report names it as a ruling to confirm.

- [ ] **Step 1: Write the failing index-level test**

Create `crates/vault-index/tests/bases_query.rs`:

```rust
mod common;

use std::collections::BTreeMap;
use std::fs;

use tempfile::TempDir;
use vault_bases::eval::EvalContext;
use vault_bases::view::{compile_view, evaluate_view};
use vault_bases::{Clock, MemoryFile, MemorySource, PropertyType, Value, parse_base, text};
use vault_core::{PropertyValue, VaultPath};
use vault_index::{BaseQuery, BaseQueryError, IndexConfig, IndexService};

const NOW: i64 = 1_768_491_000_000;

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap()
}

fn service(files: &[(&str, &str)]) -> (IndexService, TempDir, TempDir) {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    for (path, body) in files {
        let full = vault.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, body).unwrap();
    }
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    (service, vault, index)
}

fn rows(service: &IndexService, base: &str, view: Option<&str>, this: Option<&str>) -> Vec<String> {
    let types = BTreeMap::new();
    let this = this.map(vp);
    let answer = service
        .reader()
        .unwrap()
        .evaluate_base(&BaseQuery { path: &vp(base), view, this_path: this.as_ref(), types: &types }, &Clock::fixed(NOW, "UTC"))
        .unwrap_or_else(|error| panic!("{error:?}"));
    answer.result.rows.iter().map(|row| row.path.as_str().to_string()).collect()
}

#[test]
fn the_sqlite_source_answers_what_the_memory_source_answers() {
    let files = [
        ("Books/A.md", "---\nstatus: done\nprice: 3\ntags: [book]\n---\n[[B]]\n"),
        ("Books/B.md", "---\nstatus: [done]\nprice: 10\n---\n#book\n"),
        ("Books/C.md", "---\nStatus: done\n---\n"),
        ("Books/D.md", "---\nstatus: DONE\n---\n![[A]]\n"),
        ("Other/E.md", "---\nstatus: done\n---\n"),
        ("Other/pic.png", "png"),
        ("Q.base", "views:\n  - type: table\n    name: Done\n    filters:\n      and:\n        - file.inFolder(\"Books\")\n        - 'status == \"done\"'\n  - type: table\n    name: Tagged\n    filters: 'file.hasTag(\"BOOK\")'\n  - type: table\n    name: Linked\n    filters: 'file.hasLink(\"B\") || file.backlinks.length > 0'\n  - type: list\n    name: Pngs\n    filters: 'file.ext == \"png\"'\n"),
    ];
    let (service, _vault, _index) = service(&files);
    let memory = MemorySource::new()
        .with("Books/A.md", MemoryFile::note().property("status", text("done")).property("price", PropertyValue::Integer(3)).tag("book").link("B"))
        .with("Books/B.md", MemoryFile::note().property("status", PropertyValue::Sequence(vec![vault_bases::no_span(text("done"))])).property("price", PropertyValue::Integer(10)).tag("book"))
        .with("Books/C.md", MemoryFile::note().property("Status", text("done")))
        .with("Books/D.md", MemoryFile::note().property("status", text("DONE")).embed("A"))
        .with("Other/E.md", MemoryFile::note().property("status", text("done")))
        .with("Other/pic.png", MemoryFile::attachment(3))
        .with("Q.base", MemoryFile::attachment(10));
    let base = parse_base(files[6].1).unwrap();
    let clock = Clock::fixed(NOW, "UTC");
    let base_path = vp("Q.base");
    for view in ["Done", "Tagged", "Linked", "Pngs"] {
        let compiled = compile_view(&base, Some(view)).unwrap();
        let ctx = EvalContext::new(&memory, &clock, &base_path, &base_path);
        let expected: Vec<String> = evaluate_view(&compiled, &ctx).unwrap().rows.iter().map(|r| r.path.as_str().to_string()).collect();
        assert_eq!(rows(&service, "Q.base", Some(view), None), expected, "view {view}");
    }
    assert_eq!(rows(&service, "Q.base", Some("Done"), None), vec!["Books/A.md"], "list, key case and value case never match");
}

#[test]
fn property_equality_prefilter_keeps_list_and_mixed_case_values() {
    // Review Focus 1, over SQLite: the prefilter narrows by key alone (folded),
    // so the per-row conjunct is what decides, and a key spelled `Status`
    // reaches the conjunct (which then does not match it).
    let (service, _vault, _index) = service(&[
        ("A.md", "---\nstatus: done\n---\n"),
        ("B.md", "---\nStatus: done\n---\n"),
        ("Q.base", "views:\n  - type: table\n    name: T\n    filters: 'note[\"Status\"] == \"done\"'\n"),
    ]);
    assert_eq!(rows(&service, "Q.base", None, None), vec!["B.md"]);
}

#[test]
fn this_is_the_embedding_note_and_must_be_a_note() {
    let (service, _vault, _index) = service(&[
        ("Hub.md", "# Hub\n"),
        ("A.md", "[[Hub]]\n"),
        ("B.md", "nothing\n"),
        ("Q.base", "views:\n  - type: list\n    name: Back\n    filters: 'file.hasLink(this.file)'\n"),
    ]);
    assert_eq!(rows(&service, "Q.base", None, Some("Hub.md")), vec!["A.md"]);
    let types = BTreeMap::new();
    let error = service
        .reader()
        .unwrap()
        .evaluate_base(&BaseQuery { path: &vp("Q.base"), view: None, this_path: Some(&vp("Gone.md")), types: &types }, &Clock::fixed(NOW, "UTC"))
        .err()
        .expect("a missing this_path is refused");
    assert!(matches!(error, BaseQueryError::ThisPath(_)));
}

#[test]
fn declared_property_types_reach_the_evaluator() {
    let (service, _vault, _index) = service(&[
        ("A.md", "---\ndue: 2020-01-01\n---\n"),
        ("Q.base", "views:\n  - type: table\n    name: T\n    filters: 'due < today()'\n    order: [due]\n"),
    ]);
    let types: BTreeMap<String, PropertyType> = vault_index::parse_property_types(r#"{"types":{"due":"date"}}"#);
    let answer = service
        .reader()
        .unwrap()
        .evaluate_base(&BaseQuery { path: &vp("Q.base"), view: None, this_path: None, types: &types }, &Clock::fixed(NOW, "UTC"))
        .unwrap();
    assert_eq!(answer.result.rows.len(), 1);
    assert!(matches!(answer.result.rows[0].cells[0], Ok(Value::Date(_))));
}

#[test]
fn list_bases_pages_with_status_and_views() {
    let (service, _vault, _index) = service(&[
        ("A.base", "views:\n  - type: table\n    name: One\n"),
        ("B.base", "views: [\n"),
        ("C.base", ""),
    ]);
    let reader = service.reader().unwrap();
    let first = reader.list_bases(None, Some(2)).unwrap();
    assert_eq!(first.items.len(), 2);
    assert_eq!(first.items[0].views, vec!["One".to_string()]);
    assert!(matches!(first.items[1].status, vault_index::BaseStatus::ParseFailed(_)));
    let second = reader.list_bases(first.next_cursor.as_deref(), Some(2)).unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].path.as_str(), "C.base");
    assert!(second.next_cursor.is_none());
}
```

`vault-bases` is already a normal dependency of `vault-index` (Task 10), which is all this test needs.

- [ ] **Step 2: Run it to see it fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test bases_query; echo "exit=$?"`

Expected: `unresolved import vault_index::BaseQuery`, `exit=101`.

- [ ] **Step 3: The row source and the two reads**

In `crates/vault-index/src/reader.rs`, add beside `read`:

```rust
    /// `read`, with the published live graph lent for the length of the
    /// query. The handle never escapes the guard, so the writer's next
    /// install is still in place.
    pub(crate) fn read_with_graph<T>(
        &self,
        query: impl FnOnce(&Transaction<'_>, Generation, &crate::LiveGraph) -> Result<T, IndexError>,
    ) -> Result<T, IndexError> {
        let published = read_published(&self.published)?;
        let graph = published.graph.clone().ok_or(IndexError::IndexUnavailable)?;
        drop(published);
        self.read(|transaction, generation| {
            if graph.generation() != generation {
                return Err(IndexError::LiveStateStale(format!(
                    "the lent graph is at {} but the read is at {}",
                    graph.generation().get(),
                    generation.get()
                )));
            }
            query(transaction, generation, &graph)
        })
    }
```

The clone is held only for the duration of the call, the same window `read` holds the guard; if the writer installs in between, the generation check refuses and `evaluate_base` retries (below), so no answer ever mixes two generations.

In `crates/vault-index/src/cursor.rs`, `CursorPosition` gains `Base { path: String },`.

Create `crates/vault-index/src/query/bases.rs`:

```rust
//! Bases over the index: the `RowSource` implementation and the two reads.
//!
//! Everything a view reads comes from one generation: the SQLite rows
//! through the reader's transaction, and the base and resolution through the
//! live graph lent for the same read. `vault-bases` never sees either.

use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};
use vault_bases::eval::EvalContext;
use vault_bases::view::{ColumnDecl, CompileError, ViewDependencies, ViewResult, compile_view, evaluate_view};
use vault_bases::{
    BaseParseError, Clock, FileFacts, FileKind, LinkFact, Prefilter, PropertyType, RowSource, SourceError,
    ViewDecl,
};
use vault_core::{LinkTarget, PropertyValue, Resolution, Resolver, SourceSpan, VaultPath};

use crate::codec;
use crate::cursor::{CursorPosition, decode_cursor, encode_cursor};
use crate::error::IndexError;
use crate::model::Generation;
use crate::query::{Page, effective_limit};
use crate::reader::IndexReader;

pub struct BaseQuery<'a> {
    pub path: &'a VaultPath,
    pub view: Option<&'a str>,
    pub this_path: Option<&'a VaultPath>,
    pub types: &'a BTreeMap<String, PropertyType>,
}

#[derive(Clone, Debug)]
pub struct BaseAnswer {
    pub generation: Generation,
    pub view: ViewDecl,
    pub columns: Vec<ColumnDecl>,
    pub result: ViewResult,
    pub dependencies: ViewDependencies,
}

#[derive(Debug)]
pub enum BaseQueryError {
    Index(IndexError),
    NotFound(VaultPath),
    Invalid(BaseParseError),
    Compile(CompileError),
    ThisPath(String),
}

impl From<IndexError> for BaseQueryError {
    fn from(error: IndexError) -> Self {
        Self::Index(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum BaseStatus {
    Parsed,
    ParseFailed(BaseParseError),
}

#[derive(Clone, Debug, PartialEq)]
pub struct BaseSummary {
    pub path: VaultPath,
    pub status: BaseStatus,
    pub views: Vec<String>,
}

/// `.obsidian/types.json` as Obsidian writes it. Unknown type names are
/// `Unknown`; anything that is not that shape is no declared types at all.
pub fn parse_property_types(json: &str) -> BTreeMap<String, PropertyType> {
    let Ok(serde_json::Value::Object(root)) = serde_json::from_str::<serde_json::Value>(json) else {
        return BTreeMap::new();
    };
    let Some(serde_json::Value::Object(types)) = root.get("types") else {
        return BTreeMap::new();
    };
    types
        .iter()
        .filter_map(|(key, kind)| {
            let kind = match kind.as_str()? {
                "text" => PropertyType::Text,
                "number" => PropertyType::Number,
                "checkbox" => PropertyType::Checkbox,
                "date" => PropertyType::Date,
                "datetime" => PropertyType::DateTime,
                "multitext" => PropertyType::List,
                "tags" => PropertyType::Tags,
                "aliases" => PropertyType::Aliases,
                _ => PropertyType::Unknown,
            };
            Some((key.clone(), kind))
        })
        .collect()
}

fn source_error(error: impl std::fmt::Display) -> SourceError {
    SourceError(error.to_string())
}

struct IndexRowSource<'t> {
    transaction: &'t Transaction<'t>,
    resolver: Arc<Resolver>,
    types: &'t BTreeMap<String, PropertyType>,
}

impl IndexRowSource<'_> {
    fn references(&self, path: &VaultPath, embeds: bool) -> Result<Vec<LinkFact>, SourceError> {
        let mut statement = self
            .transaction
            .prepare_cached(
                "SELECT r.kind, r.raw_target, r.display, s.kind, s.target_path FROM note_references r \
                 JOIN resolutions s ON s.reference_id = r.id WHERE r.note_path = ?1 ORDER BY r.ordinal",
            )
            .map_err(source_error)?;
        let rows = statement
            .query_map(params![path.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?))
            })
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        let mut facts = Vec::new();
        for (kind, raw_target, display, resolution, target) in rows {
            let is_embed = kind.ends_with("embed");
            if is_embed != embeds {
                continue;
            }
            let resolved = match resolution.as_str() {
                "resolved" | "missing_subpath" => target.map(|t| codec::decode_path(&t)).transpose().map_err(source_error)?,
                _ => None,
            };
            facts.push(LinkFact { raw_target, display, resolved });
        }
        Ok(facts)
    }
}

/// `substr(path, 1, n) = prefix` rather than `LIKE`, so `%` and `_` in a
/// folder name are literal.
const IN_FOLDER: &str = "substr(t.path, 1, length(?) + 1) = ? || '/'";

impl RowSource for IndexRowSource<'_> {
    fn candidates(&self, prefilters: &[Prefilter]) -> Result<Vec<VaultPath>, SourceError> {
        let mut sql = String::from("SELECT t.path FROM tree_entries t WHERE t.kind IN ('note', 'file')");
        let mut arguments: Vec<String> = Vec::new();
        let mut ext: Option<String> = None;
        for prefilter in prefilters {
            match prefilter {
                Prefilter::InFolder(folder) => {
                    let folder = folder.trim_matches('/').to_string();
                    if folder.is_empty() {
                        continue;
                    }
                    sql.push_str(" AND ");
                    sql.push_str(IN_FOLDER);
                    arguments.push(folder.clone());
                    arguments.push(folder);
                }
                Prefilter::HasTag(tags) => {
                    let mut clauses = Vec::new();
                    for tag in tags {
                        let tag = tag.trim_start_matches('#').to_lowercase();
                        clauses.push("comparison_key = ? OR substr(comparison_key, 1, length(?) + 1) = ? || '/'");
                        arguments.extend([tag.clone(), tag.clone(), tag]);
                    }
                    sql.push_str(" AND t.path IN (SELECT note_path FROM tags WHERE ");
                    sql.push_str(&clauses.join(" OR "));
                    sql.push(')');
                }
                Prefilter::Ext(wanted) => ext = Some(wanted.clone()),
                Prefilter::PropertyEquals { key, .. } => {
                    sql.push_str(" AND t.path IN (SELECT note_path FROM property_scalars WHERE key_fold = ?)");
                    arguments.push(key.to_lowercase());
                }
            }
        }
        sql.push_str(" ORDER BY t.path");
        let mut statement = self.transaction.prepare(&sql).map_err(source_error)?;
        let paths = statement
            .query_map(rusqlite::params_from_iter(arguments.iter()), |row| row.get::<_, String>(0))
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        paths
            .into_iter()
            .map(|path| codec::decode_path(&path).map_err(source_error))
            .filter(|path| match (&ext, path) {
                (Some(wanted), Ok(path)) => vault_bases::extension(path) == wanted.as_str(),
                _ => true,
            })
            .collect()
    }

    fn facts(&self, path: &VaultPath) -> Result<Option<FileFacts>, SourceError> {
        self.transaction
            .query_row(
                "SELECT kind, size, ctime_unix_ms, mtime_unix_ms FROM tree_entries WHERE path = ?1 AND kind != 'folder'",
                params![path.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?)),
            )
            .optional()
            .map_err(source_error)
            .map(|row| {
                row.map(|(kind, size, ctime_ms, mtime_ms)| FileFacts {
                    path: path.clone(),
                    kind: if kind == "note" { FileKind::Note } else { FileKind::File },
                    size: size.unwrap_or(0).max(0) as u64,
                    ctime_ms,
                    mtime_ms,
                })
            })
    }

    fn properties(&self, path: &VaultPath) -> Result<Vec<(String, PropertyValue)>, SourceError> {
        let mut statement = self
            .transaction
            .prepare_cached("SELECT key_text, value_json FROM properties WHERE note_path = ?1 ORDER BY ordinal")
            .map_err(source_error)?;
        let rows = statement
            .query_map(params![path.as_str()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        rows.into_iter()
            .map(|(key, json)| Ok((key, codec::decode_property_value(&json).map_err(source_error)?)))
            .collect()
    }

    fn tags(&self, path: &VaultPath) -> Result<Vec<String>, SourceError> {
        let mut statement = self
            .transaction
            .prepare_cached("SELECT value FROM tags WHERE note_path = ?1 ORDER BY ordinal")
            .map_err(source_error)?;
        let tags = statement
            .query_map(params![path.as_str()], |row| row.get::<_, String>(0))
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        Ok(tags)
    }

    fn links(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError> {
        self.references(path, false)
    }

    fn embeds(&self, path: &VaultPath) -> Result<Vec<LinkFact>, SourceError> {
        self.references(path, true)
    }

    fn backlinks(&self, path: &VaultPath) -> Result<Vec<VaultPath>, SourceError> {
        let mut statement = self
            .transaction
            .prepare_cached(
                "SELECT DISTINCT r.note_path FROM resolutions s JOIN note_references r ON r.id = s.reference_id \
                 WHERE s.target_path = ?1 AND s.kind IN ('resolved', 'missing_subpath') ORDER BY r.note_path",
            )
            .map_err(source_error)?;
        let paths = statement
            .query_map(params![path.as_str()], |row| row.get::<_, String>(0))
            .map_err(source_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(source_error)?;
        paths.iter().map(|path| codec::decode_path(path).map_err(source_error)).collect()
    }

    fn resolve(&self, from: &VaultPath, target: &str) -> Result<Option<VaultPath>, SourceError> {
        Ok(match self.resolver.resolve_target(from, &LinkTarget::parse(target)) {
            Resolution::Resolved { target, .. } | Resolution::MissingSubpath { target, .. } => Some(target),
            _ => None,
        })
    }

    fn property_type(&self, key: &str) -> Option<PropertyType> {
        self.types.get(key).copied()
    }
}

fn parse_failure(diagnostics_json: &str) -> BaseParseError {
    let first = serde_json::from_str::<serde_json::Value>(diagnostics_json)
        .ok()
        .and_then(|value| value.as_array().and_then(|items| items.first().cloned()));
    let message = first
        .as_ref()
        .and_then(|item| item.get("message"))
        .and_then(|message| message.as_str())
        .unwrap_or("the base failed to parse")
        .to_string();
    let span = first.as_ref().and_then(|item| {
        let start = item.get("span_start")?.as_u64()? as usize;
        let end = item.get("span_end")?.as_u64()? as usize;
        SourceSpan::new(start, end).ok()
    });
    BaseParseError { message, span }
}

const LIST_BASES: &str = "list_bases";

impl IndexReader {
    pub fn list_bases(&self, cursor: Option<&str>, limit: Option<u32>) -> Result<Page<BaseSummary>, IndexError> {
        let limit = effective_limit(limit)?;
        self.read(|transaction, generation| {
            let after = match cursor {
                None => String::new(),
                Some(cursor) => match decode_cursor(cursor, generation, LIST_BASES)? {
                    CursorPosition::Base { path } => path,
                    _ => return Err(IndexError::InvalidCursor("cursor position does not fit a base listing".into())),
                },
            };
            let mut statement = transaction.prepare(
                "SELECT path, parse_status, view_names_json, diagnostics_json FROM bases WHERE path > ?1 ORDER BY path LIMIT ?2",
            )?;
            let rows = statement
                .query_map(params![after, i64::from(limit) + 1], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let more = rows.len() > limit as usize;
            let mut items = Vec::new();
            for (path, status, views, diagnostics) in rows.into_iter().take(limit as usize) {
                items.push(BaseSummary {
                    path: codec::decode_path(&path)?,
                    status: if status == "parsed" { BaseStatus::Parsed } else { BaseStatus::ParseFailed(parse_failure(&diagnostics)) },
                    views: serde_json::from_str(&views)?,
                });
            }
            let next_cursor = match (more, items.last()) {
                (true, Some(last)) => Some(encode_cursor(generation, LIST_BASES, CursorPosition::Base { path: last.path.as_str().to_string() })?),
                _ => None,
            };
            Ok(Page { generation, items, next_cursor })
        })
    }

    /// Evaluate one view at the current generation. Retries once when the
    /// writer installs between building the resolver and opening the read,
    /// so the resolver and the rows are always one generation.
    pub fn evaluate_base(&self, query: &BaseQuery<'_>, clock: &Clock) -> Result<BaseAnswer, BaseQueryError> {
        for _ in 0..3 {
            let (resolver_generation, resolver) = self.resolver()?;
            let outcome = self.read_with_graph(|transaction, generation, graph| {
                if generation != resolver_generation {
                    return Err(IndexError::LiveStateStale("the resolver is a generation behind".into()));
                }
                Ok(evaluate_in(transaction, generation, graph, Arc::clone(&resolver), query, clock))
            });
            match outcome {
                Ok(answer) => return answer,
                Err(IndexError::LiveStateStale(_)) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(IndexError::Storage("the generation would not hold still for an evaluation".into()).into())
    }
}

fn evaluate_in(
    transaction: &Transaction<'_>,
    generation: Generation,
    graph: &crate::LiveGraph,
    resolver: Arc<Resolver>,
    query: &BaseQuery<'_>,
    clock: &Clock,
) -> Result<BaseAnswer, BaseQueryError> {
    let record = graph.base(query.path).ok_or_else(|| BaseQueryError::NotFound(query.path.clone()))?;
    let Some(file) = &record.file else {
        return Err(BaseQueryError::Invalid(record.error.clone().unwrap_or(BaseParseError {
            message: "the base failed to parse".into(),
            span: None,
        })));
    };
    if let Some(this) = query.this_path {
        if !graph.contains_note(this) {
            return Err(BaseQueryError::ThisPath(format!("this_path {:?} is not a note in the vault", this.as_str())));
        }
    }
    let compiled = compile_view(file, query.view).map_err(BaseQueryError::Compile)?;
    let source = IndexRowSource { transaction, resolver, types: query.types };
    let this = query.this_path.unwrap_or(query.path);
    let ctx = EvalContext::new(&source, clock, query.path, this);
    let result = evaluate_view(&compiled, &ctx).map_err(|error| BaseQueryError::Index(IndexError::Storage(error.0)))?;
    Ok(BaseAnswer {
        generation,
        view: compiled.decl().clone(),
        columns: compiled.columns().to_vec(),
        dependencies: compiled.dependencies().clone(),
        result,
    })
}
```

`tags.comparison_key` is the lowercased tag (`schema_v3.sql`), which is why the folded comparison is exact rather than `LOWER()` per row.

In `crates/vault-index/src/query.rs`, add `pub(crate) mod bases;` beside `pub(crate) mod diagnostics;` and make `effective_limit` `pub(crate)`. In `crates/vault-index/src/lib.rs`: `pub use query::bases::{BaseAnswer, BaseQuery, BaseQueryError, BaseStatus, BaseSummary, parse_property_types};`.

- [ ] **Step 4: Run the index test and see it pass**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test bases_query; echo "exit=$?"`

Expected: `test result: ok. 5 passed`, `exit=0`.

- [ ] **Step 5: The wire types**

Create `crates/vault-protocol/src/bases.rs`:

```rust
//! Bases on the wire: `evaluate_base`, `list_bases`, and the cell model.
//!
//! Additive to protocol version 1. Every enum a client decodes here carries
//! an `Unknown` catch-all, as `docs/protocol.md`'s Evolution section requires.

use serde::{Deserialize, Serialize};

use crate::semantic::SpanDto;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct EvaluateBaseParams {
    pub path: String,
    #[serde(default)]
    pub view: Option<String>,
    #[serde(default)]
    pub this_path: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ListBasesParams {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ViewDto {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    /// Every key of the view the core does not own, as declared.
    pub options: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ColumnDto {
    pub property: String,
    pub display_name: Option<String>,
    pub settings: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowKindDto {
    Note,
    File,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ObjectEntryDto {
    pub key: String,
    pub value: CellDto,
}

/// One typed cell. The daemon renders nothing; a client turns these into a
/// table, cards, a list or a board.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CellDto {
    Null,
    String { value: String },
    Number { value: serde_json::Number },
    Boolean { value: bool },
    /// ISO 8601 in the daemon's zone: `YYYY-MM-DD` without a time,
    /// `YYYY-MM-DDTHH:mm:ss.SSS±HH:MM` with one.
    Date { value: String, has_time: bool },
    /// Milliseconds, plus the calendar months kept apart from them.
    Duration { value: i64, months: i64 },
    List { value: Vec<CellDto> },
    Object { value: Vec<ObjectEntryDto> },
    Link { target: String, display: Option<Box<CellDto>>, resolved: Option<String> },
    File { path: String },
    Image { value: String },
    Icon { value: String },
    Html { value: String },
    Error { message: String },
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RowDto {
    pub path: String,
    pub kind: RowKindDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<CellDto>,
    pub cells: Vec<CellDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EvaluateBaseResponse {
    pub generation: u64,
    pub view: ViewDto,
    pub columns: Vec<ColumnDto>,
    pub rows: Vec<RowDto>,
    /// Name to typed value; the name is the view's `summaries` key.
    pub summaries: std::collections::BTreeMap<String, CellDto>,
    pub total_rows: u64,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BaseStatusDto {
    Parsed,
    ParseFailed { message: String, span: Option<SpanDto> },
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BaseSummaryDto {
    pub path: String,
    pub status: BaseStatusDto,
    pub views: Vec<String>,
}
```

In `crates/vault-protocol/src/operations.rs`: `Request` gains `EvaluateBase(EvaluateBaseParams),` and `ListBases(ListBasesParams),` (after `CloseSnapshot`); `Response` gains `EvaluateBase(EvaluateBaseResponse),` and `ListBases(PageResponse<BaseSummaryDto>),`. In `crates/vault-protocol/src/error.rs`: `ErrorCode` gains `BaseInvalid, ViewNotFound, ExpressionInvalid, UnsupportedFunction` before `Unknown`, and `Deserialize` gains `"base_invalid"`, `"view_not_found"`, `"expression_invalid"`, `"unsupported_function"`. In `crates/vault-protocol/src/lib.rs`: `mod bases;` and `pub use bases::{BaseStatusDto, BaseSummaryDto, CellDto, ColumnDto, EvaluateBaseParams, EvaluateBaseResponse, ListBasesParams, ObjectEntryDto, RowDto, RowKindDto, ViewDto};`.

`Response` keeps its `Eq` derive: `serde_json::Number` and `serde_json::Value` are both `Eq`.

- [ ] **Step 6: Write the failing daemon-level test**

Create `crates/vault-server/tests/bases_ops.rs`:

```rust
mod daemon;

use tempfile::TempDir;
use vault_protocol::{CellDto, ErrorCode, Response, ResponseOutcome};

use daemon::Daemon;

/// The in-repo scratch root (`target/tmp`), from this crate's manifest
/// directory rather than `TMPDIR` — the socket harness's `tmp_root` rule.
fn scratch() -> std::path::PathBuf {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
    std::fs::create_dir_all(&root).expect("create the scratch root");
    root.canonicalize().expect("canonicalize the scratch root")
}

const BASE: &str = "formulas:\n  double: 'price * 2'\n  bad: 'price +'\nproperties:\n  price:\n    displayName: Price\nsummaries:\n  top: 'values.reduce(if(acc == null || value > acc, value, acc), null)'\nviews:\n  - type: table\n    name: Table\n    filters: 'file.inFolder(\"Books\")'\n    order: [file.name, price, formula.double]\n    sort:\n      - property: price\n        direction: DESC\n    summaries:\n      price: top\n  - type: cards\n    name: Cards\n    image: cover\n  - type: table\n    name: Bad\n    order: [formula.bad]\n  - type: table\n    name: Odd\n    filters: 'frobnicate(price)'\n";

fn vault() -> (TempDir, TempDir) {
    let vault = TempDir::new_in(scratch()).unwrap();
    let index = TempDir::new_in(scratch()).unwrap();
    std::fs::create_dir_all(vault.path().join("Books")).unwrap();
    for (name, price) in [("A", 3), ("B", 30), ("C", 10)] {
        std::fs::write(vault.path().join(format!("Books/{name}.md")), format!("---\nprice: {price}\n---\n")).unwrap();
    }
    std::fs::write(vault.path().join("Views.base"), BASE).unwrap();
    std::fs::write(vault.path().join("Broken.base"), "views: [\n").unwrap();
    std::fs::write(vault.path().join("Home.md"), "![[Views.base#Table]]\n").unwrap();
    (vault, index)
}

fn started(vault: &TempDir, index: &TempDir) -> Daemon {
    let mut daemon = Daemon::for_vault(vault, index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon
}

fn ok(daemon: &mut Daemon, line: &str) -> Response {
    match daemon.call(line).outcome {
        ResponseOutcome::Ok(response) => response,
        ResponseOutcome::Err(error) => panic!("{line}: {error:?}"),
    }
}

fn err(daemon: &mut Daemon, line: &str) -> vault_protocol::ProtocolError {
    match daemon.call(line).outcome {
        ResponseOutcome::Err(error) => error,
        ResponseOutcome::Ok(response) => panic!("{line}: expected an error, got {response:?}"),
    }
}

fn evaluate(params: &str) -> String {
    format!(r#"{{"version":1,"id":"e","request":{{"method":"evaluate_base","params":{params}}}}}"#)
}

#[test]
fn evaluate_base_answers_rows_columns_summaries_and_typed_cells() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let Response::EvaluateBase(answer) = ok(&mut daemon, &evaluate(r#"{"path":"Views.base"}"#)) else {
        panic!("an evaluate_base answer");
    };
    assert_eq!(answer.view.kind, "table");
    assert_eq!(answer.view.name, "Table", "absent view means the first");
    let columns: Vec<(&str, Option<&str>)> = answer.columns.iter().map(|c| (c.property.as_str(), c.display_name.as_deref())).collect();
    assert_eq!(columns, vec![("file.name", None), ("price", Some("Price")), ("formula.double", None)]);
    let paths: Vec<&str> = answer.rows.iter().map(|row| row.path.as_str()).collect();
    assert_eq!(paths, vec!["Books/B.md", "Books/C.md", "Books/A.md"]);
    assert_eq!(answer.rows[0].cells[0], CellDto::String { value: "B.md".into() });
    assert_eq!(answer.rows[0].cells[2], CellDto::Number { value: serde_json::Number::from(60) });
    assert_eq!(answer.total_rows, 3);
    assert!(answer.next_cursor.is_none());
    assert_eq!(answer.summaries.len(), 1);
    assert_eq!(answer.summaries["price"], CellDto::Number { value: serde_json::Number::from(30) });

    let Response::EvaluateBase(cards) = ok(&mut daemon, &evaluate(r#"{"path":"Views.base","view":"Cards"}"#)) else { panic!() };
    assert_eq!(cards.view.options, serde_json::json!({"image": "cover"}));
}

#[test]
fn pages_follow_the_cursor_and_a_stale_cursor_is_generation_mismatch() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let Response::EvaluateBase(first) = ok(&mut daemon, &evaluate(r#"{"path":"Views.base","limit":2}"#)) else { panic!() };
    assert_eq!(first.rows.len(), 2);
    assert_eq!(first.total_rows, 3);
    let cursor = first.next_cursor.clone().expect("a next page");
    let Response::EvaluateBase(second) = ok(&mut daemon, &evaluate(&format!(r#"{{"path":"Views.base","limit":2,"cursor":"{cursor}"}}"#))) else { panic!() };
    assert_eq!(second.rows.len(), 1);
    assert_eq!(second.rows[0].path, "Books/A.md");
    assert_eq!(second.generation, first.generation);

    ok(&mut daemon, r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Books/D.md","content":"---\nprice: 1\n---\n","expected":{"absent":true}}}}"#);
    let error = err(&mut daemon, &evaluate(&format!(r#"{{"path":"Views.base","limit":2,"cursor":"{cursor}"}}"#)));
    assert_eq!(error.code, ErrorCode::GenerationMismatch);
    assert_eq!(error.current_generation, Some(first.generation + 1));

    let error = err(&mut daemon, &evaluate(&format!(r#"{{"path":"Views.base","view":"Cards","limit":2,"cursor":"{cursor}"}}"#)));
    assert_eq!(error.code, ErrorCode::InvalidCursor, "a cursor belongs to one view");
}

#[test]
fn every_error_code_has_a_cause() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    for (params, code, needle) in [
        (r#"{"path":"Broken.base"}"#, ErrorCode::BaseInvalid, "parse"),
        (r#"{"path":"Views.base","view":"Nope"}"#, ErrorCode::ViewNotFound, "Table, Cards, Bad, Odd"),
        (r#"{"path":"Views.base","view":"Bad"}"#, ErrorCode::ExpressionInvalid, "price +"),
        (r#"{"path":"Views.base","view":"Odd"}"#, ErrorCode::UnsupportedFunction, "frobnicate"),
        (r#"{"path":"Nowhere.base"}"#, ErrorCode::NotFound, "Nowhere.base"),
        (r#"{"path":"Views.base","this_path":"Gone.md"}"#, ErrorCode::InvalidRequest, "Gone.md"),
        (r#"{"path":"Views.base","limit":0}"#, ErrorCode::InvalidCursor, "limit"),
        (r#"{"path":"Views.base","limit":1001}"#, ErrorCode::InvalidCursor, "limit"),
        (r#"{"path":"../x.base"}"#, ErrorCode::InvalidPath, "x.base"),
    ] {
        let error = err(&mut daemon, &evaluate(params));
        assert_eq!(error.code, code, "{params}: {error:?}");
        assert!(error.message.contains(needle), "{params}: {:?} should mention {needle:?}", error.message);
    }
}

#[test]
fn health_only_mode_is_index_unavailable() {
    let mut daemon = Daemon::start(&[]);
    assert_eq!(err(&mut daemon, &evaluate(r#"{"path":"Views.base"}"#)).code, ErrorCode::IndexUnavailable);
    assert_eq!(
        err(&mut daemon, r#"{"version":1,"id":"l","request":{"method":"list_bases","params":{}}}"#).code,
        ErrorCode::IndexUnavailable
    );
}

#[test]
fn a_deleted_base_is_not_found() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    ok(&mut daemon, &evaluate(r#"{"path":"Views.base"}"#));
    ok(&mut daemon, r#"{"version":1,"id":"d","request":{"method":"delete_note","params":{"path":"Views.base","mode":"permanent","expected":{"any":true}}}}"#);
    assert_eq!(err(&mut daemon, &evaluate(r#"{"path":"Views.base"}"#)).code, ErrorCode::NotFound);
}

#[test]
fn list_bases_names_every_base_with_its_status() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let Response::ListBases(page) = ok(&mut daemon, r#"{"version":1,"id":"l","request":{"method":"list_bases","params":{}}}"#) else { panic!() };
    let summary: Vec<(&str, bool, usize)> = page
        .items
        .iter()
        .map(|item| (item.path.as_str(), matches!(item.status, vault_protocol::BaseStatusDto::Parsed), item.views.len()))
        .collect();
    assert_eq!(summary, vec![("Broken.base", false, 0), ("Views.base", true, 4)]);
}

#[test]
fn a_view_embed_resolves_over_the_wire() {
    let (vault, index) = vault();
    let mut daemon = started(&vault, &index);
    let raw = daemon.call_raw(r#"{"version":1,"id":"r","request":{"method":"resolve_link","params":{"source_path":"Home.md","destination":"Views.base#Table"}}}"#);
    assert!(raw.contains(r#""resolution":{"kind":"resolved","target":"Views.base","subpath":{"kind":"view","value":"Table"}}"#), "{raw}");
}
```

`delete_note` accepts any file (only `write_note` and `patch_frontmatter` refuse a non-note, `mutate.rs:1410` and `:1772`), and its targeted reconciliation of `Views.base` is Task 10's route.

- [ ] **Step 7: Run it to see it fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test bases_ops; echo "exit=$?"`

Expected: every test fails with `invalid request: unknown variant evaluate_base` (the server's match is not exhaustive yet, so first a compile error naming `Request::EvaluateBase` not covered), `exit=101`.

- [ ] **Step 8: The server — conversion, cursor, cache, handlers**

Add `vault-bases = { path = "../vault-bases" }` to `crates/vault-server/Cargo.toml` `[dependencies]`.

In `crates/vault-server/src/convert.rs`, add:

```rust
pub(crate) fn json_of(value: &vault_core::PropertyValue) -> serde_json::Value {
    use vault_core::PropertyValue as P;
    match value {
        P::Null => serde_json::Value::Null,
        P::Boolean(flag) => serde_json::Value::Bool(*flag),
        P::Integer(number) => serde_json::Value::from(*number),
        P::Float(number) => serde_json::Number::from_f64(*number).map_or(serde_json::Value::Null, serde_json::Value::Number),
        P::String(text) => serde_json::Value::String(text.clone()),
        P::Sequence(items) => serde_json::Value::Array(items.iter().map(|item| json_of(&item.value)).collect()),
        P::Mapping(entries) => serde_json::Value::Object(entries.iter().map(|(key, value)| (key.value.clone(), json_of(&value.value))).collect()),
    }
}

pub(crate) fn options(entries: &[(String, vault_core::PropertyValue)]) -> serde_json::Value {
    serde_json::Value::Object(entries.iter().map(|(key, value)| (key.clone(), json_of(value))).collect())
}

fn iso_date(date: vault_bases::DateValue, clock: &vault_bases::Clock) -> String {
    let format = if date.has_time { "YYYY-MM-DD[T]HH:mm:ss.SSSZ" } else { "YYYY-MM-DD" };
    vault_bases::format_date(date, format, clock).expect("every token in the ISO format is implemented")
}

pub(crate) fn cell(value: &vault_bases::view::Cell, clock: &vault_bases::Clock) -> vault_protocol::CellDto {
    use vault_bases::Value as V;
    use vault_protocol::CellDto as C;
    let value = match value {
        Ok(value) => value,
        Err(error) => return C::Error { message: error.to_string() },
    };
    match value {
        V::Null => C::Null,
        V::String(text) => C::String { value: text.clone() },
        // A whole number goes on the wire as an integer (`60`, not `60.0`),
        // which is what a JavaScript client prints for it.
        V::Number(number) if number.fract() == 0.0 && number.abs() < 9.007_199_254_740_992e15 => {
            C::Number { value: serde_json::Number::from(*number as i64) }
        }
        V::Number(number) => match serde_json::Number::from_f64(*number) {
            Some(number) => C::Number { value: number },
            None => C::Error { message: "not a finite number".into() },
        },
        V::Boolean(flag) => C::Boolean { value: *flag },
        V::Date(date) => C::Date { value: iso_date(*date, clock), has_time: date.has_time },
        V::Duration(duration) => C::Duration { value: duration.ms, months: duration.months },
        V::List(items) => C::List { value: items.iter().map(|item| cell(&Ok(item.clone()), clock)).collect() },
        V::Object(entries) => C::Object {
            value: entries
                .iter()
                .map(|(key, value)| vault_protocol::ObjectEntryDto { key: key.clone(), value: cell(&Ok(value.clone()), clock) })
                .collect(),
        },
        V::Link(link) => C::Link {
            target: link.target.clone(),
            display: link.display.as_ref().map(|display| Box::new(cell(&Ok((**display).clone()), clock))),
            resolved: link.resolved.as_ref().map(|path| path.as_str().to_string()),
        },
        V::File(path) => C::File { path: path.as_str().to_string() },
        V::Regexp(regexp) => C::String { value: format!("/{}/{}", regexp.source, regexp.flags) },
        V::Image(text) => C::Image { value: text.clone() },
        V::Icon(text) => C::Icon { value: text.clone() },
        V::Html(text) => C::Html { value: text.clone() },
    }
}
```

Create `crates/vault-server/src/bases.rs`:

```rust
//! `evaluate_base` and `list_bases`.
//!
//! A view's result is computed once per (base, view, `this_path`,
//! generation) and its pages are cut from that one computation, so a page
//! never disagrees with its neighbour about `now()`. The store holds one
//! generation's results at most: the first request at a new generation
//! drops the rest. Task 12 bounds it by entry count.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use vault_bases::view::CompileError;
use vault_core::VaultPath;
use vault_index::{BaseAnswer, BaseQuery, BaseQueryError, BaseStatus, IndexReader};
use vault_protocol::{
    BaseStatusDto, BaseSummaryDto, ColumnDto, ErrorCode, EvaluateBaseParams, EvaluateBaseResponse, ListBasesParams,
    PageResponse, ProtocolError, RowDto, RowKindDto, ViewDto,
};

use crate::convert;

pub const DEFAULT_BASE_CACHE_ENTRIES: usize = 64;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct CacheKey {
    pub base: VaultPath,
    pub view: Option<String>,
    pub this_path: Option<VaultPath>,
    pub generation: u64,
}

pub(crate) struct Cached {
    pub answer: BaseAnswer,
    pub clock: vault_bases::Clock,
}

#[derive(Default)]
pub(crate) struct BaseCache {
    entries: Mutex<HashMap<CacheKey, Arc<Cached>>>,
}

impl BaseCache {
    pub(crate) fn get(&self, key: &CacheKey) -> Option<Arc<Cached>> {
        let mut entries = self.entries.lock().ok()?;
        entries.retain(|have, _| have.generation == key.generation);
        entries.get(key).cloned()
    }

    pub(crate) fn put(&self, key: CacheKey, value: Arc<Cached>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|have, _| have.generation == key.generation);
            entries.insert(key, value);
        }
    }
}

fn error(code: ErrorCode, message: impl Into<String>) -> ProtocolError {
    ProtocolError { code, message: message.into(), supported_version: None, current_generation: None, current_revision: None }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Cursor {
    generation: u64,
    base: String,
    view: Option<String>,
    this_path: Option<String>,
    offset: usize,
}

fn decode(cursor: &str) -> Result<Cursor, ProtocolError> {
    let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|e| error(ErrorCode::InvalidCursor, format!("invalid cursor: {e}")))?;
    serde_json::from_slice(&bytes).map_err(|e| error(ErrorCode::InvalidCursor, format!("invalid cursor: {e}")))
}

fn encode(cursor: &Cursor) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).expect("a cursor serializes"))
}

pub(crate) fn query_error(value: BaseQueryError) -> ProtocolError {
    match value {
        BaseQueryError::Index(index) => convert::index_error(index),
        BaseQueryError::NotFound(path) => error(ErrorCode::NotFound, format!("no base at {}", path.as_str())),
        BaseQueryError::Invalid(parse) => error(
            ErrorCode::BaseInvalid,
            match parse.span {
                Some(span) => format!("the base failed to parse at byte {}: {}", span.start(), parse.message),
                None => format!("the base failed to parse: {}", parse.message),
            },
        ),
        BaseQueryError::Compile(CompileError::ViewNotFound { declared }) => {
            error(ErrorCode::ViewNotFound, format!("no such view; declared views: {}", declared.join(", ")))
        }
        BaseQueryError::Compile(CompileError::ExpressionInvalid { expression, message, position }) => error(
            ErrorCode::ExpressionInvalid,
            format!("expression {expression:?} is invalid at position {position}: {message}"),
        ),
        BaseQueryError::Compile(CompileError::UnsupportedFunction { name }) => {
            error(ErrorCode::UnsupportedFunction, format!("unsupported function {name}"))
        }
        BaseQueryError::ThisPath(message) => error(ErrorCode::InvalidRequest, message),
    }
}

fn limit(limit: Option<u32>) -> Result<usize, ProtocolError> {
    match limit.unwrap_or(100) {
        0 => Err(error(ErrorCode::InvalidCursor, "invalid cursor: limit must be between 1 and 1000")),
        n if n > 1000 => Err(error(ErrorCode::InvalidCursor, "invalid cursor: limit must be between 1 and 1000")),
        n => Ok(n as usize),
    }
}

pub(crate) fn evaluate_base(
    reader: &IndexReader,
    cache: &BaseCache,
    types: impl FnOnce() -> BTreeMap<String, vault_bases::PropertyType>,
    params: EvaluateBaseParams,
) -> Result<EvaluateBaseResponse, ProtocolError> {
    let limit = limit(params.limit)?;
    let path = crate::parse_path(&params.path)?;
    let this_path = params.this_path.as_deref().map(crate::parse_path).transpose()?;
    let current = reader
        .published_status()
        .map_err(convert::index_error)?
        .generation
        .ok_or_else(|| convert::index_error(vault_index::IndexError::IndexUnavailable))?
        .get();

    let offset = match &params.cursor {
        None => 0,
        Some(cursor) => {
            let cursor = decode(cursor)?;
            if cursor.base != params.path || cursor.view != params.view || cursor.this_path != params.this_path {
                return Err(error(ErrorCode::InvalidCursor, "invalid cursor: it belongs to another base, view or this_path"));
            }
            if cursor.generation != current {
                let mut mismatch = error(
                    ErrorCode::GenerationMismatch,
                    format!("cursor generation {} does not match current generation {current}", cursor.generation),
                );
                mismatch.current_generation = Some(current);
                return Err(mismatch);
            }
            cursor.offset
        }
    };

    let key = CacheKey { base: path.clone(), view: params.view.clone(), this_path: this_path.clone(), generation: current };
    let cached = match cache.get(&key) {
        Some(hit) => hit,
        None => {
            let clock = vault_bases::Clock::system();
            let types = types();
            let answer = reader
                .evaluate_base(&BaseQuery { path: &path, view: params.view.as_deref(), this_path: this_path.as_ref(), types: &types }, &clock)
                .map_err(query_error)?;
            let entry = Arc::new(Cached { answer, clock });
            let key = CacheKey { generation: entry.answer.generation.get(), ..key };
            cache.put(key, Arc::clone(&entry));
            entry
        }
    };
    let answer = &cached.answer;
    let clock = &cached.clock;
    let rows = &answer.result.rows;
    let page: Vec<RowDto> = rows
        .iter()
        .skip(offset)
        .take(limit)
        .map(|row| RowDto {
            path: row.path.as_str().to_string(),
            kind: match row.kind {
                vault_bases::FileKind::Note => RowKindDto::Note,
                vault_bases::FileKind::File => RowKindDto::File,
            },
            group: row.group.as_ref().map(|group| convert::cell(group, clock)),
            cells: row.cells.iter().map(|cell| convert::cell(cell, clock)).collect(),
        })
        .collect();
    let next = offset + page.len();
    let generation = answer.generation.get();
    Ok(EvaluateBaseResponse {
        generation,
        view: ViewDto { kind: answer.view.kind.clone(), name: answer.view.name.clone(), options: convert::options(&answer.view.options) },
        columns: answer
            .columns
            .iter()
            .map(|column| ColumnDto {
                property: column.property.clone(),
                display_name: column.display_name.clone(),
                settings: convert::options(&column.settings),
            })
            .collect(),
        rows: page,
        summaries: answer
            .result
            .summaries
            .iter()
            .map(|summary| (summary.property.clone(), convert::cell(&summary.value, clock)))
            .collect(),
        total_rows: rows.len() as u64,
        next_cursor: (next < rows.len()).then(|| {
            encode(&Cursor { generation, base: params.path.clone(), view: params.view.clone(), this_path: params.this_path.clone(), offset: next })
        }),
    })
}

pub(crate) fn list_bases(reader: &IndexReader, params: ListBasesParams) -> Result<PageResponse<BaseSummaryDto>, ProtocolError> {
    let page = reader.list_bases(params.cursor.as_deref(), params.limit).map_err(convert::index_error)?;
    Ok(PageResponse {
        generation: page.generation.get(),
        items: page
            .items
            .into_iter()
            .map(|item| BaseSummaryDto {
                path: item.path.as_str().to_string(),
                status: match item.status {
                    BaseStatus::Parsed => BaseStatusDto::Parsed,
                    BaseStatus::ParseFailed(parse) => BaseStatusDto::ParseFailed { message: parse.message, span: parse.span.map(convert::span) },
                },
                views: item.views,
            })
            .collect(),
        next_cursor: page.next_cursor,
    })
}
```

The `ViewNotFound` message names the declared views as the spec requires; the test asserts the four names in declared order.

In `crates/vault-server/src/lib.rs`:

- `mod bases;` (public items are re-exported in Task 12);
- `parse_path` becomes `pub(crate) fn parse_path`;
- `Server` gains `base_cache: bases::BaseCache`, initialized `bases::BaseCache::default()` in both `health_only` and `for_runtime`;
- add a method that reads the vault's declared property types through the raw engine:

```rust
    /// The vault's declared property types, read fresh: Obsidian rewrites
    /// `.obsidian/types.json` itself, and the zone is not watched.
    fn property_types(&self) -> std::collections::BTreeMap<String, vault_bases::PropertyType> {
        let Ok(path) = VaultPath::new(".obsidian/types.json") else {
            return Default::default();
        };
        match self.read_file(&path) {
            Ok((bytes, _)) => vault_index::parse_property_types(&String::from_utf8_lossy(&bytes)),
            Err(_) => Default::default(),
        }
    }
```

- `handle` gains, after the `CloseSnapshot` arm:

```rust
            Request::EvaluateBase(params) => match reader {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(reader) => match bases::evaluate_base(reader, &self.base_cache, || self.property_types(), params) {
                    Ok(answer) => ResponseEnvelope::success(id, Response::EvaluateBase(answer)),
                    Err(error) => ResponseEnvelope::error(id, error),
                },
            },
            Request::ListBases(params) => match reader {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(reader) => match bases::list_bases(reader, params) {
                    Ok(page) => ResponseEnvelope::success(id, Response::ListBases(page)),
                    Err(error) => ResponseEnvelope::error(id, error),
                },
            },
```

`Server::read_file` (`lib.rs:535`) answers `Result<(Vec<u8>, String), ProtocolError>` — the bytes and their revision — through the same engine the `read_file` operation uses.

- [ ] **Step 9: Conformance over both transports**

In `crates/vault-server/tests/conformance.rs`, `build_vault` also writes, after `Folder/Nested.md`:

```rust
    std::fs::write(
        vault.path().join("Views.base"),
        "formulas:\n  bad: 'title +'\nviews:\n  - type: table\n    name: Table\n    order: [file.name, title]\n  - type: cards\n    name: Cards\n  - type: table\n    name: Bad\n    order: [formula.bad]\n",
    )
    .expect("write Views.base");
    std::fs::write(vault.path().join("Broken.base"), "views: [\n").expect("write Broken.base");
```

The fixture base reads no `file.ctime`/`file.mtime` and no `now()`: those differ between the two runs for reasons the normalizer does not (and must not) blank.

In `crates/vault-server/tests/fixtures/conformance.jsonl`, after the `c29` line, add:

```json
# Bases: the listing, a view and its pages, a view embed, and every refusal.
{"version":1,"id":"c40","request":{"method":"list_bases","params":{}}}
{"version":1,"id":"c41","request":{"method":"evaluate_base","params":{"path":"Views.base"}}}
{"version":1,"id":"c42","request":{"method":"evaluate_base","params":{"path":"Views.base","limit":1}}}
{"version":1,"id":"c43","request":{"method":"evaluate_base","params":{"path":"Views.base","limit":1,"cursor":"{{next_cursor}}"}}}
{"version":1,"id":"c44","request":{"method":"evaluate_base","params":{"path":"Views.base","view":"Cards"}}}
{"version":1,"id":"c45","request":{"method":"resolve_link","params":{"source_path":"One.md","destination":"Views.base#Table"}}}
{"version":1,"id":"c46","request":{"method":"evaluate_base","params":{"path":"Views.base","view":"Nope"}}}
{"version":1,"id":"c47","request":{"method":"evaluate_base","params":{"path":"Broken.base"}}}
{"version":1,"id":"c48","request":{"method":"evaluate_base","params":{"path":"Views.base","view":"Bad"}}}
{"version":1,"id":"c49","request":{"method":"evaluate_base","params":{"path":"Views.base","this_path":"Gone.md"}}}
{"version":1,"id":"c50","request":{"method":"evaluate_base","params":{"path":"Views.base","limit":0}}}
{"version":1,"id":"c51","request":{"method":"evaluate_base","params":{"path":"Nowhere.base"}}}
```

`unsupported_function` and `generation_mismatch` are pinned in `bases_ops.rs` rather than here: the first needs a second malformed view in the fixture base for no conformance gain, and the second needs a mutation between two pages, which this set's ordering puts after the subscription. The `views_invalidated` event joins this set's transcript in Task 12 (the mutations already in it produce one).

- [ ] **Step 10: Run the tests and see them pass**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test bases_ops; echo "exit=$?"
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test conformance; echo "exit=$?"
```

Expected: `bases_ops` 7 passed, `conformance` all passed, `exit=0` both. If `the_socket_answers_the_fixture_set_exactly_as_stdio_does` fails on a cell, look for a value that depends on the instant (a date cell) — the fixture base must not contain one.

- [ ] **Step 11: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
```

Expected: `exit=0` four times.

- [ ] **Step 12: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(server): evaluate_base and list_bases over a generation-consistent row source

The daemon implements RowSource inside one read: SQLite answers facts, properties, tags, links, embeds, backlinks and the prefilter narrowing, and the live graph lent for the same read answers the base and resolution. evaluate_base pages rows of typed cells from one computation per base, view, this_path and generation; list_bases pages the bases with their status. Every refusal has its code — base_invalid, view_not_found, expression_invalid, unsupported_function, not_found, invalid_request, invalid_cursor, generation_mismatch, index_unavailable — and both operations join the conformance set over both transports.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 12: Freshness — the bounded per-generation LRU and its knob, the staleness rule, and `views_invalidated`

Results are cached per (base, view, `this_path`, generation) in an LRU bounded at 64 entries by default (`--bases-cache-entries`), and every entry of an older generation is dropped on the first request at a newer one. After each committed generation the dispatcher marks views possibly stale by the spec's coarse rule and emits one `views_invalidated { base, view, generation }` per stale view through the same subscription registry, bounds and lag marker as every event. The rule runs on the dispatcher — never on the coordinator — and its answer is memoized per generation, so many connections pay for it once. False positives are accepted; a false negative is a defect.

**The rule, as implemented** (the spec's four clauses, plus two conservative clauses this plan adds so no false negative survives — both only ever add events): a view is stale at generation G when
1. its base's path is in G's change set; or
2. a changed path is in the row set the view last answered (any `this_path`); or
3. a changed path that exists at G passes every one of the view's prefilters (a view with none passes every path); or
4. the view reads formulas, links or backlinks, and any note changed; or
5. *(added)* the view reads `this`, and any note changed — `this` is an embedding note, and the rule runs per view, not per embedding; or
6. *(added)* a note whose outgoing references (body or frontmatter) re-resolved to a different answer at G counts as changed for clauses 2 to 5 — a frontmatter link's resolution moves when its target appears or vanishes even though the note holding it did not change, and the targeted reconciliation already knows exactly which sources that was.

A `resync_required` (any reason) carries no change set; a client that receives one re-reads everything, views included, so no `views_invalidated` accompanies it.

**Files:**

- Modify: `crates/vault-server/src/bases.rs` (the LRU; recording row sets), `crates/vault-server/src/lib.rs` (`ViewTracker` on `Server`, `set_base_cache_entries`, `stale_views`, re-exports), `crates/vault-server/src/main.rs` (the flag), `crates/vault-server/src/connection.rs:501-506` (the notice arm), `crates/vault-server/src/subscriptions.rs` (`enqueue_views_invalidated`, `event_generation`)
- Create: `crates/vault-server/src/views.rs`
- Modify: `crates/vault-index/src/query/bases.rs` (`prefilter_facts`, `base_dependencies`), `crates/vault-index/src/lib.rs`, `crates/vault-index/src/live_reconcile.rs` (`LiveRefreshReport.reresolved`)
- Modify: `crates/vault-protocol/src/events.rs` (`ViewsInvalidatedEventDto`, the variant, the visitor arm), `crates/vault-protocol/src/lib.rs`
- Create: `crates/vault-server/tests/bases_freshness.rs`, `crates/vault-index/tests/reresolved.rs`
- Modify: `crates/vault-server/tests/conformance.rs` (the `views_invalidated` proof), `crates/vault-server/src/broadcast.rs` and `crates/vault-server/src/bin/vault-live-bench.rs` (the new report field)

**Interfaces:**

- Consumes: `BaseAnswer.dependencies`, `ViewDependencies`, `Prefilter`, `LiveRefreshReport.changes`, `SubscriptionRegistry`, `BaseCache`, `CacheKey` (Task 11).
- Produces:

```rust
// vault-protocol
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ViewsInvalidatedEventDto { pub base: String, pub view: String, pub generation: u64 }
RuntimeEventDto::ViewsInvalidated(ViewsInvalidatedEventDto)

// vault-index
pub struct LiveRefreshReport { /* … */ pub reresolved: Vec<VaultPath> }   // sources whose references re-resolved differently
#[derive(Clone, Debug, Default, PartialEq)] pub struct PrefilterFacts { pub tags: Vec<String>, pub keys: Vec<String> }
impl IndexReader {
    pub fn prefilter_facts(&self, paths: &BTreeSet<VaultPath>) -> Result<(Generation, BTreeMap<VaultPath, PrefilterFacts>), IndexError>;
    pub fn base_dependencies(&self, bases: Option<&BTreeSet<VaultPath>>) -> Result<(Generation, BTreeMap<VaultPath, Vec<(String, Option<ViewDependencies>)>>), IndexError>;
}

// vault-server
impl BaseCache { pub(crate) fn with_capacity(capacity: usize) -> Self; pub(crate) fn len(&self) -> usize; }
pub(crate) struct ViewTracker;  // record(), stale_views()
impl Server { pub fn set_base_cache_entries(&mut self, entries: usize); pub(crate) fn stale_views(&self, report: &LiveRefreshReport) -> Vec<ViewsInvalidatedEventDto>; }
pub(crate) fn evaluate_base(
    reader: &IndexReader,
    cache: &BaseCache,
    tracker: &ViewTracker,
    types: impl FnOnce() -> BTreeMap<String, vault_bases::PropertyType>,
    params: EvaluateBaseParams,
) -> Result<EvaluateBaseResponse, ProtocolError>;   // widened from Task 11 by `tracker`
impl SubscriptionRegistry { pub fn enqueue_views_invalidated(&mut self, events: &[ViewsInvalidatedEventDto]); }
pub use bases::DEFAULT_BASE_CACHE_ENTRIES;
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-server/tests/bases_freshness.rs`:

```rust
mod daemon;

use std::collections::BTreeSet;

use tempfile::TempDir;
use vault_protocol::{EventEnvelope, Response, ResponseOutcome, RuntimeEventDto};

use daemon::Daemon;

/// The in-repo scratch root (`target/tmp`), from this crate's manifest
/// directory rather than `TMPDIR` — the socket harness's `tmp_root` rule.
fn scratch() -> std::path::PathBuf {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
    std::fs::create_dir_all(&root).expect("create the scratch root");
    root.canonicalize().expect("canonicalize the scratch root")
}

const BASE: &str = "views:\n  - type: table\n    name: InBooks\n    filters: 'file.inFolder(\"Books\")'\n    order: [price]\n    sort:\n      - property: price\n        direction: ASC\n  - type: table\n    name: Tagged\n    filters: 'file.hasTag(\"t\")'\n";

fn setup() -> (TempDir, TempDir, Daemon) {
    let vault = TempDir::new_in(scratch()).unwrap();
    let index = TempDir::new_in(scratch()).unwrap();
    std::fs::create_dir_all(vault.path().join("Books")).unwrap();
    std::fs::create_dir_all(vault.path().join("Other")).unwrap();
    std::fs::write(vault.path().join("Books/A.md"), "---\nprice: 1\n---\n").unwrap();
    std::fs::write(vault.path().join("Books/B.md"), "---\nprice: 2\n---\n").unwrap();
    std::fs::write(vault.path().join("Other/T.md"), "#t\n").unwrap();
    std::fs::write(vault.path().join("V.base"), BASE).unwrap();
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.call(r#"{"version":1,"id":"s","request":{"method":"subscribe_events","params":{}}}"#);
    for view in ["InBooks", "Tagged"] {
        daemon.call(&format!(r#"{{"version":1,"id":"e","request":{{"method":"evaluate_base","params":{{"path":"V.base","view":"{view}"}}}}}}"#));
    }
    (vault, index, daemon)
}

fn generation_of(daemon: &mut Daemon, line: &str) -> u64 {
    match daemon.call(line).outcome {
        ResponseOutcome::Ok(response) => {
            let value = serde_json::to_value(&response).unwrap();
            value["value"]["generation"].as_u64().unwrap_or_else(|| panic!("a generation in {value}"))
        }
        ResponseOutcome::Err(error) => panic!("{line}: {error:?}"),
    }
}

/// Every view invalidated at `generation`, read after that generation's own
/// commit event (the invalidations are enqueued right behind it).
fn invalidated_at(daemon: &mut Daemon, generation: u64) -> BTreeSet<String> {
    daemon.wait_for_event(|event| matches!(&event.event, RuntimeEventDto::GenerationCommitted(c) if c.generation == generation));
    daemon
        .drain_events()
        .iter()
        .filter_map(|raw| {
            let event: EventEnvelope = serde_json::from_str(raw).unwrap();
            match event.event {
                RuntimeEventDto::ViewsInvalidated(v) if v.generation == generation => Some(format!("{}#{}", v.base, v.view)),
                _ => None,
            }
        })
        .collect()
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| name.to_string()).collect()
}

#[test]
fn entering_reordering_and_leaving_a_view_invalidates_exactly_that_view() {
    let (_vault, _index, mut daemon) = setup();

    let entered = generation_of(&mut daemon, r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Books/C.md","content":"---\nprice: 3\n---\n","expected":{"absent":true}}}}"#);
    assert_eq!(invalidated_at(&mut daemon, entered), set(&["V.base#InBooks"]), "a note entering InBooks");

    let reordered = generation_of(&mut daemon, r#"{"version":1,"id":"p","request":{"method":"patch_frontmatter","params":{"path":"Books/A.md","patch":[{"key_path":"price","value":9}],"expected":{"any":true}}}}"#);
    assert_eq!(invalidated_at(&mut daemon, reordered), set(&["V.base#InBooks"]), "a row reordering inside InBooks");

    let left = generation_of(&mut daemon, r#"{"version":1,"id":"m","request":{"method":"rename_note","params":{"from":"Books/A.md","to":"Other/A.md","expected":{"any":true},"rewrite_links":true}}}"#);
    assert_eq!(invalidated_at(&mut daemon, left), set(&["V.base#InBooks"]), "a row leaving InBooks");

    let tagged = generation_of(&mut daemon, r#"{"version":1,"id":"t","request":{"method":"write_note","params":{"path":"Other/T.md","content":"#t and more\n","expected":{"any":true}}}}"#);
    assert_eq!(invalidated_at(&mut daemon, tagged), set(&["V.base#Tagged"]), "a tagged note changing");
}

#[test]
fn a_change_unrelated_to_any_view_fires_nothing() {
    let (_vault, _index, mut daemon) = setup();
    let unrelated = generation_of(&mut daemon, r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Other/U.md","content":"plain\n","expected":{"absent":true}}}}"#);
    assert_eq!(invalidated_at(&mut daemon, unrelated), BTreeSet::new());
}

#[test]
fn a_change_to_the_base_invalidates_every_view_it_declares() {
    let (vault, _index, mut daemon) = setup();
    let _ = vault;
    let encoded = base64_of(&format!("{BASE}  - type: list\n    name: Third\n"));
    let changed = generation_of(&mut daemon, &format!(r#"{{"version":1,"id":"f","request":{{"method":"write_file","params":{{"path":"V.base","content_base64":"{encoded}","expected":{{"any":true}}}}}}}}"#));
    assert_eq!(invalidated_at(&mut daemon, changed), set(&["V.base#InBooks", "V.base#Tagged", "V.base#Third"]));
}

fn base64_of(text: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn the_cache_hits_at_one_generation_and_misses_at_the_next() {
    let (vault, _index, mut daemon) = setup();
    std::fs::write(vault.path().join("Now.base"), "formulas:\n  at: 'now().format(\"x\")'\nviews:\n  - type: table\n    name: T\n    filters: 'file.path == \"Books/B.md\"'\n    order: [formula.at]\n").unwrap();
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let read = |daemon: &mut Daemon| -> (u64, String) {
        match daemon.call(r#"{"version":1,"id":"n","request":{"method":"evaluate_base","params":{"path":"Now.base"}}}"#).outcome {
            ResponseOutcome::Ok(Response::EvaluateBase(answer)) => {
                (answer.generation, serde_json::to_string(&answer.rows[0].cells[0]).unwrap())
            }
            other => panic!("{other:?}"),
        }
    };
    let first = read(&mut daemon);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let second = read(&mut daemon);
    assert_eq!(first, second, "a second read at one generation is the cached answer");
    daemon.call(r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Other/U.md","content":"x\n","expected":{"absent":true}}}}"#);
    let third = read(&mut daemon);
    assert_eq!(third.0, first.0 + 1);
    assert_ne!(third.1, first.1, "a new generation recomputes, so now() moved");
}

fn write_base(daemon: &mut Daemon, path: &str, text: &str) -> u64 {
    generation_of(
        daemon,
        &format!(r#"{{"version":1,"id":"b","request":{{"method":"write_file","params":{{"path":"{path}","content_base64":"{}","expected":{{"any":true}}}}}}}}"#, base64_of(text)),
    )
}

#[test]
fn a_base_created_while_nobody_listened_is_tracked_once_someone_does() {
    let (vault, _index, mut daemon) = setup();
    daemon.call(r#"{"version":1,"id":"u","request":{"method":"unsubscribe","params":{"subscription_id":"sub-1"}}}"#);
    std::fs::create_dir_all(vault.path().join("New")).unwrap();
    write_base(&mut daemon, "N.base", "views:\n  - type: table\n    name: V\n    filters: 'file.inFolder(\"New\")'\n");
    daemon.drain_events();
    daemon.call(r#"{"version":1,"id":"s2","request":{"method":"subscribe_events","params":{}}}"#);
    let entered = generation_of(&mut daemon, r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"New/X.md","content":"x\n","expected":{"absent":true}}}}"#);
    assert!(invalidated_at(&mut daemon, entered).contains("N.base#V"), "the base born unobserved is in the catalog");
}

#[test]
fn clause_five_a_view_reading_this_is_stale_when_any_note_changes() {
    let (_vault, _index, mut daemon) = setup();
    write_base(&mut daemon, "This.base", "views:\n  - type: table\n    name: ThisView\n    filters:\n      and:\n        - file.inFolder(\"Books\")\n        - 'file.name != this.file.name'\n");
    daemon.call(r#"{"version":1,"id":"e","request":{"method":"evaluate_base","params":{"path":"This.base"}}}"#);
    let unrelated = generation_of(&mut daemon, r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Other/U.md","content":"plain\n","expected":{"absent":true}}}}"#);
    // Other/U.md is outside the prefilter and was never a row: only clause 5
    // can name ThisView, and the other two views stay quiet.
    assert_eq!(invalidated_at(&mut daemon, unrelated), set(&["This.base#ThisView"]));
}

#[test]
fn clause_six_a_row_whose_link_target_appears_is_stale() {
    let (vault, _index, mut daemon) = setup();
    std::fs::create_dir_all(vault.path().join("Refs")).unwrap();
    std::fs::write(vault.path().join("Refs/R.md"), "---\nref: \"[[Target]]\"\n---\n").unwrap();
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    write_base(&mut daemon, "Refs.base", "views:\n  - type: table\n    name: Refs\n    filters: 'file.inFolder(\"Refs\")'\n");
    daemon.call(r#"{"version":1,"id":"e","request":{"method":"evaluate_base","params":{"path":"Refs.base"}}}"#);
    let appeared = generation_of(&mut daemon, r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Target.md","content":"# Target\n","expected":{"absent":true}}}}"#);
    // Target.md is outside every prefilter and no row changed its bytes; the
    // only path to Refs is R.md's reference re-resolving.
    assert_eq!(invalidated_at(&mut daemon, appeared), set(&["Refs.base#Refs"]));
}
```

Create `crates/vault-index/tests/reresolved.rs` — clause 6's input, pinned where it is computed:

```rust
mod common;

use std::collections::BTreeSet;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{ChangeCause, IndexConfig, IndexService};

#[test]
fn a_source_whose_reference_reresolves_is_reported_and_a_body_edit_is_not() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    std::fs::write(vault.path().join("R.md"), "---\nref: \"[[Target]]\"\n---\n[[Target]]\n").unwrap();
    let config = IndexConfig::explicit(vault.path(), index.path().join("i.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let target: BTreeSet<VaultPath> = [VaultPath::new("Target.md").unwrap()].into();

    std::fs::write(vault.path().join("Target.md"), "# Target\n").unwrap();
    let created = service.refresh_paths(target.clone(), ChangeCause::Watcher).unwrap();
    assert_eq!(created.reresolved, vec![VaultPath::new("R.md").unwrap()]);

    std::fs::write(vault.path().join("Target.md"), "# Target\n\nmore\n").unwrap();
    let edited = service.refresh_paths(target, ChangeCause::Watcher).unwrap();
    assert!(edited.reresolved.is_empty(), "a body edit moves no resolution: {:?}", edited.reresolved);
}
```

Add a unit-test module to `crates/vault-server/src/bases.rs` (after Step 3 writes the LRU):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn key(base: &str, generation: u64) -> CacheKey {
        CacheKey { base: VaultPath::new(base).unwrap(), view: None, this_path: None, generation }
    }

    fn entry() -> Arc<Cached> {
        Arc::new(Cached {
            answer: BaseAnswer {
                generation: vault_index::Generation::new(1),
                view: vault_bases::parse_base("views:\n  - type: table\n    name: T\n").unwrap().views.remove(0),
                columns: Vec::new(),
                result: vault_bases::view::ViewResult { rows: Vec::new(), summaries: Vec::new(), total_rows: 0 },
                dependencies: Default::default(),
            },
            clock: vault_bases::Clock::fixed(0, "UTC"),
        })
    }

    #[test]
    fn the_cache_is_bounded_least_recently_used_first() {
        let cache = BaseCache::with_capacity(2);
        cache.put(key("A.base", 1), entry());
        cache.put(key("B.base", 1), entry());
        assert!(cache.get(&key("A.base", 1)).is_some(), "touch A");
        cache.put(key("C.base", 1), entry());
        assert!(cache.get(&key("B.base", 1)).is_none(), "B was the least recently used");
        assert!(cache.get(&key("A.base", 1)).is_some());
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn a_newer_generation_drops_every_older_entry() {
        let cache = BaseCache::with_capacity(8);
        cache.put(key("A.base", 1), entry());
        assert!(cache.get(&key("A.base", 2)).is_none());
        assert_eq!(cache.len(), 0);
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd ~/repos/system/vaultd/.claude/worktrees/live-impl && TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test bases_freshness; echo "exit=$?"`

Expected: compile error `no variant named ViewsInvalidated`, `exit=101`.

- [ ] **Step 3: The event on the wire and in the registry**

In `crates/vault-protocol/src/events.rs`, add:

```rust
/// A view may have changed at `generation`: re-ask `evaluate_base` for it.
/// Coarse by design — false positives happen, false negatives do not. One
/// event per view, whichever embeddings (`this_path`) a client holds.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ViewsInvalidatedEventDto {
    pub base: String,
    pub view: String,
    pub generation: u64,
}
```

`RuntimeEventDto` gains `ViewsInvalidated(ViewsInvalidatedEventDto),` before `Unknown`; the visitor's `match named` gains `"views_invalidated" => RuntimeEventDto::ViewsInvalidated(map.next_value()?),`, and the missing-value list gains `"views_invalidated"`. Export it from `lib.rs`.

In `crates/vault-server/src/subscriptions.rs`: `event_generation` gains `RuntimeEventDto::ViewsInvalidated(event) => Some(event.generation),`, and `SubscriptionRegistry` gains:

```rust
    /// Offer the views one generation invalidated to every active
    /// subscription, through the same bounded queue as every other event.
    pub fn enqueue_views_invalidated(&mut self, events: &[ViewsInvalidatedEventDto]) {
        for subscription in self.subscriptions.values_mut() {
            if !subscription.active {
                continue;
            }
            for event in events {
                subscription.push(RuntimeEventDto::ViewsInvalidated(event.clone()));
            }
        }
    }
```

`Subscription::push` already filters `generation_committed` at or below a subscription's start; a `views_invalidated` is not filtered (like `resync_required`, it is news whatever the start point) and joins the lag collapse through `event_generation`.

In `crates/vault-server/src/connection.rs`, the dispatcher's notice arm (`connection.rs:501-506`) becomes:

```rust
            ServerInput::Notice(notice) => {
                // Computed for every committed generation, whether or not this
                // connection has a subscription: the tracker must see each
                // generation to keep its base catalog current, and the answer
                // is memoized per generation, so N connections pay once.
                let stale = match notice.as_ref() {
                    RuntimeNotice::Generation(report) => server.stale_views(report),
                    _ => Vec::new(),
                };
                subscriptions.enqueue_notice(*notice);
                if !stale.is_empty() {
                    subscriptions.enqueue_views_invalidated(&stale);
                }
                if !drain(&mut subscriptions, outputs) {
                    return Ok(());
                }
            }
```

- [ ] **Step 4: The index answers the two facts the rule needs**

First, clause 6's input: the source notes of the *incoming* selected references (those whose source was not itself replaced — a replaced source is already in `changes.modified`) whose new resolution differs from the stored one. In `crates/vault-index/src/live_reconcile.rs`:

- `LiveRefreshReport` gains, after `affected_reference_count`:

```rust
    /// Notes whose own bytes did not change but at least one of whose
    /// references now resolves differently, sorted. The staleness rule treats
    /// them as changed (a frontmatter link's target appeared or vanished).
    pub reresolved: Vec<VaultPath>,
```

- `BatchOutcome` gains `pub(crate) reresolved: Vec<VaultPath>,`;
- in `try_reconcile_batch`, immediately before `for (path, ordinals) in &by_source {`, add `let mut reresolved: BTreeSet<VaultPath> = BTreeSet::new();`, and inside that loop replace

```rust
                let target = LinkTarget::from(&existing.reference);
                let resolution = resolver.resolve_target(path, &target);
```

  with

```rust
                let target = LinkTarget::from(&existing.reference);
                let resolution = resolver.resolve_target(path, &target);
                // `existing` is the stored `ResolvedReference`: its resolution
                // is the answer the index held before this cycle.
                if resolution != existing.resolution {
                    reresolved.insert(path.clone());
                }
```

- the `DeltaPublishOutcome::Committed` arm's `BatchOutcome { … }` gains `reresolved: reresolved.into_iter().collect(),`, and the nothing-changed early return's `BatchOutcome { … }` gains `reresolved: Vec::new(),`;
- `refresh_paths`'s `outcome.map(|batch| LiveRefreshReport { … })` gains `reresolved: batch.reresolved,`;
- the two other `LiveRefreshReport` literals in the workspace — `crates/vault-server/src/broadcast.rs:475` (a test) and `crates/vault-server/src/bin/vault-live-bench.rs:684` — gain `reresolved: Vec::new(),`.

Then the two reads.

Append to `crates/vault-index/src/query/bases.rs`:

```rust
/// What prefilter matching needs to know about one changed path at the
/// current generation: its tags (lowercased) and its property keys (folded).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PrefilterFacts {
    pub tags: Vec<String>,
    pub keys: Vec<String>,
}

impl IndexReader {
    /// Facts for the paths that exist as files or notes at this generation;
    /// a deleted path or a folder has no entry.
    pub fn prefilter_facts(&self, paths: &std::collections::BTreeSet<VaultPath>) -> Result<(Generation, BTreeMap<VaultPath, PrefilterFacts>), IndexError> {
        self.read(|transaction, generation| {
            let mut facts = BTreeMap::new();
            for path in paths {
                let exists: Option<String> = transaction
                    .query_row("SELECT kind FROM tree_entries WHERE path = ?1 AND kind != 'folder'", params![path.as_str()], |row| row.get(0))
                    .optional()?;
                if exists.is_none() {
                    continue;
                }
                let mut tags = transaction.prepare_cached("SELECT comparison_key FROM tags WHERE note_path = ?1")?;
                let tags = tags.query_map(params![path.as_str()], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
                let mut keys = transaction.prepare_cached("SELECT key_fold FROM property_scalars WHERE note_path = ?1")?;
                let keys = keys.query_map(params![path.as_str()], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
                facts.insert(path.clone(), PrefilterFacts { tags, keys });
            }
            Ok((generation, facts))
        })
    }

    /// Every view of every base (or of `bases` only) with its dependencies;
    /// `None` for a view that does not compile, and an empty list for a base
    /// that does not parse.
    pub fn base_dependencies(
        &self,
        bases: Option<&std::collections::BTreeSet<VaultPath>>,
    ) -> Result<(Generation, BTreeMap<VaultPath, Vec<(String, Option<ViewDependencies>)>>), IndexError> {
        self.read_with_graph(|_, generation, graph| {
            let mut out = BTreeMap::new();
            for path in graph.base_paths() {
                if bases.is_some_and(|wanted| !wanted.contains(path)) {
                    continue;
                }
                let record = graph.base(path).expect("listed by base_paths");
                let views = match &record.file {
                    Some(file) => file
                        .view_names()
                        .into_iter()
                        .map(|name| {
                            let dependencies = compile_view(file, Some(&name)).ok().map(|view| view.dependencies().clone());
                            (name, dependencies)
                        })
                        .collect(),
                    None => Vec::new(),
                };
                out.insert(path.clone(), views);
            }
            Ok((generation, out))
        })
    }
}
```

Export `PrefilterFacts` from `crates/vault-index/src/lib.rs`.

- [ ] **Step 5: The tracker and the rule**

Create `crates/vault-server/src/views.rs`:

```rust
//! Which views a committed generation may have changed.
//!
//! The rule is the one `docs/protocol.md` documents under
//! `views_invalidated`: coarse, cheap, run on the dispatcher and memoized per
//! generation, so it never touches the coordinator and N connections pay for
//! it once. It may say a view changed when it did not; it must never say a
//! view is fresh when it changed.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use vault_bases::Prefilter;
use vault_bases::view::ViewDependencies;
use vault_core::VaultPath;
use vault_index::{IndexReader, LiveRefreshReport, PrefilterFacts};
use vault_protocol::ViewsInvalidatedEventDto;

type Views = Vec<(String, Option<ViewDependencies>)>;

#[derive(Default)]
struct State {
    /// The rows each (base, view) last answered, over every `this_path`.
    last_rows: BTreeMap<(VaultPath, String), BTreeSet<VaultPath>>,
    /// Every base's views and their dependencies, refreshed for the bases a
    /// generation changed; `None` until first needed.
    dependencies: Option<BTreeMap<VaultPath, Views>>,
    decided: Option<(u64, Arc<Vec<ViewsInvalidatedEventDto>>)>,
}

#[derive(Default)]
pub(crate) struct ViewTracker {
    state: Mutex<State>,
}

fn matches(prefilter: &Prefilter, path: &VaultPath, facts: &PrefilterFacts) -> bool {
    match prefilter {
        Prefilter::InFolder(folder) => {
            let folder = folder.trim_matches('/');
            folder.is_empty() || path.as_str().starts_with(&format!("{folder}/"))
        }
        Prefilter::Ext(ext) => vault_bases::extension(path) == ext.as_str(),
        Prefilter::HasTag(tags) => facts.tags.iter().any(|have| {
            tags.iter().any(|want| {
                let want = want.trim_start_matches('#').to_lowercase();
                *have == want || have.starts_with(&format!("{want}/"))
            })
        }),
        Prefilter::PropertyEquals { key, .. } => facts.keys.contains(&key.to_lowercase()),
    }
}

impl ViewTracker {
    /// Remember what a view answered, for clause 2.
    pub(crate) fn record(&self, base: &VaultPath, view: &str, rows: impl Iterator<Item = VaultPath>) {
        if let Ok(mut state) = self.state.lock() {
            state.last_rows.entry((base.clone(), view.to_string())).or_default().extend(rows);
        }
    }

    pub(crate) fn stale_views(&self, reader: &IndexReader, report: &LiveRefreshReport) -> Vec<ViewsInvalidatedEventDto> {
        let generation = report.generation.get();
        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        if let Some((decided, events)) = &state.decided {
            if *decided == generation {
                return events.as_ref().clone();
            }
        }
        let changes = &report.changes;
        let changed: BTreeSet<VaultPath> = changes
            .created
            .iter()
            .chain(&changes.modified)
            .chain(&changes.deleted)
            .chain(&report.reresolved)
            .cloned()
            .collect();
        let changed_bases: BTreeSet<VaultPath> = changed.iter().filter(|path| path.is_base()).cloned().collect();
        let note_changed = changed.iter().any(VaultPath::is_markdown);

        // The views of a base that just vanished still need their event, so
        // their names are taken from the previous map before it is refreshed.
        let previous: BTreeMap<VaultPath, Views> = state.dependencies.clone().unwrap_or_default();
        // The catalog is patched incrementally only when this report follows
        // directly on the last generation the tracker decided; after any gap
        // (a generation no dispatcher saw, a resync, the first call) it is
        // reloaded whole, so a base created in the gap is never missed.
        let continuous = state.dependencies.is_some()
            && state.decided.as_ref().map(|(decided, _)| *decided)
                == report.previous_generation.map(vault_index::Generation::get);
        let refreshed = if !continuous {
            reader.base_dependencies(None).map(|(_, all)| all)
        } else if changed_bases.is_empty() {
            Ok(previous.clone())
        } else {
            reader.base_dependencies(Some(&changed_bases)).map(|(_, fresh)| {
                let mut merged = previous.clone();
                for path in &changed_bases {
                    merged.remove(path);
                }
                merged.extend(fresh);
                merged
            })
        };
        // When the index cannot answer, every known view is stale: the one
        // failure that may never become a false negative.
        let (catalog, facts) = match (refreshed, reader.prefilter_facts(&changed)) {
            (Ok(catalog), Ok((_, facts))) => (catalog, Some(facts)),
            (Ok(catalog), Err(_)) => (catalog, None),
            (Err(_), _) => (previous.clone(), None),
        };

        let mut events = Vec::new();
        let mut names: BTreeSet<(VaultPath, String)> = BTreeSet::new();
        for path in &changed_bases {
            for (view, _) in previous.get(path).into_iter().flatten().chain(catalog.get(path).into_iter().flatten()) {
                names.insert((path.clone(), view.clone()));
            }
        }
        for (base, views) in &catalog {
            for (view, dependencies) in views {
                if names.contains(&(base.clone(), view.clone())) {
                    continue;
                }
                let key = (base.clone(), view.clone());
                let stale = match (dependencies, &facts) {
                    (_, None) | (None, _) => true,
                    (Some(deps), Some(facts)) => {
                        state.last_rows.get(&key).is_some_and(|rows| changed.iter().any(|path| rows.contains(path)))
                            || changed.iter().any(|path| {
                                facts.get(path).is_some_and(|facts| deps.prefilters.iter().all(|p| matches(p, path, facts)))
                            })
                            || ((deps.reads_formulas || deps.reads_links || deps.reads_backlinks || deps.reads_this) && note_changed)
                    }
                };
                if stale {
                    names.insert(key);
                }
            }
        }
        for (base, view) in names {
            events.push(ViewsInvalidatedEventDto { base: base.as_str().to_string(), view, generation });
        }
        state.dependencies = Some(catalog);
        state.decided = Some((generation, Arc::new(events.clone())));
        events
    }
}
```

Clause 3 runs only for paths with facts (they exist at G and are files or notes); a deleted path reaches a view only through clause 2 (it was a row) or clauses 4–6, which is exactly where its absence matters. The `a_change_unrelated_to_any_view_fires_nothing` test is what proves clauses 3 to 6 stay quiet: neither fixture view reads formulas, links, backlinks or `this`, `Other/U.md` passes neither view's prefilters, and nothing links to `U`, so no reference re-resolves.

- [ ] **Step 6: The bounded cache, the knob, and the wiring**

In `crates/vault-server/src/bases.rs`, replace `BaseCache` with an LRU:

```rust
pub(crate) struct BaseCache {
    capacity: usize,
    entries: Mutex<(HashMap<CacheKey, Arc<Cached>>, std::collections::VecDeque<CacheKey>)>,
}

impl Default for BaseCache {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_BASE_CACHE_ENTRIES)
    }
}

impl BaseCache {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self { capacity: capacity.max(1), entries: Mutex::new((HashMap::new(), std::collections::VecDeque::new())) }
    }

    fn drop_older(entries: &mut (HashMap<CacheKey, Arc<Cached>>, std::collections::VecDeque<CacheKey>), generation: u64) {
        entries.0.retain(|have, _| have.generation >= generation);
        entries.1.retain(|have| have.generation >= generation);
    }

    pub(crate) fn get(&self, key: &CacheKey) -> Option<Arc<Cached>> {
        let mut entries = self.entries.lock().ok()?;
        Self::drop_older(&mut entries, key.generation);
        let hit = entries.0.get(key).cloned()?;
        entries.1.retain(|have| have != key);
        entries.1.push_back(key.clone());
        Some(hit)
    }

    pub(crate) fn put(&self, key: CacheKey, value: Arc<Cached>) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        Self::drop_older(&mut entries, key.generation);
        entries.1.retain(|have| *have != key);
        entries.1.push_back(key.clone());
        entries.0.insert(key, value);
        while entries.0.len() > self.capacity {
            match entries.1.pop_front() {
                Some(oldest) => {
                    entries.0.remove(&oldest);
                }
                None => break,
            }
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.lock().map(|entries| entries.0.len()).unwrap_or(0)
    }
}
```

`drop_older` keeps a *newer* generation's entries (`>=`): a request racing a commit may carry the older current generation for an instant, and it must not evict an answer another connection already computed at the newer one.

`evaluate_base` gains a `tracker: &crate::views::ViewTracker` parameter (after `cache`), and on a cache miss, right after `cache.put`, records: `tracker.record(&path, &entry.answer.view.name, entry.answer.result.rows.iter().map(|row| row.path.clone()));`.

In `crates/vault-server/src/lib.rs`:

- `mod views;` and `pub use bases::DEFAULT_BASE_CACHE_ENTRIES;`;
- `Server` gains `views: views::ViewTracker` (default in both constructors);
- `pub fn set_base_cache_entries(&mut self, entries: usize) { self.base_cache = bases::BaseCache::with_capacity(entries); }` beside `set_socket_path`;
- `pub(crate) fn stale_views(&self, report: &vault_index::LiveRefreshReport) -> Vec<vault_protocol::ViewsInvalidatedEventDto>` returns `self.views.stale_views(reader, report)` when there is a reader and `Vec::new()` otherwise;
- the `EvaluateBase` arm's call becomes `bases::evaluate_base(reader, &self.base_cache, &self.views, || self.property_types(), params)`.

In `crates/vault-server/src/main.rs`, `Cli` gains:

```rust
    /// How many evaluated views to keep for the current generation. Older
    /// generations are always dropped; this bounds one generation's worth.
    #[arg(
        long,
        default_value_t = vault_server::DEFAULT_BASE_CACHE_ENTRIES,
        requires = "vault",
        value_parser = clap::value_parser!(usize).range(1..=4096),
    )]
    bases_cache_entries: usize,
```

(if `value_parser!(usize).range` does not exist for `usize` in this clap, parse as `u64` with the same range and convert), and `configured_server` calls `server.set_base_cache_entries(cli.bases_cache_entries)` on the server it builds before returning it (`let (mut server, notices) = Server::start(…)?;`).

- [ ] **Step 7: Run the tests and see them pass**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test bases_freshness; echo "exit=$?"
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --lib bases; echo "exit=$?"
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test conformance --test subscriptions; echo "exit=$?"
```

First add the conformance proof that the event is really in the transcript — append to `crates/vault-server/tests/conformance.rs`:

```rust
/// The Bases fixtures and the mutations after them must produce at least one
/// `views_invalidated` line, or "both transports carry the same ones" would
/// pass vacuously over a transcript that carries none.
#[test]
fn the_fixture_set_produces_a_views_invalidated_event() {
    let (transcript, _) = normalized(Transport::Stdio, &fixtures());
    assert!(
        transcript.iter().any(|line| line.contains(r#""type":"views_invalidated""#)),
        "no views_invalidated line in the transcript"
    );
}
```

Expected: 7 passed, 2 passed, and the conformance and subscription suites green, each `exit=0`; and `TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test reresolved; echo "exit=$?"` passes with `exit=0`. The conformance transcript now carries `views_invalidated` lines after its mutations (the fixture base `Views.base` has views with no prefilter, so every mutation stales them — clause 3's vacuous case); both transports carry the same ones in the same place, which is what that test compares.

- [ ] **Step 8: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
```

Expected: `exit=0` four times.

- [ ] **Step 9: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(server): views_invalidated, the staleness rule, and a bounded result cache

Evaluated views are cached per base, view, this_path and generation in an LRU of 64 entries by default (--bases-cache-entries), and an older generation's entries are dropped on the first request at a newer one. After each committed generation the dispatcher marks views stale by the spec's coarse rule — base changed, a row changed, a changed path passing the prefilters, formulas, links or backlinks read with any note changed — plus two conservative clauses for this and for notes whose references re-resolved, memoized per generation, and emits one views_invalidated per stale view through the bounded subscription queues.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 13: The parity corpus and the runtime captures — copy, generate, capture, replay, and settle every uncaptured case

This is the task that turns "published" and "uncaptured" into "captured". Five stages, two of them the maintainer's:

1. **Copy (the maintainer runs it, by hand).** `host/scripts/bases-corpus-copy.js` reads the maintainer's `.base` files and the notes they name from the live vault and writes them under `target/tmp/bases-corpus/`, with a manifest of what it copied and why. It is the **only** program in this phase that touches `~/vault`, it only reads there, and it never descends into `Private/`.
2. **Generate (the implementer).** `host/scripts/bases-capture.js generate` writes `Captures/` into the corpus: one base per function family, one view and one note per fixture row, and a probe base for the view-level questions (filter errors, default order, mixed-type sort, `Stddev`, limit before group, view-name case, hyphenated identifiers).
3. **Open (the maintainer, once).** The maintainer opens `target/tmp/bases-corpus` as a vault in Obsidian on the desktop machine ("Open folder as vault"), lets it finish indexing, and says so.
4. **Capture (the implementer).** `host/scripts/bases-capture.js capture` drives the `obsidian` CLI against that vault only — every call guarded by a check that the CLI is pointed at the corpus path — and saves each view's `base:query` output verbatim, plus the clock and zone the capture ran under.
5. **Replay and settle (the implementer).** The replay suite evaluates every captured view and every captured function row through the daemon's engine over the same corpus at the captured instant and zone, diffs rows and cell text, and the implementer changes the evaluator until every row agrees — implementing each named uncaptured case as captured, replacing `MIXED_TYPE_RANK` with the captured order, and fixing `render_text`'s provisional rules — then flips every fixture row's `source` to `captured`.

**How the implementer waits for the maintainer.** At stage 1 and again at stage 3 the implementer stops and reports `BLOCKED` to the controller with the exact text below; the controller relays it; the implementer resumes when the controller passes the maintainer's go-ahead back. It never runs stage 1 itself and never opens a vault.

- Stage 1 text: *"Please run, in this worktree: `node host/scripts/bases-corpus-copy.js --from ~/vault --to target/tmp/bases-corpus` — it reads your vault's `.base` files and the notes they name, skips `Private/`, writes only under `target/tmp/bases-corpus/`, and prints what it copied. Look at `target/tmp/bases-corpus/MANIFEST.json` and tell me it is fine to use."*
- Stage 3 text: *"Please open `<absolute path of target/tmp/bases-corpus>` in Obsidian on the desktop machine with Open folder as vault, wait until indexing finishes, leave it open, and tell me it is open."*

**Files:**

- Create: `host/scripts/bases-corpus-copy.js`, `host/scripts/bases-capture.js`
- Modify: `crates/vault-server/src/bin/fixture-row.rs` (a `--base-views` mode)
- Create: `crates/vault-server/tests/bases_replay.rs`, `crates/vault-server/tests/fixtures/bases-captures/` (written by stage 4: `meta.json`, `views/*.json`, `functions/*.json`)
- Modify: `crates/vault-server/Cargo.toml` (`[dev-dependencies]` `vault-bases = { path = "../vault-bases", features = ["fixtures"] }`)
- Modify (stage 5, driven by the captures): `crates/vault-bases/src/eval/coerce.rs`, `crates/vault-bases/src/functions/*.rs`, `crates/vault-bases/src/view/*.rs`, `crates/vault-bases/src/fixtures.rs`, `crates/vault-bases/tests/fixtures/captures/*.jsonl`, `crates/vault-core/src/resolver.rs` (only if `view:case` says Obsidian folds case)

**Interfaces:**

- Consumes: the fixture `.jsonl` files (Tasks 3–7), `IndexService`, `IndexReader::evaluate_base`, `BaseQuery`, `parse_property_types` (Task 11), `Clock::fixed`, `fixtures::render_text`.
- Produces: `crates/vault-server/tests/fixtures/bases-captures/meta.json` — `{"captured_at_ms": …, "zone": "…", "obsidian_version": "…", "corpus": "target/tmp/bases-corpus"}`; one `views/<slug>.json` per view — `{"base": "…", "view": "…", "exit_code": 0, "stdout": "<base:query format=json output, verbatim>"}`; one `functions/<family>.json` per family with the same shape per row view; and every fixture row with `"source":"captured"`.

**Rows whose answer is the row file's own facts.** A family row runs on `Capture.md` in the unit fixtures (`capture_vault`: name `Capture.md`, root folder, size 42, created one day and modified one hour before `FIXTURE_NOW_MS`) and on `Captures/<family>/rN.md` in the corpus, with that file's real size and times. Such a row cannot carry one literal `text` that both answer. So a row may carry `"expect_from": "corpus"` and a `"template"` instead of `"text"`: `{name}`, `{basename}`, `{path}`, `{folder}`, `{size}`, `{ctime:<Moment format>}`, `{mtime:<Moment format>}` and `{age_ms}` (`now − ctime`) are filled from the row file's facts — `Capture.md`'s in `check_family`, the corpus row note's (its tree entry in the index, the same `stat` Obsidian reads; the generated notes postdate `MANIFEST.json`, so the manifest does not list them) in the replay. The rows that take a template when Task 13 flips them, and their templates: `name` → `{name}`, `basename` → `{basename}`, `path` → `{path}`, `size` → `{size}`, `ctime` → `{ctime:YYYY-MM-DD HH:mm}`, `age` → `{age_ms}`, `asLink` → `{name}`; `folder:root` is settled by the `#folder_root` probe (a corpus row note is never at the root), and every other `file`/`link` row's answer (`Other.md`, `Folder/image.png`, the tag and link rows) is the same literal in both, because the generator writes the same companions at the same paths. This is what makes Step 9's "no row left uncaptured" reachable.

**The capture probes** (generated by stage 2, read at stage 5; each answers one named item from Tasks 2–8):

| Probe | What it settles | Task that named it |
| --- | --- | --- |
| `Captures/probes.base#filter_error_row` — filter `price > 2` over notes with and without `price` | whether a row whose filter errors is shown | 7 (`filter:error_row`) |
| `#sort_default` — no `sort` | the default row order | 7 (`sort:default`) |
| `#sort_mixed` — sort by a property holding a number, a string, a date, a boolean, a list and nothing across six notes | the mixed-type order that replaces `MIXED_TYPE_RANK` | 3 (`sort:mixed`) |
| `#stddev` — `Stddev` over 2, 4, 4, 4, 5, 5, 7, 9 | population (2) or sample (2.138…) | 7 (`summary:stddev`) |
| `#limit_group` — `limit: 2` with `groupBy` over four notes in two groups | limit before or after grouping | 7 (`limit:before_group`) |
| `Captures/embeds.md` — `![[probes.base#Sort_Default]]` and `![[probes.base#sort_default]]`, read back through `app.metadataCache.resolvedLinks` and the rendered embed | view-name case | 8 (`view:case`) |
| `#hyphen` — formula `image-property` with properties `image`, `property` and `image-property` | whether a hyphen joins an identifier | 2 (`hyphenated_identifier`) |
| `#tags_spelling`, `#folder_root`, `#has_link_embed`, `#file_missing` — one formula each | the four Task 6 cases | 6 |
| every `uncaptured` row of every family file | its case | 3–6 |

- [ ] **Step 1: The copy script**

Create `host/scripts/bases-corpus-copy.js`:

```js
#!/usr/bin/env node
"use strict";
/**
 * Copy a vault's bases, and the notes they name, into a scratch vault.
 *
 * The one program in the Bases phase that reads the live vault. It is run by
 * hand, by the vault's owner, and it only ever reads there:
 *
 *   node host/scripts/bases-corpus-copy.js --from ~/vault --to target/tmp/bases-corpus
 *
 * What it reads: every `.base` file under --from (skipping dot-directories
 * and the guarded private folder, unconditionally), every `.md` note's text (to find
 * tags and embeds), and `.obsidian/types.json`. What it writes: only under
 * --to, which must be inside this repository's `target/tmp/`, and which it
 * replaces wholesale when --fresh is given. What it copies, per base: the
 * base; the notes in every folder an `inFolder("…")` names; the notes that
 * carry a tag a `hasTag("…")` names; the notes a `[[link]]`, `link("…")`,
 * `file("…")` or `hasLink("…")` in the base names; the notes that embed the
 * base; and, for a base none of those narrow, the notes beside it — each set
 * capped at --max-per-set (default 200), in path order. `MANIFEST.json` lists
 * every copied path with every reason it was copied.
 */

const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join, relative, resolve, sep } = require("node:path");

const REPO = resolve(__dirname, "..", "..");
const SCRATCH = join(REPO, "target", "tmp");
// A private folder the copy never reads. Set VAULTD_CORPUS_GUARDED to name
// your own; the default is a placeholder.
const GUARDED = process.env.VAULTD_CORPUS_GUARDED || "Private";

function parseArgs(argv) {
  const out = { maxPerSet: 200, fresh: false };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const next = () => {
      at += 1;
      if (at >= argv.length) throw new Error(`${flag} wants a value`);
      return argv[at];
    };
    switch (flag) {
      case "--from": out.from = resolve(next()); break;
      case "--to": out.to = resolve(next()); break;
      case "--max-per-set": out.maxPerSet = Number(next()); break;
      case "--fresh": out.fresh = true; break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!out.from || !out.to) throw new Error("--from and --to are both required");
  if (!out.to.startsWith(SCRATCH + sep)) throw new Error(`--to must be inside ${SCRATCH}, not ${out.to}`);
  if (out.from.startsWith(out.to) || out.to.startsWith(out.from + sep)) throw new Error("--to and --from must not contain each other");
  if (!Number.isInteger(out.maxPerSet) || out.maxPerSet < 1) throw new Error("--max-per-set wants a positive integer");
  return out;
}

/** Every file under root, vault-relative, skipping dot-directories and the guarded area. */
function walk(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (rel === GUARDED || rel.startsWith(`${GUARDED}/`)) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(rel);
    }
  };
  visit(root);
  return files.sort();
}

const strings = (text, fn) => [...text.matchAll(new RegExp(`${fn}\\(\\s*(["'])(.*?)\\1`, "g"))].map((m) => m[2]);

function tagsOf(text) {
  const tags = new Set();
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (front) {
    const line = /^tags?:\s*(.*)$/m.exec(front[1]);
    if (line) for (const t of line[1].replace(/[[\]]/g, "").split(",")) if (t.trim()) tags.add(t.trim().replace(/^#/, "").toLowerCase());
    for (const m of front[1].matchAll(/^\s*-\s*#?([^\s#][^\n]*)$/gm)) tags.add(m[1].trim().toLowerCase());
  }
  for (const m of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(m[1].toLowerCase());
  return tags;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (existsSync(options.to) && readdirSync(options.to).length > 0) {
    if (!options.fresh) throw new Error(`${options.to} is not empty; pass --fresh to replace it`);
    rmSync(options.to, { recursive: true, force: true });
  }
  const files = walk(options.from);
  const notes = files.filter((f) => f.endsWith(".md"));
  const bases = files.filter((f) => f.endsWith(".base"));
  const text = new Map();
  const read = (rel) => {
    if (!text.has(rel)) text.set(rel, readFileSync(join(options.from, rel), "utf8"));
    return text.get(rel);
  };
  const reasons = new Map();
  const add = (rel, reason) => {
    if (!reasons.has(rel)) reasons.set(rel, []);
    reasons.get(rel).push(reason);
  };
  const capped = (list) => list.slice(0, options.maxPerSet);
  const byName = (name) => {
    const wanted = name.replace(/^\[\[|\]\]$/g, "").split(/[#|]/)[0].toLowerCase();
    return notes.filter((n) => n.toLowerCase() === wanted || n.toLowerCase() === `${wanted}.md` || n.toLowerCase().endsWith(`/${wanted}.md`) || n.toLowerCase().endsWith(`/${wanted}`));
  };

  for (const base of bases) {
    const source = read(base);
    add(base, "base");
    const folders = strings(source, "inFolder");
    const tags = strings(source, "hasTag").map((t) => t.replace(/^#/, "").toLowerCase());
    const named = [
      ...[...source.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]),
      ...strings(source, "link"), ...strings(source, "file"), ...strings(source, "hasLink"),
    ];
    for (const folder of folders) for (const n of capped(notes.filter((n) => n.startsWith(`${folder.replace(/\/$/, "")}/`)))) add(n, `${base}: inFolder ${folder}`);
    for (const tag of tags) {
      const tagged = notes.filter((n) => [...tagsOf(read(n))].some((t) => t === tag || t.startsWith(`${tag}/`)));
      for (const n of capped(tagged)) add(n, `${base}: hasTag ${tag}`);
    }
    for (const name of named) for (const n of byName(name)) add(n, `${base}: names ${name}`);
    const stem = base.split("/").pop();
    for (const n of capped(notes.filter((n) => read(n).includes(`![[${stem}`) || read(n).includes(`![[${base}`)))) add(n, `${base}: embeds it`);
    if (folders.length === 0 && tags.length === 0) {
      const here = dirname(base) === "." ? "" : `${dirname(base)}/`;
      for (const n of capped(notes.filter((n) => n.startsWith(here) && !n.slice(here.length).includes("/")))) add(n, `${base}: beside it`);
    }
  }

  for (const rel of [...reasons.keys()].sort()) {
    const target = join(options.to, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(options.from, rel), target, { preserveTimestamps: true });
  }
  const types = join(options.from, ".obsidian", "types.json");
  if (existsSync(types) && statSync(types).isFile()) {
    mkdirSync(join(options.to, ".obsidian"), { recursive: true });
    cpSync(types, join(options.to, ".obsidian", "types.json"));
    add(".obsidian/types.json", "property types");
  }
  const manifest = {
    from: options.from,
    copied: Object.fromEntries([...reasons.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    bases: bases.length,
    excluded: `${GUARDED}/ and every dot-directory, unconditionally`,
  };
  writeFileSync(join(options.to, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`bases: ${bases.length}, files copied: ${reasons.size}, manifest: ${join(options.to, "MANIFEST.json")}`);
}

try {
  main();
} catch (error) {
  console.error(`bases-corpus-copy: ${error.message}`);
  process.exit(2);
}
```

`MANIFEST.json` inside the scratch vault is a file Obsidian will see; it is not Markdown, so it is an attachment row in any base without filters — which is exactly what Obsidian sees too, so parity holds.

Run: `npm --prefix host run lint; echo "exit=$?"`. Expected: `exit=0`.

- [ ] **Step 2: The capture script**

Create `host/scripts/bases-capture.js`:

```js
#!/usr/bin/env node
"use strict";
/**
 * Generate the capture probes into the scratch corpus, and capture what
 * Obsidian answers for every view in it.
 *
 *   node host/scripts/bases-capture.js generate --corpus target/tmp/bases-corpus
 *   node host/scripts/bases-capture.js capture --corpus target/tmp/bases-corpus --vault-name bases-corpus \
 *        --out crates/vault-server/tests/fixtures/bases-captures
 *
 * `capture` never runs a command against any vault but the corpus: before
 * anything else, and again inside every `eval`, it checks that the vault the
 * CLI answers for is the corpus path, and exits 3 otherwise. It never reads
 * or writes outside --corpus and --out.
 */

const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { join, relative, resolve, sep } = require("node:path");

const REPO = resolve(__dirname, "..", "..");
const SCRATCH = join(REPO, "target", "tmp");
const FAMILIES = ["coercion", "global", "any", "string", "number", "list", "object", "regexp", "date", "link", "file"];
const CAPTURES = join(REPO, "crates", "vault-bases", "tests", "fixtures", "captures");

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const out = { mode };
  for (let at = 0; at < rest.length; at += 1) {
    const flag = rest[at];
    const value = rest[at + 1];
    at += 1;
    if (value === undefined) throw new Error(`${flag} wants a value`);
    if (flag === "--corpus") out.corpus = resolve(value);
    else if (flag === "--vault-name") out.vaultName = value;
    else if (flag === "--out") out.out = resolve(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!["generate", "capture"].includes(out.mode)) throw new Error("the mode is generate or capture");
  if (!out.corpus || !out.corpus.startsWith(SCRATCH + sep)) throw new Error(`--corpus must be inside ${SCRATCH}`);
  if (out.mode === "capture" && (!out.vaultName || !out.out)) throw new Error("capture needs --vault-name and --out");
  return out;
}

const yamlString = (text) => `'${text.replace(/'/g, "''")}'`;
const slug = (text) => text.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");

function rows(family) {
  return readFileSync(join(CAPTURES, `${family}.jsonl`), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Frontmatter for a row's props, as YAML Obsidian reads back to the same values. */
function frontmatter(props = {}) {
  const lines = Object.entries(props).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return lines.length ? `---\n${lines.join("\n")}\n---\n` : "";
}

/** The body every capture row's note carries: the shape `capture_vault` gives `Capture.md`. */
const ROW_BODY = "#book #Project/Active [[Other]] [[Missing]] ![[Folder/image.png]]\n";

function generate(options) {
  const root = join(options.corpus, "Captures");
  mkdirSync(root, { recursive: true });
  // The two companions every row links to live at the corpus root, exactly
  // where `capture_vault` puts them, so a row's literal answer (`Other.md`,
  // `Folder/image.png`) is the same in the corpus as in the unit fixtures.
  for (const companion of ["Other.md", join("Folder", "image.png")]) {
    if (existsSync(join(options.corpus, companion))) {
      throw new Error(`${companion} already exists in the corpus; the capture rows need that path`);
    }
  }
  mkdirSync(join(options.corpus, "Folder"), { recursive: true });
  writeFileSync(join(options.corpus, "Folder", "image.png"), Buffer.alloc(1000));
  const rowPaths = [];
  for (const family of FAMILIES) {
    const dir = join(root, family);
    mkdirSync(dir, { recursive: true });
    const views = [];
    const formulas = [];
    rows(family).forEach((row, index) => {
      // `this` is the base when a view is opened directly; rows about `this`
      // are captured through the corpus views instead.
      if (/\bthis\b/.test(row.expr)) return;
      const note = `r${index}`;
      writeFileSync(join(dir, `${note}.md`), `${frontmatter(row.props)}${ROW_BODY}`);
      rowPaths.push(`Captures/${family}/${note}`);
      formulas.push(`  f${index}: ${yamlString(row.expr)}`);
      views.push(`  - type: table\n    name: ${note}\n    filters: ${yamlString(`file.path == "Captures/${family}/${note}.md"`)}\n    order: [formula.f${index}]`);
    });
    writeFileSync(join(root, `${family}.base`), `formulas:\n${formulas.join("\n")}\nviews:\n${views.join("\n")}\n`);
  }
  // `Other.md` links back to every row, so a row's first backlink is
  // `Other.md` here as it is in `capture_vault`.
  writeFileSync(
    join(options.corpus, "Other.md"),
    `---\nstatus: done\n---\n${rowPaths.map((path) => `[[${path}]]`).join("\n")}\n`,
  );
  const probe = (name, notes, view) => ({ name, notes, view });
  const probes = [
    probe("filter_error_row", [["a", { price: 3 }], ["b", {}]], "    filters: 'price > 2'"),
    probe("sort_default", [["z", {}], ["a", {}], ["m", {}]], ""),
    probe("sort_mixed", [["n", { mix: 5 }], ["s", { mix: "five" }], ["d", { mix: "2025-01-01" }], ["b", { mix: true }], ["l", { mix: [1] }], ["e", {}]],
      "    order: [mix]\n    sort:\n      - property: mix\n        direction: ASC"),
    probe("stddev", [2, 4, 4, 4, 5, 5, 7, 9].map((v, i) => [`v${i}`, { v }]), "    order: [v]\n    summaries:\n      v: Stddev"),
    probe("limit_group", [["a", { g: 1, k: 1 }], ["b", { g: 2, k: 2 }], ["c", { g: 1, k: 3 }], ["d", { g: 2, k: 4 }]],
      "    order: [k]\n    limit: 2\n    sort:\n      - property: k\n        direction: DESC\n    groupBy:\n      property: g\n      direction: ASC"),
    probe("hyphen", [["h", { image: 10, property: 3, "image-property": 99 }]], "    order: [formula.hyphen]"),
    probe("tags_spelling", [["t", {}]], "    order: [formula.tags]"),
    probe("folder_root", [], "    filters: 'file.path == \"Root-probe.md\"'\n    order: [formula.folder]"),
    probe("has_link_embed", [["e", {}]], "    order: [formula.has_embed]"),
    probe("file_missing", [["f", {}]], "    order: [formula.missing_file]"),
  ];
  const probeDir = join(root, "probes");
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(options.corpus, "Root-probe.md"), "root\n");
  const views = probes.map((p) => {
    for (const [name, props] of p.notes) writeFileSync(join(probeDir, `${p.name}-${name}.md`), `${frontmatter(props)}${name === "t" ? "#Mixed/Case\n" : ""}${name === "e" ? "![[Captures/Other.md]]\n" : ""}`);
    const filter = p.view.includes("filters:") ? "" : `    filters: ${yamlString(`file.inFolder("Captures/probes") && file.name.startsWith("${p.name}-")`)}\n`;
    return `  - type: table\n    name: ${p.name}\n${filter}${p.view}`.replace(/\n$/, "");
  });
  writeFileSync(
    join(root, "probes.base"),
    `formulas:\n  hyphen: 'image-property'\n  tags: 'file.tags'\n  folder: 'file.folder'\n  has_embed: 'file.hasLink("Captures/Other.md")'\n  missing_file: 'file("path to nowhere")'\nviews:\n${views.join("\n")}\n  - type: table\n    name: Sort_Default\n`,
  );
  writeFileSync(join(root, "embeds.md"), "![[probes.base#Sort_Default]]\n![[probes.base#sort_default]]\n");
  console.log(`generated Captures/ in ${options.corpus}`);
}

function obsidian(vaultName, args) {
  const result = spawnSync("obsidian", [`vault=${vaultName}`, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function guard(options) {
  const expected = realpathSync(options.corpus);
  const info = obsidian(options.vaultName, ["vault", "info=path"]);
  if (info.code !== 0 || realpathSync(info.stdout.trim() || "/nonexistent-guard") !== expected) {
    console.error(`bases-capture: the CLI answers for ${JSON.stringify(info.stdout.trim())}, not ${expected}; is the corpus open as ${options.vaultName}?`);
    process.exit(3);
  }
  return expected;
}

/** Run JavaScript in the app, refusing the answer unless it came from the corpus. */
function evalInCorpus(options, expected, body) {
  const code = `(() => { const base = app.vault.adapter.basePath; if (base !== ${JSON.stringify(expected)}) return JSON.stringify({ refused: base }); return JSON.stringify({ value: (${body})() }); })()`;
  const answer = obsidian(options.vaultName, ["eval", `code=${code}`]);
  // The CLI prints the expression's value; a leading "=> " marker, where the
  // installed CLI writes one, is not part of it.
  const parsed = JSON.parse(answer.stdout.trim().replace(/^=>\s*/, ""));
  if ("refused" in parsed) {
    console.error(`bases-capture: eval ran in ${parsed.refused}, not the corpus; stopping`);
    process.exit(3);
  }
  return parsed.value;
}

function baseFiles(corpus) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".base")) out.push(relative(corpus, full).split(sep).join("/"));
    }
  };
  visit(corpus);
  return out.sort();
}

function viewNames(corpus, base) {
  // Read with the daemon's own parser, so the capture asks Obsidian about
  // exactly the views vaultd will evaluate.
  const listing = execFileSync(join(REPO, "target", "release", "fixture-row"), ["--base-views"], { input: readFileSync(join(corpus, base)), encoding: "utf8" });
  return JSON.parse(listing);
}

function capture(options) {
  const expected = guard(options);
  mkdirSync(join(options.out, "views"), { recursive: true });
  mkdirSync(join(options.out, "functions"), { recursive: true });
  const meta = evalInCorpus(options, expected, "() => ({ now: Date.now(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone, appVersion: navigator.userAgent.match(/obsidian\\/([\\d.]+)/i)?.[1] ?? null })");
  const resolved = evalInCorpus(options, expected, "() => app.metadataCache.resolvedLinks['Captures/embeds.md'] ?? null");
  writeFileSync(join(options.out, "meta.json"), `${JSON.stringify({ captured_at_ms: meta.now, zone: meta.zone, obsidian_version: meta.appVersion, corpus: relative(REPO, options.corpus), embeds_resolved: resolved }, null, 2)}\n`);
  for (const base of baseFiles(options.corpus)) {
    const family = /^Captures\/([a-z]+)\.base$/.exec(base)?.[1];
    for (const view of viewNames(options.corpus, base)) {
      const answer = obsidian(options.vaultName, ["base:query", `path=${base}`, `view=${view}`, "format=json"]);
      const record = { base, view, exit_code: answer.code, stdout: answer.stdout, stderr: answer.stderr };
      const dir = family && family !== "probes" ? join(options.out, "functions", family) : join(options.out, "views");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${slug(base)}__${slug(view)}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
  }
  console.log(`captured into ${options.out}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "generate") generate(options);
  else capture(options);
} catch (error) {
  console.error(`bases-capture: ${error.message}`);
  process.exit(2);
}
```

`viewNames` asks the daemon's own parser for a base's view names through the existing `fixture-row` test binary (`crates/vault-server/src/bin/fixture-row.rs`), which gains one mode: with `--base-views`, it reads a `.base` document on stdin and prints `vault_bases::parse_base(text).map(|b| b.view_names()).unwrap_or_default()` as a JSON array. Add that branch at the top of its `main` (eight lines: read stdin to a string, parse, print, return), plus `vault-bases` in `vault-server`'s normal dependencies (already there since Task 11). A base that does not parse has no views and is captured by no `base:query` — its parse failure is the daemon's to report, and Obsidian's own error view is not row data.

Run: `npm --prefix host run lint; echo "exit=$?"` and `cargo build --release --bin fixture-row --bin vaultd; echo "exit=$?"`. Expected: `exit=0` twice.

Nothing is committed yet: the task commits once, at Step 10, with the scripts, the captures and the settled evaluator together. The scripts run from the working tree.

- [ ] **Step 3: Stage 1 — the maintainer copies**

Stop. Report `BLOCKED` with the stage 1 text above. When the controller relays the maintainer's go-ahead, check: `ls target/tmp/bases-corpus/MANIFEST.json; echo "exit=$?"` — `exit=0`; and `grep -c '"Private/' target/tmp/bases-corpus/MANIFEST.json; echo "exit=$?"` — prints `0` (`exit=1` from `grep` meaning no match is the success).

- [ ] **Step 4: Stage 2 — generate**

Run: `node host/scripts/bases-capture.js generate --corpus target/tmp/bases-corpus; echo "exit=$?"`. Expected: `generated Captures/ in …`, `exit=0`.

- [ ] **Step 5: Stage 3 — the maintainer opens the vault**

Stop. Report `BLOCKED` with the stage 3 text above, giving the absolute path (`realpath target/tmp/bases-corpus`). Resume on the maintainer's go-ahead.

- [ ] **Step 6: Stage 4 — capture**

Run (backgrounded with a bound: ~300 CLI calls):

```bash
timeout 1800 node host/scripts/bases-capture.js capture --corpus target/tmp/bases-corpus --vault-name bases-corpus --out crates/vault-server/tests/fixtures/bases-captures > target/tmp/t13-capture.log 2>&1; echo "exit=$?" >> target/tmp/t13-capture.log
```

Expected: the log ends `captured into …` then `exit=0`. An `exit=3` means a guard refused — the CLI was pointed elsewhere; tell the controller, do not retry with a different vault name.

Then open one view capture and one function capture and write down, in the replay suite's module comment, the exact shape `base:query format=json` produced (an array of row objects keyed by column? rendered strings or typed values? the file path under which key?). That shape is a fact of the installed Obsidian; the replay's `rows_of` below is written against it. If `base:query` does not carry cell values at all (paths only), the cells are captured instead through `evalInCorpus` reading the rendered view's cell text — add that as a second capture pass in `bases-capture.js` (open the base with `app.workspace.openLinkText`, wait for the view, read `.bases-table` cell `textContent` per row) and say in the report that `base:query` alone was not enough.

- [ ] **Step 7: The replay suite**

Create `crates/vault-server/tests/bases_replay.rs`:

```rust
//! Replay every capture against vaultd's evaluator over the same corpus.
//!
//! Ignored by default: it needs `target/tmp/bases-corpus` (made by hand in
//! Task 13) and the captures. Run with
//! `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test bases_replay -- --ignored`.
//!
//! The engine is driven through `IndexReader::evaluate_base` with the
//! captured clock and zone, and cells are compared as the text
//! `vault_bases::fixtures::render_text` gives them — the wire conversion is
//! pinned separately by `bases_ops.rs` and the conformance set, so this file
//! pins exactly one thing: that vaultd computes what Obsidian computed.
//!
//! Shape of `base:query format=json`, recorded at capture time: (filled in
//! from the first capture in Task 13 Step 6, one paragraph).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use vault_bases::Clock;
use vault_bases::fixtures::render_text;
use vault_core::VaultPath;
use vault_index::{BaseQuery, IndexConfig, IndexService, parse_property_types};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Captured {
    base: String,
    view: String,
    /// (row path, cell texts) in captured order.
    rows: Vec<(String, Vec<String>)>,
}

/// The captured rows of one record. Written against the shape recorded in
/// this module's comment; a record whose `exit_code` is not 0 has no rows.
fn rows_of(record: &serde_json::Value) -> Vec<(String, Vec<String>)> {
    let stdout = record["stdout"].as_str().unwrap_or_default();
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return Vec::new();
    };
    rows.iter()
        .map(|row| {
            let path = row["path"].as_str().or_else(|| row["file"].as_str()).unwrap_or_default().to_string();
            let cells = row
                .as_object()
                .map(|object| {
                    object
                        .iter()
                        .filter(|(key, _)| key.as_str() != "path" && key.as_str() != "file")
                        .map(|(_, value)| match value {
                            serde_json::Value::String(text) => text.clone(),
                            serde_json::Value::Null => String::new(),
                            other => other.to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            (path, cells)
        })
        .collect()
}

fn captures(dir: &Path) -> Vec<Captured> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            out.extend(captures(&path));
            continue;
        }
        let record: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        if record["exit_code"].as_i64() != Some(0) {
            continue;
        }
        out.push(Captured {
            base: record["base"].as_str().unwrap().to_string(),
            view: record["view"].as_str().unwrap().to_string(),
            rows: rows_of(&record),
        });
    }
    out
}

#[test]
#[ignore = "needs the hand-made corpus under target/tmp/bases-corpus"]
fn every_captured_view_replays_exactly() {
    let root = repo();
    let corpus = root.join("target/tmp/bases-corpus");
    let fixtures = root.join("crates/vault-server/tests/fixtures/bases-captures");
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fixtures.join("meta.json")).expect("meta.json")).unwrap();
    let clock = Clock::fixed(meta["captured_at_ms"].as_i64().unwrap(), meta["zone"].as_str().unwrap());

    let index = tempfile::TempDir::new_in(root.join("target/tmp")).unwrap();
    let config = IndexConfig::explicit(&corpus, index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let reader = service.reader().unwrap();
    let types = std::fs::read_to_string(corpus.join(".obsidian/types.json"))
        .map(|text| parse_property_types(&text))
        .unwrap_or_else(|_| BTreeMap::new());

    let mut failures = Vec::new();
    let all = captures(&fixtures);
    assert!(!all.is_empty(), "no captures under {}", fixtures.display());
    for captured in &all {
        let base = VaultPath::new(captured.base.as_str()).unwrap();
        let answer = match reader.evaluate_base(&BaseQuery { path: &base, view: Some(&captured.view), this_path: None, types: &types }, &clock) {
            Ok(answer) => answer,
            Err(error) => {
                failures.push(format!("{}#{}: vaultd refused: {error:?}", captured.base, captured.view));
                continue;
            }
        };
        let ours: Vec<(String, Vec<String>)> = answer
            .result
            .rows
            .iter()
            .map(|row| {
                let cells = row
                    .cells
                    .iter()
                    .map(|cell| match cell {
                        Ok(value) => render_text(value, &clock),
                        Err(error) => format!("<error: {error}>"),
                    })
                    .collect();
                (row.path.as_str().to_string(), cells)
            })
            .collect();
        if ours != captured.rows {
            failures.push(format!(
                "{}#{}:\n  obsidian {:?}\n  vaultd   {:?}",
                captured.base, captured.view, captured.rows, ours
            ));
        }
    }
    assert!(failures.is_empty(), "{} of {} views differ:\n{}", failures.len(), all.len(), failures.join("\n"));
}

/// Every family row with `expect_from: corpus` agrees with its capture once
/// the template is filled from the corpus row note's own facts.
#[test]
#[ignore = "needs the hand-made corpus under target/tmp/bases-corpus"]
fn every_templated_row_agrees_with_its_capture() {
    use vault_bases::fixtures::{TemplateFacts, fill_template, load_captures};
    let root = repo();
    let corpus = root.join("target/tmp/bases-corpus");
    let fixtures = root.join("crates/vault-server/tests/fixtures/bases-captures");
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fixtures.join("meta.json")).unwrap()).unwrap();
    let clock = Clock::fixed(meta["captured_at_ms"].as_i64().unwrap(), meta["zone"].as_str().unwrap());
    let index = tempfile::TempDir::new_in(root.join("target/tmp")).unwrap();
    let mut service = IndexService::open(IndexConfig::explicit(&corpus, index.path().join("i.sqlite3")).unwrap()).unwrap();
    service.refresh(false).unwrap();
    let reader = service.reader().unwrap();
    let captured = captures(&fixtures);
    let mut failures = Vec::new();
    for family in ["coercion", "global", "any", "string", "number", "list", "object", "regexp", "date", "link", "file"] {
        for (index, row) in load_captures(family).iter().enumerate() {
            let Some(template) = &row.template else { continue };
            let note = format!("Captures/{family}/r{index}.md");
            let Some(capture) = captured.iter().find(|c| c.base == format!("Captures/{family}.base") && c.view == format!("r{index}")) else {
                failures.push(format!("{family} {}: no capture", row.case));
                continue;
            };
            let (_, entries) = reader.tree_entries_for(&[VaultPath::new(note.as_str()).unwrap()]).unwrap();
            let entry = entries[0].clone().expect("the row note is indexed");
            let facts = TemplateFacts {
                path: note.clone(),
                size: entry.size.unwrap_or(0),
                ctime_ms: entry.ctime_unix_ms,
                mtime_ms: entry.mtime_unix_ms,
            };
            let expected = fill_template(template, &facts, &clock);
            let got = capture.rows.first().and_then(|(_, cells)| cells.first()).cloned().unwrap_or_default();
            if got != expected {
                failures.push(format!("{family} {}: template gives {expected:?}, Obsidian showed {got:?}", row.case));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
```

`rows_of` above is the starting shape — an array of objects with a `path` (or `file`) key and one key per column. Rewrite it to the shape Step 6 recorded, and make the module comment's last paragraph say what that shape was; the rest of the file does not change.

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test bases_replay -- --ignored > target/tmp/t13-replay-1.log 2>&1; echo "exit=$?" >> target/tmp/t13-replay-1.log`. Expected **on the first run**: `exit=101` with a list of differing views — that list is the work of Step 8.

- [ ] **Step 8: Settle every difference**

First give the fixtures the template form (the rule above). In `crates/vault-bases/src/fixtures.rs`, `CaptureRow` gains `pub expect_from: Option<String>` and `pub template: Option<String>` (read in `load_captures` with `field("expect_from")` and `field("template")`), and add:

```rust
/// The row file's own facts a template may name.
pub struct TemplateFacts {
    pub path: String,
    pub size: u64,
    pub ctime_ms: i64,
    pub mtime_ms: i64,
}

/// Fill `{name}`, `{basename}`, `{path}`, `{folder}`, `{size}`,
/// `{ctime:<fmt>}`, `{mtime:<fmt>}` and `{age_ms}` from `facts`.
pub fn fill_template(template: &str, facts: &TemplateFacts, clock: &Clock) -> String {
    let name = facts.path.rsplit('/').next().unwrap_or(&facts.path).to_string();
    let basename = match name.rfind('.') {
        Some(dot) if dot > 0 => name[..dot].to_string(),
        _ => name.clone(),
    };
    let folder = facts.path.rsplit_once('/').map(|(folder, _)| folder.to_string()).unwrap_or_default();
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let close = rest[open..].find('}').map_or(rest.len(), |at| open + at);
        let token = &rest[open + 1..close];
        let date = |ms: i64, format: &str| {
            crate::dates::format_date(crate::DateValue { epoch_ms: ms, has_time: true }, format, clock).unwrap_or_default()
        };
        out.push_str(&match token.split_once(':') {
            Some(("ctime", format)) => date(facts.ctime_ms, format),
            Some(("mtime", format)) => date(facts.mtime_ms, format),
            _ => match token {
                "name" => name.clone(),
                "basename" => basename.clone(),
                "path" => facts.path.clone(),
                "folder" => folder.clone(),
                "size" => facts.size.to_string(),
                "age_ms" => (clock.now_ms - facts.ctime_ms).to_string(),
                other => format!("{{{other}}}"),
            },
        });
        rest = &rest[(close + 1).min(rest.len())..];
    }
    out.push_str(rest);
    out
}
```

and in `check_family`, the expected text becomes `row.template` filled from `Capture.md`'s facts when a template is present:

```rust
                } else if let Some(text) = row
                    .template
                    .as_ref()
                    .map(|template| {
                        fill_template(
                            template,
                            &TemplateFacts {
                                path: "Capture.md".into(),
                                size: 42,
                                ctime_ms: FIXTURE_NOW_MS - 86_400_000,
                                mtime_ms: FIXTURE_NOW_MS - 3_600_000,
                            },
                            &clock,
                        )
                    })
                    .or_else(|| row.text.clone())
                {
```

(replacing the `else if let Some(text) = &row.text {` line and dereferencing `text` as a `String` below it). Then rewrite the seven templated rows of `file.jsonl` to the form, for example `{"family":"file","case":"name","expr":"file.name","kind":"string","expect_from":"corpus","template":"{name}","source":"captured"}`, and run `every_templated_row_agrees_with_its_capture` with the replay.

Then work the differences:

Work the failure list until the replay exits 0, one cause at a time, re-running the replay after each change. Every change lands where the case was named:

- an `uncaptured` row's case (`EvalError::Uncaptured("<case>")` in `coerce.rs`, `functions/*.rs`): replace the `Uncaptured` arm with the captured behaviour, and in that family's `.jsonl` set the row's `kind`/`text` to what was captured and `source` to `captured`;
- `MIXED_TYPE_RANK`: reorder it to the `#sort_mixed` capture and rewrite its doc comment to cite the capture instead of calling itself provisional;
- `filter:error_row`, `sort:default`, `summary:stddev`, `limit:before_group`: make `view/mod.rs` and `view/summary.rs` do what the probe shows, and replace each "(confirmed by capture)" note with the capture's file name;
- `view:case`: if `meta.json`'s `embeds_resolved` shows the lower-case embed resolving, make `Resolver::with_subpath`'s view match case-insensitive and flip `a_subpath_on_a_base_is_a_view`'s third assertion — the only change outside `vault-bases` this step may make;
- `reverse:astral`: implement what the capture shows (code points or UTF-16 units), and add `astral_reverse_matches_the_capture` to `crates/vault-bases/tests/functions_reference.rs` asserting `"a🙂".reverse()` equals the captured string exactly;
- `hyphenated_identifier`: if `#hyphen` shows `99`, the tokenizer joins `-` inside an identifier when no space surrounds it; change `is_ident_continue` accordingly and add the case to `syntax_examples.rs`;
- a `published` row that the capture contradicts: the capture wins (the spec: parity comes from captures); change the code and the row, set `source` to `captured`, and list the contradiction — the published sentence, the captured value — in the task report;
- a cell-text difference with equal values (a date shown differently, a list joined differently): fix `render_text` in `fixtures.rs`, dropping the "Provisional" note on the rule that changed;
- a whole-row difference in a corpus view: find the clause responsible with a smaller probe if needed (add it to `generate`, re-run stages 4 and 7 — the scratch vault is still open), and fix it in the module that owns it.

Every row in every `crates/vault-bases/tests/fixtures/captures/*.jsonl` file whose case was captured ends with `"source":"captured"` — a templated row once `every_templated_row_agrees_with_its_capture` passes for it, a probe-settled row (`folder:root` and the other probe rows) with the probe's answer as its `kind` and `text`; a row that could not be captured (a `this` row skipped by `generate`) keeps `published` and is covered by a corpus view instead.

- [ ] **Step 9: Run everything**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test bases_replay -- --ignored; echo "exit=$?"
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
grep -c '"source":"uncaptured"' crates/vault-bases/tests/fixtures/captures/*.jsonl; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
```

Expected: `exit=0` from the replay and the workspace; the `grep` prints `0` for every file (`exit=1`, no match); clippy, fmt and MSRV `exit=0`.

- [ ] **Step 10: Commit**

```bash
git add crates host/scripts
git commit -F - <<'COMMIT'
test(bases): runtime captures from a scratch copy of a real vault's bases, and parity with them

Every view of the scratch corpus and every function-family row was captured from Obsidian through its CLI against the corpus only, and replays exactly through vaultd's evaluator at the captured instant and zone. Every case that no published rule settled now does what Obsidian does, the provisional mixed-type sort order and cell-text rules are replaced by captured ones, and no fixture row is left uncaptured.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

The scratch corpus itself is never committed (`target/` is ignored); the captures under `crates/vault-server/tests/fixtures/bases-captures/` are, as the spec says. Before `git add`, check that no capture names a path under `Private/`: `grep -rl "Private/" crates/vault-server/tests/fixtures/bases-captures; echo "exit=$?"` must print nothing (`exit=1`).

---
### Task 14: Performance — the harness's `--base` case, the staleness-rule measurement, and the baseline document

The spec's six numbers, measured on the 10,000-note fixture, warm: a filtered, sorted 100-row table under 20 ms p50; the unfiltered whole-vault page under 100 ms p50; a cache hit under 1 ms p50; a `.base` change reconciled within 5 percent of a note change; the per-commit staleness rule under 1 ms with 50 bases; and reconciliation of a vault with no base unchanged within 5 percent of phase 7. Every miss is reported as a miss with its mechanism, never rounded away.

**Files:**

- Modify: `host/scripts/socket-transport-baseline.js` (`--base`, the five Bases cases, `buildVault`'s optional fields)
- Create: `host/fixtures/bases/bench.base` (the committed fixture base)
- Modify: `crates/vault-server/src/views.rs` (an ignored timing test of the rule)
- Create: `docs/performance/bases-evaluation-baseline.md`

**Interfaces:**

- Consumes: `evaluate_base`, `write_file`, `write_note` on the wire; `--bases-cache-entries` (Task 12); `ViewTracker::stale_views` (Task 12).
- Produces: `node host/scripts/socket-transport-baseline.js --base host/fixtures/bases/bench.base …` writing a report whose `cases` gain `base_filtered_ms`, `base_whole_vault_ms`, `base_cache_hit_ms`, `base_change_ms`, `note_change_ms`.

- [ ] **Step 1: The fixture base**

Create `host/fixtures/bases/bench.base`:

```yaml
views:
  - type: table
    name: Filtered
    filters:
      and:
        - file.hasTag("group-3")
        - 'rank < 50'
    order: [file.name, rank, title]
    sort:
      - property: rank
        direction: DESC
  - type: table
    name: Filtered2
    filters:
      and:
        - file.hasTag("group-3")
        - 'rank < 50'
    order: [file.name, rank, title]
    sort:
      - property: rank
        direction: DESC
  - type: table
    name: All
    order: [file.name, title]
  - type: table
    name: All2
    order: [file.name, title]
```

`Filtered` and `Filtered2` are the same view twice, as are `All` and `All2`: the harness alternates between the twins under `--bases-cache-entries 1`, so every measured request evaluates rather than hits, while the page cache stays warm.

- [ ] **Step 2: The harness**

In `host/scripts/socket-transport-baseline.js`:

- `parseArgs` gains `case "--base": out.base = resolve(next()); break;`, and the usage block gains `--base PATH   also measure Bases over this fixture base (copied into the vault as bench.base)`. With `--base`, the default `--vault` becomes `target/tmp/bases-baseline/vault` (a vault built with the Bases fields, never mixed with phase 7's).
- `buildVault(root, count, withBaseFields = false)`: with the flag, each note's frontmatter also carries `rank: ${i % 100}` and its body a `#group-${i % 10}` tag line; the export keeps its two-argument callers working.
- `spawnDaemon` adds `"--bases-cache-entries", "1"` to the arguments when `options.base` is set.
- `measureRun`, after the `write_note` samples and before the connect samples, when `options.base` is set:

```js
    if (options.base) {
      const baseText = readFileSync(options.base);
      await client.request("write_file", { path: "bench.base", content_base64: baseText.toString("base64"), expected: { any: true } });
      written.push("bench.base");
      const timed = async (into, count, request) => {
        for (let at = 0; at < count; at += 1) {
          const started = hrtime.bigint();
          await request(at);
          into.push(ms(started));
        }
      };
      const evaluate = (view) => client.request("evaluate_base", { path: "bench.base", view, limit: 100 });
      for (let at = 0; at < 10; at += 1) await evaluate(at % 2 ? "Filtered" : "Filtered2");
      cases.base_filtered_ms = [];
      await timed(cases.base_filtered_ms, options.samples, (at) => evaluate(at % 2 ? "Filtered" : "Filtered2"));
      cases.base_whole_vault_ms = [];
      await timed(cases.base_whole_vault_ms, Math.min(options.samples, 50), (at) => evaluate(at % 2 ? "All" : "All2"));
      // One view, asked again and again at one generation: every answer after
      // the first is the cached one (capacity 1 holds exactly it).
      await evaluate("Filtered");
      cases.base_cache_hit_ms = [];
      await timed(cases.base_cache_hit_ms, options.samples, () => evaluate("Filtered"));
      // A base change and a note change, alternated so neither runs warmer.
      cases.base_change_ms = [];
      cases.note_change_ms = [];
      const variants = [baseText, Buffer.concat([baseText, Buffer.from("\n")])];
      for (let at = 0; at < options.samples; at += 1) {
        let started = hrtime.bigint();
        await client.request("write_file", { path: "bench.base", content_base64: variants[at % 2].toString("base64"), expected: { any: true } });
        cases.base_change_ms.push(ms(started));
        const path = `${prefix}-change.md`;
        started = hrtime.bigint();
        await client.request("write_note", { path, content: `# Change ${String(at)}\n`, expected: { any: true } });
        cases.note_change_ms.push(ms(started));
        if (at === 0) written.push(path);
      }
    }
```

  with `const cases = { connect_ms: connectMs, get_note_ms: getNoteMs, write_note_ms: writeNoteMs };` declared before this block and returned as `cases` (replacing the literal in the `return`), and `readFileSync` added to the `node:fs` import. The summary printer gains one line per Bases case (`p50` each) when present; `--json` carries them as they are.

Run: `npm --prefix host run lint; echo "exit=$?"`. Expected: `exit=0`.

- [ ] **Step 3: The staleness rule's own measurement**

The rule runs inside the dispatcher, so the harness cannot time it alone; time it where it lives. Append to the test module of `crates/vault-server/src/views.rs` (create `#[cfg(test)] mod tests` if absent):

```rust
    /// The spec's bound: the per-commit rule under 1 ms with 50 bases. Ignored
    /// by default (it builds a vault); run with `--ignored --nocapture` and
    /// read the printed p50.
    #[test]
    #[ignore = "a timing measurement, run by Task 14"]
    fn the_rule_with_fifty_bases_is_under_a_millisecond() {
        let scratch = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
        std::fs::create_dir_all(&scratch).unwrap();
        let vault = tempfile::TempDir::new_in(&scratch).unwrap();
        let index = tempfile::TempDir::new_in(&scratch).unwrap();
        for at in 0..1000 {
            std::fs::write(vault.path().join(format!("N{at:04}.md")), format!("---\nrank: {}\n---\n#g{}\n", at % 100, at % 10)).unwrap();
        }
        for at in 0..50 {
            std::fs::write(
                vault.path().join(format!("B{at:02}.base")),
                format!("views:\n  - type: table\n    name: T\n    filters: 'file.hasTag(\"g{}\")'\n  - type: table\n    name: U\n    filters: 'rank == {}'\n", at % 10, at + 1),
            )
            .unwrap();
        }
        let config = vault_index::IndexConfig::explicit(vault.path(), index.path().join("i.sqlite3")).unwrap();
        let mut service = vault_index::IndexService::open(config).unwrap();
        service.refresh(false).unwrap();
        let reader = service.reader().unwrap();
        let tracker = ViewTracker::default();
        let mut samples = Vec::new();
        for at in 0..200u32 {
            let path = VaultPath::new(format!("N{:04}.md", at % 1000)).unwrap();
            std::fs::write(vault.path().join(path.as_str()), format!("---\nrank: {at}\n---\n#g{}\n", at % 10)).unwrap();
            let report = service.refresh_paths([path].into(), vault_index::ChangeCause::Watcher).unwrap();
            let started = std::time::Instant::now();
            let _ = tracker.stale_views(&reader, &report);
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let p50 = samples[samples.len() / 2];
        println!("staleness rule p50 over 50 bases: {p50:.3} ms");
        assert!(p50 < 1.0, "p50 {p50:.3} ms is over the 1 ms bound");
    }
```

The first sample loads every base's dependencies; the p50 over 200 commits is the steady state the spec bounds.

- [ ] **Step 4: Measure**

Build, then run each measurement backgrounded with a bound and its exit code, one heavy thing at a time:

```bash
cargo build --release --bin vaultd; echo "exit=$?"
npm --prefix host run build; echo "exit=$?"
timeout 2400 node host/scripts/socket-transport-baseline.js --base host/fixtures/bases/bench.base --notes 10000 --samples 200 --repeat 3 --label bases --out target/tmp/t14/bases.json > target/tmp/t14/bases.log 2>&1; echo "exit=$?" >> target/tmp/t14/bases.log
TMPDIR="$PWD/target/tmp" timeout 900 cargo test --release -p vault-server --lib views::tests::the_rule_with_fifty_bases_is_under_a_millisecond -- --ignored --nocapture > target/tmp/t14/rule.log 2>&1; echo "exit=$?" >> target/tmp/t14/rule.log
```

For "unchanged within 5 percent", the comparison binary is phase 7's: build `main` (`b391820`) in a throwaway worktree under `target/tmp` — `git worktree add target/tmp/t14-main b391820` then `cargo build --release --bin vaultd --manifest-path target/tmp/t14-main/Cargo.toml --target-dir target/tmp/t14-main-target` — and run the harness **without** `--base` against both binaries on the same 10,000-note vault, three runs each, alternating:

```bash
timeout 2400 node host/scripts/socket-transport-baseline.js --notes 10000 --samples 200 --repeat 3 --label head --out target/tmp/t14/head.json > target/tmp/t14/head.log 2>&1; echo "exit=$?" >> target/tmp/t14/head.log
timeout 2400 node host/scripts/socket-transport-baseline.js --notes 10000 --samples 200 --repeat 3 --label main --binary target/tmp/t14-main-target/release/vaultd --out target/tmp/t14/main.json > target/tmp/t14/main.log 2>&1; echo "exit=$?" >> target/tmp/t14/main.log
git worktree remove --force target/tmp/t14-main
```

Expected: every log ends `exit=0` (the rule's test exits 101 if its bound is missed — that is a measured miss, recorded, not hidden).

- [ ] **Step 5: The baseline document**

Create `docs/performance/bases-evaluation-baseline.md` with: the machine and load averages each report carries; one table — requirement, bound, measured p50 (median of the three runs' p50s), verdict (`met` or `missed`); for every miss, one paragraph naming the mechanism (where the time goes, from a profile or a stage split, not a guess) and what would close it (approach B, an index the prefilters do not yet use, …); the exact commands of Step 4; and the sentence that a cache hit is measured over the socket, so it includes one round trip. Prose one paragraph per line.

- [ ] **Step 6: Commit**

```bash
git add host/scripts/socket-transport-baseline.js host/fixtures/bases/bench.base crates/vault-server/src/views.rs docs/performance/bases-evaluation-baseline.md
git commit -F - <<'COMMIT'
perf(bases): the baseline harness's --base case and the measured baseline

The socket baseline harness gains a --base case over a committed fixture base on the 10,000-note fixture: a filtered sorted 100-row page and the whole-vault page (evaluated every time, by alternating twin views under a one-entry cache), a cache hit, and a base change against a note change. The per-commit staleness rule is timed where it runs, over 50 bases. The baseline document records every number against its bound, and every miss with its mechanism.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
### Task 15: The HTMX spike's embedded live view — on `spike/htmx-client`, as a smoke test and a demonstration

The spike that found the gap closes it: `![[Views.base#Table]]` in a note now renders as a table the server builds from `evaluate_base`, and it re-renders by itself when the daemon emits `views_invalidated` for that view. The work lands on the spike's own branch, `spike/htmx-client`, never on `feat/bases-evaluation`; the daemon it drives is this branch's release build, copied out of the way first so the branch switch cannot change it.

**Files (on `spike/htmx-client` only):**

- Modify: `spikes/htmx-client/server.js` (the embed placeholder, the `/view` route, the `view` SSE event, the client-side trigger)
- Modify: `spikes/htmx-client/smoke.js` (the embed renders, `/view` renders, and a write re-renders it)

**Interfaces:**

- Consumes: `evaluate_base` (Task 11) with `this_path`, `views_invalidated` (Task 12), `CellDto`'s shape, `SubpathDto::View` in resolutions (Task 8).
- Produces: `GET /view?path=<base>&view=<name>&this=<note>` returning an HTML table fragment; SSE events `event: view` whose data is the view's slug.

- [ ] **Step 1: Build the daemon on this branch and park it**

```bash
cd ~/repos/system/vaultd/.claude/worktrees/live-impl
git status --short; echo "exit=$?"
cargo build --release --bin vaultd; echo "exit=$?"
mkdir -p target/tmp/t15 && cp target/release/vaultd target/tmp/t15/vaultd; echo "exit=$?"
```

Expected: an empty status (a clean tree is required to switch), then `exit=0` three times. `target/` is ignored, so `target/tmp/t15/vaultd` survives the switch unchanged.

- [ ] **Step 2: Switch to the spike branch**

```bash
git switch spike/htmx-client; echo "exit=$?"
npm --prefix host run build; echo "exit=$?"
```

Expected: `Switched to branch 'spike/htmx-client'`, `exit=0` twice. Every step until Step 6 is on this branch.

- [ ] **Step 3: Write the failing smoke checks**

In `spikes/htmx-client/smoke.js`, inside `checkLinks()`, **replace** the existing `if (baseRef.resolution.kind === "resolved") { … } else { … }` block — the one that asserts `${a("/file?path=Views.base", "embed")} <small>#Table</small>` for a resolved embed and the `unresolved` mark otherwise — with the checks below. That old assertion describes the file link the server stops emitting for a `.base` embed in Step 4; left in place, it would fail the smoke after Step 4 and make Step 5 unreachable. The line after it (`/file?path=Views.base serves the YAML`) stays: `/file` still serves the bytes.

```js
    if (baseRef.resolution.kind !== "resolved" || baseRef.resolution.subpath?.kind !== "view") {
      fail(`![[Views.base#Table]] must resolve to the view now: ${JSON.stringify(baseRef.resolution)}`);
    }
    mustHave(html, `hx-get="/view?path=Views.base&amp;view=Table&amp;this=${LINKS}"`, "the embed is a live view placeholder");
    const view = await (await fetch(`${base}/view?path=Views.base&view=Table&this=${encodeURIComponent(LINKS)}`)).text();
    mustHave(view, "<table", "/view renders a table");
    mustHave(view, "Other.md", "/view lists the vault's files");
```

and in `main()`, after the existing SSE write check, a second check that a write re-renders the view:

```js
    // A write that enters the view must make the daemon invalidate it, and
    // the server must forward that as the `view` SSE event the page listens for.
    {
      const ctl2 = new AbortController();
      const events2 = await fetch(`${base}/events`, { signal: ctl2.signal });
      const reader2 = events2.body.getReader();
      const { client, socket } = await openSocketClient(SOCKET);
      const path2 = `Smoke-view-${Date.now()}.md`;
      try {
        await client.request("write_file", { path: BASE, content_base64: Buffer.from(BASE_YAML).toString("base64") });
        await client.request("evaluate_base", { path: BASE, view: "Table" });
        await client.request("write_note", { path: path2, content: "# In the view\n", expected: { absent: true } });
        const decoder = new TextDecoder();
        let seen = "";
        const deadline = Date.now() + 15_000;
        while (!seen.includes("event: view") || !seen.includes("Views.base#Table")) {
          if (Date.now() > deadline) fail(`no view event within 15 s; saw ${seen.slice(0, 300)}`);
          const { value, done } = await reader2.read();
          if (done) fail("SSE stream ended");
          seen += decoder.decode(value);
        }
        console.log("ok /events delivered views_invalidated for Views.base#Table");
        const again = await (await fetch(`${base}/view?path=Views.base&view=Table&this=${encodeURIComponent(LINKS)}&limit=1000`)).text();
        mustHave(again, `generation `, "/view re-renders at the new generation");
      } finally {
        await client.request("delete_note", { path: path2, mode: "permanent" }).catch((e) => console.error(`cleanup: ${e.message}`));
        client.close();
        socket.destroy();
        ctl2.abort();
      }
    }
```

Run: `node spikes/htmx-client/smoke.js --binary target/tmp/t15/vaultd; echo "exit=$?"`

Expected: `smoke: FAIL … the embed is a live view placeholder`, `exit=1`.

- [ ] **Step 4: The server**

In `spikes/htmx-client/server.js`:

- a slug for a view, shared by the placeholder and the event: `const viewSlug = (path, view) => \`${path}#${view}\`;`
- in `renderRef`, before the generic non-note branch inside `r.kind === "resolved"`:

```js
    if (isEmbed(ref) && r.target.endsWith(".base")) {
      const view = r.subpath?.kind === "view" ? r.subpath.value : "";
      const url = `/view?path=${q(r.target)}&view=${q(view)}&this=${q(currentNote)}`;
      const slug = viewSlug(r.target, view);
      return `<div class="view" hx-get="${esc(url)}" hx-trigger="load, refresh-view from:body[detail.slug=='${esc(slug)}']">loading ${esc(slug)}…</div>`;
    }
```

  where `currentNote` is the note being rendered: give `renderRef` a third parameter `currentNote`, and pass `note.path` from `renderBody`'s call site;
- a cell renderer and the `/view` page:

```js
function cellText(cell) {
  switch (cell.kind) {
    case "null": return "";
    case "string": case "image": case "icon": case "html": return String(cell.value);
    case "number": case "boolean": return String(cell.value);
    case "date": return cell.has_time ? cell.value.replace("T", " ").slice(0, 16) : cell.value;
    case "duration": return `${cell.value} ms`;
    case "list": return cell.value.map(cellText).join(", ");
    case "object": return cell.value.map((e) => `${e.key}: ${cellText(e.value)}`).join(", ");
    case "link": return cell.display ? cellText(cell.display) : cell.target;
    case "file": return cell.path;
    case "error": return `⚠ ${cell.message}`;
    default: return `(${cell.kind})`;
  }
}

async function pageView(client, path, view, thisPath, limit) {
  const answer = await client.request("evaluate_base", {
    path, view: view || null, this_path: thisPath || null, limit: Math.min(Number(limit) || 100, 1000),
  });
  const head = answer.columns.map((c) => `<th>${esc(c.display_name ?? c.property)}</th>`).join("");
  const body = answer.rows.map((row) => {
    const cells = row.cells.map((cell) => `<td${cell.kind === "error" ? ' class="unresolved"' : ""}>${esc(cellText(cell))}</td>`).join("");
    const group = row.group ? `<td><small>${esc(cellText(row.group))}</small></td>` : "";
    return `<tr><td>${noteLink(row.path)}</td>${group}${cells}</tr>`;
  }).join("");
  const sums = Object.entries(answer.summaries).map(([name, value]) => `<li>${esc(name)}: ${esc(cellText(value))}</li>`).join("");
  return `<div><b>${esc(answer.view.name)}</b> <small>${esc(answer.view.type)} · generation ${answer.generation} · ${answer.total_rows} rows</small>` +
    `<table><tr><th>file</th>${head}</tr>${body}</table>${sums ? `<ul>${sums}</ul>` : ""}</div>`;
}
```

- the route, in `makeServer`'s `switch`: `case "/view": return send(200, await pageView(client, url.searchParams.get("path") ?? "", url.searchParams.get("view") ?? "", url.searchParams.get("this") ?? "", url.searchParams.get("limit")));`
- the event, at the top of `broadcast`:

```js
  if (event.type === "views_invalidated") {
    const slug = viewSlug(event.value.base, event.value.view);
    for (const res of feed) res.write(`event: view\ndata: ${slug}\n\n`);
    return;
  }
```

- the page side, in `SHELL` before `</body>`:

```html
<script>
// One EventSource for the view events; each one re-fires the placeholder
// whose slug it names, which re-requests /view.
new EventSource("/events").addEventListener("view", (e) => htmx.trigger(document.body, "refresh-view", { slug: e.data }));
</script>
```

`hx-trigger="… from:body[detail.slug=='…']"` is htmx's event filter on the triggering event's detail; it is what keeps one view's event from re-rendering every view on the page.

- [ ] **Step 5: Run the smoke and see it pass, then commit on the spike branch**

```bash
node spikes/htmx-client/smoke.js --binary target/tmp/t15/vaultd; echo "exit=$?"
npm --prefix host run lint; echo "exit=$?"
```

Expected: `ok the embed is a live view placeholder`, `ok /view renders a table`, `ok /events delivered views_invalidated for Views.base#Table`, `smoke: pass`, `exit=0`; lint `exit=0` (the spike lives outside `host/scripts`, so lint covers nothing new; run it anyway as the branch's own gate).

```bash
git add spikes/htmx-client/server.js spikes/htmx-client/smoke.js
git commit -F - <<'COMMIT'
spike(htmx): embedded Bases views that re-render on views_invalidated

![[X.base#View]] now resolves to the view, so the spike renders it as a placeholder that loads /view, a table built from evaluate_base's typed cells with groups and summaries. The daemon's views_invalidated event is forwarded as an SSE view event, and the placeholder for exactly that view re-requests itself. The smoke test pins the placeholder, the table, and the event after a write.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

- [ ] **Step 6: Switch back**

```bash
git switch feat/bases-evaluation; echo "exit=$?"
git status --short --branch; echo "exit=$?"
```

Expected: back on `feat/bases-evaluation`, clean, `exit=0` twice. This task's commit is on `spike/htmx-client`; `feat/bases-evaluation` gains no commit from it, and the controller's ledger records the spike commit's hash.

---
### Task 16: Documentation — `docs/protocol.md`, `README.md`, `VAULTD-COMPATIBILITY.md`, the semantic read-path line, and the `tests/docs.rs` pins

What shipped, written where its users look: the two operations, the event, the cell model, the resolver's base targets and the `view` subpath, the staleness rule with its false positives, the new error codes, the new unknown-variant tolerances, and what parity means for Bases. Every JSON example in `docs/protocol.md` is machine-checked against the real types by `tests/protocol_doc_examples.rs`, so each one below is written to deserialize.

**Files:**

- Modify: `docs/protocol.md`, `docs/design/semantic-read-path.md`, `README.md`, `VAULTD-COMPATIBILITY.md`
- Modify: `crates/vault-server/tests/docs.rs`

**Interfaces:**

- Consumes: every wire name from Tasks 8, 11 and 12; the measured numbers and misses from Task 14; the captured facts and contradictions from Task 13's report.
- Produces: documentation only, and the pins that keep it.

- [ ] **Step 1: Write the failing pins**

Append to `crates/vault-server/tests/docs.rs`:

```rust
#[test]
fn bases_evaluation_is_documented_where_its_users_look() {
    assert_document_contains(
        "docs/protocol.md",
        &[
            "### `evaluate_base`",
            "### `list_bases`",
            "### `views_invalidated`",
            "## Bases",
            "The cell model",
            "False positives are accepted; false negatives are a defect",
            "`{\"kind\":\"view\",\"value\":\"Table\"}`",
            "a subpath's `kind`",
        ],
    );
    assert_document_contains("README.md", &["evaluate_base", "`.base`"]);
    assert_document_contains("VAULTD-COMPATIBILITY.md", &["Bases parity", "captured", "uncaptured"]);
    assert_document_contains("docs/design/semantic-read-path.md", &["Bases evaluation landed in phase 8"]);
    assert_document_contains("docs/performance/bases-evaluation-baseline.md", &["20 ms", "100 ms", "1 ms", "5 percent"]);
}

#[test]
fn every_bases_error_code_is_documented_exactly_once() {
    let document = read_document("docs/protocol.md");
    let errors = document.split_once("\n## Errors\n").expect("an Errors section").1;
    let errors = match errors.split_once("\n## ") {
        Some((section, _)) => section,
        None => errors,
    };
    for code in ["base_invalid", "view_not_found", "expression_invalid", "unsupported_function"] {
        let definitions = errors.lines().filter(|line| line.starts_with(&format!("- `{code}`"))).count();
        assert_eq!(definitions, 1, "`{code}` is defined {definitions} times");
    }
}
```

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test docs; echo "exit=$?"`. Expected: the two new tests fail naming the first missing phrase, `exit=101`.

- [ ] **Step 2: `docs/protocol.md`**

Make these edits, prose one paragraph per line:

1. Under **Operations**, after `### unsubscribe`, add `### evaluate_base` and `### list_bases`:

````markdown
### `evaluate_base`

Evaluates one view of a `.base` file at the current generation and answers its rows. `path` names the base; `view` names a view (absent means the first declared view, as Obsidian opens a base); `this_path` names the note that embeds the base (absent means the base itself — what `this` is); `cursor` and `limit` page the rows like every collection operation. The answer carries the `generation`, the `view` as declared (`type`, `name`, and every other key in `options`), the `columns` (the view's `order`, each with the `display_name` and the settings its `properties` entry declares), the page of `rows` (each a `path`, a `kind` of `note` or `file`, a `group` cell when the view groups, and one cell per column), the `summaries` (an object from name to typed value — the name is the key the view's own `summaries` map declares it under, so `summaries: {price: Average}` answers `"price": <cell>`), `total_rows`, and `next_cursor`. The daemon renders nothing: a client turns cells into a table, cards, a list or a board. Every view type — `table`, `cards`, `list`, `kanban`, `map`, and a plugin's own — evaluates to the same row data; an unknown type is passed through as declared.

```json
{"version":1,"id":"b","request":{"method":"evaluate_base","params":{"path":"Books.base","view":"Table","this_path":"Home.md","limit":2}}}
```

```json
{"version":1,"id":"b","outcome":{"status":"ok","value":{"type":"evaluate_base","value":{"generation":7,"view":{"type":"table","name":"Table","options":{}},"columns":[{"property":"file.name","display_name":null,"settings":{}},{"property":"price","display_name":"Price","settings":{}}],"rows":[{"path":"Books/Ulysses.md","kind":"note","cells":[{"kind":"string","value":"Ulysses.md"},{"kind":"number","value":30}]},{"path":"Books/Dune.md","kind":"note","cells":[{"kind":"string","value":"Dune.md"},{"kind":"number","value":10}]}],"summaries":{"price":{"kind":"number","value":14.333333333333334}},"total_rows":3,"next_cursor":"eyJnZW5lcmF0aW9uIjo3fQ"}}}}
```

A result is computed once per (base, view, `this_path`, generation) and its pages are cut from that one computation, so `now()` and `random()` cannot move between pages. The computation is cached in a bounded LRU (`--bases-cache-entries`, default 64); every entry of an older generation is dropped on the first request at a newer one. A cursor binds the generation, the base, the view, `this_path` and the row position: a cursor for another view is `invalid_cursor`, and a cursor from an older generation is `generation_mismatch` with `current_generation`. An evaluation runs on the requesting connection's dispatcher and takes no lease: a long one delays that connection's next request, never another connection and never reconciliation.

### `list_bases`

Pages every `.base` file the index holds, in path order, with its declared view names and its parse status.

```json
{"version":1,"id":"l","outcome":{"status":"ok","value":{"type":"list_bases","value":{"generation":7,"items":[{"path":"Books.base","status":{"state":"parsed"},"views":["Table","Cards"]},{"path":"Broken.base","status":{"state":"parse_failed","message":"base failed to parse: did not find expected ',' or ']'","span":{"start":7,"end":7}},"views":[]}],"next_cursor":null}}}}
```
````

2. A new top-level section `## Bases`, after **Snapshot sessions** and before **Transports**, holding: how a `.base` is indexed (reconciled in the same generation as notes, on both routes; a base that does not parse is still indexed, still resolves, lists with `parse_failed`, and has a `malformed_base` diagnostic under its path in `get_diagnostics`); **base targets and the view subpath** — a link whose target reaches a `.base` resolves to it, and a subpath on a base is a view name matched exactly (`![[Books.base#Table]]` resolves with subpath `{"kind":"view","value":"Table"}`; an undeclared view is `missing_subpath` with a `missing_view` diagnostic; a block subpath on a base is `missing_subpath`); a reference keeps its parsed subpath as `heading` — only the *resolution* names a view; **The cell model** — the fourteen cell kinds plus `unknown` (the client-side catch-all the server never emits), exactly as Task 11 defines them, one line each, including the ISO date form, durations as milliseconds plus calendar months, whole numbers as integers, and `{"kind":"error","message":…}` for a cell whose expression failed on that row (its row stays); **property types** — read from the vault's `.obsidian/types.json` on each evaluation; **the language** — the whole published reference, with the evaluation order (prefilters, filters, formulas, sort, limit, groupBy, summaries) and the rule that where neither a published page nor a runtime capture fixes a behaviour the answer is an error naming the case.

3. Under **Events**, after `### config_changed`, add:

````markdown
### `views_invalidated`

A view may have changed at `generation`; re-ask `evaluate_base` for it. One event per view (whatever embeddings a client holds), emitted right after the `generation_committed` it follows, through the same per-subscription queue and bounds as every event. The rule is coarse and cheap enough to run on every commit: a view is stale when its base changed; when a changed path is among the rows it last answered; when a changed path passes all its prefilters (a view with none passes every path); when it reads formulas, links, backlinks or `this` and any note changed; and a note whose references re-resolved differently counts as changed. False positives are accepted; false negatives are a defect. A `resync_required` carries no change set, so no `views_invalidated` accompanies it — a client re-reads everything then, views included.

```json
{"version":1,"subscription_id":"sub-1","event":{"type":"views_invalidated","value":{"base":"Books.base","view":"Table","generation":8}}}
```
````

4. Under **Errors**, after the `too_many_snapshots` bullet, add (each exactly once):

```markdown
Bases evaluation adds four, each naming what it refused:

- `base_invalid` — the base does not parse; the message carries the YAML position.
- `view_not_found` — the base declares no view by that name; the message lists the declared views.
- `expression_invalid` — an expression the view reads does not parse; the message names the expression and the position.
- `unsupported_function` — an expression the view reads calls a function or method this build does not implement; the message names it.
```

   and one sentence after them: a `base_invalid`-shaped failure of one row's cell is not an error at all — it is an error cell.

5. The `resolve_link` section gains one sentence and the view example: `Views.base#Table` resolves to `{"kind":"resolved","target":"Views.base","subpath":{"kind":"view","value":"Table"}}`.

6. In **Evolution**, the unknown-variant list ("an unrecognized value of an event's `type`, …") gains `a subpath's \`kind\``, `a cell's \`kind\``, `a row's \`kind\``, and `a base's status \`state\``.

7. In **Reserved operation families**, nothing changes (`query` stays reserved; `evaluate_base` is not it).

- [ ] **Step 3: The other three documents**

- `README.md`: under **Current milestone**, a new first subsection `### On the branch \`feat/bases-evaluation\`: Bases evaluation` — two paragraphs: what the daemon does with a `.base` (indexes it, resolves links to it and to its views, answers `evaluate_base` and `list_bases`, emits `views_invalidated`), and where the details are (`docs/protocol.md` **Bases**, `docs/design/bases-evaluation.md`, `docs/performance/bases-evaluation-baseline.md`), plus the `--bases-cache-entries` flag in the flag list.
- `docs/design/semantic-read-path.md`: in the non-goals line that defers "Bases evaluation" (line 32) leave the sentence as the record of that phase, and add one line at the end of **Deferred follow-on**: "Bases evaluation landed in phase 8; see `docs/design/bases-evaluation.md`."
- `VAULTD-COMPATIBILITY.md`: a section `## Bases parity` after **Tier 1**: parity means the rows and the cell text Obsidian shows for a real vault's bases, captured from a scratch copy by the `obsidian` CLI (Task 13); which behaviours are fixed by the published pages, which by captures (the list Task 13's report produced, including every published sentence a capture contradicted), and that the provisional rules are gone; the documented limits (no rendering; Map geodata; `fileclass-table` semantics; `random()` per evaluation; property types read from `.obsidian/types.json`; regular expressions limited to what the `regex` crate expresses, refused by name otherwise); and that no case is left uncaptured, or, if Task 13 left any, each one named.

- [ ] **Step 4: Run the pins and the example check**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test docs --test protocol_doc_examples; echo "exit=$?"
```

Expected: every test passes, `exit=0`. A failing example names its block; fix the example, never the test.

- [ ] **Step 5: The final gates — the whole branch**

```bash
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
npm --prefix host run lint; echo "exit=$?"
npm --prefix host run typecheck; echo "exit=$?"
git diff --stat main -- host/packages/host/src; echo "exit=$?"
```

Expected: `exit=0` from all seven, and the last command prints nothing — this phase changed nothing under `host/packages/host/src`.

- [ ] **Step 6: Commit**

```bash
git add docs README.md VAULTD-COMPATIBILITY.md crates/vault-server/tests/docs.rs
git commit -F - <<'COMMIT'
docs: Bases evaluation in the protocol, the README and the compatibility contract

docs/protocol.md documents evaluate_base and list_bases with checked examples, a Bases section with base targets, the view subpath and the cell model, the views_invalidated event with its staleness rule and its accepted false positives, the four new error codes, and the four new unknown-variant tolerances. The README says what the daemon does with a .base; the compatibility contract says what parity means for Bases and what was captured; the semantic read-path design notes that Bases evaluation landed here. tests/docs.rs pins the contract phrases.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT
```

---
## Coverage

Every section of `docs/design/bases-evaluation.md`, and the task that implements it.

| Spec section | Requirement | Task |
| --- | --- | --- |
| Goals 1 | Parse every `.base` into an indexed record with views and diagnostics; re-parse in the same generation | 1 (file model), 9 (table), 10 (reconciliation) |
| Goals 2 | The whole published language: every type, operator and function, `this`, formulas, summaries, view declarations | 2 (syntax), 3–6 (functions, by family), 7 (views, summaries) |
| Goals 3 | `evaluate_base`, `list_bases`, `views_invalidated`, additive | 11, 12 |
| Goals 4 | Links to `.base` resolve; `![[X.base#View]]`; `missing_subpath` | 8 (resolver), 10 (index feeds it) |
| Goals 5 | Parity on a real vault's bases by runtime captures on a scratch vault | 13 |
| Goals 6 | The four performance numbers | 14 |
| Non-goals | Rendering, editing, approach B, `fileclass-table` semantics, Map geodata, `random()` determinism, search | none by construction; `fileclass-table` passes through (1, 7), `random()` seeded per evaluation (3) |
| Architecture — the `vault-bases` crate: file model | `BaseFile` with filters, formulas, properties, summaries, views with every key kept; unknown view type kept; `saphyr` with char-to-byte | 1 |
| Architecture — the `vault-bases` crate: expression language | Tokenizer, Pratt parser, every reference form, the operators | 2 |
| Architecture — the `vault-bases` crate: expression language | The typed value model (13 kinds plus render-only) | 1 (types), 3–6 (behaviour) |
| Architecture — the `vault-bases` crate: expression language | Every function: global, `any`, `date`, `string`, `number`, `list`, `link`, `file`, `object`, `regexp`, date and list fields | 3 (global non-date/file, any), 4 (string, number, list, object, regexp), 5 (date), 6 (link, file) |
| Architecture — the `vault-bases` crate: expression language | Coercion, equality, mixed-type sort, truthiness, `format()` (Moment) with `unsupported_format_token`, `relative()` — from captures, else a typed diagnostic | 3 (published rules, `Uncaptured` cases), 5 (format, relative), 13 (captures settle) |
| Architecture — the `vault-bases` crate: row source | A trait; in-memory source for tests | 3 (trait, `MemorySource`), 11 (the daemon's) |
| Architecture — the base as an indexed file | `bases` table; reconciler on create, change, remove, same generation; `.base` beside `.md`; live graph holds `BaseFile` | 9 (DDL), 10 |
| Architecture — the base as an indexed file | Resolver non-note targets; `SubpathDto` `view`; `missing_subpath` | 8 |
| Architecture — rows and prefilters | Candidates are every file; prefilters from the top of the tree (`inFolder`, `hasTag`, `ext`, scalar equality) | 7 (extraction), 11 (served by the index) |
| Architecture — rows and prefilters | `property_scalars` maintained beside `properties` | 9 |
| Architecture — rows and prefilters | Evaluation order: prefilters, filters, formulas memoized, sort stable, groupBy, limit, summaries | 7 |
| Architecture — the operations | `evaluate_base` params and answer; the cell model; the cursor; `generation_mismatch` | 11 |
| Architecture — the operations | `list_bases` | 11 |
| Architecture — the operations | Requests on the dispatcher, no lease, block only their connection | 11 (by construction: `Server::handle`), 16 (documented) |
| Architecture — freshness | Per-key LRU, default 64, knob; dropped when the generation advances | 11 (per-generation store), 12 (bound, knob) |
| Architecture — freshness | The coarse staleness rule per commit; one event per stale view; same registry and bounds; never blocks the coordinator | 12 |
| Architecture — `this` | Embedding note or the base; `this.file`; cache key includes `this_path` | 3, 6, 11 |
| Error handling | `parse_failed` with position; `base_invalid`; `list_bases` shows it; `get_diagnostics` | 1, 10, 11 |
| Error handling | `view_not_found` naming the views | 7, 11 |
| Error handling | `expression_invalid` with expression and position; `unsupported_function` naming it | 7, 11 |
| Error handling | A per-row failure is an error cell; the row stays | 3, 7 |
| Error handling | `this_path` not a note: `invalid_request` | 11 |
| Error handling | `limit` 0 or over 1000: `invalid_cursor` | 11 |
| Error handling | Health-only: `index_unavailable` | 11 |
| Performance requirements | 20 ms, 100 ms, 1 ms, within 5 percent, rule under 1 ms with 50 bases, no-base reconciliation within 5 percent; misses with mechanism | 14 |
| Testing — parity corpus | Copy script listing what it copied; the maintainer opens once; capture per view; committed captures; suite diffs rows and cell text; live vault read only by the copy script | 13 |
| Testing — function captures | One capture per family on edge inputs | 3–6 (rows), 13 (captured) |
| Testing — unit tests | Every published example parses; every function; coercion and comparison tables; sort; `groupBy`; `limit`; summaries | 2, 3–6, 7 |
| Testing — property tests | Comparison antisymmetric and transitive; `sort` stable; `list` round-trips | 7 (`ordering_properties.rs`) |
| Testing — index tests | Create, change, delete move the generation and `bases`; diagnostics appear and clear; `property_scalars` matches `properties` after every mutation | 9 (scalars, the oracle's claim 6), 10 |
| Testing — resolver tests | `[[X.base]]`, `![[X.base#View]]`, a missing view, a renamed base | 8, 10 |
| Testing — protocol tests | Both operations and the event in the conformance set over both transports; paging; `generation_mismatch`; every error code | 11, 12 |
| Testing — freshness tests | Enter, leave, reorder fire exactly for that view; unrelated change fires nothing; cache hits at one generation, misses at the next | 12 |
| Testing — client | The HTMX spike's embedded view re-renders on `views_invalidated`, on its own branch | 15 |
| Testing — gates | Exit codes; MSRV 1.85; clippy; `TMPDIR`; nothing at the live vault | Global Constraints, every task |
| Documentation | `docs/protocol.md`; the semantic read-path line; `README.md`; `docs/performance/bases-evaluation-baseline.md`; `VAULTD-COMPATIBILITY.md` | 16 (and 14 for the baseline) |
| Rulings 1–5 | Daemon, whole language, approach C, the sections, the standing rules | the architecture of 1–12; 13 (captures, never `app.asar`); Global Constraints |
| Deferred follow-on | Approach B, `fileclass-table` adapter, Map, search, a client renderer package, Bases over snapshots | named in 16's documentation, not implemented |

Every function on the published reference appears in exactly one task's checklist: global `if`, `list`, `number`, `max`, `min`, `random`, `escapeHTML`, `html`, `icon`, `image` (3); `date`, `duration`, `now`, `today` (5); `link`, `file` (6); any `isTruthy`, `isType`, `toString` (3); date fields and `date`, `format`, `time`, `relative`, `isEmpty` (5); string `length` and fourteen methods (4); number six methods (4); list `length`, thirteen methods and `mean` (4); link `asFile`, `linksTo` (6); file eleven fields plus `backlinks`, `embeds`, `file`, and five methods (6); object three methods (4); regexp `matches` (4). `isEmpty` is listed once per receiver type because the reference lists it once per type.

## Self-review

**1. Spec coverage.** The table above walks every section and bullet of the spec. Three spec points were ruled by the controller on the consistency review and are implemented as ruled: `summaries` on the wire is an object from name (the view's `summaries` key) to typed value; a duration keeps `months` because the published duration-unit table lists months; an object cell is an ordered `{key, value}` entry list, as the protocol's property DTO already represents mappings, recorded in the spec as a fact correction in the same commit. A filter statement that errors is three-valued *unknown* (Task 7), so an error inside `not` excludes the row like an error anywhere else, provisional until `filter:error_row` is captured. Three spec statements needed a choice the spec does not make, and each is a ruling named in the plan report rather than decided silently: property types are read from `.obsidian/types.json` (the spec never names where types come from); the copy script excludes a guarded private folder (the spec counts the maintainer's bases, and the vault policy forbids moving that material out of its area); and the staleness rule gains two conservative clauses (`this`, and notes whose references re-resolved) so its documented approximation has no false negative; both clauses and the `reresolved` computation have their own tests (Task 12), and the rule runs on every committed generation and reloads its base catalog after any gap, so a base created while no client listened is still tracked.

**2. Placeholder scan.** No `TBD`, `TODO`, "implement later", "add error handling", "add validation", "handle edge cases", "write tests for the above", or "similar to Task N". Task 13's stage 5 cannot carry the code it will write — the captures decide it — so it names, for every uncaptured case and provisional rule, the exact function to change, the fixture row to flip, and the probe that settles it; that is the capture-driven table the spec asks for, not an unwritten step.

**3. Type consistency.** Checked against the Shared names table: `parse_base` and `BaseFile` (1, 10, 11); `Expr` with `position` on `Call` and `Method` (2, 7); `RowSource`'s nine methods and `Prefilter`/`ScalarLiteral` defined in Task 3's `source.rs`, extracted in 7, served in 11, matched in 12; `EvalContext::new` with four arguments and `with_formulas` (3), `reborrow` (7); `typed_property` widened from three to four parameters in 6, and every later caller uses four; `Cell = Result<Value, EvalError>` (7, 11); `ResolutionNote.views` (8, 10); `BaseRecord`/`BaseDelta`/`BaseReplacement` (10, 11, 12); `BaseQuery` with `types` (11, 13); `evaluate_base` in `vault-server` is `(reader, cache, types, params)` in 11 and `(reader, cache, tracker, types, params)` from 12, with its one caller updated in 12; `list_bases(reader, params)` (11); `capture_vault(props)` (6, 13); `summaries` is `BTreeMap<String, CellDto>` everywhere it is built or read (11, 15, 16) and no `SummaryDto` remains; `LiveRefreshReport.reresolved` and `BatchOutcome.reresolved` added in 12, consumed by the rule and pinned by `tests/reresolved.rs`; `fill_template`/`TemplateFacts` (13, used by `check_family` and the replay); `scratch_root`/`scratch` in every new test that makes a directory; `IndexService::publish_delta`'s new last parameter `bases` (10) passed by its one production caller and every test caller; `DEFAULT_BASE_CACHE_ENTRIES` (11, 12, 14).

**4. Review Focus.** Each of the five lines has its test in its owning task: the superset property (7 and 11), the YAML-but-not-a-base shapes (1), the formula cycle (7), Unicode positions and view names (4, 8), and the vault changing under a view (11, 12).

## Execution handoff

Plan complete and saved to `docs/plans/bases-evaluation-implementation.md`. Subagent-driven is the method the controller already runs: a fresh implementer per task, an independent reviewer with a diff package, fix rounds resumed on the implementer. Tasks 1 to 7 are the pure crate and run in order; 8 is `vault-core` and the wire spelling; 9 and 10 are the index and run in order; 11 and 12 are the server; 13 has two human stops (the maintainer copies, the maintainer opens the scratch vault) and blocks until both are done; 14 needs a release build and a quiet machine; 15 runs on `spike/htmx-client` and switches back; 16 is documentation and depends on everything, including Task 13's list of captured facts.
