# Bases evaluation performance baseline

Baselines for phase 8, Obsidian Bases evaluation inside vaultd. The targets are the six numbers in `docs/design/bases-evaluation.md`, measured on a 10,000-note fixture, warm. Seven further measurements that the earlier tasks' reviews carried here follow them. These are baselines, not contracts: the contract is the test suite. A target that was missed is reported as missed, with the number and the mechanism.

## Environment

- Date: 2026-10-09, all series.
- Machine: MacBook Pro, Apple M2 Max (`Mac14,6`), 12 cores, 96 GiB. Not an idle machine: other sessions ran beside these measurements. Every measured run started behind `fleet-gate` with the 5-minute load average under 4, and the load at each run's start is given beside its numbers. A run whose 5-minute load reached 4 or more is labelled "under load" and is not used for a verdict.
- OS: macOS 26.4.1 (Darwin 25.4.0), arm64. Node v26.10.0.
- Engine: `target/release/vaultd` on branch `feat/bases-evaluation`. The first series (the "before" columns) ran at `621c48d` plus the harness and timing tests of `30a520c`; the fix-round series (the "after" columns) ran on the fix-round commit, which changed the engine in the five places the section "Fix round 1" names. The phase 7 comparison binaries (`vaultd` and `vault-bench`) were built from `main` at `b391820` in a throwaway worktree.

## The six numbers

Each harness series is three daemon runs (`--repeat 3`) of 200 samples (50 for the whole-vault page). Two series were taken before the fix round (`bases-1`, `bases-2`) and two after it (`bases-5`, `bases-6`). The measured p50 is the median of the six runs' p50s; each series' own median of three is given too.

| Requirement | Bound | Before the fix round | After the fix round | Verdict |
| --- | --- | --- | --- | --- |
| A filtered, sorted 100-row table | under 20 ms | 7.559 ms (series 7.600, 7.461) | 6.643 ms (series 6.636, 6.650) | met |
| The unfiltered whole-vault page | under 100 ms | 66.995 ms (series 67.597, 66.358) | 66.764 ms (series 66.919, 66.608) | met |
| A cache hit | under 1 ms | 0.106 ms (series 0.105, 0.106) | 0.105 ms (series 0.107, 0.104) | met |
| A `.base` change reconciled, against a note change | within 5 percent | 10.098 against 10.179 ms, -0.8 percent | 10.109 against 10.211 ms, -1.0 percent | met |
| The per-commit staleness rule, 50 bases | under 1 ms | 0.050 ms (runs 0.051, 0.050) | 0.049 ms (runs 0.048, 0.049) | met |
| Reconciliation of a vault with no base, against phase 7 | within 5 percent | cold build +7.4 to +11.8 percent (missed); one-note `write_note` -1.7 percent | cold build -0.1 to +3.1 percent; 100-note burst +1.6 and +4.0 percent; one-note `write_note` +0.7 percent | met (after the fix round) |

The after series' loads at the start of each run: bases-5 0.49 1.07 1.34, 1.06 1.16 1.37, 1.12 1.17 1.37; bases-6 0.93 1.05 1.25, 1.02 1.06 1.25, 1.09 1.08 1.25. Per run after the fix round (p50 / p95 / min, ms):

| Run | Load at start (1, 5, 15 min) | filtered | whole-vault | cache hit | base change | note change |
| --- | --- | --- | --- | --- | --- | --- |
| bases-5 run 1 | 0.49 1.07 1.34 | 6.596 / 6.946 / 6.490 | 66.554 / 71.082 / 65.791 | 0.110 / 0.143 / 0.102 | 10.144 / 12.192 / 8.620 | 10.216 / 11.824 / 8.676 |
| bases-5 run 2 | 1.06 1.16 1.37 | 6.636 / 7.135 / 6.483 | 66.919 / 68.011 / 65.822 | 0.105 / 0.127 / 0.097 | 10.074 / 11.857 / 8.460 | 10.217 / 11.625 / 8.695 |
| bases-5 run 3 | 1.12 1.17 1.37 | 6.693 / 7.149 / 6.502 | 67.601 / 68.538 / 66.074 | 0.107 / 0.131 / 0.101 | 10.010 / 11.140 / 8.568 | 10.139 / 11.346 / 8.635 |
| bases-6 run 1 | 0.93 1.05 1.25 | 6.650 / 7.031 / 6.545 | 66.608 / 68.204 / 66.071 | 0.104 / 0.127 / 0.093 | 9.960 / 11.506 / 8.481 | 10.078 / 11.379 / 8.594 |
| bases-6 run 2 | 1.02 1.06 1.25 | 6.594 / 6.925 / 6.471 | 66.597 / 68.779 / 65.592 | 0.104 / 0.127 / 0.094 | 10.156 / 11.547 / 8.699 | 10.206 / 11.460 / 8.680 |
| bases-6 run 3 | 1.09 1.08 1.25 | 6.693 / 7.120 / 6.516 | 67.308 / 69.142 / 65.833 | 0.105 / 0.131 / 0.097 | 10.147 / 11.690 / 8.856 | 10.217 / 12.124 / 8.687 |

