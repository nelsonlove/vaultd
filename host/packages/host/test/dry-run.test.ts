import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_REGISTRY, PluginConfigService } from "../src/settings/plugin-config";
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
});
