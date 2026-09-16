/**
 * The dispatch table: every `host.*` method, and the rule for everything else.
 *
 * **The multiplexing rule is the whole reason this host is one door rather than
 * two.** A method that does not begin with `host.` is forwarded to `vaultd`
 * verbatim and its outcome relayed unchanged, so `get_note`, `write_note`,
 * `list_notes` and every operation a future daemon adds work through this socket
 * with no host-side maintenance at all. A `host.`-prefixed method that is not in
 * the table is `invalid_request` — the host is the authority on its own
 * namespace, and forwarding an unknown `host.` method to a daemon that has never
 * heard of it would turn a typo into a confusing refusal from the wrong process.
 *
 * The four snapshot ops are the exception to the forwarding rule: they are
 * answered from the mirror (Ruling 5, and `snapshot.ts`), so a client hydrating
 * through this host needs one connection rather than two.
 *
 * **Readiness is a typed state, not a crash.** `host.hello`, `host.info`,
 * `host.list_plugins` and `host.subscribe` answer from the moment the socket is
 * up — a client that has just connected needs to be able to ask what is going on
 * *because* something is wrong. Everything that needs a loaded plugin set
 * answers `host_not_ready` until the sequencer reports `steady`. The six
 * operations Task 20b owns are in the table from the start and answer
 * `host_not_ready` with a message naming that task, so a client meets a
 * documented state rather than a missing method.
 */

import { OverlapRefused } from "../pluginset/coexistence";
import { SnapshotStore } from "./snapshot";
import { TFile } from "../shim/files";
import { failureFromReport } from "../runtime/quarantine";
import {
  HostError,
  toWireCommand,
  toWireMenuItem,
  toWireOverlap,
  toWirePluginState,
  toWirePolicyUse,
  toWireProtocolHandler,
  toWireTimer,
} from "./wire";
import { InteractionUnavailable } from "../interaction/broker";
import type { App } from "../shim/app";
import type { ClientSubscriptions } from "./subscriptions";
import type { HostEvent } from "./subscriptions";
import type { InteractionBroker, PromptAnswer } from "../interaction/broker";
import type { CoexistenceMonitor } from "../pluginset/coexistence";
import type { DispatchQueue } from "../runtime/queue";
import type { EditorRange } from "../shim/editor";
import type { Harvest, MenuContext } from "../shim/harvest";
import type { HeadlessConfigDir } from "../pluginset/config-dir";
import type { HostConfig } from "../config";
import type { HostErrors } from "../shim/errors";
import type { LifecycleSequencer } from "../runtime/lifecycle";
import type { LiveStateDto } from "../client/protocol";
import type { Mirror } from "../mirror/mirror";
import type { NoticeLog } from "../shim/notice";
import type { InstalledPlugin } from "../pluginset/config-dir";
import type { PluginState, PositionWire, SelectionWire } from "./wire";
import type { PolicyRecorder } from "../shim/policy";
import type { QuarantineTracker } from "../runtime/quarantine";
import type { RequestSink } from "../client/request-sink";
import type { WriteGate } from "../dryrun/dry-run";

/** The protocol version this host speaks — `vaultd`'s, because it is the same. */
export const HOST_PROTOCOL_VERSION = 1;

/** What `host.hello` reports as the host's own build. */
export const HOST_VERSION = "0.0.0";

/**
 * 16a's dependency set. **Every member is produced by an earlier task.**
 *
 * Three departures from the phase brief's sketch, each forced by what the
 * earlier tasks actually built:
 *
 * - `client` is a {@link RequestSink}, not a `VaultdClient`. Task 15 settled
 *   that nothing in this host may capture a client: a connection dies with its
 *   engine, and the forwarding sink resolves the current one per call. A server
 *   holding a `VaultdClient` would forward to a dead socket after the first
 *   restart, and the symptom would be silent.
 * - `dir`, `queue`, `errors` and `policyRecorder` are named, because the ops
 *   need them: the installed set comes from the config directory, a menu item
 *   and a protocol handler run inside a dispatch slot so their policy hits are
 *   attributed, and `host.info`'s `unsupported` is the policy recorder's tally.
 * - `liveState` is a function rather than a value. The supervisor owns liveness
 *   and a host driven straight off a client has no supervisor at all, so the
 *   honest answer there is `null` rather than an invented `"watching"`.
 */
export interface HostServerDeps {
  readonly config: HostConfig;
  readonly lifecycle: LifecycleSequencer;
  readonly harvest: Harvest;
  readonly mirror: Mirror;
  readonly client: RequestSink;
  /**
   * The same {@link WriteGate} every shim surface writes through.
   *
   * Here because the non-`host.` road below is a **write path too**: a client's
   * own `write_note` is proxied to the daemon by this host, and a host
   * answering `dry_run: true` on `host.hello` that then let that write land
   * would be a dry run that writes — the one failure this mode exists to
   * prevent. Optional so a caller that predates it keeps working; it defaults
   * to forwarding, which is what the proxy always did.
   */
  readonly writes?: WriteGate;
  readonly quarantine: QuarantineTracker;
  readonly coexistence: CoexistenceMonitor;
  readonly noticeLog: NoticeLog;
  readonly app: App;
  readonly dir: HeadlessConfigDir;
  readonly queue: DispatchQueue;
  readonly errors: HostErrors;
  readonly policyRecorder: PolicyRecorder;
  readonly liveState?: () => LiveStateDto | null;
}

