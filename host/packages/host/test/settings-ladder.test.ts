import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SchemaLadder } from "../src/settings/ladder";
import { SettingsHarness } from "../src/testing/settings-harness";
import { fs } from "../src/runtime/fs-access";

describe("SchemaLadder", () => {
  it("rung 1: reads getSettingDefinitions when items carry control.key", async () => {
    const harness = await SettingsHarness.withTab({
      getSettingDefinitions: () => [
        { control: { key: "enabled", type: "toggle" }, defaultValue: true, name: "Enabled" },
        { control: { key: "count", type: "number" }, defaultValue: 3, name: "Count" },
      ],
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("definitions");
    expect(schema.items).toEqual([
      { key: "enabled", control: "toggle", name: "Enabled", defaultValue: true },
      { key: "count", control: "number", name: "Count", defaultValue: 3 },
    ]);
  });

  it("rung 1 demotes a degenerate implementation with no control.key", async () => {
    const harness = await SettingsHarness.withTab({
      getSettingDefinitions: () => [{ render: () => {} }],
      moduleExports: { DEFAULT_SETTINGS: { enabled: false, label: "x" } },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("types");
    expect(schema.items.map((i) => i.key).sort()).toEqual(["enabled", "label"]);
  });

  it("rung 2: reads a descriptor array", async () => {
    const harness = await SettingsHarness.withTab({
      moduleExports: {
        SETTINGS_CATALOG: [
          { key: "endpoint", control: "text", name: "Endpoint", description: "Where to call" },
          { key: "mode", control: "dropdown", options: [{ value: "a", label: "A" }] },
        ],
      },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("descriptors");
    expect(schema.items[0]).toEqual({
      key: "endpoint",
      control: "text",
      name: "Endpoint",
      description: "Where to call",
    });
  });

  it("rung 3: falls back to DEFAULT_SETTINGS keys and defaults", async () => {
    const harness = await SettingsHarness.withTab({
      moduleExports: { DEFAULT_SETTINGS: { alpha: 1, beta: "two", gamma: false } },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("types");
    expect(schema.items).toEqual([
      { key: "alpha", control: "number", defaultValue: 1 },
      { key: "beta", control: "text", defaultValue: "two" },
      { key: "gamma", control: "toggle", defaultValue: false },
    ]);
  });

  it("reports source none when no rung applies, and never calls display()", async () => {
    let displayCalls = 0;
    const harness = await SettingsHarness.withTab({
      display: () => {
        displayCalls += 1;
      },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("none");
    expect(schema.items).toEqual([]);
    expect(displayCalls).toBe(0);
  });

  it("caches to disk keyed by plugin version", async () => {
    const harness = await SettingsHarness.withTab({
      moduleExports: { DEFAULT_SETTINGS: { alpha: 1 } },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    harness.ladder.write(schema);
    const reread = new SchemaLadder(harness.dataDir).read(harness.manifest.id, harness.manifest.version);
    expect(reread).toEqual(schema);
    expect(new SchemaLadder(harness.dataDir).read(harness.manifest.id, "9.9.9")).toBeNull();
  });

  // **The rule that keeps a Detector pass from dying on a real plugin.**
  // quickadd declares `getSettingDefinitions()` and its implementation throws
  // headlessly (`Unable to resolve owner document for DOM node.`) because
  // building its definitions touches the DOM. A ladder that let that throw
  // escape would fail the climb for a plugin it could still have described from
  // its defaults, and a sweep over the plugin set would stop at the first one.
  it("rung 1 demotes when getSettingDefinitions throws, and keeps climbing", async () => {
    const harness = await SettingsHarness.withTab({
      getSettingDefinitions: () => {
        throw new Error("Unable to resolve owner document for DOM node.");
      },
      moduleExports: { DEFAULT_SETTINGS: { alpha: 1 } },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("types");
    expect(schema.items).toEqual([{ key: "alpha", control: "number", defaultValue: 1 }]);
  });

  it("a throwing getSettingDefinitions with nothing below it reports none, not a failure", async () => {
    const harness = await SettingsHarness.withTab({
      getSettingDefinitions: () => {
        throw new Error("Unable to resolve owner document for DOM node.");
      },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("none");
    expect(schema.items).toEqual([]);
  });

  // The plain CommonJS export shape — `module.exports = MyPlugin` — which
  // `obsidian-rollover-daily-todos` ships. Own properties read off a function
  // exactly as off an object, and a helper that refused one made both lower
  // rungs structurally blind to the idiom.
  it("reads DEFAULT_SETTINGS off a function-shaped module.exports", async () => {
    const exported = function RolloverTodosPlugin(): void {};
    (exported as unknown as Record<string, unknown>)["DEFAULT_SETTINGS"] = { alpha: "one" };
    const harness = await SettingsHarness.withTab({ moduleExports: exported });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("types");
    expect(schema.items).toEqual([{ key: "alpha", control: "text", defaultValue: "one" }]);
  });

  it("rung 2 declines an array whose entries carry no control-ish field", async () => {
    const harness = await SettingsHarness.withTab({
      moduleExports: {
        SETTINGS_CATALOG: [{ key: "endpoint", name: "Endpoint" }],
        DEFAULT_SETTINGS: { endpoint: "https://example.invalid" },
      },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    // Demoted whole, to the rung below — not accepted as a control-less item.
    expect(schema.source).toBe("types");
    expect(schema.items).toEqual([
      { key: "endpoint", control: "text", defaultValue: "https://example.invalid" },
    ]);
  });

  // Accept-or-decline-whole. A per-entry rung would answer a schema that looks
  // authoritative and silently omits `mode` — which is exactly the shape that
  // makes `set` refuse a legitimate write to it with `unknown_key`.
  it("rung 2 declines the whole array when one entry is unusable", async () => {
    const harness = await SettingsHarness.withTab({
      moduleExports: {
        SETTINGS_CATALOG: [
          { key: "endpoint", control: "text" },
          { name: "a heading, not a field" },
        ],
      },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("none");
    expect(schema.items).toEqual([]);
  });

  // The cache is read at startup by something with no second source for it, so
  // a truncated write is an unparseable document and a plugin's whole schema.
  // `writeJsonAtomic` writes a sibling and renames; a reader sees the whole
  // previous document or the whole new one, never a prefix.
  it("writes the cache through a rename, leaving no sibling behind", async () => {
    const harness = await SettingsHarness.withTab({
      moduleExports: { DEFAULT_SETTINGS: { alpha: 1 } },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    const renames: Array<{ from: string; to: string }> = [];
    const real = fs.renameSync;
    fs.renameSync = ((from: string, to: string): void => {
      renames.push({ from: String(from), to: String(to) });
      real(from, to);
    }) as typeof fs.renameSync;
    try {
      harness.ladder.write(schema);
    } finally {
      fs.renameSync = real;
    }
    expect(renames).toHaveLength(1);
    expect(renames[0]?.from).toMatch(/\.tmp$/);
    expect(renames[0]?.to).toBe(
      join(harness.dataDir, "schema", `${harness.manifest.id}@${harness.manifest.version}.json`),
    );
    expect(readdirSync(join(harness.dataDir, "schema")).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
  });
});
