# Search performance baseline

Baselines for the search MVP (`docs/plans/search-implementation.md`, Task 9). The targets are the six numbers in the **Performance requirements** of `docs/design/search.md`, measured on the 10,000-note synthetic fixture, warm, unless stated. Four questions that the earlier tasks' reviews carried here follow them, and then the follow-ups those measurements point at. These are baselines, not contracts: the contract is the test suite. A target that was missed is reported as missed, with the number and the mechanism.

**Every number here was taken on a loaded machine.** The house rule of the earlier baselines (every run started with the 5-minute load under 4) could not be kept: other work ran beside these measurements, and the 5-minute load stayed between 15 and 32 for the harness series. The maintainer ruled to measure anyway, behind a load gate, with the load beside every number and every series repeated to show the spread. The numbers are therefore upper bounds of what a quiet machine gives, and a verdict near a bound is weaker than the same verdict in `bases-evaluation-baseline.md`.

## Environment

- Date: 2026-10-18, all series.
- Machine: MacBook Pro, Apple M2 Max (`Mac14,6`), 12 cores, 96 GiB, under other load (see above). Every run started behind a load gate; the load at each run's start (1, 5, 15 minutes) is given beside its numbers.
- OS: macOS 26.4.1 (Darwin 25.4.0), arm64. Node v26.11.1.
- Re-measure of `meeting group` and `tag:#group-3` (rows 1 and 3 of the table, and **Re-measured on the fixed build** under number 3): `vaultd` built in release at `5dfd0c3`, which holds follow-ups 1 and 2 (`6d58a5b`, `05b1294`, `5dfd0c3`). One series of three runs on the synthetic fixture, 5-minute load 18.5 to 19.1.
- Engine: `vaultd`, `vault-bench` and the `search_timing` test built in release on branch `feat/search` at `17ebb07` (the engine; the harness and the timing test are `91cc175`, which changes neither). The write-path comparison binaries (number 5) were built from `main` at `f470184` (GitHub main, which carries the vendored markdown fix) in a throwaway worktree; the head binaries for that comparison were built at `e18e353`.

## The fixtures

- **Synthetic** (`target/tmp/search-baseline/n10000-p0/vault`): the harness's Bases fixture, 10,000 notes `Note-NNNNNN.md`, each with `title` and `rank: i % 100` properties, a heading, a `#group-(i % 10)` tag line and a link to its successor, plus the line `meeting notes` on every tenth note (`i % 10 === 0`). On it `meeting group` answers 1,000 files (every note holds `group` in its tag line; only the tenth notes hold `meeting`), `tag:#group-3` answers 1,000, `file:Note-0001` answers 100. Every series printed the `total_files` of its first answer, and every count was as designed.
- **Prose** (`n10000-p3000`): the same notes plus about 3,000 bytes each of seeded word salad (`--prose-bytes 3000`), in paragraphs of about 400 bytes, from a word list holding neither `meeting`, `group` nor `note`, so the counts do not move. About 31 MB of text.
- **100,000 notes** (`n100000-p0`): the synthetic shape at 100,000 notes; `meeting group` answers 10,000.

## The six numbers

Each harness series is three daemon runs (`--repeat 3`) of 200 samples (50 at 100,000 notes). Two series were taken on the synthetic fixture (`s1`, `s2`) and two on the prose fixture (`p1`, `p2`), alternated s1, p1, s2, p2. The measured p50 is the median of the six runs' p50s; each series' own median of three is given too. The uncached series runs the daemon with `--search-cache-entries 1` and alternates each query with a twin (the query with the case of its last ASCII letter in a plain word flipped, never one in an operator name: `meeting grouP`, `tag:#grouP-3`, `file:NotE-0001`), which is a different cache key with the same answer and the same work under `match_case: false`; the harness refuses a run whose twin answers a different `total_files`. So every uncached sample is a computation, never a hit. All requests ask a first page of 100 files.

