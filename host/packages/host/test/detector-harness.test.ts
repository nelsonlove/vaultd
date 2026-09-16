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
