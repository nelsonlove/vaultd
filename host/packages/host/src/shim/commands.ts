/**
 * `app.commands` — the one command map, and the only one.
 *
 * **There is exactly one list.** `Plugin.addCommand` (Task 10) namespaces the
 * id, records the harvest row, and hands the command here; `Plugin.removeCommand`
 * and the plugin's own teardown withdraw it through the same seam. The harvest
 * stays the source of truth for the *compatibility report* — what a plugin
 * registered, with its kind and its hotkeys — and this registry is the
 * *executable* map. Two lists would be two answers to "is this command still
 * there" the day a plugin is quarantined.
 *
 * **`commands` is a plain mutable object, deliberately.** Two of the eight
 * golden plugins monkeypatch it: obsidian-linter and automatic-linker both
 * replace `commands["editor:save-file"].checkCallback` at load and call the
 * original from inside their replacement, which is how they run on save. A
 * `Map`, a frozen object or a getter would break both patches silently — the
 * plugin would install its wrapper onto a copy, nothing would throw, and the
 * feature would simply never fire. So the shape is the shape they expect.
 *
 * **`editor:save-file` is seeded for exactly that reason.** It is a real entry
 * whose `checkCallback(checking)` answers `true` and does nothing else: there is
 * no editor-save in a host with no editor buffer to save, but the *entry* has to
 * exist or the two patches above have nothing to wrap, and it has to answer
 * truthily or their save path decides saving is unavailable and stops.
 *
 * **Why `executeCommandById` is synchronous.** Obsidian's is, plugins branch on
 * its boolean, and a version that answered a promise would change what a
 * plugin's own code does. So the command runs inline, inside the dispatch
 * queue's attribution window ({@link DispatchQueue.runInline}) so every policy
 * hit lands against the plugin that owns the command, and a promise the
 * callback returns is adopted rather than dropped — a rejection nobody awaited
 * is reported to the host's error sink instead of becoming an unhandled
 * rejection with no plugin name on it.
 *
 * **The editor path is asynchronous, and is {@link CommandRegistry.invokeCommandById}.**
 * An `editorCallback` needs a note read before it can run, so it cannot be
 * served from a synchronous call — which is also true in Obsidian, where
 * `executeCommandById` on an editor command with no editor focused answers
 * `false`. Task 16a's `host.invoke_command` calls the async form with the
 * subject file; everything about building, running and flushing the editor
 * lives there, in one place, rather than being invented again per caller.
 */

import { Editor } from "./editor";
import { declarePolicy, recordUse } from "./policy";
import type { Command } from "./plugin";
import type { DispatchQueue } from "../runtime/queue";
import type { EditorRange } from "./editor";
import type { HostErrors } from "./errors";
import type { Mirror } from "../mirror/mirror";
import type { TFile } from "./files";
import type { VaultdClient } from "../client/client";
import type { Vault, WriteGate } from "./vault";
import type { Workspace } from "./workspace";

export type { Command } from "./plugin";

/** What the registry needs to run a command, and to build an editor for one. */
export interface CommandDeps {
  readonly queue: DispatchQueue;
  readonly client: VaultdClient;
  readonly mirror: Mirror;
  readonly writes: WriteGate;
  readonly vault: Vault;
  readonly workspace: Workspace;
  readonly errors: HostErrors;
}

/** How a caller names the note an `editorCallback` acts on. */
export interface InvokeOptions {
  /** The subject file. Required by the two editor kinds, ignored by the others. */
  readonly file?: TFile | null;
  /** Where the editor's selection starts. A caret at the top by default. */
  readonly selection?: EditorRange;
}

/** The four command shapes, most specific first — Obsidian's own precedence. */
export type CommandKind = "editorCheckCallback" | "editorCallback" | "checkCallback" | "callback";

/** Obsidian's id for the save command every editor-adjacent plugin patches. */
export const SAVE_COMMAND_ID = "editor:save-file";

export class CommandRegistry {
  /**
   * Every command, by id. **Mutable by design** — see this file's header.
   *
   * A plain object rather than a `Map` because that is what plugins reach into.
   */
  readonly commands: Record<string, Command> = {};

  constructor(private readonly deps: CommandDeps) {
    this.commands[SAVE_COMMAND_ID] = {
      id: SAVE_COMMAND_ID,
      name: "Save current file",
      checkCallback: (): boolean => true,
    };
  }

  /**
   * Add or replace a command. Answers the entry that is now in the map.
   *
   * Replacement rather than refusal for a repeated id, because that is what
   * Obsidian does and because a plugin re-registering a command after a
   * settings change is ordinary.
   */
  addCommand(command: Command): Command {
    this.commands[command.id] = command;
    return command;
  }

  removeCommand(id: string): void {
    // `delete` rather than assigning `undefined`: a plugin iterating the map
    // must not see a key whose value is not a command.
    delete this.commands[id];
  }

  findCommand(id: string): Command | undefined {
    return this.commands[id];
  }

  /** Every command, in registration order. A fresh array the caller may sort. */
  listCommands(): Command[] {
    return Object.values(this.commands);
  }

  /**
   * Run a command by id, the way a plugin does.
   *
   * `false` for an unknown id, for a `checkCallback` that answers falsy — which
   * means "this command is not available right now", and Obsidian does not run
   * it either — and for the two editor kinds, which have no editor in a
   * synchronous call. `true` when the command ran.
   */
  executeCommandById(id: string): boolean {
    recordUse("CommandRegistry.executeCommandById");
    const command = this.commands[id];
    if (command === undefined) return false;
    return this.deps.queue.runInline(pluginIdOf(id), `command:${id}`, () => this.dispatch(command));
  }

