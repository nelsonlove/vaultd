# Structural parse and file tree performance baseline

What schema v3 costs: sections, list items, and the vault file tree, measured against the same code without them. Absolute timings are observational and machine-bound. **These are baselines, not contracts** — the contractual parts of this milestone are the work counters and the equivalence proofs the test suite enforces (`cargo test --workspace`, `crates/vault-index/tests/file_tree.rs`, `crates/vault-index/tests/schema_v3.rs`, and the randomized oracle in `crates/vault-index/tests/live_oracle.rs`), not any number below.

## Environment

- Date: 2026-08-31
- OS: macOS 26.5.1 (Darwin), arm64
- CPU: Apple M2
- RAM: 16 GiB
- Rust: rustc 1.98.0, release profile
- Measured commit: `6212cec` (branch `feat/structural-parse-extension`) plus this task's working tree
- Comparison commit: `99264d4` (`main`, schema v2 — no `sections`, `list_items`, or `tree_entries`)

## Method

Every number is an A/B against `main`, on the same machine, in the same session, against identical synthetic vaults. `main`'s tree was extracted with `git archive 99264d4` into a scratch directory and built with the same toolchain; no branch was switched and no real vault was touched at any point.

```bash
# both trees
cargo build --release -p vault-index --bin vault-bench
cargo build --release -p vault-server --bin vaultd --bin vault-live-bench

# timings: three alternating paired runs at 10,000 notes, one pair at 100,000
./target/release/vault-bench --notes 10000 --repeats 7
./target/release/vault-bench --notes 100000 --repeats 7

# index size and row counts: same vault, one index per build, via the daemon
vaultd --vault <synthetic-vault> --index <path> --no-watch --reconcile-interval-seconds 0

# the bulk-import cases, on the real watcher path
./target/release/vault-live-bench --notes 10000 --repeats 7
./target/release/vault-live-bench --notes 100000 --repeats 7
```

Three synthetic vaults, all generated to the shape `vault-bench` itself generates:

- **notes-only** — 10,000 and 100,000 notes, each with frontmatter, a heading, and two wikilinks. Three sections per note, **no list items**, one tree row per note.
- **list-heavy** — 10,000 notes of the same shape plus a seven-item nested task list each: four sections and seven list items per note.
- **attachment-heavy** — the 10,000-note vault plus 2,000 `.png` attachments in 40 folders.

## Write growth: index size and row counts

Same vault, same daemon invocation, one index per build. Sizes are the SQLite file after a clean shutdown, in bytes; every write-ahead log was 0 bytes at that point, on both sides, so nothing is hiding outside the measured file.

| Vault | `main` (v2) | branch (v3) | delta |
|---|---:|---:|---:|
| 10,000 notes | 30,584,832 | 33,165,312 | **+2,580,480 (+8.4 %)** |
| 100,000 notes | 311,533,568 | 337,735,680 | **+26,202,112 (+8.4 %)** |
| 10,000 notes, list-heavy | 31,752,192 | 39,305,216 | **+7,553,024 (+23.8 %)** |
| 10,000 notes + 2,000 attachments | 30,584,832 | 33,361,920 | **+2,777,088 (+9.1 %)** |

Rows written, branch side:

| Vault | `notes` | `sections` | `list_items` | `tree_entries` (note / file / folder) |
|---|---:|---:|---:|---|
| 10,000 notes | 10,000 | 30,000 | 0 | 10,000 (10,000 / 0 / 0) |
| 100,000 notes | 100,000 | 300,000 | 0 | 100,000 (100,000 / 0 / 0) |
| 10,000 notes, list-heavy | 10,000 | 40,000 | 70,000 | 10,000 (10,000 / 0 / 0) |
| 10,000 notes + 2,000 attachments | 10,000 | 30,000 | 0 | 12,040 (10,000 / 2,000 / 40) |

