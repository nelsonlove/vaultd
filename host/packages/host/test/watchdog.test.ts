/**
 * The wedged-thread watchdog.
 *
 * **Three of the four cases drive the heartbeat through the injected clock and
 * never sleep; the fourth blocks the loop for real**, because "the mechanism
 * works against an actual synchronous wedge" is a claim only an actual
 * synchronous wedge can support — and even it waits on {@link
 * Watchdog.awaitReports} rather than on a timer, so it is bounded by the event
 * under test instead of by a guessed duration.
 *
 * **What "no wall-clock dependency" means here, stated honestly.** The main
 * side is entirely on the injected clock: a stall is simulated by advancing
 * `TestClock` past the threshold without stamping, which is exactly what a
 * wedged loop looks like from the worker's side of the shared buffer. The
 * *detection* still costs real milliseconds, because the worker owns one real
 * `Atomics.wait` loop — a watchdog driven by the clock it is watching detects
 * nothing. Every wait below is a rendezvous on the worker's own report rather
 * than a deadline, so a slow machine is slower here and never redder.
 *
 * The report file goes under `scratchRoot` (dispatch ruling 1), never
 * `os.tmpdir()` directly: scratch in this repository is swept, and a watchdog
 * writing into the developer's temp directory is a file nobody removes.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { Watchdog, watchdogFor, watchdogWorkerPath } from "../src/runtime/watchdog";
import { DispatchQueue } from "../src/runtime/queue";
import { defaultHostConfig, systemClock } from "../src/config";
import { testClock } from "../src/testing/clock";
import { cleanupRealDaemons, scratchRoot } from "./real-daemon";

const reportPath = (): string => join(scratchRoot("vaultd-wd-"), "stalls.jsonl");

/** Every watchdog this file started, so `afterEach` can prove each one stopped. */
const running: Watchdog[] = [];
const started: Watchdog[] = [];

const start = (options: {
  thresholdMs: number;
  stampIntervalMs: number;
  reportPath: string;
}): { watchdog: Watchdog; clock: ReturnType<typeof testClock> } => {
  const clock = testClock();
  const watchdog = new Watchdog({ ...options, clock });
  running.push(watchdog);
  started.push(watchdog);
  watchdog.start();
  return { watchdog, clock };
};

afterEach(async () => {
  while (running.length) await running.pop()?.stop();
  await cleanupRealDaemons();
});

afterAll(() => {
  // **No thread outlives this file.** The per-instance half is the real one:
  // `stop()` terminates the worker and awaits its `exit`, so a watchdog that
  // says it exited has been joined. The process-level half is a backstop and is
  // weaker than it looks — `getActiveResourcesInfo()` reports what is *keeping
  // the loop alive*, and these workers are `unref()`ed on purpose — so it
  // catches a leaked ref'd worker and nothing else. Both are asserted rather
  // than one, because they fail for different reasons.
  expect(started.filter((watchdog) => !watchdog.exited())).toEqual([]);
  expect(process.getActiveResourcesInfo().filter((kind) => kind === "Worker")).toEqual([]);
});

