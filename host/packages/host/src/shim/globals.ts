/**
 * The globals a plugin bundle reads before anyone hands it anything.
 *
 * **Why this exists at all.** A plugin is a class the host instantiates, so it
 * would be reasonable to think everything it touches arrives through its
 * constructor. It does not: a bundle's *module scope* runs first, and the
 * corpus reads globals there. `nested-properties` reads `globalThis.app` while
 * its module is still evaluating — before any instance exists to hand an `App`
 * to — and rollover-daily-todos' vendored `obsidian-daily-notes-interface`
 * reaches `window.app` at twenty-four sites and `window.moment` at fifteen,
 * never `this.app`. So the globals have to be standing before a bundle is
 * evaluated, which is why {@link installGlobals} is called from the assembler
 * rather than from a plugin loader.
 *
 * **What is installed, and what each one is.** Three different kinds of thing
 * share this file, and the difference matters to the compatibility report:
 *
 * - **Real.** `moment` is the actual library (a declared dependency of this
 *   package, at the version Obsidian ships), `localStorage` really persists
 *   through the host's data directory, and the four timer functions really
 *   arm — on the injected {@link Clock}, so a test drives time rather than
 *   waiting for it and a leaked interval is a number a case can assert on.
 * - **Inert.** `document`, `navigator`, `MutationObserver`, `i18next` and the
 *   element constructors accept what a plugin does with them and do nothing.
 * - **Refused.** `window.require` throws a typed {@link HeadlessUnsupported}
 *   naming the specifier, because this host is not Electron and a plugin
 *   reaching for a Node builtin through the window is asking for something
 *   that is genuinely not here. A typed refusal is diagnosable; an `undefined`
 *   that fails one call later is not.
 *
 * **`window` is not `globalThis`.** The brief called for an alias, and an alias
 * is what a browser has — but this process is Node, and `globalThis.setTimeout`
 * is what Node's own machinery, the test runner, and this host's supervisor all
 * use. Overwriting it with a `TestClock`-backed one would freeze the runtime
 * itself. So `window` is an object whose **prototype is `globalThis`**: every
 * global a plugin reads through it resolves exactly as it would through an
 * alias, while the four timer functions, `require`, `moment` and `app` are own
 * properties that shadow Node's. The one observable difference is that
 * `window.foo = 1` does not create a bare global `foo`, which nothing in the
 * corpus relies on.
 *
 * **Everything is installed through property descriptors, and every descriptor
 * is remembered.** Some of these names are already defined on `globalThis` in
 * Node 24 — `navigator` is a getter — and a plain assignment to an accessor
 * property silently does nothing. {@link GlobalInstallation.restore} puts back
 * exactly what was there, which is what lets a process assemble a host, tear it
 * down, and assemble another.
 *
 * **Two hosts in one process share the globals, and that is accepted.** A
 * second install shadows the first: the bare names (`app`, `document`,
 * `localStorage`) point at the newest host, and because the first host's
 * `window` owns only a handful of properties and resolves the rest through
 * `globalThis`, its `window.document` resolves to the *newest* installation
 * too. What stays per-host is what a plugin is actually handed — the `obsidian`
 * barrel, which binds its own host's `window`, `app` and surfaces. This is
 * accepted rather than fixed because production runs one host per process
 * (`main.ts` starts one) and test files are forked and sequential; the fix, if
 * a second live host ever shares a process, is to `restore()` the first.
 */

import moment from "moment";

import { DataDir } from "../datadir";
import { ShimTimers } from "./timers";
import {
  StubEl,
  StubFragment,
  StubNode,
  createDiv,
  createEl,
  createFragment,
  createSpan,
  createStubDocument,
} from "./dom";
import { currentPluginId, declarePolicy, recordUse, stub, unsupported } from "./policy";
import type { App } from "./app";
import type { Clock, HostConfig } from "../config";
import type { Harvest, HarvestedUnreachable } from "./harvest";
import type { HostErrors } from "./errors";
import type { StubDocument } from "./dom";

/**
 * `window`, as a plugin reaches it.
 *
 * The index signature is not laziness: `window` in a browser carries every
 * global there is, and this one really does resolve them through its prototype,
 * so a type that named only the members below would be lying about the object.
 * The named members are the ones this host's own code and tests depend on.
 */
