/**
 * The `electron` module, for a bundle that was compiled against Electron and is
 * now running under plain Node.
 *
 * **Three calls are real, and they are the three plugins actually make.**
 * `shell.openPath`, `shell.showItemInFolder` and `shell.openExternal` are how a
 * desktop plugin says "show this to the human", and a host with a terminal can
 * genuinely do that — it hands the path to the platform opener. Everything else
 * Electron exposes is a window, a renderer process or an IPC channel to a main
 * process that does not exist, and there is nothing honest to do with it.
 *
 * **Everything else fails by name, which is the whole reason for the `Proxy`.**
 * A plain object hands `undefined` to a bundle that reaches for `remote` or
 * `webFrame`; the bundle calls it and dies three frames later with `undefined is
 * not a function`, naming neither the symbol nor the host. The `get` trap
 * returns a function that throws {@link HeadlessUnsupported} with
 * `electron.remote` in the message and the current plugin attributed, so the
 * compatibility report can say who reached for what.
 *
 * **The interop probes are the exception.** `__esModule`, `default` and `then`
 * are read by machinery rather than by a plugin — a bundler's default-interop
 * wrapper reads the first two, and `await` reads the third. Refusing them would
 * turn an ordinary `await stub` into a throw naming a symbol nobody wrote, so
 * they answer `undefined`, which is what a module object without them answers.
 */

import { execFile } from "node:child_process";

import { declarePolicy, recordUse, refuseInDryRun, stub, unsupported } from "../shim/policy";
import type { ElectronStub } from "./electron-registry";

/**
 * How this host reaches the platform opener.
 *
 * Injected rather than imported at the call site so a test can watch what would
 * have been run without running it — and because `--dry-run` has to refuse
 * before the process is spawned, not after.
 */
export type OsSpawn = (command: string, args: readonly string[]) => Promise<void>;

export interface ElectronStubDeps {
  /** When true, every OS bridge refuses with a `DryRunRefused`. */
  readonly dryRun: boolean;
  readonly spawn: OsSpawn;
}

/** The dry-run report's grouping for the three `shell` calls. */
const OS_BRIDGE = "os_bridge";

/** Read by machinery, never by a plugin. See the header. */
const INTEROP_PROBES = new Set(["__esModule", "default", "then"]);

/**
 * Hand a path or a URL to the platform's own opener.
 *
 * `open` on macOS, which is the platform this host is developed and captured
 * on. Linux's `xdg-open` and Windows' `start` take different arguments —
 * `showItemInFolder` in particular has no portable spelling — so rather than
 * guess at two platforms with no capture behind them, this names the one it
 * knows and Task 22's compatibility report is where a second one gets added.
 */
export function osSpawn(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], (error: Error | null) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
}

export function createElectronStub(deps: ElectronStubDeps): ElectronStub {
  const bridge = async (symbol: string, command: string, args: readonly string[]): Promise<void> => {
    if (deps.dryRun) refuseInDryRun(symbol, OS_BRIDGE, args.join(" "));
    // Recorded before the spawn, at the symbol's own declared policy, so the
    // report says a plugin reached for the opener whether or not it succeeded.
    recordUse(symbol);
    await deps.spawn(command, args);
  };

  const shell = {
    /**
     * Electron's own success value is the **empty string**: `openPath` resolves
     * with the error message, and no error is no message. A plugin that checks
     * `if (result)` would branch into its failure path on any other answer.
     */
    async openPath(path: string): Promise<string> {
      await bridge("electron.shell.openPath", "open", [path]);
      return "";
    },
    async showItemInFolder(path: string): Promise<void> {
      await bridge("electron.shell.showItemInFolder", "open", ["-R", path]);
    },
    async openExternal(url: string): Promise<void> {
      await bridge("electron.shell.openExternal", "open", [url]);
    },
  };

  /**
   * Accepts every listener and delivers to none.
   *
   * There is no main process to send from, so a registration is a promise this
   * host can keep only in the sense that it never breaks it: nothing is ever
   * delivered, and nothing throws. `invoke` and `sendSync` are the two that
   * *return* something, and an inert answer to those is a wrong answer — so
   * they refuse by name, carrying the channel.
   */
  const ipcRenderer: ElectronStub["ipcRenderer"] = {
    on: () => stub("electron.ipcRenderer.on", undefined),
    off: () => stub("electron.ipcRenderer.on", undefined),
    once: () => stub("electron.ipcRenderer.on", undefined),
    removeListener: () => stub("electron.ipcRenderer.on", undefined),
    removeAllListeners: () => stub("electron.ipcRenderer.on", undefined),
    send: () => stub("electron.ipcRenderer.send", undefined),
    sendSync: (channel: string) => unsupported("electron.ipcRenderer.invoke", channel),
    invoke: (channel: string) => unsupported("electron.ipcRenderer.invoke", channel),
  };

  const surface = { shell, ipcRenderer };

  return new Proxy(surface, {
    get(target, property: string | symbol): unknown {
      if (typeof property === "symbol") return Reflect.get(target, property);
      if (Object.prototype.hasOwnProperty.call(target, property)) {
        return Reflect.get(target, property);
      }
      if (INTEROP_PROBES.has(property)) return undefined;
      // A function rather than an immediate throw: a bundle that merely *reads*
      // `electron.remote` to test for it — several do — must not die on the
      // read. It dies on the call, which is the first moment it truly needs the
      // thing that is not here.
      return (): never => unsupported(`electron.${property}`);
    },
  });
}

// The rows this file owns. Dotted members, so they reach the compatibility
// report through `declaredSymbols()` without being names a plugin can import.
declarePolicy("electron.shell.openPath", "implemented");
declarePolicy("electron.shell.showItemInFolder", "implemented");
declarePolicy("electron.shell.openExternal", "implemented");
declarePolicy("electron.ipcRenderer.on", "safe_stub");
declarePolicy("electron.ipcRenderer.send", "safe_stub");
declarePolicy("electron.ipcRenderer.invoke", "absent");
