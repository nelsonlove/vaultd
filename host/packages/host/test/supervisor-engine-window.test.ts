/**
 * The `auto` reconnect window, counted rung by rung on an injected clock.
 *
 * The spec's `auto` bullet is not "probe, then spawn": it is "on a dropped
 * connection, retry the probe with the existing restart backoff, **and spawn
 * only if the socket stays absent for the whole window**". The difference is
 * the whole behaviour when the owner of a shared daemon restarts it — every
 * connected host either waits the daemon out, or races the daemon's own unlink
 * and the index's writer lease to bind the one path it is about to bind again.
 * Counting that requires a clock a test moves, so this file uses
 * {@link FakeClock} and a fake daemon **on a socket**, and never spawns a real
 * one.
 *
 * **The timer-index shift, written down once.** A probe arms a timer on
 * `config.clock` (its 500 ms read deadline) and clears it the instant an answer
 * or a refusal arrives. So under `auto` the arming order is: one timer per
 * probe, then one per ladder rung — which is why `test/supervisor.test.ts`,
 * whose ladder cases count `clock.armed(n)` against phase 6's arming order, is
 * pinned to `engine: "spawn"` rather than rewritten. This file is where the
 * `auto` order lives instead.
 */

import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Server, Socket } from "node:net";

import { FakeClock } from "./fake-clock";
import { cleanupScratchRoots, scratchRoot } from "./scratch";
import { defaultHostConfig } from "../src/config";
import { EngineLostError, Supervisor } from "../src/supervisor";
import type { HostConfig } from "../src/config";

const FAKE_VAULTD = resolve(__dirname, "fixtures", "fake-vaultd.js");

const running: Supervisor[] = [];
const servers: FakeDaemon[] = [];

afterEach(async () => {
  for (const supervisor of running.splice(0)) await supervisor.stop();
  for (const server of servers.splice(0)) await server.close();
  cleanupScratchRoots();
});

/**
 * A daemon on a Unix socket, answering the four methods a supervisor asks for.
 *
 * In-process rather than the `fake-vaultd.js` child, because that fixture
 * speaks stdio and this file is about the socket. It is deliberately dumb: it
 * answers `health`, `get_vault_info` and `subscribe_events`, and **ignores**
 * anything else — which is what makes a request that is in flight when the
 * connection drops a deterministic fixture rather than a race.
 */
class FakeDaemon {
  private server: Server | null = null;
  private readonly accepted: Socket[] = [];

  constructor(
    readonly path: string,
    private readonly canonicalRoot: string,
  ) {}

