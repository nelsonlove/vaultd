# vaultd Live Incremental Runtime Design

## Status

Approved direction for the phase following the persistent-index and daemon-read-API milestone.

## Summary

This phase turns `vaultd` from a daemon that reconciles only at startup or on request into an always-live semantic runtime. It watches one configured Obsidian-compatible vault, coalesces filesystem hints into stable change batches, updates a compact in-memory resolution graph, persists only affected semantic rows in SQLite, and emits protocol events only after a complete generation has committed.

The principal performance requirement is to remove work proportional to the whole vault from the ordinary one-file edit path. A body-only edit must not enumerate every note, load unchanged source, rebuild every resolution, rewrite every resolution row, or globally sort diagnostics. Its work must be proportional to the changed notes plus references whose answers can actually change.

The vault's ordinary files remain authoritative. The in-memory graph and SQLite database are rebuildable derived state. The in-memory graph accelerates change planning and resolution; SQLite remains the durable query snapshot and restart boundary. A generation is never announced to a client before its SQLite delta has committed and the corresponding in-memory state is ready to publish.

## Evidence and motivation

The persistent-index milestone established the correct structural warm-read path:

- 100,000-note warm startup reconciliation: 505 ms p50;
- warm `get_note`: 0.068 ms p50;
- warm backlinks: 0.027 ms p50;
- unchanged startup body reads: zero;
- unchanged startup reparses: zero.

It also exposed the next bottleneck:

- a one-file edit at 100,000 notes: 8.4 seconds p50.

That edit reads and reparses only one body. Its time is dominated by complete-vault inventory, loading broad semantic state, rebuilding global resolution, globally materializing diagnostics, and replacing all resolution rows. Putting SQLite in an in-memory database would not remove those algorithms. This phase changes their complexity instead.

The absolute measurements are machine-bound observations from `docs/performance/persistent-index-baseline.md`. The structural work limits in this design are the contract.

## Goals

- Watch included Markdown files continuously while a vault is configured.
- Make an ordinary watcher-driven change path avoid a complete vault inventory.
- Maintain a compact in-memory graph containing only data required for resolution, invalidation, and live publication.
- Determine the exact conservative set of references that may change after a note edit, addition, deletion, or rename.
- Re-resolve and persist only changed notes and affected references.
- Preserve Phase 3's atomic, monotonic, generation-consistent read contract.
- Make cached indexed reads available before startup catch-up completes.
- Emit transport-neutral generation and runtime-state events over the existing stdio proof transport.
- Bound memory, event queues, and change payloads.
- Recover from missed, duplicate, reordered, overflowing, or unavailable watcher signals.
- Prove incremental results equivalent to a clean full scan across randomized edits and forced race interleavings.
- Measure every stage of change-to-event latency at 10,000 and 100,000 notes.
- Preserve Rust 1.85 as the workspace minimum supported Rust version.

## Non-goals

This phase does not:

- create, edit, rename, or delete vault files;
- implement full-text, property, or semantic search;
- evaluate Canvas or Bases files;
- index attachment contents;
- implement a persistent event history or offline event replay;
- add a network transport, authentication, or remote access;
- implement MCP tools, URI handling, an Obsidian accelerator plugin, the Node Obsidian API shim, Swift bindings, an Elisp host, Sync, mobile, e-ink, or any UI;
- run Obsidian plugins or JavaScript;
- keep exact note bodies or complete query DTOs duplicated in the live graph;
- promise constant latency for a change that genuinely affects a large fraction of all references.

## Design principles

### Optimize complexity before storage placement

SQLite is a persistent file, not an in-memory database. SQLite's page cache and the operating system normally keep hot index pages in memory, and Phase 3's sub-millisecond reads show that query I/O is not the current bottleneck. The first-order optimization is to replace complete-vault work with dirty-set and affected-reference work.

### Memory computes; SQLite publishes

The live graph is the hot computation plane. SQLite is the durable current snapshot and query plane. Neither becomes canonical vault data.

The live graph may be discarded and reconstructed entirely from SQLite. SQLite may be discarded and reconstructed entirely from the vault. These recovery directions remain explicit.

### Hints may queue; committed generations may not

Filesystem hints can be delayed, duplicated, reordered, coalesced, or discarded in favor of a full reconciliation. A generation visible to a client cannot be queued for later persistence. Publication is complete only after SQLite commits and the matching live state is installed.

