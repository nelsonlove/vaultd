/**
 * What the mirror does when the engine is **not there** — the half of Task
 * 22a's second blocker that had no deterministic pin.
 *
 * The defect these cases exist for: `Supervisor.client()` throws a bare
 * `Error("no engine is running")` in the window between an engine dying and its
 * replacement being ready. A refetch in flight at that moment rejected with
 * something no layer recognised, on a promise the caller had deliberately
 * dropped — and Node's answer to a rejection nobody holds is to kill the
 * process. It made the golden suite exit non-zero in half its runs while every
 * test reported passed.
 *
 * Three properties, each its own case, and none of them needs a daemon to die
 * for real: a **throwing client supplier** is exactly what a replaced engine
 * looks like from inside the mirror.
 *
 * 1. An absent engine is converted to the typed {@link EngineLostError} and
 *    takes the `runtime_recovered` resync road — the same road the supervisor's
 *    own synthesized marker uses.
 * 2. A refetch whose caller dropped the promise -- a write made by a plugin
 *    that dropped its own -- is reported rather than lost.
 * 3. `stop()` closes the queue: an application enqueued afterwards resolves
 *    without running and sends nothing, so a late delta arriving during a
 *    teardown is ignored rather than fatal.
 */

import { afterEach, describe, expect, it } from "vitest";

import { DaemonHarness } from "../src/testing/daemon-harness";
import { DispatchQueue } from "../src/runtime/queue";
import { EngineLostError } from "../src/supervisor";
import { Mirror } from "../src/mirror/mirror";
import { ShimEventBus } from "../src/shim/events";
import { Vault } from "../src/shim/vault";
import { answerHydrationOn } from "../src/testing/mirror-harness";
import { forwardingWriteGate } from "../src/testing/assemble";
import type { RuntimeEventDto } from "../src/client/protocol";

const harnesses: DaemonHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
});

/** A hydrated mirror whose client supplier this case can take away. */
async function mirrorOverSwitchableEngine(): Promise<{
  mirror: Mirror;
  harness: DaemonHarness;
  /** Make the supplier throw the way `Supervisor.client()` does with no engine. */
  readonly loseEngine: () => void;
  /** The supervisor brought a replacement up. */
  readonly regainEngine: () => void;
}> {
  const harness = DaemonHarness.create();
  harnesses.push(harness);
  let live = true;
  const opening = Mirror.open(() => {
    // **The bare error, verbatim.** `Supervisor.client()` throws exactly this
    // and the conversion under test is what turns it into something the host
    // knows. A typed error here would test the conversion against itself.
    if (!live) throw new Error("no engine is running");
    return harness.client;
  }, harness.config);
  await answerHydrationOn(harness, {
    generation: 5,
    entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
    notes: [{ path: "A.md", revision: "blake3:a1" }],
  });
  const mirror = await opening;
  harness.clearMethodLog();
  return {
    mirror,
    harness,
    loseEngine: () => {
      live = false;
    },
    regainEngine: () => {
      live = true;
    },
  };
}

function committed(generation: number, modified: string[]): RuntimeEventDto {
  return {
    type: "generation_committed",
    value: {
      previous_generation: generation - 1,
      generation,
      cause: "watcher",
      changes: { kind: "detailed", created: [], modified, deleted: [] },
      affected_note_count: modified.length,
      affected_reference_count: 0,
    },
  };
}

