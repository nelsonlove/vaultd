/**
 * The `obsidian` module, as a plugin bundle resolves it.
 *
 * **A minimal barrel, created in Task 10 and owned by Task 11b.** Task 10's own
 * cases write `class extends harness.api.Plugin`, so the barrel has to be
 * reachable two tasks before the task that fills it in. What is here is exactly
 * the bindings that exist so far, bound by hand. Task 11b **replaces the body**
 * of {@link createObsidianApi} with the `API_POLICY`-driven walk: every symbol
 * in the policy table, bound to its implementation, its safe stub, or a getter
 * that throws `HeadlessUnsupported` — and it asserts that the barrel's key set
 * and `declaredSymbols()` agree. Until then, a name a plugin reaches for that is
 * not below is `undefined` rather than a typed refusal.
 *
 * The index signature is 11b's declaration, kept here unchanged: a barrel is a
 * module object, and a plugin may read any name off it. The named members are
 * the ones this host's own code and tests use as types — an index signature
 * alone would type every one of them `unknown`, and `class extends
 * (something: unknown)` does not compile.
 */

import { App } from "./app";
import { Component, Plugin } from "./plugin";
import { DataAdapter, FileSystemAdapter } from "./adapter";
import { Events, Menu, MenuItem } from "./events";
import { FileManager } from "./file-manager";
import { MetadataCache } from "./metadata-cache";
import { ShimTimers } from "./timers";
import { TAbstractFile, TFile, TFolder } from "./files";
import { Vault } from "./vault";
import { Workspace } from "./workspace";
import type { HostAssembly } from "../testing/assemble";

/**
 * `window`, as a plugin uses it: four timer functions and nothing else yet.
 *
 * The timers are the reason this exists at all. `registerInterval` is handed a
 * bare id, so the cadence has to be captured where it is known — inside
 * `setInterval` — and that means the `window` a plugin calls has to be the
 * host's rather than the real global. Task 11a installs the fuller globals.
 */
export interface ShimWindow {
  setInterval(callback: () => void, ms: number): number;
  clearInterval(id: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  readonly document: ShimDocument;
}

/**
 * `activeDocument`, as a plugin uses it: something to hand `registerDomEvent`.
 *
 * It accepts listeners and drops them, because there is no DOM to deliver
 * anything from. `registerDomEvent` records the hit; this is only the object
 * the plugin passes in.
 */
export interface ShimDocument {
  addEventListener(...args: unknown[]): void;
  removeEventListener(...args: unknown[]): void;
  readonly body: ShimDocument;
}

export interface ObsidianApi {
  readonly App: typeof App;
  readonly Component: typeof Component;
  readonly DataAdapter: typeof DataAdapter;
  readonly Events: typeof Events;
  readonly FileManager: typeof FileManager;
  readonly FileSystemAdapter: typeof FileSystemAdapter;
  readonly Menu: typeof Menu;
  readonly MenuItem: typeof MenuItem;
  readonly MetadataCache: typeof MetadataCache;
  readonly Plugin: typeof Plugin;
  readonly TAbstractFile: typeof TAbstractFile;
  readonly TFile: typeof TFile;
  readonly TFolder: typeof TFolder;
  readonly Vault: typeof Vault;
  readonly Workspace: typeof Workspace;
  readonly window: ShimWindow;
  readonly activeWindow: ShimWindow;
  readonly activeDocument: ShimDocument;
  readonly [symbol: string]: unknown;
}

/**
 * Bind one assembled host's `obsidian` module.
 *
 * It takes the assembly rather than nothing because the timer functions have to
 * arm on **this** host's clock: a test that advances its own `TestClock` must
 * see its own plugin's intervals fire, and a module-level pair would arm every
 * host's timers on whichever clock was installed last.
 *
 * The parameter is spelled `Omit<HostAssembly, "api">` so the assembler can
 * call it while building the very object it returns; a full {@link HostAssembly}
 * is assignable to it, so a later caller holding one passes it unchanged.
 */
export function createObsidianApi(assembly: Omit<HostAssembly, "api">): ObsidianApi {
  const timers = new ShimTimers(assembly.clock);
  const document = headlessDocument();
  const shimWindow: ShimWindow = {
    setInterval: (callback, ms) => timers.setInterval(callback, ms),
    clearInterval: (id) => {
      timers.clearInterval(id);
    },
    setTimeout: (callback, ms) => timers.setTimeout(callback, ms),
    clearTimeout: (id) => {
      timers.clearTimeout(id);
    },
    document,
  };
  return Object.freeze({
    App,
    Component,
    DataAdapter,
    Events,
    FileManager,
    FileSystemAdapter,
    Menu,
    MenuItem,
    MetadataCache,
    Plugin,
    TAbstractFile,
    TFile,
    TFolder,
    Vault,
    Workspace,
    window: shimWindow,
    activeWindow: shimWindow,
    activeDocument: document,
  });
}

/** One inert document, self-referential so `document.body` is also inert. */
function headlessDocument(): ShimDocument {
  const document = {
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  } as { addEventListener(): void; removeEventListener(): void; body?: ShimDocument };
  document.body = document as ShimDocument;
  return document as ShimDocument;
}
