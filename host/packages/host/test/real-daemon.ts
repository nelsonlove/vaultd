import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { cleanupScratchRoots, scratchRoot } from "./scratch";

import { Mirror } from "../src/mirror/mirror";
import { Supervisor } from "../src/supervisor";
import type { GetVaultInfoResponse } from "../src/client/protocol";
import type { VaultdClient } from "../src/client/client";
import type { HostConfig } from "../src/config";
import type { SupervisorEvents } from "../src/supervisor";

/**
 * The shared scaffolding for every case that drives the **real** `vaultd`.
 *
 * It exists for one reason, and the reason is written in Task 5's report: when
 * three vitest workers indexed 200-note vaults at once, two real-daemon cases
 * timed out at 60 s *at daemon start* with no assertion failure, no daemon
 * stderr, and nothing having reached a page. `supervisor-real-daemon.test.ts`
 * had a `waitFor` that would have said what the supervisor thought was
 * happening; the mirror cases had a bare `await`, which says nothing at all.
 * Under load that is the difference between "the machine was busy" and an hour
 * of hunting.
 *
 * So the diagnosis lives here, once, and every real-daemon file starts its
 * engines through {@link startedOn}.
 *
 * The binary is a Rust build artifact and is not in the repository. Its absence
 * fails **`client-real-daemon.test.ts`** loudly — that file carries the
 * unconditional assertion plus the deliberate `VAULTD_ALLOW_MISSING_BINARY=1`
 * opt-out — and merely skips everywhere else, so the loud failure is stated
 * once. Build it with `cargo build --release --bin vaultd`.
 */
export const BINARY = resolve(__dirname, "..", "..", "..", "..", "target", "release", "vaultd");
export const BINARY_EXISTS = existsSync(BINARY);

/**
 * **Why every case in this suite but one pins `engine: "spawn"`.**
 *
 * `defaultHostConfig` says `engine: "auto"`, which is right for production and
 * wrong for a test: under `auto` a host probes `config.engineSocketPath` —
 * whose default is under the developer's own XDG run directory, outside
 * `target/tmp` — and spawns its daemon with `--listen` there. Three things
 * follow, and all three are wrong for a case that is about something else.
 * Sockets accumulate in a directory this suite does not sweep; a daemon with a
 * listener no longer ends when its stdin closes, which is the fact
 * `supervisor-real-daemon.test.ts` exists to pin; and two hosts over one vault
 * would find each other instead of meeting the writer lease, which is the fact
 * beside it.
 *
 * So every real-daemon config factory says `engine: "spawn"` — phase 6's road,
 * which is what those cases were written against — and the mode matrix lives
 * in `supervisor-engine-mode-real-daemon.test.ts`, the one file that binds an
 * engine socket, inside its own scratch root.
 */

/** A supervisor whose lifecycle callbacks say nothing. */
export const silentEvents: SupervisorEvents = {
  onClientReady: (): void => {},
  onEngineLost: (): void => {},
  onStateChange: (): void => {},
};

const running: Supervisor[] = [];

/**
 * A scratch directory that `cleanupRealDaemons` removes.
 *
 * Re-exported rather than defined here: every scratch directory in this suite
 * comes from one helper under `target/tmp` now, and `test/scratch.ts` says why.
 */
export { scratchRoot };

/** A supervisor registered for cleanup, not yet started. */
export function superviseOn(config: HostConfig, events: SupervisorEvents = silentEvents): Supervisor {
  const supervisor = new Supervisor(config, events);
  running.push(supervisor);
  return supervisor;
}

/**
 * Start an engine and wait for its runtime to reach `watching`.
 *
 * Both waits carry a watchdog that reports the supervisor's own view when it
 * fires — state, live state, last error, last exit — rather than letting vitest
 * print a bare timeout that names neither what was awaited nor why.
 */
export async function startedOn(
  config: HostConfig,
  events: SupervisorEvents = silentEvents,
): Promise<Supervisor> {
  const supervisor = superviseOn(config, events);
  const diagnose = (): string =>
    `The supervisor's own view: state=${supervisor.state()}, ` +
    `live_state=${String(supervisor.liveState())}, ` +
    `lastError=${supervisor.lastError()?.message ?? "none"}, ` +
    `lastExit=${JSON.stringify(supervisor.lastExit())}. ` +
    "The daemon's stderr is inherited by this process and printed above.";
  await diagnosed(supervisor.start(), "the engine to answer health", diagnose);
  await diagnosed(supervisor.whenWatching(), "the runtime to reach watching", diagnose);
  return supervisor;
}

/**
 * Resolve when `predicate` holds — a rendezvous on observable state, never a
 * sleep — and **say what was true instead** when it does not.
 *
 * A bare vitest timeout names neither what was awaited nor what the subject
 * thought was happening, which is how a real failure becomes "flaky" and then
 * invisible.
 */
export function waitFor(
  description: string,
  predicate: () => boolean,
  diagnose: () => string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((settle, reject) => {
    const check = (): void => {
      if (predicate()) {
        settle();
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(
            `timed out after ${String(timeoutMs)}ms waiting for ${description}. ${diagnose()}`,
          ),
        );
        return;
      }
      setImmediate(check);
    };
    check();
  });
}

/**
 * Hydrate a second mirror **at the same generation** the live one has applied
 * through, so the two are comparable.
 *
 * This is the oracle every drift case in this suite rests on: a mirror kept
 * current by deltas must equal a mirror hydrated from scratch, and the only
 * honest way to say "equal" is to compare two views of one generation.
 *
 * It is a rendezvous rather than a wait. Each turn is two real round trips —
 * ask the daemon where it is, wait for the live mirror to catch up, hydrate —
 * and it returns the instant the fresh mirror lands on the generation the live
 * one holds. A vault that is still moving simply takes another turn; nothing
 * here picks a duration and hopes, which is what makes it stable under a busy
 * machine as well as an idle one.
 *
 * `undefined` rather than a throw when the vault never goes quiet, so a caller
 * that is sampling — the fuzz — can skip a comparison the vault moved under,
 * and a caller that is asserting can fail on the `undefined`.
 */
export async function freshMirrorAt(
  live: Mirror,
  config: HostConfig,
  client: () => VaultdClient,
  turns = 20,
): Promise<Mirror | undefined> {
  for (let attempt = 0; attempt < turns; attempt += 1) {
    const info = await client().request<GetVaultInfoResponse>("get_vault_info");
    await waitFor(
      `the live mirror to apply through generation ${String(info.generation)}`,
      () => live.appliedThrough() >= info.generation && !live.resyncing(),
      () =>
        `the live mirror is at generation ${String(live.generation())}, applied through ` +
        `${String(live.appliedThrough())}, resyncing=${String(live.resyncing())}`,
      30_000,
    );
    const fresh = await Mirror.open(client, config);
    if (fresh.generation() === live.appliedThrough()) return fresh;
  }
  return undefined;
}

/** Race a promise against a watchdog that reports rather than merely expiring. */
export async function diagnosed<T>(
  pending: Promise<T>,
  description: string,
  diagnose: () => string,
  timeoutMs = 20_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_settle, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`timed out after ${String(timeoutMs)}ms waiting for ${description}. ${diagnose()}`),
      );
    }, timeoutMs);
    // Never the reason the process stays alive.
    timer.unref();
  });
  try {
    return await Promise.race([pending, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stop every supervisor and remove every scratch root. For `afterEach`. */
export async function cleanupRealDaemons(): Promise<void> {
  for (const supervisor of running.splice(0)) await supervisor.stop();
  cleanupScratchRoots();
}
