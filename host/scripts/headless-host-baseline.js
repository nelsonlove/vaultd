#!/usr/bin/env node
// The headless host's startup baseline, in one command.
//
// This is the harness that produced `docs/performance/headless-host-baseline.md`,
// lifted out of a scratch directory so the next machine can reproduce the
// numbers rather than take this one's word for them. The measurement it exists
// for is the **cold start**, and the document's own cold-start figure was taken
// on a 16 GiB MacBook Air that never had less than 9.4 GiB of 10 GiB in swap —
// so the number a machine that is not swapping gets is the number the document
// is missing, and the whole point of this file.
//
//     node host/scripts/headless-host-baseline.js --repeat 3 --label m4-pro
//
// It builds the synthetic vault, installs the plugin set, warms the engine
// index, runs the measured runs one process each, writes one JSON report per
// run and prints the medians. Nothing it writes leaves `target/tmp`, which is
// gitignored, and it never touches a real vault: `--vault` exists for a machine
// that wants the fixture somewhere else, not for pointing this at notes that
// matter.
//
// **It calls the same `startHost` the `vaultd-host` binary calls** (`dist/host.js`,
// the single copy of the wiring), so the numbers are of the shipped startup
// order rather than of a harness's own.
//
// Prerequisites, both checked before anything is measured: the host is built
// (`npm --prefix host run build`) and `vaultd` is built in release
// (`cargo build --release -p vault-server`).
//
// Flags:
//   --repeat N       measured runs, one process each (default 3)
//   --label NAME     names the reports: <out>/<label>-<n>.json (default "run")
//   --notes N        synthetic vault size (default 10000)
//   --round-trip N   also measure N `vault.modify` round trips (default 0)
//   --no-plugins     mirror only: skip installing the ten bundles
//   --vault DIR      where the fixture lives (default target/tmp/baseline/vault)
//   --index DIR      engine index (default target/tmp/baseline/index)
//   --out DIR        where reports land (default target/tmp/baseline/out)
//   --binary PATH    the vaultd to supervise (default target/release/vaultd)
//   --keep-vault     reuse an existing fixture instead of regenerating it
//   --json           print the summary as JSON instead of a table

const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const REPO = resolve(__dirname, "..", "..");
const DIST = join(REPO, "host", "packages", "host", "dist");

// --- The fixture -------------------------------------------------------------

/**
 * Reproduces `build_synthetic_vault` / `synthetic_note` from
 * `crates/vault-server/src/bin/vault-live-bench.rs`, byte for byte, so the
 * fixture measured here is the fixture that binary builds. That binary makes
 * its vault in a `TempDir` and drops it, with no flag to emit one, which is why
 * this reproduces the two functions instead of calling it.
 */
function buildVault(root, count) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const pad = (n) => String(n).padStart(6, "0");
  for (let i = 0; i < count; i += 1) {
    const next = pad((i + 1) % count);
    const previous = pad((i + count - 1) % count);
    const index = pad(i);
    writeFileSync(
      join(root, `Note-${index}.md`),
      `---\ntitle: Note ${index}\n---\n# Note ${index}\n[[Note-${next}]]\n[[Note-${previous}#Note ${previous}]]\n`,
    );
  }
}

const GOLDENS = [
  "automatic-linker",
  "find-replace",
  "folder-notes",
  "nested-properties",
  "obsidian-linter",
  "obsidian-rollover-daily-todos",
  "quickadd",
  "tag-wrangler",
];
const DETECTOR = ["unminified-tier1", "menu-only-tier2"];

/**
 * The ten bundles, in the standard Obsidian layout the host's config directory
 * uses. Eight are the real golden community bundles; two are the hand-authored
 * detector fixtures, which are real bundles requiring `obsidian` but ship no
 * manifest, so one is written for them. Each golden's `scenario.json` settings
 * become its `data.json`, which is what makes QuickAdd register its per-choice
 * commands at all.
 *
 * `nested-properties` is installed and is expected to fail to load, for the
 * reason its own golden pins. A run reporting nine loaded and one failed is the
 * healthy shape, not a broken harness.
 */
