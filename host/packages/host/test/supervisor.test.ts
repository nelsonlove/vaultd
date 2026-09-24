import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultHostConfig, systemClock } from "../src/config";
import { forwardingSink } from "../src/runtime/forwarding-sink";
import { EngineLostError, EngineStartError, Supervisor } from "../src/supervisor";
import type { HostConfig } from "../src/config";
import type { RuntimeEventDto } from "../src/client/events";
import { FakeClock } from "./fake-clock";
import { cleanupScratchRoots, scratchRoot } from "./scratch";

/**
 * The supervisor against a fake engine that is nevertheless a **real child
 * process**: `test/fixtures/fake-vaultd.js`, spawned through `process.execPath`.
 *
 * Nothing here sleeps. Every wait is a rendezvous on something the supervisor
 * or the fake actually did — a promise the supervisor returns, a callback it
 * fires, a timer it armed on the injected clock — because a spawn test that
 * waits a fixed number of milliseconds is a spawn test that fails on a loaded
 * machine and passes when nobody is looking.
 */
const fake = join(__dirname, "fixtures", "fake-vaultd.js");

/**
 * `env` is a real `HostConfig` field, so this spread type-checks and the value
 * actually reaches the spawned child. Without it the modes below would all
 * spawn the same "ok" daemon and the cases would silently assert nothing.
 */
// **The roots are `scratchRoot`'s now**, under `target/tmp`, swept per file by
// `test/scratch-setup.ts` — a case no longer has to remember to register one.
// This `afterEach` stays because it also has to run **between** cases: a
// supervisor spawns a real child that holds its root open, and a file's worth
// of them is not what this file's cases mean by "a fresh daemon".
afterEach(() => {
  cleanupScratchRoots();
});

function configFor(mode: string, overrides: Partial<HostConfig> = {}): HostConfig {
  const root = scratchRoot("vaultd-sup-");
  return {
    ...defaultHostConfig(root),
    vaultdBinary: process.execPath,
    vaultdArgs: [fake],
    restartBackoffMs: [1, 1, 1],
    clock: systemClock(), // real process spawning, real waits
    env: { FAKE_VAULTD_MODE: mode },
    ...overrides,
  };
}

const silent = {
  onClientReady: (): void => {},
  onEngineLost: (): void => {},
  onStateChange: (): void => {},
};

/** Resolve when `predicate` holds, checked once per macrotask turn. */
function until(predicate: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = (): void => {
      if (predicate()) resolve();
      else setImmediate(check);
    };
    check();
  });
}