describe("Watchdog", () => {
  it("writes nothing while the heartbeat keeps stamping", async () => {
    const path = reportPath();
    const { watchdog, clock } = start({ thresholdMs: 150, stampIntervalMs: 25, reportPath: path });
    // Twenty stamps at 25 ms: 500 ms of simulated healthy operation in no
    // wall-clock time at all, because the heartbeat runs on the injected clock.
    await clock.advance(500);
    expect(watchdog.reports()).toEqual([]);
    expect(existsSync(path) ? readFileSync(path, "utf8").trim() : "").toBe("");
  });

  it("reports a stall when the heartbeat stops stamping", async () => {
    const path = reportPath();
    const { watchdog, clock } = start({ thresholdMs: 150, stampIntervalMs: 25, reportPath: path });
    await clock.advance(100); // healthy
    watchdog.suspendHeartbeat(); // exactly what a wedged loop looks like
    clock.setNow(clock.now() + 600); // time passes, no stamp lands
    const [report] = await watchdog.awaitReports(1);
    expect(report?.stalledForMs).toBeGreaterThanOrEqual(150);
    expect(report?.lastStampUnixMs).toBeLessThan(report?.detectedAtUnixMs ?? 0);
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // `toMatchObject({ stalledForMs: expect.any(Number) })` is the same claim,
    // and it is the one the brief wrote — but `expect.any` is typed `any`, and
    // this tree lints `no-unsafe-assignment` with type information. Spelled out
    // instead, which asserts exactly as much.
    const first = JSON.parse(lines[0] ?? "") as { stalledForMs?: unknown };
    expect(typeof first.stalledForMs).toBe("number");
  });

  it("stops reporting once the heartbeat resumes", async () => {
    const path = reportPath();
    const { watchdog, clock } = start({ thresholdMs: 150, stampIntervalMs: 25, reportPath: path });
    watchdog.suspendHeartbeat();
    clock.setNow(clock.now() + 600);
    await watchdog.awaitReports(1);
    watchdog.resumeHeartbeat();
    const after = watchdog.reports().length;
    await clock.advance(1_000); // healthy again
    expect(watchdog.reports().length).toBe(after);
  });

  it("reports a genuinely wedged main thread, and interrupts nothing", async () => {
    // The one case that must use the real clock. A synchronous wedge is the
    // failure this component exists to catch, and only a real wedge proves the
    // SharedArrayBuffer path survives a blocked event loop. It still waits on
    // `awaitReports` rather than on a sleep, so it is bounded by the event
    // under test instead of by a guessed duration.
    const path = reportPath();
    const watchdog = new Watchdog({
      thresholdMs: 100,
      stampIntervalMs: 25,
      reportPath: path,
      clock: systemClock(),
    });
    running.push(watchdog);
    started.push(watchdog);
    watchdog.start();
    let total = 0;
    const until = Date.now() + 400;
    while (Date.now() < until) total += 1; // deliberately wedge the loop
    const [report] = await watchdog.awaitReports(1);
    expect(report?.stalledForMs).toBeGreaterThanOrEqual(100);
    expect(total).toBeGreaterThan(0); // report-only: the work finished
  });

  it("stamps from the dispatch queue between tasks, so a busy loop is not a wedged one", async () => {
    // Dispatch ruling 4: the queue stamps through a hook it is handed, never a
    // hard import of the watchdog. A host whose loop is saturated with plugin
    // work services no interval — the heartbeat included — so without this the
    // busiest healthy host in the fleet would be the one that reported itself
    // wedged.
    const path = reportPath();
    const clock = testClock();
    const watchdog = new Watchdog({
      thresholdMs: 150,
      stampIntervalMs: 25,
      reportPath: path,
      clock,
    });
    running.push(watchdog);
    started.push(watchdog);
    watchdog.start();
    const queue = new DispatchQueue({
      afterTask: () => {
        watchdog.stamp();
      },
    });
    // The heartbeat is suspended for the whole of this: the only thing stamping
    // is the queue, which is the claim.
    watchdog.suspendHeartbeat();
    for (let i = 0; i < 20; i += 1) {
      clock.setNow(clock.now() + 25);
      await queue.run("busy", `task-${String(i)}`, () => i);
    }
    expect(watchdog.reports()).toEqual([]);
    expect(existsSync(path) ? readFileSync(path, "utf8").trim() : "").toBe("");
  });
});

describe("where the worker file lives", () => {
  it("resolves the same worker file from src and from the compiled dist", async () => {
    // Dispatch ruling 2: the package compiles `src/` only, so a plain `.js`
    // worker under `src/` would never reach `dist/`. It lives outside both, at
    // the same depth from `src/runtime/` and from `dist/runtime/` — and the
    // only honest proof of "the same depth" is to ask the built module.
    const fromSrc = watchdogWorkerPath();
    expect(existsSync(fromSrc)).toBe(true);
    const built = resolve(__dirname, "..", "dist", "runtime", "watchdog.js");
    expect(
      existsSync(built),
      `${built} is missing: run \`npm --prefix host run build\` (npm test does this for you)`,
    ).toBe(true);
    const compiled = (await import(built)) as { watchdogWorkerPath: () => string };
    expect(compiled.watchdogWorkerPath()).toBe(fromSrc);
    expect(existsSync(compiled.watchdogWorkerPath())).toBe(true);
  });
});

describe("what the configuration decides", () => {
  it("builds a watchdog only when the threshold is positive", async () => {
    const config = defaultHostConfig("/vault");
    expect(config.watchdogThresholdMs).toBe(30_000);
    expect(watchdogFor({ ...config, watchdogThresholdMs: 0 }, scratchRoot("vaultd-wd-"))).toBeNull();
    const built = watchdogFor(
      { ...config, watchdogThresholdMs: 1_000, clock: testClock() },
      scratchRoot("vaultd-wd-"),
    );
    expect(built).not.toBeNull();
    if (built === null) return;
    started.push(built);
    running.push(built);
    // Not started: the assembler builds it, the host lifecycle starts it — and
    // a factory that spawned a thread would spawn one in every harness that
    // merely assembled a host.
    expect(built.exited()).toBe(true);
    await built.stop();
  });
});
