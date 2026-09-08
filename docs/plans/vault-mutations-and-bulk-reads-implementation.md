# vaultd Vault Mutation and Bulk Read Implementation Plan (DRAFT v2)

## Status

Draft v2, revised 2026-08-30 against three independent fresh-context reviews (spec consistency, internal rigor, codebase accuracy). Every Blocking and Important finding is applied in the text below. The substantive changes from v1: Task 8 implements the spec's correction #9 (a sub-span edit re-serializes its enclosing top-level property) instead of the superseded refuse-with-`unaddressable_patch` rule; Tasks 13–15 read the pre-task's `tree_entries` table inside the pinned transaction instead of walking the filesystem at open; `MutationOutcome::semantic` has one pinned meaning; and the plan gained execution checkpoints, failure-path coverage, a closing spec-coverage matrix, and a clippy gate. Nothing here is accepted.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `vaultd` a generation-consistent write path, spelling-preserving rename link repair, raw file I/O for attachments and the `.obsidian` zone, and snapshot-session bulk reads, so a client that completes a write can immediately read its own result and a host can hydrate a whole vault in a handful of round trips.

**Architecture:** A new `mutate.rs` module in `vault-index` owns every filesystem write — canonicalize-and-contain path validation, content-revision compare-and-swap, and temp-file-then-rename atomicity — and is driven exclusively from the existing single-writer coordinator through a new `RuntimeCommand::Mutate` with a reply channel, which reconciles the mutated paths and publishes an ordinary generation before it answers. Snapshot sessions live beside the reader on their own SQLite connections holding one long-lived deferred read transaction each, so a bulk read pins its generation without blocking the writer and without occupying the dispatcher. Every new protocol shape is additive to protocol version 1, and lands behind a wire-tolerance prerequisite that makes unknown enum variants degrade rather than fail.

**Spec:** `docs/design/vault-mutations-and-bulk-reads.md` (the original draft was kept outside the repository), including its **Rulings (2026-08-30)** section, which supersedes every inline `OPEN` marker above it. The plan argues from the spec; executors read both in full.

**Tech Stack:** Rust 2024 edition with Rust 1.85 MSRV; existing `vault-core`, `vault-index`, `vault-protocol`, `vault-server`, and `vault-watch` crates; SQLite/WAL through `rusqlite 0.32.1`; `blake3 1.8` for content revisions; `tempfile 3.23` for atomic temp-then-rename writes; `base64 0.22.1` for raw file payloads; `serde`/`serde_json`; `proptest 1.9`; the new `trash 5.2` dependency for `mode: "trash_system"`; existing stdio JSON-lines transport.

## Global Constraints

- Base this work on `main` at commit `99264d4` (or a descendant of it). Execute from an isolated git worktree.
- Preserve workspace `edition = "2024"` and `rust-version = "1.85"`. **No let-chains** (`if let ... && ...`): they stabilized in Rust 1.88 and will not compile under the MSRV check. Use nested `if let` blocks or `match` instead. Every new direct dependency must pass `cargo +1.85.0 check --workspace --all-targets`.
- Every test invocation sets the temp prefix: `TMPDIR="$PWD/target/tmp" cargo test ...`, with `mkdir -p "$PWD/target/tmp"` run first. Tests create real temporary vaults; they must never land in the system temp directory.
- The gate at the end of every task, in this exact order (the same four commands the sibling plans use):

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

  `cargo fmt --all -- --check` rather than `cargo fmt --all`: the gate must *fail* on unformatted code, not silently reformat it inside the commit step. Run the plain `cargo fmt --all` yourself while implementing; the gate only verifies.

- **Commits are scoped, never `git add -A`.** Every task's commit step names the exact paths it touched, so a stray artifact, a `.permission-check` touch, or an unrelated edit can never ride along. Each task's commit step below lists its own paths.

- **The ordinary Obsidian vault is authoritative.** Before this phase `vaultd` never wrote into it; from this phase it writes *only* through `vault_index::MutationEngine`, and only files a client explicitly named. Derived storage (the SQLite cache, its sidecars, the lease file) stays outside the vault root, unchanged. Never point a mutation test, a destructive rebuild test, or a benchmark at the maintainer's live vault or live cache.
- Every filesystem write is atomic per file: write a temp file in the *target's own directory*, `sync_all`, then rename over the target. A crash leaves the old bytes or the new bytes, never a torn file.
- **Protocol changes are additive only.** Protocol version stays `1`. New requests, responses, optional fields, event variants, and error codes are added; no existing envelope shape, field name, spelling, or serialized form changes. Task 1 ships the unknown-variant tolerance that makes this true for enum growth, and no later task may add an enum variant before it lands.
- **Conservative invalidation is unchanged.** A mutation reconciles through the same `refresh_paths` engine a watcher hint uses; over-selection of affected paths is always allowed, under-selection is a bug. A mutation that cannot name every path it changed must reconcile all of them or hand them back as pending.
- Preserve the dependency direction: `vault-core` knows no SQLite, watcher, threads, protocol, or daemon types; `vault-protocol` knows no core/index/server types; `vault-server` composes the process. `mutate.rs` lives in `vault-index` because it needs the index's revision and reference rows; it never names a protocol type.
- One writer: every mutation is applied on the coordinator thread, through `Coordinator::mutation`, so exactly one mutation is ever in flight. Mailbox order is mutation order.
- A client-visible generation exists only after the SQLite commit and the matching live-state installation. A mutation response is sent only after its own reconciliation has published, so read-your-writes holds at the process level.
- Rust production code may not panic on vault content, watcher input, protocol input, SQLite contents, filesystem races, or recoverable errors. A mutation that cannot proceed returns a typed error and changes nothing.
- Retain `synchronous=NORMAL`, WAL, foreign keys, busy timeout, and indexed/keyset query behavior.
- Test-driven development for every behavior change: write the failing focused test, run it, observe the named failure, write the minimal implementation, run it again, run the workspace suite, commit once per task. Do not combine task commits.
- **Assumed pre-task (not planned here):** a preceding schema-v3 change — [Structural parse extension implementation plan for vaultd (draft)](structural-parse-extension-implementation.md) — has added **three** tables, bumped `SQL_SCHEMA_VERSION`/`SEMANTIC_FORMAT_VERSION` from `2` to `3`, and forced one cache rebuild: `sections` and `list_items` (its Tasks 1–4) and `tree_entries` (its Addendum Task 5). **That plan's "Pinned DDL and corrections (2026-08-30)" section is the schema authority for all three; this plan reads exactly it and invents no variation.** The shapes, repeated here so an implementer of this phase never has to guess:

```sql
CREATE TABLE sections (
    note_path  TEXT    NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal    INTEGER NOT NULL,           -- 0-based, document order
    kind       TEXT    NOT NULL,           -- SectionKind wire string; Other(s) stores s literally
    span_start INTEGER NOT NULL,
    span_end   INTEGER NOT NULL,
    block_id   TEXT,                       -- nullable; carried through to every read path
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE list_items (
    note_path         TEXT    NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal           INTEGER NOT NULL,
    span_start        INTEGER NOT NULL,
    span_end          INTEGER NOT NULL,
    list_start_line   INTEGER,             -- set iff top-level (ListItemParent::Root)
    parent_start_line INTEGER,             -- set iff nested (ListItemParent::Item)
    task              TEXT,                -- the raw character inside the brackets; NULL for non-task items
    PRIMARY KEY (note_path, ordinal),
    CHECK ((list_start_line IS NULL) <> (parent_start_line IS NULL))
);

CREATE TABLE tree_entries (
    path             TEXT PRIMARY KEY,
    kind             TEXT    NOT NULL CHECK (kind IN ('note','file','folder')),
    size             INTEGER,              -- NULL for folders
    ctime_unix_ms    INTEGER NOT NULL,     -- birthtime; mtime fallback where unavailable
    mtime_unix_ms    INTEGER NOT NULL,
    content_revision TEXT                  -- NULL for folders and notes (notes carry theirs on `notes`)
);
```

  Three consequences bind this phase. Task 15 consumes `sections` and `list_items` as ordinary `snapshot_notes` facets under the wire names `sections` and `list_items` — **siblings of `metadata`, never nested inside it** — and follows the pinned conventions: `list_items` uses the **line-number parent model** (exactly one of `list_start_line`/`parent_start_line` set; no `-1` sentinel and no parent ordinal anywhere), `sections` carries `block_id` through every layer, and `task` is `Option<char>` in the domain and a **one-character string** on the wire. Tasks 13 and 14 read `tree_entries` inside the same pinned read transaction as `notes`, which is what makes a snapshot session coherent at one generation for its tree as well as its semantics. If the pre-task landed under different column names, fix the SQL statements in Task 14 Step 3 and Task 15 Step 4 and nothing else.

---

## Preflight gate

Run these checks before Task 1 and stop if any expectation fails:

```bash
git status --short --branch
mkdir -p "$PWD/target/tmp"
git merge-base --is-ancestor 99264d4 HEAD
test -f crates/vault-index/src/schema_v2.sql
test -f docs/protocol.md
test -f docs/performance/live-incremental-baseline.md
# The schema-v3 pre-task must have landed: this phase reads three of its tables.
test -f crates/vault-index/src/schema_v3.sql
sqlite3 "$(mktemp -d)/probe.sqlite3" < crates/vault-index/src/schema_v3.sql \
  && grep -q 'CREATE TABLE tree_entries' crates/vault-index/src/schema_v3.sql \
  && grep -q 'CREATE TABLE sections' crates/vault-index/src/schema_v3.sql \
  && grep -q 'CREATE TABLE list_items' crates/vault-index/src/schema_v3.sql
grep -q 'SQL_SCHEMA_VERSION: u32 = 3' crates/vault-index/src/schema.rs
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

Expected:

- the worktree is clean before implementation;
- the ancestry check exits `0`;
- all four schema probes exit `0`. On `99264d4` itself they all **fail**, and that is the correct signal: `crates/vault-index/src/schema_v3.sql` does not exist there, only `schema_v1.sql` and `schema_v2.sql` do, and `crates/vault-index/src/schema.rs:8` still reads `pub const SQL_SCHEMA_VERSION: u32 = 2;`. **Do not start this phase until they pass** — Tasks 13–15 read tables that only the pre-task creates, and starting early buys nothing but a rewrite;
- the workspace suite passes. **347 is the `99264d4` count — the count *before* the pre-task**, verified by summing the `test result:` lines across all 62 targets. The pre-task adds its own tests, so the number here will be higher: **record the actual pre-pass count at execution time and use that as this phase's baseline**, rather than expecting 347. Every "N pre-existing tests plus the M new ones" line below means N = that recorded baseline;
- the Rust 1.85 check and the clippy gate pass;
- `.permission-check` is untouched and unstaged.

---

## Planned file map

### `vault-protocol`

- Modify `crates/vault-protocol/src/events.rs`: `Unknown` variants and manual `Deserialize` for `LiveStateDto`, `GenerationCauseDto`, `ResyncReasonDto`, `RuntimeEventDto`; new `GenerationCauseDto::Mutation`; new `ConfigChangedEventDto` and `RuntimeEventDto::ConfigChanged`.
- Modify `crates/vault-protocol/src/error.rs`: `ErrorCode::Unknown` plus the mutation and snapshot codes; `ProtocolError::current_revision`.
- Create `crates/vault-protocol/src/mutations.rs`: mutation request/response DTOs.
- Create `crates/vault-protocol/src/snapshots.rs`: snapshot-session request/response DTOs.
- Modify `crates/vault-protocol/src/operations.rs` and `src/lib.rs`: new `Request`/`Response` variants and re-exports.
- Create `crates/vault-protocol/tests/wire_tolerance.rs`, `tests/mutations.rs`, `tests/snapshots.rs`.

### `vault-index`

- Create `crates/vault-index/src/mutate.rs`: `MutationEngine`, `Mutation`, `Precondition`, `MutationOutcome`, `MutationError`, path containment, atomic writes, per-operation semantics.
- Create `crates/vault-index/src/mutate/frontmatter.rs`: span-based `patch_frontmatter` and the addition dialect.
- Create `crates/vault-index/src/mutate/rename.rs`: two-tier rename link repair.
- Create `crates/vault-index/src/snapshot.rs`: snapshot sessions, tree pages, note pages.
- Modify `crates/vault-index/src/{lib,error,config,reconcile,live_reconcile,test_hook,cursor}.rs`.
- Modify `crates/vault-index/src/bin/vault-bench.rs`: mutation and rename fan-out cases.
- Create `crates/vault-index/tests/{mutation_paths,mutation_write,mutation_folders,mutation_copy_rename,frontmatter_patch,rename_repair,snapshot_sessions,snapshot_pages}.rs`.
- Modify `crates/vault-index/tests/live_oracle.rs`: mutation operations in the alphabet.

### `vault-server`

- Modify `crates/vault-server/src/runtime.rs`: `RuntimeCommand::Mutate`, `MutationReport`, `MutationFailure`, `RuntimeHandle::mutate`, `RuntimeOptions::read_only`.
- Modify `crates/vault-server/src/lib.rs`: dispatch for every new request, snapshot session registry.
- Modify `crates/vault-server/src/convert.rs`: DTO ↔ engine conversions and the mutation error mapping.
- Modify `crates/vault-server/src/subscriptions.rs`: `ChangeCause::Mutation` and `config_changed` delivery.
- Modify `crates/vault-server/src/main.rs`: `--read-only`, and the module doc comment that lists the flags.
- Create `crates/vault-server/tests/daemon/mod.rs`: the shared spawned-daemon harness (Task 9 Step 8), used by `mutations.rs`, `mutation_errors.rs`, `snapshots.rs`, and `read_only.rs`. `mutation_races.rs` deliberately keeps its own — a race test sends two requests before reading either response, which no `call`-shaped helper can express.
- Create `crates/vault-server/tests/{mutations,mutation_errors,mutation_races,mutation_oracle,snapshots,raw_files,read_only}.rs`.

### Documentation

- Modify `docs/protocol.md`: wire-tolerance rule, mutation operations, snapshot operations, raw file operations, new error codes, `--read-only`.
- Modify `crates/vault-server/tests/docs.rs`: the phrases those sections must contain.
- Create `docs/performance/vault-mutation-baseline.md`.

---

### Task 1: Unknown-variant tolerance on the open-ended wire enums

Adding `cause: "mutation"` to a shipped event would hard-fail deserialization in every existing subscriber, because every wire enum today is closed. This task makes growth safe **before** anything grows, and is a prerequisite for Task 9.

**Files:**

- Modify: `crates/vault-protocol/src/events.rs` (`LiveStateDto` lines 18–26, `GenerationCauseDto` lines 34–42, `ResyncReasonDto` lines 67–85, `RuntimeEventDto` lines 125–131)
- Modify: `crates/vault-protocol/src/error.rs` (`ErrorCode`, lines 13–32)
- Create: `crates/vault-protocol/tests/wire_tolerance.rs`
- Modify: `docs/protocol.md` (`## Evolution`, lines 280–282)
- Modify: `crates/vault-server/tests/docs.rs`

**Interfaces:**

- Produces: `LiveStateDto::Unknown`, `GenerationCauseDto::Unknown`, `ResyncReasonDto::Unknown`, `RuntimeEventDto::Unknown`, `ErrorCode::Unknown`.
- Produces: hand-written `impl<'de> Deserialize<'de> for …` on all five, replacing the derived one. `Serialize` stays derived, so every existing line is byte-identical on the wire.
- Preserves: every existing variant name, spelling, and serialized form; `EventEnvelope`, `ResponseEnvelope`, and `ProtocolError` shapes.

- [ ] **Step 1: Write the failing wire-tolerance test**

Create `crates/vault-protocol/tests/wire_tolerance.rs`:

```rust
//! Wire tolerance: yesterday's fixtures still parse, and a variant from a
//! later `vaultd` degrades to `Unknown` instead of failing the line — and
//! with it, the whole subscription that line belonged to.

use vault_protocol::{
    ErrorCode, EventEnvelope, GenerationCauseDto, LiveStateDto, ResponseEnvelope, ResponseOutcome,
    ResyncReasonDto, RuntimeEventDto,
};

/// Captured from the shipped live-runtime transport: one line per event
/// shape, exactly as `vaultd` writes them today.
const GENERATION_COMMITTED: &str = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"generation_committed","value":{"previous_generation":1,"generation":2,"cause":"watcher","changes":{"kind":"detailed","created":[],"modified":["One.md"],"deleted":[]},"affected_note_count":1,"affected_reference_count":0}}}"#;
const RUNTIME_STATE_CHANGED: &str = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"runtime_state_changed","value":{"generation":2,"live_state":"watching"}}}"#;
const RESYNC_REQUIRED: &str = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"resync_required","value":{"current_generation":2,"reason":"runtime_recovered"}}}"#;

#[test]
fn todays_event_fixtures_still_parse_unchanged() {
    let committed: EventEnvelope =
        serde_json::from_str(GENERATION_COMMITTED).expect("today's generation_committed line");
    match committed.event {
        RuntimeEventDto::GenerationCommitted(event) => {
            assert_eq!(event.generation, 2);
            assert_eq!(event.cause, GenerationCauseDto::Watcher);
        }
        other => panic!("expected generation_committed, got {other:?}"),
    }

    let state: EventEnvelope =
        serde_json::from_str(RUNTIME_STATE_CHANGED).expect("today's runtime_state_changed line");
    match state.event {
        RuntimeEventDto::RuntimeStateChanged(event) => {
            assert_eq!(event.live_state, LiveStateDto::Watching);
        }
        other => panic!("expected runtime_state_changed, got {other:?}"),
    }

    let resync: EventEnvelope =
        serde_json::from_str(RESYNC_REQUIRED).expect("today's resync_required line");
    match resync.event {
        RuntimeEventDto::ResyncRequired(event) => {
            assert_eq!(event.reason, ResyncReasonDto::RuntimeRecovered);
        }
        other => panic!("expected resync_required, got {other:?}"),
    }
}

#[test]
fn an_unknown_generation_cause_degrades_to_unknown() {
    let line = GENERATION_COMMITTED.replace(r#""cause":"watcher""#, r#""cause":"from_the_future""#);
    let envelope: EventEnvelope =
        serde_json::from_str(&line).expect("an unknown cause must still parse");
    match envelope.event {
        RuntimeEventDto::GenerationCommitted(event) => {
            assert_eq!(event.cause, GenerationCauseDto::Unknown);
            assert_eq!(event.generation, 2, "the rest of the event must survive");
        }
        other => panic!("expected generation_committed, got {other:?}"),
    }
}

#[test]
fn an_unknown_resync_reason_degrades_to_unknown() {
    let line = RESYNC_REQUIRED.replace(
        r#""reason":"runtime_recovered""#,
        r#""reason":"from_the_future""#,
    );
    let envelope: EventEnvelope =
        serde_json::from_str(&line).expect("an unknown reason must still parse");
    match envelope.event {
        RuntimeEventDto::ResyncRequired(event) => {
            assert_eq!(event.reason, ResyncReasonDto::Unknown);
            assert_eq!(event.current_generation, Some(2));
        }
        other => panic!("expected resync_required, got {other:?}"),
    }
}

#[test]
fn an_unknown_live_state_degrades_to_unknown() {
    let line = RUNTIME_STATE_CHANGED.replace(
        r#""live_state":"watching""#,
        r#""live_state":"from_the_future""#,
    );
    let envelope: EventEnvelope =
        serde_json::from_str(&line).expect("an unknown live state must still parse");
    match envelope.event {
        RuntimeEventDto::RuntimeStateChanged(event) => {
            assert_eq!(event.live_state, LiveStateDto::Unknown);
            assert_eq!(event.generation, Some(2));
        }
        other => panic!("expected runtime_state_changed, got {other:?}"),
    }
}

#[test]
fn an_unknown_event_type_degrades_to_unknown() {
    let line = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"from_the_future","value":{"anything":[1,2,3]}}}"#;
    let envelope: EventEnvelope =
        serde_json::from_str(line).expect("an unknown event type must still parse");
    assert_eq!(envelope.event, RuntimeEventDto::Unknown);
    assert_eq!(
        envelope.subscription_id, "sub-1",
        "the envelope around an unknown event must still be usable"
    );
}

#[test]
fn an_unknown_event_type_with_no_value_degrades_to_unknown() {
    let line = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"from_the_future"}}"#;
    let envelope: EventEnvelope =
        serde_json::from_str(line).expect("an unknown unit-shaped event must still parse");
    assert_eq!(envelope.event, RuntimeEventDto::Unknown);
}

#[test]
fn a_known_event_type_missing_its_value_is_still_an_error() {
    let line = r#"{"version":1,"subscription_id":"sub-1","event":{"type":"resync_required"}}"#;
    let result = serde_json::from_str::<EventEnvelope>(line);
    assert!(
        result.is_err(),
        "tolerance is for unknown variants only; a malformed known variant must still fail"
    );
}

#[test]
fn an_unknown_error_code_degrades_to_unknown() {
    let line = r#"{"version":1,"id":"a","outcome":{"status":"err","value":{"code":"from_the_future","message":"stale"}}}"#;
    let envelope: ResponseEnvelope =
        serde_json::from_str(line).expect("an unknown error code must still parse");
    match envelope.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::Unknown);
            assert_eq!(error.message, "stale");
        }
        other => panic!("expected an error outcome, got {other:?}"),
    }
}

#[test]
fn unknown_serializes_to_a_reserved_spelling_this_server_never_emits() {
    assert_eq!(
        serde_json::to_string(&GenerationCauseDto::Unknown).expect("serialize"),
        r#""unknown""#
    );
    assert_eq!(
        serde_json::to_string(&ResyncReasonDto::Unknown).expect("serialize"),
        r#""unknown""#
    );
    assert_eq!(
        serde_json::to_string(&LiveStateDto::Unknown).expect("serialize"),
        r#""unknown""#
    );
    assert_eq!(
        serde_json::to_string(&ErrorCode::Unknown).expect("serialize"),
        r#""unknown""#
    );
}
```

- [ ] **Step 2: Run the focused test and observe the missing variants**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol --test wire_tolerance
```

Expected: compilation fails — `GenerationCauseDto::Unknown`, `ResyncReasonDto::Unknown`, `LiveStateDto::Unknown`, `RuntimeEventDto::Unknown`, and `ErrorCode::Unknown` do not exist.

- [ ] **Step 3: Add the catch-all variants and tolerant deserializers for the three string enums**

In `crates/vault-protocol/src/events.rs`, change the three string enums to derive only `Serialize` and add `Unknown`, then hand-write their `Deserialize`. Replace the `LiveStateDto` block (lines 18–26) with:

```rust
/// The runtime's observational status, mirroring `vault_index::LiveState`.
///
/// Open-ended: a client that meets a status a later `vaultd` introduced must
/// see [`LiveStateDto::Unknown`], never a deserialization failure that takes
/// the whole line — and with it the subscription — down. `Deserialize` is
/// hand-written because `#[serde(other)]` is rejected on an externally
/// tagged enum, which is what a plain unit-variant enum is.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveStateDto {
    Starting,
    CatchingUp,
    Watching,
    PollingFallback,
    Stopped,
    /// A status this build does not know. Never produced by this server.
    Unknown,
}

impl<'de> Deserialize<'de> for LiveStateDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "starting" => Self::Starting,
            "catching_up" => Self::CatchingUp,
            "watching" => Self::Watching,
            "polling_fallback" => Self::PollingFallback,
            "stopped" => Self::Stopped,
            _ => Self::Unknown,
        })
    }
}
```

Replace the `GenerationCauseDto` block (lines 34–42) with:

```rust
/// Why a generation advanced, mirroring `vault_index::live_reconcile::ChangeCause`.
///
/// Open-ended for the same reason [`LiveStateDto`] is: `mutation` was added
/// after the first subscribers shipped, and any later cause must degrade
/// rather than fail.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationCauseDto {
    Watcher,
    Startup,
    Periodic,
    Manual,
    Verified,
    /// A cause this build does not know. Never produced by this server.
    Unknown,
}

impl<'de> Deserialize<'de> for GenerationCauseDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "watcher" => Self::Watcher,
            "startup" => Self::Startup,
            "periodic" => Self::Periodic,
            "manual" => Self::Manual,
            "verified" => Self::Verified,
            _ => Self::Unknown,
        })
    }
}
```

Replace the `ResyncReasonDto` derive line (line 67) and add `Unknown` plus:

```rust
    /// A reason this build does not know. Never produced by this server.
    Unknown,
}

impl<'de> Deserialize<'de> for ResyncReasonDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "subscriber_lag" => Self::SubscriberLag,
            "oversized_change_set" => Self::OversizedChangeSet,
            "runtime_recovered" => Self::RuntimeRecovered,
            "watcher_overflow" => Self::WatcherOverflow,
            "root_invalidated" => Self::RootInvalidated,
            _ => Self::Unknown,
        })
    }
}
```

In `crates/vault-protocol/src/error.rs`, change the `ErrorCode` derive to `#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]`, add `Unknown` as the last variant with the doc comment `/// A code this build does not know. Never produced by this server.`, and add:

```rust
impl<'de> Deserialize<'de> for ErrorCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "incompatible_version" => Self::IncompatibleVersion,
            "invalid_request" => Self::InvalidRequest,
            "invalid_path" => Self::InvalidPath,
            "invalid_cursor" => Self::InvalidCursor,
            "note_not_found" => Self::NoteNotFound,
            "index_unavailable" => Self::IndexUnavailable,
            "generation_mismatch" => Self::GenerationMismatch,
            "vault_changed_during_refresh" => Self::VaultChangedDuringRefresh,
            "incompatible_index" => Self::IncompatibleIndex,
            "storage_failure" => Self::StorageFailure,
            "internal" => Self::Internal,
            "index_in_use" => Self::IndexInUse,
            "watch_unavailable" => Self::WatchUnavailable,
            "subscription_not_found" => Self::SubscriptionNotFound,
            "runtime_not_ready" => Self::RuntimeNotReady,
            "runtime_overloaded" => Self::RuntimeOverloaded,
            _ => Self::Unknown,
        })
    }
}
```

Add `use serde::Deserialize;` where `error.rs` currently imports `{Deserialize, Serialize}` — it already does, so no import change is needed there; in `events.rs` the existing `use serde::{Deserialize, Serialize};` also already covers this.

- [ ] **Step 4: Run the focused test and observe the remaining event-type failure**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol --test wire_tolerance
```

Expected: the five string-enum tests pass; `an_unknown_event_type_degrades_to_unknown` and `an_unknown_event_type_with_no_value_degrades_to_unknown` fail to compile because `RuntimeEventDto::Unknown` does not exist.

- [ ] **Step 5: Hand-write `RuntimeEventDto`'s tolerant deserializer**

In `crates/vault-protocol/src/events.rs`, change `RuntimeEventDto` to derive only `Serialize`, add the `Unknown` unit variant, and add the visitor:

```rust
/// One event delivered to a subscription.
///
/// Open-ended on its own tag: an event kind a later `vaultd` introduces
/// deserializes as [`RuntimeEventDto::Unknown`], with its payload discarded,
/// rather than failing the line.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum RuntimeEventDto {
    GenerationCommitted(GenerationCommittedEventDto),
    RuntimeStateChanged(RuntimeStateChangedEventDto),
    ResyncRequired(ResyncRequiredEventDto),
    /// An event kind this build does not know. Never produced by this server.
    Unknown,
}

/// Hand-written because serde's derive rejects `#[serde(other)]` on an
/// adjacently tagged enum's own tag. The visitor reads exactly the
/// `{"type": …, "value": …}` shape the derived `Serialize` above produces,
/// and turns an unrecognized `type` into [`RuntimeEventDto::Unknown`] after
/// discarding its payload with `IgnoredAny`. A *known* type whose payload is
/// malformed or missing still fails: tolerance is for variants this build has
/// never heard of, not for lines this build should have understood.
impl<'de> Deserialize<'de> for RuntimeEventDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(RuntimeEventVisitor)
    }
}

struct RuntimeEventVisitor;

impl<'de> serde::de::Visitor<'de> for RuntimeEventVisitor {
    type Value = RuntimeEventDto;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a runtime event with a `type` tag and a `value` payload")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        let mut kind: Option<String> = None;
        let mut event: Option<RuntimeEventDto> = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "type" => {
                    if kind.is_some() {
                        return Err(serde::de::Error::duplicate_field("type"));
                    }
                    kind = Some(map.next_value()?);
                }
                "value" => {
                    let Some(named) = kind.as_deref() else {
                        return Err(serde::de::Error::custom(
                            "`value` must follow `type` in a runtime event",
                        ));
                    };
                    event = Some(match named {
                        "generation_committed" => {
                            RuntimeEventDto::GenerationCommitted(map.next_value()?)
                        }
                        "runtime_state_changed" => {
                            RuntimeEventDto::RuntimeStateChanged(map.next_value()?)
                        }
                        "resync_required" => RuntimeEventDto::ResyncRequired(map.next_value()?),
                        _ => {
                            map.next_value::<serde::de::IgnoredAny>()?;
                            RuntimeEventDto::Unknown
                        }
                    });
                }
                _ => {
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        match event {
            Some(event) => Ok(event),
            None => match kind.as_deref() {
                Some("generation_committed" | "runtime_state_changed" | "resync_required") => {
                    Err(serde::de::Error::missing_field("value"))
                }
                Some(_) => Ok(RuntimeEventDto::Unknown),
                None => Err(serde::de::Error::missing_field("type")),
            },
        }
    }
}
```

- [ ] **Step 6: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol --test wire_tolerance
```

Expected: all nine tests pass.

- [ ] **Step 7: State the rule in `docs/protocol.md`**

In `docs/protocol.md`, add this paragraph at the end of the `## Evolution` section (after the existing "Adding optional fields is backward-compatible…" paragraph):

```markdown
**Unknown variants are tolerated, not fatal.** Clients MUST treat an unrecognized value of an event's `type`, a `generation_committed` `cause`, a `resync_required` `reason`, a `live_state`, or an error `code` as *unknown* rather than as a protocol error: parse the surrounding envelope, keep every field the client does recognize, and ignore the payload it does not. `vaultd`'s own DTOs implement this — each of those enums carries an `Unknown` catch-all, and an unknown event type discards its `value` — so adding an event kind, a cause, a reason, or an error code never breaks a subscriber built against an earlier version. This tolerance is for variants a client has never heard of; a *known* variant whose payload is malformed is still an error.
```

- [ ] **Step 8: Pin the rule with a documentation test**

In `crates/vault-server/tests/docs.rs`, append:

```rust
#[test]
fn the_protocol_documents_its_unknown_variant_tolerance() {
    assert_document_contains(
        "docs/protocol.md",
        &[
            "Unknown variants are tolerated, not fatal",
            "MUST treat an unrecognized value",
            "`Unknown` catch-all",
        ],
    );
}
```

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test docs
```

Expected: every test in `docs.rs` passes, the new one included.

- [ ] **Step 9: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-protocol/src/events.rs crates/vault-protocol/src/error.rs \
        crates/vault-protocol/tests/wire_tolerance.rs \
        crates/vault-server/tests/docs.rs docs/protocol.md
git commit -m "feat(protocol): tolerate unknown variants on open-ended wire enums"
```

Expected: the recorded baseline plus the 10 new tests pass.

---

### Task 2: Mutation and raw-file protocol DTOs

**Files:**

- Create: `crates/vault-protocol/src/mutations.rs`
- Modify: `crates/vault-protocol/src/error.rs` (`ProtocolError` lines 3–11, `ErrorCode`)
- Modify: `crates/vault-protocol/src/operations.rs` (`Request` lines 8–22, `Response` lines 98–112)
- Modify: `crates/vault-protocol/src/lib.rs` (module list and re-exports)
- Create: `crates/vault-protocol/tests/mutations.rs`

**Interfaces:**

- Consumes: `ErrorCode::Unknown` and the tolerant deserializers from Task 1.
- Produces: `ExpectedDto`, `DeleteModeDto`, `CopyConflictDto`, `FrontmatterEditDto`, `PatchValueDto`, `LinkRewriteFailureDto`; params structs `WriteNoteParams`, `FolderParams`, `RenameNoteParams`, `RenameFolderParams`, `CopyFileParams`, `DeleteNoteParams`, `DeleteFolderParams`, `PatchFrontmatterParams`, `WriteFileParams`, `ReadFileParams`; responses `MutationResponse`, `GenerationResponse`, `RenameResponse`, `WriteFileResponse`, `ReadFileResponse`.
- Produces: `Request::{WriteNote, CreateFolder, RenameNote, RenameFolder, CopyFile, DeleteNote, DeleteFolder, PatchFrontmatter, WriteFile, ReadFile}` and the matching `Response` variants.
- Produces: `ProtocolError::current_revision: Option<String>` and `ErrorCode::{RevisionConflict, NotFound, ParentNotFound, TargetExists, CaseCollision, ZoneViolation, PayloadTooLarge, ReadOnly}`.
- Later tasks rely on these exact names; Task 9 converts them, Task 16 uses the raw-file pair, Task 17 uses `ReadOnly`.

- [ ] **Step 1: Write the failing DTO round-trip test**

Create `crates/vault-protocol/tests/mutations.rs`:

```rust
//! The mutation request and response shapes, pinned to the exact JSON the
//! design names. Wire spellings are contractual: a rename here is a protocol
//! break, not a refactor.

use vault_protocol::{
    CopyConflictDto, DeleteModeDto, ExpectedDto, FrontmatterEditDto, LinkRewriteFailureDto,
    MutationResponse, PatchValueDto, RenameResponse, Request, RequestEnvelope, Response,
    ResponseEnvelope, ResponseOutcome, WriteNoteParams,
};

#[test]
fn a_write_note_request_round_trips_through_its_documented_json() {
    let line = r#"{"version":1,"id":"w1","request":{"method":"write_note","params":{"path":"One.md","content":"# One\n","expected":{"revision":"blake3:abc"}}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode write_note");
    match &envelope.request {
        Request::WriteNote(params) => {
            assert_eq!(params.path, "One.md");
            assert_eq!(params.content, "# One\n");
            assert_eq!(params.expected.revision.as_deref(), Some("blake3:abc"));
            assert_eq!(params.expected.absent, None);
            assert_eq!(params.expected.any, None);
        }
        other => panic!("expected write_note, got {other:?}"),
    }
    assert_eq!(
        serde_json::to_string(&envelope).expect("re-encode"),
        line,
        "the encoded form must be byte-identical to the documented one"
    );
}

#[test]
fn the_three_expected_shapes_each_decode_to_exactly_one_field() {
    let absent: ExpectedDto =
        serde_json::from_str(r#"{"absent":true}"#).expect("decode absent precondition");
    assert_eq!(absent.absent, Some(true));
    assert_eq!(absent.revision, None);

    let any: ExpectedDto = serde_json::from_str(r#"{"any":true}"#).expect("decode any precondition");
    assert_eq!(any.any, Some(true));

    let empty: ExpectedDto = serde_json::from_str("{}").expect("an omitted precondition decodes");
    assert_eq!(empty.revision, None);
    assert_eq!(empty.absent, None);
    assert_eq!(empty.any, None);

    let extra = serde_json::from_str::<ExpectedDto>(r#"{"whatever":true}"#);
    assert!(
        extra.is_err(),
        "an unknown precondition field is a client bug, not a variant to tolerate"
    );
}

#[test]
fn a_write_note_request_omits_an_absent_precondition_entirely() {
    let params = WriteNoteParams {
        path: "One.md".into(),
        content: "# One\n".into(),
        expected: ExpectedDto::default(),
    };
    assert_eq!(
        serde_json::to_string(&params).expect("encode"),
        r#"{"path":"One.md","content":"# One\n","expected":{}}"#
    );
}

#[test]
fn delete_and_copy_modes_use_their_documented_spellings() {
    assert_eq!(
        serde_json::to_string(&DeleteModeDto::TrashSystem).expect("encode"),
        r#""trash_system""#
    );
    assert_eq!(
        serde_json::to_string(&DeleteModeDto::TrashLocal).expect("encode"),
        r#""trash_local""#
    );
    assert_eq!(
        serde_json::to_string(&DeleteModeDto::Permanent).expect("encode"),
        r#""permanent""#
    );
    assert_eq!(
        serde_json::to_string(&CopyConflictDto::Error).expect("encode"),
        r#""error""#
    );
    assert_eq!(
        serde_json::to_string(&CopyConflictDto::Suffix).expect("encode"),
        r#""suffix""#
    );
}

#[test]
fn a_frontmatter_patch_carries_dot_paths_and_a_null_deletion() {
    let line = r#"{"version":1,"id":"p1","request":{"method":"patch_frontmatter","params":{"path":"One.md","patch":[{"key_path":"a.b.c","value":"set"},{"key_path":"gone","value":null}],"expected":{"any":true}}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode patch_frontmatter");
    match &envelope.request {
        Request::PatchFrontmatter(params) => {
            assert_eq!(params.patch.len(), 2);
            assert_eq!(params.patch[0].key_path, "a.b.c");
            assert_eq!(
                params.patch[0].value,
                Some(PatchValueDto::String("set".into()))
            );
            assert_eq!(
                params.patch[1].value, None,
                "an explicit JSON null is the deletion spelling"
            );
        }
        other => panic!("expected patch_frontmatter, got {other:?}"),
    }
    assert_eq!(serde_json::to_string(&envelope).expect("re-encode"), line);
}

#[test]
fn a_patch_value_decodes_every_json_shape_the_design_allows() {
    let sequence: PatchValueDto =
        serde_json::from_str(r#"["one",2,true]"#).expect("decode a sequence");
    assert_eq!(
        sequence,
        PatchValueDto::Sequence(vec![
            PatchValueDto::String("one".into()),
            PatchValueDto::Integer(2),
            PatchValueDto::Boolean(true),
        ])
    );
    let mapping: PatchValueDto =
        serde_json::from_str(r#"{"key":"value"}"#).expect("decode a mapping");
    assert_eq!(
        mapping,
        PatchValueDto::Mapping(vec![("key".to_string(), PatchValueDto::String("value".into()))])
    );
    let float: PatchValueDto = serde_json::from_str("1.5").expect("decode a float");
    assert_eq!(float, PatchValueDto::Float(1.5));
}

#[test]
fn a_mutation_response_reports_its_generation_and_revision() {
    let response = ResponseEnvelope::success(
        "w1",
        Response::WriteNote(MutationResponse {
            generation: 4,
            revision: "blake3:def".into(),
        }),
    );
    assert_eq!(
        serde_json::to_string(&response).expect("encode"),
        r#"{"version":1,"id":"w1","outcome":{"status":"ok","value":{"type":"write_note","value":{"generation":4,"revision":"blake3:def"}}}}"#
    );
}

#[test]
fn a_rename_response_reports_rewrites_and_the_files_it_skipped() {
    let response = ResponseEnvelope::success(
        "r1",
        Response::RenameNote(RenameResponse {
            generation: 5,
            revision: "blake3:def".into(),
            links_rewritten: 3,
            link_rewrite_failures: vec![LinkRewriteFailureDto {
                path: "Busy.md".into(),
                reason: "revision_conflict".into(),
            }],
        }),
    );
    let encoded = serde_json::to_string(&response).expect("encode");
    assert!(encoded.contains(r#""links_rewritten":3"#), "{encoded}");
    assert!(
        encoded.contains(r#""link_rewrite_failures":[{"path":"Busy.md","reason":"revision_conflict"}]"#),
        "{encoded}"
    );
}

#[test]
fn a_revision_conflict_carries_both_the_current_revision_and_generation() {
    let line = r#"{"version":1,"id":"w1","outcome":{"status":"err","value":{"code":"revision_conflict","message":"One.md moved","current_generation":7,"current_revision":"blake3:ghi"}}}"#;
    let envelope: ResponseEnvelope = serde_json::from_str(line).expect("decode conflict");
    match envelope.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, vault_protocol::ErrorCode::RevisionConflict);
            assert_eq!(error.current_generation, Some(7));
            assert_eq!(error.current_revision.as_deref(), Some("blake3:ghi"));
        }
        other => panic!("expected an error outcome, got {other:?}"),
    }
}
```

- [ ] **Step 2: Run the focused test and observe the missing module**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol --test mutations
```

Expected: compilation fails — none of `ExpectedDto`, `WriteNoteParams`, `MutationResponse`, `Request::WriteNote`, or `ErrorCode::RevisionConflict` exist.

- [ ] **Step 3: Create the mutation DTO module**

Create `crates/vault-protocol/src/mutations.rs`:

```rust
//! Mutation and raw-file DTOs.
//!
//! Additive to protocol version 1: no existing shape changes. Every wire
//! spelling here is contractual — the design names them, `docs/protocol.md`
//! documents them, and `tests/mutations.rs` pins them.

use serde::{Deserialize, Serialize};

/// The precondition a content-bearing mutation carries.
///
/// Modelled as three optional fields rather than a tagged enum because that
/// is the wire shape the design specifies (`{"revision": …}`,
/// `{"absent": true}`, `{"any": true}`), and because `deny_unknown_fields`
/// then rejects a misspelled precondition loudly instead of silently
/// downgrading it to "unconditional". Exactly one field must be set; the
/// server validates that and answers `invalid_request` otherwise, because a
/// two-field precondition has no meaning.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub any: Option<bool>,
}

/// How a delete disposes of its target. The shim passes the plugin's own
/// choice through; a direct client that omits this gets the vault's
/// `.obsidian/app.json` `trashOption` default.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteModeDto {
    TrashSystem,
    TrashLocal,
    Permanent,
}

/// What `copy_file` does when its destination already exists.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyConflictDto {
    #[default]
    Error,
    /// Obsidian's auto-numbering behaviour, for `getAvailablePath` parity.
    Suffix,
}

/// One frontmatter value a patch sets. There is no null variant: a JSON
/// `null` in `value` is the deletion spelling, carried as
/// `FrontmatterEditDto::value == None`.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PatchValueDto {
    Boolean(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Sequence(Vec<PatchValueDto>),
    Mapping(Vec<(String, PatchValueDto)>),
}

/// One addressed key and what becomes of it. `key_path` is a dot-path
/// (`a.b.c`) addressing nested keys; `value: null` deletes.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FrontmatterEditDto {
    pub key_path: String,
    pub value: Option<PatchValueDto>,
}

/// One referencing note a rename could not rewrite, and why.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LinkRewriteFailureDto {
    pub path: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WriteNoteParams {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub expected: ExpectedDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FolderParams {
    pub path: String,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RenameNoteParams {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub expected: ExpectedDto,
    #[serde(default = "default_true")]
    pub rewrite_links: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RenameFolderParams {
    pub from: String,
    pub to: String,
    #[serde(default = "default_true")]
    pub rewrite_links: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CopyFileParams {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub expected_source: ExpectedDto,
    #[serde(default)]
    pub if_exists: CopyConflictDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DeleteNoteParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<DeleteModeDto>,
    #[serde(default)]
    pub expected: ExpectedDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DeleteFolderParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<DeleteModeDto>,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PatchFrontmatterParams {
    pub path: String,
    pub patch: Vec<FrontmatterEditDto>,
    #[serde(default)]
    pub expected: ExpectedDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WriteFileParams {
    pub path: String,
    pub content_base64: String,
    #[serde(default)]
    pub expected: ExpectedDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReadFileParams {
    pub path: String,
}

/// A content-bearing mutation's answer: the generation containing it, and
/// the revision it wrote.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MutationResponse {
    pub generation: u64,
    pub revision: String,
}

/// A mutation with no content revision to report — a folder operation, or a
/// delete (a deleted file has no revision).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GenerationResponse {
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RenameResponse {
    pub generation: u64,
    pub revision: String,
    pub links_rewritten: u64,
    pub link_rewrite_failures: Vec<LinkRewriteFailureDto>,
}

/// `generation` is absent and `semantic` is `false` for a write into the
/// `.obsidian` zone: nothing there is indexed, so no generation contains it.
///
/// `semantic` answers **"is this path inside the indexed vault"** — it is
/// `!` the configuration-zone test and nothing else. It deliberately does not
/// answer "did this write change indexed rows", which for a raw write is
/// always `false`: `write_file` reaches only attachments and the zone, and a
/// `.md` path is refused so a note can never bypass its generation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WriteFileResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    pub revision: String,
    pub semantic: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReadFileResponse {
    pub content_base64: String,
    pub revision: String,
}
```

- [ ] **Step 4: Add the error codes and the conflict's current revision**

In `crates/vault-protocol/src/error.rs`, add to `ProtocolError` after `current_generation`:

```rust
    /// The revision the target actually holds, on a `revision_conflict`. The
    /// caller's retry loop needs it, and re-reading the note to discover it
    /// would race the next writer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
```

Add these variants to `ErrorCode` immediately before `Unknown`, and their arms to the hand-written `Deserialize` from Task 1:

```rust
    RevisionConflict,
    NotFound,
    ParentNotFound,
    TargetExists,
    CaseCollision,
    ZoneViolation,
    PayloadTooLarge,
    ReadOnly,
```

```rust
            "revision_conflict" => Self::RevisionConflict,
            "not_found" => Self::NotFound,
            "parent_not_found" => Self::ParentNotFound,
            "target_exists" => Self::TargetExists,
            "case_collision" => Self::CaseCollision,
            "zone_violation" => Self::ZoneViolation,
            "payload_too_large" => Self::PayloadTooLarge,
            "read_only" => Self::ReadOnly,
```

Every existing `ProtocolError { … }` literal in `vault-protocol` and `vault-server` now misses a field. There are **nine**, verified by grep on `99264d4` — one in `vault-protocol` and eight in `vault-server`. Add `current_revision: None` to each:

| # | Location |
| --- | --- |
| 1 | `validate_version` in `crates/vault-protocol/src/envelope.rs` |
| 2 | `index_unavailable`, `crates/vault-server/src/lib.rs:52` |
| 3 | `runtime_not_ready`, `crates/vault-server/src/lib.rs:63` |
| 4 | `parse_path`, `crates/vault-server/src/lib.rs:72` |
| 5 | `unsubscribe`, `crates/vault-server/src/subscriptions.rs:432` |
| 6 | `refresh_failure`'s `Overloaded` arm, `crates/vault-server/src/convert.rs:269` |
| 7 | `refresh_failure`'s `NotReady` arm, `crates/vault-server/src/convert.rs:275` |
| 8 | `index_error`'s `let mut error = …` initializer, `crates/vault-server/src/convert.rs:288` |
| 9 | the request-decode failure in `crates/vault-server/src/stdio.rs:106` |

The ninth is the one a reader skips: it is the *only* `ProtocolError` in `stdio.rs`, it sits in the transport rather than in a handler, and missing it is a compile error rather than a silent bug — so this table exists to make the compiler's complaint predictable rather than surprising.

- [ ] **Step 5: Add the request and response variants**

In `crates/vault-protocol/src/operations.rs`, add `use crate::mutations::{…};` for every params and response type, then extend `Request` (after `Unsubscribe`):

```rust
    WriteNote(WriteNoteParams),
    CreateFolder(FolderParams),
    RenameNote(RenameNoteParams),
    RenameFolder(RenameFolderParams),
    CopyFile(CopyFileParams),
    DeleteNote(DeleteNoteParams),
    DeleteFolder(DeleteFolderParams),
    PatchFrontmatter(PatchFrontmatterParams),
    WriteFile(WriteFileParams),
    ReadFile(ReadFileParams),
```

and `Response` (after `Unsubscribe`):

```rust
    WriteNote(MutationResponse),
    CreateFolder(GenerationResponse),
    RenameNote(RenameResponse),
    RenameFolder(RenameResponse),
    CopyFile(MutationResponse),
    DeleteNote(GenerationResponse),
    DeleteFolder(GenerationResponse),
    PatchFrontmatter(MutationResponse),
    WriteFile(WriteFileResponse),
    ReadFile(ReadFileResponse),
```

In `crates/vault-protocol/src/lib.rs`, add `mod mutations;` and re-export every public name from it.

- [ ] **Step 6: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol
```

Expected: all nine tests in `tests/mutations.rs` pass, and the existing `tests/events.rs`, `tests/indexed_operations.rs`, and `tests/schema.rs` still pass — no existing serialized form moved.

- [ ] **Step 7: Add the temporary dispatch arms so `vault-server` still compiles**

`Request` is matched exhaustively in `Server::handle` and that match has **no catch-all arm** — the last one today is `Request::Unsubscribe(params)` — so ten new variants break `vault-server`'s build the moment they exist. This is implementation work, not commit hygiene, so it gets its own step and its own run.

In `crates/vault-server/src/lib.rs`, add one arm at the end of that match:

```rust
            // Wired in Task 9; the DTOs land first so the protocol stays
            // additive and each layer is reviewable on its own.
            Request::WriteNote(_)
            | Request::CreateFolder(_)
            | Request::RenameNote(_)
            | Request::RenameFolder(_)
            | Request::CopyFile(_)
            | Request::DeleteNote(_)
            | Request::DeleteFolder(_)
            | Request::PatchFrontmatter(_)
            | Request::WriteFile(_)
            | Request::ReadFile(_) => {
                ResponseEnvelope::error(id, runtime_not_ready("mutations are not wired yet"))
            }
```

One `|`-joined arm rather than ten copies: they are identical placeholders, and Task 9 replaces the whole block. Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server
```

Expected: `vault-server` compiles and its suite passes. A client that calls a mutation between this task and Task 9 gets a typed `runtime_not_ready`, never a panic and never a silent success.

- [ ] **Step 8: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-protocol/src/mutations.rs crates/vault-protocol/src/error.rs \
        crates/vault-protocol/src/operations.rs crates/vault-protocol/src/lib.rs \
        crates/vault-protocol/src/envelope.rs crates/vault-protocol/tests/mutations.rs \
        crates/vault-server/src/lib.rs crates/vault-server/src/subscriptions.rs \
        crates/vault-server/src/convert.rs crates/vault-server/src/stdio.rs
git commit -m "feat(protocol): add mutation and raw-file operation dtos"
```

Expected: the workspace suite passes.

---

### Task 3: Snapshot-session protocol DTOs

**Files:**

- Create: `crates/vault-protocol/src/snapshots.rs`
- Modify: `crates/vault-protocol/src/error.rs` (`ErrorCode`)
- Modify: `crates/vault-protocol/src/operations.rs` (`Request`, `Response`)
- Modify: `crates/vault-protocol/src/lib.rs`
- Modify: `crates/vault-server/src/lib.rs` (temporary arms, as in Task 2 Step 7)
- Create: `crates/vault-protocol/tests/snapshots.rs`

**Interfaces:**

- Consumes: `ErrorCode`'s hand-written `Deserialize` (Task 1), the existing `PropertyDto`, `AliasDto`, `HeadingDto`, `BlockDto`, `TagDto`, `DiagnosticDto`, `ReferenceDto`, `ResolutionDto`, `SpanDto` from `crate::semantic`.
- Produces: `OpenSnapshotParams`, `OpenSnapshotResponse`, `SnapshotTreeParams`, `SnapshotTreeResponse`, `TreeEntryDto`, `TreeEntryKindDto`, `SnapshotNotesParams`, `SnapshotNotesResponse`, `SnapshotNoteDto`, `NoteFacetDto`, `NoteMetadataDto`, `SectionDto`, `ListItemDto`, `CloseSnapshotParams`, `CloseSnapshotResponse`.
- Produces: `ErrorCode::{SnapshotNotFound, TooManySnapshots}`.
- Produces: `Request::{OpenSnapshot, SnapshotTree, SnapshotNotes, CloseSnapshot}` and matching `Response` variants.
- Tasks 13–15 fill these in; nothing else depends on them.

- [ ] **Step 1: Write the failing snapshot DTO test**

Create `crates/vault-protocol/tests/snapshots.rs`:

```rust
//! Snapshot-session request and response shapes. These replace the v1
//! streaming design entirely: every call is ordinary request/response, so
//! there is no new framing here to test — only shapes and spellings.

use vault_protocol::{
    CloseSnapshotResponse, ErrorCode, ListItemDto, NoteFacetDto, NoteMetadataDto,
    OpenSnapshotResponse, Request, RequestEnvelope, Response, ResponseEnvelope, SectionDto,
    SnapshotNoteDto, SnapshotNotesResponse, SnapshotTreeResponse, SpanDto, TreeEntryDto,
    TreeEntryKindDto,
};

#[test]
fn open_snapshot_takes_no_parameters_and_reports_both_counts() {
    let line = r#"{"version":1,"id":"s1","request":{"method":"open_snapshot","params":{}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode open_snapshot");
    assert!(matches!(envelope.request, Request::OpenSnapshot(_)));
    assert_eq!(serde_json::to_string(&envelope).expect("re-encode"), line);

    let response = ResponseEnvelope::success(
        "s1",
        Response::OpenSnapshot(OpenSnapshotResponse {
            snapshot_id: "snap-1".into(),
            generation: 9,
            note_count: 120,
            entry_count: 145,
        }),
    );
    let encoded = serde_json::to_string(&response).expect("encode");
    assert!(encoded.contains(r#""snapshot_id":"snap-1""#), "{encoded}");
    assert!(encoded.contains(r#""note_count":120"#), "{encoded}");
    assert!(encoded.contains(r#""entry_count":145"#), "{encoded}");
}

#[test]
fn a_tree_page_carries_folders_notes_and_plain_files_with_their_stat() {
    let page = SnapshotTreeResponse {
        snapshot_id: "snap-1".into(),
        generation: 9,
        entries: vec![
            TreeEntryDto {
                path: "Folder".into(),
                kind: TreeEntryKindDto::Folder,
                size: None,
                ctime_unix_ms: 1_700_000_000_000,
                mtime_unix_ms: 1_700_000_000_500,
                revision: None,
            },
            TreeEntryDto {
                path: "Folder/One.md".into(),
                kind: TreeEntryKindDto::Note,
                size: Some(7),
                ctime_unix_ms: 1_700_000_001_000,
                mtime_unix_ms: 1_700_000_002_000,
                revision: Some("blake3:abc".into()),
            },
            TreeEntryDto {
                path: "Folder/image.png".into(),
                kind: TreeEntryKindDto::File,
                size: Some(1024),
                ctime_unix_ms: 1_700_000_003_000,
                mtime_unix_ms: 1_700_000_003_000,
                revision: Some("blake3:def".into()),
            },
        ],
        next_cursor: Some("opaque".into()),
    };
    let encoded = serde_json::to_string(&page).expect("encode");
    assert!(encoded.contains(r#""kind":"folder""#), "{encoded}");
    assert!(encoded.contains(r#""kind":"note""#), "{encoded}");
    assert!(encoded.contains(r#""kind":"file""#), "{encoded}");
    assert!(
        encoded.contains(r#""ctime_unix_ms":1700000001000"#),
        "the host serves TFile.stat from these two fields: {encoded}"
    );
    assert!(encoded.contains(r#""mtime_unix_ms":1700000002000"#), "{encoded}");
    let decoded: SnapshotTreeResponse = serde_json::from_str(&encoded).expect("round trip");
    assert_eq!(decoded.entries.len(), 3);
    assert_eq!(decoded.entries[0].size, None, "a folder has no size");
    assert_eq!(
        decoded.entries[0].ctime_unix_ms, 1_700_000_000_000,
        "a folder still has timestamps; only its size is absent"
    );
}

#[test]
fn a_notes_page_request_names_the_facets_it_wants() {
    let line = r#"{"version":1,"id":"s2","request":{"method":"snapshot_notes","params":{"snapshot_id":"snap-1","include":["metadata","references","sections","list_items"]}}}"#;
    let envelope: RequestEnvelope = serde_json::from_str(line).expect("decode snapshot_notes");
    match &envelope.request {
        Request::SnapshotNotes(params) => {
            assert_eq!(params.snapshot_id, "snap-1");
            assert_eq!(
                params.include,
                vec![
                    NoteFacetDto::Metadata,
                    NoteFacetDto::References,
                    NoteFacetDto::Sections,
                    NoteFacetDto::ListItems,
                ]
            );
            assert_eq!(params.cursor, None);
            assert_eq!(params.limit, None);
        }
        other => panic!("expected snapshot_notes, got {other:?}"),
    }
}

#[test]
fn an_unrequested_facet_is_absent_rather_than_empty() {
    let note = SnapshotNoteDto {
        path: "One.md".into(),
        revision: "blake3:abc".into(),
        metadata: Some(NoteMetadataDto {
            properties: Vec::new(),
            aliases: Vec::new(),
            headings: Vec::new(),
            blocks: Vec::new(),
            tags: Vec::new(),
            diagnostics: Vec::new(),
        }),
        references: None,
        resolutions: None,
        backlinks: None,
        sections: Some(vec![SectionDto {
            kind: "heading".into(),
            span: SpanDto { start: 0, end: 7 },
            block_id: None,
        }]),
        list_items: Some(vec![ListItemDto {
            span: SpanDto { start: 8, end: 16 },
            list_start_line: Some(1),
            parent_start_line: None,
            task: Some(" ".into()),
        }]),
    };
    let encoded = serde_json::to_string(&note).expect("encode");
    assert!(
        !encoded.contains("references"),
        "an unrequested facet must be absent, not an empty list: {encoded}"
    );
    assert!(encoded.contains(r#""sections":[{"kind":"heading""#), "{encoded}");
    assert!(
        encoded.contains(r#""list_start_line":1"#) && !encoded.contains("parent_start_line"),
        "a top-level item names its list's start line and nothing else: {encoded}"
    );
    assert!(
        !encoded.contains("-1"),
        "the line-number model has no sentinel: {encoded}"
    );
}

#[test]
fn a_nested_list_item_names_its_parents_start_line_instead() {
    let nested = ListItemDto {
        span: SpanDto { start: 20, end: 30 },
        list_start_line: None,
        parent_start_line: Some(3),
        task: Some("x".into()),
    };
    let encoded = serde_json::to_string(&nested).expect("encode");
    assert_eq!(
        encoded,
        r#"{"span":{"start":20,"end":30},"parent_start_line":3,"task":"x"}"#
    );
    let decoded: ListItemDto = serde_json::from_str(&encoded).expect("round trip");
    assert_eq!(decoded.list_start_line, None);
    assert_eq!(decoded.parent_start_line, Some(3));
    assert_eq!(
        decoded.task.as_deref().map(str::len),
        Some(1),
        "task is one character on the wire, per the pre-task's pinned convention"
    );
}

#[test]
fn a_section_carries_its_block_id_when_it_has_one() {
    let section = SectionDto {
        kind: "paragraph".into(),
        span: SpanDto { start: 0, end: 12 },
        block_id: Some("anchor".into()),
    };
    assert_eq!(
        serde_json::to_string(&section).expect("encode"),
        r#"{"kind":"paragraph","span":{"start":0,"end":12},"block_id":"anchor"}"#
    );
}

#[test]
fn closing_a_snapshot_echoes_its_identifier() {
    let response = CloseSnapshotResponse {
        snapshot_id: "snap-1".into(),
    };
    assert_eq!(
        serde_json::to_string(&response).expect("encode"),
        r#"{"snapshot_id":"snap-1"}"#
    );
}

#[test]
fn the_snapshot_error_codes_have_their_documented_spellings() {
    assert_eq!(
        serde_json::to_string(&ErrorCode::SnapshotNotFound).expect("encode"),
        r#""snapshot_not_found""#
    );
    assert_eq!(
        serde_json::to_string(&ErrorCode::TooManySnapshots).expect("encode"),
        r#""too_many_snapshots""#
    );
    let decoded: ErrorCode =
        serde_json::from_str(r#""snapshot_not_found""#).expect("decode snapshot_not_found");
    assert_eq!(decoded, ErrorCode::SnapshotNotFound);
}

#[test]
fn an_empty_notes_page_still_reports_its_snapshot_and_generation() {
    let page = SnapshotNotesResponse {
        snapshot_id: "snap-1".into(),
        generation: 9,
        notes: Vec::new(),
        next_cursor: None,
    };
    assert_eq!(
        serde_json::to_string(&page).expect("encode"),
        r#"{"snapshot_id":"snap-1","generation":9,"notes":[],"next_cursor":null}"#
    );
}
```

- [ ] **Step 2: Run the focused test and observe the missing module**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol --test snapshots
```

Expected: compilation fails — `OpenSnapshotResponse`, `TreeEntryDto`, `NoteFacetDto`, and the two error codes do not exist.

- [ ] **Step 3: Create the snapshot DTO module**

Create `crates/vault-protocol/src/snapshots.rs`:

```rust
//! Snapshot-session DTOs.
//!
//! A snapshot session is a pinned, generation-stable view a client pages
//! through with ordinary request/response calls, so hydration costs a
//! handful of round trips instead of thousands and never tears across
//! generations. Nothing here introduces new framing.

use serde::{Deserialize, Serialize};

use crate::semantic::{
    AliasDto, BlockDto, DiagnosticDto, HeadingDto, PropertyDto, ReferenceDto, ResolutionDto,
    SpanDto, TagDto,
};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct OpenSnapshotParams {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OpenSnapshotResponse {
    pub snapshot_id: String,
    pub generation: u64,
    pub note_count: u64,
    /// Every tree entry the session will page out: folders, notes, and
    /// non-Markdown files. Always at least `note_count`.
    pub entry_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotTreeParams {
    pub snapshot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// What one tree entry is. `Note` is an indexed Markdown file; `File` is any
/// other vault file (attachments), which carries bytes but no semantics.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TreeEntryKindDto {
    Folder,
    Note,
    File,
}

/// One entry of the vault tree, read from the pre-task's `tree_entries` table
/// inside the session's pinned transaction.
///
/// `size` and `revision` are absent for a folder, which has neither. The two
/// timestamps are never absent: they are **the source a host serves
/// `TFile.stat = { ctime, mtime, size }` from**, which is why they are stored
/// per entry rather than restated from the filesystem at read time. Both are
/// Unix milliseconds; `ctime_unix_ms` is filesystem birthtime where the
/// platform provides it and mtime where it does not.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TreeEntryDto {
    pub path: String,
    pub kind: TreeEntryKindDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub ctime_unix_ms: i64,
    pub mtime_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotTreeResponse {
    pub snapshot_id: String,
    pub generation: u64,
    pub entries: Vec<TreeEntryDto>,
    pub next_cursor: Option<String>,
}

/// Which per-note row-sets a page carries. A facet a client does not ask for
/// is not read, not serialized, and absent from the response.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteFacetDto {
    Metadata,
    References,
    /// The resolution answers, in the same ordinal order as `references`.
    /// Redundant with `references` (whose entries carry their own
    /// resolution) and cheaper: a client that wants answers without spans or
    /// spellings asks for this alone.
    Resolutions,
    Backlinks,
    /// Block-level sections, from the schema-v3 `sections` rows. A **sibling
    /// of `metadata`, never nested inside it** — the pre-task pins that, and a
    /// client asks for it by name or does not get it.
    Sections,
    /// List items, from the schema-v3 `list_items` rows. A sibling of
    /// `metadata` for the same reason.
    ListItems,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct SnapshotNotesParams {
    pub snapshot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default)]
    pub include: Vec<NoteFacetDto>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct NoteMetadataDto {
    pub properties: Vec<PropertyDto>,
    pub aliases: Vec<AliasDto>,
    pub headings: Vec<HeadingDto>,
    pub blocks: Vec<BlockDto>,
    pub tags: Vec<TagDto>,
    pub diagnostics: Vec<DiagnosticDto>,
}

/// One parsed document section, from the schema-v3 `sections` rows.
/// `block_id` is the trailing `^id` anchor when the block carries one.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SectionDto {
    pub kind: String,
    pub span: SpanDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
}

/// One parsed list item, from the schema-v3 `list_items` rows.
///
/// The parent is a **line number**, never an array index and never a sentinel:
/// a top-level item names the start line of the list that contains it
/// (`list_start_line`), a nested item names its parent item's own start line
/// (`parent_start_line`), and exactly one of the two is set. This mirrors the
/// pre-task's pinned DDL column-for-column. A host reconstructing Obsidian's
/// single `listItems[].parent` number negates `list_start_line` and passes
/// `parent_start_line` through unchanged — the widening lives here so the
/// negation is the consumer's arithmetic rather than this protocol's sign
/// trick.
///
/// `task` is the raw character inside the brackets when the item is a task
/// and absent otherwise: `Option<char>` in the domain, a one-character string
/// on the wire.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ListItemDto {
    pub span: SpanDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

/// One note's requested facets. Bodies stay per-note through `get_note`.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SnapshotNoteDto {
    pub path: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<NoteMetadataDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<ReferenceDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolutions: Option<Vec<ResolutionDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backlinks: Option<Vec<ReferenceDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<Vec<SectionDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_items: Option<Vec<ListItemDto>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SnapshotNotesResponse {
    pub snapshot_id: String,
    pub generation: u64,
    pub notes: Vec<SnapshotNoteDto>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloseSnapshotParams {
    pub snapshot_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloseSnapshotResponse {
    pub snapshot_id: String,
}
```

- [ ] **Step 4: Add the two snapshot error codes**

In `crates/vault-protocol/src/error.rs`, add `SnapshotNotFound` and `TooManySnapshots` to `ErrorCode` immediately before `Unknown`, and their arms to the hand-written `Deserialize`:

```rust
            "snapshot_not_found" => Self::SnapshotNotFound,
            "too_many_snapshots" => Self::TooManySnapshots,
```

- [ ] **Step 5: Add the request and response variants**

In `crates/vault-protocol/src/operations.rs`, extend `Request`:

```rust
    OpenSnapshot(OpenSnapshotParams),
    SnapshotTree(SnapshotTreeParams),
    SnapshotNotes(SnapshotNotesParams),
    CloseSnapshot(CloseSnapshotParams),
```

and `Response`:

```rust
    OpenSnapshot(OpenSnapshotResponse),
    SnapshotTree(SnapshotTreeResponse),
    SnapshotNotes(SnapshotNotesResponse),
    CloseSnapshot(CloseSnapshotResponse),
```

In `crates/vault-protocol/src/lib.rs`, add `mod snapshots;` and re-export every public name from it.

In `crates/vault-server/src/lib.rs`, extend the temporary arm from Task 2 Step 7 with the four snapshot variants, keeping it one `|`-joined arm, and change its comment to `// Wired in Task 9 (mutations) and Tasks 13-15 (snapshots).`

- [ ] **Step 6: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-protocol
```

Expected: the nine snapshot tests pass and every earlier protocol test still passes.

- [ ] **Step 7: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-protocol/src/snapshots.rs crates/vault-protocol/src/error.rs \
        crates/vault-protocol/src/operations.rs crates/vault-protocol/src/lib.rs \
        crates/vault-protocol/tests/snapshots.rs crates/vault-server/src/lib.rs
git commit -m "feat(protocol): add snapshot session operation dtos"
```

---

## Execution checkpoint 1 — after Task 3: the wire is settled, nothing writes yet

**Stop here and get a review before Task 4.** Everything committed so far is protocol surface: enum tolerance, request and response shapes, error-code spellings. None of it writes a byte into a vault, and all of it is *contractual* — a spelling changed after a consumer ships is a protocol break rather than a refactor, and the headless plugin host plan consumes exactly these names.

What the reviewer is checking: every wire spelling matches the design and the pinned pre-task conventions (`list_start_line`/`parent_start_line`, `block_id`, one-character `task`, `ctime_unix_ms`/`mtime_unix_ms`); no existing serialized form moved; the unknown-variant tolerance degrades unknown variants and still fails malformed known ones. Cheap to fix now, expensive after Task 9.

---

### Task 4: The mutation engine's path containment and preconditions

No writes yet: this task builds the two things every later mutation depends on and gets wrong most easily — resolving a vault path to a filesystem location that provably stays inside the vault, and evaluating a compare-and-swap precondition.

**Note on the validation mechanism.** `IndexConfig`'s `resolve_against_existing_ancestor`/`reject_if_inside_vault` pair is the *cache*-path check: it proves a path is **outside** the vault. Mutations need the opposite proof, and the model for it is `FileSystemVaultSource::contained_target` in `crates/vault-core/src/vault_source.rs` (lines 64–71) — canonicalize, then `starts_with` the canonical root. That check cannot be reused verbatim because a mutation target need not exist yet, so `MutationEngine::resolve` canonicalizes the *parent* and re-checks the final component when it does exist.

**Note on what a revision is compared against.** The design's Architecture line says "CAS against the index" and its Revisions section says "the target must currently have this revision". These can disagree, because the index lags the filesystem by up to a debounce window. This plan compares against **the bytes on disk at mutation time**: a CAS validated against a lagging index would admit exactly the lost update CAS exists to prevent. The index's generation is still what the response reports.

**Files:**

- Create: `crates/vault-index/src/mutate.rs`
- Modify: `crates/vault-index/src/lib.rs` (module list lines 1–16, re-exports lines 18–45)
- Modify: `crates/vault-index/src/error.rs` (`IndexError`)
- Create: `crates/vault-index/tests/mutation_paths.rs`

**Interfaces:**

- Produces: `pub struct MutationEngine`, `MutationEngine::new(canonical_root: impl AsRef<Path>) -> MutationEngine`, `MutationEngine::with_read_only(self, read_only: bool) -> MutationEngine`, `MutationEngine::with_max_file_bytes(self, max: u64) -> MutationEngine`.
- Produces: `MutationEngine::resolve(&self, path: &VaultPath) -> Result<PathBuf, MutationError>`.
- Produces: `MutationEngine::current_revision(&self, path: &VaultPath) -> Result<Option<String>, MutationError>`.
- Produces: `MutationEngine::check(&self, path: &VaultPath, expected: &Precondition) -> Result<Option<Vec<u8>>, MutationError>` — `Ok(Some(bytes))` when the target exists and satisfied the precondition, `Ok(None)` when it is absent and the precondition allowed that.
- Produces: `MutationEngine::case_variant(&self, path: &VaultPath) -> Result<Option<String>, MutationError>`.
- Produces: `pub enum Precondition { Revision(String), Absent, Any }`, `pub enum MutationError { … }`, `pub fn revision_of(bytes: &[u8]) -> String`, `pub const DEFAULT_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024`.
- Produces: `IndexError::Mutation(MutationError)` with `#[from]`.
- Tasks 5–8 add operations to this engine; Task 9 calls it from the coordinator; Task 17 sets `read_only`.

- [ ] **Step 1: Write the failing containment test**

Create `crates/vault-index/tests/mutation_paths.rs`:

```rust
//! Path containment and preconditions: the two checks every mutation runs
//! before it touches a byte.

use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{MutationEngine, MutationError, Precondition, revision_of};

struct Fixture {
    engine: MutationEngine,
    root: PathBuf,
    _vault: TempDir,
    _outside: TempDir,
    outside: PathBuf,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let outside = TempDir::new().expect("outside tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    let outside_root = outside.path().canonicalize().expect("canonical outside root");
    std::fs::create_dir_all(root.join("Folder")).expect("create Folder");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    std::fs::write(outside_root.join("Secret.md"), "# Secret\n").expect("write Secret");
    let engine = MutationEngine::new(&root);
    Fixture {
        engine,
        root,
        _vault: vault,
        _outside: outside,
        outside: outside_root,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

#[test]
fn a_path_inside_the_vault_resolves_under_the_canonical_root() {
    let fixture = fixture();
    let resolved = fixture
        .engine
        .resolve(&path("Folder/New.md"))
        .expect("a path with an existing parent resolves");
    assert_eq!(resolved, fixture.root.join("Folder").join("New.md"));
}

// Both symlink tests are gated whole rather than gating only the `symlink`
// call: with the call compiled out the assertion below would demand a refusal
// of an ordinary missing path, and the test would fail on the platform the
// gate was supposed to protect.
#[cfg(unix)]
#[test]
fn a_symlinked_folder_that_escapes_the_vault_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(&fixture.outside, fixture.root.join("Escape"))
        .expect("plant an escaping symlink");
    let error = fixture
        .engine
        .resolve(&path("Escape/Secret.md"))
        .expect_err("a write through an escaping symlink must be refused");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_file_that_escapes_the_vault_is_refused() {
    let fixture = fixture();
    std::os::unix::fs::symlink(
        fixture.outside.join("Secret.md"),
        fixture.root.join("Linked.md"),
    )
    .expect("plant an escaping file symlink");
    let error = fixture
        .engine
        .resolve(&path("Linked.md"))
        .expect_err("a write through an escaping file symlink must be refused");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
}

#[test]
fn a_missing_parent_folder_is_never_created_implicitly() {
    let fixture = fixture();
    let error = fixture
        .engine
        .resolve(&path("Missing/New.md"))
        .expect_err("a write into a missing folder must be refused");
    assert!(
        matches!(error, MutationError::ParentNotFound { .. }),
        "expected parent_not_found, got {error:?}"
    );
    assert!(
        !fixture.root.join("Missing").exists(),
        "resolution must never create anything"
    );
}

#[test]
fn a_matching_revision_precondition_hands_back_the_current_bytes() {
    let fixture = fixture();
    let current = revision_of(b"# One\n");
    let bytes = fixture
        .engine
        .check(&path("One.md"), &Precondition::Revision(current))
        .expect("a matching revision satisfies the precondition")
        .expect("an existing file hands back its bytes");
    assert_eq!(bytes, b"# One\n");
}

#[test]
fn a_stale_revision_precondition_reports_the_revision_the_file_actually_holds() {
    let fixture = fixture();
    let error = fixture
        .engine
        .check(
            &path("One.md"),
            &Precondition::Revision("blake3:0000".into()),
        )
        .expect_err("a stale revision must be refused");
    match error {
        MutationError::RevisionConflict { current, .. } => {
            assert_eq!(current.as_deref(), Some(revision_of(b"# One\n").as_str()));
        }
        other => panic!("expected a revision conflict, got {other:?}"),
    }
}

#[test]
fn an_absent_precondition_against_an_existing_file_is_a_revision_conflict() {
    let fixture = fixture();
    let error = fixture
        .engine
        .check(&path("One.md"), &Precondition::Absent)
        .expect_err("expected-absent against an existing file must be refused");
    match error {
        MutationError::RevisionConflict { current, .. } => {
            assert_eq!(current.as_deref(), Some(revision_of(b"# One\n").as_str()));
        }
        other => panic!("expected a revision conflict, got {other:?}"),
    }
}

#[test]
fn a_revision_precondition_against_an_absent_file_is_not_found() {
    let fixture = fixture();
    let error = fixture
        .engine
        .check(&path("Gone.md"), &Precondition::Revision("blake3:0".into()))
        .expect_err("a revision precondition needs something to compare");
    assert!(
        matches!(error, MutationError::NotFound { .. }),
        "expected not_found, got {error:?}"
    );
}

#[test]
fn an_unconditional_precondition_accepts_both_presence_and_absence() {
    let fixture = fixture();
    assert_eq!(
        fixture
            .engine
            .check(&path("One.md"), &Precondition::Any)
            .expect("any accepts a present file"),
        Some(b"# One\n".to_vec())
    );
    assert_eq!(
        fixture
            .engine
            .check(&path("Gone.md"), &Precondition::Any)
            .expect("any accepts an absent file"),
        None
    );
}

#[test]
fn a_case_variant_of_an_absent_target_is_detected() {
    let fixture = fixture();
    assert_eq!(
        fixture
            .engine
            .case_variant(&path("one.md"))
            .expect("enumerate the parent directory"),
        Some("One.md".to_string()),
        "a case-insensitive filesystem would silently overwrite One.md"
    );
    assert_eq!(
        fixture
            .engine
            .case_variant(&path("One.md"))
            .expect("enumerate the parent directory"),
        None,
        "the exact spelling is not its own case variant"
    );
    assert_eq!(
        fixture
            .engine
            .case_variant(&path("Folder/Anything.md"))
            .expect("enumerate an empty directory"),
        None
    );
}

#[test]
fn a_revision_is_the_same_blake3_spelling_the_index_stores() {
    assert_eq!(
        revision_of(b"# One\n"),
        format!("blake3:{}", blake3::hash(b"# One\n"))
    );
}
```

- [ ] **Step 2: Run the focused test and observe the missing module**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_paths
```

Expected: compilation fails — `vault_index::MutationEngine`, `MutationError`, `Precondition`, and `revision_of` do not exist.

- [ ] **Step 3: Create `mutate.rs` with the error taxonomy and revisions**

Create `crates/vault-index/src/mutate.rs`:

```rust
//! The write path: the one place in `vaultd` that writes into the vault.
//!
//! Three invariants hold for every operation in this module:
//!
//! 1. **Containment.** A target is resolved by canonicalizing its parent
//!    directory (which resolves every symlink in it) and requiring the result
//!    to stay inside the canonical vault root. `VaultPath`'s constructor is
//!    string-level and rejects `..`, absolute paths, and backslashes; that is
//!    necessary and not sufficient, because a symlink is invisible to it.
//! 2. **Preconditions.** A content-bearing mutation compares the caller's
//!    expected revision against the bytes *on disk*, not against the index.
//!    The index can lag the filesystem by a debounce window, and a
//!    compare-and-swap validated against a lagging index would admit exactly
//!    the lost update it exists to prevent.
//! 3. **Atomicity per file.** Every write goes to a temporary file in the
//!    target's own directory, is flushed, and is renamed over the target. A
//!    crash leaves the old bytes or the new bytes, never a torn file.
//!
//! Nothing here knows about protocol types, the coordinator, or generations.

use std::path::{Path, PathBuf};

use vault_core::VaultPath;

/// The largest single raw payload a mutation accepts, in bytes.
///
/// 16 MiB, revised down from the design's 64 MiB draft: base64 over JSON
/// inflates by roughly a third, so 64 MiB of bytes is an ~85 MB single JSON
/// line, which strains a line-delimited reader for no measured benefit. This
/// covers every attachment class in the reference vault. Chunked transfer for
/// larger files is deferred follow-on, and the refusal names it.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// The configuration zone. Raw reads and writes are allowed here; every
/// semantic operation refuses, and nothing in it is ever indexed.
pub const CONFIG_ZONE: &str = ".obsidian";

/// The vault-local trash directory. A dot-directory, and therefore already
/// excluded from scanning and watching by the existing hidden-directory rule
/// in `FileSystemVaultSource::markdown_paths` — stated here rather than
/// assumed, because `trash_local` depends on it.
pub const LOCAL_TRASH: &str = ".trash";

/// The precondition a content-bearing mutation carries.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Precondition {
    /// The target must currently hold this revision.
    Revision(String),
    /// The target must not exist.
    Absent,
    /// Unconditional. Allowed, discouraged, and exists for append-style flows
    /// that genuinely do not care.
    Any,
}

/// Why a mutation was refused. Every variant means *nothing changed*.
#[derive(Clone, Debug, thiserror::Error, Eq, PartialEq)]
pub enum MutationError {
    #[error("{path} does not hold the expected revision")]
    RevisionConflict {
        path: VaultPath,
        /// The revision the target actually holds, or `None` when it does not
        /// exist. The caller's retry loop needs it, and re-reading to find it
        /// would race the next writer.
        current: Option<String>,
    },
    #[error("{path} does not exist")]
    NotFound { path: VaultPath },
    #[error("the parent folder of {path} does not exist")]
    ParentNotFound { path: VaultPath },
    #[error("{path} already exists")]
    TargetExists { path: VaultPath },
    #[error("{path} collides with the existing {existing} on a case-insensitive filesystem")]
    CaseCollision { path: VaultPath, existing: String },
    #[error("{path} is outside the vault, or is not a valid target for this operation")]
    ZoneViolation { path: VaultPath },
    #[error("{path} is not a Markdown note")]
    NotANote { path: VaultPath },
    /// The inverse of [`MutationError::NotANote`], and the reason it exists:
    /// `write_file` at a `.md` path outside the configuration zone is refused
    /// so raw writes can never bypass the generation model. `write_note`
    /// serves that path, publishes it, and gives the caller read-your-writes;
    /// a raw write would land bytes the caller then could not read back at any
    /// generation it was told about.
    #[error("{path} is a Markdown note; write it with write_note so it joins a generation")]
    IsANote { path: VaultPath },
    #[error("{path} is not empty; pass recursive to delete it anyway")]
    FolderNotEmpty { path: VaultPath },
    #[error("{expected:?} is not a valid precondition for this operation")]
    InvalidPrecondition { expected: Precondition },
    #[error(
        "{actual} bytes exceeds the {limit}-byte cap; chunked transfer for larger files is not implemented"
    )]
    TooLarge { limit: u64, actual: u64 },
    #[error("the daemon is running read-only")]
    ReadOnly,
    /// A frontmatter key path reached somewhere there is no value to address:
    /// it descended into a scalar, indexed a sequence with a non-numeric
    /// segment, or indexed one past its end.
    ///
    /// Narrow on purpose. The design's correction #9 supersedes the earlier,
    /// much broader reading of this variant: an edit *below* a stored span's
    /// granularity is **served** by re-serializing its enclosing top-level
    /// property, not refused. What is left here is the genuinely
    /// unrepresentable — `a.b` where `a` is the string `"x"` has no `b` to
    /// set, and inventing one would silently discard the caller's `a`.
    #[error("{key_path} does not address a value in this frontmatter")]
    UnaddressablePatch { key_path: String },
    #[error("two patch entries edit overlapping spans")]
    OverlappingPatch,
    /// The document opens a frontmatter fence it never closes. A patch that
    /// added a key would have to prepend a second fence, burying the first, so
    /// it refuses instead and the caller fixes the document.
    #[error("{path} opens a frontmatter block it never closes")]
    MalformedFrontmatter { path: VaultPath },
    #[error("filesystem failure: {message}")]
    Io { message: String },
}

/// The content revision of `bytes`, in the same `blake3:<hex>` spelling
/// `SourceDocument::new` stores — the full stored format, prefix included, so
/// a client can compare a `get_note` revision against a `write_note` one
/// without reformatting either.
pub fn revision_of(bytes: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(bytes))
}

fn io(error: std::io::Error) -> MutationError {
    MutationError::Io {
        message: error.to_string(),
    }
}

/// The one writer into the vault.
#[derive(Clone, Debug)]
pub struct MutationEngine {
    canonical_root: PathBuf,
    read_only: bool,
    max_file_bytes: u64,
}

impl MutationEngine {
    /// `canonical_root` must already be canonical — `IndexConfig`'s
    /// `canonical_vault_root` is, which is where every production caller
    /// gets it. A non-canonical root would make every containment check
    /// compare a resolved path against an unresolved prefix and refuse
    /// everything.
    pub fn new(canonical_root: impl AsRef<Path>) -> Self {
        Self {
            canonical_root: canonical_root.as_ref().to_path_buf(),
            read_only: false,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
        }
    }

    pub fn with_read_only(mut self, read_only: bool) -> Self {
        self.read_only = read_only;
        self
    }

    pub fn with_max_file_bytes(mut self, max_file_bytes: u64) -> Self {
        self.max_file_bytes = max_file_bytes;
        self
    }

    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn max_file_bytes(&self) -> u64 {
        self.max_file_bytes
    }

    /// Resolve `path` to an absolute filesystem location that provably stays
    /// inside the vault.
    ///
    /// The parent is canonicalized, so every symlink on the way to the target
    /// is resolved before the containment check; the final component is then
    /// appended unresolved, because a mutation target need not exist yet.
    /// When the final component *does* exist and is itself a symlink, its own
    /// canonical target is checked too — a link planted at the target name
    /// must not become an out-of-vault write.
    pub fn resolve(&self, path: &VaultPath) -> Result<PathBuf, MutationError> {
        let absolute = self.canonical_root.join(path.as_str());
        let parent = absolute
            .parent()
            .ok_or_else(|| MutationError::ZoneViolation { path: path.clone() })?;
        let canonical_parent = match parent.canonicalize() {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(MutationError::ParentNotFound { path: path.clone() });
            }
            Err(error) => return Err(io(error)),
        };
        if !canonical_parent.starts_with(&self.canonical_root) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        let name = absolute
            .file_name()
            .ok_or_else(|| MutationError::ZoneViolation { path: path.clone() })?;
        let resolved = canonical_parent.join(name);
        match resolved.canonicalize() {
            Ok(canonical) => {
                if canonical.starts_with(&self.canonical_root) {
                    Ok(resolved)
                } else {
                    Err(MutationError::ZoneViolation { path: path.clone() })
                }
            }
            // The target does not exist yet, or is a link whose own target
            // does not exist. Either way the parent check above is what
            // bounds it, and nothing has been written.
            Err(_) => Ok(resolved),
        }
    }

    /// `path`'s current on-disk revision, or `None` when it does not exist.
    pub fn current_revision(&self, path: &VaultPath) -> Result<Option<String>, MutationError> {
        let resolved = self.resolve(path)?;
        match std::fs::read(&resolved) {
            Ok(bytes) => Ok(Some(revision_of(&bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io(error)),
        }
    }

    /// Evaluate `expected` against what is on disk right now, handing back
    /// the target's current bytes when it exists. Reading the bytes rather
    /// than only hashing them is deliberate: `patch_frontmatter` and
    /// `copy_file` need them anyway, and re-reading after the check would
    /// open a window between the comparison and the use.
    pub fn check(
        &self,
        path: &VaultPath,
        expected: &Precondition,
    ) -> Result<Option<Vec<u8>>, MutationError> {
        let resolved = self.resolve(path)?;
        let current = match std::fs::read(&resolved) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io(error)),
        };
        match (expected, &current) {
            (Precondition::Any, _) => Ok(current),
            (Precondition::Absent, None) => Ok(None),
            (Precondition::Absent, Some(bytes)) => Err(MutationError::RevisionConflict {
                path: path.clone(),
                current: Some(revision_of(bytes)),
            }),
            (Precondition::Revision(_), None) => Err(MutationError::NotFound { path: path.clone() }),
            (Precondition::Revision(wanted), Some(bytes)) => {
                let actual = revision_of(bytes);
                if &actual == wanted {
                    Ok(current)
                } else {
                    Err(MutationError::RevisionConflict {
                        path: path.clone(),
                        current: Some(actual),
                    })
                }
            }
        }
    }

    /// The existing entry whose name differs from `path`'s only by case, if
    /// there is one. APFS is case-insensitive by default, so creating
    /// `one.md` beside an existing `One.md` silently overwrites it; the
    /// callers refuse instead. Stricter than Obsidian, which mishandles this
    /// — data safety wins over bug-compatibility.
    pub fn case_variant(&self, path: &VaultPath) -> Result<Option<String>, MutationError> {
        let resolved = self.resolve(path)?;
        let Some(parent) = resolved.parent() else {
            return Ok(None);
        };
        let Some(name) = resolved.file_name().and_then(|name| name.to_str()) else {
            return Ok(None);
        };
        let wanted = name.to_lowercase();
        for entry in std::fs::read_dir(parent).map_err(io)? {
            let entry = entry.map_err(io)?;
            let existing = entry.file_name().to_string_lossy().into_owned();
            if existing != name && existing.to_lowercase() == wanted {
                return Ok(Some(existing));
            }
        }
        Ok(None)
    }
}
```

- [ ] **Step 4: Export the engine and fold its error into `IndexError`**

In `crates/vault-index/src/lib.rs`, add `mod mutate;` to the module list and this re-export beside the others:

```rust
pub use mutate::{
    CONFIG_ZONE, DEFAULT_MAX_FILE_BYTES, LOCAL_TRASH, MutationEngine, MutationError, Precondition,
    revision_of,
};
```

In `crates/vault-index/src/error.rs`, add to `IndexError`:

```rust
    /// A mutation was refused by its own preconditions, by path validation,
    /// or by a zone rule. Never damage, and never retryable by this process:
    /// the caller's model of the vault was wrong and should hear so.
    #[error("mutation refused: {0}")]
    Mutation(#[from] crate::mutate::MutationError),
```

- [ ] **Step 5: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_paths
```

Expected: all 11 tests pass. If `a_symlinked_file_that_escapes_the_vault_is_refused` fails, the final-component re-check in `resolve` is missing.

- [ ] **Step 6: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/mutate.rs crates/vault-index/src/lib.rs \
        crates/vault-index/src/error.rs crates/vault-index/tests/mutation_paths.rs
git commit -m "feat(index): add mutation path containment and preconditions"
```

---

### Task 5: `write_note` — atomic create and replace

**Files:**

- Modify: `crates/vault-index/src/mutate.rs`
- Modify: `crates/vault-index/src/lib.rs` (re-exports)
- Create: `crates/vault-index/tests/mutation_write.rs`

**Interfaces:**

- Consumes: `MutationEngine::{resolve, check, case_variant}`, `Precondition`, `MutationError`, `revision_of` (Task 4).
- Produces: `pub enum Mutation { WriteNote { path: VaultPath, content: String, expected: Precondition } }` — later tasks add variants.
- Produces: `pub struct MutationOutcome { pub changed_paths: BTreeSet<VaultPath>, pub revision: Option<String>, pub links_rewritten: u64, pub link_rewrite_failures: Vec<LinkRewriteFailure>, pub semantic: bool }`.
- Produces: `pub struct LinkRewriteFailure { pub path: VaultPath, pub reason: String }`.
- Produces: `MutationEngine::apply(&self, mutation: &Mutation) -> Result<MutationOutcome, MutationError>`.
- Produces: `pub(crate) fn write_atomically(target: &Path, bytes: &[u8]) -> Result<(), MutationError>`.
- Produces: `pub fn in_config_zone(path: &VaultPath) -> bool`.
- Task 9 calls `apply` from the coordinator; Tasks 6–8 and 12 extend `Mutation`.

- [ ] **Step 1: Write the failing `write_note` test**

Create `crates/vault-index/tests/mutation_write.rs`:

```rust
//! `write_note`: create or replace a UTF-8 note, atomically, under a
//! compare-and-swap.

use std::collections::BTreeSet;
use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{Mutation, MutationEngine, MutationError, Precondition, revision_of};

struct Fixture {
    engine: MutationEngine,
    root: PathBuf,
    _vault: TempDir,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder")).expect("create Folder");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    Fixture {
        engine: MutationEngine::new(&root),
        root,
        _vault: vault,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

fn names_in(directory: &std::path::Path) -> BTreeSet<String> {
    std::fs::read_dir(directory)
        .expect("read directory")
        .map(|entry| {
            entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

#[test]
fn creating_a_note_writes_exactly_the_bytes_given() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/New.md"),
            content: "# New\n\nbody\n".into(),
            expected: Precondition::Absent,
        })
        .expect("create a new note");

    assert_eq!(
        std::fs::read(fixture.root.join("Folder/New.md")).expect("read back"),
        b"# New\n\nbody\n"
    );
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(b"# New\n\nbody\n").as_str())
    );
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Folder/New.md")])
    );
    assert!(outcome.semantic, "a Markdown note is semantic");
}

#[test]
fn replacing_a_note_under_its_current_revision_succeeds() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("One.md"),
            content: "# One changed\n".into(),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect("replace under a matching revision");
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# One changed\n"
    );
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(b"# One changed\n").as_str())
    );
}

#[test]
fn a_stale_revision_changes_nothing_at_all() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("One.md"),
            content: "# clobbered\n".into(),
            expected: Precondition::Revision("blake3:0000".into()),
        })
        .expect_err("a stale revision must lose");
    match error {
        MutationError::RevisionConflict { current, .. } => {
            assert_eq!(current.as_deref(), Some(revision_of(b"# One\n").as_str()));
        }
        other => panic!("expected a revision conflict, got {other:?}"),
    }
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# One\n",
        "a refused write must leave the file byte-identical"
    );
}

#[test]
fn creating_where_a_note_already_exists_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("One.md"),
            content: "# clobbered\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("expected-absent against an existing note must lose");
    assert!(
        matches!(error, MutationError::RevisionConflict { .. }),
        "expected a revision conflict, got {error:?}"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# One\n"
    );
}

#[test]
fn a_write_into_a_missing_folder_creates_nothing() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Missing/New.md"),
            content: "# New\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("parent folders are never created implicitly");
    assert!(
        matches!(error, MutationError::ParentNotFound { .. }),
        "expected parent_not_found, got {error:?}"
    );
    assert!(!fixture.root.join("Missing").exists());
}

#[test]
fn creating_a_case_variant_of_an_existing_note_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("one.md"),
            content: "# lowercase\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("a case variant would silently overwrite on APFS");
    match error {
        MutationError::CaseCollision { existing, .. } => assert_eq!(existing, "One.md"),
        other => panic!("expected a case collision, got {other:?}"),
    }
    assert_eq!(
        std::fs::read(fixture.root.join("One.md")).expect("read back"),
        b"# One\n"
    );
}

#[test]
fn a_non_markdown_path_is_not_a_note() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/notes.txt"),
            content: "plain\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("write_note writes notes; write_file writes everything else");
    assert!(
        matches!(error, MutationError::NotANote { .. }),
        "expected not_a_note, got {error:?}"
    );
}

#[test]
fn the_configuration_zone_refuses_every_semantic_operation() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    let error = fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path(".obsidian/app.md"),
            content: "# nope\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("nothing in the zone is ever indexed");
    assert!(
        matches!(error, MutationError::ZoneViolation { .. }),
        "expected a zone violation, got {error:?}"
    );
}

#[test]
fn a_write_leaves_no_temporary_file_behind() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/New.md"),
            content: "# New\n".into(),
            expected: Precondition::Absent,
        })
        .expect("create a new note");
    assert_eq!(
        names_in(&fixture.root.join("Folder")),
        BTreeSet::from(["New.md".to_string()]),
        "the temp file must be renamed away, not left in the vault"
    );
}

#[test]
fn a_read_only_engine_refuses_before_it_touches_anything() {
    let fixture = fixture();
    let engine = MutationEngine::new(&fixture.root).with_read_only(true);
    let error = engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/New.md"),
            content: "# New\n".into(),
            expected: Precondition::Absent,
        })
        .expect_err("a read-only daemon writes nothing");
    assert_eq!(error, MutationError::ReadOnly);
    assert!(!fixture.root.join("Folder/New.md").exists());
}

#[test]
fn a_payload_past_the_cap_is_refused_whole() {
    let fixture = fixture();
    let engine = MutationEngine::new(&fixture.root).with_max_file_bytes(16);
    let error = engine
        .apply(&Mutation::WriteNote {
            path: path("Folder/Big.md"),
            content: "x".repeat(17),
            expected: Precondition::Absent,
        })
        .expect_err("the cap is enforced before anything is written");
    match error {
        MutationError::TooLarge { limit, actual } => {
            assert_eq!(limit, 16);
            assert_eq!(actual, 17);
        }
        other => panic!("expected too_large, got {other:?}"),
    }
    assert!(!fixture.root.join("Folder/Big.md").exists());
}
```

- [ ] **Step 2: Run the focused test and observe the missing operation type**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_write
```

Expected: compilation fails — `vault_index::Mutation` and `MutationEngine::apply` do not exist.

- [ ] **Step 3: Add the operation, outcome, and atomic write**

Append to `crates/vault-index/src/mutate.rs`:

```rust
use std::collections::BTreeSet;
use std::io::Write as _;

/// One mutation, as the coordinator receives it. Later variants are added by
/// their own tasks; every variant is a single-file operation except the
/// folder ones and rename-with-repair, which are still one coordinator
/// command and one generation.
#[derive(Clone, Debug)]
pub enum Mutation {
    WriteNote {
        path: VaultPath,
        content: String,
        expected: Precondition,
    },
}

/// One referencing note a rename could not rewrite, and why. Populated only
/// by rename link repair; every other mutation leaves it empty.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkRewriteFailure {
    pub path: VaultPath,
    pub reason: String,
}

/// What one applied mutation did on disk. `changed_paths` is what the
/// coordinator hands to `refresh_paths`, and must name **every** path whose
/// state moved — over-naming is free, under-naming is a missing generation.
#[derive(Clone, Debug, Default)]
pub struct MutationOutcome {
    pub changed_paths: BTreeSet<VaultPath>,
    /// The revision written, for the operations that write content. `None`
    /// for folder operations and deletes: a deleted file has no revision.
    pub revision: Option<String>,
    pub links_rewritten: u64,
    pub link_rewrite_failures: Vec<LinkRewriteFailure>,
    /// Whether this mutation **changed anything the semantic layer indexes**.
    ///
    /// This is the one meaning the field has anywhere in the codebase, and it
    /// is a *derived* fact rather than an independent flag: the invariant
    /// every constructor below upholds is
    ///
    /// ```text
    /// semantic == !changed_paths.is_empty()
    /// ```
    ///
    /// because `changed_paths` names exactly the Markdown paths whose indexed
    /// state moved. Read off per operation, that gives:
    ///
    /// | operation | `semantic` |
    /// | --- | --- |
    /// | `write_note` | `true` — the target is a note by construction |
    /// | `create_folder` | `false` — a folder holds no indexed rows |
    /// | `delete_note` of a note | `true` |
    /// | `delete_note` of an attachment | `false` |
    /// | `delete_folder` | `true` iff it removed at least one note |
    /// | `copy_file` | `true` iff the **destination** is Markdown |
    /// | `rename_note` / `rename_folder` | `true` iff any Markdown path moved |
    /// | `patch_frontmatter` | `true` unless the patch was byte-identical |
    /// | `write_file` | **always `false`** — the zone is not indexed, an
    ///   attachment is not indexed, and a `.md` path is refused with
    ///   [`MutationError::IsANote`] rather than written raw |
    ///
    /// It is deliberately **not** the same question as "does this write live
    /// inside the indexed vault", which is what the wire's
    /// `WriteFileResponse::semantic` answers. That one is `!in_config_zone`,
    /// the server computes it from the path, and conflating the two is what
    /// made an attachment write claim to be semantic in the first draft.
    pub semantic: bool,
}

/// Whether `path` is inside the configuration zone, which every semantic
/// operation refuses and only the raw pair may touch.
pub fn in_config_zone(path: &VaultPath) -> bool {
    let text = path.as_str();
    text == CONFIG_ZONE
        || text
            .strip_prefix(CONFIG_ZONE)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn is_markdown(path: &VaultPath) -> bool {
    Path::new(path.as_str())
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

/// Write `bytes` to `target` atomically: a temporary file in the target's own
/// directory (so the rename is same-filesystem and therefore atomic),
/// flushed to disk, then renamed over the target.
///
/// The temporary name is `.vaultd-*` with **no** extension, deliberately:
/// `FileSystemVaultSource::markdown_paths` only enumerates `*.md`, so the
/// temporary is never mistaken for a note even in the microseconds it exists,
/// and never produces a spurious create-then-delete generation pair.
pub(crate) fn write_atomically(target: &Path, bytes: &[u8]) -> Result<(), MutationError> {
    let directory = target.parent().ok_or_else(|| MutationError::Io {
        message: format!("{} has no parent directory", target.display()),
    })?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".vaultd-")
        .tempfile_in(directory)
        .map_err(io)?;
    temporary.write_all(bytes).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary.persist(target).map_err(|error| MutationError::Io {
        message: error.error.to_string(),
    })?;
    Ok(())
}

impl MutationEngine {
    /// Apply one mutation. Every refusal happens before anything is written,
    /// so an `Err` means the vault is byte-identical to what it was.
    pub fn apply(&self, mutation: &Mutation) -> Result<MutationOutcome, MutationError> {
        if self.read_only {
            return Err(MutationError::ReadOnly);
        }
        match mutation {
            Mutation::WriteNote {
                path,
                content,
                expected,
            } => self.write_note(path, content, expected),
        }
    }

    fn write_note(
        &self,
        path: &VaultPath,
        content: &str,
        expected: &Precondition,
    ) -> Result<MutationOutcome, MutationError> {
        if in_config_zone(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        if !is_markdown(path) {
            return Err(MutationError::NotANote { path: path.clone() });
        }
        let bytes = content.as_bytes();
        // Invalid UTF-8 is structurally impossible here: `content` arrived as
        // a JSON string and is a `&str`. Asserted by the type, not validated.
        let actual = bytes.len() as u64;
        if actual > self.max_file_bytes {
            return Err(MutationError::TooLarge {
                limit: self.max_file_bytes,
                actual,
            });
        }
        let resolved = self.resolve(path)?;
        let current = self.check(path, expected)?;
        if current.is_none() {
            if let Some(existing) = self.case_variant(path)? {
                return Err(MutationError::CaseCollision {
                    path: path.clone(),
                    existing,
                });
            }
        }
        write_atomically(&resolved, bytes)?;
        Ok(MutationOutcome {
            changed_paths: BTreeSet::from([path.clone()]),
            revision: Some(revision_of(bytes)),
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic: true,
        })
    }
}
```

In `crates/vault-index/src/lib.rs`, extend the `mutate` re-export with `LinkRewriteFailure, Mutation, MutationOutcome, in_config_zone`.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_write
```

Expected: all 11 tests pass.

- [ ] **Step 5: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/mutate.rs crates/vault-index/src/lib.rs \
        crates/vault-index/tests/mutation_write.rs
git commit -m "feat(index): write notes atomically under a content-revision cas"
```

---

### Task 6: Folder operations and the three delete modes

**Files:**

- Modify: `Cargo.toml` (workspace dependencies), `crates/vault-index/Cargo.toml`
- Modify: `Cargo.lock` (resolver output only)
- Modify: `crates/vault-index/src/mutate.rs`
- Create: `crates/vault-index/tests/mutation_folders.rs`

**Interfaces:**

- Consumes: `MutationEngine::{resolve, check, case_variant, apply}`, `MutationOutcome`, `MutationError`, `LOCAL_TRASH` (Tasks 4–5).
- Produces: `Mutation::{CreateFolder, DeleteNote, DeleteFolder}` variants.
- Produces: `pub enum DeleteMode { TrashSystem, TrashLocal, Permanent }`.
- Produces: `MutationEngine::configured_delete_mode(&self) -> DeleteMode` — reads `.obsidian/app.json`'s `trashOption`.
- Produces: `pub(crate) fn markdown_paths_under(root: &Path, folder: &VaultPath) -> Result<Vec<VaultPath>, MutationError>`.
- Task 9 maps `DeleteMode` from the protocol's `DeleteModeDto`.

- [ ] **Step 1: Add the system-trash and directory-walk dependencies**

Add to the workspace `[workspace.dependencies]` in `Cargo.toml`:

```toml
trash = "5.2"
```

`walkdir` is **already** in `[workspace.dependencies]` at version `2.5`, but only `vault-core` names it; `vault-index` does not. `markdown_paths_under` in Step 4 needs it, so add both to `crates/vault-index/Cargo.toml`'s `[dependencies]`:

```toml
trash.workspace = true
walkdir.workspace = true
```

This is the only task in the phase that adds a `vault-index` dependency: Task 13's session registry reads `tree_entries` out of SQLite and walks nothing, so no later task needs `walkdir` again.

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check -p vault-index
```

Expected: the check passes under the MSRV. If `trash 5.2` does not build on Rust 1.85, pin the newest version that does (`cargo add trash@<version> -p vault-index`) and re-run — the API used below (`trash::delete`) is stable across the 3.x–5.x line.

- [ ] **Step 2: Write the failing folder and delete test**

Create `crates/vault-index/tests/mutation_folders.rs`:

```rust
//! Folder operations and the three delete dispositions.

use std::collections::BTreeSet;
use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{DeleteMode, Mutation, MutationEngine, MutationError, Precondition, revision_of};

struct Fixture {
    engine: MutationEngine,
    root: PathBuf,
    _vault: TempDir,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder/Deep")).expect("create Folder/Deep");
    std::fs::create_dir_all(root.join("Empty")).expect("create Empty");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    std::fs::write(root.join("Folder/Two.md"), "# Two\n").expect("write Two");
    std::fs::write(root.join("Folder/Deep/Three.md"), "# Three\n").expect("write Three");
    Fixture {
        engine: MutationEngine::new(&root),
        root,
        _vault: vault,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

#[test]
fn creating_a_folder_chain_creates_every_missing_segment() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("A/B/C"),
        })
        .expect("mkdir -p semantics");
    assert!(fixture.root.join("A/B/C").is_dir());
}

#[test]
fn creating_a_folder_that_already_exists_succeeds_idempotently() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("Empty"),
        })
        .expect("an existing folder is success, not a conflict");
}

#[test]
fn creating_a_folder_where_a_file_sits_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CreateFolder {
            path: path("One.md"),
        })
        .expect_err("a file occupies the name");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
}

#[test]
fn a_permanent_delete_removes_the_file_and_names_it_as_changed() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("One.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect("delete under a matching revision");
    assert!(!fixture.root.join("One.md").exists());
    assert_eq!(outcome.changed_paths, BTreeSet::from([path("One.md")]));
    assert_eq!(
        outcome.revision, None,
        "a deleted file has no revision to report"
    );
}

#[test]
fn a_local_trash_delete_moves_the_file_into_the_vaults_own_trash() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Folder/Two.md"),
            mode: Some(DeleteMode::TrashLocal),
            expected: Precondition::Any,
        })
        .expect("delete into the local trash");
    assert!(!fixture.root.join("Folder/Two.md").exists());
    assert_eq!(
        std::fs::read(fixture.root.join(".trash/Two.md")).expect("read the trashed file"),
        b"# Two\n"
    );

    // `trash_local` is only safe because `.trash` is a dot-directory and the
    // scanner's hidden-directory rule skips it. Asserted rather than assumed:
    // if that rule ever changed, every locally-trashed note would reappear as
    // a live note at a new path, and this is where that shows up.
    let source = vault_core::FileSystemVaultSource::new(&fixture.root).expect("scan source");
    let scanned = vault_core::scan_vault(&source).expect("scan the vault");
    let paths: Vec<String> = scanned
        .graph
        .note_paths()
        .into_iter()
        .map(|path| path.as_str().to_string())
        .collect();
    assert!(
        paths.iter().all(|path| !path.starts_with(".trash/")),
        "the local trash must be invisible to the scanner: {paths:?}"
    );
}

#[test]
fn a_second_local_trash_delete_of_the_same_name_is_numbered_rather_than_clobbered() {
    let fixture = fixture();
    fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Folder/Two.md"),
            mode: Some(DeleteMode::TrashLocal),
            expected: Precondition::Any,
        })
        .expect("first delete");
    std::fs::write(fixture.root.join("Folder/Two.md"), "# Two again\n").expect("recreate Two");
    fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Folder/Two.md"),
            mode: Some(DeleteMode::TrashLocal),
            expected: Precondition::Any,
        })
        .expect("second delete");
    assert_eq!(
        std::fs::read(fixture.root.join(".trash/Two.md")).expect("first trashed file"),
        b"# Two\n"
    );
    assert_eq!(
        std::fs::read(fixture.root.join(".trash/Two 1.md")).expect("second trashed file"),
        b"# Two again\n"
    );
}

#[test]
fn deleting_an_absent_note_is_never_a_silent_success() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("Gone.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect_err("deletion is never idempotent-silent");
    assert!(
        matches!(error, MutationError::NotFound { .. }),
        "expected not_found, got {error:?}"
    );
}

#[test]
fn an_absent_precondition_is_meaningless_for_a_delete() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("One.md"),
            mode: Some(DeleteMode::Permanent),
            expected: Precondition::Absent,
        })
        .expect_err("expected-absent cannot guard a delete");
    assert!(
        matches!(error, MutationError::InvalidPrecondition { .. }),
        "expected invalid_precondition, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
}

#[test]
fn deleting_a_non_empty_folder_without_recursive_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("Folder"),
            mode: Some(DeleteMode::Permanent),
            recursive: false,
        })
        .expect_err("a non-empty folder needs recursive");
    assert!(
        matches!(error, MutationError::FolderNotEmpty { .. }),
        "expected folder_not_empty, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Two.md").is_file());
}

#[test]
fn a_recursive_folder_delete_names_every_note_it_removed() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("Folder"),
            mode: Some(DeleteMode::Permanent),
            recursive: true,
        })
        .expect("recursive delete");
    assert!(!fixture.root.join("Folder").exists());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Folder/Two.md"), path("Folder/Deep/Three.md")]),
        "every removed note must reach reconciliation, or its rows survive it"
    );
}

#[test]
fn an_empty_folder_delete_needs_no_recursive_flag() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::DeleteFolder {
            path: path("Empty"),
            mode: Some(DeleteMode::Permanent),
            recursive: false,
        })
        .expect("an empty folder deletes without ceremony");
    assert!(!fixture.root.join("Empty").exists());
    assert!(outcome.changed_paths.is_empty());
    assert!(
        !outcome.semantic,
        "no note was removed, so nothing the semantic layer indexes moved"
    );
}

#[test]
fn the_default_delete_mode_comes_from_the_vaults_own_app_json() {
    let fixture = fixture();
    assert_eq!(
        fixture.engine.configured_delete_mode(),
        DeleteMode::TrashSystem,
        "Obsidian's own default is the system trash"
    );

    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    std::fs::write(
        fixture.root.join(".obsidian/app.json"),
        r#"{"trashOption":"local","alwaysUpdateLinks":true}"#,
    )
    .expect("write app.json");
    assert_eq!(fixture.engine.configured_delete_mode(), DeleteMode::TrashLocal);

    std::fs::write(
        fixture.root.join(".obsidian/app.json"),
        r#"{"trashOption":"none"}"#,
    )
    .expect("rewrite app.json");
    assert_eq!(fixture.engine.configured_delete_mode(), DeleteMode::Permanent);

    std::fs::write(fixture.root.join(".obsidian/app.json"), "not json at all")
        .expect("corrupt app.json");
    assert_eq!(
        fixture.engine.configured_delete_mode(),
        DeleteMode::TrashSystem,
        "an unreadable app.json must fall back, never fail a delete"
    );
}

#[test]
fn omitting_the_mode_uses_the_configured_default() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    std::fs::write(
        fixture.root.join(".obsidian/app.json"),
        r#"{"trashOption":"local"}"#,
    )
    .expect("write app.json");
    fixture
        .engine
        .apply(&Mutation::DeleteNote {
            path: path("One.md"),
            mode: None,
            expected: Precondition::Any,
        })
        .expect("delete with the configured default");
    assert!(fixture.root.join(".trash/One.md").is_file());
}
```

- [ ] **Step 3: Run the focused test and observe the missing variants**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_folders
```

Expected: compilation fails — `Mutation::CreateFolder`, `Mutation::DeleteNote`, `Mutation::DeleteFolder`, and `DeleteMode` do not exist.

- [ ] **Step 4: Implement the folder operations and delete dispositions**

In `crates/vault-index/src/mutate.rs`, add the variants to `Mutation`:

```rust
    CreateFolder {
        path: VaultPath,
    },
    DeleteNote {
        path: VaultPath,
        /// `None` takes the vault's own `trashOption` default. A plugin shim
        /// always passes the plugin's explicit choice; only a direct client
        /// leaves this open.
        mode: Option<DeleteMode>,
        expected: Precondition,
    },
    DeleteFolder {
        path: VaultPath,
        mode: Option<DeleteMode>,
        recursive: bool,
    },
```

and the mode:

```rust
/// How a delete disposes of its target.
///
/// Obsidian's API is `vault.trash(file, system: boolean)` and the plugin
/// chooses per call; `trashOption` governs Obsidian's own UI deletions only.
/// So a shim maps `trash(f, true)` to `TrashSystem`, `trash(f, false)` to
/// `TrashLocal`, and `delete(f)` to `Permanent`, consulting no config at all.
/// The `trashOption` default below applies only when a client deletes with no
/// plugin involved.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeleteMode {
    TrashSystem,
    TrashLocal,
    Permanent,
}

#[derive(serde::Deserialize)]
struct AppJson {
    #[serde(rename = "trashOption")]
    trash_option: Option<String>,
}
```

Add the arms to `apply`:

```rust
            Mutation::CreateFolder { path } => self.create_folder(path),
            Mutation::DeleteNote {
                path,
                mode,
                expected,
            } => self.delete_note(path, *mode, expected),
            Mutation::DeleteFolder {
                path,
                mode,
                recursive,
            } => self.delete_folder(path, *mode, *recursive),
```

and the implementations:

```rust
impl MutationEngine {
    /// The vault's own configured disposition for a delete a client did not
    /// qualify. Any failure to read or parse `app.json` falls back to the
    /// system trash, which is Obsidian's own default: a delete must never
    /// fail because a configuration file is unreadable, and the safest
    /// fallback is the recoverable one.
    pub fn configured_delete_mode(&self) -> DeleteMode {
        let path = self.canonical_root.join(CONFIG_ZONE).join("app.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return DeleteMode::TrashSystem;
        };
        let Ok(parsed) = serde_json::from_str::<AppJson>(&text) else {
            return DeleteMode::TrashSystem;
        };
        match parsed.trash_option.as_deref() {
            Some("local") => DeleteMode::TrashLocal,
            Some("none") => DeleteMode::Permanent,
            _ => DeleteMode::TrashSystem,
        }
    }

    fn create_folder(&self, path: &VaultPath) -> Result<MutationOutcome, MutationError> {
        if in_config_zone(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        // `resolve` requires an existing parent, which a folder chain need
        // not have. Walk the segments instead, checking containment at every
        // level that already exists, and creating the rest.
        let mut current = self.canonical_root.clone();
        for segment in path.as_str().split('/') {
            current = current.join(segment);
            match current.canonicalize() {
                Ok(canonical) => {
                    if !canonical.starts_with(&self.canonical_root) {
                        return Err(MutationError::ZoneViolation { path: path.clone() });
                    }
                    if canonical.is_file() {
                        return Err(MutationError::TargetExists { path: path.clone() });
                    }
                    current = canonical;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&current).map_err(io)?;
                }
                Err(error) => return Err(io(error)),
            }
        }
        Ok(MutationOutcome::default())
    }

    fn delete_note(
        &self,
        path: &VaultPath,
        mode: Option<DeleteMode>,
        expected: &Precondition,
    ) -> Result<MutationOutcome, MutationError> {
        if in_config_zone(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        if expected == &Precondition::Absent {
            return Err(MutationError::InvalidPrecondition {
                expected: expected.clone(),
            });
        }
        let resolved = self.resolve(path)?;
        // Deletion is never idempotent-silent: a caller deleting something
        // that is already gone had a wrong model of the vault and should
        // hear so.
        if self.check(path, expected)?.is_none() {
            return Err(MutationError::NotFound { path: path.clone() });
        }
        self.dispose(&resolved, mode.unwrap_or_else(|| self.configured_delete_mode()))?;
        Ok(MutationOutcome {
            changed_paths: BTreeSet::from([path.clone()]),
            revision: None,
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic: is_markdown(path),
        })
    }

    fn delete_folder(
        &self,
        path: &VaultPath,
        mode: Option<DeleteMode>,
        recursive: bool,
    ) -> Result<MutationOutcome, MutationError> {
        if in_config_zone(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        let resolved = self.resolve(path)?;
        if !resolved.is_dir() {
            return Err(MutationError::NotFound { path: path.clone() });
        }
        let empty = std::fs::read_dir(&resolved).map_err(io)?.next().is_none();
        if !empty && !recursive {
            return Err(MutationError::FolderNotEmpty { path: path.clone() });
        }
        // Enumerated *before* the delete: every note that disappears has to
        // reach reconciliation, or its rows outlive the file.
        let removed = markdown_paths_under(&self.canonical_root, path)?;
        self.dispose(&resolved, mode.unwrap_or_else(|| self.configured_delete_mode()))?;
        let changed_paths: BTreeSet<VaultPath> = removed.into_iter().collect();
        Ok(MutationOutcome {
            // `semantic == !changed_paths.is_empty()`, per the invariant on
            // `MutationOutcome`: a folder of attachments removes no indexed
            // row, and claiming otherwise would make an empty reconciliation
            // batch look like a missing generation.
            semantic: !changed_paths.is_empty(),
            changed_paths,
            revision: None,
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
        })
    }

    /// Dispose of one already-resolved path. `TrashLocal` moves it into the
    /// vault's own `.trash/`, numbering the name on collision the way
    /// Obsidian does; `TrashSystem` hands it to the platform trash;
    /// `Permanent` unlinks it.
    fn dispose(&self, resolved: &Path, mode: DeleteMode) -> Result<(), MutationError> {
        match mode {
            DeleteMode::Permanent => {
                if resolved.is_dir() {
                    std::fs::remove_dir_all(resolved).map_err(io)
                } else {
                    std::fs::remove_file(resolved).map_err(io)
                }
            }
            DeleteMode::TrashSystem => trash::delete(resolved).map_err(|error| MutationError::Io {
                message: error.to_string(),
            }),
            DeleteMode::TrashLocal => {
                let trash = self.canonical_root.join(LOCAL_TRASH);
                std::fs::create_dir_all(&trash).map_err(io)?;
                let name = resolved
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| MutationError::Io {
                        message: format!("{} has no usable file name", resolved.display()),
                    })?;
                let (stem, extension) = match name.rsplit_once('.') {
                    Some((stem, extension)) => (stem, format!(".{extension}")),
                    None => (name, String::new()),
                };
                let mut candidate = trash.join(name);
                let mut suffix = 1u32;
                while candidate.exists() {
                    candidate = trash.join(format!("{stem} {suffix}{extension}"));
                    suffix += 1;
                }
                std::fs::rename(resolved, &candidate).map_err(io)
            }
        }
    }
}

/// Every Markdown path under `folder`, vault-relative. Mirrors the scanner's
/// hidden-directory rule so a folder delete names exactly the notes the index
/// knows about.
pub(crate) fn markdown_paths_under(
    root: &Path,
    folder: &VaultPath,
) -> Result<Vec<VaultPath>, MutationError> {
    let mut found = Vec::new();
    let base = root.join(folder.as_str());
    let walker = walkdir::WalkDir::new(&base)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 || !entry.file_type().is_dir() {
                return true;
            }
            !entry.file_name().to_string_lossy().starts_with('.')
        });
    for entry in walker {
        let entry = entry.map_err(|error| MutationError::Io {
            message: error.to_string(),
        })?;
        if !entry.file_type().is_file() {
            continue;
        }
        let is_markdown_file = entry
            .path()
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
        if !is_markdown_file {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let mut parts = Vec::new();
        for component in relative.components() {
            match component.as_os_str().to_str() {
                Some(text) => parts.push(text.to_string()),
                None => break,
            }
        }
        if let Ok(path) = VaultPath::new(parts.join("/")) {
            found.push(path);
        }
    }
    Ok(found)
}
```

In `crates/vault-index/src/lib.rs`, add `DeleteMode` to the `mutate` re-export.

- [ ] **Step 5: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_folders
```

Expected: all 13 tests pass. `a_local_trash_delete_moves_the_file_into_the_vaults_own_trash` carries the `.trash`-invisibility claim itself, by scanning the vault and asserting no `.trash/` path comes back — the claim is about `FileSystemVaultSource`'s hidden-directory rule, so it is checked against that scanner rather than inferred from `markdown_paths_under` mirroring it.

- [ ] **Step 6: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add Cargo.toml Cargo.lock crates/vault-index/Cargo.toml \
        crates/vault-index/src/mutate.rs crates/vault-index/src/lib.rs \
        crates/vault-index/tests/mutation_folders.rs
git commit -m "feat(index): add folder operations and the three delete modes"
```

---

### Task 7: `copy_file`, and the file movement half of rename

Link repair is Task 12. This task moves bytes and refuses the cases that must never silently overwrite.

**Files:**

- Modify: `crates/vault-index/src/mutate.rs`
- Create: `crates/vault-index/tests/mutation_copy_rename.rs`

**Interfaces:**

- Consumes: `MutationEngine::{resolve, check, case_variant}`, `write_atomically`, `markdown_paths_under`, `is_markdown` (Tasks 4–6).
- Produces: `Mutation::{CopyFile, RenameNote, RenameFolder}` variants and `pub enum CopyConflict { Error, Suffix }`.
- Produces: `MutationEngine::rename_paths(&self, from: &VaultPath, to: &VaultPath) -> Result<BTreeSet<VaultPath>, MutationError>` — the movement primitive Task 12 calls after it has rewritten the referrers.
- Task 9 maps `CopyConflict` from `CopyConflictDto`; Task 12 calls `rename_paths`.

- [ ] **Step 1: Write the failing copy and rename test**

Create `crates/vault-index/tests/mutation_copy_rename.rs`:

```rust
//! `copy_file` and the movement half of rename. Neither ever overwrites: a
//! mover who means replace must delete first, visibly.

use std::collections::BTreeSet;
use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{CopyConflict, Mutation, MutationEngine, MutationError, Precondition, revision_of};

struct Fixture {
    engine: MutationEngine,
    root: PathBuf,
    _vault: TempDir,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder/Deep")).expect("create Folder/Deep");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    std::fs::write(root.join("Two.md"), "# Two\n").expect("write Two");
    std::fs::write(root.join("image.png"), [0x89, 0x50, 0x4e, 0x47]).expect("write image");
    std::fs::write(root.join("Folder/Deep/Three.md"), "# Three\n").expect("write Three");
    Fixture {
        engine: MutationEngine::new(&root),
        root,
        _vault: vault,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

#[test]
fn copying_an_attachment_reproduces_its_bytes_exactly() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("image.png"),
            to: path("Folder/image.png"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect("copy an attachment");
    assert_eq!(
        std::fs::read(fixture.root.join("Folder/image.png")).expect("read the copy"),
        vec![0x89, 0x50, 0x4e, 0x47]
    );
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(&[0x89, 0x50, 0x4e, 0x47]).as_str())
    );
    assert!(
        !outcome.semantic,
        "a non-Markdown copy changes nothing the index holds"
    );
    assert!(outcome.changed_paths.is_empty());
}

#[test]
fn copying_a_note_names_the_destination_as_changed() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Folder/One.md"),
            expected_source: Precondition::Revision(revision_of(b"# One\n")),
            if_exists: CopyConflict::Error,
        })
        .expect("copy a note");
    assert_eq!(outcome.changed_paths, BTreeSet::from([path("Folder/One.md")]));
    assert!(outcome.semantic);
    assert!(
        fixture.root.join("One.md").is_file(),
        "a copy leaves its source alone"
    );
}

#[test]
fn copying_onto_an_existing_file_is_refused_by_default() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Two.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Error,
        })
        .expect_err("the default never overwrites");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert_eq!(
        std::fs::read(fixture.root.join("Two.md")).expect("read back"),
        b"# Two\n"
    );
}

#[test]
fn the_suffix_policy_numbers_the_destination_the_way_obsidian_does() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Two.md"),
            expected_source: Precondition::Any,
            if_exists: CopyConflict::Suffix,
        })
        .expect("copy with auto-numbering");
    assert_eq!(
        std::fs::read(fixture.root.join("Two 1.md")).expect("read the numbered copy"),
        b"# One\n"
    );
    assert_eq!(outcome.changed_paths, BTreeSet::from([path("Two 1.md")]));
    assert_eq!(
        std::fs::read(fixture.root.join("Two.md")).expect("read back"),
        b"# Two\n",
        "the existing file must be untouched"
    );
}

#[test]
fn a_stale_source_revision_copies_nothing() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::CopyFile {
            from: path("One.md"),
            to: path("Folder/One.md"),
            expected_source: Precondition::Revision("blake3:0000".into()),
            if_exists: CopyConflict::Error,
        })
        .expect_err("a stale source revision must lose");
    assert!(matches!(error, MutationError::RevisionConflict { .. }));
    assert!(!fixture.root.join("Folder/One.md").exists());
}

#[test]
fn renaming_a_note_moves_it_and_names_both_paths() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("Folder/Renamed.md"),
            expected: Precondition::Revision(revision_of(b"# One\n")),
            rewrite_links: false,
        })
        .expect("rename a note");
    assert!(!fixture.root.join("One.md").exists());
    assert_eq!(
        std::fs::read(fixture.root.join("Folder/Renamed.md")).expect("read the moved note"),
        b"# One\n"
    );
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("One.md"), path("Folder/Renamed.md")]),
        "both the vacated and the occupied path must reach reconciliation"
    );
}

#[test]
fn renaming_onto_an_existing_note_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("Two.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect_err("there is no overwrite-on-rename");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(fixture.root.join("One.md").is_file());
    assert_eq!(
        std::fs::read(fixture.root.join("Two.md")).expect("read back"),
        b"# Two\n"
    );
}

#[test]
fn a_case_only_rename_succeeds_through_a_temporary_name() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("ONE.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect("a case-only rename is supported internally");
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("One.md"), path("ONE.md")])
    );
    let names: BTreeSet<String> = std::fs::read_dir(&fixture.root)
        .expect("read the vault root")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert!(names.contains("ONE.md"), "{names:?}");
    assert!(!names.contains("One.md"), "{names:?}");
    assert!(
        names.iter().all(|name| !name.starts_with(".vaultd-")),
        "the intermediate name must not survive: {names:?}"
    );
}

#[test]
fn renaming_onto_a_case_variant_of_a_different_note_is_refused() {
    let fixture = fixture();
    let error = fixture
        .engine
        .apply(&Mutation::RenameNote {
            from: path("One.md"),
            to: path("two.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect_err("a case variant of Two.md would clobber it on APFS");
    match error {
        MutationError::CaseCollision { existing, .. } => assert_eq!(existing, "Two.md"),
        other => panic!("expected a case collision, got {other:?}"),
    }
    assert!(fixture.root.join("One.md").is_file());
}

#[test]
fn renaming_a_folder_names_every_note_on_both_sides() {
    let fixture = fixture();
    let outcome = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("Folder"),
            to: path("Moved"),
            rewrite_links: false,
        })
        .expect("rename a folder");
    assert!(fixture.root.join("Moved/Deep/Three.md").is_file());
    assert_eq!(
        outcome.changed_paths,
        BTreeSet::from([path("Folder/Deep/Three.md"), path("Moved/Deep/Three.md")])
    );
}

#[test]
fn renaming_a_folder_onto_an_existing_name_is_refused() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join("Moved")).expect("create Moved");
    let error = fixture
        .engine
        .apply(&Mutation::RenameFolder {
            from: path("Folder"),
            to: path("Moved"),
            rewrite_links: false,
        })
        .expect_err("merging two folders is not a rename");
    assert!(
        matches!(error, MutationError::TargetExists { .. }),
        "expected target_exists, got {error:?}"
    );
    assert!(fixture.root.join("Folder/Deep/Three.md").is_file());
}
```

- [ ] **Step 2: Run the focused test and observe the missing variants**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_copy_rename
```

Expected: compilation fails — `Mutation::CopyFile`, `Mutation::RenameNote`, `Mutation::RenameFolder`, and `CopyConflict` do not exist.

- [ ] **Step 3: Implement copy and the movement primitives**

In `crates/vault-index/src/mutate.rs`, add the variants:

```rust
    CopyFile {
        from: VaultPath,
        to: VaultPath,
        expected_source: Precondition,
        if_exists: CopyConflict,
    },
    RenameNote {
        from: VaultPath,
        to: VaultPath,
        expected: Precondition,
        /// Consumed by `IndexService::apply_mutation`, which owns the link
        /// repair burst; the engine below only ever moves the file.
        rewrite_links: bool,
    },
    RenameFolder {
        from: VaultPath,
        to: VaultPath,
        rewrite_links: bool,
    },
```

and:

```rust
/// What `copy_file` does when its destination already exists.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CopyConflict {
    #[default]
    Error,
    /// Obsidian's auto-numbering behaviour, for `getAvailablePath` parity.
    Suffix,
}
```

Add the `apply` arms:

```rust
            Mutation::CopyFile {
                from,
                to,
                expected_source,
                if_exists,
            } => self.copy_file(from, to, expected_source, *if_exists),
            Mutation::RenameNote {
                from,
                to,
                expected,
                rewrite_links: _,
            } => {
                self.check(from, expected)?;
                let changed_paths = self.rename_paths(from, to)?;
                Ok(MutationOutcome {
                    // Empty when an attachment moved: `rename_paths` reports
                    // Markdown paths only, and the invariant on
                    // `MutationOutcome` ties `semantic` to exactly that.
                    semantic: !changed_paths.is_empty(),
                    changed_paths,
                    revision: self.current_revision(to)?,
                    links_rewritten: 0,
                    link_rewrite_failures: Vec::new(),
                })
            }
            Mutation::RenameFolder {
                from,
                to,
                rewrite_links: _,
            } => {
                let changed_paths = self.rename_paths(from, to)?;
                Ok(MutationOutcome {
                    semantic: !changed_paths.is_empty(),
                    changed_paths,
                    revision: None,
                    links_rewritten: 0,
                    link_rewrite_failures: Vec::new(),
                })
            }
```

and the implementations:

```rust
impl MutationEngine {
    fn copy_file(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        expected_source: &Precondition,
        if_exists: CopyConflict,
    ) -> Result<MutationOutcome, MutationError> {
        if in_config_zone(from) || in_config_zone(to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        if expected_source == &Precondition::Absent {
            return Err(MutationError::InvalidPrecondition {
                expected: expected_source.clone(),
            });
        }
        let Some(bytes) = self.check(from, expected_source)? else {
            return Err(MutationError::NotFound { path: from.clone() });
        };
        let actual = bytes.len() as u64;
        if actual > self.max_file_bytes {
            return Err(MutationError::TooLarge {
                limit: self.max_file_bytes,
                actual,
            });
        }
        let mut destination = to.clone();
        let mut resolved = self.resolve(&destination)?;
        if resolved.exists() {
            match if_exists {
                CopyConflict::Error => {
                    return Err(MutationError::TargetExists { path: to.clone() });
                }
                CopyConflict::Suffix => {
                    destination = available_sibling(to, |candidate| {
                        Ok(self.resolve(candidate)?.exists())
                    })?;
                    resolved = self.resolve(&destination)?;
                }
            }
        }
        if let Some(existing) = self.case_variant(&destination)? {
            return Err(MutationError::CaseCollision {
                path: destination,
                existing,
            });
        }
        write_atomically(&resolved, &bytes)?;
        let semantic = is_markdown(&destination);
        let changed_paths = if semantic {
            BTreeSet::from([destination])
        } else {
            BTreeSet::new()
        };
        Ok(MutationOutcome {
            changed_paths,
            revision: Some(revision_of(&bytes)),
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic,
        })
    }

    /// Move `from` to `to` and report every Markdown path whose state moved:
    /// the vacated spellings and the occupied ones. Works for a file or a
    /// folder — the only difference is how many paths come back.
    ///
    /// Refuses an existing destination outright: there is no
    /// overwrite-on-rename, and a mover who means replace must delete first,
    /// visibly. A case-only rename (`One.md` to `ONE.md`) is the one
    /// exception, and goes through a temporary name because on a
    /// case-insensitive filesystem the source and destination are the same
    /// file.
    pub fn rename_paths(
        &self,
        from: &VaultPath,
        to: &VaultPath,
    ) -> Result<BTreeSet<VaultPath>, MutationError> {
        if in_config_zone(from) || in_config_zone(to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        if self.read_only {
            return Err(MutationError::ReadOnly);
        }
        let source = self.resolve(from)?;
        if !source.exists() {
            return Err(MutationError::NotFound { path: from.clone() });
        }
        let case_only = from.as_str() != to.as_str()
            && from.as_str().to_lowercase() == to.as_str().to_lowercase();
        let destination = self.resolve(to)?;
        if !case_only {
            if destination.exists() {
                return Err(MutationError::TargetExists { path: to.clone() });
            }
            if let Some(existing) = self.case_variant(to)? {
                return Err(MutationError::CaseCollision {
                    path: to.clone(),
                    existing,
                });
            }
        }

        let mut before: Vec<VaultPath> = Vec::new();
        if source.is_dir() {
            before.extend(markdown_paths_under(&self.canonical_root, from)?);
        } else if is_markdown(from) {
            before.push(from.clone());
        }

        if case_only {
            let parent = destination.parent().ok_or_else(|| MutationError::Io {
                message: format!("{} has no parent directory", destination.display()),
            })?;
            let staging = tempfile::Builder::new()
                .prefix(".vaultd-")
                .tempdir_in(parent)
                .map_err(io)?;
            let intermediate = staging.path().join("staged");
            std::fs::rename(&source, &intermediate).map_err(io)?;
            std::fs::rename(&intermediate, &destination).map_err(io)?;
        } else {
            std::fs::rename(&source, &destination).map_err(io)?;
        }

        let mut after: Vec<VaultPath> = Vec::new();
        if destination.is_dir() {
            after.extend(markdown_paths_under(&self.canonical_root, to)?);
        } else if is_markdown(to) {
            after.push(to.clone());
        }

        Ok(before.into_iter().chain(after).collect())
    }
}

/// The first `name N.ext` spelling beside `path` that `occupied` says is
/// free, matching Obsidian's `getAvailablePath` numbering.
fn available_sibling(
    path: &VaultPath,
    occupied: impl Fn(&VaultPath) -> Result<bool, MutationError>,
) -> Result<VaultPath, MutationError> {
    let text = path.as_str();
    let (prefix, extension) = match text.rsplit_once('.') {
        Some((prefix, extension)) => (prefix, format!(".{extension}")),
        None => (text, String::new()),
    };
    for suffix in 1u32..10_000 {
        let candidate = VaultPath::new(format!("{prefix} {suffix}{extension}"))
            .map_err(|_| MutationError::ZoneViolation { path: path.clone() })?;
        if !occupied(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(MutationError::TargetExists { path: path.clone() })
}
```

In `crates/vault-index/src/lib.rs`, add `CopyConflict` to the `mutate` re-export.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_copy_rename
```

Expected: all 11 tests pass.

- [ ] **Step 5: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/mutate.rs crates/vault-index/src/lib.rs \
        crates/vault-index/tests/mutation_copy_rename.rs
git commit -m "feat(index): add copy and the file movement half of rename"
```

---

### Task 8: `patch_frontmatter` — span-surgical edits with byte fidelity

**Files:**

- Create: `crates/vault-index/src/mutate/frontmatter.rs`
- Modify: `crates/vault-index/src/mutate.rs`
- Create: `crates/vault-index/tests/frontmatter_patch.rs`

**Interfaces:**

- Consumes: `vault_core::{parse_note, ParsedNote, Property, PropertyValue, SourceDocument, SourceSpan, Spanned}`; `MutationEngine::{resolve, check}`, `write_atomically` (Tasks 4–5).
- Produces: `pub enum PatchValue { Boolean(bool), Integer(i64), Float(f64), String(String), Sequence(Vec<PatchValue>), Mapping(Vec<(String, PatchValue)>) }` — deliberately no `Null`: a JSON `null` is the deletion spelling and arrives as `FrontmatterEdit::value == None`.
- Produces: `pub struct FrontmatterEdit { pub key_path: Vec<String>, pub value: Option<PatchValue> }`.
- Produces: `pub fn patch_source(path: &VaultPath, source: &str, edits: &[FrontmatterEdit]) -> Result<String, MutationError>`.
- Produces: `Mutation::PatchFrontmatter { path, patch, expected }`.
- Produces: `MutationError::MalformedFrontmatter { path }`.
- Task 9 splits the wire's dot-path into `key_path` segments.

**The rule this task implements, and the one it does not.** The design's ruling 5 said existing values are *never* re-serialized. Its **correction #9 supersedes that**, and correction #9 is what this task builds:

> an edit at or above a stored key's granularity rewrites only that key's span; an edit **below** it re-serializes the smallest enclosing **top-level property**, and nothing outside that property is touched.

The index stores spans per top-level frontmatter key and no deeper, so a dot-path addressing a leaf inside a nested object has no stored span of its own. Refusing those — v1's reading — would make `nested-properties` unserviceable, and that plugin is the entire reason dot-paths exist. So the two granularities get two mechanisms:

| the edit addresses | mechanism | what moves |
| --- | --- | --- |
| a **top-level key** (`title`, `tags`) | span surgery: splice the stored value span, or delete the key's line range | only that value's bytes |
| **anything below** it (`nested.inner.leaf`, `tags.0`) | deserialize the enclosing top-level property's value, apply the edit to it, re-emit it in the addition dialect | only that one property's lines |

Byte-perfection was never the point; **not silently rewriting every note** was. Re-emitting one property while key order, comments, whitespace, and the whole body stay byte-identical honours that. Storing per-nested-key spans would remove even this and is deferred follow-on — it would make the property model recursive.

**Two calls this task makes explicitly**, because the spec leaves them to the plan:

1. **A multi-segment `key_path` whose top-level key does not exist creates the whole nested structure.** `{"key_path": "a.b.c", "value": "x"}` against frontmatter with no `a` adds `a:\n  b:\n    c: x`. This is `processFrontMatter` parity — a plugin writing `fm.a = fm.a ?? {}; fm.a.b = …` gets exactly that — and the alternative (refuse unless every intermediate already exists) would make a plugin's first write to a new nested key fail and its second succeed, which is the worst of both.
2. **What is still refused.** `MutationError::UnaddressablePatch` survives, narrowed to what genuinely has no value to address: descending into a **scalar** (`title.sub` where `title` is `"Original"` — inventing a mapping there would silently discard the caller's `title`), indexing a sequence with a **non-numeric** segment, or indexing one **past its end** on a set. A deletion of anything missing stays a no-op at every depth.

- [ ] **Step 1: Write the failing fixture test**

Create `crates/vault-index/tests/frontmatter_patch.rs`:

```rust
//! `patch_frontmatter`: every byte outside an addressed span survives.

use vault_core::VaultPath;
use vault_index::{FrontmatterEdit, MutationError, PatchValue, patch_source};

fn path() -> VaultPath {
    VaultPath::new("One.md").expect("valid vault path")
}

fn edit(key_path: &str, value: Option<PatchValue>) -> FrontmatterEdit {
    FrontmatterEdit {
        key_path: key_path.split('.').map(str::to_string).collect(),
        value,
    }
}

const DOCUMENT: &str = "---\ntitle: Original\ncount: 3\ntags:\n  - one\n  - two\nnested:\n  inner:\n    leaf: old\n---\n# Body\n\nUntouched prose with a link.\n";

/// The body is every byte after the closing fence. Nothing a frontmatter
/// patch does may move one of them.
fn body(text: &str) -> &str {
    let rest = text.strip_prefix("---\n").expect("fixture has frontmatter");
    let end = rest.find("\n---\n").expect("fixture has a closing fence");
    &rest[end + "\n---\n".len()..]
}

/// Every source line of `DOCUMENT` that does not belong to the top-level
/// property `key` — the exact bytes a patch addressing `key` (at any depth
/// below it) is allowed to leave alone and nothing else.
///
/// This is the assertion correction #9 calls for: an edit below a stored
/// span's granularity re-serializes its enclosing property, so "nothing
/// changed" is scoped to *outside that property*, not to every byte of the
/// frontmatter.
fn outside_property(text: &str, key: &str) -> Vec<String> {
    let mut kept = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let starts_a_top_level_key = !line.starts_with(' ') && line.contains(':');
        if starts_a_top_level_key {
            inside = line.starts_with(&format!("{key}:"));
        }
        if !inside {
            kept.push(line.to_string());
        }
    }
    kept
}

#[test]
fn replacing_a_scalar_touches_only_that_value() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("title", Some(PatchValue::String("Replaced".into())))],
    )
    .expect("replace a scalar");
    assert!(patched.contains("title: Replaced\n"), "{patched}");
    assert!(patched.contains("count: 3\n"), "{patched}");
    assert!(patched.contains("  - one\n  - two\n"), "{patched}");
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn a_nested_dot_path_edits_the_leaf_and_nothing_outside_its_property() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit(
            "nested.inner.leaf",
            Some(PatchValue::String("new".into())),
        )],
    )
    .expect("edit a nested leaf");
    assert!(patched.contains("nested:\n  inner:\n    leaf: new\n"), "{patched}");
    assert!(!patched.contains("leaf: old"), "{patched}");
    // The `nested` property is re-serialized whole, per correction #9, so the
    // byte-preservation claim is scoped to everything *outside* it: the other
    // three keys, their order, their exact spelling, and the whole body.
    assert_eq!(
        outside_property(&patched, "nested"),
        outside_property(DOCUMENT, "nested")
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn a_nested_edit_whose_top_level_key_is_missing_creates_the_whole_structure() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("brand.new.leaf", Some(PatchValue::String("v".into())))],
    )
    .expect("processFrontMatter parity: the intermediate mappings are created");
    assert!(
        patched.contains("    leaf: old\nbrand:\n  new:\n    leaf: v\n---\n"),
        "{patched}"
    );
    assert_eq!(
        outside_property(&patched, "brand"),
        outside_property(DOCUMENT, "brand"),
        "creating a new key moves no existing one"
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn deleting_a_key_takes_its_trailing_line_terminator_with_it() {
    let patched =
        patch_source(&path(), DOCUMENT, &[edit("count", None)]).expect("delete a scalar key");
    assert!(!patched.contains("count"), "{patched}");
    assert!(
        patched.contains("title: Original\ntags:\n"),
        "no blank line may be left behind: {patched}"
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn deleting_a_block_sequence_removes_every_one_of_its_lines() {
    let patched =
        patch_source(&path(), DOCUMENT, &[edit("tags", None)]).expect("delete a block sequence");
    assert!(!patched.contains("- one"), "{patched}");
    assert!(!patched.contains("- two"), "{patched}");
    assert!(patched.contains("count: 3\nnested:\n"), "{patched}");
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn deleting_a_key_that_is_not_there_is_byte_identical() {
    let patched =
        patch_source(&path(), DOCUMENT, &[edit("absent", None)]).expect("delete a missing key");
    assert_eq!(patched, DOCUMENT);
}

#[test]
fn adding_a_key_appends_it_before_the_closing_fence() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("status", Some(PatchValue::String("open".into())))],
    )
    .expect("add a key");
    assert!(patched.contains("    leaf: old\nstatus: open\n---\n"), "{patched}");
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn adding_a_key_to_a_document_with_no_frontmatter_creates_the_block() {
    let plain = "# Body\n\nprose\n";
    let patched = patch_source(
        &path(),
        plain,
        &[edit("title", Some(PatchValue::String("New".into())))],
    )
    .expect("create frontmatter");
    assert_eq!(patched, "---\ntitle: New\n---\n# Body\n\nprose\n");
}

#[test]
fn the_addition_dialect_is_pinned_byte_for_byte() {
    let plain = "body\n";
    let patched = patch_source(
        &path(),
        plain,
        &[
            edit("flag", Some(PatchValue::Boolean(true))),
            edit("count", Some(PatchValue::Integer(-2))),
            edit("ratio", Some(PatchValue::Float(1.5))),
            edit("plain", Some(PatchValue::String("no quotes needed".into()))),
            edit("quoted", Some(PatchValue::String("yes".into()))),
            edit("colon", Some(PatchValue::String("a: b".into()))),
            edit("empty", Some(PatchValue::String(String::new()))),
            edit(
                "list",
                Some(PatchValue::Sequence(vec![
                    PatchValue::String("one".into()),
                    PatchValue::Integer(2),
                ])),
            ),
            edit(
                "map",
                Some(PatchValue::Mapping(vec![(
                    "inner".to_string(),
                    PatchValue::String("value".into()),
                )])),
            ),
        ],
    )
    .expect("serialize every shape");
    assert_eq!(
        patched,
        "---\nflag: true\ncount: -2\nratio: 1.5\nplain: no quotes needed\nquoted: \"yes\"\ncolon: \"a: b\"\nempty: \"\"\nlist:\n  - one\n  - 2\nmap:\n  inner: value\n---\nbody\n"
    );
}

#[test]
fn many_additions_to_a_document_with_no_frontmatter_share_one_fence() {
    // The failure this pins: planning each addition independently makes every
    // one of them wrap itself, and a document with no frontmatter ends up with
    // N stacked `---` blocks of which only the first is frontmatter at all.
    // The fence is synthesized once, after every addition is collected.
    let patched = patch_source(
        &path(),
        "# Body\n",
        &[
            edit("one", Some(PatchValue::String("a".into()))),
            edit("two", Some(PatchValue::String("b".into()))),
            edit("three", Some(PatchValue::String("c".into()))),
        ],
    )
    .expect("three additions to a bare document");
    assert_eq!(patched, "---\none: a\ntwo: b\nthree: c\n---\n# Body\n");
    assert_eq!(
        patched.matches("---\n").count(),
        2,
        "exactly one fence pair, however many keys were added: {patched}"
    );
}

#[test]
fn an_unterminated_frontmatter_fence_is_refused_rather_than_given_a_second_one() {
    let error = patch_source(
        &path(),
        "---\ntitle: Original\n# no closing fence\n",
        &[edit("added", Some(PatchValue::String("x".into())))],
    )
    .expect_err("prepending a second fence would bury the first");
    assert!(
        matches!(error, MutationError::MalformedFrontmatter { .. }),
        "expected malformed_frontmatter, got {error:?}"
    );
}

#[test]
fn replacing_a_scalar_with_a_block_sequence_drops_the_dangling_space() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit(
            "title",
            Some(PatchValue::Sequence(vec![PatchValue::String("a".into())])),
        )],
    )
    .expect("replace a scalar with a block sequence");
    assert!(patched.contains("title:\n  - a\ncount: 3\n"), "{patched}");
}

#[test]
fn adding_a_nested_key_inside_an_existing_mapping_indents_it() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit(
            "nested.inner.added",
            Some(PatchValue::String("x".into())),
        )],
    )
    .expect("add a nested key");
    assert!(
        patched.contains("    leaf: old\n    added: x\n"),
        "{patched}"
    );
    assert_eq!(
        outside_property(&patched, "nested"),
        outside_property(DOCUMENT, "nested")
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn descending_into_a_sequence_edits_the_element_and_reserializes_its_property() {
    let patched = patch_source(
        &path(),
        DOCUMENT,
        &[edit("tags.0", Some(PatchValue::String("x".into())))],
    )
    .expect("a numeric segment indexes the sequence");
    assert!(patched.contains("tags:\n  - x\n  - two\n"), "{patched}");
    assert_eq!(
        outside_property(&patched, "tags"),
        outside_property(DOCUMENT, "tags"),
        "only the addressed property is re-serialized"
    );
    assert_eq!(body(&patched), body(DOCUMENT));
}

#[test]
fn descending_into_a_scalar_is_the_one_thing_still_refused() {
    let error = patch_source(
        &path(),
        DOCUMENT,
        &[edit("title.sub", Some(PatchValue::String("x".into())))],
    )
    .expect_err("a string has no member to set, and inventing one would discard the string");
    match error {
        MutationError::UnaddressablePatch { key_path } => assert_eq!(key_path, "title.sub"),
        other => panic!("expected unaddressable_patch, got {other:?}"),
    }
}

#[test]
fn indexing_a_sequence_past_its_end_is_refused_but_deleting_there_is_a_no_op() {
    let error = patch_source(
        &path(),
        DOCUMENT,
        &[edit("tags.9", Some(PatchValue::String("x".into())))],
    )
    .expect_err("there is no ninth tag to replace");
    assert!(
        matches!(error, MutationError::UnaddressablePatch { .. }),
        "expected unaddressable_patch, got {error:?}"
    );
    assert_eq!(
        patch_source(&path(), DOCUMENT, &[edit("tags.9", None)])
            .expect("deleting what is not there is a no-op at every depth"),
        DOCUMENT
    );
}

#[test]
fn deleting_a_nested_leaf_reserializes_its_property_without_it() {
    let patched = patch_source(&path(), DOCUMENT, &[edit("nested.inner.leaf", None)])
        .expect("delete a nested leaf");
    assert!(!patched.contains("leaf"), "{patched}");
    assert!(patched.contains("nested:\n  inner: {}\n"), "{patched}");
    assert_eq!(
        outside_property(&patched, "nested"),
        outside_property(DOCUMENT, "nested")
    );
}

#[test]
fn two_edits_to_the_same_key_are_refused_rather_than_silently_ordered() {
    let error = patch_source(
        &path(),
        DOCUMENT,
        &[
            edit("title", Some(PatchValue::String("first".into()))),
            edit("title", Some(PatchValue::String("second".into()))),
        ],
    )
    .expect_err("two edits to one span have no defined result");
    assert_eq!(error, MutationError::OverlappingPatch);
}

#[test]
fn an_empty_patch_is_byte_identical() {
    assert_eq!(patch_source(&path(), DOCUMENT, &[]).expect("no edits"), DOCUMENT);
}
```

- [ ] **Step 2: Run the focused test and observe the missing function**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test frontmatter_patch
```

Expected: compilation fails — `vault_index::patch_source`, `PatchValue`, and `FrontmatterEdit` do not exist.

- [ ] **Step 3: Write the span-surgical patcher**

Create `crates/vault-index/src/mutate/frontmatter.rs`:

```rust
//! Span-surgical frontmatter editing.
//!
//! Every edit becomes one byte range and its replacement; the ranges are
//! applied back to front, so no earlier edit invalidates a later span. Bytes
//! outside those ranges are never touched — which is the whole point, and is
//! what `tests/frontmatter_patch.rs` and its property test assert.
//!
//! Two granularities, per the design's correction #9. The index stores spans
//! per **top-level** frontmatter key and no deeper:
//!
//! * an edit addressing a top-level key splices that key's stored value span,
//!   or deletes the key's line range — every other byte of the document is
//!   untouched;
//! * an edit addressing anything *below* a top-level key has no stored span of
//!   its own, so the smallest enclosing top-level property is deserialized,
//!   edited in memory, and re-emitted in the addition dialect. One property's
//!   lines move; key order, every other property, comments, whitespace, and
//!   the entire body do not.
//!
//! What is still refused is only what has no value to address at all:
//! descending into a scalar, indexing a sequence with a non-numeric segment,
//! or indexing one past its end on a set.

use std::collections::BTreeMap;
use std::ops::Range;

use vault_core::{Property, PropertyValue, SourceDocument, VaultPath, parse_note};

use super::MutationError;

/// One frontmatter value a patch sets. No null variant: a JSON `null` in
/// `value` is the deletion spelling, and arrives as `FrontmatterEdit::value
/// == None`.
#[derive(Clone, Debug, PartialEq)]
pub enum PatchValue {
    Boolean(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Sequence(Vec<PatchValue>),
    Mapping(Vec<(String, PatchValue)>),
}

/// One addressed key and what becomes of it.
#[derive(Clone, Debug, PartialEq)]
pub struct FrontmatterEdit {
    /// The dot-path, already split into segments.
    pub key_path: Vec<String>,
    /// `None` deletes the addressed key.
    pub value: Option<PatchValue>,
}

struct Splice {
    range: Range<usize>,
    replacement: String,
}

/// The re-serialization tree.
///
/// Deliberately not [`PatchValue`]: this one has to represent a value that is
/// *already in the document*, and a document may hold a null. [`PatchValue`]
/// has no null variant on purpose — a JSON `null` on the wire is the deletion
/// spelling — so a stored null would have nowhere to go and a round trip
/// through the caller's type would corrupt it.
#[derive(Clone, Debug, PartialEq)]
enum Yaml {
    Null,
    Boolean(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Sequence(Vec<Yaml>),
    Mapping(Vec<(String, Yaml)>),
}

impl From<&PatchValue> for Yaml {
    fn from(value: &PatchValue) -> Self {
        match value {
            PatchValue::Boolean(value) => Self::Boolean(*value),
            PatchValue::Integer(value) => Self::Integer(*value),
            PatchValue::Float(value) => Self::Float(*value),
            PatchValue::String(value) => Self::String(value.clone()),
            PatchValue::Sequence(items) => Self::Sequence(items.iter().map(Self::from).collect()),
            PatchValue::Mapping(entries) => Self::Mapping(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), Self::from(value)))
                    .collect(),
            ),
        }
    }
}

impl From<&PropertyValue> for Yaml {
    /// Total, and it must stay total: this is what makes re-serializing an
    /// enclosing property safe. A shape this could not represent would be a
    /// shape the round trip silently dropped.
    fn from(value: &PropertyValue) -> Self {
        match value {
            PropertyValue::Null => Self::Null,
            PropertyValue::Boolean(value) => Self::Boolean(*value),
            PropertyValue::Integer(value) => Self::Integer(*value),
            PropertyValue::Float(value) => Self::Float(*value),
            PropertyValue::String(value) => Self::String(value.clone()),
            PropertyValue::Sequence(items) => {
                Self::Sequence(items.iter().map(|item| Self::from(&item.value)).collect())
            }
            PropertyValue::Mapping(entries) => Self::Mapping(
                entries
                    .iter()
                    .map(|(key, value)| (key.value.clone(), Self::from(&value.value)))
                    .collect(),
            ),
        }
    }
}

/// Where a new top-level key goes.
enum Fence {
    /// The offset of the closing `---`, so an addition lands just before it.
    Closing(usize),
    /// No frontmatter block at all: one has to be synthesized.
    Absent,
    /// A block that opens and never closes. Prepending a second fence would
    /// bury the first, so this is refused instead.
    Unterminated,
}

/// Apply `edits` to `source`, returning the patched document.
pub fn patch_source(
    path: &VaultPath,
    source: &str,
    edits: &[FrontmatterEdit],
) -> Result<String, MutationError> {
    if edits.is_empty() {
        return Ok(source.to_string());
    }
    let note = parse_note(SourceDocument::new(path.clone(), source.to_string()));

    // Group by top-level key, keeping first-appearance order so additions land
    // in the order the caller wrote them. Grouping is what lets two edits under
    // one key (`a.b` and `a.c`) become one re-serialization instead of two
    // conflicting ones.
    let mut order: Vec<String> = Vec::new();
    let mut groups: BTreeMap<String, Vec<&FrontmatterEdit>> = BTreeMap::new();
    for edit in edits {
        if edit.key_path.is_empty() || edit.key_path.iter().any(String::is_empty) {
            return Err(MutationError::UnaddressablePatch {
                key_path: edit.key_path.join("."),
            });
        }
        let first = &edit.key_path[0];
        if !groups.contains_key(first) {
            order.push(first.clone());
        }
        groups.entry(first.clone()).or_default().push(edit);
    }
    // Two edits addressing the identical path have no defined result, at any
    // depth. Refusing beats picking one silently.
    for group in groups.values() {
        for (index, edit) in group.iter().enumerate() {
            if group[..index]
                .iter()
                .any(|earlier| earlier.key_path == edit.key_path)
            {
                return Err(MutationError::OverlappingPatch);
            }
        }
    }

    let mut splices: Vec<Splice> = Vec::new();
    let mut additions: Vec<String> = Vec::new();
    for key in &order {
        let group = &groups[key];
        match note
            .properties
            .iter()
            .find(|property| &property.key.value == key)
        {
            Some(property) => {
                if let Some(splice) = plan_existing(source, property, group)? {
                    splices.push(splice);
                }
            }
            None => {
                if let Some(line) = plan_addition(key, group)? {
                    additions.push(line);
                }
            }
        }
    }

    // Every addition shares one anchor, and the fence is synthesized **once**.
    // Letting each addition wrap itself would emit one `---` block per new key
    // in a document that had no frontmatter, and only the first would be
    // frontmatter at all.
    if !additions.is_empty() {
        match closing_fence(source) {
            Fence::Closing(fence) => splices.push(Splice {
                range: fence..fence,
                replacement: additions.concat(),
            }),
            Fence::Absent => splices.push(Splice {
                range: 0..0,
                replacement: format!("---\n{}---\n", additions.concat()),
            }),
            Fence::Unterminated => {
                return Err(MutationError::MalformedFrontmatter { path: path.clone() });
            }
        }
    }

    splices.sort_by_key(|splice| (splice.range.start, splice.range.end));
    for window in splices.windows(2) {
        if window[0].range.end > window[1].range.start {
            return Err(MutationError::OverlappingPatch);
        }
    }
    // Back to front, so no earlier splice invalidates a later span. The
    // addition anchor sits at or past every property's end, so it is applied
    // first and the property splices below it stay valid.
    let mut patched = source.to_string();
    for splice in splices.iter().rev() {
        patched.replace_range(splice.range.clone(), &splice.replacement);
    }
    Ok(patched)
}

/// The splice for one top-level key that **exists** in the document.
fn plan_existing(
    source: &str,
    property: &Property,
    group: &[&FrontmatterEdit],
) -> Result<Option<Splice>, MutationError> {
    let indent = indent_of(source, property.key.span.start());
    // The key's whole entry, terminator included: the stored span stops at the
    // value, so a deletion that used it would leave a blank line behind.
    let entry = line_start(source, property.span.start())..line_end(source, property.value.span.end());

    // At the stored granularity: pure span surgery, nothing re-serialized.
    if group.len() == 1 && group[0].key_path.len() == 1 {
        return Ok(Some(match &group[0].value {
            Some(value) => Splice {
                // The replacement owns the separator after the `:`, so it can
                // choose one space for a scalar and a newline for a block.
                range: after_colon(source, property.key.span.end())..property.value.span.end(),
                replacement: after_key(&Yaml::from(value), indent),
            },
            None => Splice {
                range: entry,
                replacement: String::new(),
            },
        }));
    }
    // Replacing a key and editing something inside it in one patch has no
    // defined order either.
    if group.iter().any(|edit| edit.key_path.len() == 1) {
        return Err(MutationError::OverlappingPatch);
    }

    // Below the stored granularity: deserialize, apply, re-emit.
    let mut root = Yaml::from(&property.value.value);
    for edit in group {
        let key_path = edit.key_path.join(".");
        let replacement = edit.value.as_ref().map(Yaml::from);
        apply_nested(
            &mut root,
            &edit.key_path[1..],
            replacement.as_ref(),
            &key_path,
        )?;
    }
    Ok(Some(Splice {
        range: entry,
        replacement: format!(
            "{}{}:{}\n",
            " ".repeat(indent),
            property.key.value,
            after_key(&root, indent)
        ),
    }))
}

/// The new line for one top-level key that is **not** in the document.
///
/// A multi-segment path creates every intermediate mapping — `processFrontMatter`
/// parity, and the alternative would make a plugin's first write to a nested
/// key fail while its second succeeded.
fn plan_addition(
    key: &str,
    group: &[&FrontmatterEdit],
) -> Result<Option<String>, MutationError> {
    // Deleting a key that is not there is a no-op, at every depth.
    if group.iter().all(|edit| edit.value.is_none()) {
        return Ok(None);
    }
    if group.len() == 1 && group[0].key_path.len() == 1 {
        let value = group[0]
            .value
            .as_ref()
            .expect("a set was established just above");
        return Ok(Some(format!("{key}:{}\n", after_key(&Yaml::from(value), 0))));
    }
    let mut root = Yaml::Mapping(Vec::new());
    for edit in group {
        if edit.key_path.len() == 1 {
            return Err(MutationError::OverlappingPatch);
        }
        let key_path = edit.key_path.join(".");
        let replacement = edit.value.as_ref().map(Yaml::from);
        apply_nested(
            &mut root,
            &edit.key_path[1..],
            replacement.as_ref(),
            &key_path,
        )?;
    }
    Ok(Some(format!("{key}:{}\n", after_key(&root, 0))))
}

/// Apply one edit to an in-memory value, `segments` deep.
///
/// `new = None` deletes. A missing intermediate is created on a set and
/// ignored on a delete; a scalar in the way is refused, because turning it
/// into a mapping would discard the value the caller never mentioned.
fn apply_nested(
    target: &mut Yaml,
    segments: &[String],
    new: Option<&Yaml>,
    key_path: &str,
) -> Result<(), MutationError> {
    let unaddressable = || MutationError::UnaddressablePatch {
        key_path: key_path.to_string(),
    };
    let Some(segment) = segments.first() else {
        return Err(unaddressable());
    };
    let last = segments.len() == 1;
    match target {
        Yaml::Mapping(entries) => {
            match entries.iter().position(|(key, _)| key == segment) {
                Some(index) => {
                    if !last {
                        return apply_nested(&mut entries[index].1, &segments[1..], new, key_path);
                    }
                    match new {
                        Some(value) => entries[index].1 = value.clone(),
                        None => {
                            entries.remove(index);
                        }
                    }
                    Ok(())
                }
                None => {
                    let Some(value) = new else {
                        return Ok(());
                    };
                    entries.push((segment.clone(), wrap(&segments[1..], value)));
                    Ok(())
                }
            }
        }
        Yaml::Sequence(items) => {
            let Ok(index) = segment.parse::<usize>() else {
                return Err(unaddressable());
            };
            if index >= items.len() {
                // Nothing there: a delete is a no-op, a set has nowhere to go.
                return match new {
                    None => Ok(()),
                    Some(_) => Err(unaddressable()),
                };
            }
            if !last {
                return apply_nested(&mut items[index], &segments[1..], new, key_path);
            }
            match new {
                Some(value) => items[index] = value.clone(),
                None => {
                    items.remove(index);
                }
            }
            Ok(())
        }
        _ => Err(unaddressable()),
    }
}

/// `value` wrapped in a mapping per remaining segment, innermost last.
fn wrap(segments: &[String], value: &Yaml) -> Yaml {
    match segments.split_first() {
        None => value.clone(),
        Some((head, rest)) => Yaml::Mapping(vec![(head.clone(), wrap(rest, value))]),
    }
}

/// The offset of the first byte of the line containing `offset`.
fn line_start(source: &str, offset: usize) -> usize {
    source[..offset].rfind('\n').map_or(0, |index| index + 1)
}

/// The offset just past the line terminator that ends the line containing
/// `offset`. The stored property span stops at the value, so a deletion has
/// to extend through the terminator itself — otherwise the key vanishes and
/// an empty line takes its place.
fn line_end(source: &str, offset: usize) -> usize {
    match source[offset..].find('\n') {
        Some(index) => offset + index + 1,
        None => source.len(),
    }
}

/// The indentation column of the line containing `offset`.
fn indent_of(source: &str, offset: usize) -> usize {
    let start = line_start(source, offset);
    source[start..offset]
        .bytes()
        .take_while(|byte| *byte == b' ')
        .count()
}

/// The offset just past the `:` that separates `key_span_end` from its value,
/// so a replacement can own the separator and choose its own spacing.
fn after_colon(source: &str, key_span_end: usize) -> usize {
    match source[key_span_end..].find(':') {
        Some(index) => key_span_end + index + 1,
        None => key_span_end,
    }
}

/// Where a new top-level key is inserted: immediately before the closing
/// fence.
fn closing_fence(source: &str) -> Fence {
    let payload_start = if source.starts_with("---\n") {
        4
    } else if source.starts_with("---\r\n") {
        5
    } else {
        return Fence::Absent;
    };
    let mut offset = payload_start;
    for line in source[payload_start..].split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let content = content.strip_suffix('\r').unwrap_or(content);
        if content == "---" {
            return Fence::Closing(offset);
        }
        offset += line.len();
    }
    Fence::Unterminated
}

/// Serialize `value` exactly as it appears after its key's `:` — the
/// separator included, so a scalar gets one space and a block collection gets
/// a newline instead of a dangling space. The reference vault's dominant
/// obsidian-linter style: block sequences and mappings indented two spaces
/// past their key, scalars inline.
fn after_key(value: &Yaml, indent: usize) -> String {
    match value {
        // A bare `key:` — the linter's empty-value style, and what a document
        // that already held one round-trips back to.
        Yaml::Null => String::new(),
        Yaml::Boolean(value) => format!(" {value}"),
        Yaml::Integer(value) => format!(" {value}"),
        Yaml::Float(value) => format!(" {}", float(*value)),
        Yaml::String(value) => format!(" {}", scalar(value)),
        Yaml::Sequence(items) if items.is_empty() => " []".to_string(),
        Yaml::Sequence(items) => {
            let pad = " ".repeat(indent + 2);
            let mut text = String::new();
            for item in items {
                text.push('\n');
                text.push_str(&pad);
                text.push_str("- ");
                text.push_str(&flow(item));
            }
            text
        }
        Yaml::Mapping(entries) if entries.is_empty() => " {}".to_string(),
        Yaml::Mapping(entries) => {
            let pad = " ".repeat(indent + 2);
            let mut text = String::new();
            for (key, value) in entries {
                text.push('\n');
                text.push_str(&pad);
                text.push_str(key);
                text.push(':');
                text.push_str(&after_key(value, indent + 2));
            }
            text
        }
    }
}

/// One value on a single line. Collections nested inside a sequence take flow
/// style, which keeps the block form to one level and stays unambiguous.
fn flow(value: &Yaml) -> String {
    match value {
        Yaml::Null => "null".to_string(),
        Yaml::Boolean(value) => value.to_string(),
        Yaml::Integer(value) => value.to_string(),
        Yaml::Float(value) => float(*value),
        Yaml::String(value) => scalar(value),
        Yaml::Sequence(items) => {
            let rendered: Vec<String> = items.iter().map(flow).collect();
            format!("[{}]", rendered.join(", "))
        }
        Yaml::Mapping(entries) => {
            let rendered: Vec<String> = entries
                .iter()
                .map(|(key, value)| format!("{key}: {}", flow(value)))
                .collect();
            format!("{{{}}}", rendered.join(", "))
        }
    }
}

/// A float that still reads as a float. `1.0` formats as `1` by default,
/// which YAML would read back as an integer — so a whole-numbered finite
/// float gets its `.0` back.
fn float(value: f64) -> String {
    let rendered = format!("{value}");
    if rendered.contains(['.', 'e', 'E']) || !value.is_finite() {
        rendered
    } else {
        format!("{rendered}.0")
    }
}

/// Quote a string only when leaving it bare would change its meaning: empty,
/// padded with whitespace, opening with a YAML indicator, carrying a `: ` or
/// ` #`, spanning lines, or spelling a bool, null, or number.
fn scalar(text: &str) -> String {
    let indicators = [
        '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@',
        '`',
    ];
    let needs_quotes = text.is_empty()
        || text != text.trim()
        || text.starts_with(indicators)
        || text.contains(": ")
        || text.contains(" #")
        || text.contains('\n')
        || matches!(
            text.to_lowercase().as_str(),
            "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "~"
        )
        || text.parse::<f64>().is_ok();
    if needs_quotes {
        format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        text.to_string()
    }
}
```

In `crates/vault-index/src/mutate.rs`, add `pub mod frontmatter;` at the top and re-export `pub use frontmatter::{FrontmatterEdit, PatchValue, patch_source};`. In `crates/vault-index/src/lib.rs`, add those three names to the `mutate` re-export.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test frontmatter_patch
```

Expected: all 19 tests pass. If `the_addition_dialect_is_pinned_byte_for_byte` fails, the dialect is what changed — fix the serializer, never the fixture, unless the maintainer has re-ruled on the dialect. If `a_nested_dot_path_edits_the_leaf_and_nothing_outside_its_property` fails on the `outside_property` comparison rather than on the leaf, the re-serialization is reaching past its own property, which is the one thing correction #9 does not license.

- [ ] **Step 5: Add the byte-fidelity property test**

Append to `crates/vault-index/tests/frontmatter_patch.rs`:

```rust
use proptest::prelude::*;

/// A document whose frontmatter holds the four keys the strategy edits, plus
/// arbitrary body prose. The body is the property's whole subject: no
/// frontmatter edit may move one of its bytes.
fn document() -> impl Strategy<Value = String> {
    (
        "[a-z]{1,8}",
        0i64..1000,
        prop::collection::vec("[a-z]{1,6}", 0..4),
        "(?s)[a-zA-Z0-9 \n#\\[\\]-]{0,200}",
    )
        .prop_map(|(title, count, tags, body)| {
            let mut text = String::from("---\n");
            text.push_str(&format!("title: {title}\n"));
            text.push_str(&format!("count: {count}\n"));
            if tags.is_empty() {
                text.push_str("tags: []\n");
            } else {
                text.push_str("tags:\n");
                for tag in &tags {
                    text.push_str(&format!("  - {tag}\n"));
                }
            }
            text.push_str("nested:\n  leaf: value\n");
            text.push_str("---\n");
            text.push_str(&body);
            text
        })
}

fn any_edit() -> impl Strategy<Value = FrontmatterEdit> {
    prop_oneof![
        "[a-z]{1,8}".prop_map(|value| edit("title", Some(PatchValue::String(value)))),
        (0i64..1000).prop_map(|value| edit("count", Some(PatchValue::Integer(value)))),
        Just(edit("count", None)),
        Just(edit("tags", None)),
        "[a-z]{1,6}".prop_map(|value| edit("nested.leaf", Some(PatchValue::String(value)))),
        Just(edit("nested.leaf", None)),
        "[a-z]{1,6}".prop_map(|value| edit("added", Some(PatchValue::String(value)))),
        Just(edit("absent", None)),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// The body survives every patch, byte for byte.
    #[test]
    fn a_patch_never_moves_a_byte_of_the_body(
        original in document(),
        patch in any_edit(),
    ) {
        let patched = patch_source(&path(), &original, &[patch])
            .map_err(|error| TestCaseError::fail(format!("patch failed: {error}")))?;
        prop_assert_eq!(body(&patched), body(&original));
    }

    /// The keys a patch does not address keep their exact source lines.
    #[test]
    fn a_patch_never_moves_an_unaddressed_key(
        original in document(),
        value in "[a-z]{1,8}",
    ) {
        let patched = patch_source(&path(), &original, &[edit("title", Some(PatchValue::String(value)))])
            .map_err(|error| TestCaseError::fail(format!("patch failed: {error}")))?;
        for line in original.lines() {
            if line.starts_with("title:") {
                continue;
            }
            prop_assert!(
                patched.contains(line),
                "line {line:?} vanished from {patched:?}"
            );
        }
    }

    /// Re-applying the value a key already holds is byte-identical, so a
    /// no-op patch never manufactures a generation.
    #[test]
    fn re_setting_an_identical_scalar_is_byte_identical(original in document()) {
        let current = original
            .lines()
            .find_map(|line| line.strip_prefix("title: "))
            .expect("the fixture always has a title")
            .to_string();
        let patched = patch_source(&path(), &original, &[edit("title", Some(PatchValue::String(current)))])
            .map_err(|error| TestCaseError::fail(format!("patch failed: {error}")))?;
        prop_assert_eq!(patched, original);
    }
}
```

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test frontmatter_patch
```

Expected: the three property tests pass alongside the 19 fixtures.

Note what each property claims after correction #9. `a_patch_never_moves_a_byte_of_the_body` is unchanged and unconditional — no frontmatter edit at any depth may move a body byte. `a_patch_never_moves_an_unaddressed_key` edits only `title`, a top-level key, so it still holds line-for-line across the whole frontmatter. `re_setting_an_identical_scalar_is_byte_identical` also edits `title` and so takes the span-surgery path, which is what makes byte-identity provable rather than a coincidence of the dialect matching the fixture.

- [ ] **Step 6: Wire the operation into the engine**

In `crates/vault-index/src/mutate.rs`, add the variant:

```rust
    PatchFrontmatter {
        path: VaultPath,
        patch: Vec<frontmatter::FrontmatterEdit>,
        expected: Precondition,
    },
```

the `apply` arm:

```rust
            Mutation::PatchFrontmatter {
                path,
                patch,
                expected,
            } => self.patch_frontmatter(path, patch, expected),
```

and the implementation:

```rust
impl MutationEngine {
    fn patch_frontmatter(
        &self,
        path: &VaultPath,
        edits: &[frontmatter::FrontmatterEdit],
        expected: &Precondition,
    ) -> Result<MutationOutcome, MutationError> {
        if in_config_zone(path) {
            return Err(MutationError::ZoneViolation { path: path.clone() });
        }
        if !is_markdown(path) {
            return Err(MutationError::NotANote { path: path.clone() });
        }
        if expected == &Precondition::Absent {
            return Err(MutationError::InvalidPrecondition {
                expected: expected.clone(),
            });
        }
        let resolved = self.resolve(path)?;
        let Some(bytes) = self.check(path, expected)? else {
            return Err(MutationError::NotFound { path: path.clone() });
        };
        let text = String::from_utf8(bytes).map_err(|_| MutationError::Io {
            message: format!("{} is not valid UTF-8", path.as_str()),
        })?;
        let patched = frontmatter::patch_source(path, &text, edits)?;
        if patched == text {
            // Byte-identical: do not rewrite the file, do not move its mtime,
            // and name no changed path — a no-op patch must not manufacture a
            // generation. The caller still gets the current revision back.
            return Ok(MutationOutcome {
                changed_paths: BTreeSet::new(),
                revision: Some(revision_of(text.as_bytes())),
                links_rewritten: 0,
                link_rewrite_failures: Vec::new(),
                semantic: true,
            });
        }
        write_atomically(&resolved, patched.as_bytes())?;
        Ok(MutationOutcome {
            changed_paths: BTreeSet::from([path.clone()]),
            revision: Some(revision_of(patched.as_bytes())),
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic: true,
        })
    }
}
```

- [ ] **Step 7: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/mutate.rs crates/vault-index/src/mutate/frontmatter.rs \
        crates/vault-index/src/lib.rs crates/vault-index/tests/frontmatter_patch.rs
git commit -m "feat(index): patch frontmatter by span with byte fidelity"
```

---

## Execution checkpoint 2 — after Task 8: the engine is complete, nothing is wired

**Stop here and get a review before Task 9.** `MutationEngine` now performs every filesystem operation the phase needs, and it does so with no coordinator, no generations, and no protocol anywhere near it. That makes this the last cheap moment to check the engine's semantics on their own terms.

What the reviewer is checking: the `semantic == !changed_paths.is_empty()` invariant holds in every constructor; every refusal path provably leaves the vault byte-identical; `patch_frontmatter` honours correction #9 at both granularities and refuses only what has no value to address; the case-collision and temp-then-rename guarantees hold. From Task 9 onward every bug here surfaces through three more layers.

---

### Task 9: Coordinator wiring — `RuntimeCommand::Mutate` and read-your-writes

The mutation reaches the coordinator through the same bounded mailbox everything else does, is applied by the one thread that owns the `IndexService`, is reconciled **before** the response is sent, and is published as an ordinary generation with a new `cause: "mutation"`.

**Files:**

- Modify: `crates/vault-index/src/live_reconcile.rs` (`ChangeCause`, line 40 — five variants, `Watcher` through `Verified`)
- Modify: `crates/vault-index/src/reconcile.rs` (`IndexService` struct lines 36–67, `assemble` lines 119–141)
- Modify: `crates/vault-protocol/src/events.rs` (`GenerationCauseDto` and its `Deserialize`)
- Modify: `crates/vault-server/src/runtime.rs` (`RuntimeCommand` lines 108–128, `Coordinator::handle` lines 909–922, `RuntimeHandle`)
- Modify: `crates/vault-server/src/subscriptions.rs` (`generation_cause`, lines 79–87)
- Modify: `crates/vault-server/src/convert.rs`
- Modify: `crates/vault-server/src/lib.rs` (the placeholder arm from Task 2 Step 7)
- Create: `crates/vault-server/tests/mutations.rs`
- Create: `crates/vault-server/tests/daemon/mod.rs` (the spawned-daemon harness Tasks 14, 16, and 17 also use)

**Interfaces:**

- Consumes: `MutationEngine::apply`, `Mutation`, `MutationOutcome`, `MutationError`, `IndexError::Mutation` (Tasks 4–8); the protocol DTOs (Task 2); `GenerationCauseDto`'s tolerant `Deserialize` (Task 1).
- Produces: `vault_index::ChangeCause::Mutation`, `vault_protocol::GenerationCauseDto::Mutation`.
- Produces: `IndexService::apply_mutation(&mut self, mutation: &Mutation) -> Result<MutationOutcome, IndexError>`, `IndexService::set_read_only(&mut self, read_only: bool)`, `IndexService::mutation_engine(&self) -> &MutationEngine`.
- Produces: `RuntimeCommand::Mutate { mutation: Box<Mutation>, reply: SyncSender<Result<MutationReport, IndexError>> }`.
- Produces: `pub struct MutationReport { pub generation: Option<Generation>, pub revision: Option<String>, pub links_rewritten: u64, pub link_rewrite_failures: Vec<LinkRewriteFailure>, pub semantic: bool }`.
- Produces: `pub enum MutationFailure { Overloaded, NotReady, Failed(IndexError) }` and `RuntimeHandle::mutate(&self, mutation: Mutation) -> Result<MutationReport, MutationFailure>`.
- Produces: `convert::{precondition, delete_mode, copy_conflict, patch_value, frontmatter_edits, link_rewrite_failures, mutation_error, mutation_failure}` — all `pub(crate)`; `mutation_error` is the one every mutation refusal funnels through, and `link_rewrite_failures` is what Task 12's report reaches the wire by.
- Produces: `Server::mutate` and `Server::mutation_generation` (both private helpers on `Server`), and the ten real dispatch arms replacing Task 2 Step 7's placeholder.
- Tasks 10–12 and 16–17 all go through `RuntimeHandle::mutate`.

- [ ] **Step 1: Write the failing read-your-writes test**

Create `crates/vault-server/tests/mutations.rs`:

```rust
//! Mutations through the live runtime: the write lands, its generation is
//! published before the response is sent, and a read at that generation sees
//! it.

use std::sync::mpsc::{Receiver, sync_channel};

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{IndexConfig, IndexError, Mutation, MutationError, Precondition, revision_of};
use vault_server::runtime::{
    MutationFailure, Runtime, RuntimeHandle, RuntimeNotice, RuntimeOptions,
};

struct Live {
    handle: RuntimeHandle,
    notices: Receiver<RuntimeNotice>,
    vault: TempDir,
    _index: TempDir,
}

/// A runtime with no watcher and no periodic tick: every generation in these
/// tests is one a mutation caused, so nothing has to be filtered out.
fn live() -> Live {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(vault.path().join("Two.md"), "# Two\nOne\n").expect("write Two");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("runtime config");
    let (sink, notices) = sync_channel(64);
    let options = RuntimeOptions {
        watch: false,
        reconcile_interval: None,
        ..RuntimeOptions::default()
    };
    let handle = Runtime::start(config, options, sink).expect("start the runtime");
    handle.refresh(false).expect("cold build");
    Live {
        handle,
        notices,
        vault,
        _index: index,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

#[test]
fn a_write_is_readable_at_the_generation_it_reports() {
    let live = live();
    let report = live
        .handle
        .mutate(Mutation::WriteNote {
            path: path("One.md"),
            content: "# One changed\nTwo\n".into(),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect("write through the runtime");
    let generation = report.generation.expect("a semantic write joins a generation");

    let note = live
        .handle
        .reader()
        .get_note(&path("One.md"))
        .expect("read back the note this call just wrote");
    assert_eq!(note.generation, generation, "read-your-writes");
    assert_eq!(note.note.source.text(), "# One changed\nTwo\n");
    assert_eq!(
        note.outgoing.len(),
        1,
        "the new reference must be resolved in the same generation"
    );
    assert_eq!(
        report.revision.as_deref(),
        Some(revision_of(b"# One changed\nTwo\n").as_str())
    );
}

#[test]
fn a_delete_is_gone_at_the_generation_it_reports() {
    let live = live();
    let report = live
        .handle
        .mutate(Mutation::DeleteNote {
            path: path("One.md"),
            mode: Some(vault_index::DeleteMode::Permanent),
            expected: Precondition::Any,
        })
        .expect("delete through the runtime");
    assert!(report.generation.is_some());
    let error = live
        .handle
        .reader()
        .get_note(&path("One.md"))
        .expect_err("read-your-deletes");
    assert!(
        matches!(error, IndexError::NoteNotFound(_)),
        "expected note_not_found, got {error:?}"
    );
}

#[test]
fn a_mutation_publishes_a_generation_whose_cause_is_mutation() {
    let live = live();
    live.handle
        .mutate(Mutation::WriteNote {
            path: path("Three.md"),
            content: "# Three\n".into(),
            expected: Precondition::Absent,
        })
        .expect("create a note");

    let mut causes = Vec::new();
    while let Ok(notice) = live.notices.try_recv() {
        if let RuntimeNotice::Generation(report) = notice {
            causes.push(report.cause);
        }
    }
    assert!(
        causes.contains(&vault_index::ChangeCause::Mutation),
        "expected a mutation-caused generation, saw {causes:?}"
    );
}

#[test]
fn the_watchers_own_hint_for_a_mutation_publishes_no_second_generation() {
    let live = live();
    let report = live
        .handle
        .mutate(Mutation::WriteNote {
            path: path("One.md"),
            content: "# One again\n".into(),
            expected: Precondition::Any,
        })
        .expect("write through the runtime");
    let after_write = report.generation.expect("a semantic write joins a generation");

    // Exactly what the watcher would deliver a debounce window later. The
    // fingerprint already matches what was published, so this must be a
    // no-op — an own-mutation hint must never manufacture a second
    // generation.
    assert!(
        live.handle
            .hint(vault_watch::ChangeHint::Paths(vec![path("One.md")])),
        "the runtime must still be accepting hints"
    );
    let refreshed = live.handle.refresh(false).expect("drain the pending hint");
    assert_eq!(
        refreshed.generation.get(),
        after_write.get(),
        "the watcher's echo of our own write must publish nothing"
    );
}

#[test]
fn a_stale_revision_is_refused_without_moving_the_generation() {
    let live = live();
    let before = live
        .handle
        .reader()
        .vault_info()
        .expect("vault info")
        .generation;
    let error = live
        .handle
        .mutate(Mutation::WriteNote {
            path: path("One.md"),
            content: "# clobbered\n".into(),
            expected: Precondition::Revision("blake3:0000".into()),
        })
        .expect_err("a stale revision must lose");
    // Matched on the type, not on the message: a Display string is a
    // presentation detail, and asserting on it makes a reworded error a test
    // failure while a genuinely wrong *code* still passes.
    assert!(
        matches!(
            error,
            MutationFailure::Failed(IndexError::Mutation(MutationError::RevisionConflict { .. }))
        ),
        "expected a revision conflict, got {error:?}"
    );
    assert_eq!(
        std::fs::read(live.vault.path().join("One.md")).expect("read back"),
        b"# One\n"
    );
    assert_eq!(
        live.handle
            .reader()
            .vault_info()
            .expect("vault info")
            .generation,
        before,
        "a refused mutation must not move the generation"
    );
}

#[test]
fn a_folder_creation_reports_the_generation_a_client_can_already_read_at() {
    let live = live();
    let before = live
        .handle
        .reader()
        .vault_info()
        .expect("vault info")
        .generation;
    let report = live
        .handle
        .mutate(Mutation::CreateFolder {
            path: path("Folder"),
        })
        .expect("create a folder");
    assert_eq!(
        report.generation,
        Some(before),
        "a folder holds no notes, so nothing the index tracks moved"
    );
    assert!(live.vault.path().join("Folder").is_dir());
}
```

- [ ] **Step 2: Run the focused test and observe the missing command**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test mutations
```

Expected: compilation fails — `RuntimeHandle::mutate`, `ChangeCause::Mutation`, and `MutationReport` do not exist.

- [ ] **Step 3: Add the new change cause on both sides of the boundary**

In `crates/vault-index/src/live_reconcile.rs`, add `Mutation,` to `ChangeCause` with the comment:

```rust
    /// This daemon's own write path. Distinct from `Watcher` so a subscriber
    /// can tell a change it asked for from a change it must react to.
    Mutation,
```

In `crates/vault-protocol/src/events.rs`, add `Mutation,` to `GenerationCauseDto` (before `Unknown`) and `"mutation" => Self::Mutation,` to its hand-written `Deserialize`.

In `crates/vault-server/src/subscriptions.rs`, add to `generation_cause`:

```rust
        ChangeCause::Mutation => GenerationCauseDto::Mutation,
```

- [ ] **Step 4: Give the `IndexService` its engine**

In `crates/vault-index/src/reconcile.rs`, add the field to `IndexService`:

```rust
    /// The one engine that writes into this vault. Owned by the service so
    /// that a write and the reconciliation that publishes it happen on the
    /// same thread, under the same single-writer guarantee everything else
    /// here has.
    engine: crate::mutate::MutationEngine,
```

set it in `assemble` (before the struct literal, because `config` is moved into it):

```rust
        let engine = crate::mutate::MutationEngine::new(&config.canonical_vault_root);
```

and add it to the literal as `engine,`. Then add the methods:

```rust
impl IndexService {
    /// Apply one mutation to the vault. Filesystem-only: publishing what it
    /// changed is the caller's next step, through `refresh_paths`.
    pub fn apply_mutation(
        &mut self,
        mutation: &crate::mutate::Mutation,
    ) -> Result<crate::mutate::MutationOutcome, IndexError> {
        Ok(self.engine.apply(mutation)?)
    }

    /// Refuse every mutation. Reads, snapshots, and reconciliation are
    /// unaffected.
    pub fn set_read_only(&mut self, read_only: bool) {
        self.engine = self.engine.clone().with_read_only(read_only);
    }

    pub fn mutation_engine(&self) -> &crate::mutate::MutationEngine {
        &self.engine
    }
}
```

- [ ] **Step 5: Add the command, the report, and the coordinator's handling**

In `crates/vault-server/src/runtime.rs`, extend the imports with `use vault_index::{LinkRewriteFailure, Mutation, MutationOutcome};`, add the command variant:

```rust
    Mutate {
        mutation: Box<Mutation>,
        reply: std::sync::mpsc::SyncSender<Result<MutationReport, IndexError>>,
    },
```

its `Debug` arm:

```rust
            Self::Mutate { mutation, .. } => formatter
                .debug_struct("Mutate")
                .field("mutation", mutation)
                .finish_non_exhaustive(),
```

and the report and failure types:

```rust
/// What one applied mutation produced. `generation` is the generation a
/// client may now read its own write at — `None` only when nothing has ever
/// been committed.
#[derive(Clone, Debug)]
pub struct MutationReport {
    pub generation: Option<Generation>,
    pub revision: Option<String>,
    pub links_rewritten: u64,
    pub link_rewrite_failures: Vec<LinkRewriteFailure>,
    pub semantic: bool,
}

/// Why a requested mutation produced no report. Mirrors [`RefreshFailure`]'s
/// three-way split, because a client can act on the same difference.
#[derive(Debug)]
pub enum MutationFailure {
    Overloaded,
    NotReady,
    Failed(IndexError),
}

impl std::fmt::Display for MutationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Overloaded => formatter.write_str("the runtime is overloaded"),
            Self::NotReady => formatter.write_str("the runtime is not running"),
            Self::Failed(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for MutationFailure {}
```

Add the handler arm in `Coordinator::handle`:

```rust
            RuntimeCommand::Mutate { mutation, reply } => {
                let result = self.apply_mutation(*mutation);
                let _ = reply.try_send(result);
            }
```

and the coordinator methods:

```rust
impl Coordinator {
    /// Apply one mutation and publish what it changed **before** answering,
    /// so a client that completes a write can immediately read its result.
    ///
    /// The flush first is what keeps mailbox order mutation order: a watcher
    /// hint that arrived before this command describes an older state of the
    /// very path about to change, and reconciling it afterwards would publish
    /// that older state on top of this write.
    fn apply_mutation(&mut self, mutation: Mutation) -> Result<MutationReport, IndexError> {
        self.flush();
        let outcome = self.mutation(|index| index.apply_mutation(&mutation))?;
        if outcome.changed_paths.is_empty() {
            // A folder operation, an attachment copy, a zone write, or a
            // byte-identical patch: nothing the index holds moved, so report
            // the generation the client can already read at rather than
            // manufacturing one.
            return Ok(self.report(&outcome, self.committed_generation()));
        }
        let paths = outcome.changed_paths.clone();
        match self.reconcile_mutation(paths.clone()) {
            Ok(report) => {
                self.rehints = 0;
                self.clear_reconcile_error();
                if report.previous_generation != Some(report.generation) {
                    self.emit(RuntimeNotice::Generation(Box::new(report.clone())));
                }
                Ok(self.report(&outcome, Some(report.generation)))
            }
            // Nothing has ever been committed, so there is no generation to
            // be incremental against. The complete reconciliation covers this
            // write and everything else besides.
            Err(IndexError::IndexUnavailable) => {
                self.full_reconcile(ResyncReason::RuntimeRecovered);
                self.settle();
                Ok(self.report(&outcome, self.committed_generation()))
            }
            Err(error) => {
                // The bytes are on disk; only the index is behind. Hand the
                // paths back so they still reach a generation, and tell the
                // caller its read-your-writes fence did not close.
                self.fail(&error);
                self.rehint(paths);
                Err(error)
            }
        }
    }

    fn report(&self, outcome: &MutationOutcome, generation: Option<Generation>) -> MutationReport {
        MutationReport {
            generation,
            revision: outcome.revision.clone(),
            links_rewritten: outcome.links_rewritten,
            link_rewrite_failures: outcome.link_rewrite_failures.clone(),
            semantic: outcome.semantic,
        }
    }

    /// Reconcile exactly the paths a mutation changed, retrying the errors
    /// that are retryable by construction — the same three
    /// `refresh_with_retries` retries, against a targeted batch.
    fn reconcile_mutation(
        &mut self,
        paths: BTreeSet<VaultPath>,
    ) -> Result<LiveRefreshReport, IndexError> {
        let mut last = IndexError::IndexUnavailable;
        for attempt in 0..MAX_MUTATION_ATTEMPTS {
            let final_attempt = attempt + 1 == MAX_MUTATION_ATTEMPTS;
            let batch = paths.clone();
            match self.mutation(|index| index.refresh_paths(batch, ChangeCause::Mutation)) {
                Ok(report) => return Ok(report),
                Err(error) => {
                    let retryable = matches!(
                        error,
                        IndexError::Busy(_)
                            | IndexError::LiveStateStale(_)
                            | IndexError::VaultChangedDuringRefresh
                    );
                    if !retryable || final_attempt {
                        return Err(error);
                    }
                    match &error {
                        IndexError::Busy(_) => std::thread::sleep(BUSY_BACKOFF),
                        IndexError::LiveStateStale(_) => {
                            self.mutation(IndexService::resync_published)?;
                        }
                        _ => {}
                    }
                    last = error;
                }
            }
        }
        Err(last)
    }
}
```

Add the handle method:

```rust
impl RuntimeHandle {
    /// Apply one mutation and wait for it to be published. Hints already in
    /// the mailbox are processed first; hints that arrive later wait.
    pub fn mutate(&self, mutation: Mutation) -> Result<MutationReport, MutationFailure> {
        let (reply, replies) = sync_channel(1);
        match self.send_command(RuntimeCommand::Mutate {
            mutation: Box::new(mutation),
            reply,
        }) {
            Dispatch::Accepted => {}
            Dispatch::Overflowed => return Err(MutationFailure::Overloaded),
            Dispatch::MailboxClosed => return Err(MutationFailure::NotReady),
        }
        match replies.recv() {
            Ok(result) => result.map_err(MutationFailure::Failed),
            Err(_) => Err(MutationFailure::NotReady),
        }
    }
}
```

- [ ] **Step 6: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test mutations
```

Expected: all six tests pass. If `the_watchers_own_hint_for_a_mutation_publishes_no_second_generation` fails, `classify` in `live_reconcile.rs` is not recognising the fingerprint match — check that `write_atomically`'s rename leaves a fingerprint the reconciler then stores.

- [ ] **Step 7: Map every mutation error onto its protocol code**

In `crates/vault-server/src/convert.rs`, add the arm to `index_error`'s match:

```rust
        IndexError::Mutation(refusal) => return mutation_error(refusal),
```

and the mapping itself:

```rust
/// Map one mutation refusal onto its typed protocol error. Every one of these
/// means *nothing changed*, so the codes are precise on purpose: a client
/// retries a `revision_conflict`, fixes a `parent_not_found`, and gives up on
/// a `read_only`.
pub(crate) fn mutation_error(value: vault_index::MutationError) -> ProtocolError {
    use vault_index::MutationError;

    let mut error = ProtocolError {
        code: ErrorCode::Internal,
        message: value.to_string(),
        supported_version: None,
        current_generation: None,
        current_revision: None,
    };
    match value {
        MutationError::RevisionConflict { current, .. } => {
            error.code = ErrorCode::RevisionConflict;
            error.current_revision = current;
        }
        MutationError::NotFound { .. } => error.code = ErrorCode::NotFound,
        MutationError::ParentNotFound { .. } => error.code = ErrorCode::ParentNotFound,
        MutationError::TargetExists { .. } => error.code = ErrorCode::TargetExists,
        MutationError::CaseCollision { .. } => error.code = ErrorCode::CaseCollision,
        MutationError::ZoneViolation { .. } => error.code = ErrorCode::ZoneViolation,
        // Every one of these is a malformed request rather than a state
        // conflict: no retry helps, and the caller has to change what it
        // asked for. `UnaddressablePatch` is the narrowed post-correction-#9
        // variant — a path with no value to address at all — not the old
        // "below stored-span granularity", which is now served rather than
        // refused.
        MutationError::NotANote { .. }
        | MutationError::IsANote { .. }
        | MutationError::InvalidPrecondition { .. }
        | MutationError::UnaddressablePatch { .. }
        | MutationError::MalformedFrontmatter { .. }
        | MutationError::OverlappingPatch => error.code = ErrorCode::InvalidRequest,
        MutationError::FolderNotEmpty { .. } => error.code = ErrorCode::TargetExists,
        MutationError::TooLarge { .. } => error.code = ErrorCode::PayloadTooLarge,
        MutationError::ReadOnly => error.code = ErrorCode::ReadOnly,
        MutationError::Io { .. } => {
            error.code = ErrorCode::StorageFailure;
            // Never leak a filesystem path or an OS error string.
            error.message = "the vault filesystem write failed".into();
        }
    }
    error
}

pub(crate) fn mutation_failure(value: crate::runtime::MutationFailure) -> ProtocolError {
    match value {
        crate::runtime::MutationFailure::Overloaded => ProtocolError {
            code: ErrorCode::RuntimeOverloaded,
            message: "the runtime is saturated; retry this mutation".into(),
            supported_version: None,
            current_generation: None,
            current_revision: None,
        },
        crate::runtime::MutationFailure::NotReady => ProtocolError {
            code: ErrorCode::RuntimeNotReady,
            message: "the runtime is not running".into(),
            supported_version: None,
            current_generation: None,
            current_revision: None,
        },
        crate::runtime::MutationFailure::Failed(error) => index_error(error),
    }
}
```

Also add the DTO conversions:

```rust
/// Exactly one precondition field may be set. A two-field precondition has no
/// meaning, and silently preferring one would turn a client's typo into an
/// unconditional overwrite.
pub(crate) fn precondition(value: Option<&ExpectedDto>) -> Result<Precondition, ProtocolError> {
    // Omitting `expected` entirely means unconditional. An expected object
    // that is PRESENT but names no field is a typo-shaped client bug and is
    // refused (checkpoint-1 ruling I1).
    let Some(value) = value else {
        return Ok(Precondition::Any);
    };
    let invalid = |message: &str| ProtocolError {
        code: ErrorCode::InvalidRequest,
        message: message.into(),
        supported_version: None,
        current_generation: None,
        current_revision: None,
    };
    match (&value.revision, value.absent, value.any) {
        (Some(revision), None, None) => Ok(Precondition::Revision(revision.clone())),
        (None, Some(true), None) => Ok(Precondition::Absent),
        (None, None, Some(true)) => Ok(Precondition::Any),
        (None, None, None) => {
            Err(invalid("expected must name exactly one of revision, absent, or any"))
        }
        (None, Some(false), None) | (None, None, Some(false)) => {
            Err(invalid("expected.absent and expected.any must be true when present"))
        }
        _ => Err(invalid("expected must name exactly one of revision, absent, or any")),
    }
}

pub(crate) fn delete_mode(value: DeleteModeDto) -> DeleteMode {
    match value {
        DeleteModeDto::TrashSystem => DeleteMode::TrashSystem,
        DeleteModeDto::TrashLocal => DeleteMode::TrashLocal,
        DeleteModeDto::Permanent => DeleteMode::Permanent,
    }
}

pub(crate) fn copy_conflict(value: CopyConflictDto) -> CopyConflict {
    match value {
        CopyConflictDto::Error => CopyConflict::Error,
        CopyConflictDto::Suffix => CopyConflict::Suffix,
    }
}

pub(crate) fn patch_value(value: &PatchValueDto) -> PatchValue {
    match value {
        PatchValueDto::Boolean(value) => PatchValue::Boolean(*value),
        PatchValueDto::Integer(value) => PatchValue::Integer(*value),
        PatchValueDto::Float(value) => PatchValue::Float(*value),
        PatchValueDto::String(value) => PatchValue::String(value.clone()),
        PatchValueDto::Sequence(items) => {
            PatchValue::Sequence(items.iter().map(patch_value).collect())
        }
        PatchValueDto::Mapping(entries) => PatchValue::Mapping(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), patch_value(value)))
                .collect(),
        ),
    }
}

/// Split each wire dot-path into segments. An empty path, or a path with an
/// empty segment, is a client bug rather than a key named "".
pub(crate) fn frontmatter_edits(
    edits: &[FrontmatterEditDto],
) -> Result<Vec<FrontmatterEdit>, ProtocolError> {
    let mut converted = Vec::with_capacity(edits.len());
    for edit in edits {
        let segments: Vec<String> = edit.key_path.split('.').map(str::to_string).collect();
        if segments.iter().any(String::is_empty) {
            return Err(ProtocolError {
                code: ErrorCode::InvalidRequest,
                message: format!("invalid frontmatter key path: {:?}", edit.key_path),
                supported_version: None,
                current_generation: None,
                current_revision: None,
            });
        }
        converted.push(FrontmatterEdit {
            key_path: segments,
            value: edit.value.as_ref().map(patch_value),
        });
    }
    Ok(converted)
}

pub(crate) fn link_rewrite_failures(
    failures: Vec<vault_index::LinkRewriteFailure>,
) -> Vec<LinkRewriteFailureDto> {
    failures
        .into_iter()
        .map(|failure| LinkRewriteFailureDto {
            path: failure.path.as_str().to_string(),
            reason: failure.reason,
        })
        .collect()
}
```

- [ ] **Step 8: Write the failing protocol-level dispatch test**

The ten arms below are the layer nothing has exercised yet: Steps 1–7 prove the *runtime* applies mutations, and prove the DTOs encode, but nothing yet proves a JSON line reaches the engine and comes back. Replacing ten arms with no test that crosses the transport would be a two-hundred-line change verified only by the compiler.

Append to `crates/vault-server/tests/mutations.rs` — reusing the `Daemon` harness introduced in Task 10 Step 5 is not possible yet, so this file grows its own minimal spawned-daemon helper:

```rust
mod daemon;

use daemon::Daemon;
use vault_protocol::{ErrorCode, Response, ResponseOutcome};

/// The dispatch layer, end to end: a JSON line in, a typed answer out, for a
/// write, a delete, and a raw read. Three operations rather than one because
/// they take three different response shapes — `MutationResponse`,
/// `GenerationResponse`, and the not-yet-wired raw pair — and a dispatch table
/// is exactly the kind of code where nine arms are right and the tenth is
/// pasted wrong.
#[test]
fn the_protocol_reaches_the_engine_for_a_write_a_delete_and_a_read() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let written = daemon.call(
        r#"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Two.md","content":"# Two\nOne\n","expected":{"absent":true}}}}"#,
    );
    let generation = match written.outcome {
        ResponseOutcome::Ok(Response::WriteNote(response)) => {
            assert_eq!(response.revision, vault_index::revision_of(b"# Two\nOne\n"));
            response.generation
        }
        other => panic!("write_note did not reach the engine: {other:?}"),
    };

    // Read-your-writes over the transport, not merely in-process: the note is
    // readable at the generation the write reported, with no refresh between.
    let read_back = daemon.call(r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"Two.md"}}}"#);
    match read_back.outcome {
        ResponseOutcome::Ok(Response::GetNote(response)) => {
            assert_eq!(response.generation, generation);
            assert_eq!(response.note.outgoing.len(), 1);
        }
        other => panic!("get_note failed: {other:?}"),
    }

    let deleted = daemon.call(
        r#"{"version":1,"id":"d","request":{"method":"delete_note","params":{"path":"Two.md","mode":"permanent","expected":{"any":true}}}}"#,
    );
    match deleted.outcome {
        ResponseOutcome::Ok(Response::DeleteNote(response)) => {
            assert!(response.generation >= generation);
        }
        other => panic!("delete_note did not reach the engine: {other:?}"),
    }
    assert!(!vault.path().join("Two.md").exists());

    // The raw pair is still the placeholder until Task 16, and it must refuse
    // in a typed way rather than pretend the zone rules are in place.
    let raw = daemon.call(r#"{"version":1,"id":"f","request":{"method":"read_file","params":{"path":"One.md"}}}"#);
    match raw.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::RuntimeNotReady),
        other => panic!("read_file must refuse until Task 16 wires it: {other:?}"),
    }
}

/// A precondition naming two fields is a client bug, and silently preferring
/// one would turn a typo into an unconditional overwrite. `convert::precondition`
/// is the only thing standing between that typo and a lost update, so it is
/// tested through the wire it guards.
#[test]
fn a_precondition_naming_two_fields_is_refused_before_anything_is_written() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    for params in [
        r#"{"path":"One.md","content":"x\n","expected":{"revision":"blake3:abc","any":true}}"#,
        r#"{"path":"One.md","content":"x\n","expected":{"absent":true,"any":true}}"#,
        r#"{"path":"One.md","content":"x\n","expected":{"any":false}}"#,
        r#"{"path":"One.md","content":"x\n","expected":{"absent":false}}"#,
    ] {
        let response = daemon.call(&format!(
            r#"{{"version":1,"id":"p","request":{{"method":"write_note","params":{params}}}}}"#
        ));
        match response.outcome {
            ResponseOutcome::Err(error) => assert_eq!(
                error.code,
                ErrorCode::InvalidRequest,
                "wrong code for {params}: {error:?}"
            ),
            other => panic!("{params} was not refused: {other:?}"),
        }
    }
    assert_eq!(
        std::fs::read(vault.path().join("One.md")).expect("read back"),
        b"# One\n",
        "a refused precondition must never have written"
    );
}
```

Create the shared helper `crates/vault-server/tests/daemon/mod.rs` — this is the one place the spawned-daemon harness is shared, because three later test files (`mutation_errors.rs`, `snapshots.rs`, `read_only.rs`) need exactly this and nothing more:

```rust
//! A spawned `vaultd` over stdio, for the tests that must cross the real
//! transport. Deliberately smaller than `tests/live_stdio.rs`'s harness: that
//! one classifies events as well as responses, and duplicating its `Line`
//! enum here would couple two suites' transport expectations together.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use tempfile::TempDir;
use vault_protocol::ResponseEnvelope;

pub const LINE_TIMEOUT: Duration = Duration::from_secs(20);

pub struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
}

impl Daemon {
    pub fn start(arguments: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start vaultd");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = child.stdout.take().expect("child stdout");
        let (sender, lines) = channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            lines,
            reader: Some(reader),
        }
    }

    /// A daemon over `vault` with its index in `index`, watcher and periodic
    /// tick off, so every generation in a test is one the test caused.
    pub fn for_vault(vault: &TempDir, index: &TempDir) -> Self {
        Self::start(&[
            "--vault",
            vault.path().to_str().expect("utf-8 vault path"),
            "--index",
            index
                .path()
                .join("index.sqlite3")
                .to_str()
                .expect("utf-8 index path"),
            "--no-watch",
            "--reconcile-interval-seconds",
            "0",
        ])
    }

    /// Send one request line and return the next *response*, skipping any
    /// events that interleave.
    pub fn call(&mut self, line: &str) -> ResponseEnvelope {
        {
            let stdin = self.stdin.as_mut().expect("stdin is open");
            writeln!(stdin, "{line}").expect("write a request");
            stdin.flush().expect("flush the request");
        }
        loop {
            let raw = match self.lines.recv_timeout(LINE_TIMEOUT) {
                Ok(raw) => raw,
                Err(RecvTimeoutError::Timeout) => panic!("no response within {LINE_TIMEOUT:?}"),
                Err(RecvTimeoutError::Disconnected) => panic!("the daemon closed its stdout"),
            };
            let value: serde_json::Value = serde_json::from_str(&raw).expect("a JSON line");
            if value
                .as_object()
                .is_some_and(|object| object.contains_key("outcome"))
            {
                return serde_json::from_str(&raw).expect("decode a response envelope");
            }
        }
    }

    /// Close stdin and wait. The daemon must exit rather than hang.
    pub fn disconnect(&mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        self.child.wait().expect("the daemon exits")
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
```

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test mutations
```

Expected: the two new tests **fail** — `write_note` and `delete_note` answer `runtime_not_ready` from Task 2 Step 7's placeholder arm, so `the_protocol_reaches_the_engine_…` panics on its first `match` and `a_precondition_naming_two_fields_…` gets `RuntimeNotReady` where it wants `InvalidRequest`. That failure is the point: it is the only thing that proves Step 9's arms are what make the difference.

- [ ] **Step 9: Replace the temporary dispatch arm with the ten real ones**

In `crates/vault-server/src/lib.rs`, add a helper on `Server`:

```rust
    /// Send one mutation to the coordinator and wait for it to be published.
    /// Every mutation arm below shares this, so "reconcile before you answer"
    /// is one decision rather than ten.
    fn mutate(&self, mutation: vault_index::Mutation) -> Result<MutationReport, ProtocolError> {
        let live = self
            .live
            .as_ref()
            .ok_or_else(|| runtime_not_ready("no vault is configured, so there is no runtime"))?;
        live.handle.mutate(mutation).map_err(convert::mutation_failure)
    }

    /// The generation a mutation response reports. `None` means nothing has
    /// ever been committed, which a client cannot act on — every mutation
    /// that reaches a running runtime has a generation, so this is a
    /// last-resort refusal rather than a shape a caller must handle.
    fn mutation_generation(report: &MutationReport) -> Result<u64, ProtocolError> {
        report
            .generation
            .map(vault_index::Generation::get)
            .ok_or_else(index_unavailable)
    }
```

then replace Task 2 Step 7's single `|`-joined placeholder arm with these ten real ones, leaving the four snapshot variants and the raw pair still joined in a placeholder of their own:

```rust
            Request::WriteNote(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match convert::precondition(params.expected.as_ref()) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(expected) => match self.mutate(vault_index::Mutation::WriteNote {
                        path,
                        content: params.content,
                        expected,
                    }) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(report) => match Self::mutation_generation(&report) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(generation) => ResponseEnvelope::success(
                                id,
                                Response::WriteNote(MutationResponse {
                                    generation,
                                    revision: report.revision.unwrap_or_default(),
                                }),
                            ),
                        },
                    },
                },
            },
            Request::CreateFolder(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match self.mutate(vault_index::Mutation::CreateFolder { path }) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(report) => match Self::mutation_generation(&report) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(generation) => ResponseEnvelope::success(
                            id,
                            Response::CreateFolder(GenerationResponse { generation }),
                        ),
                    },
                },
            },
            Request::RenameNote(params) => {
                match (parse_path(&params.from), parse_path(&params.to)) {
                    (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                    (Ok(from), Ok(to)) => match convert::precondition(params.expected.as_ref()) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(expected) => match self.mutate(vault_index::Mutation::RenameNote {
                            from,
                            to,
                            expected,
                            rewrite_links: params.rewrite_links,
                        }) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(report) => match Self::mutation_generation(&report) {
                                Err(error) => ResponseEnvelope::error(id, error),
                                Ok(generation) => ResponseEnvelope::success(
                                    id,
                                    Response::RenameNote(RenameResponse {
                                        generation,
                                        revision: report.revision.clone(),
                                        links_rewritten: report.links_rewritten,
                                        link_rewrite_failures: convert::link_rewrite_failures(
                                            report.link_rewrite_failures,
                                        ),
                                    }),
                                ),
                            },
                        },
                    },
                }
            }
            Request::RenameFolder(params) => {
                match (parse_path(&params.from), parse_path(&params.to)) {
                    (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                    (Ok(from), Ok(to)) => match self.mutate(vault_index::Mutation::RenameFolder {
                        from,
                        to,
                        rewrite_links: params.rewrite_links,
                    }) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(report) => match Self::mutation_generation(&report) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(generation) => ResponseEnvelope::success(
                                id,
                                Response::RenameFolder(RenameResponse {
                                    generation,
                                    revision: report.revision.clone(),
                                    links_rewritten: report.links_rewritten,
                                    link_rewrite_failures: convert::link_rewrite_failures(
                                        report.link_rewrite_failures,
                                    ),
                                }),
                            ),
                        },
                    },
                }
            }
            Request::CopyFile(params) => match (parse_path(&params.from), parse_path(&params.to)) {
                (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                (Ok(from), Ok(to)) => match convert::precondition(params.expected_source.as_ref()) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(expected_source) => match self.mutate(vault_index::Mutation::CopyFile {
                        from,
                        to,
                        expected_source,
                        if_exists: convert::copy_conflict(params.if_exists),
                    }) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(report) => match Self::mutation_generation(&report) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(generation) => ResponseEnvelope::success(
                                id,
                                Response::CopyFile(MutationResponse {
                                    generation,
                                    revision: report.revision.unwrap_or_default(),
                                }),
                            ),
                        },
                    },
                },
            },
            Request::DeleteNote(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match convert::precondition(params.expected.as_ref()) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(expected) => match self.mutate(vault_index::Mutation::DeleteNote {
                        path,
                        mode: params.mode.map(convert::delete_mode),
                        expected,
                    }) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(report) => match Self::mutation_generation(&report) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(generation) => ResponseEnvelope::success(
                                id,
                                Response::DeleteNote(GenerationResponse { generation }),
                            ),
                        },
                    },
                },
            },
            Request::DeleteFolder(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match self.mutate(vault_index::Mutation::DeleteFolder {
                    path,
                    mode: params.mode.map(convert::delete_mode),
                    recursive: params.recursive,
                }) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok(report) => match Self::mutation_generation(&report) {
                        Err(error) => ResponseEnvelope::error(id, error),
                        Ok(generation) => ResponseEnvelope::success(
                            id,
                            Response::DeleteFolder(GenerationResponse { generation }),
                        ),
                    },
                },
            },
            Request::PatchFrontmatter(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match (
                    convert::precondition(params.expected.as_ref()),
                    convert::frontmatter_edits(&params.patch),
                ) {
                    (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                    (Ok(expected), Ok(patch)) => {
                        match self.mutate(vault_index::Mutation::PatchFrontmatter {
                            path,
                            patch,
                            expected,
                        }) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(report) => match Self::mutation_generation(&report) {
                                Err(error) => ResponseEnvelope::error(id, error),
                                Ok(generation) => ResponseEnvelope::success(
                                    id,
                                    Response::PatchFrontmatter(MutationResponse {
                                        generation,
                                        revision: report.revision.unwrap_or_default(),
                                    }),
                                ),
                            },
                        }
                    }
                },
            },
            // The raw pair lands in Task 16; until then it refuses rather
            // than pretending the zone rules are in place.
            Request::WriteFile(_) | Request::ReadFile(_) => ResponseEnvelope::error(
                id,
                runtime_not_ready("raw file operations are not wired yet"),
            ),
```

- [ ] **Step 10: Run the dispatch test and watch it pass**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test mutations
```

Expected: all eight tests pass — the six from Step 1 and the two from Step 8. Between them, Step 7's mapping table is no longer unexercised: `a_precondition_naming_two_fields_is_refused_before_anything_is_written` drives four requests through `convert::precondition` into `ErrorCode::InvalidRequest`, and Task 16's `mutation_errors.rs` covers the seven state-conflict codes once every operation that can produce them exists.

- [ ] **Step 11: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/live_reconcile.rs crates/vault-index/src/reconcile.rs \
        crates/vault-protocol/src/events.rs \
        crates/vault-server/src/runtime.rs crates/vault-server/src/subscriptions.rs \
        crates/vault-server/src/convert.rs crates/vault-server/src/lib.rs \
        crates/vault-server/tests/mutations.rs crates/vault-server/tests/daemon/mod.rs
git commit -m "feat(server): apply mutations on the coordinator and publish before answering"
```

---

### Task 10: Compare-and-swap races through the real daemon

The claim is narrow and worth proving at the process level: two writers racing on one path produce exactly one winner, one typed `revision_conflict`, and never a lost update.

**Files:**

- Create: `crates/vault-server/tests/mutation_races.rs`
- Modify: `crates/vault-index/src/test_hook.rs` (`HookPoint`)
- Modify: `crates/vault-index/src/mutate.rs` (one hook call)
- Modify: `crates/vault-index/src/reconcile.rs` (hook plumbing)
- Create: `crates/vault-index/tests/mutation_races.rs`

**Interfaces:**

- Consumes: `RuntimeHandle::mutate` (Task 9), the daemon harness pattern in `crates/vault-server/tests/live_stdio.rs` (its `Daemon` helper), the `Rendezvous`/`TestHook` machinery in `crates/vault-index/tests/common/mod.rs` and `crates/vault-index/src/test_hook.rs`.
- Produces: `HookPoint::AfterMutationPrecondition` — the one window a test cannot otherwise force.
- Produces: no new production API.

- [ ] **Step 1: Write the failing in-process race test**

Create `crates/vault-index/tests/mutation_races.rs`:

```rust
//! A forced compare-and-swap race, made to open rather than waited for: the
//! second writer commits while the first is parked between its precondition
//! check and its write.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    HookPoint, IndexConfig, IndexError, IndexService, Mutation, MutationError, Precondition,
    TestHook, revision_of,
};

struct Once {
    point: HookPoint,
    fired: AtomicBool,
    action: Box<dyn Fn() + Send + Sync>,
}

impl TestHook for Once {
    fn reach(&self, point: HookPoint) {
        if point != self.point {
            return;
        }
        if self.fired.swap(true, Ordering::SeqCst) {
            return;
        }
        (self.action)();
    }
}

#[test]
fn a_writer_parked_after_its_precondition_still_loses_to_the_writer_that_committed() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("race config");
    let mut service = IndexService::open(config).expect("race service");
    service.refresh(false).expect("cold build");

    // The interloper writes between the parked writer's precondition check
    // and its own write. On a real daemon this is another process; here it is
    // a plain filesystem write, which is the same thing from the engine's
    // point of view.
    let interloper_root = root.clone();
    service.install_test_hook(Arc::new(Once {
        point: HookPoint::AfterMutationPrecondition,
        fired: AtomicBool::new(false),
        action: Box::new(move || {
            std::fs::write(interloper_root.join("One.md"), "# interloper\n")
                .expect("the interloper writes");
        }),
    }));

    let error = service
        .apply_mutation(&Mutation::WriteNote {
            path: VaultPath::new("One.md").expect("valid vault path"),
            content: "# parked writer\n".into(),
            expected: Precondition::Revision(revision_of(b"# One\n")),
        })
        .expect_err("the parked writer must re-check and lose");
    assert!(
        matches!(
            error,
            IndexError::Mutation(MutationError::RevisionConflict { .. })
        ),
        "expected a revision conflict, got {error:?}"
    );
    assert_eq!(
        std::fs::read(root.join("One.md")).expect("read back"),
        b"# interloper\n",
        "the interloper's bytes must survive; a lost update is the one forbidden outcome"
    );
}

#[test]
fn an_unconditional_writer_parked_at_the_same_point_still_wins_last() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("race config");
    let mut service = IndexService::open(config).expect("race service");
    service.refresh(false).expect("cold build");

    let interloper_root = root.clone();
    service.install_test_hook(Arc::new(Once {
        point: HookPoint::AfterMutationPrecondition,
        fired: AtomicBool::new(false),
        action: Box::new(move || {
            std::fs::write(interloper_root.join("One.md"), "# interloper\n")
                .expect("the interloper writes");
        }),
    }));

    service
        .apply_mutation(&Mutation::WriteNote {
            path: VaultPath::new("One.md").expect("valid vault path"),
            content: "# unconditional\n".into(),
            expected: Precondition::Any,
        })
        .expect("an unconditional write does not care who wrote last");
    assert_eq!(
        std::fs::read(root.join("One.md")).expect("read back"),
        b"# unconditional\n",
        "`any` is documented as last-writer-wins, and must behave that way"
    );
}

#[test]
fn a_refused_write_never_leaves_a_temporary_file_behind() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("race config");
    let mut service = IndexService::open(config).expect("race service");
    service.refresh(false).expect("cold build");

    let _ = service.apply_mutation(&Mutation::WriteNote {
        path: VaultPath::new("One.md").expect("valid vault path"),
        content: "# refused\n".into(),
        expected: Precondition::Revision("blake3:0000".into()),
    });
    let names: Vec<String> = std::fs::read_dir(&root)
        .expect("read the vault root")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(names, vec!["One.md".to_string()], "{names:?}");
}
```

- [ ] **Step 2: Run the focused test and observe the missing hook point**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_races
```

Expected: compilation fails — `HookPoint::AfterMutationPrecondition` does not exist. `a_refused_write_never_leaves_a_temporary_file_behind` would pass today; it is here so the temp-file guarantee stays covered when the hook lands.

- [ ] **Step 3: Add the hook point and re-check the precondition after it**

In `crates/vault-index/src/test_hook.rs`, add to `HookPoint`:

```rust
    /// A mutation's precondition has been satisfied and its bytes have not
    /// been written yet. Writing the same path from here — as another process
    /// would — is what makes the compare-and-swap's re-check deterministic
    /// instead of a matter of timing.
    AfterMutationPrecondition,
```

In `crates/vault-index/src/mutate.rs`, give `MutationEngine` an optional hook and fire it between the check and the write:

```rust
    /// Test-only rendezvous. Production leaves it empty and pays one
    /// `Option` check per write.
    hook: Option<std::sync::Arc<dyn crate::TestHook>>,
```

with `hook: None` in `new`, plus:

```rust
    #[doc(hidden)]
    pub fn with_test_hook(mut self, hook: std::sync::Arc<dyn crate::TestHook>) -> Self {
        self.hook = Some(hook);
        self
    }

    fn reach(&self, point: crate::HookPoint) {
        if let Some(hook) = &self.hook {
            hook.reach(point);
        }
    }

    /// Re-read the target and require the precondition to still hold.
    ///
    /// The first check happens before any work; this one happens immediately
    /// before the write, so a writer that lost the race in between refuses
    /// rather than clobbering. Both checks are cheap — one read of a file
    /// already in the page cache — and the second is what makes
    /// "never a lost update" true rather than likely.
    fn recheck(&self, path: &VaultPath, expected: &Precondition) -> Result<(), MutationError> {
        self.reach(crate::HookPoint::AfterMutationPrecondition);
        self.check(path, expected)?;
        Ok(())
    }
```

Call `self.recheck(path, expected)?;` immediately before `write_atomically` in `write_note`, `patch_frontmatter`, and (against `expected_source`, on the source path) `copy_file`.

In `crates/vault-index/src/reconcile.rs`, extend `install_test_hook` so the engine gets it too:

```rust
    pub fn install_test_hook(&mut self, hook: std::sync::Arc<dyn crate::TestHook>) {
        self.engine = self.engine.clone().with_test_hook(std::sync::Arc::clone(&hook));
        self.test_hook = Some(hook);
    }
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_races
```

Expected: all three tests pass.

- [ ] **Step 5: Write the daemon-level race test**

Create `crates/vault-server/tests/mutation_races.rs`. It carries its **own** `Daemon` and `LINE_TIMEOUT` rather than using either the shipped `tests/live_stdio.rs` harness or Task 9's shared `tests/daemon/mod.rs`, and the reason is specific to this suite: a race test sends **two requests before reading either response**, which neither of those `call`-shaped helpers can express — both write one line and block for its answer. Do **not** copy `live_stdio.rs`'s `Line` enum: that file classifies events as well as responses, and the version below skips events with an inline check instead, so `Line` would be dead code here.

```rust
//! Two racing writers through the real `vaultd` process. Exactly one wins,
//! the loser is told precisely why, and the file holds one of the two
//! payloads whole.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use tempfile::TempDir;
use vault_protocol::{ErrorCode, ResponseEnvelope, ResponseOutcome};

const LINE_TIMEOUT: Duration = Duration::from_secs(20);

struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
}

impl Daemon {
    fn start(arguments: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start vaultd");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = child.stdout.take().expect("child stdout");
        let (sender, lines) = channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            lines,
            reader: Some(reader),
        }
    }

    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        writeln!(stdin, "{line}").expect("write a request");
        stdin.flush().expect("flush the request");
    }

    /// The next *response* line, skipping any events that interleave.
    fn response(&mut self) -> ResponseEnvelope {
        loop {
            let raw = match self.lines.recv_timeout(LINE_TIMEOUT) {
                Ok(raw) => raw,
                Err(RecvTimeoutError::Timeout) => panic!("no response within {LINE_TIMEOUT:?}"),
                Err(RecvTimeoutError::Disconnected) => panic!("the daemon closed its stdout"),
            };
            let value: serde_json::Value = serde_json::from_str(&raw).expect("a JSON line");
            if value
                .as_object()
                .is_some_and(|object| object.contains_key("outcome"))
            {
                return serde_json::from_str(&raw).expect("decode a response envelope");
            }
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

#[test]
fn two_writers_racing_on_one_note_produce_one_winner_and_one_typed_conflict() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    let index_path = index.path().join("index.sqlite3");

    let mut daemon = Daemon::start(&[
        "--vault",
        vault.path().to_str().expect("utf-8 vault path"),
        "--index",
        index_path.to_str().expect("utf-8 index path"),
        "--no-watch",
        "--reconcile-interval-seconds",
        "0",
    ]);

    daemon.send(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.response();

    daemon.send(r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"One.md"}}}"#);
    let note = daemon.response();
    let revision = match note.outcome {
        ResponseOutcome::Ok(vault_protocol::Response::GetNote(response)) => response.note.revision,
        other => panic!("expected a note, got {other:?}"),
    };

    // Both writes name the same expected revision. Only one can be true by
    // the time the second is applied, and the daemon applies them in mailbox
    // order on one thread.
    daemon.send(&format!(
        r#"{{"version":1,"id":"w1","request":{{"method":"write_note","params":{{"path":"One.md","content":"# first\n","expected":{{"revision":"{revision}"}}}}}}}}"#
    ));
    daemon.send(&format!(
        r#"{{"version":1,"id":"w2","request":{{"method":"write_note","params":{{"path":"One.md","content":"# second\n","expected":{{"revision":"{revision}"}}}}}}}}"#
    ));

    let first = daemon.response();
    let second = daemon.response();
    let outcomes = [first.outcome, second.outcome];
    let winners = outcomes
        .iter()
        .filter(|outcome| matches!(outcome, ResponseOutcome::Ok(_)))
        .count();
    assert_eq!(winners, 1, "exactly one writer may win: {outcomes:?}");

    let conflict = outcomes
        .iter()
        .find_map(|outcome| match outcome {
            ResponseOutcome::Err(error) => Some(error),
            ResponseOutcome::Ok(_) => None,
        })
        .expect("the loser must be told");
    assert_eq!(conflict.code, ErrorCode::RevisionConflict);
    assert!(
        conflict.current_revision.is_some(),
        "the loser needs the revision it should retry against"
    );

    let bytes = std::fs::read(vault.path().join("One.md")).expect("read back");
    assert!(
        bytes == b"# first\n" || bytes == b"# second\n",
        "the file must hold one payload whole, not a blend: {bytes:?}"
    );
}

#[test]
fn a_create_that_loses_its_race_reports_the_revision_that_beat_it() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("Seed.md"), "# Seed\n").expect("write Seed");
    let index_path = index.path().join("index.sqlite3");

    let mut daemon = Daemon::start(&[
        "--vault",
        vault.path().to_str().expect("utf-8 vault path"),
        "--index",
        index_path.to_str().expect("utf-8 index path"),
        "--no-watch",
        "--reconcile-interval-seconds",
        "0",
    ]);
    daemon.send(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.response();

    daemon.send(
        r#"{"version":1,"id":"c1","request":{"method":"write_note","params":{"path":"New.md","content":"# first\n","expected":{"absent":true}}}}"#,
    );
    daemon.send(
        r#"{"version":1,"id":"c2","request":{"method":"write_note","params":{"path":"New.md","content":"# second\n","expected":{"absent":true}}}}"#,
    );
    let first = daemon.response();
    let second = daemon.response();
    assert!(matches!(first.outcome, ResponseOutcome::Ok(_)));
    match second.outcome {
        ResponseOutcome::Err(error) => {
            assert_eq!(error.code, ErrorCode::RevisionConflict);
            assert!(error.current_revision.is_some());
        }
        other => panic!("the second create must lose: {other:?}"),
    }
    assert_eq!(
        std::fs::read(vault.path().join("New.md")).expect("read back"),
        b"# first\n"
    );
}
```

- [ ] **Step 6: Run the daemon race test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test mutation_races
```

Expected: both tests pass.

- [ ] **Step 7: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/test_hook.rs crates/vault-index/src/mutate.rs \
        crates/vault-index/src/reconcile.rs crates/vault-index/tests/mutation_races.rs \
        crates/vault-server/tests/mutation_races.rs
git commit -m "test(index): prove compare-and-swap races never lose an update"
```

---

### Task 11: Mutations in the randomized equivalence oracle

The claim the oracle already checks — indexed state equals a fresh `scan_vault` after every batch — becomes the claim that matters most here: **a mutation and an external edit must be indistinguishable to the semantic layer.** The alphabet grows; nothing else about the oracle changes.

**Files:**

- Modify: `crates/vault-index/tests/live_oracle.rs` (`Operation` at line 74 — seven variants, `Write` through `RestoreUtf8`; `apply` lines 144–194; `Oracle` lines 200–367; `operation()` lines 421–432; `INTERESTING_STATES` lines 649–658)
- Create: `crates/vault-server/tests/mutation_oracle.rs`

**Interfaces:**

- Consumes: `MutationEngine::apply`, `Mutation`, `Precondition`, `PatchValue`, `FrontmatterEdit` (Tasks 4–8); `ChangeCause::Mutation` (Task 9); the `Daemon` harness pattern (Task 10).
- Produces: no production API. This task adds coverage only.

- [ ] **Step 1: Add mutation operations to the oracle's alphabet**

In `crates/vault-index/tests/live_oracle.rs`, extend `Operation`:

```rust
    /// The same content change as `Write`, routed through the mutation
    /// engine instead of `std::fs`. The oracle's whole point here: the
    /// semantic layer must not be able to tell the two apart.
    MutateWrite { path: String, body: String },
    MutateDelete { path: String },
    MutateRename { from: String, to: String },
    MutatePatch { path: String, value: Option<String> },
```

Change `apply` to take the engine and add the four arms:

```rust
fn apply(
    root: &Path,
    engine: &vault_index::MutationEngine,
    operation: &Operation,
) -> BTreeSet<VaultPath> {
```

```rust
        Operation::MutateWrite { path, body } => {
            let vault_path = VaultPath::new(path).expect("valid vault path");
            // The generator picks freely, so a create into a folder that does
            // not exist yet is expected and is not a failure: the refusal
            // leaves the vault untouched, and the batch still has to
            // reconcile to a scan-equivalent state.
            if let Some(parent) = std::path::Path::new(path).parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(root.join(parent)).expect("create parent directory");
                }
            }
            let _ = engine.apply(&vault_index::Mutation::WriteNote {
                path: vault_path,
                content: body.clone(),
                expected: vault_index::Precondition::Any,
            });
            touch(path, &mut touched);
        }
        Operation::MutateDelete { path } => {
            let _ = engine.apply(&vault_index::Mutation::DeleteNote {
                path: VaultPath::new(path).expect("valid vault path"),
                mode: Some(vault_index::DeleteMode::Permanent),
                expected: vault_index::Precondition::Any,
            });
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
                let _ = engine.apply(&vault_index::Mutation::RenameNote {
                    from: VaultPath::new(from).expect("valid vault path"),
                    to: VaultPath::new(to).expect("valid vault path"),
                    expected: vault_index::Precondition::Any,
                    // Repair is exercised by `tests/rename_repair.rs`; here
                    // the claim is that a moved file reconciles exactly like
                    // an externally moved one.
                    rewrite_links: false,
                });
            }
            touch(from, &mut touched);
            touch(to, &mut touched);
        }
        Operation::MutatePatch { path, value } => {
            let _ = engine.apply(&vault_index::Mutation::PatchFrontmatter {
                path: VaultPath::new(path).expect("valid vault path"),
                patch: vec![vault_index::FrontmatterEdit {
                    key_path: vec!["title".to_string()],
                    value: value
                        .clone()
                        .map(vault_index::PatchValue::String),
                }],
                expected: vault_index::Precondition::Any,
            });
            touch(path, &mut touched);
        }
```

Add to the `Oracle` struct a `engine: vault_index::MutationEngine` field, built in `open_with` as
`vault_index::MutationEngine::new(root.canonicalize().expect("canonical vault root"))`, and pass
`&self.engine` at both `apply` call sites (`run_batch` and
`the_generators_reach_every_interesting_state`).

In `run_batch`, choose the cause from the batch:

```rust
        let cause = if batch.iter().any(|operation| {
            matches!(
                operation,
                Operation::MutateWrite { .. }
                    | Operation::MutateDelete { .. }
                    | Operation::MutateRename { .. }
                    | Operation::MutatePatch { .. }
            )
        }) {
            ChangeCause::Mutation
        } else {
            ChangeCause::Watcher
        };
        let report = self
            .service
            .refresh_paths(touched, cause)
            .map_err(|error| TestCaseError::fail(format!("targeted refresh failed: {error}")))?;
```

Extend the generator:

```rust
        3 => (slot(), body()).prop_map(|(path, body)| Operation::MutateWrite { path, body }),
        2 => slot().prop_map(|path| Operation::MutateDelete { path }),
        1 => (slot(), slot()).prop_map(|(from, to)| Operation::MutateRename { from, to }),
        1 => (slot(), prop::option::of("[a-z]{1,6}"))
            .prop_map(|(path, value)| Operation::MutatePatch { path, value }),
```

- [ ] **Step 2: Run the oracle and confirm nothing diverges**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test live_oracle
```

Expected: every existing oracle test still passes with mutations in the alphabet. A failure here is the real thing this task exists to catch: a mutation that leaves the vault in a state the reconciler cannot reproduce from a fresh scan.

- [ ] **Step 3: Add a mutation-specific reachability claim**

In `crates/vault-index/tests/live_oracle.rs`, extend `INTERESTING_STATES`:

```rust
    "a note is written through the mutation engine",
    "a note is deleted through the mutation engine",
    "frontmatter is patched through the mutation engine",
```

and record them inside `the_generators_reach_every_interesting_state`'s per-operation loop, before `apply` runs:

```rust
                Operation::MutateWrite { .. } => {
                    reached.insert("a note is written through the mutation engine");
                    apply(&root, &engine, operation);
                }
                Operation::MutateDelete { path } => {
                    if root.join(path).is_file() {
                        reached.insert("a note is deleted through the mutation engine");
                    }
                    apply(&root, &engine, operation);
                }
                Operation::MutatePatch { path, .. } => {
                    if root.join(path).is_file() {
                        reached.insert("frontmatter is patched through the mutation engine");
                    }
                    apply(&root, &engine, operation);
                }
```

That test builds its own scratch vault, so give it its own engine:

```rust
    let engine = vault_index::MutationEngine::new(root.canonicalize().expect("canonical root"));
```

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test live_oracle
```

Expected: `the_generators_reach_every_interesting_state` passes with the three new states reached.

- [ ] **Step 4: Write the protocol-routed scenario against the real daemon**

Create `crates/vault-server/tests/mutation_oracle.rs`. It runs the scripted scenario **through the protocol** and compares the daemon's answers against a fresh `scan_vault` of the same vault after every step — the same claim the in-process oracle checks, paid for once per step instead of once per proptest case (a spawned daemon per case would make the randomized sweep unusably slow, so the randomized half stays in-process and the protocol half is scripted):

```rust
//! The equivalence claim, routed through the real protocol: after every
//! batch of protocol mutations, what the daemon answers equals what a clean
//! `scan_vault` of the same vault would answer.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use tempfile::TempDir;
use vault_core::{FileSystemVaultSource, Resolution, VaultPath, scan_vault};
use vault_protocol::{Response, ResponseEnvelope, ResponseOutcome};

const LINE_TIMEOUT: Duration = Duration::from_secs(20);

struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
    next_id: u64,
}

impl Daemon {
    fn start(arguments: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vaultd"))
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start vaultd");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = child.stdout.take().expect("child stdout");
        let (sender, lines) = channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            lines,
            reader: Some(reader),
            next_id: 0,
        }
    }

    fn call(&mut self, method: &str, params: &str) -> ResponseEnvelope {
        self.next_id += 1;
        let id = format!("id-{}", self.next_id);
        let line = format!(
            r#"{{"version":1,"id":"{id}","request":{{"method":"{method}","params":{params}}}}}"#
        );
        {
            let stdin = self.stdin.as_mut().expect("stdin is open");
            writeln!(stdin, "{line}").expect("write a request");
            stdin.flush().expect("flush the request");
        }
        loop {
            let raw = match self.lines.recv_timeout(LINE_TIMEOUT) {
                Ok(raw) => raw,
                Err(RecvTimeoutError::Timeout) => panic!("no response to {method} within {LINE_TIMEOUT:?}"),
                Err(RecvTimeoutError::Disconnected) => panic!("the daemon closed its stdout"),
            };
            let value: serde_json::Value = serde_json::from_str(&raw).expect("a JSON line");
            let is_response = value
                .as_object()
                .is_some_and(|object| object.get("id").map(|value| value == &serde_json::Value::String(id.clone())).unwrap_or(false));
            if is_response {
                return serde_json::from_str(&raw).expect("decode a response envelope");
            }
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

/// Every note the daemon reports, with its revision and its outgoing
/// resolution targets — the shape a fresh scan can be compared against
/// without re-deriving spans.
fn daemon_state(daemon: &mut Daemon) -> Vec<(String, String, Vec<String>)> {
    let mut paths = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(cursor) => format!(r#"{{"cursor":"{cursor}","limit":50}}"#),
            None => r#"{"limit":50}"#.to_string(),
        };
        let response = daemon.call("list_notes", &params);
        let page = match response.outcome {
            ResponseOutcome::Ok(Response::ListNotes(page)) => page,
            other => panic!("list_notes failed: {other:?}"),
        };
        paths.extend(page.items.into_iter().map(|item| item.path));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    let mut state = Vec::new();
    for path in paths {
        let response = daemon.call("get_note", &format!(r#"{{"path":"{path}"}}"#));
        let note = match response.outcome {
            ResponseOutcome::Ok(Response::GetNote(response)) => response.note,
            other => panic!("get_note failed for {path}: {other:?}"),
        };
        let targets = note
            .outgoing
            .iter()
            .map(|reference| format!("{:?}", reference.resolution))
            .collect();
        state.push((note.path, note.revision, targets));
    }
    state
}

/// The same shape from a clean scan of the same directory.
fn scanned_state(root: &std::path::Path) -> Vec<(String, String, Vec<String>)> {
    let source = FileSystemVaultSource::new(root).expect("scan source");
    let report = scan_vault(&source).expect("scan the vault");
    let mut state = Vec::new();
    for path in report.graph.note_paths() {
        let note = report.graph.note(path).expect("a scanned note");
        let targets = report
            .graph
            .outgoing(path)
            .iter()
            .map(|resolved| {
                // Formatted rather than compared structurally, because the
                // wire DTO and the core enum are different types describing
                // the same answer; the formatting is what makes them
                // comparable without a second conversion layer in the test.
                match &resolved.resolution {
                    Resolution::Resolved { target, subpath } => {
                        format!("Resolved {{ target: \"{}\", subpath: {subpath:?} }}", target.as_str())
                    }
                    other => format!("{other:?}"),
                }
            })
            .collect();
        state.push((
            path.as_str().to_string(),
            note.source.revision().as_str().to_string(),
            targets,
        ));
    }
    state
}

#[test]
fn every_protocol_mutation_leaves_the_daemon_equivalent_to_a_fresh_scan() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::write(root.join("Seed.md"), "# Seed\nAlpha\nNowhere\n").expect("write Seed");
    std::fs::write(root.join("Alpha.md"), "# Heading\n\ntext ^block\n").expect("write Alpha");

    let index_path = index.path().join("index.sqlite3");
    let mut daemon = Daemon::start(&[
        "--vault",
        root.to_str().expect("utf-8 vault path"),
        "--index",
        index_path.to_str().expect("utf-8 index path"),
        "--no-watch",
        "--reconcile-interval-seconds",
        "0",
    ]);
    daemon.call("refresh_index", "{}");

    // Every operation in the mutation surface, in an order that walks a note
    // through creation, reference, patching, folder moves, copying, and
    // deletion — each step followed by the same equivalence check.
    let steps: Vec<(&str, String)> = vec![
        (
            "write_note",
            r#"{"path":"Beta.md","content":"# Beta\nAlpha#Heading\n","expected":{"absent":true}}"#.to_string(),
        ),
        ("create_folder", r#"{"path":"Nested"}"#.to_string()),
        (
            "write_note",
            r#"{"path":"Nested/Gamma.md","content":"# Gamma\nBeta\n","expected":{"absent":true}}"#.to_string(),
        ),
        (
            "patch_frontmatter",
            r#"{"path":"Beta.md","patch":[{"key_path":"title","value":"Titled"}],"expected":{"any":true}}"#.to_string(),
        ),
        (
            "copy_file",
            r#"{"from":"Beta.md","to":"Nested/Beta.md","expected_source":{"any":true},"if_exists":"error"}"#.to_string(),
        ),
        (
            "rename_note",
            r#"{"from":"Nested/Gamma.md","to":"Nested/Delta.md","expected":{"any":true},"rewrite_links":true}"#.to_string(),
        ),
        (
            "delete_note",
            r#"{"path":"Nested/Beta.md","mode":"permanent","expected":{"any":true}}"#.to_string(),
        ),
        (
            "rename_folder",
            r#"{"from":"Nested","to":"Moved","rewrite_links":true}"#.to_string(),
        ),
        (
            "delete_folder",
            r#"{"path":"Moved","mode":"permanent","recursive":true}"#.to_string(),
        ),
    ];

    for (method, params) in steps {
        let response = daemon.call(method, &params);
        assert!(
            matches!(response.outcome, ResponseOutcome::Ok(_)),
            "{method} {params} failed: {:?}",
            response.outcome
        );
        assert_eq!(
            daemon_state(&mut daemon),
            scanned_state(&root),
            "the daemon diverged from a fresh scan after {method} {params}"
        );
    }
}
```

- [ ] **Step 5: Run the protocol oracle and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test mutation_oracle
```

Expected: the test passes. It depends on Task 12's rename repair for the two `rewrite_links: true` steps, so if it is run before Task 12 lands, those two steps still pass (repair is a no-op) and the equivalence check still holds.

- [ ] **Step 6: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/tests/live_oracle.rs crates/vault-server/tests/mutation_oracle.rs
git commit -m "test(index): route mutation batches through the equivalence oracle"
```

---

### Task 12: Rename link repair

The two-tier mechanism the design states precisely, because v1's wording pointed implementers at the wrong layer: **the live graph answers *which* references target the renamed note** (IDs only — the compact graph deliberately stores no spans and no spellings); **the durable SQL layer supplies *how to rewrite each one*** (`note_references.raw_target`, `note_references.target_span`, and `notes.source_bytes`).

**Ordering is load-bearing.** Referencing notes are rewritten **first**, the file moves **last**. A crash mid-burst therefore leaves some references pointing at the new path of a note still sitting at the old one — visible as unresolved references that self-heal when the client retries the rename — and never the reverse, which would be a moved note with stale inbound links that *look* resolved but are not.

**Files:**

- Create: `crates/vault-index/src/mutate/rename.rs`
- Modify: `crates/vault-index/src/mutate.rs` (`preflight_rename`, module declaration)
- Modify: `crates/vault-index/src/reconcile.rs` (`apply_mutation` dispatch)
- Modify: `crates/vault-index/src/test_hook.rs` (`HookPoint`)
- Create: `crates/vault-index/tests/rename_repair.rs`

**Interfaces:**

- Consumes: `LiveGraph::{dependents, note, note_path, note_paths}`, `vault_core::{changed_candidate_keys, ResolutionIdentityChange, ResolutionNote, Resolver, LinkTarget, Resolution}`, `IndexStore::{load_note, load_outgoing_by_ordinal}`, `IndexService::published_graph`, `MutationEngine::{current_revision, resolve, rename_paths}`, `write_atomically` (Tasks 4–7).
- Produces: `pub(crate) fn plan_repair(graph: &LiveGraph, store: &IndexStore, engine: &MutationEngine, moves: &BTreeMap<VaultPath, VaultPath>) -> Result<Repair, IndexError>`.
- Produces: `pub(crate) struct Repair { pub(crate) rewrites: Vec<Rewrite>, pub(crate) failures: Vec<LinkRewriteFailure> }` and `pub(crate) struct Rewrite { pub(crate) path: VaultPath, pub(crate) patched: String, pub(crate) links: u64 }` — crate-visible fields on a crate-visible type, matching the code below; neither is `pub`, and neither leaves `vault-index`.
- Produces: `IndexService::rename_with_repair` (private), and `IndexService::apply_mutation`'s read-only preflight.
- Produces: `MutationEngine::preflight_rename(&self, from: &VaultPath, to: &VaultPath) -> Result<(), MutationError>`.
- Produces: `HookPoint::BeforeRenameMove`.
- Produces: `IndexService::apply_mutation` now handles `rewrite_links: true` itself.

- [ ] **Step 1: Write the failing repair fixture test**

Create `crates/vault-index/tests/rename_repair.rs`:

```rust
//! Rename link repair: spelling-preserving, per-file compare-and-swap,
//! referrers rewritten before the file moves.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    HookPoint, IndexConfig, IndexService, Mutation, Precondition, TestHook, revision_of,
};

struct Fixture {
    service: IndexService,
    root: PathBuf,
    _vault: TempDir,
    _index: TempDir,
}

/// `Alpha.md` is referenced five ways: shortest form, with extension, by
/// full path, with a heading subpath and display text, and relatively from a
/// sibling folder. Every one of them must survive a rename with its own
/// shape intact.
fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Nested")).expect("create Nested");
    std::fs::write(root.join("Alpha.md"), "# Heading\n\ntext ^block\n").expect("write Alpha");
    std::fs::write(root.join("Short.md"), "before Alpha after\n").expect("write Short");
    std::fs::write(root.join("Extended.md"), "Alpha.md\n").expect("write Extended");
    std::fs::write(root.join("Explicit.md"), "Alpha and shown\n")
        .expect("write Explicit");
    std::fs::write(root.join("Nested/Relative.md"), "../Alpha\n").expect("write Relative");
    std::fs::write(root.join("Unrelated.md"), "Short\n").expect("write Unrelated");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("repair config");
    let mut service = IndexService::open(config).expect("repair service");
    service.refresh(false).expect("cold build");
    Fixture {
        service,
        root,
        _vault: vault,
        _index: index,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

fn read(fixture: &Fixture, name: &str) -> String {
    std::fs::read_to_string(fixture.root.join(name)).expect("read a note")
}

#[test]
fn a_rename_preserves_every_referrers_own_spelling_shape() {
    let mut fixture = fixture();
    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename with repair");

    assert_eq!(read(&fixture, "Short.md"), "before Renamed after\n");
    assert_eq!(read(&fixture, "Extended.md"), "Renamed.md\n");
    assert_eq!(
        read(&fixture, "Explicit.md"),
        "Renamed and shown\n",
        "the subpath and the display text are outside the target span and must not move"
    );
    assert_eq!(read(&fixture, "Unrelated.md"), "Short\n");
    assert_eq!(outcome.links_rewritten, 5);
    assert!(outcome.link_rewrite_failures.is_empty());
    assert!(fixture.root.join("Renamed.md").is_file());
    assert!(!fixture.root.join("Alpha.md").exists());
}

#[test]
fn a_relative_spelling_that_still_reaches_the_target_stays_relative() {
    let mut fixture = fixture();
    fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename with repair");
    assert_eq!(read(&fixture, "Nested/Relative.md"), "../Renamed\n");
}

#[test]
fn ambiguity_the_rename_introduces_upgrades_the_spelling_to_the_explicit_path() {
    let mut fixture = fixture();
    // A second note whose stem would collide with the rename's destination.
    // After the move, `Beta` is ambiguous, so the shortest form is no
    // longer safe and the rewrite must over-specify.
    std::fs::write(fixture.root.join("Nested/Beta.md"), "# Beta\n").expect("write Nested/Beta");
    fixture.service.refresh(false).expect("index the new note");

    fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Beta.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename into an ambiguous stem");

    assert_eq!(
        read(&fixture, "Short.md"),
        "before Beta.md after\n",
        "over-specifying is safe; silently retargeting is not"
    );
}

#[test]
fn a_referrer_edited_out_of_band_is_skipped_and_reported_never_clobbered() {
    let mut fixture = fixture();
    // Moves `Short.md` past the revision the index knows, exactly as an
    // external editor would between the last reconciliation and this rename.
    std::fs::write(fixture.root.join("Short.md"), "before Alpha after, edited\n")
        .expect("edit Short out of band");

    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename with repair");

    assert_eq!(
        read(&fixture, "Short.md"),
        "before Alpha after, edited\n",
        "a concurrently-edited referrer is never clobbered"
    );
    let failures: Vec<&str> = outcome
        .link_rewrite_failures
        .iter()
        .map(|failure| failure.path.as_str())
        .collect();
    assert_eq!(failures, vec!["Short.md"]);
    assert_eq!(
        outcome.link_rewrite_failures[0].reason, "revision_conflict",
        "the caller must be able to tell why, not just that"
    );
    assert!(
        !outcome.changed_paths.contains(&path("Short.md")),
        "a skipped file is not in the change set"
    );
    assert_eq!(read(&fixture, "Extended.md"), "Renamed.md\n");
}

#[test]
fn every_rewrite_and_the_move_land_in_one_generation() {
    let mut fixture = fixture();
    let before = fixture
        .service
        .current_generation()
        .expect("generation")
        .expect("published");
    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("rename with repair");
    let report = fixture
        .service
        .refresh_paths(outcome.changed_paths.clone(), vault_index::ChangeCause::Mutation)
        .expect("reconcile the whole burst");
    assert_eq!(
        report.generation.get(),
        before.get() + 1,
        "the burst is one generation, not one per rewritten file"
    );
    assert!(report.changes.deleted.contains(&path("Alpha.md")));
    assert!(report.changes.created.contains(&path("Renamed.md")));
}

#[test]
fn a_crash_between_the_rewrites_and_the_move_converges_on_a_retry() {
    struct StopBeforeMove {
        fired: AtomicBool,
    }
    impl TestHook for StopBeforeMove {
        fn reach(&self, point: HookPoint) {
            if point == HookPoint::BeforeRenameMove && !self.fired.swap(true, Ordering::SeqCst) {
                panic!("simulated crash between the rewrites and the move");
            }
        }
    }

    let mut fixture = fixture();
    fixture.service.install_test_hook(Arc::new(StopBeforeMove {
        fired: AtomicBool::new(false),
    }));
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = fixture.service.apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        });
    }));
    assert!(crashed.is_err(), "the hook must have aborted the burst");

    // Referrers already point at the new path; the file is still at the old
    // one. Visible as unresolved references, never as stale links that look
    // resolved.
    assert_eq!(read(&fixture, "Short.md"), "before Renamed after\n");
    assert!(fixture.root.join("Alpha.md").is_file());

    // The hook fires once, so the retry completes the move.
    fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect("the retry converges");
    assert!(fixture.root.join("Renamed.md").is_file());
    assert_eq!(read(&fixture, "Short.md"), "before Renamed after\n");
}

#[test]
fn a_rename_that_will_be_refused_rewrites_nothing_first() {
    let mut fixture = fixture();
    let error = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Short.md"),
            expected: Precondition::Any,
            rewrite_links: true,
        })
        .expect_err("the destination already exists");
    assert!(
        matches!(
            error,
            vault_index::IndexError::Mutation(vault_index::MutationError::TargetExists { .. })
        ),
        "expected target_exists, got {error:?}"
    );
    assert_eq!(read(&fixture, "Short.md"), "before Alpha after\n");
    assert_eq!(read(&fixture, "Extended.md"), "Alpha.md\n");
}

#[test]
fn renaming_a_folder_repairs_references_to_every_note_it_carried() {
    let mut fixture = fixture();
    std::fs::write(fixture.root.join("Nested/Inner.md"), "# Inner\n").expect("write Inner");
    std::fs::write(fixture.root.join("Pointer.md"), "Nested/Inner\n").expect("write Pointer");
    fixture.service.refresh(false).expect("index the new notes");

    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameFolder {
            from: path("Nested"),
            to: path("Moved"),
            rewrite_links: true,
        })
        .expect("rename a folder with repair");

    assert_eq!(read(&fixture, "Pointer.md"), "Moved/Inner\n");
    assert!(outcome.links_rewritten >= 1);
    assert!(fixture.root.join("Moved/Inner.md").is_file());
}

#[test]
fn rewrite_links_false_moves_the_file_and_leaves_every_referrer_alone() {
    let mut fixture = fixture();
    let outcome = fixture
        .service
        .apply_mutation(&Mutation::RenameNote {
            from: path("Alpha.md"),
            to: path("Renamed.md"),
            expected: Precondition::Any,
            rewrite_links: false,
        })
        .expect("rename without repair");
    assert_eq!(read(&fixture, "Short.md"), "before Alpha after\n");
    assert_eq!(outcome.links_rewritten, 0);
    assert!(outcome.link_rewrite_failures.is_empty());
    assert!(fixture.root.join("Renamed.md").is_file());
    assert_eq!(
        outcome.revision.as_deref(),
        Some(revision_of(b"# Heading\n\ntext ^block\n").as_str()),
        "the moved note's bytes are unchanged, so its revision is its old one"
    );
}
```

- [ ] **Step 2: Run the focused test and observe the missing repair**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test rename_repair
```

Expected: compilation fails on `HookPoint::BeforeRenameMove`; once that is stubbed, the spelling tests fail because no repair runs at all.

- [ ] **Step 3: Add the hook point and the rename preflight**

In `crates/vault-index/src/test_hook.rs`, add:

```rust
    /// Every referencing note has been rewritten and the renamed file has not
    /// moved yet. Aborting from here produces exactly the crash the ordering
    /// guarantee is about, so the convergence claim can be asserted rather
    /// than argued.
    BeforeRenameMove,
```

In `crates/vault-index/src/mutate.rs`, factor the refusals out of `rename_paths` so they can run before any referrer is touched, and call the new function from `rename_paths` as well:

```rust
impl MutationEngine {
    /// Every reason a rename will be refused, checked before anything is
    /// written. Link repair rewrites referencing notes *before* the move, so
    /// a refusal discovered at move time would leave the vault edited for a
    /// rename that never happened.
    pub fn preflight_rename(
        &self,
        from: &VaultPath,
        to: &VaultPath,
    ) -> Result<(), MutationError> {
        if self.read_only {
            return Err(MutationError::ReadOnly);
        }
        if in_config_zone(from) || in_config_zone(to) {
            return Err(MutationError::ZoneViolation { path: to.clone() });
        }
        if !self.resolve(from)?.exists() {
            return Err(MutationError::NotFound { path: from.clone() });
        }
        let case_only = from.as_str() != to.as_str()
            && from.as_str().to_lowercase() == to.as_str().to_lowercase();
        if case_only {
            return Ok(());
        }
        if self.resolve(to)?.exists() {
            return Err(MutationError::TargetExists { path: to.clone() });
        }
        if let Some(existing) = self.case_variant(to)? {
            return Err(MutationError::CaseCollision {
                path: to.clone(),
                existing,
            });
        }
        Ok(())
    }
}
```

Replace the equivalent block inside `rename_paths` with `self.preflight_rename(from, to)?;`.

- [ ] **Step 4: Write the two-tier repair planner**

Create `crates/vault-index/src/mutate/rename.rs`:

```rust
//! Rename link repair.
//!
//! Two tiers, because neither layer can answer the whole question:
//!
//! * the **live graph** answers *which* references target a moved note. It
//!   stores dependency keys and reference identities and deliberately stores
//!   no spans and no spellings, so it can say "these references" and nothing
//!   more;
//! * the **durable SQL layer** answers *how to rewrite each one*.
//!   `note_references.target_span` is the exact byte range of the file-target
//!   portion — subpaths and display text sit outside it and are never
//!   touched — and `notes.source_bytes` is the document those spans index.
//!
//! Each rewrite is compare-and-swap guarded against the revision the index
//! knew, so a referrer edited since the last reconciliation is skipped and
//! reported rather than clobbered with a stale body.

use std::collections::{BTreeMap, BTreeSet};

use vault_core::{
    LinkTarget, Resolution, ResolutionIdentityChange, ResolutionNote, Resolver, VaultPath,
    changed_candidate_keys,
};

use crate::error::IndexError;
use crate::live_graph::LiveGraph;
use crate::mutate::{LinkRewriteFailure, MutationEngine};
use crate::store::IndexStore;

/// One referencing note's finished new body.
pub(crate) struct Rewrite {
    pub(crate) path: VaultPath,
    pub(crate) patched: String,
    pub(crate) links: u64,
}

pub(crate) struct Repair {
    pub(crate) rewrites: Vec<Rewrite>,
    pub(crate) failures: Vec<LinkRewriteFailure>,
}

/// The note identity a path carries in `graph`, as resolution sees it.
fn identity(graph: &LiveGraph, path: &VaultPath) -> Option<ResolutionNote> {
    graph.note(path).map(|note| ResolutionNote {
        path: note.path,
        headings: note.headings,
        blocks: note.blocks,
    })
}

/// Plan every referencing note's rewrite for one set of `from -> to` moves.
///
/// A folder rename is the same problem with more moves, so both go through
/// here: a note that references two of the moved paths is rewritten once,
/// with both spans spliced.
pub(crate) fn plan_repair(
    graph: &LiveGraph,
    store: &IndexStore,
    engine: &MutationEngine,
    moves: &BTreeMap<VaultPath, VaultPath>,
) -> Result<Repair, IndexError> {
    // Tier one: which references could be reaching any moved path. Keys come
    // only from `vault_core`'s own constructor, never hand-built, so the
    // selection can never be narrower than resolution's own lookup routes.
    let moved: BTreeSet<&VaultPath> = moves.keys().collect();
    let mut selected: BTreeMap<VaultPath, BTreeSet<u32>> = BTreeMap::new();
    for (from, to) in moves {
        let change = ResolutionIdentityChange {
            old: identity(graph, from),
            new: identity(graph, from).map(|note| ResolutionNote {
                path: to.clone(),
                headings: note.headings,
                blocks: note.blocks,
            }),
        };
        for key in changed_candidate_keys(&change) {
            for reference in graph.dependents(&key) {
                let Some(source) = graph.note_path(reference.source) else {
                    continue;
                };
                // A moved note carries its own outgoing links with it; only
                // *inbound* references need retargeting.
                if moved.contains(source) {
                    continue;
                }
                selected
                    .entry(source.clone())
                    .or_default()
                    .insert(reference.ordinal);
            }
        }
    }

    // The catalog the vault will have *after* the moves, so a preserved
    // spelling is checked against the world it will actually live in.
    let mut catalog: BTreeMap<VaultPath, ResolutionNote> = BTreeMap::new();
    for path in graph.note_paths() {
        if moved.contains(&path) {
            continue;
        }
        if let Some(note) = identity(graph, &path) {
            catalog.insert(path, note);
        }
    }
    for (from, to) in moves {
        if let Some(note) = identity(graph, from) {
            catalog.insert(
                to.clone(),
                ResolutionNote {
                    path: to.clone(),
                    headings: note.headings,
                    blocks: note.blocks,
                },
            );
        }
    }
    let resolver = Resolver::from_catalog(catalog.into_values());

    // Tier two: the spans and spellings.
    let mut rewrites = Vec::new();
    let mut failures = Vec::new();
    for (source, ordinals) in selected {
        let Some(stored) = store.load_note(&source)? else {
            failures.push(LinkRewriteFailure {
                path: source,
                reason: "not_found".into(),
            });
            continue;
        };
        // Per-file compare-and-swap: the spans below index the bytes the
        // index knows, so a file that moved since is not one this plan can
        // safely edit.
        let indexed = stored.source.revision().as_str().to_string();
        match engine.current_revision(&source)? {
            Some(on_disk) if on_disk == indexed => {}
            _ => {
                failures.push(LinkRewriteFailure {
                    path: source,
                    reason: "revision_conflict".into(),
                });
                continue;
            }
        }

        let outgoing = store.load_outgoing_by_ordinal(&source)?;
        let mut splices: Vec<(std::ops::Range<usize>, String)> = Vec::new();
        for ordinal in ordinals {
            let Some(reference) = outgoing.get(&ordinal) else {
                continue;
            };
            let current_target = match &reference.resolution {
                Resolution::Resolved { target, .. }
                | Resolution::MissingSubpath { target, .. } => target.clone(),
                _ => continue,
            };
            let Some(destination) = moves.get(&current_target) else {
                continue;
            };
            let Some(existing) = reference.reference.file_target.as_deref() else {
                // A same-note subpath reference has no file target to
                // retarget, and moves with its own note.
                continue;
            };
            let spelling = preserved_spelling(&source, existing, destination, &resolver);
            if spelling == existing {
                continue;
            }
            let span = reference.reference.target_span;
            splices.push((span.start()..span.end(), spelling));
        }
        if splices.is_empty() {
            continue;
        }
        // Descending, so no earlier splice invalidates a later span.
        splices.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
        let mut patched = stored.source.text().to_string();
        let links = splices.len() as u64;
        for (range, spelling) in splices {
            patched.replace_range(range, &spelling);
        }
        rewrites.push(Rewrite {
            path: source,
            patched,
            links,
        });
    }
    rewrites.sort_by(|left, right| left.path.cmp(&right.path));
    failures.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(Repair { rewrites, failures })
}

/// The spelling that replaces `existing` so it points at `to` from `source`.
///
/// Shortest-form stays shortest while it stays unambiguous; ambiguity the
/// rename introduces upgrades the spelling to the explicit vault path.
/// Over-specifying is safe, silently retargeting is not — so every candidate
/// is checked against the post-rename resolver before it is used, and the
/// explicit path is the fallback that always resolves.
fn preserved_spelling(
    source: &VaultPath,
    existing: &str,
    to: &VaultPath,
    resolver: &Resolver,
) -> String {
    let full = to.as_str();
    let filename = full.rsplit('/').next().unwrap_or(full);
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    let without_extension = full.strip_suffix(".md").unwrap_or(full);
    let kept_extension = existing.to_lowercase().ends_with(".md");
    let was_relative = existing.starts_with("./") || existing.starts_with("../");

    let mut candidates: Vec<String> = Vec::new();
    if was_relative {
        // Both relative shapes, so a link that reached up a level keeps
        // reaching up a level when that still works.
        let leaf = if kept_extension { filename } else { stem };
        candidates.push(format!("./{leaf}"));
        candidates.push(format!("../{leaf}"));
    }
    if kept_extension {
        candidates.push(filename.to_string());
        candidates.push(full.to_string());
    } else {
        candidates.push(stem.to_string());
        candidates.push(without_extension.to_string());
        candidates.push(full.to_string());
    }
    for candidate in candidates {
        if resolves_to(resolver, source, &candidate, to) {
            return candidate;
        }
    }
    full.to_string()
}

fn resolves_to(resolver: &Resolver, source: &VaultPath, candidate: &str, to: &VaultPath) -> bool {
    match resolver.resolve_target(source, &LinkTarget::parse(candidate)) {
        Resolution::Resolved { target, .. } | Resolution::MissingSubpath { target, .. } => {
            &target == to
        }
        _ => false,
    }
}
```

Declare it in `crates/vault-index/src/mutate.rs` with `pub(crate) mod rename;`.

- [ ] **Step 5: Run the repair burst from the service**

In `crates/vault-index/src/reconcile.rs`, replace `apply_mutation` with the dispatching version:

```rust
    /// Apply one mutation to the vault.
    ///
    /// Everything except a link-repairing rename is pure filesystem work and
    /// goes straight to the engine. A repairing rename is the one operation
    /// that needs the index — the live graph to know *which* references point
    /// at the moved note, the durable rows to know *how* to rewrite them — so
    /// it runs here, as one burst, serialized against every other mutation by
    /// the coordinator that owns this service.
    pub fn apply_mutation(
        &mut self,
        mutation: &crate::mutate::Mutation,
    ) -> Result<crate::mutate::MutationOutcome, IndexError> {
        // Read-only is checked **first**, above every other consideration.
        // `MutationEngine::apply` checks it too, but the two repairing-rename
        // arms below never reach `apply`: `RenameFolder` enumerates the
        // folder's notes before anything else runs, so on a read-only daemon a
        // rename of a folder that does not exist would fail with a filesystem
        // error — surfacing as `storage_failure` — instead of the dedicated
        // `read_only` code the flag exists to produce. Refuse here, before any
        // path is touched.
        if self.engine.is_read_only() {
            return Err(crate::mutate::MutationError::ReadOnly.into());
        }
        match mutation {
            crate::mutate::Mutation::RenameNote {
                from,
                to,
                expected,
                rewrite_links: true,
            } => {
                self.engine.check(from, expected)?;
                let mut moves = std::collections::BTreeMap::new();
                moves.insert(from.clone(), to.clone());
                self.rename_with_repair(from, to, moves)
            }
            crate::mutate::Mutation::RenameFolder {
                from,
                to,
                rewrite_links: true,
            } => {
                let mut moves = std::collections::BTreeMap::new();
                for path in crate::mutate::markdown_paths_under(&self.config.canonical_vault_root, from)? {
                    let suffix = path
                        .as_str()
                        .strip_prefix(from.as_str())
                        .and_then(|rest| rest.strip_prefix('/'))
                        .unwrap_or_default();
                    let destination = VaultPath::new(format!("{}/{suffix}", to.as_str()))
                        .map_err(|error| IndexError::InvalidPath(error.to_string()))?;
                    moves.insert(path, destination);
                }
                self.rename_with_repair(from, to, moves)
            }
            other => Ok(self.engine.apply(other)?),
        }
    }

    /// Rewrite every referencing note, then move the file — in that order,
    /// and never the reverse.
    ///
    /// A crash between the two leaves references pointing at a path the note
    /// has not reached yet: visible as unresolved references, convergent when
    /// the client retries, and never the failure mode the other order would
    /// produce — a moved note with stale inbound links that look resolved and
    /// are not.
    fn rename_with_repair(
        &mut self,
        from: &VaultPath,
        to: &VaultPath,
        moves: std::collections::BTreeMap<VaultPath, VaultPath>,
    ) -> Result<crate::mutate::MutationOutcome, IndexError> {
        // Every refusal first: a rename that will fail must not have edited a
        // single referrer on its way to failing.
        self.engine.preflight_rename(from, to)?;
        let generation = self
            .store
            .current_generation()?
            .ok_or(IndexError::IndexUnavailable)?;
        self.republish_current(generation)?;

        // The graph handle is released at the end of this block, before
        // anything publishes: a live clone would force the next delta install
        // to copy the whole graph.
        let repair = {
            let graph = self.published_graph(generation)?;
            crate::mutate::rename::plan_repair(&graph, &self.store, &self.engine, &moves)?
        };

        let mut changed_paths: std::collections::BTreeSet<VaultPath> =
            std::collections::BTreeSet::new();
        let mut links_rewritten = 0u64;
        let mut failures = repair.failures;
        for rewrite in repair.rewrites {
            let resolved = self.engine.resolve(&rewrite.path)?;
            match crate::mutate::write_atomically(&resolved, rewrite.patched.as_bytes()) {
                Ok(()) => {
                    links_rewritten += rewrite.links;
                    changed_paths.insert(rewrite.path);
                }
                Err(error) => failures.push(crate::mutate::LinkRewriteFailure {
                    path: rewrite.path,
                    reason: error.to_string(),
                }),
            }
        }

        self.reach(crate::HookPoint::BeforeRenameMove);
        changed_paths.extend(self.engine.rename_paths(from, to)?);

        Ok(crate::mutate::MutationOutcome {
            changed_paths,
            revision: self.engine.current_revision(to)?,
            links_rewritten,
            link_rewrite_failures: failures,
            semantic: true,
        })
    }
```

Make `write_atomically`, `markdown_paths_under`, and `mutate::rename` reachable from `reconcile.rs` by leaving them `pub(crate)` as written.

- [ ] **Step 6: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test rename_repair
```

Expected: all nine tests pass. If `ambiguity_the_rename_introduces_upgrades_the_spelling_to_the_explicit_path` fails, `preserved_spelling`'s candidate order or the post-rename catalog is wrong — the shortest form must be *checked*, never assumed.

- [ ] **Step 7: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/mutate.rs crates/vault-index/src/mutate/rename.rs \
        crates/vault-index/src/reconcile.rs crates/vault-index/src/test_hook.rs \
        crates/vault-index/tests/rename_repair.rs
git commit -m "feat(index): repair inbound links when a note or folder is renamed"
```

---

## Execution checkpoint 3 — after Task 12: the whole write path exists

**Stop here and get a review before Task 13.** Every mutation the design names now works end to end — engine, coordinator, protocol, races, oracle, and the rename burst — and the phase's hardest single piece (two-tier link repair with per-file CAS and a load-bearing crash ordering) has just landed. Tasks 13–15 are a different subsystem entirely and share nothing with this one but the config.

What the reviewer is checking: the rename ordering guarantee (referrers first, move last) is what the code actually does, not just what the comment says; spelling preservation never *silently retargets*; a skipped referrer is genuinely absent from the change set; and the read-only preflight now covers all four rename shapes. This is also the natural point to re-read the oracle's failures, if it has produced any.

---

### Task 13: Snapshot sessions — a pinned read transaction on its own connection

Review killed v1's streaming design twice over: the dispatcher answers exactly one response per request, and the reader barrier is per-call and cannot hold a snapshot across calls without blocking the writer. A session is the replacement: its own SQLite connection, one long-lived deferred read transaction, pinned at the generation it opened on.

**One generation, tree included.** An earlier draft had this task walk the filesystem at `open_snapshot` to produce folders and attachments, because the index stored neither — which made a session generation-exact for notes and merely point-in-time for everything else. The design's *Supersedes correction #10* withdrew that: the schema-v3 pre-task now stores a `tree_entries` row for every folder, note, and non-Markdown file, so **the tree comes out of the same pinned transaction as the notes** and an entire session is coherent at one generation. This task therefore opens a transaction and counts rows; it walks nothing, hashes nothing, and captures nothing at open.

**Cost stated honestly.** An open snapshot pins WAL frames and defers checkpoint truncation for its lifetime. Hence the idle timeout and the concurrency cap, both `IndexConfig` fields so they are tunable without a protocol change.

**Files:**

- Create: `crates/vault-index/src/snapshot.rs`
- Modify: `crates/vault-index/src/config.rs` (`IndexConfig` lines 11–17, `derived` lines 20–37, `explicit` lines 53–67)
- Modify: `crates/vault-index/src/error.rs`
- Modify: `crates/vault-index/src/lib.rs`
- Modify: `crates/vault-server/src/convert.rs`
- Create: `crates/vault-index/tests/snapshot_sessions.rs`

**Interfaces:**

- Consumes: `schema::open_reader`, `IndexConfig`, `Generation`, `Generation::from_db`, the pre-task's `tree_entries` table, `MutationEngine` (for the tests' writes).
- Produces: `IndexConfig::{snapshot_idle_timeout, max_concurrent_snapshots, snapshot_page_size, max_snapshot_page_size}` with defaults `60s`, `4`, `500`, `2000`.
- Produces: `pub struct SnapshotSessions`, `SnapshotSessions::new(config: &IndexConfig) -> SnapshotSessions`, `SnapshotSessions::open(&mut self) -> Result<OpenSnapshot, IndexError>`, `SnapshotSessions::close(&mut self, id: &str) -> Result<(), IndexError>`, `SnapshotSessions::close_all(&mut self)`, `SnapshotSessions::len(&self) -> usize`, `SnapshotSessions::is_empty(&self) -> bool`, `SnapshotSessions::generation_of(&mut self, id: &str) -> Result<Generation, IndexError>`, and the crate-private `session`/`page_size` Tasks 14 and 15 page through.
- Produces: `pub struct OpenSnapshot { pub snapshot_id: String, pub generation: Generation, pub note_count: u64, pub entry_count: u64 }`.
- Produces: `pub enum TreeEntryKind { Folder, Note, File }`. **No** `TreeEntry` capture struct: nothing is captured at open, so there is nothing for one to hold. Task 14's `TreeEntryRow` is the only tree type, and it is built per page from `tree_entries` rows.
- Produces: `IndexError::{SnapshotNotFound(String), TooManySnapshots { limit: usize }}`.
- Tasks 14 and 15 page out of these sessions.

- [ ] **Step 1: Write the failing session test**

Create `crates/vault-index/tests/snapshot_sessions.rs`:

```rust
//! Snapshot sessions: pinned, reclaimed, capped, and released.

use std::time::Duration;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    IndexConfig, IndexError, IndexService, Mutation, Precondition, SnapshotSessions,
};

struct Fixture {
    service: IndexService,
    config: IndexConfig,
    _vault: TempDir,
    _index: TempDir,
}

fn fixture(configure: impl FnOnce(&mut IndexConfig)) -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder")).expect("create Folder");
    std::fs::write(root.join("One.md"), "# One\n").expect("write One");
    std::fs::write(root.join("Folder/Two.md"), "# Two\n").expect("write Two");
    std::fs::write(root.join("Folder/image.png"), [1u8, 2, 3]).expect("write an attachment");

    let mut config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("snapshot config");
    configure(&mut config);
    let mut service = IndexService::open(config.clone()).expect("snapshot service");
    service.refresh(false).expect("cold build");
    Fixture {
        service,
        config,
        _vault: vault,
        _index: index,
    }
}

#[test]
fn a_session_reports_the_generation_and_both_counts_it_opened_on() {
    let fixture = fixture(|_| {});
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    assert_eq!(
        opened.generation,
        fixture
            .service
            .current_generation()
            .expect("generation")
            .expect("published")
    );
    assert_eq!(opened.note_count, 2);
    assert_eq!(
        opened.entry_count, 4,
        "every tree_entries row: two notes, one folder, one attachment"
    );
    assert!(
        opened.entry_count >= opened.note_count,
        "the tree contains the notes, so it can never be the smaller count"
    );
    assert_eq!(sessions.len(), 1);
}

#[test]
fn a_session_stays_at_its_own_generation_while_the_writer_moves_on() {
    let mut fixture = fixture(|_| {});
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");

    for index in 0..5 {
        fixture
            .service
            .apply_mutation(&Mutation::WriteNote {
                path: VaultPath::new(format!("Storm-{index}.md")).expect("valid vault path"),
                content: format!("# Storm {index}\n"),
                expected: Precondition::Absent,
            })
            .expect("write during the snapshot");
        fixture
            .service
            .refresh(false)
            .expect("publish during the snapshot");
    }

    let after = fixture
        .service
        .current_generation()
        .expect("generation")
        .expect("published");
    assert!(
        after > opened.generation,
        "the writer must have proceeded: {after:?} vs {:?}",
        opened.generation
    );
    assert_eq!(
        sessions
            .generation_of(&opened.snapshot_id)
            .expect("the session is still open"),
        opened.generation,
        "the pinned reader sees its generation forever"
    );
}

#[test]
fn the_concurrency_cap_refuses_rather_than_pinning_the_wal_indefinitely() {
    let fixture = fixture(|config| config.max_concurrent_snapshots = 2);
    let mut sessions = SnapshotSessions::new(&fixture.config);
    sessions.open().expect("first snapshot");
    sessions.open().expect("second snapshot");
    let error = sessions.open().expect_err("the third must be refused");
    match error {
        IndexError::TooManySnapshots { limit } => assert_eq!(limit, 2),
        other => panic!("expected too_many_snapshots, got {other:?}"),
    }
}

#[test]
fn an_idle_session_is_reclaimed_so_a_new_one_can_open() {
    let fixture = fixture(|config| {
        config.max_concurrent_snapshots = 1;
        config.snapshot_idle_timeout = Duration::from_millis(50);
    });
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let stale = sessions.open().expect("first snapshot");
    std::thread::sleep(Duration::from_millis(120));
    let fresh = sessions
        .open()
        .expect("the idle session must be reclaimed to make room");
    assert_ne!(stale.snapshot_id, fresh.snapshot_id);
    assert!(
        matches!(
            sessions.close(&stale.snapshot_id),
            Err(IndexError::SnapshotNotFound(_))
        ),
        "the reclaimed session must be gone, not merely unusable"
    );
    assert_eq!(sessions.len(), 1);
}

#[test]
fn closing_a_session_releases_it_and_closing_it_twice_is_typed() {
    let fixture = fixture(|_| {});
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    sessions.close(&opened.snapshot_id).expect("close it once");
    assert_eq!(sessions.len(), 0);
    match sessions.close(&opened.snapshot_id) {
        Err(IndexError::SnapshotNotFound(id)) => assert_eq!(id, opened.snapshot_id),
        other => panic!("expected snapshot_not_found, got {other:?}"),
    }
}

#[test]
fn closing_every_session_is_what_a_disconnect_does() {
    let fixture = fixture(|_| {});
    let mut sessions = SnapshotSessions::new(&fixture.config);
    sessions.open().expect("first snapshot");
    sessions.open().expect("second snapshot");
    sessions.close_all();
    assert_eq!(sessions.len(), 0);
    assert!(sessions.is_empty());
}
```

- [ ] **Step 2: Run the focused test and observe the missing module**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test snapshot_sessions
```

Expected: compilation fails — `SnapshotSessions`, the four `IndexConfig` fields, and the two error variants do not exist.

- [ ] **Step 3: Add the tuning fields and error variants**

In `crates/vault-index/src/config.rs`, add to `IndexConfig`:

```rust
    /// How long a snapshot session may sit unused before it is reclaimed.
    /// An open snapshot pins WAL frames and defers checkpoint truncation, so
    /// an abandoned one is a real cost rather than an inert handle.
    pub snapshot_idle_timeout: std::time::Duration,
    /// How many snapshot sessions may be open at once, for the same reason.
    pub max_concurrent_snapshots: usize,
    /// The page size a client gets when it does not ask for one.
    pub snapshot_page_size: u32,
    /// The largest page size a client may ask for.
    pub max_snapshot_page_size: u32,
```

and set them in both constructors, immediately before each `Ok(Self { … })`:

```rust
            snapshot_idle_timeout: std::time::Duration::from_secs(60),
            max_concurrent_snapshots: 4,
            snapshot_page_size: 500,
            max_snapshot_page_size: 2_000,
```

In `crates/vault-index/src/error.rs`, add:

```rust
    /// No session with this identifier is open — it was closed, reclaimed
    /// after its idle timeout, or never issued by this process.
    #[error("no such snapshot session: {0}")]
    SnapshotNotFound(String),
    /// The daemon already holds its maximum number of open snapshots. Each
    /// one pins WAL frames, so the cap is a resource bound rather than a
    /// policy.
    #[error("at most {limit} snapshot sessions may be open at once")]
    TooManySnapshots { limit: usize },
```

In `crates/vault-server/src/convert.rs`, add to `index_error`:

```rust
        IndexError::SnapshotNotFound(id) => {
            error.code = ErrorCode::SnapshotNotFound;
            error.message = format!("no such snapshot session: {id}");
        }
        IndexError::TooManySnapshots { limit } => {
            error.code = ErrorCode::TooManySnapshots;
            error.message = format!("at most {limit} snapshot sessions may be open at once");
        }
```

- [ ] **Step 4: Write the session registry**

Create `crates/vault-index/src/snapshot.rs`:

```rust
//! Snapshot sessions: a pinned, generation-stable view a client pages
//! through with ordinary request/response calls.
//!
//! Each session owns its own query-only SQLite connection and holds one
//! long-lived deferred read transaction on it. Under WAL the writer proceeds
//! the whole time; the pinned reader sees its generation forever.
//!
//! The transaction is driven with explicit `BEGIN DEFERRED`/`ROLLBACK`
//! statements rather than a `rusqlite::Transaction`, because a `Transaction`
//! borrows its `Connection` and a struct cannot hold both. `BEGIN DEFERRED`
//! does not take the snapshot until its first read, so one generation query
//! runs immediately after it — that read is what actually pins the frames.
//!
//! **Everything a session serves comes out of that one transaction**, tree as
//! well as semantics: the schema-v3 pre-task stores a `tree_entries` row for
//! every folder, note, and non-Markdown file, so a session is coherent at one
//! generation from end to end. Nothing here walks the filesystem, hashes a
//! file, or observes anything outside the transaction — a session that did
//! would be exactly as stale as whatever moment it happened to look.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::config::IndexConfig;
use crate::error::IndexError;
use crate::model::Generation;

/// What one tree entry is, mirroring `tree_entries.kind`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TreeEntryKind {
    Folder,
    Note,
    File,
}

impl TreeEntryKind {
    /// Decode one stored `kind`. The column carries a `CHECK` constraint, so
    /// an unknown value means the database is not the schema this build
    /// expects rather than that a new kind exists.
    pub(crate) fn from_stored(value: &str) -> Result<Self, IndexError> {
        match value {
            "folder" => Ok(Self::Folder),
            "note" => Ok(Self::Note),
            "file" => Ok(Self::File),
            other => Err(IndexError::IncompatibleIndex(format!(
                "unknown tree entry kind {other:?}"
            ))),
        }
    }
}

/// What `open` established.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenSnapshot {
    pub snapshot_id: String,
    pub generation: Generation,
    pub note_count: u64,
    pub entry_count: u64,
}

pub(crate) struct Session {
    pub(crate) connection: Connection,
    pub(crate) generation: Generation,
    pub(crate) note_count: u64,
    pub(crate) last_used: Instant,
}

impl Drop for Session {
    /// Release the pinned transaction even on an unwind. A session dropped
    /// without this would hold WAL frames for the life of the process.
    fn drop(&mut self) {
        let _ = self.connection.execute_batch("ROLLBACK");
    }
}

/// Every open snapshot session this process holds.
pub struct SnapshotSessions {
    config: IndexConfig,
    next_id: u64,
    sessions: BTreeMap<String, Session>,
}

impl SnapshotSessions {
    pub fn new(config: &IndexConfig) -> Self {
        Self {
            config: config.clone(),
            next_id: 0,
            sessions: BTreeMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// Open a session pinned at the current generation.
    pub fn open(&mut self) -> Result<OpenSnapshot, IndexError> {
        self.reap(Instant::now());
        if self.sessions.len() >= self.config.max_concurrent_snapshots {
            return Err(IndexError::TooManySnapshots {
                limit: self.config.max_concurrent_snapshots,
            });
        }

        let connection = crate::schema::open_reader(&self.config)?;
        connection.execute_batch("BEGIN DEFERRED")?;
        // The first read is what takes the snapshot. Everything after this
        // statement sees exactly these frames, however far the writer moves.
        let stored: Option<i64> = connection.query_row(
            "SELECT generation FROM index_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let Some(stored) = stored else {
            // Nothing committed: there is no snapshot to pin. `Drop` releases
            // the transaction as the connection falls out of scope.
            return Err(IndexError::IndexUnavailable);
        };
        let generation = Generation::from_db(stored)?;
        let note_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))?;
        let note_count = u64::try_from(note_count)
            .map_err(|_| IndexError::IncompatibleIndex("negative note count".into()))?;

        // The tree count comes from the same pinned transaction, so the
        // number a client is told up front is the number it will actually
        // page out. `tree_entries` holds folders, notes, and non-Markdown
        // files alike, so this is always at least `note_count`.
        let entry_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM tree_entries", [], |row| row.get(0))?;
        let entry_count = u64::try_from(entry_count)
            .map_err(|_| IndexError::IncompatibleIndex("negative tree entry count".into()))?;

        self.next_id += 1;
        let snapshot_id = format!("snap-{}", self.next_id);
        self.sessions.insert(
            snapshot_id.clone(),
            Session {
                connection,
                generation,
                note_count,
                last_used: Instant::now(),
            },
        );
        Ok(OpenSnapshot {
            snapshot_id,
            generation,
            note_count,
            entry_count,
        })
    }

    /// The generation `id` is pinned at, refreshing its idle deadline.
    pub fn generation_of(&mut self, id: &str) -> Result<Generation, IndexError> {
        Ok(self.session(id)?.generation)
    }

    /// Borrow one live session, refreshing its idle deadline. Every paging
    /// call goes through here, which is what makes "idle" mean "no page for
    /// this long" rather than "open for this long".
    pub(crate) fn session(&mut self, id: &str) -> Result<&mut Session, IndexError> {
        self.reap(Instant::now());
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| IndexError::SnapshotNotFound(id.to_string()))?;
        session.last_used = Instant::now();
        Ok(session)
    }

    pub fn close(&mut self, id: &str) -> Result<(), IndexError> {
        match self.sessions.remove(id) {
            // Dropping the session rolls its transaction back.
            Some(_) => Ok(()),
            None => Err(IndexError::SnapshotNotFound(id.to_string())),
        }
    }

    /// Release every session. The daemon is single-peer today, so a client
    /// disconnect (stdio end of file) releases everything — designed for
    /// here rather than discovered later.
    pub fn close_all(&mut self) {
        self.sessions.clear();
    }

    /// Drop every session whose last page is older than the idle timeout.
    fn reap(&mut self, now: Instant) {
        let timeout = self.config.snapshot_idle_timeout;
        self.sessions
            .retain(|_, session| now.duration_since(session.last_used) < timeout);
    }

    pub(crate) fn page_size(&self, requested: Option<u32>) -> u32 {
        match requested {
            None => self.config.snapshot_page_size,
            Some(requested) => requested
                .clamp(1, self.config.max_snapshot_page_size),
        }
    }
}
```

`Generation::from_db` is `pub(crate)` in `model.rs`, so `open` above calls it directly; no accessor is needed.

Note what is **absent** here and was present in the v1 draft: no `walkdir`, no `capture_tree`, no `Vec<TreeEntry>` on the session, and no hidden-directory rule restated. The pre-task's `tree_entries` already excludes `.obsidian`, `.trash`, and every other dot-directory, by mirroring the scan and watcher rules at the point they are observed. Restating that rule here would have been a second copy that could drift from the first.

In `crates/vault-index/src/lib.rs`, add `mod snapshot;` and:

```rust
pub use snapshot::{OpenSnapshot, SnapshotSessions, TreeEntryKind};
```

- [ ] **Step 5: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test snapshot_sessions
```

Expected: all six tests pass. If `a_session_stays_at_its_own_generation_while_the_writer_moves_on` fails, the `BEGIN DEFERRED` is not being followed by a read and nothing was actually pinned. If `a_session_reports_the_generation_and_both_counts_it_opened_on` fails with "no such table: tree_entries", the schema-v3 pre-task has not landed — stop and check the preflight gate rather than working around it.

- [ ] **Step 6: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/snapshot.rs crates/vault-index/src/config.rs \
        crates/vault-index/src/error.rs crates/vault-index/src/lib.rs \
        crates/vault-index/tests/snapshot_sessions.rs crates/vault-server/src/convert.rs
git commit -m "feat(index): pin bulk reads behind snapshot sessions"
```

---

### Task 14: `snapshot_tree` — paging the whole vault tree

The host's mirror needs the full `TFile`/`TFolder` tree, not just notes: v1's note-only frames could not back `getFiles` or a folder lookup. With the pre-task's `tree_entries` table in place, that tree is one ordinary paginated read out of the session's pinned transaction — one keyset query, no merge of two sources, and no per-page hashing.

**Files:**

- Modify: `crates/vault-index/src/snapshot.rs`
- Modify: `crates/vault-index/src/cursor.rs` (`CursorPosition`, an adjacently-tagged enum with `Note`, `Reference`, and `Diagnostic` variants)
- Modify: `crates/vault-server/src/{lib,convert,runtime}.rs`
- Create: `crates/vault-index/tests/snapshot_pages.rs`
- Create: `crates/vault-server/tests/snapshots.rs`

**Interfaces:**

- Consumes: `SnapshotSessions::{session, page_size}`, `TreeEntryKind::from_stored` (Task 13); `cursor::{encode_cursor, decode_cursor}`; the pre-task's `tree_entries` table.
- Produces: `SnapshotSessions::tree_page(&mut self, id: &str, cursor: Option<&str>, limit: Option<u32>) -> Result<TreePage, IndexError>`.
- Produces: `pub struct TreePage { pub generation: Generation, pub entries: Vec<TreeEntryRow>, pub next_cursor: Option<String> }` and `pub struct TreeEntryRow { pub path: VaultPath, pub kind: TreeEntryKind, pub size: Option<u64>, pub ctime_unix_ms: i64, pub mtime_unix_ms: i64, pub revision: Option<String> }` — the two timestamps are the pre-task's `ctime_unix_ms`/`mtime_unix_ms` columns and the source a host serves `TFile.stat` from.
- Produces: `CursorPosition::TreeEntry { path: String }`.
- Produces: `RuntimeHandle::config(&self) -> IndexConfig`, `Server::snapshots: Option<Mutex<SnapshotSessions>>`, `convert::tree_entry`.
- Task 15 reuses the paging shape; Task 18 documents it.

- [ ] **Step 1: Write the failing tree-paging test**

Create `crates/vault-index/tests/snapshot_pages.rs`:

```rust
//! Paging a snapshot's tree: complete, ordered, and stable across a write
//! storm.

use std::path::PathBuf;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{
    IndexConfig, IndexError, IndexService, Mutation, Precondition, SnapshotSessions, TreeEntryKind,
};

struct Fixture {
    service: IndexService,
    config: IndexConfig,
    _vault: TempDir,
    _index: TempDir,
    root: PathBuf,
}

fn fixture() -> Fixture {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let root = vault.path().canonicalize().expect("canonical vault root");
    std::fs::create_dir_all(root.join("Folder/Deep")).expect("create Folder/Deep");
    std::fs::write(root.join("Alpha.md"), "# Alpha\n").expect("write Alpha");
    std::fs::write(root.join("Folder/Beta.md"), "# Beta\n").expect("write Beta");
    std::fs::write(root.join("Folder/Deep/Gamma.md"), "# Gamma\n").expect("write Gamma");
    std::fs::write(root.join("Folder/image.png"), [1u8, 2, 3, 4]).expect("write an attachment");

    let config =
        IndexConfig::explicit(&root, index.path().join("index.sqlite3")).expect("page config");
    let mut service = IndexService::open(config.clone()).expect("page service");
    service.refresh(false).expect("cold build");
    Fixture {
        service,
        config,
        _vault: vault,
        _index: index,
        root,
    }
}

fn drain(sessions: &mut SnapshotSessions, id: &str, limit: u32) -> Vec<(String, TreeEntryKind)> {
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = sessions
            .tree_page(id, cursor.as_deref(), Some(limit))
            .expect("a tree page");
        all.extend(
            page.entries
                .into_iter()
                .map(|entry| (entry.path.as_str().to_string(), entry.kind)),
        );
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    all
}

#[test]
fn a_tree_page_covers_folders_notes_and_attachments_in_path_order() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let entries = drain(&mut sessions, &opened.snapshot_id, 2);

    assert_eq!(
        entries,
        vec![
            ("Alpha.md".to_string(), TreeEntryKind::Note),
            ("Folder".to_string(), TreeEntryKind::Folder),
            ("Folder/Beta.md".to_string(), TreeEntryKind::Note),
            ("Folder/Deep".to_string(), TreeEntryKind::Folder),
            ("Folder/Deep/Gamma.md".to_string(), TreeEntryKind::Note),
            ("Folder/image.png".to_string(), TreeEntryKind::File),
        ]
    );
    assert_eq!(entries.len() as u64, opened.entry_count);
}

#[test]
fn a_note_entry_carries_the_snapshots_own_revision_size_and_stat() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let page = sessions
        .tree_page(&opened.snapshot_id, None, Some(100))
        .expect("one page");
    let alpha = page
        .entries
        .iter()
        .find(|entry| entry.path.as_str() == "Alpha.md")
        .expect("Alpha is in the tree");
    assert_eq!(
        alpha.revision.as_deref(),
        Some(vault_index::revision_of(b"# Alpha\n").as_str()),
        "a note's revision comes from `notes`, joined onto its tree row"
    );
    assert_eq!(
        alpha.size,
        Some(
            std::fs::metadata(fixture.root.join("Alpha.md"))
                .expect("stat Alpha")
                .len()
        ),
        "the stored size is the file's real size, not a re-derivation"
    );
    assert!(
        alpha.ctime_unix_ms > 0 && alpha.mtime_unix_ms > 0,
        "the host serves TFile.stat from these: {alpha:?}"
    );

    let attachment = page
        .entries
        .iter()
        .find(|entry| entry.path.as_str() == "Folder/image.png")
        .expect("the attachment is in the tree");
    assert_eq!(attachment.size, Some(4));
    assert!(
        attachment.revision.is_some(),
        "an attachment's revision is stored on its tree row, not hashed per page"
    );

    let folder = page
        .entries
        .iter()
        .find(|entry| entry.path.as_str() == "Folder")
        .expect("Folder is in the tree");
    assert_eq!(folder.size, None);
    assert_eq!(folder.revision, None);
    assert!(
        folder.mtime_unix_ms > 0,
        "a folder has no size and no revision, but it does have timestamps"
    );
}

#[test]
fn a_session_pages_to_completion_at_its_own_generation_under_a_write_storm() {
    let mut fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");

    // One page in, then a storm, then the rest. The storm must be invisible.
    let first = sessions
        .tree_page(&opened.snapshot_id, None, Some(2))
        .expect("first page");
    for index in 0..10 {
        fixture
            .service
            .apply_mutation(&Mutation::WriteNote {
                path: VaultPath::new(format!("Storm-{index}.md")).expect("valid vault path"),
                content: format!("# Storm {index}\n"),
                expected: Precondition::Absent,
            })
            .expect("write during the snapshot");
    }
    fixture.service.refresh(false).expect("publish the storm");

    let mut entries: Vec<String> = first
        .entries
        .iter()
        .map(|entry| entry.path.as_str().to_string())
        .collect();
    let mut cursor = first.next_cursor;
    while let Some(current) = cursor {
        let page = sessions
            .tree_page(&opened.snapshot_id, Some(&current), Some(2))
            .expect("a later page");
        assert_eq!(
            page.generation, opened.generation,
            "every page answers at the pinned generation"
        );
        entries.extend(
            page.entries
                .iter()
                .map(|entry| entry.path.as_str().to_string()),
        );
        cursor = page.next_cursor;
    }
    assert!(
        entries.iter().all(|path| !path.starts_with("Storm-")),
        "a note written after the snapshot opened must never appear in it: {entries:?}"
    );
    assert_eq!(entries.len() as u64, opened.entry_count);
}

#[test]
fn a_cursor_from_another_session_is_refused() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let first = sessions.open().expect("first snapshot");
    let second = sessions.open().expect("second snapshot");
    let page = sessions
        .tree_page(&first.snapshot_id, None, Some(1))
        .expect("first page");
    let cursor = page.next_cursor.expect("more pages");
    let error = sessions
        .tree_page(&second.snapshot_id, Some(&cursor), Some(1))
        .expect_err("a cursor belongs to the session that issued it");
    assert!(
        matches!(error, IndexError::InvalidCursor(_)),
        "expected invalid_cursor, got {error:?}"
    );
}

#[test]
fn paging_a_closed_session_is_typed_rather_than_a_panic() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    sessions.close(&opened.snapshot_id).expect("close it");
    let error = sessions
        .tree_page(&opened.snapshot_id, None, Some(10))
        .expect_err("a closed session cannot be paged");
    assert!(matches!(error, IndexError::SnapshotNotFound(_)));
}
```

- [ ] **Step 2: Run the focused test and observe the missing paging API**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test snapshot_pages
```

Expected: compilation fails — `SnapshotSessions::tree_page` does not exist.

- [ ] **Step 3: Add the cursor position and the merge-walk page**

In `crates/vault-index/src/cursor.rs`, add to `CursorPosition`:

```rust
    TreeEntry {
        path: String,
    },
```

In `crates/vault-index/src/snapshot.rs`, add:

```rust
use crate::cursor::{CursorPosition, decode_cursor, encode_cursor};

/// One tree entry as a page reports it, straight out of `tree_entries`.
///
/// `ctime_unix_ms` and `mtime_unix_ms` are the pre-task's stored timestamps —
/// birthtime where the platform has one, mtime where it does not — and are
/// what a host serves `TFile.stat = { ctime, mtime, size }` from. Reading them
/// from the row rather than from disk is what keeps a page answerable at the
/// pinned generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreeEntryRow {
    pub path: VaultPath,
    pub kind: TreeEntryKind,
    pub size: Option<u64>,
    pub ctime_unix_ms: i64,
    pub mtime_unix_ms: i64,
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreePage {
    pub generation: Generation,
    pub entries: Vec<TreeEntryRow>,
    pub next_cursor: Option<String>,
}

impl SnapshotSessions {
    /// One page of the vault tree, in path order, at the session's pinned
    /// generation.
    ///
    /// One keyset query over `tree_entries`, which already holds every
    /// folder, note, and non-Markdown file. The only join is onto `notes`,
    /// and only for a revision: the pre-task stores `content_revision` on the
    /// tree row for plain files and leaves it `NULL` for notes, because a note
    /// already carries its revision on `notes` and duplicating it would give
    /// the two copies somewhere to disagree. `COALESCE` picks whichever of the
    /// two the row actually has.
    ///
    /// Nothing here touches the filesystem. An attachment's revision, size,
    /// and timestamps were recorded when the scan or the watcher observed it,
    /// so they belong to the pinned generation like everything else — the
    /// earlier draft's per-page hashing was a workaround for a tree that did
    /// not exist yet.
    pub fn tree_page(
        &mut self,
        id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<TreePage, IndexError> {
        let page_size = self.page_size(limit);
        let session = self.session(id)?;
        let generation = session.generation;
        let query = format!("snapshot_tree:{id}");
        let after = match cursor {
            None => String::new(),
            Some(cursor) => match decode_cursor(cursor, generation, &query)? {
                CursorPosition::TreeEntry { path } => path,
                _ => {
                    return Err(IndexError::InvalidCursor(
                        "cursor position does not fit a tree listing".into(),
                    ));
                }
            },
        };

        // One extra row, so "is there another page" needs no second query.
        let wanted = page_size as i64 + 1;
        let mut rows: Vec<TreeEntryRow> = {
            let mut statement = session.connection.prepare(
                "SELECT t.path, t.kind, t.size, t.ctime_unix_ms, t.mtime_unix_ms, \
                        COALESCE(t.content_revision, n.content_revision) \
                 FROM tree_entries t LEFT JOIN notes n ON n.path = t.path \
                 WHERE t.path > ?1 ORDER BY t.path LIMIT ?2",
            )?;
            let raw = statement
                .query_map(rusqlite::params![after.as_str(), wanted], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut converted = Vec::with_capacity(raw.len());
            for (path, kind, size, ctime_unix_ms, mtime_unix_ms, revision) in raw {
                converted.push(TreeEntryRow {
                    path: crate::codec::decode_path(&path)?,
                    kind: TreeEntryKind::from_stored(&kind)?,
                    size: size.and_then(|size| u64::try_from(size).ok()),
                    ctime_unix_ms,
                    mtime_unix_ms,
                    revision,
                });
            }
            converted
        };

        let has_more = rows.len() > page_size as usize;
        rows.truncate(page_size as usize);
        let next_cursor = match (has_more, rows.last()) {
            (true, Some(last)) => Some(encode_cursor(
                generation,
                &query,
                CursorPosition::TreeEntry {
                    path: last.path.as_str().to_string(),
                },
            )?),
            _ => None,
        };
        Ok(TreePage {
            generation,
            entries: rows,
            next_cursor,
        })
    }
}
```

Add `TreeEntryRow` and `TreePage` to the `snapshot` re-export in `crates/vault-index/src/lib.rs`. `codec::decode_path` is already crate-visible.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test snapshot_pages
```

Expected: all five tests pass.

- [ ] **Step 5: Wire `open_snapshot`, `snapshot_tree`, and `close_snapshot` into the server**

In `crates/vault-server/src/lib.rs`, give `Server` a registry. **The field is `Option<Mutex<…>>`, and it is `None` in health-only mode** — one shape, stated once:

```rust
    /// Snapshot sessions, behind a mutex so reads answer from the dispatcher
    /// thread without ever touching the coordinator. `rusqlite::Connection`
    /// is `Send` but not `Sync`, which is exactly what a `Mutex` is for.
    ///
    /// `None` in health-only mode. A registry needs an `IndexConfig` to open
    /// reader connections against, and health-only has no vault and therefore
    /// no config — so the absence is modelled rather than faked with an empty
    /// registry that would answer `snapshot_not_found` where it should answer
    /// `index_unavailable`.
    snapshots: Option<std::sync::Mutex<vault_index::SnapshotSessions>>,
```

`Server::health_only` sets `snapshots: None` beside its existing `live: None`. `Server::for_runtime` builds `Some(Mutex::new(SnapshotSessions::new(&handle.config())))`, which needs one new accessor: add `RuntimeHandle::config(&self) -> IndexConfig` to `crates/vault-server/src/runtime.rs`, returning a clone of the config the runtime was started with (`Runtime::start_with_hooks` already clones it for `IndexService::open`, so store that clone on `RuntimeInner` and hand it back).

Add the three arms, replacing the Task 3 placeholders:

```rust
            Request::OpenSnapshot(_) => match self.snapshots.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(sessions) => {
                    let mut sessions = sessions.lock().unwrap_or_else(|error| error.into_inner());
                    match sessions.open() {
                        Ok(opened) => ResponseEnvelope::success(
                            id,
                            Response::OpenSnapshot(OpenSnapshotResponse {
                                snapshot_id: opened.snapshot_id,
                                generation: opened.generation.get(),
                                note_count: opened.note_count,
                                entry_count: opened.entry_count,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
            Request::SnapshotTree(params) => match self.snapshots.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(sessions) => {
                    let mut sessions = sessions.lock().unwrap_or_else(|error| error.into_inner());
                    match sessions.tree_page(
                        &params.snapshot_id,
                        params.cursor.as_deref(),
                        params.limit,
                    ) {
                        Ok(page) => ResponseEnvelope::success(
                            id,
                            Response::SnapshotTree(SnapshotTreeResponse {
                                snapshot_id: params.snapshot_id,
                                generation: page.generation.get(),
                                entries: page.entries.iter().map(convert::tree_entry).collect(),
                                next_cursor: page.next_cursor,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
            Request::CloseSnapshot(params) => match self.snapshots.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(sessions) => {
                    let mut sessions = sessions.lock().unwrap_or_else(|error| error.into_inner());
                    match sessions.close(&params.snapshot_id) {
                        Ok(()) => ResponseEnvelope::success(
                            id,
                            Response::CloseSnapshot(CloseSnapshotResponse {
                                snapshot_id: params.snapshot_id,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
```

Release everything on shutdown, which is what a disconnect reaches:

```rust
    pub fn shutdown(&self) {
        if let Some(sessions) = self.snapshots.as_ref() {
            sessions
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .close_all();
        }
        if let Some(live) = &self.live {
            live.handle.shutdown();
        }
    }
```

Add the converter in `crates/vault-server/src/convert.rs`:

```rust
pub(crate) fn tree_entry(value: &vault_index::TreeEntryRow) -> TreeEntryDto {
    TreeEntryDto {
        path: value.path.as_str().to_string(),
        kind: match value.kind {
            vault_index::TreeEntryKind::Folder => TreeEntryKindDto::Folder,
            vault_index::TreeEntryKind::Note => TreeEntryKindDto::Note,
            vault_index::TreeEntryKind::File => TreeEntryKindDto::File,
        },
        size: value.size,
        ctime_unix_ms: value.ctime_unix_ms,
        mtime_unix_ms: value.mtime_unix_ms,
        revision: value.revision.clone(),
    }
}
```

- [ ] **Step 6: Prove the disconnect path releases sessions**

Create `crates/vault-server/tests/snapshots.rs`:

```rust
//! Snapshot sessions over the real transport, including the one path a unit
//! test cannot reach: a client that disconnects without closing.

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{ErrorCode, Response, ResponseOutcome};

fn daemon(vault: &TempDir, index: &TempDir) -> Daemon {
    Daemon::for_vault(vault, index)
}

#[test]
fn a_client_pages_a_snapshot_and_closes_it() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(vault.path().join("Two.md"), "# Two\n").expect("write Two");

    let mut daemon = daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let opened = daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot_id = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(response)) => {
            assert_eq!(response.note_count, 2);
            response.snapshot_id
        }
        other => panic!("open_snapshot failed: {other:?}"),
    };

    let page = daemon.call(&format!(
        r#"{{"version":1,"id":"t","request":{{"method":"snapshot_tree","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    match page.outcome {
        ResponseOutcome::Ok(Response::SnapshotTree(response)) => {
            assert_eq!(response.entries.len(), 2);
            assert_eq!(response.next_cursor, None);
            assert!(
                response
                    .entries
                    .iter()
                    .all(|entry| entry.mtime_unix_ms > 0),
                "every entry carries the stat a host mirrors: {:?}",
                response.entries
            );
        }
        other => panic!("snapshot_tree failed: {other:?}"),
    }

    let closed = daemon.call(&format!(
        r#"{{"version":1,"id":"c","request":{{"method":"close_snapshot","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    assert!(matches!(closed.outcome, ResponseOutcome::Ok(_)));

    let again = daemon.call(&format!(
        r#"{{"version":1,"id":"c2","request":{{"method":"close_snapshot","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    match again.outcome {
        ResponseOutcome::Err(error) => assert_eq!(error.code, ErrorCode::SnapshotNotFound),
        other => panic!("a second close must be refused: {other:?}"),
    }
}

#[test]
fn a_client_that_disconnects_with_a_snapshot_open_does_not_wedge_the_daemon() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");

    let mut daemon = daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);

    // No close. The daemon is single-peer, so end of file is the disconnect.
    let status = daemon.disconnect();
    assert!(
        status.success(),
        "an open snapshot must not keep the daemon alive: {status:?}"
    );
}
```

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test snapshots
```

Expected: both tests pass.

- [ ] **Step 7: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/snapshot.rs crates/vault-index/src/cursor.rs \
        crates/vault-index/src/lib.rs crates/vault-index/tests/snapshot_pages.rs \
        crates/vault-server/src/lib.rs crates/vault-server/src/convert.rs \
        crates/vault-server/src/runtime.rs crates/vault-server/tests/snapshots.rs
git commit -m "feat(index): page the whole vault tree out of a snapshot session"
```

---

### Task 15: `snapshot_notes` — per-note semantic facets, `sections` and `list_items` included

Bodies stay per-note through `get_note`; this page carries row-sets. The metadata facet therefore never selects `notes.source_bytes` — a bulk hydration that dragged every body through it would defeat the point.

**Files:**

- Modify: `crates/vault-index/src/store.rs` (`load_note_with`, lines 959–1185)
- Modify: `crates/vault-index/src/snapshot.rs`
- Modify: `crates/vault-index/src/cursor.rs`
- Modify: `crates/vault-server/src/{lib,convert}.rs`
- Modify: `crates/vault-index/tests/snapshot_pages.rs`
- Modify: `crates/vault-server/tests/snapshots.rs`

**Interfaces:**

- Consumes: `SnapshotSessions::{session, page_size}` (Task 13), `load_outgoing_with`, `resolved_reference_from_row_with`, `reference_row_prefix` (existing `store.rs`), the schema-v3 `sections` and `list_items` tables (assumed pre-task).
- Produces: `pub(crate) struct NoteMetadata { properties, aliases, headings, blocks, tags, diagnostics }` and `pub(crate) fn load_metadata_with(connection: &Connection, path: &VaultPath) -> Result<NoteMetadata, IndexError>`, extracted out of `load_note_with` so both read the same SQL.
- Produces: `pub struct NoteFacets { pub metadata: bool, pub references: bool, pub resolutions: bool, pub backlinks: bool, pub sections: bool, pub list_items: bool }`.
- Produces: `pub struct SectionRow { pub kind: String, pub span: SourceSpan, pub block_id: Option<String> }` and `pub struct ListItemRow { pub span: SourceSpan, pub list_start_line: Option<u32>, pub parent_start_line: Option<u32>, pub task: Option<String> }` — both column-for-column with the pre-task's pinned DDL. **The line-number parent model, not an ordinal and not a `-1` sentinel**: exactly one of the two parent columns is set, and the stored `CHECK` constraint enforces that at the database.
- Produces: `pub struct SnapshotNoteRow { … }`, `pub struct SnapshotMetadata { … }`, `pub struct NotesPage { … }`.
- Produces: `SnapshotSessions::notes_page(&mut self, id: &str, cursor: Option<&str>, limit: Option<u32>, facets: NoteFacets) -> Result<NotesPage, IndexError>`.
- Produces: `CursorPosition::SnapshotNote { path: String }`, `convert::{note_facets, snapshot_note}`.
- `sections` and `list_items` are **top-level facets, siblings of `metadata`**, not fields inside it — on the wire and in `SnapshotNoteRow` alike. The pre-task pins that, `NoteFacetDto` names them, and `SnapshotNoteDto` carries them at the same level as `metadata`.

- [ ] **Step 1: Write the failing facet test**

Append to `crates/vault-index/tests/snapshot_pages.rs`:

```rust
use vault_index::NoteFacets;

#[test]
fn a_notes_page_carries_only_the_facets_that_were_asked_for() {
    let fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let page = sessions
        .notes_page(
            &opened.snapshot_id,
            None,
            Some(100),
            NoteFacets {
                metadata: true,
                references: false,
                resolutions: false,
                backlinks: false,
                sections: false,
                list_items: false,
            },
        )
        .expect("a notes page");
    assert_eq!(page.notes.len(), 3);
    let alpha = &page.notes[0];
    assert_eq!(alpha.path.as_str(), "Alpha.md");
    assert_eq!(
        alpha.revision,
        vault_index::revision_of(b"# Alpha\n"),
        "the page reports the snapshot's revision, not the file's current one"
    );
    assert!(alpha.metadata.is_some());
    assert!(
        alpha.references.is_none()
            && alpha.resolutions.is_none()
            && alpha.backlinks.is_none()
            && alpha.sections.is_none()
            && alpha.list_items.is_none(),
        "an unrequested facet is not read at all"
    );
    assert_eq!(
        alpha
            .metadata
            .as_ref()
            .expect("metadata was requested")
            .headings
            .len(),
        1
    );
}

#[test]
fn references_resolutions_and_backlinks_agree_with_each_other() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("Pointer.md"), "Alpha\n").expect("write Pointer");
    let mut service = fixture.service;
    service.refresh(false).expect("index the pointer");
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");
    let page = sessions
        .notes_page(
            &opened.snapshot_id,
            None,
            Some(100),
            NoteFacets {
                metadata: false,
                references: true,
                resolutions: true,
                backlinks: true,
                sections: false,
                list_items: false,
            },
        )
        .expect("a notes page");

    let alpha = page
        .notes
        .iter()
        .find(|note| note.path.as_str() == "Alpha.md")
        .expect("Alpha is in the page");
    let backlinks = alpha.backlinks.as_ref().expect("backlinks were requested");
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source.as_str(), "Pointer.md");

    let pointer = page
        .notes
        .iter()
        .find(|note| note.path.as_str() == "Pointer.md")
        .expect("Pointer is in the page");
    let references = pointer
        .references
        .as_ref()
        .expect("references were requested");
    let resolutions = pointer
        .resolutions
        .as_ref()
        .expect("resolutions were requested");
    assert_eq!(references.len(), resolutions.len());
    assert_eq!(references[0].resolution, resolutions[0]);
}

#[test]
fn a_notes_page_stays_at_its_generation_and_pages_by_path() {
    let mut fixture = fixture();
    let mut sessions = SnapshotSessions::new(&fixture.config);
    let opened = sessions.open().expect("open a snapshot");

    fixture
        .service
        .apply_mutation(&Mutation::WriteNote {
            path: VaultPath::new("Zulu.md").expect("valid vault path"),
            content: "# Zulu\n".into(),
            expected: Precondition::Absent,
        })
        .expect("write during the snapshot");
    fixture.service.refresh(false).expect("publish the write");

    let facets = NoteFacets {
        metadata: false,
        references: false,
        resolutions: false,
        backlinks: false,
        sections: false,
        list_items: false,
    };
    let mut paths = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = sessions
            .notes_page(&opened.snapshot_id, cursor.as_deref(), Some(2), facets)
            .expect("a notes page");
        assert_eq!(page.generation, opened.generation);
        paths.extend(page.notes.iter().map(|note| note.path.as_str().to_string()));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(
        paths,
        vec![
            "Alpha.md".to_string(),
            "Folder/Beta.md".to_string(),
            "Folder/Deep/Gamma.md".to_string()
        ],
        "a note written after the snapshot opened must never appear in it"
    );
    assert_eq!(paths.len() as u64, opened.note_count);
}
```

- [ ] **Step 2: Run the focused test and observe the missing API**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test snapshot_pages
```

Expected: compilation fails — `NoteFacets` and `SnapshotSessions::notes_page` do not exist.

- [ ] **Step 3: Extract the body-free metadata loader**

In `crates/vault-index/src/store.rs`, add above `load_note_with`:

```rust
/// One note's parsed metadata **without** its source bytes: everything a
/// bulk reader wants, and none of what a body costs. `load_note_with` reads
/// the same rows through this, so the two can never drift apart.
pub(crate) struct NoteMetadata {
    pub(crate) properties: Vec<vault_core::Property>,
    pub(crate) aliases: Vec<Alias>,
    pub(crate) headings: Vec<Heading>,
    pub(crate) blocks: Vec<BlockId>,
    pub(crate) tags: Vec<Tag>,
    pub(crate) diagnostics: Vec<Diagnostic>,
}

pub(crate) fn load_metadata_with(
    connection: &Connection,
    path: &VaultPath,
) -> Result<NoteMetadata, IndexError> {
    let mut metadata = NoteMetadata {
        properties: Vec::new(),
        aliases: Vec::new(),
        headings: Vec::new(),
        blocks: Vec::new(),
        tags: Vec::new(),
        diagnostics: Vec::new(),
    };

    let mut statement = connection.prepare(
        "SELECT key_text, value_json, span_start, span_end, key_span_start, key_span_end, \
                value_span_start, value_span_end \
         FROM properties WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let property_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (key, value_json, span_start, span_end, key_start, key_end, value_start, value_end) in
        property_rows
    {
        metadata.properties.push(vault_core::Property {
            key: vault_core::Spanned::new(
                key,
                codec::decode_span(
                    i64_to_usize(key_start, "property key span start")?,
                    i64_to_usize(key_end, "property key span end")?,
                )?,
            ),
            value: vault_core::Spanned::new(
                codec::decode_property_value(&value_json)?,
                codec::decode_span(
                    i64_to_usize(value_start, "property value span start")?,
                    i64_to_usize(value_end, "property value span end")?,
                )?,
            ),
            span: codec::decode_span(
                i64_to_usize(span_start, "property span start")?,
                i64_to_usize(span_end, "property span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT value, span_start, span_end FROM aliases WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let alias_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (value, start, end) in alias_rows {
        metadata.aliases.push(Alias {
            value,
            span: codec::decode_span(
                i64_to_usize(start, "alias span start")?,
                i64_to_usize(end, "alias span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT level, text, span_start, span_end FROM headings \
         WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let heading_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (level, text, start, end) in heading_rows {
        let level = u8::try_from(level)
            .map_err(|_| IndexError::IncompatibleIndex("heading level out of range".into()))?;
        metadata.headings.push(Heading {
            level,
            text,
            span: codec::decode_span(
                i64_to_usize(start, "heading span start")?,
                i64_to_usize(end, "heading span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT identifier, span_start, span_end FROM blocks \
         WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let block_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (value, start, end) in block_rows {
        metadata.blocks.push(BlockId {
            value,
            span: codec::decode_span(
                i64_to_usize(start, "block span start")?,
                i64_to_usize(end, "block span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT value, comparison_key, span_start, span_end FROM tags \
         WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let tag_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (value, comparison_key, start, end) in tag_rows {
        metadata.tags.push(Tag {
            value,
            comparison_key,
            span: codec::decode_span(
                i64_to_usize(start, "tag span start")?,
                i64_to_usize(end, "tag span end")?,
            )?,
        });
    }

    let mut statement = connection.prepare(
        "SELECT code, severity, message, path, span_start, span_end \
         FROM note_diagnostics WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let diagnostic_rows = statement
        .query_map(params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (code, severity, message, diagnostic_path, start, end) in diagnostic_rows {
        metadata.diagnostics.push(codec::diagnostic_from_row(
            &code,
            &severity,
            message,
            diagnostic_path.as_deref(),
            start,
            end,
        )?);
    }

    Ok(metadata)
}
```

Every statement above is moved **verbatim** from `load_note_with` (lines 985–1182 of `store.rs`): identical SQL, identical `query_map` closures, identical decoding. The only change is the destination — `metadata.properties` where it read `note.properties`, and so on. Nothing new is invented here, which is the point: two loaders that read the same tables through different SQL would be free to disagree about what a note holds.

Then rewrite `load_note_with`'s middle. It currently builds `let mut note = ParsedNote::empty(source);` and then runs seven statement blocks; delete the six above and leave the `note_references` block exactly where it is:

```rust
    let mut note = ParsedNote::empty(source);
    let metadata = load_metadata_with(connection, path)?;
    note.properties = metadata.properties;
    note.aliases = metadata.aliases;
    note.headings = metadata.headings;
    note.blocks = metadata.blocks;
    note.tags = metadata.tags;
    note.diagnostics = metadata.diagnostics;

    // …the existing `note_references` block, unchanged, still here…
```

The reference loop stays because it is the one thing a bulk reader does *not* want by default: `references` is its own facet, loaded through the existing `load_outgoing_with`, which resolves each reference as well as decoding it.

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index
```

Expected: every existing `vault-index` test still passes — this step is a pure extraction and must change no behaviour.

- [ ] **Step 4: Add the notes page**

In `crates/vault-index/src/cursor.rs`, add `SnapshotNote { path: String },` to `CursorPosition`.

In `crates/vault-index/src/snapshot.rs`, add:

```rust
use vault_core::{Diagnostic, Resolution, ResolvedReference, SourceSpan};

/// Which per-note row-sets a page carries. A facet that is `false` is not
/// queried, not allocated, and absent from the row.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct NoteFacets {
    pub metadata: bool,
    pub references: bool,
    pub resolutions: bool,
    pub backlinks: bool,
    pub sections: bool,
    pub list_items: bool,
}

/// One parsed section, from the schema-v3 `sections` rows. `block_id` is the
/// trailing `^id` anchor where the block carries one, carried through to every
/// read path exactly as the pre-task's DDL requires.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SectionRow {
    pub kind: String,
    pub span: SourceSpan,
    pub block_id: Option<String>,
}

/// One parsed list item, from the schema-v3 `list_items` rows.
///
/// The parent is a **line number**. A top-level item names the start line of
/// the list containing it; a nested item names its parent item's own start
/// line. Exactly one of the two is set — the stored `CHECK` constraint
/// enforces it, and this type mirrors that rather than flattening the pair
/// into one signed number. Obsidian's own `listItems[].parent` is that
/// flattening (negated for the top level), and reconstructing it is the
/// host's arithmetic, not this layer's.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListItemRow {
    pub span: SourceSpan,
    pub list_start_line: Option<u32>,
    pub parent_start_line: Option<u32>,
    /// The raw character inside the brackets, `None` for a non-task item.
    /// One character wide by construction.
    pub task: Option<String>,
}

/// One note's requested facets.
#[derive(Clone, Debug)]
pub struct SnapshotNoteRow {
    pub path: VaultPath,
    pub revision: String,
    pub metadata: Option<SnapshotMetadata>,
    pub references: Option<Vec<ResolvedReference>>,
    pub resolutions: Option<Vec<Resolution>>,
    pub backlinks: Option<Vec<ResolvedReference>>,
    pub sections: Option<Vec<SectionRow>>,
    pub list_items: Option<Vec<ListItemRow>>,
}

/// The metadata facet, body-free.
#[derive(Clone, Debug)]
pub struct SnapshotMetadata {
    pub properties: Vec<vault_core::Property>,
    pub aliases: Vec<vault_core::Alias>,
    pub headings: Vec<vault_core::Heading>,
    pub blocks: Vec<vault_core::BlockId>,
    pub tags: Vec<vault_core::Tag>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug)]
pub struct NotesPage {
    pub generation: Generation,
    pub notes: Vec<SnapshotNoteRow>,
    pub next_cursor: Option<String>,
}

impl SnapshotSessions {
    /// One page of per-note semantic row-sets, in path order, at the
    /// session's pinned generation.
    pub fn notes_page(
        &mut self,
        id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
        facets: NoteFacets,
    ) -> Result<NotesPage, IndexError> {
        let page_size = self.page_size(limit);
        let session = self.session(id)?;
        let generation = session.generation;
        let query = format!("snapshot_notes:{id}");
        let after = match cursor {
            None => String::new(),
            Some(cursor) => match decode_cursor(cursor, generation, &query)? {
                CursorPosition::SnapshotNote { path } => path,
                _ => {
                    return Err(IndexError::InvalidCursor(
                        "cursor position does not fit a note listing".into(),
                    ));
                }
            },
        };

        let wanted = page_size as i64 + 1;
        let mut rows: Vec<(String, String)> = {
            let mut statement = session.connection.prepare(
                "SELECT path, content_revision FROM notes WHERE path > ?1 ORDER BY path LIMIT ?2",
            )?;
            statement
                .query_map(rusqlite::params![after.as_str(), wanted], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let has_more = rows.len() > page_size as usize;
        rows.truncate(page_size as usize);

        let mut notes = Vec::with_capacity(rows.len());
        for (path, revision) in rows {
            let path = crate::codec::decode_path(&path)?;
            let metadata = if facets.metadata {
                let loaded = crate::store::load_metadata_with(&session.connection, &path)?;
                Some(SnapshotMetadata {
                    properties: loaded.properties,
                    aliases: loaded.aliases,
                    headings: loaded.headings,
                    blocks: loaded.blocks,
                    tags: loaded.tags,
                    diagnostics: loaded.diagnostics,
                })
            } else {
                None
            };
            // Loaded once when either facet is asked for: the two are the
            // same query, and `resolutions` is the answers-only projection of
            // it for a client that wants no spans or spellings.
            let outgoing = if facets.references || facets.resolutions {
                Some(crate::store::load_outgoing_with(&session.connection, &path)?)
            } else {
                None
            };
            let resolutions = if facets.resolutions {
                outgoing.as_ref().map(|outgoing| {
                    outgoing
                        .iter()
                        .map(|resolved| resolved.resolution.clone())
                        .collect()
                })
            } else {
                None
            };
            let references = if facets.references { outgoing } else { None };
            let backlinks = if facets.backlinks {
                Some(load_backlinks(&session.connection, &path)?)
            } else {
                None
            };
            let sections = if facets.sections {
                Some(load_sections(&session.connection, &path)?)
            } else {
                None
            };
            let list_items = if facets.list_items {
                Some(load_list_items(&session.connection, &path)?)
            } else {
                None
            };
            notes.push(SnapshotNoteRow {
                path,
                revision,
                metadata,
                references,
                resolutions,
                backlinks,
                sections,
                list_items,
            });
        }

        let next_cursor = match (has_more, notes.last()) {
            (true, Some(last)) => Some(encode_cursor(
                generation,
                &query,
                CursorPosition::SnapshotNote {
                    path: last.path.as_str().to_string(),
                },
            )?),
            _ => None,
        };
        Ok(NotesPage {
            generation,
            notes,
            next_cursor,
        })
    }
}

/// Every reference that resolves to `path`, in the same stable order
/// `IndexReader::get_backlinks` uses.
fn load_backlinks(
    connection: &Connection,
    path: &VaultPath,
) -> Result<Vec<ResolvedReference>, IndexError> {
    let mut statement = connection.prepare(
        "SELECT r.id, r.kind, r.origin, r.raw_target, r.file_target, r.subpath_kind, \
                r.subpath_value, r.display, r.span_start, r.span_end, \
                r.target_span_start, r.target_span_end, \
                s.kind, s.target_path, s.subpath_kind, s.subpath_value, r.note_path \
         FROM resolutions s JOIN note_references r ON r.id = s.reference_id \
         WHERE s.target_path = ?1 AND s.kind IN ('resolved', 'missing_subpath') \
         ORDER BY r.note_path, r.span_start, r.span_end, r.id",
    )?;
    let rows = statement
        .query_map(rusqlite::params![path.as_str()], |row| {
            Ok((
                crate::store::reference_row_prefix(row)?,
                row.get::<_, String>(16)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(row, source)| {
            let source = crate::codec::decode_path(&source)?;
            crate::store::resolved_reference_from_row_with(connection, source, row)
        })
        .collect()
}

fn load_sections(
    connection: &Connection,
    path: &VaultPath,
) -> Result<Vec<SectionRow>, IndexError> {
    let mut statement = connection.prepare(
        "SELECT kind, span_start, span_end, block_id FROM sections \
         WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let rows = statement
        .query_map(rusqlite::params![path.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(kind, start, end, block_id)| {
            Ok(SectionRow {
                kind,
                span: crate::codec::decode_span(
                    crate::store::i64_to_usize(start, "section span start")?,
                    crate::store::i64_to_usize(end, "section span end")?,
                )?,
                block_id,
            })
        })
        .collect()
}

fn load_list_items(
    connection: &Connection,
    path: &VaultPath,
) -> Result<Vec<ListItemRow>, IndexError> {
    let mut statement = connection.prepare(
        "SELECT span_start, span_end, list_start_line, parent_start_line, task \
         FROM list_items WHERE note_path = ?1 ORDER BY ordinal",
    )?;
    let rows = statement
        .query_map(rusqlite::params![path.as_str()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(start, end, list_start_line, parent_start_line, task)| {
            // The stored CHECK already guarantees exactly one is set. Assert
            // it anyway on the way out: a database that reached this code with
            // both or neither is one this build should refuse to describe,
            // not one it should quietly halve.
            if list_start_line.is_some() == parent_start_line.is_some() {
                return Err(IndexError::IncompatibleIndex(format!(
                    "list item in {} sets both or neither parent column",
                    path.as_str()
                )));
            }
            Ok(ListItemRow {
                span: crate::codec::decode_span(
                    crate::store::i64_to_usize(start, "list item span start")?,
                    crate::store::i64_to_usize(end, "list item span end")?,
                )?,
                list_start_line: line_number(list_start_line, "list start line")?,
                parent_start_line: line_number(parent_start_line, "parent start line")?,
                task,
            })
        })
        .collect()
}

/// One stored line number, or `None`. Negative is not a sentinel here — the
/// line-number parent model has none — so a negative value means the row was
/// written by something that did not share this model.
fn line_number(value: Option<i64>, field: &str) -> Result<Option<u32>, IndexError> {
    match value {
        None => Ok(None),
        Some(value) => u32::try_from(value)
            .map(Some)
            .map_err(|_| IndexError::IncompatibleIndex(format!("{field} is out of range"))),
    }
}
```

Export `NoteFacets`, `NotesPage`, `SnapshotNoteRow`, `SnapshotMetadata`, `SectionRow`, and `ListItemRow` from `crates/vault-index/src/lib.rs`.

- [ ] **Step 5: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test snapshot_pages
```

Expected: all eight tests pass. If the two `sections`/`list_items` queries fail with "no such table" or "no such column", the assumed schema-v3 pre-task has not landed or named its columns differently — fix the two SQL statements here and nothing else, and check the preflight gate rather than adapting the model: the line-number parent columns and `sections.block_id` are pinned by that plan, not chosen by this one.

- [ ] **Step 6: Wire `snapshot_notes` into the server**

In `crates/vault-server/src/convert.rs`, add the facet and row converters:

```rust
pub(crate) fn note_facets(include: &[NoteFacetDto]) -> vault_index::NoteFacets {
    let mut facets = vault_index::NoteFacets::default();
    for facet in include {
        match facet {
            NoteFacetDto::Metadata => facets.metadata = true,
            NoteFacetDto::References => facets.references = true,
            NoteFacetDto::Resolutions => facets.resolutions = true,
            NoteFacetDto::Backlinks => facets.backlinks = true,
            NoteFacetDto::Sections => facets.sections = true,
            NoteFacetDto::ListItems => facets.list_items = true,
        }
    }
    facets
}

pub(crate) fn snapshot_note(value: &vault_index::SnapshotNoteRow) -> SnapshotNoteDto {
    SnapshotNoteDto {
        path: value.path.as_str().to_string(),
        revision: value.revision.clone(),
        metadata: value.metadata.as_ref().map(|metadata| NoteMetadataDto {
            properties: metadata
                .properties
                .iter()
                .map(|property| PropertyDto {
                    key: property.key.value.clone(),
                    value: property_value(&property.value.value),
                    span: span(property.span),
                    key_span: span(property.key.span),
                    value_span: span(property.value.span),
                })
                .collect(),
            aliases: metadata
                .aliases
                .iter()
                .map(|alias| AliasDto {
                    value: alias.value.clone(),
                    span: span(alias.span),
                })
                .collect(),
            headings: metadata
                .headings
                .iter()
                .map(|heading| HeadingDto {
                    level: heading.level,
                    text: heading.text.clone(),
                    span: span(heading.span),
                })
                .collect(),
            blocks: metadata
                .blocks
                .iter()
                .map(|block| BlockDto {
                    value: block.value.clone(),
                    span: span(block.span),
                })
                .collect(),
            tags: metadata
                .tags
                .iter()
                .map(|tag| TagDto {
                    value: tag.value.clone(),
                    comparison_key: tag.comparison_key.clone(),
                    span: span(tag.span),
                })
                .collect(),
            diagnostics: metadata.diagnostics.iter().map(diagnostic).collect(),
        }),
        references: value
            .references
            .as_ref()
            .map(|references| references.iter().map(reference).collect()),
        resolutions: value
            .resolutions
            .as_ref()
            .map(|resolutions| resolutions.iter().map(resolution).collect()),
        backlinks: value
            .backlinks
            .as_ref()
            .map(|backlinks| backlinks.iter().map(reference).collect()),
        sections: value.sections.as_ref().map(|sections| {
            sections
                .iter()
                .map(|section| SectionDto {
                    kind: section.kind.clone(),
                    span: span(section.span),
                    block_id: section.block_id.clone(),
                })
                .collect()
        }),
        list_items: value.list_items.as_ref().map(|items| {
            items
                .iter()
                .map(|item| ListItemDto {
                    span: span(item.span),
                    // Both carried through unchanged: the wire mirrors the
                    // stored line-number model, and a host does its own
                    // negation to reach Obsidian's single `parent` number.
                    list_start_line: item.list_start_line,
                    parent_start_line: item.parent_start_line,
                    task: item.task.clone(),
                })
                .collect()
        }),
    }
}
```

Replace the `Request::SnapshotNotes` placeholder in `crates/vault-server/src/lib.rs`:

```rust
            Request::SnapshotNotes(params) => match self.snapshots.as_ref() {
                None => ResponseEnvelope::error(id, index_unavailable()),
                Some(sessions) => {
                    let mut sessions = sessions.lock().unwrap_or_else(|error| error.into_inner());
                    match sessions.notes_page(
                        &params.snapshot_id,
                        params.cursor.as_deref(),
                        params.limit,
                        convert::note_facets(&params.include),
                    ) {
                        Ok(page) => ResponseEnvelope::success(
                            id,
                            Response::SnapshotNotes(SnapshotNotesResponse {
                                snapshot_id: params.snapshot_id,
                                generation: page.generation.get(),
                                notes: page.notes.iter().map(convert::snapshot_note).collect(),
                                next_cursor: page.next_cursor,
                            }),
                        ),
                        Err(error) => ResponseEnvelope::error(id, convert::index_error(error)),
                    }
                }
            },
```

- [ ] **Step 7: Prove a full hydration round trip over the transport**

Append to `crates/vault-server/tests/snapshots.rs`:

```rust
#[test]
fn a_host_hydrates_the_whole_vault_from_one_session() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join("Folder")).expect("create Folder");
    std::fs::write(vault.path().join("One.md"), "---\ntitle: One\n---\n# One\nTwo\n")
        .expect("write One");
    std::fs::write(vault.path().join("Folder/Two.md"), "# Two\n").expect("write Two");
    std::fs::write(vault.path().join("Folder/image.png"), [1u8, 2, 3]).expect("write an attachment");

    let mut daemon = daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let opened = daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot_id = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(response)) => response.snapshot_id,
        other => panic!("open_snapshot failed: {other:?}"),
    };

    let notes = daemon.call(&format!(
        r#"{{"version":1,"id":"n","request":{{"method":"snapshot_notes","params":{{"snapshot_id":"{snapshot_id}","include":["metadata","references","backlinks","sections","list_items"]}}}}}}"#
    ));
    match notes.outcome {
        ResponseOutcome::Ok(Response::SnapshotNotes(response)) => {
            assert_eq!(response.notes.len(), 2);
            let one = response
                .notes
                .iter()
                .find(|note| note.path == "One.md")
                .expect("One is in the page");
            let metadata = one.metadata.as_ref().expect("metadata was requested");
            assert_eq!(metadata.properties.len(), 1);
            assert_eq!(
                one.references
                    .as_ref()
                    .expect("references were requested")
                    .len(),
                1
            );
            assert!(
                one.sections.is_some(),
                "sections is an ordinary top-level facet, a sibling of metadata"
            );
            assert!(one.list_items.is_some());
            assert!(
                one.sections
                    .as_ref()
                    .expect("sections were requested")
                    .iter()
                    .any(|section| section.kind == "yaml"),
                "the frontmatter block is the first section, which is what tasknotes reads"
            );

            let two = response
                .notes
                .iter()
                .find(|note| note.path == "Folder/Two.md")
                .expect("Two is in the page");
            assert_eq!(
                two.backlinks
                    .as_ref()
                    .expect("backlinks were requested")
                    .len(),
                1
            );
        }
        other => panic!("snapshot_notes failed: {other:?}"),
    }

    daemon.call(&format!(
        r#"{{"version":1,"id":"c","request":{{"method":"close_snapshot","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
}
```

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test snapshots
```

Expected: all three tests pass.

- [ ] **Step 8: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/store.rs crates/vault-index/src/snapshot.rs \
        crates/vault-index/src/cursor.rs crates/vault-index/src/lib.rs \
        crates/vault-index/tests/snapshot_pages.rs \
        crates/vault-server/src/lib.rs crates/vault-server/src/convert.rs \
        crates/vault-server/tests/snapshots.rs
git commit -m "feat(index): serve per-note semantic facets from a snapshot session"
```

---

## Execution checkpoint 4 — after Task 15: bulk reads are complete

**Stop here and get a review before Task 16.** Snapshot sessions now open, pin, page a whole tree, page every semantic facet, reclaim themselves, cap themselves, and release on disconnect. Tasks 16–18 are raw I/O, a flag, and documentation — none of them touch this subsystem.

What the reviewer is checking: the session really is coherent at one generation for tree *and* semantics (no filesystem read anywhere in `snapshot.rs`); `sections` and `list_items` match the pre-task's pinned DDL column-for-column, including the line-number parent model and `block_id`; an unrequested facet is genuinely not queried rather than queried and discarded; and the extraction in Step 3 changed no behaviour, which the pre-existing `vault-index` suite is what proves.

---

### Task 16: `read_file`, `write_file`, and the `.obsidian` zone

Raw I/O closes the gap that would otherwise force a plugin host to read disk behind the daemon's back. Zone writes join no generation and emit a `config_changed` notice, which the host wants on day one.

**Files:**

- Modify: `crates/vault-index/src/mutate.rs`
- Modify: `crates/vault-protocol/src/events.rs` (`RuntimeEventDto`, its visitor)
- Modify: `crates/vault-protocol/src/mutations.rs` (`WriteFileResponse`'s doc: what `semantic` answers)
- Modify: `crates/vault-server/src/{runtime,subscriptions,lib,convert}.rs`
- Modify: `crates/vault-server/Cargo.toml` (`base64.workspace = true`)
- Create: `crates/vault-server/tests/raw_files.rs`
- Create: `crates/vault-server/tests/mutation_errors.rs`
- Modify: `crates/vault-index/tests/mutation_write.rs` (Step 4 below is the step that performs this; it is listed here because it happens, not because it might)

**Interfaces:**

- Consumes: `MutationEngine::{resolve, check, case_variant, recheck}`, `write_atomically`, `in_config_zone`, `is_markdown`, `DEFAULT_MAX_FILE_BYTES` (Tasks 4–5, 10); `RuntimeEventDto`'s tolerant visitor (Task 1); the shared `tests/daemon/mod.rs` harness (Task 9).
- Produces: `Mutation::WriteFile { path, content, expected }`, `MutationEngine::read_file(&self, path: &VaultPath) -> Result<(Vec<u8>, String), MutationError>`.
- Produces: `RuntimeEventDto::ConfigChanged(ConfigChangedEventDto { path: String })` and `RuntimeNotice::ConfigChanged { path: VaultPath }`.
- Produces: `Server::{read_file, engine}` and `convert::{decode_base64, encode_base64}`.
- Produces: `write_file`'s refusal of a `.md` path with `MutationError::IsANote`, which is what makes **`MutationOutcome::semantic` always `false` for a raw write**: the zone is not indexed, an attachment is not indexed, and a note now cannot be written this way at all.
- **The wire's `semantic` is a different question and is computed from the path**, not from the outcome: `WriteFileResponse::semantic` is `!in_config_zone(path)` — "this write is inside the indexed vault" — and it is what decides whether a `generation` accompanies it. Conflating the two is what made the first draft's attachment write claim to be semantic.

- [ ] **Step 1: Write the failing zone test**

Create `crates/vault-server/tests/raw_files.rs`:

```rust
//! Raw file I/O and the configuration zone. Bytes pass through; nothing in
//! the zone becomes semantic.

use std::sync::mpsc::{Receiver, sync_channel};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{IndexConfig, Mutation, Precondition, revision_of};
use vault_server::runtime::{Runtime, RuntimeHandle, RuntimeNotice, RuntimeOptions};

struct Live {
    handle: RuntimeHandle,
    notices: Receiver<RuntimeNotice>,
    vault: TempDir,
    _index: TempDir,
}

fn live() -> Live {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(
        vault.path().join(".obsidian/app.json"),
        r#"{"trashOption":"local"}"#,
    )
    .expect("write app.json");
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("runtime config");
    let (sink, notices) = sync_channel(64);
    let options = RuntimeOptions {
        watch: false,
        reconcile_interval: None,
        ..RuntimeOptions::default()
    };
    let handle = Runtime::start(config, options, sink).expect("start the runtime");
    handle.refresh(false).expect("cold build");
    Live {
        handle,
        notices,
        vault,
        _index: index,
    }
}

fn path(spelling: &str) -> VaultPath {
    VaultPath::new(spelling).expect("valid vault path")
}

#[test]
fn an_attachment_round_trips_byte_for_byte() {
    let live = live();
    let bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let report = live
        .handle
        .mutate(Mutation::WriteFile {
            path: path("image.png"),
            content: bytes.clone(),
            expected: Precondition::Absent,
        })
        .expect("write an attachment");
    assert_eq!(report.revision.as_deref(), Some(revision_of(&bytes).as_str()));
    assert!(
        !report.semantic,
        "`MutationOutcome::semantic` means *the semantic layer's rows moved*, and an \
         attachment is not indexed. That this write is nonetheless inside the vault \
         proper is a different fact, answered on the wire by `WriteFileResponse::semantic`"
    );
    assert_eq!(
        std::fs::read(live.vault.path().join("image.png")).expect("read back"),
        bytes
    );
    // The same bytes survive the base64 round trip the protocol layer performs,
    // which is what `write_file`'s wire form actually carries.
    assert_eq!(
        STANDARD.decode(STANDARD.encode(&bytes)).expect("round trip"),
        bytes
    );
}

#[test]
fn a_raw_write_to_a_markdown_path_is_refused_so_it_cannot_skip_the_generation() {
    let live = live();
    let error = live
        .handle
        .mutate(Mutation::WriteFile {
            path: path("Raw.md"),
            content: b"# Raw\n".to_vec(),
            expected: Precondition::Absent,
        })
        .expect_err("a note must go through write_note so it joins a generation");
    assert!(
        matches!(
            error,
            vault_server::runtime::MutationFailure::Failed(vault_index::IndexError::Mutation(
                vault_index::MutationError::IsANote { .. }
            ))
        ),
        "expected is_a_note, got {error:?}"
    );
    assert!(!live.vault.path().join("Raw.md").exists());
}

#[test]
fn a_zone_write_joins_no_generation_and_announces_itself() {
    let live = live();
    let before = live
        .handle
        .reader()
        .vault_info()
        .expect("vault info")
        .generation;
    let report = live
        .handle
        .mutate(Mutation::WriteFile {
            path: path(".obsidian/app.json"),
            content: br#"{"trashOption":"system"}"#.to_vec(),
            expected: Precondition::Any,
        })
        .expect("write into the zone");
    assert!(
        !report.semantic,
        "nothing in the zone is indexed, so nothing there is semantic"
    );
    assert_eq!(
        live.handle
            .reader()
            .vault_info()
            .expect("vault info")
            .generation,
        before,
        "a zone write must not move the generation"
    );

    let mut announced = Vec::new();
    while let Ok(notice) = live.notices.try_recv() {
        if let RuntimeNotice::ConfigChanged { path } = notice {
            announced.push(path.as_str().to_string());
        }
    }
    assert_eq!(announced, vec![".obsidian/app.json".to_string()]);
}

#[test]
fn every_semantic_operation_refuses_the_zone() {
    let live = live();
    for mutation in [
        Mutation::WriteNote {
            path: path(".obsidian/note.md"),
            content: "# nope\n".into(),
            expected: Precondition::Absent,
        },
        Mutation::DeleteNote {
            path: path(".obsidian/app.json"),
            mode: Some(vault_index::DeleteMode::Permanent),
            expected: Precondition::Any,
        },
        Mutation::CreateFolder {
            path: path(".obsidian/plugins"),
        },
        Mutation::PatchFrontmatter {
            path: path(".obsidian/app.json"),
            patch: Vec::new(),
            expected: Precondition::Any,
        },
    ] {
        let error = live
            .handle
            .mutate(mutation)
            .expect_err("a semantic operation must refuse the zone");
        assert!(
            matches!(
                error,
                vault_server::runtime::MutationFailure::Failed(vault_index::IndexError::Mutation(
                    vault_index::MutationError::ZoneViolation { .. }
                ))
            ),
            "expected a zone violation, got {error:?}"
        );
    }
    assert!(
        live.vault.path().join(".obsidian/app.json").is_file(),
        "nothing in the zone may be touched by a refused operation"
    );
}

#[test]
fn a_read_returns_the_bytes_and_the_revision_a_write_would_compare_against() {
    let live = live();
    let engine = vault_index::MutationEngine::new(
        live.vault.path().canonicalize().expect("canonical vault root"),
    );
    let (bytes, revision) = engine
        .read_file(&path(".obsidian/app.json"))
        .expect("read out of the zone");
    assert_eq!(bytes, br#"{"trashOption":"local"}"#.to_vec());
    assert_eq!(revision, revision_of(&bytes));

    let (note_bytes, note_revision) = engine.read_file(&path("One.md")).expect("read a note");
    assert_eq!(note_bytes, b"# One\n".to_vec());
    assert_eq!(
        note_revision,
        revision_of(b"# One\n"),
        "a note read raw must report the same revision get_note does"
    );
}

#[test]
fn a_payload_past_the_cap_names_the_deferred_alternative() {
    let live = live();
    let error = live
        .handle
        .mutate(Mutation::WriteFile {
            path: path("huge.bin"),
            content: vec![0u8; 17 * 1024 * 1024],
            expected: Precondition::Absent,
        })
        .expect_err("16 MiB is the cap");
    // Typed first: the code is the contract, and a client branches on it.
    match &error {
        vault_server::runtime::MutationFailure::Failed(vault_index::IndexError::Mutation(
            vault_index::MutationError::TooLarge { limit, actual },
        )) => {
            assert_eq!(*limit, vault_index::DEFAULT_MAX_FILE_BYTES);
            assert_eq!(*actual, 17 * 1024 * 1024);
        }
        other => panic!("expected too_large, got {other:?}"),
    }
    // Then the message, because this one refusal carries a genuine obligation:
    // it has to name the deferred alternative, or a caller hitting the cap has
    // nowhere to go.
    let message = format!("{error}");
    assert!(message.contains("16777216"), "{message}");
    assert!(
        message.contains("chunked transfer"),
        "the refusal must name what a caller should do instead: {message}"
    );
    assert!(!live.vault.path().join("huge.bin").exists());
}
```

- [ ] **Step 2: Run the focused test and observe the missing operation**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test raw_files
```

Expected: compilation fails — `Mutation::WriteFile`, `MutationEngine::read_file`, and `RuntimeNotice::ConfigChanged` do not exist.

- [ ] **Step 3: Add raw write and read to the engine**

In `crates/vault-index/src/mutate.rs`, add the variant:

```rust
    WriteFile {
        path: VaultPath,
        content: Vec<u8>,
        expected: Precondition,
    },
```

the `apply` arm:

```rust
            Mutation::WriteFile {
                path,
                content,
                expected,
            } => self.write_file(path, content, expected),
```

and:

```rust
impl MutationEngine {
    /// Raw bytes to any vault file **except a note**, the configuration zone
    /// included.
    ///
    /// A note is refused with [`MutationError::IsANote`], the mirror of
    /// `write_note`'s refusal of a non-`.md` path and for the mirrored reason:
    /// a raw write publishes no generation, so a note written this way would
    /// land bytes the caller could not then read back at any generation it had
    /// been told about. `write_note` serves that path and gives the caller
    /// read-your-writes.
    ///
    /// The consequence is that **every** raw write reports `semantic: false`
    /// and names no changed path: the zone is not indexed, an attachment is
    /// not indexed, and a note cannot arrive here. That is what keeps raw I/O
    /// entirely out of the generation model.
    fn write_file(
        &self,
        path: &VaultPath,
        content: &[u8],
        expected: &Precondition,
    ) -> Result<MutationOutcome, MutationError> {
        if !in_config_zone(path) && is_markdown(path) {
            return Err(MutationError::IsANote { path: path.clone() });
        }
        let actual = content.len() as u64;
        if actual > self.max_file_bytes {
            return Err(MutationError::TooLarge {
                limit: self.max_file_bytes,
                actual,
            });
        }
        let resolved = self.resolve(path)?;
        let current = self.check(path, expected)?;
        if current.is_none() {
            if let Some(existing) = self.case_variant(path)? {
                return Err(MutationError::CaseCollision {
                    path: path.clone(),
                    existing,
                });
            }
        }
        self.recheck(path, expected)?;
        write_atomically(&resolved, content)?;
        Ok(MutationOutcome {
            // Nothing a raw write can reach is indexed, so there is nothing to
            // reconcile and, by the invariant on `MutationOutcome`, nothing
            // semantic either.
            changed_paths: BTreeSet::new(),
            revision: Some(revision_of(content)),
            links_rewritten: 0,
            link_rewrite_failures: Vec::new(),
            semantic: false,
        })
    }

    /// Raw bytes from any vault file, the configuration zone included, with
    /// the revision a later `write_file` would compare against. A note read
    /// this way is byte-identical to `get_note`'s source, without the
    /// semantics.
    pub fn read_file(&self, path: &VaultPath) -> Result<(Vec<u8>, String), MutationError> {
        let resolved = self.resolve(path)?;
        match std::fs::read(&resolved) {
            Ok(bytes) => {
                let revision = revision_of(&bytes);
                Ok((bytes, revision))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(MutationError::NotFound { path: path.clone() })
            }
            Err(error) => Err(io(error)),
        }
    }
}
```

Note that `resolve` already refuses a path whose parent escapes the vault, and `.obsidian` is inside the vault, so the zone needs no special containment handling — only the semantic operations refuse it, which they already do.

- [ ] **Step 4: Cover the raw pair at the engine level too**

`tests/raw_files.rs` drives the runtime; the engine's own suite should carry the two claims that belong to it alone. Append to `crates/vault-index/tests/mutation_write.rs`:

```rust
#[test]
fn a_raw_write_refuses_a_markdown_path_and_write_note_refuses_everything_else() {
    let fixture = fixture();
    let raw_note = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path("Folder/Raw.md"),
            content: b"# Raw\n".to_vec(),
            expected: Precondition::Absent,
        })
        .expect_err("write_file must not reach a note");
    assert!(
        matches!(raw_note, MutationError::IsANote { .. }),
        "expected is_a_note, got {raw_note:?}"
    );
    assert!(!fixture.root.join("Folder/Raw.md").exists());

    // The mirror image, already covered by `a_non_markdown_path_is_not_a_note`
    // above, restated here so the pair reads as one rule: `.md` goes through
    // `write_note`, everything else through `write_file`, and neither crosses.
    let raw_attachment = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path("Folder/data.bin"),
            content: vec![1, 2, 3],
            expected: Precondition::Absent,
        })
        .expect("an attachment is exactly what write_file is for");
    assert!(!raw_attachment.semantic);
    assert!(raw_attachment.changed_paths.is_empty());
}

#[test]
fn a_zone_write_reaches_the_zone_and_stays_out_of_the_change_set() {
    let fixture = fixture();
    std::fs::create_dir_all(fixture.root.join(".obsidian")).expect("create the zone");
    let outcome = fixture
        .engine
        .apply(&Mutation::WriteFile {
            path: path(".obsidian/app.json"),
            content: br#"{"trashOption":"local"}"#.to_vec(),
            expected: Precondition::Any,
        })
        .expect("the zone is writable through the raw pair");
    assert!(!outcome.semantic);
    assert!(outcome.changed_paths.is_empty());
    assert_eq!(
        std::fs::read(fixture.root.join(".obsidian/app.json")).expect("read back"),
        br#"{"trashOption":"local"}"#.to_vec()
    );
}
```

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_write
```

Expected: 13 tests pass — the 11 from Task 5 and these two.

- [ ] **Step 5: Announce zone writes**

In `crates/vault-protocol/src/events.rs`, add:

```rust
/// A file under `.obsidian/` changed. Carries no generation: nothing in the
/// configuration zone is indexed, so no generation contains it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConfigChangedEventDto {
    pub path: String,
}
```

add `ConfigChanged(ConfigChangedEventDto),` to `RuntimeEventDto` (before `Unknown`), and the arm to its visitor:

```rust
                        "config_changed" => RuntimeEventDto::ConfigChanged(map.next_value()?),
```

plus `"config_changed"` in the visitor's trailing `missing_field("value")` match arm list.

In `crates/vault-server/src/runtime.rs`, add to `RuntimeNotice`:

```rust
    /// A file in the configuration zone was written. Not a generation: the
    /// zone is not indexed.
    ConfigChanged { path: VaultPath },
```

and emit it from `Coordinator::apply_mutation`, in the `changed_paths.is_empty()` branch, before the return:

```rust
        if outcome.changed_paths.is_empty() {
            if let Mutation::WriteFile { path, .. } = &mutation {
                if vault_index::in_config_zone(path) {
                    self.emit(RuntimeNotice::ConfigChanged { path: path.clone() });
                }
            }
            return Ok(self.report(&outcome, self.committed_generation()));
        }
```

In `crates/vault-server/src/subscriptions.rs`, add to `events_for`:

```rust
        RuntimeNotice::ConfigChanged { path } => {
            vec![RuntimeEventDto::ConfigChanged(ConfigChangedEventDto {
                path: path.as_str().to_string(),
            })]
        }
```

and to `event_generation`, `RuntimeEventDto::ConfigChanged(_) => None,` alongside `RuntimeStateChanged`. Add `RuntimeEventDto::Unknown => None,` to the same match, so the enum stays exhaustive.

- [ ] **Step 6: Replace the raw-file dispatch placeholders**

In `crates/vault-server/src/lib.rs`:

```rust
            Request::WriteFile(params) => match parse_path(&params.path) {
                Err(error) => ResponseEnvelope::error(id, error),
                Ok(path) => match (
                    convert::precondition(params.expected.as_ref()),
                    convert::decode_base64(&params.content_base64),
                ) {
                    (Err(error), _) | (_, Err(error)) => ResponseEnvelope::error(id, error),
                    (Ok(expected), Ok(content)) => {
                        // The wire's `semantic` answers "is this write inside
                        // the indexed vault", which is a question about the
                        // path — *not* `MutationOutcome::semantic`, which
                        // answers "did indexed rows move" and is always
                        // `false` for a raw write. Computed before `path` is
                        // moved into the mutation.
                        let inside_vault = !vault_index::in_config_zone(&path);
                        match self.mutate(vault_index::Mutation::WriteFile {
                            path,
                            content,
                            expected,
                        }) {
                            Err(error) => ResponseEnvelope::error(id, error),
                            Ok(report) => ResponseEnvelope::success(
                                id,
                                Response::WriteFile(WriteFileResponse {
                                    // Absent for a zone write: no generation
                                    // contains it, and claiming one would be
                                    // a lie a client could act on. For an
                                    // attachment it is the generation the
                                    // client may already read at — the write
                                    // added no rows, so none was published for
                                    // it, and reporting the current one is the
                                    // true answer rather than a manufactured
                                    // one.
                                    generation: inside_vault
                                        .then(|| report.generation.map(vault_index::Generation::get))
                                        .flatten(),
                                    revision: report.revision.unwrap_or_default(),
                                    semantic: inside_vault,
                                }),
                            ),
                        }
                    }
                },
            },
            Request::ReadFile(params) => match (self.reader(), parse_path(&params.path)) {
                (None, _) => ResponseEnvelope::error(id, index_unavailable()),
                (_, Err(error)) => ResponseEnvelope::error(id, error),
                (Some(_), Ok(path)) => match self.read_file(&path) {
                    Err(error) => ResponseEnvelope::error(id, error),
                    Ok((bytes, revision)) => ResponseEnvelope::success(
                        id,
                        Response::ReadFile(ReadFileResponse {
                            content_base64: convert::encode_base64(&bytes),
                            revision,
                        }),
                    ),
                },
            },
```

with the reader-side helper on `Server` (a raw read touches no index state, so it does not go through the coordinator):

```rust
    fn read_file(&self, path: &VaultPath) -> Result<(Vec<u8>, String), ProtocolError> {
        let engine = self
            .engine
            .as_ref()
            .ok_or_else(|| runtime_not_ready("no vault is configured"))?;
        engine.read_file(path).map_err(convert::mutation_error)
    }
```

`Server` gains `engine: Option<vault_index::MutationEngine>`, built in `for_runtime` from the same config the snapshot registry uses.

Add to `crates/vault-server/src/convert.rs`:

```rust
pub(crate) fn decode_base64(value: &str) -> Result<Vec<u8>, ProtocolError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| ProtocolError {
            code: ErrorCode::InvalidRequest,
            message: format!("content_base64 is not valid base64: {error}"),
            supported_version: None,
            current_generation: None,
            current_revision: None,
        })
}

pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
```

and `base64.workspace = true` to `crates/vault-server/Cargo.toml`'s `[dependencies]`.

- [ ] **Step 7: Cover every typed refusal over the wire**

Task 9 Step 7's mapping table has been exercised only for `revision_conflict` (Task 10) and `invalid_request` (Task 9 Step 8). Every remaining code is an arm of a `match` that nothing has run — exactly the shape where a mis-mapped arm ships silently, because the happy path never touches it. Now that every operation that can produce one exists, one compact suite covers the lot.

Create `crates/vault-server/tests/mutation_errors.rs`:

```rust
//! Every typed refusal, over the real transport, in one place. The claim is
//! narrow and worth pinning: a client branches on `code`, so a code that maps
//! to `internal` or to the wrong neighbour is a client bug this daemon caused.

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{ErrorCode, ResponseOutcome};

/// A vault with one note, one attachment, one folder, and a configuration
/// zone: enough for every refusal below without a per-case fixture.
fn fixture() -> (TempDir, TempDir, Daemon) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join("Folder")).expect("create Folder");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(vault.path().join("Folder/Two.md"), "# Two\n").expect("write Two");
    std::fs::write(vault.path().join("image.png"), [1u8, 2, 3]).expect("write an attachment");
    let mut daemon = Daemon::for_vault(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    (vault, index, daemon)
}

#[test]
fn every_state_refusal_reaches_the_wire_with_its_own_code() {
    let (vault, _index, mut daemon) = fixture();

    let cases: [(ErrorCode, &str, &str); 7] = [
        // The target is not there at all.
        (
            ErrorCode::NotFound,
            "delete_note",
            r#"{"path":"Gone.md","mode":"permanent","expected":{"any":true}}"#,
        ),
        // The target's *parent* is not there. Distinct from `not_found`
        // because the fix is different: create the folder, then retry.
        (
            ErrorCode::ParentNotFound,
            "write_note",
            r#"{"path":"Missing/New.md","content":"x\n","expected":{"absent":true}}"#,
        ),
        // There is no overwrite-on-rename.
        (
            ErrorCode::TargetExists,
            "rename_note",
            r#"{"from":"One.md","to":"Folder/Two.md","expected":{"any":true},"rewrite_links":false}"#,
        ),
        // Stricter than Obsidian, on purpose: APFS would silently overwrite.
        (
            ErrorCode::CaseCollision,
            "write_note",
            r#"{"path":"one.md","content":"x\n","expected":{"absent":true}}"#,
        ),
        // Nothing in the zone is ever semantic.
        (
            ErrorCode::ZoneViolation,
            "write_note",
            r#"{"path":".obsidian/note.md","content":"x\n","expected":{"absent":true}}"#,
        ),
        // 16 MiB is the cap; ~22 MB of base64 is comfortably past it and
        // still cheap to build.
        (
            ErrorCode::PayloadTooLarge,
            "write_file",
            "PLACEHOLDER_OVERSIZED",
        ),
        // The fifth concurrent snapshot, against a cap of four.
        (
            ErrorCode::TooManySnapshots,
            "open_snapshot",
            "PLACEHOLDER_FIFTH_SNAPSHOT",
        ),
    ];

    for (expected, method, params) in cases {
        let params = match params {
            "PLACEHOLDER_OVERSIZED" => {
                // 17 MiB of zero bytes, base64-encoded: past the cap, and the
                // encoder is the same one the daemon decodes with.
                use base64::Engine as _;
                let encoded = base64::engine::general_purpose::STANDARD
                    .encode(vec![0u8; 17 * 1024 * 1024]);
                format!(r#"{{"path":"huge.bin","content_base64":"{encoded}","expected":{{"absent":true}}}}"#)
            }
            "PLACEHOLDER_FIFTH_SNAPSHOT" => {
                // The default cap is four. Open four and leave them open; the
                // fifth is the case under test.
                for index in 0..4 {
                    let opened = daemon.call(&format!(
                        r#"{{"version":1,"id":"s{index}","request":{{"method":"open_snapshot","params":{{}}}}}}"#
                    ));
                    assert!(
                        matches!(opened.outcome, ResponseOutcome::Ok(_)),
                        "snapshot {index} of the first four must open: {:?}",
                        opened.outcome
                    );
                }
                "{}".to_string()
            }
            other => other.to_string(),
        };
        let response = daemon.call(&format!(
            r#"{{"version":1,"id":"e","request":{{"method":"{method}","params":{params}}}}}"#
        ));
        match response.outcome {
            ResponseOutcome::Err(error) => assert_eq!(
                error.code, expected,
                "wrong code for {method}: {error:?}"
            ),
            other => panic!("{method} was not refused: {other:?}"),
        }
    }

    // Every refusal above changed nothing.
    assert_eq!(
        std::fs::read(vault.path().join("One.md")).expect("read back"),
        b"# One\n"
    );
    assert_eq!(
        std::fs::read(vault.path().join("Folder/Two.md")).expect("read back"),
        b"# Two\n"
    );
    assert!(!vault.path().join("huge.bin").exists());
    assert!(!vault.path().join("Missing").exists());
    assert!(!vault.path().join(".obsidian/note.md").exists());
}

#[test]
fn content_that_is_not_base64_is_refused_before_anything_is_written() {
    let (vault, _index, mut daemon) = fixture();
    for encoded in ["not base64 at all!", "AAE", "====", "AA=A"] {
        let response = daemon.call(&format!(
            r#"{{"version":1,"id":"b","request":{{"method":"write_file","params":{{"path":"raw.bin","content_base64":"{encoded}","expected":{{"absent":true}}}}}}}}"#
        ));
        match response.outcome {
            ResponseOutcome::Err(error) => {
                assert_eq!(
                    error.code,
                    ErrorCode::InvalidRequest,
                    "wrong code for {encoded:?}: {error:?}"
                );
                assert!(
                    error.message.contains("content_base64"),
                    "the refusal must name the field: {}",
                    error.message
                );
            }
            other => panic!("{encoded:?} was accepted as base64: {other:?}"),
        }
    }
    assert!(!vault.path().join("raw.bin").exists());
}
```

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test mutation_errors
```

Expected: both tests pass. Between this file, Task 9 Step 8's precondition cases, Task 10's `revision_conflict`, and Task 17's `read_only`, every code Task 2 and Task 3 added is now produced by a real request at least once.

- [ ] **Step 8: Run the focused tests and confirm they pass**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test raw_files
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test mutation_errors
TMPDIR="$PWD/target/tmp" cargo test -p vault-index --test mutation_write
```

Expected: the six raw-file tests, the two error tests, and the thirteen write tests pass.

- [ ] **Step 9: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/mutate.rs crates/vault-index/tests/mutation_write.rs \
        crates/vault-protocol/src/events.rs crates/vault-protocol/src/mutations.rs \
        crates/vault-server/Cargo.toml Cargo.lock \
        crates/vault-server/src/runtime.rs crates/vault-server/src/subscriptions.rs \
        crates/vault-server/src/lib.rs crates/vault-server/src/convert.rs \
        crates/vault-server/tests/raw_files.rs crates/vault-server/tests/mutation_errors.rs
git commit -m "feat(server): add raw file io and the obsidian zone semantics"
```

---

### Task 17: `--read-only`

**Files:**

- Modify: `crates/vault-server/src/main.rs` (`Cli`, lines 12–63, **and the module doc comment above it**)
- Modify: `crates/vault-server/src/runtime.rs` (`RuntimeOptions` — today `watch`, `watch_config`, `reconcile_interval`, `command_capacity` — and `Runtime::start_with_hooks`)
- Create: `crates/vault-server/tests/read_only.rs`

**Interfaces:**

- Consumes: `IndexService::set_read_only` (Task 9), `IndexService::apply_mutation`'s read-only preflight (Task 12), `MutationError::ReadOnly` → `ErrorCode::ReadOnly` (Tasks 4, 9), the shared `tests/daemon/mod.rs` harness (Task 9).
- Produces: `RuntimeOptions::read_only: bool` (defaulting to `false` in its `Default` impl) and the `--read-only` flag.
- Note the dependency on Task 12: `every_mutating_operation_is_refused_with_the_read_only_code` sends a `rename_folder` for a folder that does not exist. Without Task 12's preflight that request enumerates the missing folder first and answers `storage_failure`; with it, it answers `read_only`. If that one case fails and the other nine pass, the preflight is what is missing — fix `apply_mutation`, never the fixture.

- [ ] **Step 1: Write the failing read-only test**

Create `crates/vault-server/tests/read_only.rs`. It uses the shared `tests/daemon/mod.rs` harness from Task 9 Step 8 — the same `Daemon`, `Daemon::start`, and `call` that `snapshots.rs` and `mutation_errors.rs` use, with one local constructor for the extra flag:

```rust
//! `--read-only`: every mutating operation refuses with a dedicated code;
//! every read, and every snapshot, is unaffected.

mod daemon;

use daemon::Daemon;
use tempfile::TempDir;
use vault_protocol::{ErrorCode, Response, ResponseOutcome};

/// `Daemon::for_vault`'s arguments plus the flag under test. Spelled out
/// rather than derived from it, because the flag's position in the list is
/// part of what this test exercises: `--read-only` carries `requires =
/// "vault"`, so a daemon started without `--vault` must reject it outright.
fn read_only_daemon(vault: &TempDir, index: &TempDir) -> Daemon {
    Daemon::start(&[
        "--vault",
        vault.path().to_str().expect("utf-8 vault path"),
        "--index",
        index
            .path()
            .join("index.sqlite3")
            .to_str()
            .expect("utf-8 index path"),
        "--no-watch",
        "--reconcile-interval-seconds",
        "0",
        "--read-only",
    ])
}

#[test]
fn every_mutating_operation_is_refused_with_the_read_only_code() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::create_dir_all(vault.path().join(".obsidian")).expect("create the zone");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    std::fs::write(vault.path().join(".obsidian/app.json"), "{}").expect("write app.json");

    let mut daemon = read_only_daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let attempts = [
        r#"{"version":1,"id":"1","request":{"method":"write_note","params":{"path":"New.md","content":"x\n","expected":{"absent":true}}}}"#,
        r#"{"version":1,"id":"2","request":{"method":"create_folder","params":{"path":"Folder"}}}"#,
        r#"{"version":1,"id":"3","request":{"method":"rename_note","params":{"from":"One.md","to":"Two.md","expected":{"any":true},"rewrite_links":true}}}"#,
        r#"{"version":1,"id":"4","request":{"method":"rename_folder","params":{"from":"A","to":"B","rewrite_links":true}}}"#,
        r#"{"version":1,"id":"5","request":{"method":"copy_file","params":{"from":"One.md","to":"Copy.md","expected_source":{"any":true},"if_exists":"error"}}}"#,
        r#"{"version":1,"id":"6","request":{"method":"delete_note","params":{"path":"One.md","mode":"permanent","expected":{"any":true}}}}"#,
        r#"{"version":1,"id":"7","request":{"method":"delete_folder","params":{"path":"A","mode":"permanent","recursive":true}}}"#,
        r#"{"version":1,"id":"8","request":{"method":"patch_frontmatter","params":{"path":"One.md","patch":[{"key_path":"a","value":"b"}],"expected":{"any":true}}}}"#,
        r#"{"version":1,"id":"9","request":{"method":"write_file","params":{"path":"raw.bin","content_base64":"AAEC","expected":{"absent":true}}}}"#,
        r#"{"version":1,"id":"10","request":{"method":"write_file","params":{"path":".obsidian/app.json","content_base64":"e30=","expected":{"any":true}}}}"#,
    ];
    for attempt in attempts {
        let response = daemon.call(attempt);
        match response.outcome {
            ResponseOutcome::Err(error) => assert_eq!(
                error.code,
                ErrorCode::ReadOnly,
                "wrong code for {attempt}: {error:?}"
            ),
            other => panic!("{attempt} was not refused: {other:?}"),
        }
    }

    assert_eq!(
        std::fs::read(vault.path().join("One.md")).expect("read back"),
        b"# One\n"
    );
    assert!(!vault.path().join("New.md").exists());
    assert!(!vault.path().join("Folder").exists());
    assert_eq!(
        std::fs::read(vault.path().join(".obsidian/app.json")).expect("read back"),
        b"{}",
        "a zone write is a mutating operation too"
    );
}

#[test]
fn reads_and_snapshots_are_unaffected_by_read_only() {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");

    let mut daemon = read_only_daemon(&vault, &index);
    daemon.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    let note = daemon.call(r#"{"version":1,"id":"g","request":{"method":"get_note","params":{"path":"One.md"}}}"#);
    assert!(matches!(note.outcome, ResponseOutcome::Ok(_)));

    let opened = daemon.call(r#"{"version":1,"id":"o","request":{"method":"open_snapshot","params":{}}}"#);
    let snapshot_id = match opened.outcome {
        ResponseOutcome::Ok(Response::OpenSnapshot(response)) => response.snapshot_id,
        other => panic!("open_snapshot failed under --read-only: {other:?}"),
    };
    let page = daemon.call(&format!(
        r#"{{"version":1,"id":"t","request":{{"method":"snapshot_tree","params":{{"snapshot_id":"{snapshot_id}"}}}}}}"#
    ));
    assert!(matches!(page.outcome, ResponseOutcome::Ok(_)));

    let read = daemon.call(r#"{"version":1,"id":"f","request":{"method":"read_file","params":{"path":"One.md"}}}"#);
    assert!(
        matches!(read.outcome, ResponseOutcome::Ok(_)),
        "read_file is a read"
    );
}
```

- [ ] **Step 2: Run the focused test and observe the unknown flag**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test read_only
```

Expected: both tests fail — `vaultd` exits with a clap error for the unrecognized `--read-only`, so the first call times out or the daemon exits immediately.

- [ ] **Step 3: Add the flag and plumb it to the engine**

In `crates/vault-server/src/main.rs`, add to `Cli`:

```rust
    /// Refuse every operation that would write into the vault. Reads,
    /// snapshot sessions, and reconciliation are unaffected.
    #[arg(long, default_value_t = false, requires = "vault")]
    read_only: bool,
```

and to `runtime_options`'s `RuntimeOptions` literal, `read_only: self.read_only,`.

**Update the module's own doc comment in the same edit.** `main.rs` opens by describing the daemon's flags, and this is the fourth to land; leaving it describing three is exactly the stale-documentation defect the compiler will never catch. Say that `--read-only` refuses every vault write while leaving reads, snapshot sessions, and reconciliation untouched, and that it requires `--vault`.

In `crates/vault-server/src/runtime.rs`, add `pub read_only: bool,` to `RuntimeOptions` with `read_only: false` in its `Default`, and set it on the service in `start_with_hooks`, immediately after `IndexService::open`:

```rust
        let mut index = IndexService::open(config.clone())?;
        // Before the reader exists and before the coordinator thread starts,
        // so no mutation can ever run against a service that has not been
        // told yet.
        index.set_read_only(options.read_only);
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test read_only
```

Expected: both tests pass.

- [ ] **Step 5: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-server/src/main.rs crates/vault-server/src/runtime.rs \
        crates/vault-server/tests/read_only.rs
git commit -m "feat(server): add a read-only mode that refuses every vault write"
```

---

### Task 18: Benchmarks, protocol documentation, and the baseline note

Baselines, not contracts — the phase-4 policy — each tied to a named benchmark case, so a regression has somewhere to show up.

**Files:**

- Modify: `crates/vault-index/src/bin/vault-bench.rs`
- Modify: `crates/vault-server/src/bin/vault-live-bench.rs`
- Modify: `docs/protocol.md`
- Modify: `crates/vault-server/tests/docs.rs`
- Create: `docs/performance/vault-mutation-baseline.md`
- Modify: `README.md`, `VAULTD-COMPATIBILITY.md`

**Interfaces:**

- Consumes: everything Tasks 1–17 produced.
- Produces: `vault-bench --mutations` with the cases `write_note_commit`, `patch_frontmatter_commit`, `delete_note_commit`, and `rename_fanout_{0,10,100,1000}`; `vault-live-bench`'s `snapshot_hydration` case.
- Produces: no library API.

- [ ] **Step 1: Add the mutation benchmark cases**

The binary's clap struct is named `Args` (not `Cli`), and it already carries `--notes`, `--repeats`, `--vault`, and `--live`. Add the fifth flag beside `--live`:

```rust
    /// Also run the mutation cases: a committed write, a committed
    /// frontmatter patch, a committed delete, and the rename fan-out matrix.
    /// Skipped in `--vault` mode, which performs no source writes.
    #[arg(long, default_value_t = false)]
    mutations: bool,
```

add `mutation_cases: Vec<CaseReport>` to `BenchmarkReport` (empty unless `--mutations`, exactly as `live_cases` is empty unless `--live`), and add the cases.

**`CaseSample` has no constructor.** It is a plain three-field struct at `vault-bench.rs:308` — `elapsed_ms: f64`, `metrics: ReconcileMetrics`, `affected_references: u64` — and every existing site builds it as a struct literal, including `measure` at line 362. There is no `impl CaseSample` anywhere in the workspace and therefore no `from_report`; build the literal the way `measure` does. Each case measures **mutation plus its reconciliation**, which is the number a client actually waits for:

```rust
/// One `write_note` through the engine plus the targeted reconciliation that
/// publishes it: exactly what a client blocks on, and the figure the design's
/// "p50 < 25 ms at 100k notes" target names.
fn case_write_note_commit(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let engine = vault_index::MutationEngine::new(vault_root);
    let path = VaultPath::new("bench-mutation.md").expect("valid vault path");
    // Seeded outside the timed loop, so no repeat measures a create where the
    // others measure a replace.
    write_note_body(vault_root, "bench-mutation.md", "# Bench seed\n");
    seed(service, [path.clone()]);

    let mut samples = Vec::with_capacity(repeats);
    for repeat in 0..repeats {
        let content = format!("# Bench {repeat}\n\nbench-target-0\n");
        let start = Instant::now();
        engine
            .apply(&vault_index::Mutation::WriteNote {
                path: path.clone(),
                content,
                expected: vault_index::Precondition::Any,
            })
            .expect("bench write");
        let report = service
            .refresh_paths(BTreeSet::from([path.clone()]), ChangeCause::Mutation)
            .expect("bench reconcile");
        let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
        samples.push(CaseSample {
            elapsed_ms,
            metrics: report.metrics,
            affected_references: report.affected_reference_count,
        });
    }
    case_report("write_note_commit", notes, &samples)
}

/// One `patch_frontmatter` plus its reconciliation. The patch addresses a
/// top-level key, so it takes the span-surgery path — the one a plugin's
/// `processFrontMatter` shim hits on every call.
fn case_patch_frontmatter_commit(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let engine = vault_index::MutationEngine::new(vault_root);
    let path = VaultPath::new("bench-patch.md").expect("valid vault path");
    write_note_body(
        vault_root,
        "bench-patch.md",
        "---\ntitle: seed\ncount: 0\n---\n# Bench\n\nbody\n",
    );
    seed(service, [path.clone()]);

    let mut samples = Vec::with_capacity(repeats);
    for repeat in 0..repeats {
        let edit = vault_index::FrontmatterEdit {
            key_path: vec!["title".to_string()],
            value: Some(vault_index::PatchValue::String(format!("bench {repeat}"))),
        };
        let start = Instant::now();
        engine
            .apply(&vault_index::Mutation::PatchFrontmatter {
                path: path.clone(),
                patch: vec![edit],
                expected: vault_index::Precondition::Any,
            })
            .expect("bench patch");
        let report = service
            .refresh_paths(BTreeSet::from([path.clone()]), ChangeCause::Mutation)
            .expect("bench reconcile");
        let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
        samples.push(CaseSample {
            elapsed_ms,
            metrics: report.metrics,
            affected_references: report.affected_reference_count,
        });
    }
    case_report("patch_frontmatter_commit", notes, &samples)
}

/// One `delete_note` plus its reconciliation. The note is written back
/// *before* each timed section, so every repeat deletes the same thing rather
/// than the first deleting a note and the rest refusing.
fn case_delete_note_commit(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let engine = vault_index::MutationEngine::new(vault_root);
    let path = VaultPath::new("bench-delete.md").expect("valid vault path");

    let mut samples = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        write_note_body(vault_root, "bench-delete.md", "# Bench delete\n");
        seed(service, [path.clone()]);
        let start = Instant::now();
        engine
            .apply(&vault_index::Mutation::DeleteNote {
                path: path.clone(),
                // Never the system trash in a benchmark: it would measure the
                // platform's trash implementation and leave the operator's
                // trash full of fixtures.
                mode: Some(vault_index::DeleteMode::Permanent),
                expected: vault_index::Precondition::Any,
            })
            .expect("bench delete");
        let report = service
            .refresh_paths(BTreeSet::from([path.clone()]), ChangeCause::Mutation)
            .expect("bench reconcile");
        let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
        samples.push(CaseSample {
            elapsed_ms,
            metrics: report.metrics,
            affected_references: report.affected_reference_count,
        });
    }
    case_report("delete_note_commit", notes, &samples)
}
```

`write_note_body`, `seed`, `case_report`, and `CaseSample` are the file's existing helpers; `Instant`, `BTreeSet`, `Path`, `VaultPath`, `IndexService`, and `ChangeCause` are already imported there. Dispatch the three from `run_mutation_cases`, alongside the existing `run_live_cases`, and call it from `main` when `args.mutations` is set and `args.vault` is not.

- [ ] **Step 2: Add the rename fan-out matrix**

Still in `vault-bench.rs`, the fan-out matrix the design asks for — 0, 10, 100, and 1000 inbound links, matching the phase-4 benchmark-matrix practice rather than one arbitrary point:

```rust
/// Rename with link repair at four fan-outs. Each repeat builds its own
/// referrers, reconciles them into the index, then times the whole burst:
/// planning, every rewrite, the move, and the single reconciliation that
/// publishes all of it.
///
/// Four points rather than one, matching the phase-4 benchmark-matrix
/// practice: repair is the one operation in this phase whose cost is
/// unbounded in the vault's shape, and a single measurement of it would say
/// nothing about the curve.
fn case_rename_fanout(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> Vec<CaseReport> {
    let mut reports = Vec::new();
    for fanout in [0usize, 10, 100, 1_000] {
        let mut samples = Vec::with_capacity(repeats);
        for repeat in 0..repeats {
            // A fresh target and a fresh set of referrers per repeat: a rename
            // is not idempotent, and reusing names across repeats would time a
            // refusal instead of a rename.
            let target = format!("bench-rename-{fanout}-{repeat}");
            let mut dirty = BTreeSet::new();
            dirty.insert(write_note_body(
                vault_root,
                &format!("{target}.md"),
                "# Target\n\ntext ^block\n",
            ));
            for index in 0..fanout {
                dirty.insert(write_note_body(
                    vault_root,
                    &format!("bench-referrer-{fanout}-{repeat}-{index}.md"),
                    &format!("{target}\n"),
                ));
            }
            // Untimed: the burst is what this case measures, not the fixture.
            service
                .refresh_paths(dirty, ChangeCause::Manual)
                .expect("index the fan-out fixture");

            let from = VaultPath::new(format!("{target}.md")).expect("valid vault path");
            let to = VaultPath::new(format!("{target}-renamed.md")).expect("valid vault path");
            let start = Instant::now();
            let outcome = service
                .apply_mutation(&vault_index::Mutation::RenameNote {
                    from,
                    to,
                    expected: vault_index::Precondition::Any,
                    rewrite_links: true,
                })
                .expect("bench rename");
            let report = service
                .refresh_paths(outcome.changed_paths, ChangeCause::Mutation)
                .expect("bench reconcile");
            let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
            samples.push(CaseSample {
                elapsed_ms,
                metrics: report.metrics,
                affected_references: report.affected_reference_count,
            });
        }
        reports.push(case_report(
            &format!("rename_fanout_{fanout}"),
            notes,
            &samples,
        ));
    }
    reports
}
```

**Warning — this case cannot see the repair planner's other cost axis.** `rename_fanout_*` varies *fan-out* against a **fixed** vault, and `mutate::rename::plan_repair` rebuilds a whole-vault `Resolver` from `LiveGraph::note_paths()` on every repairing rename: one `ResolutionNote` clone per note in the vault, headings and block ids included. That is O(vault), not O(fan-out), so it appears as a constant offset in all four points here and the curve looks flat in exactly the term that is not. Read these numbers as the fan-out curve only; the vault-size term needs its own case (same fan-out, vault size varied) or it will not be measured at all. The follow-up that removes the cost — resolving from the live graph's own candidate index instead of a rebuilt catalog — is tracked as *"Resolve rename repair spellings from the live graph's candidate index"*.

Note the two deliberate choices a reviewer should check rather than assume. The fixture reconciliation uses `ChangeCause::Manual`, matching the file's existing `seed` helper, so the *timed* section is the only thing tagged `Mutation` and a stage profile can be read without filtering. And `write_note_body` returns the `VaultPath` it wrote, which is why the dirty set is built from its return value rather than reconstructed — the existing live cases do the same.

- [ ] **Step 3: Add the hydration case to the runtime benchmark**

In `crates/vault-server/src/bin/vault-live-bench.rs`, add a `snapshot_hydration` case. The binary's clap struct there is also `Args` (`--notes`, `--repeats`), its report is `LiveBenchReport { schema, notes, repeats, cases }`, and every case is a `measure_*` function returning a `CaseReport` that `main` pushes into the `cases: vec![…]` literal. This one follows that shape exactly:

```rust
/// A whole vault hydrated through one snapshot session: open, page the entire
/// tree, page every note's `metadata` and `references` facets, close.
///
/// This is the operation the headless host performs once at startup and the
/// only one in the phase whose cost is proportional to the whole vault, so it
/// is the design's "< 10 s wall, < 256 MiB peak added RSS at 100k notes"
/// target — measured, so it can fail.
///
/// Bodies are deliberately not requested: `snapshot_notes` carries row-sets
/// and `get_note` carries bodies, and a hydration that dragged every body
/// through would measure something no host does.
fn measure_snapshot_hydration(
    vault_root: &Path,
    index_path: &Path,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let config = IndexConfig::explicit(vault_root, index_path).expect("bench config");
    let facets = vault_index::NoteFacets {
        metadata: true,
        references: true,
        resolutions: false,
        backlinks: false,
        sections: false,
        list_items: false,
    };

    let mut samples = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        // A fresh registry per repeat, so no repeat benefits from the page
        // cache a previous session's transaction left warm.
        let mut sessions = vault_index::SnapshotSessions::new(&config);
        let start = Instant::now();
        let opened = sessions.open().expect("open a snapshot");

        let mut entries = 0u64;
        let mut cursor: Option<String> = None;
        loop {
            let page = sessions
                .tree_page(&opened.snapshot_id, cursor.as_deref(), None)
                .expect("a tree page");
            entries += page.entries.len() as u64;
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        let mut hydrated = 0u64;
        let mut cursor: Option<String> = None;
        loop {
            let page = sessions
                .notes_page(&opened.snapshot_id, cursor.as_deref(), None, facets)
                .expect("a notes page");
            hydrated += page.notes.len() as u64;
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        sessions
            .close(&opened.snapshot_id)
            .expect("close the snapshot");
        let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;

        // The counts the session promised at open are the counts it delivered.
        // A hydration that silently paged short would otherwise look fast.
        assert_eq!(entries, opened.entry_count, "the tree paged short");
        assert_eq!(hydrated, opened.note_count, "the notes paged short");

        samples.push(CaseSample {
            elapsed_ms,
            metrics: ReconcileMetrics::default(),
            affected_references: hydrated,
        });
    }
    case_report("snapshot_hydration", notes, &samples)
}
```

`ReconcileMetrics::default()` because no reconciliation happens here — `case_compact_graph_hydration` in `vault-bench.rs` already sets that precedent for a case that measures a read rather than a refresh. Add `measure_snapshot_hydration(&vault_root, &index_path, args.notes, args.repeats)` to `main`'s `cases: vec![…]` literal, after `lag_recovery`.

- [ ] **Step 4: Produce the numbers**

Run:

```bash
mkdir -p /tmp/vaultd-bench
cargo build --release -p vault-index --bin vault-bench
cargo build --release -p vault-server --bin vault-live-bench
./target/release/vault-bench --notes 10000 --repeats 7 --mutations > /tmp/vaultd-bench/vaultd-mutations-10k.json
./target/release/vault-bench --notes 100000 --repeats 7 --mutations > /tmp/vaultd-bench/vaultd-mutations-100k.json
./target/release/vault-live-bench --notes 10000 --repeats 7 > /tmp/vaultd-bench/vaultd-hydration-10k.json
./target/release/vault-live-bench --notes 100000 --repeats 3 > /tmp/vaultd-bench/vaultd-hydration-100k.json
python3 -m json.tool /tmp/vaultd-bench/vaultd-mutations-10k.json >/dev/null
python3 -m json.tool /tmp/vaultd-bench/vaultd-mutations-100k.json >/dev/null
python3 -m json.tool /tmp/vaultd-bench/vaultd-hydration-10k.json >/dev/null
python3 -m json.tool /tmp/vaultd-bench/vaultd-hydration-100k.json >/dev/null
```

Expected: four valid JSON reports. Profile the stage distributions inside them **before** considering any tuning change, per the phase-4 rule; record that you did, and what you concluded, in the baseline note's own "Profiling before tuning" section.

- [ ] **Step 5: Write the baseline note**

Create `docs/performance/vault-mutation-baseline.md`, following `docs/performance/live-incremental-baseline.md`'s structure exactly: an environment block (date, OS, CPU, RAM, rustc version, commit), the commands above, a "Profiling before tuning" section, one table per scale with a row per case, and a "Target comparison" section stating each design target and whether the measured p50/p95 lands inside it:

- `write_note` → committed: p50 < 25 ms, p95 < 100 ms at 100k notes (against 133 ms p50 for the watcher path in `docs/performance/live-incremental-baseline.md` — mutations skip the debounce, which is the whole reason the target is lower);
- `rename_note` at the 120-inbound-link case: p50 < 500 ms including rewrites, with the curve reported at 0/10/100/1000;
- full hydration through a snapshot session (tree plus semantic rows, no bodies) at 100k notes: < 10 s wall, < 256 MiB peak added RSS.

State honestly where a target is missed rather than adjusting the target.

- [ ] **Step 6: Document every new operation in `docs/protocol.md`**

Add, in the existing document's own style — one `###` per operation with a request example and a response example, both as fenced `json` blocks (`crates/vault-server/tests/protocol_doc_examples.rs` deserializes every one of them against the real DTOs, so a drifted example fails the suite):

- a `## Mutations` section introducing the preconditions (`{"revision": …}`, `{"absent": true}`, `{"any": true}`), their per-operation validity, and the statement that **a mutation response is sent only after its own reconciliation has published, so a client that completes a write can immediately read its result at the returned generation**;
- `### write_note`, `### create_folder`, `### rename_note`, `### rename_folder`, `### copy_file`, `### delete_note`, `### delete_folder`, `### patch_frontmatter`, `### write_file`, `### read_file`;
- a `## Read-modify-write` subsection documenting the client CAS-retry loop over `get_note` + `write_note`, and stating that there is no server-side `process` operation;
- a `## Snapshot sessions` section with `### open_snapshot`, `### snapshot_tree`, `### snapshot_notes`, `### close_snapshot`, stating the idle timeout (60 s since the last page), the concurrency cap (4), the page size (default 500, maximum 2000), that all three are daemon configuration rather than protocol, that a client disconnect releases every session, and that **an entire session is coherent at one generation — tree entries and semantic rows alike — because both come from the same pinned read transaction**. Do not carry over the earlier draft's caveat that folder and attachment entries are a filesystem observation taken at `open_snapshot`: the design's *Supersedes correction #10* withdrew it when `tree_entries` joined the schema, and repeating it would tell a host to build a reconciliation path it does not need. State also that each `snapshot_tree` entry carries `ctime_unix_ms`, `mtime_unix_ms`, and `size`, which is what a host serves `TFile.stat` from, and that `snapshot_notes`' `sections` and `list_items` are top-level facets carrying `block_id` and the two line-number parent fields respectively;
- the `.obsidian` zone rules: `read_file`/`write_file` accept zone paths, every semantic operation refuses them with `zone_violation`, a zone write joins no generation and answers `semantic: false`, and it emits a `config_changed` event. State the mirror rule too: `write_file` refuses a `.md` path outside the zone with `invalid_request`, because a note must go through `write_note` to join a generation, and `read_file` reads any path including a note;
- the new event: `### config_changed`, and `mutation` as a `generation_committed` `cause`;
- the new error codes in `## Errors`, appended to that section's existing bullet list of 19 codes, **each spelled exactly once and exactly as the wire spells it** — these spellings are the canon the headless plugin host plan will consume, so a rename here is a downstream break: `revision_conflict` (carries `current_generation` and `current_revision`), `not_found`, `parent_not_found`, `target_exists`, `case_collision`, `zone_violation`, `payload_too_large` (16 MiB; names chunked transfer as the deferred alternative), `read_only`, `snapshot_not_found`, `too_many_snapshots`. Before committing, check the section for duplicates: `grep -c '^- \`<code>\`' docs/protocol.md` must be `1` for every one of the ten. Note also that `unknown` is reserved and never emitted, per Task 1;
- `--read-only` in `## Daemon configuration`;
- in `## Reserved operation families`, strike `apply_mutation` from the reserved list and note that the family landed as the named operations above, exactly as the `subscribe` note already reads.

- [ ] **Step 7: Pin the documentation with tests**

In `crates/vault-server/tests/docs.rs`, add:

```rust
#[test]
fn the_protocol_documents_the_write_path() {
    assert_document_contains(
        "docs/protocol.md",
        &[
            "## Mutations",
            "write_note",
            "patch_frontmatter",
            "rename_note",
            "revision_conflict",
            "case_collision",
            "read-modify-write",
            "## Snapshot sessions",
            "open_snapshot",
            "snapshot_notes",
            "config_changed",
            "--read-only",
        ],
    );
}

#[test]
fn the_mutation_baseline_declares_its_targets() {
    assert_document_contains(
        "docs/performance/vault-mutation-baseline.md",
        &[
            "write_note_commit",
            "rename_fanout_1000",
            "snapshot_hydration",
            "Profiling before tuning",
            "Target comparison",
        ],
    );
}

/// Every new error code appears in `## Errors` exactly once. A code documented
/// twice is a code two people edited independently, and a code documented zero
/// times is one a client meets with no way to look it up.
#[test]
fn every_new_error_code_is_documented_exactly_once() {
    // `read_document` is factored out of the existing `assert_document_contains`
    // in this file, so both resolve the path the same way; do not hand-roll a
    // second `std::fs::read_to_string` with its own relative path.
    let document = read_document("docs/protocol.md");
    for code in [
        "revision_conflict",
        "not_found",
        "parent_not_found",
        "target_exists",
        "case_collision",
        "zone_violation",
        "payload_too_large",
        "read_only",
        "snapshot_not_found",
        "too_many_snapshots",
    ] {
        let definitions = document
            .lines()
            .filter(|line| line.starts_with(&format!("- `{code}`")))
            .count();
        assert_eq!(definitions, 1, "`{code}` is defined {definitions} times");
    }
}
```

`not_found` needs care in that test: `parent_not_found` also ends in `not_found`, and `snapshot_not_found` does too. Matching on the `- \`{code}\`` line prefix rather than on a bare substring is what keeps the three apart — a `contains` check would count all three against `not_found` and pass for the wrong reason.

Update `README.md` (the feature list and non-goals: a write path exists; transactions, conflict merging, journaling, undo, and Sync do not) and `VAULTD-COMPATIBILITY.md` (Tier 0 now includes writes: temp-then-rename atomicity, the `.trash` disposition, and the deliberate divergence from Obsidian on case-insensitive collisions, where `vaultd` refuses and Obsidian mishandles).

Run:

```bash
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test docs
TMPDIR="$PWD/target/tmp" cargo test -p vault-server --test protocol_doc_examples
```

Expected: both pass — every fenced example deserializes against the real DTOs.

- [ ] **Step 8: Run the gate and commit**

Run:

```bash
mkdir -p "$PWD/target/tmp"
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
TMPDIR="$PWD/target/tmp" cargo +1.85.0 check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
git add crates/vault-index/src/bin/vault-bench.rs \
        crates/vault-server/src/bin/vault-live-bench.rs \
        crates/vault-server/tests/docs.rs \
        docs/protocol.md docs/performance/vault-mutation-baseline.md \
        README.md VAULTD-COMPATIBILITY.md
git commit -m "docs: record the mutation protocol and its performance baseline"
```

- [ ] **Step 9: Get an independent fresh-context review of the whole phase**

The phase is code-complete. Before it is called done, it gets one review from a context that did **not** write it — the `/code-review` skill at `high` effort over the full diff from `99264d4`, or a separately-dispatched review subagent with the same brief. An author reviewing their own eighteen tasks re-reads what they meant; a fresh context reads what is there.

Brief the reviewer on what to weigh, in this order:

1. **Correctness of the write path.** Can any refusal leave a partial write? Can any mutation reach the filesystem without its path being contained? Is `semantic == !changed_paths.is_empty()` actually true in every constructor?
2. **Conformance to the two authorities.** The design's Rulings and its three corrections, and the pre-task's pinned DDL — column names, the line-number parent model, `block_id`, the one-character `task`.
3. **Protocol stability.** No existing serialized form moved; every new spelling matches `docs/protocol.md`; the examples deserialize.
4. **Test honesty.** Does each test fail for the reason its name claims? Are there assertions that would pass against a broken implementation?

Style nits are out of scope. **For each high-confidence finding, apply the fix, commit it with a `fix(…)` message naming the issue, and re-run the gate** — one commit per finding, so a later reader can see what review caught. If the review comes back genuinely clean, say so; that is a result, not a formality skipped.

---

## Definition of done

The phase is complete when all of the following hold:

- every task's focused tests and the full workspace suite pass under `TMPDIR="$PWD/target/tmp"`, and `cargo +1.85.0 check --workspace --all-targets` passes;
- the randomized equivalence oracle passes with mutation operations in its alphabet — mutations and external edits are indistinguishable to the semantic layer;
- a `write_note`, `patch_frontmatter`, `rename_note`, `delete_note`, `copy_file`, `create_folder`, `delete_folder`, `rename_folder`, `write_file`, and `read_file` each work through the real daemon, with the documented typed refusals;
- read-your-writes and read-your-deletes hold at the process level;
- rename link repair preserves spelling, upgrades on ambiguity, skips-and-reports a concurrently-edited referrer, and converges after a crash between the rewrites and the move;
- a snapshot session pages the whole tree and every note's facets at its pinned generation under a concurrent write storm, is reclaimed when idle, is capped, and is released on disconnect;
- `--read-only` refuses every mutating operation, the `.obsidian` zone included, with `read_only`;
- `docs/protocol.md` documents every new operation, event, and error code, and its examples deserialize against the real DTOs;
- `docs/performance/vault-mutation-baseline.md` reports each named case at both scales against its stated target;
- an independent fresh-context review has run over the whole phase and every high-confidence finding is fixed and committed.

## Spec coverage matrix

Every requirement the design states, and the task that discharges it. Descriptive, not aspirational: where this plan does **not** cover something the design mentions, the row says so and says why.

| Design requirement | Where it lands |
| --- | --- |
| Wire-compatibility prerequisite: unknown-variant tolerance before any enum grows | Task 1 |
| `write_note` | Tasks 2 (DTO), 5 (engine), 9 (dispatch) |
| `create_folder` | Tasks 2, 6, 9 |
| `rename_note`, `rename_folder` (movement) | Tasks 2, 7, 9 |
| `copy_file`, including `if_exists: "suffix"` | Tasks 2, 7, 9 |
| `delete_note`, `delete_folder`, three delete modes | Tasks 2, 6, 9 |
| `patch_frontmatter`, both granularities per correction #9 | Tasks 2, 8, 9 |
| `write_file` / `read_file` and the `.obsidian` zone | Tasks 2, 16 |
| Read-modify-write as a documented client CAS loop (ruling 2) | Task 18 Step 6, `## Read-modify-write` |
| Read-your-writes: response sent only after its reconciliation published | Task 9 Steps 1, 5 |
| CAS against **bytes on disk**, not the index (correction #8) | Task 4 Step 3, Task 10 Step 3's re-check |
| Byte fidelity outside addressed spans | Task 8 Steps 1, 5 |
| Addition dialect pinned byte-exactly (ruling 5, as narrowed by #9) | Task 8 Step 1 |
| Rename link repair: two-tier, spelling-preserving, per-file CAS | Task 12 |
| Rename crash ordering: referrers first, move last, convergent | Task 12 Steps 1, 5 |
| Case-collision detection and refusal (ruling 4) | Tasks 4, 5, 7 |
| `write_file` size cap at 16 MiB naming chunked transfer (ruling 6) | Tasks 4, 16 |
| Snapshot sessions: open, page, close, pinned at one generation | Tasks 13–15 |
| Snapshot tree fully generation-pinned (Supersedes correction #10) | Tasks 13, 14 |
| Session calibration: 60 s idle, cap 4, page 500/2000, all `IndexConfig` (ruling 7) | Task 13 Step 3 |
| Disconnect releases every session | Task 14 Steps 5, 6 |
| `sections` / `list_items` as ordinary facets (ruling 1) | Task 15 |
| Path validation: canonicalize-and-contain, symlink-aware | Task 4 |
| Parent folders never implicitly created | Tasks 4, 5 |
| Temp-then-rename atomicity per file | Task 5 Step 3 |
| Typed refusals, each changing nothing | Tasks 4–8 (engine), 9 (mapping), 16 Step 7 (over the wire) |
| `--read-only` refusing every mutating op, zone included | Task 17 |
| `config_changed` notice for zone writes | Task 16 Step 5 |
| Oracle extension: mutations indistinguishable from external edits | Task 11 |
| CAS races through the real daemon | Task 10 |
| Instrumentation counters and named benchmark cases | Task 18 Steps 1–5 |
| Protocol documentation for every new operation, event, and code | Task 18 Steps 6–7 |

**Stated gaps, deliberate.** Three things the design's Testing and Instrumentation sections name are *not* fully discharged here, and the plan should not pretend otherwise:

- **Counters** — the design asks for "rows written, links rewritten, snapshot pages/bytes served, open-snapshot gauge + WAL-pin duration". Task 18 adds the benchmark cases those numbers would be read from, but no task adds the gauges themselves to the existing metrics struct. Deferred; the benchmarks answer the performance questions, and a gauge with no consumer is speculative surface.
- **`link_rewrite_failures` fan-out under concurrent editing** — Task 12 covers one skipped referrer. The design does not ask for more, and a matrix here would be measuring the test harness.
- **The 120-inbound-link figure** in the design's rename target is not a benchmarked point: Task 18 measures 0/10/100/1000, and the baseline note reports where 120 falls on that curve rather than adding a fifth case for one number.

## Deferred, unchanged

Server-side read-modify-write (`process_note`), multi-file transactions, conflict merging, journaling, undo, versioning, Sync semantics, chunked transfer for payloads past 16 MiB, indexing the `.obsidian` zone or attachment contents, and the cold-open hydration miss inside `IndexService::open`.
