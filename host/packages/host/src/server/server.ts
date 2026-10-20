/**
 * The host's own protocol, over a Unix stream socket.
 *
 * Same envelope as `vaultd`, because a client that already speaks one should not
 * have to learn a second grammar: one JSON object per line, UTF-8, requests
 * carrying `{ version, id, request: { method, params } }` and answers carrying
 * `{ version, id, outcome }`. Events are the daemon's second top-level shape —
 * `{ version, subscription_id, event }`, no `id`, no `outcome`.
 *
 * ## The socket's trust model, in the order the layers actually hold the door
 *
 * **The directory mode is the enforcement layer.** The socket lives inside a
 * directory this host creates with `mkdir(0o700)`; at startup the host `stat`s
 * it and refuses to listen unless the mode is exactly `0o700` and the owner is
 * this process's uid. A `0700` directory is what actually stops another user
 * reaching the socket at all, on every Unix, because traversal requires execute
 * permission on the directory. Everything else is built on top of this.
 *
 * **The socket mode is defense in depth.** Immediately after `listen`, the
 * socket file is `chmod`ed to `0o600` and `stat`ed to confirm. It is worth doing
 * and worth asserting, but it is not what is holding the door: **Darwin and the
 * BSDs historically ignore permission bits on an `AF_UNIX` socket at
 * `connect()` time**, so a `0600` socket in a world-traversable directory is not,
 * by itself, access control on macOS — which is the platform this host is
 * developed on.
 *
 * **The nonce is the application-level gate, and it is a substitute rather than
 * a supplement.** Node exposes no portable `SO_PEERCRED`/`LOCAL_PEERCRED`
 * accessor without a native addon, so a peer-UID check is not available. Instead
 * the first line on any accepted connection must be `host.hello` carrying this
 * host's ownership nonce — 32 random bytes written to `<dataDir>/nonce` at mode
 * `0o600`. Only a process that can read a `0600` file owned by this user can
 * produce it, which admits the same process set a UID check would, root excepted
 * — and a root peer is already past every boundary this host has. Anything else
 * is answered `not_owner` and the connection is destroyed.
 *
 * The honest summary: **directory `0700` enforces, socket `0600` is defense in
 * depth and may be advisory on Darwin, the nonce is the portable stand-in for
 * the peer-UID check Node cannot make.** `docs/protocol-host.md` says it there
 * too, because a reader of the protocol must not infer protection the kernel may
 * not be providing.
 *
 * ## Events
 *
 * Host events (`host.plugin_state_changed`, `host.notice`,
 * `host.overlap_changed`, `host.search_opened`) come from the components that
 * produce them. Every daemon-shaped event is relayed with its `vaultd` payload **unchanged**, so a
 * client correlating this door with a direct daemon subscription sees the same
 * numbers — which a host that recomputed them could not promise, and the first
 * cut of this file recomputed all of them.
 *
 * `generation_committed` carries one extra rule: it is **held until this host's
 * mirror has caught up to it**. A client of this host pages this host's mirror
 * (`host.open_snapshot`), so announcing generation N before the mirror holds N
 * would invite a client to page a view that does not have it. The payload is the
 * daemon's; the moment is the mirror's. See {@link HostServer.relayDaemonEvent}.
 */

import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { ClientSubscriptions } from "./subscriptions";
import { DataDir } from "../datadir";
import { HOST_PLUGIN_ID } from "../shim/errors";
import { HostError } from "./wire";
import { HostOps, HOST_PROTOCOL_VERSION } from "./ops";
import { VaultdError } from "../client/errors";
import { isKnownRuntimeEvent } from "../client/protocol";
import { toWireNotice, toWireOverlap } from "./wire";
import type { HostConfig } from "../config";
import type { HostEvent } from "./subscriptions";
import type { HostServerDeps, HostServerWiring, OpSession } from "./ops";
import type { ResyncReasonDto, RuntimeEventDto } from "../client/protocol";

export type { HostServerDeps, HostServerWiring } from "./ops";

/** The file, inside the host's data directory, that holds the ownership nonce. */
const NONCE_FILE = "nonce";

/** How much room a request's envelope and base64 padding get above its payload. */
const LINE_CAP_HEADROOM_BYTES = 1024 * 1024;

/**
 * How long one request line may be, **in bytes of UTF-8**.
 *
 * A client that sends an unterminated stream would otherwise grow this host's
 * memory one chunk at a time, which is the same hazard the subscriber queue is
 * bounded against and deserves the same answer: a bound, and a connection that
 * is destroyed rather than served.
 *
 * Derived from `writeFileCapBytes` rather than written as a literal beside it,
 * because the relationship is the whole justification for the number: the
 * largest legitimate request through this door is a `write_file` forwarded to
 * the daemon, so the cap has to be that payload plus room for its envelope. Two
 * constants that happened to agree would be two constants to keep agreeing.
 */
function lineCapFor(config: HostConfig): number {
  return config.writeFileCapBytes + LINE_CAP_HEADROOM_BYTES;
}

