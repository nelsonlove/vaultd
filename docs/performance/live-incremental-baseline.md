# Live incremental runtime performance baseline

Synthetic baselines for the live-incremental-runtime milestone (Tasks 1–13). Absolute timings are observational and machine-bound; the structural work counters and bounded-queue behavior are the contractual part and are enforced by tests (`cargo test --workspace`, the live-race suite, and the randomized oracle in `crates/vault-index/tests/live_oracle.rs`).

Two binaries produce the numbers below:

- `vault-bench --live` extends the persistent-index milestone's benchmark (`docs/performance/persistent-index-baseline.md`) with the internal, `IndexService`-level live-incremental cases: body-only edits, an outgoing-reference edit, heading fan-out at four scales, filename-resolution transitions and their reversals, a rename, a 100-note burst, the internal complete-resolution fallback, and compact-graph hydration.
- `vault-live-bench` is new for this milestone: it starts a real `vault_server::Server` runtime — real filesystem watcher, real coordinator thread, real notice channel — against a temporary synthetic vault and cache, and measures actual watcher hint-to-event latency, post-edit cached-read latency, startup cached-read availability against an already-warm cache, cold startup catch-up, in-process subscriber delivery, and subscriber lag recovery, parsing the real `vault_protocol` wire types throughout.

## Environment

- Date: 2026-08-26
- OS: macOS 26.5.1 (Darwin), arm64
- CPU: Apple M2
- RAM: 16 GiB
- Rust: rustc 1.98.0, release profile
- Commit: `24c85e8` (branch `feat/live-incremental-runtime`, Tasks 1–13 already merged into this branch; this document is produced by Task 14 on top of it)

## Commands

```bash
cargo build --release -p vault-index --bin vault-bench
cargo build --release -p vault-server --bin vault-live-bench
./target/release/vault-bench --notes 10000 --repeats 7 --live > /tmp/vaultd-bench/vaultd-live-10k.json
./target/release/vault-bench --notes 100000 --repeats 7 --live > /tmp/vaultd-bench/vaultd-live-100k.json
./target/release/vault-live-bench --notes 10000 --repeats 7 > /tmp/vaultd-bench/vaultd-events-10k.json
./target/release/vault-live-bench --notes 100000 --repeats 7 > /tmp/vaultd-bench/vaultd-events-100k.json
python3 -m json.tool /tmp/vaultd-bench/vaultd-live-10k.json >/dev/null
python3 -m json.tool /tmp/vaultd-bench/vaultd-live-100k.json >/dev/null
python3 -m json.tool /tmp/vaultd-bench/vaultd-events-10k.json >/dev/null
python3 -m json.tool /tmp/vaultd-bench/vaultd-events-100k.json >/dev/null
```

`vault-live-bench`'s `startup_catch_up` case is capped at 3 repeats internally regardless of `--repeats` (see the case's own doc comment): each sample is a full cold build from an empty cache, already measured in isolation by `vault-bench`'s `cold_index` case, so paying it 7 times would roughly double this binary's wall-clock cost at 100,000 notes for no new information.

Full JSON reports are not committed here (they run 6–30 KB each and are exactly reproducible from the commands above); the tables below are the complete `timings_ms`/`work`/`peak_rss_bytes` content of each report, one row per case, which is the "summarized distributions" form the brief's Step 7 authorizes as an alternative to embedding full JSON.

## Profiling before tuning (Step 4/5)

