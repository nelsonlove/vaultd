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
 *   --base PATH      also measure Bases over this fixture base (copied into the vault as
 *                    bench.base); the default --vault becomes target/tmp/bases-baseline/vault,
 *                    a fixture built with the Bases fields (`rank`, a `#group-N` tag), never
 *                    mixed with the plain one. The five Bases cases: base_filtered_ms (a
 *                    filtered, sorted 100-row page), base_whole_vault_ms (the unfiltered page),
 *                    base_cache_hit_ms, base_change_ms and note_change_ms. The daemon runs with
 *                    --bases-cache-entries 1 and the harness alternates twin views, so every
 *                    filtered and whole-vault sample evaluates rather than hits.
 *   --search QUERY   also measure `search` for QUERY (repeatable). Per query, three series,
 *                    each printing the `total_files` of its first answer so an empty answer is
 *                    visible: search_uncached (context "none"; the daemon runs with
 *                    --search-cache-entries 1 and the harness alternates QUERY with a twin, the
 *                    same query with the case of its last ASCII letter flipped, whose canonical
 *                    spelling differs and whose answer is the same, so every sample computes);
 *                    search_cached (QUERY again and again at one generation, context "none");
 *                    and search_cached_line (the same with context "line", which reads its
 *                    page's lines from SQLite on every request, cached or not). A run whose twin
 *                    answers a different total_files is refused. Any --search builds the fixture
 *                    with the Bases fields plus the line `meeting notes` on every tenth note,
 *                    so on 10,000 notes `meeting group` answers 1,000 files, `tag:#group-3`
 *                    1,000 and `file:Note-0001` 100. The default --vault becomes
 *                    target/tmp/search-baseline/n<notes>-p<prose-bytes>/vault.
 *   --search-cache-entries N  the daemon's --search-cache-entries (default 1 with --search)
 *   --prose-bytes N  with --search, about N bytes of seeded word salad per note (from a fixed
 *                    list holding neither `meeting` nor `group`), on top of the other lines
 *   --keep-vault     measure an existing non-empty --vault outside target/ instead
 *                    of refusing it. **Not read-only**: the `write_note` case
 *                    creates `--samples` notes named `Bench-<label>-<run>-NNNNNN.md`
 *                    (plus 20 warm-up notes) in that directory and removes them
 *                    again when the run ends, so a run that is killed between the
 *                    two leaves them behind.
 *   --json           print the summary as JSON instead of a table
 */

const { Buffer } = require("node:buffer");
const { spawn } = require("node:child_process");
const { connect } = require("node:net");
const {
  existsSync,
  mkdirSync,
  readFileSync,
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
const BASES_ROOT = join(REPO, "target", "tmp", "bases-baseline");
const SEARCH_ROOT = join(REPO, "target", "tmp", "search-baseline");

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
    searches: [],
    proseBytes: 0,
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
      case "--base": out.base = resolve(next()); break;
      case "--search": {
        const query = next();
        if (query.trim() === "") throw new Error("--search wants a non-empty query");
        out.searches.push(query);
        break;
      }
      case "--search-cache-entries": out.searchCacheEntries = numeric(next(), "--search-cache-entries"); break;
      case "--prose-bytes": out.proseBytes = numeric(next(), "--prose-bytes"); break;
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
  // A Bases run measures its own fixture (the plain notes plus `rank` and a
  // tag), so its vault, index and report never share a directory with the
  // plain run's.
  if (out.base && out.searches.length > 0) {
    throw new Error("--base and --search measure different fixtures; run them separately");
  }
  if (out.proseBytes > 0 && out.searches.length === 0) {
    throw new Error("--prose-bytes shapes the search fixture; it needs --search");
  }
  if (out.searchCacheEntries !== undefined && out.searches.length === 0) {
    throw new Error("--search-cache-entries needs --search");
  }
  if (out.searches.length > 0) out.searchCacheEntries ??= 1;
  // A search run's fixture differs by size and prose, so each shape has its
  // own directory: an existing fixture is reused, never rebuilt, and a reuse
  // must never hand a 100,000-note run the 10,000-note vault.
  const root = out.base
    ? BASES_ROOT
    : out.searches.length > 0
      ? join(SEARCH_ROOT, `n${String(out.notes)}-p${String(out.proseBytes)}`)
      : DEFAULT_ROOT;
  out.vault ??= join(root, "vault");
  out.index ??= join(root, `${out.transport}.sqlite3`);
  out.out ??= join(root, `${out.transport}.json`);
  out.binary ??= join(REPO, "target", "release", "vaultd");
  // **Short, and under the repository's own `target/`.** A Unix socket path is
  // capped near 104 bytes on macOS, and the daemon refuses a longer one by
  // name; the OS tmpdir is not used because a scratch file of this run's
  // belongs with the rest of them.
  // A search fixture's directory is one level deeper, so its socket sits at
  // the search root, where a deep checkout still fits the cap.
  out.socket ??= out.searches.length > 0 ? join(SEARCH_ROOT, "b.sock") : join(dirname(out.index), "b.sock");
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
 *
 * `withBaseFields` adds what the Bases fixture base reads: a `rank` property
 * (`i % 100`) and a `#group-N` tag line (`i % 10`) in the body. Callers that
 * pass two arguments get the plain shape, byte for byte.
 */
function buildVault(root, count, withBaseFields = false, search = null) {
  mkdirSync(root, { recursive: true });
  const pad = (n) => String(n).padStart(6, "0");
  for (let i = 0; i < count; i += 1) {
    const index = pad(i);
    const rank = withBaseFields ? `rank: ${String(i % 100)}\n` : "";
    const tag = withBaseFields ? `#group-${String(i % 10)}\n\n` : "";
    const meeting = search && i % 10 === 0 ? "meeting notes\n\n" : "";
    const words = search && search.proseBytes > 0 ? `${prose(i, search.proseBytes)}\n` : "";
    writeFileSync(
      join(root, `Note-${index}.md`),
      `---\ntitle: Note ${index}\n${rank}---\n\n# Note ${index}\n\n${tag}${meeting}${words}[[Note-${pad((i + 1) % count)}]]\n`,
    );
  }
}

/**
 * The prose words: none holds `meeting`, `group` or `note`, so the answer
 * counts of the documented queries do not move with `--prose-bytes`.
 * `crates/vault-index/tests/search_timing.rs` uses the same list.
 */
const PROSE_WORDS = [
  "the", "river", "lamp", "quietly", "under", "harbor", "stone", "seven", "winter", "basket",
  "orange", "carry", "window", "between", "folded", "market", "silver", "paper", "early",
  "garden", "across", "thunder", "small", "copper", "listen", "valley", "simple", "kettle",
  "bright", "morning", "letter", "a", "of", "and", "with", "toward", "station", "maple",
];

/**
 * About `bytes` bytes of word salad, seeded by `seed` (mulberry32), in
 * paragraphs of about 400 bytes: the same bytes on every run.
 */
function prose(seed, bytes) {
  let state = (Math.imul(seed, 0x9e3779b9) + 1) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  let out = "";
  let line = 0;
  while (out.length < bytes) {
    const word = PROSE_WORDS[next() % PROSE_WORDS.length];
    out += word;
    line += word.length + 1;
    if (line > 400) {
      out += ".\n\n";
      line = 0;
    } else {
      out += " ";
    }
  }
  return `${out}\n`;
}

/**
 * QUERY with the case of its last ASCII letter flipped: a different
 * canonical spelling (the cache key), the same answer under the default
 * `match_case: false`, and the same work. The harness checks the second half
 * of that claim on every run (equal `total_files`).
 */
function searchTwin(query) {
  for (let at = query.length - 1; at >= 0; at -= 1) {
    const c = query[at];
    if (/[A-Za-z]/.test(c)) {
      const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
      return `${query.slice(0, at)}${flipped}${query.slice(at + 1)}`;
    }
  }
  throw new Error(`--search ${JSON.stringify(query)} has no ASCII letter to make an uncached twin from`);
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
  // One entry: the twin views alternate, so every measured evaluation is a
  // miss, while the cache-hit case asks one view again and again.
  if (options.base) args.push("--bases-cache-entries", "1");
  if (options.searchCacheEntries !== undefined) {
    args.push("--search-cache-entries", String(options.searchCacheEntries));
  }
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

    const cases = { connect_ms: connectMs, get_note_ms: getNoteMs, write_note_ms: writeNoteMs };
    if (options.base) {
      const baseText = readFileSync(options.base);
      await client.request("write_file", {
        path: "bench.base", content_base64: baseText.toString("base64"), expected: { any: true },
      });
      written.push("bench.base");
      const timed = async (into, count, request) => {
        for (let at = 0; at < count; at += 1) {
          const started = hrtime.bigint();
          await request(at);
          into.push(ms(started));
        }
      };
      const evaluate = (view) => client.request("evaluate_base", { path: "bench.base", view, limit: 100 });
      for (let at = 0; at < 10; at += 1) await evaluate(at % 2 ? "Filtered" : "Filtered2");
      cases.base_filtered_ms = [];
      await timed(cases.base_filtered_ms, options.samples, (at) => evaluate(at % 2 ? "Filtered" : "Filtered2"));
      cases.base_whole_vault_ms = [];
      await timed(cases.base_whole_vault_ms, Math.min(options.samples, 50), (at) => evaluate(at % 2 ? "All" : "All2"));
      // One view, asked again and again at one generation: every answer after
      // the first is the cached one (capacity 1 holds exactly it).
      await evaluate("Filtered");
      cases.base_cache_hit_ms = [];
      await timed(cases.base_cache_hit_ms, options.samples, () => evaluate("Filtered"));
      // A base change and a note change, alternated so neither runs warmer.
      cases.base_change_ms = [];
      cases.note_change_ms = [];
      const variants = [baseText, Buffer.concat([baseText, Buffer.from("\n")])];
      for (let at = 0; at < options.samples; at += 1) {
        let started = hrtime.bigint();
        await client.request("write_file", {
          path: "bench.base", content_base64: variants[at % 2].toString("base64"), expected: { any: true },
        });
        cases.base_change_ms.push(ms(started));
        const path = `${prefix}-change.md`;
        started = hrtime.bigint();
        await client.request("write_note", { path, content: `# Change ${String(at)}\n`, expected: { any: true } });
        cases.note_change_ms.push(ms(started));
        if (at === 0) written.push(path);
      }
    }

    const searchTotals = {};
    for (const query of options.searches) {
      const twin = searchTwin(query);
      const ask = (q, context) => client.request("search", { query: q, context, limit: 100 });
      const totals = {};
      const series = async (name, count, request) => {
        const into = [];
        for (let at = 0; at < count; at += 1) {
          const started = hrtime.bigint();
          const answer = await request(at);
          into.push(ms(started));
          if (at === 0) totals[name] = answer.total_files;
        }
        cases[`search[${query}] ${name}_ms`] = into;
      };
      // Warm, alternating, so the first measured sample is no colder than the rest.
      for (let at = 0; at < 10; at += 1) await ask(at % 2 ? twin : query, "none");
      const twinTotal = (await ask(twin, "none")).total_files;
      await series("search_uncached", options.samples, (at) => ask(at % 2 ? twin : query, "none"));
      if (twinTotal !== totals.search_uncached) {
        throw new Error(
          `the twin ${JSON.stringify(twin)} answers ${String(twinTotal)} files and ` +
            `${JSON.stringify(query)} ${String(totals.search_uncached)}: the uncached series is void`,
        );
      }
      // One query, asked again and again at one generation: every answer
      // after the first is the cached one (capacity 1 holds exactly it).
      await ask(query, "none");
      await series("search_cached", options.samples, () => ask(query, "none"));
      await ask(query, "line");
      await series("search_cached_line", options.samples, () => ask(query, "line"));
      searchTotals[query] = { twin, twin_total_files: twinTotal, total_files: totals };
    }

    if (options.transport === "socket") await measureConnects(socketPath, options.samples, connectMs);

    return {
      transport: options.transport,
      run,
      socket_path: info.socket_path ?? null,
      note_count: info.note_count,
      cases,
      ...(options.searches.length > 0 ? { search_totals: searchTotals } : {}),
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
    const search = options.searches.length > 0 ? { proseBytes: options.proseBytes } : null;
    buildVault(options.vault, options.notes, Boolean(options.base) || search !== null, search);
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
    // Every case the runs carry: the three transport cases, plus the five
    // Bases cases when `--base` is given.
    const names = Object.keys(reports[0].cases);
    const summary = {
      transport: options.transport,
      label: options.label,
      repeat: options.repeat,
      runs: reports.map((report) => report.report_path),
      p50_ms: Object.fromEntries(names.map((name) => [name, p50s(name)])),
      median_p50_ms: Object.fromEntries(
        names.map((name) => [name, median(p50s(name).filter((value) => value !== null))]),
      ),
      environment: reports.map((report) => report.environment),
    };
    writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
  }

  const BASE_CASES = [
    "base_filtered_ms", "base_whole_vault_ms", "base_cache_hit_ms", "base_change_ms", "note_change_ms",
  ];
  if (options.json) {
    process.stdout.write(`${JSON.stringify(reports.map((report) => ({
      run: report.run,
      connect_p50_ms: median(report.cases.connect_ms),
      get_note_p50_ms: median(report.cases.get_note_ms),
      write_note_p50_ms: median(report.cases.write_note_ms),
      ...Object.fromEntries(
        BASE_CASES.filter((name) => name in report.cases)
          .map((name) => [name.replace(/_ms$/, "_p50_ms"), median(report.cases[name])]),
      ),
      ...Object.fromEntries(
        Object.keys(report.cases).filter((name) => name.startsWith("search["))
          .map((name) => [name.replace(/_ms$/, "_p50_ms"), median(report.cases[name])]),
      ),
      ...(report.search_totals ? { search_totals: report.search_totals } : {}),
    })), null, 2)}\n`);
  } else {
    const show = (value) => (value === null ? "—" : `${value.toFixed(3)} ms`);
    for (const report of reports) {
      process.stdout.write(
        `  ${options.transport} run ${String(report.run)}  connect p50 ${show(median(report.cases.connect_ms))}` +
          `  get_note p50 ${show(median(report.cases.get_note_ms))}` +
          `  write_note p50 ${show(median(report.cases.write_note_ms))}` +
          `  load ${report.environment.load_average_after[0].toFixed(2)}` +
          `  load at start ${report.environment.load_average_before.map((value) => value.toFixed(2)).join(" ")}\n`,
      );
      for (const name of BASE_CASES.filter((name) => name in report.cases)) {
        process.stdout.write(`    ${name.replace(/_ms$/, "")} p50 ${show(median(report.cases[name]))}\n`);
      }
      for (const name of Object.keys(report.cases).filter((name) => name.startsWith("search["))) {
        const query = name.slice("search[".length, name.lastIndexOf("] "));
        const series = name.slice(name.lastIndexOf("] ") + 2).replace(/_ms$/, "");
        const sorted = [...report.cases[name]].sort((a, b) => a - b);
        const p95 = sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * 0.95))];
        process.stdout.write(
          `    ${name.replace(/_ms$/, "")} p50 ${show(median(report.cases[name]))}` +
            `  p95 ${show(p95)}  min ${show(sorted[0])}` +
            `  total_files ${String(report.search_totals[query].total_files[series])}\n`,
        );
      }
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
  prose,
  searchTwin,
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
