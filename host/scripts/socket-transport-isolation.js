#!/usr/bin/env node
"use strict";
/**
 * What a client that has stopped reading costs the clients beside it.
 *
 * The fourth of the design's performance requirements needs two clients at
 * once, which `socket-transport-baseline.js` does not do: one worker, and one
 * peer that subscribes and then stops taking bytes off its socket. The number
 * is the worker's own `get_note` p50 while the peer is stalled, against its
 * single-client value, and the target is 10 percent.
 *
 * **Which single-client value, and why there are two.** Producing the stall
 * takes generations, and driving generations also grows the vault by
 * `--stall-writes` notes — so a naive before-and-after charges the daemon's
 * larger vault to the stalled peer. This run therefore takes four samples:
 * `alone` before anything is written, `control` after the same write volume
 * with nobody stalled, `beside` with the peer stalled, and `recovered` with
 * the peer reading again at the same vault size.
 *
 * **`ratio` is `beside` over `control`.** `recovered` looks like the tighter
 * control — same vault size, one variable changed — and it is reported as
 * `ratio_against_recovered`, but it is measured while the daemon is still
 * settling from handing the peer its whole backlog at once: its samples start
 * around 2.5 ms and decay for a hundred-odd requests, so its p50 lands wherever
 * the decay happened to be when the window closed and moves by a factor of 1.6
 * between runs that are otherwise identical. `control` is taken on a settled
 * daemon after the same write volume, and it is stable to about 2 percent
 * across runs, which is what makes it the honest single-client value. Both are
 * in the output; the run prints both.
 *
 *     node host/scripts/socket-transport-isolation.js \
 *       --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/iso.sqlite3 \
 *       --samples 200 --repeat 3 --out target/tmp/t7-bench/isolation.json
 *
 * **The stall has to be real, and the script proves it rather than assuming
 * it.** `socket.pause()` stops this process reading, so the daemon's writer
 * for that connection blocks, its output queue fills, its mailbox fills, and
 * the fan-out's `try_send` into its 256-deep inbox starts failing — which is
 * where a socket client's loss actually happens (`docs/design/vaultd-socket-transport.md`,
 * Slow-client). Filling that chain takes more generations than it looks: Task 8
 * measured about 800 lines absorbed on this machine before anything was
 * dropped, so `--stall-writes` defaults to 1200. When the peer is let go
 * again, this script counts what it was handed: fewer lines than there were
 * generations means the stall engaged, and the report says so either way —
 * a measurement taken behind a peer that was never actually stalled measures
 * nothing, and must not be read as a pass.
 *
 * **A third client covers the case the parked peer does not.** `beside` is taken
 * after the worker's own event stream has gone quiet, so no notice is in flight
 * while it is measured and the per-notice `try_send` into the stalled
 * connection's inbox — the mechanism the design worried about — costs nothing
 * then. So a third client reads *while* the generations are being driven, once
 * during the control writes and once during the stalled writes, and the two are
 * reported as `during_writes`. That pair is the fan-out cost; `beside` over
 * `control` is the parked-peer cost the spec's words ask for.
 *
 * Flags:
 *   --vault DIR        the fixture (default target/tmp/socket-baseline/vault)
 *   --index PATH       the engine index file (default …/iso.sqlite3)
 *   --socket PATH      the socket to bind (default beside the index)
 *   --samples N        samples per phase (default 200)
 *   --repeat N         measured runs, one daemon each (default 1)
 *   --label NAME       names the per-run files (default "run")
 *   --notes N          fixture size when it has to be built (default 1000)
 *   --stall-writes N   generations driven per phase (default 1200)
 *   --out PATH         where the report lands
 *   --binary PATH      the vaultd to measure (default target/release/vaultd)
 *   --keep-vault       measure an existing non-empty --vault outside target/
 *                      instead of refusing it. **Not read-only**: each run
 *                      creates 2×`--stall-writes` + 1 notes in that directory
 *                      and removes them when it ends.
 *   --json             print the summary as JSON as well as the table
 *   --help             print this header
 */

