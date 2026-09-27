/**
 * The binary, end to end: `vaultd-host` over a real `vaultd`, answering
 * `host.hello` on its own socket and exiting 0 on `SIGTERM`.
 *
 * This is the one case in the suite that runs the **compiled** host as a
 * separate process, which is the only way to prove the two things a library
 * test cannot: that `dist/main.js` is a working entry point (the `bin` in
 * `package.json` points at it), and that the signal handler takes the whole
 * host down cleanly rather than leaving a daemon, a socket or a worker behind.
 *
 * `XDG_STATE_HOME` is redirected into a scratch directory, so the binary's
 * default state directory — nonce, `localStorage`, stall reports — lands there
 * and never in the developer's home. The socket is named explicitly and kept
 * short: a Unix socket address is capped at about 104 bytes on Darwin and the
 * default `<state>/run/<digest>/host.sock` under a scratch root is past it.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot } from "./real-daemon";
import { defaultHostConfig } from "../src/config";
import { HostTestClient } from "../src/testing/host-harness";
import { goldenRoot } from "../src/testing/live-host";

/** The compiled entry point `package.json`'s `bin` names. */
const MAIN = resolve(__dirname, "..", "dist", "main.js");

/**
 * Refuse to run against a missing build, by name.
 *
 * Every case in this file spawns `dist/main.js`, and without this the failure
 * is a `MODULE_NOT_FOUND` on the child's stderr wrapped in whatever the case
 * happened to be waiting for. `npm test` cannot reach it — its `pretest`
 * (`scripts/warm-fixtures.js`) compiles the host with `tsc --build` before
 * vitest starts — but a bare `vitest` run can, and that is the run where the
 * message has to say what to do.
 */
function requireBuild(): void {
  expect(
    existsSync(MAIN),
    `${MAIN} is missing — run \`npm --prefix host run build\` (the same build \`npm test\`'s pretest does)`,
  ).toBe(true);
}

