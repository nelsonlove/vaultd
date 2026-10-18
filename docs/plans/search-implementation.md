# vaultd Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `vaultd` to answer Obsidian's core Search: a `search` request that takes a query in Obsidian's syntax and answers the matching files with match spans in Obsidian-compatible positions, paged and cached per generation; first an MVP for the next demo, then the parity operators, then a parity harness that compares `vaultd`'s answers with a running Obsidian's on one generated vault.

**Architecture:** A new pure crate, `vault-search`, owns the query grammar (a scannerless recursive-descent parser into a `Query` tree), the matcher (`Needle`, JavaScript-style case folding, byte spans into the original text, UTF-16 `Loc`s), the compiler (`CompiledQuery`, feature checks, `needs()`), the evaluator over a `SearchDocument` trait, and the sort; it does no I/O. `vault-index` gains `IndexReader::search`, an exact scan of `notes.source_bytes` (plus tree, tags, and later structure and properties) on the pinned evaluation read that Bases evaluation built, with a metadata prefilter over the tree and tag rows for positive metadata conjuncts. `vault-server` adds the `search` operation, its per-generation LRU, the cursor, and two error codes, all additive to protocol version 1. The host's `global-search` gets a real instance. No new index and no schema change in this phase: canvas content is out of this phase (design Ruling 4, issue #3).

**Tech Stack:** Rust 2024 edition, MSRV 1.85; `regex` 1.x (already in the workspace) through `vault-bases`' JavaScript-regex compiler; `vault_bases::collate` for the File name sort; `rusqlite` bundled SQLite 3.46.0; `proptest` for the round-trip, fast-path and narrowing properties. Host side: Node ≥ 24, TypeScript in `host/packages/host/src` (Task 7 only) and scripts under `host/scripts`, driving the `obsidian` CLI (`search`, `search:context`, `eval`, `vault`) against a generated vault.

