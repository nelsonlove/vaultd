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

import { enterPlugin, enterPluginSync } from "../shim/policy";

export interface DispatchQueueOptions {
  /**
   * Called on every task boundary, whichever serialization the task ran under.
   *
   * **The seam the wedged-thread watchdog stamps through**, and a hook rather
   * than an import because the dependency only runs one way: the watchdog knows
   * what a dispatch queue is, and the queue must not have to know what a
   * watchdog is. `src/testing/assemble.ts` is what ties the two together, and
   * nothing here ever calls it.
   *
   * The reason a queue stamps at all: a host saturated with plugin work
   * services no interval, so the heartbeat stops even though the loop is
   * perfectly healthy — and the busiest host in the fleet would be the one
   * reporting itself wedged. A task boundary is the other proof of life, and it
   * is the one a busy host produces most often.
   *
   * **It must not throw.** It is called from a `finally`, so a hook that threw
   * would replace the answer — or the failure — the task was about to give.
   */
  readonly afterTask?: () => void;
}

export class DispatchQueue {
  private tail: Promise<void> = Promise.resolve();
  private depthValue = 0;
  private running: { pluginId: string | null; label: string } | null = null;
  private readonly pathLocks = new Map<string, Promise<void>>();
  /** Waiters on {@link DispatchQueue.idle}, resolved at the next empty boundary. */
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly options: DispatchQueueOptions = {}) {}

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
        this.boundary();
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Run one plugin entry point **now**, attributed, without queueing it.
   *
   * The one caller is `app.commands.executeCommandById`, and the reason it
   * cannot use {@link run} is the signature: Obsidian's `executeCommandById` is
   * synchronous and answers a boolean, so a version of it that waited for a
   * FIFO slot could only ever answer a promise — which would change what every
   * plugin branching on that boolean does.
   *
   * **What is given up, stated rather than hidden:** this does not serialize.
   * A command invoked from inside another plugin's entry point runs inside that
   * one, nested, exactly as it would in Obsidian — where the palette, a hotkey
   * and a plugin's own `executeCommandById` all dispatch synchronously too. The
   * attribution window is still correct because it nests: `inFlight()` names
   * the inner work while it runs and the outer work again afterwards.
   */
  runInline<T>(pluginId: string | null, label: string, task: () => T): T {
    const outer = this.running;
    this.depthValue += 1;
    this.running = { pluginId, label };
    try {
      return enterPluginSync(pluginId, task);
    } finally {
      this.running = outer;
      this.depthValue -= 1;
      this.boundary();
    }
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
        this.boundary();
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

  /**
   * One task boundary, announced to whoever asked to hear about them.
   *
   * See {@link DispatchQueueOptions.afterTask}: no hook is the ordinary case,
   * and the queue's own behaviour does not depend on one being there.
   */
  private boundary(): void {
    this.options.afterTask?.();
    if (this.depthValue > 0 || this.idleWaiters.length === 0) return;
    for (const settle of this.idleWaiters.splice(0)) settle();
  }

  /**
   * Resolve when nothing is queued or running.
   *
   * **The drain a shutdown needs.** Stopping a host unloads its plugins and
   * then takes the process-wide globals down; a handler still inside its
   * dispatch slot when that happens is a plugin running against a `window`
   * that is being removed underneath it. Waiting on the queue is what makes
   * the teardown ordered rather than merely sequential.
   *
   * It resolves immediately when the queue is already empty, and it is
   * resolved from {@link boundary}, so it costs nothing while nobody is
   * waiting. It is **not** a promise that the host is quiet: work a plugin
   * dropped on the floor is by definition not in this queue, which is why a
   * shutdown also disarms the timers such work runs on.
   */
  idle(): Promise<void> {
    if (this.depthValue === 0) return Promise.resolve();
    return new Promise<void>((settle) => this.idleWaiters.push(settle));
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
