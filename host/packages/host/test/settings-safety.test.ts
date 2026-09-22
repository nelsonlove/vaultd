import { describe, expect, it } from "vitest";
import seed from "../src/settings/key-registry.json";
import {
  DEFAULT_KEY_REGISTRY,
  MAX_CONFIG_DEPTH,
  PluginDataTooDeep,
  PluginDataTooLarge,
} from "../src/settings/plugin-config";
import { SettingsHarness } from "../src/testing/settings-harness";

/** A document `depth` levels deep: `{"a":{"a":…{"a":1}}}`. */
function nested(depth: number): Record<string, unknown> {
  let node: unknown = 1;
  for (let i = 0; i < depth; i += 1) node = { a: node };
  return node as Record<string, unknown>;
}

describe("plugin config safety", () => {
  it("redacts secret-shaped keys by default and reveals them on request", async () => {
    const harness = await SettingsHarness.withData("tasknotes", {
      apiAuthToken: "s3cret",
      googleCalendarSyncTokens: { refresh: "r" },
      taskTag: "task",
      pomodoroState: { running: true },
    });
    const guarded = await harness.service.get("tasknotes", false);
    expect(guarded.values["apiAuthToken"]).toBe("[redacted]");
    expect(guarded.values["googleCalendarSyncTokens"]).toBe("[redacted]");
    expect(guarded.values["taskTag"]).toBe("task");
    expect(guarded.redacted_keys).toEqual([["apiAuthToken"], ["googleCalendarSyncTokens"]]);
    expect(guarded.state_keys).toContain("pomodoroState");
    const revealed = await harness.service.get("tasknotes", true);
    expect(revealed.values["apiAuthToken"]).toBe("s3cret");
  });

  it("redacts a token-shaped key the registry does not list", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", {
      myServiceApiKey: "abc",
      label: "fine",
    });
    const guarded = await harness.service.get("unknown-plugin", false);
    expect(guarded.values["myServiceApiKey"]).toBe("[redacted]");
    expect(guarded.values["label"]).toBe("fine");
  });

  it("refuses a write to a registered state key and applies the rest", async () => {
    const harness = await SettingsHarness.withData(
      "tasknotes",
      {
        pomodoroState: { running: true },
        taskTag: "task",
      },
      {
        schema: {
          source: "types",
          items: [
            { key: "taskTag", control: "text" },
            { key: "pomodoroState", control: "unknown" },
          ],
        },
      },
    );
    const result = await harness.service.set("tasknotes", {
      taskTag: "todo",
      pomodoroState: { running: false },
    });
    expect(result.applied).toEqual(["taskTag"]);
    expect(result.refused).toEqual([{ key: "pomodoroState", reason: "state_key" }]);
    expect(await harness.readData("tasknotes")).toEqual({
      pomodoroState: { running: true },
      taskTag: "todo",
    });
  });

  it("refuses an unknown key when the schema is known", async () => {
    const harness = await SettingsHarness.withData(
      "demo",
      { alpha: 1 },
      {
        schema: { source: "definitions", items: [{ key: "alpha", control: "number" }] },
      },
    );
    const result = await harness.service.set("demo", { alpha: 2, invented: true });
    expect(result.applied).toEqual(["alpha"]);
    expect(result.refused).toEqual([{ key: "invented", reason: "unknown_key" }]);
  });

  it("accepts an unknown key when the schema source is none", async () => {
    const harness = await SettingsHarness.withData(
      "opaque",
      { alpha: 1 },
      {
        schema: { source: "none", items: [] },
      },
    );
    const result = await harness.service.set("opaque", { beta: 2 });
    expect(result.applied).toEqual(["beta"]);
    expect(result.refused).toEqual([]);
  });

  it("refuses a value whose type contradicts the control", async () => {
    const harness = await SettingsHarness.withData(
      "demo",
      { flag: true },
      {
        schema: { source: "definitions", items: [{ key: "flag", control: "toggle" }] },
      },
    );
    const result = await harness.service.set("demo", { flag: "yes" });
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([{ key: "flag", reason: "type_mismatch" }]);
  });

  it("calls onExternalSettingsChange after a successful write", async () => {
    let notified = 0;
    const harness = await SettingsHarness.withData(
      "demo",
      { alpha: 1 },
      {
        schema: { source: "none", items: [] },
        onExternalSettingsChange: () => {
          notified += 1;
        },
      },
    );
    await harness.service.set("demo", { alpha: 2 });
    expect(notified).toBe(1);
  });

  // --- Redaction reaches every depth -----------------------------------------

  // The audited corpus's four credentials are all top-level. The fallback exists
  // for the plugins nobody has audited, and a nested provider map is an entirely
  // ordinary shape for one of them — so a floor that stopped at depth zero would
  // be a floor that is not there.
  it("redacts a secret nested inside an object, and names its dotted path", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", {
      nested: { deep: { apiToken: "NESTED-LEAK", ordinary: 1 } },
      label: "fine",
    });
    const guarded = await harness.service.get("unknown-plugin", false);
    expect(guarded.values["nested"]).toEqual({ deep: { apiToken: "[redacted]", ordinary: 1 } });
    expect(guarded.values["label"]).toBe("fine");
    expect(guarded.redacted_keys).toEqual([["nested", "deep", "apiToken"]]);
  });

  it("redacts a secret inside an array of objects, with the index in the path", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", {
      accounts: [{ name: "a", refreshToken: "ARRAY-LEAK" }, { name: "b" }],
    });
    const guarded = await harness.service.get("unknown-plugin", false);
    expect(guarded.values["accounts"]).toEqual([
      { name: "a", refreshToken: "[redacted]" },
      { name: "b" },
    ]);
    expect(guarded.redacted_keys).toEqual([["accounts", 0, "refreshToken"]]);
  });

  it("reveals a nested secret on request, and still names every path", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", {
      nested: { deep: { apiToken: "NESTED-LEAK" } },
      accounts: [{ refreshToken: "ARRAY-LEAK" }],
    });
    const revealed = await harness.service.get("unknown-plugin", true);
    expect(revealed.values["nested"]).toEqual({ deep: { apiToken: "NESTED-LEAK" } });
    expect(revealed.values["accounts"]).toEqual([{ refreshToken: "ARRAY-LEAK" }]);
    // A caller holding plaintext still needs to know which of these values are
    // credentials — that is the more useful question, and the guarded answer's
    // paths are the answer to it.
    expect(revealed.redacted_keys).toEqual([
      ["nested", "deep", "apiToken"],
      ["accounts", 0, "refreshToken"],
    ]);
  });

  it("withholds a registry-listed key's whole subtree as one path", async () => {
    const harness = await SettingsHarness.withData("tasknotes", {
      googleCalendarSyncTokens: { refresh: "r", access: "a" },
    });
    const guarded = await harness.service.get("tasknotes", false);
    expect(guarded.values["googleCalendarSyncTokens"]).toBe("[redacted]");
    // One path, not one per token inside the bag: a caller cannot reconstruct
    // the bag's shape from what it was told.
    expect(guarded.redacted_keys).toEqual([["googleCalendarSyncTokens"]]);
  });

  // --- The round trip that used to destroy a token ----------------------------

  // The most natural client there is: read a config, change one field, write the
  // whole thing back. Without the refusal that saves the literal "[redacted]"
  // over the user's real token, and `data.json` has no history.
  it("refuses a redacted value written back, and leaves the real token byte-identical", async () => {
    const harness = await SettingsHarness.withData("tasknotes", {
      apiAuthToken: "real-token",
      taskTag: "t",
    });
    const before = harness.rawData("tasknotes");
    const view = await harness.service.get("tasknotes", false);
    const result = await harness.service.set("tasknotes", view.values);
    expect(result.applied).toEqual(["taskTag"]);
    expect(result.refused).toEqual([
      { key: "apiAuthToken", reason: "redacted_value", path: ["apiAuthToken"] },
    ]);
    expect(await harness.readData("tasknotes")).toEqual({
      apiAuthToken: "real-token",
      taskTag: "t",
    });
    expect(harness.rawData("tasknotes")).toBe(before);
  });

  it("refuses a nested redacted value and names its path, applying the rest", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", {
      nested: { deep: { apiToken: "real" } },
      label: "before",
    });
    const view = await harness.service.get("unknown-plugin", false);
    const result = await harness.service.set("unknown-plugin", {
      ...view.values,
      label: "after",
    });
    expect(result.applied).toEqual(["label"]);
    expect(result.refused).toEqual([
      { key: "nested", reason: "redacted_value", path: ["nested", "deep", "apiToken"] },
    ]);
    expect(await harness.readData("unknown-plugin")).toEqual({
      nested: { deep: { apiToken: "real" } },
      label: "after",
    });
  });

  // The fallback matches a substring, so an ordinary *numeric* setting is
  // redacted to a string. Writing that back would put "[redacted]" into a
  // number field — and with `source: "none"` nothing else would stop it.
  it("refuses a redacted number written back under a none schema", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", {
      refreshTokenIntervalMinutes: 30,
    });
    const view = await harness.service.get("unknown-plugin", false);
    expect(view.values["refreshTokenIntervalMinutes"]).toBe("[redacted]");
    const result = await harness.service.set("unknown-plugin", view.values);
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([
      {
        key: "refreshTokenIntervalMinutes",
        reason: "redacted_value",
        path: ["refreshTokenIntervalMinutes"],
      },
    ]);
    expect(await harness.readData("unknown-plugin")).toEqual({
      refreshTokenIntervalMinutes: 30,
    });
  });

  // --- Keys that must never be reported applied -------------------------------

  it("refuses a value of undefined rather than reporting a key it would delete", async () => {
    const harness = await SettingsHarness.withData("opaque", { alpha: 1, keep: "me" }, {
      schema: { source: "none", items: [] },
    });
    const result = await harness.service.set("opaque", { alpha: undefined });
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([{ key: "alpha", reason: "type_mismatch" }]);
    expect(await harness.readData("opaque")).toEqual({ alpha: 1, keep: "me" });
  });

  it("refuses __proto__, constructor and prototype whatever the schema says", async () => {
    const harness = await SettingsHarness.withData("opaque", { alpha: 1 }, {
      schema: { source: "none", items: [] },
    });
    const result = await harness.service.set("opaque", {
      ["__proto__"]: { polluted: true },
      constructor: "no",
      prototype: "no",
      alpha: 2,
    });
    expect(result.applied).toEqual(["alpha"]);
    expect(result.refused).toEqual([
      { key: "__proto__", reason: "unknown_key" },
      { key: "constructor", reason: "unknown_key" },
      { key: "prototype", reason: "unknown_key" },
    ]);
    expect(await harness.readData("opaque")).toEqual({ alpha: 2 });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  // --- What a refused call does to the file, and what the cap does ------------

  it("writes nothing at all when every key is refused", async () => {
    const harness = await SettingsHarness.withData("demo", { flag: true }, {
      schema: { source: "definitions", items: [{ key: "flag", control: "toggle" }] },
    });
    const before = harness.rawData("demo");
    harness.clearMethodLog();
    const result = await harness.service.set("demo", { flag: "yes" });
    expect(result.applied).toEqual([]);
    expect(harness.methodsSeen()).not.toContain("write_file");
    expect(harness.rawData("demo")).toBe(before);
  });

  it("refuses an oversized document before any write, leaving the file alone", async () => {
    const harness = await SettingsHarness.withData("opaque", { alpha: 1 }, {
      schema: { source: "none", items: [] },
      config: { writeFileCapBytes: 64 },
    });
    const before = harness.rawData("opaque");
    harness.clearMethodLog();
    await expect(harness.service.set("opaque", { beta: "x".repeat(200) })).rejects.toBeInstanceOf(
      PluginDataTooLarge,
    );
    expect(harness.methodsSeen()).not.toContain("write_file");
    expect(harness.rawData("opaque")).toBe(before);
  });

  // --- The two writers of data.json agree --------------------------------------

  it("leaves one trailing newline whichever writer wrote last", async () => {
    const harness = await SettingsHarness.withData("demo", { alpha: 1 }, {
      schema: { source: "none", items: [] },
    });
    await harness.plugin.saveData({ alpha: 1, fromPlugin: true });
    const afterSave = harness.rawData("demo") ?? "";
    expect(afterSave.endsWith("}\n")).toBe(true);
    await harness.service.set("demo", { beta: 2 });
    const afterSet = harness.rawData("demo") ?? "";
    expect(afterSet.endsWith("}\n")).toBe(true);
    await harness.plugin.saveData({ alpha: 3 });
    const afterSecondSave = harness.rawData("demo") ?? "";
    expect(afterSecondSave.endsWith("}\n")).toBe(true);
    // And the host's write really did see what the plugin saved.
    expect(JSON.parse(afterSet)).toEqual({ alpha: 1, fromPlugin: true, beta: 2 });
  });

  // --- The documents a JSON value cannot express -------------------------------

  it("reads a data.json holding the literal null as an empty document", async () => {
    const harness = await SettingsHarness.withRawData("demo", "null\n");
    // Asserted at the layer that decides it: every caller above collapses
    // `null` and `{}` with a `??`, so only this says which one was answered.
    expect(await harness.dir.readPluginData("demo")).toEqual({});
    const guarded = await harness.service.get("demo", false);
    expect(guarded.values).toEqual({});
    const result = await harness.service.set("demo", { alpha: 1 });
    expect(result.applied).toEqual(["alpha"]);
    expect(await harness.readData("demo")).toEqual({ alpha: 1 });
  });

  it("refuses an array, a scalar and a damaged file, and touches none of them", async () => {
    for (const source of ["[1, 2]\n", "42\n", "{not json\n"]) {
      const harness = await SettingsHarness.withRawData("demo", source);
      await expect(harness.service.get("demo", false)).rejects.toThrow();
      await expect(harness.service.set("demo", { alpha: 1 })).rejects.toThrow();
      expect(harness.rawData("demo")).toBe(source);
    }
  });

  // --- The path grammar, and why it is an array --------------------------------

  // A key name may contain a dot — path-keyed maps, `"folder/note.md"`,
  // `"section.field"` settings — so a dotted string spells two different
  // documents the same way. A client highlighting the field a refusal names
  // cannot recover from that; segments can.
  it("tells a dotted key name apart from two nested ones", async () => {
    const flat = await SettingsHarness.withData("unknown-plugin", {
      "a.b": { apiToken: "FLAT" },
    });
    expect((await flat.service.get("unknown-plugin", false)).redacted_keys).toEqual([
      ["a.b", "apiToken"],
    ]);
    const deep = await SettingsHarness.withData("unknown-plugin", {
      a: { b: { apiToken: "DEEP" } },
    });
    expect((await deep.service.get("unknown-plugin", false)).redacted_keys).toEqual([
      ["a", "b", "apiToken"],
    ]);
  });

  // --- A document deeper than this host inspects -------------------------------

  // A plugin's own `saveData` will serialize a 200,000-deep document quite
  // happily and the daemon stores bytes, so an unbounded walk answers
  // `RangeError: Maximum call stack size exceeded` for ever on a file the
  // plugin considers ordinary. Failing closed with a typed error is the only
  // safe direction for a redactor: what it could not inspect it must not serve.
  it("refuses to read a document nested deeper than the budget", async () => {
    const harness = await SettingsHarness.withRawData(
      "demo",
      `${JSON.stringify(nested(2_500))}\n`,
    );
    await expect(harness.service.get("demo", false)).rejects.toBeInstanceOf(PluginDataTooDeep);
    await expect(harness.service.get("demo", false)).rejects.toThrow(
      new RegExp(`deeper than ${String(MAX_CONFIG_DEPTH)} levels`),
    );
    // Typed, not a stack overflow: the walk stops at the budget and never
    // recurses to the bottom.
    await expect(harness.service.get("demo", false)).rejects.not.toBeInstanceOf(RangeError);
  });

  it("refuses a patch nested deeper than the budget before any write", async () => {
    const harness = await SettingsHarness.withData("opaque", { alpha: 1 }, {
      schema: { source: "none", items: [] },
    });
    const before = harness.rawData("opaque");
    harness.clearMethodLog();
    await expect(harness.service.set("opaque", { deep: nested(2_500) })).rejects.toBeInstanceOf(
      PluginDataTooDeep,
    );
    expect(harness.methodsSeen()).not.toContain("write_file");
    expect(harness.rawData("opaque")).toBe(before);
  });

  it("reads and writes a document at the edge of the budget", async () => {
    // The budget is a bound on what this host inspects, not a bound on what a
    // plugin may store: a document inside it round-trips normally.
    const harness = await SettingsHarness.withData("opaque", { deep: nested(40) }, {
      schema: { source: "none", items: [] },
    });
    const guarded = await harness.service.get("opaque", false);
    expect(guarded.values["deep"]).toEqual(nested(40));
    const result = await harness.service.set("opaque", { alpha: 1 });
    expect(result.applied).toEqual(["alpha"]);
  });

  // --- The placeholder reconstructed by hand -----------------------------------

  // `get` withholds a secret's whole subtree as one scalar, so a client that
  // round-trips a read sends a string and is caught by the first test. A client
  // that rebuilds the shape by hand is writing the placeholder into the same
  // credential, and the guard is for the value rather than for the shape it
  // arrives in.
  it("refuses a redacted placeholder inside an array under a secret-named key", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", {
      apiTokens: ["t1", "t2"],
    });
    const result = await harness.service.set("unknown-plugin", {
      apiTokens: ["[redacted]", "[redacted]"],
    });
    expect(result.applied).toEqual([]);
    // The first offending element, named by index.
    expect(result.refused).toEqual([
      { key: "apiTokens", reason: "redacted_value", path: ["apiTokens", 0] },
    ]);
    expect(await harness.readData("unknown-plugin")).toEqual({ apiTokens: ["t1", "t2"] });
  });

  it("refuses a redacted placeholder nested under a secret-named key", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", {
      apiToken: { inner: "real" },
    });
    const result = await harness.service.set("unknown-plugin", {
      apiToken: { inner: "[redacted]" },
    });
    expect(result.refused).toEqual([
      { key: "apiToken", reason: "redacted_value", path: ["apiToken", "inner"] },
    ]);
    expect(await harness.readData("unknown-plugin")).toEqual({ apiToken: { inner: "real" } });
  });

  it("still stores the literal string under a key it would not redact", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", { label: "before" });
    const result = await harness.service.set("unknown-plugin", { label: "[redacted]" });
    expect(result.applied).toEqual(["label"]);
    expect(await harness.readData("unknown-plugin")).toEqual({ label: "[redacted]" });
  });

  // --- The lock is released before the plugin is told ---------------------------

  // `runExclusivePath` is not re-entrant, and `saveData` takes the same lock as
  // `set`. A handler that saves — the natural answer to "your file changed" —
  // would wait on a lock nothing releases if the notify ran inside the window.
  it("lets an onExternalSettingsChange handler save without deadlocking", async () => {
    const harness = await SettingsHarness.withData("demo", { alpha: 1 }, {
      schema: { source: "none", items: [] },
    });
    let saved: Promise<void> = Promise.resolve();
    harness.plugin.onExternalSettingsChange = (): void => {
      saved = harness.plugin.saveData({ alpha: 2, savedByHandler: true });
    };
    await harness.service.set("demo", { alpha: 2 });
    await saved;
    expect(await harness.readData("demo")).toEqual({ alpha: 2, savedByHandler: true });
  });

  it("exports the key registry as a deep-frozen copy, not the module object", async () => {
    expect(DEFAULT_KEY_REGISTRY).toEqual(seed);
    expect(DEFAULT_KEY_REGISTRY).not.toBe(seed);
    expect(Object.isFrozen(DEFAULT_KEY_REGISTRY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_KEY_REGISTRY["tasknotes"])).toBe(true);
    expect(Object.isFrozen(DEFAULT_KEY_REGISTRY["tasknotes"]?.state_keys)).toBe(true);
    expect(() => DEFAULT_KEY_REGISTRY["tasknotes"]?.state_keys.push("invented")).toThrow();
    // And the seed a caller could not have edited still guards.
    const harness = await SettingsHarness.withData("tasknotes", { pomodoroState: { on: true } });
    const result = await harness.service.set("tasknotes", { pomodoroState: { on: false } });
    expect(result.refused).toEqual([{ key: "pomodoroState", reason: "state_key" }]);
  });
});
