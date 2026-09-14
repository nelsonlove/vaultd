/**
 * `app.workspace`, for a host with no windows in it.
 *
 * **Seeded by Task 10, completed by Task 11a.** Task 10 needed one piece of
 * this before it needed the rest: a plugin registers its context-menu hook with
 * `app.workspace.on("file-menu", ...)`, and a harvest that could not see that
 * registration would have nothing to build a menu from. Task 11a added the rest
 * — the layout-ready latch, the active file, the inert leaf — to the same
 * class, and the menu-hook recording below did not move.
 *
 * The recording sits in `on` rather than in the harvest, because the two menu
 * events are the only ones where *registering* is the whole of the plugin's
 * contribution. Every other workspace event is delivered when it happens; these
 * two are questions the host asks whenever someone wants a menu, so the handler
 * has to be kept rather than merely attached.
 *
 * **Everything about leaves is empty, and that is load-bearing.** There are no
 * leaves headless, so `getLeavesOfType` answers `[]` and `iterateAllLeaves`
 * calls its callback zero times. Both shapes come straight out of the corpus:
 * folder-notes' `getFileExplorer()` early-returns on an empty list and disables
 * its CSS features cleanly, where an `undefined` would throw inside `onload`;
 * and its `TabManager.updateTabs()` is a no-op rather than a crash for exactly
 * the same reason. "An empty collection, never `undefined`" is the rule the
 * research found plugins break on, and it applies to every plural here.
 */

import { Events } from "./events";
import { StubEl } from "./dom";
import { declarePolicy, recordUse, stub } from "./policy";
import type { EventCallback, EventRef, ShimEventBus } from "./events";
import type { TFile } from "./files";
import type { Harvest, MenuContext, MenuHookCallback, MenuHookRegistration } from "./harvest";

export interface WorkspaceDeps {
  readonly events: ShimEventBus;
  readonly harvest: Harvest;
}

const MENU_EVENTS = new Set<string>(["file-menu", "editor-menu"]);

/**
 * The event a queued `onLayoutReady` callback is really registered for.
 *
 * Scoped by {@link Events.scoped} like every other workspace event, so a plugin
 * that writes `app.workspace.on("layout-ready", ...)` and one that writes
 * `app.workspace.onLayoutReady(...)` end up in the same fan-out, in
 * registration order.
 */
const LAYOUT_READY = "layout-ready";

/** One harvested hook, and the callback `off(name, callback)` will name it by. */
interface HookEntry {
  readonly callback: EventCallback;
  readonly registration: MenuHookRegistration;
}

export class Workspace extends Events {
  /**
   * The harvested hooks, by event name.
   *
   * Kept here because a plugin has three ways to withdraw a listener — the ref
   * it was given, `offref(ref)`, and `off(name, callback)` — and only the first
   * two carry anything that knows about the harvest. Without this map the third
   * one would leave the host holding a menu hook the plugin had withdrawn: the
   * harvest would report it, and a menu build would invoke it.
   */
  private readonly hooks = new Map<string, HookEntry[]>();

  /** The startup latch. Flipped once, by {@link markLayoutReady}. */
  private layoutReadyValue = false;

  /** The command dispatcher's subject file — see {@link setActiveFile}. */
  private activeFile: TFile | null = null;

  /**
   * The one leaf `getLeaf(false)` hands back every time.
   *
   * Built here rather than on demand so a plugin that calls `getLeaf(false)`
   * twice is holding the same object both times, as it would be in a window.
   */
  private readonly activeLeaf: WorkspaceLeaf = new WorkspaceLeaf(this);

  /** Every path something asked to have opened — see {@link openFileIntents}. */
  private readonly openIntents: string[] = [];

  constructor(private readonly deps: WorkspaceDeps) {
    super(deps.events);
    // A hook registered without `registerEvent` has no ref teardown to run, so
    // an owner-wide detach — what a quarantine does — is the only thing that
    // can withdraw it. Without this the map would keep one dead entry per
    // quarantined plugin for the life of the host.
    deps.events.onOwnerDetached((pluginId) => {
      this.forgetPlugin(pluginId);
    });
  }

  // -------------------------------------------------------------------------
  // The layout-ready latch
  // -------------------------------------------------------------------------

  /**
   * Whether the host has finished starting.
   *
   * A getter rather than a plain property, because the latch is the host's to
   * flip: a plugin that assigned `workspace.layoutReady = true` would make
   * every later `onLayoutReady` run before the host was ready, and no plugin
   * can do that in Obsidian either.
   */
  get layoutReady(): boolean {
    return this.layoutReadyValue;
  }

