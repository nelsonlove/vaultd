/**
 * The whole host — shim, server, lifecycle, quarantine — over a fake daemon:
 * the harness Tasks 15, 16a, 18, 19, 20b and 21 drive.
 *
 * **Not yet activated.** Written for `src/testing/host-harness.ts`, with its
 * imports spelled for that home. Task 15's Step 1 moves it:
 *
 * ```
 * git mv src/testing/pending/host-harness.ts src/testing/host-harness.ts
 * ```
 *
 * It extends {@link ShimHarness} rather than wrapping one, so every method a
 * shim test uses is still available to a host test: a case about the server's
 * event fan-out still needs `emitBatch` to make something happen.
 */

import { connect } from "node:net";
import type { Socket } from "node:net";

import { ShimHarness } from "./shim-harness";
import { FixtureVault } from "./fixture-vault";
import { HostServer } from "../server/server";
import { DryRunGate } from "../dryrun/dry-run";
import { InteractionBroker } from "../interaction/broker";
import { LifecycleSequencer } from "../runtime/lifecycle";
import { QuarantineTracker } from "../runtime/quarantine";
import { Detector } from "../detector/scanner";
import { DataDir } from "../datadir";
import { fs } from "../runtime/fs-access";
import type { HostConfig } from "../config";
import type { App } from "../shim/app";
import type { CoexistenceMonitor } from "../pluginset/coexistence";
import type { ObsidianApi } from "../shim/api";
import type { Plugin, PluginManifest } from "../shim/plugin";
import type { ShimHarnessOptions } from "./shim-harness";

/** A plugin class, built against the `obsidian` module the host serves. */
export type PluginFactory = (api: ObsidianApi) => new (app: App, m: PluginManifest) => Plugin;

export interface HostHarnessSpec {
  vault: Record<string, string>;
  enabled: string[];
  plugins?: Record<string, PluginFactory>;
  /** Seeds `<configDir>/plugins/<id>/data.json` before the host starts. */
  pluginData?: Record<string, Record<string, unknown>>;
  config?: Partial<HostConfig> & {
    /** 16a only: leave the six 20b ops answering `host_not_ready`. */
    wireLateOps?: boolean;
    subscriberQueueLimit?: number;
  };
  configFiles?: Record<string, string>;
  guiEnabled?: string[] | null;
  suppressLayoutReady?: boolean;
}

export class HostHarness extends ShimHarness {
  readonly lifecycle: LifecycleSequencer;
  readonly quarantine: QuarantineTracker;
  readonly server: HostServer;
  readonly broker: InteractionBroker;
  readonly dryRun: DryRunGate;
  readonly detector: Detector;
  readonly coexistence: CoexistenceMonitor;

  /**
   * The vault this harness is pretending to be the daemon for.
   *
   * Named `fixtures` rather than `vault` because `ShimHarness.vault` is the
   * *shim's* `Vault` — the object a plugin holds — and the two are opposite
   * sides of the same wire. This one is the daemon's side, and it is kept live
   * rather than discarded after hydration so that a change set committed later
   * can be answered from what the vault actually holds.
   */
  private fixtures: FixtureVault;
  private readonly clients: HostTestClient[] = [];
  private readonly handlerErrors = new Map<string, Error>();
  private readonly dataDir: DataDir;
  private guiEnabled: string[] | null;

  /**
   * Reusable plugin factories the tests share instead of restating them.
   *
   * Four, because four shapes of plugin come up over and over: one that throws
   * from a command, one that opens a modal, one that reaches the network, and
   * one that has settings. A test that needs a fifth writes it inline; a test
   * that needs one of these gets the same one every other test got, which is
   * what makes two failures in two files comparable.
   */
  static readonly throwingPlugin: PluginFactory = (api) =>
    class ThrowingPlugin extends api.Plugin {
      override onload(): void {
        this.addCommand({
          id: "boom",
          name: "Boom",
          callback: () => {
            throw new Error("boom");
          },
        });
        this.addCommand({ id: "fine", name: "Fine", callback: () => undefined });
      }
    };

