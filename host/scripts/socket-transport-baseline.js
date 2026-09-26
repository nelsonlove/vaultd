#!/usr/bin/env node
"use strict";
/**
 * Round-trip cost through each of vaultd's two doors.
 *
 * It is a *daemon* harness, not a host one: every case is one request to
 * `vaultd` and back, so there is no plugin runtime, no mirror, and no
 * `startHost`. That is what makes the stdio and socket numbers comparable —
 * the only thing that differs between two runs is the byte pipe.
 *
 * It writes only under `target/tmp` and it never touches a real vault. The
 * vault it measures is the one named by `--vault`; the harness builds it when
 * it is absent or empty, and refuses to build over a non-empty directory that
 * is not under `target/` unless `--keep-vault` says to use it as it is.
 *
 *     node host/scripts/socket-transport-baseline.js \
 *       --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/socket.sqlite3 \
 *       --transport socket --samples 200 --out target/tmp/t7-bench/socket.json
 *
 * The three cases, all measured against the same fixture:
 *
 *   connect_ms      `connect()` to the first `health` answer, on a fresh
 *                   connection each time (socket only — stdio has no connect).
 *   get_note_ms     one warm `get_note` round trip.
 *   write_note_ms   one `write_note` round trip, each to a new path, which
 *                   includes the daemon's own reconciliation because a
 *                   mutation answers only after its generation has published.
 *
 * `--repeat N` takes N measured runs, one daemon process each, and writes one
 * report per run beside a summary of the medians — the convention
 * `headless-host-baseline.js` uses, so two machines' series are comparable in
 * one directory. `--repeat 1`, the default, writes the single report at `--out`.
 *
 * Prerequisites, both checked before anything is measured: the host is built
 * (`npm --prefix host run build`) and vaultd is built in release
 * (`cargo build --release --bin vaultd`).
 *
 * Flags:
 *   --vault DIR      the fixture (default target/tmp/socket-baseline/vault)
 *   --index PATH     the engine index file (default …/index.sqlite3)
 *   --socket PATH    the socket to bind (default beside the index)
 *   --transport T    socket | stdio (default socket)
 *   --samples N      samples per case (default 200)
 *   --repeat N       measured runs, one daemon each (default 1)
 *   --label NAME     names the per-run reports (default "run")
 *   --notes N        fixture size when it has to be built (default 1000)
 *   --out PATH       where the report lands
 *   --binary PATH    the vaultd to measure (default target/release/vaultd)
 *   --keep-vault     measure an existing non-empty --vault outside target/ instead
 *                    of refusing it. **Not read-only**: the `write_note` case
 *                    creates `--samples` notes named `Bench-<label>-<run>-NNNNNN.md`
 *                    (plus 20 warm-up notes) in that directory and removes them
 *                    again when the run ends, so a run that is killed between the
 *                    two leaves them behind.
 *   --json           print the summary as JSON instead of a table
 */

const { spawn } = require("node:child_process");
const { connect } = require("node:net");
const {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { loadavg } = require("node:os");
const { basename, dirname, extname, join, resolve } = require("node:path");
const { hrtime } = require("node:process");

const { VaultdClient } = require("../packages/host/dist/client/client.js");

const REPO = resolve(__dirname, "..", "..");
const DIST = join(REPO, "host", "packages", "host", "dist");
const DEFAULT_ROOT = join(REPO, "target", "tmp", "socket-baseline");

// --- Flags -------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    transport: "socket",
    samples: 200,
    repeat: 1,
    label: "run",
    notes: 1_000,
    keepVault: false,
    json: false,
    help: false,
  };
  const numeric = (raw, flag) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1) throw new Error(`${flag} wants a positive number, got ${String(raw)}`);
    return value;
  };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const next = () => {
      at += 1;
      if (at >= argv.length) throw new Error(`${flag} wants a value`);
      return argv[at];
    };
    switch (flag) {
      case "--vault": out.vault = resolve(next()); break;
      case "--index": out.index = resolve(next()); break;
      case "--socket": out.socket = resolve(next()); break;
      case "--transport": out.transport = next(); break;
      case "--samples": out.samples = numeric(next(), "--samples"); break;
      case "--repeat": out.repeat = numeric(next(), "--repeat"); break;
      case "--label": out.label = next(); break;
      case "--notes": out.notes = numeric(next(), "--notes"); break;
      case "--out": out.out = resolve(next()); break;
      case "--binary": out.binary = resolve(next()); break;
      case "--keep-vault": out.keepVault = true; break;
      case "--json": out.json = true; break;
      case "--help": case "-h": out.help = true; break;
      default: throw new Error(`unknown flag ${String(flag)}`);
    }
  }
  if (out.help) return out;
  if (out.transport !== "socket" && out.transport !== "stdio") {
    throw new Error(`--transport must be socket or stdio, not ${String(out.transport)}`);
  }
  // A label names files, so it may not name a directory or a hidden file.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.label)) {
    throw new Error(`--label must be a plain file-name fragment, got ${out.label}`);
  }
  out.vault ??= join(DEFAULT_ROOT, "vault");
  out.index ??= join(DEFAULT_ROOT, `${out.transport}.sqlite3`);
  out.out ??= join(DEFAULT_ROOT, `${out.transport}.json`);
  out.binary ??= join(REPO, "target", "release", "vaultd");
  // **Short, and under the repository's own `target/`.** A Unix socket path is
  // capped near 104 bytes on macOS, and the daemon refuses a longer one by
  // name; the OS tmpdir is not used because a scratch file of this run's
  // belongs with the rest of them.
  out.socket ??= join(dirname(out.index), "b.sock");
  return out;
}

