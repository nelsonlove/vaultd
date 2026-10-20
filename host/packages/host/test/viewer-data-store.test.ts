import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fs } from "../src/runtime/fs-access";
import { installFsWriteGuard } from "../src/testing/fs-guard";
import { ShimHarness } from "../src/testing/shim-harness";
import { installPluginHost, pluginHostFor } from "../src/shim/plugin";
import type { PluginHostContext } from "../src/shim/plugin";
import { ViewerDataStore, viewerStateRoot } from "../src/shim/viewer-data-store";
import { diffMergePatch, mergePatch } from "../src/shim/merge-patch";
import { scratchRoot } from "./scratch";

const VAULT_DATA = ".obsidian/plugins/demo/data.json";

interface Rig {
  readonly harness: ShimHarness;
  readonly sent: string[];
  readonly stateRoot: string;
  readonly vaultRoot: string;
  store(viewerId: string): ViewerDataStore;
  setVault(doc: unknown): void;
  patchFile(viewerId: string): string;
}

/** A host whose write gate counts every mutation it is asked to send. */
async function rig(): Promise<Rig> {
  const harness = await ShimHarness.withVault({});
  const real = pluginHostFor(harness.app);
  const sent: string[] = [];
  const writes = {
    ...real.writes,
    send: (method: string): Promise<never> => {
      sent.push(method);
      return Promise.reject(new Error(`the viewer store sent a vaultd mutation: ${method}`));
    },
  } as unknown as PluginHostContext["writes"];
  const host: PluginHostContext = { ...real, writes };
  // No vault data.json until a case sets one: the daemon answers not_found.
  harness.unserveFile(VAULT_DATA);
  const stateRoot = scratchRoot("vaultd-viewer-state-");
  const vaultRoot = scratchRoot("vaultd-viewer-vault-");
  return {
    harness,
    sent,
    stateRoot,
    vaultRoot,
    store: (viewerId) => new ViewerDataStore({ host, viewerId, stateRoot }),
    setVault: (doc) => harness.setConfigFile(VAULT_DATA, JSON.stringify(doc)),
    patchFile: (viewerId) => join(stateRoot, viewerId, "demo.json"),
  };
}

const read = (path: string): unknown => JSON.parse(fs.readFileSync(path, "utf8")) as unknown;