/**
 * Every host that wants to hear about an unhandled rejection in this process.
 *
 * **Defence in depth, and the depth is the point.** Every per-line handler now
 * carries its own catch, so nothing on the request path can leak a rejection —
 * but "nothing can" is a claim about code that is still being written, and the
 * consequence of being wrong is that Node terminates the process (the default
 * since v15, and this host declares `node >= 24`): every loaded plugin, every
 * subscription, every client, for one stray promise. A host that logs the bug
 * and keeps serving is strictly better than one that dies of it.
 *
 * Refcounted rather than installed per server, because a process may hold two —
 * a live host beside a harness, and a test file builds dozens in sequence — and
 * one `process.on` per host would trip Node's max-listeners warning and leak a
 * listener per host that is never closed.
 */
const rejectionReporters = new Set<(reason: unknown) => void>();
let installedRejectionHandler: ((reason: unknown) => void) | null = null;

/**
 * Report one unhandled rejection to every host that asked to hear about it.
 *
 * Exported so a test can assert what the guard *does* without planting a real
 * unhandled rejection — which the test runner would fail the file for, before
 * this handler ever saw it.
 */
export function reportUnhandledRejection(reason: unknown): void {
  for (const report of [...rejectionReporters]) {
    try {
      report(reason);
    } catch {
      // The guard is the last place left to report to. A reporter that throws
      // here must not become the unhandled rejection this exists to absorb.
    }
  }
}

function guardUnhandledRejections(report: (reason: unknown) => void): () => void {
  rejectionReporters.add(report);
  if (installedRejectionHandler === null) {
    installedRejectionHandler = reportUnhandledRejection;
    process.on("unhandledRejection", installedRejectionHandler);
  }
  return (): void => {
    rejectionReporters.delete(report);
    if (rejectionReporters.size > 0 || installedRejectionHandler === null) return;
    process.off("unhandledRejection", installedRejectionHandler);
    installedRejectionHandler = null;
  };
}

/** Is this process's unhandled-rejection guard armed? **For its own test.** */
export function rejectionGuardArmed(): boolean {
  return installedRejectionHandler !== null;
}

export class HostServer {
  private readonly ops: HostOps;
  /** Where the host's own state lives. The nonce is written through this one. */
  private readonly dataDir: DataDir;
  /**
   * The socket's **own** directory, as its own root.
   *
   * Rooted at the directory rather than at `config.dataDir`, and the reason is a
   * hard limit rather than a preference: a Unix socket address is capped at
   * about 104 bytes on Darwin, so `socketPath` cannot always be expressed as a
   * long path under the state directory — a checked-out worktree is already
   * ninety characters before the `run/<digest>/host.sock` tail. Production does
   * put it under the data dir (`socketPathFor`), and a caller that needs it
   * shorter may point `socketPath` anywhere; either way the directory is
   * created, `stat`ed and enforced here, through the same file-system seam, and
   * the containment rule still holds — everything this object touches is inside
   * the one directory it is rooted at.
   */
  private readonly socketDir: DataDir;
  private readonly connections = new Set<Connection>();
  /**
   * Every connection that has not said `host.hello` yet, and the deadline armed
   * on it.
   *
   * **The nonce gate could not reach the peer that says nothing.** It destroys a
   * connection whose first line is wrong, which is the whole answer for a peer
   * that speaks — and no answer at all for one that connects and then holds the
   * socket open in silence. That peer costs a connection slot, a read buffer and
   * a `Connection` object for as long as it cares to, and a peer opening sockets
   * in a loop costs one of each per socket.
   *
   * So: a deadline per connection, and a cap on how many may be in this map at
   * once. The deadline bounds how long one silent peer lasts; the cap bounds how
   * many can exist inside that window. A connection leaves this map the moment
   * it authenticates or the moment it closes, whichever comes first, and its
   * timer goes with it — so an idle host has nothing armed.
   */
  private readonly preAuth = new Map<Connection, NodeJS.Timeout | null>();
  /** See {@link HostServer.preAuthClosed}. */
  private preAuthClosedCount = 0;
  private readonly detachers: Array<() => void> = [];
  private server: Server | null = null;
  private listening: Promise<string> | null = null;
  private nonce: Buffer | null = null;
  private subscriptionSequence = 0;
  /**
   * Names connections, so a refusal can say *which* client holds something.
   *
   * "Another client already holds the interaction channel" is not actionable;
   * "`host-conn-2` holds it" is, because the operator can see which of their
   * clients that is. Never reused within a process, and never parsed.
   */
  private connectionSequence = 0;
  /** Events waiting for a turn of the loop. See {@link HostServer.broadcast}. */
  private readonly outbox: HostEvent[] = [];
  private pumping = false;
  /**
   * Daemon `generation_committed` events the mirror has not caught up to yet.
   *
   * Oldest first. See {@link HostServer.relayDaemonEvent} for why they are held
   * rather than delivered on arrival.
   */
  private readonly heldCommits: Array<{ generation: number; event: HostEvent }> = [];
  /**
   * Has this episode of holding already been collapsed?
   *
   * Re-armed by {@link HostServer.releaseHeldCommits} when the mirror actually
   * releases something — which is the only evidence that the condition the
   * collapse described has changed. See {@link HostServer.hold}.
   */
  private holdCollapsed = false;
  /** Uninstalls the process-level unhandled-rejection guard. */
  private readonly unguard: () => void;

  constructor(private readonly deps: HostServerDeps) {
    this.ops = new HostOps(deps);
    this.dataDir = new DataDir(deps.config.dataDir);
    this.socketDir = new DataDir(dirname(deps.config.socketPath));
    this.unguard = guardUnhandledRejections((reason) => {
      deps.errors.report(reason, HOST_PLUGIN_ID, "event");
    });
    this.subscribeToSources();
  }

