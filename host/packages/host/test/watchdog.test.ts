/**
 * The wedged-thread watchdog.
 *
 * **The asymmetry that shapes every case in this file.** The main side is on
 * the injected clock; the worker measures real time, because a watchdog driven
 * by the clock it is watching detects nothing. So *simulated* time can create a
 * stall (stop stamping, let real time pass) but it can never prevent one — and
 * a case that asserts "no report" after driving a `TestClock` asserts almost
 * nothing, because a few milliseconds of real time was never going to cross the
 * threshold anyway. Review round 1 proved that the hard way: three mutations
 * (the queue's stamping removed, `stop()` leaving the heartbeat armed,
 * `suspendHeartbeat()` as a no-op) all left this file green.
 *
 * So the cases below are built so that the mechanism under test is either the
 * **only thing keeping the loop healthy** across a real-time window longer than
 * the threshold, or the **only thing observed**:
 *
 * - the queue case runs on `systemClock()` with the heartbeat off, so the
 *   queue's `afterTask` stamp is the one thing standing between the loop and a
 *   report;
 * - the stall cases **advance** the `TestClock` through the stall window rather
 *   than `setNow`, so a `suspendHeartbeat()` that did not suspend would stamp
 *   and no report would come;
 * - `stop()` is observed through `clock.armed()` returning to zero.
 *
 * The fourth case blocks the loop for real, because "the mechanism works
 * against an actual synchronous wedge" is a claim only an actual synchronous
 * wedge can support — and even it waits on {@link Watchdog.awaitReports} rather
 * than on a timer, so it is bounded by the event under test.
 *
 * The report file goes under `scratchRoot` (dispatch ruling 1): scratch this
 * suite sweeps, rather than a file left behind under the OS temp directory for
 * nobody to remove.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { Watchdog, watchdogFor, watchdogWorkerPath } from "../src/runtime/watchdog";
import { DispatchQueue } from "../src/runtime/queue";
import { defaultHostConfig, systemClock } from "../src/config";
import { testClock } from "../src/testing/clock";
import { cleanupRealDaemons, scratchRoot } from "./real-daemon";

const reportPath = (): string => join(scratchRoot("vaultd-wd-"), "stalls.jsonl");

/** Thirty days, which is past the `2^31` ms ceiling an `Int32` stamp would have. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Every watchdog this file started, so `afterEach` and `afterAll` can prove each one stopped. */
const running: Watchdog[] = [];
const started: Watchdog[] = [];

const track = (watchdog: Watchdog): Watchdog => {
  running.push(watchdog);
  started.push(watchdog);
  return watchdog;
};

const start = (options: {
  thresholdMs: number;
  stampIntervalMs: number;
  reportPath: string;
}): { watchdog: Watchdog; clock: ReturnType<typeof testClock> } => {
  const clock = testClock();
  const watchdog = track(new Watchdog({ ...options, clock }));
  watchdog.start();
  return { watchdog, clock };
};

