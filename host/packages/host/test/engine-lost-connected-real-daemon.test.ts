/**
 * The engine-lost road, walked by a host whose engine was a **socket**.
 *
 * The road itself is phase 6's, and this is the proof it did not change shape
 * when the door did. A connected host's engine dies by its stream ending
 * rather than by a child exiting, and those are the two doors
 * `EngineLostError` was built to be one class for. So a killed daemon must
 * cost exactly what a killed child cost: one `EngineLostError`, and — once a
 * replacement is adopted — exactly one synthesized
 * `resync_required { runtime_recovered }`. Never two, which would make a
 * consumer rebuild its whole view twice for one outage, and never none, which
 * would leave it quietly stale.
 *
 * The second case is the other end of the same road: the TOCTOU at the end of
 * the reconnect window, where `auto` probes, finds nothing, and the daemon
 * binds before the spawn does. The spawned `vaultd` then exits 2 with
 * `another vaultd is listening at <path>` and the ladder has no rung left —
 * so without a second look the host gives up fatally while a perfectly good
 * daemon sits at the path it wanted.
 *
 * **Every path is inside the scratch root**, `engineSocketPath` included, so
 * no run touches the developer's own XDG run directory and two runs never
 * collide. The names are short on purpose: this worktree's own path is 61
 * bytes of the ~104-byte `sockaddr_un` limit on Darwin.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Mirror } from "../src/mirror/mirror";
import { EngineLostError } from "../src/supervisor";
import { defaultHostConfig, systemClock } from "../src/config";
import {
  BINARY,
  BINARY_EXISTS,
  cleanupRealDaemons,
  scratchRoot,
  startedOn,
  superviseOn,
  waitFor,
} from "./real-daemon";
import type { GetVaultInfoResponse, RuntimeEventDto } from "../src/client/protocol";
import type { HostConfig } from "../src/config";

afterEach(async () => {
  await cleanupRealDaemons();
});

/** A config over a one-note scratch vault, with every path inside target/tmp. */
function configFor(mode: HostConfig["engine"]): HostConfig {
  const root = scratchRoot("elc-");
  const vault = join(root, "v");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "One.md"), "# One\n");
  const index = join(root, "i.db");
  const base = defaultHostConfig(vault);
  return {
    ...base,
    vaultdBinary: BINARY,
    clock: systemClock(),
    dataDir: join(root, "state"),
    socketPath: join(root, "state", "host.sock"),
    engineSocketPath: join(root, "r", "e.sock"),
    indexPath: index,
    vaultdArgs: ["--vault", vault, "--index", index],
    engine: mode,
    // The reconnect window is measured in rungs, so a short ladder is a short
    // window — 200 ms rather than the default 3.75 s. The window is still
    // walked rung by rung; only its length changes.
    restartBackoffMs: [100, 100, 100],
  };
}