export interface HostWindow {
  setInterval(callback: () => void, ms: number): number;
  setTimeout(callback: () => void, ms: number): number;
  clearInterval(id: number): void;
  clearTimeout(id: number): void;
  /**
   * Spelled as a property rather than as a method on purpose: the one-fs-seam
   * check in `test/fs-seam.test.ts` bans the shape `require` immediately
   * followed by a parenthesis anywhere under `src/`, because that is how a
   * module reaches the file system without naming it. A method signature would
   * trip a ban it is not the subject of.
   */
  readonly require: (specifier: string) => unknown;
  addEventListener(type: string, listener: unknown, options?: unknown): void;
  removeEventListener(type: string, listener: unknown, options?: unknown): void;
  dispatchEvent(event: unknown): boolean;
  readonly app: App;
  readonly moment: typeof moment;
  readonly document: StubDocument;
  readonly window: HostWindow;
  readonly localStorage: HostLocalStorage;
  readonly [member: string]: unknown;
}

/**
 * What {@link installGlobals} needs that the config cannot carry.
 *
 * **`dataDir` is here rather than read off the config**, and that is the whole
 * point of the parameter: `HostConfig.dataDir` is `$XDG_STATE_HOME/vaultd-host`
 * by default, so a host assembled from a default config — which is every test
 * harness — would persist `localStorage` into the developer's home directory.
 * Production passes the real path from `main.ts`; a harness passes a fresh
 * directory of its own, and `test/shim-dom.test.ts` holds the guard that says
 * no harness root is ever under the real one.
 */
export interface GlobalDeps {
  /** Where `localStorage` is persisted. Never defaulted from the config. */
  readonly dataDir: string;
  /** Where a failure nobody is waiting on goes — a torn stored document. */
  readonly errors: HostErrors;
  /** Where a `window` listener nothing can deliver to is recorded. */
  readonly harvest: Harvest;
  /**
   * The clock `window.setInterval` arms on.
   *
   * Passed rather than read from `config.clock` so that one host has one clock:
   * `assembleShim` threads `deps.clock` everywhere else, and a caller that
   * passed a different one would otherwise get plugin timers on one clock and
   * host timers on another, silently.
   */
  readonly clock: Clock;
}

/** What {@link installGlobals} hands back: the two objects, and the undo. */
export interface GlobalInstallation {
  readonly window: HostWindow;
  readonly document: StubDocument;
  readonly localStorage: HostLocalStorage;
  /** Put every global back exactly as it was found. */
  restore(): void;
}

/**
 * `localStorage`, backed by a `Map` and persisted to the host's data dir.
 *
 * **It really persists, because plugins really depend on it.** Obsidian keeps
 * per-vault UI state here and several plugins keep their own — a value written
 * on one run and read back on the next is the whole contract, and a `Map` that
 * evaporated with the process would make every such plugin behave as though it
 * had just been installed, every time.
 *
 * **Lazy at both ends.** Nothing is read from disk until the first access and
 * nothing is written until the first mutation, so a host that never touches
 * `localStorage` — which is every test in this suite that does not ask for it —
 * never creates the file.
 *
 * **Keys and values are both `String()`-coerced**, because that is what a
 * browser does: `setItem(7, "seven")` is readable as `getItem("7")`, and a
 * bundle that keys by a numeric id and reads back by a string one finds its
 * value rather than `null`.
 *
 * **A stored document that will not parse costs the values, not the store.**
 * The read is wrapped, the failure is reported through the host's error seam,
 * and the store starts empty — because the alternative is a `SyntaxError` out
 * of a plugin's first `getItem`, inside `onload`, which takes the whole plugin
 * down over a file the host itself wrote. The write goes through
 * {@link DataDir.writeJsonAtomic}, so the host cannot be the thing that creates
 * such a document: a truncated rewrite is never observable, only the whole
 * previous document or the whole new one.
 */
export class HostLocalStorage {
  private readonly entries = new Map<string, string>();
  private loaded = false;

  constructor(
    private readonly dir: DataDir,
    private readonly file: string,
    private readonly errors: HostErrors,
  ) {}