  /**
   * Run `callback` when the layout is ready — or right now, if it already is.
   *
   * The immediate arm is Obsidian's own documented behaviour and it is the one
   * that matters here: a plugin enabled *after* startup (which is every plugin
   * a headless host loads on demand) would otherwise register a callback for an
   * event that has already fired and never run its startup work at all.
   *
   * **Queued through the event bus rather than into an array of its own**, a
   * deliberate departure from the brief's `layoutReadyCallbacks` sketch and
   * worth its three lines of justification: the bus already catches a throwing
   * callback per listener so one plugin's failure does not cost every later
   * plugin its startup, it already attributes the registration to the plugin
   * that made it so a failure can be named, and it already drops a plugin's
   * registrations when that plugin is unloaded — so a plugin unloaded before
   * the host finished starting is not called afterwards. A bare array would
   * have had to grow all three.
   */
  onLayoutReady(callback: () => unknown): void {
    recordUse("Workspace.onLayoutReady");
    if (this.layoutReadyValue) {
      callback();
      return;
    }
    this.on(LAYOUT_READY, callback);
  }

  /**
   * **HOST-ONLY.** Not in `obsidian.d.ts`, and not reachable from a plugin: the
   * host calls it once, when its startup is complete.
   *
   * The latch is flipped **before** the fan-out, so a callback that registers
   * another one from inside the event sees a ready workspace and runs it
   * immediately — rather than queueing it for a fan-out that has already
   * started and will never happen again.
   *
   * Calling it a second time does nothing. Startup happens once, and a second
   * fan-out would run every plugin's startup work twice.
   */
  markLayoutReady(): void {
    if (this.layoutReadyValue) return;
    this.layoutReadyValue = true;
    this.trigger(LAYOUT_READY);
  }

  // -------------------------------------------------------------------------
  // The active file, and the views there are none of
  // -------------------------------------------------------------------------

  /**
   * The file the host is acting on, or `null`.
   *
   * Null is the ordinary answer: nothing is open in a host with no editor. It
   * is non-null only inside a command dispatch the host gave a subject file —
   * an `editorCallback` needs one to have anything to act on.
   */
  getActiveFile(): TFile | null {
    recordUse("Workspace.getActiveFile");
    return this.activeFile;
  }

  /**
   * **HOST-ONLY.** Not in `obsidian.d.ts`. The command dispatcher sets the
   * subject file around an invocation so an `editorCallback` has one, and
   * clears it afterwards. Never reachable from a plugin.
   */
  setActiveFile(file: TFile | null): void {
    this.activeFile = file;
  }

  /**
   * Always `null`: there are no views, so none of them is of any type.
   *
   * Plugins branch on this — `const view = getActiveViewOfType(MarkdownView);
   * if (!view) return;` is the shape — so `null` disables the feature the same
   * way an unfocused editor does in a real window.
   */
  getActiveViewOfType<T>(ctor: unknown): T | null {
    void ctor;
    return stub("Workspace.getActiveViewOfType", null);
  }

  /**
   * **HOST-ONLY**, in the same sense as {@link setActiveFile}:
   * `getActiveFileView` is **not** in `obsidian.d.ts`. It stays because
   * folder-notes reaches for a view of the active file through an undocumented
   * path, and `null` is the honest answer; marking it host-only is what keeps a
   * later reader from mistaking it for a documented surface the shim owes
   * parity on.
   */
  getActiveFileView(): null {
    return stub("Workspace.getActiveFileView", null);
  }

  // -------------------------------------------------------------------------
  // Leaves: none of them, and one inert stand-in
  // -------------------------------------------------------------------------

  /**
   * A leaf that opens nothing.
   *
   * `newLeaf` truthy hands back a fresh one and falsy the same stand-in every
   * time, which is the distinction a plugin is making when it passes the flag —
   * "put this somewhere new" against "put this where the user is looking". Both
   * are equally inert; the difference costs one object and keeps a plugin that
   * holds on to `getLeaf(false)` looking at the leaf it had.
   */
  getLeaf(newLeaf?: boolean | string): WorkspaceLeaf {
    const leaf = newLeaf === undefined || newLeaf === false ? this.activeLeaf : new WorkspaceLeaf(this);
    return stub("Workspace.getLeaf", leaf);
  }

  /** Always `[]`, and always a fresh array a caller may sort or splice. */
  getLeavesOfType(type: string): WorkspaceLeaf[] {
    void type;
    return stub("Workspace.getLeavesOfType", []);
  }

  /** There are no leaves, so the callback is not called. */
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void {
    void callback;
    stub("Workspace.iterateAllLeaves", undefined);
  }

