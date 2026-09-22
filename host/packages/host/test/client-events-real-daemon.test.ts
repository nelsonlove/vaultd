import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VaultdClient } from "../src/client/client";
import { KNOWN_EVENT_TYPES, isKnownChangeSet } from "../src/client/events";
import { scratchRoot } from "./scratch";
import type { RuntimeEventDto, SubscriptionHandle } from "../src/client/events";
import type {
  GenerationResponse,
  MutationResponse,
  RefreshIndexResponse,
  WriteFileResponse,
} from "../src/client/protocol";

/**
 * The subscription half of the client, against the **real** `vaultd`.
 *
 * `client-events.test.ts` proves the routing and the tolerance against a fake,
 * which agrees with whatever this client believes. This file is where the event
 * shapes are checked against the shipped Rust: a real mutation's
 * `generation_committed` (`cause: "mutation"`, a detailed change set, a note
 * count that counts notes), a real zone write's `config_changed`, and a real
 * manual refresh's `resync_required`.
 *
 * What it deliberately does *not* prove is unknown-variant tolerance. A variant
 * a later daemon introduces is, by construction, a variant this daemon never
 * emits; the fake is the only instrument that can put one on the wire.
 *
 * The binary is a Rust build artifact and is not in the repository. Its absence
 * fails **`client-real-daemon.test.ts`** loudly — that file carries an
 * unconditional assertion plus the deliberate `VAULTD_ALLOW_MISSING_BINARY=1`
 * opt-out — and merely skips here, so the loud failure is stated once. That
 * coupling is this file's only guard: if that assertion is ever removed or that
 * file renamed, these cases go quietly green with no real-daemon coverage at
 * all, and the guard must be moved here in the same motion. Build the binary
 * with `cargo build --release --bin vaultd`.
 */
const BINARY = resolve(__dirname, "..", "..", "..", "..", "target", "release", "vaultd");
const BINARY_EXISTS = existsSync(BINARY);

/** A spawned `vaultd` over a scratch vault, with an event queue and a rendezvous. */
class SubscribedDaemon {
  readonly child: ChildProcessWithoutNullStreams;
  readonly client: VaultdClient;
  readonly root: string;
  readonly vault: string;
  readonly events: RuntimeEventDto[] = [];
  fatal: Error | null = null;
  handlerErrors: Error[] = [];
  private stderr = "";
  private readonly waiters: Array<{
    matches(event: RuntimeEventDto): boolean;
    resolve(event: RuntimeEventDto): void;
  }> = [];