| Requirement | Bound | Measured p50 | Verdict |
| --- | --- | --- | --- |
| 1. `meeting group`, first page, uncached | under 50 ms | 10.311 ms (series 10.310, 10.364); at `5dfd0c3`: 8.968 ms | met |
| 2. a cached page, `context: none` | under 1 ms | 0.238 ms (series 0.241, 0.235) | met |
| 2, reported beside it: a cached page, `context: line` | no bound | 0.393 ms (series 0.390, 0.395) | — |
| 3. `tag:#group-3`, uncached | under 10 ms | 11.291 ms (series 11.192, 11.390); at `5dfd0c3`: 7.727 ms | missed at `17ebb07`; **met** at `5dfd0c3` (see below) |
| 3. `file:Note-0001`, uncached | under 10 ms | 5.111 ms (series 5.084, 5.138) | met |
| 4. a publication during a whole-vault search | under 2 ms | p50 0.597 to 0.671 ms, max 1.287 to 1.881 ms | met |
| 5. reconciliation against `main` at `f470184` | within 5 percent | `write_note` p50 -0.13 percent (10.15 against 10.22 ms) and p95 -0.47 percent; 100-note burst p50 +1.5 percent (median of four pairs); cold build p50 -5.7 percent (head faster) | met (see below) |
| 6. prose fixture, `meeting group`, uncached | observational | 45.785 ms (series 45.590, 46.709) | — |
| 6. 100,000 notes, `meeting group`, uncached | observational; over 500 ms triggers the trigram decision | 105.169 ms (runs 105.169, 105.359, 104.539) | under 500 ms: no trigger |

**Number 6, the trigram follow-on.** The 100,000-note p50 is 105 ms, a fifth of the 500 ms trigger, so this baseline does not bring the FTS5 trigram follow-on to the owner. The scan is linear: ten times the notes cost 10.2 times the time (10.3 against 105.2 ms). The prose fixture shows that text volume, not file count, sets the cost: 31 MB of text costs 45.8 ms at 10,000 notes, about 1.5 ms per MB, so a 100,000-note vault of 3 KB notes would cost about 450 ms by the same rate. That is a guess from two points, not a measurement; it sits just under the trigger, and the double fold (follow-up 1) is most of it.

The cached pages of the other queries: `tag:#group-3` 0.194 ms with `context: none` and 0.323 ms with `context: line`; `file:Note-0001` 0.110 and 0.206 ms; the prose `meeting group` 0.252 and 0.655 ms; the 100,000-note `meeting group` 0.243 and 0.404 ms. A cached page is about one socket round trip (`get_note` 0.105 to 0.124 ms in the same runs) plus the page's conversion.

### Number 3: the `tag:` miss

`tag:#group-3` misses its bound by 1.3 ms (11.3 against 10 ms). Every one of its six run p50s is over 10 ms (11.011 to 31.258; the 31.258 run is the one whose 1-minute load rose to 40 mid-run), and so is the index side alone with no socket (10.804, 10.201 ms in the timing runs, below). The machine was loaded, so a quiet machine may be under the bound; this document cannot say.

The mechanism, from the index-side split (the `search_costs_by_shape` table, below): `file:Note-0001` costs 4.6 ms on the index side, and that is the floor every query pays: `file_rows` reads and decodes all 10,000 tree rows, the prefilter runs over each, and the sort builds a map of every row's times. `tag:#group-3` adds 6 ms to that floor, in three parts:

- `tag_rows` reads all 10,000 tag rows into a `HashMap<String, Vec<TagFact>>`, allocating a path and a value string per row, although the query reads one tag;
- `tag_matches` folds every tag value with `fold_js` (one allocation per tag per term), although `tags.comparison_key` stores the same fold already;
- the query needs text (a tag match's position is a `Loc`, read from the note's text), so the 1,000 surviving notes' bodies are read one by one: about 1.4 ms (the 10 percent row of the body-read table).

What closes it: filter `tag_rows` in SQL by `comparison_key` for a positive `tag:` conjunct (the prefilter already proves it is a superset), and match on the stored fold. Both landed after these measurements (follow-up 2: the stored fold and a cheaper `tag_rows` in `05b1294`, the SQL filter in `5dfd0c3`), and the fixed build is measured below.

#### Re-measured on the fixed build

`vaultd` at `5dfd0c3` (follow-ups 1 and 2 complete), one series of three daemon runs of 200 samples on the synthetic fixture, the same harness and twins as above. p50 / p95 / min, ms:

| Run | Load at start (1, 5, 15 min) | `meeting group` uncached | cached | line | `tag:#group-3` uncached | cached | line |
| --- | --- | --- | --- | --- | --- | --- | --- |
| r1 run 1 | 22.79 19.07 15.91 | 8.883 / 9.399 / 8.332 | 0.217 / 0.249 / 0.204 | 0.357 / 0.416 / 0.337 | 7.727 / 8.238 / 7.110 | 0.160 / 0.189 / 0.138 | 0.292 / 0.338 / 0.252 |
| r1 run 2 | 20.51 18.70 15.82 | 8.968 / 9.346 / 8.396 | 0.221 / 0.250 / 0.200 | 0.385 / 0.428 / 0.337 | 7.681 / 8.213 / 7.225 | 0.143 / 0.177 / 0.129 | 0.274 / 0.333 / 0.243 |
| r1 run 3 | 19.43 18.51 15.76 | 9.198 / 10.140 / 8.719 | 0.230 / 0.323 / 0.203 | 0.401 / 0.652 / 0.342 | 7.936 / 8.546 / 7.223 | 0.157 / 0.195 / 0.135 | 0.291 / 0.373 / 0.251 |

`tag:#group-3` uncached: p50 7.727 ms (median of 7.727, 7.681, 7.936), 2.3 ms under the bound; every run's p95 (8.213 to 8.546 ms) is under it too. Every answer was 1,000 files, as designed. Against `17ebb07` it is 3.6 ms faster (11.291 to 7.727 ms); the loads were lower here (5-minute 18.5 to 19.1 against 22 to 30), so not all of the gain is the code. `meeting group` uncached is 8.968 ms (10.311 at `17ebb07`), which is follow-up 1. With a required `tag:` term the index reads only the tag rows of the notes that hold the tag or a descendant, through `tags_lookup` as a covering index (checked with `EXPLAIN QUERY PLAN` on the fixture index), so the query reads 1,000 tag rows in place of 10,000; the 1,000 body reads (about 1.4 ms) and the 4.6 ms floor stay.

### Per run (harness)

p50 / p95 / min, ms. `uncached`, `cached` and `line` are the three series of each query.

| Run | Load at start (1, 5, 15 min) | `meeting group` uncached | cached | line | `tag:#group-3` uncached | cached | line | `file:Note-0001` uncached | cached | line |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s1 run 1 | 25.63 27.34 31.22 | 10.307 / 10.921 / 9.907 | 0.241 / 0.343 / 0.207 | 0.390 / 0.504 / 0.336 | 11.011 / 11.531 / 10.102 | 0.153 / 0.190 / 0.134 | 0.270 / 0.306 / 0.244 | 5.084 / 6.093 / 4.829 | 0.096 / 0.130 / 0.074 | 0.189 / 0.221 / 0.166 |
| s1 run 2 | 22.31 26.52 30.86 | 10.310 / 11.860 / 9.687 | 0.264 / 0.489 / 0.208 | 0.467 / 0.933 / 0.344 | 11.192 / 12.814 / 10.280 | 0.156 / 0.177 / 0.133 | 0.292 / 0.360 / 0.246 | 4.977 / 5.368 / 4.668 | 0.136 / 0.247 / 0.083 | 0.195 / 0.265 / 0.172 |
| s1 run 3 | 22.45 26.48 30.82 | 10.312 / 11.306 / 9.759 | 0.220 / 0.268 / 0.199 | 0.385 / 0.442 / 0.335 | 31.258 / 92.790 / 11.282 | 0.404 / 1.617 / 0.159 | 0.947 / 3.072 / 0.286 | 7.557 / 33.356 / 4.920 | 0.230 / 0.738 / 0.093 | 0.573 / 2.432 / 0.177 |
| s2 run 1 | 29.78 29.52 31.71 | 10.068 / 12.499 / 9.541 | 0.227 / 0.306 / 0.205 | 0.385 / 0.444 / 0.342 | 11.181 / 14.687 / 10.193 | 0.163 / 0.214 / 0.137 | 0.287 / 0.334 / 0.246 | 4.929 / 5.511 / 4.723 | 0.104 / 0.116 / 0.076 | 0.202 / 0.237 / 0.170 |
| s2 run 2 | 26.74 28.88 31.45 | 11.299 / 32.553 / 10.156 | 0.312 / 0.804 / 0.209 | 0.625 / 1.837 / 0.356 | 12.302 / 17.674 / 11.185 | 0.225 / 0.515 / 0.136 | 0.548 / 1.220 / 0.255 | 5.400 / 8.293 / 4.857 | 0.102 / 0.256 / 0.074 | 0.214 / 0.481 / 0.170 |
| s2 run 3 | 30.07 29.48 31.63 | 10.364 / 10.887 / 9.961 | 0.235 / 0.324 / 0.203 | 0.395 / 0.463 / 0.342 | 11.390 / 17.206 / 10.663 | 0.265 / 0.609 / 0.141 | 0.354 / 0.852 / 0.260 | 5.138 / 7.614 / 4.875 | 0.115 / 0.295 / 0.075 | 0.210 / 0.468 / 0.173 |

