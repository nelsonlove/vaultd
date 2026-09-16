/* eslint-disable @typescript-eslint/require-await --
 * `async onload()` with nothing awaited inside it is what the corpus actually
 * writes, and it is the shape the brief pins these cases in. The same reason
 * `shim-plugin.test.ts` carries this line: rewriting them synchronous to
 * satisfy the rule would test the one case that needs no awaiting.
 */
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";
import { summaryLine } from "../src/detector/report";

describe("Detector.runHarness", () => {
  it("records every shim symbol a scripted plugin touches, in order, with its policy", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      config: { dryRun: true },
      plugins: {
        scripted: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            const file = this.app.vault.getFileByPath("A.md")!;
            this.app.metadataCache.getFileCache(file);          // implemented
            await this.app.vault.modify(file, "# changed\n");   // implemented + a write
            this.registerView("scripted-view", () => ({}));     // safe_stub + unreachable
            this.app.vault.adapter.getResourcePath("A.md");     // safe_stub
            try {
              (api as unknown as { htmlToMarkdown(html: string): string })
                .htmlToMarkdown("<p>x</p>");                    // absent -> throws
            } catch {
              // swallowed on purpose: the detector must record the throw even
              // when the plugin catches it, which is the common real case.
            }
          }
        },
      },
    });
    await harness.lifecycle.start();

    const result = await harness.detector.runHarness("scripted");
    expect(result.loaded).toBe(true);
    expect(result.loadError).toBeNull();

    expect(result.calls.map((call) => call.symbol)).toEqual([
      "MetadataCache.getFileCache",
      "Vault.modify",
      "Plugin.registerView",
      "DataAdapter.getResourcePath",
      "htmlToMarkdown",
    ]);
    expect(result.calls.map((call) => call.policy)).toEqual([
      "implemented", "implemented", "safe_stub", "safe_stub", "absent",
    ]);

    expect(result.throws).toHaveLength(1);
    expect(result.throws[0]).toMatchObject({
      symbol: "htmlToMarkdown", policy: "absent", pluginId: "scripted",
    });
    expect(result.throws[0]?.threw).toContain("htmlToMarkdown");

    // The write was recorded, not forwarded: the harness runs under DryRunGate.
    expect(result.writes).toEqual([{
      kind: "vault", method: "write_note", pluginId: "scripted",
      params: { path: "A.md", content: "# changed\n", expected: { revision: harness.revisionOf("A.md") } },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- `expect.any` is typed `any`
      atUnixMs: expect.any(Number),
    }]);
    expect(harness.daemonMethodsSeen()).not.toContain("write_note");

    expect(result.harvest).toEqual({
      commands: 0, menuHooks: 0, protocolHandlers: 0, unreachable: 1,
    });
  });

  it("records loadError and loaded false for a bundle that throws in onload", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        broken: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            throw new Error("boom during onload");
          }
        },
      },
    });
    await harness.lifecycle.start();
    // Must not propagate: the detector's whole job is to survive plugins that
    // do not, and report why.
    const result = await harness.detector.runHarness("broken");
    expect(result.loaded).toBe(false);
    expect(result.loadError).toContain("boom during onload");
    expect(result.calls).toEqual([]);
    expect(result.throws).toEqual([]);
  });

  it("attributes calls to the plugin under harness and to no other", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: ["bystander"], config: { dryRun: true },
      plugins: {
        bystander: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(this.app.metadataCache.on("changed", () => {
              this.app.vault.getMarkdownFiles();
            }));
          }
        },
        probed: (api) => class extends api.Plugin {
          override async onload(): Promise<void> { this.app.vault.getMarkdownFiles(); }
        },
      },
    });
    await harness.lifecycle.start();
    const result = await harness.detector.runHarness("probed");
    expect(result.calls.every((call) => call.pluginId === "probed")).toBe(true);
  });

  it("merges scan and harness into one verdict per plugin", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        quiet: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "go", name: "Go", callback: () => {} });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const report = await harness.detector.report("quiet");
    expect(report.plugins).toHaveLength(1);
    expect(report.plugins[0]).toMatchObject({
      id: "quiet", verdict: "runs", schemaSource: "none",
    });
    expect(report.plugins[0]?.harness).not.toBeNull();
    expect(report.generatedAtUnixMs).toBeGreaterThan(0);
  });

  // The two cases below are not in the brief. They pin dispatch rulings 1 and
  // 6, which the brief's own cases have no occasion to reach.
  it("refuses a harness run outside dry-run, and still reports the scan", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: [],
      plugins: {
        quiet: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "go", name: "Go", callback: () => {} });
          }
        },
      },
    });
    await harness.lifecycle.start();
    // Loading a plugin for real in a host that is not pretending would run its
    // `onload` against the vault, and a plugin whose `onload` writes is
    // ordinary. So the refusal is typed, and the scan — which reads bytes and
    // changes nothing — is unaffected.
    await expect(harness.detector.runHarness("quiet")).rejects.toMatchObject({
      code: "detector_requires_dry_run",
    });
    const report = await harness.detector.report("quiet");
    expect(report.plugins[0]?.harness).toBeNull();
    expect(report.plugins[0]?.scan.pluginId).toBe("quiet");
    // Nothing was attempted, so the tier mapping is the honest answer and the
    // verdict is not `unknown`: the two ways `harness` is null are different
    // facts and `harnessAttempted` is what tells them apart.
    expect(report.plugins[0]?.harnessAttempted).toBe(false);
    expect(report.plugins[0]?.verdict).toBe("runs");
  });

  it("leaves a plugin that was enabled but never loaded enabled", async () => {
    // Enabled and loaded are different sets, and the difference is exactly the
    // plugin a compatibility report is most likely being asked about: one the
    // user switched on whose `onload` threw. Deciding the restore from the
    // loaded list took it out of the enabled set — a de-registration nobody
    // asked for, as a side effect of asking a question.
    const harness = await HostHarness.create({
      vault: {}, enabled: ["fails", "fine"], config: { dryRun: true },
      plugins: {
        fails: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            throw new Error("start-time boom");
          }
        },
        fine: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "go", name: "Go", callback: () => {} });
          }
        },
      },
    });
    await harness.lifecycle.start();
    expect(await harness.dir.readEnabledSet()).toEqual(["fails", "fine"]);
    expect(harness.lifecycle.loadedPlugins()).toEqual(["fine"]);

    const result = await harness.detector.runHarness("fails");
    expect(result.loaded).toBe(false);
    expect(await harness.dir.readEnabledSet()).toEqual(["fails", "fine"]);
    // Byte-checked through the daemon: nothing was written at all, so there is
    // no enabled set on the wire for the restore to have got wrong.
    expect(harness.writtenFile(".obsidian-headless/community-plugins.json")).toBeUndefined();
    expect(harness.daemonMethodsSeen()).not.toContain("write_file");
  });

  it("keeps the host's diagnosis of a plugin it probed", async () => {
    // The restore is a restore, not a decision: a user's `disable` forgets the
    // failure window on purpose, and a detector that forgot it would hand a
    // plugin sitting at four of five failures a clean slate and erase the
    // sequencer's answer to "why isn't this running".
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        broken: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            throw new Error("boom during onload");
          }
        },
      },
    });
    await harness.lifecycle.start();
    const result = await harness.detector.runHarness("broken");
    expect(result.loaded).toBe(false);
    // Visible: the failure this probe provoked is the plugin's own, and the
    // host's answer to "why isn't this running" survives the restore.
    expect(harness.lastHandlerError("broken")?.message).toBe("boom during onload");
    expect(harness.lifecycle.loadFailures().get("broken")).toContain("rolled back");
    // Uncounted: see the next case. A question the operator asked must not
    // move a plugin toward quarantine.
    expect(harness.quarantine.failuresFor("broken")).toBe(0);
    // And the plugin is back out of the enabled set, which is the other half.
    expect(await harness.dir.readEnabledSet()).toEqual([]);
  });

  it("never advances a plugin toward quarantine by probing it", async () => {
    // Before the probe flag: five compat reports inside the rolling minute
    // quarantined a plugin no user action had touched, and the sixth then
    // answered `harness: null` for a reason the detector itself manufactured.
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        broken: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            throw new Error("boom during onload");
          }
        },
      },
    });
    await harness.lifecycle.start();
    for (let run = 0; run < 5; run += 1) {
      const result = await harness.detector.runHarness("broken");
      expect(result.loaded).toBe(false);
    }
    expect(harness.quarantine.failuresFor("broken")).toBe(0);
    expect(harness.quarantine.isQuarantined("broken")).toBe(false);
    expect(harness.lastHandlerError("broken")?.message).toBe("boom during onload");

    // A real enable still counts: the flag narrows what a probe does, not what
    // the quarantine is for.
    await expect(harness.lifecycle.enableLate("broken")).rejects.toThrow("could not be enabled");
    expect(harness.quarantine.failuresFor("broken")).toBe(1);
  });

  it("forgets on an operator's plain disable, which is the other half of the ruling", async () => {
    // The detector's restore preserves; a user switching a plugin off still
    // starts the next enable from nothing. Both halves, or neither is pinned.
    const harness = await HostHarness.create({
      vault: {}, enabled: ["broken"], config: { dryRun: true },
      plugins: {
        broken: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            throw new Error("boom during onload");
          }
        },
      },
    });
    await harness.lifecycle.start();
    expect(harness.lifecycle.loadFailures().get("broken")).toContain("rolled back");
    expect(harness.quarantine.failuresFor("broken")).toBe(1);

    await harness.lifecycle.disable("broken");
    expect(harness.quarantine.failuresFor("broken")).toBe(0);
    expect(harness.lastHandlerError("broken")).toBeNull();
    expect(harness.lifecycle.loadFailures().size).toBe(0);
  });

  it("credits a bystander's event handler to the bystander, not to the probed plugin", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: ["bystander"], config: { dryRun: true },
      plugins: {
        bystander: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(
              this.app.workspace.on("probe-ping", () => {
                this.app.vault.adapter.getResourcePath("A.md");
              }),
            );
          }
        },
        probed: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.app.vault.adapter.getResourcePath("A.md");
            this.app.workspace.trigger("probe-ping");
          }
        },
      },
    });
    await harness.lifecycle.start();
    const result = await harness.detector.runHarness("probed");
    // Two `getResourcePath` calls happened; one of them was the bystander's,
    // fired inside the probed plugin's `onload`. Before the attribution window
    // in `ShimEventBus.tryTrigger`, both were recorded against `probed` and no
    // filter could tell them apart, because the id itself was wrong.
    expect(result.calls.map((call) => call.symbol)).toEqual(["DataAdapter.getResourcePath"]);
    expect(result.calls.every((call) => call.pluginId === "probed")).toBe(true);
  });

  it("counts a handler failure against the plugin that registered the handler", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["bystander"], config: { dryRun: true },
      plugins: {
        bystander: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(
              this.app.workspace.on("probe-ping", () => {
                throw new Error("bystander handler blew up");
              }),
            );
          }
        },
        probed: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.app.workspace.trigger("probe-ping");
          }
        },
      },
    });
    await harness.lifecycle.start();
    const result = await harness.detector.runHarness("probed");
    // The probed plugin's load is not what failed, so it loads.
    expect(result.loaded).toBe(true);
    expect(harness.lastHandlerError("bystander")?.message).toBe("bystander handler blew up");
    expect(harness.lastHandlerError("probed")).toBeNull();
  });

  it("reads only its own window, so a second run is not the first one again", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: [], config: { dryRun: true },
      plugins: {
        twice: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.app.vault.adapter.getResourcePath("A.md");
          }
        },
      },
    });
    await harness.lifecycle.start();
    const first = await harness.detector.runHarness("twice");
    const second = await harness.detector.runHarness("twice");
    expect(first.calls.map((call) => call.symbol)).toEqual(["DataAdapter.getResourcePath"]);
    // Identical, not doubled: a window read from zero would hand the second
    // run the first run's rows as well.
    expect(second.calls.map((call) => call.symbol)).toEqual(first.calls.map((call) => call.symbol));
  });

  it("takes its own rows back out of the host's dry-run log", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: [], config: { dryRun: true },
      plugins: {
        writer: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            const file = this.app.vault.getFileByPath("A.md")!;
            await this.app.vault.modify(file, "# changed\n");
          }
        },
      },
    });
    await harness.lifecycle.start();
    const result = await harness.detector.runHarness("writer");
    expect(result.writes).toHaveLength(1);
    // The operator's own dry-run report must not show two enabled-set rewrites
    // and a note mutation that no ordinary run of this host would produce.
    expect(harness.dryRun.writes()).toEqual([]);
    expect(result.harnessLimits.join(" ")).toContain("overlay still reflects them");
  });

  it("removes only the rows the probe caused, and leaves a bystander's alone", async () => {
    // The first version of this dropped by position and deleted everything any
    // caller recorded inside the window. A probed plugin's load wakes every
    // other loaded plugin's handlers, so a bystander writing from one is not
    // exotic — and the operator's dry-run report is the artifact that decides
    // whether the run is safe to perform for real.
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "B.md": "# B\n" }, enabled: ["bystander"], config: { dryRun: true },
      plugins: {
        bystander: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(
              this.app.workspace.on("probe-ping", () => {
                const file = this.app.vault.getFileByPath("B.md")!;
                void this.app.vault.modify(file, "# bystander was here\n");
              }),
            );
          }
        },
        probed: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            const file = this.app.vault.getFileByPath("A.md")!;
            await this.app.vault.modify(file, "# probed was here\n");
            this.app.workspace.trigger("probe-ping");
          }
        },
      },
    });
    await harness.lifecycle.start();
    const result = await harness.detector.runHarness("probed");
    expect(result.writes.map((write) => write.pluginId)).toEqual(["probed"]);
    // The probe's own rows are gone; the bystander's survives, correctly
    // attributed (which is B2's fix doing the work this one depends on).
    expect(harness.dryRun.writes().map((write) => [write.method, write.pluginId])).toEqual([
      ["write_note", "bystander"],
    ]);
  });

  it("drops by tag and not by position, so a row nobody attributed survives", async () => {
    // **At the gate, deliberately.** The reviewer's case is a second client's
    // `write_note` landing inside the probe's window with `pluginId: null` —
    // the same shape the host's own enabled-set bookkeeping has, so a rule
    // that dropped null rows would take the client's with it. It cannot be
    // staged through the detector: a plugin's attribution window is ambient
    // and stays open across its awaits, so *any* write made while a probed
    // plugin's `onload` is parked carries that plugin's id (a pre-existing
    // property of the design, not of this change). The rule the case is about
    // is the gate's, so this pins it there, on the real gate the assembly
    // built.
    const harness = await HostHarness.create({ vault: {}, enabled: [], config: { dryRun: true } });
    await harness.lifecycle.start();
    const gate = harness.dryRun;
    const write = async (path: string): Promise<void> => {
      await gate.send("write_note", { path, content: "# x\n", expected: { absent: true } });
    };

    await write("Before.md");
    const token = gate.beginProbe("probed");
    await write("Client.md");
    // The host's own bookkeeping on the way in and out: `pluginId: null` and
    // the enabled set's own path, which is the one shape the tag claims
    // without an identity behind it.
    await gate.send("write_file", {
      path: ".obsidian-headless/community-plugins.json",
      content_base64: Buffer.from('["probed"]', "utf8").toString("base64"),
    });
    gate.dropProbe(token);

    expect(gate.writes().map((row) => (row.params as { path: string }).path)).toEqual([
      "Before.md",
      "Client.md",
    ]);
  });

  it("restores even when the run throws after the load", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        one: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "go", name: "Go", callback: () => {} });
          }
        },
        two: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "go", name: "Go", callback: () => {} });
          }
        },
      },
    });
    await harness.lifecycle.start();
    // The stretch between the load and the result is the host's own code and
    // does not throw in practice; a throw injected into it is how the property
    // — the restore holds on the way out of a failure too — gets asserted.
    const commands = harness.harvest.commands.bind(harness.harvest);
    let thrown = false;
    harness.harvest.commands = (): never[] => {
      if (thrown) return commands() as never[];
      thrown = true;
      throw new Error("harvest exploded mid-run");
    };
    const report = await harness.detector.report();
    harness.harvest.commands = commands;

    const one = report.plugins.find((row) => row.id === "one");
    expect(one?.harness).toBeNull();
    expect(one?.notes.join(" ")).toContain("harness failed mid-run: harvest exploded");
    expect(one?.verdict).toBe("unknown");
    // The probed plugin is not left running, and not left enabled.
    expect(harness.lifecycle.loadedPlugins()).not.toContain("one");
    expect(await harness.dir.readEnabledSet()).toEqual([]);
    // And the rest of the report still ran.
    expect(report.plugins.find((row) => row.id === "two")?.harness).not.toBeNull();
  });

  it("attributes a confirm prompt the way a modal is attributed", async () => {
    // Two prompt paths, one handler turn: the modal reads `currentPluginId()`
    // and named the bystander, while the confirm preferred the dispatch
    // queue's entry point and named the plugin whose load had raised the
    // event. Consistent, or one of them is lying about who is asking.
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: ["bystander"], config: { dryRun: true },
      plugins: {
        bystander: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(
              this.app.workspace.on("probe-ping", () => {
                const file = this.app.vault.getFileByPath("A.md")!;
                void this.app.fileManager.promptForDeletion(file);
              }),
            );
          }
        },
        probed: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.app.workspace.trigger("probe-ping");
          }
        },
      },
    });
    await harness.lifecycle.start();
    const session = { owner: {}, label: "test-client", deliver: (): boolean => true };
    harness.broker.attach(session);
    await harness.detector.runHarness("probed");
    expect(harness.broker.pending().map((request) => request.pluginId)).toEqual(["bystander"]);
    // Detaching fails the pending prompt, which `promptForDeletion` swallows
    // into `false` — nothing is left armed.
    harness.broker.detach(session);
  });

  it("carries a dry-run refusal into the result without moving the verdict", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        fetcher: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            try {
              await api.requestUrl({ url: "https://example.test/" });
            } catch {
              // A plugin that catches its own failed fetch is the common case.
            }
          }
        },
      },
    });
    await harness.lifecycle.start();
    const report = await harness.detector.report("fetcher");
    const row = report.plugins[0];
    expect(row?.harness?.refusals).toEqual([
      { surface: "network", detail: "https://example.test/" },
    ]);
    // A refusal is a fact about the run, not a missing surface: the symbol is
    // still `implemented`, nothing threw, and the verdict is unmoved.
    expect(row?.harness?.throws).toEqual([]);
    expect(row?.verdict).toBe("runs");
    expect(summaryLine(row!)).toContain("1 refused by dry-run (network)");
  });

  it("degrades a plugin that reached for an absent symbol", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        reacher: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            try {
              (api as unknown as { htmlToMarkdown(html: string): string }).htmlToMarkdown("<p>x</p>");
            } catch {
              // Swallowed, as the corpus swallows it.
            }
          }
        },
      },
    });
    await harness.lifecycle.start();
    const report = await harness.detector.report("reacher");
    expect(report.plugins[0]?.harness?.harvest.unreachable).toBe(0);
    expect(report.plugins[0]?.verdict).toBe("degrades");
  });

  it("says so when the plugin was already loaded, and leaves it loaded", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["live"], config: { dryRun: true },
      plugins: {
        live: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "go", name: "Go", callback: () => {} });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const result = await harness.detector.runHarness("live");
    expect(result.loaded).toBe(true);
    expect(result.calls).toEqual([]);
    expect(result.harnessLimits.join(" ")).toContain("was already loaded");
    // A detector must not be the reason a plugin stopped.
    expect(harness.lifecycle.loadedPlugins()).toContain("live");
    expect(await harness.dir.readEnabledSet()).toEqual(["live"]);
  });

  it("refuses to run a quarantined plugin, and reports the rest anyway", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["jailed", "healthy"],
      config: { dryRun: true, quarantineFailures: 1 },
      plugins: {
        jailed: HostHarness.throwingPlugin,
        healthy: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "go", name: "Go", callback: () => {} });
          }
        },
      },
    });
    await harness.lifecycle.start();
    // Straight through the tracker, which is the host's own component and the
    // one the sequencer records into: the alternative is five socket round
    // trips to put the host in a state this case only wants to start from.
    await harness.quarantine.record({
      pluginId: "jailed",
      label: "command:jailed:boom",
      error: new Error("boom"),
      atUnixMs: harness.config.clock.now(),
    });
    expect(harness.quarantine.isQuarantined("jailed")).toBe(true);

    await expect(harness.detector.runHarness("jailed")).rejects.toMatchObject({
      code: "plugin_quarantined",
    });

    // A host holding a quarantined plugin is exactly the host an operator
    // wants a report from, so one plugin's refusal is one row's and not the
    // report's.
    const report = await harness.detector.report();
    expect(report.plugins.map((row) => row.id)).toEqual(["healthy", "jailed"]);
    const jailed = report.plugins.find((row) => row.id === "jailed");
    expect(jailed?.harness).toBeNull();
    expect(jailed?.notes.join(" ")).toContain("quarantined");
    // **Not `runs`.** The tier mapping means "nothing was tried here", and
    // something was: the host refuses to run this plugin, so the field a
    // client renders on its own must not read green.
    expect(jailed?.verdict).toBe("unknown");
    expect(jailed?.harnessAttempted).toBe(true);
    expect(summaryLine(jailed!)).toContain("unknown");
    const healthy = report.plugins.find((row) => row.id === "healthy");
    expect(healthy?.harness).not.toBeNull();
    expect(healthy?.verdict).toBe("runs");
  });

  it("renders an undescribed schema as not yet described, never as no settings", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        quiet: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "go", name: "Go", callback: () => {} });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const report = await harness.detector.report("quiet");
    const row = report.plugins[0];
    expect(row?.schemaSource).toBe("none");
    const line = summaryLine(row!);
    expect(line).toContain("settings not yet described");
    expect(line).not.toContain("no settings");
  });
});