/**
 * The late services, attached as a second object rather than by widening
 * {@link HostServerDeps}.
 *
 * **Partial, and merged rather than replaced.** 16a declared all three as one
 * object because one task was going to produce all three; Task 18 produces the
 * broker and Task 20b the other two, so an all-or-nothing wiring would force
 * whichever ran first to invent placeholders for the other's services. Each
 * field is optional, {@link HostOps.attachWiring} merges what it is given into
 * what is already attached, and each late operation answers `host_not_ready`
 * naming **its own** missing service rather than the set.
 *
 * `pluginConfig` and `detector` stay `unknown`: this module must not declare
 * the shape of an interface Task 20b has not written, and a placeholder shape
 * would be a second declaration for it to reconcile. `broker` is typed, because
 * it exists.
 */
export interface HostServerWiring {
  readonly broker?: InteractionBroker;
  readonly pluginConfig?: unknown;
  readonly detector?: unknown;
}

/** One connected, authenticated client, as an operation sees it. */
export interface OpSession {
  /** Identity for the things a client owns: its snapshots and its subscriptions. */
  readonly owner: object;
  /** What a refusal calls this connection — `host-conn-3`. Never parsed. */
  readonly label: string;
  readonly subscriptions: ClientSubscriptions;
  /**
   * Deliver one event to **this** connection alone, and say whether it landed.
   *
   * Everything else the host emits is a broadcast: an event describes something
   * that happened to the vault and every subscriber is owed a copy. A prompt is
   * the other kind — a question addressed to the one client that said it would
   * answer — so the broker needs a way down one socket rather than all of them,
   * and it needs to be told when that way was blocked.
   */
  deliver(event: HostEvent): boolean;
}

export type OpHandler = (params: Record<string, unknown>, session: OpSession) => Promise<unknown>;

/** The methods that need a loaded plugin set, and therefore a steady host. */
const NEEDS_STEADY = new Set([
  "host.list_commands",
  "host.invoke_command",
  "host.list_menu_items",
  "host.invoke_menu_item",
  "host.list_protocol_handlers",
  "host.invoke_protocol",
  "host.enable_plugin",
  "host.disable_plugin",
]);

/**
 * The operations still waiting on a service nobody has built, with the service
 * each one waits on.
 *
 * Three rather than six since Task 18: the interaction trio is wired below
 * against a real broker, and answers `host_not_ready` only when no broker is
 * attached — which is the same typed state, named for the one service it is
 * actually missing rather than for the set.
 */
const LATE_OPS: ReadonlyArray<readonly [string, string]> = [
  ["host.get_plugin_config", "the plugin config service"],
  ["host.set_plugin_config", "the plugin config service"],
  ["host.compat_report", "the compatibility detector"],
];

export class HostOps {
  readonly snapshots: SnapshotStore;
  private readonly table = new Map<string, OpHandler>();
  private wiring: HostServerWiring | null = null;
  /**
   * The installed plugin set, as last read off the config directory.
   *
   * **Cached because reading it is not free.** `listInstalled` is one `read_dir`
   * plus one `read_file` per installed plugin, through the daemon, and five
   * operations ask for it — `host.hello`, `host.info`, `host.list_plugins` and
   * both plugin ops. On a hundred-plugin vault a `host.info` was a hundred and
   * one round trips for a listing that changes when somebody installs a plugin,
   * which is not something that happens between two requests.
   *
   * Invalidated explicitly rather than by a timer: an enable or a disable is the
   * host's own doing, and `host.info { refresh: true }` is a client saying it
   * wants the world re-read. Nothing else moves it, so a plugin installed on
   * disk under a running host is seen at the next refresh — which is the same
   * window the coexistence poll already documents for the enabled set.
   */
  private installedCache: readonly InstalledPlugin[] | null = null;
  /**
   * The subscription `host.attach_interaction` opened for a client that held
   * none, by that client's identity — so a detach closes exactly what the
   * attach opened, and nothing the client opened for itself.
   *
   * A `WeakMap` keyed by the session's `owner`, which is the same identity the
   * snapshot store keys by: a connection that goes without detaching takes its
   * entry with it and nothing has to remember to clean up.
   */
  private readonly attachSubscriptions = new WeakMap<object, string>();

  constructor(private readonly deps: HostServerDeps) {
    this.snapshots = new SnapshotStore(deps.mirror, deps.config);
    this.install();
  }