  /** Called by Task 20b once the three late services exist. */
  attachWiring(wiring: HostServerWiring): void {
    this.ops.attachWiring(wiring);
  }

  /**
   * Bind the socket, having proved the directory it lives in is this user's
   * alone. Resolves with the socket path. Idempotent.
   */
  listen(): Promise<string> {
    // **The rejection is not cached.** `??=` keeps a rejected promise, because a
    // rejected promise is not nullish — so a host that refused to listen on a
    // widened directory could never listen again in that process, not even after
    // the operator ran the `chmod` the refusal asked for. A failure clears the
    // slot; a success is idempotent.
    this.listening ??= this.bind().catch((error: unknown) => {
      this.listening = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
    return this.listening;
  }

  /** How many authenticated clients are connected. */
  clientCount(): number {
    let count = 0;
    for (const connection of this.connections) if (connection.authenticated) count += 1;
    return count;
  }

  /**
   * How many events are waiting across every client's subscriptions.
   *
   * Zero on a healthy host: an event is written straight through unless the
   * socket has told this host to stop. A number above zero means at least one
   * subscriber is behind, which is worth reporting — and it is what lets a test
   * say "keep going until the socket is actually backed up" rather than guess a
   * number of events from how much a particular kernel buffers for a Unix
   * socket.
   */
  pendingEvents(): number {
    let total = 0;
    for (const connection of this.connections) total += connection.subscriptions.pending();
    return total;
  }

  /**
   * Send one event to every subscription on every connected client.
   *
   * **A burst yields between events once anybody is behind.** A client reading
   * as fast as it can still cannot drain a socket inside the turn that filled
   * it: the kernel takes some tens of events and then the rest have nowhere to
   * go but the bounded queue, so a thousand events emitted in one synchronous
   * loop used to collapse a perfectly healthy reader into a `subscriber_lag`.
   * Measured before this: 1,000 synchronous broadcasts at a limit of 256
   * delivered 74 and one collapse.
   *
   * So a broadcast that finds a subscriber behind hands the loop a turn before
   * the next event. The turn is what lets the socket flush, which is what makes
   * "behind" go away — and a subscriber that is genuinely stalled stays behind
   * however many turns it is given, so the collapse still happens for the client
   * the bound exists for. The outbox is drained in order and is bounded by the
   * burst the producer is already holding.
   */
  broadcast(event: HostEvent): void {
    this.outbox.push(event);
    if (!this.pumping) this.pump();
  }

  private pump(): void {
    this.pumping = true;
    for (;;) {
      const next = this.outbox.shift();
      if (next === undefined) {
        this.pumping = false;
        return;
      }
      for (const connection of this.connections) connection.subscriptions.deliver(next);
      if (this.pendingEvents() > 0) {
        setImmediate(() => {
          this.pump();
        });
        return;
      }
    }
  }

  /**
   * Relay one event from the daemon's subscription.
   *
   * Task 22's `main.ts` is the caller: the supervisor owns the one subscription
   * per engine, and this is where it hands events on. An event kind this build
   * does not know is passed through as itself, because the wire's evolution rule
   * is that an unrecognized event degrades rather than fails, and a client of
   * this host may well understand a daemon this host does not.
   *
   * **`generation_committed` is relayed with the daemon's own payload, held
   * until this host's mirror has caught up to it.** Both halves matter and they
   * pull in opposite directions:
   *
   * - *Unchanged*, because a client correlating this door with a direct daemon
   *   subscription must see the same numbers. The host cannot honestly recompute
   *   `affected_reference_count`, and `previous_generation` and `cause` are the
   *   daemon's account of its own commit, not this host's. The first cut
   *   synthesized all of them from the mirror's batch and every one of them
   *   differed.
   * - *Held*, because a client of this host pages **this host's mirror**
   *   (`host.open_snapshot`), so an event announcing generation N before the
   *   mirror holds N would invite a client to page a view that does not have it.
   *
   * So the payload is the daemon's and the moment is the mirror's:
   * `mirror.appliedThrough() >= value.generation` is the release condition, and
   * {@link HostServer.releaseHeldCommits} runs it on every applied batch.
   *
   * **A `resync_required` voids every held commit at or below the generation it
   * names.** A subscriber that has just been told "your view is void, re-read at
   * generation N" must not then receive a change set for generation 2: a client
   * that applied it would move its own state *backwards*, which is the one thing
   * the resync told it not to do. So the resync is relayed — it is never held,
   * because it is a statement about the engine rather than about this host's
   * view — and the held set is pruned behind it. It is the queue's own collapse
   * discipline one layer up: **one message, not a prefix of the truth.**
   *
   * `config_changed` arrives here as well as through the mirror's own seam, and
   * only the mirror's is broadcast — one announcement per raw write into the
   * config zone, from the seam that also invalidates this host's cached config.
   */
  relayDaemonEvent(event: RuntimeEventDto): void {
    if (isKnownRuntimeEvent(event) && event.type === "config_changed") return;
    if (isKnownRuntimeEvent(event) && event.type === "generation_committed") {
      this.hold(event.value.generation, { type: event.type, value: event.value });
      return;
    }
    if (isKnownRuntimeEvent(event) && event.type === "resync_required") {
      // `null` means the daemon could not name a generation, which is the
      // strongest form of "start over": everything held is void.
      this.voidHeldCommits(event.value.current_generation ?? Number.POSITIVE_INFINITY);
    }
    this.broadcast({ type: event.type, value: event.value });
  }

  /** How many daemon commits are waiting for the mirror. **For its own test.** */
  heldCommitCount(): number {
    return this.heldCommits.length;
  }

  /**
   * Hold one commit until the mirror reaches it — or deliver it now, or collapse.
   *
   * **The held list is bounded, like every other buffer on this door.** It was
   * the one that was not: a mirror that falls a long way behind a committing
   * daemon — a slow re-hydration, a stalled engine connection, a vault import —
   * grew it without limit, measured at 7.4 MiB for twenty thousand commits with
   * nothing refusing, dropping or collapsing any of them.
   *
   * The bound is `subscriberQueueLimit`, and overflow takes the same road the
   * queue's own overflow takes: drop the held set **whole** and owe one
   * `resync_required { subscriber_lag }`. That is not a compromise — a mirror
   * that far behind is going to re-hydrate anyway, and a client being told to
   * re-read needs none of the detail that was being held for it.
   */
  private hold(generation: number, event: HostEvent): void {
    if (this.deps.mirror.appliedThrough() >= generation) {
      this.broadcast(event);
      return;
    }
    this.heldCommits.push({ generation, event });
    if (this.heldCommits.length <= this.deps.config.subscriberQueueLimit) return;
    this.heldCommits.length = 0;
    // **One collapse per episode, not one per overflow.** A mirror that stays
    // still under a committing daemon overflows the held set again every
    // `subscriberQueueLimit` commits, and announcing each one told a subscriber
    // the same true thing three hundred times over twenty thousand commits —
    // three hundred re-hydrations for one condition. The queue's own discipline
    // is *one message, not a prefix of the truth*, and this is that rule for the
    // layer above it: say it once, and say nothing more until the mirror has
    // actually moved. {@link releaseHeldCommits} is what re-arms it.
    if (this.holdCollapsed) return;
    this.holdCollapsed = true;
    const reason: ResyncReasonDto = "subscriber_lag";
    this.broadcast({
      type: "resync_required",
      value: { current_generation: this.deps.mirror.generation(), reason },
    });
  }

  /** Forget every held commit at or below `generation`. See {@link relayDaemonEvent}. */
  private voidHeldCommits(generation: number): void {
    if (this.heldCommits.length === 0) return;
    const kept = this.heldCommits.filter((held) => held.generation > generation);
    this.heldCommits.splice(0, this.heldCommits.length, ...kept);
  }

  /**
   * Deliver every held commit the mirror has now caught up to, in order.
   *
   * In generation order rather than arrival order, because the release condition
   * is a watermark: a batch that lands the mirror on generation 9 releases 7, 8
   * and 9 at once, and a client must see them the way the daemon committed them.
   */
  private releaseHeldCommits(): void {
    if (this.heldCommits.length === 0) return;
    const appliedThrough = this.deps.mirror.appliedThrough();
    const ready = this.heldCommits.filter((held) => held.generation <= appliedThrough);
    if (ready.length === 0) return;
    this.heldCommits.splice(
      0,
      this.heldCommits.length,
      ...this.heldCommits.filter((held) => held.generation > appliedThrough),
    );
    // The mirror moved, so the episode is over: a later overflow is a new
    // condition and is worth saying once more.
    this.holdCollapsed = false;
    ready.sort((left, right) => left.generation - right.generation);
    for (const held of ready) this.broadcast(held.event);
  }

  /**
   * Resolve once every queued event has been written.
   *
   * Not a sleep: it yields until no connection has anything left to flush. A
   * connection whose socket is backed up — a client that has stopped reading —
   * is not waited on, because waiting for one would be the host blocking on a
   * slow subscriber, which is the one thing this design refuses to do.
   */
  async quiesce(): Promise<void> {
    for (let turn = 0; turn < 100; turn += 1) {
      // A macrotask rather than an immediate, because the thing a caller is
      // usually waiting for is a socket event: a client's `close` reaches this
      // process from the poll phase, and a loop that only drained the check
      // phase would answer "quiet" while a disconnect was still in flight — and
      // `clientCount()` would then be one too high for no reason a reader could
      // see.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const busy =
        this.outbox.length > 0 ||
        [...this.connections].some(
          (connection) =>
            connection.subscriptions.pending() > 0 && !connection.subscriptions.blocked(),
        );
      if (!busy && turn >= 2) return;
    }
  }

  /** Stop listening, drop every client, and detach from every event source. */
  async close(): Promise<void> {
    for (const detach of this.detachers.splice(0)) detach();
    this.unguard();
    this.outbox.length = 0;
    this.heldCommits.length = 0;
    this.holdCollapsed = false;
    for (const connection of [...this.connections]) connection.destroy();
    this.connections.clear();
    // Each `destroy` above reached `gone` and disarmed its own deadline; this is
    // the sweep for anything that did not, so a closed host leaves no timer on
    // the clock whatever order the closes arrived in.
    for (const connection of [...this.preAuth.keys()]) this.clearPreAuth(connection);
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    // The nonce belongs to a running host. Leaving it behind would leave a
    // secret on disk for a socket nothing is listening on, and the next `listen`
    // mints a new one anyway.
    this.nonce = null;
    this.dataDir.remove(NONCE_FILE);
  }

  // --- Binding ---------------------------------------------------------------

  private async bind(): Promise<string> {
    const socketPath = this.deps.config.socketPath;
    const file = basename(socketPath);
    this.socketDir.ensureSecureDir(".");
    this.assertDirectory(socketPath);
    // A socket left by a host that died: the file is not a live endpoint, and
    // `listen` would answer `EADDRINUSE` for a path nothing is serving.
    if (this.socketDir.exists(file)) this.socketDir.remove(file);

    const server = createServer((socket) => {
      this.accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;

    this.socketDir.chmod(file, 0o600);
    const socketMode = this.socketDir.ownership(file);
    if (socketMode === null || socketMode.mode !== 0o600) {
      await this.close();
      throw new Error(
        `the host socket ${socketPath} is mode ` +
          `${(socketMode?.mode ?? 0).toString(8)} rather than 600 after chmod`,
      );
    }
    // Written last, so a nonce on disk means a socket that is up: a client that
    // can read the nonce can connect, rather than racing a bind that has not
    // finished.
    this.nonce = randomBytes(32);
    this.dataDir.writeSecret(NONCE_FILE, this.nonce.toString("hex"));
    return socketPath;
  }

  /**
   * Refuse to listen unless the socket's directory is this user's alone.
   *
   * This is the assertion the whole trust model rests on, so it is made against
   * a fresh `stat` rather than against what `mkdir` was asked for: a directory
   * that already existed was created by somebody, possibly under a different
   * umask, possibly widened since.
   */
  private assertDirectory(socketPath: string): void {
    const found = this.socketDir.ownership(".");
    if (found === null) {
      throw new Error(`the host socket directory for ${socketPath} could not be created`);
    }
    if (found.mode !== 0o700) {
      throw new Error(
        `refusing to listen: the socket directory mode is ${found.mode.toString(8)} rather than ` +
          "700. The directory mode is what actually stops another user reaching this socket — a " +
          "socket file's own mode is advisory on Darwin — so a widened directory is a refusal " +
          `rather than something to repair. Run: chmod 700 ${dirname(socketPath)}`,
      );
    }
    const uid = process.getuid?.();
    if (uid !== undefined && found.uid !== uid) {
      throw new Error(
        `refusing to listen: the socket directory is owned by uid ${String(found.uid)} and this ` +
          `host runs as uid ${String(uid)}`,
      );
    }
  }

  // --- Connections -----------------------------------------------------------

  private accept(socket: Socket): void {
    // **The newest goes, not the oldest.** An older pre-auth connection may be
    // a real client mid-handshake — it read the nonce file and is writing its
    // hello — while the one that has just arrived is the marginal socket of
    // whoever is opening them in a loop. Closed before a `Connection` is built
    // at all, so a flood costs a socket and nothing else. No reply: there is no
    // request to answer, and a host that wrote something back would be telling a
    // silent peer the socket is there.
    if (this.preAuth.size >= this.deps.config.maxPreAuthConnections) {
      this.preAuthClosedCount += 1;
      socket.destroy();
      return;
    }
    this.connectionSequence += 1;
    const connection = new Connection(socket, {
      label: `host-conn-${String(this.connectionSequence)}`,
      limit: this.deps.config.subscriberQueueLimit,
      lineCap: lineCapFor(this.deps.config),
      currentGeneration: () => this.deps.mirror.generation(),
      mintId: () => {
        this.subscriptionSequence += 1;
        return `host-sub-${String(this.subscriptionSequence)}`;
      },
      authenticate: (nonce) => this.matchesNonce(nonce),
      admitted: (connection) => {
        this.clearPreAuth(connection);
      },
      hello: () => this.ops.hello(),
      dispatch: (method, params, session) => this.ops.dispatch(method, params, session),
      gone: (closed) => {
        this.connections.delete(closed);
        // Before anything else: a connection that went away owes no handshake,
        // and a deadline left armed for it would fire into a closed socket and
        // keep a timer on the clock that nothing can account for.
        this.clearPreAuth(closed);
        // A disconnect releases everything the client held: its subscriptions,
        // its snapshot sessions, and the interaction channel if it was holding
        // that. A crashed client must not leave a frozen view of the vault in
        // this host's memory for the life of the process — nor a plugin waiting
        // two minutes on a prompt nobody is left to answer.
        this.ops.connectionGone(closed.session);
      },
    });
    this.connections.add(connection);
    this.armHandshakeDeadline(connection);
  }

  /**
   * Give this connection until `handshakeTimeoutMs` to say a well-formed hello.
   *
   * On `config.clock` like every other duration in this host, which is what lets
   * a test advance to the deadline rather than wait for it — and what makes
   * "nothing is left armed" an assertion a test can make against
   * `clock.armed()`.
   *
   * A non-positive timeout arms nothing. The connection is still tracked, so the
   * accept cap still bounds how many silent peers may pile up: the two rules are
   * independent, and a host that turned the deadline off should not lose the cap
   * with it.
   */
  private armHandshakeDeadline(connection: Connection): void {
    const timeoutMs = this.deps.config.handshakeTimeoutMs;
    if (timeoutMs <= 0) {
      this.preAuth.set(connection, null);
      return;
    }
    const handle = this.deps.config.clock.setTimeout(() => {
      // Counted first: `destroy` reaches `gone`, which takes this connection out
      // of the map, and a count taken afterwards would be a count of a
      // connection nothing remembers.
      this.preAuthClosedCount += 1;
      connection.destroy();
    }, timeoutMs);
    this.preAuth.set(connection, handle);
  }

  /** This connection is authenticated or gone: disarm its deadline and forget it. */
  private clearPreAuth(connection: Connection): void {
    const handle = this.preAuth.get(connection);
    if (handle === undefined) return;
    this.preAuth.delete(connection);
    if (handle !== null) this.deps.config.clock.clearTimeout(handle);
  }

  /**
   * How many connections this host has closed for never authenticating.
   *
   * **One count for both rules**, because they are one fact from the operator's
   * side: a peer that held a socket without ever presenting the nonce. Which
   * bound caught it — the deadline or the accept cap — changes nothing about
   * what to do next, and a host with a number here worth looking at has
   * something on the machine opening sockets it never speaks on.
   */
  preAuthClosed(): number {
    return this.preAuthClosedCount;
  }

  /**
   * Constant-time nonce comparison.
   *
   * `timingSafeEqual` refuses buffers of different lengths, so the length is
   * checked first and a wrong length is simply wrong — there is nothing to learn
   * from how long it took to find that out, because the length of the nonce is
   * not a secret.
   */
  private matchesNonce(offered: string): boolean {
    const expected = this.nonce;
    if (expected === null) return false;
    const given = Buffer.from(offered, "hex");
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  }

  // --- Event sources ---------------------------------------------------------

  private subscribeToSources(): void {
    // The mirror is the **clock**, not the source: a batch says how far this
    // host's view has come, and what it releases is the daemon's own account of
    // the generations it has now reached. See {@link relayDaemonEvent}.
    this.detachers.push(
      this.deps.mirror.onBatch(() => {
        this.releaseHeldCommits();
      }),
    );
    this.detachers.push(
      this.deps.mirror.onConfigChanged((path) => {
        this.broadcast({ type: "config_changed", value: { path } });
      }),
    );
    this.detachers.push(
      this.deps.lifecycle.onPluginStateChanged((change) => {
        this.broadcast({
          type: "host.plugin_state_changed",
          value: { id: change.id, state: change.state, reason: change.reason },
        });
      }),
    );
    this.detachers.push(
      this.deps.noticeLog.onRecord((entry) => {
        this.broadcast({ type: "host.notice", value: toWireNotice(entry) });
      }),
    );
    this.detachers.push(
      this.deps.coexistence.onOverlapChanged((report) => {
        const wire = toWireOverlap(report);
        this.broadcast({
          type: "host.overlap_changed",
          value: { overlap: wire.overlap, gui_enabled: wire.gui_enabled },
        });
      }),
    );
    // A plugin opened a search and the engine answered (or refused). The event
    // carries the count and the refusal; the hits are `host.search_state`'s, so
    // a page of results is never pushed to every subscriber.
    this.detachers.push(
      this.deps.globalSearch.onOpened((state) => {
        this.broadcast({
          type: "host.search_opened",
          value: {
            query: state.query,
            total_files: state.answer?.total_files ?? null,
            error: state.error,
          },
        });
      }),
    );
  }

}

/** What a {@link Connection} needs of the server that owns it. */
interface ConnectionDeps {
  /** What a refusal calls this connection — `host-conn-3`. See `connectionSequence`. */
  readonly label: string;
  readonly limit: number;
  /** Bytes of UTF-8 one request line may reach. See {@link lineCapFor}. */
  readonly lineCap: number;
  readonly currentGeneration: () => number;
  readonly mintId: () => string;
  readonly authenticate: (nonce: string) => boolean;
  /**
   * This connection has just passed the nonce gate.
   *
   * The event the handshake deadline waits for: an admitted connection is a
   * client, and a client is not on a deadline. Raised before the `host.hello`
   * answer is composed, because the gate is what the deadline is about and the
   * answer can take as long as the daemon does.
   */
  readonly admitted: (connection: Connection) => void;
  readonly hello: () => Promise<unknown>;
  readonly dispatch: (method: string, params: unknown, session: OpSession) => Promise<unknown>;
  readonly gone: (connection: Connection) => void;
}

/**
 * One client connection: the line framing, the nonce gate, and the one writer.
 *
 * **Every line this connection sends goes through {@link Connection.write}**,
 * responses and events alike, so a response can never be interleaved with an
 * event — which is the same guarantee `vaultd`'s stdio transport gives, where
 * exactly one writer owns the output stream.
 */
class Connection {
  readonly subscriptions: ClientSubscriptions;
  readonly session: OpSession;
  authenticated = false;

  private buffered = "";
  /** The byte length of {@link buffered}, kept incrementally. See {@link absorb}. */
  private bufferedBytes = 0;
  private destroyed = false;
  /** Flush loops waiting for the socket to have taken everything written. */
  private readonly drainWaiters: Array<() => void> = [];

  constructor(
    private readonly socket: Socket,
    private readonly deps: ConnectionDeps,
  ) {
    this.subscriptions = new ClientSubscriptions({
      limit: deps.limit,
      currentGeneration: deps.currentGeneration,
      mintId: deps.mintId,
      writer: {
        write: (line) => this.write(line),
        onceDrain: (listener) => {
          this.onceDrain(listener);
        },
      },
    });
    this.session = {
      owner: {},
      label: deps.label,
      subscriptions: this.subscriptions,
      // Down **this** socket and no other, and the answer travels back. The
      // broker addresses a prompt to the one client that said it would answer;
      // `HostServer.broadcast` is the other shape, for things every subscriber
      // is owed a copy of and where a collapsed delivery is the client's to
      // recover from by re-reading.
      deliver: (event) => this.subscriptions.deliver(event),
    };
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.absorb(chunk);
    });
    socket.on("error", () => {
      // A peer that went away mid-write is an ordinary end of a connection, not
      // a fault of this host's: `write` on a destroyed socket raises here rather
      // than throwing into whatever was broadcasting.
      this.finish();
    });
    socket.on("close", () => {
      this.finish();
    });
  }

  destroy(): void {
    this.socket.destroy();
    this.finish();
  }

  /**
   * Write one framed line. `false` means the socket has not taken it all yet.
   *
   * **Backpressure is "the socket still holds bytes", not "Node's buffer passed
   * its high-water mark", and the difference is the whole point.** A stream
   * answers `false` from `write()` only once it has buffered 16 KB *of its own*
   * — so a subscriber that stops reading would have the host quietly build a
   * second, unbounded queue inside the socket, underneath the bounded one this
   * design is built around. Measured: two hundred events to a paused peer buffer
   * about 50 KB inside the stream and the flush slows to roughly 200 ms an event
   * as libuv retries the whole queue every turn — a host degraded by a client
   * that walked away, which is exactly the failure the queue exists to prevent.
   *
   * So at most one line is ever in flight: the write's own callback is what says
   * the socket has caught up, and everything else waits in the queue where it
   * can be counted, bounded, and collapsed into one `resync_required`.
   */
  private write(line: string): boolean {
    if (this.destroyed) return false;
    this.socket.write(line, () => {
      this.releaseDrain();
    });
    return this.socket.writableLength === 0;
  }

  /** Call `listener` once the socket holds nothing of ours. */
  private onceDrain(listener: () => void): void {
    // Nothing outstanding — which happens when a response was written between
    // the flush's last event and this call — so there is no callback coming and
    // the flush must be restarted rather than left waiting forever.
    if (this.destroyed || this.socket.writableLength === 0) {
      setImmediate(listener);
      return;
    }
    this.drainWaiters.push(listener);
  }

  private releaseDrain(): void {
    if (this.socket.writableLength !== 0) return;
    for (const listener of this.drainWaiters.splice(0)) listener();
  }

  private finish(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.subscriptions.clear();
    // A flush waiting on a socket that is gone would wait forever, and the
    // subscriptions it was flushing have just been dropped: let it run once and
    // find an empty queue.
    for (const listener of this.drainWaiters.splice(0)) listener();
    this.deps.gone(this);
  }

  /**
   * Take one chunk, and hand over every complete line in it.
   *
   * **The cap is counted in bytes, incrementally.** `String.length` counts
   * UTF-16 units, so a multi-byte payload used to reach several times the
   * intended cap before the destroy fired — and measuring the whole buffer on
   * every chunk instead would be quadratic in exactly the case the cap exists
   * for, a peer that never sends a newline. So each chunk's own byte length is
   * added as it arrives (the socket decodes UTF-8, so a chunk never splits a
   * character), and the counter is recomputed from the remainder only when a
   * line has actually been consumed — which is short in every case but the one
   * that is about to be destroyed anyway.
   */
  private absorb(chunk: string): void {
    this.buffered += chunk;
    this.bufferedBytes += Buffer.byteLength(chunk, "utf8");
    if (this.bufferedBytes > this.deps.lineCap) {
      this.destroy();
      return;
    }
    let newline = this.buffered.indexOf("\n");
    if (newline === -1) return;
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line.trim().length > 0) this.dispatchLine(line);
      newline = this.buffered.indexOf("\n");
    }
    this.bufferedBytes = Buffer.byteLength(this.buffered, "utf8");
  }