const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { loadavg } = require("node:os");
const { basename, dirname, extname, join, resolve } = require("node:path");
const { hrtime } = require("node:process");

const {
  REPO,
  DIST,
  assertSafeToBuild,
  buildVault,
  median,
  ms,
  openSocketClient,
  stopDaemon,
  stopDaemonsOnSignal,
  stoppingForSignal,
  track,
} = require("./socket-transport-baseline.js");

const DEFAULT_ROOT = join(REPO, "target", "tmp", "socket-baseline");

function parseArgs(argv) {
  const out = {
    samples: 200,
    repeat: 1,
    label: "run",
    notes: 1_000,
    stallWrites: 1_200,
    json: false,
    keepVault: false,
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
      case "--samples": out.samples = numeric(next(), "--samples"); break;
      case "--repeat": out.repeat = numeric(next(), "--repeat"); break;
      case "--label": out.label = next(); break;
      case "--notes": out.notes = numeric(next(), "--notes"); break;
      case "--stall-writes": out.stallWrites = numeric(next(), "--stall-writes"); break;
      case "--out": out.out = resolve(next()); break;
      case "--binary": out.binary = resolve(next()); break;
      case "--keep-vault": out.keepVault = true; break;
      case "--json": out.json = true; break;
      case "--help": case "-h": out.help = true; break;
      default: throw new Error(`unknown flag ${String(flag)}`);
    }
  }
  if (out.help) return out;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.label)) {
    throw new Error(`--label must be a plain file-name fragment, got ${out.label}`);
  }
  out.vault ??= join(DEFAULT_ROOT, "vault");
  out.index ??= join(DEFAULT_ROOT, "iso.sqlite3");
  out.out ??= join(DEFAULT_ROOT, "isolation.json");
  out.binary ??= join(REPO, "target", "release", "vaultd");
  out.socket ??= join(dirname(out.index), "i.sock");
  return out;
}

/**
 * Reads discarded before each timing window, to let the daemon settle.
 *
 * 100 because that is where the post-write decay measured on this machine has
 * flattened: the first read after a thousand generations costs about 2 ms and
 * the hundredth costs the floor.
 */
const SETTLE_READS = 100;