  /**
   * Attach one or more late services, **merging** into what is already there.
   *
   * Merging rather than replacing, because two tasks attach: Task 18 hands over
   * the interaction broker and Task 20b the plugin config service and the
   * compatibility detector, in whichever order the caller assembles them. A
   * replacing version would make the second call silently un-wire the first
   * one's service, and the symptom would be a `host_not_ready` on an operation
   * that worked a moment ago.
   */
  attachWiring(wiring: HostServerWiring): void {
    this.wiring = {
      ...(this.wiring ?? {}),
      // Spread would let an explicitly-`undefined` field erase an attached
      // service, which is the one thing merging exists to prevent.
      ...(wiring.broker === undefined ? {} : { broker: wiring.broker }),
      ...(wiring.pluginConfig === undefined ? {} : { pluginConfig: wiring.pluginConfig }),
      ...(wiring.detector === undefined ? {} : { detector: wiring.detector }),
    };
  }

  hasWiring(): boolean {
    return this.wiring !== null;
  }

  /**
   * A client's connection closed: release everything it held that outlives the
   * socket's own teardown.
   *
   * The interaction channel is one of those. A client that attached and then
   * crashed still holds it as far as the broker is concerned, and every prompt
   * raised afterwards would be delivered into a socket nobody is reading —
   * so a disconnect is an implicit detach, and detaching fails the prompts it
   * was holding immediately rather than two minutes later.
   */
  connectionGone(session: OpSession): void {
    this.snapshots.closeAll(session.owner);
    this.wiring?.broker?.detach(session);
    // The connection's own subscriptions go with it either way; this keeps the
    // bookkeeping from outliving the client it describes.
    this.closeAttachSubscription(session);
  }

  /**
   * Close the subscription `host.attach_interaction` opened for this client, if
   * it opened one.
   *
   * **Only the one it opened.** A client that subscribed for itself and then
   * attached keeps every subscription it asked for: the host gave it nothing,
   * so the host takes nothing back. Detaching is "stop sending me prompts", not
   * "stop sending me events", and a detach that closed a channel the client was
   * using for `host.notice` would be a surprise with no way to see it coming.
   */
  private closeAttachSubscription(session: OpSession): void {
    const opened = this.attachSubscriptions.get(session.owner);
    if (opened === undefined) return;
    this.attachSubscriptions.delete(session.owner);
    session.subscriptions.close(opened);
  }

  /** Every `host.*` method this build answers, for the protocol document's sake. */
  methods(): readonly string[] {
    return [...this.table.keys()].sort();
  }

  /**
   * Answer one request.
   *
   * The three-way split is the multiplexing rule: a `host.` method the table
   * knows is answered here, a `host.` method it does not know is
   * `invalid_request`, and everything else is the daemon's.
   *
   * **"The daemon's" goes through the write gate, not around it.** The gate
   * forwards every verb that is not a mutation, so a client's reads reach the
   * daemon exactly as they always did; a client's `write_note` under
   * `--dry-run` is recorded instead, with `pluginId: null` because no plugin
   * asked for it. Before this it was the one mutation path in the process that
   * bypassed the gate, and `host.hello` was answering `dry_run: true` while it
   * did. A client that genuinely wants to write has the daemon's own socket.
   */
  async dispatch(method: string, params: unknown, session: OpSession): Promise<unknown> {
    if (!method.startsWith("host.")) {
      const writes = this.deps.writes;
      if (writes === undefined) return await this.deps.client.request(method, params);
      return await writes.send(method, params);
    }
    const handler = this.table.get(method);
    if (handler === undefined) {
      throw new HostError("invalid_request", `this host has no operation "${method}"`);
    }
    if (NEEDS_STEADY.has(method) && this.deps.lifecycle.phase() !== "steady") {
      throw new HostError(
        "host_not_ready",
        `"${method}" needs a loaded plugin set; the host lifecycle is ` +
          `${this.deps.lifecycle.phase()}, not steady`,
      );
    }
    return await handler(asParams(params), session);
  }

  /** The `host.hello` payload. The server calls it once the nonce has matched. */
  async hello(): Promise<unknown> {
    return {
      host_version: HOST_VERSION,
      protocol_version: HOST_PROTOCOL_VERSION,
      vault_root: this.deps.config.vaultRoot,
      config_dir: this.deps.config.configDirName,
      phase: this.deps.lifecycle.phase(),
      generation: this.deps.mirror.generation(),
      live_state: this.deps.liveState?.() ?? null,
      dry_run: this.deps.config.dryRun,
      plugins: await this.pluginStates(),
    };
  }

  // --- The table -------------------------------------------------------------

