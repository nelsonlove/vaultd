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
import { currentPluginId } from "../src/shim/policy";
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

  it("runs a command inside its own plugin's attribution window", async () => {
    const harness = await ShimHarness.withVault({});
    const seen: (string | null)[] = [];
    const plugin = harness.instantiate(
      "attributed",
      class extends harness.api.Plugin {
        override onload(): void {
          this.addCommand({
            id: "look",
            name: "Look",
            callback: () => {
              seen.push(currentPluginId());
            },
          });
        }
      },
    );
    await harness.load(plugin);
    // Outside a command there is nobody running; inside one it is the plugin
    // that owns the command. Attribution is the whole reason the synchronous
    // entry point goes through the queue at all — every policy hit a command
    // makes, several layers down, is recorded against this id.
    expect(currentPluginId()).toBeNull();
    expect(harness.app.commands.executeCommandById("attributed:look")).toBe(true);
    expect(seen).toEqual(["attributed"]);
    expect(currentPluginId()).toBeNull();
  });

  it("refuses a command whose checkCallback says it does not apply", async () => {
    const harness = await ShimHarness.withVault({});
    const calls: boolean[] = [];
    let available = false;
    const plugin = harness.instantiate(
      "gated",
      class extends harness.api.Plugin {
        override onload(): void {
          this.addCommand({
            id: "maybe",
            name: "Maybe",
            checkCallback: (checking: boolean) => {
              calls.push(checking);
              if (checking) return available;
              return true;
            },
          });
        }
      },
    );
    await harness.load(plugin);

    // A falsy check means "not right now": the command is asked and not run,
    // which is what Obsidian does with a greyed-out palette entry.
    expect(harness.app.commands.executeCommandById("gated:maybe")).toBe(false);
    expect(calls).toEqual([true]);

    available = true;
    expect(harness.app.commands.executeCommandById("gated:maybe")).toBe(true);
    expect(calls).toEqual([true, true, false]);
  });

  it("withdraws a plugin's commands on removeCommand and on unload", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "leaver",
      class extends harness.api.Plugin {
        override onload(): void {
          this.addCommand({ id: "stay", name: "Stay", callback: () => undefined });
          this.addCommand({ id: "go", name: "Go", callback: () => undefined });
          this.removeCommand("go");
        }
      },
    );
    await harness.load(plugin);
    // `removeCommand` takes the local id and the registry holds the qualified
    // one, so a registry that never deleted would still look right to the
    // plugin and wrong to everything that addresses commands by id.
    expect(harness.app.commands.findCommand("leaver:go")).toBeUndefined();
    expect(harness.app.commands.findCommand("leaver:stay")).toBeDefined();

    await harness.unload("leaver");
    // A plugin the host has torn down must not still be invokable.
    expect(harness.app.commands.findCommand("leaver:stay")).toBeUndefined();
    expect(harness.app.commands.executeCommandById("leaver:stay")).toBe(false);
    expect(harness.app.plugins.getPlugin("leaver")).toBeNull();
  });

  it("gives an editorCallback command a real editor, and flushes one write", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "one\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    const seen: (string | null)[] = [];
    const duringBatch: (string | null)[] = [];
    harness.mirror.onBatch(() => {
      duringBatch.push(currentPluginId());
    });
    const plugin = harness.instantiate(
      "editish",
      class extends harness.api.Plugin {
        override onload(): void {
          this.addCommand({
            id: "shout",
            name: "Shout",
            editorCallback: (editor: unknown, context: unknown) => {
              const buffer = editor as Editor;
              const info = context as { file?: { path: string } | null; editor?: unknown };
              // The context Obsidian hands an editor command is a
              // `MarkdownFileInfo`: the file it is acting on and the editor
              // over it. Six of obsidian-linter's seven commands guard on
              // exactly this, so a context without it is a command that never
              // runs.
              seen.push(info.file?.path ?? null);
              expect(info.editor).toBe(buffer);
              expect(this.app.workspace.getActiveFile()?.path).toBe("A.md");
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
    // **The flush is the plugin's write.** It runs inside the queued command
    // slot, so the `write_note`, the `applyMutation` behind it, and every
    // listener that mutation fans out to are attributed to the plugin that
    // caused them — like every other write in this host, and unlike a flush
    // that ran after the slot had closed.
    expect(duringBatch).toEqual(["editish"]);
  });

  it("holds the note's lock across the flush, against a process that is not behind it", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "one\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    const editish = harness.instantiate(
      "editish",
      class extends harness.api.Plugin {
        override onload(): void {
          this.addCommand({
            id: "shout",
            name: "Shout",
            editorCallback: (editor: unknown) => {
              const buffer = editor as Editor;
              buffer.setValue(buffer.getValue().toUpperCase());
            },
          });
        }
      },
    );
    await harness.load(editish);
    // The second plugin kicks off a `Vault.process` and does **not** await it,
    // from a synchronous command — which is a real shape (an interval, an event
    // handler, a command that starts work) and, crucially, one that is *not*
    // queued behind the editor command on the dispatch FIFO. The FIFO therefore
    // cannot be what serializes these two; only `runExclusivePath` can.
    let processed: Promise<string> | null = null;
    const other = harness.instantiate(
      "other",
      class extends harness.api.Plugin {
        override onload(): void {
          this.addCommand({
            id: "kick",
            name: "Kick",
            callback: () => {
              processed = this.app.vault.process(file, (text) => `${text}appended\n`);
            },
          });
        }
      },
    );
    await harness.load(other);
    harness.clearMethodLog();

    // The editor command is mid-flush: it holds the lock and is waiting on the
    // daemon's answer to its `write_note`.
    const invoking = harness.app.commands.invokeCommandById("editish:shout", { file });
    const editorWrite = await harness.expectRequest("write_note");
    expect(harness.methodsSeen()).toEqual(["get_note", "write_note"]);

    // Now the other plugin starts its read-modify-write on the same note.
    expect(harness.app.commands.executeCommandById("other:kick")).toBe(true);
    await harness.quiesce();
    // **The kill.** With the lock, `process` has not read anything yet: its
    // task function is not called until the editor's whole open-mutate-flush
    // has settled. Without it, the `read_file` is already out — against bytes
    // the editor is in the middle of replacing, which is the lost update the
    // lock exists to prevent.
    expect(harness.methodsSeen()).toEqual(["get_note", "write_note"]);

    // Let the editor's write land, and the process follows it.
    harness.respondOk(editorWrite.id, "write_note", { generation: 3, revision: "blake3:upper" });
    harness.setFileContent("A.md", "ONE\n");
    await harness.answerRefetch(3, [{ path: "A.md", revision: "blake3:upper" }]);
    expect(await invoking).toBe(true);

    const processWrite = await harness.expectRequest("write_note");
    // It read what the editor wrote, and states that revision as its own
    // precondition — the whole point of serializing rather than racing.
    expect(processWrite.request.params).toEqual({
      path: "A.md",
      content: "ONE\nappended\n",
      expected: { revision: "blake3:upper" },
    });
    harness.respondOk(processWrite.id, "write_note", { generation: 4, revision: "blake3:both" });
    harness.setFileContent("A.md", "ONE\nappended\n");
    await harness.answerRefetch(4, [{ path: "A.md", revision: "blake3:both" }]);
    expect(await processed!).toBe("ONE\nappended\n");
    // The whole exchange, in order. The two `read_file`s after each refetch are
    // the mirror re-warming the note's position index; the one before the
    // second `write_note` is `process`'s own read, and it sits **after** the
    // editor's write rather than beside it.
    expect(harness.methodsSeen()).toEqual([
      "get_note",
      "write_note",
      "get_tree_entries",
      "get_note",
      "read_file",
      "read_file",
      "write_note",
      "get_tree_entries",
      "get_note",
      "read_file",
    ]);
  });
});
