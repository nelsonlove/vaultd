import { describe, expect, it } from "vitest";
import { SettingsHarness } from "../src/testing/settings-harness";

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
    expect(guarded.redacted_keys.sort()).toEqual(["apiAuthToken", "googleCalendarSyncTokens"]);
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
});