  private install(): void {
    const table = this.table;
    table.set("host.hello", () => this.hello());

    table.set("host.info", async (params) => {
      const refresh = boolOf(params, "refresh") === true;
      // A client asking to refresh is asking for the world to be re-read, not
      // only for a fresh coexistence poll: the installed set is part of the
      // world, and a cache that survived an explicit refresh would be the one
      // thing this operation could not tell the truth about.
      if (refresh) this.forgetInstalled();
      const report = refresh
        ? await this.deps.coexistence.check()
        : this.deps.coexistence.latest();
      return {
        plugins: await this.pluginStates(),
        timers: this.deps.harvest.timers().map(toWireTimer),
        overlap:
          report === null
            ? null
            : // `overlap_poll_ms` rides beside the report rather than inside
              // `toWireOverlap`, because it is not part of the reading: it is
              // the **width of the window in which this host can be wrong**
              // about the GUI, and reporting it is what keeps that window from
              // being a thing only the source says. See `coexistence.ts` on
              // Ruling W7 — there is no event for "the user enabled a plugin in
              // Obsidian", so a poll is the honest mechanism and its period is
              // part of the answer.
              { ...toWireOverlap(report), overlap_poll_ms: this.deps.config.overlapPollMs },
        counters: this.counters(),
        unsupported: this.deps.policyRecorder
          .entries()
          .filter((use) => use.policy === "absent")
          .map(toWirePolicyUse),
      };
    });

    table.set("host.list_plugins", async () => ({ plugins: await this.pluginStates() }));

    table.set("host.enable_plugin", async (params) => {
      const id = stringOf(params, "id");
      await this.assertInstalled(id);
      this.forgetInstalled();
      try {
        await this.deps.lifecycle.enableLate(id, { forceShared: boolOf(params, "force_shared") === true });
      } catch (error) {
        if (error instanceof OverlapRefused) {
          throw new HostError("overlap_refused", error.message, { plugin_id: error.pluginId });
        }
        throw error;
      }
      return { id, state: await this.stateOf(id) };
    });

    table.set("host.disable_plugin", async (params) => {
      const id = stringOf(params, "id");
      await this.deps.lifecycle.disable(id);
      this.forgetInstalled();
      return { id, state: await this.stateOf(id) };
    });

    table.set("host.list_commands", (params) => {
      const pluginId = optionalStringOf(params, "plugin_id");
      const commands = this.deps.harvest
        .commands()
        .filter((command) => pluginId === null || command.pluginId === pluginId)
        .map(toWireCommand);
      return Promise.resolve({ commands });
    });

    table.set("host.invoke_command", (params) => this.invokeCommand(params));

    table.set("host.list_menu_items", async (params) => {
      const context = menuContextOf(stringOf(params, "context"));
      const subject = this.menuSubject(context, stringOf(params, "path"));
      const items = await this.deps.queue.run(null, `menu:${context}`, () =>
        this.deps.harvest.listMenuItems(context, subject),
      );
      return { items: items.map(toWireMenuItem) };
    });

    table.set("host.invoke_menu_item", async (params) => {
      const itemId = stringOf(params, "item_id");
      const path = stringOf(params, "path");
      const context = menuContextOfItemId(itemId);
      const found = this.deps.harvest.menuItemFor(itemId, this.menuSubject(context, path));
      if (found === null) {
        throw new HostError("menu_item_not_found", `no harvested menu item "${itemId}"`);
      }
      this.assertNotQuarantined(found.pluginId);
      const mark = this.deps.noticeLog.mark();
      await this.runAttributed(found.pluginId, `menu-item:${itemId}`, () => found.item.invoke());
      return { item_id: itemId, generation: this.deps.mirror.generation(), notices: this.since(mark) };
    });

    table.set("host.list_protocol_handlers", () =>
      Promise.resolve({ handlers: this.deps.harvest.protocolHandlers().map(toWireProtocolHandler) }),
    );

    table.set("host.invoke_protocol", async (params) => {
      const action = stringOf(params, "action");
      const found = this.deps.harvest.protocolHandlerFor(action);
      if (found === null) {
        throw new HostError(
          "protocol_handler_not_found",
          `no plugin registered an obsidian:// handler for "${action}"`,
        );
      }
      this.assertNotQuarantined(found.pluginId);
      const mark = this.deps.noticeLog.mark();
      // `{ action, ...params }` is the shape Obsidian hands a protocol handler —
      // the action is *in* the params — and plugins read it from there.
      const handed = { action, ...stringMapOf(params, "params") };
      await this.runAttributed(found.pluginId, `protocol:${action}`, () => found.handler(handed));
      return { action, generation: this.deps.mirror.generation(), notices: this.since(mark) };
    });

    table.set("host.subscribe", (_params, session) => {
      const opened = session.subscriptions.open();
      return Promise.resolve({ subscription_id: opened.id, generation: opened.generation });
    });

    table.set("host.unsubscribe", (params, session) => {
      const id = stringOf(params, "subscription_id");
      if (!session.subscriptions.close(id)) {
        throw new HostError("subscription_not_found", `this connection holds no subscription ${id}`);
      }
      return Promise.resolve({ subscription_id: id });
    });

    table.set("host.open_snapshot", (_params, session) =>
      Promise.resolve(this.snapshots.open(session.owner)),
    );

    table.set("host.snapshot_tree", (params, session) =>
      Promise.resolve(
        this.snapshots.tree(session.owner, {
          snapshotId: stringOf(params, "snapshot_id"),
          cursor: optionalStringOf(params, "cursor"),
          ...(numberOf(params, "limit") === null ? {} : { limit: numberOf(params, "limit") as number }),
        }),
      ),
    );

    table.set("host.snapshot_notes", (params, session) =>
      Promise.resolve(
        this.snapshots.notes(session.owner, {
          snapshotId: stringOf(params, "snapshot_id"),
          cursor: optionalStringOf(params, "cursor"),
          ...(numberOf(params, "limit") === null ? {} : { limit: numberOf(params, "limit") as number }),
          ...(stringArrayOf(params, "include") === null
            ? {}
            : { include: stringArrayOf(params, "include") as string[] }),
        }),
      ),
    );

    table.set("host.close_snapshot", (params, session) =>
      Promise.resolve(this.snapshots.close(session.owner, stringOf(params, "snapshot_id"))),
    );

    // --- Interaction (Task 18) ------------------------------------------------
    //
    // **One holder at a time, and the holder is this connection.** A prompt is
    // a question addressed to whoever said they would answer it, not a
    // broadcast, so attaching is exclusive and a second client is refused by
    // name rather than quietly taking the channel from the first.

    table.set("host.attach_interaction", (_params, session) => {
      const broker = this.broker("host.attach_interaction");
      // **The attach is taken first, and the subscription only on success.** A
      // refusal must leave nothing behind: a client refused the channel and
      // handed a subscription it never asked for would start receiving the
      // whole event firehose as a side effect of being told no, with no id to
      // close it by until an event arrived and named one.
      try {
        broker.attach(session);
      } catch (error) {
        throwInteractionRefusal(error);
      }
      // **Then a subscription, if this connection holds none.** Events reach a
      // client through its subscriptions and nowhere else, so a client that
      // attached without subscribing would have asked for prompts down a
      // channel it had not opened — and would sit waiting for an event the host
      // had nowhere to put. Opening one here is what makes "attached" mean
      // "reachable"; a client that already subscribed keeps the subscriptions
      // it has and gets no second one. Remembered, so the detach can close
      // exactly what this opened and nothing the client opened for itself.
      if (session.subscriptions.count() === 0) {
        this.attachSubscriptions.set(session.owner, session.subscriptions.open().id);
      }
      return Promise.resolve({ attached: true });
    });

    table.set("host.detach_interaction", (_params, session) => {
      const broker = this.broker("host.detach_interaction");
      // A detach from a client that never attached is not an error: it is the
      // same request ("I am not answering prompts") answered by a host that
      // already agreed. Every disconnect runs this path too.
      broker.detach(session);
      this.closeAttachSubscription(session);
      return Promise.resolve({ attached: broker.attached() });
    });

    table.set("host.respond_interaction", (params, session) => {
      const broker = this.broker("host.respond_interaction");
      // **Only the holder answers.** A prompt is delivered to one connection,
      // so an answer from any other is an answer to a question that client
      // never saw — and letting it land would let a second client decide what a
      // plugin does with the first one's human in front of it.
      if (!broker.isHolder(session)) {
        throw new HostError(
          "interaction_unavailable",
          `${session.label} does not hold the interaction channel, so it has no prompt to ` +
            "answer; call host.attach_interaction first",
        );
      }
      const promptId = stringOf(params, "prompt_id");
      const answer = answerOf(params, broker.pendingFor(promptId), promptId);
      // **Checked here rather than inside the broker**, because refusing a
      // client's malformed answer and failing a plugin's prompt are two
      // different events: the first leaves the prompt pending so the client can
      // answer it properly, the second is the plugin's error path.
      if (!broker.answer(promptId, answer)) {
        throw new HostError(
          "interaction_unavailable",
          `no prompt "${promptId}" is waiting for an answer: it was answered already, it timed ` +
            "out, or it belongs to a host that has since restarted",
          { prompt_id: promptId },
        );
      }
      return Promise.resolve({ prompt_id: promptId });
    });

    for (const [method, service] of LATE_OPS) {
      table.set(method, () => {
        throw new HostError(
          "host_not_ready",
          `"${method}" is wired by Task 20b, which attaches ${service}. It is a typed, ` +
            "documented state rather than a missing method: the operation exists and will " +
            "answer once that task has run.",
        );
      });
    }
  }

