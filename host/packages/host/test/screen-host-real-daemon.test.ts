/**
 * The screen host end to end (task 6 of `docs/design/web-plugins.md`): a real
 * `vaultd` over a copy of the Style Settings fixture vault, the screen host
 * connected to it, and `screen.apply` asked over the socket.
 *
 * What it proves beyond `apply-service.test.ts`: the plugin's bundle, manifest
 * and enabled state are read from the vault's own `.obsidian` through vaultd;
 * the socket's door and envelope; and that nothing is written into the vault.
 */

import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot } from "./real-daemon";
import { EXPECTED, FIXTURE, pluginOwnedClasses } from "./style-settings-run";
import { HostTestClient } from "../src/testing/host-harness";
import { buildSheetSet } from "../src/web/sheet-set";
import { defaultHostConfig, systemClock } from "../src/config";
import { startScreenHost } from "../src/screen/screen-host";
import { rejectionGuardArmed } from "../src/server/server";
import type { HostConfig } from "../src/config";
import type { Mode } from "./style-settings-run";
import type { RunningScreenHost } from "../src/screen/screen-host";

const running: RunningScreenHost[] = [];
const clients: HostTestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect();
  for (const host of running.splice(0)) await host.stop();
  await cleanupRealDaemons();
});

/** Every file under `root`, relative, with its bytes, to compare before and after. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else files.set(relative, readFileSync(join(dir, entry.name), "base64"));
    }
  };
  walk(root, "");
  return files;
}

function screenConfig(): { config: HostConfig; vault: string; state: string; stateRoot: string } {
  const vault = scratchRoot("vaultd-screen-vault-");
  cpSync(join(FIXTURE, "vault"), vault, { recursive: true });
  const state = scratchRoot("vaultd-screen-host-");
  const stateRoot = scratchRoot("vaultd-screen-viewers-");
  const config: HostConfig = {
    ...defaultHostConfig(vault),
    engine: "spawn",
    vaultdBinary: BINARY,
    dataDir: state,
    socketPath: join(state, "s"),
    clock: systemClock(),
    allowNetwork: false,
    watchdogThresholdMs: 0,
  };
  return { config, vault: config.vaultRoot, state, stateRoot };
}

async function screenHost(): Promise<{ host: RunningScreenHost; vault: string; state: string; stateRoot: string }> {
  const { config, state, stateRoot } = screenConfig();
  const host = await startScreenHost(config, { stateRoot });
  running.push(host);
  return { host, vault: config.vaultRoot, state, stateRoot };
}

/** Does any process's command line name this vault? (A spawned vaultd does.) */
function vaultdRunningFor(vault: string): boolean {
  return execFileSync("ps", ["-axo", "command"], { encoding: "utf8" })
    .split("\n")
    .some((line) => line.includes(vault) && line.includes("vaultd"));
}

function canConnect(path: string): Promise<boolean> {
  return new Promise((settle) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      settle(true);
    });
    socket.once("error", () => {
      settle(false);
    });
  });
}

async function connect(host: RunningScreenHost, state: string): Promise<HostTestClient> {
  const client = await HostTestClient.open(host.socketPath);
  clients.push(client);
  const nonce = readFileSync(join(state, "nonce"), "utf8").trim();
  const hello = await client.call<{ profile: string; plugins: string[] }>("host.hello", { nonce });
  expect(hello).toMatchObject({ profile: "screen", plugins: ["obsidian-style-settings"] });
  return client;
}

describe.skipIf(!BINARY_EXISTS)("the screen host over a real vaultd", () => {
  it("reproduces the capture in both modes over its socket, and writes nothing into the vault", async () => {
    const { host, vault, state, stateRoot } = await screenHost();
    const before = snapshot(vault);
    const client = await connect(host, state);
    const { sheets } = await buildSheetSet((path) => {
      try {
        return Promise.resolve(readFileSync(join(vault, path), "utf8"));
      } catch {
        return Promise.resolve(null);
      }
    });
    const owned = pluginOwnedClasses();
    for (const mode of ["light", "dark"] as Mode[]) {
      const result = await client.call<{ classes: string[]; style: string }>("screen.apply", {
        viewer: "alice",
        mode,
        sheets,
      });
      expect(result.style).toBe(EXPECTED.styleText[mode]);
      expect(result.classes).toEqual(EXPECTED.classes[mode].filter((name) => owned.has(name)).sort());
    }
    // Asked again: from the cache, with one load in all.
    await client.call("screen.apply", { viewer: "alice", mode: "dark", sheets });
    expect(await client.call("screen.stats")).toMatchObject({ loads: 1, hits: 1, misses: 2 });

    // The load-time prune went to the viewer's patch, outside the vault.
    expect(readdirSync(join(stateRoot, "alice"))).toEqual(["obsidian-style-settings.json"]);
    expect(snapshot(vault)).toEqual(before);
  }, 120_000);

  it("refuses a request of the wrong shape, and an unknown method", async () => {
    const { host, state } = await screenHost();
    const client = await connect(host, state);
    await expect(client.call("screen.apply", { viewer: "", mode: "dark", sheets: [] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(client.call("screen.nothing", {})).rejects.toMatchObject({ code: "invalid_request" });
  }, 120_000);

  it("refuses a connection that does not present the nonce", async () => {
    const { host } = await screenHost();
    const client = await HostTestClient.open(host.socketPath);
    clients.push(client);
    await expect(client.call("screen.apply", { viewer: "a", mode: "dark", sheets: [] })).rejects.toMatchObject({
      code: "not_owner",
    });
  }, 120_000);

  it("takes down what it started when the start fails, the spawned vaultd included", async () => {
    const { config, vault, stateRoot } = screenConfig();
    // A socket directory somebody opened up: the socket refuses to listen.
    const open = join(config.dataDir, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    await expect(startScreenHost({ ...config, socketPath: join(open, "s") }, { stateRoot })).rejects.toThrow(
      /refusing to listen/,
    );
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
    expect(rejectionGuardArmed()).toBe(false);
    expect(vaultdRunningFor(vault)).toBe(false);
  }, 120_000);

  it("stops the socket and the plugin, and the engine with them", async () => {
    const { host, vault, state } = await screenHost();
    const client = await connect(host, state);
    await client.call("screen.apply", { viewer: "alice", mode: "dark", sheets: [] });
    running.splice(running.indexOf(host), 1);
    await host.stop();
    expect(await canConnect(host.socketPath)).toBe(false);
    await expect(host.service?.apply({ viewer: "alice", mode: "dark", sheets: [] })).rejects.toThrow(/closed/);
    expect(rejectionGuardArmed()).toBe(false);
    expect(vaultdRunningFor(vault)).toBe(false);
  }, 120_000);
});