s1 run 3's 1-minute load rose from 22 to 40 during the run; its `tag:` and `file:` series (taken after `meeting group`) show it, and the medians above do not move with it.

| Run | Load at start (1, 5, 15 min) | `meeting group` uncached | cached | line |
| --- | --- | --- | --- | --- |
| p1 run 1 | 40.09 29.93 31.93 | 45.973 / 65.838 / 44.271 | 0.365 / 0.910 / 0.213 | 0.639 / 0.740 / 0.581 |
| p1 run 2 | 44.52 31.81 32.57 | 45.296 / 46.459 / 43.586 | 0.233 / 0.457 / 0.206 | 0.631 / 0.772 / 0.579 |
| p1 run 3 | 36.93 30.75 32.18 | 45.590 / 49.062 / 44.108 | 0.263 / 0.395 / 0.201 | 0.767 / 1.180 / 0.587 |
| p2 run 1 | 15.29 24.17 29.10 | 48.583 / 111.830 / 44.817 | 0.264 / 0.752 / 0.209 | 0.665 / 1.269 / 0.598 |
| p2 run 2 | 16.81 24.08 28.98 | 45.596 / 67.590 / 44.015 | 0.229 / 0.278 / 0.206 | 0.644 / 0.700 / 0.593 |
| p2 run 3 | 15.03 23.20 28.55 | 46.709 / 59.156 / 44.435 | 0.241 / 0.383 / 0.205 | 0.833 / 2.041 / 0.605 |
| big1 run 1 (100,000 notes) | 16.55 22.87 28.28 | 105.169 / 112.494 / 100.986 | 0.254 / 0.360 / 0.219 | 0.412 / 0.487 / 0.349 |
| big1 run 2 | 24.88 24.50 28.72 | 105.359 / 171.585 / 102.700 | 0.243 / 0.330 / 0.216 | 0.404 / 0.485 / 0.354 |
| big1 run 3 | 24.57 24.36 28.57 | 104.539 / 109.821 / 100.624 | 0.228 / 0.289 / 0.197 | 0.386 / 0.465 / 0.348 |

The min of an uncached series sits within 10 percent of its p50 in every run but s1 run 3; the p95s carry the load (a 1-minute load near 40 shows as a p95 of two or three times the p50). The prose p50s moved by 3 ms between runs at loads of 15 and 44, so the load moved the medians little.

One aside the 100,000-note runs show, outside search: the harness's `write_note` p50 there is 62.8 to 66.1 ms, against 11.2 to 12.5 ms at 10,000 notes. A one-note reconciliation at 100,000 notes costs five times as much; that is phase 8's reconciliation, not search, and no requirement here bounds it. It is reported so it is not lost.

### Number 4: a publication during a whole-vault search

`publications_while_a_search_runs` (`crates/vault-index/tests/search_timing.rs`), release, the synthetic fixture. One whole-vault search for `note` (every title holds it, so it answers 10,000 files; asserted) alone, index side: p50 23.134 and 22.765 ms over the two runs. Then 41 one-note publishes (`refresh_paths`, after 5 warm-up) per phase, 7 ms apart, with no reader, then with one search loop in flight; phases interleaved, twice per run. Every search in flight answered 10,000 files (asserted).

| Run | Load at start | Phase | publish p50 (ms) | p95 | min | max | n | searches done |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| timing 1 | 16.28 22.28 27.61 | alone, round 1 | 0.533 | 0.765 | 0.422 | 2.326 | 41 | — |
| timing 1 | | one search in flight, round 1 | 0.664 | 0.770 | 0.467 | 1.466 | 41 | 17 |
| timing 1 | | alone, round 2 | 0.601 | 1.575 | 0.438 | 1.915 | 41 | — |
| timing 1 | | one search in flight, round 2 | 0.622 | 0.938 | 0.435 | 1.881 | 41 | 18 |
| timing 2 | 14.73 21.45 27.16 | alone, round 1 | 0.592 | 0.965 | 0.409 | 2.118 | 41 | — |
| timing 2 | | one search in flight, round 1 | 0.671 | 1.325 | 0.431 | 1.618 | 41 | 17 |
| timing 2 | | alone, round 2 | 0.563 | 0.912 | 0.384 | 1.769 | 41 | — |
| timing 2 | | one search in flight, round 2 | 0.597 | 0.891 | 0.476 | 1.287 | 41 | 18 |