  /** The broker, or the typed state that says which service is missing. */
  private broker(method: string): InteractionBroker {
    const broker = this.wiring?.broker;
    if (broker === undefined) {
      throw new HostError(
        "host_not_ready",
        `"${method}" needs the interaction broker, which has not been attached to this host. ` +
          "It is a typed, documented state rather than a missing method: the operation exists " +
          "and will answer once the broker is wired.",
      );
    }
    return broker;
  }

  // --- The operations that are more than a lookup -----------------------------

  private async invokeCommand(params: Record<string, unknown>): Promise<unknown> {
    const commandId = stringOf(params, "command_id");
    // **Before the harvest lookup, and that order is the point.** Quarantining a
    // plugin drops its whole harvest, so a lookup-first version would answer
    // `command_not_found` for a command that exists and whose plugin this host
    // has stopped trusting — which tells the client the wrong thing about why.
    this.assertNotQuarantined(pluginIdOf(commandId));
    const command = this.deps.harvest.commands().find((row) => row.id === commandId);
    if (command === undefined) {
      throw new HostError("command_not_found", `no plugin registered a command "${commandId}"`);
    }
    const editorKind = command.kind === "editorCallback" || command.kind === "editorCheckCallback";
    // **Decoded before the mark and before the try.** A missing `active_file` or
    // a path that names nothing is the *client's* error, and one raised inside
    // the block below would be dressed up as a command failure and counted
    // against the plugin — five malformed requests would quarantine a plugin
    // that never ran.
    const file = editorKind ? this.activeFile(params, commandId) : null;
    const selection = editorKind ? selectionOf(params) : null;
    const mark = this.deps.noticeLog.mark();
    let ran = false;
    try {
      if (file === null) {
        // Synchronous, exactly as Obsidian's is and as plugins expect: a version
        // that answered a promise would change what a plugin's own code does.
        ran = this.deps.app.commands.executeCommandById(commandId);
      } else {
        ran = await this.deps.app.commands.invokeCommandById(commandId, {
          file,
          ...(selection === null ? {} : { selection }),
        });
      }
    } catch (error) {
      throw await this.commandFailed(commandId, command.pluginId, error);
    }
    return {
      command_id: commandId,
      ran,
      // Read **after** the command, because a command that wrote has already had
      // its `applyMutation` awaited inside the shim: the editor path flushes
      // inside its own queued slot and the mirror is read-your-writes consistent
      // by the time the call returns.
      generation: this.deps.mirror.generation(),
      notices: this.since(mark),
    };
  }

