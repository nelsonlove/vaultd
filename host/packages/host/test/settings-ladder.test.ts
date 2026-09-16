import { describe, expect, it } from "vitest";
import { SchemaLadder } from "../src/settings/ladder";
import { SettingsHarness } from "../src/testing/settings-harness";

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
});