  /**
   * Hand one line to the handler so that **no rejection can escape**.
   *
   * `void this.handle(line)` was a floating promise, and a floating promise that
   * rejects is an unhandled rejection — which Node terminates the process for by
   * default since v15, and this host declares `node >= 24`. Five bytes (`null\n`)
   * from a peer that had presented no nonce reached exactly that: `JSON.parse`
   * answered `null`, reading `.id` off it threw a `TypeError`, and the whole host
   * — every loaded plugin, every subscription, every other client — went down.
   *
   * So the invocation carries its own catch. A refusal that reached here rather
   * than being answered inside `handle` is this host's own bug, not the client's,
   * so the connection is told and then destroyed: continuing to serve a
   * connection whose last request threw out of the dispatcher entirely is
   * pretending to a state that was never reached.
   */
  private dispatchLine(line: string): void {
    void this.handle(line).catch((error: unknown) => {
      this.fail("", error);
      this.destroy();
    });
  }

  /**
   * One request line, in the order the envelope is defined.
   *
   * **Parse, version, authentication, method, dispatch** — and the order is the
   * contract rather than a convenience. `docs/protocol.md` puts version
   * validation ahead of method dispatch so that an unsupported version is told
   * so even when it names a method this build does not know; the nonce gate sits
   * directly behind it, because an unauthenticated peer must not be able to
   * reach the dispatcher, the parameter decoders, or a free retry by sending
   * something malformed.
   */
  private async handle(line: string): Promise<void> {
    const parsed = parseEnvelope(line);
    if (parsed === null) {
      // Input with no usable envelope is a fatal input error on the daemon's own
      // transport, and it is one here: `null`, `5`, `"x"` and `[]` all parse and
      // none of them is a request, so there is no `id` to echo and no way to tell
      // the client which of its lines this was about.
      this.destroy();
      return;
    }
    const id = echoableId(parsed.id);
    if (parsed.version !== HOST_PROTOCOL_VERSION) {
      this.fail(
        id,
        new HostError(
          "incompatible_version",
          `this host speaks protocol version ${String(HOST_PROTOCOL_VERSION)}; the request ` +
            `carried ${JSON.stringify(parsed.version)}`,
          { supported_version: HOST_PROTOCOL_VERSION },
        ),
      );
      // Pre-authentication this is still "not a well-formed `host.hello`", so
      // the connection goes with it. An admitted client is told and kept, the
      // way the daemon keeps a connection that sent one bad version.
      if (!this.authenticated) this.finishAfterRefusal();
      return;
    }

    if (!this.authenticated) {
      await this.admit(id, parsed.method, parsed.params);
      return;
    }
    if (typeof parsed.method !== "string") {
      this.fail(id, new HostError("invalid_request", "every request carries a string method"));
      return;
    }
    if (parsed.method === "host.hello") {
      this.fail(id, new HostError("invalid_request", "this connection has already said hello"));
      return;
    }
    try {
      this.answer(id, parsed.method, await this.deps.dispatch(parsed.method, parsed.params, this.session));
    } catch (error) {
      this.fail(id, error);
    }
  }