// --- The fixture -------------------------------------------------------------

/**
 * The path with every symlink resolved, for a path that may not exist yet.
 *
 * `realpathSync` throws on a path that is not there, and the guard below has to
 * judge paths the harness is about to create. So: resolve the deepest existing
 * ancestor and re-attach the names below it, which is the same technique
 * `IndexConfig::explicit` uses on the Rust side for exactly this reason.
 */
function realPathish(path) {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    // `dirname("/")` is `"/"`, so this is the recursion's floor.
    if (parent === path) return path;
    return join(realPathish(parent), basename(path));
  }
}

/**
 * Refuse to build the fixture over anything that is not obviously scratch.
 *
 * `--vault` is a path a human types, and the standing rule in this repository
 * is that a harness never touches a real vault. A path under `target/` is this
 * harness's own scratch; anywhere else, an existing non-empty directory is
 * refused and the caller is told the two ways forward.
 *
 * **Both sides are resolved through their symlinks before the prefix test**,
 * because `resolve()` is purely lexical: a symlink at
 * `target/tmp/anything` pointing at a real vault would otherwise read as "under
 * `target/`, therefore scratch, therefore safe to fill with a thousand notes".
 * Measured, not imagined — the review that asked for this built that symlink and
 * the lexical guard allowed it. `socket-transport-guard-selftest.js` pins the
 * fixed behaviour.
 */
function assertSafeToBuild(root) {
  const scratch = realPathish(join(REPO, "target"));
  const real = realPathish(root);
  if (real === scratch || real.startsWith(`${scratch}/`)) return;
  if (!existsSync(real)) return;
  if (readdirSync(real).length === 0) return;
  throw new Error(
    `refusing to build the fixture at ${root} (${real}): it exists, it is not empty, and it is ` +
      `not under ${scratch}. Pass --keep-vault to measure it as it is, or point --vault at a new ` +
      `or empty directory.`,
  );
}

/**
 * The same synthetic vault `headless-host-baseline.js` builds — `Note-NNNNNN.md`
 * with a `title` property, one heading and a wikilink to its successor — so the
 * two documents' fixtures are the same shape at different sizes.
 */
function buildVault(root, count) {
  mkdirSync(root, { recursive: true });
  const pad = (n) => String(n).padStart(6, "0");
  for (let i = 0; i < count; i += 1) {
    const index = pad(i);
    writeFileSync(
      join(root, `Note-${index}.md`),
      `---\ntitle: Note ${index}\n---\n\n# Note ${index}\n\n[[Note-${pad((i + 1) % count)}]]\n`,
    );
  }
}

// --- The daemon --------------------------------------------------------------

/**
 * Every daemon this process has started and not yet reaped.
 *
 * It exists for one reason: a signal. Node's default disposition for SIGINT,
 * SIGTERM and SIGHUP is to die without running a `finally`, and `spawn` on
 * POSIX does not take a child with its parent — so a Ctrl-C twenty seconds into
 * a run leaves a `vaultd` alive holding the writer lease on `--index` and the
 * socket file bound, and the next run fails on the lease with nobody to blame.
 * Measured, not imagined: the review that asked for this SIGTERMed a run and
 * found the daemon still alive four seconds later.
 */