  static readonly suggestPlugin: PluginFactory = (api) =>
    class SuggestPlugin extends api.Plugin {
      override onload(): void {
        this.addCommand({
          id: "pick",
          name: "Pick",
          callback: () => {
            const modal = new (class extends api.SuggestModal<string> {
              getSuggestions(): string[] {
                return ["one", "two"];
              }
              renderSuggestion(): void {
                // The headless host renders nothing; the broker carries the
                // choices to whoever is driving.
              }
              onChooseSuggestion(): void {
                // Recorded by the broker.
              }
            })(this.app);
            modal.open();
          },
        });
      }
    };

  static readonly requestUrlPlugin: PluginFactory = (api) =>
    class RequestUrlPlugin extends api.Plugin {
      override onload(): void {
        this.addCommand({
          id: "fetch",
          name: "Fetch",
          callback: () => {
            void api.requestUrl({ url: "https://example.test/" });
          },
        });
      }
    };

  static readonly settingsPlugin: PluginFactory = (api) =>
    class SettingsPlugin extends api.Plugin {
      override async onload(): Promise<void> {
        await this.loadData();
        this.addSettingTab(
          new (class extends api.PluginSettingTab {
            display(): void {
              new api.Setting(this.containerEl).setName("Greeting").addText((text) => text);
            }
          })(this.app, this),
        );
        this.addCommand({ id: "noop", name: "No-op", callback: () => undefined });
      }
    };

  protected constructor(spec: HostHarnessSpec) {
    const options: ShimHarnessOptions = { config: spec.config ?? {} };
    if (spec.configFiles !== undefined) options.configFiles = spec.configFiles;
    if (spec.suppressLayoutReady === true) options.layoutReady = false;
    super(options);
    this.guiEnabled = spec.guiEnabled ?? null;
    this.fixtures = new FixtureVault(spec.vault);
    this.dataDir = new DataDir(this.config.dataDir);
    this.lifecycle = new LifecycleSequencer({ config: this.config, clock: this.clock });
    this.quarantine = new QuarantineTracker({ config: this.config, clock: this.clock });
    this.broker = new InteractionBroker({ config: this.config, clock: this.clock });
    this.dryRun = new DryRunGate({ config: this.config });
    this.detector = new Detector({ config: this.config });
    this.server = new HostServer({ config: this.config, clock: this.clock, broker: this.broker });
    this.coexistence = this.lifecycle.coexistence;
  }

  static async create(spec: HostHarnessSpec): Promise<HostHarness> {
    const harness = new HostHarness(spec);
    harness.seedConfigZone(spec);
    await harness.openMirror({
      generation: 1,
      entries: harness.fixtures.entries(),
      notes: harness.fixtures.notes(),
    });
    await harness.boot(spec);
    return harness;
  }

  /**
   * Connect a client to the host's socket.
   *
   * A `stalled` client reads nothing until {@link HostTestClient.resume} is
   * called, which is how the subscriber-queue-limit cases produce back-pressure
   * without a timing race: the host's queue fills because the socket's peer is
   * genuinely not reading, not because a test guessed at a delay.
   */
  async connectClient(options: { stalled?: boolean } = {}): Promise<HostTestClient> {
    const client = await HostTestClient.open(this.config.socketPath, options.stalled ?? false);
    this.clients.push(client);
    return client;
  }

  /** Resolve once the server has flushed every queued event to every client. */
  async serverQuiesce(): Promise<void> {
    await this.server.flushed();
    await this.quiesce();
  }

  setGuiEnabled(ids: string[] | null): void {
    this.guiEnabled = ids;
    if (ids === null) return;
    this.setConfigFile(".obsidian/community-plugins.json", JSON.stringify(ids));
  }

