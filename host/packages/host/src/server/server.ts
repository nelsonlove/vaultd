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
 * `host.overlap_changed`) come from the components that produce them. The
 * daemon-shaped events are relayed with their `vaultd` payloads, with one
 * deliberate difference: **`generation_committed` is emitted from the mirror's
 * applied batch rather than relayed from the daemon's subscription.** A client
 * of this host reads this host's mirror — `host.open_snapshot` serves from it —
 * so an event announcing a generation the mirror has not applied yet would
 * invite a client to page a view that does not hold it. Emitting at apply time
 * makes the event mean "the host's view is now at N", which is the only claim
 * this door can honestly make. `runtime_state_changed` and `resync_required`
 * pass through {@link HostServer.relayDaemonEvent} untouched, because both are
 * statements about the engine rather than about this host's view.
 */

import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { ClientSubscriptions } from "./subscriptions";
import { DataDir } from "../datadir";
import { HostError } from "./wire";
import { HostOps, HOST_PROTOCOL_VERSION } from "./ops";
import { VaultdError } from "../client/errors";
import { isKnownRuntimeEvent } from "../client/protocol";
import { toWireNotice, toWireOverlap } from "./wire";
import type { HostEvent } from "./subscriptions";
import type { HostServerDeps, HostServerWiring, OpSession } from "./ops";
import type { MirrorChangeBatch } from "../mirror/types";
import type { RuntimeEventDto } from "../client/protocol";

export type { HostServerDeps, HostServerWiring } from "./ops";

/** The file, inside the host's data directory, that holds the ownership nonce. */
const NONCE_FILE = "nonce";

/**
 * How long one request line may be.
 *
 * A client that sends an unterminated stream would otherwise grow this host's
 * memory one chunk at a time, which is the same hazard the subscriber queue is
 * bounded against and deserves the same answer: a bound, and a connection that
 * is destroyed rather than served. 16 MB matches `HostConfig.writeFileCapBytes`,
 * so the largest legitimate request — a `write_file` forwarded to the daemon —
 * still fits with room for its envelope.
 */
