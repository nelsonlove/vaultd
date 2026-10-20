/**
 * The screen host end to end (task 6 of `docs/design/web-plugins.md`): a real
 * `vaultd` over a copy of the Style Settings fixture vault, the screen host
 * connected to it, and `screen.apply` asked over the socket.
 *
 * What it proves beyond `apply-service.test.ts`: the plugin's bundle, manifest
 * and enabled state are read from the vault's own `.obsidian` through vaultd;
 * the socket's door and envelope; and that nothing is written into the vault.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot } from "./real-daemon";
import { EXPECTED, FIXTURE, outputText, pluginOwnedClasses } from "./style-settings-run";
import { HostTestClient } from "../src/testing/host-harness";
import { buildSheetSet } from "../src/web/sheet-set";
import { defaultHostConfig, systemClock } from "../src/config";
import { startScreenHost } from "../src/screen/screen-host";
import { rejectionGuardArmed } from "../src/server/server";
import { installFsWriteGuard } from "../src/testing/fs-guard";
import { APPLY_DEADLINE_MS, PLUGIN_LOAD_DEADLINE_MS } from "../src/screen/apply-service";
import type { HostConfig } from "../src/config";
import type { Mode } from "./style-settings-run";
import type { RunningScreenHost, ScreenHostOptions, ScreenStats } from "../src/screen/screen-host";

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

async function screenHost(
  options: ScreenHostOptions = {},
): Promise<{ host: RunningScreenHost; vault: string; state: string; stateRoot: string }> {
  const { config, state, stateRoot } = screenConfig();
  // Style Settings is named: with no `plugins` the host loads nothing.
  const host = await startScreenHost(config, { stateRoot, plugins: [STYLE_SETTINGS], ...options });
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

/** Write a vault file through the screen host's own vaultd, which announces it with `config_changed`. */
async function writeThroughVaultd(host: RunningScreenHost, path: string, text: string): Promise<void> {
  await host.client().request("write_file", {
    path,
    content_base64: Buffer.from(text, "utf8").toString("base64"),
    expected: { any: true },
  });
}

/** Wait until the host has heard `count` more `config_changed` events than `before`. */
async function heard(host: RunningScreenHost, before: ScreenStats, count = 1): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (host.stats().config_events < before.config_events + count) {
    if (Date.now() > deadline) throw new Error("no config_changed reached the screen host within 10 s");
    await new Promise((settle) => setTimeout(settle, 10));
  }
}

/** Adds a `<style>` with no id to `head` and a class to `body`, and takes both away on unload. */
const UNNAMED_STYLE_ONLOAD = `
    const el = document.createElement("style");
    el.textContent = ".extra-plugin { --extra: 1; }";
    document.head.appendChild(el);
    document.body.classList.add("extra-plugin");
    this.register(() => { el.remove(); document.body.classList.remove("extra-plugin"); });`;

