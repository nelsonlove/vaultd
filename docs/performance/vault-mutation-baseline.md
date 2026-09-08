# Vault mutation and bulk-read performance baseline

Synthetic baselines for the vault-mutations-and-bulk-reads milestone (Tasks 1–18). **Baselines, not contracts** — the phase-4 policy carried forward. Absolute timings are observational and machine-bound; what the test suites enforce is the structural part (typed refusals that change nothing, read-your-writes, one generation per rename burst, a session coherent at one generation). Each number below is tied to a named benchmark case, so a regression has somewhere to show up.

Two binaries produce the numbers, both extended by this milestone:

- `vault-bench --mutations` adds the `IndexService`-level write cases to the existing benchmark (`docs/performance/live-incremental-baseline.md`, `docs/performance/persistent-index-baseline.md`): `write_note_commit`, `patch_frontmatter_commit`, `delete_note_commit`, and the rename fan-out matrix `rename_fanout_{0,10,100,1000}`. Each case times **the mutation plus the reconciliation that publishes it**, because that is what a client actually waits for: the daemon answers a mutation only after the generation containing it has published.
- `vault-live-bench` adds `snapshot_hydration`: a whole vault hydrated through one snapshot session — open, page the entire tree, page every note's `metadata` and `references` facets, close — which is what a headless host does once at startup, and the only operation in this phase whose cost is proportional to the whole vault.

## Environment

- Date: 2026-09-08
- OS: macOS 26.5.1 (Darwin 25F80), arm64
- CPU: Apple M2
- RAM: 16 GiB
- Rust: rustc 1.97.1, release profile
- Commit: `46fc404` (branch `feat/vault-mutations-and-bulk-reads`, Tasks 1–17 landed; this document is produced by Task 18 on top of it)
- Filesystem: APFS, case-insensitive, on the internal SSD

## Commands

```bash
mkdir -p "$PWD/target/tmp" "$PWD/target/bench-reports"
export TMPDIR="$PWD/target/tmp"
cargo build --release -p vault-index --bin vault-bench
cargo build --release -p vault-server --bin vault-live-bench
./target/release/vault-bench --notes 10000 --repeats 7 --mutations > target/bench-reports/vaultd-mutations-10k.json
./target/release/vault-bench --notes 100000 --repeats 7 --mutations > target/bench-reports/vaultd-mutations-100k.json
./target/release/vault-live-bench --notes 10000 --repeats 7 > target/bench-reports/vaultd-hydration-10k.json
./target/release/vault-live-bench --notes 100000 --repeats 3 > target/bench-reports/vaultd-hydration-100k.json
for f in target/bench-reports/*.json; do python3 -m json.tool "$f" >/dev/null; done
```

`TMPDIR` points inside the repository deliberately: every synthetic vault and cache is built under it, and pointing it at the system temporary directory would measure a different filesystem than the one being reported. The reports are written under `target/` rather than `/tmp` for the same reason and are not committed (6–17 KB each, exactly reproducible from the commands above); the tables below are the complete `timings_ms`/`work`/`peak_rss_bytes` content, one row per case.

The 100,000-note `vault-live-bench` run uses `--repeats 3` rather than 7: two of its cases (`startup_catch_up`, `attachment_burst_500_new_folder`) are whole-vault reconciliations already measured in isolation elsewhere, and the case this document is about (`snapshot_hydration`) has a p50/p95 spread of 6 ms across those three samples, so more repeats would buy nothing.

**Everything here is synthetic.** The vaults are generated flat directories of `Note-NNNNNN.md` files with two wikilinks each. No real vault was read, benchmarked, or referenced, and `vault-bench --vault` skips `--mutations` entirely for that reason — real-vault mode performs no source writes.

## Profiling before tuning

Per the design's "profile before any tuning change" rule, the stage distributions inside every report (`stages_ms` per case, mirroring `ReconcileMetrics` field-for-field) were read **before** any tuning was considered. **No tuning change was made.** What the profile says:

**The reconciliation is not where the time goes.** For `write_note_commit` at 100,000 notes, the whole `stages_ms` block sums to about 1 ms (`sqlite_commit` 0.67, `sqlite_write` 0.18, `parse` 0.03, `body_read` 0.03, `resolution` 0.004) against a 67 ms wall-clock p50. The publication side of a mutation is already proportional to the change, exactly as the live-incremental milestone measured it. The other 66 ms is spent in the mutation engine, before reconciliation begins.