  /** Run a command by id, through the same path a client call takes. */
  async invoke(commandId: string): Promise<void> {
    await this.app.commands.executeCommandById(commandId);
    await this.quiesce();
  }

  /** The error a command raised, as the wire reports it. Throws if it did not. */
  async invokeExpectingError(commandId: string): Promise<{ code: string; message: string }> {
    try {
      await this.invoke(commandId);
    } catch (error) {
      const body = error as { code?: string; message?: string };
      return { code: body.code ?? "unknown", message: body.message ?? String(error) };
    }
    throw new Error(`${commandId} was expected to fail and did not`);
  }

  /**
   * Commit one generation on the fake daemon and let the mirror apply it.
   *
   * `renamed` is sugar, and the shape of the sugar is the point: **the wire has
   * no rename**. A `rename_note` reaches a client as a delete plus a create, so
   * that is what this expands to, and the shim's pairing is what has to put
   * them back together. A helper that sent a rename event would be testing a
   * message the daemon never sends.
   *
   * **It answers its own refetch, and it has to.** A mirror handed a change set
   * asks `get_tree_entries` and then one `get_note` per surviving note; nothing
   * else in this harness answers those — `autoServeFiles` serves `read_file`
   * and nothing more — so a version that only awaited `applyMutation` could
   * never resolve. The answers come from {@link fixtures}, which is moved to
   * match the change first, so what the harness tells the mirror is what the
   * vault now holds rather than a second hand-written account of it.
   *
   * `sources` is where a created or modified path's new bytes come from. A
   * created path named nowhere in it becomes an empty note, which is a real
   * thing a vault can contain and not a placeholder.
   */
  async commitGeneration(change: {
    generation?: number;
    created?: string[];
    modified?: string[];
    deleted?: string[];
    renamed?: Array<{ from: string; to: string }>;
    sources?: Record<string, string>;
  }): Promise<void> {
    const renamed = change.renamed ?? [];
    const generation = change.generation ?? this.mirror.generation() + 1;
    const created = [...(change.created ?? []), ...renamed.map((pair) => pair.to)];
    const modified = [...(change.modified ?? [])];
    const deleted = [...(change.deleted ?? []), ...renamed.map((pair) => pair.from)];

    // Move the bytes the way the vault moved them, before answering anything
    // about them. A rename carries its source across, which is what makes the
    // new path's revision equal the old one's — and revision equality is how
    // the shim pairs the delete with the create back into a rename.
    for (const pair of renamed) {
      this.fixtures.write(pair.to, this.fixtures.source(pair.from));
      this.fixtures.remove(pair.from);
    }
    for (const [path, source] of Object.entries(change.sources ?? {})) {
      this.fixtures.write(path, source);
    }
    for (const path of created) {
      if (!(path in this.fixtures.files)) this.fixtures.write(path, "");
    }
    for (const path of deleted) this.fixtures.remove(path);

    const applying = this.mirror.applyMutation(generation, [...created, ...modified, ...deleted]);
    // The mirror asks for more paths than the change set named — the ancestors
    // of everything created, the referrers of everything deleted — so the
    // answer is the whole tree, filtered by what is still there, and
    // `answerRefetch` picks out whichever of them it was actually asked about.
    await this.answerRefetch(generation, this.fixtures.notes(), {
      entries: this.fixtures.entries(),
      absent: deleted,
    });
    await applying;
    await this.quiesce();
  }

  /**
   * Replace the engine under the host: a new daemon, a new generation, a new
   * vault, and the same plugins.
   *
   * Ruling 7: an engine restart does not reload plugins. The mirror
   * re-hydrates and publishes one synthetic batch; nothing calls `onunload`.
   */
  async restartEngine(spec: { generation: number; vault: Record<string, string> }): Promise<void> {
    // The new engine's vault replaces this harness's, so a change set committed
    // after the restart is answered from what the engine now serves.
    this.fixtures = new FixtureVault(spec.vault);
    // The daemon's own signal, not a method call: an engine that restarted
    // tells its clients `resync_required`, and the mirror's answer to that is
    // a fresh hydration walk plus one synthetic batch. Driving it any other way
    // would test a path the daemon never takes.
    this.emit("sub-1", {
      type: "resync_required",
      value: { reason: "engine_restarted", generation: spec.generation },
    } as never);
    await this.answerHydration({
      generation: spec.generation,
      entries: this.fixtures.entries(),
      notes: this.fixtures.notes(),
    });
    await this.quiesce();
  }