  get length(): number {
    this.load();
    return this.entries.size;
  }

  getItem(key: string): string | null {
    this.load();
    recordUse("localStorage");
    return this.entries.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.load();
    recordUse("localStorage");
    this.entries.set(String(key), String(value));
    this.persist();
  }

  removeItem(key: string): void {
    this.load();
    recordUse("localStorage");
    this.entries.delete(String(key));
    this.persist();
  }

  clear(): void {
    this.load();
    recordUse("localStorage");
    this.entries.clear();
    this.persist();
  }

  key(index: number): string | null {
    this.load();
    return [...this.entries.keys()][index] ?? null;
  }

  private load(): void {
    if (this.loaded) return;
    // Set before the read, not after: a read that throws must not leave the
    // store unloaded, or every later call would retry the same broken document
    // and report it again.
    this.loaded = true;
    let stored: Record<string, unknown> | null = null;
    try {
      stored = this.dir.readJson<Record<string, unknown>>(this.file);
    } catch (error) {
      // `plugin-data` is the phase for stored data that will not parse, which
      // is exactly what this is; the plugin whose call hit it is named when
      // there is one, and the host owns it otherwise.
      this.errors.report(error, currentPluginId() ?? "host", "plugin-data");
      return;
    }
    // A document that parses to something other than an object — `3`, `null`,
    // an array — is corrupt in the other direction, and gets the same answer.
    if (stored === null || typeof stored !== "object") return;
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === "string") this.entries.set(key, value);
    }
  }

  private persist(): void {
    this.dir.writeJsonAtomic(this.file, Object.fromEntries(this.entries));
  }
}

/** The file the store lives in, under the host's own data directory. */
const LOCAL_STORAGE_FILE = "localstorage.json";

/**
 * `window.addEventListener` and its two companions: accepted, recorded, and
 * never delivered to.
 *
 * **Why they exist at all.** In a browser these three are always there, and
 * `document`'s equivalents are already stubbed here — so a `window` without
 * them is an asymmetry that ends in a raw `TypeError` inside `onload`, which is
 * the failure mode this whole phase is built to avoid. `quickadd` calls
 * `window.addEventListener` fourteen times and `tag-wrangler` twice.
 *
 * **Why they are recorded.** A listener is a plugin telling the host about a
 * capability it is offering, and this host has no event loop that will ever
 * deliver one — so the honest thing is to write down what was offered.
 * `contextmenu` is separated out as `dom_delegated_menu` because that one is a
 * menu a user could have opened, and Task 14's bundle scan can work out what it
 * would have contained; everything else is a `dom_listener`, which is a fact
 * about idle cost rather than a capability.
 *
 * A registration made outside a plugin's load has nobody to attribute it to and
 * is accepted without being recorded — the same rule the workspace's menu hooks
 * follow, for the same reason: an unowned row could not be withdrawn, reported,
 * or dropped with its plugin.
 */
class WindowListeners {
  private readonly rows: Array<{
    readonly type: string;
    readonly listener: unknown;
    readonly row: HarvestedUnreachable;
  }> = [];

  constructor(private readonly harvest: Harvest) {}

  add(type: string, listener: unknown): void {
    stub("window.addEventListener", undefined);
    const pluginId = currentPluginId();
    if (pluginId === null) return;
    const row: HarvestedUnreachable = {
      pluginId,
      kind: type === "contextmenu" ? "dom_delegated_menu" : "dom_listener",
      detail: type,
    };
    this.harvest.recordUnreachable(row);
    this.rows.push({ type, listener, row });
  }

  /**
   * Withdraw the row a matching `addEventListener` recorded.
   *
   * By `(type, listener)` and only the first match, which is what
   * `removeEventListener` does: a plugin that registered the same function for
   * two event types, or twice for one, must be able to take exactly one back.
   */
  remove(type: string, listener: unknown): void {
    stub("window.removeEventListener", undefined);
    const at = this.rows.findIndex((entry) => entry.type === type && entry.listener === listener);
    if (at === -1) return;
    const [dropped] = this.rows.splice(at, 1);
    if (dropped !== undefined) this.harvest.forgetUnreachable(dropped.row);
  }
}