### Conservative invalidation

The impact planner may include references that ultimately keep the same answer. It must never exclude a reference whose answer could change. If it cannot prove a bounded affected set, it requests complete resolution instead of guessing.

### Determinism at boundaries

Internal maps may use performance-oriented integer identities and hash lookups. Protocol results, diagnostics, candidates, and event path lists remain deterministically ordered.

## Architecture

```text
authoritative vault files
        |
        | filesystem hints
        v
vault-watch
  normalization, filtering, debounce, overflow signaling
        |
        | dirty-path batches
        v
runtime coordinator (single writer)
  stable reads -> parse changed notes -> impact planning
        |                              |
        |                              v
        |                     compact live graph
        |                     resolver + reverse dependencies
        |
        | candidate delta
        v
vault-index SQLite transaction
  changed semantic rows + affected resolutions + generation
        |
        | committed generation
        v
publication barrier
  install live delta -> release readers -> emit events
        |
        +--> protocol readers and subscribers
```

## Crate and boundary changes

### `vault-core`: incremental semantic behavior

`vault-core` continues to own transport- and storage-independent resolution behavior. It gains the pure concepts required for incremental resolution:

- internable resolution keys;
- reference dependency keys;
- note resolution identity snapshots;
- impact calculation over old and new identities;
- resolution of a selected set of references;
- construction of resolution diagnostics for selected references.

Core APIs accept semantic values and stable logical identities. They do not know about watcher events, threads, channels, SQLite row IDs, generations, or protocol DTOs.

The existing complete `build_graph` path remains the correctness oracle and fallback implementation. Incremental resolution and complete resolution must produce the same public answers.

### `vault-index`: live graph, storage, and delta publication

`vault-index` owns:

- the compact live graph hydrated from persistent rows;
- in-process path and reference identities;
- reverse dependency indexes;
- classification of stored versus changed note snapshots;
- candidate `LiveDelta` construction;
- schema version 2 and dependency rows;
- delta-only compare-and-swap publication;
- query snapshots and the publication barrier;
- background catch-up and periodic reconciliation commands;
- stage-level work counters and timings.

The graph is logically complete for resolution but intentionally incomplete for general note retrieval. Exact source, properties, aliases, tags, and full spans remain available from SQLite queries without being duplicated in the graph.

### `vault-watch`: filesystem adapter

A new `vault-watch` crate owns only operating-system watcher integration and event normalization. It depends on the minimum semantic path types needed to return vault-relative dirty paths, but it does not parse notes, open SQLite, advance generations, or emit protocol events.

Its public boundary is a stream of:

```text
ChangeHint::Paths(set<VaultPath>)
ChangeHint::Overflow
ChangeHint::RootInvalidated
ChangeHint::WatcherFailed(error)
```

Tests use a fake hint source. Platform watcher integration receives separate smoke tests so correctness does not depend on nondeterministic operating-system timing.

### `vault-server`: process and transport composition

`vault-server` owns:

- startup ordering;
- the exclusive index writer lease;
- the runtime coordinator thread and command channel;
- routing refresh commands through that coordinator;
- subscriber registration and bounded delivery;
- stdio multiplexing of responses and events;
- CLI configuration for watching and periodic reconciliation.

The server does not implement resolution or expose watcher-library events as protocol types.

### `vault-protocol`: additive live contracts

`vault-protocol` gains serializable subscription requests, responses, events, runtime status, and stable errors. It remains independent of the other crates.

## Compact live graph

The live graph contains the minimum state needed to answer link resolution and determine what a change can affect:

```text
PathInterner
  NoteId <-> VaultPath

NoteIdentity
  NoteId
  filename comparison key
  stem comparison key
  heading comparison keys
  block identifiers

ReferenceIdentity
  ReferenceId
  source NoteId
  source ordinal and span
  parsed LinkTarget
  dependency keys
  current Resolution

Candidate indexes
  exact path -> NoteId
  filename key -> ordered NoteIds
  stem key -> ordered NoteIds

Reverse dependency indexes
  dependency key -> ReferenceIds
  resolved target NoteId -> ReferenceIds with subpaths
  source NoteId -> outgoing ReferenceIds
```

