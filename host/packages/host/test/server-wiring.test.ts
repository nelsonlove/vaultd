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

/** A promise somebody else settles — a parked `onload`, an occupied queue slot. */
function deferred(): { promise: Promise<void>; settle: () => void } {
  let settle = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
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
      pluginData: {
        demo: {
          taskTag: "task",
          myApiKey: "s3cret",
          // A secret one hop down **and inside an array**, so the wire case
          // catches a dotted flattening of the path grammar. With only the
          // top-level key, `[...path]` and `[path.join(".")]` are the same
          // value and the segment array is pinned at the service alone.
          accounts: [{ refreshToken: "arr3y" }],
        },
      },
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
      expect(guarded.redacted_keys).toEqual([["myApiKey"], ["accounts", 0, "refreshToken"]]);
      // The array index is a **number** on the wire, not the string "0": a
      // client acting on the path indexes an array with it.
      expect(guarded.redacted_keys[1]?.[1]).toBe(0);
      // The enum, never a rendering of it. `none` means "not yet described",
      // and that sentence is the document's to write, not the socket's.
      expect(guarded.schema.source).toBe("none");
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
      expect(revealed.redacted_keys).toEqual(guarded.redacted_keys);

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

      // **An array is not an object.** `Object.entries(["a","b"])` yields
      // index-keyed pairs, so an array accepted as a patch would write two
      // settings called `0` and `1` into the plugin's file. Refused by name,
      // with nothing written — and a missing patch is refused too, because an
      // empty patch is `{}` and an omitted one is a different question asked
      // by accident.
      await expect(
        client.call("host.set_plugin_config", { id: "demo", patch: ["taskTag", "todo"] }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        client.call("host.set_plugin_config", { id: "demo" }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      const untouched = await client.call<{ values: Record<string, unknown> }>(
        "host.get_plugin_config",
        { id: "demo" },
      );
      expect(untouched.values["taskTag"]).toBe("done");
      expect(untouched.values["0"]).toBeUndefined();
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

  it("needs a steady host for the report and the write, but never for the read", async () => {
    const parked = deferred();
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["slow"],
      pluginData: { slow: { taskTag: "task" } },
      plugins: {
        slow: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              await parked.promise;
            }
          },
      },
    });
    try {
      // Started, and deliberately not awaited: the host is in `loading` until
      // the plugin's `onload` returns.
      const starting = harness.lifecycle.start();
      const client = await harness.connectClient();

      // A report about a host that has not finished loading describes nothing.
      await expect(client.call("host.compat_report", {})).rejects.toMatchObject({
        code: "host_not_ready",
      });
      // And a write that lands before the loader's `loadData` silently changes
      // what the plugin loads with.
      await expect(
        client.call("host.set_plugin_config", { id: "slow", patch: { taskTag: "during" } }),
      ).rejects.toMatchObject({ code: "host_not_ready" });
      // Reading a settings document is well defined at every phase.
      const during = await client.call<{ values: Record<string, unknown> }>(
        "host.get_plugin_config",
        { id: "slow" },
      );
      expect(during.values["taskTag"]).toBe("task");

      parked.settle();
      await starting;

      const report = await client.call<{ report: { plugins: unknown[] } }>("host.compat_report", {
        plugin_id: "slow",
      });
      expect(report.report.plugins).toHaveLength(1);
      await expect(
        client.call("host.set_plugin_config", { id: "slow", patch: { taskTag: "after" } }),
      ).resolves.toMatchObject({ applied: ["taskTag"] });
    } finally {
      parked.settle();
      await harness.stop();
    }
  });

  it("reads unknown, never fails, when the host is what stopped the probe", async () => {
    const parked = deferred();
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["slow"],
      plugins: {
        slow: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              await parked.promise;
            }
          },
      },
      config: { dryRun: true },
    });
    try {
      const starting = harness.lifecycle.start();
      // In-process, because the socket operation is gated by the case above —
      // and this is the fact the gate protects, not the gate itself. Before the
      // fix the row read `verdict: "fails"`, `loaded: false` and an **empty**
      // `notes`: the worst word available, about a healthy plugin, with
      // nothing for the reader to argue with. The load error was the host's.
      const report = await harness.detector.report("slow");
      const row = report.plugins[0];
      expect(row?.verdict).toBe("unknown");
      expect(row?.harness).toBeNull();
      expect(row?.harnessAttempted).toBe(true);
      expect(row?.notes[0]).toContain("harness not run");
      expect(row?.notes[0]).toContain("not steady");
      parked.settle();
      await starting;
    } finally {
      parked.settle();
      await harness.stop();
    }
  });

  it("carries a dry run's writes, refusals and limits, with no bytes and no credentials", async () => {
    const harness = await HostHarness.create({
      vault: {},
      // Installed and **not** enabled, so the probe is what loads it: a plugin
      // already running records nothing it did at load time, which is a
      // different row with a different limit.
      enabled: [],
      plugins: {
        dryrunner: (api) =>
          class extends api.Plugin {
            override async onload(): Promise<void> {
              try {
                await api.requestUrl({
                  url: "https://api.example.test/v1/sync?key=URLSECRET#frag",
                });
              } catch {
                // The dry run refused it. That refusal is the point of the case.
              }
              await this.saveData({ taskTag: "x", myApiKey: "SAVEDSECRET" });
            }
          },
      },
      config: { dryRun: true },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      const reported = await client.call<{
        report: {
          plugins: Array<{
            harness_attempted: boolean;
            harness: {
              loaded: boolean;
              writes: Array<Record<string, unknown>>;
              refusals: Array<{ surface: string; detail: string }>;
              harness_limits: string[];
              harvest: Record<string, number>;
            } | null;
          }>;
        };
      }>("host.compat_report", { plugin_id: "dryrunner" });
      const row = reported.report.plugins[0];
      expect(row?.harness_attempted).toBe(true);
      const harnessRow = row?.harness;
      expect(harnessRow).not.toBeNull();
      expect(harnessRow?.loaded).toBe(true);

      // **The write rows carry no bytes.** `RecordedWrite.params` is the body
      // of the write — here, the whole of the plugin's saved settings — and a
      // report carrying it would be the copy of the configuration this report
      // exists not to make.
      expect(harnessRow?.writes.length).toBeGreaterThan(0);
      for (const write of harnessRow?.writes ?? []) {
        expect(Object.keys(write).sort()).toEqual([
          "at_unix_ms",
          "kind",
          "method",
          "plugin_id",
        ]);
      }

      // **A network refusal crosses as origin plus path.** The plugin put an
      // API key in the query string, which is what a plugin handing a stored
      // token to `requestUrl` does.
      const network = harnessRow?.refusals.find((refusal) => refusal.surface === "network");
      expect(network?.detail).toBe("https://api.example.test/v1/sync");

      // A run that recorded writes says so: the overlay still reflects them.
      expect(harnessRow?.harness_limits.length).toBeGreaterThan(0);
      expect(harnessRow?.harvest).toBeTypeOf("object");

      const serialized = JSON.stringify(reported);
      expect(serialized).not.toContain("SAVEDSECRET");
      expect(serialized).not.toContain("URLSECRET");
      expect(serialized).not.toContain("#frag");
      expect(camelCaseKeys(reported)).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it("refuses an id nobody installed, and creates no file for it", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: [],
      pluginData: { demo: { taskTag: "task" } },
      plugins: { demo: HostHarness.settingsPlugin },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      for (const call of [
        client.call("host.get_plugin_config", { id: "nobody" }),
        client.call("host.set_plugin_config", { id: "nobody", patch: { a: 1 } }),
        client.call("host.compat_report", { plugin_id: "nobody" }),
      ]) {
        await expect(call).rejects.toMatchObject({ code: "plugin_not_installed" });
      }
      // Byte-check through the daemon: a typo must not leave a stray file in
      // the config zone that nothing will ever read.
      expect(
        harness.writtenFile(`${harness.config.configDirName}/plugins/nobody/data.json`),
      ).toBeUndefined();

      // Installed but **not enabled** keeps its documented answer: installed is
      // the test, loaded is not.
      const disabled = await client.call<{ schema: { source: string } }>(
        "host.get_plugin_config",
        { id: "demo" },
      );
      expect(disabled.schema.source).toBe("none");
    } finally {
      await harness.stop();
    }
  });

  it("answers a set while the plugin is busy, and tells the plugin afterwards", async () => {
    const notified: string[] = [];
    const occupied = deferred();
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["demo"],
      pluginData: { demo: { taskTag: "task" } },
      plugins: {
        demo: (api) =>
          class extends api.Plugin {
            override onload(): void {
              // `onExternalSettingsChange` is Obsidian's own "your data.json
              // changed underneath you" signal, and it runs through the
              // dispatch queue like every other plugin entry point.
              this.onExternalSettingsChange = (): void => {
                notified.push("told");
              };
            }
          },
      },
    });
    try {
      await harness.lifecycle.start();
      const client = await harness.connectClient();
      // Stand in for a plugin that is already busy — a parked `onload`, a long
      // command. The queue is strict FIFO, so the notify this set provokes
      // queues behind it.
      const parking = harness.queue.run("demo", "park", () => occupied.promise);

      const set = await client.call<{ applied: string[] }>("host.set_plugin_config", {
        id: "demo",
        patch: { taskTag: "todo" },
      });
      // **The write is the contract.** Before the fix this call waited out the
      // whole of the plugin's queued work — measured at 1504 ms for a parked
      // load — with no timeout and nothing to say what it was waiting on.
      expect(set.applied).toEqual(["taskTag"]);
      expect(notified).toEqual([]);
      const after = await client.call<{ values: Record<string, unknown> }>(
        "host.get_plugin_config",
        { id: "demo" },
      );
      expect(after.values["taskTag"]).toBe("todo");

      // And the plugin is still told, once it is free.
      occupied.settle();
      await parking;
      await settleUntil(() => notified.length > 0);
      expect(notified).toEqual(["told"]);
    } finally {
      occupied.settle();
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