Bytes attributable to the three new tables, from `dbstat` (table pages plus each table's own index pages):

| Vault | `sections` | `list_items` | `tree_entries` | share of the whole index |
|---|---:|---:|---:|---:|
| 10,000 notes | 1,875,968 | 8,192 (empty) | 692,224 | 7.8 % |
| 100,000 notes | 19,128,320 | 8,192 (empty) | 7,061,504 | 7.8 % |
| 10,000 notes, list-heavy | 2,506,752 | 4,337,664 | 704,512 | 19.2 % |
| 10,000 notes + 2,000 attachments | 1,875,968 | 8,192 (empty) | 888,832 | 8.3 % |

Cross-checked independently by copying each index, dropping the three tables, and `VACUUM`-ing both copies: 2,465,792 bytes for the 10,000-note vault, 24,895,488 for the 100,000-note vault, 7,192,576 for the list-heavy one — within a few percent of the `dbstat` totals, which is the rounding-to-pages difference between the two methods.

**Per row, roughly 62–74 bytes** including index pages: about 63 bytes per section, 62 per list item, 69–96 per tree entry (the attachment vault's longer paths sit at the top of that range). **The honest headline: a note-shaped vault pays about 8 % more index; a list-heavy vault pays about 24 %.** The synthetic corpus `vault-bench` generates has no lists at all, which is why the list-heavy vault exists — without it this document would report a list-item cost of zero and be useless for real vaults, where lists are common.

## Cold build and refresh timings

Three alternating paired runs at 10,000 notes (`main`, branch, `main`, branch, …), `--repeats 7` each; the table reports the median of the three p50s per side. The 100,000-note row is a single pair.

| Case | scale | `main` p50 (ms) | branch p50 (ms) | delta |
|---|---|---:|---:|---:|
| `cold_index` | 10k | 1,406.2 | 1,524.9 | **+8.4 %** |
| `cold_index` | 100k | 18,081.8 | 20,204.8 | **+11.7 %** |
| `warm_startup` | 10k | 35.6 | 35.9 | +0.7 % |
| `warm_startup` | 100k | 339.3 | 324.7 | −4.3 % |
| `one_file_refresh` | 10k | 35.4 | 35.0 | −1.1 % |
| `one_file_refresh` | 100k | 339.0 | 326.3 | −3.7 % |
| `verified_refresh` | 10k | 350.2 | 350.8 | +0.2 % |
| `verified_refresh` | 100k | 6,800.6 | 8,437.7 | +24.1 % |
| `get_note` | 10k | 0.077 | 0.097 | +25.6 % |
| `get_note` | 100k | 0.093 | 0.090 | −3.7 % |
| `backlinks` | 10k | 0.024 | 0.023 | −1.6 % |
| `list_100` | 10k | 0.311 | 0.305 | −2.0 % |

Reading this honestly:

- **Cold build is the one clear, repeatable cost: about +8 % at 10,000 notes** (+7.1 %, +8.4 %, +7.4 % across the three pairs — the effect is larger than the spread) and +11.7 % on the single 100,000-note pair. Two more row types per note, plus one tree row per path, are written inside the same transaction that already writes the note.
- **Warm startup and single-file refresh do not move.** Both stay inside run-to-run noise at both scales, which is what the design predicts: neither reads the new tables, and a warm startup writes nothing.
- **`verified_refresh` at 100,000 notes shows +24 % on one pair, and +0.2 % at 10,000 across three pairs.** The 10,000-note figure is the one with three alternating pairs behind it and it says the case does not move. The 100,000-note pair is a single observation per side and the two sides were not run back to back (see the ordering caveat below); that case's own p95 spread within a single run is 7.1 s (`main`) against 14.2 s (branch), which is wider than the difference being claimed. Reported as measured rather than smoothed, and explicitly **not** claimed as a real +24 % regression.
- **Warm query latency is unchanged in kind**: everything stays far below a millisecond. `get_note` is the one query whose statement count actually rose (see below) and it shows a matching-order effect at 10,000 notes (+26 %, −10 %, +28 % across the three pairs — median +25.6 %), on absolute numbers of 77–97 microseconds, i.e. close to the measurement floor.

## Read cost the structural rows added

`load_note_with` — the single funnel every note read goes through (`get_note`, and the reload of each unchanged note inside a complete publication) — executes **8 statements per note on `main` and 10 on this branch: +25 %, exactly the two new `SELECT`s** for `sections` and `list_items`. This is a counted fact, not an estimate: the function's statements are literal and were diffed against `99264d4`.

Where that lands:

- **`get_note`**: +2 statements per call, measured at tens of microseconds (see the table above). Sub-millisecond either way.
- **The complete publication path** (`publish_snapshot`) reloads every unchanged note through the same funnel, so it pays the +25 % statement count per note. It is the mechanism behind the cold-build delta above, and it is what a whole-vault reconcile pays.
- **Live-graph hydration is untouched.** `hydrate_live_graph` reads paths, headings, block ids, and reference/resolution columns only — it never touches `sections`, `list_items`, or `tree_entries`. `cached_read_availability` therefore does not move: 54.7 ms p50 at 10,000 notes and 627.7 ms at 100,000, both in line with the pre-existing live-incremental baseline (65.1 ms and 723.4 ms). The 100,000-note startup-hydration miss documented there is unchanged by this milestone — neither improved nor worsened.

## The new cost case: a bulk attachment import on the watcher path

Before this milestone the watcher discarded every non-Markdown event, so importing attachments cost **exactly nothing**: no hint, no batch, no generation. Now every imported file is a hint and a `tree_entries` row. `vault-live-bench` gained two cases that measure both answers the runtime actually gives, 500 attachments per repeat, on a real watcher against a warm cache:

| Case | scale | p50 (ms) | p95 (ms) | repeats | route |
|---|---|---:|---:|---:|---|
| `attachment_burst_500` | 10k | 192.2 | 208.3 | 7 | targeted refresh (0 of 7 overflowed) |
| `attachment_burst_500` | 100k | 194.7 | 221.4 | 7 | targeted refresh (0 of 7 overflowed) |
| `attachment_burst_500_new_folder` | 10k | 220.3 | 224.2 | 3 | overflow → whole-vault reconcile (3 of 3) |
| `attachment_burst_500_new_folder` | 100k | 786.3 | 952.9 | 3 | overflow → whole-vault reconcile (3 of 3) |

Both cases time the same thing: from the first byte written to the moment those 500 paths are readable in the stored tree, debounce included. What separates them is not a tuning knob — it is `vault_watch`'s own rule. **A folder that is created names no included Markdown path, so the watcher classifies it as structural and forces `ChangeHint::Overflow`, whose answer is a whole-vault reconciliation** however few files follow it. Attachments dropped into a folder that already exists raise no structural event and stay a targeted refresh of exactly the named paths.

- **The targeted route is flat in vault size**: 192 ms at 10,000 notes, 195 ms at 100,000 — a 10x larger vault costs nothing extra, because the work is proportional to the 500 changed paths. About 100 ms of that is the default debounce window; the SQL write stage for the 500 tree rows is 5.5 ms p50, and resolution, parse, and body-read stages are all zero, because no note moved. `note_changes` is zero across every sample, asserted by the benchmark itself.
- **The new-folder route scales with the vault**: 220 ms at 10,000 notes, 786 ms at 100,000. That is the cost of a complete reconciliation over a warm cache — the same shape as `warm_startup` (325 ms p50 at 100,000) plus the debounce and the walk, and two orders of magnitude cheaper than a cold `startup_catch_up` (19.1 s), because no body is read and nothing is reparsed when fingerprints have not moved.
- **The practical shape of a real import**: an unarchive, a `git checkout`, or a plugin creating its attachment folder takes the second route once, per new folder. A 100,000-note vault therefore pays roughly 0.8 s per new folder in an import, not per file. A paste-into-an-existing-folder session takes the first route and pays a flat ~0.2 s per debounce window.
- **Detail, not correctness, is what a large import loses.** The change set for one generation is reported as explicit paths only up to the transport's 1,024-path limit; beyond that a client receives counts plus `resync_required { oversized_change_set }` (`docs/protocol.md`). A 2,000-file import crosses that line while the index itself stays exactly correct.

## Known limits and honest gaps

- **The synthetic corpus has no list items.** The notes-only vaults measure `list_items` at zero rows; the list-heavy vault exists to give that row type a real number, but it is one hand-written list shape, not a survey of real vaults. A vault of long outlines will pay more than the 24 % measured here.
- **`content_revision` is `NULL` for every tree row, by design.** Nothing hashes attachment bytes, so no per-file revision cost appears anywhere in these numbers. Adding one later is a new cost, not a measured one.
- **The 100,000-note timings are single pairs, not triples, and were not run back to back.** Each side costs several minutes; the branch run and the `main` run at that scale were minutes apart rather than alternating, so anything smaller than roughly 10 % at 100,000 notes is below what this method can resolve. The 10,000-note numbers are the ones with three alternating pairs behind them.
- **Every `attachment_burst` repeat leaves its imported files in the vault**, so a later repeat runs against a slightly larger vault than an earlier one (up to 3,500 extra files by the last repeat). Cleaning up would itself be a second burst of deletions; the growth is disclosed rather than hidden.
- **Peak RSS is not reported here.** `vault-live-bench`'s `peak_rss_bytes` is a whole-process high-water mark contaminated by its own cold builds, exactly as `docs/performance/live-incremental-baseline.md` documents; nothing in this milestone changes that, and no isolated memory measurement was added.
- **No real vault was measured.** Every vault above is synthetic and disposable. `vault-bench --vault` remains available for opt-in read-only real-vault measurement; it was not used.
- **No comparison against stock Obsidian is made or implied.** The rubric in `docs/performance/persistent-index-baseline.md` still stands, and no such comparison has been run.