Paths and repeated comparison keys are interned or shared. Hot internal identities use compact integers. Stable external identity remains the vault path plus source reference ordering; integer IDs never cross the protocol or persistent semantic contract.

The live graph does not retain:

- exact source bytes;
- frontmatter property values;
- aliases or tags that do not participate in current resolution rules;
- full note DTOs;
- duplicate backlink collections that SQLite already answers efficiently.

The 100,000-note benchmark records resident-memory growth. The design target is no more than 512 MiB for the synthetic workload, with exact source excluded from that growth. This is a release measurement, not a platform-independent CI threshold.

## Dependency keys

Every vault reference records the lookup routes that could determine its answer. Keys are normalized using exactly the same rules as the complete resolver:

- `exact_path`: the explicit or source-relative normalized path spelling;
- `exact_path_with_extension`: the same spelling with `.md` when applicable;
- `filename`: the case-folded filename lookup key;
- `stem`: the case-folded filename stem lookup key;
- `resolved_target`: the current target path for heading or block validation.

Non-vault URI targets have no vault dependency keys. Same-note subpath links depend on their source note's heading or block identity.

Dependency generation is part of `vault-core` resolution behavior, not a second approximation implemented in SQL. Complete and incremental resolvers use the same parsed `LinkTarget` and comparison rules.

## Change classification and impact planning

For every changed path, the coordinator compares the old stored resolution identity with the newly parsed identity.

### Content changed; resolution identity unchanged

When path, filename/stem, headings, and blocks are unchanged:

- replace the changed note's semantic rows;
- remove its old outgoing references;
- resolve its new outgoing references;
- update backlinks and diagnostics only for those references.

No incoming reference can change solely because unrelated body text, properties, aliases, or tags changed under the current compatibility contract.

### Heading or block identity changed

In addition to the changed note's outgoing references, re-resolve references whose current file target is that note and whose subpath kind could be affected. File-level backlinks remain valid; missing-heading or missing-block status may change.

### Note added

Add the new candidate identity and re-resolve:

- the new note's outgoing references;
- unresolved, resolved, or ambiguous references whose exact-path, filename, or stem dependency keys match the new note;
- same-note subpath references in the new note.

Adding a note can turn unresolved into resolved, resolved into ambiguous, or leave the answer unchanged.

### Note deleted

Remove the old candidate identity and re-resolve:

- references formerly resolved to the deleted note;
- references whose candidate sets used its exact path, filename, or stem keys;
- no outgoing references from the deleted source, which are removed with it.

Deleting a note can turn resolved into unresolved, ambiguous into resolved, or leave a different ambiguous set.

### Note renamed

Watcher rename pairing is not trusted for correctness. A rename is processed as deletion of the old path plus addition of the new path in one coalesced batch when both hints are available. The affected set is the union of old and new path, filename, stem, target, and outgoing-reference dependencies.

### Unreadable or invalid UTF-8 note

The existing usable note is removed from the candidate graph, a stable diagnostic replaces it, and dependencies are planned as for deletion. A file that remains permanently unusable does not advance every later generation unless its diagnostic or usable-state answer changes.

### Large or uncertain changes

The planner estimates affected references before publication. It requests complete resolution when:

- the watcher reports overflow or root invalidation;
- an event cannot be normalized safely inside the canonical vault root;
- the live graph generation does not match SQLite;
- dependency rows are absent or incompatible;
- the affected set crosses a benchmark-selected fraction where complete resolution is cheaper;
- a core invariant cannot prove conservative coverage.

The threshold is an internal performance policy established by the 10,000- and 100,000-note benchmarks. It is not a protocol contract. Both paths must be semantically equivalent.

## Watch pipeline

### Inclusion and path safety

Watching uses the same inclusion rules as `FileSystemVaultSource`:

- only included Markdown files;
- no `.obsidian` contents;
- no hidden directories under the current read-path rule;
- symlinks remain bounded to the canonical vault root;
- every absolute event path is canonicalized or safely lexically normalized to a valid `VaultPath` before use.

An event outside the root is ignored and increments an operational counter. It never becomes a filesystem target or a semantic diagnostic. Runtime failures belong to live-runtime status and state events; they do not advance the semantic generation merely because watcher health changed.

### Debounce and coalescing

