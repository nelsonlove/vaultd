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

/** How much of the engine's stderr is kept for the error that reports its death. */
const STDERR_TAIL_BYTES = 4096;

/**
 * The daemon's own words when the index's writer lease is held elsewhere.
 *
 * It refuses **at startup** — exit code 2, this line on stderr — rather than
 * starting and answering `index_in_use` on the wire, so the host meets the
 * lease as a start failure and there is no wire code to branch on. Matching the
 * message is therefore the only signal available today; it is best-effort, and
 * a daemon-side exit-code contract would be better. {@link EngineStartError.exit}
 * carries the code either way.
 */
const LEASE_HELD = /already in use by another writer/i;

/**
 * An engine that could not be started.
 *
 * It carries the **exit**, not the transport symptom. When a child dies during
 * its readiness round trip, the stream's `end` reaches the client before the
 * process's `exit` reaches the supervisor, so the naive error says "daemon
 * stdout closed" for what is really "the lease is held" or "the binary refused
 * its arguments". The supervisor waits for the actual exit before building this,
 * so `exit.code` and `stderrTail` are populated and a host can branch on them
 * without parsing anything.
 */
export class EngineStartError extends Error {
  readonly exit: EngineExit | null;
  readonly stderrTail: string;
  /** Best-effort, from the daemon's own stderr line — see {@link LEASE_HELD}. */
  readonly leaseHeld: boolean;

