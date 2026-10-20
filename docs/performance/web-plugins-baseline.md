# Web plugins baseline: stage 1 of stock Style Settings in vaultd-web

This measures stage 1 of `docs/design/web-plugins.md`: the web server asks the screen host for the stock Style Settings output on every full page, and writes the classes and the `<style id="css-settings-manager">` into the first HTML. It follows section 5, item 1 of the design and the task 9 line of section 6.

**The Obsidian side was not measured.** The only Obsidian window available showed `document.hasFocus() === false` and `visibilityState === "hidden"` on two probes, a few minutes apart. Live Obsidian timings are void unless the window is in the foreground, so the script stopped and wrote no number (see "Obsidian side"). Every comparison with Obsidian below is therefore open. The vaultd-web side is complete.

## Environment

- Date: 2026-10-20
- Machine: Apple M2 Max, 12 cores, 96 GiB, macOS (Darwin 25.4.0), arm64
- Node: v26.11.1
- vaultd: release build, `target/review-shared/release/vaultd` (a release profile binary)
- Code: branch `spike/style-settings` at `68c3ed8`, plus the two bench scripts of this task
- The Mac was not idle. Load average (1 minute) before each part is in the tables; it was 5.7 to 7.9 during the runs. Each run went through a load gate, one at a time, so the numbers are real but not quiet-machine numbers.

## Fixtures

- **Small:** `host/fixtures/style-settings/vault`, copied to `target/tmp` for each server start (the fixture is never written). A 4.6 KB theme with an `@settings` block, a 0.7 KB snippet with one, the stock plugin (`main.js` 154,561 bytes, `styles.css` 13,906 bytes), and 10 saved values (one of them for a setting the theme no longer has, one for a plugin that is not loaded, as in the capture).
- **Realistic:** the same vault with Minimal 9.1.4 (kepano/obsidian-minimal, latest release, MIT) as the active theme: `theme.css` 266,817 bytes, 251 settings in one `@settings` block. `data.json` holds the small fixture's values plus 16 saved Minimal values (real ids: weights, sizes, `callouts-style`, `checkbox-shape`, `minimal-code-scroll`, `trim-cols`, `link-color` and `bg1` in light and dark, and others). Built at run time by the bench script; the theme files are downloaded and not committed.