The default debounce window is 100 ms. `--watch-debounce-ms` may configure a bounded positive value. Hints arriving inside the window collapse into one ordered set of vault paths.

The dirty set has a fixed memory bound. Exceeding it discards path detail and produces `Overflow`, forcing complete reconciliation. The watcher callback performs no file reads, parsing, SQL, protocol writes, or blocking coordination.

### Stable file reads

For each candidate path:

```text
fingerprint before read
  -> one body read
  -> UTF-8 validation and revision hash
  -> fingerprint after read
```

If the two fingerprints differ, the candidate is discarded and the path returns to the dirty set after debounce. Bounded repeated instability becomes an operational refresh failure while the previous generation remains readable. A later hint or periodic reconciliation retries it.

Deleted paths are confirmed absent by two metadata checks separated by at least one debounce window. If the path reappears, it is treated as a modification. Atomic-save replacement patterns therefore settle as one changed path rather than publishing transient deletion and recreation generations. A genuine deletion pays this bounded grace interval before publication.

### Periodic correctness backstop

The default periodic reconciliation interval is 60 seconds and is configurable or disableable. It performs the Phase 3 lightweight metadata inventory, not a verified body scan. It runs at lower priority than explicit requests and dirty watcher batches and coalesces any discovered differences through the same coordinator.

`refresh_index { verify: true }` remains the explicit authoritative audit for metadata-preserving content changes.

## Startup and readiness

Startup separates durable-read availability from live catch-up:

1. Canonicalize the vault and derive or validate the index path.
2. Acquire the exclusive writer lease.
3. Open and validate SQLite.
4. Make the last committed generation available for indexed reads immediately.
5. Install the filesystem watcher so later changes cannot fall into a startup gap.
6. Hydrate the compact live graph from SQLite without loading source bodies.
7. Perform one normal metadata reconciliation while watcher hints queue.
8. Drain the coalesced dirty set.
9. Enter watching readiness and begin the periodic backstop.

If no complete generation exists, `health` remains available while the cold build runs and indexed reads retain the existing `index_unavailable` behavior. The first schema-version-2 start is also a cold rebuild because the Phase 3 cache is deliberately replaced; immediate cached-read availability applies to later starts with a valid version-2 generation.

The existing index state remains the durable semantic state (`ready`, `stale`, or `unavailable`). An additive live-runtime field reports:

- `starting`;
- `catching_up`;
- `watching`;
- `polling_fallback`;
- `stopped`.

The field is optional/defaulted in DTOs. Older version 1 clients may ignore the additional response field. New clients treat a missing field from an older daemon as `stopped`/not-supported rather than failing deserialization. While `catching_up`, indexed reads explicitly return the last committed generation; they never imply that it already includes queued filesystem changes.

Subscriptions become available after a subscriber can receive a race-free current generation. A subscription opened during catch-up receives the current durable generation and runtime-state events; it does not receive a fabricated filesystem delta for work that has not committed.

## Single-writer coordinator

One coordinator owns all semantic mutation for a configured vault:

- watcher batches;
- periodic reconciliation;
- manual normal refresh;
- manual verified refresh;
- startup catch-up;
- live-graph hydration or rebuild;
- generation publication.

Commands enter a bounded mailbox. Manual refreshes are not executed concurrently with watcher changes; compatible pending path sets coalesce around them. Verified refresh provides a clear barrier: earlier hints are incorporated in or before it, and later hints remain queued for the next batch.

Read queries do not enter the mutation mailbox. SQLite read snapshots and immutable published live state allow reads to proceed except for the short publication barrier.

## Exclusive index writer lease

An active live graph cannot safely share one index with an uncoordinated second writer. The daemon therefore acquires an operating-system advisory lock on a sibling lock file at the validated index location before starting the live runtime.

- The lock is non-blocking at startup.
- Failure returns the stable startup error `index_in_use`.
- The lock handle remains open for the daemon lifetime.
- Process exit or crash releases the operating-system lock; PID-file deletion is not used.
- The lock file is derived only after cache/index-path validation. Explicit index paths inside the canonical vault root are rejected, so neither the database nor its sibling lock file becomes a vault write.
- Read consumers connect through the daemon protocol rather than opening a competing writer.

