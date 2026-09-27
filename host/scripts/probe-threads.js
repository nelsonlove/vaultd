#!/usr/bin/env node
"use strict";
/**
 * How many threads the daemon runs, and what each connection adds.
 *
 * This is the instrument behind the socket baseline's fifth requirement — "no
 * new thread per connection beyond the four the stdio loop already has" — and it
 * counts rather than argues: `ps -M` prints one line per thread, so the deltas
 * as connections open and close are the whole measurement.
 *
 *     node host/scripts/probe-threads.js --vault target/tmp/t7-bench/vault
 *
 * The vault must already exist and is read only. The daemon is started with
 * `--listen`, so connection zero (stdin) is spawned like any other connection;
 * a daemon started *without* `--listen` runs connection zero on its main thread
 * instead, which is the same four threads counted differently.
 */

const { spawn, execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");

const {
  REPO,
  openSocketClient,
  stopDaemon,
  stopDaemonsOnSignal,
  track,
} = require("./socket-transport-baseline.js");

function parseArgs(argv) {
  const out = {
    vault: join(REPO, "target", "tmp", "socket-baseline", "vault"),
    dir: join(REPO, "target", "tmp", "probes"),
    binary: join(REPO, "target", "release", "vaultd"),
    clients: 3,
  };
  for (let at = 0; at < argv.length; at += 1) {
    switch (argv[at]) {
      case "--vault": out.vault = resolve(argv[at + 1]); at += 1; break;
      case "--dir": out.dir = resolve(argv[at + 1]); at += 1; break;
      case "--binary": out.binary = resolve(argv[at + 1]); at += 1; break;
      case "--clients": out.clients = Number(argv[at + 1]); at += 1; break;
      case "--help": case "-h": out.help = true; break;
      default: throw new Error(`unknown flag ${String(argv[at])}`);
    }
  }
  if (!Number.isFinite(out.clients) || out.clients < 1) throw new Error("--clients wants a positive number");
  return out;
}

/** One line per thread, minus the header. */
const threads = (pid) => execFileSync("/bin/ps", ["-M", "-p", String(pid)], { encoding: "utf8" })
  .trim().split("\n").length - 1;

const settle = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${require("node:fs").readFileSync(__filename, "utf8").split("*/")[0]}\n`);
    return;
  }
  stopDaemonsOnSignal("probe-threads");
  if (!existsSync(options.binary)) {
    throw new Error(`no vaultd at ${options.binary} — cargo build --release --bin vaultd`);
  }
  if (!existsSync(options.vault)) {
    throw new Error(
      `no fixture at ${options.vault} — run socket-transport-baseline.js first, or pass --vault`,
    );
  }
  mkdirSync(options.dir, { recursive: true });
  const index = join(options.dir, "threads.sqlite3");
  const socketPath = join(options.dir, "t.sock");
  rmSync(index, { force: true });
  rmSync(socketPath, { force: true });

  const counts = {};
  const open = [];
  let child = null;
  try {
    child = track(spawn(options.binary, [
      "--vault", options.vault, "--index", index,
      "--no-watch", "--reconcile-interval-seconds", "0", "--listen", socketPath,
    ], { stdio: ["pipe", "pipe", "inherit"] }));

    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        open.push(await openSocketClient(socketPath));
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await settle(50);
      }
    }
    await open[0].client.request("refresh_index", {});
    await settle(500);
    // The stdio connection is still open (this process holds the child's stdin),
    // so this is the process's own threads plus two connections' worth.
    counts.stdio_connection_plus_one_socket_connection = threads(child.pid);

    for (let at = 1; at <= options.clients; at += 1) {
      const next = await openSocketClient(socketPath);
      await next.client.request("subscribe_events", {});
      open.push(next);
      await settle(500);
      counts[`plus_${String(at)}_more`] = threads(child.pid);
    }

    for (const held of open.slice(1)) {
      held.client.close();
      held.socket.destroy();
    }
    await settle(1_000);
    counts[`after_closing_the_${String(options.clients)}`] = threads(child.pid);

    // And the process's own, with no connection at all: stdin at end of file
    // ends connection zero and nothing else.
    open[0].client.close();
    open[0].socket.destroy();
    if (child.stdin.writable) child.stdin.end();
    await settle(1_000);
    counts.no_connection_open = threads(child.pid);

    process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
  } finally {
    for (const held of open) {
      held.client.close();
      held.socket.destroy();
    }
    if (child) {
      if (child.stdin.writable) child.stdin.end();
      await stopDaemon(child);
    }
    rmSync(socketPath, { force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(
      `probe-threads: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
