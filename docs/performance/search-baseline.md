# Search performance baseline

Baselines for the search MVP (`docs/plans/search-implementation.md`, Task 9). The targets are the six numbers in the **Performance requirements** of `docs/design/search.md`, measured on the 10,000-note synthetic fixture, warm, unless stated. Four questions that the earlier tasks' reviews carried here follow them, and then the follow-ups those measurements point at. These are baselines, not contracts: the contract is the test suite. A target that was missed is reported as missed, with the number and the mechanism.

**Every number here was taken on a loaded machine.** The house rule of the earlier baselines (every run started with the 5-minute load under 4) could not be kept: the Mac is shared, other sessions ran beside these measurements, and the 5-minute load stayed between 15 and 32 for the harness series. The coordinator ruled to measure anyway, behind `fleet-gate`, with the load beside every number and every series repeated to show the spread. The numbers are therefore upper bounds of what a quiet machine gives, and a verdict near a bound is weaker than the same verdict in `bases-evaluation-baseline.md`.

## Environment

- Date: 2026-10-18, all series.
- Machine: MacBook Pro, Apple M2 Max (`Mac14,6`), 12 cores, 96 GiB, shared with other sessions (see above). Every run started behind `fleet-gate --in-session`; the load at each run's start (1, 5, 15 minutes) is given beside its numbers.
- OS: macOS 26.4.1 (Darwin 25.4.0), arm64. Node v26.11.1.
- Engine: `vaultd`, `vault-bench` and the `search_timing` test built in release on branch `feat/search` at `17ebb07` (the engine; the harness and the timing test are `91cc175`, which changes neither). The phase 8 comparison binaries were built from `main` at `8154840` (the merge base of `feat/search`) in a throwaway worktree.

## The fixtures

- **Synthetic** (`target/tmp/search-baseline/n10000-p0/vault`): the harness's Bases fixture, 10,000 notes `Note-NNNNNN.md`, each with `title` and `rank: i % 100` properties, a heading, a `#group-(i % 10)` tag line and a link to its successor, plus the line `meeting notes` on every tenth note (`i % 10 === 0`). On it `meeting group` answers 1,000 files (every note holds `group` in its tag line; only the tenth notes hold `meeting`), `tag:#group-3` answers 1,000, `file:Note-0001` answers 100. Every series printed the `total_files` of its first answer, and every count was as designed.
- **Prose** (`n10000-p3000`): the same notes plus about 3,000 bytes each of seeded word salad (`--prose-bytes 3000`), in paragraphs of about 400 bytes, from a word list holding neither `meeting`, `group` nor `note`, so the counts do not move. About 31 MB of text.
- **100,000 notes** (`n100000-p0`): the synthetic shape at 100,000 notes; `meeting group` answers 10,000.

## The six numbers

Each harness series is three daemon runs (`--repeat 3`) of 200 samples (50 at 100,000 notes). Two series were taken on the synthetic fixture (`s1`, `s2`) and two on the prose fixture (`p1`, `p2`), alternated s1, p1, s2, p2. The measured p50 is the median of the six runs' p50s; each series' own median of three is given too. The uncached series runs the daemon with `--search-cache-entries 1` and alternates each query with a twin (the query with the case of its last ASCII letter flipped: `meeting grouP`, `tag:#grouP-3`, `file:NotE-0001`), which is a different cache key with the same answer and the same work under `match_case: false`; the harness refuses a run whose twin answers a different `total_files`. So every uncached sample is a computation, never a hit. All requests ask a first page of 100 files.

| Requirement | Bound | Measured p50 | Verdict |
| --- | --- | --- | --- |
| 1. `meeting group`, first page, uncached | under 50 ms | 10.311 ms (series 10.310, 10.364) | met |
| 2. a cached page, `context: none` | under 1 ms | 0.238 ms (series 0.241, 0.235) | met |
| 2, reported beside it: a cached page, `context: line` | no bound | 0.393 ms (series 0.390, 0.395) | — |
| 3. `tag:#group-3`, uncached | under 10 ms | 11.291 ms (series 11.192, 11.390) | **missed** (see below) |
| 3. `file:Note-0001`, uncached | under 10 ms | 5.111 ms (series 5.084, 5.138) | met |
| 4. a publication during a whole-vault search | under 2 ms | p50 0.597 to 0.671 ms, max 1.287 to 1.881 ms | met |
| 5. reconciliation against phase 8 | within 5 percent | not measured (disk floor) | met by construction, unmeasured (see below) |
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

What would close it, measured nowhere here: filter `tag_rows` in SQL by `comparison_key` for a positive `tag:` conjunct (the prefilter already proves it is a superset), and match on the stored fold. Not fixed in this task, on the coordinator's ruling: it is follow-up 2.

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

