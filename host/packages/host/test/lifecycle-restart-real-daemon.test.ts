/**
 * Restart continuity, and the replacement of a path whose kind changed, against
 * the **real** `vaultd` — the two things a fake daemon cannot say.
 *
 * Everything else about the sequencer is pinned over a fake daemon, and that is
 * right: a fake answers instantly, in an order the test chose, and never flakes.
 * These two are different. An engine replacement is a process dying and a
 * supervisor bringing another one up, and the new engine catches up **either**
 * by a re-hydration **or** by ordinary delta batches — which of the two is not
 * something a fake chooses between, and a duplicate-delivery guard written
 * against one of them passed every fake-daemon test while replaying every event
 * a second time against a real one. A path that stops being a folder and starts
 * being a file is the same kind of fact: the wire spelling is the daemon's, not
 * a test's.
 *
 * Each case assembles the whole host by hand — supervisor, mirror, shim,
 * loader, quarantine, sequencer — over a scratch vault, and loads a **real
 * bundle** through {@link bundlePluginLoader}, which is the production seam the
 * fake-daemon harness deliberately bypasses.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot, startedOn, waitFor } from "./real-daemon";
import { BundleLoader } from "../src/runtime/loader";
import { LifecycleSequencer, bundlePluginLoader } from "../src/runtime/lifecycle";
import { Mirror } from "../src/mirror/mirror";
import { QuarantineTracker } from "../src/runtime/quarantine";
import { TFile, TFolder } from "../src/shim/files";
import { assembleShim } from "../src/testing/assemble";
import { defaultHostConfig, systemClock } from "../src/config";
import type { HostAssembly } from "../src/testing/assemble";
import type { HostConfig } from "../src/config";
import type { Supervisor } from "../src/supervisor";
import type { VaultdClient } from "../src/client/client";

/**
 * Where a loaded bundle writes what it saw.
 *
 * A bundle is compiled and run in this very process, so a global is the whole
 * of the channel — there is no serialization and nothing to poll. The name is
 * this file's own, and every case clears it before it starts.
 */
declare global {
  var __t15log: string[] | undefined;
}

function log(): string[] {
  const entries = globalThis.__t15log ?? [];
  globalThis.__t15log = entries;
  return entries;
}

/** How many times `entry` was recorded. The duplicate assertions read this. */
function timesSeen(entry: string): number {
  return log().filter((seen) => seen === entry).length;
}

/**
 * An observer plugin, as a real bundle.
 *
 * CommonJS and `require("obsidian")`, because that is what a community bundle
 * is: the loader prepends the host's own `node_modules` to the module's paths
 * and Node's ordinary resolution does the rest.
 */
const OBSERVER_BUNDLE = `
const obsidian = require("obsidian");
module.exports = class Observer extends obsidian.Plugin {
  async onload() {
    const log = (globalThis.__t15log = globalThis.__t15log || []);
    log.push("onload");
    this.registerEvent(this.app.vault.on("create", (f) => log.push("create:" + f.path)));
    this.registerEvent(this.app.vault.on("modify", (f) => log.push("modify:" + f.path)));
    this.registerEvent(this.app.vault.on("delete", (f) => log.push("delete:" + f.path)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => log.push("rename:" + old + "->" + f.path)));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => log.push("changed:" + f.path)));
    this.registerEvent(this.app.metadataCache.on("resolved", () => log.push("resolved")));
  }
};
`;

interface LiveSpec {
  files: Record<string, string>;
  config?: Partial<HostConfig>;
}

interface LiveHost {
  readonly config: HostConfig;
  readonly supervisor: Supervisor;
  readonly mirror: Mirror;
  readonly assembly: HostAssembly;
  readonly sequencer: LifecycleSequencer;
  readonly root: string;
}

/** Write a file into the scratch vault, making its parents. */
function put(root: string, path: string, contents: string): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

/**
 * The whole host over a real engine, with one real plugin installed.
 *
 * The client handed to `assembleShim` **forwards to the supervisor's current
 * one** rather than being captured. That is a test-side repair for a real gap:
 * `Mirror.open` takes a client *supplier* precisely because a connection dies
 * with its engine, and `assembleShim` takes a client. Captured, every shim read
 * after a restart — including the source the sequencer reads for a `changed`
 * event — goes to a socket nobody is listening on. Carried to Task 22, which
 * owns the production wiring.
 */