**Spec:** [vaultd Search Design](../design/search.md) — its trailing **Rulings** section wins over its body; its former **Open questions** are all ruled (Ruling 4: no canvas search in this phase, issue #3; Ruling 5: live search subscriptions later, issue #1; Ruling 6: the real-vault capture run later, issue #2). Predecessor plan, for house style: [vaultd Bases Evaluation Implementation Plan](bases-evaluation-implementation.md). Wire authority: [docs/protocol.md](../protocol.md). The published search reference, transcribed into Task 1's checklist: `https://obsidian.md/help/plugins/search` (raw Markdown at `https://publish-01.obsidian.md/access/f786db9fac45774fa4f0d8112e232d67/Plugins/Search.md`, fetched 2026-10-17).

## Global Constraints

- Rust MSRV 1.85 (gate: `rustup run 1.85.0 cargo check --workspace`); **never let-chains** (`if let … && …`) — nest the `if let` instead; `cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo fmt --all -- --check` clean.
- Rust tests run under `TMPDIR="$PWD/target/tmp"`: `TMPDIR="$PWD/target/tmp" cargo test -p <crate> …`. **Never `std::env::temp_dir()` in any test.** `tempfile::TempDir::new()` reads `TMPDIR`, so the prefix is the whole mechanism.
- Host: Node ≥ 24; `npm --prefix host run lint` covers `host/scripts`; vitest only through `npm --prefix host test -- <files>`, never two at once; **nothing under `host/packages/host/src` changes in this phase except in Task 7**, which owns `shim/internal-plugins.ts`, the new `shim/global-search.ts`, `server/ops.ts`, `server/server.ts`, `client/protocol.ts`, `host.ts`, `testing/assemble.ts` and `testing/host-harness.ts`.
- **Never point any process, test, fixture or path at the owner's real vault**, except the one corpus-copy mode of the parity script (Task 19 Step 4, deferred to issue #2 by design Ruling 6), run by hand by the vault's owner, which reads Markdown and canvas files and writes them under `target/tmp/search-corpus/`; the daemon, the tests and the captures use only that copy. Never benchmark against a real vault, and never commit a real vault's path, file name, note text or capture.
- Parity comes from runtime captures (the `obsidian` CLI driving a generated vault the maintainer opened) and the published help page, never from `app.asar`; where a capture is missing, the behaviour is a named provisional rule (`P1` to `P18` of the design), never an invention, and each one is listed in `VAULTD-COMPATIBILITY.md` until Task 20 settles it.
- **Every gate reports its PROCESS EXIT CODE**; a suite that prints passed while exiting 1 is red. Every run command below ends with `; echo "exit=$?"` and the expected line names the code.
- The protocol changes only additively: one operation (`search`), two error codes (`query_invalid`, `unsupported_operator`), one optional error field (`position`), one host event (`host.search_opened`) and two host operations (`host.search`, `host.search_state`); no envelope or existing-operation change; unknown-variant tolerance as documented (each new enum a client decodes carries an `Unknown` catch-all, and the Evolution paragraph of `docs/protocol.md` names them).
- One commit per task on `feat/search`, except Tasks 8 and 17, which commit on the spike branch `spike/htmx-client-clean` (never `spike/htmx-client`, an older branch that is not its ancestor). Every commit message ends with exactly the one trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and carries **no** `Claude-Session:` line: the repository's pre-push guard refuses a commit that has one. **Never push, never merge.** In particular `feat/search` is never merged into the spike branch: the spike runs against a `vaultd` built from `feat/search` (Task 8 Step 1).
- Prose in this plan and in every document it writes is one paragraph per line, never hard-wrapped; Rust doc comments follow the crate's wrapped style.
- Gate before every Rust commit: the touched crates' tests, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`, each with its exit code. Gate before every host commit: `npm --prefix host run lint` and `npm --prefix host run typecheck`.
- No agent and no script started by this plan reads anything under the guarded private folder of the vault (the folder `VAULTD_CORPUS_GUARDED` names); the corpus-copy mode excludes that subtree unconditionally and refuses to run without it (Task 19).

## Review Focus

1. **A narrowing that drops a file the full query would keep.** `IndexReader::search` narrows candidates with a metadata prefilter over the tree and tag rows (and the property rows from Task 13) for positive `file:`, `path:`, `tag:` and property-presence conjuncts before any text is read; a narrowing that is not a superset (a case fold the prefilter does differently, a tag descendant, a nested `OR`, a conjunct under a `Not`) silently loses files. Expected: every narrowing selects a superset of the files its conjunct accepts, and the conjunct still runs per file. Pinned by `narrowing_never_drops_a_file_the_query_keeps` (Task 4, a property test over a real index against an unnarrowed scan).
2. **Spans that are not on the original text.** Case folding can change byte length (`İ` lowercases to two characters, the Kelvin sign to `k`); a span computed in the folded copy and reported as-is points into the wrong bytes or splits a character. Expected: every span is a pair of character boundaries of the original source, and slicing the source at it yields text that folds to the needle. Pinned by `spans_are_char_boundaries_of_the_original_and_fold_to_the_needle` (Task 2, property test) and `fast_path_equals_reference` (Task 2).
3. **A query misread instead of refused.** A parity operator in the MVP (`line:(a b)`), an unbalanced parenthesis, a dangling `-`, or `OR` at the start must never be searched as plain text. Expected: `unsupported_operator` naming the operator, or `query_invalid` with the character position. Pinned by `every_parity_operator_is_refused_by_name_in_the_mvp` (Task 3) and `malformed_queries_are_refused_with_a_position` (Task 1).
4. **Negation over attachments.** `-foo` must not list every attachment in the vault (P10), and `-file:.png` must still list notes. Pinned by `a_negated_query_reaches_attachments_only_through_a_positive_file_or_path_term` (Task 3).
5. **A page from a stale answer.** A cursor from generation N asked at N+1, or a `context: line` page whose notes changed after the answer was cached, must never mix generations. Expected: `generation_mismatch` with `current_generation`. Pinned by `line_context_is_read_at_the_answers_generation` (Task 4) and `a_cursor_from_an_older_generation_is_generation_mismatch` (Task 6).

---

## Preflight

```bash
cd <repository root>
git status --short --branch
git log --oneline -1
cargo --version
rustup run 1.85.0 cargo --version
node --version
command -v obsidian
mkdir -p target/tmp
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
```

Expected: a clean tree on `feat/search` cut from `main` after phase 8 merged (or from `feat/bases-evaluation` if it has not; the plan reads only what that branch holds), `cargo` at 1.85 or above, the 1.85 toolchain installed, `node` at v24 or above, the `obsidian` CLI on `PATH` (needed only from Task 19), and the whole workspace suite green with `exit=0`. If the suite is red before Task 1, stop and report the failing test.

**Facts this plan relies on, checked against the tree on 2026-10-17:** the schema is **version 5** (`crates/vault-index/src/schema.rs`, `SQL_SCHEMA_VERSION = 5`, `schema_v5.sql`), and this phase changes no schema (canvas content, which would have needed schema v6, is out of this phase by Ruling 4, issue #3). `notes.source_bytes` holds every note's exact text. `tags.value` holds the tag without `#` and `tags.comparison_key` its Rust `to_lowercase`, for body and frontmatter tags alike (`vault-core/src/obsidian.rs`, `frontmatter.rs`). `sections`, `list_items` (raw task character in `task`) and `headings` carry spans. The live graph holds no source bytes (`live_graph.rs`), so text is read from SQLite inside the pinned evaluation read (`IndexReader::evaluation_read`, `reader.rs`), which is crate-private to `vault-index`; therefore the document source lives in `vault-index` (`src/query/search.rs`), and the server owns the operation, the cache, the cursor and the conversion, exactly as Bases split it. The bundled SQLite is 3.46.0 with FTS5 compiled in (not used by this plan). Every open-ended wire enum, `ErrorCode` included, pairs a derived `Serialize` with a hand-written tolerant `Deserialize` (`crates/vault-protocol/src/error.rs`, `snapshots.rs` `TreeEntryKindDto`), because `#[serde(other)]` is rejected on a plain unit-variant enum, and `crates/vault-protocol/tests/variant_anchors.rs` holds an exhaustive witness per enum that fails to compile when a variant is added without its round-trip row. The host's `global-search` is in `VIEW_ONLY` (`shim/internal-plugins.ts`), and tag-wrangler calls `getGlobalSearchQuery()` and `openGlobalSearch(query)` on its instance (`host/fixtures/golden/tag-wrangler/plugin/main.js`).

---

## Shared names

Every name below crosses a task boundary. A task's **Interfaces** block repeats the ones it consumes and produces; this table is the one place they are all listed, and the self-review at the end checks every task against it.

| Name | Kind | Defined in | Used by |
| --- | --- | --- | --- |
| `vault_search::{parse_query, Query, Node, Term, Pattern, Scope, PropertyValueQuery, QueryError}` | fn, types | 1 | 2, 3, 11–16 |
| `Query::strip_positions`, `impl Display for Query` | fn, impl | 1 | 1 (the tests use `strip_positions`), 3 (`Display` gives `CompiledQuery::canonical`) |
| `vault_search::text::{Needle, fold_js, LineIndex, Loc, utf16_len}` | types, fns | 2 | 3, 4, 11–13 |
| `vault_search::{compile, CompiledQuery, CompileError, Needs}`; `CompiledQuery::{is_empty, needs, reaches_files, prefilter, canonical, match_case}`; the signature is `compile(&Query, match_case: bool)` (the design's `Features` argument is deferred) | fn, types, methods | 3 (MVP scopes), 11–13 (extended) | 4, 6, 11–16, 18 |
| `vault_search::{SearchDocument, DocumentKind, TagFact, MemoryDocument}` (`DocumentKind::Canvas` is reserved and never produced in this phase, Ruling 4) | trait, types | 3, extended 12 (`structure`), 13 (`properties`) | 4, 11–13 |
| `vault_search::{evaluate, FileHit, ContentMatch, MAX_MATCHES_PER_FILE}` | fn, types, const | 3 | 4, 6 |
| `vault_search::{SortOrder, Times, sort_hits}` | enum, struct, fn | 3 | 4, 6 |
| `vault_search::{Structure, Unit}` | types | 12 | 12 |
| `vault_search::{PropertyFact, PropertyFactValue}` | types | 13 | 13 |
| `vault_search::canvas::{extract_text, CanvasText}` | fn, type | none: Task 14 is removed from this phase (Ruling 4, issue #3) | none |
| `vault_search::{Exclusions, parse_exclusions}` | type, fn | 15 | 15 |
| `vault_search::explain::{explain, ExplainNode}` | fn, type | 16 | 16 |
| `vault_bases::regexp::{compile, RegexpError}` (was `eval::compile_regexp`, made public) | fn, enum | 11 | 11, 13, 15 |
| `vault_index::{SearchQuery, SearchAnswer, MAX_LINE_TEXT_BYTES}`, `IndexReader::{search, match_contexts, search_unnarrowed_for_test}` | types, const, fns | 4 (`SearchQuery.exclusions` in 15) | 6, 9, 15 |
| `vault_index::MatchContext { line_text: String, line_text_start: usize }` | struct | 4 | 6 |
| `SQL_SCHEMA_VERSION = 6`, `schema_v6.sql`, `canvases` table | const, file | none: Task 14 is removed from this phase (Ruling 4, issue #3) | none |
| `vault_protocol::{SearchParams, SearchResponse, SearchHitDto, ContentMatchDto, LocDto, Utf16SpanDto, SearchSortDto, SearchContextDto, DocumentKindDto}` | DTOs | 5 | 6, 7, 15, 16, 20 |
| `vault_protocol::ExplainNodeDto`, `SearchParams.explain`, `SearchResponse.explain` | DTO, fields | 16 | 16 |
| `SearchParams.include_excluded` | field | 15 | 15 |
| `ErrorCode::{QueryInvalid, UnsupportedOperator}` (with their hand-written `Deserialize` arms and `variant_anchors.rs` witnesses), `ProtocolError.position`, `ProtocolError::new` | variants, field, fn | 5 | 6, 21 |
| `vault_server::search::{SearchCache, DEFAULT_SEARCH_CACHE_ENTRIES, MAX_STORED_MATCHES, search, query_error}` | type, consts, fns | 6 | 6, 9, 15 |
| `vault_server::paging::{page_limit, invalid_cursor, generation_mismatch, encode_cursor, decode_cursor}` (crate-private, moved out of `bases.rs`) | fns | 6 | 6, 15 (and `bases.rs`) |
| `Server::set_search_cache_entries(n)`, `--search-cache-entries` | fn, flag | 6 | 9 |
| `Server::exclusion_epoch()` | fn | 15 | 15 |
| `GlobalSearchInstance`, `SearchState`, `host.search`, `host.search_state`, `host.search_opened` | class, type, ops, event | 7 | 7 |
| `host/scripts/search-parity.js` (`generate`, `copy`, `capture`) | script | 18 (generate), 19 (copy, capture) | 18–20 |
| `crates/vault-server/tests/fixtures/search-parity/{corpus.json,queries.jsonl}` | fixtures | 18 | 19, 20 |
| `crates/vault-server/tests/fixtures/search-captures/{*.json,meta.json,deviations.json}` | fixtures | 19, 20 | 20 |
| `scratch()` (each new vault-server test file), `common::scratch_root()` (vault-index) | test helpers | existing | 4, 6, 12–15, 20 |

---

## Planned file map

### `crates/vault-search` (new crate)

- Create `Cargo.toml` — depends on `vault-core`, `vault-bases`, `thiserror` (and `serde_json` from Task 15); dev-depends on `proptest`.
- Create `src/lib.rs` — module list and re-exports; the crate's one-paragraph contract (no I/O, no SQLite, no protocol types).
- Create `src/query.rs` — `Query`, `Node`, `Term`, `Pattern`, `Scope`, `PropertyValueQuery`, `QueryError`, the printer.
- Create `src/parse.rs` — `parse_query`, the scannerless recursive-descent parser.
- Create `src/text.rs` — `Needle`, `fold_js`, `LineIndex`, `Loc`, `utf16_len`.
- Create `src/compile.rs` — `compile`, `CompiledQuery`, `CompileError`, `Needs` (the design's `Features` argument is deferred until a build needs to switch features at run time).
- Create `src/document.rs` — `SearchDocument`, `DocumentKind`, `TagFact`, `MemoryDocument`, and the crate-private `file_name` that `evaluate.rs` and `sort.rs` share (and in 12, 13: `Structure`, `Unit`, `PropertyFact`, `PropertyFactValue`).
- Create `src/evaluate.rs` — `evaluate`, `FileHit`, `ContentMatch`, `MAX_MATCHES_PER_FILE`.
- Create `src/sort.rs` — `SortOrder`, `Times`, `sort_hits`.
- Create (parity) `src/exclusions.rs`, `src/explain.rs`. (`src/canvas.rs` belonged to Task 14, removed from this phase by Ruling 4.)
- Create `tests/parse.rs`, `tests/text.rs`, `tests/evaluate.rs`, `tests/sort.rs`, and (parity) `tests/regex.rs`, `tests/structure.rs`, `tests/properties.rs`, `tests/exclusions.rs`, `tests/explain.rs`.

### `crates/vault-bases`

- Modify (Task 11) `src/eval/mod.rs` and `src/lib.rs` — move `compile_regexp` into a new public module `src/regexp.rs` as `pub fn compile(source: &str, flags: &str) -> Result<RegexpValue, String>`; `eval` calls it and maps the error to `EvalError::Argument` exactly as before.

### `crates/vault-index`

- Create `src/query/search.rs` — the document source over the pinned read, the narrowing, `search`, `match_contexts`.
- Modify `src/query.rs` (`pub(crate) mod search;`, as `bases` is) and `src/lib.rs` (exports).
- Modify `Cargo.toml` — depend on `vault-search`.
- No schema file changes: Task 14 (schema v6, `.canvas` as a stored kind) is removed from this phase by Ruling 4 (issue #3).
- Create `tests/search_query.rs` and `tests/search_timing.rs` (Task 9).

### `crates/vault-protocol`

- Create `src/search.rs` — every search DTO, with a hand-written `Deserialize` for `DocumentKindDto`; create `tests/search_wire.rs` (it holds the round-trip rows for the two codes and `DocumentKindDto`).
- Modify `src/operations.rs` — `Request::Search`, `Response::Search`.
- Modify `src/error.rs` — two codes, their two arms in the hand-written `Deserialize`, `position`, `ProtocolError::new`.
- Modify `tests/variant_anchors.rs` — witnesses for the two codes and for `DocumentKindDto`.
- Modify `src/lib.rs` — exports.

### `crates/vault-server`

- Create `src/search.rs` — `SearchCache`, the cursor, the handler.
- Create `src/paging.rs` — the page limit, the cursor codec and the two cursor refusals, moved out of `src/bases.rs`; modify `src/bases.rs` to call them (Task 6).
- Modify `src/lib.rs` — the dispatch arm, the cache on `Server`, `set_search_cache_entries`, `exclusion_epoch` (Task 15).
- Modify `src/convert.rs` — DTO conversion, the two codes.
- Modify `src/main.rs` — `--search-cache-entries`.
- Modify `crates/vault-watch` (Task 15) — the watcher passes `.obsidian/app.json` beside `.obsidian/types.json`.
- Modify `tests/conformance.rs`, `tests/fixtures/conformance.jsonl` — the search fixtures.
- Create `tests/search_ops.rs`, `tests/search_replay.rs`, `tests/fixtures/search-parity/`, `tests/fixtures/search-captures/`.
- Modify `tests/docs.rs` — pins.

### Host

- Create `host/packages/host/src/shim/global-search.ts`; modify `shim/internal-plugins.ts`, `server/ops.ts`, `server/server.ts`, `client/protocol.ts`, `host.ts`, `testing/assemble.ts`, `testing/host-harness.ts` (Task 7 only).
- Create `host/packages/host/test/shim-global-search.test.ts`, `host/packages/host/test/global-search-real-daemon.test.ts`; modify `host/packages/host/test/shim-internal-plugins.test.ts` and `host/packages/host/test/golden/tag-wrangler.test.ts`.
- Create `host/scripts/search-parity.js`; modify `host/scripts/socket-transport-baseline.js` (`--search`, `--prose-bytes`).
- On branch `spike/htmx-client-clean` only: modify `spikes/htmx-client/server.js` and `spikes/htmx-client/smoke.js` (Tasks 8, 17).

### Documentation

- Modify `docs/protocol.md`, `docs/protocol-host.md`, `docs/design/semantic-read-path.md`, `README.md`, `VAULTD-COMPATIBILITY.md`; create `docs/performance/search-baseline.md`. The design lives at `docs/design/search.md` and this plan at `docs/plans/search-implementation.md` from before Task 1; Task 10 records the review's rulings in the design.

---

# Part 1 — The MVP (Tasks 1 to 10)

The MVP is shippable after Tasks 1 to 10, with Task 8 run last, on the spike branch: the grammar, the MVP operators, the operation, the host instance, the baseline, the documents and the demo search box. Tasks 11 to 17 add the parity operators; Tasks 18 to 21 are the parity harness.

---
### Task 1: The `vault-search` crate, the query tree, and the parser

Create the crate and parse Obsidian's whole search grammar into a `Query` tree, with a printer that round-trips it. The parser accepts every operator from the start, including the ones the MVP does not evaluate, so that a parity operator is refused by name at compile time (Task 3) instead of being misread as text. Positions in errors are character offsets into the query string.

**Files:**

- Create: `crates/vault-search/Cargo.toml`, `crates/vault-search/src/lib.rs`, `crates/vault-search/src/query.rs`, `crates/vault-search/src/parse.rs`
- Create: `crates/vault-search/tests/parse.rs`
- Modify: `Cargo.toml` (workspace members: add `"crates/vault-search"` in sorted position)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:

```rust
pub struct Query { pub root: Option<Node> }               // None: an empty or all-whitespace query
pub enum Node {
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    Term(Term),
    Scoped { scope: Scope, query: Box<Node>, at: Range<usize> },
    Case { sensitive: bool, query: Box<Node>, at: Range<usize> },
    Property { name: Box<Node>, value: Option<PropertyValueQuery>, at: Range<usize> },
}
pub struct Term { pub pattern: Pattern, pub phrase: bool, pub at: Range<usize> }
pub enum Pattern { Text(String), Regex { source: String, flags: String } }
pub enum Scope { File, Path, Content, Tag, Line, Block, Section, Task, TaskTodo, TaskDone }
pub enum PropertyValueQuery { Null, Query(Box<Node>), Less(f64), Greater(f64) }
pub struct QueryError { pub message: String, pub position: usize }
pub fn parse_query(text: &str) -> Result<Query, QueryError>;
impl Query { pub fn strip_positions(&self) -> Query }
impl std::fmt::Display for Query { /* the canonical spelling; parse(print(q)) == q, positions aside */ }
pub const MAX_DEPTH: usize = 64;
```

**The published-query checklist** — every query printed on the help page [S1 of the design], transcribed 2026-10-17. Step 1 pins one parse per line, and the structural ones are asserted in full.

- Terms: `"star wars"`, `"they said \"hello\" to each other"`, `meeting work`, `meeting OR work`, `meeting work OR meetup personal`, `meeting (work OR meetup) personal`, `meeting -work`, `meeting -work -meetup`, `meeting -(work meetup)`, `meeting [duration:<5]`, `meeting [duration:>5]`.
- Operators: `task:(call OR email)`, `file:.jpg`, `file:202209`, `path:"Daily notes/2022-07"`, `content:"happy cat"`, `match-case:HappyCat`, `ignore-case:ikea`, `tag:#work`, `line:(mix flour)`, `block:(dog cat)`, `section:(dog cat)`, `task:call`, `task-todo:call`, `task-done:call`.
- Properties: `[aliases]`, `[aliases:Name]`, `[aliases:null]`, `[status:Draft OR Published]`.
- Regular expressions: `/\d{4}-\d{2}-\d{2}/`, `path:/\d{4}-\d{2}-\d{2}/`.
- Embedded block body: `embed OR search`.

The lexical rules this parser fixes, each a provisional rule of the design where the page is silent: a word runs to whitespace or a parenthesis (inside `[…]` also to `]`, and in a property name also to `:`); `OR` is an operator only in upper case and only as a whole word (P6); `name:` is an operator only for the twelve names above, and any other `x:y` is a plain word (P7); inside `[…]` no operator is recognized (`[file:x]` is the property `file`); a backslash escapes `"` and `\` inside a phrase and is literal elsewhere; a `/` starts a regular expression only when an unescaped closing `/` follows, optionally followed by JavaScript flag letters (`d g i m s u y v`) and then a word end, and is otherwise an ordinary word character; a malformed query is refused (P8): an unmatched `(` (at the `(`), an unmatched `)` (at the `)`), an unterminated phrase (at its opening quote), an unmatched `[` (at the `[`), an empty `()` or `[]` (at the opener), a dangling `-`, one followed by the end of the query, whitespace or `)`, and inside `[…]` also by `]` or `:` (at the `-`; a `-` before `(`, another `-`, a quote, a `[` or any word character negates what follows, so `-(work meetup)` is a negated group), `OR` with nothing before or after it (at the `OR`), an operator with no operand (at the operator's first character), a comparison whose operand is not a number (at the `<` or `>`), and nesting deeper than `MAX_DEPTH` (at the opener that crossed it).

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-search/tests/parse.rs`:

```rust
use proptest::prelude::*;
use vault_search::{Node, Pattern, PropertyValueQuery, Query, Scope, Term, parse_query};

fn word(text: &str) -> Node {
    Node::Term(Term { pattern: Pattern::Text(text.into()), phrase: false, at: 0..0 })
}
fn phrase(text: &str) -> Node {
    Node::Term(Term { pattern: Pattern::Text(text.into()), phrase: true, at: 0..0 })
}
fn regex(source: &str, flags: &str) -> Node {
    Node::Term(Term {
        pattern: Pattern::Regex { source: source.into(), flags: flags.into() },
        phrase: false,
        at: 0..0,
    })
}
fn and(items: Vec<Node>) -> Node { Node::And(items) }
fn or(items: Vec<Node>) -> Node { Node::Or(items) }
fn not(item: Node) -> Node { Node::Not(Box::new(item)) }
fn scoped(scope: Scope, query: Node) -> Node {
    Node::Scoped { scope, query: Box::new(query), at: 0..0 }
}
fn case(sensitive: bool, query: Node) -> Node {
    Node::Case { sensitive, query: Box::new(query), at: 0..0 }
}
fn property(name: Node, value: Option<PropertyValueQuery>) -> Node {
    Node::Property { name: Box::new(name), value, at: 0..0 }
}
fn parsed(text: &str) -> Node {
    parse_query(text)
        .unwrap_or_else(|error| panic!("{text:?}: {error:?}"))
        .strip_positions()
        .root
        .unwrap_or_else(|| panic!("{text:?} parsed to an empty query"))
}

const PUBLISHED: &[&str] = &[
    r#""star wars""#,
    r#""they said \"hello\" to each other""#,
    "meeting work",
    "meeting OR work",
    "meeting work OR meetup personal",
    "meeting (work OR meetup) personal",
    "meeting -work",
    "meeting -work -meetup",
    "meeting -(work meetup)",
    "meeting [duration:<5]",
    "meeting [duration:>5]",
    "task:(call OR email)",
    "file:.jpg",
    "file:202209",
    r#"path:"Daily notes/2022-07""#,
    r#"content:"happy cat""#,
    "match-case:HappyCat",
    "ignore-case:ikea",
    "tag:#work",
    "line:(mix flour)",
    "block:(dog cat)",
    "section:(dog cat)",
    "task:call",
    "task-todo:call",
    "task-done:call",
    "[aliases]",
    "[aliases:Name]",
    "[aliases:null]",
    "[status:Draft OR Published]",
    r"/\d{4}-\d{2}-\d{2}/",
    r"path:/\d{4}-\d{2}-\d{2}/",
    "embed OR search",
];

#[test]
fn every_published_query_parses() {
    let failures: Vec<String> = PUBLISHED
        .iter()
        .filter_map(|text| parse_query(text).err().map(|error| format!("{text:?}: {error:?}")))
        .collect();
    assert!(failures.is_empty(), "failed to parse:\n{}", failures.join("\n"));
}

#[test]
fn and_binds_tighter_than_or_as_the_help_page_shows() {
    assert_eq!(
        parsed("meeting work OR meetup personal"),
        or(vec![and(vec![word("meeting"), word("work")]), and(vec![word("meetup"), word("personal")])])
    );
    assert_eq!(
        parsed("meeting (work OR meetup) personal"),
        and(vec![word("meeting"), or(vec![word("work"), word("meetup")]), word("personal")])
    );
}

#[test]
fn negation_applies_to_words_groups_and_operators() {
    assert_eq!(parsed("meeting -work -meetup"), and(vec![word("meeting"), not(word("work")), not(word("meetup"))]));
    assert_eq!(parsed("meeting -(work meetup)"), and(vec![word("meeting"), not(and(vec![word("work"), word("meetup")]))]));
    assert_eq!(parsed("-line:(mix flour)"), not(scoped(Scope::Line, and(vec![word("mix"), word("flour")]))));
    assert_eq!(parsed("-file:.png"), not(scoped(Scope::File, word(".png"))));
    assert_eq!(parsed("well-known"), word("well-known"), "a hyphen negates only at the start");
}

#[test]
fn a_hyphen_negates_the_group_or_term_right_after_it() {
    assert_eq!(parsed("meeting -(work meetup)"), and(vec![word("meeting"), not(and(vec![word("work"), word("meetup")]))]));
    assert_eq!(parsed("-(a)"), not(word("a")));
    assert_eq!(parsed("--a"), not(not(word("a"))));
    assert_eq!(parsed(r#"-"a b""#), not(phrase("a b")));
    assert_eq!(parsed("-[aliases]"), not(property(word("aliases"), None)));
}

#[test]
fn a_phrase_unescapes_quotes_and_backslashes_only() {
    assert_eq!(parsed(r#""they said \"hello\" to each other""#), phrase(r#"they said "hello" to each other"#));
    assert_eq!(parsed(r#""a\\b""#), phrase(r"a\b"));
    assert_eq!(parsed(r#""a\nb""#), phrase(r"a\nb"), "any other backslash is literal");
}

#[test]
fn operators_take_words_phrases_regexes_and_sub_queries() {
    assert_eq!(parsed("file:.jpg"), scoped(Scope::File, word(".jpg")));
    assert_eq!(parsed(r#"path:"Daily notes/2022-07""#), scoped(Scope::Path, phrase("Daily notes/2022-07")));
    assert_eq!(parsed(r"path:/\d{4}/"), scoped(Scope::Path, regex(r"\d{4}", "")));
    assert_eq!(parsed("task:(call OR email)"), scoped(Scope::Task, or(vec![word("call"), word("email")])));
    assert_eq!(parsed("task-todo:call"), scoped(Scope::TaskTodo, word("call")));
    assert_eq!(parsed("task-done:call"), scoped(Scope::TaskDone, word("call")));
    assert_eq!(parsed("tag:#work"), scoped(Scope::Tag, word("#work")));
    assert_eq!(parsed("match-case:HappyCat"), case(true, word("HappyCat")));
    assert_eq!(parsed("ignore-case:ikea"), case(false, word("ikea")));
    assert_eq!(parsed("content:(a OR b)"), scoped(Scope::Content, or(vec![word("a"), word("b")])));
}

#[test]
fn property_forms_parse_with_sub_queries_null_and_comparisons() {
    assert_eq!(parsed("[aliases]"), property(word("aliases"), None));
    assert_eq!(parsed("[aliases:Name]"), property(word("aliases"), Some(PropertyValueQuery::Query(Box::new(word("Name"))))));
    assert_eq!(parsed("[aliases:null]"), property(word("aliases"), Some(PropertyValueQuery::Null)));
    assert_eq!(
        parsed("[status:Draft OR Published]"),
        property(word("status"), Some(PropertyValueQuery::Query(Box::new(or(vec![word("Draft"), word("Published")])))))
    );
    assert_eq!(parsed("[duration:<5]"), property(word("duration"), Some(PropertyValueQuery::Less(5.0))));
    assert_eq!(parsed("[duration:>2.5]"), property(word("duration"), Some(PropertyValueQuery::Greater(2.5))));
    assert_eq!(parsed("[file:x]"), property(word("file"), Some(PropertyValueQuery::Query(Box::new(word("x"))))), "no operators inside brackets");
}

#[test]
fn the_lexical_provisional_rules() {
    assert_eq!(parsed("a or b"), and(vec![word("a"), word("or"), word("b")]), "P6: only upper-case OR");
    assert_eq!(parsed("foo:bar"), word("foo:bar"), "P7: an unknown prefix is a word");
    assert_eq!(parsed("/abc/i"), regex("abc", "i"));
    assert_eq!(parsed("/usr/local"), word("/usr/local"), "no word end after the closing slash: a word");
    assert_eq!(parsed("/usr"), word("/usr"), "no closing slash: a word");
    assert_eq!(parsed("a/b c"), and(vec![word("a/b"), word("c")]));
    assert_eq!(parse_query("").unwrap().root, None);
    assert_eq!(parse_query("  \t ").unwrap().root, None);
}

#[test]
fn malformed_queries_are_refused_with_a_position() {
    for (text, position) in [
        ("(a b", 0),
        ("a b)", 3),
        (r#"x "abc"#, 2),
        ("[aliases", 0),
        ("()", 0),
        ("[]", 0),
        ("a -", 2),
        ("a -)", 2),
        ("a - b", 2),
        ("OR a", 0),
        ("a OR", 2),
        ("a OR )", 2),
        ("file:", 0),
        ("a file: b", 2),
        ("[duration:<five]", 10),
    ] {
        let error = parse_query(text).expect_err(text);
        assert_eq!(error.position, position, "{text:?}: {error:?}");
        assert!(!error.message.is_empty());
    }
    let deep = format!("{}a{}", "(".repeat(65), ")".repeat(65));
    assert_eq!(parse_query(&deep).expect_err("too deep").position, 64);
}

#[test]
fn positions_are_character_offsets() {
    let query = parse_query("é tag:x").unwrap();
    let Some(Node::And(items)) = query.root else { panic!("an AND") };
    let Node::Term(first) = &items[0] else { panic!("a term") };
    assert_eq!(first.at, 0..1);
    let Node::Scoped { at, .. } = &items[1] else { panic!("a scope") };
    assert_eq!(*at, 2..5, "the operator name, in characters");
    assert_eq!(parse_query("é (").unwrap_err().position, 2);
}

fn arb_word() -> impl Strategy<Value = String> {
    "[a-z0-9éß]{1,6}".prop_filter("not a keyword", |w| w != "null")
}

fn arb_leaf() -> impl Strategy<Value = Node> {
    prop_oneof![
        arb_word().prop_map(|w| word(&w)),
        "[a-z \"\\\\()]{1,8}".prop_map(|p| phrase(&p)),
        "[a-z0-9.]{1,5}".prop_map(|r| regex(&r, "")),
    ]
}

/// What a property's value can hold: inside `[…]` no operator and no
/// property is recognized, so the value draws from terms and the boolean
/// connectives only.
fn arb_plain() -> impl Strategy<Value = Node> {
    arb_leaf().prop_recursive(3, 12, 3, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 2..4).prop_map(Node::And),
            prop::collection::vec(inner.clone(), 2..4).prop_map(Node::Or),
            inner.prop_map(|n| Node::Not(Box::new(n))),
        ]
    })
}

fn arb_node() -> impl Strategy<Value = Node> {
    arb_leaf().prop_recursive(4, 24, 4, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 2..4).prop_map(Node::And),
            prop::collection::vec(inner.clone(), 2..4).prop_map(Node::Or),
            inner.clone().prop_map(|n| Node::Not(Box::new(n))),
            (
                prop::sample::select(vec![
                    Scope::File, Scope::Path, Scope::Content, Scope::Tag, Scope::Line,
                    Scope::Block, Scope::Section, Scope::Task, Scope::TaskTodo, Scope::TaskDone,
                ]),
                inner.clone(),
            )
                .prop_map(|(scope, n)| scoped(scope, n)),
            (any::<bool>(), inner.clone()).prop_map(|(s, n)| case(s, n)),
            (arb_word(), arb_plain()).prop_map(|(name, n)| property(word(&name), Some(PropertyValueQuery::Query(Box::new(n))))),
        ]
    })
}

proptest! {
    #[test]
    fn printing_and_parsing_round_trips(node in arb_node()) {
        let query = Query { root: Some(node) }.strip_positions();
        let printed = query.to_string();
        let again = parse_query(&printed).map_err(|e| TestCaseError::fail(format!("{printed:?}: {e:?}")))?;
        prop_assert_eq!(normalize(again.strip_positions()), normalize(query), "printed as {:?}", printed);
    }
}

/// Flatten nested ANDs and ORs of the same kind, which print identically:
/// `And([a, And([b, c])])` and `And([a, b, c])` are one query.
fn normalize(query: Query) -> Query {
    fn flat(node: Node) -> Node {
        match node {
            Node::And(items) => Node::And(items.into_iter().map(flat).flat_map(|n| match n { Node::And(inner) => inner, other => vec![other] }).collect()),
            Node::Or(items) => Node::Or(items.into_iter().map(flat).flat_map(|n| match n { Node::Or(inner) => inner, other => vec![other] }).collect()),
            Node::Not(inner) => Node::Not(Box::new(flat(*inner))),
            Node::Scoped { scope, query, at } => Node::Scoped { scope, query: Box::new(flat(*query)), at },
            Node::Case { sensitive, query, at } => Node::Case { sensitive, query: Box::new(flat(*query)), at },
            Node::Property { name, value, at } => Node::Property {
                name: Box::new(flat(*name)),
                value: value.map(|v| match v { PropertyValueQuery::Query(q) => PropertyValueQuery::Query(Box::new(flat(*q))), other => other }),
                at,
            },
            leaf => leaf,
        }
    }
    Query { root: query.root.map(flat) }
}
```

Create `crates/vault-search/Cargo.toml` with the workspace `version`, `edition`, `rust-version` and `license` keys as `vault-bases` declares them, `[dependencies] thiserror.workspace = true`, `vault-core = { path = "../vault-core" }`, `vault-bases = { path = "../vault-bases" }` (used from Task 3), and `[dev-dependencies] proptest.workspace = true`; `src/lib.rs` with `mod parse; mod query; pub use parse::{MAX_DEPTH, parse_query}; pub use query::*;` and a one-paragraph crate doc ("Obsidian's search grammar and a matcher over documents. No I/O, no SQLite, no protocol types: the daemon feeds it documents, and a test feeds it `MemoryDocument`s."); `query.rs` and `parse.rs` with the signatures above returning `unimplemented!()`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test parse; echo "exit=$?"`

Expected: every test fails at `unimplemented!()`, `exit=101`.

- [ ] **Step 3: The tree and the printer**

Write `crates/vault-search/src/query.rs`. Every type derives `Clone, Debug, PartialEq` (`Scope` also `Copy, Eq, Hash`). `Scope::name(self) -> &'static str` returns `file`, `path`, `content`, `tag`, `line`, `block`, `section`, `task`, `task-todo`, `task-done`; `Scope::from_name(&str) -> Option<Scope>` is its inverse. `QueryError` derives `thiserror::Error` with `#[error("{message} (at character {position})")]`. `strip_positions` rebuilds the tree with every `at` set to `0..0`.

The printer writes the canonical spelling, which Task 6 uses as the cache key:

```rust
impl fmt::Display for Query {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.root {
            None => Ok(()),
            Some(node) => write_node(f, node, Context::Top),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Context { Top, InOr, Tight }

fn write_node(f: &mut fmt::Formatter<'_>, node: &Node, context: Context) -> fmt::Result {
    match node {
        Node::Or(items) => write_joined(f, items, " OR ", Context::InOr, context != Context::Top),
        Node::And(items) => write_joined(f, items, " ", Context::Tight, context == Context::Tight),
        Node::Not(inner) => {
            f.write_str("-")?;
            write_node(f, inner, Context::Tight)
        }
        Node::Term(term) => write_term(f, term),
        Node::Scoped { scope, query, .. } => {
            write!(f, "{}:", scope.name())?;
            write_operand(f, query)
        }
        Node::Case { sensitive, query, .. } => {
            f.write_str(if *sensitive { "match-case:" } else { "ignore-case:" })?;
            write_operand(f, query)
        }
        Node::Property { name, value, .. } => {
            f.write_str("[")?;
            write_node(f, name, Context::Top)?;
            match value {
                None => {}
                Some(PropertyValueQuery::Null) => f.write_str(":null")?,
                Some(PropertyValueQuery::Less(n)) => write!(f, ":<{n}")?,
                Some(PropertyValueQuery::Greater(n)) => write!(f, ":>{n}")?,
                Some(PropertyValueQuery::Query(q)) => {
                    f.write_str(":")?;
                    write_node(f, q, Context::Top)?;
                }
            }
            f.write_str("]")
        }
    }
}
```

`write_joined` writes the items with the separator, each in the given child context, inside parentheses when its last argument is true (an `Or` is parenthesized everywhere but at the top, because inside an `And` it must be and inside an `Or` it is harmless). `write_operand` writes a `Term` bare and anything else as `(…)` with the inner node in `Context::Top`. `write_term` writes a regex as `/source/flags`, and text bare only when it is a *safe word* — non-empty; no whitespace, `(`, `)`, `[`, `]`, `"`, `:` or `\`; not starting with `-` or `/`; not `OR` or `null` — and as a phrase otherwise (always when `phrase` is set), escaping `"` and `\` with a backslash.

- [ ] **Step 4: The parser**

Write `crates/vault-search/src/parse.rs`, scannerless, over `Vec<char>` so every position is a character offset:

```rust
use crate::query::{Node, Pattern, PropertyValueQuery, Query, QueryError, Scope, Term};

pub const MAX_DEPTH: usize = 64;

const OPERATORS: [&str; 12] = [
    "file", "path", "content", "tag", "line", "block", "section", "task", "task-todo",
    "task-done", "match-case", "ignore-case",
];

/// Where a sub-expression stops, beyond whitespace and parentheses.
#[derive(Clone, Copy, PartialEq)]
enum Within { Top, Group, PropertyName, PropertyValue }

impl Within {
    fn in_property(self) -> bool { matches!(self, Within::PropertyName | Within::PropertyValue) }
}

struct Parser { chars: Vec<char>, at: usize, depth: usize }

pub fn parse_query(text: &str) -> Result<Query, QueryError> {
    let mut p = Parser { chars: text.chars().collect(), at: 0, depth: 0 };
    p.skip_ws();
    if p.done() {
        return Ok(Query { root: None });
    }
    let root = p.or_expr(Within::Top)?;
    p.skip_ws();
    if !p.done() {
        return Err(p.error(p.at, "unmatched `)`"));
    }
    Ok(Query { root: Some(root) })
}

impl Parser {
    fn done(&self) -> bool { self.at >= self.chars.len() }
    fn peek(&self) -> Option<char> { self.chars.get(self.at).copied() }
    fn skip_ws(&mut self) { while self.peek().is_some_and(char::is_whitespace) { self.at += 1; } }
    fn error(&self, position: usize, message: &str) -> QueryError {
        QueryError { message: message.to_string(), position }
    }

    /// Does a word end before `chars[at]`?
    fn ends_word(&self, at: usize, within: Within) -> bool {
        match self.chars.get(at) {
            None => true,
            Some(c) if c.is_whitespace() || *c == '(' || *c == ')' => true,
            Some(']') => within.in_property(),
            Some(':') => within == Within::PropertyName,
            Some(_) => false,
        }
    }

    /// Does the current expression end here?
    fn stops(&self, within: Within) -> bool {
        match self.peek() {
            None | Some(')') => true,
            Some(']') => within.in_property(),
            Some(':') => within == Within::PropertyName,
            Some(_) => false,
        }
    }

    fn at_or(&self, within: Within) -> bool {
        self.chars.get(self.at) == Some(&'O')
            && self.chars.get(self.at + 1) == Some(&'R')
            && self.ends_word(self.at + 2, within)
    }

    fn deeper(&mut self, opener: usize) -> Result<(), QueryError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.error(opener, "the query nests more than 64 levels deep"));
        }
        Ok(())
    }

    fn or_expr(&mut self, within: Within) -> Result<Node, QueryError> {
        let mut items = vec![self.and_expr(within)?];
        loop {
            self.skip_ws();
            if !self.at_or(within) {
                break;
            }
            let or_at = self.at;
            self.at += 2;
            self.skip_ws();
            if self.stops(within) || self.at_or(within) {
                return Err(self.error(or_at, "`OR` needs a term after it"));
            }
            items.push(self.and_expr(within)?);
        }
        Ok(if items.len() == 1 { items.pop().expect("one item") } else { Node::Or(items) })
    }

    fn and_expr(&mut self, within: Within) -> Result<Node, QueryError> {
        let mut items = Vec::new();
        loop {
            self.skip_ws();
            if self.stops(within) || self.at_or(within) {
                break;
            }
            items.push(self.unary(within)?);
        }
        match items.len() {
            0 if self.at_or(within) => Err(self.error(self.at, "`OR` needs a term before it")),
            0 if self.peek() == Some(')') => Err(self.error(self.at, "unmatched `)`")),
            0 => Err(self.error(self.at, "expected a term")),
            1 => Ok(items.pop().expect("one item")),
            _ => Ok(Node::And(items)),
        }
    }

    fn unary(&mut self, within: Within) -> Result<Node, QueryError> {
        if self.peek() != Some('-') {
            return self.primary(within);
        }
        let start = self.at;
        // Only the end of the query, whitespace or `)` (and, inside `[…]`,
        // `]` or `:`) leave a `-` dangling. `(` and another `-` begin the
        // term it negates, so `-(a b)` is a negated group; `ends_word` would
        // refuse `(`, which is why it is not used here.
        let dangling = match self.chars.get(start + 1) {
            None => true,
            Some(c) if c.is_whitespace() || *c == ')' => true,
            Some(']' | ':') => within.in_property(),
            Some(_) => false,
        };
        if dangling {
            return Err(self.error(start, "`-` needs a term after it"));
        }
        self.at += 1;
        self.deeper(start)?;
        let inner = self.unary(within)?;
        self.depth -= 1;
        Ok(Node::Not(Box::new(inner)))
    }

    fn primary(&mut self, within: Within) -> Result<Node, QueryError> {
        let start = self.at;
        match self.peek() {
            Some('(') => self.group(),
            Some('[') if !within.in_property() => self.property(),
            Some('"') => self.phrase().map(Node::Term),
            Some('/') => Ok(Node::Term(self.regex_or_word(within))),
            _ => {
                if !within.in_property() {
                    if let Some((name, after)) = self.operator_name() {
                        return self.operator(name, start, after, within);
                    }
                }
                Ok(Node::Term(self.word(within)))
            }
        }
    }

    fn group(&mut self) -> Result<Node, QueryError> {
        let opener = self.at;
        self.at += 1;
        self.deeper(opener)?;
        self.skip_ws();
        if self.peek() == Some(')') {
            return Err(self.error(opener, "empty `()`"));
        }
        if self.done() {
            return Err(self.error(opener, "unmatched `(`"));
        }
        let inner = self.or_expr(Within::Group)?;
        self.skip_ws();
        if self.peek() != Some(')') {
            return Err(self.error(opener, "unmatched `(`"));
        }
        self.at += 1;
        self.depth -= 1;
        Ok(inner)
    }

    /// An operator name followed by `:`, and the position after the colon.
    fn operator_name(&self) -> Option<(&'static str, usize)> {
        let mut end = self.at;
        while self.chars.get(end).is_some_and(|c| c.is_ascii_lowercase() || *c == '-') {
            end += 1;
        }
        if self.chars.get(end) != Some(&':') {
            return None;
        }
        let name: String = self.chars[self.at..end].iter().collect();
        OPERATORS.iter().find(|known| **known == name).map(|known| (*known, end + 1))
    }

    fn operator(&mut self, name: &'static str, start: usize, after: usize, within: Within) -> Result<Node, QueryError> {
        let at = start..after - 1;
        self.at = after;
        if self.ends_word(self.at, within) && self.peek() != Some('(') {
            return Err(self.error(start, "an operator needs a term after it"));
        }
        let operand = match self.peek() {
            Some('(') => self.group()?,
            Some('"') => Node::Term(self.phrase()?),
            Some('/') => Node::Term(self.regex_or_word(within)),
            _ => Node::Term(self.word(within)),
        };
        let query = Box::new(operand);
        Ok(match name {
            "match-case" => Node::Case { sensitive: true, query, at },
            "ignore-case" => Node::Case { sensitive: false, query, at },
            other => Node::Scoped { scope: Scope::from_name(other).expect("a known scope"), query, at },
        })
    }

    fn word(&mut self, within: Within) -> Term {
        let start = self.at;
        while !self.ends_word(self.at, within) {
            self.at += 1;
        }
        Term { pattern: Pattern::Text(self.chars[start..self.at].iter().collect()), phrase: false, at: start..self.at }
    }

    fn phrase(&mut self) -> Result<Term, QueryError> {
        let start = self.at;
        self.at += 1;
        let mut text = String::new();
        loop {
            match self.peek() {
                None => return Err(self.error(start, "unterminated quote")),
                Some('\\') if matches!(self.chars.get(self.at + 1), Some('"') | Some('\\')) => {
                    text.push(self.chars[self.at + 1]);
                    self.at += 2;
                }
                Some('"') => {
                    self.at += 1;
                    return Ok(Term { pattern: Pattern::Text(text), phrase: true, at: start..self.at });
                }
                Some(c) => {
                    text.push(c);
                    self.at += 1;
                }
            }
        }
    }

    /// `/source/flags` when an unescaped closing slash follows and the flags
    /// end a word; an ordinary word otherwise.
    fn regex_or_word(&mut self, within: Within) -> Term {
        let start = self.at;
        let mut at = start + 1;
        while let Some(c) = self.chars.get(at) {
            if *c == '\\' {
                at += 2;
                continue;
            }
            if *c == '/' {
                let mut end = at + 1;
                // JavaScript's flag letters only, so `/usr/local` stays a word.
                while self.chars.get(end).is_some_and(|c| "dgimsuyv".contains(*c)) {
                    end += 1;
                }
                if self.ends_word(end, within) {
                    let source = self.chars[start + 1..at].iter().collect();
                    let flags = self.chars[at + 1..end].iter().collect();
                    self.at = end;
                    return Term { pattern: Pattern::Regex { source, flags }, phrase: false, at: start..end };
                }
                break;
            }
            at += 1;
        }
        self.word(within)
    }

    fn property(&mut self) -> Result<Node, QueryError> {
        let opener = self.at;
        self.at += 1;
        self.deeper(opener)?;
        self.skip_ws();
        if self.peek() == Some(']') {
            return Err(self.error(opener, "empty `[]`"));
        }
        if self.done() {
            return Err(self.error(opener, "unmatched `[`"));
        }
        let name = self.or_expr(Within::PropertyName)?;
        self.skip_ws();
        let mut value = None;
        if self.peek() == Some(':') {
            self.at += 1;
            self.skip_ws();
            value = Some(self.property_value(opener)?);
        }
        self.skip_ws();
        if self.peek() != Some(']') {
            return Err(self.error(opener, "unmatched `[`"));
        }
        self.at += 1;
        self.depth -= 1;
        Ok(Node::Property { name: Box::new(name), value, at: opener..self.at })
    }

    fn property_value(&mut self, opener: usize) -> Result<PropertyValueQuery, QueryError> {
        if let Some(op) = self.peek().filter(|c| *c == '<' || *c == '>') {
            let op_at = self.at;
            self.at += 1;
            let start = self.at;
            while self.peek().is_some_and(|c| c != ']' && !c.is_whitespace()) {
                self.at += 1;
            }
            let text: String = self.chars[start..self.at].iter().collect();
            let number: f64 = text.parse().map_err(|_| self.error(op_at, "a comparison needs a number"))?;
            return Ok(if op == '<' { PropertyValueQuery::Less(number) } else { PropertyValueQuery::Greater(number) });
        }
        if self.null_value() {
            self.at += 4;
            return Ok(PropertyValueQuery::Null);
        }
        if self.peek() == Some(']') || self.done() {
            return Err(self.error(opener, "a property value is missing after `:`"));
        }
        Ok(PropertyValueQuery::Query(Box::new(self.or_expr(Within::PropertyValue)?)))
    }

    /// `null`, then only whitespace before the closing `]`.
    fn null_value(&self) -> bool {
        let word: String = self.chars.iter().skip(self.at).take(4).collect();
        if word != "null" {
            return false;
        }
        let mut after = self.at + 4;
        while self.chars.get(after).is_some_and(|c| c.is_whitespace()) {
            after += 1;
        }
        self.chars.get(after) == Some(&']')
    }
}
```

The positions in Step 1's table follow from this code: `x "abc` fails at the quote (2), `a -`, `a -)` and `a - b` at the `-` (2), `a OR` and `a OR )` at the `OR` (2), `a file: b` at `f` (2), `[duration:<five]` at the `<` (10), and 65 opening parentheses at the 65th (index 64).

- [ ] **Step 5: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test parse; echo "exit=$?"`

Expected: `test result: ok. 11 passed`, `exit=0`. A failure of `every_published_query_parses` lists each failing query; fix the parser, never the list. A round-trip failure prints the spelling that did not survive; fix the printer's safe-word rule or the parser, never the generator, unless the generator produced a tree no spelling can express (then narrow it the way `arb_plain` narrows property values, with a comment saying why).

- [ ] **Step 6: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-search; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check -p vault-search; echo "exit=$?"
```

Expected: `exit=0` four times.

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml Cargo.lock crates/vault-search
git commit -F - <<'COMMIT'
feat(search): the vault-search crate, the query tree and the parser

A scannerless recursive-descent parser reads Obsidian's whole search grammar into a Query tree: words, quoted phrases with escaped quotes, regular expressions, implicit AND, OR binding looser than AND as the help page shows, parentheses, negation of words, groups and operators, the twelve operators with words, phrases, regexes or sub-queries, and property search with null and comparisons. Malformed queries are refused with a character position. A printer gives the canonical spelling, and printing then parsing round-trips. Every query on the published help page parses.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 2: The matcher — needles, JavaScript-style case folding, byte spans and UTF-16 positions

One `Needle` per term finds every non-overlapping occurrence in a haystack and answers byte spans into the **original** text. Case-insensitive needles fold both sides the way JavaScript's `toLowerCase` does (P3), through a byte-offset map; a match that starts or ends inside the fold of one original character is widened to that whole character. `LineIndex` converts a byte offset to an Obsidian `Loc` (`line` zero-based, `col` and `offset` in UTF-16 units). An ASCII-haystack fast path is allowed because a property test pins it to the reference.

**Files:**

- Create: `crates/vault-search/src/text.rs`, `crates/vault-search/tests/text.rs`
- Modify: `crates/vault-search/src/lib.rs` (add `pub mod text;`)

**Interfaces:**

- Consumes: nothing from Task 1 but the crate.
- Produces:

```rust
pub mod text {
    #[derive(Debug)]
    pub struct Needle { /* private: the needle, its fold, the sensitivity; a regex from Task 11 */ }
    impl Needle {
        /// A literal needle; `sensitive` false folds both sides.
        pub fn text(needle: &str, sensitive: bool) -> Needle;
        pub fn find_all(&self, haystack: &str) -> Vec<std::ops::Range<usize>>;
        pub fn is_match(&self, haystack: &str) -> bool;
        /// The fold-and-map reference, for the fast-path property test.
        #[doc(hidden)] pub fn find_all_reference(&self, haystack: &str) -> Vec<std::ops::Range<usize>>;
    }
    /// JavaScript `toLowerCase` per character, with the final-sigma rule.
    pub fn fold_js(text: &str) -> String;
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct Loc { pub line: usize, pub col: usize, pub offset: usize }
    pub struct LineIndex<'a> { /* private */ }
    impl<'a> LineIndex<'a> {
        pub fn new(text: &'a str) -> Self;
        pub fn loc(&self, byte: usize) -> Loc;
        /// The byte range of the line holding `byte`, without its line break.
        pub fn line_range(&self, byte: usize) -> std::ops::Range<usize>;
    }
    pub fn utf16_len(text: &str) -> usize;
}
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-search/tests/text.rs`:

```rust
use std::ops::Range;

use proptest::prelude::*;
use vault_search::text::{LineIndex, Loc, Needle, fold_js, utf16_len};

const NONE: Vec<Range<usize>> = Vec::new();

#[test]
fn insensitive_match_finds_every_occurrence_case_folded() {
    assert_eq!(Needle::text("Meet", false).find_all("meeting MEET meet"), vec![0..4, 8..12, 13..17]);
}

#[test]
fn sensitive_match_is_exact() {
    assert_eq!(Needle::text("Meet", true).find_all("meeting MEET Meet"), vec![13..17]);
}

#[test]
fn matches_do_not_overlap() {
    assert_eq!(Needle::text("aa", false).find_all("aaaa"), vec![0..2, 2..4]);
}

#[test]
fn spans_point_into_the_original_after_a_length_changing_fold() {
    // "İ" (2 bytes) folds to "i" + U+0307, so "ist" does not match at the start.
    assert_eq!(Needle::text("ist", false).find_all("İstanbul ist"), vec![10..13]);
    // The Kelvin sign (3 bytes) folds to "k".
    assert_eq!(Needle::text("kelvin", false).find_all("\u{212A}elvin"), vec![0..8]);
    assert_eq!(Needle::text("kelvin", true).find_all("\u{212A}elvin"), NONE);
}

#[test]
fn a_match_inside_one_characters_fold_is_widened_to_the_character() {
    assert_eq!(Needle::text("i", false).find_all("İ"), vec![0..2]);
}

#[test]
fn diacritics_and_normalization_are_not_folded() {
    // P4: provisional until captured.
    assert_eq!(Needle::text("cafe", false).find_all("café"), NONE);
    assert_eq!(Needle::text("caf\u{e9}", false).find_all("cafe\u{301}"), NONE);
}

#[test]
fn final_sigma_folds_as_javascript_does() {
    // "οδος" ending in the final sigma U+03C2, written with escapes so no
    // editor can swap it for U+03C3.
    let final_form = "\u{3bf}\u{3b4}\u{3bf}\u{3c2}";
    assert_eq!(fold_js("\u{39f}\u{394}\u{39f}\u{3a3}"), final_form);
    assert_eq!(fold_js("\u{39f}\u{394}\u{39f}\u{3a3} \u{39f}\u{394}\u{39f}\u{3a3}."), format!("{final_form} {final_form}."));
    assert_eq!(fold_js("\u{3a3}\u{391}"), "\u{3c3}\u{3b1}", "a sigma before a letter is the medial form");
}

#[test]
fn loc_counts_utf16_units_per_line() {
    let text = "a😀b\nxé y";
    let index = LineIndex::new(text);
    assert_eq!(index.loc(5), Loc { line: 0, col: 3, offset: 3 });
    assert_eq!(index.loc(11), Loc { line: 1, col: 3, offset: 8 });
    assert_eq!(index.line_range(11), 7..12);
    assert_eq!(index.loc(text.len()), Loc { line: 1, col: 4, offset: 9 });
    assert_eq!(utf16_len("😀é"), 3);
}

#[test]
fn a_crlf_line_break_ends_the_line_before_the_carriage_return() {
    let index = LineIndex::new("ab\r\ncd");
    assert_eq!(index.line_range(0), 0..2);
    assert_eq!(index.loc(4), Loc { line: 1, col: 0, offset: 4 });
}

proptest! {
    #[test]
    fn fast_path_equals_reference(haystack in "[ -~\n]{0,200}", needle in "[ -~]{1,4}") {
        // The fast path exists only for an insensitive needle over an ASCII
        // haystack. A sensitive needle runs the same `match_indices` in both
        // finders, so drawing one here would compare a function with itself.
        let needle = Needle::text(&needle, false);
        prop_assert_eq!(needle.find_all(&haystack), needle.find_all_reference(&haystack));
    }

    #[test]
    fn spans_are_char_boundaries_of_the_original_and_fold_to_the_needle(
        haystack in "[a-zA-Z İıK\u{212A}ßẞé\u{301}😀σΟ]{1,40}",
        from in 0usize..40,
        len in 1usize..6,
    ) {
        let chars: Vec<char> = haystack.chars().collect();
        let from = from % chars.len();
        let needle: String = chars[from..(from + len).min(chars.len())].iter().collect();
        let spans = Needle::text(&needle, false).find_all(&haystack);
        prop_assert!(!spans.is_empty(), "the leftmost occurrence is always found");
        let folded_needle = fold_js(&needle);
        for span in spans {
            prop_assert!(haystack.is_char_boundary(span.start) && haystack.is_char_boundary(span.end));
            prop_assert!(fold_js(&haystack[span.clone()]).contains(&folded_needle), "{:?} in {:?}", span, haystack);
        }
    }
}
```

The second property's alphabet leaves out `Σ`, whose fold depends on its neighbours, so a slice's fold could differ from its fold in context; `final_sigma_folds_as_javascript_does` covers it.

Create `src/text.rs` with the signatures above as `unimplemented!()`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test text; echo "exit=$?"`

Expected: every test fails at `unimplemented!()`, `exit=101`.

- [ ] **Step 3: Implement**

`fold_js` lowercases per character with `char::to_lowercase`, except that `Σ` becomes `ς` (U+03C2) when the previous character is alphabetic and the next one is not, the final-sigma context JavaScript applies (approximated by `is_alphabetic`; P3 lists it for capture), and `σ` otherwise. The reference finder folds the haystack into a `String` and a `Vec<usize>` with one entry per folded byte holding the byte offset of the original character that produced it; it folds the needle the same way; it runs `str::match_indices` on the folded pair; and it maps each folded `[s, e)` to an original span whose start is the start of the character that produced folded byte `s` and whose end is the end of the character that produced folded byte `e - 1`, so a match inside a character's expansion covers the whole character. A widened span that overlaps the previous one is merged into it, so spans stay non-overlapping and sorted.

```rust
pub fn find_all_reference(&self, haystack: &str) -> Vec<Range<usize>> {
    if self.needle.is_empty() {
        return Vec::new();
    }
    if self.sensitive {
        return haystack.match_indices(self.needle.as_str()).map(|(at, m)| at..at + m.len()).collect();
    }
    let (folded, map) = fold_with_map(haystack);
    let mut spans: Vec<Range<usize>> = Vec::new();
    for (at, m) in folded.match_indices(self.folded.as_str()) {
        let start = map[at];
        let last = map[at + m.len() - 1];
        let end = last + haystack[last..].chars().next().map_or(0, char::len_utf8);
        match spans.last_mut() {
            Some(previous) if previous.end > start => previous.end = previous.end.max(end),
            _ => spans.push(start..end),
        }
    }
    spans
}
```

`find_all` takes the fast path when the needle is not sensitive and the haystack is ASCII (every ASCII character folds to one ASCII byte, so the map is the identity): it runs `match_indices` on `haystack.to_ascii_lowercase()` with the folded needle and answers the indices directly. Otherwise it calls the reference. An empty needle answers no spans (the parser never produces one). `is_match` is `!find_all(..).is_empty()`; Task 9 may give it a short-circuiting body if the baseline asks for it, pinned by the same property test.

`LineIndex::new` records the byte offset of every line start (after each `\n`) and the UTF-16 offset of the same starts. `loc(byte)` binary-searches the line, takes `col = utf16_len(&text[start..byte])` and `offset = u16_start + col`; a `byte` that is not a character boundary is a caller bug and panics with the offset in the message. `line_range(byte)` runs from the line's start to the next `\n`, minus a `\r` immediately before it.

- [ ] **Step 4: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test text; echo "exit=$?"`

Expected: `test result: ok. 11 passed`, `exit=0`.

- [ ] **Step 5: The gates** — as Task 1 Step 6.

- [ ] **Step 6: Commit**

```bash
git add crates/vault-search
git commit -F - <<'COMMIT'
feat(search): needles, JavaScript-style folding, byte spans and UTF-16 positions

A Needle finds every non-overlapping occurrence of a term and answers byte spans into the original text, never into a folded copy: case-insensitive needles fold both sides by JavaScript's toLowerCase per character, with the final-sigma rule, through a byte-offset map, and a match inside one character's fold is widened to that character. An ASCII-haystack fast path is pinned to the reference by a property test, and a second property pins every span to character boundaries whose text folds to the needle. LineIndex converts a byte offset to Obsidian's Loc in UTF-16 units.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 3: Compile and evaluate — the MVP scopes, case modes, the file universe, spans, and the six sorts

`compile` turns a `Query` into a `CompiledQuery`: every term gets its `Needle` with its resolved case mode (the request's toggle, overridden by the nearest `match-case:` or `ignore-case:`), every construct the MVP does not evaluate is refused with `CompileError::Unsupported` naming it, and `needs()` says which facets a document must carry. `evaluate` decides one `SearchDocument` and answers a `FileHit` with its spans. `sort_hits` implements the six orders. Everything here runs over `MemoryDocument`s; the daemon's documents arrive in Task 4.

The semantics, each tied to the design: a term in the default scope matches a note's text or its path (P1 substring, P2 path), and never an attachment's; `content:` the text only; `file:` the file name, the last path segment with its extension; `path:` the whole path; `tag:` a tag equal to the operand or a descendant of it, ignoring case and a leading `#` (P9); a non-note file is a candidate only when a positive `file:` or `path:` scope occurs in the query, at an even depth of negation (P10); the spans of a matching file are every occurrence of every term that is not under a negation and that sits in a branch that holds for the file (in `(a b) OR c` over a text with `a` and `c` only `c` is highlighted), within that term's scope (P18), merged where they overlap, capped at `MAX_MATCHES_PER_FILE` (100) content matches with the true count kept. A positive `tag:` term needs the text as well as the tags, because a tag match is a content match whose `Loc`s are computed from the text; the prefilter still skips every note whose tags fail, so only tagged notes' bodies are read.

**Files:**

- Create: `crates/vault-search/src/compile.rs`, `crates/vault-search/src/document.rs`, `crates/vault-search/src/evaluate.rs`, `crates/vault-search/src/sort.rs`
- Create: `crates/vault-search/tests/evaluate.rs`, `crates/vault-search/tests/sort.rs`
- Modify: `crates/vault-search/src/lib.rs` (modules and re-exports: `pub use compile::{CompileError, CompiledQuery, Needs, compile}; pub use document::{DocumentKind, MemoryDocument, SearchDocument, TagFact}; pub use evaluate::{ContentMatch, FileHit, MAX_MATCHES_PER_FILE, evaluate}; pub use sort::{SortOrder, Times, sort_hits};`)

**Interfaces:**

- Consumes: `Query`, `Node`, `Term`, `Pattern`, `Scope`, `QueryError`, `parse_query` (Task 1); `Needle`, `fold_js`, `LineIndex`, `Loc`, `utf16_len` (Task 2); `vault_core::VaultPath`; `vault_bases::collate::collate_strictly`.
- Produces:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum DocumentKind { Note, /** Reserved: never produced in this phase (Ruling 4, issue #3). */ Canvas, File }
#[derive(Clone, Debug, PartialEq)]
pub struct TagFact { pub value: String, pub span: std::ops::Range<usize> } // value without `#`
pub trait SearchDocument {
    fn path(&self) -> &VaultPath;
    fn kind(&self) -> DocumentKind;
    /// The searchable text; `None` for a non-note file, or when not loaded.
    fn text(&self) -> Option<&str>;
    fn tags(&self) -> &[TagFact];
}
#[derive(Clone, Debug)]
pub struct MemoryDocument { pub path: VaultPath, pub kind: DocumentKind, pub text: Option<String>, pub tags: Vec<TagFact> }
impl MemoryDocument {
    pub fn note(path: &str, text: &str) -> Self;
    pub fn file(path: &str) -> Self;
    pub fn with_tag(self, value: &str, span: std::ops::Range<usize>) -> Self;
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Needs { pub text: bool, pub tags: bool }
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum CompileError {
    #[error("{what} is not supported by this build (at character {position})")]
    Unsupported { what: String, position: usize },
    #[error(transparent)]
    Invalid(#[from] QueryError),
}
#[derive(Debug)]
pub struct CompiledQuery { /* private */ }
impl CompiledQuery {
    pub fn is_empty(&self) -> bool;
    pub fn needs(&self) -> Needs;
    pub fn reaches_files(&self) -> bool;
    /// The canonical spelling and the case toggle: the cache key's query part.
    pub fn canonical(&self) -> &str;
    pub fn match_case(&self) -> bool;
    /// False only when a top-level conjunct that reads no text (`file:`,
    /// `path:`, `tag:`) rejects the document, or the file universe excludes
    /// it. Never reads `text()`.
    pub fn prefilter(&self, doc: &dyn SearchDocument) -> bool;
}
pub fn compile(query: &Query, match_case: bool) -> Result<CompiledQuery, CompileError>;
/// 100, so a default page (100 files) with line text stays near 7 MB, inside
/// the protocol's 16 MiB payload cap; 1000 would put it near 66 MB.
pub const MAX_MATCHES_PER_FILE: usize = 100;
#[derive(Clone, Debug, PartialEq)]
pub struct ContentMatch { pub span: std::ops::Range<usize>, pub start: Loc, pub end: Loc }
#[derive(Clone, Debug, PartialEq)]
pub struct FileHit {
    pub path: VaultPath,
    pub kind: DocumentKind,
    /// UTF-16 offsets into the path string.
    pub path_matches: Vec<std::ops::Range<usize>>,
    pub content_matches: Vec<ContentMatch>,
    /// Every content and path match, before the cap.
    pub total_matches: usize,
    pub matches_truncated: bool,
}
pub fn evaluate(query: &CompiledQuery, doc: &dyn SearchDocument) -> Option<FileHit>;
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum SortOrder { #[default] FileNameAsc, FileNameDesc, ModifiedDesc, ModifiedAsc, CreatedDesc, CreatedAsc }
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Times { pub mtime_ms: i64, pub ctime_ms: i64 }
pub fn sort_hits(hits: &mut [FileHit], order: SortOrder, times: &dyn Fn(&VaultPath) -> Times);
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-search/tests/evaluate.rs`:

```rust
use vault_search::text::Loc;
use vault_search::{
    CompileError, ContentMatch, FileHit, MAX_MATCHES_PER_FILE, MemoryDocument, Needs, compile, evaluate,
    parse_query,
};

fn hits_case(query: &str, match_case: bool, docs: &[MemoryDocument]) -> Vec<FileHit> {
    let compiled = compile(&parse_query(query).unwrap(), match_case).unwrap_or_else(|e| panic!("{query:?}: {e:?}"));
    docs.iter().filter_map(|doc| evaluate(&compiled, doc)).collect()
}
fn hits(query: &str, docs: &[MemoryDocument]) -> Vec<FileHit> {
    hits_case(query, false, docs)
}
fn paths(query: &str, docs: &[MemoryDocument]) -> Vec<String> {
    hits(query, docs).into_iter().map(|hit| hit.path.as_str().to_string()).collect()
}
fn spans(hit: &FileHit) -> Vec<std::ops::Range<usize>> {
    hit.content_matches.iter().map(|m| m.span.clone()).collect()
}

fn meetings() -> Vec<MemoryDocument> {
    vec![
        MemoryDocument::note("a.md", "meeting at work"),
        MemoryDocument::note("b.md", "meeting"),
        MemoryDocument::note("c.md", "homework"),
        MemoryDocument::note("d.md", "meetup personal"),
        MemoryDocument::note("e.md", "meeting work meetup"),
    ]
}

#[test]
fn plain_words_and_together_by_substring() {
    assert_eq!(paths("meeting work", &meetings()), ["a.md", "e.md"]);
    assert_eq!(paths("work", &meetings()), ["a.md", "c.md", "e.md"], "P1: substring");
}

#[test]
fn or_grouping_and_negation_follow_the_help_page() {
    assert_eq!(paths("meeting work OR meetup personal", &meetings()), ["a.md", "d.md", "e.md"]);
    assert_eq!(paths("meeting -work", &meetings()), ["b.md"]);
    assert_eq!(paths("meeting -(work meetup)", &meetings()), ["a.md", "b.md"], "not both");
}

#[test]
fn a_plain_term_matches_a_notes_path_and_content_does_not() {
    let docs = [MemoryDocument::note("Projects/Alpha.md", "x")];
    let found = hits("alpha", &docs);
    assert_eq!(found.len(), 1, "P2: the path of a note is searched");
    assert_eq!(found[0].path_matches, vec![9..14]);
    assert!(found[0].content_matches.is_empty());
    assert!(hits("content:alpha", &docs).is_empty());
}

#[test]
fn file_matches_the_name_with_its_extension_and_path_the_whole_path() {
    let docs = [
        MemoryDocument::note("img/notes.md", ""),
        MemoryDocument::file("img/cat.png"),
        MemoryDocument::file("img/dog.png"),
    ];
    assert_eq!(paths("file:.png", &docs), ["img/cat.png", "img/dog.png"]);
    assert_eq!(hits("file:.png", &docs)[0].path_matches, vec![7..11], "UTF-16 offsets into the path");
    assert!(paths("file:img", &docs).is_empty(), "the folder is not the name");
    assert_eq!(paths("path:img", &docs), ["img/notes.md", "img/cat.png", "img/dog.png"]);
}

#[test]
fn a_negated_query_reaches_attachments_only_through_a_positive_file_or_path_term() {
    let docs = [
        MemoryDocument::note("img/notes.md", "cat"),
        MemoryDocument::file("img/cat.png"),
        MemoryDocument::file("img/dog.png"),
    ];
    assert_eq!(paths("-foo", &docs), ["img/notes.md"], "P10");
    assert_eq!(paths("-file:.png", &docs), ["img/notes.md"]);
    assert_eq!(paths("file:.png -file:cat", &docs), ["img/dog.png"]);
    assert_eq!(paths("-(-path:img)", &docs), ["img/notes.md", "img/cat.png", "img/dog.png"], "an even depth is positive");
    assert_eq!(paths("cat", &docs), ["img/notes.md"], "a default-scope term never matches an attachment");
}

#[test]
fn tag_matches_itself_and_its_descendants_but_not_a_suffix() {
    let docs = [
        MemoryDocument::note("t1.md", "#work").with_tag("work", 0..5),
        MemoryDocument::note("t2.md", "#work/meeting").with_tag("work/meeting", 0..13),
        MemoryDocument::note("t3.md", "#myjob/work").with_tag("myjob/work", 0..11),
        MemoryDocument::note("t4.md", "#Work").with_tag("Work", 0..5),
    ];
    for query in ["tag:#work", "tag:work", "tag:WORK"] {
        assert_eq!(paths(query, &docs), ["t1.md", "t2.md", "t4.md"], "{query}");
    }
    assert_eq!(paths("tag:#work/meeting", &docs), ["t2.md"]);
    assert_eq!(spans(&hits("tag:work", &docs)[0]), vec![0..5], "a tag's span is the tag");
}

#[test]
fn the_case_toggle_and_the_case_operators() {
    let docs = [MemoryDocument::note("h.md", "HappyCat happycat")];
    assert_eq!(spans(&hits_case("happycat", true, &docs)[0]), vec![9..17]);
    assert_eq!(spans(&hits_case("ignore-case:HAPPYCAT", true, &docs)[0]), vec![0..8, 9..17]);
    assert_eq!(spans(&hits_case("match-case:HappyCat", false, &docs)[0]), vec![0..8]);
    assert_eq!(spans(&hits_case("HAPPYCAT", false, &docs)[0]), vec![0..8, 9..17]);
}

#[test]
fn spans_come_only_from_terms_outside_a_negation() {
    let docs = [MemoryDocument::note("m.md", "meeting notes")];
    assert_eq!(spans(&hits("meeting -work", &docs)[0]), vec![0..7]);
    assert_eq!(spans(&hits("meeting OR zzz", &docs)[0]), vec![0..7]);
    assert_eq!(spans(&hits("notes -(meeting zzz)", &docs)[0]), vec![8..13]);
}

#[test]
fn spans_come_only_from_branches_that_hold() {
    let docs = [MemoryDocument::note("o.md", "a c")];
    assert_eq!(spans(&hits("(a b) OR c", &docs)[0]), vec![2..3], "the branch `a b` fails, so its `a` adds no span");
}

#[test]
fn a_content_match_carries_utf16_locs() {
    let found = hits("meeting", &[MemoryDocument::note("l.md", "one\ntwo meeting")]);
    assert_eq!(
        found[0].content_matches,
        vec![ContentMatch {
            span: 8..15,
            start: Loc { line: 1, col: 4, offset: 8 },
            end: Loc { line: 1, col: 11, offset: 15 },
        }]
    );
}

#[test]
fn content_matches_are_capped_and_the_true_count_is_kept() {
    let found = hits("a", &[MemoryDocument::note("x.md", &"a ".repeat(150))]);
    assert_eq!(found[0].content_matches.len(), MAX_MATCHES_PER_FILE);
    assert!(found[0].matches_truncated);
    assert_eq!(found[0].total_matches, 150);
}

#[test]
fn an_empty_query_matches_nothing() {
    let compiled = compile(&parse_query("   ").unwrap(), false).unwrap();
    assert!(compiled.is_empty());
    assert!(meetings().iter().all(|doc| evaluate(&compiled, doc).is_none()));
}

#[test]
fn every_parity_operator_is_refused_by_name_in_the_mvp() {
    for (query, what, position) in [
        ("line:(a)", "line:", 0),
        ("block:(a)", "block:", 0),
        ("section:(a)", "section:", 0),
        ("x task:a", "task:", 2),
        ("task-todo:a", "task-todo:", 0),
        ("task-done:a", "task-done:", 0),
        ("a [prop]", "property search", 2),
        ("/re/", "regular expression", 0),
        ("path:/re/", "regular expression", 5),
    ] {
        match compile(&parse_query(query).unwrap(), false) {
            Err(CompileError::Unsupported { what: got, position: at }) => {
                assert!(got.contains(what), "{query}: {got}");
                assert_eq!(at, position, "{query}");
            }
            other => panic!("{query}: expected Unsupported, got {other:?}"),
        }
    }
}

#[test]
fn needs_and_the_file_universe_are_computed_from_the_tree() {
    let needs = |q: &str| compile(&parse_query(q).unwrap(), false).unwrap().needs();
    assert_eq!(needs("file:x"), Needs { text: false, tags: false });
    // A tag match is a content match: its Locs need the text.
    assert_eq!(needs("tag:x"), Needs { text: true, tags: true });
    assert_eq!(needs("-tag:x"), Needs { text: false, tags: true }, "a negated term adds no span");
    assert_eq!(needs("x"), Needs { text: true, tags: false });
    assert_eq!(needs("x -tag:y"), Needs { text: true, tags: true });
    let reaches = |q: &str| compile(&parse_query(q).unwrap(), false).unwrap().reaches_files();
    assert!(reaches("file:x"));
    assert!(!reaches("-file:x"));
    assert!(reaches("-(-path:x)"));
    assert!(!reaches("x"));
}

#[test]
fn the_prefilter_rejects_only_on_metadata_and_never_reads_text() {
    let compiled = compile(&parse_query("meeting tag:work file:.md").unwrap(), false).unwrap();
    let tagged = MemoryDocument { text: None, ..MemoryDocument::note("a.md", "").with_tag("work", 0..5) };
    let untagged = MemoryDocument { text: None, ..MemoryDocument::note("b.md", "") };
    assert!(compiled.prefilter(&tagged), "the text conjunct is skipped, not failed");
    assert!(!compiled.prefilter(&untagged));
    assert!(!compiled.prefilter(&MemoryDocument::file("c.png")), "no tag");
    let notes_only = compile(&parse_query("meeting").unwrap(), false).unwrap();
    assert!(!notes_only.prefilter(&MemoryDocument::file("c.png")), "the file universe");
}
```

Create `crates/vault-search/tests/sort.rs`:

```rust
use vault_core::VaultPath;
use vault_search::{DocumentKind, FileHit, SortOrder, Times, sort_hits};

fn hit(path: &str) -> FileHit {
    FileHit {
        path: VaultPath::new(path).unwrap(),
        kind: DocumentKind::Note,
        path_matches: vec![],
        content_matches: vec![],
        total_matches: 0,
        matches_truncated: false,
    }
}
fn sorted(paths: &[&str], order: SortOrder, times: &[(&str, i64, i64)]) -> Vec<String> {
    let mut hits: Vec<FileHit> = paths.iter().map(|p| hit(p)).collect();
    let lookup = |path: &VaultPath| {
        let (_, mtime_ms, ctime_ms) = times.iter().find(|(p, _, _)| *p == path.as_str()).copied().unwrap_or(("", 0, 0));
        Times { mtime_ms, ctime_ms }
    };
    sort_hits(&mut hits, order, &lookup);
    hits.into_iter().map(|h| h.path.as_str().to_string()).collect()
}

const NAMES: &[&str] = &["a/Zed.md", "Note 10.md", "b/zed.md", "note 1.md", "Note 2.md"];

#[test]
fn file_name_order_is_locale_compare_numeric_then_path() {
    // P15: vault_bases' localeCompare order, numeric, locale en.
    assert_eq!(sorted(NAMES, SortOrder::FileNameAsc, &[]), ["note 1.md", "Note 2.md", "Note 10.md", "b/zed.md", "a/Zed.md"]);
    assert_eq!(sorted(NAMES, SortOrder::FileNameDesc, &[]), ["a/Zed.md", "b/zed.md", "Note 10.md", "Note 2.md", "note 1.md"]);
}

#[test]
fn equal_names_tie_by_path_in_both_directions() {
    let paths = ["y/same.md", "x/same.md"];
    assert_eq!(sorted(&paths, SortOrder::FileNameAsc, &[]), ["x/same.md", "y/same.md"]);
    assert_eq!(sorted(&paths, SortOrder::FileNameDesc, &[]), ["x/same.md", "y/same.md"]);
}

#[test]
fn time_orders_tie_by_path() {
    let paths = ["p3.md", "p1.md", "p2.md"];
    let times = [("p1.md", 3, 10), ("p2.md", 1, 30), ("p3.md", 3, 20)];
    assert_eq!(sorted(&paths, SortOrder::ModifiedDesc, &times), ["p1.md", "p3.md", "p2.md"]);
    assert_eq!(sorted(&paths, SortOrder::ModifiedAsc, &times), ["p2.md", "p1.md", "p3.md"]);
    assert_eq!(sorted(&paths, SortOrder::CreatedDesc, &times), ["p2.md", "p3.md", "p1.md"]);
    assert_eq!(sorted(&paths, SortOrder::CreatedAsc, &times), ["p1.md", "p3.md", "p2.md"]);
}
```

`vault-core` is already a normal dependency, so the sort test needs no new dev-dependency. Create the four source files with the signatures above as `unimplemented!()`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test evaluate --test sort; echo "exit=$?"`

Expected: every test fails at `unimplemented!()`, `exit=101`.

- [ ] **Step 3: Documents** — write `document.rs`: the types above; `MemoryDocument::note` sets `kind: Note` and `text: Some(text)`, `file` sets `kind: File` and `text: None`; both parse the path with `VaultPath::new(..).expect(..)`; `with_tag` pushes a `TagFact`. `impl SearchDocument for MemoryDocument` returns the fields.

- [ ] **Step 4: Compile**

`compile.rs` mirrors the tree with a private `Compiled` enum whose term leaves carry what evaluation needs:

```rust
#[derive(Debug)]
pub(crate) enum Compiled {
    And(Vec<Compiled>),
    Or(Vec<Compiled>),
    Not(Box<Compiled>),
    Term(CompiledTerm),
    Scoped { scope: Scope, query: Box<Compiled> },
}
#[derive(Debug)]
pub(crate) struct CompiledTerm {
    pub needle: Needle,
    /// The text folded by `fold_js`, without a leading `#`: the tag-scope comparison key.
    pub tag_key: String,
}

pub fn compile(query: &Query, match_case: bool) -> Result<CompiledQuery, CompileError> {
    let root = match &query.root {
        None => None,
        Some(node) => Some(lower(node, match_case)?),
    };
    let mut needs = Needs::default();
    let mut reaches_files = false;
    if let Some(root) = &root {
        survey(root, Domain::Default, true, &mut needs, &mut reaches_files);
    }
    Ok(CompiledQuery { root, needs, reaches_files, canonical: query.to_string(), match_case })
}

fn lower(node: &Node, sensitive: bool) -> Result<Compiled, CompileError> {
    Ok(match node {
        Node::And(items) => Compiled::And(items.iter().map(|n| lower(n, sensitive)).collect::<Result<_, _>>()?),
        Node::Or(items) => Compiled::Or(items.iter().map(|n| lower(n, sensitive)).collect::<Result<_, _>>()?),
        Node::Not(inner) => Compiled::Not(Box::new(lower(inner, sensitive)?)),
        Node::Case { sensitive, query, .. } => lower(query, *sensitive)?,
        Node::Term(term) => Compiled::Term(lower_term(term, sensitive)?),
        Node::Scoped { scope, query, at } => match scope {
            Scope::File | Scope::Path | Scope::Content | Scope::Tag => {
                Compiled::Scoped { scope: *scope, query: Box::new(lower(query, sensitive)?) }
            }
            other => return Err(CompileError::Unsupported { what: format!("`{}:`", other.name()), position: at.start }),
        },
        Node::Property { at, .. } => {
            return Err(CompileError::Unsupported { what: "property search".into(), position: at.start });
        }
    })
}

fn lower_term(term: &Term, sensitive: bool) -> Result<CompiledTerm, CompileError> {
    match &term.pattern {
        Pattern::Text(text) => Ok(CompiledTerm {
            needle: Needle::text(text, sensitive),
            tag_key: fold_js(text.strip_prefix('#').unwrap_or(text)),
        }),
        Pattern::Regex { .. } => Err(CompileError::Unsupported { what: "regular expression".into(), position: term.at.start }),
    }
}
```

`survey` walks the compiled tree with the current domain (a `Scoped` node switches it: `File` to `Domain::Name`, `Path` to `Domain::Path`, `Content` to `Domain::Content`, `Tag` to `Domain::Tag`) and a `positive` flag flipped by each `Not`: a term in `Default` or `Content` sets `needs.text`, a term in `Tag` sets `needs.tags` and, when `positive`, `needs.text` too (its spans need the text for their `Loc`s), and a `Scoped` `File` or `Path` node reached while `positive` sets `reaches_files`. `canonical` returns the stored spelling; `is_empty` is `root.is_none()`.

`prefilter` returns `false` when the document is a `File` and `!reaches_files`; otherwise, when the root is an `And` (or a single node), it evaluates each top-level item that `survey` finds reads neither text (no `Default`- or `Content`-domain term inside it) and returns `false` if one of them is false; every other item is skipped. This is exact for the conjuncts it evaluates and silent on the rest, so it accepts a superset of what `evaluate` accepts. A `tag:` conjunct reads no text here (it reads `tags()`), so a tag-only query still loads the bodies of the notes whose tags pass and no others.

- [ ] **Step 5: Evaluate**

```rust
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Domain { Default, Content, Name, Path, Tag }

fn holds(node: &Compiled, doc: &dyn SearchDocument, domain: Domain) -> bool {
    match node {
        Compiled::And(items) => items.iter().all(|n| holds(n, doc, domain)),
        Compiled::Or(items) => items.iter().any(|n| holds(n, doc, domain)),
        Compiled::Not(inner) => !holds(inner, doc, domain),
        Compiled::Scoped { scope, query } => holds(query, doc, scope_domain(*scope)),
        Compiled::Term(term) => term_holds(term, doc, domain),
    }
}

fn term_holds(term: &CompiledTerm, doc: &dyn SearchDocument, domain: Domain) -> bool {
    let is_note = doc.kind() != DocumentKind::File;
    match domain {
        Domain::Default => {
            doc.text().is_some_and(|t| term.needle.is_match(t)) || (is_note && term.needle.is_match(doc.path().as_str()))
        }
        Domain::Content => doc.text().is_some_and(|t| term.needle.is_match(t)),
        Domain::Name => term.needle.is_match(file_name(doc.path())),
        Domain::Path => term.needle.is_match(doc.path().as_str()),
        Domain::Tag => doc.tags().iter().any(|tag| tag_matches(&term.tag_key, &tag.value)),
    }
}

/// P9: the tag itself or a descendant, ignoring case and a leading `#`.
fn tag_matches(key: &str, tag: &str) -> bool {
    let tag = fold_js(tag);
    tag == key || (tag.len() > key.len() && tag.starts_with(key) && tag.as_bytes()[key.len()] == b'/')
}

pub fn evaluate(query: &CompiledQuery, doc: &dyn SearchDocument) -> Option<FileHit> {
    let root = query.root.as_ref()?;
    if doc.kind() == DocumentKind::File && !query.reaches_files {
        return None;
    }
    if !holds(root, doc, Domain::Default) {
        return None;
    }
    let mut collector = Collector::default();
    collect(root, doc, Domain::Default, true, &mut collector);
    Some(collector.finish(doc))
}
```

`collect` walks the same tree with the `positive` flag and descends only into what holds for the document: an `Or` item or a scope whose `holds` is false adds nothing (an `And` that is collected holds in every item, and under a `Not` nothing is added anyway); at a positive term it adds, by domain: `Default` — every `find_all` span in the text (content) and, for a note, in the path (path); `Content` — text spans; `Name` — spans in the file name, shifted by the name's byte offset in the path; `Path` — path spans; `Tag` — the `span` of every tag `tag_matches` accepts (content). `Collector::finish` sorts each list by start, merges overlapping spans, counts them into `total_matches` (content plus path), converts path byte spans to UTF-16 offsets with `utf16_len` of the prefix, keeps the first `MAX_MATCHES_PER_FILE` content spans and sets `matches_truncated` when more existed, and builds each `ContentMatch`'s `start` and `end` with one `LineIndex` over the text. `file_name` (the path after its last `/`) is one `pub(crate) fn file_name(path: &VaultPath) -> &str` in `document.rs`, used by `evaluate.rs` and `sort.rs`.

- [ ] **Step 6: Sort**

```rust
pub fn sort_hits(hits: &mut [FileHit], order: SortOrder, times: &dyn Fn(&VaultPath) -> Times) {
    let by_path = |a: &FileHit, b: &FileHit| a.path.as_str().cmp(b.path.as_str());
    let name = |h: &FileHit| file_name(&h.path).to_string();
    match order {
        SortOrder::FileNameAsc => hits.sort_by(|a, b| collate_strictly(&name(a), &name(b)).then_with(|| by_path(a, b))),
        SortOrder::FileNameDesc => hits.sort_by(|a, b| collate_strictly(&name(b), &name(a)).then_with(|| by_path(a, b))),
        SortOrder::ModifiedDesc => hits.sort_by(|a, b| times(&b.path).mtime_ms.cmp(&times(&a.path).mtime_ms).then_with(|| by_path(a, b))),
        SortOrder::ModifiedAsc => hits.sort_by(|a, b| times(&a.path).mtime_ms.cmp(&times(&b.path).mtime_ms).then_with(|| by_path(a, b))),
        SortOrder::CreatedDesc => hits.sort_by(|a, b| times(&b.path).ctime_ms.cmp(&times(&a.path).ctime_ms).then_with(|| by_path(a, b))),
        SortOrder::CreatedAsc => hits.sort_by(|a, b| times(&a.path).ctime_ms.cmp(&times(&b.path).ctime_ms).then_with(|| by_path(a, b))),
    }
}
```

The `name` closure allocates per comparison; replace it with `sort_by_cached_key` over `(name, path)` if Task 9's baseline shows the sort in the profile, keeping these tests green.

- [ ] **Step 7: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search; echo "exit=$?"`

Expected: `parse` 11, `text` 11, `evaluate` 15, `sort` 3 passed, `exit=0`. If `file_name_order_is_locale_compare_numeric_then_path` disagrees about `zed` against `Zed`, read `vault_bases::collate::collate_strictly`'s documented tie order and correct the test's expectation to it, saying so in the commit body: the rule is "the Bases collation", not a new one.

- [ ] **Step 8: The gates** — as Task 1 Step 6.

- [ ] **Step 9: Commit**

```bash
git add crates/vault-search
git commit -F - <<'COMMIT'
feat(search): compile and evaluate the MVP scopes, with spans and the six sorts

compile resolves each term's case mode from the toggle and the nearest match-case: or ignore-case:, refuses every construct the MVP does not evaluate by name (the structural scopes, property search, regular expressions), and computes which facets a document must carry. evaluate decides one document: default-scope terms over a note's text and path, content:, file: over the file name, path:, and tag: over a tag and its descendants; a non-note file is reached only through a positive file: or path: term; the spans are every occurrence of every non-negated term, merged and capped with the true count kept, with UTF-16 locations. sort_hits implements Obsidian's six orders, the name orders with the Bases localeCompare collation.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 4: `IndexReader::search` — an exact scan on the pinned read, metadata narrowing, and match contexts

The daemon's document source. `search` pins the published generation on a private pooled connection under the publication guard (the eighth read shape in `reader.rs`, which Bases evaluation built), releases the guard, and scans: it reads every non-folder `tree_entries` row (path, kind, times) and, when the query needs tags, every `tags` row; it runs `CompiledQuery::prefilter` over each file with no text loaded; it reads `notes.source_bytes` for the surviving notes only when the query needs text; it evaluates each candidate and sorts the hits. Nothing is cached here and nothing is written. `match_contexts` reads the line text around a page's matches at a named generation, refusing with `GenerationMismatch` when that generation is no longer published.

**Files:**

- Create: `crates/vault-index/src/query/search.rs`, `crates/vault-index/tests/search_query.rs`
- Modify: `crates/vault-index/src/query.rs` (`pub(crate) mod search;`, as `pub(crate) mod bases;` is), `crates/vault-index/src/lib.rs` (exports), `crates/vault-index/src/reader.rs` (`evaluation_read_current`), `crates/vault-index/Cargo.toml` (`vault-search = { path = "../vault-search" }`; `filetime` is already a normal dependency, which the integration tests see, so no dev-dependency is added)

**Interfaces:**

- Consumes: `vault_search::{CompiledQuery, SearchDocument, DocumentKind, TagFact, FileHit, SortOrder, Times, evaluate, sort_hits}`, `vault_search::text::LineIndex` (Tasks 2–3); `IndexReader::pin_evaluation`, `EvaluationRead`, `Generation`, `IndexError::GenerationMismatch` (existing).
- Produces:

```rust
pub struct SearchQuery<'a> { pub compiled: &'a CompiledQuery, pub sort: SortOrder }
#[derive(Clone, Debug)]
pub struct SearchAnswer {
    pub generation: Generation,
    pub hits: Vec<FileHit>,
    /// Note bodies read for this answer: a work counter, for tests and the baseline.
    pub texts_read: usize,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchContext { pub line_text: String, pub line_text_start: usize }
pub const MAX_LINE_TEXT_BYTES: usize = 512;
impl IndexReader {
    pub fn search(&self, query: &SearchQuery<'_>) -> Result<SearchAnswer, IndexError>;
    /// One context per requested span, in request order, read at `generation`.
    pub fn match_contexts(&self, generation: Generation, wanted: &[(VaultPath, Vec<Range<usize>>)]) -> Result<Vec<Vec<MatchContext>>, IndexError>;
    #[doc(hidden)] pub fn search_unnarrowed_for_test(&self, query: &SearchQuery<'_>) -> Result<SearchAnswer, IndexError>;
}
// reader.rs, crate-private:
pub(crate) fn evaluation_read_current<T>(&self, under_guard: impl FnOnce(&LiveGraph) -> T) -> Result<(EvaluationRead<'_>, T), IndexError>;
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-index/tests/search_query.rs`:

```rust
mod common;

use std::fs;
use std::thread;

use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{IndexConfig, IndexError, IndexService, MatchContext, SearchQuery};
use vault_search::{DocumentKind, SortOrder, compile, parse_query};

fn vp(path: &str) -> VaultPath {
    VaultPath::new(path).unwrap()
}

fn service(files: &[(&str, &[u8])]) -> (IndexService, TempDir, TempDir) {
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

fn found(service: &IndexService, query: &str) -> Vec<(String, DocumentKind)> {
    let compiled = compile(&parse_query(query).unwrap(), false).unwrap();
    let answer = service.reader().unwrap().search(&SearchQuery { compiled: &compiled, sort: SortOrder::FileNameAsc }).unwrap();
    answer.hits.into_iter().map(|h| (h.path.as_str().to_string(), h.kind)).collect()
}

const KICKOFF: &[u8] = b"The meeting ran long.\n#project\n";

#[test]
fn search_answers_notes_and_attachments_at_the_published_generation() {
    let (service, _vault, _index) = service(&[
        ("Notes/Kickoff.md", KICKOFF),
        ("Notes/Other.md", b"work\n"),
        ("img/cat.png", b"\x89PNG"),
    ]);
    assert_eq!(found(&service, "meeting"), [("Notes/Kickoff.md".to_string(), DocumentKind::Note)]);
    assert_eq!(found(&service, "file:.png"), [("img/cat.png".to_string(), DocumentKind::File)]);
    let compiled = compile(&parse_query("meeting").unwrap(), false).unwrap();
    let reader = service.reader().unwrap();
    let answer = reader.search(&SearchQuery { compiled: &compiled, sort: SortOrder::FileNameAsc }).unwrap();
    assert_eq!(Some(answer.generation), reader.published_status().unwrap().generation);
    assert_eq!(answer.hits[0].content_matches[0].span, 4..11);
}

#[test]
fn body_and_frontmatter_tags_come_from_the_index() {
    let (service, _vault, _index) = service(&[("t.md", b"---\ntags: [alpha]\n---\n#beta\n")]);
    assert_eq!(found(&service, "tag:alpha").len(), 1);
    assert_eq!(found(&service, "tag:#beta").len(), 1);
    assert!(found(&service, "tag:alp").is_empty(), "a tag is matched whole, not by substring");
}

#[test]
fn a_tag_only_query_reports_located_spans_and_reads_only_tagged_bodies() {
    let (service, _vault, _index) = service(&[("Notes/Kickoff.md", KICKOFF), ("Notes/Other.md", b"meeting\n")]);
    let compiled = compile(&parse_query("tag:#project").unwrap(), false).unwrap();
    let answer = service.reader().unwrap().search(&SearchQuery { compiled: &compiled, sort: SortOrder::FileNameAsc }).unwrap();
    let first = &answer.hits[0].content_matches[0];
    // "The meeting ran long.\n" is 22 bytes; a body tag's span includes its `#`.
    assert_eq!(first.span, 22..30);
    assert_eq!((first.start.line, first.start.col), (1, 0));
    assert_eq!(answer.texts_read, 1, "the untagged note's body is not read");
}

#[test]
fn a_note_with_no_stored_body_searches_as_empty_text() {
    // An `.md` file that is not UTF-8 is diagnosed and its body is not stored.
    let (service, _vault, _index) = service(&[("bad.md", b"meeting \xff\n"), ("good.md", b"meeting\n")]);
    let paths: Vec<String> = found(&service, "meeting").into_iter().map(|(p, _)| p).collect();
    assert_eq!(paths, ["good.md"]);
    assert_eq!(found(&service, "file:bad").len(), 1, "it is still found by its name");
}

#[test]
fn only_candidate_bodies_are_read() {
    let (service, _vault, _index) = service(&[
        ("Notes/Kickoff.md", KICKOFF),
        ("Notes/Other.md", b"meeting\n"),
        ("Notes/Third.md", b"meeting\n"),
    ]);
    let reader = service.reader().unwrap();
    let read = |q: &str| {
        let compiled = compile(&parse_query(q).unwrap(), false).unwrap();
        reader.search(&SearchQuery { compiled: &compiled, sort: SortOrder::FileNameAsc }).unwrap().texts_read
    };
    assert_eq!(read("file:Kickoff meeting"), 1);
    assert_eq!(read("meeting"), 3);
    assert_eq!(read("file:Kickoff"), 0, "no text is needed");
}

#[test]
fn the_sort_reads_tree_times() {
    // The times are set before the first build: a metadata-only touch
    // publishes no generation, so setting them afterwards would not reach
    // the index.
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    for (name, seconds) in [("a.md", 300), ("b.md", 100), ("c.md", 200)] {
        let path = vault.path().join(name);
        fs::write(&path, "x").unwrap();
        filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(1_700_000_000 + seconds, 0)).unwrap();
    }
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let compiled = compile(&parse_query("x").unwrap(), false).unwrap();
    let answer = service.reader().unwrap().search(&SearchQuery { compiled: &compiled, sort: SortOrder::ModifiedDesc }).unwrap();
    let order: Vec<&str> = answer.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(order, ["a.md", "c.md", "b.md"]);
}

#[test]
fn a_publication_completes_while_a_search_is_in_flight() {
    let (mut service, vault, _index) = service(&[("a.md", b"meeting\n")]);
    let mut reader = service.reader().unwrap();
    let before = reader.published_status().unwrap().generation;
    let (rendezvous, hook) = common::rendezvous("search");
    reader.pause_evaluations_for_test(hook);
    let searching = thread::spawn(move || {
        let compiled = compile(&parse_query("meeting").unwrap(), false).unwrap();
        reader.search(&SearchQuery { compiled: &compiled, sort: SortOrder::FileNameAsc }).unwrap()
    });
    rendezvous.arrived();
    fs::write(vault.path().join("b.md"), "meeting\n").unwrap();
    service.refresh(false).unwrap();
    rendezvous.release();
    let answer = searching.join().unwrap();
    assert_eq!(Some(answer.generation), before, "the search answers the generation it pinned");
    assert_eq!(answer.hits.len(), 1, "and none of the newer one's rows");
}

#[test]
fn line_context_is_read_at_the_answers_generation() {
    let long = format!("{}needle{}\n", "x".repeat(1000), "é".repeat(500));
    let (mut service, vault, _index) = service(&[("a.md", b"a\nThe meeting ran long.\n"), ("b.md", long.as_bytes())]);
    let reader = service.reader().unwrap();
    let generation = reader.published_status().unwrap().generation.unwrap();
    let contexts = reader.match_contexts(generation, &[(vp("a.md"), vec![6..13]), (vp("b.md"), vec![1000..1006])]).unwrap();
    assert_eq!(contexts[0], vec![MatchContext { line_text: "The meeting ran long.".into(), line_text_start: 2 }]);
    let cut = &contexts[1][0];
    assert!(cut.line_text.len() <= vault_index::MAX_LINE_TEXT_BYTES);
    assert!(cut.line_text.contains("needle"));
    assert!(cut.line_text_start > 0 && long.is_char_boundary(cut.line_text_start));
    fs::write(vault.path().join("a.md"), "changed\n").unwrap();
    service.refresh(false).unwrap();
    match reader.match_contexts(generation, &[(vp("a.md"), vec![0..1])]) {
        Err(IndexError::GenerationMismatch { cursor, current }) => {
            assert_eq!(cursor, generation.get());
            assert!(current > cursor);
        }
        other => panic!("expected GenerationMismatch, got {other:?}"),
    }
}

/// A fixed vault with overlapping words, tags, names and attachments, and
/// random queries over them: narrowing must never change the answer.
#[test]
fn narrowing_never_drops_a_file_the_query_keeps() {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let words = ["alpha", "beta", "gamma", "Alpha", "BETA"];
    let tags = ["work", "work/meeting", "myjob/work", "Home"];
    for i in 0..40 {
        let body = format!("{} {}\n#{}\n", words[i % 5], words[(i * 3) % 5], tags[i % 4]);
        files.push((format!("{}/{}-{i}.md", ["notes", "img", "Work"][i % 3], words[(i * 7) % 5]), body.into_bytes()));
    }
    for i in 0..10 {
        files.push((format!("img/{}-{i}.png", words[i % 5]), vec![0]));
    }
    let borrowed: Vec<(&str, &[u8])> = files.iter().map(|(p, b)| (p.as_str(), b.as_slice())).collect();
    let (service, _vault, _index) = service(&borrowed);
    let reader = service.reader().unwrap();
    let leaf = prop::sample::select(vec![
        "alpha", "beta", "gam", "file:alpha", "file:.png", "file:img", "path:img", "path:work",
        "tag:work", "tag:#work/meeting", "tag:home", "content:beta", "match-case:Alpha", "ignore-case:BETA",
    ]);
    let query = prop::collection::vec((leaf, any::<bool>(), any::<bool>()), 1..4).prop_map(|items| {
        items
            .into_iter()
            .enumerate()
            .map(|(i, (leaf, negate, or))| {
                let joiner = if i == 0 { "" } else if or { " OR " } else { " " };
                format!("{joiner}{}{leaf}", if negate { "-" } else { "" })
            })
            .collect::<String>()
    });
    let mut runner = TestRunner::new(Config::with_cases(256));
    runner
        .run(&query, |text| {
            let compiled = compile(&parse_query(&text).unwrap(), false).unwrap();
            let request = SearchQuery { compiled: &compiled, sort: SortOrder::FileNameAsc };
            let narrowed = reader.search(&request).unwrap().hits;
            let full = reader.search_unnarrowed_for_test(&request).unwrap().hits;
            prop_assert_eq!(narrowed, full, "{}", text);
            Ok(())
        })
        .unwrap();
}
```

`common::rendezvous`, `Rendezvous::arrived` and `Rendezvous::release` are the existing helpers in `crates/vault-index/tests/common/mod.rs`, and `common::scratch_root` the existing scratch root; `IndexService::reader()` returns an owned `IndexReader`, so one can move into a thread. `vault-search` is a normal dependency of `vault-index` (Step 3), which the integration tests see.

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test search_query; echo "exit=$?"`

Expected: the build fails on the missing `SearchQuery`, `MatchContext`, `IndexReader::search` and `match_contexts`, `exit=101`.

- [ ] **Step 3: The pinned read**

In `reader.rs`, beside `evaluation_read`:

```rust
/// [`Self::evaluation_read`] at whatever generation is published, without a
/// resolver: a search reads rows, never resolutions.
pub(crate) fn evaluation_read_current<T>(
    &self,
    under_guard: impl FnOnce(&crate::LiveGraph) -> T,
) -> Result<(EvaluationRead<'_>, T), IndexError> {
    if self.forced_stale {
        return Err(IndexError::LiveStateStale("evaluations are refused as stale by a test".into()));
    }
    self.pin_evaluation(None, true, under_guard)
}
```

- [ ] **Step 4: The document source and the scan**

`crates/vault-index/src/query/search.rs`:

```rust
struct FileRow { path: VaultPath, kind: DocumentKind, times: Times }

struct IndexDocument<'a> { row: &'a FileRow, text: Option<&'a str>, tags: &'a [TagFact] }

impl SearchDocument for IndexDocument<'_> {
    fn path(&self) -> &VaultPath { &self.row.path }
    fn kind(&self) -> DocumentKind { self.row.kind }
    fn text(&self) -> Option<&str> { self.text }
    fn tags(&self) -> &[TagFact] { self.tags }
}

impl IndexReader {
    pub fn search(&self, query: &SearchQuery<'_>) -> Result<SearchAnswer, IndexError> {
        self.search_with(query, true)
    }

    #[doc(hidden)]
    pub fn search_unnarrowed_for_test(&self, query: &SearchQuery<'_>) -> Result<SearchAnswer, IndexError> {
        self.search_with(query, false)
    }

    fn search_with(&self, query: &SearchQuery<'_>, narrow: bool) -> Result<SearchAnswer, IndexError> {
        let deadline = Instant::now() + SEARCH_BUDGET;
        let mut pause = SEARCH_BACKOFF;
        loop {
            match self.evaluation_read_current(|_| ()) {
                Ok((read, ())) => return scan(&read, query, narrow),
                Err(error @ IndexError::LiveStateStale(_)) => {
                    if Instant::now() + pause > deadline {
                        return Err(error);
                    }
                    std::thread::sleep(pause);
                    pause = (pause * 2).min(SEARCH_BACKOFF_MAX);
                }
                Err(error) => return Err(error),
            }
        }
    }
}
```

`SEARCH_BUDGET`, `SEARCH_BACKOFF` and `SEARCH_BACKOFF_MAX` are 2 s, 1 ms and 32 ms, the same values as the Bases evaluation budget (`query/bases.rs`), named separately so either can move alone.

`scan(read, query, narrow)`:

1. An empty query (`compiled.is_empty()`) answers no hits with `read.generation`, reading nothing.
2. Read `SELECT path, kind, mtime_unix_ms, ctime_unix_ms FROM tree_entries WHERE kind IN ('note','file') ORDER BY path` into `FileRow`s (`note` → `DocumentKind::Note`, `file` → `DocumentKind::File`). A canvas is a `file` row, reached only by `file:` and `path:`: canvas content is out of this phase (Ruling 4, issue #3), so `DocumentKind::Canvas` is never produced.
3. When `needs().tags`, read `SELECT note_path, value, span_start, span_end FROM tags ORDER BY note_path, ordinal` into a `HashMap<VaultPath, Vec<TagFact>>`.
4. For each row, build an `IndexDocument` with `text: None` and keep it when `!narrow || compiled.prefilter(&doc)`.
5. When `needs().text`, read the kept notes' bodies: when they are fewer than a quarter of the notes, one prepared `SELECT source_bytes FROM notes WHERE path = ?1` per kept note; otherwise one pass of `SELECT path, source_bytes FROM notes ORDER BY path`, skipping rows not kept. Each body is read as a borrowed `ValueRef::Blob` and checked with `std::str::from_utf8` (the index stores only UTF-8 sources; a failure is `IndexError::Storage` naming the path, never a panic), evaluated at once, and dropped: no body outlives its evaluation. Count each body read into `texts_read`. A kept note with no `notes` row (an `.md` file that is not UTF-8 is diagnosed and its body is not stored, `reconcile.rs`) is evaluated with the empty text `""`: it can match by its path, never by its content.
6. Evaluate each kept document (with its text, when read) through `vault_search::evaluate`; collect the hits.
7. `sort_hits(&mut hits, query.sort, &|path| times[path])`, the times taken from the `FileRow`s.

`match_contexts(generation, wanted)` runs on the reader's ordinary `read` path (it is short), refuses with `IndexError::GenerationMismatch { cursor: generation.get(), current }` when the read's generation is not `generation`, reads each path's `source_bytes`, and for each span cuts the line: `LineIndex::new(text).line_range(span.start)`; when the line is at most `MAX_LINE_TEXT_BYTES`, the whole line; otherwise a window of `MAX_LINE_TEXT_BYTES` bytes that starts `(MAX_LINE_TEXT_BYTES - span_len) / 2` bytes before the match (never before the line start, and the whole window starting at the match when the match itself is longer), with its start moved forward and its end moved back to character boundaries. A path that has no note row at that generation answers no contexts for it (an empty inner list) rather than an error, because a page's notes are the answer's own and can only be absent through a defect, which the server reports as `internal`.

Export `SearchQuery`, `SearchAnswer`, `MatchContext` and `MAX_LINE_TEXT_BYTES` from `lib.rs` beside the Bases query types (`pub use query::search::{…}`; the module itself is `pub(crate)`).

- [ ] **Step 5: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test search_query; echo "exit=$?"`

Expected: `test result: ok. 9 passed`, `exit=0`. A failure of `narrowing_never_drops_a_file_the_query_keeps` prints the query; the fix is in `CompiledQuery::prefilter` (Task 3's crate), never in the test, and that fix adds the failing query to `tests/evaluate.rs` as a unit case.

- [ ] **Step 6: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index -p vault-search; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
```

Expected: `exit=0` four times. The whole `vault-index` suite stays green: nothing on the write path changed.

- [ ] **Step 7: Commit**

```bash
git add crates/vault-index
git commit -F - <<'COMMIT'
feat(index): search as an exact scan on the pinned read, with metadata narrowing

IndexReader::search pins the published generation on a private pooled connection under the publication guard, releases the guard, and scans: tree rows and, when needed, tags narrow the candidates exactly through the compiled query's metadata prefilter, note bodies are read only for the survivors and only when the query reads text, each candidate is evaluated, and the hits are sorted with the tree's times. A publication completes while a search is in flight, and the search answers the generation it pinned. match_contexts cuts each match's line at a named generation and refuses with GenerationMismatch once that generation is gone. A property test pins narrowing to the unnarrowed scan.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 5: The wire types — `search`, its DTOs, two error codes, and the `position` field

Add the request and response to `vault-protocol`, additively: `Request::Search(SearchParams)`, `Response::Search(SearchResponse)`, the hit, match, location and span DTOs, `ErrorCode::{QueryInvalid, UnsupportedOperator}`, and an optional `position` on `ProtocolError`. Request-side enums (`sort`, `context`) carry no `Unknown`, because an unknown value a client chose is `invalid_request` by the Evolution rule; the response-side `DocumentKindDto` carries `Unknown`. Both new open-ended enums follow `main`'s pattern exactly: `ErrorCode` already pairs a derived `Serialize` with a hand-written `Deserialize` (`error.rs`, `_ => Self::Unknown`), so the two codes need two match arms there or they decode as `Unknown`; `DocumentKindDto` derives `Serialize` only and hand-writes `Deserialize` as `TreeEntryKindDto` does (`snapshots.rs`), because `#[serde(other)]` is rejected on a plain unit-variant enum; and `tests/variant_anchors.rs`, an exhaustive match per enum, gains both codes and a `DocumentKindDto` witness, with their round-trip rows in `tests/search_wire.rs` (the Bases codes' rows live in `tests/bases_wire.rs` the same way).

**Files:**

- Create: `crates/vault-protocol/src/search.rs`, `crates/vault-protocol/tests/search_wire.rs`
- Modify: `crates/vault-protocol/src/operations.rs`, `crates/vault-protocol/src/error.rs` (the two variants, their two `Deserialize` arms, `position`, `ProtocolError::new`), `crates/vault-protocol/src/lib.rs`, `crates/vault-protocol/tests/variant_anchors.rs` (the two `ErrorCode` arms and a `witness_document_kind`); every `ProtocolError { … }` struct literal in the workspace gains `position: None` (the compiler lists them; `crates/vault-server/src/convert.rs` holds most)

**Interfaces:**

- Consumes: `SpanDto` (existing).
- Produces:

```rust
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct SearchParams {
    pub query: String,
    #[serde(default)] pub match_case: bool,
    #[serde(default)] pub sort: SearchSortDto,
    #[serde(default)] pub context: SearchContextDto,
    #[serde(default)] pub cursor: Option<String>,
    #[serde(default)] pub limit: Option<u32>,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchSortDto { #[default] FileNameAsc, FileNameDesc, ModifiedDesc, ModifiedAsc, CreatedDesc, CreatedAsc }
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchContextDto { None, #[default] Line }
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SearchResponse { pub generation: u64, pub total_files: u64, pub total_matches: u64, pub items: Vec<SearchHitDto>, pub next_cursor: Option<String> }
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SearchHitDto { pub path: String, pub kind: DocumentKindDto, pub path_matches: Vec<Utf16SpanDto>, pub content_matches: Vec<ContentMatchDto>, pub matches_truncated: bool }
/// `Canvas` is reserved and never produced in this phase (Ruling 4, issue #3).
/// `Deserialize` is hand-written, as `TreeEntryKindDto`'s is.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKindDto { Note, Canvas, File, /** A kind this build does not know. Never produced. */ Unknown }
impl<'de> Deserialize<'de> for DocumentKindDto { /* "note" | "canvas" | "file", `_ => Self::Unknown` */ }
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Utf16SpanDto { pub start: u64, pub end: u64 }
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocDto { pub line: u64, pub col: u64, pub offset: u64 }
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContentMatchDto {
    pub span: SpanDto,
    pub start: LocDto,
    pub end: LocDto,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub line_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub line_text_start: Option<u64>,
}
// error.rs: the derived `Serialize` spells them `query_invalid` and `unsupported_operator`;
// the hand-written `Deserialize` gains `"query_invalid" => Self::QueryInvalid` and
// `"unsupported_operator" => Self::UnsupportedOperator` before its `_ => Self::Unknown`.
pub enum ErrorCode { /* … */ QueryInvalid, UnsupportedOperator, /* … */ Unknown }
pub struct ProtocolError { /* … */ #[serde(default, skip_serializing_if = "Option::is_none")] pub position: Option<u64> }
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-protocol/tests/search_wire.rs`:

```rust
use vault_protocol::{
    DocumentKindDto, ErrorCode, ProtocolError, Request, RequestEnvelope, Response, ResponseEnvelope, ResponseOutcome,
    SearchContextDto, SearchParams, SearchSortDto,
};

const REQUEST: &str = r#"{"version":1,"id":"q","request":{"method":"search","params":{"query":"meeting -work tag:#project","limit":1}}}"#;
const RESPONSE: &str = r#"{"version":1,"id":"q","outcome":{"status":"ok","value":{"type":"search","value":{"generation":12,"total_files":3,"total_matches":5,"items":[{"path":"Notes/Kickoff.md","kind":"note","path_matches":[],"content_matches":[{"span":{"start":21,"end":28},"start":{"line":2,"col":4,"offset":21},"end":{"line":2,"col":11,"offset":28},"line_text":"The meeting ran long.","line_text_start":17}],"matches_truncated":false}],"next_cursor":"eyJn"}}}}"#;

#[test]
fn the_request_decodes_with_its_defaults() {
    let envelope: RequestEnvelope = serde_json::from_str(REQUEST).unwrap();
    let Request::Search(params) = envelope.request else { panic!("a search request") };
    assert_eq!(
        params,
        SearchParams {
            query: "meeting -work tag:#project".into(),
            match_case: false,
            sort: SearchSortDto::FileNameAsc,
            context: SearchContextDto::Line,
            cursor: None,
            limit: Some(1),
        }
    );
}

#[test]
fn the_response_round_trips_byte_for_byte() {
    let envelope: ResponseEnvelope = serde_json::from_str(RESPONSE).unwrap();
    assert_eq!(serde_json::to_string(&envelope).unwrap(), RESPONSE);
    let ResponseOutcome::Ok(Response::Search(answer)) = envelope.outcome else { panic!("a search answer") };
    assert_eq!(answer.items[0].kind, DocumentKindDto::Note);
}

#[test]
fn an_unknown_document_kind_is_tolerated_and_an_unknown_sort_is_not() {
    let unknown = RESPONSE.replace(r#""kind":"note""#, r#""kind":"hologram""#);
    let envelope: ResponseEnvelope = serde_json::from_str(&unknown).unwrap();
    let ResponseOutcome::Ok(Response::Search(answer)) = envelope.outcome else { panic!("a search answer") };
    assert_eq!(answer.items[0].kind, DocumentKindDto::Unknown);
    let bad_sort = REQUEST.replace(r#""limit":1"#, r#""sort":"relevance""#);
    assert!(serde_json::from_str::<RequestEnvelope>(&bad_sort).is_err(), "a value from a closed set a client chose");
}

#[test]
fn the_new_codes_and_position_serialize() {
    let error = ProtocolError { position: Some(3), ..ProtocolError::new(ErrorCode::QueryInvalid, "unmatched `)`") };
    let text = serde_json::to_string(&error).unwrap();
    assert_eq!(text, r#"{"code":"query_invalid","message":"unmatched `)`","position":3}"#);
    let unsupported = serde_json::to_string(&ProtocolError::new(ErrorCode::UnsupportedOperator, "`line:`")).unwrap();
    assert!(unsupported.contains(r#""code":"unsupported_operator""#) && !unsupported.contains("position"));
}

/// The round-trip rows `variant_anchors.rs` points at for the two codes.
#[test]
fn the_two_search_error_codes_round_trip() {
    for (code, wire) in [(ErrorCode::QueryInvalid, "query_invalid"), (ErrorCode::UnsupportedOperator, "unsupported_operator")] {
        assert_eq!(serde_json::to_value(code).unwrap(), serde_json::json!(wire));
        assert_eq!(serde_json::from_value::<ErrorCode>(serde_json::json!(wire)).unwrap(), code);
    }
}

/// The round-trip rows for every known `DocumentKindDto`.
#[test]
fn every_document_kind_round_trips() {
    for (kind, wire) in [(DocumentKindDto::Note, "note"), (DocumentKindDto::Canvas, "canvas"), (DocumentKindDto::File, "file")] {
        assert_eq!(serde_json::to_value(kind).unwrap(), serde_json::json!(wire));
        assert_eq!(serde_json::from_value::<DocumentKindDto>(serde_json::json!(wire)).unwrap(), kind);
    }
}
```

`ProtocolError::new(code, message)` does not exist yet; this task adds it (`pub fn new(code: ErrorCode, message: impl Into<String>) -> Self`, every optional field `None`), and Task 6 uses it for the two new refusals. `RequestEnvelope`, `ResponseEnvelope` and `ResponseOutcome` are the existing envelope types; if their exported names differ, the test uses the existing names (the Bases wire test, `tests/bases_wire.rs`, shows them).

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol --test search_wire; echo "exit=$?"`

Expected: the build fails on the missing types, `exit=101`.

- [ ] **Step 3: Implement** — `src/search.rs` with the DTOs above and a module doc ("Search on the wire. Additive to protocol version 1; the response's `kind` carries an `Unknown` catch-all, the request's `sort` and `context` do not, because an unknown value a client chose is refused."); `DocumentKindDto`'s `Deserialize` written exactly as `TreeEntryKindDto`'s in `snapshots.rs` (`String::deserialize`, one arm per known spelling, `_ => Self::Unknown`), with the same doc paragraph saying why it is hand-written; `Request::Search(SearchParams)` and `Response::Search(SearchResponse)` appended to the two enums in `operations.rs`, each with a doc line; the two codes with doc comments in `error.rs` before `Unknown`, their two arms in `ErrorCode`'s hand-written `Deserialize` before `_ => Self::Unknown`, and `position` after the existing optional fields; `ProtocolError::new`; the exports in `lib.rs`. In `tests/variant_anchors.rs`: add `| ErrorCode::QueryInvalid | ErrorCode::UnsupportedOperator` to `witness_error_code` under a `// Round-tripped in search_wire.rs.` comment, add a `witness_document_kind` over `Note | Canvas | File | Unknown` and call it, and add `search_wire.rs` to the header's list of round-trip tables. Fix every `ProtocolError` literal the compiler names by adding `position: None`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol; echo "exit=$?"`

Expected: every suite passes (the existing `wire_tolerance.rs` and `variant_anchors.rs` included; `search_wire` runs 6 tests), `exit=0`.

- [ ] **Step 5: The gates** — the workspace build, clippy, fmt and MSRV check, as Task 4 Step 6.

- [ ] **Step 6: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(protocol): the search request and response, two error codes and position

search takes a query in Obsidian's syntax with the case toggle, one of the six sort orders, a context choice and the collection paging; it answers per file the path, the kind, path matches in UTF-16 units and content matches as UTF-8 byte spans with Obsidian Locs and optional line text. query_invalid and unsupported_operator are new codes, and a refusal of a query carries the character position. The response's kind tolerates an unknown value; the request's sort and context refuse one.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 6: The `search` operation — handler, per-generation cache, cursor, paging, and conformance over both transports

`vault-server` answers `search`: parse (refusing with `query_invalid` and its position), compile (refusing with `unsupported_operator` and its position), check the limit, decode the cursor, take the answer from a bounded per-generation LRU or compute it with `IndexReader::search`, cut the page, read line contexts at the answer's generation when `context` is `line`, and convert. One flag, `--search-cache-entries`.

**Files:**

- Create: `crates/vault-server/src/search.rs`, `crates/vault-server/tests/search_ops.rs`
- Create: `crates/vault-server/src/paging.rs` (moved out of `src/bases.rs`: `page_limit`, `invalid_cursor`, `generation_mismatch`, `encode_cursor`, `decode_cursor`)
- Modify: `crates/vault-server/src/bases.rs` (calls `paging`; no behaviour change), `crates/vault-server/src/lib.rs` (`mod paging;`, the `Request::Search` arm, `search_cache` on `Server` in both constructors, `set_search_cache_entries`), `crates/vault-server/src/convert.rs` (hit and match conversion), `crates/vault-server/src/main.rs` (`--search-cache-entries <1..=1024>`, requires `--vault`), `crates/vault-server/Cargo.toml` (`vault-search`), `crates/vault-server/tests/conformance.rs` and `tests/fixtures/conformance.jsonl` (search rows)

**Interfaces:**

- Consumes: `parse_query`, `compile`, `CompileError`, `SortOrder`, `FileHit` (Tasks 1–3); `IndexReader::{search, match_contexts}`, `SearchQuery`, `SearchAnswer`, `MatchContext` (Task 4); the DTOs and codes (Task 5).
- Produces:

```rust
pub const DEFAULT_SEARCH_CACHE_ENTRIES: usize = 16;
/// An answer holding more stored content matches than this is not cached;
/// each of its pages is computed again.
pub const MAX_STORED_MATCHES: usize = 200_000;
pub(crate) struct SearchCache { /* LRU keyed by (canonical query, match_case, sort, generation) */ }
pub(crate) fn search(reader: &IndexReader, cache: &SearchCache, params: SearchParams) -> Result<SearchResponse, ProtocolError>;
pub(crate) fn query_error(error: &CompileError) -> ProtocolError;
impl Server { pub fn set_search_cache_entries(&mut self, entries: usize); }
// paging.rs (crate-private; bases.rs and search.rs both call it)
pub(crate) fn page_limit(limit: Option<u32>) -> Result<usize, ProtocolError>; // 1..=1000, default 100, else invalid_cursor
pub(crate) fn invalid_cursor(message: String) -> ProtocolError;
pub(crate) fn generation_mismatch(cursor: u64, current: u64) -> ProtocolError;
pub(crate) fn encode_cursor<T: serde::Serialize>(cursor: &T) -> String; // URL-safe base64 of JSON, no padding
pub(crate) fn decode_cursor<T: serde::de::DeserializeOwned>(cursor: &str) -> Result<T, ProtocolError>;
// convert.rs
pub(crate) fn search_hit(hit: &FileHit, contexts: Option<&[MatchContext]>) -> Result<SearchHitDto, ProtocolError>;
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-server/tests/search_ops.rs` with the `scratch`, `vault_of`, `started`, `ok` and `err` helpers copied from `tests/bases_ops.rs` (each test file is its own crate), and:

```rust
fn search(params: &str) -> String {
    format!(r#"{{"version":1,"id":"q","request":{{"method":"search","params":{params}}}}}"#)
}

fn answer(daemon: &mut Daemon, params: &str) -> vault_protocol::SearchResponse {
    match ok(daemon, &search(params)) {
        Response::Search(answer) => answer,
        other => panic!("{params}: a search answer, got {other:?}"),
    }
}

fn paths(answer: &vault_protocol::SearchResponse) -> Vec<&str> {
    answer.items.iter().map(|item| item.path.as_str()).collect()
}

fn meeting_vault() -> (TempDir, TempDir) {
    vault_of(&[
        ("Notes/Kickoff.md", "---\nkind: x\n---\nThe meeting ran long.\n#project\n"),
        ("Notes/Retro.md", "meeting about work\n#project\n"),
        ("Notes/Standup.md", "meeting\n"),
        ("img/meeting.png", "png"),
    ])
}

#[test]
fn search_answers_files_spans_locs_and_line_text() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    let found = answer(&mut daemon, r#"{"query":"meeting -work tag:#project"}"#);
    assert_eq!(paths(&found), ["Notes/Kickoff.md"]);
    assert_eq!(found.total_files, 1);
    let first = &found.items[0].content_matches[0];
    // Line 3 starts at byte 16, after the three frontmatter lines.
    assert_eq!((first.span.start, first.span.end), (20, 27));
    assert_eq!((first.start.line, first.start.col, first.start.offset), (3, 4, 20));
    assert_eq!(first.line_text.as_deref(), Some("The meeting ran long."));
    assert_eq!(first.line_text_start, Some(16));
    let bare = answer(&mut daemon, r#"{"query":"meeting -work tag:#project","context":"none"}"#);
    assert_eq!(bare.items[0].content_matches[0].line_text, None);
}

#[test]
fn attachments_are_reached_by_file_and_path_only() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    assert_eq!(paths(&answer(&mut daemon, r#"{"query":"meeting"}"#)), ["Notes/Kickoff.md", "Notes/Retro.md", "Notes/Standup.md"]);
    let files = answer(&mut daemon, r#"{"query":"file:meeting"}"#);
    assert_eq!(paths(&files), ["img/meeting.png"]);
    assert_eq!(files.items[0].kind, vault_protocol::DocumentKindDto::File);
}

#[test]
fn paging_cuts_one_answer_and_the_cursor_binds_its_parameters() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    let first = answer(&mut daemon, r#"{"query":"meeting","limit":2}"#);
    assert_eq!(paths(&first), ["Notes/Kickoff.md", "Notes/Retro.md"]);
    assert_eq!(first.total_files, 3);
    let cursor = first.next_cursor.clone().expect("a second page");
    let second = answer(&mut daemon, &format!(r#"{{"query":"meeting","limit":2,"cursor":"{cursor}"}}"#));
    assert_eq!(paths(&second), ["Notes/Standup.md"]);
    assert_eq!(second.next_cursor, None);
    let other = err(&mut daemon, &search(&format!(r#"{{"query":"standup","limit":2,"cursor":"{cursor}"}}"#)));
    assert_eq!(other.code, ErrorCode::InvalidCursor);
    let other_sort = err(&mut daemon, &search(&format!(r#"{{"query":"meeting","sort":"file_name_desc","limit":2,"cursor":"{cursor}"}}"#)));
    assert_eq!(other_sort.code, ErrorCode::InvalidCursor);
}

#[test]
fn a_cursor_from_an_older_generation_is_generation_mismatch() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    let first = answer(&mut daemon, r#"{"query":"meeting","limit":1}"#);
    let cursor = first.next_cursor.unwrap();
    ok(&mut daemon, r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"New.md","content":"meeting\n","expected":{"absent":true}}}}"#);
    let stale = err(&mut daemon, &search(&format!(r#"{{"query":"meeting","limit":1,"cursor":"{cursor}"}}"#)));
    assert_eq!(stale.code, ErrorCode::GenerationMismatch);
    assert!(stale.current_generation.unwrap() > first.generation);
}

#[test]
fn malformed_and_unsupported_queries_are_refused_with_a_position() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    let malformed = err(&mut daemon, &search(r#"{"query":"a b)"}"#));
    assert_eq!(malformed.code, ErrorCode::QueryInvalid);
    assert_eq!(malformed.position, Some(3));
    let unsupported = err(&mut daemon, &search(r#"{"query":"x line:(a b)"}"#));
    assert_eq!(unsupported.code, ErrorCode::UnsupportedOperator);
    assert_eq!(unsupported.position, Some(2));
    assert!(unsupported.message.contains("line:"));
}

#[test]
fn limits_and_closed_values_are_checked() {
    let (vault, index) = meeting_vault();
    let mut daemon = started(&vault, &index);
    assert_eq!(err(&mut daemon, &search(r#"{"query":"a","limit":0}"#)).code, ErrorCode::InvalidCursor);
    assert_eq!(err(&mut daemon, &search(r#"{"query":"a","limit":1001}"#)).code, ErrorCode::InvalidCursor);
    assert_eq!(err(&mut daemon, &search(r#"{"query":"a","sort":"relevance"}"#)).code, ErrorCode::InvalidRequest);
    let empty = answer(&mut daemon, r#"{"query":"   "}"#);
    assert_eq!((empty.total_files, empty.items.len()), (0, 0), "an empty query is an empty answer, not an error");
}

#[test]
fn the_match_case_toggle_and_the_sorts_reach_the_engine() {
    let (vault, index) = vault_of(&[("b.md", "Meeting\n"), ("a.md", "meeting\n")]);
    let mut daemon = started(&vault, &index);
    assert_eq!(paths(&answer(&mut daemon, r#"{"query":"Meeting","match_case":true}"#)), ["b.md"]);
    assert_eq!(paths(&answer(&mut daemon, r#"{"query":"meeting","sort":"file_name_desc"}"#)), ["b.md", "a.md"]);
}

#[test]
fn health_only_mode_is_index_unavailable() {
    let mut daemon = Daemon::start(&[]);
    assert_eq!(err(&mut daemon, &search(r#"{"query":"a"}"#)).code, ErrorCode::IndexUnavailable);
}
```

`Daemon::start(&[])` is the harness's daemon with no arguments, which is health-only mode (`tests/daemon/mod.rs`). The `write_note` line uses the parameter spelling of the existing conformance rows.

Add one conformance row per transport-visible shape to `tests/fixtures/conformance.jsonl` in the existing row format (the Bases rows are the model): a `search` answer over the conformance vault, a `query_invalid` refusal with its `position`, and an `unsupported_operator` refusal. `tests/conformance.rs` runs the set over stdio and the socket unchanged.

Add a unit test module to `src/search.rs` for the cache, as `src/bases.rs` has: `the_cache_hits_at_one_generation_and_misses_at_the_next` (put at generation 3, get at 3 hits, a put at 4 drops every entry of 3), `the_least_recently_used_entry_is_evicted`, and `an_answer_over_the_stored_match_bound_is_not_stored`; and one for the conversion, `contexts_that_do_not_pair_with_the_matches_are_internal` (a hit with two content matches and one context answers `internal` from `convert::search_hit`, never a panic or a silently shortened hit).

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test search_ops; echo "exit=$?"`

Expected: every test fails with `invalid_request` from the dispatcher (the method is unknown), `exit=101`.

- [ ] **Step 3: The cache and the cursor**

First move the shared paging pieces out of `src/bases.rs` into `src/paging.rs`: `limit` (renamed `page_limit`), `invalid_cursor`, `generation_mismatch`, and `encode`/`decode` made generic as `encode_cursor<T: Serialize>`/`decode_cursor<T: DeserializeOwned>`; `bases.rs` calls them, with no behaviour change, and its unit tests and `tests/bases_ops.rs` stay unchanged and green. The least-recently-used store is not shared, because its keys and values differ per operation; that duplication is accepted and the commit body says so.

`SearchCache` copies `BaseCache`'s shape (`src/bases.rs`): a `Mutex` over a `HashMap<CacheKey, Arc<SearchAnswer>>` and a use-order `VecDeque`, `with_capacity(n)` (at least one), `get`, `put` (which first drops every entry of an older generation and evicts the least recently used past capacity), and `len` for tests. The key is `(canonical: String, match_case: bool, sort: SortOrder, generation: u64)`; Task 15 adds the exclusion epoch and `include_excluded`. `put` skips an answer whose total stored content matches exceed `MAX_STORED_MATCHES`.

The cursor is `paging::encode_cursor` of `#[derive(Serialize, Deserialize)] struct Cursor { g: u64, q: String, c: bool, s: SearchSortDto, p: usize }`, so its JSON is `{"g":<generation>,"q":<canonical>,"c":<match_case>,"s":<sort>,"p":<next file index>}` with the sort in its wire spelling (`SearchSortDto` serializes as `file_name_asc` and so on; `vault_search::SortOrder` has no serialization). A cursor that does not decode, or whose `q`, `c` or `s` differ from the request's, is `invalid_cursor`.

- [ ] **Step 4: The handler**

```rust
pub(crate) fn search(reader: &IndexReader, cache: &SearchCache, params: SearchParams) -> Result<SearchResponse, ProtocolError> {
    let limit = paging::page_limit(params.limit)?; // 1..=1000, default 100, else invalid_cursor
    let query = parse_query(&params.query).map_err(|e| query_error(&CompileError::Invalid(e)))?;
    let compiled = compile(&query, params.match_case).map_err(|e| query_error(&e))?;
    let sort = sort_order(params.sort);
    let current = reader.published_status().map_err(convert::index_error)?.generation.ok_or_else(index_unavailable)?;
    let start = match &params.cursor {
        None => 0,
        Some(cursor) => {
            let cursor = Cursor::decode(cursor, compiled.canonical(), compiled.match_case(), params.sort)?;
            if cursor.generation != current.get() {
                return Err(generation_mismatch(cursor.generation, current.get()));
            }
            cursor.position
        }
    };
    let key = CacheKey::new(&compiled, sort, current.get());
    let answer = match cache.get(&key) {
        Some(answer) => answer,
        None => {
            let answer = Arc::new(reader.search(&SearchQuery { compiled: &compiled, sort }).map_err(convert::index_error)?);
            if params.cursor.is_some() && answer.generation != current {
                return Err(generation_mismatch(current.get(), answer.generation.get()));
            }
            cache.put(CacheKey::new(&compiled, sort, answer.generation.get()), Arc::clone(&answer));
            answer
        }
    };
    let page = answer.hits.iter().skip(start).take(limit).collect::<Vec<_>>();
    let contexts = match params.context {
        SearchContextDto::None => None,
        SearchContextDto::Line => Some(
            reader
                .match_contexts(answer.generation, &page.iter().map(|h| (h.path.clone(), h.content_matches.iter().map(|m| m.span.clone()).collect())).collect::<Vec<_>>())
                .map_err(convert::index_error)?,
        ),
    };
    let next = start + page.len();
    Ok(SearchResponse {
        generation: answer.generation.get(),
        total_files: answer.hits.len() as u64,
        total_matches: answer.hits.iter().map(|h| h.total_matches as u64).sum(),
        items: page
            .iter()
            .enumerate()
            .map(|(i, hit)| convert::search_hit(hit, contexts.as_ref().map(|c| c.get(i).map_or(&[][..], Vec::as_slice))))
            .collect::<Result<Vec<_>, _>>()?,
        next_cursor: (next < answer.hits.len()).then(|| Cursor::encode(answer.generation.get(), compiled.canonical(), compiled.match_case(), params.sort, next)),
    })
}
```

A fresh request (no cursor) answers whatever generation the search pinned, which may be newer than `current` if a publication landed in between; that is correct, because the answer names its generation. A page with a cursor must come from the cursor's generation, hence the check after a cache miss. `convert::index_error` already maps `IndexError::GenerationMismatch` to `generation_mismatch` with `current_generation`, so a publication between the answer and `match_contexts` is refused the same way.

`query_error` maps `CompileError::Invalid(e)` to `query_invalid` with `e.message` and `position: Some(e.position)`, and `CompileError::Unsupported { what, position }` to `unsupported_operator` with the message "`<what>` is not supported by this build yet" and the position. `convert::search_hit` builds a `SearchHitDto` from a `FileHit` and its contexts (`line_text` and `line_text_start` set only when contexts were read), mapping `DocumentKind` to `DocumentKindDto` and the ranges to `SpanDto`, `Utf16SpanDto` and `LocDto`. It zips the contexts with `content_matches` and refuses with `internal` ("line contexts do not pair with the matches of <path>") when their lengths differ, which is how a page note missing at the answer's generation, a defect, surfaces (Task 4's `match_contexts` answers an empty list for it).

The dispatch arm in `lib.rs`, beside `Request::EvaluateBase`:

```rust
Request::Search(params) => match reader {
    None => ResponseEnvelope::error(id, index_unavailable()),
    Some(reader) => match search::search(reader, &self.search_cache, params) {
        Ok(answer) => ResponseEnvelope::success(id, Response::Search(answer)),
        Err(error) => ResponseEnvelope::error(id, error),
    },
},
```

`--search-cache-entries` follows `--bases-cache-entries` exactly (range check, refused without `--vault`, `Server::set_search_cache_entries`).

- [ ] **Step 5: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test search_ops --test conformance --lib; echo "exit=$?"`

Expected: every test passes, `exit=0`.

- [ ] **Step 6: The gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
```

Expected: `exit=0` four times. A failure in one of the three load-dependent tests `README.md` lists is re-run alone before it is treated as a regression.

- [ ] **Step 7: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(server): the search operation, with a per-generation cache, paging and refusals

search parses and compiles the query, refusing with query_invalid or unsupported_operator and the character position; takes the answer from a bounded least-recently-used store keyed by the canonical query, the case toggle, the sort and the generation, or computes it on the pinned read; cuts the page; and reads each match's line at the answer's generation. A cursor binds its query, toggle, sort and generation, so a changed parameter is invalid_cursor and a moved generation generation_mismatch. --search-cache-entries bounds the store. The page limit, the cursor codec and the two cursor refusals move from bases.rs into a shared paging module; the least-recently-used store stays one per operation, an accepted duplication, because its keys and values differ. The conformance set gains the search rows over both transports.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 7: The host's `global-search` instance, `host.search`, `host.search_state` and `host.search_opened`

`global-search` leaves `VIEW_ONLY`. When `core-plugins.json` enables it, `app.internalPlugins.getPluginById("global-search").instance` is a `GlobalSearchInstance` with exactly the two methods the corpus calls: `openGlobalSearch(query)` makes `query` the host's current search, runs `search` on the engine for its first page, and raises `host.search_opened`; `getGlobalSearchQuery()` returns the current query, `""` when none. Headless, opening a search means that and nothing more: the search becomes host state any host client can read, because there is no pane to show it in. Two host operations: `host.search` (a pass-through to the engine's `search`, for host clients that hold no engine connection) and `host.search_state` (the current query and its last answer).

**Files:**

- Create: `host/packages/host/src/shim/global-search.ts`, `host/packages/host/test/shim-global-search.test.ts`, `host/packages/host/test/global-search-real-daemon.test.ts`
- Modify: `host/packages/host/src/shim/internal-plugins.ts` (remove `global-search` from `VIEW_ONLY`; build the instance when enabled; header paragraph), `host/packages/host/src/client/protocol.ts` (`SearchParams`, `SearchResponse` and their parts, mirroring Task 5), `host/packages/host/src/server/ops.ts` (`host.search`, `host.search_state`, listed in `NEEDS_STEADY` only if they need a loaded plugin set — they do not; `HostServerDeps` gains a required `globalSearch: GlobalSearchInstance`), `host/packages/host/src/server/server.ts` (`subscribeToSources` relays `host.search_opened`), `host/packages/host/src/testing/assemble.ts` (builds the one `GlobalSearchInstance` per host beside the `InternalPluginRegistry` it is handed to, and exposes it on `HostAssembly` as `globalSearch`), and the two places that build a `HostServer`, `host/packages/host/src/host.ts` and `host/packages/host/src/testing/host-harness.ts` (each passes `assembly.globalSearch`)
- Modify (tests): `host/packages/host/test/shim-internal-plugins.test.ts` (one existing case changed, one added), `host/packages/host/test/golden/tag-wrangler.test.ts` (one case retitled)

**Interfaces:**

- Consumes: the engine's `search` (Tasks 5–6); `RequestSink` (`client/request-sink.ts`); the registry's `enabledMap` result.
- Produces:

```ts
export interface SearchState { readonly query: string; readonly answer: SearchResponse | null; readonly error: string | null }
export class GlobalSearchInstance {
  constructor(deps: { client: RequestSink });
  /** Obsidian's method: make `query` the current search and run it. */
  openGlobalSearch(query: string): void;
  /** Obsidian's method: the current query, "" when none. */
  getGlobalSearchQuery(): string;
  /** HOST-ONLY. The current query and its last answer. */
  state(): SearchState;
  /** HOST-ONLY. Resolves when the search started by the last open has answered. */
  settled(): Promise<void>;
  /** HOST-ONLY. Called with the state each time an opened search answers or fails. */
  onOpened(listener: (state: SearchState) => void): () => void;
}
// ops: "host.search" (params: SearchParams) -> SearchResponse; "host.search_state" () -> SearchState (snake_case on the wire)
// event: { type: "host.search_opened", value: { query, total_files, error } }
```

- [ ] **Step 1: Write the failing tests**

Create `host/packages/host/test/shim-global-search.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { GlobalSearchInstance } from "../src/shim/global-search";
import type { RequestSink } from "../src/client/request-sink";

function recordingClient(answer: unknown): { client: RequestSink; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: RequestSink = {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
  return { client, calls };
}

const ANSWER = { generation: 4, total_files: 1, total_matches: 1, items: [], next_cursor: null };

describe("GlobalSearchInstance", () => {
  it("starts with no query", () => {
    const { client } = recordingClient(ANSWER);
    expect(new GlobalSearchInstance({ client }).getGlobalSearchQuery()).toBe("");
  });

  it("opens a search: records the query, asks the engine, and reports the answer", async () => {
    const { client, calls } = recordingClient(ANSWER);
    const search = new GlobalSearchInstance({ client });
    const seen: string[] = [];
    search.onOpened((state) => seen.push(`${state.query}:${state.answer?.total_files}`));
    search.openGlobalSearch("tag:#project");
    expect(search.getGlobalSearchQuery()).toBe("tag:#project");
    await search.settled();
    expect(calls).toEqual([{ method: "search", params: { query: "tag:#project", limit: 100 } }]);
    expect(search.state().answer).toEqual(ANSWER);
    expect(seen).toEqual(["tag:#project:1"]);
  });

  it("composes the way tag-wrangler does: the current query plus a tag", async () => {
    const { client, calls } = recordingClient(ANSWER);
    const search = new GlobalSearchInstance({ client });
    search.openGlobalSearch("meeting");
    await search.settled();
    search.openGlobalSearch(`${search.getGlobalSearchQuery()} tag:#work`);
    await search.settled();
    expect(calls.map((c) => (c.params as { query: string }).query)).toEqual(["meeting", "meeting tag:#work"]);
  });

  it("keeps a refused query as state with its error, and never throws into the plugin", async () => {
    const { client } = recordingClient(new Error("query_invalid: unmatched `)` (at character 3)"));
    const search = new GlobalSearchInstance({ client });
    expect(() => search.openGlobalSearch("a b)")).not.toThrow();
    await search.settled();
    expect(search.state()).toEqual({ query: "a b)", answer: null, error: "query_invalid: unmatched `)` (at character 3)" });
  });

  it("answers only the newest open when two overlap", async () => {
    let release: (() => void) | undefined;
    const client: RequestSink = {
      request: async <T>(_method: string, params?: unknown): Promise<T> => {
        const query = (params as { query: string }).query;
        if (query === "slow") await new Promise<void>((resolve) => (release = resolve));
        return { ...ANSWER, total_files: query === "slow" ? 9 : 2 } as T;
      },
    };
    const search = new GlobalSearchInstance({ client });
    search.openGlobalSearch("slow");
    search.openGlobalSearch("fast");
    await search.settled();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(search.state().query).toBe("fast");
    expect(search.state().answer?.total_files).toBe(2);
  });
});
```

In `host/packages/host/test/shim-internal-plugins.test.ts`, change the existing case `reports the six absent core plugins with a null instance`: it enables `global-search` and expects a null instance for it, so this task turns it red. Drop `"global-search"` from its id list (its `core-plugins.json` may keep enabling it) and retitle it `reports the five view-only core plugins and templates with a null instance`. Then add one case: with `core-plugins.json` enabling `global-search`, `getPluginById("global-search")?.instance` is a `GlobalSearchInstance` and `getEnabledPluginById("global-search")` returns the same object; with it disabled, `instance` is `null` and `getEnabledPluginById` is `null`. Update that file's header sentence ("tag-wrangler asks for `global-search`") to say the instance is now real. In `host/packages/host/test/golden/tag-wrangler.test.ts`, the case `degrades honestly when it reaches for global-search` stays true only because that vault has no `core-plugins.json` (so `global-search` is disabled); retitle it `degrades honestly when it reaches for global-search without core-plugins.json enabling it`, assertions unchanged.

Create `host/packages/host/test/global-search-real-daemon.test.ts`, skipped unless `BINARY_EXISTS` (the pattern every `*-real-daemon.test.ts` uses), which starts the production wiring with `startHost` over a scratch vault holding `.obsidian/core-plugins.json` = `{"global-search": true}` and two notes, `A.md` (`#project meeting`) and `B.md` (`meeting`), as `host-wiring-real-daemon.test.ts` does, and asserts: `host.search` with `{"query":"meeting"}` answers both paths; the shim's `app.internalPlugins.getPluginById("global-search").instance.openGlobalSearch("tag:#project")` raises one `host.search_opened` to a subscribed host client with `query` `tag:#project` and `total_files` 1; `host.search_state` then answers that query and `A.md`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm --prefix host test -- test/shim-global-search.test.ts; echo "exit=$?"`

Expected: the import of `../src/shim/global-search` fails, `exit=1`.

- [ ] **Step 3: Implement**

`shim/global-search.ts`: the class above. `openGlobalSearch` sets `query`, clears `answer` and `error`, increments a sequence number, and starts `client.request("search", { query, limit: 100 })` without awaiting it; when it settles, it applies the result only if its sequence number is still the newest (so an older, slower search never overwrites a newer one), then calls every `onOpened` listener with the state. `settled()` returns the promise of the newest open (resolved, never rejected). A refusal is recorded as `error` (the `Error`'s message) and never thrown into the caller: Obsidian's `openGlobalSearch` returns nothing and throws nothing to a plugin. A file header in the style of `internal-plugins.ts` says what "open" means headless and that only the two corpus methods exist, and the policy rows: `declarePolicy("GlobalSearchInstance.openGlobalSearch", "implemented")`, `declarePolicy("GlobalSearchInstance.getGlobalSearchQuery", "implemented")`, with `recordUse` in each.

`internal-plugins.ts`: `InternalPluginDeps` gains `globalSearch: GlobalSearchInstance`; `VIEW_ONLY` loses `global-search` (and its doc comment says five view ids now); `readAndRebuild` sets `next["global-search"] = { id: "global-search", enabled, instance: enabled ? deps.globalSearch : null }` after the `VIEW_ONLY` loop. The header's first paragraph changes from "Two are reimplemented" to three, naming `global-search` and what it does.

`ops.ts`: `host.search` validates that `query` is a string (else `new HostError("invalid_request", …)`, the refusal the table already uses for a malformed parameter), forwards the params object unchanged to the engine through the client, and returns the engine's answer or relays its error code; `host.search_state` returns `{ query, answer, error }`. `server.ts`'s `subscribeToSources` adds `this.deps.globalSearch.onOpened((state) => this.broadcast({ type: "host.search_opened", value: { query: state.query, total_files: state.answer?.total_files ?? null, error: state.error } }))`. `testing/assemble.ts` constructs one `GlobalSearchInstance({ client })`, passes it to the `InternalPluginRegistry` and exposes it as `HostAssembly.globalSearch`; `host.ts` and `testing/host-harness.ts` pass `assembly.globalSearch` into `new HostServer({ … })`, whose `HostServerDeps` now requires it, so the type checker names any other construction site.

- [ ] **Step 4: Run the tests and see them pass**

```bash
npm --prefix host test -- test/shim-global-search.test.ts; echo "exit=$?"
npm --prefix host test -- test/shim-internal-plugins.test.ts; echo "exit=$?"
npm --prefix host test -- test/golden/tag-wrangler.test.ts; echo "exit=$?"
cargo build --release -p vault-server; echo "exit=$?"
npm --prefix host test -- test/global-search-real-daemon.test.ts; echo "exit=$?"
```

Expected: `exit=0` five times, and the real-daemon file runs rather than skips (the release binary exists after the fourth command).

- [ ] **Step 5: The host gates**

```bash
npm --prefix host run lint; echo "exit=$?"
npm --prefix host run typecheck; echo "exit=$?"
npm --prefix host test -- test/api-policy.test.ts; echo "exit=$?"
npm --prefix host test -- test/server-ops.test.ts; echo "exit=$?"
```

Expected: `exit=0` four times. `api-policy.test.ts` checks that every declared policy row is used and every used one declared; `server-ops.test.ts` lists the operation table, and gains the two names.

- [ ] **Step 6: Commit**

```bash
git add host/packages/host
git commit -F - <<'COMMIT'
feat(host): a real global-search instance, host.search and host.search_state

global-search leaves the view-only list. When core-plugins.json enables it, its instance has the two methods the corpus calls: openGlobalSearch makes the query the host's current search, runs it on the engine and raises host.search_opened, never throwing into the plugin, and the newest open always wins; getGlobalSearchQuery returns the current query. Headless, opening a search means exactly that: host state any host client reads through host.search_state. host.search passes a query through to the engine. tag-wrangler's three search menu items now act.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 8: The HTMX spike's search box — on `spike/htmx-client-clean`, as the demo

The visible half of the MVP. On the spike's own branch, `spike/htmx-client-clean`, a search box posts to `/search`, which calls the daemon's `search` over the socket and renders each hit's path and its matched lines with the spans highlighted from `line_text` and `line_text_start`, plus `total_files`, a "more" link that follows `next_cursor`, the six sorts, and the Match case toggle; a `query_invalid` or `unsupported_operator` refusal renders its message with a caret under its `position`.

**When and where.** Task 8 runs last in the MVP, after every `feat/search` task (1 to 7, 9 and 10) is committed and the worktree is clean, and in that same worktree. `feat/search` is never merged into the spike branch (Global Constraints): the spike's code stays on `spike/htmx-client-clean`, and the spike runs against a `vaultd` built from `feat/search`, either by pointing the spike at that build with its `--binary` flag (the smoke passes server flags through) or, for a hand-run demo, by attaching it with `--connect SOCKET` to a running `feat/search` daemon. The spike branch is `spike/htmx-client-clean`, never `spike/htmx-client`, an older branch that is not its ancestor.

**Files (on `spike/htmx-client-clean` only):**

- Modify: `spikes/htmx-client/server.js` (the `/search` route and the box in the page shell), `spikes/htmx-client/smoke.js` (the smoke cases)

- [ ] **Step 1: Build the search daemon, then switch branches**

```bash
git status --short --branch; echo "exit=$?"
cargo build --release -p vault-server; echo "exit=$?"
mkdir -p target/tmp/vaultd-search && cp target/release/vaultd target/tmp/vaultd-search/vaultd; echo "exit=$?"
git switch spike/htmx-client-clean; echo "exit=$?"
```

Expected: a clean tree on `feat/search`, then `exit=0` three times. `target/` is untracked, so the copied binary survives the switch, and no build on the spike branch can overwrite it. If `git switch` refuses because another worktree has `spike/htmx-client-clean` checked out, stop and report; never force it, and never merge.

- [ ] **Step 2: Write the failing smoke cases** — in `smoke.js`, beside the Bases cases and in their style: over the smoke vault, `GET /search?q=meeting` answers 200 with every note holding `meeting` and a `<mark>` around each occurrence in the line text; `GET /search?q=a%20b)` answers 200 with the refusal message and a caret at character 3; `GET /search?q=meeting&limit=1` carries a "more" link whose next request lists the second file; `GET /search?q=Meeting&match_case=1` lists only the case-exact notes.

- [ ] **Step 3: Run them and see them fail** — `node spikes/htmx-client/smoke.js --binary target/tmp/vaultd-search/vaultd; echo "exit=$?"`; expected: the new cases fail with 404, `exit=1`.

- [ ] **Step 4: Implement** — the route forwards `q`, `match_case`, `sort`, `cursor` and `limit` to `search` with `context: "line"`, escapes every text it renders, and highlights by slicing `line_text` at `span.start - line_text_start` and `span.end - line_text_start` (byte offsets: slice the UTF-8 `Buffer`, never the JavaScript string). The search box is an htmx form targeting a results `<div>`.

- [ ] **Step 5: Run them and see them pass** — `node spikes/htmx-client/smoke.js --binary target/tmp/vaultd-search/vaultd; echo "exit=$?"`; expected `exit=0`. Then `npm --prefix host run lint; echo "exit=$?"`, expected `exit=0` if the spike is covered by the lint config, and the spike's own `node --check` on both files otherwise.

- [ ] **Step 6: Commit and switch back**

```bash
git add spikes/htmx-client
git commit -F - <<'COMMIT'
spike(htmx): a search box over the daemon's search, with highlighted lines

The page gains a search box: /search forwards the query, the case toggle, the sort and the cursor to search, renders each file with its matched lines and the spans marked from line_text and line_text_start (sliced as UTF-8 bytes), follows next_cursor for more, and shows a refused query's message with a caret at its position.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
git switch feat/search
```

---
### Task 9: Performance — the harness's `--search` case and the MVP baseline

Measure the six numbers of the design's **Performance requirements** and write `docs/performance/search-baseline.md`, in the house style of `docs/performance/bases-evaluation-baseline.md`: environment, the numbers against their bounds, per-run tables with the load at each run's start, the mechanism of every miss, and the commands.

**Files:**

- Modify: `host/scripts/socket-transport-baseline.js` (`--search <query>` repeatable, `--search-cache-entries <n>` passed through to the daemon, `--prose-bytes <n>`; the existing `--notes` sets the fixture size)
- Create: `docs/performance/search-baseline.md`
- Create: `crates/vault-index/tests/search_timing.rs` (the publication-during-search measurement, `#[ignore]`d as `bases_timing.rs` is, and run with `--ignored`; no environment variable gates it)

- [ ] **Step 1: The harness case** — `--search <query>` adds, per query, an uncached series (the daemon runs with `--search-cache-entries 1` and the harness alternates the query with a twin that differs only by a trailing space inside a phrase, so every sample is a computation, as the Bases harness alternated twin views) and a cached series (the same query again and again at one generation) with `context: "none"`, because requirement 2 is the cache's cost and a `context: "line"` page reads its notes' lines from SQLite on every request, cached or not; a third series repeats the cached page with `context: "line"` and is reported beside it without a bound. When any `--search` is given, the fixture is built with the Bases fields (`buildVault(root, count, true)`: a `rank` property and a `#group-N` tag line, `N = i % 10`) and one more deterministic line, `meeting notes`, on every tenth note (`i % 10 === 0`), so on the 10,000-note fixture `meeting group` answers 1,000 files (each of those notes holds `#group-0`), `tag:#group-3` answers 1,000 and `file:Note-0001` answers 100; every series prints the `total_files` of its first answer, so an empty answer is visible. `--prose-bytes <n>` makes the generated fixture's notes about `n` bytes of generated prose each (seeded word salad from a fixed list that holds neither `meeting` nor `group`, so a run is reproducible and the answer counts above do not move), on top of the existing title, property, tag and link lines. The harness's existing refusal of a `--vault` that is not under `target/` is unchanged and covers the new flags.

- [ ] **Step 2: The timing test** — `publications_while_a_search_runs`: the 10,000-note fixture under `target/tmp`, one whole-vault plain-term search alone (p50 of 5), then 41 one-note publishes 7 ms apart while searches run on another thread, recording each publish's duration; it asserts nothing about time (a timing assertion in the suite is a flake, as `README.md` records) and prints the numbers the baseline quotes, but it asserts that each search answers every note of the fixture (the plain term `note`, which every note's title holds), so a broken search cannot pass as a fast one.

- [ ] **Step 3: Measure** — on a quiet machine, every run behind `fleet-gate` with the 5-minute load under 4, each series three daemon runs, two series alternated, release build:

```bash
cargo build --release -p vault-server -p vault-index; echo "exit=$?"
node host/scripts/socket-transport-baseline.js --repeat 3 --search "meeting group" --search "tag:#group-3" --search "file:Note-0001"; echo "exit=$?"
node host/scripts/socket-transport-baseline.js --repeat 3 --prose-bytes 3000 --search "meeting group"; echo "exit=$?"
node host/scripts/socket-transport-baseline.js --repeat 1 --notes 100000 --search "meeting group"; echo "exit=$?"
TMPDIR="$PWD/target/tmp" cargo test --release -p vault-index --test search_timing -- --ignored --nocapture; echo "exit=$?"
```

and the reconciliation comparison against the phase-8 binaries built from `main` in a throwaway worktree (cold build, one-note `write_note`, 100-note burst), alternated head, main, as the Bases baseline did.

- [ ] **Step 4: Write the baseline** — the six numbers with verdicts (requirement 2 judged on the `context: none` series, as the design states it; the `context: line` series reported beside it); the 100,000-note number marked observational, with the statement the design asks for: whether it is over 500 ms, and therefore whether the FTS5 trigram follow-on should be brought to the owner. A miss on numbers 1 to 5 is reported with its mechanism, and fixed in this task only if the fix is inside `vault-search` or `query/search.rs` and changes no answer (for example the `is_match` short-circuit Task 2 allows, or `sort_by_cached_key` Task 3 allows), with the property tests re-run.

- [ ] **Step 5: The gates** — the workspace tests, clippy, fmt, MSRV, and `npm --prefix host run lint`, each with its exit code.

- [ ] **Step 6: Commit**

```bash
git add host/scripts/socket-transport-baseline.js crates/vault-index/tests/search_timing.rs docs/performance/search-baseline.md
git commit -F - <<'COMMIT'
perf(search): the harness's search case and the MVP baseline

The socket harness measures search uncached and cached, on the 10,000-note synthetic fixture, on a prose fixture of about 3 KB per note, and once on 100,000 notes; a timing test measures publications while a search runs. docs/performance/search-baseline.md reports the six numbers against the design's bounds with the load at every run's start, the reconciliation comparison against phase 8, and whether the 100,000-note number triggers the trigram follow-on.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 10: The MVP documents — `docs/protocol.md`, `docs/protocol-host.md`, `README.md`, `VAULTD-COMPATIBILITY.md`, and the design and plan in `docs/`

Document what the MVP ships, and move the two planning documents to their public homes.

**Files:**

- Modify: `docs/protocol.md`, `docs/protocol-host.md`, `README.md`, `VAULTD-COMPATIBILITY.md`, `docs/design/semantic-read-path.md`, `crates/vault-server/tests/docs.rs`
- Modify: `docs/design/search.md` and `docs/plans/search-implementation.md` (moved there on `feat/search` before Task 1; they do not exist on `main`; this task updates the design's Status and fixes any link that still points at a working copy)

- [ ] **Step 1: Write the failing pins** — in `tests/docs.rs`, in the style of its Bases pins: `docs/protocol.md` has a `### \`search\`` heading, a `## Search` section, the phrases `query_invalid`, `unsupported_operator`, `"position"`, `--search-cache-entries`, and no longer lists `search` under **Reserved operation families**; `README.md` names `--search-cache-entries`; `VAULTD-COMPATIBILITY.md` has a `## Search parity` heading and names every provisional rule `P1` to `P18`; `docs/protocol-host.md` names `host.search`, `host.search_state` and `host.search_opened`; and a test `every_search_error_code_is_documented_exactly_once`, in the shape of `every_bases_error_code_is_documented_exactly_once`, pins `query_invalid` and `unsupported_operator` to exactly one definition line each in `## Errors`. Run `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test docs; echo "exit=$?"`; expected: the new pins fail, `exit=101`.

- [ ] **Step 2: `docs/protocol.md`**

1. In **Daemon configuration**, the flag line `--search-cache-entries <1..=1024>    # search answers kept per generation, default 16` and a sentence on what it bounds.
2. After `list_bases`, a `### \`search\`` operation section: the parameters (`query`, `match_case`, `sort` and its six values, `context`, `cursor`, `limit`), the answer (`generation`, `total_files`, `total_matches`, `items` with `path`, `kind`, `path_matches` in UTF-16 units, `content_matches` with `span` in UTF-8 bytes and `start`/`end` as UTF-16 `Loc`s, `line_text` and `line_text_start`, `matches_truncated` with the cap of 100, and that `kind`'s value `canvas` is reserved and never produced in this phase (Ruling 4, issue #3)), the request and response examples of the design, one computation per query and generation, the cursor's bindings, an empty query, the refusals, and the page size: the per-file cap keeps a default page (100 files) with line text near 7 MB, inside the 16 MiB payload cap, while a `limit` above 100 with `context: line` is not bounded by that cap (a documented limit, as `read_dir`'s is). `tests/protocol_doc_examples.rs` checks the examples decode and re-encode.
3. A `## Search` section after `## Bases`: the grammar as implemented (the design's grammar block, AND binding tighter than OR, negation, phrases and escapes, the operators the MVP evaluates and the ones it refuses with `unsupported_operator`), what each scope reads, the file universe rule, how spans are chosen, case folding, positions, the freshness contract (re-ask on a newer `generation_committed`; no search event; live subscriptions are later, issue #1), that canvas content is not searched in this phase (a canvas is a `file`, reached by `file:` and `path:` only; issue #3), and a pointer to `VAULTD-COMPATIBILITY.md` for the provisional rules.
4. In **Errors**, the two codes and the `position` field, in the Bases codes' style.
5. In **Reserved operation families**, remove `search` and add a sentence that it landed as the `search` operation.
6. In **Evolution**, the tolerated list gains "a search hit's `kind`".

- [ ] **Step 3: The other documents**

- `docs/protocol-host.md`: `host.search` and `host.search_state` beside the other operations, `host.search_opened` beside the other events, and the `global-search` instance in the internal-plugins paragraph (what "open" means headless; only the two methods exist).
- `README.md`: under **Current milestone**, a first subsection `### On the branch \`feat/search\`: search` — what the daemon does with a query, the MVP operators, the flag, and where the details are (`docs/protocol.md` **Search**, `docs/design/search.md`, `docs/performance/search-baseline.md`, `VAULTD-COMPATIBILITY.md` **Search parity**); in the Bases subsection, nothing changes.
- `VAULTD-COMPATIBILITY.md`: a `## Search parity` section after **Bases parity**: the contract (for a query, `search` answers the files Obsidian's Search lists, with the same match spans and, under each sort, the same order, except where a deviation is named); the sources the behaviour comes from; the provisional rules `P1` to `P18`, one line each, all marked provisional until the parity harness captures them; what the MVP refuses with `unsupported_operator`; the documented limits (the per-file match cap of 100; canvas content is not searched in this phase, Ruling 4, issue #3: a canvas is a `file` kind and is reached only by `file:` and `path:`, never by a plain term, so parity excludes canvas content until then; excluded files not yet honoured until Task 15). The "Recoverable transactions, search, CLI commands …" sentence in Tier 2 drops "search".
- `docs/design/semantic-read-path.md`: one line at the end of **Deferred follow-on**: "Search landed in phase 9; see `docs/design/search.md`."
- `docs/design/search.md`: Status says the direction was approved and when; the Rulings section is checked to still hold Rulings 1 to 6 in the owner's words (the former Open questions are Rulings 4 to 6), and nothing is added to it; `docs/plans/search-implementation.md` is checked for links that still point at a working copy.

- [ ] **Step 4: Run the pins and the examples**

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test docs --test protocol_doc_examples; echo "exit=$?"
```

Expected: every test passes, `exit=0`. A failing example names its block; fix the example, never the test.

- [ ] **Step 5: The MVP's final gates**

```bash
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
npm --prefix host run lint; echo "exit=$?"
npm --prefix host run typecheck; echo "exit=$?"
```

Expected: `exit=0` six times. The MVP's `feat/search` side is complete here; Task 8 runs next, on the spike branch, and the demo runs from there.

- [ ] **Step 6: Commit**

```bash
git add docs README.md VAULTD-COMPATIBILITY.md crates/vault-server/tests/docs.rs
git commit -F - <<'COMMIT'
docs: search in the protocol, the host protocol, the README and the compatibility contract

docs/protocol.md documents the search operation with checked examples, a Search section with the grammar as implemented, the scopes, the file universe, spans, folding, positions and freshness, the two error codes and the position field, and removes search from the reserved families. The host protocol documents host.search, host.search_state, host.search_opened and the global-search instance. The compatibility contract gains a Search parity section listing every provisional rule and saying canvas content is out of this phase. The design's status records its approval.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---

# Part 2 — The parity operators (Tasks 11 to 17)

Each task removes one group of refusals from `compile`, adds the facets the index must supply, and edits `every_parity_operator_is_refused_by_name_in_the_mvp` (renamed in Task 11 to `every_operator_this_build_lacks_is_refused_by_name`) by deleting the rows it implements. The design's former Open questions are ruled (Rulings 4 to 6). Task 14 (canvas content) is removed from this phase by Ruling 4 and tracked as issue #3; its number is kept so the later tasks keep theirs.

---
### Task 11: Regular expressions — `/…/` terms in every scope, through the Bases JavaScript-regex compiler

A regex term matches where its pattern matches, in whatever scope it stands: the default scope, `content:`, `file:`, `path:`, and `tag:` (against the tag text without `#`). It follows the case toggle and the case operators (P11): when the resolved mode is insensitive, `i` is added to its flags. It compiles through `vault-bases`' compiler, which already translates JavaScript's character classes and refuses what the `regex` crate cannot express; a construct the crate lacks (look-around, back-references) is `unsupported_operator` naming it, and a pattern that does not compile at all is `query_invalid`, both at the term's position. An empty match makes the term true and contributes no span.

**Files:**

- Create: `crates/vault-bases/src/regexp.rs`, `crates/vault-search/tests/regex.rs`
- Modify: `crates/vault-bases/src/lib.rs` (`pub mod regexp;`), `crates/vault-bases/src/eval/mod.rs` (`compile_regexp` calls `regexp::compile` and maps its error to `EvalError::Argument`, behaviour unchanged), `crates/vault-search/src/text.rs` (`Needle::regex`), `crates/vault-search/src/compile.rs`, `crates/vault-search/tests/evaluate.rs` (the refusal test loses its two regex rows and is renamed `every_operator_this_build_lacks_is_refused_by_name`), `crates/vault-server/tests/search_ops.rs` (one case)

**Interfaces:**

- Consumes: `vault_bases::RegexpValue`; Tasks 1–3.
- Produces:

```rust
// vault-bases
pub mod regexp {
    /// Compile a JavaScript regular-expression literal's source and flags.
    /// `Err` carries the reason; `RegexpError::Unsupported` when the pattern
    /// needs a feature the `regex` crate lacks (look-around, back-references).
    pub fn compile(source: &str, flags: &str) -> Result<RegexpValue, RegexpError>;
    pub enum RegexpError { Invalid(String), Unsupported(String) }
}
// vault-search
impl Needle { pub fn regex(source: &str, flags: &str, sensitive: bool) -> Result<Needle, vault_bases::regexp::RegexpError>; }
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-search/tests/regex.rs`:

```rust
use vault_search::{CompileError, FileHit, MemoryDocument, compile, evaluate, parse_query};

fn hits_case(query: &str, match_case: bool, docs: &[MemoryDocument]) -> Vec<FileHit> {
    let compiled = compile(&parse_query(query).unwrap(), match_case).unwrap_or_else(|e| panic!("{query:?}: {e:?}"));
    docs.iter().filter_map(|doc| evaluate(&compiled, doc)).collect()
}

#[test]
fn the_help_pages_iso_date_matches_content_and_paths() {
    let docs = [
        MemoryDocument::note("Daily/2022-01-01.md", "x"),
        MemoryDocument::note("Notes/Plan.md", "due 2022-07-15 ok"),
        MemoryDocument::note("Notes/None.md", "due 2022-7-15"),
    ];
    let found = hits_case(r"/\d{4}-\d{2}-\d{2}/", false, &docs);
    assert_eq!(found.len(), 2);
    assert_eq!(found[1].content_matches[0].span, 4..14);
    let by_path = hits_case(r"path:/\d{4}-\d{2}-\d{2}/", false, &docs);
    assert_eq!(by_path.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), ["Daily/2022-01-01.md"]);
}

#[test]
fn a_regex_follows_the_case_toggle_and_the_case_operators() {
    let docs = [MemoryDocument::note("c.md", "ABC")];
    assert_eq!(hits_case("/abc/", false, &docs).len(), 1, "P11: insensitive by default");
    assert!(hits_case("/abc/", true, &docs).is_empty());
    assert!(hits_case("match-case:/abc/", false, &docs).is_empty());
    assert_eq!(hits_case("/abc/i", true, &docs).len(), 1, "an explicit i flag wins");
}

#[test]
fn a_regex_in_tag_scope_matches_the_tag_text_without_the_hash() {
    let docs = [
        MemoryDocument::note("1.md", "#work").with_tag("work", 0..5),
        MemoryDocument::note("2.md", "#work/meeting").with_tag("work/meeting", 0..13),
        MemoryDocument::note("3.md", "#myjob/work").with_tag("myjob/work", 0..11),
    ];
    let found = hits_case("tag:/^work/", false, &docs);
    assert_eq!(found.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), ["1.md", "2.md"]);
}

#[test]
fn javascript_classes_are_ascii_as_in_javascript() {
    // `\d` is ASCII in JavaScript; the Bases compiler translates it so.
    let docs = [MemoryDocument::note("d.md", "\u{0663}")];
    assert!(hits_case(r"/\d/", false, &docs).is_empty());
}

#[test]
fn an_empty_match_makes_the_term_true_without_a_span() {
    let found = hits_case("/x*/", false, &[MemoryDocument::note("e.md", "abc")]);
    assert_eq!(found.len(), 1);
    assert!(found[0].content_matches.is_empty());
}

#[test]
fn look_around_is_unsupported_and_a_broken_pattern_is_invalid() {
    match compile(&parse_query("a /(?<=a)b/").unwrap(), false) {
        Err(CompileError::Unsupported { what, position }) => {
            assert!(what.contains("look"), "{what}");
            assert_eq!(position, 2);
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
    match compile(&parse_query("/a(/").unwrap(), false) {
        Err(CompileError::Invalid(error)) => assert_eq!(error.position, 0),
        other => panic!("expected Invalid, got {other:?}"),
    }
}
```

In `crates/vault-server/tests/search_ops.rs`, add `a_broken_regex_is_query_invalid`: `/a(/` answers `query_invalid` with `position` 0.

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test regex; echo "exit=$?"`

Expected: every test fails with `Unsupported { what: "regular expression", .. }` from Task 3's `lower_term`, `exit=101`.

- [ ] **Step 3: Implement**

Move the body of `vault_bases::eval::compile_regexp` into `regexp::compile`, returning `RegexpError::Invalid` for a repeated or unknown flag and for a `regex` build error, and `RegexpError::Unsupported` when the build error is the `regex` crate's look-around or back-reference refusal (detected the way `vault-bases` already detects a look-behind; the Bases design's **Deferred follow-on** records that this detection reads the crate's error text, which a test pins). `eval::compile_regexp` becomes a three-line wrapper; the whole `vault-bases` suite stays green unchanged.

`Needle::regex(source, flags, sensitive)` adds `i` to `flags` when `!sensitive` and `flags` lacks it, compiles through `regexp::compile`, and stores the `regex::Regex`; `find_all` is `find_iter` keeping only non-empty matches; `is_match` is `Regex::is_match`. In `compile.rs`, `lower_term` builds a regex needle for `Pattern::Regex`, mapping `RegexpError::Unsupported(m)` to `CompileError::Unsupported { what: format!("regular expression {m}"), position: term.at.start }` and `Invalid(m)` to `CompileError::Invalid(QueryError { message: m, position: term.at.start })`; in the tag domain a regex term tests `needle.is_match(tag)` against each tag's text instead of `tag_matches`. Delete the two regex rows from the refusal test and rename it.

- [ ] **Step 4: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-bases -p vault-search -p vault-index; echo "exit=$?"` then `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test search_ops; echo "exit=$?"`

Expected: `exit=0` twice.

- [ ] **Step 5: The gates** — the workspace tests, clippy, fmt and MSRV check, each with its exit code.

- [ ] **Step 6: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(search): regular-expression terms in every scope

A /…/ term matches where its pattern matches, in the default scope, content:, file:, path: and tag:, following the case toggle and the case operators. It compiles through the Bases JavaScript-regex compiler, now public as vault_bases::regexp::compile: a construct the regex crate lacks is unsupported_operator naming it, and a pattern that does not compile is query_invalid, both at the term's position. An empty match makes the term true and adds no span.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 12: The structural scopes — `line:`, `block:`, `section:`, `task:`, `task-todo:` and `task-done:`, with sub-queries

Each structural scope evaluates its whole sub-query against each unit of the note and holds when one unit satisfies it; `-line:(…)` therefore means no line does. The units (P13): a line is a line of the text; a block is one of Obsidian's `sections` (the top-level blocks `vaultd` already indexes); a section runs from one heading to the next heading of any level, and the text before the first heading is a section too; a task is a list item with a task box, and `task-todo:` takes a box holding a space while `task-done:` takes any other character (P12). Inside a unit, a default-scope term matches the unit's text only, never the path. Spans come from the units that satisfied the scope.

**Files:**

- Create: `crates/vault-search/tests/structure.rs`
- Modify: `crates/vault-search/src/document.rs` (`Structure`, `Unit`, `SearchDocument::structure`, `MemoryDocument::with_structure`), `crates/vault-search/src/compile.rs` (the six scopes, `Needs.structure`), `crates/vault-search/src/evaluate.rs` (unit evaluation), `crates/vault-search/tests/evaluate.rs` (delete the six rows; the four `Needs { … }` literals in `needs_and_the_file_universe_are_computed_from_the_tree` gain `structure: false`), `crates/vault-index/src/query/search.rs` (read `sections`, `headings`, `list_items` when needed), `crates/vault-index/tests/search_query.rs` (one case)

**Interfaces:**

- Produces:

```rust
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Structure {
    /// Obsidian's sections: one byte span per top-level block, in order.
    pub blocks: Vec<std::ops::Range<usize>>,
    /// The byte offset where each heading starts, in order.
    pub heading_starts: Vec<usize>,
    /// Every list item with a task box.
    pub tasks: Vec<Unit>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Unit { pub span: std::ops::Range<usize>, pub task: char }
pub trait SearchDocument { /* … */ fn structure(&self) -> Option<&Structure> { None } }
impl MemoryDocument { pub fn with_structure(self, structure: Structure) -> Self; }
pub struct Needs { pub text: bool, pub tags: bool, pub structure: bool }
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-search/tests/structure.rs`:

```rust
use vault_search::{FileHit, MemoryDocument, Structure, Unit, compile, evaluate, parse_query};

fn matching(query: &str, docs: &[MemoryDocument]) -> Vec<String> {
    found(query, docs).into_iter().map(|h| h.path.as_str().to_string()).collect()
}
fn found(query: &str, docs: &[MemoryDocument]) -> Vec<FileHit> {
    let compiled = compile(&parse_query(query).unwrap(), false).unwrap_or_else(|e| panic!("{query:?}: {e:?}"));
    docs.iter().filter_map(|doc| evaluate(&compiled, doc)).collect()
}
fn note(path: &str, text: &str, structure: Structure) -> MemoryDocument {
    MemoryDocument::note(path, text).with_structure(structure)
}

#[test]
fn line_needs_every_term_on_one_line_and_its_negation_on_none() {
    let docs = [
        MemoryDocument::note("apart.md", "mix the\nflour"),
        MemoryDocument::note("together.md", "first\nmix the flour"),
    ];
    assert_eq!(matching("line:(mix flour)", &docs), ["together.md"]);
    assert_eq!(matching("-line:(mix flour)", &docs), ["apart.md"]);
    assert_eq!(found("line:(mix flour)", &docs)[0].content_matches.iter().map(|m| m.span.clone()).collect::<Vec<_>>(), vec![6..9, 14..19]);
}

#[test]
fn block_uses_the_indexed_top_level_blocks() {
    let two = Structure { blocks: vec![0..3, 5..8], ..Structure::default() };
    let one = Structure { blocks: vec![0..7], ..Structure::default() };
    let docs = [note("two.md", "dog\n\ncat", two), note("one.md", "dog cat", one)];
    assert_eq!(matching("block:(dog cat)", &docs), ["one.md"]);
}

#[test]
fn section_runs_from_heading_to_heading_and_the_preamble_counts() {
    // "# A\n" is 0..4 and "dog\n" 4..8, so the second heading starts at 8.
    let split = Structure { heading_starts: vec![0, 8], ..Structure::default() };
    let joined = Structure { heading_starts: vec![0], ..Structure::default() };
    let preamble = Structure { heading_starts: vec![8], ..Structure::default() };
    let docs = [
        note("split.md", "# A\ndog\n# B\ncat", split),
        note("joined.md", "# A\ndog cat", joined),
        note("preamble.md", "dog cat\n# H\nx", preamble),
    ];
    assert_eq!(matching("section:(dog cat)", &docs), ["joined.md", "preamble.md"]);
}

#[test]
fn task_scopes_read_the_box() {
    let text = "call here\n- [ ] call mom\n- [x] email bob\n- [-] call off\n";
    let structure = Structure {
        tasks: vec![
            Unit { span: 10..24, task: ' ' },
            Unit { span: 25..40, task: 'x' },
            Unit { span: 41..55, task: '-' },
        ],
        ..Structure::default()
    };
    let docs = [note("t.md", text, structure), MemoryDocument::note("plain.md", "call email")];
    assert_eq!(matching("task:call", &docs), ["t.md"]);
    assert_eq!(matching("task:(call OR email)", &docs), ["t.md"]);
    assert_eq!(matching("task-todo:email", &docs), Vec::<String>::new());
    assert_eq!(matching("task-done:email", &docs), ["t.md"]);
    assert_eq!(matching("task-done:off", &docs), ["t.md"], "P12: any non-space box is done");
    let spans: Vec<_> = found("task-todo:call", &docs)[0].content_matches.iter().map(|m| m.span.clone()).collect();
    assert_eq!(spans, vec![16..20], "spans only from the units that satisfied the scope");
}

#[test]
fn a_term_inside_a_unit_never_matches_the_path() {
    let docs = [MemoryDocument::note("meeting.md", "nothing here")];
    assert_eq!(matching("meeting", &docs), ["meeting.md"]);
    assert!(matching("line:meeting", &docs).is_empty());
}
```

Byte offsets in `task_scopes_read_the_box`: `call here\n` is 0..10, `- [ ] call mom` 10..24 (`call` at 16..20), `\n`, `- [x] email bob` 25..40, `\n`, `- [-] call off` 41..55. In `line_needs_every_term_on_one_line_and_its_negation_on_none`, line 2 starts at 6: `mix` 6..9, `flour` 14..19.

In `crates/vault-index/tests/search_query.rs`, add `structural_scopes_read_the_indexed_rows`: a note `# A\ndog\n\n# B\ncat\n- [ ] call\n` answers `section:(dog cat)` with nothing, `block:dog` with the note, and `task-todo:call` with the note.

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test structure; echo "exit=$?"`

Expected: the build fails on `Structure`, `Unit` and `with_structure`, `exit=101`.

- [ ] **Step 3: Implement**

`compile.rs` lowers the six scopes to `Compiled::Scoped`, and `survey` sets `needs.text` for all six and `needs.structure` for `block`, `section` and the three task scopes. In `evaluate.rs`, a structural scope computes its units from the document (`line`: `LineIndex` line ranges over the text; `block`: `structure.blocks`; `section`: the ranges between consecutive `heading_starts`, plus `0..first` when the first heading does not start at 0, and the last running to the end; `task`, `task-todo`, `task-done`: `structure.tasks` filtered by `task`), and holds when `units.iter().any(|unit| holds(query, &UnitView { doc, span: unit.clone() }, Domain::Content))`, where `UnitView` is a private `SearchDocument` whose `text()` is the unit's slice and whose tags are those inside the unit. `collect` visits each unit that holds and adds its positive spans shifted by the unit's start. A document with no `structure` has no blocks, sections or tasks (so the scope is false, and its negation true).

In `query/search.rs`, when `needs().structure`, read for the kept notes `SELECT span_start, span_end FROM sections WHERE note_path = ?1 ORDER BY ordinal`, `SELECT span_start FROM headings WHERE note_path = ?1 ORDER BY ordinal` and `SELECT span_start, span_end, task FROM list_items WHERE note_path = ?1 AND task IS NOT NULL ORDER BY ordinal`, prepared once per scan, and pass the `Structure` with the document.

Delete the six structural rows from the refusal test.

- [ ] **Step 4: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search -p vault-index; echo "exit=$?"`

Expected: `exit=0`.

- [ ] **Step 5: The gates** — the workspace tests, clippy, fmt and MSRV check, each with its exit code.

- [ ] **Step 6: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(search): line:, block:, section: and the task scopes, with sub-queries

Each structural scope evaluates its sub-query against each unit of the note and holds when one unit satisfies it, so a negated scope means no unit does: lines of the text, the indexed top-level blocks, sections from heading to heading with the preamble as one, and list items with a task box, todo for a space and done for any other character. Inside a unit a term matches the unit's text only. The index reads sections, headings and task items only when a query needs them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 13: Property search — `[name]`, `[name:value]`, `[name:null]`, `[name:<n]`, `[name:>n]`, with sub-queries

A property node matches a note that has a property whose name satisfies the name sub-query and, when a value is given, whose value satisfies it (P14): a name word or phrase matches a key equal to it ignoring case, a name regex searches the key; `null` matches a property with no value (a YAML null, not `""` and not `[]`, as the help page says); a value sub-query is evaluated against the value's text, and a list property matches when one element does; `<` and `>` compare numbers, and a list when one element does. A value match's span is the value's span in the source.

**Files:**

- Create: `crates/vault-search/tests/properties.rs`
- Modify: `crates/vault-search/src/document.rs` (`PropertyFact`, `PropertyFactValue`, `SearchDocument::properties`, `MemoryDocument::with_property`), `crates/vault-search/src/compile.rs` (properties, `Needs.properties`), `crates/vault-search/src/evaluate.rs`, `crates/vault-search/tests/evaluate.rs` (delete `every_operator_this_build_lacks_is_refused_by_name`, whose last row this task implements; the refusal that remains, a regex construct the `regex` crate lacks, is pinned by `look_around_is_unsupported_and_a_broken_pattern_is_invalid` in `tests/regex.rs`; the four `Needs { … }` literals gain `properties: false`), `crates/vault-index/src/query/search.rs` (read `properties` when needed), `crates/vault-index/tests/search_query.rs` (one case)

**Interfaces:**

- Produces:

```rust
#[derive(Clone, Debug, PartialEq)]
pub enum PropertyFactValue { Null, Text(String), Number(f64), Bool(bool), List(Vec<PropertyFactValue>), Other(String) }
#[derive(Clone, Debug, PartialEq)]
pub struct PropertyFact { pub key: String, pub value: PropertyFactValue, pub value_span: std::ops::Range<usize> }
pub trait SearchDocument { /* … */ fn properties(&self) -> &[PropertyFact] { &[] } }
impl MemoryDocument { pub fn with_property(self, key: &str, value: PropertyFactValue, value_span: std::ops::Range<usize>) -> Self; }
pub struct Needs { pub text: bool, pub tags: bool, pub structure: bool, pub properties: bool }
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-search/tests/properties.rs`:

```rust
use vault_search::{MemoryDocument, PropertyFactValue as V, compile, evaluate, parse_query};

fn matching(query: &str, docs: &[MemoryDocument]) -> Vec<String> {
    let compiled = compile(&parse_query(query).unwrap(), false).unwrap_or_else(|e| panic!("{query:?}: {e:?}"));
    docs.iter().filter_map(|doc| evaluate(&compiled, doc)).map(|h| h.path.as_str().to_string()).collect()
}

fn docs() -> Vec<MemoryDocument> {
    vec![
        MemoryDocument::note("draft.md", "").with_property("status", V::Text("Draft".into()), 12..17),
        MemoryDocument::note("published.md", "").with_property("Status", V::Text("Published".into()), 12..21),
        MemoryDocument::note("empty.md", "").with_property("aliases", V::Null, 9..9),
        MemoryDocument::note("quoted.md", "").with_property("aliases", V::Text(String::new()), 9..11),
        MemoryDocument::note("brackets.md", "").with_property("aliases", V::List(vec![]), 9..11),
        MemoryDocument::note("named.md", "").with_property("aliases", V::List(vec![V::Text("Name".into()), V::Text("Other".into())]), 9..23),
        MemoryDocument::note("short.md", "").with_property("duration", V::Number(3.0), 10..11),
        MemoryDocument::note("long.md", "").with_property("duration", V::Number(8.0), 10..11),
        MemoryDocument::note("none.md", "no properties"),
    ]
}

#[test]
fn presence_matches_the_name_ignoring_case() {
    assert_eq!(matching("[status]", &docs()), ["draft.md", "published.md"]);
    assert_eq!(matching("[aliases]", &docs()), ["empty.md", "quoted.md", "brackets.md", "named.md"]);
}

#[test]
fn null_matches_only_an_empty_value() {
    assert_eq!(matching("[aliases:null]", &docs()), ["empty.md"], "not \"\" and not []");
}

#[test]
fn a_value_sub_query_matches_text_and_any_list_element() {
    assert_eq!(matching("[status:Draft OR Published]", &docs()), ["draft.md", "published.md"]);
    assert_eq!(matching("[aliases:Name]", &docs()), ["named.md"]);
    assert_eq!(matching("[aliases:oth]", &docs()), ["named.md"], "P14: substring, ignoring case");
    assert_eq!(matching(r#"[status:"Draft"]"#, &docs()), ["draft.md"]);
    assert_eq!(matching("[status:/^pub/]", &docs()), ["published.md"]);
}

#[test]
fn comparisons_compare_numbers() {
    assert_eq!(matching("[duration:<5]", &docs()), ["short.md"]);
    assert_eq!(matching("[duration:>5]", &docs()), ["long.md"]);
    assert_eq!(matching("meeting [duration:<5]", &[MemoryDocument::note("m.md", "meeting").with_property("duration", V::Number(1.0), 0..1)]), ["m.md"]);
}

#[test]
fn a_negated_property_and_a_value_span() {
    assert_eq!(matching("-[status]", &docs()).len(), 7);
    let compiled = compile(&parse_query("[status:draft]").unwrap(), false).unwrap();
    let hit = evaluate(&compiled, &docs()[0]).unwrap();
    assert_eq!(hit.content_matches[0].span, 12..17);
}
```

In `crates/vault-index/tests/search_query.rs`, add `properties_come_from_the_index`: a note `---\nstatus: Draft\naliases:\nduration: 3\ntags: [a]\n---\n` answers `[status:draft]`, `[aliases:null]` and `[duration:<5]`, and not `[duration:>5]`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test properties; echo "exit=$?"`

Expected: the build fails on the missing types, `exit=101`.

- [ ] **Step 3: Implement**

`compile.rs` lowers `Node::Property` to `Compiled::Property { name: Box<Compiled>, value: Option<CompiledValue> }`, where `CompiledValue` is `Null`, `Query(Box<Compiled>)`, `Less(f64)` or `Greater(f64)`, and sets `needs.properties`. Name evaluation runs the name sub-query in a private `Domain::Key` where a text term holds when `fold_js(key) == fold_js(text)` (or exact, under match-case) and a regex term when it matches the key. Value evaluation: `Null` holds for `PropertyFactValue::Null`; a `Query` is evaluated in a private `Domain::Value` against each element's text (`Text` as is, `Number` as JavaScript prints it — whole numbers without `.0` — `Bool` as `true`/`false`, `Other` as stored, `List` element by element, `Null` as never), holding when any element does; `Less` and `Greater` compare `Number` elements. `collect` adds a value match's `value_span`. In `query/search.rs`, when `needs().properties`, read `SELECT key_text, value_json, value_span_start, value_span_end FROM properties WHERE note_path = ?1 ORDER BY ordinal` and decode `value_json` with the crate's `codec::decode_property_value`, mapping `PropertyValue` to `PropertyFactValue` (a mapping becomes `Other` with its JSON text).

- [ ] **Step 4: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search -p vault-index; echo "exit=$?"`

Expected: `exit=0`.

- [ ] **Step 5: The gates** — the workspace tests, clippy, fmt and MSRV check, each with its exit code.

- [ ] **Step 6: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(search): property search with null, comparisons and sub-queries

[name] matches a note with that property, ignoring case; [name:null] only an empty value, not "" or []; [name:value] evaluates the value sub-query against the value's text, a list when one element matches; [name:<n] and [name:>n] compare numbers. A value match's span is the value's span in the source. The index reads properties only when a query needs them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 14: Canvas content — REMOVED from this phase (Ruling 4, issue #3)

**Do not execute this task.** Ruling 4 of the design: no canvas search until `vaultd` supports canvas files ("no need to build search for it until we support them"); tracked as issue #3, canvas support first, then canvas text in search. The text below is kept only as the starting point for issue #3. Nothing in Tasks 1 to 13 or 15 to 21 depends on it, and this phase changes no schema.

Obsidian searches canvas content by default. A `.canvas` becomes a stored file kind: schema v6 adds a `canvases` table, reconciled in the same generation as any other change on both routes, holding the canvas's revision, bytes, observed size and time, and its search text: the `text` of every text node, in node order, joined by a blank line (P16). A canvas is a `DocumentKind::Canvas` document: its text is the search text, its path is searched like a note's (P2), and its content spans and `Loc`s point into the search text, not into the file's JSON bytes, which `docs/protocol.md` states. A canvas that is not valid JSON is indexed with empty search text.

**Files:**

- Create: `crates/vault-search/src/canvas.rs`, `crates/vault-search/tests/canvas.rs`, `crates/vault-index/src/schema_v6.sql`, `crates/vault-index/tests/canvases_index.rs`
- Modify: `crates/vault-search/Cargo.toml` (`serde_json.workspace = true`), `crates/vault-index/src/schema.rs` (version 6), `src/store.rs`, `src/store/delta.rs`, `src/store/hydrate.rs`, `src/live_reconcile.rs`, `src/reconcile.rs`, `src/inventory.rs` (`.canvas` as a stored kind, modelled exactly on how `.base` became one in phase 8), `src/query/search.rs` (canvas rows as documents; `match_contexts` reads the search text for a canvas), the schema tests that name the current version

**Interfaces:**

- Produces:

```rust
pub mod canvas {
    #[derive(Clone, Debug, Default, PartialEq)]
    pub struct CanvasText { pub text: String }
    /// The search text of a canvas: its text nodes' `text`, in node order,
    /// joined by "\n\n". `Err` when the source is not a JSON canvas.
    pub fn extract_text(source: &str) -> Result<CanvasText, String>;
}
// vault-index
pub const SQL_SCHEMA_VERSION: u32 = 6; pub const SEMANTIC_FORMAT_VERSION: u32 = 6;
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-search/tests/canvas.rs`:

```rust
use vault_search::canvas::extract_text;

#[test]
fn text_nodes_are_joined_in_order_and_other_nodes_are_left_out() {
    let source = r#"{"nodes":[
        {"id":"1","type":"text","text":"first idea","x":0,"y":0,"width":1,"height":1},
        {"id":"2","type":"file","file":"Notes/A.md","x":0,"y":0,"width":1,"height":1},
        {"id":"3","type":"link","url":"https://example.com","x":0,"y":0,"width":1,"height":1},
        {"id":"4","type":"text","text":"second \"quoted\"\nline","x":0,"y":0,"width":1,"height":1}
    ],"edges":[]}"#;
    assert_eq!(extract_text(source).unwrap().text, "first idea\n\nsecond \"quoted\"\nline");
}

#[test]
fn an_empty_canvas_has_empty_text_and_a_broken_one_is_an_error() {
    assert_eq!(extract_text(r#"{"nodes":[],"edges":[]}"#).unwrap().text, "");
    assert_eq!(extract_text("{}").unwrap().text, "");
    assert!(extract_text("{nodes").is_err());
}
```

Create `crates/vault-index/tests/canvases_index.rs` (on the model of `tests/bases_index.rs`): a canvas create, change and delete each move the generation and the `canvases` table; `search` with `idea` finds a canvas holding a text node `first idea` as `DocumentKind::Canvas` with its span into the search text; a plain term matching the canvas's path finds it; a broken canvas is indexed with empty text and found by `file:`; a genuine version-five cache is replaced by schema six (`a_genuine_version_five_cache_is_replaced_by_schema_six`, built from `schema_v5.sql` the way the v4 test builds its obsolete cache).

- [ ] **Step 2: Run the tests and see them fail**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test canvas; echo "exit=$?"` and `TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test canvases_index; echo "exit=$?"`

Expected: both fail to build, `exit=101` twice.

- [ ] **Step 3: Implement**

`extract_text` deserializes with `serde_json` into a minimal shape (`nodes: Vec<{ type: String, text: Option<String> }>`, both defaulted when absent) and joins the `text` of `type == "text"` nodes with `"\n\n"`. `schema_v6.sql` is `schema_v5.sql` plus `canvases (path TEXT PRIMARY KEY, content_revision TEXT NOT NULL, source_bytes BLOB NOT NULL, observed_size INTEGER NOT NULL CHECK (observed_size >= 0), observed_mtime_seconds INTEGER NOT NULL, observed_mtime_nanos INTEGER NOT NULL CHECK (…), search_text TEXT NOT NULL)` with a comment in the style of the `bases` table's. The reconciler parses `.canvas` files beside `.md` and `.base` on both routes, in the same generation; the store writes, deletes and hydrates the rows; the tree row stays `kind = 'file'` (a canvas is still a file in the tree), and the search scan maps a tree row whose path has a `canvases` row to `DocumentKind::Canvas`, reading `search_text` as its text. `match_contexts` cuts lines from `search_text` for a canvas.

- [ ] **Step 4: Run the tests and see them pass**

Run: `TMPDIR="$PWD/target/tmp" cargo test -p vault-search -p vault-index; echo "exit=$?"`

Expected: `exit=0`, including every existing schema and recovery test, which now name version six.

- [ ] **Step 5: The gates** — the workspace tests, clippy, fmt and MSRV check, each with its exit code.

- [ ] **Step 6: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(index): canvases as a stored kind, so search reads canvas content

Schema v6 adds a canvases table reconciled in the same generation as any other change on both routes, holding each canvas's bytes and its search text: its text nodes' text in node order, joined by a blank line. A canvas is a Canvas document, searched by content and by path like a note, with spans into its search text. A canvas that is not JSON is indexed with empty text. A version-five cache is rebuilt, never migrated.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 15: Excluded files — `userIgnoreFilters` from `.obsidian/app.json`, an exclusion epoch, and `include_excluded`

Obsidian hides files matching the Excluded files setting from results. The daemon reads `userIgnoreFilters` from `.obsidian/app.json` through the configuration zone when a search is computed, as Bases reads `.obsidian/types.json`; each filter is a path prefix, or a JavaScript regex when written `/…/` (P17). An exclusion epoch, bumped by a change to that file through this daemon or seen by the watcher, keys the cache, so an answer computed under older exclusions is never served again. The watcher passes exactly `.obsidian/app.json` beside `.obsidian/types.json`. `include_excluded: true` sees everything.

**Files:**

- Create: `crates/vault-search/src/exclusions.rs`, `crates/vault-search/tests/exclusions.rs`
- Modify: `crates/vault-search/Cargo.toml` (`serde_json`), `crates/vault-search/src/lib.rs`, `crates/vault-index/src/query/search.rs` (`SearchQuery.exclusions`; every `SearchQuery { … }` literal in `tests/search_query.rs`, `tests/search_timing.rs` and `vault-server` gains `exclusions: &Exclusions::none()`), `crates/vault-protocol/src/search.rs` (`SearchParams.include_excluded`), `crates/vault-server/src/search.rs` (key and cursor gain the epoch and the flag), `crates/vault-server/src/lib.rs` (`exclusion_epoch`, the read, the bump on `config_changed` for `app.json`), `crates/vault-watch` (pass `.obsidian/app.json`; its test), `crates/vault-server/tests/search_ops.rs` (cases)

**Interfaces:**

- Produces:

```rust
pub struct Exclusions { /* prefixes and regexes */ }
impl Exclusions { pub fn none() -> Self; pub fn excludes(&self, path: &VaultPath) -> bool; }
/// `userIgnoreFilters` from an `app.json` text; a missing key, a file that
/// does not parse, or a filter that is not a string means no exclusions from it.
pub fn parse_exclusions(app_json: &str) -> Exclusions;
pub struct SearchQuery<'a> { pub compiled: &'a CompiledQuery, pub sort: SortOrder, pub exclusions: &'a Exclusions }
pub struct SearchParams { /* … */ #[serde(default)] pub include_excluded: bool }
impl Server { pub fn exclusion_epoch(&self) -> u64; }
```

- [ ] **Step 1: Write the failing tests**

Create `crates/vault-search/tests/exclusions.rs`:

```rust
use vault_core::VaultPath;
use vault_search::parse_exclusions;

fn vp(p: &str) -> VaultPath { VaultPath::new(p).unwrap() }

#[test]
fn prefixes_and_regexes_exclude_and_nothing_else_does() {
    let exclusions = parse_exclusions(r#"{"userIgnoreFilters":["Archive/","/\\.excalidraw\\.md$/"],"other":1}"#);
    assert!(exclusions.excludes(&vp("Archive/old.md")));
    assert!(exclusions.excludes(&vp("Drawings/a.excalidraw.md")));
    assert!(!exclusions.excludes(&vp("Notes/Archive.md")));
    assert!(!exclusions.excludes(&vp("Notes/a.md")));
}

#[test]
fn a_missing_or_broken_setting_excludes_nothing() {
    assert!(!parse_exclusions("{}").excludes(&vp("a.md")));
    assert!(!parse_exclusions("not json").excludes(&vp("a.md")));
    assert!(!parse_exclusions(r#"{"userIgnoreFilters":[3,null]}"#).excludes(&vp("a.md")));
}
```

In `crates/vault-server/tests/search_ops.rs`, add `excluded_files_are_hidden_and_the_epoch_moves_with_app_json`: a vault with `Archive/old.md` and `Notes/new.md`, both holding `meeting`, and `.obsidian/app.json` excluding `Archive/`; `meeting` answers `Notes/new.md`; with `include_excluded: true`, both; after a `write_file` of `.obsidian/app.json` with no filters (through the daemon), `meeting` answers both at the same generation (the epoch moved, the cache did not serve the old answer); a cursor from before the change is `invalid_cursor`. In `crates/vault-watch`'s tests, add that an external write of `.obsidian/app.json` raises a hint, as the `types.json` test does.

- [ ] **Step 2: Run the tests and see them fail** — `TMPDIR="$PWD/target/tmp" cargo test -p vault-search --test exclusions; echo "exit=$?"`; expected: build failure, `exit=101`.

- [ ] **Step 3: Implement** — `parse_exclusions` with `serde_json` (added to `crates/vault-search/Cargo.toml` in this task as `serde_json.workspace = true`; Task 14, which would have added it, is removed from this phase), regex filters through `vault_bases::regexp::compile` (a filter that does not compile is ignored, and the server logs one stderr line naming it); `IndexReader::search` skips an excluded file before the prefilter unless the caller passes `Exclusions::none()`; the server reads `.obsidian/app.json` through the raw read engine when it computes an answer (not on a cache hit), keeps `exclusion_epoch` exactly as it keeps the types epoch (bumped before the `config_changed` event is sent for this daemon's own `write_file` and for a watcher hint naming the file), adds the epoch and `include_excluded` to the cache key, and adds `x` (`include_excluded`) and `e` (the epoch) to the cursor, refusing a cursor whose epoch is not current with `invalid_cursor` and the message "the excluded-files setting changed; restart the listing". In `docs/protocol.md`'s **`config_changed`** section the watcher exception sentence names both files (Task 21 checks it).

- [ ] **Step 4: Run the tests and see them pass** — `TMPDIR="$PWD/target/tmp" cargo test -p vault-search -p vault-watch -p vault-server; echo "exit=$?"`; expected `exit=0` (the known load-dependent `vault-watch` smoke test is re-run alone on a failure).

- [ ] **Step 5: The gates** — the workspace tests, clippy, fmt and MSRV check, each with its exit code.

- [ ] **Step 6: Commit**

```bash
git add crates docs/protocol.md
git commit -F - <<'COMMIT'
feat(search): honour Obsidian's excluded files, with an exclusion epoch

search hides files matching userIgnoreFilters in .obsidian/app.json, path prefixes or /regex/ filters, read through the configuration zone when an answer is computed; include_excluded sees everything. An exclusion epoch, bumped by this daemon's own write of app.json and by the watcher, which now passes app.json beside types.json, keys the cache and the cursor, so an answer computed under older exclusions is never served again.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 16: `explain` — the parsed query as a tree

Obsidian's **Explain search term** breaks a query down in prose; the daemon answers the same breakdown structurally. `explain: true` adds `explain` to the answer: the parsed tree, each node with its `kind` (`and`, `or`, `not`, `word`, `phrase`, `regex`, `scope`, `case`, `property`, and for a property's value `null` or `compare`), its text, scope or sensitivity where it has one, its character range in the query, and its children. Numbers travel as strings so the response keeps its `Eq` derive. Matching Obsidian's prose wording is a non-goal.

**Files:**

- Create: `crates/vault-search/src/explain.rs`, `crates/vault-search/tests/explain.rs`
- Modify: `crates/vault-protocol/src/search.rs` (`ExplainNodeDto`, `SearchParams.explain`, `SearchResponse.explain` with `skip_serializing_if = "Option::is_none"`), `crates/vault-server/src/search.rs`, `crates/vault-server/src/convert.rs`, `crates/vault-server/tests/search_ops.rs` (one case)

**Interfaces:**

- Produces:

```rust
pub mod explain {
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ExplainNode {
        pub kind: &'static str,
        pub text: Option<String>,
        pub scope: Option<&'static str>,
        pub sensitive: Option<bool>,
        pub at: std::ops::Range<usize>,
        pub children: Vec<ExplainNode>,
    }
    pub fn explain(query: &Query) -> Option<ExplainNode>;
}
```

- [ ] **Step 1: Write the failing tests** — `crates/vault-search/tests/explain.rs`: `meeting -(work meetup) tag:#x` explains as `and` with children `word "meeting"` (0..7), `not` with one `and` child of two words, and `scope tag` with child `word "#x"`; `[duration:<5]` explains as `property` with children `word "duration"` and a `compare` node of text `<5`; an empty query explains as `None`. In `search_ops.rs`, `explain_is_returned_only_when_asked`: `{"query":"a OR b","explain":true}` carries `explain.kind == "or"`, and without the flag the response has no `explain` key.

- [ ] **Step 2: Run the tests and see them fail** — build failure, `exit=101`.

- [ ] **Step 3: Implement** — a walk over `Query` (positions kept), the DTO mirroring `ExplainNode` with `at` as `{"start","end"}` character offsets; the handler computes it from the parsed query when `explain` is set, after compile succeeds (a refused query answers its refusal, which already names a position).

- [ ] **Step 4: Run the tests and see them pass** — `TMPDIR="$PWD/target/tmp" cargo test -p vault-search -p vault-protocol -p vault-server --test search_ops --test explain; echo "exit=$?"`; expected `exit=0`.

- [ ] **Step 5: The gates** — as before.

- [ ] **Step 6: Commit**

```bash
git add crates
git commit -F - <<'COMMIT'
feat(search): explain a query as its parsed tree

explain: true adds the parsed query to the answer as a tree: each node's kind, its text, scope or sensitivity, its character range in the query and its children, the structural counterpart of Obsidian's Explain search term. The prose wording is not reproduced.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 17: Embedded ```` ```query ```` blocks in the HTMX spike — on `spike/htmx-client-clean`

The spike renders a fenced code block whose info string is `query` as live results: the block's body is the query, answered by `search` with `context: "line"` and rendered as Task 8 renders hits; the block re-asks when a `generation_committed` newer than its answer arrives, through the spike's existing event subscription. A refused query renders its message in place.

**Files (on `spike/htmx-client-clean` only):** `spikes/htmx-client/server.js`, `spikes/htmx-client/smoke.js`.

- [ ] **Step 1: Build and switch** — as Task 8 Step 1, after Task 16 is committed on `feat/search`: build `vaultd` from `feat/search`, copy it to `target/tmp/vaultd-search/vaultd`, and switch to `spike/htmx-client-clean`. Never merge `feat/search` into it. The smoke runs as `node spikes/htmx-client/smoke.js --binary target/tmp/vaultd-search/vaultd`.
- [ ] **Step 2: Write the failing smoke cases** — a note holding ```` ```query\nmeeting\n``` ```` renders the results list for `meeting` in place of the code block; after the smoke script writes a new note holding `meeting` through the daemon, the next poll of that note's results fragment lists it; a block holding `a b)` renders the refusal.
- [ ] **Step 3: Run them and see them fail** — `node spikes/htmx-client/smoke.js; echo "exit=$?"`, `exit=1`.
- [ ] **Step 4: Implement** — in the note renderer, replace each `query` block with an htmx fragment that loads `/search?q=…&embed=1`; the fragment carries the answer's generation and is re-requested when the spike's event loop sees a newer `generation_committed`, the way embedded Bases views re-render on `views_invalidated`.
- [ ] **Step 5: Run them and see them pass** — `exit=0`.
- [ ] **Step 6: Commit and switch back**

```bash
git add spikes/htmx-client
git commit -F - <<'COMMIT'
spike(htmx): embedded query blocks rendered live from search

A fenced query block renders as the results of its query, answered by search with line context, and re-asks when a newer generation_committed arrives; a refused query shows its message in place.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
git switch feat/search
```

---

# Part 3 — The parity harness (Tasks 18 to 21)

The owner's final step: the same queries through a running Obsidian and through `vaultd`, on one generated vault, compared. Task 19 has one human stop in this phase: the owner opens the generated vault in Obsidian once. The optional real-vault run (the copy by hand, and opening the copy) is deferred to issue #2 by Ruling 6.

---
### Task 18: The parity corpus and the query set — a generated vault and every query that probes it

A generator writes the parity vault's manifest and the query set as committed fixtures, and materializes the vault under `target/tmp` for Obsidian to open. Nothing in either fixture comes from a real vault: every name and every line is made up by the generator.

**Files:**

- Create: `host/scripts/search-parity.js` (modes `generate` and `materialize`; Task 19 adds `copy` and `capture`)
- Create: `crates/vault-server/tests/fixtures/search-parity/corpus.json`, `crates/vault-server/tests/fixtures/search-parity/queries.jsonl` (both written by `generate`, committed)
- Create: `crates/vault-server/tests/search_replay.rs` (this task: the fixture checks and the Rust materializer; Task 20: the replay)

**Interfaces:**

- Produces:

```text
node host/scripts/search-parity.js generate --out crates/vault-server/tests/fixtures/search-parity
node host/scripts/search-parity.js materialize --fixtures crates/vault-server/tests/fixtures/search-parity --corpus target/tmp/search-parity

corpus.json   {"files":[{"path":"…","text":"…"}|{"path":"…","base64":"…"}, … with "mtime_ms" on each]}
queries.jsonl {"id":"q001","query":"…","match_case":false,"sort":"file_name_asc","probes":["P1","plain"],"expect":"answer"|"refused"}
```

**What the corpus holds** — each line names the rule or operator it exists for; the generator writes at least these, and the fixture test (Step 1) checks the probes are covered:

- Plain text: words that are substrings of other words (`work`, `homework`, `workshop`) for P1; a note whose path holds a word its text does not (`Projects/Alpha plan.md`) for P2; frontmatter holding a word the body does not for P5; `OR` and `or` as words in text for P6; `foo:bar` in text for P7.
- Case and Unicode for P3 and P4: `HappyCat` and `happycat`; `İstanbul`; the Kelvin sign; `ΟΔΟΣ` and `οδος` with a final sigma; `café` in NFC and `café` in NFD in two notes; `straße` and `STRASSE`; CJK (`会議の議事録`); emoji; punctuation-joined words (`well-known`, `e-mail`, `C++`, `#hashtag-like` inside a code span).
- Tags for P9: body tags `#work`, `#work/meeting`, `#myjob/work`, `#Work`; a frontmatter `tags: [project]`; `#notatag` inside a fenced code block.
- Structure for P12 and P13: headings of mixed levels with words split across sections and joined within one; a preamble before the first heading; paragraphs that split and join words across blocks; task items `- [ ]`, `- [x]`, `- [X]`, `- [-]`, `- [>]`, and a plain list item holding the same words.
- Properties for P14: `status: Draft`, `Status: Published`, `aliases:` (empty), `aliases: ""`, `aliases: []`, `aliases: [Name, Other]`, `duration: 3`, `duration: 8`, `rank: "5"` (a number written as text).
- Canvases for P16: one with two text nodes, a file node and a link node; one that is not JSON. Canvas content is out of this phase (Ruling 4, issue #3), so Task 20 records each canvas-content difference in `deviations.json` with the ruling `Ruling 4: "no need to build search for it until we support them" (issue #3)`, and P16 stays provisional.
- Attachments for P10 and `file:`: `img/cat.png`, `img/dog.png`, `docs/Report 2022-07-15.pdf`.
- Excluded files for P17: `.obsidian/app.json` with `"userIgnoreFilters":["Excluded/","/\\.draft\\.md$/"]`, a note under `Excluded/` and a `Notes/x.draft.md`, both holding a common word.
- Sorting for P15: names that differ only in case (`zed.md`, `Zed.md` in two folders), numeric names (`Note 2.md`, `Note 10.md`), accented names (`Éclair.md`, `eclair.md`), and distinct `mtime_ms` for every file, two files sharing one.
- Spans for P18: a note whose name and text both hold the searched word; a note with more than 100 occurrences of a word (the per-file cap).
- `.obsidian/core-plugins.json` enabling `global-search`.

**What the query set holds** — at least one query per line below, and each line's queries carry its probe names:

- Every query on the help page that the corpus can answer (Task 1's checklist), with `match_case` both ways where case matters.
- `plain`: single words, two words, three words, a phrase with an escaped quote; P1, P2, P5, P6, P7 each probed directly.
- `or`, `group`, `negation`: `a b OR c d`, `a (b OR c) d`, `-a`, `a -b -c`, `a -(b c)`, `-file:.png`, `-tag:#work`, `-line:(a b)`, and a double negation.
- Each scope alone and negated: `file:`, `path:`, `content:`, `tag:` (with and without `#`), `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:`, `match-case:`, `ignore-case:`, each with a word, a phrase and, where it takes one, a sub-query with `OR`.
- `regex`: the help page's date regex in content and in `path:`; `/abc/` under both case modes and with an explicit `i`; a regex in `tag:`; `/\d/` against a non-ASCII digit; an empty-matching regex.
- `property`: `[status]`, `[aliases]`, `[aliases:null]`, `[aliases:Name]`, `[status:Draft OR Published]`, `[duration:<5]`, `[duration:>5]`, `[rank:<9]`, `-[status]`.
- `canvas`: a word only a canvas text node holds; a word only a canvas file node's path holds.
- `excluded`: the common word of the excluded notes (Obsidian hides them).
- `sort`: one multi-file query under each of the six sorts.
- `refused`: `(a b`, `a b)`, `"abc`, `a -`, `OR a`, `file:`, `[]`, `/a(/`, each `"expect":"refused"`, recording what Obsidian does with a query this daemon refuses (P8).

- [ ] **Step 1: Write the failing fixture test**

Create `crates/vault-server/tests/search_replay.rs` with:

```rust
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use vault_core::VaultPath;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/search-parity")
}

#[derive(Deserialize)]
struct Corpus { files: Vec<CorpusFile> }
#[derive(Deserialize)]
struct CorpusFile { path: String, #[serde(default)] text: Option<String>, #[serde(default)] base64: Option<String>, mtime_ms: i64 }
#[derive(Deserialize)]
struct QueryRow { id: String, query: String, match_case: bool, sort: String, probes: Vec<String>, expect: String }

fn corpus() -> Corpus {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("corpus.json")).unwrap()).unwrap()
}
fn queries() -> Vec<QueryRow> {
    std::fs::read_to_string(fixtures().join("queries.jsonl")).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

const RULES: [&str; 18] = ["P1","P2","P3","P4","P5","P6","P7","P8","P9","P10","P11","P12","P13","P14","P15","P16","P17","P18"];
const FAMILIES: [&str; 22] = [
    "plain", "or", "group", "negation", "file", "path", "content", "tag", "line", "block", "section", "task",
    "task-todo", "task-done", "match-case", "ignore-case", "regex", "property", "canvas", "excluded", "sort", "refused",
];
const SORTS: [&str; 6] = ["file_name_asc", "file_name_desc", "modified_desc", "modified_asc", "created_desc", "created_asc"];

#[test]
fn the_parity_corpus_and_queries_are_well_formed() {
    let corpus = corpus();
    let mut seen = BTreeSet::new();
    for file in &corpus.files {
        let in_config = file.path.starts_with(".obsidian/");
        assert!(in_config || VaultPath::new(file.path.as_str()).is_ok(), "{}", file.path);
        assert!(seen.insert(file.path.clone()), "duplicate {}", file.path);
        assert!(file.text.is_some() != file.base64.is_some(), "{}: text or base64", file.path);
        assert!(file.mtime_ms > 0);
    }
    let queries = queries();
    let mut ids = BTreeSet::new();
    let probed: BTreeSet<&str> = queries.iter().flat_map(|q| q.probes.iter().map(String::as_str)).collect();
    for row in &queries {
        assert!(ids.insert(row.id.clone()), "duplicate id {}", row.id);
        assert!(SORTS.contains(&row.sort.as_str()), "{}: sort {}", row.id, row.sort);
        let parsed = vault_search::parse_query(&row.query);
        match row.expect.as_str() {
            "answer" => assert!(parsed.is_ok(), "{}: {:?}", row.id, parsed.err()),
            "refused" => assert!(parsed.is_err() || vault_search::compile(&parsed.unwrap(), row.match_case).is_err(), "{}", row.id),
            other => panic!("{}: expect {other}", row.id),
        }
        let _ = row.match_case;
    }
    for name in RULES.iter().chain(FAMILIES.iter()).chain(SORTS.iter()) {
        assert!(probed.contains(name) || queries.iter().any(|q| q.sort == *name), "nothing probes {name}");
    }
}
```

Add `vault-search = { path = "../vault-search" }` to `crates/vault-server/Cargo.toml`'s `[dev-dependencies]` if the normal dependency added in Task 6 does not already reach the test. Run `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test search_replay; echo "exit=$?"`; expected: the fixtures are missing, `exit=101`.

- [ ] **Step 2: Write the generator** — `host/scripts/search-parity.js`, CommonJS like `bases-capture.js`, with the corpus and query tables as data in the script, so the fixtures are reproducible: `generate --out <dir>` writes `corpus.json` (stable key order, files sorted by path) and `queries.jsonl` (ids `q001` upward in table order); `materialize --fixtures <dir> --corpus <dir>` refuses a `--corpus` that is not inside the repository's `target/tmp` (compared as real paths, as `bases-capture.js` compares them), refuses a non-empty `--corpus`, writes every file, and sets each file's modification time from `mtime_ms` with `fs.utimesSync` (creation times cannot be set portably; the replay compares the created-time sorts as Task 20 says).

- [ ] **Step 3: Generate and check**

```bash
node host/scripts/search-parity.js generate --out crates/vault-server/tests/fixtures/search-parity; echo "exit=$?"
node host/scripts/search-parity.js materialize --fixtures crates/vault-server/tests/fixtures/search-parity --corpus target/tmp/search-parity; echo "exit=$?"
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test search_replay; echo "exit=$?"
npm --prefix host run lint; echo "exit=$?"
```

Expected: `exit=0` four times. A probe the fixture test reports as missing is added to the generator's tables, never removed from the test's lists.

- [ ] **Step 4: Commit**

```bash
git add host/scripts/search-parity.js crates/vault-server/tests/fixtures/search-parity crates/vault-server/tests/search_replay.rs crates/vault-server/Cargo.toml
git commit -F - <<'COMMIT'
test(search): the parity corpus and query set, generated and committed

host/scripts/search-parity.js generates a made-up parity vault's manifest and a query set that probes every operator, every sort, both case modes and every provisional rule P1 to P18, including queries this daemon refuses, and materializes the vault under target/tmp with its modification times. A test checks the fixtures are well formed and that every rule, operator family and sort is probed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 19: Capture — Obsidian's answers through the `obsidian` CLI, and the optional real-vault run

**Two human stops.** (1) The owner opens `target/tmp/search-parity` in Obsidian once, as a vault named `search-parity`, with the core Search plugin enabled (the materialized `core-plugins.json` enables it). (2) Optional, and deferred to issue #2 by Ruling 6: the owner runs the copy mode by hand over a real vault and opens the copy once as `search-corpus`. In this phase the task blocks at stop 1 only, until the owner reports it done.

The capture drives only the documented and best-effort routes the design names: `obsidian search … format=json` (and `total`, and `case`) for the file set and the match count; `obsidian search:context … format=json` for lines; and `obsidian eval` of the search view's own answer after `openGlobalSearch(query)`, for spans and order. Every CLI call runs with the corpus as its working directory, and before the first call and again inside every `eval` the script checks that the vault the CLI answers for is the corpus path, exiting 3 otherwise, as `bases-capture.js` does. It never reads or writes outside `--corpus`, `--out` and `--corpus-out`.

**Files:**

- Modify: `host/scripts/search-parity.js` (modes `copy` and `capture`)
- Create: `crates/vault-server/tests/fixtures/search-captures/meta.json` and one `<id>.json` per query (written by `capture`, committed)

**Interfaces:**

- Produces:

```text
node host/scripts/search-parity.js capture --corpus target/tmp/search-parity --vault-name search-parity \
     --fixtures crates/vault-server/tests/fixtures/search-parity --out crates/vault-server/tests/fixtures/search-captures
node host/scripts/search-parity.js copy --from <the owner's vault> --corpus target/tmp/search-corpus     # owner only; needs VAULTD_CORPUS_GUARDED
node host/scripts/search-parity.js capture --corpus target/tmp/search-corpus --vault-name search-corpus \
     --fixtures crates/vault-server/tests/fixtures/search-parity [--saved-searches] [--corpus-out <dir>]

<id>.json  {"id","query","match_case","sort",
            "cli":{"raw_search":<the CLI's JSON verbatim>,"raw_context":<verbatim>,"files":["…"],"total":n|null},
            "view":{"files":[{"path":"…","matches":[[start,end],…]}],"order":["…"],"routes":{"case":bool,"sort":bool}}|null,
            "view_error":"…"|null}
meta.json  {"obsidian_version","cli_help_search","date","vault_name","view_methods":[…],"cli_sample":{…},"routes":{…}}
```

- [ ] **Step 1: The discovery run** — `capture --discover` (after stop 1) records into `meta.json`: Obsidian's version (`obsidian version`), the full `obsidian help search` and `help search:context` text, one raw `search format=json` and one raw `search:context format=json` answer for the query `meeting`, and the search view's method and property names (`Object.getOwnPropertyNames(Object.getPrototypeOf(view))` and `Object.keys(view)` for the `search` leaf's view after `openGlobalSearch("meeting")`). Commit nothing yet. From these, write the two adapters the capture needs, with the discovered names as constants at the top of the script and each one's source cited to `meta.json`: `cliFiles(raw)` (the file list out of the CLI's JSON) and the view reader below. If the view exposes no way to set the case toggle or the sort, the capture records `routes.case` or `routes.sort` as `false` and captures those queries through the CLI alone.

- [ ] **Step 2: The view reader** — the `eval` body, with the discovered names in place of the three marked ones:

```js
(async () => {
  const QUERY = __QUERY__, MATCH_CASE = __CASE__, SORT = __SORT__, CORPUS = __CORPUS__;
  if (app.vault.adapter.basePath !== CORPUS) return JSON.stringify({ error: "wrong vault" });
  const plugin = app.internalPlugins.getPluginById("global-search");
  if (!plugin || !plugin.enabled) return JSON.stringify({ error: "global-search is disabled" });
  plugin.instance.openGlobalSearch(QUERY);
  const view = app.workspace.getLeavesOfType("search")[0].view;
  const caseRoute = typeof view[SET_CASE] === "function";        // SET_CASE: discovered in Step 1
  const sortRoute = typeof view[SET_SORT] === "function";        // SET_SORT: discovered in Step 1
  if (caseRoute) view[SET_CASE](MATCH_CASE);
  if (sortRoute) view[SET_SORT](SORT);
  const read = () => {
    const files = [];
    for (const [file, item] of view.dom.resultDomLookup) {
      files.push({ path: file.path, matches: (item.result && item.result.content) || [] });
    }
    return files;
  };
  let last = "", stable = 0;
  for (let i = 0; i < 200 && stable < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const now = JSON.stringify(read());
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  const order = (view.dom[CHILDREN] || []).map((child) => child.file && child.file.path).filter(Boolean); // CHILDREN: discovered
  return JSON.stringify({ files: read(), order, routes: { case: caseRoute, sort: sortRoute } });
})()
```

`resultDomLookup` (a map keyed by file) is the route the forum thread [S4 of the design] shows; whether `item.result.content` holds the content matches as `[start, end]` pairs in UTF-16 units, and whether file-name matches appear under another key, is exactly what Step 1's discovery records and P18 asks. The poll waits for four equal reads 50 ms apart (at most 10 s), because the view fills asynchronously.

- [ ] **Step 3: Capture the generated vault** (after stop 1) — run the capture command for `search-parity`. For each query row it runs the two CLI routes (with `case` when `match_case`) and the view reader (with that row's sort), and writes `<id>.json`; a CLI call or an `eval` that fails is recorded in the file, never retried silently. Before writing, it checks that every path in every capture is a path the corpus manifest names (a capture that names anything else exits 4: it would mean the CLI answered for another vault). Then `meta.json` is written with the date and the routes that worked.

- [ ] **Step 4: The optional real-vault run** (stop 2) — **deferred to issue #2 by Ruling 6; not run in this phase.** The copy mode is still written and linted here, so issue #2 starts from it. When issue #2 runs it: `copy` refuses to run unless `VAULTD_CORPUS_GUARDED` names the guarded private folder, never descends into it, copies only `.md` and `.canvas` files and, from the settings, only `.obsidian/app.json` and `.obsidian/core-plugins.json`, into a `--corpus` inside `target/tmp` that must be empty, and prints the count of files it copied (never their names). After the owner opens the copy, `capture --corpus target/tmp/search-corpus` runs the committed query set and, with `--saved-searches`, the `query` of every `search` item in the copy's `.obsidian/bookmarks.json` (which the copy mode also takes when that flag is given), writing to `--corpus-out`, default `$XDG_DATA_HOME/vaultd/search-captures/corpus` (`.local/share` under the home directory when unset), and refusing a `--corpus-out` inside the repository (compared as real paths). Nothing from this run is committed.

- [ ] **Step 5: Check and commit** — `npm --prefix host run lint; echo "exit=$?"` (expected `exit=0`), and `git status --short` shows only `host/scripts/search-parity.js` and `crates/vault-server/tests/fixtures/search-captures/`.

```bash
git add host/scripts/search-parity.js crates/vault-server/tests/fixtures/search-captures
git commit -F - <<'COMMIT'
test(search): capture Obsidian's own search answers for the parity queries

search-parity.js capture runs every parity query through the obsidian CLI's search and search:context and through the search view after openGlobalSearch, checking before every call that the CLI answers for the generated vault, and commits one capture per query plus the discovered CLI and view shapes. The copy mode and a capture to a directory outside the repository serve an optional run over a copy of a real vault, whose captures are never committed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 20: The replay — compare, record deviations, and settle every provisional rule

`search_replay.rs` rebuilds the generated vault from `corpus.json`, runs every captured query through `search` over a daemon, and compares. Then each provisional rule is settled: a capture that agrees flips it to captured; one that disagrees changes the code to Obsidian's behaviour, unless the owner rules an exception.

**Files:**

- Modify: `crates/vault-server/tests/search_replay.rs` (the replay), `VAULTD-COMPATIBILITY.md` (**Search parity**: what was captured)
- Create: `crates/vault-server/tests/fixtures/search-captures/deviations.json`
- Modify, as the captures require: `crates/vault-search/src/*` and their tests

- [ ] **Step 1: Write the replay**

```rust
#[derive(Deserialize)]
struct Capture { id: String, query: String, match_case: bool, sort: String, cli: CliCapture, view: Option<ViewCapture> }
#[derive(Deserialize)]
struct CliCapture { files: Vec<String>, total: Option<u64> }
#[derive(Deserialize)]
struct ViewCapture { files: Vec<ViewFile>, order: Vec<String>, routes: Routes }
#[derive(Deserialize)]
struct ViewFile { path: String, matches: Vec<[u64; 2]> }
#[derive(Deserialize)]
struct Routes { case: bool, sort: bool }
#[derive(Deserialize)]
struct Deviation { id: String, kind: String, ruling: String }

#[test]
fn every_capture_matches_vaultd_or_names_a_ruled_deviation() {
    let vault = materialize(&corpus());          // a TempDir under target/tmp, files and mtimes from the manifest
    let index = tempfile::TempDir::new_in(scratch()).unwrap();
    let mut daemon = Daemon::for_vault(&vault, &index);
    refresh(&mut daemon);
    let deviations = deviations();
    let mut failures = Vec::new();
    for capture in captures() {
        let answer = run(&mut daemon, &capture);  // every page, context none, the capture's case and sort
        compare(&capture, &answer, &deviations, &mut failures);
    }
    assert!(failures.is_empty(), "{} differences:\n{}", failures.len(), failures.join("\n"));
}
```

`compare` checks, in order, and pushes one line per difference not named in `deviations.json` for that capture's `id` and that `kind`:

1. `files`: the set of paths in `cli.files` against the set `vaultd` answered (a refused query answers the empty set, and the capture of a query this daemon refuses records what Obsidian did, so a refused row that Obsidian answered is a `files` difference, the P8 evidence).
2. `spans`: for each file in `view.files`, its `matches` against `vaultd`'s content matches converted to UTF-16 `[offset, offset]` pairs (`start.offset`, `end.offset`), when `view` is present; files with more than `MAX_MATCHES_PER_FILE` matches compare their first hundred.
3. `order`: `view.order` against `vaultd`'s order, when `view` is present and `routes.sort` is true or the sort is the default, for the file-name and modified-time sorts; for the created-time sorts, which the materialized vault cannot reproduce, `vaultd`'s comparator is checked against Obsidian's order using the creation times the capture's view saw (recorded by Task 19's reader as `stat.ctime` per file, added to the reader if Step 1 of Task 19 did not).
4. `total`: `cli.total` against `total_matches`, when present.

A deviation entry is `{"id":"q042","kind":"spans","ruling":"S1: <the owner's words>"}`; an entry whose difference no longer occurs fails the suite too ("stale deviation"), so the file never outlives its reason. The corpus captures under `VAULTD_SEARCH_CORPUS_CAPTURES` (default `$XDG_DATA_HOME/vaultd/search-captures/corpus`) are replayed by a second test that compares file sets only (the copy is not in the repository, so the test needs the copy at `target/tmp/search-corpus` too) and skips, printing why, when either is absent.

- [ ] **Step 2: Run it and read the differences** — `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test search_replay -- --nocapture; echo "exit=$?"`. Expected the first time: differences, `exit=101`. Every difference is classified, in a table in the task report, as one of: a provisional rule the capture settles the other way (a bug: fix the code, with the capture as the test); a defect in this build (fix it); or a behaviour the owner may prefer to keep (filed for a ruling, with both options and a pick).

- [ ] **Step 3: Settle the rules** — for each of `P1` to `P18`, change the code where the capture contradicts it (each change with a unit test in `vault-search` that pins the captured behaviour, citing the capture id), re-run the replay until only ruled deviations remain, and record the owner's rulings in `deviations.json`. A rule no capture could reach (for example a case or sort route the view did not expose) stays provisional and is named as such.

- [ ] **Step 4: The compatibility record** — rewrite `VAULTD-COMPATIBILITY.md`'s **Search parity** provisional list as: how it was captured (Obsidian's version and the date from `meta.json`, the routes that worked); a table of `P1` to `P18` with the verdict of each (captured as provisional, captured otherwise and fixed, ruled deviation with its ruling, or still provisional and why); and what the optional real-vault run showed, in counts only.

- [ ] **Step 5: Run it and see it pass** — `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test search_replay; echo "exit=$?"` and `TMPDIR="$PWD/target/tmp" cargo test -p vault-search; echo "exit=$?"`; expected `exit=0` twice.

- [ ] **Step 6: The gates** — the workspace tests, clippy, fmt, MSRV, and `npm --prefix host run lint`, each with its exit code.

- [ ] **Step 7: Commit**

```bash
git add crates VAULTD-COMPATIBILITY.md
git commit -F - <<'COMMIT'
test(search): replay Obsidian's captured answers and settle the provisional rules

search_replay rebuilds the generated vault, runs every captured query through search, and compares file sets, match spans in UTF-16 units, the order under each sort, and match counts; every difference fails unless deviations.json names it with the owner's ruling, and a deviation that no longer occurs fails too. Each provisional rule P1 to P18 is settled against the captures: the ones they contradicted are fixed with a unit test citing the capture, and the compatibility record lists every verdict.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
### Task 21: The final documents and the branch's gates

**Files:**

- Modify: `docs/protocol.md` (the **Search** section's grammar and scopes complete; property search; regex; the sentence that canvas content is not searched in this phase (issue #3); excluded files, the exclusion epoch and `include_excluded`; `explain`; the `config_changed` watcher sentence naming `.obsidian/app.json`), `docs/protocol-host.md` (unchanged unless Task 7's operations changed), `README.md` (the milestone subsection: parity operators and the harness), `VAULTD-COMPATIBILITY.md` (Tier 2 sentence; the documented limits), `crates/vault-server/tests/docs.rs` (pins for the parity phrases)

- [ ] **Step 1: Write the failing pins** — `docs/protocol.md` names `include_excluded`, `explain`, `userIgnoreFilters`, `task-todo:`, `[property:null]` and says canvas content is not searched in this phase; run `TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test docs; echo "exit=$?"`, expected `exit=101`.

- [ ] **Step 2: Write the documents** — as listed above, each in the style of its Bases counterpart; `tests/protocol_doc_examples.rs` checks any new example.

- [ ] **Step 3: (removed)** — the schema-v6 measurement belonged to Task 14, which is removed from this phase by Ruling 4 (issue #3). The step number is kept.

- [ ] **Step 4: The final gates — the whole branch**

```bash
TMPDIR="$PWD/target/tmp" cargo test --workspace; echo "exit=$?"
cargo clippy --workspace --all-targets -- -D warnings; echo "exit=$?"
cargo fmt --all -- --check; echo "exit=$?"
rustup run 1.85.0 cargo check --workspace; echo "exit=$?"
npm --prefix host run lint; echo "exit=$?"
npm --prefix host run typecheck; echo "exit=$?"
git diff --stat main -- host/packages/host/src; echo "exit=$?"
```

Expected: `exit=0` from all seven, and the last command lists only the files Task 7 owns.

- [ ] **Step 5: Commit**

```bash
git add docs README.md VAULTD-COMPATIBILITY.md crates/vault-server/tests/docs.rs
git commit -F - <<'COMMIT'
docs: search parity in the protocol, the README and the compatibility contract

docs/protocol.md documents the whole grammar as implemented: regular expressions, the structural scopes, property search, excluded files with their epoch and include_excluded, and explain, and says canvas content is not searched in this phase; the config_changed section names app.json beside types.json. The README and the compatibility contract describe the parity phase and the harness.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
```

---
## Coverage

Every section of `docs/design/search.md`, and the task that implements it.

| Spec section | Requirement | Task |
| --- | --- | --- |
| Goals 1 | One additive `search` with spans in Obsidian-compatible positions, paged, at one generation | 2 (positions), 3 (hits), 4 (generation), 5 (wire), 6 (operation) |
| Goals 2 | The MVP operators, the toggle, the six sorts | 1 (grammar), 3 (scopes, case, sorts) |
| Goals 3 | Regex, structural scopes, properties, canvas, excluded files, explain | 11, 12, 13, 15, 16; canvas removed from this phase (Ruling 4, issue #3) |
| Goals 4 | A real `global-search` instance | 7 |
| Goals 5 | The parity harness | 18, 19, 20 |
| Goals 6 | Performance; reconciliation unchanged | 9, 21 |
| What Obsidian's Search does | Every stated behaviour | 1 (syntax), 3 (scopes, case, sorts, file universe), 11–16 |
| UNVERIFIED P1–P18 | Implemented as named provisional rules, listed, then settled | 1 (P6–P8), 2 (P3, P4), 3 (P1, P2, P5, P9, P10, P15, P18), 11 (P11), 12 (P12, P13), 13 (P14), 15 (P17); P16 stays provisional (Ruling 4, issue #3); 10 (listed); 20 (settled) |
| CLI and vault-mcp | The CLI is the capture route; vault-mcp's tool is not a parity source | 19 |
| Non-goals | No fuzzy search, attachment text, live subscriptions, Explain prose, history, rendering | none by construction |
| Architecture — `vault-search` grammar | Scannerless parser, tree, positions, printer | 1 |
| Architecture — matcher | Needles, folding, original-text spans, ASCII fast path | 2 |
| Architecture — compile and evaluate | Feature refusals, `needs()`, scopes, spans, sort | 3 |
| Architecture — the index, scanned exactly | Pinned read, narrowing superset, streaming bodies, no write-path change | 4 |
| Architecture — trigram follow-on | Designed, not built; decided on the 100,000-note number | 9 (measured and reported) |
| Architecture — canvas content | Schema v6, search text | removed from this phase (Ruling 4, issue #3) |
| Architecture — excluded files | `userIgnoreFilters`, epoch, watcher, `include_excluded` | 15 |
| Architecture — the operation | Parameters, answer, cache, cursor, empty query | 5, 6 (15 and 16 add their fields) |
| Architecture — freshness | Re-ask on `generation_committed`; no event | 6 (documented in 10); 8 and 17 (the spike does it) |
| Architecture — errors | `query_invalid` with position, `unsupported_operator`, existing codes | 5, 6, 11 |
| Architecture — consumers | Host instance and operations; vault-mcp noted; HTMX search box and query blocks | 7; none (other repository); 8, 17 |
| Architecture — MVP versus parity | The split as listed | Parts 1 and 2 |
| Architecture — the parity harness | Corpus, query set, capture, optional real-vault run, comparison, deviations | 18, 19, 20 |
| Performance requirements | The six numbers | 9 |
| Testing | Parser, matcher, evaluate, index, protocol and server, host, parity, gates | 1, 2, 3, 4, 5–6, 7, 20, every task |
| Documentation | Protocol, README, compatibility, baseline, host protocol, semantic read-path line | 10, 21 (9 for the baseline) |
| Open questions | None open: canvas (Ruling 4, issue #3), live search (Ruling 5, issue #1), real-vault run (Ruling 6, issue #2) | 14 removed; live search not in this plan; 19 Step 4 deferred |
| Rulings 1–6 | Search in `vaultd`; parity target with MVP first and harness last; standing rules; the three former Open questions | the plan's order; Global Constraints; Tasks 14 and 19 |

## Self-review

**1. Spec coverage.** The table walks every section of the design. Two points the design leaves to execution are fixed here and named: the CLI's JSON shape and the search view's internal method names are discovered in Task 19 Step 1 and recorded in `meta.json` before any capture is trusted, because no source documents them; and the created-time sorts cannot be reproduced in a materialized vault, so Task 20 checks the comparator against Obsidian's captured creation times instead of comparing orders directly.

**2. Placeholder scan.** No `TBD`, `TODO`, "implement later", "add error handling", "write tests for the above" or "similar to Task N". Task 19's view reader names three internal members (`SET_CASE`, `SET_SORT`, `CHILDREN`) that no source documents; Step 1 discovers them on a running Obsidian and the script records which were found, and the capture degrades to the CLI routes, recorded per file, when one is absent. Task 20 Step 3 cannot carry the code it will write, because the captures decide it; it names, for each provisional rule, the evidence, the test that pins it and where the verdict is recorded.

**3. Type consistency.** Checked against the Shared names table: `parse_query`, `Query`, `Node` with `at` on `Scoped`, `Case` and `Property` (1, 3, 16); `Needle::text` (2) and `Needle::regex` (11); `compile(&Query, bool)` everywhere it is called (3, 4, 6, 11–13, 18); `CompileError::{Unsupported { what, position }, Invalid}` (3, 6, 11); `Needs` gaining `structure` (12) and `properties` (13), and the task that adds each field also updates the four `Needs { … }` literals of Task 3's test; `MemoryDocument` gaining `structure` and `properties` fields, which the struct-update literal in Task 3's prefilter test absorbs; `SearchDocument` gaining `structure()` and `properties()` with default bodies, so `IndexDocument` and `MemoryDocument` stay valid between tasks; `SearchQuery` gaining `exclusions` in 15, with every literal (the server, `tests/search_query.rs`, `tests/search_timing.rs`) updated in that task; `SearchAnswer.texts_read` (4, 9); `MatchContext` (4, 6); the DTOs (5) gaining `include_excluded` (15) and `explain` (16) as defaulted, skipped-when-absent fields; `ProtocolError::new` and `position` (5, 6); `SearchCache` keyed by canonical query, case, sort and generation (6), plus the exclusion epoch and `include_excluded` (15); `host.search_opened` is the event name in the design and in Task 7; `MAX_MATCHES_PER_FILE` 100 (3, 6, 10, 20, and the design); `Needle`, `CompiledQuery`, `Compiled` and `CompiledTerm` derive `Debug` (2, 3); `DocumentKindDto` and the two `ErrorCode`s decode through hand-written `Deserialize` arms anchored in `variant_anchors.rs` (5); `MAX_STORED_MATCHES` 200,000 (6); `MAX_LINE_TEXT_BYTES` 512 (4, design).

**4. Review Focus.** Each line has its test in its owning task: the narrowing superset (4), spans on the original text (2), refusal instead of misreading (1, 3), negation over attachments (3), and a page from a stale answer (4 for the context read, 6 for the cursor).

## Execution handoff

Plan complete; it is to be saved as `docs/plans/search-implementation.md`, beside the design at `docs/design/search.md`. Subagent-driven is the method: a fresh implementer per task, an independent reviewer with a diff package, fix rounds resumed on the implementer. Tasks 1 to 3 are the pure crate and run in order; 4 is the index; 5 and 6 the wire and the server; 7 the host; 9 needs a release build and a quiet machine; 10 closes the `feat/search` side of the MVP; 8 runs last, in the same worktree on `spike/htmx-client-clean`, against a `vaultd` built from `feat/search` and never by merging it, then switches back, and the MVP can be demonstrated from that point. Tasks 11, 12, 13, 15 and 16 each extend the crate, the index and the server and run in order; Task 14 is removed from this phase (Ruling 4, issue #3); 17 runs on the spike branch as 8 does. Task 18 needs no human; 19 has one human stop in this phase (its real-vault run is deferred to issue #2); 20 depends on 19's captures and may need the owner's rulings; 21 depends on everything.
