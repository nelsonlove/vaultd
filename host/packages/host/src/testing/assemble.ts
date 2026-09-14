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
import { FileManager } from "../shim/file-manager";
import { ShimEventBus } from "../shim/events";
import { MetadataCache } from "../shim/metadata-cache";
import { DispatchQueue } from "../runtime/queue";
import { setPolicyRecorder } from "../shim/policy";
import { Vault } from "../shim/vault";
import { Harvest } from "../shim/harvest";
import { Workspace } from "../shim/workspace";
import { createObsidianApi } from "../shim/api";
import { installPluginHost } from "../shim/plugin";
import type { VaultdClient } from "../client/client";
import type { Clock, HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { ObsidianApi } from "../shim/api";
import type { ApiPolicy, PolicyRecorder } from "../shim/policy";
import type { WriteGate } from "../shim/vault";
// activated by Task 13:  import { registerElectronStub } from "../runtime/electron-registry";
// activated by Task 11b: import { NoticeLog } from "../shim/notice";
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
  // activated by Task 11b: readonly noticeLog: NoticeLog;
  /**
   * The module object a plugin bundle resolves `obsidian` to.
   *
   * Bound minimally in Task 10 — it is that task's tests that first write
   * `class extends api.Plugin` — and filled in by Task 11b's policy-driven
   * walk. It is last in the assembly because it names every surface above it.
   */
  readonly api: ObsidianApi;
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
  writes?: WriteGate;
  policyRecorder?: PolicyRecorder;
}): HostAssembly {
  const { config, client, mirror, clock } = deps;
  // activated by Task 13: registerElectronStub(...). It is registered *first*,
  // before anything that could load a plugin bundle, because a bundle that
  // resolves `electron` before the stub is in place gets the real module or a
  // throw — and either way the failure surfaces far from its cause.

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
  const app = new App({ appId: appIdFor(config.vaultRoot) });
  const vault = new Vault({ config, client, mirror, events, writes, queue });
  // After the vault, because it resolves link paths to the `TFile` instances
  // the vault's index owns — and it reads that index rather than holding a
  // copy, so a file the vault renames is the same object this answers with.
  const metadataCache = new MetadataCache({ mirror, events, index: vault.index });
  // Third, because it reads both of the others: the vault's index for the files
  // it moves and the metadata cache's resolver for the links it composes.
  const fileManager = new FileManager({ mirror, vault, metadataCache, writes, queue });
  // activated by Task 11b: const noticeLog = new NoticeLog({ clock });
  // The harvest holds nothing but its own rows, so it is built before the
  // surfaces that write into it. The workspace needs it at construction — its
  // `on` records menu hooks — which is why it comes first of the two.
  const harvest = new Harvest();
  const workspace = new Workspace({ events, harvest });

  // The assign-once step. `App` is a mutable container precisely so this can
  // happen after every surface exists; a plugin never sees the gap, because no
  // bundle has been loaded yet.
  assignOnce(app, "vault", vault);
  assignOnce(app, "metadataCache", metadataCache);
  assignOnce(app, "fileManager", fileManager);
  assignOnce(app, "workspace", workspace);

  // Everything a `Plugin` needs that its two constructor arguments cannot
  // carry. Installed against the `App`, keyed by it, so two hosts in one
  // process never read each other's wiring — see `shim/plugin.ts`.
  installPluginHost(app, { config, client, writes, harvest, events, queue, clock });

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
  };
  // Last, and built from the assembly itself: the barrel binds this host's
  // clock into the timer functions a plugin calls, so a test advancing its own
  // clock sees its own plugin's intervals fire.
  return { ...assembled, api: createObsidianApi(assembled) };
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