  /** Always `[]`: this host keeps no recently-opened list. */
  getLastOpenFiles(): string[] {
    return stub("Workspace.getLastOpenFiles", []);
  }

  /** Accepted and discarded — there is no hover preview to source. */
  registerHoverLinkSource(id: string, info: unknown): void {
    void id;
    void info;
    stub("Workspace.registerHoverLinkSource", undefined);
  }

  /**
   * Records the intent and opens nothing.
   *
   * Recorded rather than ignored because "this plugin wanted to show you a
   * file" is the whole of what a GUI-less host can report about the call, and a
   * caller outside the process may well want to act on it.
   */
  async openLinkText(linktext: string, sourcePath: string, newLeaf?: boolean | string): Promise<void> {
    void sourcePath;
    void newLeaf;
    this.recordOpenIntent(linktext);
    stub("Workspace.openLinkText", undefined);
    return Promise.resolve();
  }

  /**
   * **HOST-ONLY.** Every path a plugin asked to have opened, in order.
   *
   * The one observable consequence of an `openFile` on a host with nothing to
   * open it in — so it is what a test asserts on, and what Task 16a reports.
   */
  openFileIntents(): readonly string[] {
    return [...this.openIntents];
  }

  /** **HOST-ONLY.** Called by the inert leaf; see {@link openFileIntents}. */
  recordOpenIntent(path: string): void {
    this.openIntents.push(path);
  }

  /** Drop every hook one plugin registered, listener refs or not. */
  forgetPlugin(pluginId: string): void {
    for (const [name, entries] of [...this.hooks]) {
      for (const entry of [...entries]) {
        if (entry.registration.hook.pluginId === pluginId) this.withdraw(name, entry);
      }
    }
  }

  /**
   * How many hook entries this workspace is holding.
   *
   * Public so a case can assert the map is empty after a plugin is forgotten:
   * a leak of one entry per plugin lifetime is invisible to every other
   * assertion, which is exactly why it needs one of its own.
   */
  hookEntryCount(): number {
    let total = 0;
    for (const entries of this.hooks.values()) total += entries.length;
    return total;
  }

  /**
   * Attach the listener, and — for the two menu events — record the hook.
   *
   * Both, not either: the bus registration is what keeps `off`, `offref` and
   * the listener count honest, and the harvest record is what lets a menu be
   * built on demand. The returned ref drops both, so a plugin that detaches its
   * own hook really loses it.
   *
   * A registration made outside a plugin's load has no owner to attribute it
   * to, and is attached without being harvested: an unowned hook could not be
   * quarantined, reported, or addressed by id.
   */
  override on(name: string, callback: EventCallback, context?: unknown): EventRef {
    const ref = super.on(name, callback, context);
    if (!MENU_EVENTS.has(name)) return ref;
    const pluginId = this.deps.events.attribution();
    if (pluginId === null) return ref;
    const registration = this.deps.harvest.recordMenuHook(
      pluginId,
      name as MenuContext,
      // The bus types every listener as Obsidian does — untyped — and a menu
      // hook's real signature is `(menu, file, source)`. The cast is the one
      // place the shim states that.
      callback as unknown as MenuHookCallback,
    );
    const entry: HookEntry = { callback, registration };
    this.entriesFor(name).push(entry);
    return {
      detach: (): void => {
        ref.detach();
        this.withdraw(name, entry);
      },
    };
  }

  /**
   * Detach every listener of `callback` for `name`, and withdraw the hooks with
   * them.
   *
   * By callback, and therefore possibly several at once — which is what the bus
   * does, and what a plugin that registered the same function twice is asking
   * for.
   */
  override off(name: string, callback: EventCallback): void {
    super.off(name, callback);
    const entries = this.hooks.get(name);
    if (entries === undefined) return;
    for (const entry of [...entries]) {
      if (entry.callback === callback) this.withdraw(name, entry);
    }
  }

  protected override prefix(): string {
    return "workspace";
  }

  private entriesFor(name: string): HookEntry[] {
    const existing = this.hooks.get(name);
    if (existing !== undefined) return existing;
    const created: HookEntry[] = [];
    this.hooks.set(name, created);
    return created;
  }

  /** Drop one hook from the harvest and from this map. Safe to call twice. */
  private withdraw(name: string, entry: HookEntry): void {
    entry.registration.detach();
    const entries = this.hooks.get(name);
    if (entries === undefined) return;
    const at = entries.indexOf(entry);
    if (at !== -1) entries.splice(at, 1);
    if (entries.length === 0) this.hooks.delete(name);
  }
}

// ---------------------------------------------------------------------------
// The inert leaf, and the views nothing renders
// ---------------------------------------------------------------------------