  async advanceClock(ms: number): Promise<void> {
    await this.clock.advance(ms);
    await this.quiesce();
  }

  tick(): Promise<void> {
    return this.clock.tick();
  }

  /** The last error a plugin's handler raised, or `null`. */
  lastHandlerError(pluginId: string): Error | null {
    return this.handlerErrors.get(pluginId) ?? null;
  }

  /** Every daemon method sent since `marker` was last passed here. */
  mirrorRequestsSince(marker: string): readonly string[] {
    const seen = this.methodsSeen();
    const at = seen.lastIndexOf(marker);
    return at === -1 ? seen : seen.slice(at + 1);
  }

  daemonMethodsSeen(): readonly string[] {
    return this.methodsSeen();
  }

  clearDaemonMethodLog(): void {
    this.clearMethodLog();
  }

  /** Loosen the socket directory's mode, so the host's refusal can be tested. */
  chmodSocketDir(mode: number): void {
    fs.chmodSync(socketDirOf(this.config.socketPath), mode);
  }

  noncePath(): string {
    return this.dataDir.resolve("nonce");
  }

  /**
   * The nonce exactly as it sits on disk.
   *
   * Text, not JSON: `DataDir.writeSecret` writes its argument verbatim, so a
   * nonce written as raw hex — the obvious thing for Task 21 to write — would
   * make a `readJson` here throw on the first character.
   */
  readNonce(): string {
    const nonce = this.dataDir.readText("nonce");
    if (nonce === null) throw new Error("the host wrote no nonce");
    return nonce;
  }

  override async stop(): Promise<void> {
    for (const client of this.clients) await client.disconnect();
    this.clients.length = 0;
    await this.server.stop();
    await super.stop();
  }

  /** The config zone as it stands before the host reads any of it. */
  private seedConfigZone(spec: HostHarnessSpec): void {
    const files: Record<string, string> = {
      [`${this.config.configDirName}/community-plugins.json`]: JSON.stringify(spec.enabled),
    };
    if (this.guiEnabled !== null) {
      files[".obsidian/community-plugins.json"] = JSON.stringify(this.guiEnabled);
    }
    this.autoServeFiles(files);
    for (const [id, data] of Object.entries(spec.pluginData ?? {})) {
      this.dataDir.writeJson(`plugins/${id}/data.json`, data);
    }
  }

  private async boot(spec: HostHarnessSpec): Promise<void> {
    this.assembleHost();
    this.api.onHandlerError((pluginId, error) => {
      this.handlerErrors.set(pluginId, error instanceof Error ? error : new Error(String(error)));
    });
    for (const [id, factory] of Object.entries(spec.plugins ?? {})) {
      if (!spec.enabled.includes(id)) continue;
      await this.load(this.instantiate(id, factory(this.api)));
    }
    await this.server.start({ wireLateOps: spec.config?.wireLateOps ?? true });
    if (spec.suppressLayoutReady !== true) await this.flipLayoutReady();
  }

  /**
   * Assemble the shim, then the host pieces that sit on top of it.
   *
   * Separate from `ShimHarness`'s own assembly because the server needs the
   * assembled `App` to route calls to, and the shim needs to exist before there
   * is anything to route.
   */
  private assembleHost(): void {
    this.server.serve({
      app: this.app,
      api: this.api,
      harvest: this.harvest,
      lifecycle: this.lifecycle,
      quarantine: this.quarantine,
      dryRun: this.dryRun,
    });
  }
}