async function liveHost(spec: LiveSpec): Promise<LiveHost> {
  const root = scratchRoot("t15-lifecycle-");
  for (const [path, contents] of Object.entries(spec.files)) put(root, path, contents);

  const configDirName = ".obsidian-headless";
  const pluginDir = join(root, configDirName, "plugins", "observer");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "main.js"), OBSERVER_BUNDLE, "utf8");
  writeFileSync(
    join(pluginDir, "manifest.json"),
    JSON.stringify({ id: "observer", name: "Observer", version: "0.0.0", minAppVersion: "1.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(root, configDirName, "community-plugins.json"),
    `${JSON.stringify(["observer"], null, 2)}\n`,
    "utf8",
  );

  const dataDir = join(root, ".host-state");
  mkdirSync(dataDir, { recursive: true });
  const config: HostConfig = {
    ...defaultHostConfig(root),
    vaultdBinary: BINARY,
    dataDir,
    socketPath: join(dataDir, "host.sock"),
    clock: systemClock(),
    allowNetwork: false,
    ...spec.config,
  };

  const supervisor = await startedOn(config);
  const clientOf = (): VaultdClient => supervisor.client();
  const mirror = await Mirror.open(clientOf, config);
  await supervisor.subscribe((event) => {
    void mirror.applyEvent(event).catch(() => undefined);
  });

  // See this function's docstring: forwarding, never captured.
  const client = {
    request: <T>(method: string, params?: unknown): Promise<T> =>
      clientOf().request<T>(method, params),
  } as unknown as VaultdClient;
  const assembly = assembleShim({ config, client, mirror, clock: config.clock, dataDir });
  const loader = new BundleLoader({
    app: assembly.app,
    queue: assembly.queue,
    events: assembly.events,
    harvest: assembly.harvest,
    errors: assembly.errors,
  });
  assembly.app.plugins.setLoader(loader);
  let sequencer: LifecycleSequencer | null = null;
  const quarantine = new QuarantineTracker(config, (id, failures) => {
    if (sequencer === null) return Promise.resolve();
    return sequencer.onQuarantine(id, failures);
  });
  sequencer = new LifecycleSequencer({
    supervisor,
    mirror,
    app: assembly.app,
    harvest: assembly.harvest,
    events: assembly.events,
    errors: assembly.errors,
    dir: assembly.dir,
    coexistence: assembly.coexistence,
    quarantine,
    queue: assembly.queue,
    config,
    plugins: bundlePluginLoader({
      dir: assembly.dir,
      loader,
      config,
      // `host/node_modules`, which is where the workspace links `obsidian` and
      // `electron`. From this file that is three levels up.
      hostModulePaths: [resolve(__dirname, "..", "..", "..", "node_modules")],
    }),
  });
  return { config, supervisor, mirror, assembly, sequencer, root };
}

/** Kill the engine outright and wait for the supervisor to bring a new one up. */
async function killAndRecover(host: LiveHost): Promise<void> {
  const pid = host.supervisor.pid();
  expect(pid).not.toBeNull();
  const before = host.supervisor.restartCount();
  process.kill(pid as number, "SIGKILL");
  await waitFor(
    "the supervisor to replace the engine",
    () => host.supervisor.restartCount() > before && host.supervisor.state() === "running",
    () =>
      `state=${host.supervisor.state()}, restarts=${String(host.supervisor.restartCount())}, ` +
      `lastError=${host.supervisor.lastError()?.message ?? "none"}`,
    30_000,
  );
  await host.supervisor.whenWatching();
}

/** Wait until the mirror holds `predicate`, then let the sequencer finish. */
async function settled(host: LiveHost, what: string, predicate: () => boolean): Promise<void> {
  await waitFor(
    what,
    () => predicate() && !host.mirror.resyncing(),
    () =>
      `the mirror is at generation ${String(host.mirror.generation())}, applied through ` +
      `${String(host.mirror.appliedThrough())}, resyncing=${String(host.mirror.resyncing())}; ` +
      `the log holds ${JSON.stringify(log())}`,
    30_000,
  );
  await host.sequencer.settled();
}

afterEach(async () => {
  await cleanupRealDaemons();
  globalThis.__t15log = undefined;
});

describe.skipIf(!BINARY_EXISTS)("engine restart continuity, against a real vaultd", () => {
  it("keeps plugins loaded and delivers the recovery exactly once", async () => {
    globalThis.__t15log = [];
    const host = await liveHost({
      files: { "A.md": "# A\n", "Gone.md": "x\n" },
    });
    await host.sequencer.start();
    expect(timesSeen("onload")).toBe(1);
    const previous = host.mirror.snapshotRevisions();

    // Everything moves while nothing is watching, which is the whole point: the
    // new engine has to reconcile on startup, and how it chooses to report that
    // — a re-hydration or a run of ordinary deltas — is the daemon's business.
    await killAndRecover(host);
    put(host.root, "A.md", "# A changed\n");
    put(host.root, "New.md", "fresh\n");
    rmSync(join(host.root, "Gone.md"));

    await settled(
      host,
      "the recovered mirror to hold New.md and to have forgotten Gone.md",
      () => host.mirror.entry("New.md") !== undefined && host.mirror.entry("Gone.md") === undefined,
    );
    // The caller that noticed the restart is holding the map from before it.
    await host.sequencer.onEngineRestart(previous);
    await host.sequencer.settled();

    // **Exactly once each.** Before this round the duplicate guard watermarked
    // synthetic batches alone; a recovery that arrived as ordinary deltas left
    // it untouched, the guard passed, and every one of these was delivered a
    // second time — a `create` for a file the plugin already holds, which is
    // the shape that double-inserts into a plugin's own index.
    expect(timesSeen("create:New.md")).toBe(1);
    expect(timesSeen("delete:Gone.md")).toBe(1);
    expect(timesSeen("modify:A.md")).toBe(1);
    expect(timesSeen("changed:A.md")).toBe(1);
    // No `onunload` and no second `onload`: Ruling 7's whole claim.
    expect(timesSeen("onload")).toBe(1);
    expect(host.sequencer.phase()).toBe("steady");
    expect(host.assembly.app.plugins.getPlugin("observer")).not.toBeNull();
  }, 60_000);

  it("reloads plugins across a real restart when the knob is set", async () => {
    globalThis.__t15log = [];
    const host = await liveHost({
      files: { "A.md": "# A\n" },
      config: { reloadPluginsOnEngineRestart: true },
    });
    await host.sequencer.start();
    expect(timesSeen("onload")).toBe(1);
    const previous = host.mirror.snapshotRevisions();
    await killAndRecover(host);
    await settled(host, "the recovered mirror to be quiet", () => host.mirror.generation() > 0);
    await host.sequencer.onEngineRestart(previous);
    await host.sequencer.settled();
    expect(timesSeen("onload")).toBe(2);
    // The reloaded instance gets a `resolved`, because its `onLayoutReady` ran
    // immediately — the latch does not unflip — and its gate has to open again.
    expect(timesSeen("resolved")).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("reports a folder replaced by a file as a delete and a create", async () => {
    globalThis.__t15log = [];
    const host = await liveHost({
      files: { "A.md": "# A\n", "Swap/Inner.md": "inner\n" },
    });
    await host.sequencer.start();
    expect(host.assembly.app.vault.getAbstractFileByPath("Swap")).toBeInstanceOf(TFolder);
    const previous = host.mirror.snapshotRevisions();

    // While nothing is watching, so the change arrives as one reconciliation
    // rather than as a delete and a create the watcher happened to separate.
    await killAndRecover(host);
    rmSync(join(host.root, "Swap"), { recursive: true, force: true });
    writeFileSync(join(host.root, "Swap"), "now a file\n", "utf8");

    await settled(
      host,
      "the recovered mirror to hold Swap as a file",
      () => host.mirror.entry("Swap")?.kind !== "folder",
    );
    await host.sequencer.onEngineRestart(previous);
    await host.sequencer.settled();

    // The daemon has no "this path changed kind" verb: every measurement of
    // this shape reported `Swap` as **modified**, which the file index used to
    // drop on the floor — no event, and a `TFolder` left at a path the daemon
    // says is a file for the rest of the session.
    expect(timesSeen("delete:Swap")).toBe(1);
    expect(timesSeen("create:Swap")).toBe(1);
    expect(timesSeen("delete:Swap/Inner.md")).toBe(1);
    expect(host.assembly.app.vault.getAbstractFileByPath("Swap")).toBeInstanceOf(TFile);
  }, 60_000);

  it("reports a file replaced by a folder as a delete and a create", async () => {
    globalThis.__t15log = [];
    const host = await liveHost({
      files: { "A.md": "# A\n", "Swap": "a file\n" },
    });
    await host.sequencer.start();
    expect(host.assembly.app.vault.getAbstractFileByPath("Swap")).toBeInstanceOf(TFile);
    const previous = host.mirror.snapshotRevisions();

    await killAndRecover(host);
    rmSync(join(host.root, "Swap"));
    put(host.root, "Swap/Inner.md", "inner\n");

    await settled(
      host,
      "the recovered mirror to hold Swap as a folder",
      () => host.mirror.entry("Swap")?.kind === "folder",
    );
    await host.sequencer.onEngineRestart(previous);
    await host.sequencer.settled();

    expect(timesSeen("delete:Swap")).toBe(1);
    expect(timesSeen("create:Swap")).toBe(1);
    expect(timesSeen("create:Swap/Inner.md")).toBe(1);
    expect(host.assembly.app.vault.getAbstractFileByPath("Swap")).toBeInstanceOf(TFolder);
  }, 60_000);
});
