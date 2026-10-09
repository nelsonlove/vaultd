# Bases evaluation performance baseline

Baselines for phase 8, Obsidian Bases evaluation inside vaultd. The targets are the six numbers in `docs/design/bases-evaluation.md`, measured on a 10,000-note fixture, warm. Seven further measurements that the earlier tasks' reviews carried here follow them. These are baselines, not contracts: the contract is the test suite. A target that was missed is reported as missed, with the number and the mechanism.

## Environment

- Date: 2026-10-09, all series.
- Machine: MacBook Pro, Apple M2 Max (`Mac14,6`), 12 cores, 96 GiB. Not an idle machine: other sessions ran beside these measurements. Every measured run started behind `fleet-gate` with the 5-minute load average under 4, and the load at each run's start is given beside its numbers. A run whose 5-minute load reached 4 or more is labelled "under load" and is not used for a verdict.
- OS: macOS 26.4.1 (Darwin 25.4.0), arm64. Node v26.10.0.
- Engine: `target/release/vaultd` at `621c48d` plus this commit's test and harness changes (no engine code changed), branch `feat/bases-evaluation`. The phase 7 comparison binaries (`vaultd` and `vault-bench`) were built from `main` at `b391820` in a throwaway worktree.

## The six numbers

Each harness series is three daemon runs (`--repeat 3`) of 200 samples (50 for the whole-vault page). Two series were taken, `bases-1` and `bases-2`. The measured p50 is the median of the six runs' p50s; each series' own median of three is given too.

| Requirement | Bound | Measured p50 | Verdict |
| --- | --- | --- | --- |
| A filtered, sorted 100-row table | under 20 ms | 7.559 ms (series 7.600, 7.461) | met |
| The unfiltered whole-vault page | under 100 ms | 66.995 ms (series 67.597, 66.358) | met |
| A cache hit | under 1 ms | 0.106 ms (series 0.105, 0.106) | met |
| A `.base` change reconciled, against a note change | within 5 percent | 10.098 ms against 10.179 ms, -0.8 percent (series -1.2, -0.7) | met |
| The per-commit staleness rule, 50 bases | under 1 ms | 0.050 ms (runs 0.051, 0.050) | met |
| Reconciliation of a vault with no base, against phase 7 | within 5 percent | one-note `write_note` 9.870 ms against 10.041 ms (-1.7 percent); cold build +7.5 to +11.5 percent | missed (the cold build) |

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

**Missed: the cold build is 7.5 to 11.5 percent slower** (synthetic: +10.0 and +11.8 percent at p50; frontmatter vault: +7.4 and +11.5 percent), and the 100-note burst is about 10 percent slower (22.0 and 22.5 ms against 20.3 and 20.2 ms). The mechanism is the `property_scalars` table, new in schema v4 for the Bases prefilters: one row per frontmatter property, written beside `properties` and maintained in three indexes (`property_scalars_by_key`, `_by_string`, `_by_number`). The evidence is the pair of vaults that differ in exactly one respect: the same 10,000 notes without frontmatter build within noise of phase 7 (p50 +5.7 and +0.4 percent, min +2.9 and +0.8 percent), and the same notes with frontmatter build 7.4 to 11.5 percent slower. The two value indexes alone are a small part of it (carry 7 below: a cold build with them dropped is 0.7 percent faster). What would close it: populate `property_scalars` on the cold route with one `INSERT … SELECT` from `properties` after the bulk load and create its indexes after the rows are in, rather than per row through three live indexes; or derive the scalar columns into `properties` itself so no second table is written. Neither is measured here.

**Outside the bound, but measured: `get_note` is 12 to 17 µs slower** (harness 0.121 against 0.108 ms; `vault-bench` 0.087 against 0.075 ms, with and without frontmatter). The mechanism: `get_note` reads its note's diagnostics through `diagnostics::note_diagnostics`, which prepares the diagnostic union statement fresh on every call (`connection.prepare`, not `prepare_cached`), and Task 10 added a fourth branch to that union (`bases` joined with `json_each(diagnostics_json)`). Timed alone on a head index (`target/tmp/t14/diag_prepare.py`, Python's `sqlite3` with its statement cache off, 2,000 calls, two rounds): three branches 20.2 to 20.5 µs, four branches 30.3 to 31.4 µs, about +10 µs per call, which is most of the difference. What would close it: `prepare_cached` in `note_diagnostics` (and in the other two union readers), or filter the base branch by path before `json_each`.

## The carried measurements

### 1. A publication while evaluations run (Task 11 H1)

`publications_while_evaluations_and_resolving_reads_run` (`crates/vault-index/tests/bases_timing.rs`), release, the 10,000-note Bases fixture plus `All.base` (a whole-vault view, 10,001 rows). One whole-vault `evaluate_base` alone, index side: p50 57.5 and 55.3 ms over the two runs. Then 41 one-note publishes (`refresh_paths`, after 5 warm-up) per phase, 7 ms apart, with the load running on other threads the whole time; phases interleaved, twice per run, two runs:

| Load | publish p50 (ms), four phases | p95 range | max range | evaluations done / failed per phase |
| --- | --- | --- | --- | --- |
| alone | 1.226, 1.533, 1.514, 1.321 | 2.157 to 2.593 | 2.525 to 4.701 | — |
| one whole-vault evaluation in flight | 0.516, 0.490, 0.495, 0.484 | 0.574 to 1.115 | 1.255 to 1.870 | 5 to 7 / 3 to 6 |
| four in flight | 1.342, 1.440, 1.424, 1.463 | 1.802 to 2.135 | 2.242 to 2.408 | 12 to 16 / 1 to 2 |

Loads at the two runs' starts: 1.22 1.94 2.07 and 1.49 1.68 1.72. Before the H1 fix a publish took about 355 ms while one evaluation ran; now no publish in any phase took more than 4.7 ms, and the slowest were in the phase with no reader at all. The alone phase's higher p50 is not contention: with no busy thread the cores idle between the 7 ms-spaced edits and each publish runs on a cooling core; one busy reader thread keeps the clocks up. Four evaluations add about 0.9 ms at p50 against one (four threads of SQLite reads beside the writer).

A finding the measurement surfaced: under publishes 7 ms apart, 30 to 55 percent of whole-vault evaluations fail when one thread evaluates (6 to 14 percent when four do), each answering `LiveStateStale("the resolver is at N but the publication is at N+1")`. `evaluate_base` builds (or takes) the resolver for generation N, then takes the guard to pin the read; when a publication lands in between it retries, three times, and a resolver build plus a 56 ms evaluation cannot win three races against a writer publishing every 7 ms. The daemon answers such a request with an error rather than a stale or mixed answer, which is correct, but a client of a vault that changes 100 times a second cannot evaluate a whole-vault view. Not a spec bound; a concern for Task 16 (more attempts, or evaluate against the resolver's own generation when its snapshot is still pinnable).

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

The answer is right (the first row's cell is 10) and costs 3.5 ms per attachment row, 420 times the plain view. Mechanism, from the code: for an attachment, `IndexRowSource::backlinks` runs `SELECT … FROM resolutions JOIN note_references WHERE s.kind = 'unresolved' AND instr(lower(r.raw_target), lower(?1)) > 0` once per row, a full scan of every unresolved reference (10,000 here) with two `lower` calls per reference, and then resolves each candidate through `attachment()`. With A attachments and U unresolved references the view costs A × U. What would close it: compute the attachment backlinks once per evaluation (one pass over the unresolved references, each resolved through `attachment()` once, into a map from attachment to notes), or store the attachment a reference resolves to at index time, so the per-row lookup is the indexed `target_path` probe notes already use.

### 5. Deep `reduce` and the wide re-wrap (Task 7 fix 2)

`time_deep_reduce_and_wide_rewrap` (`crates/vault-bases/tests/value_depth.rs`), release, one note whose `xs` holds n zeros, three evaluations each (median, min), two runs (loads 1.42 1.84 2.08 and 1.02 1.57 1.68):

| n | deep `xs.reduce([acc], [])` run 1 / run 2 | wide `xs.reduce([xs], []).length` run 1 / run 2 |
| --- | --- | --- |
| 1,000 | 0.137 / 0.054 ms | 19.6 / 14.7 ms |
| 5,000 | 0.121 / 0.124 ms | 344.2 / 339.9 ms |
| 20,000 | 0.278 / 0.265 ms | 5436.9 / 5348.8 ms |

The deep fold answers `ValueTooDeep` at the cap in a fraction of a millisecond at every size. The wide re-wrap is quadratic, as the Task 7 re-review predicted: 4 times the items cost 16 times the time (340 ms to 5.4 s). Mechanism: `built_list` calls `ensure_room` on every item it wraps, and `ensure_room` calls `nests_deeper_than(MAX_VALUE_DEPTH - 1)`, which visits every element of a flat list until it finds one deep enough; a 20,000-item list is walked whole on each of 20,000 steps. A formula like this over a 20,000-item property holds one evaluation for 5 seconds. What would close it: cache each value's depth when it is built (lists and objects carry their nesting depth), so `ensure_room` is one comparison.

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

Medians: cold build 1488.5 against 1477.8 ms (+0.7 percent, inside the spread); one-note edit 0.373 against 0.346 ms (+0.027 ms, +8 percent of a publish whose daemon round trip is 10 ms). The indexes earn their place: Task 11's `the_value_indexes_serve_the_property_prefilter` pins that the prefilter's equal-value probes use them.

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
```

`target/tmp/t14/vprops` and `vnoprops` are the `vault-bench` synthetic note shape (`title`, a `tags` list, a heading, two links) at 10,000 notes, with and without the frontmatter block; every other byte is the same. Each command ran behind `fleet-gate` with `CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=4` and `-j 4`, one at a time.
