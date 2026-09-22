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
import { HostTestClient } from "../src/testing/host-harness";
import { goldenRoot } from "../src/testing/live-host";

/** The compiled entry point `package.json`'s `bin` names. */
const MAIN = resolve(__dirname, "..", "dist", "main.js");

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
    expect(
      existsSync(MAIN),
      `${MAIN} is missing — run \`npm --prefix host run build\` (the same build \`npm test\`'s pretest does)`,
    ).toBe(true);

    const vault = scratchRoot("vaultd-main-");
    writeFileSync(join(vault, "A.md"), "# A\n", "utf8");
    const state = scratchRoot("vaultd-main-state-");
    const socketDir = shortSocketDir();
    const socketPath = join(socketDir, "s");

    const child = spawn(
      process.execPath,
      [MAIN, "--vault", vault, "--vaultd", BINARY, "--socket", socketPath],
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
      [MAIN, "--vault", vault, "--vaultd", BINARY, "--socket", socketPath],
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
  readonly loaded: readonly string[];
}

/** Resolve with the binary's one machine-readable ready line. */
function readyLine(child: ChildProcess, stderr: string[]): Promise<ReadyLine> {
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