/** A short directory for the socket: everything after it counts against ~104 bytes. */
function shortSocketDir(): string {
  const root = resolve(__dirname, "..", "..", "..", "target", "tmp");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, `m-${String(process.pid)}-${String(Date.now()).slice(-6)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

afterEach(async () => {
  await cleanupRealDaemons();
});

describe.skipIf(!BINARY_EXISTS)("the vaultd-host binary", () => {
  it("starts on a scratch vault, answers host.hello, and exits 0 on SIGTERM", async () => {
    requireBuild();

    const vault = scratchRoot("vaultd-main-");
    writeFileSync(join(vault, "A.md"), "# A\n", "utf8");
    const state = scratchRoot("vaultd-main-state-");
    const socketDir = shortSocketDir();
    const socketPath = join(socketDir, "s");

    // `--engine spawn` for the reason `test/real-daemon.ts` gives: the default
    // `auto` would bind an engine socket under the developer's own XDG run
    // directory and leave a shareable daemon behind, and this case is about
    // the binary's ready line and its exit code.
    const child = spawn(
      process.execPath,
      [MAIN, "--vault", vault, "--vaultd", BINARY, "--socket", socketPath, "--engine", "spawn"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, XDG_STATE_HOME: state },
      },
    );

    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

    const ready = await new Promise<{ ready: boolean; socket: string; vault: string }>(
      (settle, reject) => {
        let buffered = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `the binary printed no ready line within 30s. stdout=${JSON.stringify(buffered)} ` +
                `stderr=${JSON.stringify(stderr.join(""))}`,
            ),
          );
        }, 30_000);
        child.stdout?.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          const line = buffered.split("\n").find((candidate) => candidate.startsWith("{"));
          if (line === undefined) return;
          clearTimeout(timer);
          settle(JSON.parse(line) as { ready: boolean; socket: string; vault: string });
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(
            new Error(
              `the binary exited with ${String(code)} before printing a ready line. ` +
                `stderr=${JSON.stringify(stderr.join(""))}`,
            ),
          );
        });
      },
    );

    expect(ready.ready).toBe(true);
    expect(ready.socket).toBe(socketPath);
    expect(ready.vault).toBe(vault);

    // The nonce lives in the state directory the binary derived from
    // XDG_STATE_HOME, which is the proof that it wrote its own state where it
    // was told to and not into the vault.
    const nonce = readFileSync(join(state, "vaultd-host", "nonce"), "utf8").trim();
    const client = await HostTestClient.open(socketPath);
    const hello = await client.call<{ protocol_version: number; vault_root: string }>(
      "host.hello",
      { nonce },
    );
    expect(hello.vault_root).toBe(vault);
    await client.disconnect();

    const exitCode = await terminate(child);
    expect(exitCode, stderr.join("")).toBe(0);
  }, 120_000);

  it("exits 0 on SIGTERM with a plugin's async work still in flight", async () => {
    // **The case the first round could not see.** The committed pin ran a vault
    // with no plugins, which is the degenerate shutdown: nothing of anyone's is
    // in flight, so the ordering that the exit code depends on is never
    // exercised. Measured at review: with folder-notes busy, `SIGTERM` 500 ms
    // after its command exited **1**, from `ReferenceError: window is not
    // defined` in the plugin's retry loop waking after the host had restored
    // the globals. Waiting 15 s instead exited 0 — which is what "a race, not a
    // behaviour" looks like.
    //
    // folder-notes rather than a hand-written stand-in, because the loop that
    // broke it is its own: `addCSSClassToFileExplorerEl` retries on
    // `window.setTimeout` for a file-explorer element a headless host will
    // never have.
    const vault = scratchRoot("vaultd-main-busy-");
    mkdirSync(join(vault, "Project"), { recursive: true });
    writeFileSync(join(vault, "Project", "Existing note.md"), "A note.\n", "utf8");
    installGolden(vault, "folder-notes");
    const state = scratchRoot("vaultd-main-busy-state-");
    const socketDir = shortSocketDir();
    const socketPath = join(socketDir, "s");

    const child = spawn(
      process.execPath,
      [MAIN, "--vault", vault, "--vaultd", BINARY, "--socket", socketPath, "--engine", "spawn"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: state } },
    );
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    const ready = await readyLine(child, stderr);
    expect(ready.loaded, stderr.join("")).toEqual(["folder-notes"]);

    const nonce = readFileSync(join(state, "vaultd-host", "nonce"), "utf8").trim();
    const client = await HostTestClient.open(socketPath);
    await client.call("host.hello", { nonce });
    // The command whose handler arms the retry loop. `checkCallback`, so it
    // needs the note it acts on named.
    await client.call("host.invoke_command", {
      command_id: "folder-notes:create-folder-note-for-current-folder",
      active_file: "Project/Existing note.md",
    });
    await client.disconnect();

    // **500 ms, which is the measured red window.** Long enough for the
    // plugin's loop to be parked on a timer, short enough that it has not given
    // up: the review's own table has 500 ms failing twice and 15 s passing.
    await new Promise<void>((settle) => setTimeout(settle, 500));

    const exitCode = await terminate(child);
    expect(exitCode, `stderr:\n${stderr.join("")}`).toBe(0);
  }, 120_000);

  it("exits 3 under --engine connect when nothing is listening", async () => {
    // **The exit code is read off the process, not off a thrown refusal.**
    // `test/main.test.ts` already drives `runHost` in-process and asserts the
    // `CliRefusal`'s `code`; what that cannot show is that the code survives
    // `main`'s catch, the `finally`, and the entry point's `process.exitCode`
    // assignment — which is the half a script branches on. So this case runs
    // `dist/main.js` and waits for the real exit status.
    //
    // No daemon is involved and none is spawned, which is the point of the
    // mode: `connect` probes and refuses. The probe path is derived from the
    // vault root, and the root is a fresh scratch directory, so nothing else
    // in the suite can be listening there. `XDG_RUNTIME_DIR` is the scratch
    // one `test/scratch-setup.ts` installs and the child inherits it.
    requireBuild();
    const vault = scratchRoot("vaultd-main-connect-");
    writeFileSync(join(vault, "One.md"), "# One\n", "utf8");
    const state = scratchRoot("vaultd-main-connect-state-");
    const socketPath = join(shortSocketDir(), "s");

    const child = spawn(
      process.execPath,
      [MAIN, "--vault", vault, "--vaultd", BINARY, "--engine", "connect", "--socket", socketPath],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: state } },
    );
    const finished = await untilExit(child);

    expect(finished.code, `stderr:\n${finished.stderr}`).toBe(3);
    expect(finished.stderr).toMatch(/no vaultd is listening/i);
    expect(finished.stderr).toContain('engine: "connect" never spawns one');
    // Nothing reached the ready line, so there is no machine-readable line on
    // stdout to mislead a caller that only reads the first `{`.
    expect(finished.stdout.split("\n").filter((line) => line.startsWith("{"))).toEqual([]);
  }, 120_000);

  it("refuses an --engine value that is not one of the three", async () => {
    requireBuild();
    const child = spawn(process.execPath, [MAIN, "--vault", ".", "--engine", "borrow"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    const finished = await untilExit(child);

    expect(finished.code, `stderr:\n${finished.stderr}`).toBe(2);
    expect(finished.stderr).toContain("--engine must be auto, connect or spawn");
    // A usage error prints the contract it broke.
    expect(finished.stderr).toContain("Exit codes:");
  }, 60_000);

  it("says on its ready line where its engine came from, and prints nothing else", async () => {
    requireBuild();
    const vault = scratchRoot("vaultd-main-ready-");
    writeFileSync(join(vault, "One.md"), "# One\n", "utf8");
    const state = scratchRoot("vaultd-main-ready-state-");
    const socketPath = join(shortSocketDir(), "s");

    // `spawn`, which is also the mode where `engine_socket` must be `null`:
    // nothing is probed, the daemon gets no `--listen`, and the path the
    // config still holds names a socket that will never exist.
    const child = spawn(
      process.execPath,
      [MAIN, "--vault", vault, "--vaultd", BINARY, "--engine", "spawn", "--socket", socketPath],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: state } },
    );
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    const out = { text: "" };

    // **The terminate is in a `finally`.** Between the ready line and the
    // signal there are assertions, and an assertion that throws would
    // otherwise leave a host and its daemon running for the rest of the
    // session — which is exactly what a deliberate mutation of the ready line
    // produced while this case was being proved able to fail.
    let exitCode: number | null = null;
    try {
      const ready = await readyLine(child, stderr, out);
      expect(ready.ready).toBe(true);
      expect(ready.engine_source, stderr.join("")).toBe("spawned");
      // The ruling: the key stays, the value tells the truth.
      expect(ready.engine_socket).toBeNull();

      // **The whole shape, as an exact sorted key list.** Three fields
      // asserted by name leaves a silently dropped `dry_run` or `socket`
      // passing, and this line is the binary's entire machine-readable
      // interface — the same reason `host.info`'s `engine` object is pinned
      // key by key rather than by `toMatchObject`.
      expect(Object.keys(ready).sort()).toEqual([
        "dry_run",
        "engine_socket",
        "engine_source",
        "failed",
        "loaded",
        "ready",
        "socket",
        "vault",
      ]);

      // **One line, and it came before the host served.** Prove the host is
      // serving — a `host.hello` on its own socket — and only then count what
      // reached stdout, so a second line printed on the way up is already in
      // the buffer by the time it is read.
      const nonce = readFileSync(join(state, "vaultd-host", "nonce"), "utf8").trim();
      const client = await HostTestClient.open(socketPath);
      await client.call("host.hello", { nonce });
      await client.disconnect();
      expect(out.text.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
    } finally {
      exitCode = await terminate(child);
    }
    expect(exitCode, stderr.join("")).toBe(0);
  }, 120_000);

  it("names the engine socket under auto and under connect, and both name the same one", async () => {
    requireBuild();
    const vault = scratchRoot("vaultd-main-share-");
    writeFileSync(join(vault, "One.md"), "# One\n", "utf8");
    // The path the daemon will bind, derived here exactly as the child derives
    // it: from the canonical vault root, under the scratch `XDG_RUNTIME_DIR`
    // that `test/scratch-setup.ts` installs and the children inherit.
    const engineSocket = defaultHostConfig(vault).engineSocketPath;

    const ownerState = scratchRoot("vaultd-main-share-a-");
    const guestState = scratchRoot("vaultd-main-share-b-");
    const ownerSocket = join(shortSocketDir(), "s");
    const guestSocket = join(shortSocketDir(), "s");
    const ownerErr: string[] = [];
    const guestErr: string[] = [];

    const owner = spawn(
      process.execPath,
      [MAIN, "--vault", vault, "--vaultd", BINARY, "--engine", "auto", "--socket", ownerSocket],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: ownerState } },
    );
    owner.stderr?.on("data", (chunk: Buffer) => ownerErr.push(chunk.toString("utf8")));
    let guest: ChildProcess | null = null;
    try {
      const ownerReady = await readyLine(owner, ownerErr);
      // `auto` with nothing listening spawns, and gives the daemon it spawns
      // `--listen`, so the path is real and the line says so.
      expect(ownerReady.engine_source, ownerErr.join("")).toBe("spawned");
      expect(ownerReady.engine_socket).toBe(engineSocket);

      guest = spawn(
        process.execPath,
        [MAIN, "--vault", vault, "--vaultd", BINARY, "--engine", "connect", "--socket", guestSocket],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: guestState } },
      );
      guest.stderr?.on("data", (chunk: Buffer) => guestErr.push(chunk.toString("utf8")));
      const guestReady = await readyLine(guest, guestErr);
      expect(guestReady.engine_source, guestErr.join("")).toBe("connected");
      expect(guestReady.engine_socket).toBe(engineSocket);
    } finally {
      // The guest first: it holds a connection to the owner's daemon, and the
      // owner's shutdown is what takes that daemon down.
      if (guest) expect(await terminate(guest), guestErr.join("")).toBe(0);
      expect(await terminate(owner), ownerErr.join("")).toBe(0);
    }
  }, 180_000);
});