  /**
   * Run a command with a subject file, building the editor the two editor kinds
   * need. **Host-only**; Task 16a's `host.invoke_command` is the caller.
   *
   * The whole construction path, stated once: one `get_note` for the source and
   * the revision, `workspace.setActiveFile(file)` so a callback that asks what
   * it is acting on gets an answer, the callback through the dispatch queue,
   * and `editor.flush()` on the way out — which writes only when the buffer
   * really changed. `setActiveFile(null)` runs in a `finally`, so a callback
   * that throws does not leave the host claiming a file is open.
   *
   * A command that needs an editor and was given no file answers `false` rather
   * than throwing: the caller is the one that knows whether a missing
   * `active_file` is a client error worth reporting as `invalid_request`, and
   * this layer has no way to say so.
   */
  async invokeCommandById(id: string, options: InvokeOptions = {}): Promise<boolean> {
    recordUse("CommandRegistry.invokeCommandById");
    const command = this.commands[id];
    if (command === undefined) return false;
    const pluginId = pluginIdOf(id);
    const kind = kindOf(command);
    if (kind !== "editorCallback" && kind !== "editorCheckCallback") {
      return await this.deps.queue.run(pluginId, `command:${id}`, () => this.dispatch(command));
    }
    const file = options.file ?? null;
    if (file === null) return false;
    const editor = await Editor.open({
      client: this.deps.client,
      mirror: this.deps.mirror,
      writes: this.deps.writes,
      file,
      initialSelection: options.selection,
    });
    const view = this.deps.workspace.getLeaf(false).view;
    this.deps.workspace.setActiveFile(file);
    let ran = false;
    try {
      ran = await this.deps.queue.run(pluginId, `command:${id}`, async () => {
        if (kind === "editorCheckCallback") {
          if (command.editorCheckCallback!(true, editor, view) !== true) return false;
          await settle(command.editorCheckCallback!(false, editor, view));
          return true;
        }
        await settle(command.editorCallback!(editor, view));
        return true;
      });
    } finally {
      this.deps.workspace.setActiveFile(null);
    }
    if (ran) await editor.flush();
    return ran;
  }

  /**
   * What a command is, by the most specific callback it declares.
   *
   * Public because the dispatcher has to know whether a command needs a file
   * *before* it invokes it — that is what turns a missing `active_file` into an
   * `invalid_request` rather than a silent `false`.
   */
  kindOf(id: string): CommandKind | null {
    const command = this.commands[id];
    return command === undefined ? null : kindOf(command);
  }

  /** Run one command's callback, already inside an attribution window. */
  private dispatch(command: Command): boolean {
    const pluginId = pluginIdOf(command.id);
    switch (kindOf(command)) {
      case "checkCallback": {
        // `true` asks "can this run"; only then is it run with `false`. A
        // plugin that answers falsy to the question has said the command does
        // not apply right now, and Obsidian does not run it either.
        if (command.checkCallback!(true) !== true) return false;
        this.settleSync(command.checkCallback!(false), pluginId);
        return true;
      }
      case "callback": {
        if (command.callback === undefined) return false;
        this.settleSync(command.callback(), pluginId);
        return true;
      }
      default:
        // The two editor kinds. There is no editor in a synchronous call, which
        // is the same answer Obsidian gives with no editor focused.
        return false;
    }
  }

  /**
   * Adopt whatever a callback returned.
   *
   * A command callback may be `async`, and a caller that wanted its boolean
   * back has no promise to await. Dropping the rejection would surface it as an
   * unhandled rejection with nothing naming the plugin; reporting it puts the
   * plugin's id on it and lets the quarantine see it.
   */
  private settleSync(result: unknown, pluginId: string | null): void {
    if (!isThenable(result)) return;
    void result.then(undefined, (error: unknown) => {
      this.deps.errors.report(error, pluginId ?? HOST_COMMAND_OWNER, "command");
    });
  }
}

/** Await what a callback returned, when the caller can wait for it. */
async function settle(result: unknown): Promise<void> {
  if (isThenable(result)) await result;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** The most specific callback a command declares is the kind it is. */
function kindOf(command: Command): CommandKind {
  if (command.editorCheckCallback !== undefined) return "editorCheckCallback";
  if (command.editorCallback !== undefined) return "editorCallback";
  if (command.checkCallback !== undefined) return "checkCallback";
  return "callback";
}

/** What a failure in one of the host's own commands is reported against. */
const HOST_COMMAND_OWNER = "host";

/** The ids this host seeds itself, which belong to no plugin. */
const HOST_COMMAND_IDS = new Set<string>([SAVE_COMMAND_ID]);

/**
 * The plugin a command id belongs to, or `null` for one of the host's own.
 *
 * `Plugin.addCommand` namespaces every plugin command as `<pluginId>:<localId>`,
 * so the prefix is the owner. The host's own seeded ids are the exception:
 * `editor` in `editor:save-file` is Obsidian's namespace, not a plugin id, and
 * attributing that command's hits to a plugin called "editor" would invent a
 * plugin in the compatibility report. They attribute to nobody instead — which
 * is the truth, even when the callback running is a plugin's monkeypatch.
 */
function pluginIdOf(id: string): string | null {
  if (HOST_COMMAND_IDS.has(id)) return null;
  const cut = id.indexOf(":");
  return cut === -1 ? null : id.slice(0, cut);
}

declarePolicy("CommandRegistry.executeCommandById", "implemented");
declarePolicy("CommandRegistry.invokeCommandById", "implemented");
declarePolicy("CommandRegistry.addCommand", "implemented");
declarePolicy("CommandRegistry.removeCommand", "implemented");
declarePolicy("CommandRegistry.findCommand", "implemented");
declarePolicy("CommandRegistry.listCommands", "implemented");
