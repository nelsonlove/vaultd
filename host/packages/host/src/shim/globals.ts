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
 */

import moment from "moment";

import { DataDir } from "../datadir";
import { ShimTimers } from "./timers";
import { StubEl, StubFragment, createDiv, createEl, createFragment, createSpan, createStubDocument } from "./dom";
import { declarePolicy, recordUse, stub, unsupported } from "./policy";
import type { App } from "./app";
import type { HostConfig } from "../config";
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
  readonly app: App;
  readonly moment: typeof moment;
  readonly document: StubDocument;
  readonly window: HostWindow;
  readonly localStorage: HostLocalStorage;
  readonly [member: string]: unknown;
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
 * `localStorage` — which is every test in this suite today — never creates the
 * file. The write is a whole-document rewrite rather than an append: the
 * document is a few kilobytes of UI state, and a torn append would be
 * unparseable where a torn rewrite is at worst the previous state.
 */
export class HostLocalStorage {
  private readonly entries = new Map<string, string>();
  private loaded = false;

  constructor(
    private readonly dir: DataDir,
    private readonly file: string,
  ) {}

  get length(): number {
    this.load();
    return this.entries.size;
  }

  getItem(key: string): string | null {
    this.load();
    recordUse("localStorage");
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.load();
    recordUse("localStorage");
    this.entries.set(key, String(value));
    this.persist();
  }

  removeItem(key: string): void {
    this.load();
    recordUse("localStorage");
    this.entries.delete(key);
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
    this.loaded = true;
    // A document that is not there is an empty store; a document that is there
    // but is not an object is a corrupt one, and an empty store is the only
    // answer that does not throw inside somebody's `onload`.
    const stored = this.dir.readJson<Record<string, unknown>>(this.file);
    if (stored === null || typeof stored !== "object") return;
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === "string") this.entries.set(key, value);
    }
  }

  private persist(): void {
    this.dir.writeJson(this.file, Object.fromEntries(this.entries));
  }
}

/** The file the store lives in, under the host's own data directory. */
const LOCAL_STORAGE_FILE = "localstorage.json";

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
export function installGlobals(app: App, config: HostConfig): GlobalInstallation {
  const patcher = new GlobalPatcher();
  const timers = new ShimTimers(config.clock);
  const document = createStubDocument();
  const localStorage = new HostLocalStorage(new DataDir(config.dataDir), LOCAL_STORAGE_FILE);

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

  // The element constructors. `Node`, `Element` and `HTMLElement` are all the
  // same class, because nothing this host does distinguishes them and plugins
  // use the three names only as `instanceof` branches — see `shim/dom.ts`.
  // `DocumentFragment` is the one that has to be separate: a plugin testing for
  // it means "not an element", and a `div` must answer `false`.
  patcher.define(globalThis, "Node", StubEl);
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
declarePolicy("window", "safe_stub");
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