**Two mechanisms account for it, and both were measured rather than assumed.**

1. **One directory listing per addressed path.** Every mutation that names a path checks for a case-insensitive collision by reading the target's parent directory (`MutationEngine::case_scan` → `std::fs::read_dir`), which is O(entries in that folder). The synthetic vault is one flat directory, so that folder *is* the vault. Measured directly on this machine and filesystem: listing a directory of 10,000 entries costs 5.1 ms p50, and 100,000 entries costs 51.9 ms p50. That matches the floor every mutation case shows — `delete_note_commit`, which writes no bytes, costs 5.0 ms at 10k and 61.2 ms at 100k, and the write and patch cases sit a few milliseconds above it.
2. **One `fsync` per file written.** `staged` calls `sync_all()` before the atomic rename, so a note reaches disk durably rather than only into the page cache. The rename fan-out matrix prices it exactly: the marginal cost per referrer rewritten is 5.4 ms at 10,000 notes and 5.3 ms at 100,000 — **identical across a 10x vault**, which is what proves it is a per-file cost and not a vault-size one.

**A tuning change would trade a real guarantee for the time.** Dropping the case scan would give up Ruling 4's collision refusal — the divergence from Obsidian this milestone deliberately chose. Dropping the `fsync` would make an acknowledged write survivable only until the next power loss. Neither is a knob to turn inside a benchmarking task, and both are recorded below as follow-ups with the shape a real fix would take.

One thing the profile does **not** show, and cannot: the rename repair planner's vault-size term (`mutate::rename::plan_repair` rebuilds a whole-vault resolver from `LiveGraph::note_paths()`). It is inside the timed section but has no stage of its own, so it appears only as part of `rename_fanout_0`'s wall-clock cost. See the warning under "Reading the numbers".

## 10,000-note reports

`vault-bench --notes 10000 --repeats 7 --mutations`, `note_count` including every fixture the run creates: 17,800.

| case | p50 (ms) | p95 (ms) | affected_references | note_rows | reference_rows | resolution_rows | dependency_rows | peak_rss_bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `write_note_commit` | 9.881 | 15.329 | 1 | 7 | 7 | 7 | 28 | 175,226,880 |
| `patch_frontmatter_commit` | 9.303 | 10.235 | 0 | 7 | 0 | 0 | 0 | 175,226,880 |
| `delete_note_commit` | 5.034 | 5.085 | 0 | 0 | 0 | 0 | 0 | 175,226,880 |
| `rename_fanout_0` | 42.428 | 43.696 | 0 | 7 | 0 | 0 | 0 | 185,319,424 |
| `rename_fanout_10` | 81.732 | 84.224 | 10 | 77 | 70 | 70 | 350 | 185,483,264 |
| `rename_fanout_100` | 514.964 | 530.762 | 100 | 707 | 700 | 700 | 3,500 | 187,875,328 |
| `rename_fanout_1000` | 5,461.7 | 5,572.9 | 1,000 | 7,007 | 7,000 | 7,000 | 35,000 | 209,649,664 |

