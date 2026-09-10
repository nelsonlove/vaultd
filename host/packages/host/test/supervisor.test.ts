import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { defaultHostConfig, systemClock } from "../src/config";
import { Supervisor } from "../src/supervisor";
import type { HostConfig } from "../src/config";
import type { RuntimeEventDto } from "../src/client/events";
import { FakeClock } from "./fake-clock";

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
function configFor(mode: string, overrides: Partial<HostConfig> = {}): HostConfig {
  const root = mkdtempSync(join(tmpdir(), "vaultd-sup-"));
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