Two timing runs, not the three asked for: the third was held by the load gate for its full 30 minutes, and when the gate let work through again the disk was under the 60 GB floor (see number 5).

No publish while a search ran took 2 ms or more: the search holds no guard while it scans (only its pin runs under the publication guard), so a writer never waits for it. The alone phases have the higher maxima, as in the Bases baseline (a cooling core between 7 ms-spaced edits).

### Number 5: reconciliation against phase 8

**Measured, and met.** The comparison is the one in **Commands**: the head binaries (`vaultd`, `vault-bench`, release, this branch at `e18e353`) against `f470184`, GitHub main, built from a throwaway worktree. The base is `f470184`, not `8154840`, because `f470184` carries the vendored markdown fix, and comparing with `8154840` would credit search with that fix's gain. Free disk was 96 GB. Every run went behind a load gate, one at a time, alternated head, main, head, main; the 1-minute load average before each run is given. Both sides used the same vault and the same fixture, with separate index files.

*Socket harness* (`socket-transport-baseline.js`, no `--search`, 10,000 notes, 200 samples, three daemon runs per series, two series per side). The figure is the median of the three runs.

| Series | Load before (1 min) | `write_note` p50, ms | `write_note` p95, ms |
| --- | --- | --- | --- |
| head-1 | 7.77 | 10.155 | 11.252 |
| main-1 | 9.63 | 10.145 | 11.249 |
| head-2 | 10.85 | 10.175 | 11.674 |
| main-2 | 12.62 | 10.212 | 11.784 |

Pair 1: p50 +0.09 percent, p95 +0.03 percent. Pair 2: p50 -0.36 percent, p95 -0.94 percent. Over both pairs: p50 -0.13 percent, p95 -0.47 percent. Within 5 percent.

*`vault-bench --notes 10000 --repeats 5 --live`*, alternated head, main, head, main. The first four runs (loads 14.04, 14.75, 14.62, 14.75) put the burst and the cold build over 5 percent in some pairs, so, as the brief requires, the pair was rerun twice more (loads 9.66, 7.64, 6.60, 6.48), eight runs in all. P50 per run, ms (p95 in the last column is the median over the four pairs):

| Number | Head, four runs | Main, four runs | Pairs, percent | Median of four, p50 | Median of four, p95 |
| --- | --- | --- | --- | --- | --- |
| cold build | 911.6, 910.7, 955.1, 980.5 | 892.0, 972.0, 1006.7, 1014.1 | +2.2, -6.3, -5.1, -3.3 | -5.7 percent | -2.9 percent |
| 100-note burst | 18.18, 18.71, 19.50, 20.63 | 17.07, 18.74, 18.92, 19.03 | +6.5, -0.2, +3.1, +8.4 | +1.5 percent | -4.8 percent |
| one-note body edit (`body_only_edit`) | 0.107, 0.123, 0.127, 0.118 | 0.108, 0.116, 0.118, 0.118 | -1.0, +5.7, +7.8, +0.3 | +3.0 percent | +3.0 percent |
| one-note reference edit | 0.197, 0.228, 0.206, 0.218 | 0.195, 0.230, 0.205, 0.229 | +0.9, -0.8, +0.2, -4.6 | -2.3 percent | -10.8 percent |

The single pairs that pass 5 percent point both ways (the cold build is faster on head in three of four pairs, and the burst is slower on head in three of four but faster once), and the medians of four are inside the bound: the worst adverse median is +3.0 percent for a body edit that takes 0.12 ms, where 5 percent is 6 microseconds and the run-to-run spread of one side alone is 0.107 to 0.127 ms. The 1-minute load before a head run and before its main partner differed by about 1.8 in each harness pair, by 0.7 or less in the first bench pairs, and by 2.0 or less in the reruns, and it drifted upward through the first four bench runs (14.0 to 14.8); the later runs of each side were slower on both (cold build 892 to 1014 ms on main), so the order effect is larger than any head-to-main gap. The reruns ran at lower load and show the same picture. **Verdict: met.** The worst adverse figure for the write path is +1.5 percent (the burst, median of four pairs).