describe("ViewerDataStore", () => {
  it("stores only the patch, and reads back the saved document", async () => {
    const r = await rig();
    r.setVault({ a: 1, b: { c: 2, d: 3 }, list: [1, 2] });
    const store = r.store("ann");
    await store.save("demo", { a: 1, b: { c: 20, d: 3 }, list: [1, 2], extra: true });
    expect(read(r.patchFile("ann"))).toEqual({ b: { c: 20 }, extra: true });
    await expect(store.load("demo")).resolves.toEqual({
      a: 1,
      b: { c: 20, d: 3 },
      list: [1, 2],
      extra: true,
    });
  });

  it("shows a changed vault value for a key the viewer did not override, and keeps an override", async () => {
    const r = await rig();
    r.setVault({ a: 1, b: 2 });
    const store = r.store("ann");
    await store.save("demo", { a: 1, b: 99 });
    r.setVault({ a: 5, b: 7 });
    await expect(store.load("demo")).resolves.toEqual({ a: 5, b: 99 });
  });

  it("removes the patch file when a save equals the vault document", async () => {
    const r = await rig();
    r.setVault({ a: 1 });
    const store = r.store("ann");
    await store.save("demo", { a: 2 });
    expect(fs.existsSync(r.patchFile("ann"))).toBe(true);
    await store.save("demo", { a: 1 });
    expect(fs.existsSync(r.patchFile("ann"))).toBe(false);
    await expect(store.load("demo")).resolves.toEqual({ a: 1 });
  });

  it("records only the removals for a prune-save (E4)", async () => {
    const r = await rig();
    r.setVault({ keep: 1, stale: 2, nested: { gone: true, here: 1 } });
    const store = r.store("ann");
    await store.save("demo", { keep: 1, nested: { here: 1 } });
    expect(read(r.patchFile("ann"))).toEqual({ stale: null, nested: { gone: null } });
    // The owner changing a kept key later still reaches the viewer.
    r.setVault({ keep: 9, stale: 2, nested: { gone: true, here: 1 } });
    await expect(store.load("demo")).resolves.toEqual({ keep: 9, nested: { here: 1 } });
  });

  it("treats an explicit null as an absent key", async () => {
    const r = await rig();
    r.setVault({ a: 1 });
    const store = r.store("ann");
    await store.save("demo", { a: null, b: null });
    expect(read(r.patchFile("ann"))).toEqual({ a: null });
    await expect(store.load("demo")).resolves.toEqual({});
  });

  it("keeps a viewer's document when the vault has no data.json", async () => {
    const r = await rig();
    const store = r.store("ann");
    await expect(store.load("demo")).resolves.toBeNull();
    await store.save("demo", { a: 1 });
    await expect(store.load("demo")).resolves.toEqual({ a: 1 });
  });

  it("writes nothing to the vault: zero direct writes and no vaultd mutation", async () => {
    const r = await rig();
    r.setVault({ a: 1 });
    const guard = installFsWriteGuard(r.vaultRoot);
    try {
      const store = r.store("ann");
      await store.save("demo", { a: 2 });
      await store.load("demo");
      await store.save("demo", { a: 1 });
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(0);
    expect(r.sent).toEqual([]);
  });

  it("does not show one viewer's values to another", async () => {
    const r = await rig();
    r.setVault({ a: 1 });
    await r.store("ann").save("demo", { a: 2 });
    await r.store("bob").save("demo", { a: 3 });
    await expect(r.store("ann").load("demo")).resolves.toEqual({ a: 2 });
    await expect(r.store("bob").load("demo")).resolves.toEqual({ a: 3 });
    await expect(r.store("cy").load("demo")).resolves.toEqual({ a: 1 });
  });

  it("stores awkward viewer ids inside the state root", async () => {
    const r = await rig();
    r.setVault({ a: 1 });
    const ids = ["a/b", "../../etc", "..", ".", "ünï/çødé", "Ann@x.com", "ann@x.com", "x".repeat(600)];
    for (const [i, id] of ids.entries()) {
      await r.store(id).save("demo", { a: i + 10 });
    }
    for (const [i, id] of ids.entries()) {
      await expect(r.store(id).load("demo")).resolves.toEqual({ a: i + 10 });
    }
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const files = walk(r.stateRoot);
    expect(files).toHaveLength(ids.length);
    for (const file of files) expect(file.startsWith(r.stateRoot + "/")).toBe(true);
    expect(fs.existsSync(join(r.stateRoot, "..", "..", "etc"))).toBe(false);
  });

  it("serves a plugin through loadData and saveData when it is the host's store", async () => {
    const r = await rig();
    r.setVault({ a: 1, b: 2 });
    const real = pluginHostFor(r.harness.app);
    installPluginHost(r.harness.app, { ...real, dataStore: r.store("ann") });
    const plugin = r.harness.instantiate("demo", class extends r.harness.api.Plugin {});
    await plugin.saveData({ a: 1, b: 5 });
    await expect(plugin.loadData()).resolves.toEqual({ a: 1, b: 5 });
    expect(read(r.patchFile("ann"))).toEqual({ b: 5 });
  });

  it("names the default state root under XDG_STATE_HOME", () => {
    expect(viewerStateRoot({ XDG_STATE_HOME: "/s" })).toBe("/s/vaultd-web/plugin-data");
  });
});

describe("merge patch", () => {
  it("applies RFC 7396 examples", () => {
    expect(mergePatch({ a: "b" }, { a: "c" })).toEqual({ a: "c" });
    expect(mergePatch({ a: "b" }, { b: "c" })).toEqual({ a: "b", b: "c" });
    expect(mergePatch({ a: "b" }, { a: null })).toEqual({});
    expect(mergePatch({ a: ["b"] }, { a: "c" })).toEqual({ a: "c" });
    expect(mergePatch({ a: "c" }, { a: ["b"] })).toEqual({ a: ["b"] });
    expect(mergePatch({ a: { b: "c" } }, { a: { b: "d", c: null } })).toEqual({ a: { b: "d" } });
    expect(mergePatch({ a: [{ b: "c" }] }, { a: [1] })).toEqual({ a: [1] });
    expect(mergePatch(["a", "b"], ["c", "d"])).toEqual(["c", "d"]);
    expect(mergePatch({ a: "foo" }, null)).toBeNull();
    expect(mergePatch({ e: null }, { a: 1 })).toEqual({ e: null, a: 1 });
    expect(mergePatch([1, 2], { a: "b", c: null })).toEqual({ a: "b" });
    expect(mergePatch({}, { a: { bb: { ccc: null } } })).toEqual({ a: { bb: {} } });
  });

  it("round-trips diff and apply, including a __proto__ key", () => {
    const base = JSON.parse('{"a":1,"__proto__":{"x":1},"n":{"k":1,"j":2}}') as unknown;
    const next = JSON.parse('{"a":2,"__proto__":{"x":2},"n":{"j":2},"m":[1]}') as unknown;
    const patch = diffMergePatch(base, next);
    expect(mergePatch(base, patch)).toEqual(next);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
});

