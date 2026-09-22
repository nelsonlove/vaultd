"use strict";

/**
 * The watchdog's worker thread: the one part of this host that is allowed to be
 * slow, because it is the only part that is still running when the rest is not.
 *
 * **Why this file is plain CommonJS JavaScript and lives outside `src/`.** The
 * package compiles `src/` only (`tsconfig.json` `include: ["src"]`), so a `.js`
 * file under `src/` would never reach `dist/` and a host started from `dist/`
 * would spawn a worker that is not there. It sits beside both instead, at the
 * same depth from `src/runtime/` and from `dist/runtime/`, so
 * `../../worker/watchdog-worker.js` resolves to this file either way.
 * `runtime/watchdog.ts` holds the pin for that, and `test/watchdog.test.ts`
 * asserts it from the built module as well as from the source.
 *
 * **This is the second file in this host permitted to name `node:fs`**, and the
 * reason is the whole design: the main thread is the thing that is wedged, so
 * the report has to be written by a thread that is not. It cannot reach the
 * host's fs seam — that seam is TypeScript under `src/`, in another thread, and
 * behind the CommonJS door the write guard patches for the *main* thread — so
 * it names the module itself. `test/fs-seam.test.ts` names this file as the one
 * other permitted namer, on purpose rather than by accident.
 *
 * **The one real timer this plan admits.** Everything else in this host takes
 * its time from `config.clock`; a watchdog driven by the clock it is watching
 * detects nothing, because a wedged main thread services no timer the main
 * thread would have to service. So this loop owns a real
 * `Atomics.wait(view, STAMP, seen, pollMs)`, which is a blocking wait with a
 * timeout and costs no CPU between wakes — and it wakes early, without waiting
 * out the poll, whenever the main side stamps and notifies.
 *
 * **Both sides measure elapsed time in their own base, and that is what makes
 * an injected clock testable.** The main side stores `clock.now() - epoch` —
 * milliseconds of *its* time since the watchdog started. This thread measures
 * milliseconds of *real* time since it booted. The difference between the two
 * is the stall: a main loop keeping up has stored at least as many milliseconds
 * as have really passed, and a main loop that has stopped stamping falls behind
 * real time at one millisecond per millisecond. A test that advances a
 * `TestClock` past the threshold without stamping therefore looks exactly like
 * a wedge from this side of the buffer, which is the point.
 *
 * Report-only. Nothing here interrupts, kills, or signals the main thread: it
 * appends one JSON line per stall and posts the same object back, which the
 * main side receives if and when it is alive to hear it.
 */

const fs = require("node:fs");
const { dirname } = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");

/** Milliseconds of the main side's clock since the watchdog started. */
const STAMP = 0;
/** Non-zero once the main side has asked this thread to finish. */
const STOP = 1;

const options = workerData;
/**
 * **64-bit slots.** An `Int32` stamp of elapsed milliseconds wraps negative
 * after 24.855 days of uptime, and every poll after that reports a stall of
 * about 4.29e9 ms — one line per stamp, for ever, about a host that is fine.
 * See the note in `runtime/watchdog.ts`. `Atomics.wait` works on a
 * `BigInt64Array`, so the loop below is otherwise unchanged.
 */
const view = new BigInt64Array(options.buffer);
const thresholdMs = BigInt(options.thresholdMs);
const pollMs = options.pollMs;
const reportPath = options.reportPath;
const rotateBytes = options.rotateBytes;

/**
 * This thread's own zero, and how long the main side had already been up when
 * this thread booted.
 *
 * The offset is zero in every real host: a watchdog's worker starts with its
 * watchdog. A test that needs a host which has been up for a month hands both
 * sides the same number, so the two bases still measure the same interval.
 */
const epoch = Date.now();
const uptimeMs = BigInt(options.uptimeMs === undefined ? 0 : options.uptimeMs);

fs.mkdirSync(dirname(reportPath), { recursive: true });

/**
 * Append one line, rotating first if the file has reached its cap.
 *
 * One generation, and the rename is what makes it cheap: no copy, no read, and
 * the file this thread then appends to is empty. A cap of `0` keeps the file
 * unbounded, which nothing in this host asks for.
 */
function appendReport(line) {
  if (rotateBytes > 0 && fs.existsSync(reportPath) && fs.statSync(reportPath).size >= rotateBytes) {
    fs.renameSync(reportPath, `${reportPath}.1`);
  }
  fs.appendFileSync(reportPath, line);
}

/**
 * At most one report per stall.
 *
 * Re-armed only by a *fresh stamp*, so a loop wedged for an hour produces one
 * line rather than one line per poll — and a loop that recovers and wedges
 * again produces a second, which is the distinction a reader cares about.
 */
let reported = false;
let seen = Atomics.load(view, STAMP);

for (;;) {
  if (Atomics.load(view, STOP) !== 0n) break;
  const stamp = Atomics.load(view, STAMP);
  if (stamp !== seen) {
    seen = stamp;
    reported = false;
  }
  const detectedAtUnixMs = Date.now();
  const stalled = BigInt(detectedAtUnixMs - epoch) + uptimeMs - stamp;
  if (!reported && stalled >= thresholdMs) {
    reported = true;
    const stalledForMs = Number(stalled);
    const report = {
      stalledForMs,
      // Derived from the stall rather than from the stamp, so it is the wall
      // clock moment of the last stamp whatever base the stamp was measured in.
      lastStampUnixMs: detectedAtUnixMs - stalledForMs,
      detectedAtUnixMs,
    };
    // The file first, then the message. The file is the half that survives a
    // main thread which never comes back; the message is the half a live host
    // can act on. Ordering them this way means a host that dies between the two
    // has still left the record.
    appendReport(`${JSON.stringify(report)}\n`);
    if (parentPort !== null) parentPort.postMessage(report);
  }
  // Wakes early on a stamp — the main side notifies after every store — and
  // otherwise after `pollMs`, so detection costs at most one poll beyond the
  // threshold. `not-equal` returns immediately when a stamp landed between the
  // load above and this call, which is a re-arm rather than a missed one.
  Atomics.wait(view, STAMP, stamp, pollMs);
}

if (parentPort !== null) parentPort.close();