describe.skipIf(!BINARY_EXISTS)("a connected engine that dies", () => {
  it("raises one EngineLostError and costs the mirror exactly one resync", async () => {
    const config = configFor("auto");

    // **One daemon, then a host that adopts it.** The owner is only here to
    // put a listening daemon on the path and then get out of the way:
    // `leaveEngineRunning` means its shutdown closes the daemon's stdin and
    // returns, so the daemon survives its parent and there is exactly one
    // supervisor left with an opinion about it.
    const owner = await startedOn({ ...config, leaveEngineRunning: true });
    expect(owner.engineSource()).toBe("spawned");
    const daemon = owner.pid() as number;
    await owner.stop();
    expect(alive(daemon)).toBe(true);

    const lost: Error[] = [];
    const guest = superviseOn(config, {
      onClientReady: (): void => {},
      onEngineLost: (error): void => {
        lost.push(error);
      },
      onStateChange: (): void => {},
    });
    try {
      await guest.start();
      // Adopted, not spawned: no child of its own, and the daemon it is
      // talking to is the one the owner left.
      expect(guest.engineSource()).toBe("connected");
      expect(guest.pid()).toBeNull();

      const mirror = await Mirror.open(() => guest.client(), config);
      const resyncs: RuntimeEventDto[] = [];
      await guest.subscribe((event) => {
        if (event.type === "resync_required") resyncs.push(event);
        void mirror.applyEvent(event).catch(() => undefined);
      });
      // **Baselines, because the daemon resyncs for reasons of its own.** A
      // watcher overflow, an oversized change set or a reconcile escalation
      // all emit `resync_required`, so the numbers this case asserts are
      // deltas across the kill rather than totals — and the wait requires the
      // loss it is counting, so a stray resync cannot end it early.
      const before = mirror.resyncCount();
      const beforeEvents = resyncs.length;

      // Kill the daemon out from under the connected host. Nothing exits on
      // this host's side — a socket simply ends — which is the whole point:
      // the same `EngineLostError` must come out of the other door.
      process.kill(daemon, "SIGKILL");
      await waitFor(
        "the guest to lose its engine, wait out the window, and pay the resync debt",
        () =>
          lost.length > 0 &&
          guest.engineSource() === "spawned" &&
          mirror.resyncCount() > before,
        () =>
          `guest state=${guest.state()}, source=${String(guest.engineSource())}, ` +
          `losses=${String(lost.length)}, resync events=${String(resyncs.length)}, ` +
          `mirror resyncs=${String(mirror.resyncCount() - before)}, ` +
          `lastError=${guest.lastError()?.message ?? "none"}`,
        30_000,
      );

      // **Counted, not bounded.** The rungs the supervisor spends waiting out
      // the reconnect window are the same outage, not new ones, so one loss
      // is the number — and one resync is what a consumer must pay for it.
      expect(lost.length).toBe(1);
      expect(lost[0]).toBeInstanceOf(EngineLostError);
      expect(lost[0]?.message).toContain("the engine connection to");
      expect(resyncs.length - beforeEvents).toBe(1);
      expect(resyncs[beforeEvents]?.value).toMatchObject({ reason: "runtime_recovered" });
      expect(mirror.resyncCount() - before).toBe(1);
      mirror.stop();
    } finally {
      if (alive(daemon)) process.kill(daemon, "SIGKILL");
    }
  }, 120_000);

  it("adopts a daemon that binds in the gap between auto's last probe and its spawn", async () => {
    // **`auto` gets exactly one spawn attempt after the window**, because the
    // window consumes every rung before the last one. If a daemon rebinds
    // between that final probe and the spawn's own `bind`, the spawned
    // `vaultd` meets `ListenError::AlreadyListening` and exits 2 — and an
    // exhausted ladder would turn that into a fatal give-up next to a healthy
    // daemon. The supervisor reads that one exit for what it is and looks
    // again.
    //
    // The gap is made deterministic rather than raced for. The guest's
    // `vaultdBinary` is a stand-in that parks inside the gap and says so; the
    // **real** daemon is then started, and only once it is watching is the
    // stand-in released to refuse in the daemon's own words. Nothing here
    // sleeps waiting for a state: both waits are rendezvous on a file the
    // other side creates.
    // **A one-rung ladder, which is the state the window leaves `auto` in.**
    // The reconnect window spends rungs `0..n-2` probing, so the spawn lands on
    // the last rung with nothing behind it; one rung reproduces exactly that —
    // the spawn failed and there is no rung left — without having to drop a
    // connection first to reach it. With a longer ladder the ordinary retry would
    // find the daemon on the next rung and this case would pass whether or not
    // the second look exists, which is the one shape a test must not have.
    const config: HostConfig = { ...configFor("auto"), restartBackoffMs: [100] };
    // `dataDir` is `<scratch root>/state`, so its parent is the scratch root.
    const root = dirname(config.dataDir);
    const marker = join(root, "gap");
    const go = join(root, "go");
    const loser = join(root, "loser.sh");
    writeFileSync(
      loser,
      [
        "#!/bin/sh",
        "# A vaultd that loses the bind race, on purpose.",
        `: > "${marker}"`,
        "n=0",
        `while [ ! -f "${go}" ]; do`,
        "  n=$((n+1))",
        '  [ "$n" -gt 600 ] && exit 9',
        "  sleep 0.05",
        "done",
        `echo "vaultd: another vaultd is listening at ${config.engineSocketPath}" >&2`,
        "exit 2",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const guest = superviseOn({ ...config, vaultdBinary: loser });
    const starting = guest.start();
    await waitFor(
      "the guest's spawn to reach the gap",
      () => existsSync(marker),
      () => `guest state=${guest.state()}, lastError=${guest.lastError()?.message ?? "none"}`,
      30_000,
    );

    // The daemon arrives in the gap — a real one, listening on the very path
    // the guest's probe had just found empty.
    const owner = await startedOn(config);
    expect(owner.engineSource()).toBe("spawned");
    writeFileSync(go, "");

    await starting;
    expect(guest.engineSource()).toBe("connected");
    // Nothing of its own was left running: the stand-in exited 2 and the
    // second look found a daemon rather than spawning beside one.
    expect(guest.pid()).toBeNull();
    const info = await guest.client().request<GetVaultInfoResponse>("get_vault_info");
    expect(info.socket_path).toBe(config.engineSocketPath);
  }, 120_000);
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
