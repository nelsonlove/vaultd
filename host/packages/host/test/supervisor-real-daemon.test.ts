import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultHostConfig } from "../src/config";
import { EngineStartError, Supervisor } from "../src/supervisor";
import type { SupervisorEvents } from "../src/supervisor";
import type { HostConfig } from "../src/config";
import type { GetNoteResponse, GetVaultInfoResponse, MutationResponse } from "../src/client/protocol";
import type { RuntimeEventDto } from "../src/client/events";
import {
  BINARY,
  BINARY_EXISTS,
  cleanupRealDaemons,
  scratchRoot,
  silentEvents,
  superviseOn,
  waitFor,
} from "./real-daemon";

/**
 * The supervisor against the **real** `vaultd`.
 *
 * `supervisor.test.ts` proves the state machine against a fake engine, which
 * agrees with whatever this supervisor believes. Four facts cannot be proved
 * that way, because they are facts about the shipped daemon:
 *
 * 1. **The child exits on `stdin` EOF.** This is the whole orphan story: the
 *    host owns the engine's `stdin`, so a host that dies takes the engine with
 *    it and no orphan is left holding the index's writer lease.
 * 2. **A second host on one vault fails cleanly.** The lease is the daemon's,
 *    and it refuses *at startup* — `vaultd: index storage is already in use by
 *    another writer`, exit code 2 — rather than serving and answering
 *    `index_in_use` on the wire. So the host meets it as a start failure, and
 *    what "cleanly" means here is: the ladder is exhausted, `start()` rejects,
 *    the supervisor is `stopped`, and the *first* host is untouched.
 * 3. **A restart resumes the generation and reads its own writes.** The index
 *    is on disk; a write acknowledged before a `SIGKILL` is readable after it.
 * 4. **Readiness is the runtime's own announcement.** A cold vault's
 *    subscription opens during `catching_up` and the move to `watching` arrives
 *    as an ordinary event.
 *
 * The binary is a Rust build artifact and is not in the repository. Its absence
 * fails **`client-real-daemon.test.ts`** loudly — that file carries the
 * unconditional assertion plus the deliberate `VAULTD_ALLOW_MISSING_BINARY=1`
 * opt-out — and merely skips here, so the loud failure is stated once. If that
 * assertion is ever removed or that file renamed, the guard must move here in
 * the same motion. Build it with `cargo build --release --bin vaultd`.
 *
 * The binary path, the scratch-root registry, `silent`, and `waitFor` now live
 * in `real-daemon.ts`, so every real-daemon file shares one set — the mirror
 * files had no `waitFor` at all until it was lifted out of here.
 */

/**
 * A config over a fresh scratch vault and its own index.
 *
 * The ladder is short because these cases restart on purpose and a real 250 ms
 * first rung would be a quarter second of nothing per restart; it is still the
 * config's ladder, taken through the config's clock.
 */
function configFor(): HostConfig {
  const root = scratchRoot("vaultd-sup-real-");
  const vault = join(root, "vault");
  mkdirSync(vault);
  const index = join(root, "index.db");
  return {
    ...defaultHostConfig(vault),
    // Phase 6's road, pinned: this case owns its daemon. See the note in
    // `real-daemon.ts` on why a test never runs under `auto`.
    engine: "spawn" as const,
    vaultdBinary: BINARY,
    vaultdArgs: ["--vault", vault, "--index", index],
    indexPath: index,
    restartBackoffMs: [50, 50, 50, 50],
  };
}

const silent = silentEvents;

function supervise(config: HostConfig, events: SupervisorEvents = silent): Supervisor {
  return superviseOn(config, events);
}

afterEach(cleanupRealDaemons);

