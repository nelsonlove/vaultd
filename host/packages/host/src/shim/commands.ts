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
import { HOST_PLUGIN_ID } from "./errors";
import { declarePolicy, recordUse } from "./policy";
import type { App } from "./app";
import type { Command } from "./plugin";
import type { DispatchQueue } from "../runtime/queue";
import type { EditorRange } from "./editor";
import type { HostErrors } from "./errors";
import type { Mirror } from "../mirror/mirror";
import type { TFile } from "./files";
import type { RequestSink } from "../client/request-sink";
import type { WriteGate } from "./vault";
import type { Workspace } from "./workspace";

export type { Command } from "./plugin";

/** What the registry needs to run a command, and to build an editor for one. */
export interface CommandDeps {
  readonly queue: DispatchQueue;
  readonly client: RequestSink;
  readonly mirror: Mirror;
  readonly writes: WriteGate;
  readonly workspace: Workspace;
  readonly errors: HostErrors;
  /** Carried only so the editor context can hand a plugin its own `app`. */
  readonly app: App;
}

/**
 * Obsidian's `MarkdownFileInfo`, as much of it as a headless host has.
 *
 * The published interface is `{ app, file, editor?, hoverPopover, … }`. The
 * three fields here are the three this host can answer truthfully; nothing else
 * is invented. See {@link CommandRegistry.fileInfoFor}.
 */
export interface MarkdownFileInfo {
  readonly app: App;
  readonly file: TFile | null;
  readonly editor: Editor;
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
   * The whole construction path, stated once:
   *
   * 1. one `get_note` for the source and the revision;
   * 2. the second argument — see {@link MarkdownFileInfo}, and it is the whole
   *    difference between a command that runs and one that silently refuses;
   * 3. `workspace.setActiveFile(file)`, so a callback that asks the workspace
   *    what it is acting on gets the same answer as its `ctx.file`;
   * 4. the callback, and then `editor.flush()`, **inside one queued plugin
   *    slot and inside that path's exclusive lock** — the shape
   *    `FileManager.processFrontMatter` and `Vault.process` already use;
   * 5. `setActiveFile(null)` in a `finally`, so a callback that throws does not
   *    leave the host claiming a file is open.
   *
   * **Why the lock and the slot, corrected in fix round 1.** Open-mutate-flush
   * is a read-modify-write against a revision precondition, exactly like the
   * other two, and it was the only one in this host taking no per-path lock: two
   * commands editing one note interleaved into a `revision_conflict` rather
   * than queueing. The flush also ran *after* `queue.run` had returned, so the
   * `write_note`, its `applyMutation` and every `modify` handler that mutation
   * fans out to ran with `currentPluginId()` null — a write attributed to
   * nobody, where every other shim write in this host is attributed to the
   * plugin that caused it.
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
    return await this.deps.queue.run(pluginId, `command:${id}`, () =>
      // Independent of the FIFO this is already running under — see
      // `DispatchQueue.runExclusivePath`, which exists precisely so a
      // read-modify-write can serialize by path from inside a plugin slot
      // without waiting on the queue it is running under.
      this.deps.queue.runExclusivePath(file.path, async () => {
        const editor = await Editor.open({
          client: this.deps.client,
          mirror: this.deps.mirror,
          writes: this.deps.writes,
          file,
          initialSelection: options.selection,
        });
        const context = this.fileInfoFor(file, editor);
        this.deps.workspace.setActiveFile(file);
        let ran = false;
        try {
          if (kind === "editorCheckCallback") {
            if (command.editorCheckCallback!(true, editor, context) === true) {
              await settle(command.editorCheckCallback!(false, editor, context));
              ran = true;
            }
          } else {
            await settle(command.editorCallback!(editor, context));
            ran = true;
          }
        } finally {
          this.deps.workspace.setActiveFile(null);
        }
        // Inside the slot and inside the lock, so the write and everything it
        // fans out to are the plugin's.
        if (ran) await editor.flush();
        return ran;
      }),
    );
  }

  /**
   * The second argument every editor command is handed.
   *
   * Obsidian's signature is `editorCallback(editor: Editor, ctx: MarkdownView |
   * MarkdownFileInfo)`, and `MarkdownFileInfo` — the published interface — is
   * `{ app, file, editor?, hoverPopover?, … }`. **This is not decoration: it is
   * the difference between a command running and silently not running.** Six of
   * obsidian-linter's seven commands are `editorCheckCallback`s whose checking
   * arm reads `ctx.file` (`view && view.file instanceof TFile && view.file.parent
   * ? !view.file.parent.isRoot() : false`), so a context with no `file` answers
   * `false` for every one of them — no throw, no error, the command simply does
   * not happen. The inert leaf's `View`, which is what this used to hand over,
   * has no `file`.
   *
   * `MarkdownFileInfo` rather than a `MarkdownView` instance, and the choice is
   * a least-harm one: a `MarkdownView` would answer `true` to `ctx instanceof
   * MarkdownView` and promise a rendering surface, a `previewMode`, a `getMode()`
   * this host cannot serve. The documented smaller interface carries exactly
   * what a headless host really has — the app, the file, and the editor over it
   * — and a plugin that needs the bigger one still takes its own "no markdown
   * view" branch. Anything beyond those three fields is uncaptured and is not
   * invented here.
   */
  private fileInfoFor(file: TFile, editor: Editor): MarkdownFileInfo {
    return { app: this.deps.app, file, editor };
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

/**
 * What a failure in one of the host's own commands is reported against.
 *
 * The host's one id, imported rather than spelled again — see
 * {@link HOST_PLUGIN_ID}. The alias is kept because this file's call sites read
 * as a statement about command ownership rather than about the quarantine.
 */
const HOST_COMMAND_OWNER = HOST_PLUGIN_ID;

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
