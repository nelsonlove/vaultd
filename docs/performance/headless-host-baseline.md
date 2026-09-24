# Headless plugin host performance baseline

Baselines for the headless-plugin-host milestone (phase 6, Tasks 0–22). They are **baselines, not contracts**: the contractual part of this phase is the conformance suite and the policy table, both enforced by `npm --prefix host test`. What follows is wall-clock measurement on one machine, reported so that it can fail — every case is named, run three times, and its median stated beside the design's target. A target that was missed is reported as missed, with the number.

The targets come from `docs/design/headless-plugin-host.md`'s "Instrumentation and targets": host cold start with the mirror plus 10 plugins on the 10k fixture under 2 s, and a plugin write round trip (shim `modify` to the promise resolving with the mirror applied) at p50 under 50 ms. The third target in that list — the golden suite green three consecutive runs — is not a timing case and was measured by Task 22a (ten serial runs of `golden.test.ts`, 11/11 tests and process exit 0 in all ten; see `.superpowers/sdd/headless-plugin-host-implementation/task-22a-report.md`).

## Environment

- Date: 2026-09-22
- Machine: MacBook Air, Apple M2, 16 GiB — **not an idle machine.** Load average and swap use are recorded per run below, because this host's startup reads every note's bytes and the page cache on a swapping 16 GiB machine is the dominant source of variance in these numbers.
- OS: macOS 26.5.1 (Darwin 25.5.0), arm64
- Node: v26.7.0
- Engine: `target/release/vaultd` 0.1.0, release profile
- Commit: `8661010` (branch `feat/headless-plugin-host`)
- Load at the start of the measurement session: `load averages: 5.50 7.35 7.01`, swap `9469.69M` of `10240.00M` used. Load fell to 2.8–3.3 across the runs themselves; every run below was taken under load **3.3 or lower**, so none of them is labelled "taken under load" in the sense the dispatch reserves for load above 6. The swap figure never fell below 9.4 GiB, which is the part that matters for the page-cache finding at the end.

## The fixture, and what it is

A 10,000-note synthetic vault, generated to be byte-identical to the one `crates/vault-server/src/bin/vault-live-bench.rs` builds: `build_synthetic_vault` writes `Note-{index:06}.md` for each index, and `synthetic_note` gives each note a `title` property, one `# Note NNNNNN` heading, a wikilink to its successor and a heading-subpath wikilink to its predecessor. That binary constructs its vault in a `tempfile::TempDir` and drops it, so it cannot hand one over; the generator here reproduces its two functions rather than copying its output, and the fixture lives under `target/tmp/`.

`~/vault` was never a target. Nothing in this document touched a real vault, and the 2026-09-09 smoke index was not used.

Ten plugins are installed into the fixture's `.obsidian-headless/plugins/`, in the standard Obsidian layout the host's config directory uses (design Ruling 1): the eight real community bundles from `host/fixtures/golden/<id>/plugin/`, each with its golden's `scenario.json` `settings` written as its `data.json`, plus two hand-authored detector fixtures (`unminified-tier1`, `menu-only-tier2`) given a manifest, because the golden corpus holds eight bundles and the target names ten.

**Nine of the ten load; `nested-properties` does not, and that is the measured behaviour rather than a fixture fault.** Its `onload` builds property-editor widgets off `app.metadataTypeManager.registeredTypeWidgets` and asserts each is non-null; this host answers an empty map, so the plugin's own assertion fires and the load is rolled back. Task 22a's golden pins the same outcome. The cold-start numbers below are therefore "ten enabled, nine loaded, one failed", which is what a real vault with a GUI-shaped plugin in it looks like.

## Commands

The three scratch scripts that produced the numbers below now live in the repository as one command, `host/scripts/headless-host-baseline.js`, so a second machine can reproduce them without reconstructing a harness:

```bash
npm --prefix host run build
cargo build --release -p vault-server
node host/scripts/headless-host-baseline.js --repeat 3 --label <machine>
```

That builds the 10,000-note fixture, installs the ten bundles, warms the engine index with one discarded run, takes three measured runs one process each, writes `target/tmp/baseline/out/<machine>-{1,2,3}.json` plus a `<machine>-summary.json`, and prints the series and its medians. `--repeat N` sets the number of measured runs and `--label NAME` names the reports, which is what makes two machines' series comparable in one directory. The other flags: `--no-plugins` for the mirror-only case (Case 3), `--round-trip N` to add Case 2's `vault.modify` samples, `--notes N` for a smaller fixture, `--keep-vault` to reuse one, and `--vault` / `--index` / `--out` / `--binary` to move the pieces. `--help` prints the same list.