/**
 * An observer that never observes.
 *
 * Plugins construct one in `onload` and disconnect it in `onunload`; there is
 * no document for it to watch, so the honest implementation is a pair of
 * no-ops. It must still be a **constructor**, because `new MutationObserver(cb)`
 * is what the plugin writes.
 */
class InertMutationObserver {
  constructor(callback: (records: unknown[], observer: unknown) => unknown) {
    void callback;
    stub("MutationObserver", undefined);
  }

  observe(target: unknown, options?: unknown): void {
    void target;
    void options;
  }

  disconnect(): void {
    // Nothing was ever connected.
  }

  takeRecords(): unknown[] {
    return [];
  }
}

/**
 * Install every global, and hand back the undo.
 *
 * Called by `assembleShim` immediately after the `App` is constructed and long
 * before any bundle can be evaluated. The `App` is a mutable container whose
 * surfaces land a few lines later, which is fine and is the whole reason it is
 * a mutable container: nothing reads `globalThis.app.vault` between the two
 * points, because nothing but the assembler is running.
 */
export function installGlobals(app: App, config: HostConfig, deps: GlobalDeps): GlobalInstallation {
  const patcher = new GlobalPatcher();
  const timers = new ShimTimers(deps.clock);
  const document = createStubDocument();
  const localStorage = new HostLocalStorage(new DataDir(deps.dataDir), LOCAL_STORAGE_FILE, deps.errors);
  const listeners = new WindowListeners(deps.harvest);

  // `window` first, because everything else is installed on `globalThis` and
  // therefore reachable through its prototype the moment it is defined.
  const host = Object.create(globalThis) as HostWindow;
  defineOwn(host, "setInterval", (callback: () => void, ms: number) => timers.setInterval(callback, ms));
  defineOwn(host, "setTimeout", (callback: () => void, ms: number) => timers.setTimeout(callback, ms));
  defineOwn(host, "clearInterval", (id: number) => {
    timers.clearInterval(id);
  });
  defineOwn(host, "clearTimeout", (id: number) => {
    timers.clearTimeout(id);
  });
  defineOwn(host, "require", hostRequire);
  defineOwn(host, "moment", moment);
  defineOwn(host, "app", app);
  defineOwn(host, "window", host);
  // **A bundle's bare `setTimeout` does not come here**, and cannot be made to
  // from this file: it resolves to `globalThis`, and replacing Node's own
  // timers would freeze the runtime. Task 13's module wrapper shadows the four
  // names with these, which is where a bundle's bare call becomes `window`'s,
  // exactly as it is in the browser the bundle was compiled for.
  defineOwn(host, "addEventListener", (type: string, listener: unknown, options?: unknown) => {
    void options;
    listeners.add(type, listener);
  });
  defineOwn(host, "removeEventListener", (type: string, listener: unknown, options?: unknown) => {
    void options;
    listeners.remove(type, listener);
  });
  defineOwn(host, "dispatchEvent", (event: unknown) => {
    void event;
    // `true` is "not cancelled", which is the honest answer when nothing
    // listened: no handler ran, so no handler called `preventDefault`.
    return stub("window.dispatchEvent", true);
  });

  patcher.define(globalThis, "window", host);
  patcher.define(globalThis, "activeWindow", host);
  patcher.define(globalThis, "app", app);
  patcher.define(globalThis, "moment", moment);
  patcher.define(globalThis, "document", document);
  patcher.define(globalThis, "activeDocument", document);
  patcher.define(globalThis, "localStorage", localStorage);
  patcher.define(globalThis, "navigator", navigatorFor(config));
  patcher.define(globalThis, "i18next", {
    t: (key: string): string => stub("i18next", key),
    language: config.momentLocale,
    exists: (): boolean => false,
    changeLanguage: (): Promise<void> => Promise.resolve(),
  });
  patcher.define(globalThis, "MutationObserver", InertMutationObserver);

  // The element constructors. `Element` and `HTMLElement` are the same class,
  // because nothing this host does distinguishes them and plugins use both
  // names only as `instanceof` branches. `Node` is their base and
  // `DocumentFragment` their sibling, so both tests a plugin writes — "is this
  // an element" and "is this a fragment" — answer as a browser answers them.
  // See `shim/dom.ts`.
  patcher.define(globalThis, "Node", StubNode);
  patcher.define(globalThis, "Element", StubEl);
  patcher.define(globalThis, "HTMLElement", StubEl);
  patcher.define(globalThis, "DocumentFragment", StubFragment);

  patcher.define(globalThis, "createEl", createEl);
  patcher.define(globalThis, "createDiv", createDiv);
  patcher.define(globalThis, "createSpan", createSpan);
  patcher.define(globalThis, "createFragment", createFragment);

  installPrototypeExtensions(patcher);

  // Obsidian sets moment's locale from the app's language, and the host's
  // equivalent knob is `momentLocale`. It is global state on a shared library,
  // so the previous value is restored with everything else.
  const previousLocale = moment.locale();
  moment.locale(config.momentLocale);
  patcher.onRestore(() => {
    moment.locale(previousLocale);
  });

  return {
    window: host,
    document,
    localStorage,
    restore: () => {
      patcher.restore();
    },
  };
}

