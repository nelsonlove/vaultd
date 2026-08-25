# vaultd Persistent Index and Daemon Read API Design

## Status

Approved direction for the phase following the semantic read-path milestone.

## Summary

This phase turns the read-only semantic graph into a durable, queryable daemon service. A `vaultd` process owns one explicitly configured vault, reconciles its Markdown files into a normalized SQLite index, and exposes semantic read operations through protocol version 1.

The ordinary Obsidian vault remains authoritative. SQLite contains only rebuildable derived state and lives outside the vault under the XDG cache directory unless an explicit index path is supplied. The daemon never writes, renames, or deletes a vault file in this phase.

This phase deliberately uses startup and manual reconciliation rather than a filesystem watcher. Always-live watching and event subscriptions form the following milestone and consume the same index and generation contracts defined here.

## Goals

- Persist exact note source, parsed semantics, resolutions, backlinks, and diagnostics in SQLite.
- Avoid reading, hashing, or parsing unchanged note bodies during ordinary startup reconciliation.
- Reparse only added or changed notes and remove deleted notes.
- Recompute vault-global resolution without reparsing unchanged notes.
- Publish each successful reconciliation as one atomic, monotonically numbered generation.
- Expose vault information, note listing and retrieval, link resolution, backlinks, references, diagnostics, and manual refresh through protocol version 1.
- Keep indexed reads deterministic, paginated where collections may be large, and independent of the in-memory lifetime of a scan.
- Establish correctness and performance harnesses for 10,000-note, 100,000-note, and opt-in real-vault workloads.

## Non-goals

This phase does not:

- watch the filesystem continuously or publish change events;
- implement subscriptions;
- edit, create, rename, or delete vault files;
- implement transactions or mutation journaling;
- implement full-text or semantic search;
- evaluate Bases or Canvas files;
- index attachment contents;
- add network transports, authentication, or remote access;
- implement MCP, CLI commands beyond daemon configuration, URI handling, Obsidian plugins, the Node API shim, Swift or Elisp bindings, Sync adapters, UI, mobile, or e-ink clients;
- claim a performance advantage over stock Obsidian before both are measured on the same real vault.

## Architectural boundaries

The phase adds one crate while preserving the existing dependency direction:

```text
vault files (authoritative)
  -> reconciler
  -> vault-core parse and resolution
  -> vault-index SQLite (derived)
  -> vault-server dispatch
  -> vault-protocol DTOs
  -> future consumers
```

### `vault-core`: semantic behavior

`vault-core` remains the owner of transport-independent parsing, resolution, graph behavior, source spans, revisions, and diagnostics. It does not depend on SQLite, XDG paths, daemon configuration, or protocol types.

The current `scan_vault` entry point couples file reading, parsing, and graph construction. This phase extracts a graph-building entry point that accepts already-parsed notes plus scan diagnostics. `scan_vault` becomes a convenience composition over that entry point. The index can then load unchanged parsed notes from SQLite, parse only changed documents, and ask the same core resolver to construct the authoritative graph result.

### `vault-index`: derived storage and reconciliation

A new `vault-index` crate owns:

- schema creation and semantic-schema versioning;
- SQLite connection configuration and transactions;
- XDG cache path derivation and explicit index-path overrides;
- vault identity validation;
- filesystem inventory fingerprints;
- cold builds, incremental reconciliation, and verified reconciliation;
- conversion between core semantic values and normalized database rows;
- generation-aware query services and opaque pagination cursors.

It depends on `vault-core`, but neither `vault-core` nor `vault-protocol` depends on it.

### `vault-server`: process composition

`vault-server` owns one optional configured vault and its index service. With `--vault <path>`, startup opens or creates the matching cache and attempts reconciliation before serving requests. With no `--vault`, the existing health-only behavior remains available.

The server translates between protocol DTOs and `vault-index` query values. It does not expose SQLite rows, SQL errors, or core parser implementation types across the protocol boundary.

### `vault-protocol`: stable transport contract

`vault-protocol` adds only serializable request, response, error, pagination, and semantic snapshot types. It does not depend on `vault-core`, `vault-index`, or `vault-server`.

The new operations are additive protocol version 1 variants. Existing version negotiation and unknown-method behavior remain unchanged.

## Process and cache model

One `vaultd` process serves at most one vault. The vault root is selected explicitly:

```text
vaultd --vault /path/to/vault
vaultd --vault /path/to/vault --index /path/to/index.sqlite3
vaultd                              # health only
```

