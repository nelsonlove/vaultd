/**
 * Two writers, one `data.json`, and the lock that keeps either from lying.
 *
 * `PluginConfigService.set` is a read-modify-write across an `await`, and
 * `Plugin.saveData` is a blind whole-file write. The daemon cannot arbitrate
 * between them: `write_file` is whole-file, so nothing tears and nothing
 * conflicts — the loser simply disappears, and **both callers are told they
 * succeeded**. `applied` is the service's only success signal, and without a
 * lock it is not a fact about the file.
 *
 * Driven against the real `vaultd` rather than a fake, because the window is an
 * ordering property of real requests over a real socket: a fake that answers on
 * the turn it is asked can hide an interleaving the daemon will happily produce.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_KEY_REGISTRY, PluginConfigService } from "../src/settings/plugin-config";
import { Mirror } from "../src/mirror/mirror";
import { SchemaLadder } from "../src/settings/ladder";
import { assembleShim } from "../src/testing/assemble";
import { defaultHostConfig, socketPathFor, systemClock } from "../src/config";
import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot, startedOn } from "./real-daemon";
import type { HostAssembly } from "../src/testing/assemble";
import type { HostConfig } from "../src/config";
import type { Plugin, PluginManifest } from "../src/shim/plugin";

const PLUGIN_ID = "lock-probe";

/** What the plugin had saved before either writer ran. */
const PLANTED = { taskTag: "task", untouched: "keep me" };

interface Staged {
  readonly assembly: HostAssembly;
  readonly service: PluginConfigService;
  readonly plugin: Plugin;
  readonly dataFile: string;
}

function configFor(): HostConfig {
  const root = scratchRoot("vaultd-settings-lock-");
  const vault = join(root, "vault");
  mkdirSync(join(vault, ".obsidian-headless", "plugins", PLUGIN_ID), { recursive: true });
  writeFileSync(
    join(vault, ".obsidian-headless", "plugins", PLUGIN_ID, "data.json"),
    `${JSON.stringify(PLANTED, null, 2)}\n`,
    "utf8",
  );
  const index = join(root, "index.db");
  // The host's own state directory goes under the scratch root, never
  // `$XDG_STATE_HOME/vaultd-host`: this file constructs a `SchemaLadder`, and a
  // ladder pointed at the real state directory would cache into the developer's
  // home.
  const dataDir = join(root, "host-state");
  return {
    ...defaultHostConfig(vault),
    vaultdBinary: BINARY,
    vaultdArgs: ["--vault", vault, "--index", index],
    indexPath: index,
    dataDir,
    socketPath: socketPathFor(dataDir, vault),
    restartBackoffMs: [50, 50],
  };
}

/** A real engine, a real shim, a registered plugin, and a service over both. */
async function staged(): Promise<Staged> {
  const config = configFor();
  const supervisor = await startedOn(config);
  const mirror = await Mirror.open(() => supervisor.client(), config);
  const assembly = assembleShim({
    config,
    client: () => supervisor.client(),
    mirror,
    clock: systemClock(),
  });
  const manifest: PluginManifest = {
    id: PLUGIN_ID,
    name: "Lock probe",
    version: "1.0.0",
    minAppVersion: "1.0.0",
    author: "this test",
    description: "writes its own data.json while the host writes it too",
    dir: `${config.configDirName}/plugins/${PLUGIN_ID}`,
  };
  const plugin = new (class extends assembly.api.Plugin {})(assembly.app, manifest);
  assembly.app.plugins.register(plugin);
  const service = new PluginConfigService(
    assembly.dir,
    new SchemaLadder(config.dataDir, config.clock),
    DEFAULT_KEY_REGISTRY,
    config,
    // The queue **is** the lock: the same `DispatchQueue` the shim handed the
    // plugin, so `set` and `saveData` contend for one path lock rather than two.
    { plugins: assembly.app.plugins, queue: assembly.queue },
  );
  return {
    assembly,
    service,
    plugin,
    dataFile: join(config.vaultRoot, config.configDirName, "plugins", PLUGIN_ID, "data.json"),
  };
}

function onDisk(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

afterEach(cleanupRealDaemons);

describe.skipIf(!BINARY_EXISTS)("two writers of one data.json, against a real vaultd", () => {
  it("lands both of two concurrent sets on different keys", async () => {
    const { service, dataFile } = await staged();
    const [a, b] = await Promise.all([
      service.set(PLUGIN_ID, { taskTag: "from-a" }),
      service.set(PLUGIN_ID, { zeta: "from-b" }),
    ]);
    expect(a.applied).toEqual(["taskTag"]);
    expect(b.applied).toEqual(["zeta"]);
    // Measured before the lock: `taskTag` was still `"task"` — A's write was
    // gone, and A had been told it was applied.
    expect(onDisk(dataFile)).toEqual({
      taskTag: "from-a",
      untouched: "keep me",
      zeta: "from-b",
    });
  }, 120_000);

  it("loses nothing when a set races the plugin's own saveData", async () => {
    const { service, plugin, dataFile } = await staged();
    // The plugin saves first and the host's `set` follows it into the lock, so
    // the `set` reads the document the plugin *just* wrote rather than the one
    // it read before. Unlocked, the read goes out while the save is in flight
    // and the merge clobbers whatever the plugin had saved.
    const saving = plugin.saveData({ ...PLANTED, fromPlugin: true });
    const setting = service.set(PLUGIN_ID, { taskTag: "from-set" });
    const [, result] = await Promise.all([saving, setting]);
    expect(result.applied).toEqual(["taskTag"]);
    expect(onDisk(dataFile)).toEqual({
      taskTag: "from-set",
      untouched: "keep me",
      fromPlugin: true,
    });
  }, 120_000);

  // **The other half of the same lock**, and the one only `saveData`'s side can
  // give. Both writers are made to queue behind a task this case holds, so the
  // interleaving is the file's own order rather than the network's: the host's
  // `set` reads and writes, and only then does the plugin's blind whole-file
  // save land on top of it. The end state is one of the two **serial** outcomes
  // — the document the plugin saved — rather than a hybrid that never existed.
  // With `saveData` outside the lock the save slips in while `set` is still
  // waiting, `set` then merges over it, and the file ends up carrying a key the
  // plugin's save had already replaced.
  it("serializes a plugin's blind save against the host's read-modify-write", async () => {
    const { assembly, service, plugin, dataFile } = await staged();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = assembly.queue.runExclusivePath(assembly.dir.dataPath(PLUGIN_ID), () => gate);
    const setting = service.set(PLUGIN_ID, { taskTag: "from-set" });
    const saving = plugin.saveData({ ...PLANTED, fromPlugin: true });
    release();
    await Promise.all([held, setting, saving]);
    expect(onDisk(dataFile)).toEqual({ ...PLANTED, fromPlugin: true });
  }, 120_000);
});
