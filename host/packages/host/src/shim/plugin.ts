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
import { VaultdError } from "../client/errors";
import type { App } from "./app";
import type { EventRef, ShimEventBus } from "./events";
import type { Harvest } from "./harvest";
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
 * Obsidian's `Component`: a lifecycle and a list of things to undo.
 *
 * `unload()` runs `onunload()` first and then drains the teardown list in
 * reverse registration order — the order that lets a later registration depend
 * on an earlier one — and marks itself unloaded so a second `unload()` does
 * nothing. Unloading twice is ordinary (a plugin unloaded during a quarantine
 * that is then unloaded again at shutdown), and a teardown that ran twice would
 * hand a plugin's `onunload` a world it had already dismantled.
 */
export abstract class Component {
  private loadedFlag = false;
  private unloadedFlag = false;
  private readonly teardown: (() => unknown)[] = [];
  private readonly children: Component[] = [];

  /** Whether `load()` has run and `unload()` has not. */
  get isLoaded(): boolean {
    return this.loadedFlag && !this.unloadedFlag;
  }

  /**
   * Run `onload`, once.
   *
   * Returns whatever `onload` returns so an `async onload` can be awaited. That
   * is a real departure from Obsidian, whose `load()` is `void` — but plugins
   * write `async onload` constantly, and a host that did not await it would run
   * the first request against a plugin whose registrations had not landed yet.
   */
  load(): void | Promise<void> {
    if (this.loadedFlag) return;
    this.loadedFlag = true;
    return this.onload();
  }

  onload(): void | Promise<void> {
    // A plugin overrides this. The base does nothing on purpose.
  }

  unload(): void {
    if (this.unloadedFlag) return;
    this.unloadedFlag = true;
    this.onunload();
    for (const child of this.children.splice(0).reverse()) child.unload();
    for (const undo of this.teardown.splice(0).reverse()) {
      try {
        undo();
      } catch {
        // A teardown that throws must not strand the ones behind it: the
        // remaining undos are what keep a quarantined plugin from leaving
        // listeners and timers behind.
      }
    }
  }

  onunload(): void {
    // A plugin overrides this. The base does nothing on purpose.
  }

  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    void child.load();
    return child;
  }

  removeChild<T extends Component>(child: T): T {
    const at = this.children.indexOf(child);
    if (at !== -1) this.children.splice(at, 1);
    child.unload();
    return child;
  }

  register(callback: () => unknown): void {
    this.teardown.push(callback);
  }

  registerEvent(ref: EventRef): void {
    this.teardown.push(() => {
      ref.detach();
    });
  }

  /**
   * Accepted and discarded: there is no DOM to attach a listener to.
   *
   * Recorded as a `safe_stub` hit rather than as an unreachable row, because
   * the plugin has not told the host what the listener was *for*. The ten
   * delegated listeners tag-wrangler installs are recorded as
   * `dom_delegated_menu` by Task 14's bundle scan, which can see what this call
   * cannot.
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
   */
  registerInterval(id: number): number {
    this.teardown.push(() => {
      clearTimerById(id);
    });
    return id;
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
  }

  // --- Harvested registrations ----------------------------------------------

  /**
   * Namespace the id, record the row, and hand the command to the registry.
   *
   * Obsidian prefixes a plugin's command ids with the plugin id, and everything
   * that addresses a command later — the palette, a hotkey, the host's own
   * `invoke_command` — uses the prefixed form. Returning the namespaced command
   * is Obsidian's behaviour too.
   */
  addCommand(command: Command): Command {
    recordUse("Plugin.addCommand");
    const pluginId = this.manifest.id;
    const namespaced: Command = { ...command, id: `${pluginId}:${command.id}` };
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
   * `addCommand` — as Obsidian's own `removeCommand` takes it.
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
      // `window.setInterval` has no cadence to read back. It is still recorded,
      // with `0` standing for "unknown", because a timer nobody can see is
      // exactly what the idle-cost census exists to surface.
      intervalMs: intervalMsOf(id) ?? 0,
      createdAt: this.host.clock.now(),
    });
    return super.registerInterval(id);
  }

  // --- Plugin data -----------------------------------------------------------

  /**
   * Read `<hostConfigDir>/plugins/<id>/data.json`, or `null` if it is not there.
   *
   * `null` rather than `{}` because that is what Obsidian answers for a plugin
   * with no saved data, and fifty plugins in the corpus branch on it to install
   * their defaults. Malformed JSON still throws, also as Obsidian does.
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
    return JSON.parse(source) as unknown;
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

  /** `<hostConfigDir>/plugins/<id>/data.json`. Never `.obsidian/`. */
  private dataPath(): string {
    return `${this.host.config.configDirName}/plugins/${this.manifest.id}/data.json`;
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
 * Task 12 assigns `app.commands`; until it does this answers `null` and the
 * harvest is the only list. Written as a duck-type check rather than a field
 * read so the delegation starts working the moment that task lands, with no
 * edit here.
 */
function commandSinkOf(app: App): CommandSink | null {
  const commands = (app as App & { commands?: unknown }).commands;
  if (typeof commands !== "object" || commands === null) return null;
  const candidate = commands as { addCommand?: unknown };
  return typeof candidate.addCommand === "function" ? (commands as CommandSink) : null;
}

/** A name for something a plugin registered, for the unreachable row's detail. */
function describeRegistration(value: unknown, fallback: string): string {
  if (typeof value === "function") return value.name === "" ? fallback : value.name;
  if (typeof value === "object" && value !== null) {
    const name = value.constructor.name;
    return name === "" || name === "Object" ? fallback : name;
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