The Phase 3 SQLite compare-and-swap generation check remains in every publication as defense in depth and for testability. A mismatch discards the candidate, reloads the committed graph, and retries or falls back; it never overwrites an unexpected generation.

## Candidate delta and publication

A watcher batch against generation `G` proceeds as follows:

```text
dirty paths
  -> stable reads and change classification
  -> conservative affected ReferenceId set
  -> resolve selected references
  -> construct allocation-complete LiveDelta for G -> G+1
  -> recheck dirty file fingerprints
  -> acquire publication write barrier
  -> begin SQLite transaction and compare generation == G
  -> replace changed note rows
  -> replace affected dependency, resolution, candidate, and diagnostic rows
  -> write generation G+1 and refresh metadata
  -> commit SQLite
  -> install prevalidated LiveDelta without fallible allocation
  -> release publication barrier
  -> emit generation G+1 event
```

The delta owns all replacement buckets and allocations needed for its live-state update before SQLite begins. Post-commit installation consists of bounded swaps/removals/inserts whose capacity has been prepared. If the process crashes after SQLite commit but before live installation or event emission, clients disconnect and the next process hydrates `G+1` from SQLite. No uncommitted generation was announced.

If any step before commit fails, SQLite remains at `G`, the published live graph remains at `G`, no generation event is emitted, and the dirty paths remain eligible for retry.

Queries acquire the publication barrier for reading before beginning their SQLite snapshot or cloning the published live-state handle. They therefore observe either complete `G` or complete `G+1`, never SQLite at one generation and the live graph at another.

## SQLite schema version 2

This phase advances the derived schema and semantic-format version. Existing Phase 3 caches are rebuilt once from the authoritative vault rather than migrated in place. The rebuild does not modify vault files.

Schema version 2 adds normalized dependency and resolution-diagnostic ownership:

```text
resolution_dependencies
  reference_id
  dependency_kind
  comparison_key

resolution_diagnostics
  reference_id
  code
  severity
  message
  path/span
```

Required indexes include:

```text
(dependency_kind, comparison_key, reference_id)
(reference_id, dependency_kind, comparison_key)
(resolved target path, resolution kind, reference_id)
(source note path, reference ordinal)
```

The Phase 3 globally materialized aggregate `diagnostics` table is removed. `get_diagnostics` reads a deterministic union of:

- note parse diagnostics;
- resolution diagnostics;
- semantic scan diagnostics.

This eliminates global diagnostic deletion, insertion, and sorting for every semantic change. A note diagnostic whose stored path is absent is projected with its owning note path, matching `build_graph` behavior. Canonical query order is null/global path first, then vault path, span, code, message, diagnostic owner kind, and stable owner identity. Pagination and query-plan tests cover the union directly.

Changed note rows may still be replaced as a unit because their child semantics are source-local. Unchanged notes and unaffected reference rows are untouched. SQL work counters report notes, references, resolutions, candidates, dependencies, and diagnostics inserted, updated, or deleted per generation.

SQLite retains WAL mode, foreign keys, a busy timeout, and `synchronous=NORMAL`. Prepared statements and batched transaction loops are required. Additional page-cache, memory-map, checkpoint, or pragma tuning is accepted only when the stage benchmarks demonstrate a repeatable improvement; correctness does not depend on an undocumented cache setting.

## In-memory publication model

The coordinator mutates no data reachable by active readers. The current published live state is held behind a short read/write publication barrier and an immutable shared handle.

The next candidate is represented as a delta over `G`, not a clone of the complete graph. After commit, the writer applies allocation-complete replacement buckets while holding the barrier, advances the in-memory generation to `G+1`, and releases it. Normal queries hold the barrier only long enough to obtain their SQLite read snapshot or shared live handle.

The resolver cache and SQLite generation are checked when serving `resolve_link`. A mismatch is an internal invariant failure that triggers reload rather than returning a mixed answer.

## Protocol subscription contract

Protocol version 1 gains additive operations:

```text
subscribe_events {}
unsubscribe { subscription_id }
```

`subscribe_events` returns:

```text
subscription_id
generation: optional when no complete generation exists
live_state
```

The response establishes a race-free boundary: its response line is enqueued before the subscription becomes eligible for event delivery, and the subscription then receives events for commits after the returned generation. There is no historical replay. A reconnecting client subscribes, records the returned generation, and queries current state. A successful `unsubscribe` response is likewise ordered after all already-enqueued events and guarantees that no later event for that subscription will be emitted.