/** Copy a golden plugin's bundle into the vault's headless config dir, enabled. */
function installGolden(vault: string, id: string): void {
  const target = join(vault, ".obsidian-headless", "plugins", id);
  mkdirSync(target, { recursive: true });
  cpSync(join(goldenRoot(), id, "plugin"), target, { recursive: true });
  writeFileSync(
    join(vault, ".obsidian-headless", "community-plugins.json"),
    `${JSON.stringify([id], null, 2)}\n`,
    "utf8",
  );
}

interface ReadyLine {
  readonly ready: boolean;
  readonly socket: string;
  readonly vault: string;
  readonly engine_source: string;
  readonly engine_socket: string | null;
  readonly loaded: readonly string[];
}

/** Everything a finished child said, and the status it said it with. */
interface Finished {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Wait for a child to exit on its own, with a deadline that kills rather than
 * hangs.
 *
 * Both pipes are drained and the `close` event is awaited rather than `exit`,
 * so the output is complete before it is asserted on: `exit` can arrive with
 * the last chunk of stderr still buffered, which would make a message
 * assertion a race.
 */
function untilExit(child: ChildProcess, timeoutMs = 30_000): Promise<Finished> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return new Promise<Finished>((settle, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `the binary was still running after ${String(timeoutMs)}ms. ` +
            `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
        ),
      );
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      settle({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Resolve with the binary's one machine-readable ready line.
 *
 * `sink` keeps receiving everything stdout produces, for the life of the
 * child and not only up to the ready line, so a caller can assert that the
 * line it settled on was the *only* one.
 */
function readyLine(
  child: ChildProcess,
  stderr: string[],
  sink?: { text: string },
): Promise<ReadyLine> {
  return new Promise<ReadyLine>((settle, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `the binary printed no ready line within 30s. stdout=${JSON.stringify(buffered)} ` +
            `stderr=${JSON.stringify(stderr.join(""))}`,
        ),
      );
    }, 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (sink) sink.text = buffered;
      const line = buffered.split("\n").find((candidate) => candidate.startsWith("{"));
      if (line === undefined) return;
      clearTimeout(timer);
      settle(JSON.parse(line) as ReadyLine);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the binary exited with ${String(code)} before printing a ready line. ` +
            `stderr=${JSON.stringify(stderr.join(""))}`,
        ),
      );
    });
  });
}

/** `SIGTERM`, and the exit code it produced. */
function terminate(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((settle) => {
    child.once("exit", (code) => settle(code));
    child.kill("SIGTERM");
  });
}