describe.skipIf(!BINARY_EXISTS)("Supervisor against a real vaultd", () => {
  it("ends the engine by closing its stdin, with no signal and no escalation", async () => {
    const supervisor = supervise(configFor());
    await supervisor.start();
    expect(supervisor.state()).toBe("running");
    await supervisor.stop();
    // Code 0, no signal, no escalation: the daemon ended because its stdin
    // reached EOF. That is what makes a dead host a dead engine, and it is the
    // only reason a host crash cannot strand the writer lease.
    expect(supervisor.lastExit()).toEqual({ code: 0, signal: null, escalated: "none" });
  }, 20_000);

  it("reaches watching, which is later than the process existing", async () => {
    const supervisor = supervise(configFor());
    await supervisor.start();
    await supervisor.whenWatching();
    expect(supervisor.liveState()).toBe("watching");
    // Readiness is a fact about the runtime, not about the supervisor: the
    // engine answers `health` long before its catch-up finishes.
    await expect(supervisor.client().request("health")).resolves.toEqual({
      service: "vaultd",
      status: "ok",
    });
  }, 20_000);

  it("refuses a second host on the same vault and leaves the first one serving", async () => {
    const first = configFor();
    const holder = supervise(first);
    await holder.start();
    await holder.whenWatching();

    // The same index, a different supervisor: the daemon's writer lease is what
    // this meets, and it meets it as a startup refusal.
    let lost = 0;
    const second = superviseOn({ ...first, restartBackoffMs: [20, 20] }, {
      ...silent,
      onEngineLost: () => {
        lost += 1;
      },
    });
    const thrown: unknown = await second.start().then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(EngineStartError);
    const failure = thrown as EngineStartError;
    expect(failure.message).toMatch(/engine failed to start/);
    // Programmatically distinguishable, which is the point: the daemon refuses
    // at startup with code 2 and says why on stderr, so the host can tell "the
    // lease is held" from "the binary is missing" without parsing a message
    // itself.
    expect(failure.exit?.code).toBe(2);
    expect(failure.leaseHeld).toBe(true);
    expect(failure.stderrTail).toMatch(/already in use by another writer/);
    expect(second.state()).toBe("stopped");
    expect(lost).toBe(2);
    expect(() => second.client()).toThrow(/no engine/);
    // The lease holder is untouched by the attempt.
    await expect(holder.client().request("health")).resolves.toEqual({
      service: "vaultd",
      status: "ok",
    });
    expect(holder.state()).toBe("running");
  }, 30_000);

  it("restarts after a kill -9, resumes the generation, and still reads its own writes", async () => {
    const seen: RuntimeEventDto[] = [];
    const order: string[] = [];
    let ready = 0;
    const supervisor = supervise(configFor(), {
      onClientReady: () => {
        ready += 1;
        order.push("ready");
      },
      onEngineLost: () => {
        order.push("lost");
      },
      onStateChange: (state) => {
        order.push(`state:${state}`);
      },
    });
    await supervisor.start();
    await supervisor.subscribe((event) => seen.push(event));
    await supervisor.whenWatching();

    const written = await supervisor.client().request<MutationResponse>("write_note", {
      path: "Survivor.md",
      content: "# Survivor\n\n[[Other]]\n",
    });
    expect(written.generation).toBeGreaterThan(0);

    // **Drain the old engine before killing it.** The write's own
    // `generation_committed` is delivered asynchronously, so clearing the list
    // immediately after the write acknowledgement is a race the case loses
    // about one run in six: the event lands after the clear and takes the
    // first slot the restart marker is asserted to hold. Wait for that event,
    // then take a round trip as the barrier — the daemon answered a later
    // request, so anything it meant to send for that write has already been
    // written and read — and only then clear and kill.
    await waitFor(
      `the write's own generation_committed (generation ${String(written.generation)})`,
      () =>
        seen.some(
          (event) =>
            event.type === "generation_committed" &&
            (event.value as { generation: number }).generation === written.generation,
        ),
      () => `events so far: ${JSON.stringify(seen.map((event) => event.type))}.`,
    );
    await supervisor.client().request("health");

    const doomed = supervisor.pid();
    expect(doomed).toBeGreaterThan(0);
    seen.length = 0;
    process.kill(doomed!, "SIGKILL");

    await waitFor(
      "the supervisor to replace the killed engine",
      () => supervisor.restartCount() >= 1 && ready >= 2 && supervisor.state() === "running",
      () =>
        `state=${supervisor.state()} restarts=${String(supervisor.restartCount())} ready=${String(ready)} lastError=${supervisor.lastError()?.message ?? "(none)"}.`,
    );
    expect(order.indexOf("lost")).toBeLessThan(order.lastIndexOf("ready"));
    expect(supervisor.lastExit()?.signal).toBe("SIGKILL");

    // Read-your-writes across the crash: the acknowledgement was durable, so
    // the note is there, at or above the generation the write was given.
    const note = await supervisor
      .client()
      .request<GetNoteResponse>("get_note", { path: "Survivor.md" });
    expect(note.note.source).toContain("# Survivor");
    const info = await supervisor.client().request<GetVaultInfoResponse>("get_vault_info");
    expect(info.generation).toBeGreaterThanOrEqual(written.generation);

    // And the subscription that was open across the restart is told, once,
    // before anything the new engine has to say.
    await waitFor(
      "the synthesized resync marker",
      () => seen.length > 0,
      () => `no event reached the surviving subscriber; state=${supervisor.state()}.`,
    );
    // Asserted on shape and on position, not on an exact generation: the
    // restarted daemon runs its own catch-up and may commit past the marker
    // before this case reads `get_vault_info`. What must hold is that the
    // marker is FIRST — ahead of every event of the new engine's, including
    // the `resync_required` its own catch-up raises — and that it names a real
    // generation at or above the write that survived the crash.
    const marker = seen[0];
    expect(marker?.type).toBe("resync_required");
    expect(marker?.value).toMatchObject({ reason: "runtime_recovered" });
    const named = (marker?.value as { current_generation: number | null }).current_generation;
    expect(typeof named).toBe("number");
    expect(named).toBeGreaterThanOrEqual(written.generation);
  }, 30_000);
});