The default index location is derived from the canonical vault root:

```text
$XDG_CACHE_HOME/vaultd/vaults/<vault-identity>/semantic-v1.sqlite3
```

When `XDG_CACHE_HOME` is unset, normal XDG fallback behavior applies. The vault identity is a stable BLAKE3 encoding of the canonical root path. The database also records that identity, so an explicitly supplied index cannot silently be opened for the wrong vault.

The index never lives inside the vault by default and never becomes canonical data. Missing, obsolete, or corrupt derived storage is rebuilt into a current schema database without changing vault content. A semantic-format version is stored separately from the SQL schema version so parser or resolution changes can invalidate stale derived rows even when the table shapes remain usable.

SQLite uses foreign keys, a busy timeout, WAL journal mode, and `synchronous=NORMAL`. Reconciliation publishes a generation in one transaction. WAL permits readers to continue seeing the previous complete generation during that write; they never observe partially replaced graph state. Since this database is a rebuildable cache, the reduced synchronization cost of `NORMAL` is preferable to treating it as the source of truth.

Primary SQLite references:

- [Atomic transactions](https://www.sqlite.org/transactional.html)
- [Write-ahead logging](https://www.sqlite.org/wal.html)
- [Query planning and indexes](https://www.sqlite.org/queryplanner.html)
- [`PRAGMA optimize`](https://www.sqlite.org/lang_analyze.html)

## Persistent semantic model

The schema is normalized around notes and source-derived elements rather than storing one opaque serialized `SemanticGraph` blob. Exact source is stored as bytes so a `get_note` result can reproduce the validated UTF-8 document without re-reading the vault.

Conceptually, the schema contains:

```text
index_metadata
  sql_schema_version
  semantic_format_version
  vault_identity
  generation
  created_at
  refreshed_at

notes
  path (primary key)
  content_revision
  source_bytes
  observed_size
  observed_modified_time

properties       note + order + value + key/value/full spans
aliases          note + order + value + span
headings         note + order + level + text + span
blocks           note + order + identifier + span
tags             note + order + original + comparison key + span
references       note + order + syntax/origin + target/display/subpath + spans
resolutions      reference + resolution kind + resolved target/subpath
resolution_candidates
                 reference + candidate order + candidate path
diagnostics      note-or-scan + order + code/severity/message/path/span
```

Every child row is deleted with its owning note. Ordering columns preserve the deterministic order of the public core model. All span endpoints use the existing half-open UTF-8 byte-offset contract.

Required indexes cover note path, filename/stem comparison keys, tag comparison keys, reference source, resolved target, resolution kind, diagnostic path and severity, and stable pagination order. Query tests inspect `EXPLAIN QUERY PLAN` so point reads, backlinks, and normal page traversal do not regress into whole-table scans.

The database generation is a non-negative, monotonically increasing semantic-snapshot identifier. A new database has no readable generation until its first successful build, then publishes generation 1. A reconciliation with no client-visible semantic or diagnostic changes returns the existing generation. Updating only an observed filesystem fingerprint or refresh timestamp does not invalidate client cursors. A reconciliation that changes indexed source, semantics, resolution, or diagnostics advances the generation exactly once.

## Reconciliation

### Fast startup reconciliation

The ordinary startup path enumerates Markdown paths using the existing filesystem safety rules and records a lightweight fingerprint for each included file:

```text
(vault path, byte size, modified time)
```

It compares that inventory with the stored `notes` rows:

- identical path, size, and modified time: load stored semantics; do not read, hash, or parse the body;
- new path: read, validate, hash, and parse the body;
- changed size or modified time: read, validate, and hash the body; parse it only when its content revision differs;
- missing path: remove the note and its dependent rows;
- unreadable or invalid file: retain the core diagnostic behavior and exclude an unusable note from the new semantic graph.

Conventional filesystem edits update size or modified time. The fast path intentionally trusts those metadata signals. `refresh_index { verify: true }` is the authoritative audit for metadata-preserving changes: it reads and hashes every included Markdown file, but still reparses only files whose content revision differs.

### Global resolution without global reparsing

The reconciler combines changed `ParsedNote` values with unchanged parsed semantics loaded from SQLite, then calls the extracted `vault-core` graph builder. This recomputes path/name candidates, outgoing resolutions, backlinks, unresolved and ambiguous results, and graph diagnostics for the complete vault. Unchanged source bodies are not reparsed.

Recomputing all resolution rows is the initial correctness-first policy. Later profiling may introduce dependency-aware partial resolution without changing the schema or protocol contract.

### Stable filesystem snapshot and atomic publication

A build or changed reconciliation proceeds as follows:

```text
initial inventory
  -> load unchanged semantics
  -> read and parse changed files
  -> build complete graph with vault-core
  -> repeat inventory
  -> require the two inventories to match
  -> compare-and-swap expected database generation
  -> replace affected semantic rows and graph-wide resolution rows
  -> advance generation and commit
```

If the second inventory differs, the refresh returns `vault_changed_during_refresh` and publishes nothing. If another daemon process advanced the database generation meanwhile, the transaction aborts and reconciliation retries from the current database state rather than overwriting it. SQLite serializes the short publication transaction; filesystem reads and parsing occur before it.

When a failed refresh has an older complete generation, the daemon continues serving that generation and reports the last refresh failure through vault information. When no complete generation exists, indexed read operations return `index_unavailable`; `health` remains functional.

## Read service contract

Every successful indexed response contains the generation from the same database read snapshot that produced its data. Collection ordering is deterministic. Collection operations use an optional opaque cursor and bounded limit; the server chooses the default and maximum limits.

A cursor encodes at least the generation, operation/query identity, and final stable sort key. If its generation is no longer current, the request fails with `generation_mismatch`. Clients must restart the listing rather than combine pages from different snapshots.

### `get_vault_info`

Returns the configured canonical vault root, vault identity, index state, current generation, note count, last successful refresh time, and any last refresh failure. It does not expose the SQLite filename as a portable client contract.

### `list_notes`

Accepts `cursor` and `limit`. Returns compact note summaries ordered by vault path. Each summary contains path, content revision, and the title property or first heading when available.

### `get_note`

Accepts an exact vault path. Returns exact source, content revision, properties, aliases, headings, blocks, tags, diagnostics, and outgoing references with their resolutions. The DTO preserves source spelling and byte spans but does not expose SQLite row identifiers.

### `resolve_link`

Accepts a source note path and a vault-link destination string, including an optional heading or block subpath. It applies the same `vault-core` resolution rules used during reconciliation and returns resolved, unresolved, ambiguous, or missing-subpath state with candidates where applicable.

### `get_backlinks`

Accepts an exact target path plus `cursor` and `limit`. It returns source references ordered by source path and source span. References whose file target resolves but whose heading or block is missing remain backlinks to the resolved file.

### `list_references`

Accepts an optional source path, an optional `resolved`, `unresolved`, or `ambiguous` status filter, plus `cursor` and `limit`. The resolved filter includes references with a resolved file but a missing heading or block. Non-vault external targets are not returned by this vault-reference listing.

### `get_diagnostics`

Accepts optional path and severity filters plus `cursor` and `limit`. It returns both file diagnostics and graph-wide scan diagnostics in stable path/span/code/message order.

### `refresh_index`

Accepts `verify`, defaulting to `false`. A normal refresh uses path, size, and modified-time fingerprints. A verified refresh hashes every included Markdown file. The response reports the previous and current generations and counts for added, changed, deleted, unchanged, and reparsed notes.

## Protocol errors

The phase retains `incompatible_version`, `invalid_request`, and `internal`, and adds stable version 1 errors for indexed operations:

- `invalid_path`;
- `invalid_cursor`;
- `note_not_found`;
- `index_unavailable`;
- `generation_mismatch`;
- `vault_changed_during_refresh`;
- `incompatible_index` for schema, semantic-format, or vault-identity mismatches that cannot be rebuilt safely;
- `storage_failure` for SQLite or filesystem failures that cannot be represented as note diagnostics.

Errors do not contain raw SQL, absolute internal cache paths, or backtraces. Human-readable messages may improve without changing the stable code.

## Failure and recovery behavior

- A missing default cache is created and receives generation 1 only after a complete successful build.
- An obsolete schema or semantic format is rebuilt rather than migrated in place during this phase because all rows are derived.
- A corrupt default cache is rebuilt into a fresh database; vault files are never used as a recovery write target.
- An explicit index whose recorded identity names another vault fails with `incompatible_index` rather than being repurposed.
- Any failure before commit leaves the previous database generation readable.
- A startup refresh failure with a previous generation records stale status and serves that previous generation.
- A startup refresh failure without a previous generation leaves only `health` available and makes indexed operations return `index_unavailable`.
- A malformed note produces diagnostics and partial vault results according to the existing core contract; it does not crash or poison the entire index.

## Performance contract

The intended advantage over stock Obsidian is a persistent semantic runtime whose warm path performs substantially less repeated work and whose read queries execute directly against indexed SQLite state. This is an engineering target, not an unmeasured marketing claim.

The contract is structural:

- unchanged startup performs one metadata inventory and no note-body reads, hashes, Markdown parses, or YAML parses;
- a normal one-file edit reads and hashes that file only, and parses it when its content revision differs;
- verified refresh reads and hashes all note bodies but parses only changed revisions;
- warm `get_note`, backlinks, diagnostics, and page queries do not rebuild an in-memory vault graph;
- point and relationship queries use prepared, indexed SQL;
- list operations are bounded and cursor-paginated;
- `PRAGMA optimize` runs after initial schema creation and substantial refreshes as recommended by SQLite.

A standalone benchmark program uses `std::time` and existing workspace dependencies, preserving the workspace's Rust 1.85 minimum rather than introducing a benchmarking framework with a higher MSRV. It creates deterministic synthetic 10,000-note and 100,000-note vaults and emits machine-readable JSON for:

- cold index build;
- unchanged startup reconciliation;
- one-file incremental refresh;
- verified refresh;
- warm `get_note`;
- warm backlinks;
- warm 100-note list pages.

The harness reports repeated-run distributions rather than one timing. The maintainer's real vault is an opt-in local target; its contents and derived index are never committed as fixtures. CI enforces semantic equivalence and indexed query shape, not brittle absolute wall-clock thresholds. Baselines are recorded for regression analysis.

A stock-Obsidian comparison must use the same machine and real vault, clearly define cold versus warm state, and measure equivalent outcomes. `vaultd` may be described as faster only after that comparison shows lower warm read latency and less repeated startup work.

## Testing strategy

Implementation follows red-green-refactor across these layers:

1. Schema and row round trips preserve exact source, revisions, semantic values, ordering, spans, resolutions, and diagnostics.
2. Cold build produces query results semantically equivalent to the existing `scan_vault` fixture results.
3. Unchanged startup proves through an instrumented source that note bodies were not read.
4. Added, changed, deleted, touched-but-identical, and verified metadata-preserving edits produce the specified reparsing and generation behavior.
5. Randomized file-change sequences compare incremental reconciliation with a clean full `scan_vault` result as the correctness oracle.
6. Injected failures before publication and vault changes between inventories preserve the previous generation.
7. Corrupt, obsolete, missing, and wrong-vault databases follow the recovery contract.
8. Query-plan tests prove index use for note lookup, backlinks, diagnostics filters, and pagination.
9. Protocol serialization tests cover every request, response, semantic DTO, cursor shape, and error code without importing core types.
10. Server integration tests exercise health-only mode, configured startup, all read operations, refresh, pagination, generation mismatch, invalid paths, missing notes, stale-index fallback, and stdio process continuity after request errors.
11. The deterministic synthetic benchmark emits valid reports at both target scales; the real-vault run remains manual and opt-in.

Tests use temporary vaults and temporary index paths. They never point destructive or rebuild behavior at the maintainer's live vault or cache. Fixture vaults are digested before and after reconciliation to prove the phase remains read-only with respect to authoritative files.

## Success criteria

The phase is complete when:

- a cold reconciliation persists the semantic fixture corpus and all read APIs reproduce the current core graph contract;
- every tested incremental change is equivalent to a clean full scan;
- unchanged startup reads no note bodies and parses no notes;
- normal refresh reparses only notes whose metadata triggered a read and whose content revision changed, while verified refresh detects metadata-preserving content changes;
- failed or racing refreshes never expose partial data and preserve the prior generation;
- every indexed response is generation-consistent and paginated cursors reject mixed generations;
- corrupt or obsolete derived state rebuilds without changing a vault file;
- protocol and daemon tests cover all new operations and stable errors;
- query-plan tests show indexed access for the principal warm reads;
- the 10,000-note and 100,000-note benchmark reports are reproducible and the real-vault comparison procedure is documented;
- all workspace tests, formatting, Clippy with warnings denied, and documentation checks pass.

## Deferred follow-on

The next phase adds an always-live filesystem watcher and protocol event subscriptions. Watcher events are hints that trigger the same reconciler; periodic reconciliation remains the correctness backstop. Events name committed generations, so clients never observe filesystem activity that has not become a complete indexed snapshot.

Search, mutations, Sync, plugin runtimes, and UI clients remain later consumers of the same storage, semantic, protocol, and generation boundaries.