The original scratch scripts were `target/tmp/t22b/gen-vault.js`, `install-plugins.js` and `bench.js`; the committed script is those three merged, with the hard-coded absolute paths replaced by paths derived from the repository root. Nothing about the measured path changed.

The harness calls `startHost` from `host/packages/host/dist/host.js` — **the same function the `vaultd-host` binary calls**, and the single copy of the wiring that `main.ts` and the live-host test seam both drive — so every number here is of the shipped startup order rather than of a harness's own. One host per process, one process per run, the engine spawned and supervised exactly as in production, `allowNetwork` forced off. The daemon's index is built once and kept warm across runs; the first run against a freshly built index pays a full 10k cold build (`vault-live-bench`'s `startup_catch_up` measures that separately at about 1.75 s on this machine) and is not what "host cold start" means.

## Case 1 — host cold start, mirror plus ten plugins, 10k fixture

Wall clock from the `startHost` call to the promise resolving: the supervisor spawning `vaultd` and reaching `watching`, the mirror hydrating from a snapshot session, the position warm-up, the enabled-set and overlap reads, every `onload`, the layout-ready latch, the startup resolve run, and `server.listen()`.

| run | cold start (ms) | of which hydration phase (ms) | of which position warm-up (ms) | of which plugin loads (ms) | loaded / failed | load average at run |
|---|---:|---:|---:|---:|---|---|
| 1 | 2441.8 | 1127 | 1126 | 134 | 9 / 1 | 3.13 |
| 2 | 1627.4 | 521 | 520 | 123 | 9 / 1 | 3.12 |
| 3 | 1624.0 | 508 | 507 | 116 | 9 / 1 | 3.12 |
| **median** | **1627.4** | **521** | **520** | **123** | | |

**Target: under 2 s. Median 1627.4 ms — met.** Run 1 missed it at 2441.8 ms, and that sample is not noise: see "The first run of a series costs double" below, which reproduces it three times and names the mechanism.

The column names are `StartupReport`'s own fields and they do not nest the way the ordering suggests. `hydrationMs` covers the phase from `lifecycle.start()` to the end of the overlap check — the position warm-up, the enabled-set read and the coexistence reading — and `warmMs` is the position warm-up alone, which is 99.8% of it in every run. The mirror's own snapshot hydration happens **before** `lifecycle.start()`, inside `startHost`, so it is inside `cold start` and outside every other column here. **That gap is closed in the code as of 2026-09-22**, after the final review: `StartupReport` now carries `snapshotHydrationMs`, read off the mirror (`Mirror.snapshotHydrationMs()`, timed around the opening snapshot walk), and the design's "mirror hydration time" is that field plus `warmMs`. The numbers in this document were taken before the field existed and are **not** re-measured for it — the column is simply absent from these runs, and the next series will carry it.

## Case 2 — plugin write round trip

`app.vault.modify(file, body)` on the shim `Vault` a plugin receives, timed from the call to the promise resolving — which by Goal 5 is after the daemon's response **and** after the mirror has applied that response's generation and change set. Twenty samples per run, on twenty distinct notes of the 10k fixture, inside the same ten-plugin host as Case 1 (so nine loaded plugins' event subscriptions are live and each write fans out to them).

| run | p50 (ms) | p95 (ms) | min (ms) | max (ms) | samples |
|---|---:|---:|---:|---:|---:|
| 1 | 23.99 | 37.08 | 10.57 | 48.76 | 20 |
| 2 | 24.98 | 40.15 | 8.87 | 40.83 | 20 |
| 3 | 24.65 | 42.82 | 9.03 | 47.35 | 20 |
| **median** | **24.65** | **40.15** | | | |

**Target: p50 under 50 ms. Median p50 24.65 ms — met.** The p95 is met on the same target as well, which the target does not ask for.

The distribution is bimodal rather than noisy: every run holds a cluster near 9–11 ms and a cluster near 24–31 ms, with a handful of 37–49 ms outliers. The samples are in the raw reports under `target/tmp/t22b/out/`. Nothing here isolates which half of the round trip the bimodality lives in — the daemon's commit or the mirror's apply — and this document does not guess.

**One honest note on where the call came from.** The `modify` calls are made by the harness against `assembly.app.vault`, which is the same object and the same code path a loaded plugin's `this.app.vault` is, rather than from inside a plugin's own callback. The one thing that differs is the plugin-attribution window (`currentPluginId`), which records who wrote and does not gate or delay the write. A measurement taken from inside a plugin callback would additionally carry that plugin's dispatch-queue slot.

## Case 3 — full hydration wall time and added RSS

The same fixture with **no plugins enabled**, so the number is the mirror's alone. Three back-to-back runs.

| run | cold start (ms) | hydration phase (ms) | position warm-up (ms) | RSS before start (MiB) | RSS at ready (MiB) | **added RSS (MiB)** |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 2118.7 | 1075 | 1074 | 61.5 | 257.0 | 195.5 |
| 2 | 1449.1 | 520 | 519 | 61.7 | 263.7 | 202.0 |
| 3 | 1544.4 | 583 | 582 | 61.7 | 268.0 | 206.3 |
| **median** | **1544.4** | **583** | **582** | | | **202.0** |

The design sets no target for either figure, so neither is a pass or a fail; both are here because Step 6 asks for them and because they are the numbers a future change would regress against.

Read against Case 1, the ten-plugin host's added RSS is 273.3 / 280.2 / 279.6 MiB, median **279.6 MiB** at the same moment — so **nine loaded community bundles cost about 78 MiB** over the mirror alone, and the mirror over a 10,000-note vault costs about 202 MiB. The RSS figures are `process.memoryUsage().rss` of the host process at two points in one run; they are not a high-water mark and they exclude the `vaultd` child entirely, which is the other half of any deployment's real footprint and is measured in `docs/performance/live-incremental-baseline.md`.

The cold-start difference between the two configurations — median 1627.4 ms with ten enabled against 1544.4 ms with none, a gap of 83 ms — is smaller than the median `loadMs` of 123 ms, which is a reminder that these are three-sample medians on a noisy machine and that the two configurations were measured in different series.

## Case 4 — per-plugin load time

`LifecycleSequencer.loadTimings()`, one entry per plugin, from the three ten-plugin runs of Case 1.

| plugin | run 1 (ms) | run 2 (ms) | run 3 (ms) | median (ms) | bundle size (KB) |
|---|---:|---:|---:|---:|---:|
| `quickadd` | 54 | 46 | 47 | **47** | 1156 |
| `obsidian-linter` | 28 | 30 | 27 | **28** | 882 |
| `folder-notes` | 19 | 13 | 10 | **13** | 333 |
| `automatic-linker` | 5 | 5 | 5 | **5** | 99 |
| `tag-wrangler` | 5 | 5 | 5 | **5** | 135 |
| `find-replace` | 2 | 1 | 1 | **1** | 15 |
| `obsidian-rollover-daily-todos` | 1 | 1 | 1 | **1** | 52 |
| `unminified-tier1` | 0 | 1 | 1 | **1** | fixture |
| `menu-only-tier2` | 1 | 0 | 0 | **0** | fixture |
| `nested-properties` | — | — | — | — | 279 |

No target exists for this case either. The bundle-size column is the Task 20 scan table's `KB` field, quoted so the two can be read together; it was **scanned on 2026-09-16, not asserted**, and a plugin update would change it.

`nested-properties` has no row because it never finished loading, in all three runs, for the reason given above. Its failure is counted in the `loadMs` total (the sequencer times the whole loop) but not in `loadTimings()`, which records completions.

The nine medians sum to 101 ms against a median `loadMs` of 123 ms; the remaining ~22 ms is the loop itself — the enabled-set iteration, the bundle reads, and the failed plugin's attempt and rollback.

## Case 5 — the timer registry, with cadences

`Harvest.timers()` after startup, same three runs, identical in all three:

| plugin | interval (ms) |
|---|---:|
| `quickadd` | 60 000 |

**One timer, across nine loaded plugins.** This is the measurement the design's idle-cost concern asked for — it named "5 Hz-forever timers" as the thing worth reporting — and on this corpus there are none: the only interval any of these nine arms is QuickAdd's, once a minute. The registry is real (`shim/timers.ts` arms every `window.setInterval` and `registerInterval` on the host's own clock and records the cadence), so a plugin that armed a fast one would appear here and in `host.info`'s `timers`; this corpus simply does not contain one.

## The first run of a series costs double, and it is the page cache

Every back-to-back series above has a slow first run and two fast ones, and the pattern reproduced in **three independent series**:

| series | run 1 cold start | runs 2–3 cold start | run 1 position warm-up | runs 2–3 position warm-up |
|---|---:|---|---:|---|
| ten plugins (Case 1) | 2441.8 ms | 1627.4 / 1624.0 ms | 1126 ms | 520 / 507 ms |
| no plugins (Case 3) | 2118.7 ms | 1449.1 / 1544.4 ms | 1074 ms | 519 / 582 ms |
| no plugins (an earlier series) | 2201.1 ms | 1544.6 / 1492.6 ms | 1136 ms | 622 / 522 ms |

Each row is its own raw file under `target/tmp/t22b/out/`: `plugins10-{1,2,3}.json`, `hydration-{1,2,3}.json`, and — the earlier series — `noplugins-{1,2,3}.json`. **The third row was re-derived from those files on 2026-09-22**: as first written it carried 2331.8 / 1479.5 / 1492.6 ms with a 1164 ms warm-up, two of whose three values matched no run in its own cited source. Only the numbers changed; the row still says what it said, and the conclusion below was never the third row's alone — it reproduces in all three.

The whole of the difference sits in the position warm-up, which roughly doubles. That phase is the one place the host reads **every note's bytes** (`Mirror.warmPositions`, bounded at `mirrorWarmConcurrency` 16), so it is exactly the phase whose cost is decided by whether 10,000 files are in the page cache. On this machine they are not, a minute later: swap use never dropped below 9.4 GiB of 10 GiB during the session, and the gap between series was seconds to a minute of ordinary tool activity.

**This is machine-bound, not a host defect, and it is reported rather than averaged away.** It means the 2 s cold-start target is met on a warm page cache and missed — at 2118–2442 ms, three times out of three — on a cold one. A second machine, or the same machine not under memory pressure, would very likely tell a different story; nothing here was run on one, so nothing here claims it.

**Every cold-start figure in this document is Air-only, and it is the one number that most wants a second machine.** The measurement was taken on a 16 GiB MacBook Air that never had less than 9.4 GiB of 10 GiB in swap, which is precisely the condition the position warm-up is sensitive to. The final review's recommendation was to keep the 2 s target, treat the miss as machine-bound, and take one series on a machine that is not swapping before calling the target met or missed at all — so until such a series exists, the honest reading of Case 1 is "met at 1627.4 ms on this machine with a warm page cache", not "met".

To take that series elsewhere: clone the repository on the other machine, `npm --prefix host run build`, `cargo build --release -p vault-server`, then `node host/scripts/headless-host-baseline.js --repeat 3 --label <machine>` for Case 1 and `--no-plugins --repeat 3 --label <machine>-noplugins` for Case 3. Record the machine, its RAM, its swap use and its load average beside the series, as the Environment section above does — a cold-start number with no memory-pressure reading beside it cannot be compared with these. Add the result as a second series in this document rather than replacing this one: two machines disagreeing is the evidence, and one overwriting the other is not.

## Known limits and honest gaps

- **The cold start is measured on one machine, and that machine was swapping.** Named again here because it is the only figure with a target attached: see the reproduction recipe at the end of the page-cache section. `host/scripts/headless-host-baseline.js` exists so the second machine is one command away.
- **Three samples per case, one machine, one session.** No confidence interval is implied by a three-sample median, and the machine was swapping throughout. Every number should be read as an order of magnitude with a shape, not as a figure to compare against a different machine.
- **The mirror's snapshot hydration was not separately timed by anything that shipped — it is now, and these runs predate it.** `StartupReport` gained `snapshotHydrationMs` on 2026-09-22 (the one-field addition this entry asked for), so the snapshot walk is no longer only inside the cold-start wall clock. Every number in this document was measured before that field existed and none was re-measured for it, so the figures above still decompose the way the prose says they do.
- **RSS is the host process only**, sampled at two points, and excludes the supervised `vaultd` child. It is not a high-water mark and it is not comparable to the `peak_rss_bytes` figures in the other baseline documents, which are `getrusage` high-water marks of a whole benchmark process.
- **The round-trip case does not decompose.** It measures the whole of Goal 5's ordering and says nothing about which of the daemon commit, the response, or the mirror apply owns the bimodality.
- **The ten-plugin set is eight real bundles plus two fixtures.** The golden corpus holds eight community plugins; the target names ten. The two fixtures are small hand-authored bundles and contribute about 1 ms between them, so the ten-plugin figure is within a millisecond or two of what an eight-plugin figure would have been.
- **No comparison against Obsidian's own startup is made or implied.** Obsidian loads the same bundles inside an Electron renderer with a DOM, a workspace and a CodeMirror instance; none of that exists here, so the two numbers are not measuring the same thing and no ratio between them would mean anything.
- **Nothing was benchmarked against a real vault**, per the standing constraint. The fixture is synthetic, disposable, and under `target/tmp/`.