  /**
   * Turn a command's throw into a refusal, and count it against the plugin.
   *
   * **Counted here rather than through the host's error sink**, and the
   * difference is not cosmetic. The sink is where a failure *nobody is waiting
   * on* goes; this failure has a client waiting for an answer, and reporting it
   * to the sink as well would count it twice — the sequencer listens there and
   * records every report against the quarantine.
   *
   * The record is **awaited**, so the quarantine's transition — which unloads
   * the plugin and drops its harvest — has completed before this refusal
   * reaches the client. A client that invokes a failing command five times and
   * is told `plugin_quarantined` on the sixth is observing a host that has
   * really stopped trusting the plugin, not one that is about to.
   */
  private async commandFailed(
    commandId: string,
    pluginId: string,
    error: unknown,
  ): Promise<HostError> {
    // A typed refusal that came *from this host* on the way in — a malformed
    // request, a quarantined plugin — is not the plugin failing, and counting it
    // would let a client quarantine a working plugin with five bad requests.
    if (error instanceof HostError) return error;
    const failure = failureFromReport(
      { error, pluginId, phase: "command" },
      this.deps.config.clock.now(),
      commandId,
    );
    if (failure !== null) {
      try {
        await this.deps.quarantine.record(failure);
      } catch (teardown: unknown) {
        // The quarantine decided, and the teardown it triggered failed. That is
        // the host's own problem rather than this command's, so it goes to the
        // sink and the client still hears about the command.
        this.deps.errors.report(teardown, pluginId, "teardown");
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return new HostError("internal", `${commandId} failed: ${message}`, { plugin_id: pluginId });
  }

  /** The file an editor command acts on, or the refusal that says why there is none. */
  private activeFile(params: Record<string, unknown>, commandId: string): TFile {
    const path = optionalStringOf(params, "active_file");
    if (path === null) {
      throw new HostError(
        "invalid_request",
        `"${commandId}" is an editor command and needs an "active_file": there is no focused ` +
          "editor in a headless host, so the note it acts on has to be named",
      );
    }
    const node = this.deps.app.vault.getAbstractFileByPath(path);
    if (!(node instanceof TFile)) {
      throw new HostError("not_found", `${path} is not a file in this vault`);
    }
    return node;
  }

  /** Run a plugin's callback inside its own dispatch slot, so hits are attributed. */
  private async runAttributed(
    pluginId: string,
    label: string,
    task: () => unknown,
  ): Promise<void> {
    try {
      await this.deps.queue.run(pluginId, label, async () => {
        await Promise.resolve(task());
      });
    } catch (error) {
      throw await this.commandFailed(label, pluginId, error);
    }
  }

  private assertNotQuarantined(pluginId: string | null): void {
    if (pluginId === null) return;
    if (!this.deps.quarantine.isQuarantined(pluginId)) return;
    const reason = this.deps.quarantine.reason(pluginId);
    throw new HostError(
      "plugin_quarantined",
      `"${pluginId}" is quarantined after ${String(reason.length)} handler failures ` +
        `(${reason.map((failure) => failure.label).join(", ")}) and this host will not run its ` +
        "code until it is enabled again",
      { plugin_id: pluginId },
    );
  }

  /** The installed set, from the cache if it is warm. See {@link installedCache}. */
  private async installed(): Promise<readonly InstalledPlugin[]> {
    this.installedCache ??= await this.deps.dir.listInstalled();
    return this.installedCache;
  }

  /** Forget the installed set: an enable, a disable, or a client asking to refresh. */
  private forgetInstalled(): void {
    this.installedCache = null;
  }

  private async assertInstalled(id: string): Promise<void> {
    const installed = await this.installed();
    if (installed.some((plugin) => plugin.id === id)) return;
    throw new HostError(
      "plugin_not_installed",
      `no plugin "${id}" under ${this.deps.dir.pluginsDir()}`,
      { plugin_id: id },
    );
  }

  /** What a menu handler is called with after the menu itself. */
  private menuSubject(context: MenuContext, path: string): readonly unknown[] {
    const node = this.deps.app.vault.getAbstractFileByPath(path);
    if (node === null) throw new HostError("not_found", `${path} is not in this vault`);
    // `(file, source)` is Obsidian's own shape for a file menu and plugins branch
    // on the source — one that only adds its item for the file explorer would add
    // nothing at all if the source were omitted.
    if (context === "file-menu") return [node, "file-explorer-context-menu"];
    // `(editor, view)` for an editor menu. The view carries the file, which is
    // what a handler that only reads `view.file` needs; this host opens no editor
    // buffer to build a menu, because building one is a daemon round trip for a
    // listing that may never be invoked.
    return [{ headless: true }, { file: node }];
  }

  private since(mark: number): string[] {
    return this.deps.noticeLog.since(mark).map((entry) => entry.message);
  }

  private counters(): Record<string, unknown> {
    const byReason: Record<string, number> = {};
    for (const [reason, count] of this.deps.mirror.resyncCounts()) byReason[reason] = count;
    return {
      generation: this.deps.mirror.generation(),
      applied_through: this.deps.mirror.appliedThrough(),
      resync_count: this.deps.mirror.resyncCount(),
      resyncs_by_reason: byReason,
      resyncing: this.deps.mirror.resyncing(),
      last_resync_reason: this.deps.mirror.lastResyncReason(),
      notices: this.deps.noticeLog.entries().length,
      quarantined: [...this.deps.quarantine.quarantined()],
      snapshot_sessions: this.snapshots.count(),
      pending_batches: this.deps.lifecycle.pendingBatchCount(),
    };
  }

  // --- Plugin states ----------------------------------------------------------

  private async stateOf(id: string): Promise<string> {
    const states = await this.pluginStates();
    return states.find((state) => state.id === id)?.state ?? "disabled";
  }

  /**
   * Every plugin this host knows about, installed or running.
   *
   * The installed set comes off disk and the running set off the sequencer, and
   * the union is deliberate: a plugin loaded from a bundle that has since been
   * removed from the config directory is still running, and a report that listed
   * only what is on disk would not say so.
   */
  private async pluginStates(): Promise<PluginStateWireRow[]> {
    const installed = await this.installed();
    const loaded = new Set(this.deps.lifecycle.loadedPlugins());
    const failures = this.deps.lifecycle.loadFailures();
    const timings = this.deps.lifecycle.loadTimings();
    const ids = new Set<string>([
      ...installed.map((plugin) => plugin.id),
      ...loaded,
      ...failures.keys(),
      ...this.deps.quarantine.quarantined(),
    ]);
    const manifests = new Map(installed.map((plugin) => [plugin.id, plugin.manifest]));
    const rows: PluginState[] = [];
    for (const id of [...ids].sort()) {
      const manifest = manifests.get(id) ?? this.deps.app.plugins.manifests[id];
      const quarantined = this.deps.quarantine.isQuarantined(id);
      const failure = failures.get(id);
      rows.push({
        id,
        name: manifest?.name ?? id,
        // Unknown rather than invented: a plugin running from a bundle whose
        // manifest this host cannot read has a version nobody should print as
        // though it were `0.0.0`.
        version: manifest?.version ?? "",
        state: quarantined
          ? "quarantined"
          : loaded.has(id)
            ? "loaded"
            : failure === undefined
              ? "disabled"
              : "failed",
        loadMs: timings.get(id) ?? null,
        failureCount: this.deps.quarantine.failuresFor(id),
        reason: quarantined
          ? this.deps.quarantine
              .reason(id)
              .map((entry) => entry.label)
              .join(", ")
          : (failure ?? null),
      });
    }
    return rows.map(toWirePluginState);
  }
}

/** The row `pluginStates` answers with, named so the return type reads. */
type PluginStateWireRow = ReturnType<typeof toWirePluginState>;

// --- Parameter decoding -------------------------------------------------------

/**
 * `params`, as an object.
 *
 * An absent `params` is an empty object rather than a refusal, because the
 * daemon's own unit variants omit the key entirely and a client that already
 * speaks `vaultd` will omit it here too.
 */
function asParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new HostError("invalid_request", "params must be an object");
  }
  return params as Record<string, unknown>;
}