`vault-live-bench --notes 10000 --repeats 7` (the six phase-4 cases are reproduced unchanged for context; `snapshot_hydration` is this milestone's):

| case | p50 (ms) | p95 (ms) | `affected_references` field | peak_rss_bytes |
|---|---:|---:|---:|---:|
| `hint_to_committed_event` | 136.240 | 141.713 | 0 | 136,527,872 |
| `post_edit_cached_read` | 129.313 | 136.098 | 0 | 136,708,096 |
| `cached_read_availability` | 66.540 | 67.019 | 0 | 169,558,016 |
| `startup_catch_up` | 1,955.8 | 2,042.8 | 0 | 174,800,896 |
| `subscriber_delivery` | 0.000 | 0.010 | 7 (events delivered) | 169,558,016 |
| `lag_recovery` | 0.000 | 0.000 | 1 (events emitted by the drain) | 169,558,016 |
| `snapshot_hydration` | 454.838 | 459.090 | 10,002 (notes hydrated) | 170,573,824 |
| `attachment_burst_500` | 193.695 | 202.128 | 0 | 174,800,896 |
| `attachment_burst_500_new_folder` | 243.066 | 243.077 | 0 | 174,800,896 |

## 100,000-note reports

`vault-bench --notes 100000 --repeats 7 --mutations`, `note_count` including fixtures: 107,800.

| case | p50 (ms) | p95 (ms) | affected_references | note_rows | reference_rows | resolution_rows | dependency_rows | peak_rss_bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `write_note_commit` | 67.370 | 72.157 | 1 | 7 | 7 | 7 | 28 | 1,939,914,752 |
| `patch_frontmatter_commit` | 68.212 | 69.797 | 0 | 7 | 0 | 0 | 0 | 1,939,914,752 |
| `delete_note_commit` | 61.222 | 62.154 | 0 | 0 | 0 | 0 | 0 | 1,939,914,752 |
| `rename_fanout_0` | 439.484 | 458.643 | 0 | 7 | 0 | 0 | 0 | 1,939,914,752 |
| `rename_fanout_10` | 484.333 | 501.644 | 10 | 77 | 70 | 70 | 350 | 1,939,914,752 |
| `rename_fanout_100` | 928.791 | 936.392 | 100 | 707 | 700 | 700 | 3,500 | 1,939,914,752 |
| `rename_fanout_1000` | 5,779.5 | 6,165.2 | 1,000 | 7,007 | 7,000 | 7,000 | 35,000 | 1,939,914,752 |

`vault-live-bench --notes 100000 --repeats 3`:

| case | p50 (ms) | p95 (ms) | `affected_references` field | peak_rss_bytes |
|---|---:|---:|---:|---:|
| `hint_to_committed_event` | 129.474 | 135.904 | 0 | 1,222,868,992 |
| `post_edit_cached_read` | 122.161 | 123.545 | 0 | 1,223,065,600 |
| `cached_read_availability` | 716.166 | 736.041 | 0 | 1,342,423,040 |
| `startup_catch_up` | 22,305.9 | 22,787.1 | 0 | 1,605,664,768 |
| `subscriber_delivery` | 0.001 | 0.262 | 3 (events delivered) | 1,342,423,040 |
| `lag_recovery` | 0.000 | 0.000 | 1 (events emitted by the drain) | 1,342,423,040 |
| `snapshot_hydration` | 4,605.8 | 4,611.5 | 100,002 (notes hydrated) | 1,342,668,800 |
| `attachment_burst_500` | 210.964 | 212.890 | 0 | 1,777,156,096 |
| `attachment_burst_500_new_folder` | 862.431 | 872.698 | 0 | 1,782,611,968 |

## Reading the numbers

- **The three single-file cases share one floor, and it is the directory scan.** `delete_note_commit` writes no bytes and still costs 5.0 ms at 10k and 61.2 ms at 100k; `write_note_commit` and `patch_frontmatter_commit` sit a few milliseconds above it, which is the `fsync`. The floor is the case-collision `read_dir`, and it scales with **the number of entries in the target's own folder**, not with the vault. A flat synthetic vault is the worst possible shape for it: a real vault with a hundred notes per folder would pay roughly 0.05 ms there, not 52 ms. This benchmark deliberately does not pretend otherwise, and the honest reading is "the mutation cost is one directory listing plus one fsync plus a sub-millisecond reconciliation".
- **`rename_fanout_*` is a straight line in the fan-out.** At 100,000 notes: 439 ms at fan-out 0, 484 ms at 10, 929 ms at 100, 5,780 ms at 1,000 — a fixed base plus about 5.3 ms per referrer. At 10,000 notes the same slope holds at 5.4 ms per referrer. That per-referrer cost is a read, a splice, a CAS re-check, and an `fsync`, and it does not care how big the vault is.
- **The base of that line *is* the vault-size term, and this matrix can only see it by comparing scales.** `rename_fanout_0` — a rename with no inbound links at all — costs 42 ms at 10,000 notes and 439 ms at 100,000: **10x the vault, 10x the base**. Two O(vault) mechanisms sit inside it: `plan_repair` rebuilding a whole-vault `Resolver` from `LiveGraph::note_paths()` (one `ResolutionNote` per note, headings and block ids included), and the several parent-directory scans a rename performs (source, destination, reservation, and the move's re-check). **Warning, stated as the plan requires it: the fan-out matrix varies fan-out against a fixed vault, so this term appears as a constant offset in all four points and the curve looks flat in exactly the axis that is not.** A dedicated case (fixed fan-out, vault size varied) would measure it properly; the 10k-vs-100k comparison above is the closest this document gets. The follow-up that removes the resolver half is tracked as **"Resolve rename repair spellings from the live graph's candidate index"**.
- **Row counters are proportional to the fan-out, not the vault.** `rename_fanout_100` writes 700 reference rows and 3,500 dependency rows across its 7 repeats (100 and 500 per repeat) at *both* scales, and `affected_references` equals the named fan-out exactly. That is the structural claim the design makes about repair, and it holds unchanged across a 10x vault.
- **`write_note_commit` reports `affected_references: 1`** because the benchmark's body carries one wikilink; the reconciliation resolves exactly that one reference, never the vault's.
- **`snapshot_hydration` pages a whole vault in one session**: 455 ms for 10,002 notes, 4.61 s for 100,002 notes — roughly 46 µs per note at both scales, so the cost is linear in the vault and the per-note constant does not degrade. It hydrates the tree *and* every note's `metadata` and `references` facets, at 500 rows a page, without ever leaving the pinned transaction. Bodies are deliberately not requested (that is `get_note`'s job), and the case asserts that the number of entries and notes it paged equals the counts `open_snapshot` promised — a hydration that silently paged short would otherwise look fast.
- **`snapshot_hydration`'s added memory is small, and that is the number the target wants.** `peak_rss_bytes` is a whole-process monotonic high-water mark, so its absolute value at 100k (1.34 GB) is dominated by the cold build that ran earlier in the same process. The *increment* over the immediately preceding case is the meaningful figure: **+0.24 MiB at 100,000 notes** (1,342,423,040 → 1,342,668,800) and +0.97 MiB at 10,000. Paging is why: 500 rows are materialized at a time and dropped, so hydrating a vault never has the vault in memory. The caveat is stated rather than hidden — a process that has already peaked high can serve new allocations from memory it has already touched, so this is an upper bound on *added* RSS for a daemon that has already built its index, which is the daemon the target describes, and not an isolated measurement of hydration in a fresh process.
- **The phase-4 cases are unchanged.** `hint_to_committed_event` (129–136 ms, debounce-dominated), `cached_read_availability` (716 ms at 100k — still the honest miss `live-incremental-baseline.md` records), and the attachment bursts land where that document already reports them. Nothing in this milestone moved the read or watcher paths.

## Target comparison

Per the design's "Target measurements" (`docs/design/vault-mutations-and-bulk-reads.md` lines 113–115), on the 100,000-note synthetic vault:

| Target | Measured (100k) | Verdict |
|---|---|---|
| `write_note` → committed: **p50 < 25 ms** | `write_note_commit`: 67.4 ms p50 | **Missed** — 2.7x over; see below |
| `write_note` → committed: **p95 < 100 ms** | `write_note_commit`: 72.2 ms p95 | Met |
| `rename_note` at the 120-inbound-link case: **p50 < 500 ms** including rewrites | Not benchmarked as a point; the curve gives ~1.04 s at fan-out 120 (929 ms at 100 plus 20 × 5.3 ms) | **Missed** at 100k. At 10,000 notes the same interpolation gives ~625 ms, also over |
| Curve reported at 0/10/100/1000 | 439 / 484 / 929 / 5,780 ms p50 | Reported |
| Full hydration via snapshot session (tree + semantic rows, no bodies): **< 10 s wall** | `snapshot_hydration`: 4.61 s p50, 4.61 s p95 | Met, with ~2x headroom |
| Full hydration: **< 256 MiB peak added RSS** | `snapshot_hydration`: +0.24 MiB over the preceding case's peak | Met (see the caveat above) |

**The `write_note` p50 miss is real and is not the write path.** the 67.4 ms is dominated by the directory listing — measured at 51.9 ms for a 100,000-entry directory on this machine and filesystem, against the 107,800 entries this case's folder actually holds — plus a few milliseconds of staging and `fsync`, and about 1 ms of reconciliation. `delete_note_commit`, which does the same scan and writes nothing, costs 61.2 ms on its own, which is what pins the attribution. The design's 25 ms target was set against the 133 ms watcher path, on the reasoning that a mutation skips the debounce — which it does. What the target did not anticipate is a per-mutation O(folder) directory scan meeting a vault that keeps 100,000 notes in one folder. At 10,000 notes the same code path measures 9.9 ms p50 / 15.3 ms p95, comfortably inside. **The target is left as stated and the miss is reported rather than the target adjusted**, with two named follow-ups:

- *Cache the case-collision scan per folder*, invalidated by the watcher's own events for that folder. The scan exists to answer "does a name folding onto this one already exist here", which the index could answer from `tree_entries` at the pinned generation instead of from the filesystem — at the cost of a decision made against a possibly-stale view, which is exactly the trade correction #8 refused for CAS. A safe middle is to scan only when the index *suspects* a fold.
- *Ask the filesystem instead of enumerating it.* On a case-insensitive volume, `stat` on the caller's spelling plus a comparison of the stored name answers the same question in one syscall for the common case, leaving the full listing for the case where the stored name differs.

**The rename miss is the same story with a second term.** The 120-link figure was never a benchmarked point (this matrix measures 0/10/100/1000, and the plan says so); interpolated, it lands at about 1.04 s at 100k — over the 500 ms target, with roughly 440 ms of it being the vault-size base rather than the repair itself. Both follow-ups above reduce it, and the resolver follow-up ("Resolve rename repair spellings from the live graph's candidate index") reduces the rest. At a fan-out of 10 — which is what most real renames are — the whole burst is 484 ms at 100k and 82 ms at 10k.

## Known limits and honest gaps

- **The synthetic vault is flat, and that is the worst case for the dominant cost.** Every note lives in the vault root, so the per-mutation directory scan reads 100,000+ entries. A vault organized into folders pays that cost per folder. No case here measures a foldered vault, so the mutation numbers should be read as an upper bound on the directory-scan term, not as a typical figure.
- **The vault-size axis of rename repair is inferred from two scales, not measured by a case.** `rename_fanout_0` at 10k versus 100k is the whole evidence (42 ms → 439 ms). No case holds fan-out fixed and varies vault size, so the split between the resolver rebuild and the rename's own directory scans inside that base is arithmetic, not measurement.
- **`peak_rss_bytes` is a whole-process monotonic high-water mark**, contaminated in both binaries by the cold builds that precede the cases — the same limitation `live-incremental-baseline.md` records. The hydration increment reported above is the honest way to read it; the absolute figures are not a clean pass/fail against any memory target.
- **`note_rows_written`/`reference_rows_written` are populated only by the delta publication path** (a pre-existing metrics gap, documented in `live-incremental-baseline.md`). Every mutation case here takes that path, so the columns are accurate in these tables — but they are cumulative across a case's repeats, so a per-repeat figure is the tabled value divided by 7.
- **`stages_ms.event_enqueue` is always zero**, unchanged: nothing assigns it. Pre-existing, reported rather than fabricated.
- **No counters were added for the design's instrumentation list** ("rows written, links rewritten, snapshot pages/bytes served, open-snapshot gauge, WAL-pin duration"). The plan states this as a deliberate gap: the benchmark cases answer the performance questions those gauges would be read for, and a gauge with no consumer is speculative surface. `links_rewritten` is on the wire in every rename response, so the one a client actually needs is already observable.
- **`delete_note_commit` measures a permanent delete.** `trash_system` would measure the platform's trash implementation and fill the operator's trash with fixtures; `trash_local` would measure a rename into `.trash/`. Neither is the daemon's own cost, and the difference is a `rename(2)` either way.
- **Single machine, single run per scale**, on an otherwise idle Apple M2 with this session's tooling alongside. No comparison against stock Obsidian is made or implied.
- **The maintainer's real vault was never read, benchmarked, or referenced** while producing this document. `vault-bench --mutations` refuses to run its cases in `--vault` mode for exactly that reason: the mutation cases write, and a benchmark must never write into a vault it did not create.