The filtered page is 0.9 ms faster after the fix round; the property memo (item 5 below) is the one engine change on its path that could account for it, but the before and after series differ in more than that one respect, so the attribution is plausible, not proven.

The no-base `write_note` after the fix round, the harness on the same 10,000-note fixture, alternated:

| Series | `write_note` p50 per run (ms) |
| --- | --- |
| head-3 | 10.133, 10.144, 10.164 |
| main-3 | 10.081, 9.502, 10.084 |
| head-4 | 10.114, 10.068, 10.129 |
| main-4 | 10.039, 10.035, 10.178 |

Medians of six run p50s: 10.131 against 10.060 ms (+0.7 percent).

## Fix round 1 — before and after

Each item below was fixed on the controller's ruling and measured again under the same quiet-machine rule (5-minute load under 4 at every run's start, every run behind `fleet-gate`), at least twice, alternated with phase 7 where a comparison is asked.

### 1. The cold-build miss: `properties` and its scalar columns

Two fixes, tried in the ruled order, `vault-bench` alternated head, main:

| Step | Vault | Head cold build p50 (min) | Phase 7 cold build p50 (min) | Delta at p50 | Loads at the head / main starts |
| --- | --- | --- | --- | --- | --- |
| before | frontmatter | 1596.4 (1588.6), 1606.4 (1578.6) | 1485.9 (1474.6), 1440.2 (1428.7) | +7.4, +11.5 percent | see below |
| before | synthetic | 1557.1 (1542.3), 1561.1 (1549.9) | 1416.2 (1406.5), 1396.4 (1389.3) | +10.0, +11.8 percent | see below |
| a: cold build creates `property_scalars`' indexes after its load; its insert prepared once | frontmatter | 1545.5 (1523.4), 1523.5 (1511.3) | 1440.4 (1419.8), 1423.4 (1411.6) | +7.3, +7.0 percent | 0.75 1.29 1.47 / 0.71 1.17 1.41; 0.88 1.05 1.33 / 1.11 1.10 1.31 |
| a | synthetic | 1492.7 (1466.2), 1493.3 (1480.3) | 1384.3 (1376.2), 1380.5 (1379.5) | +7.8, +8.2 percent | 1.89 1.37 1.39 / 0.93 1.29 1.36; 1.92 1.60 1.48 / 1.11 1.47 1.45 |
| b: the scalar columns folded into `properties` (schema v5), plus a | frontmatter | 1481.9 (1472.5), 1499.1 (1483.1) | 1454.8 (1436.0), 1453.5 (1430.4) | +1.9, +3.1 percent | 1.27 1.52 1.47 / 2.64 2.02 1.68; 1.41 1.79 1.62 / 1.08 1.55 1.55 |
| b | synthetic | 1417.7 (1401.0), 1410.9 (1398.1) | 1418.8 (1389.8), 1399.9 (1379.2) | -0.1, +0.8 percent | 1.07 1.41 1.49 / 0.89 1.32 1.45; 1.09 1.37 1.46 / 0.88 1.24 1.39 |

The cold-build bound is met at the instrument's resolution, not with margin: the delta between the same two binaries on the same vault moved from +0.4 to +5.7 percent between two paired `vault-bench` runs (the no-frontmatter pairs), so +1.9 to +3.1 percent is inside the instrument's run-to-run spread. Step a alone closed a third of the gap (the indexes and the per-row prepare); the rest was the second row per property itself (its own primary-key b-tree and row write). Step b removes the row: `properties` gains `key_fold`, `kind`, `string_value` and `number_value`, and its three secondary indexes (`properties_by_key`, `_by_string`, `_by_number`) are dropped before the cold build's bulk load and created again after it, inside the same transaction. The 100-note burst after step b: 20.5 and 20.1 ms against 20.2 and 19.4 ms (+1.6, +4.0 percent; before: +10 percent). Warm start, one-file refresh, verified refresh and every other `--live` case stay within the run-to-run spread. The schema is version 5; a version 4 (or older) cache is rebuilt, never migrated (`a_genuine_version_four_cache_is_replaced_by_schema_five`). The scalar-mirror oracle now checks that every `properties` row's scalar columns classify its own value; it, the drift oracle and the live oracle stay green.

### 2. `get_note`: `prepare_cached` in the diagnostics union

`note_diagnostics` (and the two other union readers) now use `prepare_cached`. `get_note` p50, before and after, against phase 7:

| Instrument | Before (head / phase 7) | After (head / phase 7) |
| --- | --- | --- |
| harness, six runs each (after: head-3, head-4, main-3, main-4) | 0.121 / 0.108 ms (+12 percent) | 0.0835 / 0.1075 ms (-22 percent) |
| `vault-bench` (after: the eight fold-round runs) | 0.087 / 0.075 ms (+16 percent) | 0.055 to 0.061 / 0.076 to 0.081 ms (-21 to -28 percent) |

