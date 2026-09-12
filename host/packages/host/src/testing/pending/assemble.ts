/**
 * One factory, one wiring order — for the harnesses and for production alike.
 *
 * **Not yet activated.** This file is written for `src/testing/assemble.ts` and
 * lives in `pending/` until Task 7, which builds the first shim surface it
 * refers to. Its imports are spelled for its activated home, which is why
 * `./daemon-harness` and `../shim/vault` are how they read here. Task 7's Step 1
 * moves it and `shim-harness.ts` up one directory in one motion:
 *
 * ```
 * git mv src/testing/pending/assemble.ts src/testing/assemble.ts
 * git mv src/testing/pending/shim-harness.ts src/testing/shim-harness.ts
 * ```
 *
 * and drops the `src/testing/pending` line from `tsconfig.json`'s and
 * `vitest.config.ts`'s excludes only when the last file leaves (Task 22).
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

import { registerElectronStub } from "../runtime/electron-registry";
import { App } from "../shim/app";
import { ShimEventBus } from "../shim/events";
import { ObsidianApi } from "../shim/api";
import { DispatchQueue } from "../runtime/queue";
import { Harvest } from "../shim/harvest";
import { NoticeLog } from "../shim/notice";
import { Vault } from "../shim/vault";
import type { VaultdClient } from "../client/client";
import type { Clock, HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { ApiPolicy, PolicyRecorder } from "../shim/policy";
import type { WriteGate } from "../dryrun/dry-run";

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
  readonly harvest: Harvest;
  readonly policyRecorder: PolicyRecorder;
  readonly noticeLog: NoticeLog;
  readonly app: App;
  /** The Task 11b barrel: the module object a plugin bundle resolves to. */
  readonly api: ObsidianApi;
  readonly writes: WriteGate;
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
  registerElectronStub();

  // Nothing below observes anything but its own arguments during construction,
  // which is what lets a cycle be wired at all: the vault holds the event bus,
  // the bus holds nobody, and every cross-surface read happens later, from a
  // method.
  const events = new ShimEventBus();
  const noticeLog = new NoticeLog({ clock });
  const policyRecorder = deps.policyRecorder ?? memoryPolicyRecorder();
  const harvest = new Harvest();
  const queue = new DispatchQueue({ clock });
  const writes = deps.writes ?? forwardingWriteGate(client);
  const app = new App({ appId: appIdFor(config.vaultRoot) });
  const vault = new Vault({ app, config, mirror, events, writes, clock });
  const api = new ObsidianApi({ app, config, harvest, noticeLog, policyRecorder, queue, clock });

  // The assign-once step. `App` is a mutable container precisely so this can
  // happen after every surface exists; a plugin never sees the gap, because no
  // bundle has been loaded yet.
  assignOnce(app, "vault", vault);

  return {
    config,
    clock,
    client,
    mirror,
    events,
    queue,
    harvest,
    policyRecorder,
    noticeLog,
    app,
    api,
    writes,
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
