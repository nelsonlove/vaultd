/**
 * `Component` and `Plugin`: what a plugin's own `onload` talks to.
 *
 * Every other shim surface answers a question a plugin asks about the vault.
 * This one is the plugin's own scaffolding — the object it extends, the
 * lifecycle it is driven through, and the dozen `register*` calls it makes
 * before it does anything useful. Three rules shape the whole file:
 *
 * 1. **Nothing here may throw.** These calls run inside `onload`, so a throw
 *    kills the plugin before its useful half has loaded — a plugin that also
 *    registers commands would lose them because it happened to register a view
 *    first. `registerView`, `registerEditorExtension`, `registerEditorSuggest`
 *    and the two markdown processors therefore accept and discard. This is the
 *    single most important "never throw" rule in the shim.
 * 2. **Discarding is recorded.** A surface that vanished silently would leave
 *    the compatibility report unable to say why a plugin does nothing here, so
 *    every discard is either a `safe_stub` hit or an {@link HarvestedUnreachable}
 *    row naming what was registered and what cannot reach it.
 * 3. **Registrations that a headless host *can* honour are honoured.** Commands,
 *    menu hooks, protocol handlers and intervals are really recorded, really
 *    invokable, and really torn down on unload.
 *
 * **`addCommand` delegates to `app.commands`** rather than keeping a second
 * command list of its own: it namespaces the id, records the harvest row here,
 * and hands the command to the registry Task 12 builds — the same map
 * obsidian-linter and automatic-linker monkeypatch. Until that task lands,
 * `app.commands` is absent and the harvest is the only list; the delegation is
 * written now so the two can never drift into two answers.
 *
 * **Host wiring is ambient.** Obsidian's constructor is `(app, manifest)` and a
 * plugin bundle calls `super(app, manifest)` with exactly those two, so there
 * is no argument left for the harvest, the client or the clock. The assembler
 * installs them against the `App` instead ({@link installPluginHost}), and a
 * `Plugin` finds them through the app it was handed — which also means two
 * hosts in one process never see each other's.
 */

import { declarePolicy, recordUse, stub } from "./policy";
import { clearTimerById, intervalMsOf } from "./timers";
import { pluginDataPath } from "../pluginset/config-dir";
import { VaultdError } from "../client/errors";
import type { App } from "./app";
import type { EventRef, ShimEventBus } from "./events";
import type { Harvest } from "./harvest";
import type { HostErrorPhase, HostErrors } from "./errors";
import type { ReadFileResponse, WriteFileResponse } from "../client/protocol";
import type { VaultdClient } from "../client/client";
import type { Clock, HostConfig } from "../config";
import type { DispatchQueue } from "../runtime/queue";
import type { WriteGate } from "./vault";

/**
 * A plugin's `manifest.json`, as Obsidian hands it to the constructor.
 *
 * `dir` is the plugin's folder inside the **host's** config directory. Obsidian
 * fills it too, and plugins read it to find their own bundled assets.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
  dir?: string;
}

export interface Hotkey {
  modifiers: string[];
  key: string;
}

/**
 * One command, exactly as a plugin declares it.
 *
 * The four callback shapes are mutually exclusive in practice and Obsidian
 * treats the most specific one it finds as the command's kind; so does
 * {@link commandKindOf}.
 */
export interface Command {
  id: string;
  name: string;
  icon?: string;
  mobileOnly?: boolean;
  repeatable?: boolean;
  hotkeys?: Hotkey[];
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: unknown, ctx: unknown) => unknown;
  editorCheckCallback?: (checking: boolean, editor: unknown, ctx: unknown) => boolean | void;
}

/**
 * A plugin's settings tab, as much of it as this host needs to hold.
 *
 * An interface rather than a class **for now**: Task 11b binds the real
 * `PluginSettingTab` base (with `containerEl` and the `Setting` builder) into
 * the barrel, and Task 17 calls `getSettingDefinitions()` on whatever the
 * plugin passed. What the harvest needs today is a reference to the live
 * instance and an answer to "does it declare its settings", and both work
 * against the structural type — so nothing here has to be re-decided when the
 * class arrives under the same name.
 */
export interface PluginSettingTab {
  display?(): void;
  hide?(): void;
  getSettingDefinitions?(): unknown;
}