  /**
   * The nonce gate: the only thing an unauthenticated connection may do.
   *
   * **Anything that is not a well-formed `host.hello` carrying the nonce is
   * `not_owner`, and the socket goes.** Not only a wrong nonce: a missing
   * `request`, a method that is not a string, params that are not an object, a
   * different method entirely. The previous order checked the *shape* first and
   * answered `invalid_request` while keeping the connection, which made a
   * malformed line a free retry channel — measured at a hundred refusals on one
   * unauthenticated connection followed by a successful hello on that same
   * connection. No privilege was gained, but "one attempt, then destroyed" was
   * not true, and the same path was how a rejection escaped the door.
   *
   * There is nothing to guess — the nonce is 32 random bytes — so a connection
   * that got it wrong is either a bug or a probe, and neither is owed a retry on
   * the same connection.
   */
  private async admit(id: string | number, method: unknown, params: unknown): Promise<void> {
    const offered = isObject(params) ? params["nonce"] : undefined;
    if (method !== "host.hello" || typeof offered !== "string" || !this.deps.authenticate(offered)) {
      this.fail(
        id,
        new HostError(
          "not_owner",
          "the first line on a host connection must be host.hello carrying the ownership nonce " +
            "from <dataDir>/nonce, which only this user can read",
        ),
      );
      this.finishAfterRefusal();
      return;
    }
    this.authenticated = true;
    this.deps.admitted(this);
    try {
      this.answer(id, "host.hello", await this.deps.hello());
    } catch (error) {
      this.fail(id, error);
    }
  }