  /**
   * @param watch `false` — the default — runs with no watcher and no periodic
   * tick, so every event is caused by an operation the test issued and the
   * resync *reason* is assertable. With the watcher live, a `watcher_overflow`
   * raised by the test's own writes races the manual refresh's
   * `runtime_recovered`. `true` is for the two cases that need the watcher and
   * assert nothing about reasons.
   */
  constructor(watch = false) {
    this.root = scratchRoot("vaultd-host-events-");
    this.vault = join(this.root, "vault");
    mkdirSync(this.vault);
    const args = ["--vault", this.vault, "--index", join(this.root, "index.db")];
    if (!watch) args.push("--no-watch", "--reconcile-interval-seconds", "0");
    this.child = spawn(BINARY, args, { stdio: ["pipe", "pipe", "pipe"] });
    // Drained, not ignored: a stderr nobody reads is a pipe that eventually
    // blocks the daemon, and its text is the only diagnosis when a case fails.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.client = new VaultdClient({
      stdout: this.child.stdout,
      stdin: this.child.stdin,
      onEvent: () => {},
      onHandlerError: (error) => this.handlerErrors.push(error),
      onFatal: (error) => {
        this.fatal = error;
      },
    });
  }

  /** The subscription every case in this file shares. */
  subscribe(): Promise<SubscriptionHandle> {
    return this.client.subscribeEvents((event) => {
      this.events.push(event);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i]!;
        if (waiter.matches(event)) {
          this.waiters.splice(i, 1);
          waiter.resolve(event);
        }
      }
    });
  }

  /**
   * Resolve on the first event matching `matches`, past or future. A
   * rendezvous, never a sleep: the daemon decides when the event exists, and
   * this waits exactly that long.
   *
   * It gives up before the case's own timeout does, and **says why**: a bare
   * "timed out in 20000ms" from vitest names neither what was awaited, nor what
   * did arrive instead, nor what the daemon said on stderr — and a gate failure
   * nobody can read is one that gets marked flaky and then ignored.
   */
  nextEvent(
    description: string,
    matches: (event: RuntimeEventDto) => boolean,
    timeoutMs = 15_000,
  ): Promise<RuntimeEventDto> {
    const already = this.events.find((event) => matches(event));
    if (already) return Promise.resolve(already);
    return new Promise((resolveEvent, rejectEvent) => {
      // The timer is armed first so the waiter can clear it, and it reaches the
      // waiter through the closure — it only ever runs after both exist.
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectEvent(
          new Error(
            `timed out after ${timeoutMs}ms waiting for ${description}. ` +
              `Events delivered: ${JSON.stringify(this.summary())}. ` +
              `Daemon stderr: ${this.stderr.trim() || "(silent)"}`,
          ),
        );
      }, timeoutMs);
      const waiter = {
        matches,
        resolve: (event: RuntimeEventDto): void => {
          clearTimeout(timer);
          resolveEvent(event);
        },
      };
      this.waiters.push(waiter);
    });
  }

  /** What arrived, compactly, for a timeout message: type plus its tell. */
  private summary(): string[] {
    return this.events.map((event) => {
      const value = event.value as { cause?: string; live_state?: string; reason?: string };
      const tell = value.cause ?? value.live_state ?? value.reason;
      return tell === undefined ? event.type : `${event.type}(${tell})`;
    });
  }

  diagnostics(): string {
    return this.stderr;
  }

  dispose(): void {
    this.client.close();
    this.child.kill();
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe.skipIf(!BINARY_EXISTS)("subscriptions against a real vaultd", () => {
  let daemon: SubscribedDaemon;
  let handle: SubscriptionHandle;

  beforeAll(async () => {
    daemon = new SubscribedDaemon();
    handle = await daemon.subscribe();
  }, 20_000);

  afterAll(() => {
    daemon.dispose();
  });

  it("answers subscribe with a real start point and live state", () => {
    expect(handle.subscriptionId.length).toBeGreaterThan(0);
    expect(handle.startGeneration === null || typeof handle.startGeneration === "number").toBe(true);
    // Open-ended on the wire, so the assertion is on the type, not the set: a
    // later `vaultd` may answer a state this build has never heard of.
    expect(typeof handle.liveState).toBe("string");
  });

  it("reports this client's own write as generation_committed with cause mutation", async () => {
    const written = await daemon.client.request<MutationResponse>("write_note", {
      path: "Note.md",
      content: "# Note\n\n[[Other]]\n",
    });
    const event = await daemon.nextEvent(
      `generation_committed for the mutation's own generation ${written.generation}`,
      (candidate) =>
        candidate.type === "generation_committed" &&
        (candidate.value as { generation: number }).generation === written.generation,
    );
    expect(event.type).toBe("generation_committed");
    const value = event.value as {
      previous_generation: number | null;
      generation: number;
      cause: string;
      changes: { kind: string; created: string[]; modified: string[]; deleted: string[] };
      affected_note_count: number;
      affected_reference_count: number;
    };
    // `mutation` is this daemon's own write path, distinct from `watcher`.
    expect(value.cause).toBe("mutation");
    expect(value.changes.kind).toBe("detailed");
    expect(isKnownChangeSet(value.changes)).toBe(true);
    expect(value.changes.created).toContain("Note.md");
    // `affected_note_count` counts NOTES, not paths.
    expect(value.affected_note_count).toBe(1);
    expect(value.affected_reference_count).toBeGreaterThanOrEqual(1);
    expect(value.previous_generation).not.toBe(value.generation);
    expect(daemon.fatal).toBeNull();
  }, 20_000);

  it("names a deleted folder once, and leaves its subtree implied", async () => {
    await daemon.client.request<GenerationResponse>("create_folder", { path: "Sub" });
    await daemon.client.request<MutationResponse>("write_note", {
      path: "Sub/Inner.md",
      content: "inner\n",
    });
    const deleted = await daemon.client.request<GenerationResponse>("delete_folder", {
      path: "Sub",
      mode: "permanent",
      recursive: true,
    });
    const event = await daemon.nextEvent(
      `generation_committed for the delete's generation ${deleted.generation}`,
      (candidate) =>
        candidate.type === "generation_committed" &&
        (candidate.value as { generation: number }).generation === deleted.generation,
    );
    const changes = (event.value as { changes: { kind: string; deleted: string[] } }).changes;
    expect(changes.kind).toBe("detailed");
    // The folder is named; whether its descendants are spelled out depends on
    // which reconciliation route produced the event, which is exactly why a
    // consumer must apply the subtree rule rather than trust the list length.
    expect(changes.deleted).toContain("Sub");
  }, 20_000);

  it("reports a zone write as config_changed naming the path it landed on", async () => {
    await daemon.client.request<GenerationResponse>("create_folder", {
      path: ".obsidian/plugins/example",
    });
    const zoneFolder = await daemon.nextEvent(
      "config_changed for the zone folder",
      (candidate) =>
        candidate.type === "config_changed" &&
        (candidate.value as { path: string }).path === ".obsidian/plugins/example",
    );
    expect(zoneFolder.type).toBe("config_changed");
    const written = await daemon.client.request<WriteFileResponse>("write_file", {
      path: ".obsidian/plugins/example/data.json",
      content_base64: Buffer.from('{"key":"value"}', "utf8").toString("base64"),
    });
    // Nothing in the zone is indexed, so the write joins no generation.
    expect(written.semantic).toBe(false);
    expect(written.generation).toBeUndefined();
    const event = await daemon.nextEvent(
      "config_changed for the zone file",
      (candidate) =>
        candidate.type === "config_changed" &&
        (candidate.value as { path: string }).path === ".obsidian/plugins/example/data.json",
    );
    expect(Object.keys(event.value as object)).toEqual(["path"]);
  }, 20_000);

  it("reports a manual refresh that moved the generation as resync_required", async () => {
    const before = daemon.events.length;
    // A change made behind the daemon's back, with no watcher to see it: the
    // manual refresh is then the only thing that can move the generation, and
    // the move is what makes the resync unconditional (`foreground_refresh`
    // announces `runtime_recovered` exactly when the generation advanced).
    writeFileSync(join(daemon.vault, "External.md"), "# External\n", "utf8");
    const refreshed = await daemon.client.request<RefreshIndexResponse>("refresh_index", {
      verify: false,
    });
    expect(refreshed.added).toBe(1);
    const event = await daemon.nextEvent(
      "resync_required raised by the manual refresh",
      (candidate) =>
        candidate.type === "resync_required" && daemon.events.indexOf(candidate) >= before,
    );
    const value = event.value as { current_generation: number | null; reason: string };
    expect(value.reason).toBe("runtime_recovered");
    expect(value.current_generation).toBe(refreshed.generation);
    // Never null in protocol version 1: an event that cannot name a generation
    // to re-read at is withheld rather than emitted.
    expect(typeof value.current_generation).toBe("number");
  }, 20_000);

  it("delivers only event types this build knows, none below the start point", () => {
    expect(daemon.events.length).toBeGreaterThan(0);
    for (const event of daemon.events) {
      expect(KNOWN_EVENT_TYPES as readonly string[]).toContain(event.type);
    }
    // A strict start point, not a hint: no `generation_committed` at or below
    // the generation the subscription opened at is ever delivered.
    const start = handle.startGeneration;
    if (start !== null) {
      for (const event of daemon.events) {
        if (event.type !== "generation_committed") continue;
        expect((event.value as { generation: number }).generation).toBeGreaterThan(start);
      }
    }
    expect(daemon.handlerErrors).toEqual([]);
  });

  it("stops delivering after unsubscribe, and the client keeps serving", async () => {
    await handle.close();
    const seen = daemon.events.length;
    await daemon.client.request<MutationResponse>("write_note", {
      path: "After.md",
      content: "after\n",
    });
    // A round trip after the mutation is the barrier: the daemon answered a
    // later request, so any event it meant to send for that write has already
    // been written and read.
    await daemon.client.request("health");
    expect(daemon.events).toHaveLength(seen);
    expect(daemon.fatal).toBeNull();
    expect(daemon.diagnostics()).not.toContain("panicked");
  }, 20_000);
});

/**
 * The two paths the `--no-watch` block above deliberately gives up, on a second
 * daemon that keeps its watcher. Neither asserts a resync *reason*, so the race
 * that forced the first block's determinism cannot reach these.
 */
describe.skipIf(!BINARY_EXISTS)("subscriptions against a real vaultd with the watcher live", () => {
  let daemon: SubscribedDaemon;
  let handle: SubscriptionHandle;

  beforeAll(async () => {
    daemon = new SubscribedDaemon(true);
    handle = await daemon.subscribe();
  }, 20_000);

  afterAll(() => {
    daemon.dispose();
  });

  it("reports a change nobody told it about as generation_committed with cause watcher", async () => {
    // **Wait for the watcher before giving it something to see.** The
    // subscription opens during `catching_up` in every measured run, and a file
    // that lands in that window is the startup catch-up's to find, not the
    // watcher's — it is committed under a different cause, so a predicate
    // waiting for `watcher` waits forever. That is a ~1-in-50 timeout, and the
    // precondition is the fix: the same rendezvous the sibling case uses, made
    // explicit here rather than assumed. No sleep — the daemon decides when.
    await daemon.nextEvent(
      "runtime_state_changed reaching watching, before writing anything",
      (candidate) =>
        candidate.type === "runtime_state_changed" &&
        (candidate.value as { live_state: string }).live_state === "watching",
    );
    // Written behind the daemon's back, so only the watcher can find it —
    // `mutation` is unreachable here by construction.
    writeFileSync(join(daemon.vault, "Watched.md"), "# Watched\n\n[[Other]]\n", "utf8");
    const event = await daemon.nextEvent(
      "generation_committed with cause watcher",
      (candidate) =>
        candidate.type === "generation_committed" &&
        (candidate.value as { cause: string }).cause === "watcher",
    );
    const value = event.value as {
      cause: string;
      generation: number;
      changes: { kind: string; created: string[] };
      affected_note_count: number;
    };
    expect(value.cause).toBe("watcher");
    expect(value.changes.kind).toBe("detailed");
    expect(value.changes.created).toContain("Watched.md");
    expect(value.affected_note_count).toBe(1);
    // The start point is strict on this path too, whatever the subscription
    // opened at — `null` on a vault whose catch-up had not committed yet.
    if (handle.startGeneration !== null) {
      expect(value.generation).toBeGreaterThan(handle.startGeneration);
    }
    expect(daemon.fatal).toBeNull();
  }, 20_000);

  it("observes the runtime reaching watching", async () => {
    // The subscription opens while the startup catch-up is still running — a
    // cold vault starts at `startGeneration: null`, `live_state: "catching_up"`
    // — so the move to `watching` happens *after* it exists and is delivered
    // like any other event. Nothing here is untestable end to end. The case
    // above awaits the same event as its precondition, so by now this one
    // resolves from what already arrived; it is the assertion that reads it.
    const event = await daemon.nextEvent(
      "runtime_state_changed reaching watching",
      (candidate) =>
        candidate.type === "runtime_state_changed" &&
        (candidate.value as { live_state: string }).live_state === "watching",
    );
    const value = event.value as { generation: number | null; live_state: string };
    expect(value.live_state).toBe("watching");
    // `error_code` is reserved for a future typed code and is never populated.
    expect((event.value as { error_code?: string }).error_code).toBeUndefined();
    expect(daemon.diagnostics()).not.toContain("panicked");
  }, 20_000);
});