const liveDaemons = new Set();

/**
 * True once a signal has been taken and the daemons are being stopped.
 *
 * Stopping a daemon fails every request in flight, so a run that is interrupted
 * ends with a rejected promise — which is correct and is not news. The harness's
 * top-level handler consults this so an interrupted run dies of its signal with
 * one line, rather than of an uncaught "client closed" with a stack trace that
 * suggests something went wrong.
 */
let stopping = false;

/** Whether this process is on its way out because of a signal. */
const stoppingForSignal = () => stopping;

/**
 * Install the handler that stops those daemons and then lets the signal do what
 * it was going to do.
 *
 * Re-raising rather than `process.exit`ing is the part worth stating: a shell
 * that sent SIGINT is entitled to see the process die of SIGINT, and a wrapper
 * counting exit codes must not be told a killed run exited 0. The handler is
 * removed first so the re-raise takes the default disposition.
 */
function stopDaemonsOnSignal(label) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(
        `${label}: ${signal} — stopping ${String(liveDaemons.size)} daemon(s) before exiting\n`,
      );
      void (async () => {
        // `stopDaemon` is SIGTERM, then a 15 s deadline, then SIGKILL, so this
        // waits exactly as long as an orderly shutdown is allowed to take.
        await Promise.all([...liveDaemons].map((child) => stopDaemon(child)));
        for (const other of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeAllListeners(other);
        process.kill(process.pid, signal);
      })();
    });
  }
}

/** Spawn the daemon, with a listener when the run needs one. */
function spawnDaemon(options, socketPath, indexPath) {
  const args = [
    "--vault", options.vault,
    "--index", indexPath,
    "--no-watch",
    "--reconcile-interval-seconds", "0",
  ];
  if (options.transport === "socket") args.push("--listen", socketPath);
  return track(spawn(options.binary, args, { stdio: ["pipe", "pipe", "inherit"] }));
}

/** Remember a daemon until it exits, so a signal can stop it. */
function track(child) {
  liveDaemons.add(child);
  child.once("exit", () => liveDaemons.delete(child));
  return child;
}

/**
 * SIGTERM, then wait for the process to go, then SIGKILL if it will not.
 *
 * The daemon's shutdown is two bounded budgets of 5 s each (Task 5), so 15 s is
 * a hang-becomes-a-failure bound rather than a timing assertion. The exit is
 * reported with the run so a measurement taken behind a daemon that had to be
 * killed is legible as one.
 */
function stopDaemon(child) {
  return new Promise((settle) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      settle({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(killer);
      settle({ code, signal });
    });
    child.kill("SIGTERM");
  });
}

const ms = (since) => Number(hrtime.bigint() - since) / 1e6;

/** One client over `path`, and what its connect-to-first-answer cost. */
async function openSocketClient(path, onEvent = () => {}) {
  const started = hrtime.bigint();
  const socket = connect(path);
  await new Promise((settle, fail) => {
    socket.once("connect", settle);
    socket.once("error", fail);
  });
  const client = new VaultdClient({
    stdout: socket, stdin: socket, onEvent, onFatal: () => {},
  });
  await client.request("health");
  return { client, socket, connectMs: ms(started) };
}

/** A client over this run's transport, plus the connect cost when there is one. */
async function openClient(options, child, socketPath) {
  if (options.transport === "stdio") {
    const client = new VaultdClient({
      stdout: child.stdout, stdin: child.stdin,
      onEvent: () => {}, onFatal: () => {},
    });
    await client.request("health");
    return { client, socket: null, connectMs: [] };
  }
  // The socket appears when the daemon has hydrated, which on a cold index is
  // seconds. Waiting for it is not part of any case: the first connection that
  // succeeds is discarded, and `measureConnects` takes the samples afterwards
  // against a daemon that is already answering.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const opened = await openSocketClient(socketPath);
      return { client: opened.client, socket: opened.socket, connectMs: [] };
    } catch (error) {
      if (child.exitCode !== null) throw new Error(`the daemon exited ${String(child.exitCode)} before it answered`);
      if (Date.now() > deadline) throw error;
      await new Promise((settle) => setTimeout(settle, 25));
    }
  }
}

