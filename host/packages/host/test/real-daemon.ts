import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Supervisor } from "../src/supervisor";
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

/** A supervisor whose lifecycle callbacks say nothing. */
export const silentEvents: SupervisorEvents = {
  onClientReady: (): void => {},
  onEngineLost: (): void => {},
  onStateChange: (): void => {},
};

const roots: string[] = [];
const running: Supervisor[] = [];

/** A scratch directory that `cleanupRealDaemons` removes. */
export function scratchRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