/**
 * A workspace leaf that holds nothing and shows nothing.
 *
 * It exists because plugins ask for one — `getLeaf(false).openFile(file)` is
 * how half the corpus reveals a file it just created — and because the honest
 * answer to that call is not a throw. What it does instead is write the path
 * down: "this plugin wanted this file shown" is real information, it is the
 * only part of the call a host with no window can act on, and something outside
 * the process may want it.
 */
export class WorkspaceLeaf {
  /**
   * An empty view, rather than `null`.
   *
   * `leaf.view` is read before it is type-tested — `leaf.view instanceof
   * MarkdownView`, `leaf.view.getViewType()` — so `null` would turn an ordinary
   * guard into a `TypeError`. An inert {@link View} answers both shapes: the
   * `instanceof` is `false`, which is what "no editor here" means, and the
   * getters answer.
   */
  view: unknown = new View();

  constructor(private readonly workspace: Workspace) {}

  /** Records the intent, opens nothing, and resolves. */
  openFile(file: TFile, state?: unknown): Promise<void> {
    void state;
    this.workspace.recordOpenIntent(file.path);
    stub("WorkspaceLeaf.openFile", undefined);
    return Promise.resolve();
  }

  setViewState(state: unknown): Promise<void> {
    void state;
    stub("WorkspaceLeaf.setViewState", undefined);
    return Promise.resolve();
  }

  /** Nothing is attached, so nothing is detached. */
  detach(): void {
    stub("WorkspaceLeaf.detach", undefined);
  }

  getViewState(): unknown {
    return stub("WorkspaceLeaf.getViewState", { type: "empty", state: {} });
  }

  getDisplayText(): string {
    return stub("WorkspaceLeaf.getDisplayText", "");
  }

  setEphemeralState(state: unknown): void {
    void state;
    stub("WorkspaceLeaf.setEphemeralState", undefined);
  }

  getEphemeralState(): unknown {
    return stub("WorkspaceLeaf.getEphemeralState", {});
  }
}

/**
 * `View` and the three names below it, as `instanceof` targets and nothing
 * more.
 *
 * Plugins use these classes to ask what kind of thing they are looking at, and
 * a host with no views still has to answer that question — `leaf.view
 * instanceof EditableFileView` must be a `false`, not a `TypeError` about an
 * undefined right-hand side. The chain is Obsidian's own, so a branch that
 * tests the general class and a branch that tests the specific one both answer
 * the way they would in a window with nothing open.
 *
 * **What is deliberately not here** is any of the behaviour: no editor, no
 * rendering, no `onOpen` that opens anything. A later task that gives this host
 * an editor context owns that; a class with a plausible-looking `editor` field
 * that did nothing would be worse than no field at all.
 */
export class View {
  readonly containerEl: StubEl = new StubEl("div");
  readonly contentEl: StubEl = new StubEl("div");

  getViewType(): string {
    return "empty";
  }

  getDisplayText(): string {
    return "";
  }

  onOpen(): Promise<void> {
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    return Promise.resolve();
  }
}

export class ItemView extends View {}

export class FileView extends ItemView {
  file: TFile | null = null;

  override getViewType(): string {
    return "file";
  }
}

export class EditableFileView extends FileView {}

export class MarkdownView extends EditableFileView {
  override getViewType(): string {
    return "markdown";
  }
}

// The table rows this file owns. Module-level, so importing the module is all
// it takes for the compatibility report to know about them — with nothing
// constructed and no vault open.
declarePolicy("Workspace.onLayoutReady", "implemented");
declarePolicy("Workspace.getActiveFile", "implemented");
declarePolicy("Workspace.getActiveViewOfType", "safe_stub");
declarePolicy("Workspace.getActiveFileView", "safe_stub");
declarePolicy("Workspace.getLeaf", "safe_stub");
declarePolicy("Workspace.getLeavesOfType", "safe_stub");
declarePolicy("Workspace.iterateAllLeaves", "safe_stub");
declarePolicy("Workspace.getLastOpenFiles", "safe_stub");
declarePolicy("Workspace.registerHoverLinkSource", "safe_stub");
declarePolicy("Workspace.openLinkText", "harvested");
declarePolicy("WorkspaceLeaf.openFile", "harvested");
declarePolicy("WorkspaceLeaf.setViewState", "safe_stub");
declarePolicy("WorkspaceLeaf.detach", "safe_stub");
declarePolicy("WorkspaceLeaf.getViewState", "safe_stub");
declarePolicy("WorkspaceLeaf.getDisplayText", "safe_stub");
declarePolicy("WorkspaceLeaf.setEphemeralState", "safe_stub");
declarePolicy("WorkspaceLeaf.getEphemeralState", "safe_stub");