Two timing runs, not the three asked for: the third was held by `fleet-gate` for its full 30 minutes (the plan's 5-hour usage stood at 91 percent against a limit of 85), and when the gate let work through again the disk was under the 60 GB floor (see number 5).

No publish while a search ran took 2 ms or more: the search holds no guard while it scans (only its pin runs under the publication guard), so a writer never waits for it. The alone phases have the higher maxima, as in the Bases baseline (a cooling core between 7 ms-spaced edits).

### Number 5: reconciliation against phase 8

**Not measured.** The comparison binaries were built (`main` at `8154840`, in a throwaway worktree), but before the first comparison run the free disk was 59 GB, under the 60 GB floor this task works to (other sessions were filling the disk), and the run stopped there. The comparison commands are in **Commands** below, ready to run.

The requirement holds by construction, and that much is checked here against the source: between `8154840` and this branch, `vault-index` changes in four files (`git diff --stat 8154840 HEAD -- crates/vault-index/src crates/vault-core crates/vault-watch`), and none is a write path. `query/search.rs` is new and read-only (it writes nothing and holds no lock while it scans). `reader.rs` gains one read entry point (`evaluation_read_current`, a pin without a resolver). `lib.rs` and `query.rs` gain one export and one module line each. `vault-core` and `vault-watch` do not change. On the server, the search cache is dropped lazily on the next search at a newer generation, so a commit does no search work. No schema change. So a cold build, a one-note `write_note` and a 100-note burst run the same code as in phase 8.

What the head binary alone shows, for the record (not a comparison): the harness's `write_note` p50 on the synthetic search fixture is 11.218 to 12.241 ms across the six `s` runs at loads of 22 to 30, against the 10.0 to 10.2 ms that `bases-evaluation-baseline.md` measured for phase 8 at loads near 1. The two differ in the load, the fixture and the binary at once, so the gap is not evidence about this branch.

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

None is fixed in this task (the coordinator's ruling); each is inside `vault-search` or `query/search.rs` and changes no answer.

1. **The double fold.** `Needle::is_match` calls `find_all`, which lowercases the whole haystack into a new string and collects every span; `holds` calls it per term to decide, and `collect_term` calls `find_all` again for the spans. So each text term folds each candidate note twice, and a whole-vault search folds the whole vault's text twice per term. It is most of the search cost: the bodies of the synthetic fixture are read in under 1 ms and the search costs 9.5 ms; the prose fixture's 31 MB cost 46 ms, against 4.4 to 6.0 ms to read them. Fix: an `is_match` that stops at the first occurrence without allocating (an ASCII case-insensitive scan, the short-circuit Task 2 allows), and fold once per document for both decide and collect. This is also what keeps number 6 under its trigger as notes grow.
2. **Tag rows and tag folding.** Filter `tag_rows` in SQL by `comparison_key` for a positive `tag:` conjunct, and compare against the stored fold instead of `fold_js` per tag per term. Closes the number 3 miss by about 4 ms, by this document's split (a guess until measured).
3. **Per-match `loc`.** Carry the previous match's position forward (matches are sorted) so each line is measured once: linear in the line length instead of 200 times it.
4. **The bulk-pass threshold.** Decide by bytes, or lower to about 1/10 (question a).
5. **The time map.** Build the map of times only for a time sort.

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

# Phase 8's binaries, from a throwaway worktree.
git worktree add --detach target/tmp/t9-main 8154840
cargo build --release --bin vaultd --bin vault-bench \
  --manifest-path target/tmp/t9-main/Cargo.toml --target-dir target/tmp/t9-main-target
# No search, alternated head, main, head, main.
node host/scripts/socket-transport-baseline.js --binary <release>/vaultd --vault target/tmp/t9/plain/vault \
  --index target/tmp/t9/plain/head.sqlite3 --notes 10000 --samples 200 --repeat 3 --label head-1 --out target/tmp/t9/head-1.json
node host/scripts/socket-transport-baseline.js --binary target/tmp/t9-main-target/release/vaultd --vault target/tmp/t9/plain/vault \
  --index target/tmp/t9/plain/main.sqlite3 --notes 10000 --samples 200 --repeat 3 --label main-1 --out target/tmp/t9/main-1.json
TMPDIR="$PWD/target/tmp" <release>/vault-bench --notes 10000 --repeats 5 --live
TMPDIR="$PWD/target/tmp" target/tmp/t9-main-target/release/vault-bench --notes 10000 --repeats 5 --live
git worktree remove --force target/tmp/t9-main
```

`<release>` is the release target directory (`target/release` by default; these runs used a shared `CARGO_TARGET_DIR`). Every command ran behind `fleet-gate --wait 1800 --in-session`, one at a time, with `CARGO_INCREMENTAL=0`, cargo through the 1.85.0 toolchain.