/** The socket's own directory — the one whose mode the host checks. */
function socketDirOf(socketPath: string): string {
  const cut = socketPath.lastIndexOf("/");
  return cut === -1 ? "." : socketPath.slice(0, cut);
}

/**
 * A client of the host's socket, as a test drives one.
 *
 * Line-delimited JSON, the same framing the real client uses, and no sleeps:
 * {@link quiesce} resolves on a quiet turn of the event loop rather than after
 * a chosen number of milliseconds.
 */
export class HostTestClient {
  private readonly pending = new Map<string, (outcome: unknown) => void>();
  private readonly events: Array<{ type: string; value: unknown }> = [];
  private readonly eventWaiters = new Map<string, (value: unknown) => void>();
  private readonly eventListeners: Array<
    (envelope: { subscription_id: string; event: { type: string; value: unknown } }) => void
  > = [];
  private buffered = "";
  private sequence = 0;
  private stalled: boolean;

  private constructor(
    private readonly socket: Socket,
    stalled: boolean,
  ) {
    this.stalled = stalled;
    if (stalled) socket.pause();
    socket.on("data", (chunk: Buffer) => {
      this.absorb(chunk.toString("utf8"));
    });
  }

  static open(socketPath: string, stalled: boolean): Promise<HostTestClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        resolve(new HostTestClient(socket, stalled));
      });
      socket.once("error", reject);
    });
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.sequence += 1;
    const id = `test-${String(this.sequence)}`;
    const frame = JSON.stringify({ version: 1, id, request: { method, params } });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (outcome) => {
        const body = outcome as { status: string; value: unknown };
        if (body.status === "ok") resolve((body.value as { value: T }).value);
        else reject(body.value);
      });
      this.socket.write(`${frame}\n`);
    });
  }

  /** Resolve with the `value` of the next event of this type. */
  nextEvent(type: string): Promise<unknown> {
    const already = this.events.find((event) => event.type === type);
    if (already !== undefined) return Promise.resolve(already.value);
    return new Promise((resolve) => {
      this.eventWaiters.set(type, resolve);
    });
  }

  onEvent(
    listener: (envelope: { subscription_id: string; event: { type: string; value: unknown } }) => void,
  ): void {
    this.eventListeners.push(listener);
  }

  /** Stalled clients only: start reading what the host has been queueing. */
  resume(): void {
    this.stalled = false;
    this.socket.resume();
  }

  async drainEvents(): Promise<ReadonlyArray<{ type: string; value: unknown }>> {
    if (this.stalled) this.resume();
    await this.quiesce();
    return [...this.events];
  }

  /** Resolve once the socket has been quiet for one turn of the event loop. */
  quiesce(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(() => {
        setImmediate(resolve);
      });
    });
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.end(() => {
        resolve();
      });
    });
  }

  private absorb(text: string): void {
    this.buffered += text;
    let newline = this.buffered.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line.trim().length > 0) this.deliver(JSON.parse(line));
      newline = this.buffered.indexOf("\n");
    }
  }

  private deliver(frame: unknown): void {
    const envelope = frame as {
      id?: string;
      outcome?: unknown;
      subscription_id?: string;
      event?: { type: string; value: unknown };
    };
    if (envelope.id !== undefined && envelope.outcome !== undefined) {
      const waiter = this.pending.get(envelope.id);
      this.pending.delete(envelope.id);
      waiter?.(envelope.outcome);
      return;
    }
    if (envelope.event === undefined) return;
    this.events.push(envelope.event);
    for (const listener of this.eventListeners) {
      listener({ subscription_id: envelope.subscription_id ?? "", event: envelope.event });
    }
    const waiter = this.eventWaiters.get(envelope.event.type);
    if (waiter !== undefined) {
      this.eventWaiters.delete(envelope.event.type);
      waiter(envelope.event.value);
    }
  }
}