function installPlugins(vault) {
  const goldenRoot = join(REPO, "host", "fixtures", "golden");
  const detectorRoot = join(REPO, "host", "fixtures", "detector");
  const configDir = join(vault, ".obsidian-headless");
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(join(configDir, "plugins"), { recursive: true });

  const ids = [];
  for (const id of GOLDENS) {
    const into = join(configDir, "plugins", id);
    cpSync(join(goldenRoot, id, "plugin"), into, { recursive: true });
    const scenarioPath = join(goldenRoot, id, "scenario.json");
    if (existsSync(scenarioPath)) {
      const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
      if (scenario.settings && Object.keys(scenario.settings).length > 0) {
        writeFileSync(join(into, "data.json"), `${JSON.stringify(scenario.settings, null, 2)}\n`);
      }
    }
    // Config files the golden's own vault carried (daily-notes.json and
    // friends) ride along into the host's config dir, which resolves
    // host-dir-first.
    const goldenObsidian = join(goldenRoot, id, "vault", ".obsidian");
    if (existsSync(goldenObsidian)) {
      for (const name of ["daily-notes.json", "core-plugins.json", "templates.json", "app.json"]) {
        const from = join(goldenObsidian, name);
        if (existsSync(from)) cpSync(from, join(configDir, name));
      }
    }
    ids.push(id);
  }

  for (const id of DETECTOR) {
    const into = join(configDir, "plugins", id);
    mkdirSync(into, { recursive: true });
    cpSync(join(detectorRoot, id, "main.js"), join(into, "main.js"));
    writeFileSync(
      join(into, "manifest.json"),
      `${JSON.stringify(
        {
          id,
          name: id,
          version: "0.0.0-fixture",
          minAppVersion: "1.0.0",
          author: "vaultd fixtures",
          isDesktopOnly: false,
        },
        null,
        2,
      )}\n`,
    );
    ids.push(id);
  }

  writeFileSync(join(configDir, "community-plugins.json"), `${JSON.stringify(ids, null, 2)}\n`);
  return ids;
}

// --- One measured run, in this process ---------------------------------------

const pct = (sorted, p) => {
  if (sorted.length === 0) return null;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[at];
};

/**
 * The measured run. One host, one process, one JSON object written to a file —
 * **never to stdout**, because loaded community bundles log to stdout
 * themselves (QuickAdd's migrations, nested-properties' debug banner) and a
 * report written there would be interleaved with them.
 */
