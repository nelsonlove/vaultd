#!/usr/bin/env node
"use strict";
/**
 * What a line round trip costs over a pipe and over an AF_UNIX socket, with no
 * `vaultd` anywhere.
 *
 * It exists to answer one question the socket baseline had to answer: when the
 * socket was slower than stdio, was the kernel charging for the socket? This
 * says no — a parent and a child exchanging one line measure the same either
 * way — which is what pointed at the daemon's own writer instead.
 *
 *     node host/scripts/probe-echo.js --samples 400
 *
 * Writes one socket file under `target/tmp/probes` and removes it.
 */

const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { EventEmitter } = require("node:events");
const { mkdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { hrtime } = require("node:process");

const { REPO, median, ms } = require("./socket-transport-baseline.js");

/** The child: echo every line back, over whichever pipe it was given. */
const CHILD = [
  'const { connect } = require("node:net");',
  'const echo = (r, w) => { let buf = ""; r.on("data", (c) => { buf += c; let at;'
    + ' while ((at = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, at + 1);'
    + ' buf = buf.slice(at + 1); w.write(line); } }); };',
  'if (process.argv[1] === "pipe") echo(process.stdin, process.stdout);',
  'else { const s = connect(process.argv[2]); s.on("connect", () => echo(s, s)); }',
].join("\n");

function parseArgs(argv) {
  const out = { samples: 400, dir: join(REPO, "target", "tmp", "probes") };
  for (let at = 0; at < argv.length; at += 1) {
    switch (argv[at]) {
      case "--samples": out.samples = Number(argv[at + 1]); at += 1; break;
      case "--dir": out.dir = resolve(argv[at + 1]); at += 1; break;
      case "--help": case "-h": out.help = true; break;
      default: throw new Error(`unknown flag ${String(argv[at])}`);
    }
  }
  if (!Number.isFinite(out.samples) || out.samples < 1) throw new Error("--samples wants a positive number");
  return out;
}

/** One line out, the same line back, timed. */
function lines(stream) {
  const emitter = new EventEmitter();
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      emitter.emit("line", line);
    }
  });
  return emitter;
}

async function roundTrips(write, incoming, samples) {
  const out = [];
  for (let at = 0; at < samples; at += 1) {
    const started = hrtime.bigint();
    await new Promise((settle) => {
      incoming.once("line", settle);
      write(`{"n":${String(at)}}\n`);
    });
    out.push(ms(started));
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${require("node:fs").readFileSync(__filename, "utf8").split("*/")[0]}\n`);
    return;
  }
  mkdirSync(options.dir, { recursive: true });
  const socketPath = join(options.dir, "echo.sock");
  rmSync(socketPath, { force: true });

  const pipeChild = spawn(process.execPath, ["-e", CHILD, "pipe"], { stdio: ["pipe", "pipe", "inherit"] });
  let pipe;
  try {
    pipe = await roundTrips((line) => pipeChild.stdin.write(line), lines(pipeChild.stdout), options.samples);
  } finally {
    pipeChild.kill("SIGKILL");
  }

  const server = createServer();
  await new Promise((settle) => server.listen(socketPath, settle));
  const socketChild = spawn(process.execPath, ["-e", CHILD, "socket", socketPath], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  let socket;
  try {
    const peer = await new Promise((settle) => server.once("connection", settle));
    socket = await roundTrips((line) => peer.write(line), lines(peer), options.samples);
  } finally {
    socketChild.kill("SIGKILL");
    server.close();
    rmSync(socketPath, { force: true });
  }

  process.stdout.write(`${JSON.stringify({
    samples: options.samples,
    pipe_p50_ms: median(pipe),
    unix_socket_p50_ms: median(socket),
    ratio: median(socket) / median(pipe),
  }, null, 2)}\n`);
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(
      `probe-echo: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