The harness after-loads: head-3 1.05 1.16 1.28, main-3 1.11 1.17 1.27, head-4 1.05 1.13 1.24, main-4 2.04 1.34 1.30. `get_note` is now faster than phase 7, which re-prepared its three-branch union on every call too.

### 3. `LiveStateStale` under fast publishes

`evaluate_base` now pins its snapshot first and takes the resolver for exactly that generation: under the same guard it takes the shared resolver if it is built for the pinned generation, waits (with no lock held, bounded by the evaluation's deadline and by the 2 s build patience, and copying nothing) for a build already in flight for it, refusing the attempt as stale if that build never settles, or copies the resolution catalog and builds the resolver after the guard is released, then installs it for that generation unless a newer one is there. The snapshot stays pinned while the resolver builds, so a publication landing meanwhile cannot make the resolver, the base and the rows disagree. A refusal that remains possible (a commit landing between the snapshot and the guard, or a foreign writer) is retried with backoff (1 ms doubling to 32 ms) for up to 2 s before the typed error.

| Measurement | Before | After |
| --- | --- | --- |
| whole-vault evaluations refused under one publish every 7 ms, one evaluating thread (`bases_timing`, 4 phases per run) | 3 to 6 of 9 to 11 per phase (30 to 55 percent), two runs | 0 of 7 or 8 per phase, four runs (timing-3 to timing-6) |
| the same, four evaluating threads | 1 or 2 of 13 to 18 per phase | 0 of 16 to 18 per phase |
| publish p50 with one / four evaluations in flight | 0.48 to 0.52 / 1.34 to 1.46 ms | 0.47 to 0.61 / 1.31 to 1.65 ms |
| publish p95 / max, no reader | 2.16 to 2.59 / 2.53 to 4.70 ms | 1.78 to 2.75 / 2.65 to 4.67 ms |
| publish p95 / max, one evaluation in flight | 0.57 to 1.12 / 1.26 to 1.87 ms | 0.60 to 0.99 / 1.16 to 2.11 ms |
| publish p95 / max, four evaluations in flight | 1.80 to 2.14 / 2.24 to 2.41 ms | 1.58 to 2.95 / 1.88 to 7.14 ms |

`a_whole_vault_evaluation_answers_while_the_writer_publishes_every_seven_ms` (3,000 notes, 10 s, debug build) asserts that every evaluation answers and that each answer's row count is exactly its generation's; it fails on the old shape (resolver first, pin second: mutation exit 101). It runs 10 s, so it is ignored by default. Two deterministic tests pin the rest: `an_evaluations_resolver_belongs_to_the_generation_it_pinned` parks a read after its pin, publishes the note a frontmatter link names, and asserts the parked answer is at the old generation with the link still unresolved (it fails when the evaluation takes the newest resolver: exit 101); `an_evaluation_that_never_holds_still_answers_live_state_stale_within_its_budget` forces every attempt stale and asserts the typed `LiveStateStale` after 1.9 to 3 s (it fails when the retry ignores the budget: exit 101). The worst publish max after, 7.14 ms with four evaluations in flight (timing-4, load 1.01 1.27 1.29 at start), is one sample of 41; the other seven phases with four evaluations stay at or under 4.79 ms. Loads at the four timing runs' starts: 1.11 1.19 1.35, 1.01 1.27 1.29, 2.21 1.65 1.58, 0.89 1.12 1.33.

### 4. The attachment backlinks arm

The row source now builds two maps once per evaluation (one generation): the unresolved references by the ASCII-lowercased last component of their file target, and the tree's files by the same key. An attachment row's backlinks are one lookup of its name, each candidate verified through `attachment()` as before, and `attachment()` itself is one lookup instead of a scan of `tree_entries` per distinct target.

| Step | `Back` (`file.backlinks`) p50 / min | `Plain` p50 | Loads |
| --- | --- | --- | --- |
| before | 3491.2 / 3476.6, 3470.5 / 3460.4 ms | 8.35, 8.24 ms | 1.22 1.94 2.07; 1.49 1.68 1.72 |
| the unresolved-reference map only | 2273.1 / 2237.5, 2243.4 / 2222.5 ms | 8.20, 8.02 ms | 1.11 1.19 1.35; 1.01 1.27 1.29 |
| both maps | 17.5 / 17.5, 18.1 / 17.7 ms | 7.98, 8.23 ms | 2.21 1.65 1.58; 0.89 1.12 1.33 |

The first step showed the per-target `tree_entries` scan (`lower(path)` over every file, about 2.2 ms per distinct target) as the remaining cost. After both, 1,000 attachment rows cost about 10 ms more than the same rows without backlinks (p95 25 ms: the first evaluation builds the maps).

### 5. The wide re-wrap: the depth is stored, and the property read is memoized

Lists and objects now carry their nesting depth (`vault_bases::Nested`, computed once when the value is built), so `ensure_room` and `nests_deeper_than` read one number instead of walking. Measured, that alone changed nothing: the wide re-wrap took 5323 and 5471 ms at 20,000 items after it. The stage split the re-measurement added (`xs.reduce(xs.length, 0)`, which reads `xs` on every step and wraps nothing) took 5382 ms, the same: the mechanism this document first named (`ensure_room` walking the list) was wrong. The cost was the property read itself: every reference to `xs` re-read the note's properties from the row source and converted the 20,000-item YAML sequence into a value again, once per step. `EvalContext` now memoizes each `(file, key)` property read for the evaluation (a list clones in O(1)).

| n | before: wide re-wrap | depth stored only: wide / read every step | depth stored and reads memoized: wide / read every step |
| --- | --- | --- | --- |
| 1,000 | 19.6, 14.7 ms | 20.1 / 14.5 ms | 1.48 / 1.14 ms, 0.53 / 0.45 ms |
| 5,000 | 344.2, 339.9 ms | 333.5 / 331.1 ms | 3.37 / 2.76 ms, 2.39 / 2.12 ms |
| 20,000 | 5436.9, 5348.8 ms | 5316.5 / 5381.5 ms | 11.1 / 9.2 ms, 9.4 / 8.8 ms |

The deep fold is unchanged (0.05 to 0.38 ms, refused at the cap). `reading_or_wrapping_a_wide_property_on_every_step_is_linear` pins both forms at 20,000 items on a 1 MiB stack in a debug build (fails without the memo: mutation exit 101). Loads: depth-split 1.62 1.60 1.45; depth-5 0.73 1.31 1.45; depth-6 1.00 1.08 1.29.

A cache hit is measured over the socket, so it includes one round trip; the same request's round trip with no evaluation at all (`get_note`) is 0.12 ms on this machine.

### Per run (harness, `--base`)

| Run | Load at start (1, 5, 15 min) | filtered p50 / p95 / min | whole-vault p50 / p95 / min | cache hit p50 / p95 / min | base change p50 / p95 / min | note change p50 / p95 / min |
| --- | --- | --- | --- | --- | --- | --- |
| bases-1 run 1 | 1.68 1.91 2.04 | 7.569 / 8.037 / 7.224 | 66.820 / 67.659 / 65.240 | 0.105 / 0.135 / 0.099 | 10.058 / 11.302 / 8.629 | 10.077 / 11.302 / 8.550 |
| bases-1 run 2 | 1.65 1.89 2.03 | 7.600 / 7.797 / 7.207 | 67.597 / 69.415 / 65.757 | 0.103 / 0.124 / 0.097 | 10.111 / 11.630 / 8.816 | 10.256 / 12.001 / 8.706 |
| bases-1 run 3 | 1.75 1.90 2.03 | 7.785 / 8.048 / 7.374 | 68.985 / 70.706 / 67.249 | 0.109 / 0.131 / 0.100 | 10.137 / 12.054 / 8.544 | 10.236 / 11.358 / 8.774 |
| bases-2 run 1 | 0.75 1.12 1.59 | 7.403 / 7.787 / 7.217 | 66.108 / 68.041 / 64.995 | 0.107 / 0.131 / 0.102 | 10.084 / 11.421 / 8.700 | 10.151 / 11.370 / 8.555 |
| bases-2 run 2 | 1.02 1.16 1.60 | 7.461 / 7.671 / 7.237 | 66.358 / 67.991 / 64.895 | 0.106 / 0.130 / 0.102 | 10.166 / 11.514 / 8.873 | 10.206 / 11.673 / 8.694 |
| bases-2 run 3 | 1.09 1.17 1.60 | 7.548 / 7.869 / 7.254 | 67.170 / 68.076 / 65.736 | 0.106 / 0.130 / 0.101 | 10.038 / 11.320 / 8.797 | 10.063 / 11.296 / 8.640 |

The fixture is the harness's synthetic vault with the Bases fields: 10,000 notes `Note-NNNNNN.md`, each with `title` and `rank: i % 100` properties, a `#group-(i % 10)` tag line and a link to its successor, built at `target/tmp/bases-baseline/vault`. The fixture base, `host/fixtures/bases/bench.base`, declares `Filtered` (tag `group-3` and `rank < 50`, 500 rows, sorted by `rank` descending, 100 returned) and `All` (no filter, 10,001 rows with the base itself, 100 returned), each twice under two names. The daemon runs with `--bases-cache-entries 1` and the harness alternates the twins, so every filtered and whole-vault sample is an evaluation, never a hit, while the page cache stays warm. The cache hit asks `Filtered` again and again at one generation. The base change rewrites `bench.base` (alternating a trailing newline) and the note change rewrites one note, alternated so neither runs warmer.

### The staleness rule

`views::tests::the_rule_with_fifty_bases_is_under_a_millisecond` (`crates/vault-server/src/views.rs`, ignored by default): 1,000 notes and 50 bases of two views each (one tag filter, one property filter), 200 one-note commits through `refresh_paths`, each decided by `ViewTracker::stale_views`.

| Run | Load at start | Continuous p50 / p95 / min (n 200) | After a gap p50 / p95 / min (n 100) |
| --- | --- | --- | --- |
| rule-1 | 1.86 2.19 2.16 | 0.051 / 0.063 / 0.043 ms | 0.126 / 0.138 / 0.115 ms |
| rule-2 | 3.57 1.95 1.81 | 0.050 / 0.056 / 0.043 ms | 0.127 / 0.139 / 0.117 ms |

"Continuous" is a dispatcher that saw every generation, so its catalog is patched in place: the steady state the spec bounds. "After a gap" is a second dispatcher that sees every other generation, so each of its decisions reloads the whole catalog with a full `base_dependencies` compile of all 50 bases; it is also under the bound, by a factor of 8.

### The no-base comparison: what was met and what was missed

Two instruments compare this branch with phase 7 (`b391820`) on vaults with no base.

The socket harness without `--base`, on one 10,000-note fixture (`target/tmp/t14/plain/vault`), three runs per series, alternated head, main, head, main:

| Series | Load at start of run 1 | `write_note` p50 per run (ms) | `get_note` p50 per run (ms) |
| --- | --- | --- | --- |
| head-1 | 1.96 1.98 2.05 | 10.138, 9.919, 9.822 | 0.120, 0.121, 0.121 |
| main-1 | 1.03 1.70 1.94 | 10.000, 9.683, 10.084 | 0.111, 0.108, 0.106 |
| head-2 | 0.93 1.49 1.83 | 10.078, 9.696, 9.807 | 0.123, 0.118, 0.121 |
| main-2 | 0.78 1.28 1.71 | 10.082, 9.938, 19.997 | 0.108, 0.099, 0.109 |

A one-note reconciliation through the daemon is unchanged: 9.870 ms against 10.041 ms, the medians of six run p50s (-1.7 percent). main-2's third run, at 19.997 ms, is an outlier of the phase 7 binary, not of this branch; the median does not move with it.

`vault-bench` (the index alone, no daemon), 5 repeats per run, alternated:

| Run | Vault | Load at start | cold build p50 / min | warm start p50 | one-file refresh p50 | verified refresh p50 | `get_note` p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| head-3 | synthetic, `--live` | 1.10 3.96 3.56 | 1557.1 / 1542.3 | 26.3 | 26.3 | 318.0 | 0.087 |
| main-3 | synthetic, `--live` | 1.85 3.93 3.55 | 1416.2 / 1406.5 | 27.9 | 26.6 | 327.8 | 0.075 |
| head-4 | synthetic, `--live` | 1.81 3.34 3.36 | 1561.1 / 1549.9 | 28.3 | 27.1 | 329.5 | 0.087 |
| main-4 | synthetic, `--live` | 0.82 2.60 3.07 | 1396.4 / 1389.3 | 26.7 | 27.0 | 318.9 | 0.075 |
| head-props-1 | 10,000 notes with frontmatter | 0.93 2.14 2.84 | 1596.4 / 1588.6 | 25.3 | — | 364.9 | 0.102 |
| main-props-1 | the same | 1.63 2.06 2.72 | 1485.9 / 1474.6 | 24.9 | — | 377.0 | 0.089 |
| head-noprops-1 | the same notes, no frontmatter | 1.03 1.76 2.53 | 1355.8 / 1313.3 | 23.9 | — | 360.1 | 0.089 |
| main-noprops-1 | the same | 1.81 1.86 2.48 | 1282.8 / 1276.8 | 23.2 | — | 363.1 | 0.071 |
| head-props-2 | with frontmatter | 1.55 1.86 2.42 | 1606.4 / 1578.6 | 25.2 | — | 370.6 | 0.088 |
| main-props-2 | the same | 1.04 1.62 2.26 | 1440.2 / 1428.7 | 25.1 | — | 364.6 | 0.076 |
| head-noprops-2 | no frontmatter | 0.99 1.48 2.13 | 1296.2 / 1286.2 | 23.2 | — | 374.9 | 0.087 |
| main-noprops-2 | the same | 1.17 1.37 2.01 | 1290.9 / 1276.2 | 23.2 | — | 364.7 | 0.073 |

An earlier pair (head-1, main-1, head-2, main-2, the synthetic vault) ran while the 5-minute load rose to 6.9; it is under load and not used here.

Warm start, one-file refresh, verified refresh and every `--live` case but one (body edit, reference edit, heading fan-out at 0 to the maximum, resolution transitions, deletes, rename, the complete fallback after an overflow, hydration) are within the run-to-run spread. Two are not:

**Before the fix round, missed: the cold build was 7.5 to 11.5 percent slower** (fixed: "Fix round 1", item 1) (synthetic: +10.0 and +11.8 percent at p50; frontmatter vault: +7.4 and +11.5 percent), and the 100-note burst is about 10 percent slower (22.0 and 22.5 ms against 20.3 and 20.2 ms). The mechanism is the `property_scalars` table, new in schema v4 for the Bases prefilters: one row per frontmatter property, written beside `properties` and maintained in three indexes (`property_scalars_by_key`, `_by_string`, `_by_number`). The evidence is the pair of vaults that differ in exactly one respect: the same 10,000 notes without frontmatter build within noise of phase 7 (p50 +5.7 and +0.4 percent, min +2.9 and +0.8 percent), and the same notes with frontmatter build 7.4 to 11.5 percent slower. The two value indexes alone are a small part of it (carry 7 below: a cold build with them dropped is 0.7 percent faster). What would close it: populate `property_scalars` on the cold route with one `INSERT … SELECT` from `properties` after the bulk load and create its indexes after the rows are in, rather than per row through three live indexes; or derive the scalar columns into `properties` itself so no second table is written. Neither is measured here.

**Before the fix round, outside the bound: `get_note` was 12 to 17 µs slower** (fixed: item 2) (harness 0.121 against 0.108 ms; `vault-bench` 0.087 against 0.075 ms, with and without frontmatter). The mechanism: `get_note` reads its note's diagnostics through `diagnostics::note_diagnostics`, which prepares the diagnostic union statement fresh on every call (`connection.prepare`, not `prepare_cached`), and Task 10 added a fourth branch to that union (`bases` joined with `json_each(diagnostics_json)`). Timed alone on a head index (`target/tmp/t14/diag_prepare.py`, Python's `sqlite3` with its statement cache off, 2,000 calls, two rounds): three branches 20.2 to 20.5 µs, four branches 30.3 to 31.4 µs, about +10 µs per call, which is most of the difference. What would close it: `prepare_cached` in `note_diagnostics` (and in the other two union readers), or filter the base branch by path before `json_each`.