/**
 * The stand-in for an `HTMLElement`, for the three calls that return one.
 *
 * The host compiles with `lib: es2023` and no DOM, and there is no document to
 * hand back a real element from. Plugins chain onto what `addRibbonIcon` and
 * `addStatusBarItem` return (`.setText(...)`, `.addClass(...)`, `.createEl(...)`),
 * so the stand-in answers every one of those with itself rather than with
 * `undefined` — a chain that ends in a `TypeError` inside `onload` would defeat
 * rule 1 above. Task 11b owns the fuller DOM shim; this is the floor.
 */
export interface HeadlessElement {
  readonly headless: true;
  [member: string]: unknown;
}

/** Everything a `Plugin` needs from the host, installed against its `App`. */
export interface PluginHostContext {
  readonly config: HostConfig;
  readonly client: VaultdClient;
  readonly writes: WriteGate;
  readonly harvest: Harvest;
  readonly events: ShimEventBus;
  readonly queue: DispatchQueue;
  readonly clock: Clock;
  /** Where a failure with nobody waiting on it goes — see `shim/errors.ts`. */
  readonly errors: HostErrors;
}

/**
 * Keyed by the `App` rather than held in a module-level variable, so two hosts
 * in one process — a test that assembles twice, Task 22's live host beside a
 * harness — never read each other's wiring.
 */
const hostContexts = new WeakMap<App, PluginHostContext>();

/** Wire an assembled host's internals to the `App` its plugins are handed. */
export function installPluginHost(app: App, context: PluginHostContext): void {
  hostContexts.set(app, context);
}

/** The host behind an `App`, or a throw naming what was not assembled. */
export function pluginHostFor(app: App): PluginHostContext {
  const context = hostContexts.get(app);
  if (context === undefined) {
    throw new Error("this App was never assembled by the host: no plugin context is installed");
  }
  return context;
}

/**
 * What a component needs from the host when something goes wrong on the way
 * out, and when it has to disarm a timer the shim did not arm.
 *
 * A bare `Component` has neither — `new SomeComponent()` names no plugin and no
 * host — so the context arrives from above: a {@link Plugin} builds it in its
 * constructor, and {@link Component.addChild} hands its own down. A component
 * with no context still tears down; it just has nowhere to report to.
 */
interface ComponentContext {
  readonly clock: Clock;
  report(error: unknown, phase: HostErrorPhase): void;
}

/**
 * `Component`: a lifecycle and four lists of things to undo.
 *
 * **Teardown order, fixed by the Task 10 fix-round-1 ruling:** children unload,
 * then the `register()` callbacks in reverse, then the event refs, then the
 * timers, and `onunload()` **last**. Last is the point of it — a plugin's
 * `onunload` that touches the vault would otherwise re-enter its own listeners
 * and its own intervals, which are still live if `onunload` runs first. (Task
 * 10 shipped it first, pinned by the brief's fourth case; the ruling reversed
 * both.)
 *
 * **Nothing thrown on the unload path escapes.** Every step runs inside a guard
 * that reports through {@link ComponentContext.report} and carries on: the
 * plugin most likely to throw while being torn down is exactly the one a
 * quarantine is trying to remove, and a throw that escaped would leave its
 * listeners attached, its timers armed, and its harvest un-forgotten.
 *
 * **`unload()` is idempotent for real.** The flag is set before any of the work,
 * so a second call is a no-op even when the first one threw — and the lists are
 * drained rather than iterated, so nothing can run twice.
 */
export abstract class Component {
  private loadedFlag = false;
  private unloadedFlag = false;
  private context: ComponentContext | null = null;
  /** `register(cb)` — the plugin's own undo callbacks. */
  private readonly registered: (() => unknown)[] = [];
  /** `registerEvent(ref)` — detached after the callbacks above have run. */
  private readonly eventRefs: EventRef[] = [];
  /** `registerInterval(id)` — disarmed last, so nothing can re-arm behind it. */
  private readonly timerIds: number[] = [];
  /**
   * This component's children — spelled with Obsidian's own leading underscore.
   *
   * **Uncaptured best-effort, and named as such.** `_children` and
   * {@link _loaded} are Obsidian's *private* fields: no published typing
   * mentions them and no runtime capture in this repository pins their shape.
   * They are here because bundles reach for them anyway — `nested-properties`
   * ships a `Component` subclass whose own `load()` does `[...this._children]`
   * and whose own `addChild` pushes into it, so a base class without the field
   * kills that plugin at its first `addChild` with a spread of `undefined`.
   *
   * It is the **real list**, not a copy: this host's `addChild` pushes here and
   * its `unload` drains here, so a bundle that pushes in directly is pushing
   * into the list this component will actually tear down. A copy would have
   * been the worse kind of mimic — present, readable, and silently connected to
   * nothing.
   *
   * If Obsidian's internals turn out to differ, this is a guess that costs
   * nothing when unused, and the compatibility report is where a plugin needing
   * deeper internals gets recorded.
   */
  readonly _children: Component[] = [];