/** Put a plugin of the test's own into a scratch vault (never the fixture) and enable it after the others. */
function addPlugin(vault: string, id: string, onload: string): void {
  const dir = join(vault, ".obsidian", "plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, version: "1.0.0", minAppVersion: "1.0.0" }));
  writeFileSync(
    join(dir, "main.js"),
    `"use strict";\nvar obsidian = require("obsidian");\nmodule.exports = class extends obsidian.Plugin {\n  async onload() {\n${onload}\n  }\n};\n`,
  );
  const enabledPath = join(vault, ".obsidian", "community-plugins.json");
  const enabled = JSON.parse(readFileSync(enabledPath, "utf8")) as string[];
  writeFileSync(enabledPath, JSON.stringify([...enabled, id]));
}

const STYLE_SETTINGS = "obsidian-style-settings";

/**
 * Tries every road to the vault in `onload`: an awaited note create, an
 * unawaited adapter write, a frontmatter write, and reaching the node file
 * system (it asks for `fs`, and writes nothing with it). Then
 * writes what each met into a `<style id="writer-verdict">`, as JSON.
 */
const WRITER_ONLOAD = `
    const verdict = {};
    try { await this.app.vault.create("written-by-plugin.md", "x"); verdict.create = "written"; } catch (e) { verdict.create = String(e && e.message); }
    void this.app.vault.adapter.write(".obsidian/writer-cache.json", "{}");
    try {
      const file = this.app.vault.getFileByPath ? this.app.vault.getFileByPath("note.md") : null;
      if (file === null) throw new Error("no file note.md in the screen profile's empty vault");
      await this.app.fileManager.processFrontMatter(file, (fm) => { fm.x = 1; });
      verdict.frontmatter = "written";
    } catch (e) { verdict.frontmatter = String(e && e.message); }
    try { verdict.fs = typeof require("fs").writeFileSync; } catch (e) { verdict.fs = String(e && e.message); }
    const el = document.createElement("style");
    el.id = "writer-verdict";
    el.textContent = JSON.stringify(verdict);
    document.head.appendChild(el);
    this.register(() => el.remove());`;
const SNIPPET = ".obsidian/snippets/fixture-snippet.css";
const DATA = ".obsidian/plugins/obsidian-style-settings/data.json";
const ENABLED = ".obsidian/community-plugins.json";
const MANIFEST = ".obsidian/plugins/obsidian-style-settings/manifest.json";

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
      const result = await client.call<{ classes: string[]; styles: Array<{ id: string | null; text: string }> }>("screen.apply", {
        viewer: "alice",
        mode,
        sheets,
      });
      expect(outputText(result)).toBe(EXPECTED.styleText[mode]);
      expect(result.classes).toEqual(EXPECTED.classes[mode].filter((name) => owned.has(name)).sort());
    }
    // Asked again: from the cache, with one load in all.
    await client.call("screen.apply", { viewer: "alice", mode: "dark", sheets });
    expect(await client.call("screen.stats")).toMatchObject({ loads: 1, hits: 1, misses: 2 });

    // The load-time prune went to the viewer's patch, outside the vault.
    expect(readdirSync(join(stateRoot, "alice"))).toEqual(["obsidian-style-settings.json"]);
    expect(snapshot(vault)).toEqual(before);
  }, 120_000);

  it("builds the set itself from an appearance, and a cache hit makes no vaultd request and takes no sheet text", async () => {
    const { host, state } = await screenHost({ revalidateMs: 0 });
    const client = await connect(host, state);
    const owned = pluginOwnedClasses();
    for (const mode of ["dark", "light"] as Mode[]) {
      const result = await client.call<{ classes: string[]; styles: Array<{ id: string | null; text: string }> }>("screen.apply", {
        viewer: "alice",
        mode,
        appearance: {},
      });
      expect(outputText(result)).toBe(EXPECTED.styleText[mode]);
      expect(result.classes).toEqual(EXPECTED.classes[mode].filter((name) => owned.has(name)).sort());
    }
    const before = await client.call<ScreenStats>("screen.stats");
    const again = await client.call<{ styles: Array<{ id: string | null; text: string }> }>("screen.apply", { viewer: "alice", mode: "light", appearance: {} });
    expect(outputText(again)).toBe(EXPECTED.styleText.light);
    const after = await client.call<ScreenStats>("screen.stats");
    expect(after.hits).toBe(before.hits + 1);
    expect(after.misses).toBe(before.misses);
    expect(after.vaultd_requests).toBe(before.vaultd_requests);
    expect(after.config_reads).toBe(before.config_reads);
    expect(after.sheet_bytes_received).toBe(0);
    // The explicit theme and snippet list is the same set as the vault's.
    await client.call("screen.apply", {
      viewer: "alice",
      mode: "light",
      appearance: { theme: "Fixture Theme", snippets: ["fixture-snippet"] },
    });
    const third = await client.call<ScreenStats>("screen.stats");
    expect(third.hits).toBe(after.hits + 1);
    // A bad appearance is refused.
    await expect(client.call("screen.apply", { viewer: "a", mode: "dark", appearance: { theme: "../x" } })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(client.call("screen.apply", { viewer: "a", mode: "dark" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  }, 120_000);

  it("a snippet's @settings change made through vaultd changes the next apply, with no restart", async () => {
    const { host, vault } = await screenHost({ revalidateMs: 0 });
    const first = await host.apply({ viewer: "alice", mode: "dark", appearance: {} });
    expect(outputText(first)).toContain("--sn-width: 700px");
    const before = host.stats();
    const text = readFileSync(join(vault, SNIPPET), "utf8").replace("format: px", "format: em");
    await writeThroughVaultd(host, SNIPPET, text);
    await heard(host, before);
    const next = await host.apply({ viewer: "alice", mode: "dark", appearance: {} });
    expect(outputText(next)).toContain("--sn-width: 700em");
    expect(outputText(next)).not.toContain("--sn-width: 700px");
  }, 120_000);

  it("a vault data.json change reaches a viewer with no override of that key, and not one with", async () => {
    const { host, vault, stateRoot } = await screenHost({ revalidateMs: 0 });
    // Alice overrides the width; Bob does not.
    mkdirSync(join(stateRoot, "alice"), { recursive: true, mode: 0o700 });
    writeFileSync(join(stateRoot, "alice", "obsidian-style-settings.json"), JSON.stringify({ "fixture-snippet@@sn-width": 900 }));
    expect(outputText(await host.apply({ viewer: "bob", mode: "dark", appearance: {} }))).toContain("--sn-width: 700px");
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 900px");
    const before = host.stats();
    const data = JSON.parse(readFileSync(join(vault, DATA), "utf8")) as Record<string, unknown>;
    await writeThroughVaultd(host, DATA, JSON.stringify({ ...data, "fixture-snippet@@sn-width": 820 }));
    await heard(host, before);
    expect(outputText(await host.apply({ viewer: "bob", mode: "dark", appearance: {} }))).toContain("--sn-width: 820px");
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 900px");
  }, 120_000);

  it("disabling the plugin removes the output, enabling it brings it back, and a bundle change reloads it", async () => {
    const { host, vault, state } = await screenHost({ revalidateMs: 0 });
    const client = await connect(host, state);
    const enabledText = readFileSync(join(vault, ENABLED), "utf8");
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toBe(EXPECTED.styleText.dark);

    let before = host.stats();
    await writeThroughVaultd(host, ENABLED, "[]");
    await heard(host, before);
    expect(await host.apply({ viewer: "alice", mode: "dark", appearance: {} })).toEqual({ classes: [], styles: [] });
    expect(host.plugins).toEqual([]);
    expect(host.service).toBeNull();
    // A new connection's hello says so too.
    const fresh = await HostTestClient.open(host.socketPath);
    clients.push(fresh);
    const hello = await fresh.call<{ plugins: string[] }>("host.hello", { nonce: readFileSync(join(state, "nonce"), "utf8").trim() });
    expect(hello.plugins).toEqual([]);

    before = host.stats();
    await writeThroughVaultd(host, ENABLED, enabledText);
    await heard(host, before);
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toBe(EXPECTED.styleText.dark);
    expect(host.plugins).toEqual(["obsidian-style-settings"]);

    // A changed manifest is a changed bundle: the service is replaced and the plugin loaded again.
    const service = host.service;
    before = host.stats();
    const manifest = JSON.parse(readFileSync(join(vault, MANIFEST), "utf8")) as Record<string, unknown>;
    await writeThroughVaultd(host, MANIFEST, JSON.stringify({ ...manifest, description: "changed" }));
    await heard(host, before);
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toBe(EXPECTED.styleText.dark);
    expect(host.service).not.toBe(service);
    const after = await client.call<ScreenStats>("screen.stats");
    expect(after.bundle_changes).toBe(before.bundle_changes + 1);
    expect(after.loads).toBe(1);
  }, 120_000);

  it("a change that is not the screen's raises no re-read", async () => {
    const { host } = await screenHost({ revalidateMs: 0 });
    await host.apply({ viewer: "alice", mode: "dark", appearance: {} });
    const before = host.stats();
    await writeThroughVaultd(host, ".obsidian/app.json", "{}");
    // Then one that is, so there is something to wait for.
    await writeThroughVaultd(host, ".obsidian/appearance.json", readFileSync(join(FIXTURE, "vault", ".obsidian", "appearance.json"), "utf8"));
    await heard(host, before);
    expect(host.stats().config_events).toBe(before.config_events + 1);
  }, 120_000);

  it("an edit made outside vaultd, which raises no event, shows after the re-read period", async () => {
    const { host, vault } = await screenHost({ revalidateMs: 2_000 });
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 700px");
    writeFileSync(join(vault, SNIPPET), readFileSync(join(vault, SNIPPET), "utf8").replace("format: px", "format: em"));
    // Within the period the kept set still answers.
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 700px");
    await new Promise((settle) => setTimeout(settle, 2_100));
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 700em");
    expect(host.stats().config_events).toBe(0);
  }, 120_000);

  it("an outside snippet edit is still seen when another request rebuilt a set from the new file inside the period", async () => {
    const { host, vault } = await screenHost({ revalidateMs: 1_000 });
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 700px");
    writeFileSync(join(vault, SNIPPET), readFileSync(join(vault, SNIPPET), "utf8").replace("format: px", "format: em"));
    // A different choice misses the cache and reads the edited file inside the period.
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: { snippets: ["fixture-snippet"] } }))).toContain("--sn-width: 700em");
    // The kept set for the first choice is still the old one until the check.
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 700px");
    const before = host.stats();
    await new Promise((settle) => setTimeout(settle, 1_100));
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 700em");
    expect(host.stats().config_checks).toBe(before.config_checks + 1);
  }, 120_000);

  it("an outside edit of community-plugins.json replaces the service at the next check", async () => {
    const { host, vault } = await screenHost({ revalidateMs: 500 });
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 700px");
    const service = host.service;
    expect(service).not.toBeNull();
    writeFileSync(join(vault, ENABLED), "[]");
    await new Promise((settle) => setTimeout(settle, 600));
    expect(await host.apply({ viewer: "alice", mode: "dark", appearance: {} })).toEqual({ classes: [], styles: [] });
    expect(host.service).toBeNull();
    expect(host.plugins).toEqual([]);
    expect(host.stats().config_events).toBe(0);
  }, 120_000);

  it("a vaultd read that never answers fails its request at the read timeout, the queue keeps moving, and the next request reads again", async () => {
    let hang = false;
    const { host, vault } = await screenHost({
      revalidateMs: 0,
      readTimeoutMs: 300,
      interceptRead: <T,>(path: string, read: Promise<T>): Promise<T> =>
        hang && path === ENABLED ? new Promise<T>(() => undefined) : read,
    });
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 700px");
    const before = host.stats();
    await writeThroughVaultd(host, SNIPPET, readFileSync(join(vault, SNIPPET), "utf8").replace("format: px", "format: em"));
    await heard(host, before);
    hang = true;
    const started = Date.now();
    const settled = await Promise.allSettled([
      host.apply({ viewer: "alice", mode: "dark", appearance: {} }),
      host.apply({ viewer: "bob", mode: "dark", appearance: {} }),
    ]);
    // Each one fails at its read's timeout; neither hangs.
    expect(settled.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(String((settled[0] as PromiseRejectedResult).reason)).toMatch(/took over 300 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    hang = false;
    // Still stale after the failure: the next request reads again and sees the change.
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toContain("--sn-width: 700em");
  }, 120_000);

  it("a manifest that is not valid is a reported failure, not a fatal one, and a good one brings the plugin back", async () => {
    const { host, vault } = await screenHost({ revalidateMs: 0 });
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toBe(EXPECTED.styleText.dark);
    const manifestText = readFileSync(join(vault, MANIFEST), "utf8");
    let before = host.stats();
    await writeThroughVaultd(host, MANIFEST, "{not json");
    await heard(host, before);
    // The apply still answers, with nothing from the plugin that cannot be read.
    expect(await host.apply({ viewer: "alice", mode: "dark", appearance: {} })).toEqual({ classes: [], styles: [] });
    expect(host.plugins).toEqual([]);
    expect(host.failed.map((failure) => failure.id)).toEqual(["obsidian-style-settings"]);
    expect(host.failed[0]?.reason).toMatch(/manifest of obsidian-style-settings is not JSON/);
    before = host.stats();
    await writeThroughVaultd(host, MANIFEST, JSON.stringify({ ...(JSON.parse(manifestText) as object), id: "someone-else" }));
    await heard(host, before);
    expect(await host.apply({ viewer: "alice", mode: "dark", appearance: {} })).toEqual({ classes: [], styles: [] });
    expect(host.failed[0]?.reason).toMatch(/names the id/);
    before = host.stats();
    await writeThroughVaultd(host, MANIFEST, manifestText);
    await heard(host, before);
    expect(outputText(await host.apply({ viewer: "alice", mode: "dark", appearance: {} }))).toBe(EXPECTED.styleText.dark);
    expect(host.plugins).toEqual(["obsidian-style-settings"]);
    expect(host.failed).toEqual([]);
  }, 120_000);

  it("with no plugins named it loads nothing, though the vault enables some: hello lists none and an apply answers an empty diff", async () => {
    const { config, vault, state, stateRoot } = screenConfig();
    addPlugin(vault, "extra-style", UNNAMED_STYLE_ONLOAD);
    const host = await startScreenHost(config, { stateRoot });
    running.push(host);
    expect(host.plugins).toEqual([]);
    expect(host.failed).toEqual([]);
    expect(host.service).toBeNull();
    const client = await HostTestClient.open(host.socketPath);
    clients.push(client);
    const hello = await client.call<{ plugins: string[]; failed: unknown[] }>("host.hello", { nonce: readFileSync(join(state, "nonce"), "utf8").trim() });
    expect(hello).toMatchObject({ plugins: [], failed: [] });
    expect(await client.call("screen.apply", { viewer: "alice", mode: "dark", appearance: {} })).toEqual({ classes: [], styles: [] });
    expect(await client.call("screen.stats")).toMatchObject({ loads: 0, plugins: [] });
  }, 120_000);

  it("loads every named plugin: a second plugin's <style> with no id is returned beside Style Settings'", async () => {
    const { config, vault, state, stateRoot } = screenConfig();
    addPlugin(vault, "extra-style", UNNAMED_STYLE_ONLOAD);
    const host = await startScreenHost(config, { stateRoot, plugins: [STYLE_SETTINGS, "extra-style"] });
    running.push(host);
    expect(host.plugins).toEqual(["obsidian-style-settings", "extra-style"]);
    const client = await HostTestClient.open(host.socketPath);
    clients.push(client);
    const hello = await client.call<{ plugins: string[]; failed: unknown[] }>("host.hello", { nonce: readFileSync(join(state, "nonce"), "utf8").trim() });
    expect(hello).toMatchObject({ plugins: ["obsidian-style-settings", "extra-style"], failed: [] });
    const result = await client.call<{ classes: string[]; styles: Array<{ id: string | null; text: string }> }>("screen.apply", {
      viewer: "alice",
      mode: "dark",
      appearance: {},
    });
    expect(result.styles).toEqual([
      { id: "css-settings-manager", text: EXPECTED.styleText.dark },
      { id: null, text: ".extra-plugin { --extra: 1; }" },
    ]);
    expect(result.classes).toContain("extra-plugin");
  }, 120_000);

  it("--plugins names what loads: an enabled plugin it does not name stays out, and a named one the vault does not enable too", async () => {
    const { config, vault, stateRoot } = screenConfig();
    addPlugin(vault, "extra-style", UNNAMED_STYLE_ONLOAD);
    const host = await startScreenHost(config, { stateRoot, plugins: ["extra-style", "not-enabled"] });
    running.push(host);
    expect(host.plugins).toEqual(["extra-style"]);
    expect(host.failed).toEqual([]);
    // The named plugin the vault does not enable is reported, not dropped silently.
    expect(host.unknown).toEqual(["not-enabled"]);
    expect(host.stats().unknown).toEqual(["not-enabled"]);
    expect(await host.apply({ viewer: "alice", mode: "dark", appearance: {} })).toEqual({
      classes: ["extra-plugin"],
      styles: [{ id: null, text: ".extra-plugin { --extra: 1; }" }],
    });
  }, 120_000);

  it("with --read-only it refuses every vault write a plugin tries, records it, and still serves the apply; the vault is unchanged", async () => {
    const { config, vault, state, stateRoot } = screenConfig();
    addPlugin(vault, "writer", WRITER_ONLOAD);
    const before = snapshot(vault);
    const guard = installFsWriteGuard(vault);
    try {
      const host = await startScreenHost(config, { stateRoot, plugins: [STYLE_SETTINGS, "writer"], readOnly: true });
      running.push(host);
      const writes = host.writes;
      if (writes === null) throw new Error("--read-only gave no write gate");
      const result = await host.apply({ viewer: "alice", mode: "dark", appearance: {} });
      // Served: Style Settings' output, and the writer's own style, which says what each write met.
      expect(outputText(result)).toBe(EXPECTED.styleText.dark);
      const verdict = JSON.parse(result.styles.find((style) => style.id === "writer-verdict")?.text ?? "null") as Record<string, string> | null;
      expect(verdict?.["create"]).toMatch(/screen_write_refused/);
      expect(verdict?.["frontmatter"]).toMatch(/screen_write_refused|not found|no file/i);
      expect(verdict?.["fs"]).toMatch(/refused/);
      expect(host.plugins).toEqual([STYLE_SETTINGS, "writer"]);
      expect(host.failed).toEqual([]);
      // Recorded: the awaited create and the adapter write left unawaited.
      const methods = writes.recent().map((write) => `${write.method} ${String(write.path)} ${String(write.pluginId)}`);
      expect(methods).toContain("write_note written-by-plugin.md writer");
      expect(methods).toContain("write_file .obsidian/writer-cache.json writer");
      expect(host.stats().writes_refused).toBe(writes.refusals);
      const client = await HostTestClient.open(host.socketPath);
      clients.push(client);
      await client.call("host.hello", { nonce: readFileSync(join(state, "nonce"), "utf8").trim() });
      expect(await client.call<ScreenStats>("screen.stats")).toMatchObject({ read_only: true, writes_refused: writes.refusals });
      // A second viewer with values of their own reloads every plugin, and its writes are refused again.
      mkdirSync(join(stateRoot, "bob"), { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, "bob", `${STYLE_SETTINGS}.json`), JSON.stringify({ "fixture-snippet@@sn-width": 900 }));
      const refusedBefore = writes.refusals;
      expect(outputText(await host.apply({ viewer: "bob", mode: "dark", appearance: {} }))).toContain("--sn-width: 900px");
      expect(writes.refusals).toBeGreaterThan(refusedBefore);
    } finally {
      guard.release();
    }
    expect(guard.violations()).toEqual([]);
    expect(snapshot(vault)).toEqual(before);
  }, 120_000);

  it("without --read-only a plugin's writes go through vaultd, as in the headless host", async () => {
    const { config, vault, stateRoot } = screenConfig();
    addPlugin(vault, "writer", WRITER_ONLOAD);
    const host = await startScreenHost(config, { stateRoot, plugins: [STYLE_SETTINGS, "writer"] });
    running.push(host);
    expect(host.writes).toBeNull();
    const result = await host.apply({ viewer: "alice", mode: "dark", appearance: {} });
    expect(outputText(result)).toBe(EXPECTED.styleText.dark);
    const verdict = JSON.parse(result.styles.find((style) => style.id === "writer-verdict")?.text ?? "null") as Record<string, string> | null;
    expect(verdict).toMatchObject({ create: "written", fs: "function" });
    expect(readFileSync(join(vault, "written-by-plugin.md"), "utf8")).toBe("x");
    // The unawaited adapter write lands too, once vaultd has answered it.
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(vault, ".obsidian", "writer-cache.json"))) {
      if (Date.now() > deadline) throw new Error("the adapter write never reached the vault");
      await new Promise((settle) => setTimeout(settle, 20));
    }
    expect(host.stats()).toMatchObject({ read_only: false, writes_refused: 0 });
  }, 120_000);

  it("a plugin whose onload never finishes fails alone: the others are served within the apply deadline", async () => {
    const { config, vault, stateRoot } = screenConfig();
    addPlugin(vault, "hangs", "    await new Promise(() => undefined);");
    addPlugin(vault, "extra-style", UNNAMED_STYLE_ONLOAD);
    const host = await startScreenHost(config, { stateRoot, plugins: [STYLE_SETTINGS, "hangs", "extra-style"] });
    running.push(host);
    const started = Date.now();
    const result = await host.apply({ viewer: "alice", mode: "dark", appearance: {} });
    expect(Date.now() - started).toBeLessThan(APPLY_DEADLINE_MS);
    expect(outputText(result)).toBe(EXPECTED.styleText.dark);
    expect(result.styles.map((style) => style.id)).toEqual(["css-settings-manager", null]);
    expect(host.plugins).toEqual([STYLE_SETTINGS, "extra-style"]);
    expect(host.failed.map((failure) => failure.id)).toEqual(["hangs"]);
    expect(host.failed[0]?.reason).toMatch(new RegExp(`did not finish within ${String(PLUGIN_LOAD_DEADLINE_MS)} ms`));
    // The queue is free: another viewer's reload is quick and skips the hung plugin.
    const again = Date.now();
    expect(outputText(await host.apply({ viewer: "bob", mode: "light", appearance: {} }))).toBe(EXPECTED.styleText.light);
    expect(Date.now() - again).toBeLessThan(PLUGIN_LOAD_DEADLINE_MS);
  }, 120_000);

  it("a vault enabling two plugins where one fails to load still serves the other", async () => {
    const { config, vault, state, stateRoot } = screenConfig();
    addPlugin(vault, "broken-onload", '    throw new Error("broken onload");');
    // And one whose main.js is missing, which fails at the read.
    addPlugin(vault, "no-main", "");
    rmSync(join(vault, ".obsidian", "plugins", "no-main", "main.js"));
    const host = await startScreenHost(config, { stateRoot, plugins: ["no-main", "broken-onload", STYLE_SETTINGS] });
    running.push(host);
    expect(host.failed).toEqual([{ id: "no-main", reason: "no-main has no main.js" }]);
    const result = await host.apply({ viewer: "alice", mode: "dark", appearance: {} });
    expect(outputText(result)).toBe(EXPECTED.styleText.dark);
    expect(host.plugins).toEqual(["obsidian-style-settings"]);
    expect(host.failed.map((failure) => failure.id)).toEqual(["broken-onload", "no-main"]);
    expect(host.failed[0]?.reason).toMatch(/broken onload/);
    // A new connection's hello says the same.
    const client = await HostTestClient.open(host.socketPath);
    clients.push(client);
    const hello = await client.call<{ plugins: string[]; failed: Array<{ id: string }> }>("host.hello", { nonce: readFileSync(join(state, "nonce"), "utf8").trim() });
    expect(hello.plugins).toEqual(["obsidian-style-settings"]);
    expect(hello.failed.map((failure) => failure.id)).toEqual(["broken-onload", "no-main"]);
  }, 120_000);

  it("the period's check rebuilds nothing when nothing changed, and drops only data.json when only it changed", async () => {
    const { host, vault } = await screenHost({ revalidateMs: 300 });
    expect(outputText(await host.apply({ viewer: "bob", mode: "dark", appearance: {} }))).toContain("--sn-width: 700px");
    const service = host.service;
    let before = host.stats();
    await new Promise((settle) => setTimeout(settle, 350));
    expect(outputText(await host.apply({ viewer: "bob", mode: "dark", appearance: {} }))).toContain("--sn-width: 700px");
    let after = host.stats();
    expect(after.config_checks).toBe(before.config_checks + 1);
    expect(after.config_reads).toBe(before.config_reads);
    expect(after.hits).toBe(before.hits + 1);
    expect(after.misses).toBe(before.misses);
    expect(host.service).toBe(service);
    // Edited on disk, so no event: the check finds it, and only data.json's cache goes.
    const data = JSON.parse(readFileSync(join(vault, DATA), "utf8")) as Record<string, unknown>;
    writeFileSync(join(vault, DATA), JSON.stringify({ ...data, "fixture-snippet@@sn-width": 830 }));
    before = host.stats();
    await new Promise((settle) => setTimeout(settle, 350));
    expect(outputText(await host.apply({ viewer: "bob", mode: "dark", appearance: {} }))).toContain("--sn-width: 830px");
    after = host.stats();
    expect(after.config_checks).toBe(before.config_checks + 1);
    expect(after.config_reads).toBe(before.config_reads);
    expect(host.service).toBe(service);
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
