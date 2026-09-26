/**
 * The three engine modes against the **real** `vaultd`.
 *
 * Every fact here is a fact about the shipped daemon and cannot be proved
 * against a fake one: that `--listen` makes a daemon discoverable, that a
 * second host finds it rather than fighting it for the index's writer lease,
 * that dropping a connection leaves the daemon serving everyone else, and that
 * killing it takes the connected host down the same `EngineLostError` road a
 * killed child already took it down.
 *
 * **Every path is inside the scratch root**, `engineSocketPath` included, so no
 * run touches the developer's own XDG run directory and two runs never collide.
 * The names are short on purpose: this worktree's own path is 61 bytes of the
 * ~104-byte `sockaddr_un` limit on Darwin, and `run/vaultd.sock` under a
 * `mkdtemp` directory would spend the rest.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultHostConfig, systemClock } from "../src/config";
import { EngineLostError } from "../src/supervisor";
import { probeEngineSocket } from "../src/engine-probe";
import {
  BINARY,
  BINARY_EXISTS,
  cleanupRealDaemons,
  scratchRoot,
  startedOn,
  superviseOn,
} from "./real-daemon";
import type { GetVaultInfoResponse } from "../src/client/protocol";
import type { HostConfig } from "../src/config";

afterEach(async () => {
  await cleanupRealDaemons();
});

/** A config over a one-note scratch vault, with every path inside target/tmp. */
function configFor(mode: HostConfig["engine"]): HostConfig {
  const root = scratchRoot("em-");
  const vault = join(root, "v");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "One.md"), "# One\n");
  const base = defaultHostConfig(vault);
  return {
    ...base,
    vaultdBinary: BINARY,
    clock: systemClock(),
    dataDir: join(root, "state"),
    socketPath: join(root, "state", "host.sock"),
    // Inside the scratch root, so a run never writes to the developer's own
    // XDG run directory and two runs never collide.
    engineSocketPath: join(root, "r", "e.sock"),
    indexPath: join(root, "i.db"),
    vaultdArgs: ["--vault", vault, "--index", join(root, "i.db")],
    engine: mode,
    // These cases fail by exhausting the ladder on purpose; the real first
    // rung would be a quarter second of nothing per attempt.
    restartBackoffMs: [50, 50, 50],
  };
}

describe.skipIf(!BINARY_EXISTS)("engine modes", () => {
  it("spawn never probes and never passes --listen", async () => {
    const config = configFor("spawn");
    const supervisor = await startedOn(config);
    expect(supervisor.engineSource()).toBe("spawned");
    expect(existsSync(config.engineSocketPath)).toBe(false);
    const info = await supervisor.client().request<GetVaultInfoResponse>("get_vault_info");
    expect(info.socket_path ?? null).toBeNull();
  });

  it("auto spawns with --listen when nothing answers, and says so", async () => {
    const config = configFor("auto");
    const supervisor = await startedOn(config);
    expect(supervisor.engineSource()).toBe("spawned");
    const info = await supervisor.client().request<GetVaultInfoResponse>("get_vault_info");
    expect(info.socket_path).toBe(config.engineSocketPath);
    expect(existsSync(config.engineSocketPath)).toBe(true);
  });

  it("auto connects to a daemon that is already there", async () => {
    const config = configFor("auto");
    const first = await startedOn(config);
    expect(first.engineSource()).toBe("spawned");

    // A second host over the same vault and the same engine socket: it must
    // find the daemon rather than fight it for the writer lease.
    const second = superviseOn({ ...config, leaveEngineRunning: true });
    await second.start();
    expect(second.engineSource()).toBe("connected");
    expect(second.pid()).toBeNull();
    expect((await second.client().request<GetVaultInfoResponse>("get_vault_info")).socket_path).toBe(
      config.engineSocketPath,
    );

    // And the second host's shutdown leaves the daemon serving the first.
    await second.stop();
    expect(
      (await first.client().request<GetVaultInfoResponse>("get_vault_info")).generation,
    ).toBeGreaterThanOrEqual(0);
  });

  it("auto leaves a daemon it spawned running when told to", async () => {
    // The flag's whole promise: the next client's start is cheap because this
    // host left the daemon where the probe will find it. A shutdown that
    // escalated to SIGTERM at the 2 s rung — which a listening daemon reaches,
    // because it does not end on stdin EOF — would break exactly that.
    const config = { ...configFor("auto"), leaveEngineRunning: true };
    const supervisor = await startedOn(config);
    const pid = supervisor.pid();
    expect(pid).not.toBeNull();
    await supervisor.stop();
    const probe = await probeEngineSocket(config.engineSocketPath, config.clock);
    expect(probe.answered).toBe(true);
    // This case's daemon is nobody else's to clean up.
    process.kill(pid as number, "SIGTERM");
    await expectEventually(() => !alive(pid as number), "the left-behind daemon to stop");
  });

  it("connect refuses when nothing is listening", async () => {
    const config = configFor("connect");
    const supervisor = superviseOn(config);
    await expect(supervisor.start()).rejects.toThrow(/no vaultd is listening/i);
    expect(supervisor.engineSource()).toBeNull();
  });

  it("connect takes the engine-lost road when the daemon is killed", async () => {
    const config = configFor("auto");
    const running = await startedOn(config);
    const connecting: HostConfig = { ...config, engine: "connect" };
    const lost: Error[] = [];
    const client = superviseOn(connecting, {
      onClientReady: (): void => {},
      onEngineLost: (error): void => {
        lost.push(error);
      },
      onStateChange: (): void => {},
    });
    await client.start();
    expect(client.engineSource()).toBe("connected");

    const resyncs: unknown[] = [];
    await client.subscribe((event) => {
      if (event.type === "resync_required") resyncs.push(event);
    });

    // Kill the daemon the connected host is using.
    process.kill(running.pid() as number, "SIGKILL");
    await expectEventually(() => lost.length > 0, "the connected host is told its engine is gone");
    // **The same door a killed child goes through.** Nothing downstream of the
    // supervisor distinguishes the two, and the Mirror's resync road is built
    // on this class alone.
    expect(lost[0]).toBeInstanceOf(EngineLostError);
    expect(resyncs.length).toBeLessThanOrEqual(1);
  });
});

/** Is this process still there? `kill(pid, 0)` asks without signalling. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Rendezvous on a condition, never a sleep. */
async function expectEventually(
  holds: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((settle) => setImmediate(settle));
  }
}