The stdio transport writes two top-level envelope shapes as newline-delimited JSON:

```text
ResponseEnvelope
  version, id, outcome

EventEnvelope
  version, subscription_id, event
```

Clients that never subscribe receive no event envelopes. Response IDs and existing response envelopes remain unchanged.

### Events

```text
generation_committed
  optional previous_generation
  generation
  cause: watcher | startup | periodic | manual | verified
  changes: detailed paths | counts-only summary
  affected_note_count
  affected_reference_count

runtime_state_changed
  optional generation
  live_state
  optional stable error code and message

resync_required
  current_generation
  reason: subscriber_lag | oversized_change_set | runtime_recovered
```

Detailed path changes contain deterministic, disjoint `created`, `modified`, and `deleted` lists. They describe note-file membership/source changes, not every backlink whose answer changed. An event contains detailed paths only when the total is at most 1,024. Larger generations use a counts-only summary followed by `resync_required { reason: oversized_change_set }`.

A refresh that changes only fingerprints or refresh timestamps emits no generation event because the semantic generation does not advance.

### Subscriber backpressure

Each subscription has a bounded queue of 64 event envelopes. The coordinator never blocks on a subscriber or stdout.

When a subscriber falls behind:

- queued incremental generation events may be coalesced;
- one `resync_required { reason: subscriber_lag }` marker records the latest committed generation;
- the subscription remains active for later events;
- protocol responses are not dropped or reordered behind an unbounded event queue.

The stdio writer is the only owner of stdout, so response and event JSON lines cannot interleave at the byte level.

## Race and concurrency invariants

### Watcher order and duplication

Correctness never depends on watcher order, event pairing, or uniqueness. Dirty paths are a set. Overflow becomes complete reconciliation.

### Startup gap

The watcher is installed before catch-up inventory. Events during hydration or inventory remain queued and are reconciled afterward.

### File changes during read

Pre- and post-read fingerprints must match before the candidate can publish. The same dirty fingerprints are checked once more immediately before the publication barrier. Instability retries without invalidating the previous generation.

### Event during commit

The watcher callback appends the new hint to the coordinator mailbox. It cannot modify the candidate already under publication. The path participates in the next batch.

### Manual refresh versus watcher batch

Both are coordinator commands and execute serially. Pending paths coalesce before or after the explicit refresh according to mailbox order. The returned refresh generation names the committed snapshot that includes all earlier commands.

### Read during publication

Queries hold a shared publication barrier while selecting their SQLite snapshot/live handle. The writer holds the exclusive barrier across SQLite commit and live-state installation. Readers see one generation.

### Competing process

The exclusive lease rejects a second live writer. The generation compare-and-swap remains a second guard; an unexpected mismatch discards local candidate state.

### Subscriber during publication

Registration occurs through the coordinator. It is ordered either before the commit, receiving the later event, or after the commit, receiving the new generation in its subscription response.

### Slow subscriber

Bounded queues and `resync_required` prevent subscriber speed from affecting reconciliation or memory without bound.

### Crash boundaries

- Before SQLite commit: generation `G` remains durable and visible.
- After commit but before live install: process failure disconnects clients; restart hydrates `G+1`.
- After live install but before event write: process failure disconnects clients; reconnect returns `G+1`.
- After event write: SQLite and the live graph already contain the announced generation.

Tests expose barriers at each boundary and assert these outcomes directly.

## Failure and recovery

### Watch installation failure

Indexed reads remain available. The live state becomes `polling_fallback`, an operational error is reported, and periodic metadata reconciliation continues. No event claims the daemon is continuously watching.

### Watcher overflow or root invalidation

The runtime marks itself `catching_up`, performs complete metadata reconciliation and conservative resolution, publishes any semantic change atomically, emits `resync_required`, and returns to `watching` if the backend recovers. Complete fallback resolves all stored references but still does not reparse unchanged source bodies.

### Parse or read failure

The existing structured diagnostic contract applies. The last complete generation remains readable until a stable candidate containing the new diagnostic can commit. Repeated identical unusable state does not cause repeated generation advances.

### SQLite publication failure