describe("Supervisor", () => {
  it("passes config.env through to the spawned engine", async () => {
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    // The fake echoes its own view of FAKE_VAULTD_MODE back through
    // get_vault_info's vault_identity, so this asserts the env actually crossed
    // the process boundary rather than that the object had a key.
    await expect(
      supervisor.client().request<{ vault_identity: string }>("get_vault_info"),
    ).resolves.toMatchObject({ vault_identity: "fake:ok" });
    await supervisor.stop();
  });

  it("spawns the engine and answers health through the client", async () => {
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    expect(supervisor.state()).toBe("running");
    expect(supervisor.pid()).toBeGreaterThan(0);
    await expect(supervisor.client().request("health")).resolves.toEqual({
      service: "vaultd",
      status: "ok",
    });
    await supervisor.stop();
    expect(supervisor.state()).toBe("stopped");
  });

  it("restarts a dying engine and calls onEngineLost then onClientReady", async () => {
    const order: string[] = [];
    let ready = 0;
    const supervisor = new Supervisor(configFor("die-after-health"), {
      onClientReady: () => {
        ready += 1;
        order.push("ready");
      },
      onEngineLost: () => {
        order.push("lost");
      },
      onStateChange: (state) => order.push(`state:${state}`),
    });
    await supervisor.start();
    await supervisor.client().request("health").catch(() => undefined);
    // Both conditions, because `restartCount` rises the moment the child dies
    // and the replacement is not ready yet at that instant — waiting on the
    // count alone would assert `ready >= 2` against a race it usually loses.
    await until(() => supervisor.restartCount() >= 1 && ready >= 2);
    expect(order).toContain("lost");
    expect(order).toContain("state:restarting");
    expect(ready).toBeGreaterThanOrEqual(2);
    await supervisor.stop();
    expect(supervisor.state()).toBe("stopped");
  });

  it("gives up after the backoff ladder is exhausted", async () => {
    let lost = 0;
    const supervisor = new Supervisor(configFor("exit-immediately"), {
      ...silent,
      onEngineLost: () => {
        lost += 1;
      },
    });
    await expect(supervisor.start()).rejects.toThrow(/engine failed to start/);
    // One attempt per rung: three rungs, three losses, and the last rung is
    // never waited on because no attempt follows it.
    expect(lost).toBe(3);
    expect(supervisor.state()).toBe("stopped");
    expect(supervisor.lastError()?.message).toMatch(/engine failed to start/);
  });

  it("takes every backoff wait from config.clock, and never waits the last rung", async () => {
    // The Global Constraint made observable: the ladder's waits are asked of
    // the injected clock, so this whole case runs with no wall-clock time
    // passing at all. A supervisor reaching for the global `setTimeout` would
    // hang here instead, which is exactly the failure that should be loud.
    const clock = new FakeClock();
    const config = configFor("exit-immediately", {
      restartBackoffMs: [5_000, 30_000, 60_000],
      clock,
    });
    let lost = 0;
    const supervisor = new Supervisor(config, {
      ...silent,
      onEngineLost: () => {
        lost += 1;
      },
    });
    const started = supervisor.start();
    const rejected = expect(started).rejects.toThrow(/engine failed to start/);
    await clock.armed(1);
    expect(supervisor.state()).toBe("restarting");
    clock.advance(5_000);
    await clock.armed(2);
    clock.advance(30_000);
    await rejected;
    expect(clock.armedWaits()).toEqual([5_000, 30_000]);
    expect(lost).toBe(3);
    expect(clock.pending()).toBe(0);
  });

  it("becomes ready on the runtime reaching watching, not on the spawn", async () => {
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    // The engine is spawned and answering, and the runtime is still catching
    // up: a subscription that opens now reports `catching_up`, exactly as a
    // cold real vault does. Readiness is the daemon's own announcement that
    // the catch-up finished, never the fact that a process exists.
    expect(supervisor.state()).toBe("running");
    expect(supervisor.liveState()).toBeNull();
    const watching = supervisor.whenWatching();
    await watching;
    expect(supervisor.liveState()).toBe("watching");
    await supervisor.stop();
  });

  it("resolves readiness from the subscribe response when the runtime is already watching", async () => {
    const supervisor = new Supervisor(
      configFor("ok", { env: { FAKE_VAULTD_MODE: "ok", FAKE_VAULTD_LIVE_STATE: "watching" } }),
      silent,
    );
    await supervisor.start();
    await supervisor.whenWatching();
    expect(supervisor.liveState()).toBe("watching");
    await supervisor.stop();
  });

  it("keeps a subscription across a restart and leads with one synthesized resync", async () => {
    const seen: RuntimeEventDto[] = [];
    let ready = 0;
    const supervisor = new Supervisor(configFor("ok"), {
      ...silent,
      onClientReady: () => {
        ready += 1;
      },
    });
    await supervisor.start();
    await supervisor.subscribe((event) => seen.push(event));
    await supervisor.whenWatching();
    seen.length = 0;
    // A crash at a moment this test chooses. The request never gets an answer:
    // a crash is not a refusal, and the in-flight request must fail rather
    // than hang.
    await expect(supervisor.client().request("die")).rejects.toThrow();
    await until(() => supervisor.restartCount() >= 1 && seen.length > 0);
    expect(ready).toBe(2);
    // The marker leads: the consumer learns its view is stale BEFORE any event
    // of the new engine's reaches it.
    expect(seen[0]).toEqual({
      type: "resync_required",
      value: { current_generation: 1, reason: "runtime_recovered" },
    });
    // And the new engine's own subscription is live behind it.
    await until(() => seen.some((event) => event.type === "runtime_state_changed"));
    await supervisor.stop();
  });

  it("stops by closing stdin, and the child exits on the EOF alone", async () => {
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    await supervisor.stop();
    // Exit code 0 with no signal is the whole point: the child ended because
    // its stdin closed, not because the supervisor had to escalate. That is
    // what stops a host crash from leaving an orphan holding the writer lease.
    expect(supervisor.lastExit()).toEqual({ code: 0, signal: null, escalated: "none" });
    expect(supervisor.pid()).toBeNull();
  });

  it("is idempotent to stop, and refuses to hand out a client once stopped", async () => {
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    await supervisor.stop();
    await supervisor.stop();
    expect(supervisor.state()).toBe("stopped");
    expect(() => supervisor.client()).toThrow(/no engine/);
    expect(supervisor.restartCount()).toBe(0);
  });

  /**
   * The no-engine window is typed, on every road out of the supervisor.
   *
   * The Mirror has always converted this into {@link EngineLostError} at its
   * own client seam, because a bare `Error` was a different kind of failure
   * from the one every other layer knows how to wait out. The shim's road does
   * not go through the Mirror: `runtime/forwarding-sink.ts` resolves the
   * supplier per call and deliberately lets a supplier throw travel, so a
   * plugin whose call was in flight when the supervisor replaced the engine met
   * an untyped `Error` where everyone else met the typed one. Typing it at the
   * source is what makes the refusal the same on both roads; the message is
   * unchanged, so anything matching on it still matches.
   */
  it("refuses with a typed EngineLostError on every road, not a bare Error", async () => {
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    await supervisor.stop();

    expect(() => supervisor.client()).toThrow(EngineLostError);
    // The engine that is gone is still describable, which is the difference
    // between a typed refusal and a sentence: a caller can read how it ended.
    try {
      supervisor.client();
      expect.unreachable("client() must throw with no engine");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineLostError);
      expect((error as EngineLostError).exit).toEqual(supervisor.lastExit());
    }
    await expect(supervisor.whenWatching()).rejects.toThrow(EngineLostError);

    // The shim's own road: one sink over the same supplier, which is exactly
    // what `assembleShim` hands every shim surface.
    const sink = forwardingSink(() => supervisor.client());
    await expect(sink.request("health")).rejects.toThrow(EngineLostError);
  });

  it("does not restart an engine that exits after stop", async () => {
    const lost: Error[] = [];
    const supervisor = new Supervisor(configFor("ok"), {
      ...silent,
      onEngineLost: (error) => {
        lost.push(error);
      },
    });
    await supervisor.start();
    await supervisor.stop();
    await until(() => supervisor.state() === "stopped");
    expect(lost).toEqual([]);
    expect(supervisor.restartCount()).toBe(0);
  });
});

