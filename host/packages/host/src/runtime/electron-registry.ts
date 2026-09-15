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
  /**
   * The two module objects a bundle is handed, built once per **process**
   * rather than once per copy of this file — see {@link obsidianModule}. Both
   * copies of this module must hand back the same object, or a bundle that
   * resolved `obsidian` through Node and again through the `_load` patch would
   * hold two different module objects for one host.
   */
  obsidianModule: ObsidianApi | null;
  electronModule: ElectronStub | null;
}

const CELL = Symbol.for("vaultd.host.moduleRegistry");

function registry(): ModuleRegistry {
  const holder = globalThis as unknown as Record<symbol, ModuleRegistry | undefined>;
  const existing = holder[CELL];
  if (existing !== undefined) return existing;
  const fresh: ModuleRegistry = {
    electron: null,
    obsidian: null,
    obsidianModule: null,
    electronModule: null,
  };
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

// ---------------------------------------------------------------------------
// The two module objects a bundle is handed
// ---------------------------------------------------------------------------

/**
 * Why these are here rather than in the packages that publish them.
 *
 * There are **two** ways a bundle reaches `obsidian`: Node's own resolution
 * through `host/node_modules/obsidian` (the loader's `module.paths`), and the
 * `Module._load` patch in `runtime/intercept.ts`. If those two handed back
 * different objects the design would have two module systems rather than one —
 * and the difference that would actually bite is staleness: a snapshot taken at
 * require time is the barrel of whichever host was assembled then, so a bundle
 * that outlived a second assembly would hold surfaces pointing at a vault that
 * is gone.
 *
 * So the module object is built **once, here**, as a forwarding proxy, and both
 * mechanisms hand back that same object. The packages are three lines each.
 *
 * `has`, `ownKeys` and `getOwnPropertyDescriptor` are forwarded as well as
 * `get`, because bundlers interrogate a module object as well as reading from
 * it — `"default" in mod`, `Object.keys(mod)`, esbuild's `__toESM` own-keys
 * walk. A proxy answering only `get` looks empty to all three.
 *
 * The descriptor trap forces `configurable: true`. The assembled barrel is
 * frozen, so its own descriptors are non-configurable, and reporting a
 * non-configurable property that the proxy's target does not have is a
 * `TypeError` by the Proxy invariants — a true answer the language refuses to
 * let us give.
 */
function forwarding<T extends object>(current: (symbol?: string) => T): T {
  return new Proxy(Object.create(null) as T, {
    get(_target, property: string | symbol): unknown {
      if (typeof property === "symbol") return undefined;
      return (current(property) as Record<string, unknown>)[property];
    },
    has(_target, property: string | symbol): boolean {
      if (typeof property === "symbol") return false;
      return property in current(property);
    },
    ownKeys(): ArrayLike<string | symbol> {
      return Reflect.ownKeys(current());
    },
    getOwnPropertyDescriptor(_target, property: string | symbol): PropertyDescriptor | undefined {
      if (typeof property === "symbol") return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(current(property), property);
      if (descriptor === undefined) return undefined;
      return { ...descriptor, configurable: true };
    },
  });
}

/** The `obsidian` module object, live. Built once per process. */
export function obsidianModule(): ObsidianApi {
  const cell = registry();
  cell.obsidianModule ??= forwarding<ObsidianApi>(currentObsidianApi);
  return cell.obsidianModule;
}

/** The `electron` module object, live. Built once per process. */
export function electronModule(): ElectronStub {
  const cell = registry();
  cell.electronModule ??= forwarding<ElectronStub>(() => currentElectronStub());
  return cell.electronModule;
}