  /** Whether `load()` has run and `unload()` has not. */
  get isLoaded(): boolean {
    return this.loadedFlag && !this.unloadedFlag;
  }

  /**
   * Obsidian's private "has `onload` run" flag, mirroring this host's own.
   *
   * An accessor pair rather than a second field, deliberately: a bundle that
   * reimplements `load()` sets `this._loaded = true` and never calls
   * `super.load()`, and a duplicate field would leave this host believing the
   * component never loaded — so its `unload()` would skip `onunload` and every
   * registration made during that load would leak. Mirroring the one flag makes
   * the bundle's write and this host's read the same fact.
   *
   * Uncaptured best-effort, for the reasons in {@link _children}.
   */
  get _loaded(): boolean {
    return this.loadedFlag;
  }

  set _loaded(value: boolean) {
    this.loadedFlag = value;
  }

  /**
   * Run `onload`, once.
   *
   * Returns whatever `onload` returns so an `async onload` can be awaited: a
   * host that did not await it would run its first request against a plugin
   * whose registrations had not landed yet.
   */
  load(): void | Promise<void> {
    if (this.loadedFlag) return;
    this.loadedFlag = true;
    return this.onload();
  }

  onload(): void | Promise<void> {
    // A plugin overrides this. The base does nothing on purpose.
  }

  /**
   * Tear this component down, in the ruled order, without ever throwing.
   *
   * A component that was never loaded has no `onunload` worth running, so it is
   * marked and left alone. The exposure that follows from that, for the next
   * reader: a registration made in a **constructor** rather than in `onload` is
   * not undone when a plugin that never loaded is unloaded. A plugin whose
   * `onload` threw is unaffected — the flag is set before `onload` runs — so
   * the only way to reach it is to register before the host has decided to load
   * you at all.
   */
  unload(): void {
    if (this.unloadedFlag) return;
    this.unloadedFlag = true;
    if (!this.loadedFlag) return;
    for (const child of this._children.splice(0).reverse()) {
      this.guard("teardown", () => {
        child.unload();
      });
    }
    for (const undo of this.registered.splice(0).reverse()) {
      this.guard("teardown", undo);
    }
    for (const ref of this.eventRefs.splice(0).reverse()) {
      this.guard("teardown", () => {
        ref.detach();
      });
    }
    for (const id of this.timerIds.splice(0).reverse()) {
      this.guard("teardown", () => {
        clearTimerById(id, this.context?.clock ?? null);
      });
    }
    this.guard("onunload", () => {
      this.onunload();
    });
  }

  onunload(): void {
    // A plugin overrides this. The base does nothing on purpose.
  }

  /**
   * Adopt a child, and load it if this component is itself loaded.
   *
   * The child inherits this component's context, so a failure inside a child's
   * teardown is still attributed to the plugin that owns the tree.
   */
  /**
   * Adopt a child, and load it if this component is itself loaded.
   *
   * The child inherits this component's context, so a failure inside a child's
   * teardown — or inside its `onload` — is still attributed to the plugin that
   * owns the tree.
   *
   * **The load is not awaited, and its rejection is caught.** Not awaited
   * because what a parent's `load()` should do about a child's is a question
   * this host has no capture to answer, and inventing an aggregation here would
   * be inventing behaviour. Caught because the two are separate questions: an
   * unguarded `void child.load()` turns one plugin's async `onload` throwing
   * into an unhandled rejection on the process — host-killing under Node's
   * default, with no plugin id and no phase attached to it.
   *
   * A child added before its parent loads is held rather than loaded, and the
   * parent's own `load()` does not sweep the list; that sweep is the same
   * uncaptured question.
   */
  addChild<T extends Component>(child: T): T {
    this._children.push(child);
    child.adoptContext(this.context);
    if (this.loadedFlag && !this.unloadedFlag) {
      void Promise.resolve(child.load()).catch((error: unknown) => {
        this.context?.report(error, "onload");
      });
    }
    return child;
  }

