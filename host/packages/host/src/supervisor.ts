import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { VaultdClient } from "./client/client";
import { isKnownRuntimeEvent } from "./client/events";
import type {
  SubscriptionErrorHandler,
  SubscriptionHandle,
  SubscriptionHandler,
} from "./client/client";
import type { GetVaultInfoResponse, LiveStateDto, RuntimeEventDto } from "./client/protocol";
import type { HostConfig } from "./config";

export type SupervisorState = "starting" | "running" | "restarting" | "stopped";

export interface SupervisorEvents {
  /**
   * A new engine answered its readiness probe. The client is **new on every
   * call**: the old one is closed and everything that was in flight on it has
   * already been failed, so nothing held from a previous call is usable.
   */
  onClientReady(client: VaultdClient): void | Promise<void>;
  /** An engine died, or an attempt to start one failed. Called once per loss. */
  onEngineLost(reason: Error): void | Promise<void>;
  onStateChange(state: SupervisorState): void;
}

/** How the engine process ended, and whether the supervisor had to escalate. */
export interface EngineExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly escalated: "none" | "sigterm" | "sigkill";
}

/**
 * A subscription that outlives the engine it was opened on.
 *
 * `close()` detaches the handler. It does not close the daemon-side
 * subscription, which belongs to the engine and ends with it.
 */
export interface SupervisorSubscription {
  close(): Promise<void>;
}