/** Connect-to-first-answer, `--samples` times, on fresh connections. */
async function measureConnects(socketPath, samples, into) {
  for (let at = 0; at < samples; at += 1) {
    const opened = await openSocketClient(socketPath);
    into.push(opened.connectMs);
    opened.client.close();
    opened.socket.destroy();
  }
}

// --- One run -----------------------------------------------------------------

async function measureRun(options, run) {
  const socketPath = options.repeat === 1
    ? options.socket
    : join(dirname(options.socket), `${basename(options.socket, ".sock")}${String(run)}.sock`);
  const indexPath = options.repeat === 1
    ? options.index
    : join(
      dirname(options.index),
      `${basename(options.index, extname(options.index))}-${options.label}-${String(run)}${extname(options.index)}`,
    );
  rmSync(indexPath, { force: true });
  rmSync(socketPath, { force: true });

  const loadBefore = loadavg();
  // Every path this run writes, so the fixture is the same bytes for the next
  // run and for the other transport.
  const written = [];
  // **The spawn is inside the `try`.** Every way `openClient` can fail — its
  // hydration deadline, a `health` that connects and never answers, a client
  // that rejects — must still reach the `finally` that stops the daemon, or the
  // harness exits 1 leaving a `vaultd` holding the lease on `--index`.
  let child = null;
  let client = null;
  let socket = null;
  try {
    child = spawnDaemon(options, socketPath, indexPath);
    const opened = await openClient(options, child, socketPath);
    client = opened.client;
    socket = opened.socket;
    const connectMs = opened.connectMs;
    await client.request("refresh_index", {});
    const info = await client.request("get_vault_info");
    const first = (await client.request("list_notes", { cursor: null, limit: 1 })).items[0];
    if (!first) throw new Error(`the fixture vault at ${options.vault} has no notes`);

    // Warm, so the numbers are of the transport rather than of a cold page cache.
    for (let at = 0; at < 20; at += 1) await client.request("get_note", { path: first.path });

    const getNoteMs = [];
    for (let at = 0; at < options.samples; at += 1) {
      const started = hrtime.bigint();
      await client.request("get_note", { path: first.path });
      getNoteMs.push(ms(started));
    }

    // **Warmed the same way the reads are**, because the first write of a run
    // pays the index's first-write cost on a freshly built index and it would
    // otherwise sit inside the sample set. The warm-up notes are removed with
    // the measured ones.
    const prefix = `Bench-${options.label}-${String(run)}`;
    for (let at = 0; at < 20; at += 1) {
      const path = `${prefix}-warm-${String(at).padStart(6, "0")}.md`;
      await client.request("write_note", {
        path, content: `# Warm ${String(at)}\n`, expected: { absent: true },
      });
      written.push(path);
    }

    const writeNoteMs = [];
    for (let at = 0; at < options.samples; at += 1) {
      const path = `${prefix}-${String(at).padStart(6, "0")}.md`;
      const started = hrtime.bigint();
      await client.request("write_note", {
        path, content: `# Bench ${String(at)}\n`, expected: { absent: true },
      });
      writeNoteMs.push(ms(started));
      written.push(path);
    }

    if (options.transport === "socket") await measureConnects(socketPath, options.samples, connectMs);

    return {
      transport: options.transport,
      run,
      socket_path: info.socket_path ?? null,
      note_count: info.note_count,
      cases: { connect_ms: connectMs, get_note_ms: getNoteMs, write_note_ms: writeNoteMs },
      environment: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        samples: options.samples,
        taken_at: new Date().toISOString(),
        load_average_before: loadBefore,
        load_average_after: loadavg(),
      },
    };
  } finally {
    if (client) client.close();
    if (socket) socket.destroy();
    if (child) {
      if (child.stdin.writable) child.stdin.end();
      const exit = await stopDaemon(child);
      if (exit.signal === "SIGKILL") {
        process.stderr.write(`baseline: run ${String(run)} had to SIGKILL the daemon\n`);
      }
    }
    // After the daemon is gone, so nothing reconciles a half-removed vault.
    for (const path of written) rmSync(join(options.vault, path), { force: true });
    rmSync(socketPath, { force: true });
  }
}

