import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_REGISTRY, PluginConfigService } from "../src/settings/plugin-config";
import { DryRunRefused } from "../src/dryrun/dry-run";
import { refuseInDryRun } from "../src/shim/policy";
import { HostHarness } from "../src/testing/host-harness";
import { SchemaLadder } from "../src/settings/ladder";
import { electronModule } from "../src/runtime/electron-registry";

describe("dry-run", () => {
  it("records a vault write instead of forwarding it, and reports success to the plugin", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: ["writer"], config: { dryRun: true },
      plugins: {
        writer: (api) => class extends api.Plugin {
          override onload(): void {
            this.addCommand({
              id: "write", name: "Write",
              callback: async () => {
                const file = this.app.vault.getFileByPath("A.md")!;
                await this.app.vault.modify(file, "# changed\n");
              },
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    // **Cleared after the handshake, not before it.** `host.hello` answers with
    // `plugins: PluginState[]`, which the host reads out of its config
    // directory — one `read_dir` and one `read_file`. Those are the host's own
    // *reads*, and dry-run deliberately intercepts no read at all, so a clear
    // taken before the connect would be asserting that the handshake does not
    // read rather than that the command does not write. The window this case is
    // about is the invoke.
    harness.clearDaemonMethodLog();
    await client.call("host.invoke_command", { command_id: "writer:write" });
    expect(harness.daemonMethodsSeen()).toEqual([]);
    expect(harness.dryRun.writes()).toEqual([{
      kind: "vault", method: "write_note", pluginId: "writer",
      params: { path: "A.md", content: "# changed\n", expected: { revision: harness.revisionOf("A.md") } },
      atUnixMs: expect.any(Number) as unknown,
    }]);
    expect(harness.lastHandlerError("writer")).toBeNull();
  });

  it("refuses network by default and allows it with the flag", async () => {
    const refused = await HostHarness.create({
      vault: {}, enabled: ["fetcher"], config: { dryRun: true },
      plugins: { fetcher: HostHarness.requestUrlPlugin },
    });
    await refused.lifecycle.start();
    await refused.invoke("fetcher:fetch");
    expect(refused.lastHandlerError("fetcher")?.message).toMatch(/dry_run_refused/);
    expect(refused.dryRun.refusals()).toEqual([{ surface: "network", detail: "https://example.test/" }]);

    const allowed = await HostHarness.create({
      vault: {}, enabled: ["fetcher"],
      config: { dryRun: true, dryRunAllowNetwork: true },
      plugins: { fetcher: HostHarness.requestUrlPlugin },
    });
    await allowed.lifecycle.start();
    await allowed.invoke("fetcher:fetch");
    expect(allowed.dryRun.refusals()).toEqual([]);
    // **What "allowed" means here, said out loud.** `--dry-run-allow-network`
    // stands the dry-run refusal down and hands the question back to
    // `allowNetwork`, which every harness pins to `false` — so the call still
    // fails, with the *other* error. Asserting the message is what keeps this
    // half from passing for the wrong reason: a build that refused with
    // `dry_run_refused` regardless of the flag would otherwise look identical
    // from `refusals()` alone if the sink were also broken.
    expect(allowed.lastHandlerError("fetcher")?.message).toMatch(/network access is disabled/);
    expect(allowed.lastHandlerError("fetcher")?.message).not.toMatch(/dry_run_refused/);
  });

  it("records notices and refuses the OS bridge", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["noisy"], config: { dryRun: true },
      plugins: {
        noisy: (api) => class extends api.Plugin {
          override onload(): void {
            this.addCommand({
              id: "go", name: "Go",
              callback: async () => {
                new api.Notice("hello");
                // `electronModule()` rather than the brief's bare
                // `require("electron")`, and it is the **same object**: the
                // workspace's `electron` package is a forwarding proxy over
                // this registry, and the module patch answers the bare
                // specifier out of it too. A literal `require` in a test file
                // resolves through the compiled `dist` copy of the registry
                // instead — a second module instance, which no assembly ever
                // registered a stub into.
                await electronModule().shell.openPath("/tmp/x");
              },
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    await harness.invoke("noisy:go");
    expect(harness.dryRun.notices()).toEqual([{
      pluginId: "noisy", message: "hello",
      atUnixMs: expect.any(Number) as unknown, timeoutMs: null,
    }]);
    // The same entry is in the shared log, because there is only one log.
    expect(harness.noticeLog.entries()).toContainEqual(harness.dryRun.notices()[0]);
    expect(harness.dryRun.refusals()).toEqual([{ surface: "os_bridge", detail: "openPath /tmp/x" }]);
  });

  it("leaves reads and timers untouched", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: ["reader"], config: { dryRun: true },
      plugins: {
        reader: (api) => class extends api.Plugin {
          read?: string;
          override async onload(): Promise<void> {
            this.read = await this.app.vault.read(this.app.vault.getFileByPath("A.md")!);
            // `harness.window`, not the bare global the brief wrote: the host
            // really does install `globalThis.window`, but TypeScript's node
            // lib declares no such name, so a test file cannot say it. This is
            // the same object — `assembly.globals.window` — and the spelling
            // every other case in this suite uses.
            this.registerInterval(harness.window.setInterval(() => {}, 1000));
          }
        },
      },
    });
    await harness.lifecycle.start();
    const plugin = harness.app.plugins.getPlugin("reader") as unknown as { read: string };
    expect(plugin.read).toBe("# A\n");
    expect(harness.harvest.timers()).toHaveLength(1);
    expect(harness.dryRun.refusals()).toEqual([]);
  });

  /**
   * The carry from Task 17: a plugin-config write is a write.
   *
   * Both of the host's two writers of a `data.json` — the plugin's own
   * `saveData` and the client-facing `PluginConfigService.set` — go through the
   * same gate every vault write does, so a dry run records them as
   * `plugin_config` and the daemon never sees a `write_file`. Before this they
   * went straight to the client, which meant `--dry-run` changed a plugin's
   * settings on disk while reporting that it had changed nothing.
   */
  it("records plugin-config writes and forwards none of them", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["saver"], config: { dryRun: true },
      plugins: {
        saver: (api) => class extends api.Plugin {
          override onload(): void {
            this.addCommand({
              id: "save", name: "Save",
              callback: () => this.saveData({ greeting: "hello" }),
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    harness.clearDaemonMethodLog();
    await harness.invoke("saver:save");

    // The other writer of the same file: the one a client reaches over the
    // socket. Built over the assembly's own config directory, which is the one
    // wired to the gate.
    const service = new PluginConfigService(
      harness.dir,
      new SchemaLadder(harness.config.dataDir, harness.config.clock),
      DEFAULT_KEY_REGISTRY,
      harness.config,
    );
    await service.set("saver", { greeting: "goodbye" });

    const dataPath = `${harness.config.configDirName}/plugins/saver/data.json`;
    expect(harness.dryRun.writes().map((write) => ({ kind: write.kind, method: write.method }))).toEqual([
      { kind: "plugin_config", method: "write_file" },
      { kind: "plugin_config", method: "write_file" },
    ]);
    for (const write of harness.dryRun.writes()) {
      expect((write.params as { path: string }).path).toBe(dataPath);
    }
    expect(harness.daemonMethodsSeen()).not.toContain("write_file");
    expect(harness.lastHandlerError("saver")).toBeNull();
    // Nothing landed, so the file the daemon holds is the one it held before.
    expect(harness.writtenFile(dataPath)).toBeUndefined();
  });

  /**
   * The third writer of the config directory, which the pin above does not
   * reach: the enabled set a late enable persists.
   *
   * Mutation testing found this one uncovered — a `writeEnabledSet` that went
   * straight to the client survived every case in the file. A dry run that
   * silently enabled a plugin for the next restart has changed the host's
   * configuration while reporting that it changed nothing.
   */
  it("records the enabled set a late enable writes", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        late: (api) => class extends api.Plugin {
          override onload(): void {
            this.addCommand({ id: "noop", name: "No-op", callback: () => undefined });
          }
        },
      },
    });
    await harness.lifecycle.start();
    harness.clearDaemonMethodLog();
    await harness.lifecycle.enableLate("late");

    const enabledSet = `${harness.config.configDirName}/community-plugins.json`;
    const recorded = harness.dryRun.writes().filter(
      (write) => (write.params as { path?: string }).path === enabledSet,
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.kind).toBe("plugin_config");
    expect(recorded[0]?.method).toBe("write_file");
    expect(harness.daemonMethodsSeen()).not.toContain("write_file");
    expect(harness.writtenFile(enabledSet)).toBeUndefined();
    // The plugin really is running — the dry run changed what happens, not
    // whether it happened.
    expect(harness.app.plugins.getPlugin("late")).not.toBeNull();
  });

  /**
   * The client's own road to the daemon is a write path, and the gate is on it.
   *
   * `server/ops.ts` proxies every non-`host.` method straight through. Without
   * the gate on that line a client could read `dry_run: true` off `host.hello`
   * and then mutate the real vault through the very socket that told it the
   * host was pretending.
   */
  it("records a client's own mutating request and forwards its reads", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: [], config: { dryRun: true },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    harness.clearDaemonMethodLog();

    await client.call("write_note", {
      path: "A.md",
      content: "# by the client\n",
      expected: { revision: harness.revisionOf("A.md") },
    });
    expect(harness.daemonMethodsSeen()).not.toContain("write_note");
    expect(harness.dryRun.writes()).toHaveLength(1);
    expect(harness.dryRun.writes()[0]).toMatchObject({
      kind: "vault",
      method: "write_note",
      // No plugin asked for this one. A row attributed to a plugin that was not
      // running would be a lie a report repeats.
      pluginId: null,
    });

    // Reads still go to the daemon: dry-run intercepts no read, and a client
    // that could not read through this host would be a different product.
    await client.call("read_file", { path: "A.md" });
    expect(harness.daemonMethodsSeen()).toContain("read_file");
  });

  /**
   * A synthetic answer is the daemon's answer or it is a lie, and the question
   * `semantic` asks is **not** the question `kind` asks.
   *
   * `kind` splits the host's storage in two and answers from `configDirName`.
   * `semantic` — and whether a `generation` is there at all — answers "did
   * these bytes land inside the indexed universe", which `docs/protocol.md`
   * decides by dot segment: the config zone and *any* hidden folder are
   * outside it. Conflating them made the gate hand `Vault.createFolder` a
   * generation the daemon would have withheld, so the shim took the indexed
   * branch and threw on a call that works for real.
   *
   * The expected column is the release daemon's own answer, measured.
   */
  it("answers with the daemon's indexability rule, not the config-directory one", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
    });
    const gate = harness.dryRun;
    const generation = harness.mirror.generation();

    const folders: ReadonlyArray<readonly [string, unknown]> = [
      [".hidden", {}],
      [".obsidian/x", {}],
      [`${harness.config.configDirName}/x`, {}],
      ["Plain", { generation }],
    ];
    for (const [path, expected] of folders) {
      await expect(gate.send("create_folder", { path })).resolves.toEqual(expected);
    }

    const files: ReadonlyArray<readonly [string, unknown]> = [
      [".hidden/a.json", { revision: "blake3:dry-run", semantic: false }],
      [".obsidian/a.json", { revision: "blake3:dry-run", semantic: false }],
      [
        `${harness.config.configDirName}/a.json`,
        { revision: "blake3:dry-run", semantic: false },
      ],
      ["Plain/a.json", { generation, revision: "blake3:dry-run", semantic: true }],
    ];
    for (const [path, expected] of files) {
      await expect(gate.send("write_file", { path, content_base64: "" })).resolves.toEqual(expected);
    }

    // `kind` is unchanged by any of it — that is ruling 5, and it is a different
    // question. Only the host's own config directory is `plugin_config`.
    const kinds = gate.writes().map((write) => [(write.params as { path: string }).path, write.kind]);
    expect(kinds).toEqual([
      [".hidden", "vault"],
      [".obsidian/x", "vault"],
      [`${harness.config.configDirName}/x`, "plugin_config"],
      ["Plain", "vault"],
      [".hidden/a.json", "vault"],
      [".obsidian/a.json", "vault"],
      [`${harness.config.configDirName}/a.json`, "plugin_config"],
      ["Plain/a.json", "vault"],
    ]);
  });

  /**
   * The end-to-end half of the same finding: an ordinary folder create no
   * longer throws under dry-run.
   *
   * A plugin whose `onload` makes a folder is ordinary — every daily-notes
   * shaped plugin does it — and a harness that threw would have Task 20's
   * detector verdict such a plugin `fails` for a defect of the mode.
   */
  it("makes a folder without throwing, indexed or hidden", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
    });
    for (const path of ["Plain", ".hidden/probe", `${harness.config.configDirName}/probe`]) {
      const folder = await harness.vault.createFolder(path);
      expect(folder.path).toBe(path);
    }
    expect(harness.daemonMethodsSeen()).not.toContain("create_folder");
  });

  /**
   * A call the daemon would refuse is refused here too.
   *
   * `docs/protocol.md`: `create_folder` and `write_file` serve the zone and
   * hidden folders; every other verb refuses them with `zone_violation`. A
   * synthetic success for a call that cannot happen puts "worked" in a
   * transcript for an operation that would have failed — the one reading a
   * detector must never get.
   *
   * Five verbs, not two. The deletes were the obvious pair; the renames and the
   * copy reach a dot path through `DataAdapter`, which takes the caller's own
   * two paths with no indexability check — and `app.vault.adapter` is the
   * ordinary surface a plugin uses to shuffle files inside its own cache
   * directory.
   */
  it("refuses a delete in an unindexable zone the way the daemon does", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
    });
    const gate = harness.dryRun;
    for (const [method, path] of [
      ["delete_note", ".obsidian/app.json"],
      ["delete_folder", ".trash"],
      ["delete_folder", `${harness.config.configDirName}/plugins`],
    ] as const) {
      // `body` is the undisturbed wire object; `VaultdError` prefixes the code
      // onto `message` itself, so a caller catching one of these here sees
      // exactly what it sees after a real refusal.
      await expect(gate.send(method, { path, mode: "permanent" })).rejects.toMatchObject({
        code: "zone_violation",
        message: `zone_violation: ${path} is outside the vault, or is not a valid target for this operation`,
        body: {
          code: "zone_violation",
          message: `${path} is outside the vault, or is not a valid target for this operation`,
        },
      });
    }
    // A folder rename on a dot path, and the two ends checked source first —
    // the daemon's own order, so an attempt to move something *out* of a
    // hidden zone is refused naming the source rather than the destination.
    for (const [method, from, to, named] of [
      ["rename_folder", ".trash", ".trash-old", ".trash"],
      ["rename_folder", "Plain", ".archive", ".archive"],
    ] as const) {
      await expect(
        gate.send(method, { from, to, rewrite_links: true }),
      ).rejects.toMatchObject({
        code: "zone_violation",
        body: {
          message: `${named} is outside the vault, or is not a valid target for this operation`,
        },
      });
    }
    // Refused, therefore not recorded: a `writes()` row means "the daemon would
    // have done this", and it would not have.
    expect(gate.writes()).toEqual([]);
    // An ordinary delete is still recorded.
    await gate.send("delete_note", { path: "Plain.md", mode: "permanent" });
    expect(gate.writes()).toHaveLength(1);
  });

  /**
   * The route that made the gap reachable: `DataAdapter`, which takes the
   * caller's own two paths with no indexability check.
   *
   * Driven through the shim rather than through the gate, because "a plugin can
   * reach this" is the whole finding — a unit call on the gate would prove the
   * refusal without proving it is ever asked for.
   */
  it("refuses an adapter rename or copy inside a hidden zone", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
    });
    const adapter = harness.vault.adapter;
    const expected = {
      code: "zone_violation",
      message:
        "zone_violation: .hidden/a.md is outside the vault, or is not a valid target for this operation",
      body: {
        code: "zone_violation",
        message: ".hidden/a.md is outside the vault, or is not a valid target for this operation",
      },
    };
    await expect(adapter.rename(".hidden/a.md", ".hidden/b.md")).rejects.toMatchObject(expected);
    await expect(adapter.copy(".hidden/a.md", ".hidden/b.md")).rejects.toMatchObject(expected);
    // Nothing recorded and nothing forwarded: the daemon would have refused
    // both, so a transcript saying otherwise would be worse than no transcript.
    expect(harness.dryRun.writes()).toEqual([]);
    expect(harness.daemonMethodsSeen()).not.toContain("rename_note");
    expect(harness.daemonMethodsSeen()).not.toContain("copy_file");
  });

  /**
   * `clear()`'s two halves, and the notice window's one.
   *
   * Ruling 2 spelled all three out and no case asserted any of them: mutation
   * testing found that a `clear()` which did nothing, and a `notices()` that
   * returned the whole shared log, both survived the suite. The asymmetry is
   * the point — the writes and the refusals are the gate's own and are emptied;
   * the notices belong to the host's one log and are only re-windowed.
   */
  it("clears its own records and re-windows the shared notice log", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["chatty"], config: { dryRun: true },
      plugins: {
        chatty: (api) => class extends api.Plugin {
          override onload(): void {
            this.addCommand({
              id: "say", name: "Say",
              callback: async () => {
                new api.Notice(this.sequence);
                await this.app.vault.createFolder(`Folder-${this.sequence}`);
                await electronModule().shell.openPath(`/tmp/${this.sequence}`);
              },
            });
          }
          sequence = "first";
        },
      },
    });
    await harness.lifecycle.start();
    await harness.invoke("chatty:say");
    expect(harness.dryRun.writes()).toHaveLength(1);
    expect(harness.dryRun.refusals()).toHaveLength(1);
    expect(harness.dryRun.notices().map((entry) => entry.message)).toEqual(["first"]);

    harness.dryRun.clear();
    expect(harness.dryRun.writes()).toEqual([]);
    expect(harness.dryRun.refusals()).toEqual([]);
    expect(harness.dryRun.notices()).toEqual([]);

    (harness.app.plugins.getPlugin("chatty") as unknown as { sequence: string }).sequence = "second";
    await harness.invoke("chatty:say");
    // Windowed, not erased: the gate sees only what came after the re-mark…
    expect(harness.dryRun.notices().map((entry) => entry.message)).toEqual(["second"]);
    // …while the host's one log still holds both, which is what
    // `host.invoke_command` reports from.
    expect(harness.noticeLog.entries().map((entry) => entry.message)).toEqual(["first", "second"]);
  });

  /**
   * Two live gates in one process is a test-only situation, and tearing the
   * first one down must not deafen the second.
   *
   * The refusal sink is module-level, so the last gate constructed owns it.
   * `uninstall()` used to clear it unconditionally: measured, gate A's teardown
   * took gate B's installation with it and the next refusal reached nobody.
   */
  it("gives up the refusal sink only when it still owns it", async () => {
    const first = await HostHarness.create({ vault: {}, enabled: [], config: { dryRun: true } });
    const second = await HostHarness.create({ vault: {}, enabled: [], config: { dryRun: true } });

    // Last installed wins.
    expect(() => refuseInDryRun("probe", "os_bridge", "one")).toThrow(DryRunRefused);
    expect(first.dryRun.refusals()).toEqual([]);
    expect(second.dryRun.refusals()).toEqual([{ surface: "os_bridge", detail: "one" }]);

    first.dryRun.uninstall();
    expect(() => refuseInDryRun("probe", "os_bridge", "two")).toThrow(DryRunRefused);
    expect(second.dryRun.refusals()).toEqual([
      { surface: "os_bridge", detail: "one" },
      { surface: "os_bridge", detail: "two" },
    ]);
  });

  /**
   * A recorded write is read after the fact, so it must not follow the caller's
   * object.
   */
  it("records a copy of the params, not the caller's object", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
    });
    const params = { path: "Plain.md", content: "before", expected: { absent: true } };
    await harness.dryRun.send("write_note", params);
    params.content = "after";
    expect((harness.dryRun.writes()[0]?.params as { content: string }).content).toBe("before");
  });
});