The requirement holds by construction, and that much is checked here against the source: between `f470184` (GitHub main, the branch's base after the rebase) and this branch, `vault-index` changes in four files (`git diff --stat f470184 HEAD -- crates/vault-index/src crates/vault-core crates/vault-watch`), and none is a write path. `query/search.rs` is new and read-only (it writes nothing and holds no lock while it scans). `reader.rs` gains one read entry point (`evaluation_read_current`, a pin without a resolver). `lib.rs` and `query.rs` gain one export and one module line each. `vault-core` and `vault-watch` do not change. On the server, the search cache is dropped lazily on the next search at a newer generation, so a commit does no search work. No schema change. So a cold build, a one-note `write_note` and a 100-note burst run the same code as on `f470184`.

## The carried review questions

The index-side split is `search_costs_by_shape` (`search_timing.rs`), release, three runs: per query shape, 21 timed searches after two warm-ups, on the synthetic and the prose fixtures; then the two ways the scan reads bodies, timed alone on a read-only connection to the same index; then one note's evaluation with many matches. Timing runs 1 and 2 (loads at start 16.28 22.28 27.61 and 14.73 21.45 27.16):

| Fixture | Query | Sort | Files | Bodies read | p50 run 1 / run 2 (ms) |
| --- | --- | --- | --- | --- | --- |
| synthetic | `meeting group` | file name | 1,000 | 10,000 | 9.543 / 9.644 |
| synthetic | `meeting group` | modified, newest first | 1,000 | 10,000 | 9.213 / 9.368 |
| synthetic | `note` | file name | 10,000 | 10,000 | 22.875 / 22.357 |
| synthetic | `note` | modified | 10,000 | 10,000 | 21.148 / 20.589 |
| synthetic | `tag:#group-3` | file name | 1,000 | 1,000 | 10.804 / 10.201 |
| synthetic | `file:Note-0001` | file name | 100 | 0 | 4.638 / 4.594 |
| synthetic | `tag:#group-3 meeting` | file name | 0 | 1,000 | 9.615 / 9.334 |
| synthetic | `path:Note-000 meeting` | file name | 100 | 1,000 | 5.430 / 5.313 |
| synthetic | `(path:Note-001 OR path:Note-002 OR path:Note-003) meeting` | file name | 300 | 3,000 | 9.265 / 9.032 |
| prose | `meeting group` | file name | 1,000 | 10,000 | 46.910 / 45.738 |
| prose | `meeting group` | modified | 1,000 | 10,000 | 46.619 / 45.555 |
| prose | `note` | file name | 10,000 | 10,000 | 107.402 / 105.289 |
| prose | `note` | modified | 10,000 | 10,000 | 104.527 / 103.614 |
| prose | `tag:#group-3` | file name | 1,000 | 1,000 | 13.010 / 12.824 |
| prose | `file:Note-0001` | file name | 100 | 0 | 4.493 / 4.609 |
| prose | `tag:#group-3 meeting` | file name | 0 | 1,000 | 11.860 / 11.804 |
| prose | `path:Note-000 meeting` | file name | 100 | 1,000 | 8.274 / 8.453 |
| prose | `(path:Note-001 OR … ) meeting` | file name | 300 | 3,000 | 22.073 / 21.923 |

The body reads alone (p50, ms, run 1 / run 2):

| Read | Synthetic (about 130 bytes a note) | Prose (about 3.1 KB a note) |
| --- | --- | --- |
| the bulk pass, every body (10,000) | 0.946 / 0.929 | 4.444 / 5.990 |
| per-note reads, 5 percent (500) | 0.724 / 0.768 | 0.855 / 0.891 |
| 10 percent | 1.408 / 1.363 | 1.773 / 1.859 |
| 20 percent | 2.762 / 2.692 | 3.455 / 3.545 |
| 25 percent | 3.504 / 3.345 | 4.303 / 4.248 |
| 30 percent | 4.249 / 4.044 | 5.180 / 5.112 |
| 40 percent | 5.475 / 5.223 | 7.362 / 7.343 |
| 50 percent | 6.772 / 6.616 | 9.258 / 8.809 |
| 75 percent | 10.349 / 9.876 | 13.227 / 12.905 |
| 100 percent | 13.582 / 12.975 | 18.389 / 18.056 |

### (a) The 1/4 threshold between the bulk pass and per-note reads

The bulk pass reads every body even when the query keeps 26 percent, and the question was whether the threshold should move. Measured: one indexed lookup costs about 1.35 µs on the synthetic fixture and 1.8 µs on the prose one, and the bulk pass costs about 0.09 µs per small note and 0.45 to 0.6 µs per 3 KB note. So the break-even is near **7 percent** for small notes and **25 to 33 percent** for 3 KB notes. The 1/4 threshold is right for notes of a few kilobytes and too high for small ones: on the synthetic fixture a query keeping 24 percent pays about 3.3 ms of per-note reads where the bulk pass costs 0.95 ms. Either way only the kept notes are evaluated (the bulk pass reads the other bodies and drops them), so the threshold moves the read cost alone.

It matters little next to evaluation: a whole-vault `meeting group` costs 9.5 ms of which the bodies are under 1 ms. No single note-count threshold fits both fixtures: 1/10 would save small-note vaults up to about 2.4 ms and cost 3 KB-note vaults up to about 4 ms (a query keeping 10 percent of the prose fixture: bulk 4.4 to 6.0 ms against 1.8 ms per note). Recommendation (follow-up 4): decide by cost, comparing the kept count times the per-lookup cost with the total stored bytes times the per-byte pass cost (both measured above). Not changed here.

### (b) The cost of `context: line`

A cached `context: line` page pins the generation, reads each page note's body once (`SELECT source_bytes … WHERE path = ?`, up to 100 notes) and builds a `LineIndex` per note. Against the same cached page with `context: none`: +0.15 ms on the synthetic fixture (0.393 against 0.238 ms), +0.40 ms on the prose one (0.655 against 0.252 ms), +0.16 ms at 100,000 notes (0.404 against 0.243 ms). So the contexts cost about 1.5 µs per page note plus about 1 µs per KB of note text; they do not grow with the vault. Nothing to fix.

### (c) Per-match line measuring

`LineIndex::loc` counts UTF-16 units from the line's start for each reported match, start and end (at most 100 matches a file, `MAX_MATCHES_PER_FILE`), so one file's cost is up to 200 times its longest line. On the fixtures (lines under 450 bytes) it does not show. On one note it does:

| One note | Bytes | Matches reported | `evaluate` p50 run 1 / run 2 (ms) |
| --- | --- | --- | --- |
| lines of about 350 bytes | 70,200 | 100 | 0.109 / 0.107 |
| the same text on one line | 70,000 | 100 | 5.184 / 5.276 |
| one line of 980,000 bytes | 980,000 | 100 | 72.538 / 72.430 |

The same text costs 50 times more on one line, and a 1 MB single-line note (a minified file saved as `.md`, a pasted log) costs 72 ms alone: the 1 MB line is measured 200 times. Quadratic in the line length, bounded by the match cap. Follow-up 3.

### (d) Tag folding per term and the sort's time lookups

- **Tag folding** shows: it is one of the three parts of the `tag:` miss (number 3 above). The fold alone is not separated from `tag_rows`' allocations by these measurements; together with them it is about 4.5 ms of the 6 ms that `tag:#group-3` adds to the `file:` floor (the other part, the 1,000 body reads, is about 1.4 ms by the body-read table).
- **The sort's time lookups** do not show: sorting by modified time is 0.2 to 2.9 ms *faster* than by file name in every pair above (the file-name sort collates names; the time sort compares integers). The map of times built over every row on every search is part of the 4.6 ms floor; building it for a file-name sort, which never reads it, is a small waste (follow-up 5), not a measured cost.

## Follow-ups

Each is inside `vault-search` or `query/search.rs` and changes no answer. Follow-up 1's decide half and follow-up 2 were fixed after the measurements above, on the coordinator's order: `6d58a5b`, `05b1294` and `5dfd0c3`. Every number in this document is from the build before them (`17ebb07`), except the re-measure of `meeting group` and `tag:#group-3` at `5dfd0c3` (under number 3), which puts number 3 under its bound.

1. **The double fold: the decide half. Fixed in `6d58a5b`; measured at `5dfd0c3` with follow-up 2: `meeting group` 8.968 ms, against 10.311.** The collect half is open as follow-up 6. `is_match` now stops at the first occurrence: over ASCII text it compares bytes ASCII-case-insensitively without a copy, and only non-ASCII text is folded. Property tests pin it to `!find_all(..).is_empty()`. Before the fix: `Needle::is_match` calls `find_all`, which lowercases the whole haystack into a new string and collects every span; `holds` calls it per term to decide, and `collect_term` calls `find_all` again for the spans. So each text term folds each candidate note twice, and a whole-vault search folds the whole vault's text twice per term. It is most of the search cost: the bodies of the synthetic fixture are read in under 1 ms and the search costs 9.5 ms; the prose fixture's 31 MB cost 46 ms, against 4.4 to 6.0 ms to read them. Fix, in two halves: an `is_match` that stops at the first occurrence without allocating (an ASCII case-insensitive scan, the short-circuit Task 2 allows), which landed; and one fold per document for both decide and collect, which did not (follow-up 6). This is also what keeps number 6 under its trigger as notes grow.
2. **Tag rows and tag folding. Fixed in `05b1294` and `5dfd0c3`; measured: `tag:#group-3` 7.727 ms, against 11.291, so number 3 is met.** `TagFact` carries the stored `comparison_key` as `folded`, and `tag:` matches on it, so no tag is folded per term. `tag_rows` groups rows into one entry per note (one path string per note) and the scan binary-searches it, in place of a `HashMap` with an owned path per row. Since `5dfd0c3`, a positive `tag:` term at the top level of the query (`CompiledQuery::required_tag_key`) narrows `tag_rows` in SQL: only the notes holding a tag whose `comparison_key` is the key or starts with the key plus `/` are read, with all of each such note's rows, through the `tags_lookup` index (no schema change). Under OR or NOT, or with no such term, the full read stays. `a_required_tag_narrows_the_tag_rows_read` pins the rows read (`SearchAnswer::tag_rows_read`) and the property test pins the answer.
3. **Per-match `loc`.** Carry the previous match's position forward (matches are sorted) so each line is measured once: linear in the line length instead of 200 times it.
4. **The bulk-pass threshold.** Decide by bytes, or lower to about 1/10 (question a).
5. **The time map.** Build the map of times only for a time sort.
6. **One fold per document for decide and collect.** Open; the other half of follow-up 1. A matching document is still lowercased again by `find_all` when its spans are collected (`evaluate.rs`, `collect_term`), and a non-ASCII document is folded once to decide (`is_match`) and again to collect. Fix: fold a document once per search and hand the folded text to both.

## Commands

```bash
cargo build --release -p vault-server -p vault-index
cargo test --release -p vault-index --test search_timing --no-run
npm --prefix host run build

# The six numbers: two series of three runs each per fixture, alternated.
node host/scripts/socket-transport-baseline.js --binary <release>/vaultd --repeat 3 --notes 10000 \
  --search "meeting group" --search "tag:#group-3" --search "file:Note-0001" --label s1 --out target/tmp/t9/s1.json
node host/scripts/socket-transport-baseline.js --binary <release>/vaultd --repeat 3 --notes 10000 \
  --prose-bytes 3000 --search "meeting group" --label p1 --out target/tmp/t9/p1.json
# … s2 and p2 the same; then 100,000 notes:
node host/scripts/socket-transport-baseline.js --binary <release>/vaultd --repeat 3 --notes 100000 --samples 50 \
  --search "meeting group" --label big1 --out target/tmp/t9/big1.json
TMPDIR="$PWD/target/tmp" cargo test --release -p vault-index --test search_timing \
  -- --ignored --nocapture --test-threads 1

# The base binaries (GitHub main, f470184), from a throwaway worktree.
git worktree add --detach target/tmp/r5-main f470184
cargo build --release --bin vaultd --bin vault-bench \
  --manifest-path target/tmp/r5-main/Cargo.toml --target-dir target/tmp/r5-main-target
# No search, alternated head, main, head, main.
node host/scripts/socket-transport-baseline.js --binary <release>/vaultd --vault target/tmp/t9/plain/vault \
  --index target/tmp/t9/plain/head.sqlite3 --notes 10000 --samples 200 --repeat 3 --label head-1 --out target/tmp/t9/head-1.json
node host/scripts/socket-transport-baseline.js --binary target/tmp/r5-main-target/release/vaultd --vault target/tmp/t9/plain/vault \
  --index target/tmp/t9/plain/main.sqlite3 --notes 10000 --samples 200 --repeat 3 --label main-1 --out target/tmp/t9/main-1.json
TMPDIR="$PWD/target/tmp" <release>/vault-bench --notes 10000 --repeats 5 --live
TMPDIR="$PWD/target/tmp" target/tmp/r5-main-target/release/vault-bench --notes 10000 --repeats 5 --live
git worktree remove --force target/tmp/r5-main
```

`<release>` is the release target directory (`target/release` by default; these runs used a shared `CARGO_TARGET_DIR`). Every command ran behind a load gate, one at a time, with `CARGO_INCREMENTAL=0`, cargo through the 1.85.0 toolchain.
