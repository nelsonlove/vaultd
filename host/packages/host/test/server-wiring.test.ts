/**
 * The late operations, once their services are attached.
 *
 * Task 16a registered six `host.*` operations that answered `host_not_ready`
 * until somebody handed the server the service each one needs; Task 18
 * attached the interaction broker and made the three interaction operations
 * real; this file covers what Task 20b attaches — the plugin config service
 * and the compatibility detector — plus the list operation the lag amendment
 * added and the two error codes the config pair can raise.
 *
 * Two cases here are **pins of Task 18** rather than new work (the attach/
 * detach pair and the unknown-prompt refusal): they passed before this task
 * and must keep passing after it, because attaching two more services must not
 * disturb the one that was already there.
 *
 * **The scrub assertion is a key walk, not a regex over the serialized text.**
 * The brief's fourth case asserts `JSON.stringify(report)` matches no
 * `/[a-z][A-Z]/` at all, and no compatibility report can satisfy that: a scan
 * *counts Obsidian's own API members*, so `getFileCache` and `onLayoutReady`
 * are the report's **data**, and a plugin's command ids and the host's own
 * prose sit in it too. What `wire.ts` promises is that no **field name**
 * crosses the socket in `camelCase`, and that is what {@link camelCaseKeys}
 * checks — every key at every depth, with no exemptions, which is why the scan's
 * symbol tallies cross as `[{ symbol, hits }]` rows rather than as objects keyed
 * by the symbol name.
 */

import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

/**
 * Every key anywhere in `value` whose spelling is `camelCase`, by path.
 *
 * Returns the paths rather than a boolean so a failure names the field that
 * was not converted instead of only saying that one was.
 */
function camelCaseKeys(value: unknown, path: string[] = [], found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => camelCaseKeys(entry, [...path, String(index)], found));
    return found;
  }
  if (typeof value !== "object" || value === null) return found;
  for (const [key, child] of Object.entries(value)) {
    if (/[a-z][A-Z]/.test(key)) found.push([...path, key].join("."));
    camelCaseKeys(child, [...path, key], found);
  }
  return found;
}

/** A patch nested `depth` levels deep, which is what the depth budget refuses. */
function deepPatch(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: true };
  for (let level = 0; level < depth; level += 1) node = { down: node };
  return { nest: node };
}