function stringOf(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") {
    throw new HostError("invalid_request", `"${key}" is required and must be a string`);
  }
  return value;
}

function optionalStringOf(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HostError("invalid_request", `"${key}" must be a string when it is present`);
  }
  return value;
}

function numberOf(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HostError("invalid_request", `"${key}" must be a number when it is present`);
  }
  return value;
}

function boolOf(params: Record<string, unknown>, key: string): boolean | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new HostError("invalid_request", `"${key}" must be a boolean when it is present`);
  }
  return value;
}

function stringArrayOf(params: Record<string, unknown>, key: string): string[] | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HostError("invalid_request", `"${key}" must be an array of strings`);
  }
  return value as string[];
}

/**
 * One `host.respond_interaction` body, decoded against the prompt it answers.
 *
 * **The range check needs the prompt**, which is why the pending request is
 * passed in rather than looked up later: `choice_index` means "the nth of the
 * items this host sent you", so out of range is a malformed parameter in
 * exactly the way a missing `command_id` is — the client got the request wrong
 * — and it is refused as `invalid_request` with the prompt left pending, not as
 * `interaction_unavailable` with the plugin failed. A client that miscounted
 * can answer again.
 */
function answerOf(
  params: Record<string, unknown>,
  request: { items: readonly string[] } | null,
  promptId: string,
): PromptAnswer {
  const choiceIndex = numberOf(params, "choice_index");
  const value = optionalStringOf(params, "value");
  const cancelled = boolOf(params, "cancelled");
  if (choiceIndex !== null && request !== null) {
    if (request.items.length === 0) {
      // "from 0 to -1" is not a range, and telling a client to pick from one
      // would be telling it to do something impossible. A prompt with no items
      // — a `text` prompt — is answered with `value`, and that is what to say.
      throw new HostError(
        "invalid_request",
        `prompt "${promptId}" offers no items to choose from, so it takes no "choice_index": ` +
          'answer it with "value", or with "cancelled": true',
      );
    }
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= request.items.length) {
      throw new HostError(
        "invalid_request",
        `"choice_index" must be a whole number from 0 to ${String(request.items.length - 1)}: ` +
          `prompt "${promptId}" offered ${String(request.items.length)} items and this answer ` +
          `names ${String(choiceIndex)}`,
      );
    }
  }
  return {
    ...(choiceIndex === null ? {} : { choiceIndex }),
    ...(value === null ? {} : { value }),
    ...(cancelled === null ? {} : { cancelled }),
  };
}