const MAX_LINE_BYTES = 17 * 1024 * 1024;

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
  private readonly detachers: Array<() => void> = [];
  private server: Server | null = null;
  private listening: Promise<string> | null = null;
  private nonce: Buffer | null = null;
  private subscriptionSequence = 0;
  /**
   * The generation this host last announced.
   *
   * `generation_committed` carries `previous_generation`, and the honest value
   * for it on this door is where *this host's view* was before the batch —
   * which is not necessarily the daemon's `previous_generation`, because a
   * re-hydration can move the mirror across several generations at once.
   */
  private lastAnnounced: number;

  constructor(private readonly deps: HostServerDeps) {
    this.ops = new HostOps(deps);
    this.dataDir = new DataDir(deps.config.dataDir);
    this.socketDir = new DataDir(dirname(deps.config.socketPath));
    this.lastAnnounced = deps.mirror.generation();
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
    this.listening ??= this.bind();
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

  /** Send one event to every subscription on every connected client. */
  broadcast(event: HostEvent): void {
    for (const connection of this.connections) connection.subscriptions.deliver(event);
  }

  /**
   * Relay one event from the daemon's subscription.
   *
   * Task 22's `main.ts` is the caller: the supervisor owns the one subscription
   * per engine, and this is where it hands events on. `generation_committed` is
   * **not** relayed — see this file's header — and an event kind this build does
   * not know is passed through as itself, because the wire's evolution rule is
   * that an unrecognized event degrades rather than fails, and a client of this
   * host may well understand a daemon this host does not.
   */
  relayDaemonEvent(event: RuntimeEventDto): void {
    if (isKnownRuntimeEvent(event) && event.type === "generation_committed") return;
    // `config_changed` arrives here as well as through the mirror's own seam;
    // only the mirror's is broadcast, so a raw write into the config zone is
    // announced once rather than twice.
    if (isKnownRuntimeEvent(event) && event.type === "config_changed") return;
    this.broadcast({ type: event.type, value: event.value });
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
      const busy = [...this.connections].some(
        (connection) =>
          connection.subscriptions.pending() > 0 && !connection.subscriptions.blocked(),
      );
      if (!busy && turn >= 2) return;
    }
  }

  /** Stop listening, drop every client, and detach from every event source. */
  async close(): Promise<void> {
    for (const detach of this.detachers.splice(0)) detach();
    for (const connection of [...this.connections]) connection.destroy();
    this.connections.clear();
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
    const connection = new Connection(socket, {
      limit: this.deps.config.subscriberQueueLimit,
      currentGeneration: () => this.deps.mirror.generation(),
      mintId: () => {
        this.subscriptionSequence += 1;
        return `host-sub-${String(this.subscriptionSequence)}`;
      },
      authenticate: (nonce) => this.matchesNonce(nonce),
      hello: () => this.ops.hello(),
      dispatch: (method, params, session) => this.ops.dispatch(method, params, session),
      gone: (closed) => {
        this.connections.delete(closed);
        // A disconnect releases everything the client held: its subscriptions
        // and its snapshot sessions. A crashed client must not leave a frozen
        // view of the vault in this host's memory for the life of the process.
        this.ops.snapshots.closeAll(closed.session.owner);
      },
    });
    this.connections.add(connection);
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
    this.detachers.push(
      this.deps.mirror.onBatch((batch) => {
        this.broadcast(this.committedEvent(batch));
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
  }

  /**
   * One applied batch, as `vaultd`'s `generation_committed`.
   *
   * `changes` is the daemon's `detailed` shape because that is what it is: this
   * host never announces counts-only, since a batch it could not describe path
   * by path took the resync road inside the mirror and a `resync_required` is
   * what a subscriber hears instead.
   *
   * `affected_note_count` is counted here rather than carried, because the
   * mirror's batch does not carry it; `affected_reference_count` is **not**
   * invented, and is absent rather than reported as zero — a client that needs
   * it is asking a question only the daemon can answer.
   */
  private committedEvent(batch: MirrorChangeBatch): HostEvent {
    const previous = this.lastAnnounced;
    this.lastAnnounced = batch.generation;
    const paths = [...batch.created, ...batch.modified, ...batch.deleted];
    return {
      type: "generation_committed",
      value: {
        previous_generation: previous,
        generation: batch.generation,
        cause: batch.cause,
        changes: {
          kind: "detailed",
          created: [...batch.created],
          modified: [...batch.modified],
          deleted: [...batch.deleted],
        },
        affected_note_count: paths.filter((path) => path.toLowerCase().endsWith(".md")).length,
        synthetic: batch.synthetic,
      },
    };
  }
}

/** What a {@link Connection} needs of the server that owns it. */
interface ConnectionDeps {
  readonly limit: number;
  readonly currentGeneration: () => number;
  readonly mintId: () => string;
  readonly authenticate: (nonce: string) => boolean;
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
    this.session = { owner: {}, subscriptions: this.subscriptions };
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

  private absorb(chunk: string): void {
    this.buffered += chunk;
    if (this.buffered.length > MAX_LINE_BYTES) {
      this.destroy();
      return;
    }
    let newline = this.buffered.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line.trim().length > 0) void this.handle(line);
      newline = this.buffered.indexOf("\n");
    }
  }

  private async handle(line: string): Promise<void> {
    let envelope: { id?: unknown; request?: { method?: unknown; params?: unknown } };
    try {
      envelope = JSON.parse(line) as typeof envelope;
    } catch {
      // Input with no usable envelope is a fatal input error on the daemon's
      // own transport, and it is one here: there is no `id` to echo, so there is
      // no way to tell the client which of its requests this was about.
      this.destroy();
      return;
    }
    const id = typeof envelope.id === "string" ? envelope.id : "";
    const method = envelope.request?.method;
    if (typeof method !== "string") {
      this.fail(id, new HostError("invalid_request", "every request carries a string method"));
      return;
    }
    const params = envelope.request?.params;

    if (!this.authenticated) {
      await this.admit(id, method, params);
      return;
    }
    if (method === "host.hello") {
      this.fail(
        id,
        new HostError("invalid_request", "this connection has already said hello"),
      );
      return;
    }
    try {
      this.answer(id, method, await this.deps.dispatch(method, params, this.session));
    } catch (error) {
      this.fail(id, error);
    }
  }

  /**
   * The nonce gate: the only thing an unauthenticated connection may do.
   *
   * A refusal destroys the socket rather than leaving it open for a second
   * attempt. There is nothing to guess — the nonce is 32 random bytes — so a
   * connection that got it wrong is either a bug or a probe, and neither is
   * owed a retry on the same connection.
   */
  private async admit(id: string, method: string, params: unknown): Promise<void> {
    const offered = (params as { nonce?: unknown } | undefined)?.nonce;
    if (method !== "host.hello" || typeof offered !== "string" || !this.deps.authenticate(offered)) {
      this.fail(
        id,
        new HostError(
          "not_owner",
          "the first line on a host connection must be host.hello carrying the ownership nonce " +
            "from <dataDir>/nonce, which only this user can read",
        ),
      );
      this.socket.end();
      this.finish();
      return;
    }
    this.authenticated = true;
    try {
      this.answer(id, "host.hello", await this.deps.hello());
    } catch (error) {
      this.fail(id, error);
    }
  }

  private answer(id: string, type: string, value: unknown): void {
    this.write(
      `${JSON.stringify({
        version: HOST_PROTOCOL_VERSION,
        id,
        outcome: { status: "ok", value: { type, value } },
      })}\n`,
    );
  }

  private fail(id: string, error: unknown): void {
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
function bodyOf(error: unknown): { code: string; message: string } {
  if (error instanceof HostError) return error.body();
  if (error instanceof VaultdError) return error.body;
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}
