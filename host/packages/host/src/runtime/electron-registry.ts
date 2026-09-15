/**
 * The two module registries the workspace's stand-in packages read through.
 *
 * `host/node_modules/obsidian` and `host/node_modules/electron` are links to
 * `packages/obsidian` and `packages/electron`, two three-line CommonJS files
 * whose whole job is to hand a bundle whatever this host has assembled. They
 * cannot hold the value themselves: a module body runs **once**, and the thing a
 * bundle must be handed is built per host — so what the packages hold is a
 * lookup into these two cells, performed at the moment the bundle reads.
 *
 * **Why the state lives on `globalThis` rather than in this module.** There are
 * two copies of this file in a test process and that is not a bug: Vitest loads
 * `src/runtime/electron-registry.ts` through its own transform, and Node loads
 * `dist/runtime/electron-registry.js` when the `obsidian` package requires it by
 * path. Two module instances, two module-level `let`s — and an assembler that
 * registered into one while a bundle read the other would find nothing, with
 * nothing to say about why. One process-wide cell, keyed by a
 * {@link Symbol.for} name, is what makes the two copies the same registry.
 *
 * **One host per process** is the standing assumption (`main.ts` starts one), so
 * one cell is one host. A second registration replaces the first — which is what
 * a test that assembles several harnesses in one file is doing, deliberately:
 * the most recently assembled host is the one a bundle loaded now belongs to.
 */

import type { ObsidianApi } from "../shim/api";

export interface ElectronStub {
  readonly shell: {
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  readonly ipcRenderer: {
    on(channel: string, listener: (...args: unknown[]) => void): void;
    off(channel: string, listener: (...args: unknown[]) => void): void;
    once(channel: string, listener: (...args: unknown[]) => void): void;
    removeListener(channel: string, listener: (...args: unknown[]) => void): void;
    removeAllListeners(channel?: string): void;
    send(channel: string, ...args: unknown[]): void;
    sendSync(channel: string, ...args: unknown[]): never;
    invoke(channel: string, ...args: unknown[]): never;
  };
}

export class ElectronNotRegistered extends Error {
  readonly code = "electron_not_registered";
  constructor() {
    super(
      "require(\"electron\") was resolved before the host registered its stub; " +
        "call registerElectronStub(createElectronStub(...)) during host assembly, " +
        "before any plugin bundle loads",
    );
    this.name = "ElectronNotRegistered";
  }
}

export class ObsidianApiNotAssembled extends Error {
  readonly code = "obsidian_api_not_assembled";
  readonly symbol: string | null;
  constructor(symbol?: string) {
    super(
      (symbol === undefined ? "the obsidian module" : `the obsidian module's ${symbol}`) +
        " was read before this process assembled a host; assembleShim() registers the " +
        "module a bundle resolves, and it must run before any bundle loads",
    );
    this.name = "ObsidianApiNotAssembled";
    this.symbol = symbol ?? null;
  }
}

/** What the one process-wide cell holds. */
interface ModuleRegistry {
  electron: ElectronStub | null;
  obsidian: ObsidianApi | null;
}

const CELL = Symbol.for("vaultd.host.moduleRegistry");

function registry(): ModuleRegistry {
  const holder = globalThis as unknown as Record<symbol, ModuleRegistry | undefined>;
  const existing = holder[CELL];
  if (existing !== undefined) return existing;
  const fresh: ModuleRegistry = { electron: null, obsidian: null };
  holder[CELL] = fresh;
  return fresh;
}

/** Called exactly once during host assembly, before any bundle loads. */
export function registerElectronStub(stub: ElectronStub): void {
  registry().electron = stub;
}

/** Called by the `electron` package's `index.js` at require time. */
export function currentElectronStub(): ElectronStub {
  const found = registry().electron;
  if (found === null) throw new ElectronNotRegistered();
  return found;
}

/** Test-only: drop the registration so a fresh assembly can install its own. */
export function clearElectronStub(): void {
  registry().electron = null;
}

/**
 * Called at the end of host assembly, with the barrel that host built.
 *
 * Last rather than first — the opposite of the electron stub — because the
 * barrel is the last thing `assembleShim` builds: it binds every surface above
 * it. Nothing can have loaded a bundle in between, because only the assembler
 * is running.
 */
export function registerObsidianApi(api: ObsidianApi): void {
  registry().obsidian = api;
}

/** Called by the `obsidian` package's `index.js` on every property read. */
export function currentObsidianApi(symbol?: string): ObsidianApi {
  const found = registry().obsidian;
  if (found === null) throw new ObsidianApiNotAssembled(symbol);
  return found;
}

/** Test-only: drop the registration so a fresh assembly can install its own. */
export function clearObsidianApi(): void {
  registry().obsidian = null;
}