interface DurableSubscriber {
  readonly handler: SubscriptionHandler;
  readonly onError?: SubscriptionErrorHandler;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface Engine {
  readonly child: ChildProcess;
  readonly client: VaultdClient;
  readonly stdin: NodeJS.WritableStream;
  /** Resolves when this engine's runtime announces `watching`. */
  readonly watching: Deferred;
  exited: boolean;
  exit: EngineExit | null;
  escalated: "none" | "sigterm" | "sigkill";
  subscription: SubscriptionHandle | null;
  subscribing: boolean;
  /** Events held back until the restart marker has been delivered. */
  queued: RuntimeEventDto[];
  buffering: boolean;
  failStartup: ((error: Error) => void) | null;
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/**
 * A promise nobody may be awaiting yet.
 *
 * The `catch` is attached at creation and is not a swallow: it marks the
 * promise as handled so a rejection nobody is waiting on cannot become an
 * unhandled rejection, while the original promise — the one handed to callers
 * — still rejects for whoever awaits it.
 */
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((settleResolve, settleReject) => {
    resolve = settleResolve;
    reject = settleReject;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function describeExit(exit: EngineExit | null): string {
  if (!exit) return "for reasons the supervisor never saw";
  if (exit.signal !== null) return `on signal ${exit.signal}`;
  return `with code ${String(exit.code)}`;
}

/**
 * Owns one `vaultd` process: spawns it, holds its stdio, restarts it, and
 * carries what continuity there is across a restart.
 *
 * **The lifecycle runs in both directions.** The supervisor owns the engine's
 * `stdin` and `stdout`; when the host exits, that `stdin` closes and `vaultd`
 * exits with it, so a host crash cannot leave an orphan daemon holding the
 * index's writer lease. (Verified against the shipped binary: EOF on `stdin`
 * ends it with code 0 and no signal.) `stop()` uses the same door — close
 * `stdin`, wait — and escalates to `SIGTERM` after 2 s and `SIGKILL` after 5 s
 * only if the child does not take the hint.
 *
 * **Readiness has two meanings and this class exposes both, because conflating
 * them is how a host starts driving a runtime that is still catching up.**
 * `start()` resolves on one `health` round trip: the process exists and speaks
 * the protocol. That is *not* the vault being ready. The runtime's own
 * announcement is `runtime_state_changed { live_state: "watching" }`, delivered
 * on a subscription that opens during `catching_up`, and {@link whenWatching}
 * is the promise that waits for exactly it.
 *
 * **What a restart preserves, and what it cannot.** The index is on disk, so a
 * new engine over the same index resumes at the generation the old one
 * committed and a write acknowledged before the crash is readable after it.
 * The *connection* survives nothing: the client, its pending requests, and its
 * subscriptions all die with the process. So this class re-opens one
 * subscription per engine and fans it out to {@link subscribe} handlers, and on
 * a restart it leads that fan-out with one synthesized
 * `resync_required { reason: "runtime_recovered" }` naming the new engine's
 * generation — the wire's own word for "a startup catch-up happened, re-read
 * current state", which is precisely what a restarted daemon does. No reason
 * the wire lacks is invented, and `current_generation` is a real generation
 * read from the new engine's `get_vault_info`, so the one client-synthesized
 * marker Task 3 documents (`subscriber_lag` with a null generation) keeps its
 * unambiguous signature.
 */
export class Supervisor {
  private readonly config: HostConfig;
  private readonly events: SupervisorEvents;
  private currentState: SupervisorState = "stopped";
  private engine: Engine | null = null;
  private restarts = 0;
  private stopping = false;
  private lastExitValue: EngineExit | null = null;
  private lastErrorValue: Error | null = null;
  private liveStateValue: LiveStateDto | null = null;
  private readonly durable = new Set<DurableSubscriber>();
  private subscriptionWanted = false;
  private resyncOwed = false;
  private backoffTimer: NodeJS.Timeout | null = null;
  private resumeBackoff: (() => void) | null = null;
  private warned = false;

  constructor(config: HostConfig, events: SupervisorEvents) {
    this.config = config;
    this.events = events;
  }

  /**
   * Start an engine, retrying up the backoff ladder until one answers.
   *
   * Rejects when the ladder is exhausted; the supervisor is then `stopped` and
   * {@link lastError} holds why.
   */
  async start(): Promise<void> {
    if (this.engine) throw new Error("the supervisor already has an engine");
    this.stopping = false;
    this.setState("starting");
    await this.climb();
  }

  state(): SupervisorState {
    return this.currentState;
  }

  /** How many times a *running* engine has been replaced. Start attempts do not count. */
  restartCount(): number {
    return this.restarts;
  }

  /** The current engine's client. Throws when there is no engine. */
  client(): VaultdClient {
    if (!this.engine) throw new Error("no engine is running");
    return this.engine.client;
  }

  /** The current engine's pid, for a test that needs to kill it the hard way. */
  pid(): number | null {
    return this.engine?.child.pid ?? null;
  }

  /** The last live state the current engine announced, or `null` before any. */
  liveState(): LiveStateDto | null {
    return this.liveStateValue;
  }

  /** How the last engine process ended. */
  lastExit(): EngineExit | null {
    return this.lastExitValue;
  }

  /** The last failure this supervisor saw, whether or not it recovered from it. */
  lastError(): Error | null {
    return this.lastErrorValue;
  }

  /**
   * Resolve when the current engine's runtime reaches `watching`.
   *
   * This is the readiness a host should gate real work on. Opening the
   * subscription is what makes it observable, so the first call opens one; a
   * runtime already `watching` when that subscription opens resolves from the
   * subscribe response rather than waiting for a transition that has already
   * happened. If the engine dies first, the promise rejects rather than hanging
   * — a caller waiting on a dead engine is a caller waiting forever.
   */
  whenWatching(): Promise<void> {
    const engine = this.engine;
    if (!engine) return Promise.reject(new Error("no engine is running"));
    this.wantSubscription(engine);
    return engine.watching.promise;
  }

  /**
   * Subscribe to the engine's events for as long as this supervisor lives.
   *
   * One daemon-side subscription is opened per engine and fanned out here, so
   * every handler sees the same stream in the same order. Across a restart the
   * handler is re-attached to the new engine and receives one synthesized
   * `resync_required { runtime_recovered }` **before** any event of the new
   * engine's — see the class doc for why that reason and not another.
   *
   * A throw out of `handler` goes to `onError`, and with no `onError` it raises
   * one warning per supervisor: one subscriber's bug must not take down the
   * fan-out every other subscriber shares.
   */
  async subscribe(
    handler: SubscriptionHandler,
    onError?: SubscriptionErrorHandler,
  ): Promise<SupervisorSubscription> {
    const subscriber: DurableSubscriber = onError ? { handler, onError } : { handler };
    this.durable.add(subscriber);
    const engine = this.engine;
    if (engine) {
      await this.openSubscription(engine);
      // `openSubscription` swallows its failure on purpose — a restart must not
      // die because one subscribe attempt did — but a caller subscribing right
      // now is entitled to hear that it got nothing.
      if (!engine.subscription && engine === this.engine) {
        this.durable.delete(subscriber);
        throw this.lastErrorValue ?? new Error("the engine refused a subscription");
      }
    }
    return {
      close: (): Promise<void> => {
        this.durable.delete(subscriber);
        return Promise.resolve();
      },
    };
  }

  /**
   * Stop the engine and stay stopped. Idempotent.
   *
   * The child is ended by closing its `stdin`, which is the door that also
   * closes when the host process dies; `SIGTERM` at 2 s and `SIGKILL` at 5 s
   * are the escalation, and {@link lastExit} says which of the three actually
   * ended it.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelBackoff();
    const engine = this.engine;
    this.engine = null;
    this.liveStateValue = null;
    this.setState("stopped");
    if (!engine) return;
    await this.shutdown(engine);
  }

  /** One attempt per rung; rung `i`'s wait precedes attempt `i + 1`. */
  private async climb(): Promise<void> {
    const ladder = this.config.restartBackoffMs;
    for (let attempt = 0; ; attempt += 1) {
      if (this.stopping) return;
      try {
        await this.spawnOnce();
        return;
      } catch (thrown) {
        const error = asError(thrown);
        this.lastErrorValue = error;
        await this.safely(() => this.events.onEngineLost(error), "onEngineLost");
        if (this.stopping) return;
        const wait = attempt + 1 < ladder.length ? ladder[attempt] : undefined;
        if (wait === undefined) {
          this.setState("stopped");
          const fatal = new Error(
            `engine failed to start after ${attempt + 1} attempt(s): ${error.message}`,
          );
          this.lastErrorValue = fatal;
          throw fatal;
        }
        this.setState("restarting");
        await this.wait(wait);
      }
    }
  }

  /**
   * Spawn one engine and prove it answers.
   *
   * The readiness proof is a `health` round trip rather than a timer: a process
   * that exists is not a daemon that speaks. It races the child's own death, so
   * an engine that exits before answering fails this attempt with the exit code
   * rather than leaving the request pending until something else notices.
   */
  private async spawnOnce(): Promise<void> {
    const child = spawn(this.config.vaultdBinary, [...this.config.vaultdArgs], {
      env: { ...process.env, ...this.config.env },
      // stderr is inherited on purpose: the daemon's diagnostics are the host's
      // diagnostics, and a pipe nobody drains is a pipe that eventually blocks
      // the process writing to it.
      stdio: ["pipe", "pipe", "inherit"],
    });
    const { stdin, stdout } = child;
    if (!stdin || !stdout) {
      child.kill("SIGKILL");
      throw new Error("the engine was spawned without its stdio pipes");
    }
    const client = new VaultdClient({
      stdout,
      stdin,
      onEvent: () => undefined,
      // Never absent: a throw out of a consumer's handler must not be able to
      // kill the transport every other consumer on this engine shares.
      onHandlerError: (error) => {
        this.warn(`a vaultd event handler threw: ${error.message}`);
      },
      onFatal: (error) => {
        this.onTransportFatal(engine, error);
      },
    });
    const engine: Engine = {
      child,
      client,
      stdin,
      watching: deferred(),
      exited: false,
      exit: null,
      escalated: "none",
      subscription: null,
      subscribing: false,
      queued: [],
      buffering: false,
      failStartup: null,
    };
    child.on("error", (error: Error) => {
      // A spawn that never happened: no stdout, so nothing will ever end and
      // the readiness request has to be failed by hand.
      client.failAllPending(error);
      client.close();
      engine.failStartup?.(error);
    });
    child.on("exit", (code, signal) => {
      engine.exited = true;
      engine.exit = { code, signal, escalated: engine.escalated };
      this.onChildExit(engine);
    });

    const failed = new Promise<never>((_resolve, reject) => {
      engine.failStartup = reject;
    });
    try {
      await Promise.race([client.request("health"), failed]);
    } catch (thrown) {
      client.close();
      if (!engine.exited) child.kill("SIGKILL");
      throw asError(thrown);
    }
    engine.failStartup = null;
    // From here the engine is the current one, and that identity — not a flag —
    // is what tells a later exit apart from a failed start attempt.
    this.engine = engine;
    this.liveStateValue = null;
    this.setState("running");
    await this.safely(() => this.events.onClientReady(client), "onClientReady");
    if (this.subscriptionWanted) await this.openSubscription(engine);
  }

  /**
   * Open this engine's one subscription, and settle the restart debt if there
   * is one.
   *
   * Order is the whole point. The subscription is installed first, so no event
   * of the new engine's is missed; the marker is delivered next, so the
   * consumer learns its view is stale before it sees anything built on the new
   * one; the events that arrived in between are released last, in order.
   */
  private async openSubscription(engine: Engine): Promise<void> {
    this.subscriptionWanted = true;
    if (engine.subscription || engine.subscribing) return;
    engine.subscribing = true;
    const owed = this.resyncOwed;
    engine.buffering = owed;
    try {
      const handle = await engine.client.subscribeEvents((event) => {
        this.onEngineEvent(engine, event);
      });
      engine.subscription = handle;
      this.noteLiveState(engine, handle.liveState);
      if (!owed) return;
      const info = await engine.client.request<GetVaultInfoResponse>("get_vault_info");
      this.resyncOwed = false;
      engine.buffering = false;
      this.fanout({
        type: "resync_required",
        value: { current_generation: info.generation, reason: "runtime_recovered" },
      });
      const held = engine.queued;
      engine.queued = [];
      for (const event of held) this.fanout(event);
    } catch (thrown) {
      const error = asError(thrown);
      this.lastErrorValue = error;
      engine.buffering = false;
      engine.watching.reject(error);
      this.warn(`the supervisor could not subscribe to the engine: ${error.message}`);
    } finally {
      engine.subscribing = false;
    }
  }

  /** Ask for a subscription without waiting for it — {@link whenWatching}'s door. */
  private wantSubscription(engine: Engine): void {
    if (engine.subscription || engine.subscribing) {
      this.subscriptionWanted = true;
      return;
    }
    void this.openSubscription(engine);
  }

  private onEngineEvent(engine: Engine, event: RuntimeEventDto): void {
    // Narrowed through the guard, not by comparing `type` alone: the event
    // union is open, and its unknown member's `type` is an unconstrained
    // string, so a bare comparison leaves `value` as `unknown`.
    if (isKnownRuntimeEvent(event) && event.type === "runtime_state_changed") {
      this.noteLiveState(engine, event.value.live_state);
    }
    if (engine.buffering) engine.queued.push(event);
    else this.fanout(event);
  }

  private noteLiveState(engine: Engine, state: LiveStateDto): void {
    if (engine !== this.engine) return;
    this.liveStateValue = state;
    if (state === "watching") engine.watching.resolve();
  }

  /** Hand one event to every durable subscriber, and keep their throws local. */
  private fanout(event: RuntimeEventDto): void {
    for (const subscriber of [...this.durable]) {
      try {
        subscriber.handler(event);
      } catch (thrown) {
        const error = asError(thrown);
        this.lastErrorValue = error;
        if (subscriber.onError) subscriber.onError(error, event);
        else this.warn(`a supervisor subscriber threw and named no onError: ${error.message}`);
      }
    }
  }

  /**
   * The transport died with the child still alive — a malformed line, or a
   * stream error. The engine is unusable either way, so it is killed and the
   * ordinary exit path does the restarting; there is one restart mechanism, not
   * two.
   */
  private onTransportFatal(engine: Engine, error: Error): void {
    this.lastErrorValue = error;
    if (engine.exited || engine !== this.engine || this.stopping) return;
    engine.child.kill("SIGKILL");
  }

  private onChildExit(engine: Engine): void {
    // Never left hanging: a request whose engine is gone must fail, because a
    // shim write that never settles is indistinguishable from a wedged plugin.
    engine.client.failAllPending(new Error("vaultd restarted"));
    engine.client.close();
    // Recorded for every engine, including one that died before it was ever
    // current: how the last process ended is diagnosis, and a failed start is
    // exactly when somebody wants it.
    this.lastExitValue = engine.exit;
    if (engine !== this.engine) {
      engine.failStartup?.(
        new Error(`the engine exited ${describeExit(engine.exit)} before it was ready`),
      );
      return;
    }
    this.engine = null;
    this.liveStateValue = null;
    engine.watching.reject(new Error(`the engine exited ${describeExit(engine.exit)}`));
    if (this.stopping) return;
    this.restarts += 1;
    void this.restart(engine);
  }

  /** A running engine died. Report it, then climb the ladder from the bottom. */
  private async restart(lost: Engine): Promise<void> {
    const error = new Error(`vaultd exited ${describeExit(lost.exit)}`);
    this.lastErrorValue = error;
    await this.safely(() => this.events.onEngineLost(error), "onEngineLost");
    if (this.stopping) return;
    this.setState("restarting");
    // The new engine owes every live subscriber a resync: their view was built
    // on a connection that no longer exists.
    this.resyncOwed = this.durable.size > 0;
    try {
      await this.climb();
    } catch {
      // `climb` has already recorded the failure and stopped the supervisor.
      // Nothing above this call is waiting on it — a crash long after `start()`
      // resolved has no promise to reject — so the state and `lastError()` are
      // the report.
    }
  }

  private shutdown(engine: Engine): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        for (const timer of timers) this.config.clock.clearTimeout(timer);
        this.lastExitValue = engine.exit;
        resolve();
      };
      if (engine.exited) {
        this.lastExitValue = engine.exit;
        resolve();
        return;
      }
      const timers: NodeJS.Timeout[] = [
        this.config.clock.setTimeout(() => {
          engine.escalated = "sigterm";
          engine.child.kill("SIGTERM");
        }, 2_000),
        this.config.clock.setTimeout(() => {
          engine.escalated = "sigkill";
          engine.child.kill("SIGKILL");
        }, 5_000),
      ];
      // Registered after the listener that records the exit, so by the time
      // this runs `engine.exit` is filled in.
      engine.child.once("exit", finish);
      engine.stdin.end();
    });
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resumeBackoff = resolve;
      this.backoffTimer = this.config.clock.setTimeout(() => {
        this.backoffTimer = null;
        this.resumeBackoff = null;
        resolve();
      }, ms);
    });
  }

  private cancelBackoff(): void {
    if (this.backoffTimer !== null) {
      this.config.clock.clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    const resume = this.resumeBackoff;
    this.resumeBackoff = null;
    if (resume) resume();
  }

  private setState(state: SupervisorState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.events.onStateChange(state);
  }

  /**
   * Run a consumer callback and keep its throw off the lifecycle. A host whose
   * `onClientReady` throws is a broken host, but killing the engine it just
   * started would turn one bug into a restart loop.
   */
  private async safely(run: () => void | Promise<void>, label: string): Promise<void> {
    try {
      await run();
    } catch (thrown) {
      const error = asError(thrown);
      this.lastErrorValue = error;
      this.warn(`${label} threw: ${error.message}`);
    }
  }

  /** One warning per supervisor: a callback that throws on every event must not flood. */
  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    process.emitWarning(`${message} Further supervisor warnings are suppressed.`, {
      type: "VaultdSupervisorWarning",
    });
  }
}
