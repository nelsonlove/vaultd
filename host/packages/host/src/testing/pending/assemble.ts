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
 * this with {@link systemClock} and the real {@link WriteGate}.
 */

import { registerElectronStub } from "../runtime/electron-registry";
import { App } from "../shim/app";
import { ShimEventBus } from "../shim/events";
import { ObsidianApi } from "../shim/api";
import { DispatchQueue } from "../shim/dispatch-queue";
import { Harvest } from "../shim/harvest";
import { NoticeLog } from "../shim/notice-log";
import { PolicyRecorder } from "../shim/policy-recorder";
import { Vault } from "../shim/vault";
import { WriteGate } from "../shim/write-gate";
import type { VaultdClient } from "../client/client";
import type { Clock, HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";

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
 * Build the shim, in the one order that works.
 *
 * The electron stub is registered **first**, before anything that could load a
 * plugin bundle: a bundle that resolves `electron` before the stub is in place
 * gets the real module or a throw, and either way the failure surfaces far from
 * its cause.
 */
export function assembleShim(deps: {
  config: HostConfig;
  client: VaultdClient;
  mirror: Mirror;
  clock: Clock;
}): HostAssembly {
  const { config, client, mirror, clock } = deps;
  registerElectronStub();

  // Nothing below observes anything but its own arguments during construction,
  // which is what lets a cycle be wired at all: the vault holds the event bus,
  // the bus holds nobody, and every cross-surface read happens later, from a
  // method.
  const events = new ShimEventBus();
  const noticeLog = new NoticeLog({ clock });
  const policyRecorder = new PolicyRecorder({ clock });
  const harvest = new Harvest();
  const queue = new DispatchQueue({ clock });
  const writes = new WriteGate({ config, client, mirror });
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