The output the realistic fixture gives is 22 body classes (15 of them set by Minimal's defaults and saved values) and 400 bytes of style text; the small one gives 10 body classes and 407 bytes.

## Commands

```bash
node spikes/htmx-client/bench-style-settings.js build-fixtures
VAULTD_BIN=<release vaultd> node spikes/htmx-client/bench-style-settings.js run --fixture small
VAULTD_BIN=<release vaultd> node spikes/htmx-client/bench-style-settings.js run --fixture realistic
node host/scripts/style-settings-obsidian-bench.js --vault <scratch vault open in Obsidian> \
     --realistic-vault target/tmp/ss-perf/realistic/vault --out <json> --runs 20
```

Every run was started through a load gate, one at a time.

## What each number is

- **Cold:** the server answers its own first `/` before it prints its timing line. That request is the first page after a start, and the screen host loads the plugin during it. The figure is the server's own time for it (`server_first_root_ms`), and the time `curl` saw. Five server starts per fixture. The viewer there is anonymous (a cookie viewer).
- **Hit:** 200 sequential `screen.apply` calls for one viewer on one connection to the screen host, the same call and the same framing the web server makes. This is the time the screen step adds to a page, from the write of the request to the arrival of the answer. It does not include the few microseconds the server spends reading the answer. "Page" is 200 sequential `GET /` requests (HTTP, keep-alive, in the same process as the client), once with the screen host and once with `--no-screen`.
- **Miss:** between calls, the viewer's saved value for one setting changes (a patch file in the viewer store), so the result key is new and the plugin loads again. 20 calls, and 20 pages.
- **The period's check:** the screen host compares the revisions of what it kept every 10 s. The bench runs a server with a 1 ms period, so each call carries one check, and the check's cost is that call's time minus a hit's. 200 calls, 200 checks.
- **Bytes** are the bytes of the lines on the socket, counting the newline. The bytes a check reads from vaultd are the sizes of the files it reads (see below); vaultd's own encoding of them is not counted.

## vaultd-web results

All times are in milliseconds. Median / p95.

| Measure | Small | Realistic |
|---|---:|---:|
| Cold first page, server time (n=5) | 28.8 / 29.7 | 50.5 / 51.9 |
| Cold first page, `curl` total (n=5) | 30.2 / 30.9 | 51.9 / 53.1 |
| The same first page with `--no-screen` (n=1) | 2.7 | 10.7 |
| Server start to the timing line (n=5) | 406 / 428 | 429 / 438 |
| **Hit: screen step** (n=200) | **0.09 / 0.15** | **0.31 / 0.37** |
| Hit: bytes server to screen host | 186 | 180 |
| Hit: bytes screen host to server | 583 | 822 |
| Hit: sheet text sent, vaultd requests made, `.obsidian` reads | 0, 0, 0 | 0, 0, 0 |
| `/` with the screen host (n=200) | 0.57 / 0.75 | 0.80 / 1.02 |
| `/` with `--no-screen` (n=200) | 0.34 / 0.51 | 0.34 / 0.52 |
| **Miss: screen step** (n=20) | **4.35 / 5.14** | **11.13 / 12.86** |
| Miss: whole `/` (n=20) | 4.71 / 5.17 | 11.30 / 12.31 |
| Plugin loads in 20 misses | 20 | 20 |
| Period check: call time with a check (n=200) | 1.87 / 2.54 | 3.35 / 5.58 |
| Period check: cost (call minus a hit) | about 1.8 | about 3.0 |
| Period check: files read, vaultd requests | 7 files, 8 requests | 7 files, 8 requests |
| Period check: bytes read (file sizes) | 174,541 | 437,401 |
| of which `main.js` | 154,561 | 154,561 |
| Screen host RSS | 130 MB | 259 MB |
| Web server RSS, vaultd RSS | 86 MB, 16 MB | 87 MB, 16 MB |

Load average (1 min) before each part, small: 5.7 for cold, hit, miss and the check; 6.6 for the page without the screen host. Realistic: 7.6 for cold, hit and miss; 7.9 for the check and the page without the screen host.

The hit cost grows with the theme: 0.09 ms with a 4.6 KB theme and 0.31 ms with Minimal. The screen host keys its result cache on content digests, so I expect it hashes the stylesheet set on each request, but I did not check that in the code. The hit stays far under its target either way.

### The first HTML

For both fixtures, the first HTML response of `/`:

- carries the plugin's classes on `<body>` (10 and 22 classes) and the `<style id="css-settings-manager">` in `<head>`, before `<body>`;
- holds six `<script>` elements (three of them external, the page's own: htmx, its SSE extension, `client.js`); none mentions `css-settings-manager` or `screen.apply`; the plugin's id appears only in the `window.VAULTD_APPEARANCE` config the page already carried for its `<link data-plugin>` sheets.

So the apply needs no client script, and nothing in the page can restyle after first paint on its account. This is read from the HTML and the scripts it carries. I did not run a browser, so "zero restyles" is shown by construction (the output is in the first bytes, and nothing changes it), not by a paint trace.

## Obsidian side

`host/scripts/style-settings-obsidian-bench.js` is written and was run against the scratch vault the owner keeps open. Its design: disable and enable the plugin through `app.plugins`, and take the time from the enable call to `#css-settings-manager` holding the text a calibration run settled on, using a `MutationObserver` so the timer does not wait for a poll. The time includes the plugin's own debounce. It does 20 runs for the small vault, then copies Minimal and the realistic `data.json` in, switches the theme with `app.customCss.setTheme`, and does 20 runs again. At the end, always, it restores the first `appearance.json` and `data.json`, switches the theme back and removes the copied theme.

It checks the safety rules of `style-settings-capture.js`: each CLI call runs with the scratch vault as its working directory and is killed after 60 s, and each eval first checks that `app.vault.adapter.basePath` equals the scratch path.

Result: the first probe read `focus: false`, `visibility: "hidden"`. A second probe, some minutes later, read the same. The script stopped before any timed run, restored the vault (checked byte for byte against its backup), and wrote `{"void": true}`. **There is no Obsidian number in this document.** To fill the gap, bring that Obsidian window to the front and run the last command above; I did not bring the window to the front myself, because that changes what is on the owner's screen.

## Comparison with the design's targets

| Target | Result | Verdict |
|---|---|---|
| Server time added per page under 5 ms on a cache hit | 0.09 ms (small), 0.31 ms (realistic); p95 0.15 and 0.37 ms | Met, by more than 10x |
| Zero client script for the apply | No script touches the output; it is in the first HTML | Met |
| Zero restyles after first paint | The first HTML carries the classes and the style, and nothing changes them; shown by reading the HTML, not by a paint trace | Met by construction |
| A cache miss under Obsidian's own onload-to-apply time | Miss: 4.4 ms (small), 11.1 ms (realistic). Obsidian's time not measured. | Open |

On the open target: the plugin parses its settings after a 100 ms debounce, and the design says Obsidian's onload-to-apply figure includes it. If that holds, Obsidian's figure is at least about 100 ms, and a miss of 11 ms would be well under it. That is a reading of the design, not a measurement, and the Obsidian figure also includes the plugin's load and its first parse of a 267 KB theme, so I leave the target open until the bench has run in a foreground window.

## Other costs worth knowing

- **Cold start.** The first page after a start costs 28.8 ms (small) and 50.5 ms (realistic) of server time, against 2.7 and 10.7 ms for the same page with no screen host. That is the plugin's first load (a 154 KB bundle in the screen host's DOM) and the first sheet-set build. It is paid once per server start and per bundle change, and it is not on the design's target list.
- **A miss loads the plugin again.** `loads` rose by exactly one per miss (20 in 20). A viewer who changes a value pays a load, 4.4 ms or 11.1 ms. The cost scales with the theme (the plugin parses its `@settings` block each time), not with the number of saved values. A cache of the parsed settings keyed by the set would make a miss cheaper; I did not try it.
- **The period's check** (every 10 s, while pages arrive) re-reads 7 files through vaultd: 175 KB on the small fixture and 437 KB with Minimal, of which `main.js` is 154,561 bytes and the theme 266,817. It takes about 1.8 ms and 3.0 ms, and it makes 8 vaultd requests (I counted 7 files; I did not identify the eighth request). Nothing is rebuilt when nothing changed. The cost is bounded and small. It would drop to a fraction if vaultd offered a stat that returns a revision without the text, so the check need not read `main.js` and the theme; that is vaultd work, and it was already noted in the task 8 report.
- **Memory.** The screen host takes 130 MB (small) and 259 MB (realistic) of RSS, at the end of a run that included 20 plugin loads. The web server is 86 MB to 87 MB and vaultd 16 MB. The screen host is the largest process of the three, and its size follows the theme. It was not measured over a long run, so I do not know if it keeps growing.

## Caveats

- One machine, with other work running: load averages from 5.7 to 7.9, on 12 cores. Absolute numbers are machine-bound; the ratios are the useful part.
- Timings come from one process (the bench) calling a local server on loopback. The screen step is measured by calling the screen host the way the server does, not by instrumenting the server; the page numbers (`/` with and without) show the difference the server sees, and they agree: 0.23 ms and 0.47 ms for the two fixtures, against 0.09 ms and 0.31 ms measured directly (the rest is the server building a larger HTML and the second hop).
- The cold figure uses the server's own first request, with an anonymous viewer. The five starts differ by under 2 ms, so the n of 5 is enough for the median, but the p95 of 5 is the maximum.
- The Minimal values are my pick of real ids, not a measured real vault. The design's reference vault is Minimal with several snippets and 84 values; this fixture has 26 values and one snippet.
- Not measured: a phone, a Kindle-class browser, settings open and one change applied (stage 2, items 2 and 3 of section 5), and the browser's first paint.