  removeChild<T extends Component>(child: T): T {
    const at = this._children.indexOf(child);
    if (at !== -1) this._children.splice(at, 1);
    child.unload();
    return child;
  }

  register(callback: () => unknown): void {
    this.registered.push(callback);
  }

  registerEvent(ref: EventRef): void {
    this.eventRefs.push(ref);
  }

  /**
   * Accepted and discarded: there is no DOM to attach a listener to.
   *
   * Recorded as a `safe_stub` hit rather than as an unreachable row, because
   * the plugin has not told the host what the listener was *for*. The
   * `dom_delegated_menu` rows belong to Task 14's bundle scan, which can see
   * what this call cannot: nine of tag-wrangler's ten delegated listeners never
   * reach this method at all.
   */
  registerDomEvent(...args: unknown[]): void {
    void args;
    stub("Component.registerDomEvent", undefined);
  }

  /**
   * Really schedules, and is really cleared on unload.
   *
   * Eight plugins in the corpus depend on an interval actually firing, so this
   * is `implemented` rather than stubbed. The cadence is read back from the
   * timer registry the host's `window.setInterval` writes to — the call itself
   * carries only an id — and {@link Plugin.registerInterval} is what puts it in
   * the harvest, because the id alone does not say whose timer it is.
   *
   * An id the shim's own `window` did not arm is still cleared, through this
   * component's injected clock. A plugin that reached around the shim for its
   * timer would otherwise keep firing after it was unloaded.
   */
  registerInterval(id: number): number {
    this.timerIds.push(id);
    return id;
  }

  /** Install the host wiring a `Plugin` has and a bare `Component` does not. */
  protected adoptContext(context: ComponentContext | null): void {
    this.context = context;
  }

  /** What this component reports failures through, for a subclass to pass on. */
  protected componentContext(): ComponentContext | null {
    return this.context;
  }

  /** Run one teardown step; report whatever it throws and carry on. */
  private guard(phase: HostErrorPhase, step: () => void): void {
    try {
      step();
    } catch (error) {
      this.context?.report(error, phase);
    }
  }
}

/**
 * Obsidian's `Plugin`: the class every bundle extends.
 *
 * Abstract because Obsidian's is, and because nothing should ever construct a
 * bare one — a `Plugin` with no `onload` registers nothing and is indistinguishable
 * from a plugin that failed to load.
 */
export abstract class Plugin extends Component {
  readonly app: App;
  readonly manifest: PluginManifest;

  /**
   * Declared, never defined.
   *
   * `declare` is load-bearing: this host targets ES2023, where an undeclared
   * optional field would be *defined* as `undefined` on every instance and
   * would shadow the method a plugin puts on its own prototype. Task 17 calls
   * it when the config service sees a plugin's `data.json` change underneath it.
   */
  declare onExternalSettingsChange?: () => void;