/** Collect every rejection nobody held, for the life of one case. */
async function withUnhandledWatch<T>(body: () => Promise<T>): Promise<{ value: T; unhandled: string[] }> {
  const seen: string[] = [];
  const record = (reason: unknown): void => {
    seen.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", record);
  try {
    const value = await body();
    // Two turns: a rejection is reported at the end of the turn it happened in,
    // and the mirror's own last-resort report is deferred by one `setImmediate`.
    await new Promise<void>((settle) => setImmediate(settle));
    await new Promise<void>((settle) => setImmediate(settle));
    return { value, unhandled: seen };
  } finally {
    process.off("unhandledRejection", record);
  }
}

describe("the mirror when the engine is gone", () => {
  it("turns an absent engine into the runtime_recovered resync road, not a rejection", async () => {
    const { mirror, harness, loseEngine, regainEngine } = await mirrorOverSwitchableEngine();
    const reported: string[] = [];
    mirror.onApplyError((error) => {
      reported.push(error instanceof Error ? error.message : String(error));
    });

    loseEngine();
    // A delta that needs a refetch, applied while there is no engine to ask.
    // **It resolves.** The conversion in `Mirror.client()` raises the typed
    // `EngineLostError`, and `applyChangeSet` has always read that as "a
    // `runtime_recovered` marker is on its way, nothing here is worth failing a
    // subscription fan-out over" — so the delta is abandoned quietly. Before
    // the conversion the supplier's bare `Error` fell past that branch and
    // became a rejection on a promise the subscription had dropped, which is
    // the defect. This assertion is the difference.
    await expect(mirror.applyEvent(committed(6, ["A.md"]))).resolves.toBeUndefined();
    // Nothing was sent: the supplier threw before a request could be written.
    expect(harness.methodsSeen()).toEqual([]);
    // **The road, asserted.** `markResync` ran, so the mirror knows generation
    // 6's paths are stale and is waiting to be re-hydrated rather than
    // believing itself current.
    expect(mirror.resyncing()).toBe(true);
    expect(mirror.appliedThrough()).toBe(5);

    // The supervisor brought the replacement up and delivered its marker.
    regainEngine();
    // And the reason is the supervisor's own: the engine was replaced. Driving
    // the recovery to completion is what makes the reason observable —
    // `lastResyncReason()` is written when the resync actually runs.
    const recovering = mirror.applyEvent({
      type: "resync_required",
      value: { current_generation: 9, reason: "runtime_recovered" },
    });
    await answerHydrationOn(harness, {
      generation: 9,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a2" }],
      notes: [{ path: "A.md", revision: "blake3:a2" }],
    });
    await recovering;
    expect(mirror.lastResyncReason()).toBe("runtime_recovered");
    expect(mirror.resyncing()).toBe(false);
    expect(mirror.generation()).toBe(9);
    // Quietly is not silently: nothing about the lost engine was reported as an
    // apply failure, because it is a recovery the supervisor is already making.
    expect(reported).toEqual([]);
  });

  it("reports a refetch failure its caller dropped, instead of losing it", async () => {
    // **The pin for `Mirror.enqueue`'s `run.catch(...)`, and what that handler
    // is really for — measured, not assumed.** The chain already attaches a
    // rejection handler to the same promise (`this.queue = run.then(a, b)`), so
    // `run` was never the thing Node reported as unhandled; what floated in the
    // original defect was the *caller's* derived promise, and what closed that
    // is the `EngineLostError` conversion the case above pins.
    //
    // What this handler adds is the **report**: a refetch that fails for a
    // reason nobody is recovering from (the daemon refused it) and whose
    // caller dropped the promise — a write made by a plugin that dropped its
    // own — would otherwise be lost entirely, with the mirror quietly stale.
    // Remove `run.catch(...)` and the apply-error seam hears nothing.
    const { mirror, harness } = await mirrorOverSwitchableEngine();
    const reported: string[] = [];
    mirror.onApplyError((error) => {
      reported.push(error instanceof Error ? error.message : String(error));
    });

    const { unhandled } = await withUnhandledWatch(async () => {
      // Dropped on purpose. No `await`, no `.catch` — the shape the defect was.
      void mirror.applyMutation(6, ["A.md"]);
      const tree = await harness.expectRequest("get_tree_entries");
      harness.respondErr(tree.id, { code: "internal", message: "the daemon fell over" });
    });

    expect(unhandled, "nothing floats out of a dropped refetch").toEqual([]);
    // Dropped by its caller is not the same as lost: it reaches the seam.
    expect(reported.join(" | "), "the apply-error seam must hear it").toMatch(
      /the daemon fell over/,
    );
  });

  /**
   * **The `Vault.create` race, reproduced at the seam.**
   *
   * The 22a implementer saw `the daemon accepted a write to X but the mirror
   * has no row for it` twice and nobody reproduced it: two reviewers ran the
   * goldens ten serial times each and never saw it. It is not a timing
   * coincidence, it is a swallow. `applyMutation` reads an `EngineLostError`
   * out of its refetch the same way an event apply does — "a
   * `runtime_recovered` marker is on its way, nothing here is worth failing a
   * subscription fan-out over" — and **returns**, which for a mutation is a
   * claim that the paths were refetched when they were not. `Vault.create`
   * takes that promise as a success and asks the mirror for the row that was
   * never installed, so the sentence it throws describes the symptom and names
   * the wrong culprit: the daemon really did accept the write.
   *
   * Why the goldens never reproduced it: the engine has to be replaced in the
   * window between the daemon answering a write and this host refetching it.
   * The daemon does replace it there — a root-level `create_folder` under a
   * live watcher answers `resync_required { watcher_overflow }` and the resync
   * can take the engine with it (`docs/protocol-host.md`, and the note on
   * `Journal/` in `test/golden/quickadd.test.ts`) — but only sometimes, and the
   * goldens pre-create the folders that provoke it.
   *
   * Deterministic here because the engine is taken away between the write's
   * request and its response, which is exactly that window and needs no timing
   * at all. What the mutation must do is refuse, with the typed error the rest
   * of the host already knows: the write landed, the mirror could not read it
   * back, and the supervisor's replacement will re-hydrate.
   */
  it("refuses a create whose read-back meets a replaced engine, instead of claiming a missing row", async () => {
    const { mirror, harness, loseEngine } = await mirrorOverSwitchableEngine();
    // A `Vault` primes its `app.json` cache the moment it is built, from the
    // host config directory first and `.obsidian/` second. Answered here so
    // those two reads never reach the request queue this case is stepping
    // through; a vault with no settings file is an ordinary vault.
    harness.unserveFile(`${harness.config.configDirName}/app.json`);
    harness.unserveFile(".obsidian/app.json");
    const vault = new Vault({
      config: harness.config,
      client: harness.client,
      mirror,
      events: new ShimEventBus(),
      writes: forwardingWriteGate(harness.client),
      queue: new DispatchQueue(),
    });

    const creating = vault.create("New.md", "body\n");
    const sent = await harness.expectRequest("write_note");
    // The engine is replaced while the write is in flight. The write itself is
    // already the daemon's business and still answers; the *refetch* is what
    // meets the gap.
    loseEngine();
    harness.respondOk(sent.id, "write_note", { generation: 6, revision: "blake3:n1" });

    await expect(creating).rejects.toThrow(EngineLostError);
    await expect(creating).rejects.toThrow(/New\.md/);
    // Not the sentence that blamed the mirror for a row the daemon supposedly
    // wrote. That message is the symptom this case exists to remove.
    await expect(creating).rejects.not.toThrow(/has no row for it/);
    // The road is the same one every other engine loss takes: the mirror knows
    // generation 6 is unread and is waiting to be re-hydrated rather than
    // believing itself current.
    expect(mirror.resyncing()).toBe(true);
    expect(mirror.appliedThrough()).toBe(5);
  });

  it("ignores a late delta once stopped, and sends nothing for it", async () => {
    const { mirror, harness } = await mirrorOverSwitchableEngine();

    mirror.stop();
    const { unhandled } = await withUnhandledWatch(async () => {
      // A generation the daemon committed just as the host began shutting down.
      // Held here so a rejection would be this case's to see; dropped, it would
      // be the process's.
      await mirror.applyEvent(committed(6, ["A.md"]));
    });

    expect(unhandled).toEqual([]);
    // Nothing was asked of the engine the teardown is stopping, and the mirror
    // did not move: a task enqueued after `stop()` resolves without running.
    expect(harness.methodsSeen()).toEqual([]);
    expect(mirror.generation()).toBe(5);
    expect(mirror.appliedThrough()).toBe(5);
  });
});