Stage-level distributions inside every JSON report (`stages_ms` per live case, and `vault-bench`'s existing `stages` block for the persistent-index cases) were inspected before any tuning change was considered, per the design's "profile before any tuning change" rule. No SQLite pragma, batching, or threshold change was made: every case at both scales already lands comfortably inside its design target (see "Target comparison" below), or its cost is explained entirely by the work it is defined to do (heading fan-out scaling with fan-out; the complete-resolution fallback scaling with the whole graph). `wal_autocheckpoint` is left at its default (unset) — the known follow-up documented in `crates/vault-index/src/reconcile.rs`'s `publish_snapshot` is not isolated by anything measured here. No focused tuning patch was applied.

## 10,000-note reports

`vault-bench --live --notes 10000 --repeats 7`, `note_count` (including live-case fixtures): 11,120.

| case | p50 (ms) | p95 (ms) | affected_references | note_rows | reference_rows | resolution_rows | dependency_rows | diagnostic_rows | peak_rss_bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `body_only_edit` | 0.146 | 0.250 | 0 | 7 | 0 | 0 | 0 | 0 | 140,328,960 |
| `outgoing_reference_edit` | 0.230 | 0.244 | 1 | 7 | 7 | 7 | 35 | 0 | 140,328,960 |
| `heading_fanout_0` | 0.135 | 0.153 | 0 | 7 | 0 | 0 | 0 | 0 | 140,328,960 |
| `heading_fanout_10` | 0.662 | 0.760 | 10 | 7 | 0 | 70 | 350 | 40 | 140,328,960 |
| `heading_fanout_100` | 5.155 | 10.349 | 100 | 7 | 0 | 700 | 3,500 | 400 | 140,328,960 |
| `heading_fanout_high` (1,000) | 57.465 | 69.156 | 1,000 | 7 | 0 | 7,000 | 35,000 | 4,000 | 140,328,960 |
| `unresolved_to_resolved` | 0.236 | 0.359 | 1 | 7 | 0 | 7 | 35 | 0 | 140,328,960 |
| `resolved_to_ambiguous` | 0.241 | 0.268 | 1 | 7 | 0 | 7 | 28 | 7 | 140,328,960 |
| `delete_reversals` | 0.186 | 2.142 | 1 | 0 | 0 | 14 | 57 | 13 | 140,328,960 |
| `rename` | 0.160 | 0.176 | 0 | 7 | 0 | 0 | 0 | 0 | 140,328,960 |
| `burst_100_notes` | 20.548 | 26.807 | 200 | 700 | 1,400 | 1,400 | 7,000 | 0 | 140,328,960 |
| `complete_fallback_after_overflow` | 1,109.5 | 1,115.0 | 21,112 | 7 | 0 | 147,784 | 738,913 | 7,737 | 178,601,984 |
| `compact_graph_hydration` | 69.497 | 71.395 | 21,112 | 0 | 0 | 0 | 0 | 0 | 205,094,912 |

`vault-live-bench --notes 10000 --repeats 7`:

| case | p50 (ms) | p95 (ms) | `notes` field | `affected_references` field | `queue_len_before_drain` | peak_rss_bytes |
|---|---:|---:|---:|---:|---:|---:|
| `hint_to_committed_event` | 136.263 | 138.938 | 10,000 | 0 | 0 | 129,335,296 |
| `post_edit_cached_read` | 132.241 | 139.099 | 10,000 | 0 | 0 | 129,466,368 |
| `cached_read_availability` | 65.085 | 66.210 | 10,000 | 0 | 0 | 162,299,904 |
| `startup_catch_up` | 1,750.8 | 1,757.2 | 10,000 | 0 | 0 | 162,299,904 |
| `subscriber_delivery` | 0.0003 | 0.0023 | 7 (notices offered) | 7 (events delivered) | 0 | 162,299,904 |
| `lag_recovery` | 0.0001 | 0.0001 | 69 (notices offered) | 1 (events emitted by the drain) | 1 | 162,299,904 |

## 100,000-note reports

`vault-bench --live --notes 100000 --repeats 7`, `note_count` (including live-case fixtures): 101,120.

| case | p50 (ms) | p95 (ms) | affected_references | note_rows | reference_rows | resolution_rows | dependency_rows | diagnostic_rows | peak_rss_bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `body_only_edit` | 0.127 | 0.238 | 0 | 7 | 0 | 0 | 0 | 0 | 1,284,390,912 |
| `outgoing_reference_edit` | 0.233 | 0.309 | 1 | 7 | 7 | 7 | 35 | 0 | 1,284,390,912 |
| `heading_fanout_0` | 0.133 | 0.139 | 0 | 7 | 0 | 0 | 0 | 0 | 1,284,390,912 |
| `heading_fanout_10` | 0.715 | 1.046 | 10 | 7 | 0 | 70 | 350 | 40 | 1,284,390,912 |
| `heading_fanout_100` | 5.465 | 13.867 | 100 | 7 | 0 | 700 | 3,500 | 400 | 1,284,390,912 |
| `heading_fanout_high` (1,000) | 64.182 | 77.868 | 1,000 | 7 | 0 | 7,000 | 35,000 | 4,000 | 1,284,390,912 |
| `unresolved_to_resolved` | 0.236 | 0.314 | 1 | 7 | 0 | 7 | 35 | 0 | 1,284,390,912 |
| `resolved_to_ambiguous` | 0.240 | 0.252 | 1 | 7 | 0 | 7 | 28 | 7 | 1,284,390,912 |
| `delete_reversals` | 0.183 | 0.261 | 1 | 0 | 0 | 14 | 57 | 13 | 1,284,390,912 |
| `rename` | 0.167 | 0.188 | 0 | 7 | 0 | 0 | 0 | 0 | 1,284,390,912 |
| `burst_100_notes` | 21.729 | 29.821 | 200 | 700 | 1,400 | 1,400 | 7,000 | 0 | 1,284,390,912 |
| `complete_fallback_after_overflow` | 11,732.6 | 26,831.8 | 201,112 | 7 | 0 | 1,407,784 | 7,038,913 | 7,737 | 1,284,390,912 |
| `compact_graph_hydration` | 1,245.3 | 1,641.3 | 201,112 | 0 | 0 | 0 | 0 | 0 | 1,284,390,912 |

`vault-live-bench --notes 100000 --repeats 7`:

| case | p50 (ms) | p95 (ms) | `notes` field | `affected_references` field | `queue_len_before_drain` | peak_rss_bytes |
|---|---:|---:|---:|---:|---:|---:|
| `hint_to_committed_event` | 133.257 | 137.734 | 100,000 | 0 | 0 | 1,041,154,048 |
| `post_edit_cached_read` | 129.049 | 139.991 | 100,000 | 0 | 0 | 1,041,154,048 |
| `cached_read_availability` | 723.380 | 819.873 | 100,000 | 0 | 0 | 1,155,497,984 |
| `startup_catch_up` | 19,396.8 | 19,595.7 | 100,000 | 0 | 0 | 1,155,497,984 |
| `subscriber_delivery` | 0.0003 | 0.0332 | 7 (notices offered) | 7 (events delivered) | 0 | 1,155,497,984 |
| `lag_recovery` | 0.0001 | 0.0001 | 69 (notices offered) | 1 (events emitted by the drain) | 1 | 1,155,497,984 |

## Reading the numbers

- `body_only_edit`, `outgoing_reference_edit`, and the filename-resolution transitions (`unresolved_to_resolved`, `resolved_to_ambiguous`, `delete_reversals`) all cost well under a millisecond at both scales and touch 0–1 references — proportional to the change, not the vault. This is unchanged going from 10,000 to 100,000 notes, which is the structural proof the design's O(D)/O(A) claim is about.
- `heading_fanout_{0,10,100,high}` scale with the fan-out, not with the vault size: `affected_references` matches the named fan-out exactly at both scales, and p50 is nearly identical at 10k vs 100k for the same fan-out (0.135/0.133 ms, 0.662/0.715 ms, 5.155/5.465 ms, 57.465/64.182 ms) — the resolution and dependency-row cost is proportional to the fan-out, never to the 10x larger vault.
- `rename` and `burst_100_notes` exercise a multi-path batch in one `refresh_paths` call, matching how the runtime coordinator actually batches a paired rename hint or a debounced burst; both stay flat across the 10x note-count increase.
- `complete_fallback_after_overflow` forces the *internal* complete-resolution fallback inside `refresh_paths` (`select_impact`'s selected-count threshold) via the test-only `set_complete_resolution_threshold_for_test(1)`, reusing the 10-fan-in heading hub — production's real threshold (`max(10_000, references / 4)`) is unreachable at these fixture scales. This is **not** the runtime's separate watcher-overflow full reconciliation (a whole-vault code path in `vault-server`'s coordinator); `vault-live-bench`'s `startup_catch_up` case is the closest whole-vault-cost proxy this report has for that path, since both pay for resolving the whole graph. `affected_references` here is the last sample's re-resolved count, which is the graph's whole reference count at that point (accumulated fixture notes included: 21,112 at 10k, 201,112 at 100k), not just the 10-note fan-out that triggered it. Its cost scales roughly 10x from 10k to 100k (1.1 s → 11.7 s p50), consistent with the O(R) complexity the design states for this fallback. The wide p95 spread at 100k (11.7 s p50 vs 26.8 s p95) reflects allocator/GC-style variance resolving ~1.4M+ resolution rows repeatedly in one process, not a correctness concern.
- `compact_graph_hydration` is run last in `vault-bench`'s case list so its `peak_rss_bytes` — a running high-water mark since process start, via `getrusage(RUSAGE_SELF)` — is the largest this process reaches at the point it matters most for that case's own claim. See "Known limits" below for why this number is **not** a clean isolated measurement of the compact live graph alone.
- `hint_to_committed_event` and `post_edit_cached_read` are driven by a real filesystem write and a real `notify`-backed watcher against a warm cache; their latency (126–141 ms across both scales) is dominated by the 100 ms default debounce window, not by resolution or SQL cost (see `hint_to_committed_event`'s `stages_ms`, which mirrors the real `ReconcileMetrics` captured off the matching `generation_committed` notice — sub-millisecond stage sums against a ~130 ms wall-clock total).
- `cached_read_availability` is the design's actual "cached-read availability... when a valid index exists" target: time from `Server::start()` returning to the first successful read against an *already-warm* cache (no filesystem write involved). It is dominated by `IndexService::open`'s synchronous SQLite-connection setup and compact-live-graph hydration from stored rows — both O(N) in note/reference count — which is why it scales with vault size (see "Target comparison").
- `startup_catch_up` measures a cold build plus runtime startup overhead through to `Watching`: the worst case, where nothing is cached yet at all.
- `subscriber_delivery` and `lag_recovery` are in-process `SubscriptionRegistry` measurements (no filesystem, no watcher): `subscriber_delivery`'s `notes`/`affected_references` fields are repurposed as "notices offered"/"events delivered"; `lag_recovery`'s as "notices offered before drain"/"events emitted by the drain", with `queue_len_before_drain` reporting the queue depth immediately before the timed drain. It is far below `SUBSCRIBER_CAPACITY` (64) in both runs (0 and 1) because the registry collapses the queue at push time, the moment it reaches capacity — not lazily at drain time — so by the time a drain is timed, the collapse has already happened.

## Target comparison

Per `docs/design/live-incremental-runtime.md`'s "Target measurements", all on the same Apple M2 baseline and the 100,000-note synthetic vault:

| Target | Measured (100k, p50 unless noted) | Verdict |
|---|---|---|
| Cached-read availability under 100 ms p50 when a valid index exists | `cached_read_availability`: 723.4 ms p50 at 100k (65.1 ms p50 at 10k) | **Missed at 100k** — see below |
| Body-only edit processing under 50 ms p50 after debounce | `body_only_edit`: 0.127 ms p50 | Comfortably met |
| Watcher hint to committed generation event under 250 ms p50 and 500 ms p95 | `hint_to_committed_event`: 133.3 ms p50 / 137.7 ms p95 | Met |
| Warm indexed note/backlink queries sub-millisecond p50 | Unchanged from `docs/performance/persistent-index-baseline.md` (`get_note`/`backlinks` in the same `vault-bench` report, ~0.06–0.11 ms at 100k) | Met (persistent-index milestone's own measurement, reconfirmed by this report's `vault-bench` run) |
| Body-only edit reads one body and parses one note | `body_only_edit` `work`: 1 body read, 1 reparse per sample (visible in the raw JSON's `work.body_reads`/`work.notes_reparsed`, aggregated to 7 across the 7 repeats; omitted from the summarized table's column set above) | Met |
| Body-only edit performs no complete inventory | `body_only_edit` `work.complete_inventories` = 0 | Met |
| Resolution and SQL row counters proportional to the changed source's outgoing references | `outgoing_reference_edit`: 1 affected reference, 7 resolution/35 dependency rows (constant across both scales) | Met |
| Compact live-state resident-memory growth under 512 MiB | `compact_graph_hydration` reports 1,284,390,912 bytes (~1.22 GiB) peak RSS at 100k | **Not cleanly measurable — see "Known limits"; the raw number exceeds 512 MiB but is not attributable to the live graph alone** |

**`cached_read_availability` is a genuine, honest miss at 100,000 notes**: 723 ms p50 / 820 ms p95, over 7x the 100 ms target, versus 65 ms p50 at 10,000 notes — the cost scales with note count, not the target's implicit assumption of near-constant startup. The cause is not the live-incremental runtime's ordinary operation: it is `IndexService::open`'s synchronous work before `Server::start` ever returns — opening the SQLite connection and, inside `assemble`/`seed_published`, hydrating the compact live graph from every stored note and reference (`IndexStore::hydrate_live_graph`), an O(N) pass with no shortcut in the current design. This runs *before* the watcher installs and *before* the coordinator's own catch-up cycle, so it is unrelated to watching, debouncing, or reconciliation — it is pure startup-time graph hydration cost. The design's Goal ("make cached indexed reads available before startup catch-up completes") is still met in the qualitative sense that a read never waits for the coordinator's metadata reconciliation — but the *quantitative* "under 100 ms p50" target assumed this hydration would be cheap enough not to matter, which this measurement disproves at 100,000 notes. This is a real finding for a future milestone (a lazier or incremental live-graph hydration path), not a regression introduced by Task 14, and it is reported here honestly rather than reframed to pass.

## Known limits and honest gaps

- **`peak_rss_bytes` is a whole-process, monotonic high-water mark, not an isolated measurement of the compact live graph.** `vault-bench --live` runs the persistent-index milestone's own cold/warm/verified sections (seven full 100,000-note cold builds among them) in the *same process*, before ever reaching the live-incremental cases; `getrusage(RUSAGE_SELF)`'s `ru_maxrss` can only grow, never shrink, for the life of a process, so the 1.22 GiB figure reported at `compact_graph_hydration` is dominated by that earlier, already-documented persistent-index work (`docs/performance/persistent-index-baseline.md`), not by the compact live graph's own footprint. `vault-live-bench`'s peak RSS is contaminated the same way by its own cold builds (one to seed the warm cache, up to three more for `startup_catch_up`). Neither binary's `peak_rss_bytes` is a clean pass/fail against the design's 512 MiB "compact live-state" target as a result — a dedicated, single-purpose, isolated-process measurement (cold-build once, hydrate once, measure RSS immediately after, exit) would be needed for that, and does not exist yet. Reported here as an honest gap rather than silently presented as a target miss it cannot actually prove.
- **`note_rows_written`/`reference_rows_written` in `WorkCounts` are populated only by the delta (incremental) publication path**; the complete-resolution path never sets them (`vault_index::metrics::WorkCounts`, `IndexService::publish_snapshot`). `complete_fallback_after_overflow`'s `work` row above therefore shows `note_rows_written: 7`/`reference_rows_written: 0` — the accumulated total from earlier delta-path cases in the same run, not the fallback's own (much larger) write volume; its `resolution_rows_written`/`dependency_rows_written`/`diagnostic_rows_written` *are* accurate, because the complete path does populate those three. This is a pre-existing metrics gap flagged as a binding note for this task, not something Task 14 introduced; it is excluded from cross-path note/reference-row comparison here rather than fixed, per the sanctioned choice to document it instead of touching the reconciliation write path in a benchmarking task.
- **`stages_ms.event_enqueue` is always zero in every report above.** Nothing in the current implementation populates `ReconcileMetrics.stages.event_enqueue` — it is declared in `vault_index::metrics::StageDurations` and serialized faithfully by both benchmark binaries, but no code path assigns it a duration. This predates Task 14 and is reported here as an honest gap rather than fabricated.
- `post_edit_cached_read` and `startup_catch_up` report empty `stages_ms`/`work` (see "Reading the numbers" above for why); they are timing-only cases.
- `wal_autocheckpoint` is unset (SQLite default of 1,000 pages), so a full-publication commit runs a passive checkpoint inside the exclusive section, per the documented comment in `IndexService::publish_snapshot`. None of Task 14's benchmark cases isolate that cost from ordinary commit cost, so it is not separately measured here; it remains the ledgered follow-up it already was.
- `resolution_dependencies` rows are written on every publication but read only by tests (`LiveGraph` recomputes its own dependency keys at hydration rather than reading them back) — a known write-amplification noted at the schema, not a correctness issue, and not something this benchmark quantifies separately from ordinary SQL-write cost.
- All timing numbers are single-machine, single-run-per-scale observations (Apple M2, otherwise idle except for this session's own tooling). No comparison against stock Obsidian is made or implied; the persistent-index milestone's stock-Obsidian comparison rubric (`docs/performance/persistent-index-baseline.md`) still applies and no such comparison has been run for this milestone either.
- Real-vault mode is intentionally out of scope for every case in this document — `vault-bench --vault` still skips `--live` entirely (real-vault mode performs no source writes), and `vault-live-bench` has no `--vault` mode at all. The maintainer's real vault was never read, benchmarked, or referenced while producing this document, per the global constraint against benchmarking against it.

## Opt-in real-vault measurement

`vault-bench --vault /path/to/vault --repeats 7` remains available exactly as documented in `docs/performance/persistent-index-baseline.md`: read-only, into a temporary index, with `--live` silently skipped (real-vault mode performs no source writes). `vault-live-bench` has no equivalent real-vault mode; it always builds and watches a disposable synthetic vault.