  private readonly host: PluginHostContext;

  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    this.host = pluginHostFor(app);
    // Every failure this plugin's teardown produces — its own, and any child
    // component's — carries its id from here.
    this.adoptContext({
      clock: this.host.clock,
      report: (error, phase) => {
        this.host.errors.report(error, manifest.id, phase);
      },
    });
  }

  // --- Harvested registrations ----------------------------------------------

  /**
   * Namespace the id, record the row, hand the command to the registry, and
   * register its withdrawal.
   *
   * A plugin's command ids are prefixed with the plugin id, and everything that
   * addresses a command later — the palette, a hotkey, the host's own
   * `invoke_command` — uses the prefixed form.
   *
   * **The teardown is half the delegation.** Without it an unloaded or
   * quarantined plugin's commands would stay in `app.commands` and stay
   * executable: the harvest forgets them, the registry would not. Today
   * `app.commands` is absent and the seam is inert; it starts working the
   * moment Task 12 assigns the field, which is why it is written now rather
   * than there.
   *
   * Two differences from the GUI worth recording for Task 16a/22, both of which
   * the brief pins: the command object is **copied** rather than rewritten in
   * place, and `name` is stored as the plugin wrote it rather than prefixed
   * with the plugin's display name.
   */
  addCommand(command: Command): Command {
    recordUse("Plugin.addCommand");
    const pluginId = this.manifest.id;
    const namespaced: Command = { ...command, id: `${pluginId}:${command.id}` };
    this.register(() => {
      commandSinkOf(this.app)?.removeCommand?.(namespaced.id);
    });
    this.host.harvest.recordCommand({
      pluginId,
      id: namespaced.id,
      localId: command.id,
      name: command.name,
      icon: command.icon ?? null,
      kind: commandKindOf(command),
      hotkeys: (command.hotkeys ?? []).map((hotkey) => ({
        modifiers: [...hotkey.modifiers],
        key: hotkey.key,
      })),
    });
    commandSinkOf(this.app)?.addCommand(namespaced);
    return namespaced;
  }

  /**
   * Forget a command, by the **local** id — the one the plugin passed to
   * `addCommand`. A qualified id is accepted too, since half the corpus passes
   * back what `addCommand` returned.
   */
  removeCommand(id: string): void {
    recordUse("Plugin.removeCommand");
    const qualified = id.startsWith(`${this.manifest.id}:`) ? id : `${this.manifest.id}:${id}`;
    this.host.harvest.forgetCommand(qualified);
    commandSinkOf(this.app)?.removeCommand?.(qualified);
  }

  addRibbonIcon(icon: string, title: string, callback: (evt: unknown) => unknown): HeadlessElement {
    recordUse("Plugin.addRibbonIcon");
    this.host.harvest.recordRibbonIcon(this.manifest.id, title, icon, callback);
    return headlessElement();
  }

  /**
   * Answers with an element nothing displays.
   *
   * Harvested in the sense that the *call* is recorded — but not as a row of
   * its own: a status bar item carries no id, no action and no text until the
   * plugin writes into the element, so there is nothing a caller could ask for
   * by name. The compatibility report counts the hits; Task 16a sends nothing.
   */
  addStatusBarItem(): HeadlessElement {
    return stub("Plugin.addStatusBarItem", headlessElement());
  }

  addSettingTab(tab: PluginSettingTab): void {
    recordUse("Plugin.addSettingTab");
    this.host.harvest.recordSettingTab({
      pluginId: this.manifest.id,
      hasSettingDefinitions: typeof tab.getSettingDefinitions === "function",
      // The live instance, deliberately: Task 17's schema ladder has to call
      // `getSettingDefinitions()` on it, and nothing else holds a reference.
      tab,
    });
  }

  registerObsidianProtocolHandler(
    action: string,
    handler: (params: Record<string, string>) => unknown,
  ): void {
    recordUse("Plugin.registerObsidianProtocolHandler");
    this.host.harvest.recordProtocolHandler(this.manifest.id, action, handler);
  }

  // --- Accepted and discarded ------------------------------------------------

  registerView(type: string, ctor: unknown): void {
    void ctor;
    this.host.harvest.recordUnreachable({
      pluginId: this.manifest.id,
      kind: "view",
      detail: type,
    });
    stub("Plugin.registerView", undefined);
  }

  registerEditorExtension(extension: unknown): void {
    this.host.harvest.recordUnreachable({
      pluginId: this.manifest.id,
      kind: "editor_extension",
      detail: describeRegistration(extension, "a CodeMirror extension"),
    });
    stub("Plugin.registerEditorExtension", undefined);
  }

  registerMarkdownPostProcessor(processor: unknown, sortOrder?: number): unknown {
    void sortOrder;
    // Not unreachable: nothing renders markdown here, but a post-processor
    // describes a transform rather than a surface a caller could ask for, so
    // there is nothing to put in a report beyond the hit.
    return stub("Plugin.registerMarkdownPostProcessor", processor);
  }

  registerMarkdownCodeBlockProcessor(language: string, processor: unknown): unknown {
    this.host.harvest.recordUnreachable({
      pluginId: this.manifest.id,
      kind: "code_block_processor",
      detail: language,
    });
    return stub("Plugin.registerMarkdownCodeBlockProcessor", processor);
  }

  registerEditorSuggest(suggest: unknown): void {
    this.host.harvest.recordUnreachable({
      pluginId: this.manifest.id,
      kind: "editor_suggest",
      detail: describeRegistration(suggest, "an editor suggester"),
    });
    stub("Plugin.registerEditorSuggest", undefined);
  }

  registerHoverLinkSource(id: string, info: unknown): void {
    void id;
    void info;
    stub("Plugin.registerHoverLinkSource", undefined);
  }

  // --- Timers ----------------------------------------------------------------

  override registerInterval(id: number): number {
    recordUse("Component.registerInterval");
    this.host.harvest.recordTimer({
      pluginId: this.manifest.id,
      // A timer armed through something other than the host's own
      // `window.setInterval` has no cadence to read back, and `null` says that
      // out loud. `0` would have been a lie the idle-cost census could not spot
      // — it reads as a timer that fires as fast as the loop will let it.
      intervalMs: intervalMsOf(id),
      createdAt: this.host.clock.now(),
    });
    return super.registerInterval(id);
  }

  // --- Plugin data -----------------------------------------------------------

  /**
   * Read `<hostConfigDir>/plugins/<id>/data.json`, or `null` if it is not there.
   *
   * `null` rather than `{}`: a plugin with no saved data is the ordinary case,
   * and fifty plugins in the corpus branch on a falsy answer to install their
   * defaults.
   *
   * **A file that is not JSON is reported and answered `null` too** — the
   * least-harm choice pending a runtime capture of what the GUI really does
   * with one. The alternative is a throw inside `onload`, which kills the whole
   * plugin over one bad byte in a settings file; answering `null` puts it on
   * the path every one of those fifty plugins already handles, and the failure
   * still reaches the host's error sink rather than disappearing.
   *
   * It stays inside the **host's** config directory, so the GUI copy's
   * `data.json` is structurally untouchable rather than merely left alone by
   * convention.
   */
  async loadData(): Promise<unknown> {
    recordUse("Plugin.loadData");
    let source: string;
    try {
      const response = await this.host.client.request<ReadFileResponse>("read_file", {
        path: this.dataPath(),
      });
      source = Buffer.from(response.content_base64, "base64").toString("utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (source.trim() === "") return null;
    try {
      return JSON.parse(source) as unknown;
    } catch (error) {
      this.host.errors.report(error, this.manifest.id, "plugin-data");
      return null;
    }
  }

  /**
   * Write the plugin's `data.json`, creating its folder if the daemon says it
   * is not there.
   *
   * The folder is created **on the refusal** rather than ahead of every write:
   * a plugin that saves its settings on every keystroke would otherwise send a
   * `create_folder` per save for a folder that has existed since the first one.
   * `create_folder` walks its own segments, so one call is enough however much
   * of the chain is missing.
   */
  async saveData(data: unknown): Promise<void> {
    recordUse("Plugin.saveData");
    const path = this.dataPath();
    const params = {
      path,
      content_base64: Buffer.from(JSON.stringify(data, null, 2), "utf8").toString("base64"),
    };
    try {
      await this.host.writes.send<WriteFileResponse>("write_file", params);
      return;
    } catch (error) {
      if (!isParentMissing(error)) throw error;
    }
    await this.host.writes.send<unknown>("create_folder", { path: parentOf(path) });
    await this.host.writes.send<WriteFileResponse>("write_file", params);
  }

  /**
   * `<hostConfigDir>/plugins/<id>/data.json`. Never `.obsidian/`.
   *
   * Through the shared helper rather than a template string of its own, so that
   * this and `HeadlessConfigDir.dataPath` cannot drift: Task 17's config service
   * reads the file this method writes, and the two naming it independently is
   * the kind of agreement that holds until someone changes one of them.
   */
  private dataPath(): string {
    return pluginDataPath(this.host.config.configDirName, this.manifest.id);
  }
}

/** The most specific callback a command declares is the kind it is. */
function commandKindOf(command: Command): HarvestedCommandKind {
  if (command.editorCheckCallback !== undefined) return "editorCheckCallback";
  if (command.editorCallback !== undefined) return "editorCallback";
  if (command.checkCallback !== undefined) return "checkCallback";
  return "callback";
}

type HarvestedCommandKind = "callback" | "checkCallback" | "editorCallback" | "editorCheckCallback";

/** What `app.commands` looks like from here, before Task 12 builds it. */
interface CommandSink {
  addCommand(command: Command): unknown;
  removeCommand?(id: string): unknown;
}

/**
 * The command registry, when there is one.
 *
 * **Task 12 assigned `app.commands`, and this stayed a duck-type check.** The
 * field is now a real `CommandRegistry` in every assembled host, but it is
 * assigned by the assembler rather than by the constructor, and a case that
 * builds an `App` by hand — or replaces `commands` with a recording double,
 * which `shim-plugin.test.ts` does — still has to be able to load a plugin. A
 * structural check answers for all three, where a field read would be a
 * `TypeError` on the first `addCommand` of a half-built app.
 */
function commandSinkOf(app: App): CommandSink | null {
  const commands: unknown = (app as App & { commands?: unknown }).commands;
  if (typeof commands !== "object" || commands === null) return null;
  const candidate = commands as { addCommand?: unknown };
  return typeof candidate.addCommand === "function" ? (commands as CommandSink) : null;
}

/**
 * A name for something a plugin registered, for the unreachable row's detail.
 *
 * `constructor?.name` rather than `constructor.name`: an object made with
 * `Object.create(null)` has no constructor, and a `TypeError` raised here would
 * escape from inside the one set of methods whose whole purpose is never to
 * throw during `onload`.
 */
function describeRegistration(value: unknown, fallback: string): string {
  if (typeof value === "function") return value.name === "" ? fallback : value.name;
  if (typeof value === "object" && value !== null) {
    const name = value.constructor?.name;
    return name === undefined || name === "" || name === "Object" ? fallback : name;
  }
  return fallback;
}

/** The daemon's two ways of saying "there is no such file". */
function isMissing(error: unknown): boolean {
  return (
    error instanceof VaultdError &&
    (error.code === "not_found" || error.code === "parent_not_found")
  );
}

function isParentMissing(error: unknown): boolean {
  return error instanceof VaultdError && error.code === "parent_not_found";
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * An element-shaped object whose every method answers with itself.
 *
 * A `Proxy` rather than a hand-written list, because the list is Obsidian's
 * whole `HTMLElement` extension surface plus the DOM's — `setText`, `addClass`,
 * `createEl`, `appendChild`, `empty`, `onClickEvent`, and any of a hundred more
 * a plugin may chain. Answering all of them with a chainable no-op is the only
 * version of this that cannot throw inside an `onload`.
 */
function headlessElement(): HeadlessElement {
  const target = { headless: true } as HeadlessElement;
  const element: HeadlessElement = new Proxy(target, {
    get(receiver, member): unknown {
      if (member === "headless") return true;
      if (member in receiver) return receiver[member as string];
      if (typeof member === "symbol") return undefined;
      // `then` must stay absent, or this object is a thenable: `await el` or
      // returning it from an async function would call `el.then(resolve)`, get
      // the chainable no-op back, and never settle.
      if (member === "then") return undefined;
      // Two shapes plugins read rather than call, answered as themselves so a
      // `.style.display = "none"` or a `.textContent` read is inert too.
      if (member === "textContent" || member === "innerText") return "";
      return (): HeadlessElement => element;
    },
    set(receiver, member, value): boolean {
      if (typeof member === "symbol") return true;
      receiver[member] = value;
      return true;
    },
  });
  return element;
}

// The table rows this file owns. Module-level, so importing the module is all
// it takes for the compatibility report to know about them — with nothing
// constructed and no vault open.
declarePolicy("Plugin.addCommand", "harvested");
declarePolicy("Plugin.removeCommand", "harvested");
declarePolicy("Plugin.addRibbonIcon", "harvested");
declarePolicy("Plugin.addStatusBarItem", "safe_stub");
declarePolicy("Plugin.addSettingTab", "harvested");
declarePolicy("Plugin.registerObsidianProtocolHandler", "harvested");
declarePolicy("Plugin.registerView", "safe_stub");
declarePolicy("Plugin.registerEditorExtension", "safe_stub");
declarePolicy("Plugin.registerMarkdownPostProcessor", "safe_stub");
declarePolicy("Plugin.registerMarkdownCodeBlockProcessor", "safe_stub");
declarePolicy("Plugin.registerEditorSuggest", "safe_stub");
declarePolicy("Plugin.registerHoverLinkSource", "safe_stub");
declarePolicy("Plugin.loadData", "implemented");
declarePolicy("Plugin.saveData", "implemented");
declarePolicy("Component.registerDomEvent", "safe_stub");
declarePolicy("Component.registerInterval", "implemented");