/** Wait until nothing has arrived for `quiet` ms, or give up at `bound`. */
async function settleQuiet(counter, quiet, bound) {
  const deadline = Date.now() + bound;
  for (;;) {
    const before = counter.seen;
    await new Promise((settle) => setTimeout(settle, quiet));
    if (counter.seen === before) return true;
    if (Date.now() > deadline) return false;
  }
}

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
  const child = track(spawn(options.binary, [
    "--vault", options.vault,
    "--index", indexPath,
    "--no-watch",
    "--reconcile-interval-seconds", "0",
    "--listen", socketPath,
  ], { stdio: ["pipe", "pipe", "inherit"] }));

  const written = [];
  let worker = null;
  let peer = null;
  let prober = null;
  try {
    const workerSeen = { seen: 0 };
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        worker = await openSocketClient(socketPath, () => { workerSeen.seen += 1; });
        break;
      } catch (error) {
        if (child.exitCode !== null) throw new Error(`the daemon exited ${String(child.exitCode)} before it answered`);
        if (Date.now() > deadline) throw error;
        await new Promise((settle) => setTimeout(settle, 25));
      }
    }

    await worker.client.request("refresh_index", {});
    const first = (await worker.client.request("list_notes", { cursor: null, limit: 1 })).items[0];
    if (!first) throw new Error(`the fixture vault at ${options.vault} has no notes`);
    // The worker is subscribed for **both** measurements, so the only thing
    // that differs between them is the stalled peer.
    await worker.client.request("subscribe_events", {});

    /**
     * Read until the daemon has settled, then take the samples.
     *
     * **The warm-up is not decoration.** Every one of these windows opens right
     * after a phase that committed a thousand generations or handed a stalled
     * peer its backlog, and the first hundred-odd reads after that decay from
     * about 2 ms to the floor — SQLite's WAL state, not the transport. Measured
     * without it, one phase's p50 lands wherever its decay had reached, and a
     * single run of this case could read anywhere from 0.66 to 1.6 on a
     * quantity whose true value is 1.0. Discarding `SETTLE_READS` first costs
     * a tenth of a second and makes the four windows comparable.
     */
    const time = async (samples) => {
      for (let at = 0; at < SETTLE_READS; at += 1) {
        await worker.client.request("get_note", { path: first.path });
      }
      const out = [];
      for (let at = 0; at < samples; at += 1) {
        const started = hrtime.bigint();
        await worker.client.request("get_note", { path: first.path });
        out.push(ms(started));
      }
      return out;
    };
    /** Commit `count` generations, each one note the run removes afterwards. */
    const drive = async (tag, count) => {
      for (let at = 0; at < count; at += 1) {
        const path = `${tag}-${options.label}-${String(run)}-${String(at).padStart(6, "0")}.md`;
        await worker.client.request("write_note", { path, content: "# s\n", expected: { absent: true } });
        written.push(path);
      }
    };

    /**
     * Drive those generations while a third client reads, and time the reads.
     *
     * This is the fan-out window: every generation is one notice offered to
     * every registered connection, so while this is running the broadcaster is
     * cloning and `try_send`ing per notice — including into a stalled
     * connection's inbox when there is one. The prober is deliberately **not**
     * subscribed: a subscriber's round trip would also be carrying its own
     * event traffic, and the question is what a *reader* pays while other
     * people's events are being fanned out.
     */
    const driveWhileReading = async (tag, count, prober) => {
      const samples = [];
      const state = { done: false };
      // The catch is attached at construction, not at the `await` below: a
      // daemon that goes away mid-phase — an interrupted run, a crash — rejects
      // this loop's request while nobody is awaiting it yet, and a floating
      // rejection takes the whole process down with an uncaught error instead of
      // the error that actually happened.
      let failure = null;
      const reading = (async () => {
        while (!state.done) {
          const started = hrtime.bigint();
          await prober.client.request("get_note", { path: first.path });
          samples.push(ms(started));
        }
      })().catch((error) => {
        failure = error;
        state.done = true;
      });
      await drive(tag, count);
      state.done = true;
      await reading;
      if (failure) throw failure;
      return samples;
    };

    prober = await openSocketClient(socketPath);
    for (let at = 0; at < 20; at += 1) await prober.client.request("get_note", { path: first.path });
    const alone = await time(options.samples);

    // **The control, and why there is one.** The stall is produced by driving
    // generations, and driving them changes two things at once: a peer backs
    // up, and the vault grows by `--stall-writes` notes that the daemon has
    // just reconciled. Measuring only before and after would charge the second
    // to the first. So the same write volume is driven once with no stalled
    // peer at all, and *that* is the single-client value the stalled case is
    // compared against; the alone-to-control ratio below is the size-and-churn
    // effect, reported separately rather than folded in.
    const duringControlWrites = await driveWhileReading("Warm", options.stallWrites, prober);
    const controlQuiet = await settleQuiet(workerSeen, 250, 60_000);
    const control = await time(options.samples);

    // A peer that subscribes and then stops reading. `pause()` leaves the
    // socket connected with nothing draining it, which is the real slow client.
    const peerSeen = { seen: 0, markers: [] };
    peer = await openSocketClient(socketPath, (envelope) => {
      peerSeen.seen += 1;
      // The reason as well as the type: the spec's requirement names
      // `runtime_recovered` in particular, and `resync_required` alone would
      // not say whether that is the one that arrived.
      const event = envelope?.event;
      const type = event?.type === undefined
        ? "unknown"
        : `${String(event.type)}${event.value?.reason ? `:${String(event.value.reason)}` : ""}`;
      if (!type.startsWith("generation_committed")) peerSeen.markers.push(type);
    });
    await peer.client.request("subscribe_events", {});
    peer.socket.pause();

    const before = await worker.client.request("get_vault_info");
    const duringStalledWrites = await driveWhileReading("Stall", options.stallWrites, prober);
    const after = await worker.client.request("get_vault_info");
    // The worker's own fan-out must have drained before the second sample, or
    // it would time the tail of the run's own events rather than `get_note`.
    const workerQuiet = await settleQuiet(workerSeen, 250, 60_000);

    const beside = await time(options.samples);

    // Let the peer go, and count what the daemon had kept for it.
    peer.socket.resume();
    const peerQuiet = await settleQuiet(peerSeen, 500, 60_000);
    const generations = after.generation - before.generation;
    // **The marker needs a carrier.** A latched gap is announced ahead of the
    // *next* notice and never on its own (Task 8, deviation 7), so with every
    // write already done the debt would stay latched and no `runtime_recovered`
    // could arrive. One more generation is both the carrier and the newest
    // generation the marker names.
    const markersBefore = peerSeen.markers.length;
    await drive("Carrier", 1);
    await settleQuiet(peerSeen, 500, 60_000);
    const markersAfterCarrier = peerSeen.markers.slice(markersBefore);

    // **The second control, at the same vault size.** The peer is connected
    // and subscribed exactly as before, and the only thing that has changed
    // since the stalled sample is that it is reading again — so this pair
    // differs in the stall alone, where the first pair also differs by
    // `--stall-writes` notes.
    const recovered = await time(options.samples);

    return {
      run,
      samples: options.samples,
      stall_writes: options.stallWrites,
      alone_p50_ms: median(alone),
      control_p50_ms: median(control),
      beside_stalled_peer_p50_ms: median(beside),
      recovered_p50_ms: median(recovered),
      // The fan-out window: a third, unsubscribed client reading while the
      // generations are driven, once with nobody stalled and once with the peer
      // stalled. This is the pair that exercises the per-notice `try_send`.
      during_writes_control_p50_ms: median(duringControlWrites),
      during_writes_stalled_peer_p50_ms: median(duringStalledWrites),
      during_writes_ratio: median(duringStalledWrites) / median(duringControlWrites),
      // The isolation number: the stalled case against a settled daemon after
      // the same write volume with nobody stalled. See the header for why the
      // same-vault-size pair is the secondary one and not this.
      ratio: median(beside) / median(control),
      ratio_against_recovered: median(beside) / median(recovered),
      ratio_against_first_measurement: median(beside) / median(alone),
      churn_ratio: median(control) / median(alone),
      alone_ms: alone,
      control_ms: control,
      beside_stalled_peer_ms: beside,
      recovered_ms: recovered,
      during_writes_control_ms: duringControlWrites,
      during_writes_stalled_peer_ms: duringStalledWrites,
      stall: {
        generations_committed: generations,
        peer_lines_seen_after_resume: peerSeen.seen,
        peer_non_commit_events: peerSeen.markers,
        peer_markers_after_the_carrier: markersAfterCarrier,
        // The stall engaged only if the daemon could not keep everything for
        // the peer. If it kept it all, nothing was ever backed up and the
        // ratio above is not a measurement of isolation.
        engaged: peerSeen.seen < generations,
        control_stream_went_quiet: controlQuiet,
        worker_stream_went_quiet: workerQuiet,
        peer_stream_went_quiet: peerQuiet,
      },
      environment: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        taken_at: new Date().toISOString(),
        load_average_before: loadBefore,
        load_average_after: loadavg(),
      },
    };
  } finally {
    if (peer) {
      peer.socket.resume();
      peer.client.close();
      peer.socket.destroy();
    }
    for (const held of [prober, worker]) {
      if (!held) continue;
      held.client.close();
      held.socket.destroy();
    }
    if (child.stdin.writable) child.stdin.end();
    const exit = await stopDaemon(child);
    for (const path of written) rmSync(join(options.vault, path), { force: true });
    rmSync(socketPath, { force: true });
    if (exit.signal === "SIGKILL") {
      process.stderr.write(`isolation: run ${String(run)} had to SIGKILL the daemon\n`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${readFileSync(__filename, "utf8").split("*/")[0]}\n`);
    return;
  }
  stopDaemonsOnSignal("isolation");
  if (!existsSync(join(DIST, "client", "client.js"))) {
    throw new Error(`the host is not built: no ${join(DIST, "client", "client.js")} — npm --prefix host run build`);
  }
  if (!existsSync(options.binary)) {
    throw new Error(`no vaultd at ${options.binary} — cargo build --release --bin vaultd, or pass --binary`);
  }
  if (existsSync(options.vault) && readdirSync(options.vault).length > 0) {
    if (!options.keepVault) assertSafeToBuild(options.vault);
    process.stdout.write(`isolation: reusing the fixture at ${options.vault}\n`);
  } else {
    assertSafeToBuild(options.vault);
    process.stdout.write(`isolation: building a ${String(options.notes)}-note fixture at ${options.vault}\n`);
    buildVault(options.vault, options.notes);
  }
  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(dirname(options.index), { recursive: true });

  const runs = [];
  for (let run = 1; run <= options.repeat; run += 1) {
    process.stdout.write(`isolation: run ${String(run)} of ${String(options.repeat)}\n`);
    const report = await measureRun(options, run);
    runs.push(report);
    process.stdout.write(
      `  first p50 ${report.alone_p50_ms.toFixed(3)} ms  control p50 ${report.control_p50_ms.toFixed(3)} ms` +
        `  beside a stalled peer ${report.beside_stalled_peer_p50_ms.toFixed(3)} ms` +
        `  recovered p50 ${report.recovered_p50_ms.toFixed(3)} ms` +
        `  ratio ${report.ratio.toFixed(3)} (against recovered ${report.ratio_against_recovered.toFixed(3)})` +
        `\n  during the writes: control ${report.during_writes_control_p50_ms.toFixed(3)} ms` +
        `  with the peer stalled ${report.during_writes_stalled_peer_p50_ms.toFixed(3)} ms` +
        `  ratio ${report.during_writes_ratio.toFixed(3)}` +
        `  stall ${report.stall.engaged ? "engaged" : "DID NOT ENGAGE"}` +
        ` (${String(report.stall.peer_lines_seen_after_resume)} of ${String(report.stall.generations_committed)} events kept)` +
        `  load ${report.environment.load_average_after[0].toFixed(2)}\n`,
    );
  }

  const summary = {
    label: options.label,
    repeat: options.repeat,
    median_alone_p50_ms: median(runs.map((run) => run.alone_p50_ms)),
    median_control_p50_ms: median(runs.map((run) => run.control_p50_ms)),
    median_beside_stalled_peer_p50_ms: median(runs.map((run) => run.beside_stalled_peer_p50_ms)),
    median_recovered_p50_ms: median(runs.map((run) => run.recovered_p50_ms)),
    median_ratio: median(runs.map((run) => run.ratio)),
    median_ratio_against_recovered: median(runs.map((run) => run.ratio_against_recovered)),
    median_during_writes_control_p50_ms: median(runs.map((run) => run.during_writes_control_p50_ms)),
    median_during_writes_stalled_peer_p50_ms: median(
      runs.map((run) => run.during_writes_stalled_peer_p50_ms),
    ),
    median_during_writes_ratio: median(runs.map((run) => run.during_writes_ratio)),
    median_churn_ratio: median(runs.map((run) => run.churn_ratio)),
    every_run_stalled: runs.every((run) => run.stall.engaged),
    runs,
  };
  writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
  if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${options.out}\n`);
}

main().catch((error) => {
  if (stoppingForSignal()) {
    process.stderr.write("isolation: interrupted; the signal handler is stopping the daemon\n");
    return;
  }
  process.stderr.write(
    `isolation: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