/**
 * The Obsidian prototype extensions, as non-enumerable properties.
 *
 * Non-enumerable is not a detail: an enumerable `Array.prototype.first` shows
 * up in every `for (const key in array)` in the process — this host's own code,
 * the test runner's, and every plugin's — and quietly corrupts loops that have
 * nothing to do with the shim.
 *
 * The `Node.prototype` half of Obsidian's extension set is already present:
 * `detach`, `empty`, `setText`, `createEl`, `createDiv`, `createSpan`,
 * `addClass`, `removeClass`, `toggleClass`, `setAttr` and `appendText` are
 * declared as methods of {@link StubEl}, which **is** the `Node` this host
 * installs, so its prototype carries all of them without a patch.
 */
function installPrototypeExtensions(patcher: GlobalPatcher): void {
  patcher.defineHidden(Array.prototype, "first", function <T>(this: T[]): T | undefined {
    return this.length === 0 ? undefined : this[0];
  });
  patcher.defineHidden(Array.prototype, "last", function <T>(this: T[]): T | undefined {
    return this.length === 0 ? undefined : this[this.length - 1];
  });
  patcher.defineHidden(Array.prototype, "contains", function <T>(this: T[], target: T): boolean {
    return this.includes(target);
  });
  patcher.defineHidden(Array.prototype, "remove", function <T>(this: T[], target: T): void {
    const at = this.indexOf(target);
    if (at !== -1) this.splice(at, 1);
  });
  patcher.defineHidden(Array.prototype, "unique", function <T>(this: T[]): T[] {
    return [...new Set(this)];
  });
  patcher.defineHidden(String.prototype, "contains", function (this: string, target: string): boolean {
    return this.includes(target);
  });
}

/**
 * `navigator`, for the platform sniffs plugins do.
 *
 * **Uncaptured, and chosen for least harm.** No runtime capture of Obsidian's
 * own `navigator.userAgent` exists in this repository, so rather than invent
 * one this says what is true — the platform this process is on, and that the
 * agent is the vaultd host — in the shape a sniff can read. What matters to the
 * corpus is the absence of a mobile token: a plugin testing for `Android` or
 * `iPhone` must come out desktop, because a headless host on a laptop is a
 * desktop.
 */
function navigatorFor(config: HostConfig): {
  userAgent: string;
  platform: string;
  language: string;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
} {
  const platform =
    process.platform === "darwin" ? "MacIntel" : process.platform === "win32" ? "Win32" : "Linux x86_64";
  const os =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return {
    userAgent: `Mozilla/5.0 (${os}) vaultd-host/${config.appVersion} (headless)`,
    platform,
    language: config.momentLocale,
    clipboard: {
      readText: (): Promise<string> => Promise.resolve(stub("navigator.clipboard", "")),
      writeText: (text: string): Promise<void> => {
        void text;
        stub("navigator.clipboard", undefined);
        return Promise.resolve();
      },
    },
  };
}