## The carried measurements

### 1. A publication while evaluations run (Task 11 H1)

`publications_while_evaluations_and_resolving_reads_run` (`crates/vault-index/tests/bases_timing.rs`), release, the 10,000-note Bases fixture plus `All.base` (a whole-vault view, 10,001 rows). One whole-vault `evaluate_base` alone, index side: p50 57.5 and 55.3 ms over the two runs. Then 41 one-note publishes (`refresh_paths`, after 5 warm-up) per phase, 7 ms apart, with the load running on other threads the whole time; phases interleaved, twice per run, two runs:

| Load | publish p50 (ms), four phases | p95 range | max range | evaluations done / failed per phase |
| --- | --- | --- | --- | --- |
| alone | 1.226, 1.533, 1.514, 1.321 | 2.157 to 2.593 | 2.525 to 4.701 | — |
| one whole-vault evaluation in flight | 0.516, 0.490, 0.495, 0.484 | 0.574 to 1.115 | 1.255 to 1.870 | 5 to 7 / 3 to 6 |
| four in flight | 1.342, 1.440, 1.424, 1.463 | 1.802 to 2.135 | 2.242 to 2.408 | 12 to 16 / 1 to 2 |

Loads at the two runs' starts: 1.22 1.94 2.07 and 1.49 1.68 1.72. Before the H1 fix a publish took about 355 ms while one evaluation ran; now no publish in any phase took more than 4.7 ms, and the slowest were in the phase with no reader at all. The alone phase's higher p50 is not contention: with no busy thread the cores idle between the 7 ms-spaced edits and each publish runs on a cooling core; one busy reader thread keeps the clocks up. Four evaluations add about 0.9 ms at p50 against one (four threads of SQLite reads beside the writer).