async function measure(options) {
  const { startHost } = require(join(DIST, "host.js"));
  const { defaultHostConfig, systemClock } = require(join(DIST, "config.js"));

  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(options.dataDir, 0o700);

  const base = defaultHostConfig(options.vault);
  const config = {
    ...base,
    vaultdBinary: options.binary,
    vaultdArgs: ["--vault", options.vault, "--index", options.index],
    socketPath: options.socketPath,
    dataDir: options.dataDir,
    clock: systemClock(),
    // No harness may reach the network, whatever bundle it loads.
    allowNetwork: false,
    // The watchdog spawns a worker thread; production's 30 s threshold is kept
    // so the measured start is the production start.
  };

  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const running = await startHost(config);
  const coldStartMs = performance.now() - t0;
  const rssAfter = process.memoryUsage().rss;

  const out = {
    label: options.label,
    run: options.run,
    notes: options.notes,
    plugins: options.plugins,
    cold_start_ms: coldStartMs,
    rss_before_bytes: rssBefore,
    rss_after_bytes: rssAfter,
    rss_added_bytes: rssAfter - rssBefore,
    startup: {
      generation: running.startup.generation,
      hydration_ms: running.startup.hydrationMs,
      warm_ms: running.startup.warmMs,
      load_ms: running.startup.loadMs,
      loaded: running.startup.loaded,
      failed: running.startup.failed,
    },
    per_plugin_load_ms: Object.fromEntries([...running.lifecycle.loadTimings()].sort()),
    timers: running.assembly.harvest.timers().map((timer) => ({
      plugin_id: timer.pluginId,
      interval_ms: timer.intervalMs,
    })),
    round_trip: null,
    errors: [],
  };

  if (options.roundTrip > 0) {
    const vault = running.assembly.app.vault;
    const samples = [];
    for (let i = 0; i < options.roundTrip; i += 1) {
      // The 10k fixture's notes 1000-1019, which is what the published series
      // used. The modulo is what keeps a smaller `--notes` from asking for a
      // note that was never written — on the default vault it changes nothing.
      const stamp = String((1000 + i) % Math.max(1, options.notes)).padStart(6, "0");
      const path = `Note-${stamp}.md`;
      const file = vault.getAbstractFileByPath(path);
      if (file === null || file === undefined) {
        out.errors.push(`no file at ${path}`);
        break;
      }
      const body = `---\ntitle: Note ${stamp}\n---\n# Note ${stamp}\nround trip ${i} at ${Date.now()}\n`;
      const started = performance.now();
      try {
        await vault.modify(file, body);
        samples.push(performance.now() - started);
      } catch (error) {
        out.errors.push(
          `modify ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    out.round_trip = {
      samples: samples.length,
      p50_ms: pct(sorted, 50),
      p95_ms: pct(sorted, 95),
      min_ms: sorted[0] ?? null,
      max_ms: sorted[sorted.length - 1] ?? null,
      all_ms: samples,
    };
  }

  out.rss_end_bytes = process.memoryUsage().rss;
  await running.stop();
  writeFileSync(options.outFile, `${JSON.stringify(out, null, 2)}\n`);
}

// --- The driver ---------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    repeat: 3,
    label: "run",
    notes: 10_000,
    roundTrip: 0,
    plugins: true,
    vault: join(REPO, "target", "tmp", "baseline", "vault"),
    index: join(REPO, "target", "tmp", "baseline", "index"),
    out: join(REPO, "target", "tmp", "baseline", "out"),
    binary: join(REPO, "target", "release", "vaultd"),
    keepVault: false,
    json: false,
  };
  const numeric = (raw, flag) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} wants a number, got ${raw}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} wants a value`);
      return argv[i];
    };
    switch (flag) {
      case "--repeat":
        options.repeat = numeric(next(), "--repeat");
        break;
      case "--label":
        options.label = next();
        break;
      case "--notes":
        options.notes = numeric(next(), "--notes");
        break;
      case "--round-trip":
        options.roundTrip = numeric(next(), "--round-trip");
        break;
      case "--no-plugins":
        options.plugins = false;
        break;
      case "--vault":
        options.vault = resolve(next());
        break;
      case "--index":
        options.index = resolve(next());
        break;
      case "--out":
        options.out = resolve(next());
        break;
      case "--binary":
        options.binary = resolve(next());
        break;
      case "--keep-vault":
        options.keepVault = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  if (options.repeat < 1) throw new Error("--repeat wants at least 1");
  // A label names files, so it may not name a directory or a hidden file.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.label)) {
    throw new Error(`--label must be a plain file-name fragment, got ${options.label}`);
  }
  return options;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * One measured run in its own process, because two hosts in one process would
 * share a module registry, a page cache warmed by the previous run's reads and
 * a heap the RSS numbers are of.
 */
function runOnce(options, run, outFile) {
  // The data directory lives beside the reports, under `target/tmp`, so a run
  // leaves nothing in the OS tmpdir. **The socket does not**, and cannot: a
  // Unix socket path is capped at around 104 bytes on macOS, and a repository
  // checked out at any depth blows that from `target/` alone. So the socket
  // gets a short tmpdir of its own and the run removes it again.
  const dataDir = join(options.out, `${options.label}-${String(run)}-data`);
  rmSync(dataDir, { recursive: true, force: true });
  const socketDir = mkdtempSync(join(tmpdir(), "vaultd-bl-"));
  const args = [
    __filename,
    "--child",
    JSON.stringify({
      vault: options.vault,
      index: options.index,
      binary: options.binary,
      dataDir,
      socketPath: join(socketDir, "h.sock"),
      outFile,
      label: options.label,
      run,
      notes: options.notes,
      plugins: options.plugins,
      roundTrip: options.roundTrip,
    }),
  ];
  const result = spawnSync(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  writeFileSync(`${outFile}.stdout`, result.stdout ?? "");
  writeFileSync(`${outFile}.stderr`, result.stderr ?? "");
  rmSync(socketDir, { recursive: true, force: true });
  return result.status;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--child") {
    const options = JSON.parse(argv[1]);
    measure(options).then(
      () => {
        // The host is stopped; anything still holding the loop open is not this
        // measurement's business, and a hung exit would be a silent hang.
        setTimeout(() => process.exit(0), 250).unref();
      },
      (error) => {
        process.stderr.write(
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
        process.exit(1);
      },
    );
    return;
  }

  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${readFileSync(__filename, "utf8").split("\n\n")[0]}\n`);
    return;
  }

  // Both prerequisites before anything is measured, because discovering a
  // missing binary after building a 10,000-note vault is a waste of the
  // machine this is being run on.
  if (!existsSync(join(DIST, "host.js"))) {
    throw new Error(`the host is not built: no ${join(DIST, "host.js")} — npm --prefix host run build`);
  }
  if (!existsSync(options.binary)) {
    throw new Error(
      `no vaultd at ${options.binary} — cargo build --release -p vault-server, or pass --binary`,
    );
  }

  mkdirSync(options.out, { recursive: true });
  if (options.keepVault && existsSync(options.vault)) {
    process.stdout.write(`baseline: reusing the fixture at ${options.vault}\n`);
  } else {
    process.stdout.write(`baseline: building a ${String(options.notes)}-note fixture\n`);
    buildVault(options.vault, options.notes);
  }
  if (options.plugins) {
    const ids = installPlugins(options.vault);
    process.stdout.write(`baseline: installed ${String(ids.length)} plugin bundles\n`);
  } else {
    rmSync(join(options.vault, ".obsidian-headless"), { recursive: true, force: true });
    process.stdout.write("baseline: mirror only, no plugins installed\n");
  }

  // **The engine index is built before the measured runs and kept between
  // them.** A run against a fresh index pays a full cold index build, which is
  // `vault-live-bench`'s `startup_catch_up` case and is not what "host cold
  // start" means. The warm-up run is discarded and says so.
  if (!existsSync(options.index)) {
    process.stdout.write("baseline: warming the engine index (this run is discarded)\n");
    const status = runOnce(options, 0, join(options.out, `${options.label}-index-warm.json`));
    if (status !== 0) {
      throw new Error(
        `the index warm-up run exited ${String(status)} — see ${join(options.out, `${options.label}-index-warm.json.stderr`)}`,
      );
    }
  }

  const reports = [];
  for (let run = 1; run <= options.repeat; run += 1) {
    const outFile = join(options.out, `${options.label}-${String(run)}.json`);
    process.stdout.write(`baseline: run ${String(run)} of ${String(options.repeat)}\n`);
    const status = runOnce(options, run, outFile);
    if (status !== 0) {
      throw new Error(`run ${String(run)} exited ${String(status)} — see ${outFile}.stderr`);
    }
    reports.push(JSON.parse(readFileSync(outFile, "utf8")));
  }

  const summary = {
    label: options.label,
    repeat: options.repeat,
    notes: options.notes,
    plugins: options.plugins,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    taken_at: new Date().toISOString(),
    cold_start_ms: reports.map((report) => report.cold_start_ms),
    cold_start_median_ms: median(reports.map((report) => report.cold_start_ms)),
    hydration_ms: reports.map((report) => report.startup.hydration_ms),
    warm_ms: reports.map((report) => report.startup.warm_ms),
    load_ms: reports.map((report) => report.startup.load_ms),
    rss_added_bytes_median: median(reports.map((report) => report.rss_added_bytes)),
    loaded: reports.map((report) => report.startup.loaded.length),
    failed: reports.map((report) => report.startup.failed.length),
    round_trip_p50_ms: median(
      reports.map((report) => report.round_trip?.p50_ms).filter((value) => value !== undefined && value !== null),
    ),
    round_trip_p95_ms: median(
      reports.map((report) => report.round_trip?.p95_ms).filter((value) => value !== undefined && value !== null),
    ),
    reports: reports.map((report) => `${options.label}-${String(report.run)}.json`),
  };
  const summaryPath = join(options.out, `${options.label}-summary.json`);
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const ms = (value) => (value === null ? "—" : `${value.toFixed(1)} ms`);
  const mib = (value) => (value === null ? "—" : `${(value / 1024 / 1024).toFixed(1)} MiB`);
  process.stdout.write(
    [
      "",
      `baseline ${options.label} — ${String(options.notes)} notes, ${options.plugins ? "ten plugins" : "mirror only"}, ${String(options.repeat)} runs`,
      `  cold start      ${summary.cold_start_ms.map((value) => value.toFixed(1)).join(" / ")}  median ${ms(summary.cold_start_median_ms)}`,
      `  hydration       ${summary.hydration_ms.map((value) => value.toFixed(1)).join(" / ")}`,
      `  position warm   ${summary.warm_ms.map((value) => value.toFixed(1)).join(" / ")}`,
      `  plugin load     ${summary.load_ms.map((value) => value.toFixed(1)).join(" / ")}`,
      `  added RSS       median ${mib(summary.rss_added_bytes_median)}`,
      `  loaded / failed ${summary.loaded.join(",")} / ${summary.failed.join(",")}`,
      options.roundTrip > 0
        ? `  round trip      p50 ${ms(summary.round_trip_p50_ms)}  p95 ${ms(summary.round_trip_p95_ms)}`
        : null,
      `  reports         ${summaryPath}`,
      "",
      "The first run of a series is expected to be the slow one on a machine whose",
      "page cache cannot hold the fixture: the position warm-up is the phase that",
      "reads every note's bytes. Report the series, not the median alone.",
      "",
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`baseline: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
