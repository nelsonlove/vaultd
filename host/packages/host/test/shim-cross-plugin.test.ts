/**
 * `app.plugins` and `app.commands`: what one plugin can see of another, and the
 * one command map everything shares.
 *
 * Three cases, and each one is a shape the golden corpus really executes.
 * `getPlugin` answering `null` for a plugin that is not loaded is the branch
 * folder-notes, rollover and quickadd all take; the `editor:save-file`
 * monkeypatch is obsidian-linter's and automatic-linker's save path, and it is
 * the reason the seeded entry exists at all; and `executeCommandById` is how a
 * plugin runs a command it did not register.
 */

import { describe, expect, it } from "vitest";

import { ShimHarness } from "../src/testing/shim-harness";
import type { Editor } from "../src/shim/editor";

describe("app.plugins and app.commands", () => {
  it("exposes loaded plugins three ways and null for a missing one", async () => {
    const harness = await ShimHarness.withVault({});
    const alpha = harness.instantiate(
      "alpha",
      class extends harness.api.Plugin {
        api = { hello: (): string => "from alpha" };
      },
    );
    await harness.load(alpha);
    const plugins = harness.app.plugins;
    expect(plugins.getPlugin("alpha")).toBe(alpha);
    expect(plugins.plugins["alpha"]).toBe(alpha);
    expect(plugins.enabledPlugins.has("alpha")).toBe(true);
    expect(plugins.getPlugin("periodic-notes")).toBeNull();
    expect(plugins.plugins["periodic-notes"]).toBeUndefined();
    expect(plugins.enabledPlugins.has("periodic-notes")).toBe(false);
    const consumer = plugins.getPlugin("alpha") as unknown as { api: { hello(): string } };
    expect(consumer.api.hello()).toBe("from alpha");
  });

  it("seeds editor:save-file so a save monkeypatch installs and calls through", async () => {
    const harness = await ShimHarness.withVault({});
    const calls: string[] = [];
    const plugin = harness.instantiate(
      "linterish",
      class extends harness.api.Plugin {
        original?: ((checking: boolean) => boolean | void) | undefined;
        override onload(): void {
          const entry = this.app.commands.commands["editor:save-file"];
          this.original = entry?.checkCallback;
          if (entry && typeof this.original === "function") {
            entry.checkCallback = (checking: boolean): boolean | void => {
              calls.push(`patched:${String(checking)}`);
              return this.original!(checking);
            };
          }
        }
        override onunload(): void {
          const entry = this.app.commands.commands["editor:save-file"];
          if (entry && this.original) entry.checkCallback = this.original;
        }
      },
    );
    await harness.load(plugin);
    const patched = harness.app.commands.commands["editor:save-file"]!;
    expect(patched.checkCallback?.(false)).toBe(true);
    expect(calls).toEqual(["patched:false"]);
    await harness.unload("linterish");
    expect(harness.app.commands.commands["editor:save-file"]?.checkCallback?.(false)).toBe(true);
    expect(calls).toEqual(["patched:false"]);
  });

  it("lists and executes commands through app.commands", async () => {
    const harness = await ShimHarness.withVault({});
    let ran = 0;
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override onload(): void {
          this.addCommand({
            id: "go",
            name: "Go",
            callback: () => {
              ran += 1;
            },
          });
        }
      },
    );
    await harness.load(plugin);
    expect(harness.app.commands.listCommands().map((command) => command.id)).toContain("demo:go");
    expect(harness.app.commands.executeCommandById("demo:go")).toBe(true);
    expect(harness.app.commands.executeCommandById("demo:missing")).toBe(false);
    expect(ran).toBe(1);
  });

  it("gives an editorCallback command a real editor, and flushes one write", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "one\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    const seen: (string | null)[] = [];
    const plugin = harness.instantiate(
      "editish",
      class extends harness.api.Plugin {
        override onload(): void {
          this.addCommand({
            id: "shout",
            name: "Shout",
            editorCallback: (editor: unknown) => {
              const buffer = editor as Editor;
              seen.push(this.app.workspace.getActiveFile()?.path ?? null);
              buffer.setValue(buffer.getValue().toUpperCase());
            },
          });
        }
      },
    );
    await harness.load(plugin);

    // Synchronously, there is no editor — the same answer Obsidian gives with
    // nothing focused — and the async form with no subject file says so too.
    expect(harness.app.commands.executeCommandById("editish:shout")).toBe(false);
    expect(await harness.app.commands.invokeCommandById("editish:shout")).toBe(false);

    const invoking = harness.app.commands.invokeCommandById("editish:shout", { file });
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "write_note",
      params: {
        path: "A.md",
        content: "ONE\n",
        expected: { revision: harness.revisionOf("A.md") },
      },
    });
    harness.respondOk(sent.id, "write_note", { generation: 3, revision: "blake3:b1" });
    await harness.answerRefetch(3, [{ path: "A.md", revision: "blake3:b1" }]);
    expect(await invoking).toBe(true);
    // The callback saw the file it was acting on, and the host put the active
    // file back afterwards.
    expect(seen).toEqual(["A.md"]);
    expect(harness.app.workspace.getActiveFile()).toBeNull();
  });
});