A finding the measurement surfaced (fixed: "Fix round 1", item 3): under publishes 7 ms apart, 30 to 55 percent of whole-vault evaluations fail when one thread evaluates (6 to 14 percent when four do), each answering `LiveStateStale("the resolver is at N but the publication is at N+1")`. `evaluate_base` builds (or takes) the resolver for generation N, then takes the guard to pin the read; when a publication lands in between it retries, three times, and a resolver build plus a 56 ms evaluation cannot win three races against a writer publishing every 7 ms. The daemon answers such a request with an error rather than a stale or mixed answer, which is correct, but a client of a vault that changes 100 times a second cannot evaluate a whole-vault view. Not a spec bound; a concern for Task 16 (more attempts, or evaluate against the resolver's own generation when its snapshot is still pinnable).

### 2. The resolver: phase C and the catalog copy (Task 12 H3)

`resolver_publish_latency` (unchanged from Task 12, release), two runs (loads 0.93 1.12 1.54 and 0.48 1.05 1.43):

| Phase | Run 1 median / p95 (ms) | Run 2 median / p95 (ms) |
| --- | --- | --- |
| A, no resolving client | 0.438 / 0.562 | 0.392 / 0.466 |
| B, a client resolved once | 0.402 / 0.493 | 0.395 / 0.426 |
| A2, no resolving client | 0.436 / 0.538 | 0.443 / 0.514 |
| C, a client resolving after every publication | 0.541 / 0.608 | 0.534 / 0.612 |

B against the larger of A and A2: -8.2 and -10.9 percent. Phase C is +0.09 to +0.10 ms against the larger of A and A2 (+21 to +24 percent; +46 percent in the Task 12 fix round's run) and its cause stays unproven by a profile: the writer does no resolver work, so it is the effect of an 8 ms resolver build (first resolving read: 8.7 and 7.9 ms) between publications on the caches and allocator the next publication runs on. It is not a wait: the phase is sequential, so no read is in flight during a publish.

Does a writer wait on a reader's catalog copy under the read guard? The `Resolving` phase of carry 1 answers it under contention: one thread calls `resolve_link` in a loop (450,000 to 476,000 calls per phase), so every new generation's first resolving read copies the resolution catalog under the guard while the next publication may be arriving. Publish p50 0.497, 0.491, 0.492, 0.482 ms, p95 0.544 to 0.643 ms, max 1.649 to 1.811 ms, against the alone phase's max of 2.5 to 4.7 ms. A wait for a whole 10,000-note catalog copy would show in the max; none does. So the copy is short enough that a writer meeting it is not visible at this resolution.

### 3. The staleness rule with 50 bases

See "The staleness rule" above: continuous 0.050 ms, after a gap (a full `base_dependencies` compile) 0.127 ms, both under the 1 ms bound.

### 4. The attachment backlinks arm (Task 13 M5)

`attachment_backlinks_over_ten_thousand_notes`: 10,000 notes, each embedding one of 1,000 attachments (`img-NNNN.png`, 10 notes each), and a base with two views over the attachments (`file.ext == "png"`, 1,000 rows): `Back` reads `file.backlinks.length` in a formula, `Plain` reads `file.size` instead. Five evaluations each, interleaved, two runs (loads 1.22 1.94 2.07 and 1.49 1.68 1.72):

| View | Run 1 p50 / p95 / min (ms) | Run 2 p50 / p95 / min (ms) |
| --- | --- | --- |
| Back (`file.backlinks`) | 3491.2 / 3517.6 / 3476.6 | 3470.5 / 3487.9 / 3460.4 |
| Plain | 8.354 / 8.560 / 8.247 | 8.240 / 8.340 / 8.084 |

Before the fix round (item 4 has the after numbers): the answer is right (the first row's cell is 10) and costs 3.5 ms per attachment row, 420 times the plain view. Mechanism, from the code: for an attachment, `IndexRowSource::backlinks` runs `SELECT … FROM resolutions JOIN note_references WHERE s.kind = 'unresolved' AND instr(lower(r.raw_target), lower(?1)) > 0` once per row, a full scan of every unresolved reference (10,000 here) with two `lower` calls per reference, and then resolves each candidate through `attachment()`. With A attachments and U unresolved references the view costs A × U. What would close it: compute the attachment backlinks once per evaluation (one pass over the unresolved references, each resolved through `attachment()` once, into a map from attachment to notes), or store the attachment a reference resolves to at index time, so the per-row lookup is the indexed `target_path` probe notes already use.

### 5. Deep `reduce` and the wide re-wrap (Task 7 fix 2)

`time_deep_reduce_and_wide_rewrap` (`crates/vault-bases/tests/value_depth.rs`), release, one note whose `xs` holds n zeros, three evaluations each (median, min), two runs (loads 1.42 1.84 2.08 and 1.02 1.57 1.68):

| n | deep `xs.reduce([acc], [])` run 1 / run 2 | wide `xs.reduce([xs], []).length` run 1 / run 2 |
| --- | --- | --- |
| 1,000 | 0.137 / 0.054 ms | 19.6 / 14.7 ms |
| 5,000 | 0.121 / 0.124 ms | 344.2 / 339.9 ms |
| 20,000 | 0.278 / 0.265 ms | 5436.9 / 5348.8 ms |

Before the fix round (item 5 has the after numbers and corrects the mechanism below): the deep fold answers `ValueTooDeep` at the cap in a fraction of a millisecond at every size. The wide re-wrap is quadratic, as the Task 7 re-review predicted: 4 times the items cost 16 times the time (340 ms to 5.4 s). Mechanism: `built_list` calls `ensure_room` on every item it wraps, and `ensure_room` calls `nests_deeper_than(MAX_VALUE_DEPTH - 1)`, which visits every element of a flat list until it finds one deep enough; a 20,000-item list is walked whole on each of 20,000 steps. A formula like this over a 20,000-item property holds one evaluation for 5 seconds. What would close it: cache each value's depth when it is built (lists and objects carry their nesting depth), so `ensure_room` is one comparison.

### 6. The R2 total-order sort (Task 13 fix round)

`time_one_boolean_in_a_text_column` (`crates/vault-bases/tests/ordering_properties.rs`), release, 10,000 rows of reversed text sorted by one key, with and without one `false`, five evaluations each, interleaved, two runs (loads 1.15 1.62 1.96 and 0.67 1.29 1.55):

| View | Run 1 p50 / max / min (ms) | Run 2 p50 / max / min (ms) |
| --- | --- | --- |
| plain text | 16.240 / 27.460 / 14.968 | 15.237 / 16.271 / 14.984 |
| one `false` | 16.833 / 22.863 / 16.290 | 16.262 / 16.658 / 16.011 |

One boolean costs 0.6 to 1.0 ms (+4 to +7 percent) on a 10,000-row sort; the quadratic insertion sort it replaced took 11.6 s.

### 7. The two value indexes on `property_scalars` (Task 11 M1)

`the_value_indexes_cost_on_reconciliation`: the 10,000-note Bases fixture, a cold build and 41 one-note edits (after 5 warm-up) with `property_scalars_by_string` and `property_scalars_by_number` present, and with both dropped before the build; interleaved, twice per run, two runs:

| Indexes | Cold build (ms), four builds | Edit p50 (ms), four phases | Edit min range |
| --- | --- | --- | --- |
| present | 1597.7, 1481.4, 1495.5, 1472.5 | 0.370, 0.375, 0.378, 0.367 | 0.330 to 0.355 |
| dropped | 1466.6, 1489.0, 1511.4, 1455.6 | 0.336, 0.371, 0.342, 0.349 | 0.306 to 0.328 |
| after the fix round, present (`properties_by_*`) | 1367.5, 1334.0, 1361.2, 1338.6 | 0.357, 0.309, 0.334, 0.316 | 0.292 to 0.324 |
| after the fix round, dropped after the cold build | 1368.8, 1302.5, 1366.2, 1311.4 | 0.353, 0.294, 0.294, 0.294 | 0.275 to 0.282 |

Medians before: cold build 1488.5 against 1477.8 ms (+0.7 percent, inside the spread); one-note edit 0.373 against 0.346 ms (+0.027 ms, +8 percent of a publish whose daemon round trip is 10 ms). After the fix round the cold build creates every index after its load, so the indexes are dropped after it and only the edit compares: 0.325 against 0.294 ms (+0.031 ms), loads 2.21 1.65 1.58 and 0.89 1.12 1.33. The indexes earn their place: Task 11's `the_value_indexes_serve_the_property_prefilter` pins that the prefilter's equal-value probes use them.

## Commands

```bash
cargo build --release --bin vaultd
npm --prefix host run build
npm --prefix host run lint

# The six numbers: two series of three runs each.
node host/scripts/socket-transport-baseline.js --base host/fixtures/bases/bench.base \
  --notes 10000 --samples 200 --repeat 3 --label bases-1 --out target/tmp/t14/bases-1.json
node host/scripts/socket-transport-baseline.js --base host/fixtures/bases/bench.base \
  --notes 10000 --samples 200 --repeat 3 --label bases-2 --out target/tmp/t14/bases-2.json
TMPDIR="$PWD/target/tmp" cargo test --release -p vault-server --lib \
  views::tests::the_rule_with_fifty_bases_is_under_a_millisecond -- --ignored --nocapture

# Phase 7's binaries, from a throwaway worktree.
git worktree add --detach target/tmp/t14-main b391820
cargo build --release --bin vaultd --bin vault-bench \
  --manifest-path target/tmp/t14-main/Cargo.toml --target-dir target/tmp/t14-main-target

# No base, alternated head, main, head, main.
node host/scripts/socket-transport-baseline.js --vault target/tmp/t14/plain/vault \
  --index target/tmp/t14/plain/head.sqlite3 --notes 10000 --samples 200 --repeat 3 \
  --label head-1 --out target/tmp/t14/head-1.json
node host/scripts/socket-transport-baseline.js --vault target/tmp/t14/plain/vault \
  --index target/tmp/t14/plain/main.sqlite3 --notes 10000 --samples 200 --repeat 3 \
  --label main-1 --binary target/tmp/t14-main-target/release/vaultd --out target/tmp/t14/main-1.json
target/release/vault-bench --notes 10000 --repeats 5 --live
target/tmp/t14-main-target/release/vault-bench --notes 10000 --repeats 5 --live
target/release/vault-bench --vault target/tmp/t14/vprops --repeats 5
target/release/vault-bench --vault target/tmp/t14/vnoprops --repeats 5
git worktree remove --force target/tmp/t14-main

# The carried measurements.
TMPDIR="$PWD/target/tmp" cargo test --release -p vault-index --test bases_timing \
  -- --ignored --nocapture --test-threads 1
TMPDIR="$PWD/target/tmp" cargo test --release -p vault-index --test resolver_publish_latency \
  -- --ignored --nocapture
TMPDIR="$PWD/target/tmp" cargo test --release -p vault-bases --test value_depth \
  time_deep_reduce_and_wide_rewrap -- --ignored --nocapture
TMPDIR="$PWD/target/tmp" cargo test --release -p vault-bases --test ordering_properties \
  time_one_boolean_in_a_text_column -- --ignored --nocapture

# Fix round 1: the same commands, plus the frontmatter pair alternated with phase 7.
target/release/vault-bench --vault target/tmp/t14/vprops --repeats 5
target/tmp/t14-main-target/release/vault-bench --vault target/tmp/t14/vprops --repeats 5
```

`target/tmp/t14/vprops` and `vnoprops` are the `vault-bench` synthetic note shape (`title`, a `tags` list, a heading, two links) at 10,000 notes, with and without the frontmatter block; every other byte is the same. Each command ran behind `fleet-gate` with `CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=4` and `-j 4`, one at a time.
