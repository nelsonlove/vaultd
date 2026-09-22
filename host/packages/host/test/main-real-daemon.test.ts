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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot } from "./real-daemon";
import { HostTestClient } from "../src/testing/host-harness";

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

    const exitCode = await new Promise<number | null>((settle) => {
      child.once("exit", (code) => settle(code));
      child.kill("SIGTERM");
    });
    expect(exitCode, stderr.join("")).toBe(0);
  }, 120_000);
});
