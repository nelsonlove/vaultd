#!/usr/bin/env node
"use strict";
/**
 * How many chunks one response arrives in, over each of vaultd's two doors.
 *
 * A response the daemon writes in one `write(2)` reaches the client as one
 * chunk; one written fragment by fragment reaches it as many. That count is the
 * wire-side evidence for the write buffer in `connection::write_output` — before
 * it, a 902-byte `get_note` answer arrived over the socket in 15 chunks and over
 * stdio in 1; after it, 1 on both. It is a lower bound on the daemon's write
 * count, since the kernel may coalesce but does not split without cause.
 *
 *     node host/scripts/probe-chunks.js --vault target/tmp/t7-bench/vault
 *
 * The vault must already exist — `socket-transport-baseline.js` builds one — and
 * is read only: this probe writes nothing into it. Its index and socket live
 * beside it under `target/tmp/probes`.
 */

const { spawn } = require("node:child_process");
const { connect } = require("node:net");
const { existsSync, mkdirSync, readdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");

const { REPO, stopDaemon, stopDaemonsOnSignal, track } = require("./socket-transport-baseline.js");

function parseArgs(argv) {
  const out = {
    vault: join(REPO, "target", "tmp", "socket-baseline", "vault"),
    dir: join(REPO, "target", "tmp", "probes"),
    binary: join(REPO, "target", "release", "vaultd"),
  };
  for (let at = 0; at < argv.length; at += 1) {
    switch (argv[at]) {
      case "--vault": out.vault = resolve(argv[at + 1]); at += 1; break;
      case "--dir": out.dir = resolve(argv[at + 1]); at += 1; break;
      case "--binary": out.binary = resolve(argv[at + 1]); at += 1; break;
      case "--help": case "-h": out.help = true; break;
      default: throw new Error(`unknown flag ${String(argv[at])}`);
    }
  }
  return out;
}

/** Count chunks and bytes until a whole line has arrived. */
function collector(stream) {
  const state = { chunks: 0, bytes: 0, line: "", settle: null };
  stream.on("data", (chunk) => {
    state.chunks += 1;
    state.bytes += chunk.length;
    state.line += chunk.toString("utf8");
    if (state.line.includes("\n") && state.settle) {
      const done = state.settle;
      state.settle = null;
      done({ chunks: state.chunks, bytes: state.bytes });
    }
  });
  return state;
}

async function ask(state, write, request) {
  state.chunks = 0;
  state.bytes = 0;
  state.line = "";
  const answered = new Promise((settle) => { state.settle = settle; });
  write(`${JSON.stringify(request)}\n`);
  return answered;
}

async function measure(options, transport, notePath) {
  const index = join(options.dir, `chunks-${transport}.sqlite3`);
  const socketPath = join(options.dir, "c.sock");
  rmSync(index, { force: true });
  rmSync(socketPath, { force: true });
  const args = [
    "--vault", options.vault, "--index", index,
    "--no-watch", "--reconcile-interval-seconds", "0",
  ];
  if (transport === "socket") args.push("--listen", socketPath);

  let child = null;
  let stream = null;
  try {
    child = track(spawn(options.binary, args, { stdio: ["pipe", "pipe", "inherit"] }));
    let state;
    let write;
    if (transport === "stdio") {
      state = collector(child.stdout);
      write = (line) => child.stdin.write(line);
    } else {
      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          stream = connect(socketPath);
          await new Promise((settle, fail) => {
            stream.once("connect", settle);
            stream.once("error", fail);
          });
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((settle) => setTimeout(settle, 50));
        }
      }
      state = collector(stream);
      write = (line) => stream.write(line);
    }
    // The index has to be built before `get_note` can answer; the refresh's own
    // response is not measured.
    await ask(state, write, { version: 1, id: "r", request: { method: "refresh_index", params: {} } });
    const health = await ask(state, write, { version: 1, id: "h", request: { method: "health" } });
    const note = await ask(state, write, {
      version: 1, id: "n", request: { method: "get_note", params: { path: notePath } },
    });
    return { health, get_note: note };
  } finally {
    if (stream) stream.destroy();
    if (child) {
      if (child.stdin.writable) child.stdin.end();
      await stopDaemon(child);
    }
    rmSync(socketPath, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${require("node:fs").readFileSync(__filename, "utf8").split("*/")[0]}\n`);
    return;
  }
  stopDaemonsOnSignal("probe-chunks");
  if (!existsSync(options.binary)) {
    throw new Error(`no vaultd at ${options.binary} — cargo build --release --bin vaultd`);
  }
  if (!existsSync(options.vault)) {
    throw new Error(
      `no fixture at ${options.vault} — run socket-transport-baseline.js first, or pass --vault`,
    );
  }
  const note = readdirSync(options.vault).filter((name) => name.endsWith(".md")).sort()[0];
  if (!note) throw new Error(`the fixture at ${options.vault} has no notes`);
  mkdirSync(options.dir, { recursive: true });

  const stdio = await measure(options, "stdio", note);
  const socket = await measure(options, "socket", note);
  process.stdout.write(`${JSON.stringify({ note, stdio, socket }, null, 2)}\n`);
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(
      `probe-chunks: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
