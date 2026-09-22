import { describe, expect, it } from "vitest";

import { DispatchQueue } from "../src/runtime/queue";
import { currentPluginId } from "../src/shim/policy";
import { testClock } from "../src/testing/clock";

/**
 * The dispatch queue: one FIFO for plugin entry points, one lock per path.
 *
 * Both serializations are load-bearing and neither is visible from the surfaces
 * that use them — `Vault.process` holds a path lock and says nothing about it,
 * and `currentPluginId()` is ambient by design — so this file is where they are
 * proved rather than assumed.
 *
 * The queue is **timer-free**, and that is asserted rather than described: a
 * queue that reached for `setTimeout` would serialize by waiting, which is the
 * failure mode that makes a suite slow and then flaky.
 */

/** A promise plus the handle that settles it, for ordering without sleeps. */
function deferred(): { promise: Promise<void>; settle: () => void } {
  let settle = (): void => {};
  const promise = new Promise<void>((resolve) => {
    settle = (): void => {
      resolve();
    };
  });
  return { promise, settle };
}

describe("DispatchQueue.run", () => {
  it("runs entry points one at a time, in the order they were queued", async () => {
    const queue = new DispatchQueue();
    const order: string[] = [];
    const first = deferred();

    const a = queue.run(null, "a", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = queue.run(null, "b", () => {
      order.push("b");
    });
    const c = queue.run(null, "c", () => {
      order.push("c");
    });

    expect(queue.depth()).toBe(3);
    await Promise.resolve();
    // `b` and `c` are queued behind a task that has not finished: nothing of
    // theirs may have run.
    expect(order).toEqual(["a:start"]);
    first.settle();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a:start", "a:end", "b", "c"]);
    expect(queue.depth()).toBe(0);
  });

  it("keeps running after a task rejects", async () => {
    const queue = new DispatchQueue();
    const failing = queue.run(null, "boom", () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(queue.run(null, "after", () => "answered")).resolves.toBe("answered");
    expect(queue.depth()).toBe(0);
  });

  it("names the entry point in flight, and nothing between tasks", async () => {
    const queue = new DispatchQueue();
    const held = deferred();
    expect(queue.inFlight()).toBeNull();
    const running = queue.run("quickadd", "quickadd:onload", async () => {
      await held.promise;
    });
    await Promise.resolve();
    expect(queue.inFlight()).toEqual({ pluginId: "quickadd", label: "quickadd:onload" });
    held.settle();
    await running;
    expect(queue.inFlight()).toBeNull();
  });

  it("makes the current plugin ambient, and restores it on the way out", async () => {
    const queue = new DispatchQueue();
    expect(currentPluginId()).toBeNull();
    const seen: (string | null)[] = [];
    await queue.run("tasknotes", "command", async () => {
      seen.push(currentPluginId());
      // A nested path lock runs inside the same attribution window: a `process`
      // call is always already inside a plugin entry point.
      await queue.runExclusivePath("A.md", () => {
        seen.push(currentPluginId());
        return Promise.resolve();
      });
      seen.push(currentPluginId());
    });
    expect(seen).toEqual(["tasknotes", "tasknotes", "tasknotes"]);
    expect(currentPluginId()).toBeNull();
  });

  it("arms no timer", async () => {
    const clock = testClock();
    const queue = new DispatchQueue();
    await queue.run("a", "one", () => undefined);
    await queue.runExclusivePath("A.md", () => Promise.resolve());
    expect(clock.armed()).toBe(0);
  });
});

describe("DispatchQueue.runExclusivePath", () => {
  it("serializes one path and lets a different path proceed", async () => {
    const queue = new DispatchQueue();
    const order: string[] = [];
    const held = deferred();

    const first = queue.runExclusivePath("A.md", async () => {
      order.push("first:start");
      await held.promise;
      order.push("first:end");
    });
    const second = queue.runExclusivePath("A.md", () => {
      order.push("second");
      return Promise.resolve();
    });
    const other = queue.runExclusivePath("B.md", () => {
      order.push("other");
      return Promise.resolve();
    });

    await other;
    // A different path is not behind this lock, so it has already run — while
    // the second holder of `A.md` has not.
    expect(order).toEqual(["first:start", "other"]);
    held.settle();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });

  it("hands the lock on after a holder rejects", async () => {
    const queue = new DispatchQueue();
    const failing = queue.runExclusivePath("A.md", () => Promise.reject(new Error("nope")));
    await expect(failing).rejects.toThrow("nope");
    await expect(queue.runExclusivePath("A.md", () => Promise.resolve("through"))).resolves.toBe(
      "through",
    );
    expect(queue.depth()).toBe(0);
  });
});
