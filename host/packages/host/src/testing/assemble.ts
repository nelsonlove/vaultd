/**
 * One factory, one wiring order — for the harnesses and for production alike.
 *
 * **Activated by Task 7**, which moved this file and `shim-harness.ts` up out of
 * `src/testing/pending/` when it built the first shim surface they refer to. The
 * `src/testing/pending` line stays in `tsconfig.json`'s and `vitest.config.ts`'s
 * excludes until the last file leaves that directory (Task 22).
 *
 * **Why one factory.** The shim's surfaces refer to each other in a cycle, so
 * the order they are built in is a real decision with a real failure mode — a
 * surface handed a half-built peer works until the day it reads a field during
 * construction. Writing that order once, here, and having the harnesses use the
 * same function production does means the tests exercise the real wiring rather
 * than a test-only arrangement that happens to work. Task 22's `main.ts` calls
 * this with `systemClock()`, and with Task 19's `DryRunGate` as the
 * {@link WriteGate} when `--dry-run` is on — otherwise with nothing, which
 * takes the {@link forwardingWriteGate} default below.
 */

import { App } from "../shim/app";
import { CommandRegistry } from "../shim/commands";
import { FileManager } from "../shim/file-manager";
import { InternalPluginRegistry } from "../shim/internal-plugins";
import { PluginRegistry } from "../shim/plugin-registry";
import { ShimEventBus } from "../shim/events";
import { MetadataCache } from "../shim/metadata-cache";
import { DispatchQueue } from "../runtime/queue";
import { setPolicyRecorder } from "../shim/policy";
import { Vault } from "../shim/vault";
import { Harvest } from "../shim/harvest";
import { NoticeLog } from "../shim/notice";
import { HostErrors } from "../shim/errors";
import { Workspace } from "../shim/workspace";
import { createObsidianApi } from "../shim/api";
import { installGlobals } from "../shim/globals";
import { installPluginHost } from "../shim/plugin";
import type { VaultdClient } from "../client/client";
import type { Clock, HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { ObsidianApi } from "../shim/api";
import type { ApiPolicy, PolicyRecorder } from "../shim/policy";
import type { GlobalInstallation } from "../shim/globals";
import type { WriteGate } from "../shim/vault";
import { createElectronStub, osSpawn } from "../runtime/electron-stub";
import {
  clearElectronStub,
  clearObsidianApi,
  registerElectronStub,
  registerObsidianApi,
} from "../runtime/electron-registry";
import type { OsSpawn } from "../runtime/electron-stub";
//
// `WriteGate` is declared in `../shim/vault` until Task 19 creates
// `../dryrun/dry-run`, which owns the interface and the one implementation
// (`DryRunGate`) that is not the forwarding default below. Nothing but this
// import line moves when it does.

/**
 * Everything one assembled shim consists of.
 *
 * The `clock` is a {@link Clock}, not a `TestClock`: the same function serves
 * production, which passes `systemClock()`. (The phase plan's sketch said
 * `TestClock` in both places, which no production call could satisfy.) A
 * harness that needs to advance time holds its own `TestClock` and passes it in
 * — it is the same object, at a narrower type.
 */
export interface HostAssembly {
  readonly config: HostConfig;
  readonly clock: Clock;
  readonly client: VaultdClient;
  readonly mirror: Mirror;
  readonly events: ShimEventBus;
  readonly queue: DispatchQueue;
  readonly policyRecorder: PolicyRecorder;
  readonly app: App;
  readonly writes: WriteGate;
  readonly harvest: Harvest;
  /**
   * Where a failure nobody is waiting on goes: a plugin's `onunload` throwing,
   * a teardown throwing, a menu hook throwing, a `data.json` that is not JSON.
   * Task 14b's quarantine listens here.
   */
  readonly errors: HostErrors;
  /**
   * The `window`, `document` and prototype extensions this host installed on
   * `globalThis`, and the undo for them.
   *
   * Part of the assembly rather than a side effect nobody holds, because they
   * are process-wide state: a caller that assembles a second host — Task 22's
   * live host beside a harness — has to be able to put the first one's globals
   * back, and a caller that never asks still has the objects the `obsidian`
   * barrel binds `window` and `activeDocument` to.
   */
  readonly globals: GlobalInstallation;
  /**
   * Every notice a plugin raised, in order, **in every mode**.
   *
   * Unconditional rather than gated on dry-run, which is the correction Task
   * 11b carries: `host.invoke_command` takes a `mark()` before dispatch and
   * reports `since(mark)` in its response, so a client sees exactly the notices
   * that command produced whether or not the host is pretending. Task 19's
   * `DryRunGate` reads a window of this log; it owns no second one.
   */
  readonly noticeLog: NoticeLog;
  /**
   * The module object a plugin bundle resolves `obsidian` to.
   *
   * Bound minimally in Task 10 — it is that task's tests that first write
   * `class extends api.Plugin` — and filled in by Task 11b's policy-driven
   * walk. It is last in the assembly because it names every surface above it.
   */
  readonly api: ObsidianApi;
  /**
   * Put this process back the way it was found: the module registries the
   * `obsidian` and `electron` packages read through, and every global.
   *
   * One call rather than three, because the three are one fact — "this host is
   * no longer the host of this process" — and a caller that put the globals
   * back while leaving a torn-down assembly registered would hand the next
   * bundle to load a barrel whose surfaces point at a vault that is gone.
   */
  teardown(): void;
}

/**
 * A `WriteGate` that forwards, which is what the host does when it is not
 * pretending.
 *
 * `WriteGate` is an **interface**, not a class — one method, `send` — and the
 * only concrete implementation the plan names is Task 19's `DryRunGate`, which
 * exists to *intercept*. So the ordinary case needs an implementation of its
 * own, and this is the whole of it: hand the request to the daemon. Task 22's
 * `main.ts` passes `DryRunGate` here instead when `--dry-run` is on, and
 * nothing between the two knows which it got.
 */
export function forwardingWriteGate(client: VaultdClient): WriteGate {
  return {
    send<T>(method: string, params: unknown): Promise<T> {
      return client.request<T>(method, params);
    },
  };
}

/**
 * The `PolicyRecorder` the host uses when nobody supplies one.
 *
 * `PolicyRecorder` is an interface too, and what it describes is a tally: every
 * time a plugin touches an API surface, record the symbol, the policy that
 * surface declares, and who touched it — then answer how many times. Counting
 * per `(symbol, plugin)` rather than per call is what makes the compatibility
 * report readable: "this plugin reached for `Modal.open` 400 times" is one row,
 * not four hundred.
 *
 * Exported beside {@link assembleShim} because the two are used together and
 * Task 7 owns `shim/policy.ts`; it may relocate this there without changing a
 * caller, since the type is the interface and not this function.
 */
export function memoryPolicyRecorder(): PolicyRecorder {
  interface Tally {
    symbol: string;
    policy: ApiPolicy;
    pluginId: string | null;
    hits: number;
  }
  // Insertion-ordered, so `entries()` reports surfaces in the order a plugin
  // first reached for them — which reads as a trace of what it tried to do.
  const tallies = new Map<string, Tally>();
  return {
    record(symbol: string, policy: ApiPolicy, pluginId: string | null): void {
      const key = `${symbol}\0${pluginId ?? ""}`;
      const existing = tallies.get(key);
      if (existing === undefined) tallies.set(key, { symbol, policy, pluginId, hits: 1 });
      else existing.hits += 1;
    },
    entries() {
      return [...tallies.values()].map((tally) => ({ ...tally }));
    },
  };
}

/**
 * Build the shim, in the one order that works.
 *
 * The electron stub is registered **first**, before anything that could load a
 * plugin bundle: a bundle that resolves `electron` before the stub is in place
 * gets the real module or a throw, and either way the failure surfaces far from
 * its cause.
 *
 * `writes` and `policyRecorder` are **injected rather than constructed**,
 * because both are interfaces: there is no `new WriteGate` and no
 * `new PolicyRecorder` to call. Omitting them gives the ordinary host — a gate
 * that forwards to the daemon and a recorder that tallies in memory. Task 19's
 * `DryRunGate` is what `--dry-run` passes for the first, and a test that wants
 * to read back what a plugin touched passes its own for the second.
 */
export function assembleShim(deps: {
  config: HostConfig;
  client: VaultdClient;
  mirror: Mirror;
  clock: Clock;
  /**
   * Where this host may write its own state — `localStorage` today.
   *
   * A parameter rather than `config.dataDir`, because the default config's
   * value is `$XDG_STATE_HOME/vaultd-host`: a harness assembled from it would
   * persist into the developer's home directory, and two test files would share
   * one document. Task 22's `main.ts` passes the real path; every harness
   * passes a fresh directory of its own. Omitting it falls back to the config,
   * which is what a caller that really means the real one is saying.
   */
  dataDir?: string;
  writes?: WriteGate;
  policyRecorder?: PolicyRecorder;
  /**
   * How `electron.shell.openPath` reaches the platform opener.
   *
   * Injected so a test can watch what would have been run without running it.
   * Production takes the default, which really spawns.
   */
  spawn?: OsSpawn;
}): HostAssembly {
  const { config, client, mirror, clock } = deps;
  const dataDir = deps.dataDir ?? config.dataDir;
  // **First**, before anything that could load a plugin bundle: a bundle that
  // resolves `electron` before the stub is in place gets the real module or a
  // throw — and either way the failure surfaces far from its cause. The barrel
  // the `obsidian` package resolves is registered at the very end instead,
  // because it is the last thing built; nothing can load a bundle in between,
  // since only the assembler is running.
  registerElectronStub(
    createElectronStub({ dryRun: config.dryRun, spawn: deps.spawn ?? osSpawn }),
  );

  // Nothing below observes anything but its own arguments during construction,
  // which is what lets a cycle be wired at all: the vault holds the event bus,
  // the bus holds nobody, and every cross-surface read happens later, from a
  // method.
  const events = new ShimEventBus();
  const policyRecorder = deps.policyRecorder ?? memoryPolicyRecorder();
  // The policy table is module-level — a lookup happens inside a getter on a
  // frozen barrel, far below anything holding the host — so the recorder every
  // `stub`/`unsupported` hit lands in is installed rather than passed.
  setPolicyRecorder(policyRecorder);
  const queue = new DispatchQueue();
  const writes = deps.writes ?? forwardingWriteGate(client);
  // The error sink and the harvest are built here, above every surface that
  // writes into them, because the globals need both: a torn `localStorage`
  // document is reported to the first, and a `window` listener nothing can
  // deliver to is recorded in the second. Neither reads anything during
  // construction, so moving them up costs nothing.
  //
  // A menu hook that throws is reported to the same sink a plugin's teardown
  // failures go to. Without the wiring the `Harvest` would catch the throw and
  // hand it nowhere, which is how a quarantine ends up unable to name the
  // plugin whose handler is broken.
  const errors = new HostErrors();
  const harvest = new Harvest({
    onHookError: (failure) => {
      errors.report(failure.error, failure.pluginId, "menu-hook");
    },
  });
  const app = new App({ appId: appIdFor(config.vaultRoot), appVersion: config.appVersion });
  // Straight after the `App` and before anything else, for the same reason the
  // electron stub goes first: a plugin bundle reads `globalThis.app`,
  // `window.moment` and `document` while its *module* is still evaluating —
  // before any instance exists to hand an `App` to — so the globals have to be
  // standing before a bundle can be loaded. The `App`'s own surfaces land a few
  // lines below, and nothing reads them in between: only the assembler is
  // running.
  const globals = installGlobals(app, config, { dataDir, errors, harvest, clock });
  const vault = new Vault({ config, client, mirror, events, writes, queue });
  // After the vault, because it resolves link paths to the `TFile` instances
  // the vault's index owns — and it reads that index rather than holding a
  // copy, so a file the vault renames is the same object this answers with.
  const metadataCache = new MetadataCache({ mirror, events, index: vault.index });
  // Third, because it reads both of the others: the vault's index for the files
  // it moves and the metadata cache's resolver for the links it composes.
  const fileManager = new FileManager({ mirror, vault, metadataCache, writes, queue });
  // On this host's clock, so a notice's `atUnixMs` is the same time base every
  // other timestamp in this host is measured against.
  const noticeLog = new NoticeLog({ clock });
  // The workspace needs the harvest at construction — its `on` records menu
  // hooks — and the harvest is built above, with the error sink.
  const workspace = new Workspace({ events, harvest });

  // The assign-once step. `App` is a mutable container precisely so this can
  // happen after every surface exists; a plugin never sees the gap, because no
  // bundle has been loaded yet.
  assignOnce(app, "vault", vault);
  assignOnce(app, "metadataCache", metadataCache);
  assignOnce(app, "fileManager", fileManager);
  assignOnce(app, "workspace", workspace);
  // The cross-plugin registries. `plugins` holds nothing until a loader
  // registers one; `internalPlugins` starts its first config read in its
  // constructor, so `app.internalPlugins.ready()` is what a caller awaits
  // before the first synchronous `getPluginById`; `commands` seeds
  // `editor:save-file` and is the map `Plugin.addCommand` delegates into.
  assignOnce(app, "plugins", new PluginRegistry());
  assignOnce(app, "internalPlugins", new InternalPluginRegistry({ client, mirror, config }));
  assignOnce(
    app,
    "commands",
    new CommandRegistry({ queue, client, mirror, writes, workspace, errors, app }),
  );
  // The store behind `app.loadLocalStorage`, which is the same one the bare
  // `localStorage` global is backed by — one store, two addresses.
  assignOnce(app, "localStorageStore", globals.localStorage);

  // Everything a `Plugin` needs that its two constructor arguments cannot
  // carry. Installed against the `App`, keyed by it, so two hosts in one
  // process never read each other's wiring — see `shim/plugin.ts`.
  installPluginHost(app, { config, client, writes, harvest, events, queue, clock, errors });

  const assembled = {
    config,
    clock,
    client,
    mirror,
    events,
    queue,
    policyRecorder,
    app,
    writes,
    harvest,
    errors,
    globals,
    noticeLog,
  };
  // Last, and built from the assembly itself: the barrel binds this host's
  // clock into the timer functions a plugin calls, so a test advancing its own
  // clock sees its own plugin's intervals fire.
  const api = createObsidianApi(assembled);
  // And registered immediately, because this is the object the workspace's
  // `obsidian` package forwards every property read to. A bundle resolving the
  // specifier before this line would find nothing registered and be told so by
  // name; after it, it finds this host.
  registerObsidianApi(api);
  return {
    ...assembled,
    api,
    teardown(): void {
      clearObsidianApi();
      clearElectronStub();
      globals.restore();
    },
  };
}

/**
 * Obsidian's `app.appId`: sixteen hex characters, stable for a vault root.
 *
 * Derived rather than random because a plugin that keys per-vault storage by it
 * would find its data orphaned on every host restart otherwise.
 */
function appIdFor(vaultRoot: string): string {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let i = 0; i < vaultRoot.length; i += 1) {
    high = Math.imul(high ^ vaultRoot.charCodeAt(i), 0x01000193) >>> 0;
    low = Math.imul(low + vaultRoot.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

/**
 * Fill one container field, and refuse to fill it twice.
 *
 * The refusal is the point: "assigned once by `assembleShim`" is a claim the
 * whole mutable-container design rests on, and a second assembler run against a
 * live `App` — two hosts in one process, a harness that forgot to stop — would
 * otherwise leave plugins holding surfaces belonging to a vault that is no
 * longer there.
 */
function assignOnce<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  if (target[key] !== undefined) {
    throw new Error(`the shim's ${String(key)} was already assembled`);
  }
  target[key] = value;
}
