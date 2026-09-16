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
import type { App } from "../shim/app";
import type { ClientSubscriptions } from "./subscriptions";
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
import type { PluginState } from "./wire";
import type { PolicyRecorder } from "../shim/policy";
import type { QuarantineTracker } from "../runtime/quarantine";
import type { RequestSink } from "../client/request-sink";

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
 * The three services Task 20b produces, attached as a second object rather than
 * by widening {@link HostServerDeps}.
 *
 * Typed as `unknown` here on purpose: 16a must not declare the shape of an
 * interface task 18 and 20 have not written yet, and a placeholder shape would
 * be a second declaration for 20b to reconcile. What 16a owns is the *state* —
 * attached or not — which is what turns six forward references into a typed
 * `host_not_ready` instead of six missing methods.
 */
export interface HostServerWiring {
  readonly broker: unknown;
  readonly pluginConfig: unknown;
  readonly detector: unknown;
}

/** One connected, authenticated client, as an operation sees it. */
export interface OpSession {
  /** Identity for the things a client owns: its snapshots and its subscriptions. */
  readonly owner: object;
  readonly subscriptions: ClientSubscriptions;
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

/** The six operations Task 20b wires, with the service each one waits on. */
const LATE_OPS: ReadonlyArray<readonly [string, string]> = [
  ["host.get_plugin_config", "the plugin config service"],
  ["host.set_plugin_config", "the plugin config service"],
  ["host.compat_report", "the compatibility detector"],
  ["host.attach_interaction", "the interaction broker"],
  ["host.detach_interaction", "the interaction broker"],
  ["host.respond_interaction", "the interaction broker"],
];

export class HostOps {
  readonly snapshots: SnapshotStore;
  private readonly table = new Map<string, OpHandler>();
  private wiring: HostServerWiring | null = null;

  constructor(private readonly deps: HostServerDeps) {
    this.snapshots = new SnapshotStore(deps.mirror, deps.config);
    this.install();
  }

  attachWiring(wiring: HostServerWiring): void {
    this.wiring = wiring;
  }

  hasWiring(): boolean {
    return this.wiring !== null;
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
   */
  async dispatch(method: string, params: unknown, session: OpSession): Promise<unknown> {
    if (!method.startsWith("host.")) return await this.deps.client.request(method, params);
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
      const report =
        boolOf(params, "refresh") === true
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

  private async assertInstalled(id: string): Promise<void> {
    const installed = await this.deps.dir.listInstalled();
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
    const installed = await this.deps.dir.listInstalled();
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
 * The phase brief's table spelled this `selection?: string`, which no editor
 * command can use: `Editor.setSelection` takes two positions, and a string
 * would have to be searched for in the note — a different operation with a
 * different failure mode. It is the range, and a client that sends a string is
 * told so rather than having it silently ignored.
 */
function selectionOf(params: Record<string, unknown>): EditorRange | null {
  const value = params["selection"];
  if (value === undefined || value === null) return null;
  const range = value as { from?: unknown; to?: unknown };
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

function positionOf(value: unknown): { line: number; ch: number } | null {
  const position = value as { line?: unknown; ch?: unknown } | null;
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