/** Turn the event loop until `check` holds, or let the assertion say what was true. */
async function settleUntil(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("wired host ops", () => {
  it("attaches one interaction handler and refuses a second", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      await harness.lifecycle.start();
      const first = await harness.connectClient();
      const second = await harness.connectClient();
      await expect(first.call("host.attach_interaction", {})).resolves.toEqual({ attached: true });
      await expect(second.call("host.attach_interaction", {})).rejects.toMatchObject({
        code: "interaction_unavailable",
      });
      await expect(first.call("host.detach_interaction", {})).resolves.toEqual({ attached: false });
      await expect(second.call("host.attach_interaction", {})).resolves.toEqual({ attached: true });
    } finally {
      await harness.stop();
    }
  });

  it("refuses respond_interaction for an unknown prompt", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.attach_interaction", {});
      await expect(
        client.call("host.respond_interaction", { prompt_id: "nope", choice_index: 0 }),
      ).rejects.toMatchObject({ code: "interaction_unavailable" });
    } finally {
      await harness.stop();
    }
  });

  it("lists what is pending, so a client that lost an event can re-ask", async () => {
    const chosen: string[] = [];
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["picker"],
      plugins: {
        picker: (api) =>
          class extends api.Plugin {
            override onload(): void {
              this.addCommand({
                id: "pick",
                name: "Pick",
                callback: async () => {
                  class Picker extends api.FuzzySuggestModal<string> {
                    override getItems(): string[] {
                      return ["Alpha", "Beta"];
                    }
                    override getItemText(item: string): string {
                      return item;
                    }
                    override onChooseItem(item: string): void {
                      chosen.push(item);
                    }
                  }
                  await new Picker(this.app).open();
                },
              });
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.attach_interaction", {});
      // Nothing asked yet: an empty list rather than a refusal.
      await expect(client.call("host.list_interactions", {})).resolves.toEqual({ pending: [] });
      const invoking = client.call("host.invoke_command", { command_id: "picker:pick" });
      const request = (await client.nextEvent("host.interaction_request")) as {
        prompt_id: string;
      };
      const listed = await client.call<{ pending: Array<Record<string, unknown>> }>(
        "host.list_interactions",
        {},
      );
      expect(listed.pending).toHaveLength(1);
      expect(listed.pending[0]).toMatchObject({
        prompt_id: request.prompt_id,
        plugin_id: "picker",
        kind: "fuzzy_suggest",
        items: ["Alpha", "Beta"],
        timeout_ms: 120000,
      });
      expect(typeof listed.pending[0]?.["prompt"]).toBe("string");
      expect(camelCaseKeys(listed)).toEqual([]);
      await client.call("host.respond_interaction", {
        prompt_id: request.prompt_id,
        choice_index: 1,
      });
      await invoking;
      await settleUntil(() => chosen.length > 0);
      // Answered, and therefore gone.
      await expect(client.call("host.list_interactions", {})).resolves.toEqual({ pending: [] });
    } finally {
      await harness.stop();
    }
  });

  it("serves and patches plugin config over the socket, snake_case throughout", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["demo"],
      pluginData: { demo: { taskTag: "task", myApiKey: "s3cret" } },
      plugins: { demo: HostHarness.settingsPlugin },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();

      const guarded = await client.call<{
        id: string;
        values: Record<string, unknown>;
        schema: { source: string; items: unknown[] };
        redacted_keys: Array<Array<string | number>>;
        state_keys: string[];
      }>("host.get_plugin_config", { id: "demo" });
      expect(guarded.values["myApiKey"]).toBe("[redacted]");
      expect(guarded.values["taskTag"]).toBe("task");
      // **Segment arrays, not names.** Task 17 round 2 froze `redacted_keys` as
      // the daemon's `key_path` grammar, so a top-level key is a one-segment
      // path; the brief's `["myApiKey"]` predates that freeze.
      expect(guarded.redacted_keys).toEqual([["myApiKey"]]);
      expect(Object.keys(guarded).sort()).toEqual([
        "id",
        "redacted_keys",
        "schema",
        "state_keys",
        "values",
      ]);
      expect(camelCaseKeys({ ...guarded, values: {} })).toEqual([]);

      const revealed = await client.call<{
        values: Record<string, unknown>;
        redacted_keys: Array<Array<string | number>>;
      }>("host.get_plugin_config", { id: "demo", reveal_secrets: true });
      expect(revealed.values["myApiKey"]).toBe("s3cret");
      // Still named, because a caller holding plaintext most needs to know
      // which of the values it is holding are credentials.
      expect(revealed.redacted_keys).toEqual([["myApiKey"]]);

      const set = await client.call<{ applied: string[]; refused: unknown[] }>(
        "host.set_plugin_config",
        { id: "demo", patch: { taskTag: "todo" } },
      );
      expect(set).toEqual({ id: "demo", applied: ["taskTag"], refused: [] });
      const after = await client.call<{ values: Record<string, unknown> }>(
        "host.get_plugin_config",
        { id: "demo" },
      );
      expect(after.values["taskTag"]).toBe("todo");

      // The placeholder written back is a refusal row with a path, and the rest
      // of the patch still lands.
      const guardedWrite = await client.call<{
        applied: string[];
        refused: Array<{ key: string; reason: string; path?: Array<string | number> }>;
      }>("host.set_plugin_config", {
        id: "demo",
        patch: { myApiKey: "[redacted]", taskTag: "done" },
      });
      expect(guardedWrite.applied).toEqual(["taskTag"]);
      expect(guardedWrite.refused).toEqual([
        { key: "myApiKey", reason: "redacted_value", path: ["myApiKey"] },
      ]);
    } finally {
      await harness.stop();
    }
  });

  it("answers plugin_data_too_deep and plugin_data_too_large as errors, never refusal rows", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["demo"],
      pluginData: { demo: { taskTag: "task" } },
      plugins: { demo: HostHarness.settingsPlugin },
      // Small enough that one ordinary string patch is over the cap. The
      // refusal is the host's own, before anything is written.
      config: { writeFileCapBytes: 64 },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await expect(
        client.call("host.set_plugin_config", { id: "demo", patch: deepPatch(80) }),
      ).rejects.toMatchObject({ code: "plugin_data_too_deep" });
      await expect(
        client.call("host.set_plugin_config", { id: "demo", patch: { taskTag: "x".repeat(200) } }),
      ).rejects.toMatchObject({ code: "plugin_data_too_large" });
      // Nothing was written by either refusal.
      const after = await client.call<{ values: Record<string, unknown> }>(
        "host.get_plugin_config",
        { id: "demo" },
      );
      expect(after.values["taskTag"]).toBe("task");
      expect(after.values["nest"]).toBeUndefined();
    } finally {
      await harness.stop();
    }
  });

  it("serves a compat report that leaks no settings values and no live objects", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["demo"],
      pluginData: { demo: { myApiKey: "s3cret" } },
      plugins: { demo: HostHarness.settingsPlugin },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      const reported = await client.call<{
        report: {
          generated_at_unix_ms: number;
          plugins: Array<{
            id: string;
            verdict: string;
            harness_attempted: boolean;
            harness: unknown;
            notes: string[];
            schema_source: string;
          }>;
        };
      }>("host.compat_report", { plugin_id: "demo" });
      const serialized = JSON.stringify(reported);
      expect(serialized).not.toContain("s3cret");
      expect(serialized).not.toContain('"tab"');
      // Every **field name**, at every depth. See the file header for why this
      // is a key walk rather than a regex over the text.
      expect(camelCaseKeys(reported)).toEqual([]);
      const row = reported.report.plugins[0];
      expect(row).toMatchObject({ id: "demo", harness_attempted: false, harness: null });
      // Not in dry-run, so nothing was attempted and the verdict is the tier
      // mapping rather than `unknown`.
      expect(["runs", "degrades"]).toContain(row?.verdict);
      expect(row?.notes[0]).toContain("not in dry-run");
      expect(row?.schema_source).toBe("none");
    } finally {
      await harness.stop();
    }
  });

  it("broadcasts host.overlap_changed when the GUI enables an overlapping plugin", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["quickadd"],
      plugins: { quickadd: HostHarness.settingsPlugin },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      await client.call("host.subscribe", {});
      const event = client.nextEvent("host.overlap_changed");
      harness.setGuiEnabled(["quickadd"]);
      await harness.advanceClock(60_000);
      await expect(event).resolves.toMatchObject({
        overlap: ["quickadd"],
        gui_enabled: ["quickadd"],
      });
    } finally {
      await harness.stop();
    }
  });

  it("reports only absent symbols as unsupported — an unreachable registration is not one", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["viewer"],
      plugins: {
        viewer: (api) =>
          class extends api.Plugin {
            override onload(): void {
              // Accepted and discarded: it records an unreachable row and a
              // `safe_stub` policy hit, and neither is an unsupported symbol.
              this.registerView("demo-view", class {});
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      const info = await client.call<{
        unsupported: Array<{ symbol: string; policy: string; plugin_id: string | null }>;
      }>("host.info", { refresh: true });
      expect(harness.harvest.unreachable().map((row) => row.kind)).toContain("view");
      expect(info.unsupported.every((row) => row.policy === "absent")).toBe(true);
      expect(info.unsupported.map((row) => row.symbol)).not.toContain("Plugin.registerView");
    } finally {
      await harness.stop();
    }
  });
});