The live candidate is discarded, no event is emitted, the old generation remains published, the durable index state becomes `stale`, and live state moves to `catching_up` or `polling_fallback` with a stable storage error. The watcher dirty set remains retryable.

### Live-graph invariant failure

The runtime stops incremental publication, reloads the graph from SQLite, and runs complete reconciliation. It does not attempt to repair an uncertain graph with another partial delta.

### Subscriber failure

Invalid subscription IDs return `subscription_not_found`. Subscriber serialization or transport closure removes that subscription without affecting the runtime.

## Stable errors

The phase adds stable protocol or startup errors where required:

- `index_in_use`;
- `watch_unavailable`;
- `subscription_not_found`;
- `runtime_not_ready` for an operation that specifically requires the hydrated live resolver;
- `runtime_overloaded` when a bounded command queue cannot accept optional work.

Ordinary indexed reads continue to use the existing Phase 3 error contract. Error messages do not expose raw SQL, internal cache paths, backtraces, watcher implementation types, or unvalidated absolute event paths.

## CLI behavior

With a configured vault, watching is enabled by default:

```text
vaultd --vault /path/to/vault
vaultd --vault /path/to/vault --no-watch
vaultd --vault /path/to/vault --watch-debounce-ms 100
vaultd --vault /path/to/vault --reconcile-interval-seconds 60
```

`--no-watch` uses periodic/manual reconciliation and reports the corresponding live state. A reconcile interval of zero disables the periodic backstop only when explicitly requested; verified refresh remains available. Health-only mode starts no watcher, graph, lease, or periodic task.

CLI values are range-checked. Defaults and effective settings appear in documentation, not in portable semantic DTOs unless clients need them to interpret state.

## Performance model

For `N` notes, `R` references, `D` dirty notes, and `A` conservatively affected references:

```text
ordinary watcher batch
  filesystem: O(D)
  parsing:    O(bytes in changed usable notes)
  planning:   O(changed identity keys + A)
  resolution: O(A)
  SQL writes: O(changed semantic rows + A)

periodic backstop
  inventory:  O(N) metadata
  subsequent semantic work: same dirty-set model

complete fallback
  resolution: O(R) by explicit conservative choice
```

No ordinary body-only edit may perform an `O(N)` inventory or `O(R)` resolution pass.

### Target measurements

On the same Apple M2 baseline machine and deterministic 100,000-note synthetic vault:

- cached-read availability target: under 100 ms p50 when a valid index exists;
- body-only edit processing after debounce: under 50 ms p50;
- watcher hint to committed generation event: under 250 ms p50 and under 500 ms p95;
- warm indexed note/backlink queries remain sub-millisecond p50;
- body-only edit reads one body and parses one note;
- body-only edit performs no complete inventory;
- resolution and SQL row counters are proportional to the changed source's outgoing references;
- compact live-state resident-memory growth remains under 512 MiB for the synthetic workload.

The timing goals are release baselines, not brittle CI assertions. Structural counters, semantic equivalence, bounded queues, and query plans are enforced in tests. Results outside a timing target require profiling and documentation, not hidden benchmark relaxation.

High-fan-out changes report their affected-reference cardinality. Their latency is evaluated per affected reference rather than against the body-only constant target.

## Instrumentation and benchmarks

Each change report records durations and work counts for:

- watcher delivery;
- debounce wait;
- stable metadata checks;
- body read;
- UTF-8 validation and revision hashing;
- parse;
- identity diff;
- dependency lookup;
- resolution;
- candidate construction;
- SQL note rows;
- SQL dependency/resolution/diagnostic rows;
- SQLite transaction and commit;
- live-state installation;
- event enqueue and observed delivery.

The benchmark adds deterministic cases at 10,000 and 100,000 notes:

- body-only edit with unchanged reference identity;
- outgoing-reference edit;
- heading addition/removal with 0, 10, 100, and high fan-out subpath references;
- new filename resolving formerly unresolved references;
- new filename making a target ambiguous;
- deletion reversing those transitions;
- rename;
- burst of 100 changed notes;
- watcher overflow complete fallback;
- cached-read startup and live catch-up;
- subscriber event latency and lag recovery;
- compact graph hydration time and resident memory.

Reports remain machine-readable JSON with repeated-run p50/p95 distributions. Real-vault mode is opt-in, read-only, uses disposable cache state, and never records private paths or note names in committed output.