const linesIn = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];

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
    // (Weak on its own — see the note at the top of this file — and kept
    // because "the ordinary path writes nothing" is still worth stating.)
    await clock.advance(500);
    expect(watchdog.reports()).toEqual([]);
    expect(linesIn(path)).toEqual([]);
  });

  it("reports a stall when the heartbeat stops stamping", async () => {
    const path = reportPath();
    const { watchdog, clock } = start({ thresholdMs: 150, stampIntervalMs: 25, reportPath: path });
    await clock.advance(100); // healthy
    watchdog.suspendHeartbeat(); // exactly what a wedged loop looks like
    // The seam really suspended: nothing is left on the clock to stamp with.
    // Asserted here rather than inferred from the report, because a *frozen*
    // simulated clock eventually looks stalled to the worker whether the
    // heartbeat is armed or not — so the report alone cannot tell the two
    // apart, and this can.
    expect(clock.armed()).toBe(0);
    // **`advance`, not `setNow`.** Six hundred milliseconds of simulated time
    // pass *through* the heartbeat's cadence: a suspend that did not suspend
    // would fire twenty-four stamps here, the stamp would race ahead of real
    // time, and no report would ever come. That is what makes this case fail
    // when `suspendHeartbeat()` is a no-op.
    await clock.advance(600);
    const [report] = await watchdog.awaitReports(1);
    expect(report?.stalledForMs).toBeGreaterThanOrEqual(150);
    expect(report?.lastStampUnixMs).toBeLessThan(report?.detectedAtUnixMs ?? 0);
    const lines = linesIn(path);
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
    await clock.advance(600);
    await watchdog.awaitReports(1);
    watchdog.resumeHeartbeat();
    expect(clock.armed()).toBe(1);
    const after = watchdog.reports().length;
    await clock.advance(1_000); // healthy again
    expect(watchdog.reports().length).toBe(after);
  });

  it("reports a genuinely wedged main thread once, and interrupts nothing", async () => {
    // The one case that must use the real clock. A synchronous wedge is the
    // failure this component exists to catch, and only a real wedge proves the
    // SharedArrayBuffer path survives a blocked event loop. It still waits on
    // `awaitReports` rather than on a sleep, so it is bounded by the event
    // under test instead of by a guessed duration.
    const path = reportPath();
    const watchdog = track(
      new Watchdog({
        thresholdMs: 100,
        stampIntervalMs: 25,
        reportPath: path,
        clock: systemClock(),
      }),
    );
    watchdog.start();
    let total = 0;
    const until = Date.now() + 400;
    while (Date.now() < until) total += 1; // deliberately wedge the loop
    const [report] = await watchdog.awaitReports(1);
    expect(report?.stalledForMs).toBeGreaterThanOrEqual(100);
    expect(total).toBeGreaterThan(0); // report-only: the work finished
    // **One line per stall episode, not one per poll.** The wedge lasted four
    // thresholds; the latch in the worker re-arms only on a fresh stamp, so a
    // long wedge is one report and one line — which is what makes the next real
    // stall findable in this file.
    expect(watchdog.reports()).toHaveLength(1);
    expect(linesIn(path)).toHaveLength(1);
  });

  it("stays healthy on the queue's stamps alone, with the heartbeat off", async () => {
    // **Dispatch ruling 4, pinned against real time.** A host saturated with
    // plugin work services no interval, so the heartbeat is off for the whole
    // window here and the queue's `afterTask` stamp is the only thing between
    // this loop and a stall report. The window is four thresholds of *real*
    // time, so removing the hook turns this case red rather than leaving it
    // green — which is exactly what the first round of this file did.
    const path = reportPath();
    const watchdog = track(
      new Watchdog({
        thresholdMs: 100,
        stampIntervalMs: 25,
        reportPath: path,
        clock: systemClock(),
      }),
    );
    watchdog.start();
    const queue = new DispatchQueue({
      afterTask: () => {
        watchdog.stamp();
      },
    });
    watchdog.suspendHeartbeat();
    let tasks = 0;
    const until = Date.now() + 400;
    while (Date.now() < until) {
      await queue.run("busy", `task-${String(tasks)}`, () => (tasks += 1));
    }
    // The loop really ran, so "no report" is a fact about a busy host rather
    // than about a host that did nothing.
    expect(tasks).toBeGreaterThan(10);
    expect(watchdog.reports()).toEqual([]);
    expect(linesIn(path)).toEqual([]);
  });

  it("disarms the heartbeat and joins the worker when it stops", async () => {
    // `stop()`'s two halves, observed rather than assumed. Without the
    // heartbeat clear the interval stays armed — `unref()`ed under the system
    // clock, so a process still exits, but stamping into a buffer whose reader
    // is gone for the life of the host, and piling up on a harness's clock.
    const path = reportPath();
    const clock = testClock();
    const watchdog = new Watchdog({
      thresholdMs: 150,
      stampIntervalMs: 25,
      reportPath: path,
      clock,
    });
    // `started` and not `running`: this case stops it itself, which is the
    // subject, and `afterEach`'s stop would be a second one.
    started.push(watchdog);
    watchdog.start();
    expect(clock.armed()).toBe(1);
    expect(watchdog.exited()).toBe(false);
    await watchdog.stop();
    expect(clock.armed()).toBe(0);
    expect(watchdog.exited()).toBe(true);
  });

  it("is still healthy after a month of uptime, past the 2^31 ms ceiling", async () => {
    // **The blocking defect of review round 1.** The stamp is elapsed
    // milliseconds; in an `Int32` slot it wraps negative at 24.855 days, and
    // every poll after that computes a stall of ~4.29e9 ms — one line per
    // stamp, for ever, about a host that is fine. A daemon is exactly the thing
    // that runs for a month.
    //
    // `simulatedUptimeMs` moves both bases together, so this is a host that has
    // been up thirty days rather than a stall thirty days long.
    const path = reportPath();
    const clock = testClock();
    const watchdog = track(
      new Watchdog({
        thresholdMs: 150,
        stampIntervalMs: 25,
        reportPath: path,
        clock,
        simulatedUptimeMs: THIRTY_DAYS_MS,
      }),
    );
    watchdog.start();
    // A month in, still stamping: healthy.
    await clock.advance(200);
    expect(watchdog.reports()).toEqual([]);
    // **The proof is the number, not the silence.** Stop stamping and let the
    // worker catch a real stall on the far side of the ceiling: a 64-bit stamp
    // reports the few hundred milliseconds that really passed, and a wrapped
    // one reports about 4.29e9.
    watchdog.suspendHeartbeat();
    await clock.advance(600);
    const [report] = await watchdog.awaitReports(1);
    expect(report?.stalledForMs).toBeGreaterThanOrEqual(150);
    expect(report?.stalledForMs).toBeLessThan(10_000);
    expect(report?.lastStampUnixMs).toBeLessThan(report?.detectedAtUnixMs ?? 0);
  });

  it("rotates the report file when it reaches its cap", async () => {
    // A stall log is read after the fact, so the recent lines are the ones that
    // answer the question — and an unbounded file in the data directory is a
    // slow leak. One generation is kept; the one before it is gone.
    const path = reportPath();
    writeFileSync(path, `${"x".repeat(400)}\n`);
    const clock = testClock();
    const watchdog = track(
      new Watchdog({
        thresholdMs: 150,
        stampIntervalMs: 25,
        reportPath: path,
        clock,
        rotateBytes: 256,
      }),
    );
    watchdog.start();
    watchdog.suspendHeartbeat();
    await clock.advance(600);
    await watchdog.awaitReports(1);
    // The fresh file holds this stall and nothing else…
    expect(linesIn(path)).toHaveLength(1);
    // …and what was there is beside it, once.
    expect(readFileSync(`${path}.1`, "utf8")).toContain("xxxx");
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

  it("stays inside whatever this package publishes", () => {
    // There is no `files` allowlist today, so ruling 2's conditional clause is
    // vacuous — but it is a fragile silence: the day one appears, `worker/` is
    // the one directory that must be in it, or the published host spawns a
    // worker that is not there. This case is where that gets said.
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
    ) as { files?: readonly string[] };
    if (manifest.files !== undefined) {
      expect(manifest.files.some((entry) => entry.startsWith("worker"))).toBe(true);
    }
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
    track(built);
    // Not started: the assembler builds it, the host lifecycle starts it — and
    // a factory that spawned a thread would spawn one in every harness that
    // merely assembled a host.
    expect(built.exited()).toBe(true);
    await built.stop();
  });
});