/**
 * `window.require` — refused, by name.
 *
 * In Obsidian this is Electron's own loader and a desktop-only plugin uses it
 * to reach Node builtins. This host is not Electron, and the answer is a typed
 * throw carrying the specifier rather than an `undefined` that fails one call
 * later with nothing to say. A bundle's *own* `require` — the one its module
 * wrapper is handed, which is how it resolves `obsidian` and `electron` — is a
 * different door entirely and belongs to the loader task.
 */
function hostRequire(specifier: string): never {
  return unsupported("window.require", specifier);
}

/** Define an own property on the window object, shadowing `globalThis`. */
function defineOwn(target: HostWindow, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
}

/**
 * Installs globals and remembers how to put them back.
 *
 * Descriptors rather than assignments throughout: several of these names are
 * already accessor properties on Node's `globalThis`, and assigning to an
 * accessor with no setter fails silently in sloppy mode and throws in strict
 * mode. A descriptor overwrite works in both, and remembering the descriptor is
 * the only way to restore a getter someone else defined.
 */
class GlobalPatcher {
  private readonly undo: Array<() => void> = [];

  define(target: object, key: string, value: unknown): void {
    this.install(target, key, value, true);
  }

  /** As {@link define}, but non-enumerable — for prototype extensions. */
  defineHidden(target: object, key: string, value: unknown): void {
    this.install(target, key, value, false);
  }

  onRestore(undo: () => void): void {
    this.undo.push(undo);
  }

  /** Undo in reverse, so a name installed twice ends up as it started. */
  restore(): void {
    for (const undo of [...this.undo].reverse()) undo();
    this.undo.length = 0;
  }

  private install(target: object, key: string, value: unknown, enumerable: boolean): void {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable });
    this.undo.push(() => {
      if (previous === undefined) delete (target as Record<string, unknown>)[key];
      else Object.defineProperty(target, key, previous);
    });
  }
}

declare global {
  interface Array<T> {
    /** Obsidian's extension: the first element, or `undefined`. */
    first(): T | undefined;
    /** Obsidian's extension: the last element, or `undefined`. */
    last(): T | undefined;
    /** Obsidian's extension: `includes`, under the name plugins call. */
    contains(target: T): boolean;
    /** Obsidian's extension: remove the first occurrence, in place. */
    remove(target: T): void;
    /** Obsidian's extension: a copy with duplicates dropped. */
    unique(): T[];
  }
  interface String {
    /** Obsidian's extension: `includes`, under the name plugins call. */
    contains(target: string): boolean;
  }
}

// The rows this file owns. Module-level, so the compatibility report knows
// about them with nothing constructed and no vault open.
//
// **About a dozen of these can never record a hit**, and a reader of the report
// should be told why rather than left to wonder: `window`, `activeWindow`,
// `activeDocument`, `moment`, `app`, `Node`, `Element`, `DocumentFragment` and
// the six prototype extensions are read as *properties*, and a property read on
// a plain value cannot be intercepted. They are declarations of surface — "this
// host has this, at this policy" — not counters. The rows that do count are the
// ones behind a function call: `localStorage`, `window.require`,
// `window.addEventListener`, `i18next`, `navigator.clipboard`.
declarePolicy("window", "safe_stub");
declarePolicy("window.addEventListener", "harvested");
declarePolicy("window.removeEventListener", "harvested");
declarePolicy("window.dispatchEvent", "safe_stub");
declarePolicy("activeWindow", "safe_stub");
declarePolicy("activeDocument", "safe_stub");
declarePolicy("window.require", "absent");
declarePolicy("navigator", "safe_stub");
declarePolicy("navigator.clipboard", "safe_stub");
declarePolicy("i18next", "safe_stub");
declarePolicy("MutationObserver", "safe_stub");
declarePolicy("Element", "safe_stub");
declarePolicy("Node", "safe_stub");
declarePolicy("DocumentFragment", "safe_stub");
declarePolicy("localStorage", "implemented");
declarePolicy("moment", "implemented");
declarePolicy("app", "implemented");
declarePolicy("Array.prototype.first", "implemented");
declarePolicy("Array.prototype.last", "implemented");
declarePolicy("Array.prototype.contains", "implemented");
declarePolicy("Array.prototype.remove", "implemented");
declarePolicy("Array.prototype.unique", "implemented");
declarePolicy("String.prototype.contains", "implemented");