## Testing strategy

Implementation follows test-driven development.

### Core dependency correctness

- Dependency keys match complete resolver lookup routes for exact, extension-added, filename, stem, relative, same-note, heading, block, ambiguous, unresolved, and non-vault targets.
- Old/new identity diffs produce conservative affected-reference sets.
- Selected resolution equals complete resolution for every affected reference.

### Persistent delta correctness

- Schema version 2 round trips dependency and resolution-diagnostic rows.
- One changed note leaves unrelated note/reference row identities untouched.
- SQL work counters prove body-only edits do not rewrite global rows.
- `get_note`, backlinks, references, diagnostics, and `resolve_link` equal a clean full graph after each delta.
- Diagnostic union ordering matches the existing public deterministic order.

### Randomized oracle

Randomized sequences include edits, additions, deletions, renames, heading/block changes, ambiguous-name transitions, malformed UTF-8, unreadable files, and metadata-preserving changes. After every committed generation, incremental SQLite queries and the live resolver are compared with a clean `scan_vault` result.

### Watcher behavior

- Duplicate, reordered, paired, and unpaired hints converge to one correct generation.
- Atomic-save patterns do not publish transient deletion.
- Overflow and root invalidation force complete fallback.
- Ignored and out-of-root paths never enter reconciliation.
- Periodic inventory catches a deliberately dropped hint.

### Deterministic race injection

Test-only barriers pause:

- before and after body read;
- before the stability recheck;
- before SQLite transaction;
- before SQLite commit;
- after commit and before live install;
- after live install and before event enqueue;
- during subscription registration;
- while a manual refresh is queued.

Every specified interleaving asserts generation, live graph, SQLite rows, events, and retry state.

### Lease and recovery

- A second daemon cannot acquire the same index lease.
- Crash/process exit releases the lease without deleting or rewriting vault data.
- SQLite generation mismatch discards a local candidate.
- Graph reload and full fallback restore equivalence after injected invariant failure.
- Busy SQLite is operational failure, never corruption recovery.

### Protocol and transport

- Subscription response establishes the current generation boundary.
- Events appear only after commit and in monotonically increasing order.
- Existing unsubscribed request/response streams remain byte-compatible.
- Response and event lines never interleave.
- Oversized batches and slow subscribers receive `resync_required` without unbounded memory.
- Unknown subscriptions and live-not-ready operations return stable errors without terminating stdio.

### Read-only authority

Fixture and synthetic vault digests are identical before and after watcher, refresh, overflow, recovery, and benchmark runs. Production writes remain restricted to validated cache/index and lock paths.

### Final gates

- `cargo test --workspace --all-targets`;
- formatting check;
- Clippy with warnings denied;
- documentation build;
- Rust 1.85 workspace check and tests required by the dependency surface;
- whitespace check;
- independent review of correctness, race invariants, path safety, and bounded-resource behavior.

## Success criteria

This phase is complete when:

- a configured daemon watches included Markdown and publishes stable changes without manual refresh;
- the ordinary one-file path performs no complete inventory, no global resolution, and no global diagnostic rewrite;
- partial resolution and delta persistence equal a clean full scan across deterministic and randomized suites;
- SQLite and the compact graph expose exactly one generation across every forced publication race;
- watcher loss, overflow, failure, and startup gaps converge through explicit recovery paths;
- subscription events are post-commit, ordered, bounded, and resynchronizable;
- cached reads are available while live catch-up runs;
- a second live writer is rejected safely;
- the 10,000- and 100,000-note reports expose stage latency, row counts, affected-reference counts, and memory;
- the structural work contracts are enforced and the performance targets are measured;
- vault files remain byte-for-byte unchanged;
- the Rust 1.85, test, format, Clippy, documentation, and independent-review gates pass.

## Deferred follow-on

After this phase, `vaultd` is a fast, live, read-only semantic runtime suitable for its first real consumer. The recommended following milestone is the MCP and CLI consumer surface over the stable read and event contracts.

Search remains a later semantic/query capability. Transactions and mutations require their own write-authority, conflict, journaling, and Sync design. Obsidian acceleration, Node API compatibility, Swift, Elisp, mobile, e-ink, URI handling, and Sync remain consumers of the same semantic, generation, and event boundaries rather than additions to this phase.