// --- The driver ---------------------------------------------------------------

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  stopDaemonsOnSignal("baseline");
  if (options.help) {
    process.stdout.write(`${require("node:fs").readFileSync(__filename, "utf8").split("*/")[0]}\n`);
    return;
  }

  // Both prerequisites before anything is measured, because discovering a
  // missing binary after building a fixture wastes the machine this runs on.
  if (!existsSync(join(DIST, "client", "client.js"))) {
    throw new Error(
      `the host is not built: no ${join(DIST, "client", "client.js")} — npm --prefix host run build`,
    );
  }
  if (!existsSync(options.binary)) {
    throw new Error(
      `no vaultd at ${options.binary} — cargo build --release --bin vaultd, or pass --binary`,
    );
  }

  // **An existing fixture is reused, never rebuilt.** Both transports and every
  // run must measure the same bytes, and a rebuild between them would change
  // every note's mtime and hand one run a colder page cache than the next.
  if (existsSync(options.vault) && readdirSync(options.vault).length > 0) {
    if (!options.keepVault) assertSafeToBuild(options.vault);
    process.stdout.write(`baseline: reusing the fixture at ${options.vault}\n`);
  } else {
    assertSafeToBuild(options.vault);
    process.stdout.write(`baseline: building a ${String(options.notes)}-note fixture at ${options.vault}\n`);
    buildVault(options.vault, options.notes);
  }
  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(dirname(options.index), { recursive: true });

  const reports = [];
  for (let run = 1; run <= options.repeat; run += 1) {
    process.stdout.write(`baseline: ${options.transport} run ${String(run)} of ${String(options.repeat)}\n`);
    const report = await measureRun(options, run);
    if (options.repeat > 1) {
      const path = join(dirname(options.out), `${basename(options.out, ".json")}-${options.label}-${String(run)}.json`);
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      report.report_path = path;
    }
    reports.push(report);
  }

  // `--repeat 1` writes exactly the report the interface names; a series writes
  // the same shape per run beside a summary of the three p50s and their median.
  if (options.repeat === 1) {
    writeFileSync(options.out, `${JSON.stringify(reports[0], null, 2)}\n`);
  } else {
    const p50s = (name) => reports.map((report) => median(report.cases[name]));
    const summary = {
      transport: options.transport,
      label: options.label,
      repeat: options.repeat,
      runs: reports.map((report) => report.report_path),
      p50_ms: {
        connect_ms: p50s("connect_ms"),
        get_note_ms: p50s("get_note_ms"),
        write_note_ms: p50s("write_note_ms"),
      },
      median_p50_ms: {
        connect_ms: median(p50s("connect_ms").filter((value) => value !== null)),
        get_note_ms: median(p50s("get_note_ms")),
        write_note_ms: median(p50s("write_note_ms")),
      },
      environment: reports.map((report) => report.environment),
    };
    writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(reports.map((report) => ({
      run: report.run,
      connect_p50_ms: median(report.cases.connect_ms),
      get_note_p50_ms: median(report.cases.get_note_ms),
      write_note_p50_ms: median(report.cases.write_note_ms),
    })), null, 2)}\n`);
  } else {
    const show = (value) => (value === null ? "—" : `${value.toFixed(3)} ms`);
    for (const report of reports) {
      process.stdout.write(
        `  ${options.transport} run ${String(report.run)}  connect p50 ${show(median(report.cases.connect_ms))}` +
          `  get_note p50 ${show(median(report.cases.get_note_ms))}` +
          `  write_note p50 ${show(median(report.cases.write_note_ms))}` +
          `  load ${report.environment.load_average_after[0].toFixed(2)}\n`,
      );
    }
  }
  process.stdout.write(`${options.out}\n`);
}

// The pieces the companion isolation harness shares, so the two measure the
// same daemon the same way rather than each growing its own copy.
module.exports = {
  REPO,
  DIST,
  assertSafeToBuild,
  buildVault,
  median,
  ms,
  openSocketClient,
  realPathish,
  stopDaemon,
  stopDaemonsOnSignal,
  stoppingForSignal,
  track,
};

if (require.main === module) {
  main().catch((error) => {
    if (stoppingForSignal()) {
      process.stderr.write("baseline: interrupted; the signal handler is stopping the daemon\n");
      return;
    }
    process.stderr.write(
      `baseline: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