/**
 * Every child process of this test process, asked of the operating system.
 *
 * The supervisor's engines are direct children of the vitest worker, so this
 * counts engines — including the ones the supervisor has lost track of, which
 * is the only way to see a double spawn at all. `pgrep` exits 1 when nothing
 * matches, which is an answer, not a failure.
 */
function childPids(): number[] {
  try {
    return execFileSync("/usr/bin/pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => Number(line.trim()));
  } catch {
    return [];
  }
}

/** Does the operating system still know this pid? The orphan question. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The error paths, which is where every finding of the first review lived.
 *
 * The happy path of `subscribe` was the only path the first cut covered, and
 * all three blocking defects were one turn away from it: a second subscriber in
 * the same turn, a subscriber that arrives before the engine, and a `stop()`
 * that lands inside a spawn.
 */
describe("Supervisor error paths", () => {
  it("attaches both subscribers when two subscribes overlap in one turn", async () => {
    const first: RuntimeEventDto[] = [];
    const second: RuntimeEventDto[] = [];
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    const handles = await Promise.all([
      supervisor.subscribe((event) => first.push(event)),
      supervisor.subscribe((event) => second.push(event)),
    ]);
    await supervisor.whenWatching();
    await until(() => first.length > 0 && second.length > 0);
    // One daemon-side subscription, two consumers of it.
    expect(supervisor.client().subscriptionCount()).toBe(1);
    await handles[0].close();
    await supervisor.stop();
  });

  it("attaches a subscriber that arrives in the same turn as whenWatching", async () => {
    const seen: RuntimeEventDto[] = [];
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    // The natural consumer order — ask for readiness, then subscribe — and the
    // one the first cut rejected as "the engine refused a subscription".
    const watching = supervisor.whenWatching();
    await supervisor.subscribe((event) => seen.push(event));
    await watching;
    await until(() => seen.length > 0);
    expect(supervisor.liveState()).toBe("watching");
    await supervisor.stop();
  });

  it("attaches a subscriber that arrives before the engine does", async () => {
    const seen: RuntimeEventDto[] = [];
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.subscribe((event) => seen.push(event));
    await supervisor.start();
    await supervisor.whenWatching();
    await until(() => seen.length > 0);
    await supervisor.stop();
  });

  it("attaches a subscriber that arrives during a restart with nobody else subscribed", async () => {
    const seen: RuntimeEventDto[] = [];
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    await expect(supervisor.client().request("die")).rejects.toThrow();
    // No engine exists at this instant, and no other subscriber owes a resync.
    // The handle must still be live when the replacement arrives.
    await supervisor.subscribe((event) => seen.push(event));
    await until(() => seen.length > 0);
    expect(supervisor.restartCount()).toBe(1);
    await supervisor.stop();
  });

  it("attaches a subscriber that arrives while the restart is re-opening", async () => {
    const late: RuntimeEventDto[] = [];
    const early: RuntimeEventDto[] = [];
    let ready = 0;
    const pending: Array<Promise<unknown>> = [];
    const supervisor = new Supervisor(configFor("ok"), {
      ...silent,
      onClientReady: () => {
        ready += 1;
        // Inside the very turn the restart declares the new engine ready — the
        // window where an open is in flight and the first cut threw the dead
        // engine's error at a live one.
        if (ready === 2) pending.push(supervisor.subscribe((event) => late.push(event)));
      },
    });
    await supervisor.start();
    await supervisor.subscribe((event) => early.push(event));
    await expect(supervisor.client().request("die")).rejects.toThrow();
    await until(() => ready >= 2 && pending.length > 0);
    await Promise.all(pending);
    await until(() => late.length > 0 && early.length > 0);
    await supervisor.stop();
  });

  it("kills the engine it was spawning when stop lands mid-spawn", async () => {
    const pidfile = join(scratchRoot("vaultd-sup-pid-"), "engine.pid");
    const states: string[] = [];
    const supervisor = new Supervisor(
      configFor("slow-health", {
        env: {
          FAKE_VAULTD_MODE: "slow-health",
          FAKE_VAULTD_HEALTH_DELAY_MS: "400",
          FAKE_VAULTD_PIDFILE: pidfile,
        },
      }),
      {
        ...silent,
        onStateChange: (state) => states.push(state),
      },
    );
    const started = supervisor.start();
    await until(() => existsSync(pidfile) && readFileSync(pidfile, "utf8").length > 0);
    const pid = Number(readFileSync(pidfile, "utf8"));
    expect(alive(pid)).toBe(true);
    await supervisor.stop();
    await started;
    expect(supervisor.state()).toBe("stopped");
    // The orphan question asked of the operating system, not of the supervisor:
    // a surviving child here would hold the index's writer lease for the life
    // of the host.
    await until(() => !alive(pid));
    expect(states).not.toContain("running");
  });

  it("coalesces two concurrent start calls into one engine", async () => {
    let ready = 0;
    const supervisor = new Supervisor(configFor("ok"), {
      ...silent,
      onClientReady: () => {
        ready += 1;
      },
    });
    await Promise.all([supervisor.start(), supervisor.start()]);
    expect(ready).toBe(1);
    const pid = supervisor.pid();
    expect(pid).toBeGreaterThan(0);
    await supervisor.stop();
    await until(() => !alive(pid!));
    expect(ready).toBe(1);
  });

  it("names the engine's exit in the start failure, and carries its stderr", async () => {
    const supervisor = new Supervisor(configFor("exit-immediately"), silent);
    const thrown: unknown = await supervisor.start().then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(EngineStartError);
    const failure = thrown as EngineStartError;
    // The exit is what the host needs — "the lease is held" and "the binary
    // refused its arguments" are both exits, and neither is a transport fault.
    expect(failure.message).toMatch(/engine failed to start/);
    expect(failure.message).toMatch(/code 3/);
    expect(failure.exit?.code).toBe(3);
    expect(failure.stderrTail).toContain("refusing to start");
    expect(failure.leaseHeld).toBe(false);
  });

  it("fails a request in flight across a crash with a typed engine-lost error", async () => {
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    const thrown: unknown = await supervisor
      .client()
      .request("die")
      .then(
        () => null,
        (error: unknown) => error,
      );
    // Typed and deterministic: not whichever of the stream's end and the
    // process's exit happened to win.
    expect(thrown).toBeInstanceOf(EngineLostError);
    expect((thrown as Error).message).toMatch(/vaultd restarted/);
    await supervisor.stop();
  });

  it("stops when the engine flaps faster than the ceiling allows", async () => {
    let ready = 0;
    const supervisor = new Supervisor(
      configFor("die-after-health", { restartFlapLimit: 3, restartFlapWindowMs: 60_000 }),
      {
        ...silent,
        onClientReady: () => {
          ready += 1;
        },
      },
    );
    await supervisor.start();
    await supervisor.client().request("health").catch(() => undefined);
    await until(() => supervisor.state() === "stopped");
    // Three restarts are allowed inside the window; the fourth is the ceiling.
    expect(supervisor.restartCount()).toBe(4);
    expect(ready).toBe(4);
    expect(supervisor.pid()).toBeNull();
    expect(supervisor.lastError()?.message).toMatch(/restarted 4 times/);
  });

  it("keeps the buffered events and clears the debt when get_vault_info fails mid-open", async () => {
    const seen: RuntimeEventDto[] = [];
    const supervisor = new Supervisor(configFor("no-vault-info"), silent);
    await supervisor.start();
    await supervisor.subscribe((event) => seen.push(event));
    // `whenWatching` resolves from inside the delivery of the event that
    // announces it, so by here the first engine's one event is already in the
    // list and clearing cannot race it.
    await supervisor.whenWatching();
    seen.length = 0;
    await expect(supervisor.client().request("die")).rejects.toThrow();
    await until(() => supervisor.restartCount() >= 1 && seen.length >= 2);
    // The generation falls back to the subscribe response's own start point,
    // which is a real generation the daemon named; nothing is invented and
    // nothing that arrived during the round trip is dropped.
    expect(seen[0]).toEqual({
      type: "resync_required",
      value: { current_generation: 1, reason: "runtime_recovered" },
    });
    expect(seen.some((event) => event.type === "runtime_state_changed")).toBe(true);
    await supervisor.stop();
  });

  it("reports the engine's own refusal to subscribe, and stays usable after it", async () => {
    const supervisor = new Supervisor(configFor("no-subscribe"), silent);
    await supervisor.start();
    await expect(supervisor.subscribe(() => undefined)).rejects.toThrow(/no runtime to subscribe/);
    // Not poisoned: a second attempt is a real second attempt, and it fails
    // with this engine's own answer rather than a remembered one.
    await expect(supervisor.whenWatching()).rejects.toThrow(/no runtime to subscribe/);
    await expect(supervisor.client().request("health")).resolves.toEqual({
      service: "vaultd",
      status: "ok",
    });
    expect(supervisor.state()).toBe("running");
    await supervisor.stop();
  });

  it("settles every request that races an engine's death, and survives the writes", async () => {
    const supervisor = new Supervisor(configFor("die-after-health"), silent);
    await supervisor.start();
    const client = supervisor.client();
    // The engine exits as it answers the first of these, so the rest are
    // written into a pipe whose reader is going away. Two invariants at once:
    // nothing is left hanging, and the writes themselves are survivable —
    // `EPIPE` arrives asynchronously on a stream the supervisor created, and
    // with no listener there Node turns it into an uncaught exception that
    // takes the host down. That is what the full suite caught before this was
    // fixed: one unhandled error beside 128 passing tests. Provoking the
    // `EPIPE` itself is a race by nature, which is why the assertions below
    // are the invariants rather than the errno.
    const results = await Promise.allSettled([
      client.request("health"),
      client.request("health"),
      client.request("health"),
    ]);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(EngineLostError);
    }
    // And nothing about it damaged the supervisor: the replacement arrives.
    await until(() => supervisor.restartCount() >= 1);
    await supervisor.stop();
  }, 15_000);

  it("runs one climb at a time, even when start races an in-flight restart", async () => {
    let ready = 0;
    // `slow-health` widens the window this case aims at: the replacement takes
    // 400 ms to answer its readiness probe, so "the restart is in flight" is a
    // state a test can be inside of rather than a moment it has to hit.
    const supervisor = new Supervisor(
      configFor("slow-health", { restartBackoffMs: [50, 50, 50] }),
      {
        ...silent,
        onClientReady: () => {
          ready += 1;
        },
      },
    );
    // A clean slate, so the child count below is this case's own.
    await until(() => childPids().length === 0);
    await supervisor.start();
    await expect(supervisor.client().request("die")).rejects.toThrow();
    await until(() => supervisor.state() === "restarting");
    // Inside the restart window: `this.engine` is null and the restart's climb
    // is not the one `start()` remembers, so an explicit start here used to
    // open a second, parallel climb — two live engines, of which the
    // supervisor tracked one and `stop()` could only end that one.
    await supervisor.start();
    await until(() => supervisor.state() === "running");
    expect(ready).toBe(2);
    expect(childPids()).toHaveLength(1);
    await supervisor.stop();
    // Nothing survives the stop: the orphan question, asked of the operating
    // system rather than of the supervisor.
    await until(() => childPids().length === 0);
    expect(supervisor.state()).toBe("stopped");
  }, 15_000);

  it("classifies the lease refusal on the exit code as well as the message", async () => {
    const held = new Supervisor(
      configFor("refuse", {
        restartBackoffMs: [1],
        env: {
          FAKE_VAULTD_MODE: "refuse",
          FAKE_VAULTD_EXIT_CODE: "2",
          FAKE_VAULTD_STDERR_LINE: "vaultd: index storage is already in use by another writer",
        },
      }),
      silent,
    );
    const refusal: unknown = await held.start().then(
      () => null,
      (error: unknown) => error,
    );
    expect((refusal as EngineStartError).exit?.code).toBe(2);
    expect((refusal as EngineStartError).leaseHeld).toBe(true);

    // The same sentence, a different exit code: not the lease. The message
    // alone is a string nothing on the daemon side pins, so a reworded
    // diagnostic must not be able to flip this on its own — and neither must
    // some other failure that happens to quote it.
    const impostor = new Supervisor(
      configFor("refuse", {
        restartBackoffMs: [1],
        env: {
          FAKE_VAULTD_MODE: "refuse",
          FAKE_VAULTD_EXIT_CODE: "3",
          FAKE_VAULTD_STDERR_LINE: "vaultd: index storage is already in use by another writer",
        },
      }),
      silent,
    );
    const other: unknown = await impostor.start().then(
      () => null,
      (error: unknown) => error,
    );
    expect((other as EngineStartError).exit?.code).toBe(3);
    expect((other as EngineStartError).leaseHeld).toBe(false);
  }, 15_000);

  it("resolves the lost engine's exit once the process has actually exited", async () => {
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    const thrown: unknown = await supervisor
      .client()
      .request("die")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(thrown).toBeInstanceOf(EngineLostError);
    // The stream's `end` beats the process's `exit`, so at the instant this
    // error is raised there is no exit code yet. Reading it later gets the
    // real one rather than a permanent null.
    await until(() => supervisor.restartCount() >= 1);
    expect((thrown as EngineLostError).exit?.code).toBe(9);
    await supervisor.stop();
  }, 15_000);

  it("keeps one subscriber's throw off every other subscriber", async () => {
    const errors: Error[] = [];
    const quiet: RuntimeEventDto[] = [];
    const supervisor = new Supervisor(configFor("ok"), silent);
    await supervisor.start();
    // Both in the same turn, because this fake emits exactly one event: a
    // subscriber that attaches after that event has been delivered correctly
    // receives nothing, and awaiting the first subscribe before starting the
    // second loses the race about one run in ten. `subscribe` adds to the
    // fan-out synchronously, so issuing both here attaches both before any
    // event can be routed.
    await Promise.all([
      supervisor.subscribe(
        () => {
          throw new Error("subscriber is broken");
        },
        (error) => errors.push(error),
      ),
      supervisor.subscribe((event) => quiet.push(event)),
    ]);
    await supervisor.whenWatching();
    await until(() => quiet.length > 0 && errors.length > 0);
    expect(errors[0]?.message).toBe("subscriber is broken");
    await expect(supervisor.client().request("health")).resolves.toBeTruthy();
    await supervisor.stop();
  });
});