  async listen(): Promise<void> {
    const server = createServer((socket) => {
      this.accepted.push(socket);
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        for (;;) {
          const at = buffered.indexOf("\n");
          if (at < 0) break;
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          if (line.trim()) this.answer(socket, line);
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((settle, fail) => {
      server.once("error", fail);
      server.listen(this.path, () => {
        server.removeListener("error", fail);
        settle();
      });
    });
    this.server = server;
  }

  /** Every connection dropped and the path unlinked: the daemon is gone. */
  async close(): Promise<void> {
    for (const socket of this.accepted.splice(0)) socket.destroy();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((settle) => server.close(() => settle()));
  }

  /** Drop the connections and keep listening: a client this daemon hung up on. */
  dropConnections(): void {
    for (const socket of this.accepted.splice(0)) socket.destroy();
  }

  private answer(socket: Socket, line: string): void {
    const envelope = JSON.parse(line) as { id: string; request: { method: string } };
    const send = (type: string, value: unknown): void => {
      socket.write(
        `${JSON.stringify({ version: 1, id: envelope.id, outcome: { status: "ok", value: { type, value } } })}\n`,
      );
    };
    switch (envelope.request.method) {
      case "health":
        send("health", { service: "vaultd", status: "ok" });
        return;
      case "get_vault_info":
        send("get_vault_info", {
          generation: 7,
          canonical_root: this.canonicalRoot,
          vault_identity: "fake-socket-daemon",
          state: { state: "ready" },
          note_count: 0,
          refreshed_at_unix_ms: 0,
          live_state: "watching",
          socket_path: this.path,
        });
        return;
      case "subscribe_events":
        send("subscribe_events", {
          subscription_id: "fake-sub-1",
          generation: 7,
          live_state: "watching",
        });
        return;
      default:
        // Answered by nobody, on purpose. See the class comment.
        return;
    }
  }
}

interface Fixture {
  readonly config: HostConfig;
  readonly clock: FakeClock;
  readonly daemon: FakeDaemon;
  readonly lost: Error[];
  readonly supervisor: Supervisor;
}

/** A supervisor under `auto`, a three-rung ladder, and a daemon on its socket. */
function fixture(): Fixture {
  const root = scratchRoot("w-");
  const vault = join(root, "v");
  mkdirSync(vault, { recursive: true });
  const clock = new FakeClock();
  const config: HostConfig = {
    ...defaultHostConfig(vault),
    engine: "auto",
    engineSocketPath: join(root, "e.sock"),
    clock,
    // Three rungs, so "not the last one" and "the last one" are both reachable
    // and distinguishable. The durations are the clock's, not the machine's.
    restartBackoffMs: [100, 200, 400],
    vaultdBinary: process.execPath,
    vaultdArgs: [FAKE_VAULTD],
    env: { FAKE_VAULTD_MODE: "ok", FAKE_VAULTD_LIVE_STATE: "watching" },
  };
  const lost: Error[] = [];
  const supervisor = new Supervisor(config, {
    onClientReady: (): void => {},
    onEngineLost: (error): void => {
      lost.push(error);
    },
    onStateChange: (): void => {},
  });
  running.push(supervisor);
  const daemon = new FakeDaemon(config.engineSocketPath, config.vaultRoot);
  servers.push(daemon);
  return { config, clock, daemon, lost, supervisor };
}

/** Rendezvous on a condition, never a sleep. */
async function until(holds: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((settle) => setImmediate(settle));
  }
}

describe("the auto reconnect window", () => {
  it("waits out the window and reconnects, without ever spawning", async () => {
    const { clock, daemon, lost, supervisor } = fixture();
    await daemon.listen();
    await supervisor.start();
    expect(supervisor.engineSource()).toBe("connected");

    // The owner restarts its daemon: the socket goes away and comes back.
    await daemon.close();
    // One loss, reported once. Rung 0's probe finds nothing and the ladder
    // waits — the timer below is that wait, and it is armed after the probe's
    // own deadline timer, which is the arming order this file exists to pin.
    await clock.armed(3);
    expect(supervisor.pid()).toBeNull();
    expect(supervisor.engineSource()).toBeNull();

    await daemon.listen();
    clock.advance(100);
    await until(() => supervisor.engineSource() !== null, "the host to find the daemon again");

    expect(supervisor.engineSource()).toBe("connected");
    // **Never spawned.** A connected engine has no child, so a pid here would
    // mean the ladder gave up on the window and started a daemon of its own.
    expect(supervisor.pid()).toBeNull();
    // **Exactly one loss**: the rungs spent waiting are the same outage, not
    // new ones, and a consumer counting engine losses must not count four.
    expect(lost.length).toBe(1);
    expect(lost[0]).toBeInstanceOf(EngineLostError);
  });

  it("spawns with --listen only after the last rung of the window", async () => {
    const { config, clock, daemon, lost, supervisor } = fixture();
    await daemon.listen();
    await supervisor.start();
    expect(supervisor.engineSource()).toBe("connected");

    // This time the daemon does not come back.
    await daemon.close();
    await clock.armed(3);
    expect(supervisor.pid()).toBeNull();

    // Rung 1: still absent, still no spawn — the window is not over.
    clock.advance(100);
    await clock.armed(5);
    expect(supervisor.pid()).toBeNull();
    expect(supervisor.engineSource()).toBeNull();

    // Rung 2 is the last the ladder allows, so the window has passed.
    clock.advance(200);
    await until(() => supervisor.engineSource() !== null, "the host to spawn its own daemon");
    expect(supervisor.engineSource()).toBe("spawned");
    expect(supervisor.pid()).not.toBeNull();
    expect(lost.length).toBe(1);
    // The daemon it started is the shareable kind, at the path it probed.
    expect(config.engine).toBe("auto");
  });

  it("fails a request in flight when the connection drops, with the typed error", async () => {
    const { daemon, supervisor } = fixture();
    await daemon.listen();
    await supervisor.start();

    // `get_note` is the one method this daemon never answers, so the request
    // is genuinely in flight when the socket goes — no race, no timing.
    const pending = supervisor.client().request("get_note", { path: "A.md" });
    daemon.dropConnections();
    await expect(pending).rejects.toBeInstanceOf(EngineLostError);
  });

  it("says the connection closed, rather than that vaultd exited unseen", async () => {
    // A dropped socket is not an exit, and `describeExit(null)` words it as
    // "for reasons the supervisor never saw" — the least useful sentence
    // available about the most likely failure in this phase.
    const { daemon, lost, supervisor } = fixture();
    await daemon.listen();
    await supervisor.start();
    daemon.dropConnections();
    await until(() => lost.length > 0, "the loss to be reported");
    expect(lost[0]?.message).toContain("the engine connection to");
    expect(lost[0]?.message).not.toContain("never saw");
  });
});