/**
 * Re-raise the broker's own refusal as a wire refusal.
 *
 * It **throws** rather than returning something to throw, and the difference is
 * the honesty of the signature: only one of the two paths produces a
 * `HostError`, so a function returning the pair would have to be typed
 * `HostError | unknown` — which is just `unknown`, and says nothing. `never`
 * says exactly what happens.
 *
 * Anything that is not an {@link InteractionUnavailable} is a bug in this host
 * rather than something the client did, and is re-thrown unchanged so it
 * travels the ordinary internal-error path instead of being dressed up as a
 * refusal the client could act on.
 */
function throwInteractionRefusal(error: unknown): never {
  if (error instanceof InteractionUnavailable) {
    throw new HostError("interaction_unavailable", error.message);
  }
  throw error;
}

function stringMapOf(params: Record<string, unknown>, key: string): Record<string, string> {
  const value = params[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HostError("invalid_request", `"${key}" must be an object of strings`);
  }
  const map: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new HostError("invalid_request", `"${key}.${name}" must be a string`);
    }
    map[name] = entry;
  }
  return map;
}

/**
 * Where an editor command's selection starts and ends.
 *
 * The shape is pinned as {@link SelectionWire} — a **ratified** deviation from
 * the brief's `selection?: string`, which no editor command can use. See that
 * declaration for the reasoning; a client that sends a string is told so rather
 * than having it silently ignored.
 */
function selectionOf(params: Record<string, unknown>): EditorRange | null {
  const value = params["selection"];
  if (value === undefined || value === null) return null;
  const range = value as Partial<SelectionWire>;
  const from = positionOf(range.from);
  const to = positionOf(range.to);
  if (from === null || to === null) {
    throw new HostError(
      "invalid_request",
      '"selection" is { from: { line, ch }, to: { line, ch } } — two positions, not a string',
    );
  }
  return { from, to };
}

function positionOf(value: unknown): PositionWire | null {
  const position = value as Partial<PositionWire> | null;
  if (typeof position?.line !== "number" || typeof position.ch !== "number") return null;
  return { line: position.line, ch: position.ch };
}

function menuContextOf(context: string): MenuContext {
  if (context !== "file-menu" && context !== "editor-menu") {
    throw new HostError(
      "invalid_request",
      `"context" is "file-menu" or "editor-menu"; a headless host can build no other menu`,
    );
  }
  return context;
}

/**
 * Which menu an item id belongs to.
 *
 * An item id is `<pluginId>:<context>:<hookOrdinal>:<itemOrdinal>`, so the
 * context is the third segment from the right — read from the right because a
 * plugin id is the only part that could itself contain a colon.
 */
function menuContextOfItemId(id: string): MenuContext {
  const segments = id.split(":");
  const context = segments[segments.length - 3];
  if (context !== "file-menu" && context !== "editor-menu") {
    throw new HostError("menu_item_not_found", `"${id}" does not name a menu item`);
  }
  return context;
}

/**
 * The plugin a command id belongs to, or `null` for one of the host's own.
 *
 * `Plugin.addCommand` namespaces every plugin command as
 * `<pluginId>:<localId>`, so the prefix is the owner. An id with no colon
 * belongs to no plugin.
 */
function pluginIdOf(commandId: string): string | null {
  const cut = commandId.indexOf(":");
  return cut === -1 ? null : commandId.slice(0, cut);
}