  constructor(message: string, exit: EngineExit | null, stderrTail: string, cause?: unknown) {
    super(message);
    this.name = "EngineStartError";
    this.exit = exit;
    this.stderrTail = stderrTail;
    // **Both halves, because either alone is weak.** The message is a string
    // nothing on the daemon side pins, so a reworded diagnostic would silently
    // turn this off and any other failure quoting the phrase would turn it on;
    // the exit code alone is the daemon's general "refused to start" and says
    // nothing about why. Together they classify, and `exit.code` stays the
    // durable half for a host that wants to branch on something narrower.
    this.leaseHeld = exit?.code === 2 && LEASE_HELD.test(stderrTail);
    // The transport error that arrived first is kept rather than discarded: it
    // is the wrong headline but it is still evidence.
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The engine behind a request went away.
 *
 * One class from **both** doors — the stream ending and the process exiting —
 * because which of the two wins is a race, and a caller must not have to
 * distinguish "vaultd restarted" from "daemon stdout closed" to know it is the
 * same event.
 */
export class EngineLostError extends Error {
  private readonly exitSource: () => EngineExit | null;

  constructor(message: string, exit: EngineExit | null | (() => EngineExit | null) = null) {
    super(message);
    this.name = "EngineLostError";
    this.exitSource = typeof exit === "function" ? exit : (): EngineExit | null => exit;
  }

  /**
   * How the engine ended, **resolved when read**.
   *
   * The stream's `end` is what fails a pending request, and it arrives before
   * the process's `exit` — so at the instant this error is raised, in the
   * common crash case, there is no exit code yet. A caller that reads `exit` a
   * turn later gets the real one instead of a permanent `null`, which is why
   * this is a getter over the engine's own record rather than a snapshot taken
   * too early. It is `null` only while the process is genuinely still going, or
   * when the engine never reported an exit at all.
   */
  get exit(): EngineExit | null {
    return this.exitSource();
  }
}

/** The engine kept dying as fast as it was started. See the flap ceiling. */
export class EngineFlappingError extends Error {
  readonly restarts: number;
  readonly windowMs: number;

  constructor(message: string, restarts: number, windowMs: number) {
    super(message);
    this.name = "EngineFlappingError";
    this.restarts = restarts;
    this.windowMs = windowMs;
  }
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
  /** Resolves when the process has actually exited, so its code is knowable. */
  readonly ended: Deferred;
  /** True once this engine passed its readiness probe and was adopted. */
  everReady: boolean;
  /**
   * True the moment this engine's transport is finished — set on the stream's
   * `end`, which is strictly earlier than the process's `exit`. It is the
   * question "is this engine still usable?", and the two events are far enough
   * apart that asking `exited` instead gets the wrong answer.
   */
  lost: boolean;
  exited: boolean;
  exit: EngineExit | null;
  escalated: "none" | "sigterm" | "sigkill";
  stderrTail: string;
  subscription: SubscriptionHandle | null;
  /** The in-flight open, shared by every caller that asks while it runs. */
  opening: Promise<void> | null;
  /**
   * True once an *event* has reported this engine's live state.
   *
   * The subscribe response's `live_state` is a snapshot taken when the daemon
   * wrote it, and the client drains events buffered during the round trip
   * **before** it returns that response — so an event carrying a newer state
   * can be delivered first. Seeding from the response afterwards would then
   * walk the state backwards, which is how `whenWatching()` resolved while
   * `liveState()` still said `catching_up`.
   */
  sawLiveEvent: boolean;
  /** Events held back until the restart marker has been delivered. */
  queued: RuntimeEventDto[];
  buffering: boolean;
  /** The in-flight shutdown, so `stop()` and `spawnOnce` cannot run two. */
  shuttingDown: Promise<void> | null;
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
 * only if the child does not take the hint. A `stop()` that lands *inside* a
 * spawn shuts that half-born engine down too, rather than letting the spawn
 * finish and adopt it.
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
 * from the daemon (`get_vault_info`, or the subscribe response's own start
 * point if that call fails), so the one client-synthesized marker Task 3
 * documents (`subscriber_lag` with a null generation) keeps its unambiguous
 * signature.
 *
 * **A restart is not free and the ceiling says so.** Reaching readiness clears
 * the backoff ladder, so an engine that ran for hours and then crashed is not
 * punished for a failure hours ago — but more than
 * `config.restartFlapLimit` restarts inside `config.restartFlapWindowMs` stops
 * the supervisor with an {@link EngineFlappingError}. Without it, an engine
 * that answers `health` and then dies restarts forever, taking the writer lease
 * every time.
 */
export class Supervisor {
  private readonly config: HostConfig;
  private readonly events: SupervisorEvents;
  private currentState: SupervisorState = "stopped";
  private engine: Engine | null = null;
  /** The engine between `spawn` and adoption. `stop()` must be able to see it. */
  private spawning: Engine | null = null;
  /** The one climb in flight, whether a `start()` or a restart owns it. */
  private climbing: Promise<void> | null = null;
  private restarts = 0;
  private restartTimes: number[] = [];
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
   * Concurrent calls **coalesce**: the second caller awaits the first call's
   * engine rather than spawning a second one.
   *
   * Rejects with an {@link EngineStartError} when the ladder is exhausted; the
   * supervisor is then `stopped` and {@link lastError} holds why. A `stop()`
   * that lands mid-start **resolves** this instead, with no engine and
   * `state() === "stopped"` — the stop was not a failure.
   */
  start(): Promise<void> {
    if (this.engine) return Promise.reject(new Error("the supervisor already has an engine"));
    // **One climb in flight, ever.** The in-flight climb may be another
    // `start()`'s or a restart's — the restart used to bypass this guard by
    // calling `climb()` directly, and an explicit `start()` in that window
    // opened a second parallel climb, two live engines, and an orphan that
    // survived `stop()` because the supervisor only ever tracked one of them.
    if (this.climbing) return this.climbing;
    this.stopping = false;
    this.restartTimes = [];
    this.setState("starting");
    return this.runClimb();
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

  /**
   * The last failure this supervisor saw **on the current engine**.
   *
   * Cleared when a new engine is adopted: an error about a process that no
   * longer exists is worse than none, because the code that reads it cannot
   * tell it is stale.
   */
  lastError(): Error | null {
    return this.lastErrorValue;
  }

  /**
   * Resolve when the current engine's runtime reaches `watching`.
   *
   * This is the readiness a host should gate real work on. Opening the
   * subscription is what makes it observable, so this call opens one — and
   * joins an open already in flight rather than racing it. A runtime already
   * `watching` when that subscription opens resolves from the subscribe
   * response rather than waiting for a transition that has already happened. If
   * the engine dies first, the promise rejects rather than hanging; if the
   * *subscription* is refused, this call rejects with the engine's own answer
   * and a later call is a fresh attempt.
   */
  whenWatching(): Promise<void> {
    const engine = this.engine;
    if (!engine) return Promise.reject(new Error("no engine is running"));
    return this.openSubscription(engine).then(() => engine.watching.promise);
  }

  /**
   * Subscribe to the engine's events for as long as this supervisor lives.
   *
   * One daemon-side subscription is opened per engine and fanned out here, so
   * every handler sees the same stream in the same order. **A subscriber that
   * arrives before there is an engine is honoured**: the next engine opens a
   * subscription because somebody asked for one. Across a restart the handler
   * is re-attached to the new engine and receives one synthesized
   * `resync_required { runtime_recovered }` **before** any event of the new
   * engine's — see the class doc for why that reason and not another.
   *
   * This rejects only when *this* attempt failed — the engine refused the
   * subscription, or died under it — never because another open happened to be
   * in flight. A throw out of `handler` goes to `onError`, and with no
   * `onError` it raises one warning per supervisor: one subscriber's bug must
   * not take down the fan-out every other subscriber shares.
   */
  async subscribe(
    handler: SubscriptionHandler,
    onError?: SubscriptionErrorHandler,
  ): Promise<SupervisorSubscription> {
    const subscriber: DurableSubscriber = onError ? { handler, onError } : { handler };
    // Before anything else, and whether or not an engine exists right now: this
    // is what makes the *next* engine open a subscription.
    this.subscriptionWanted = true;
    this.durable.add(subscriber);
    const engine = this.engine;
    if (engine) {
      try {
        await this.openSubscription(engine);
      } catch (thrown) {
        // Only a **live** engine's refusal is this caller's problem. If the
        // engine died under the attempt, the subscriber stays in the fan-out
        // and the replacement opens for it — which is the whole point of a
        // subscription that outlives its engine.
        if (this.engine === engine && !engine.lost) {
          this.durable.delete(subscriber);
          throw asError(thrown);
        }
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
   * ended it. An engine that is still being spawned is shut down the same way —
   * it is exactly the engine nobody else can see, and leaving it alive is how a
   * host that is told to quit during boot orphans a daemon on its own vault.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelBackoff();
    const engine = this.engine ?? this.spawning;
    this.engine = null;
    this.liveStateValue = null;
    this.setState("stopped");
    if (!engine) return;
    await this.shutdown(engine);
  }

  /**
   * The one door to {@link climb}.
   *
   * Both entrances — an explicit `start()` and an engine's own restart — go
   * through this, so there is exactly one ladder being climbed at any moment
   * and therefore at most one engine being spawned. A caller that arrives while
   * one is running joins it instead of starting another.
   */
  private runClimb(): Promise<void> {
    this.climbing ??= this.climb().finally(() => {
      this.climbing = null;
    });
    return this.climbing;
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
        // A stop is not a loss: nobody is told an engine died when the host
        // asked for it to go away.
        if (this.stopping) return;
        this.lastErrorValue = error;
        await this.safely(() => this.events.onEngineLost(error), "onEngineLost");
        if (this.stopping) return;
        const wait = attempt + 1 < ladder.length ? ladder[attempt] : undefined;
        if (wait === undefined) {
          this.setState("stopped");
          const detail = error instanceof EngineStartError ? error : null;
          const fatal = new EngineStartError(
            `engine failed to start after ${attempt + 1} attempt(s): ${error.message}`,
            detail?.exit ?? null,
            detail?.stderrTail ?? "",
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
   * that exists is not a daemon that speaks. It races the child's own death,
   * and when the child loses that race the error reports the **exit** — after
   * waiting for the exit to actually happen, because the stream's `end` beats
   * the process's `exit` and the exit code is the half a caller can act on.
   */
  private async spawnOnce(): Promise<void> {
    const child = spawn(this.config.vaultdBinary, [...this.config.vaultdArgs], {
      env: { ...process.env, ...this.config.env },
      // stderr is piped and forwarded verbatim to the host's own stderr rather
      // than inherited: the diagnostics still reach the operator, and the tail
      // is kept so the error that reports a start failure can carry the
      // daemon's own words instead of pointing at the transport.
      stdio: ["pipe", "pipe", "pipe"],
    });
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout) {
      child.kill("SIGKILL");
      throw new Error("the engine was spawned without its stdio pipes");
    }
    // **A write into a dead engine is expected, and must not be fatal.**
    // `VaultdClient.request` writes synchronously, so a request that races the
    // engine's death raises `EPIPE` on this pipe — asynchronously, with no
    // listener, which in Node is an uncaught exception that takes the host
    // down. The supervisor created the pipe, so the supervisor owns its
    // errors: the request itself is already failed by the stream and exit
    // doors with a typed `EngineLostError`, so there is nothing further to
    // report for a broken pipe. Anything else is unexpected and is said out
    // loud.
    stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
      this.warn(`the engine's stdin failed: ${error.message}`);
    });
    // Declared before the client so no callback can name `engine` in its own
    // temporal dead zone; assigned in the same synchronous run, before any
    // stream event can fire.
    let self: Engine | null = null;
    // Registered BEFORE the client's own `end` listener, so a typed
    // `EngineLostError` reaches the pending caller instead of the client's
    // generic transport message. Listener order is registration order.
    stdout.once("end", () => {
      const engine = self;
      if (!engine) return;
      engine.lost = true;
      engine.client.failAllPending(
        new EngineLostError(
          engine.everReady ? "vaultd restarted" : "the engine ended before it was ready",
          () => engine.exit,
        ),
      );
    });
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
        const engine = self;
        if (engine) this.onTransportFatal(engine, error);
      },
    });
    const engine: Engine = {
      child,
      client,
      stdin,
      watching: deferred(),
      ended: deferred(),
      everReady: false,
      lost: false,
      exited: false,
      exit: null,
      escalated: "none",
      stderrTail: "",
      subscription: null,
      opening: null,
      sawLiveEvent: false,
      queued: [],
      buffering: false,
      shuttingDown: null,
      failStartup: null,
    };
    self = engine;
    if (stderr) {
      stderr.setEncoding("utf8");
      // The same class of door as `stdin`'s: a pipe this supervisor created,
      // whose error would otherwise be an uncaught exception. Rare on a
      // readable stream, one line to close, and the diagnostics channel is a
      // poor place to lose the host.
      stderr.on("error", (error: Error) => {
        this.warn(`the engine's stderr failed: ${error.message}`);
      });
      stderr.on("data", (chunk: string) => {
        engine.stderrTail = (engine.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
        process.stderr.write(chunk);
      });
    }
    child.on("error", (error: Error) => {
      // A spawn that never happened: no stdout, so nothing will ever end and
      // the readiness request has to be failed by hand.
      client.failAllPending(error);
      client.close();
      engine.ended.resolve();
      engine.failStartup?.(error);
    });
    child.on("exit", (code, signal) => {
      engine.exited = true;
      engine.lost = true;
      engine.exit = { code, signal, escalated: engine.escalated };
      engine.ended.resolve();
      this.onChildExit(engine);
    });

    const failed = new Promise<never>((_resolve, reject) => {
      engine.failStartup = reject;
    });
    this.spawning = engine;
    try {
      await Promise.race([client.request("health"), failed]);
    } catch (thrown) {
      this.spawning = null;
      client.close();
      if (!engine.exited) child.kill("SIGKILL");
      // The exit is the diagnosis, so wait for it rather than reporting the
      // stream symptom that arrived first. A killed process always exits.
      await engine.ended.promise;
      throw new EngineStartError(
        `the engine exited ${describeExit(engine.exit)}`,
        engine.exit,
        engine.stderrTail,
        thrown,
      );
    }
    if (this.stopping) {
      // The host asked to stop while this engine was being born. Nobody else
      // can see it, so nobody else can shut it down.
      this.spawning = null;
      await this.shutdown(engine);
      throw new EngineStartError(
        "the supervisor stopped while the engine was starting",
        engine.exit,
        engine.stderrTail,
      );
    }
    engine.failStartup = null;
    engine.everReady = true;
    this.spawning = null;
    // From here the engine is the current one, and that identity — not a flag —
    // is what tells a later exit apart from a failed start attempt.
    this.engine = engine;
    // A fresh engine is a fresh slate: the previous engine's death must not be
    // handed to a caller asking about this one.
    this.lastErrorValue = null;
    this.liveStateValue = null;
    this.setState("running");
    await this.safely(() => this.events.onClientReady(client), "onClientReady");
    if (this.subscriptionWanted && this.engine === engine) {
      // A refusal here is the subscription's problem, not the engine's: the
      // engine is up and serving, and `subscribe`/`whenWatching` report the
      // refusal to whoever actually asked for one.
      await this.openSubscription(engine).catch((error: unknown) => {
        this.warn(`the supervisor could not subscribe to the engine: ${asError(error).message}`);
      });
    }
  }

  /**
   * Open this engine's one subscription, joining an open already in flight.
   *
   * Returning early on "somebody else is opening" is what made a healthy engine
   * look like it was refusing: the caller then read a still-null
   * `engine.subscription` as a refusal and dropped its own subscriber. Every
   * caller now awaits the same attempt and sees the same outcome.
   */
  private openSubscription(engine: Engine): Promise<void> {
    this.subscriptionWanted = true;
    if (engine.subscription) return Promise.resolve();
    engine.opening ??= this.runOpen(engine).finally(() => {
      engine.opening = null;
    });
    return engine.opening;
  }

  /**
   * One open attempt, and the restart debt if there is one.
   *
   * Order is the whole point. The subscription is installed first, so no event
   * of the new engine's is missed; the marker is delivered next, so the
   * consumer learns its view is stale before it sees anything built on the new
   * one; the events that arrived in between are released last, in order.
   */
  private async runOpen(engine: Engine): Promise<void> {
    // Recomputed here rather than trusted from restart time: a subscriber may
    // have arrived or left since, and only a subscriber that existed across the
    // restart is owed anything.
    const owed = this.resyncOwed && this.durable.size > 0;
    engine.buffering = owed;
    let handle: SubscriptionHandle;
    try {
      handle = await engine.client.subscribeEvents((event) => {
        this.onEngineEvent(engine, event);
      });
    } catch (thrown) {
      // No subscription, so the debt is still owed to the next engine, and
      // anything buffered belongs to nobody.
      engine.buffering = false;
      engine.queued = [];
      throw asError(thrown);
    }
    engine.subscription = handle;
    this.noteLiveState(engine, handle.liveState, "response");
    if (!owed) return;
    // The subscribe response's own start point is a generation the daemon
    // named, so the marker is honest even if the round trip below fails —
    // which is what stops a half-open subscription from losing its buffered
    // events and leaving the debt set for a restart that does not owe one.
    let generation = handle.startGeneration;
    try {
      const info = await engine.client.request<GetVaultInfoResponse>("get_vault_info");
      generation = info.generation;
    } catch (thrown) {
      this.warn(
        `the supervisor could not read the new engine's generation: ${asError(thrown).message}`,
      );
    }
    this.resyncOwed = false;
    engine.buffering = false;
    this.fanout({
      type: "resync_required",
      value: { current_generation: generation, reason: "runtime_recovered" },
    });
    const held = engine.queued;
    engine.queued = [];
    for (const event of held) this.fanout(event);
  }

  private onEngineEvent(engine: Engine, event: RuntimeEventDto): void {
    // Narrowed through the guard, not by comparing `type` alone: the event
    // union is open, and its unknown member's `type` is an unconstrained
    // string, so a bare comparison leaves `value` as `unknown`.
    if (isKnownRuntimeEvent(event) && event.type === "runtime_state_changed") {
      this.noteLiveState(engine, event.value.live_state, "event");
    }
    if (engine.buffering) engine.queued.push(event);
    else this.fanout(event);
  }

  private noteLiveState(engine: Engine, state: LiveStateDto, source: "event" | "response"): void {
    if (engine !== this.engine) return;
    // The response never overwrites what an event already said — see
    // `Engine.sawLiveEvent`. An event always wins, including one that reports
    // the runtime falling back out of `watching`, which is real news.
    if (source === "response" && engine.sawLiveEvent) return;
    if (source === "event") engine.sawLiveEvent = true;
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
    if (engine.exited || engine !== this.engine || this.stopping) return;
    this.lastErrorValue = error;
    engine.child.kill("SIGKILL");
  }

  private onChildExit(engine: Engine): void {
    // Never left hanging, and typed: a request whose engine is gone must fail,
    // because a shim write that never settles is indistinguishable from a
    // wedged plugin.
    engine.client.failAllPending(
      new EngineLostError(
        engine.everReady ? "vaultd restarted" : "the engine ended before it was ready",
        () => engine.exit,
      ),
    );
    engine.client.close();
    // Recorded for every engine, including one that died before it was ever
    // current: how the last process ended is diagnosis, and a failed start is
    // exactly when somebody wants it.
    this.lastExitValue = engine.exit;
    if (engine !== this.engine) {
      engine.failStartup?.(
        new EngineStartError(
          `the engine exited ${describeExit(engine.exit)} before it was ready`,
          engine.exit,
          engine.stderrTail,
        ),
      );
      return;
    }
    this.engine = null;
    this.liveStateValue = null;
    engine.watching.reject(new EngineLostError(`the engine exited ${describeExit(engine.exit)}`));
    if (this.stopping) return;
    this.restarts += 1;
    void this.restart(engine);
  }

  /** A running engine died. Report it, check the ceiling, then climb the ladder. */
  private async restart(lost: Engine): Promise<void> {
    const error = new EngineLostError(`vaultd exited ${describeExit(lost.exit)}`, lost.exit);
    this.lastErrorValue = error;
    await this.safely(() => this.events.onEngineLost(error), "onEngineLost");
    if (this.stopping) return;
    if (this.flapping()) return;
    this.setState("restarting");
    // The new engine owes every live subscriber a resync: their view was built
    // on a connection that no longer exists.
    this.resyncOwed = this.durable.size > 0;
    try {
      await this.runClimb();
    } catch {
      // `climb` has already recorded the failure and stopped the supervisor.
      // Nothing above this call is waiting on it — a crash long after `start()`
      // resolved has no promise to reject — so the state and `lastError()` are
      // the report.
    }
  }

  /**
   * Has the engine died more often than the ceiling allows?
   *
   * Readiness clears the *ladder* but not this window, because an engine that
   * answers `health` and then dies would otherwise restart forever, taking the
   * index's writer lease on every attempt. Tripping the ceiling stops the
   * supervisor for good; only an explicit `start()` lifts it.
   */
  private flapping(): boolean {
    const now = this.config.clock.now();
    this.restartTimes.push(now);
    this.restartTimes = this.restartTimes.filter(
      (at) => now - at < this.config.restartFlapWindowMs,
    );
    if (this.restartTimes.length <= this.config.restartFlapLimit) return false;
    const fatal = new EngineFlappingError(
      `vaultd restarted ${String(this.restartTimes.length)} times in ${String(this.config.restartFlapWindowMs)}ms; the supervisor is giving up`,
      this.restartTimes.length,
      this.config.restartFlapWindowMs,
    );
    this.lastErrorValue = fatal;
    this.stopping = true;
    this.setState("stopped");
    return true;
  }

  /** End one engine. Idempotent per engine: two callers await one shutdown. */
  private shutdown(engine: Engine): Promise<void> {
    engine.shuttingDown ??= this.runShutdown(engine);
    return engine.shuttingDown;
  }

  private runShutdown(engine: Engine): Promise<void> {
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