  /** Let the refusal reach the peer, then take the connection down. */
  private finishAfterRefusal(): void {
    this.socket.end();
    this.finish();
  }

  private answer(id: string | number, type: string, value: unknown): void {
    this.write(
      `${JSON.stringify({
        version: HOST_PROTOCOL_VERSION,
        id,
        outcome: { status: "ok", value: { type, value } },
      })}\n`,
    );
  }

  private fail(id: string | number, error: unknown): void {
    this.write(
      `${JSON.stringify({
        version: HOST_PROTOCOL_VERSION,
        id,
        outcome: { status: "err", value: bodyOf(error) },
      })}\n`,
    );
  }
}

/**
 * Whatever went wrong, as the wire's `{ code, message }`.
 *
 * A {@link VaultdError} keeps its **undisturbed** body, which is the
 * multiplexing rule's other half: a refusal the daemon made reaches the client
 * exactly as the daemon wrote it, `current_revision` and all, so a retry loop
 * behaves the same through either door. Anything else is `internal` — an
 * unexpected throw is a bug in this host, and dressing it up as a typed refusal
 * would tell the client it did something wrong.
 */
/** Is this a JSON object — not `null`, not an array, not a scalar? */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One line's envelope, or `null` when the line is not a request at all. */
function parseEnvelope(
  line: string,
): { version: unknown; id: unknown; method: unknown; params: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const request = parsed["request"];
  return {
    version: parsed["version"],
    id: parsed["id"],
    method: isObject(request) ? request["method"] : undefined,
    params: isObject(request) ? request["params"] : undefined,
  };
}

/**
 * The `id` to echo.
 *
 * A refusal echoes the request's id so a client can pair it with what it sent,
 * and a client that spelled its id as a number gets that number back rather than
 * an empty string it cannot match. Anything that is neither — an object, an
 * array, an absent key — has no useful echo, and `""` is what a client sees
 * instead.
 */
function echoableId(id: unknown): string | number {
  return typeof id === "string" || typeof id === "number" ? id : "";
}

function bodyOf(error: unknown): { code: string; message: string } {
  if (error instanceof HostError) return error.body();
  if (error instanceof VaultdError) return error.body;
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}
