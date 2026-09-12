/**
 * The host's dispatch queue: one FIFO for plugin entry points, and a per-path
 * lock layered on top of it.
 *
 * Two different serializations, because they answer two different questions.
 *
 * {@link DispatchQueue.run} is the **single FIFO**. Every plugin entry point —
 * a command invocation, an event handler the host drives, a protocol action —
 * goes through it, so at most one plugin call is in flight at a time and
 * `currentPluginId()` has one unambiguous answer for the whole of it. That
 * ambient attribution is what lets a surface several layers down record a hit
 * against the plugin that caused it without every call site passing an id.
 *
 * {@link DispatchQueue.runExclusivePath} is a **per-path lock**, used only by
 * `Vault.process`. Mutation-spec Ruling 2 assigns read-modify-write
 * serialization to the host explicitly: two plugins processing the same note
 * must interleave here rather than race to a `revision_conflict` at the daemon.
 * It is a real promise chain per path — the next holder's task function is not
 * called until the previous one's promise has settled — because anything less
 * (a boolean flag, a counter, a `setImmediate` hop) serializes the *start* of
 * the work and not the work.
 *
 * A rejected task never poisons either chain: the next entry is different work
 * with its own answer to give, and a queue that stopped on the first failure
 * would turn one plugin's bug into the host's.
 */

import { enterPlugin } from "../shim/policy";

export class DispatchQueue {
  private tail: Promise<void> = Promise.resolve();
  private depthValue = 0;
  private running: { pluginId: string | null; label: string } | null = null;
  private readonly pathLocks = new Map<string, Promise<void>>();

  /**
   * Queue one plugin entry point behind everything already queued.
   *
   * `label` is what the report and a stuck-queue diagnostic call this piece of
   * work ("quickadd:onload", "command:tasknotes:open"). It is never parsed.
   */
  run<T>(pluginId: string | null, label: string, task: () => Promise<T> | T): Promise<T> {
    this.depthValue += 1;
    const result = this.tail.then(async () => {
      this.running = { pluginId, label };
      try {
        return await enterPlugin(pluginId, task);
      } finally {
        // Cleared here rather than in a `.finally` on `result`: the tail
        // continuation below is registered first and would therefore run
        // first, so a later `.finally` would null out the *next* task's entry.
        this.running = null;
        this.depthValue -= 1;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Queue `task` behind every other task holding `path`.
   *
   * Independent of {@link run}'s FIFO: a `process` call is already inside one
   * plugin entry point, and making it wait on the global queue it is running
   * *under* would deadlock.
   */
  runExclusivePath<T>(path: string, task: () => Promise<T>): Promise<T> {
    // Spelled out rather than `?? Promise.resolve()`: a nullish coalesce whose
    // left side is a promise reads to the lint rules as a promise in a boolean
    // position, which is the bug class they exist to catch.
    const held = this.pathLocks.get(path);
    const previous = held === undefined ? Promise.resolve() : held;
    this.depthValue += 1;
    const result = previous.then(async () => {
      try {
        return await task();
      } finally {
        this.depthValue -= 1;
      }
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pathLocks.set(path, settled);
    // Drop the entry once nothing is behind it, so a long-lived host does not
    // accumulate one resolved promise per path it has ever written.
    void settled.then(() => {
      if (this.pathLocks.get(path) === settled) this.pathLocks.delete(path);
    });
    return result;
  }

  /** How many tasks are queued or running, across both serializations. */
  depth(): number {
    return this.depthValue;
  }

  /** The plugin entry point running right now, or `null` between tasks. */
  inFlight(): { pluginId: string | null; label: string } | null {
    return this.running === null ? null : { ...this.running };
  }
}
