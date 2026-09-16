/**
 * The whole host — shim, lifecycle, quarantine — over a fake daemon: the
 * harness Tasks 15, 16a, 18, 19, 20b and 21 drive.
 *
 * **Activated by Task 15**, and reconciled against the modules it names. The
 * body predates every one of them — it was written in Task 6b against interface
 * sketches — so the divergences were real and each is noted at the call site it
 * was found in. The members belonging to tasks that have not run yet (`broker`,
 * `dryRun`, `detector`) are kept by **name** and throw when touched, so a case
 * written against one fails with the task number rather than with `undefined is
 * not a function`. `server`, `connectClient` and `serverQuiesce` were three of
 * those until Task 16a built the socket; they are real now.
 *
 * It extends {@link ShimHarness} rather than wrapping one, so every method a
 * shim test uses is still available to a host test: a case about the event
 * fan-out still needs `emitBatch` to make something happen.
 *
 * Three things are worth knowing before writing a case against it:
 *
 * - **The lifecycle loads the plugins, not this harness.** `create` assembles a
 *   host with nothing running and `layoutReady` false; `harness.lifecycle.start()`
 *   is what reads the enabled set, runs each `onload`, flips the latch and fires
 *   `resolved`. A harness that pre-loaded them would make every ordering
 *   assertion in `lifecycle-order.test.ts` vacuous.
 * - **The fixture vault is served, live.** Every note's source answers
 *   `read_file`, and it is re-served after every change, because a
 *   `metadataCache` `changed` event carries the note's new source and the
 *   sequencer reads it back through the vault.
 * - **`write_file` is answered and remembered.** A late enable writes the
 *   enabled set, so a harness that did not serve writes would hang on the first
 *   one — and one that answered without remembering would let a case assert a
 *   persistence that never happened.
 */

import { connect } from "node:net";
import type { Socket } from "node:net";

import { join, resolve } from "node:path";

import { DaemonHarness } from "./daemon-harness";
import { FixtureVault } from "./fixture-vault";
import { HostServer } from "../server/server";
import { LifecycleSequencer } from "../runtime/lifecycle";
import { QuarantineTracker } from "../runtime/quarantine";
import { ShimHarness, configFilePathsFor, sweepStaleDataDirs } from "./shim-harness";
import { DataDir } from "../datadir";
import { OBSIDIAN_CONFIG_DIR, pluginDataPath, pluginDirPath } from "../pluginset/config-dir";
import { TFolder } from "../shim/files";
import { fs } from "../runtime/fs-access";
import { noteDto } from "./mirror-harness";
import { revisionOfSource } from "./daemon-harness";
import type { HostConfig } from "../config";
import type { App } from "../shim/app";
import type { CoexistenceMonitor } from "../pluginset/coexistence";
import type { ObsidianApi } from "../shim/api";
import type { Plugin, PluginManifest } from "../shim/plugin";
import type { PluginLoadSeam } from "../runtime/lifecycle";
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

/** Obsidian's own enabled set — the file the coexistence monitor reads. */
const GUI_COMMUNITY_PLUGINS = `${OBSIDIAN_CONFIG_DIR}/community-plugins.json`;

/**
 * The daemon verbs only the mirror sends.
 *
 * `read_file` is deliberately **not** here: the config ladder, the plugin data
 * store and the position warm-up all send it, so counting it would answer
 * "did the mirror do any work" with "did anything read anything".
 */
const MIRROR_METHODS = new Set<string>([
  "open_snapshot",
  "snapshot_tree",
  "snapshot_notes",
  "close_snapshot",
  "get_tree_entries",
  "get_note",
]);

/** `vault` and `enabled` are required on a spec and neither is a `HostConfig` key. */
function isHostHarnessSpec(arg: HostHarnessSpec | Partial<HostConfig>): arg is HostHarnessSpec {
  return "vault" in arg && "enabled" in arg;
}

export class HostHarness extends ShimHarness {
  /**
   * Definite-assignment, like every `ShimHarness` field and for the same
   * reason: the sequencer is built around an assembled shim, the shim is built
   * around a hydrated mirror, and a constructor cannot await a hydration.
   */
  readonly lifecycle!: LifecycleSequencer;
  readonly quarantine!: QuarantineTracker;
  readonly coexistence!: CoexistenceMonitor;

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
  private readonly dataDir: DataDir;
  private readonly factories = new Map<string, PluginFactory>();
  /** Every `write_file` this harness answered, by path. See {@link writtenFile}. */
  private readonly written = new Map<string, string>();
  private guiEnabled: string[] | null;
  /** Built by {@link bindHost}, so it is listening to the mirror from the start. */
  private serverValue: HostServer | null = null;

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
              override getSuggestions(): string[] {
                return ["one", "two"];
              }
              override renderSuggestion(): void {
                // The headless host renders nothing; the broker carries the
                // choices to whoever is driving.
              }
              override onChooseSuggestion(): void {
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
            override display(): void {
              new api.Setting(this.containerEl).setName("Greeting").addText((text) => text);
            }
          })(this.app, this),
        );
        this.addCommand({ id: "noop", name: "No-op", callback: () => undefined });
      }
    };

  protected constructor(spec: HostHarnessSpec) {
    // **Always `layoutReady: false`**, whatever the spec says. The latch is the
    // lifecycle's to flip — that is step 3 of the startup order, and
    // `lifecycle-order.test.ts` asserts a plugin sees it false inside `onload`
    // — so a harness that flipped it during construction would make the
    // assertion pass for the wrong reason. `suppressLayoutReady` is passed to
    // the sequencer instead, where it means "never flip it at all".
    const options: ShimHarnessOptions = {
      // **A short socket path, and it has to be short.** A Unix socket address
      // is capped at about 104 bytes on Darwin, and `socketPathFor`'s
      // `<dataDir>/run/<digest>/host.sock` under a checked-out worktree is
      // already past it — the failure is an `EINVAL` from `listen` that names no
      // limit and reads like a bug in the host. `ShimHarness` derives the socket
      // from the data dir precisely so a harness cannot bind one in the user's
      // home directory; this keeps that property (the path is inside the
      // repository's own `target/tmp`) and buys back the twenty-odd characters.
      config: { socketPath: freshSocketPath(), ...(spec.config ?? {}) },
      layoutReady: false,
    };
    if (spec.configFiles !== undefined) options.configFiles = spec.configFiles;
    super(options);
    this.guiEnabled = spec.guiEnabled ?? null;
    this.fixtures = new FixtureVault(spec.vault);
    this.dataDir = new DataDir(this.config.dataDir);
    for (const [id, factory] of Object.entries(spec.plugins ?? {})) this.factories.set(id, factory);
  }

  /**
   * Build a host over `spec` — assembled, hydrated, and **not started**.
   *
   * The second overload is not a fiction. `create` is also
   * {@link DaemonHarness}'s, TypeScript checks a class's static side against
   * its base's, and `HostHarness.create({})` already meant "build a plain
   * `DaemonHarness`" before this class existed. The implementation keeps
   * exactly that behaviour rather than inventing a new one for it. Task 14's
   * `PluginSetHarness` carries the same pair for the same reason.
   */
  static override create(spec: HostHarnessSpec): Promise<HostHarness>;
  static override create(overrides?: Partial<HostConfig>): DaemonHarness;
  static override create(
    arg: HostHarnessSpec | Partial<HostConfig> = {},
  ): Promise<HostHarness> | DaemonHarness {
    if (!isHostHarnessSpec(arg)) return DaemonHarness.create(arg);
    return HostHarness.assembled(arg);
  }

  private static async assembled(spec: HostHarnessSpec): Promise<HostHarness> {
    const harness = new HostHarness(spec);
    harness.seedConfigZone(spec);
    harness.serveWrites();
    await harness.openMirror({
      generation: 1,
      entries: harness.fixtures.entries(),
      notes: harness.fixtures.notes(),
    });
    harness.assemble();
    // Both config readers prime in their constructors and are read
    // synchronously by the cases that follow. Awaiting the primes is what makes
    // "the first synchronous call answers" true rather than a race against the
    // fixture server.
    await harness.vault.configReady();
    await harness.app.internalPlugins.ready();
    harness.bindHost(spec);
    await harness.quiesce();
    return harness;
  }

  /**
   * Build the quarantine and the sequencer, in the one order that works.
   *
   * The tracker's callback reaches back into the sequencer and the sequencer
   * takes the tracker as a dependency, so one of the two has to be named before
   * it exists. The arrow is what defers that read to the moment a plugin is
   * actually quarantined, by which time both are built.
   */
  private bindHost(spec: HostHarnessSpec): void {
    const mutable = this as {
      -readonly [K in "lifecycle" | "quarantine" | "coexistence"]: HostHarness[K];
    };
    mutable.quarantine = new QuarantineTracker(this.config, (id, failures) =>
      this.lifecycle.onQuarantine(id, failures),
    );
    mutable.coexistence = this.assembly.coexistence;
    mutable.lifecycle = new LifecycleSequencer({
      supervisor: null,
      mirror: this.mirror,
      app: this.app,
      harvest: this.harvest,
      events: this.assembly.events,
      errors: this.assembly.errors,
      dir: this.assembly.dir,
      coexistence: this.assembly.coexistence,
      quarantine: this.quarantine,
      queue: this.assembly.queue,
      config: this.config,
      plugins: this.pluginSeam(),
      onOperation: (label) => {
        this.mark(label);
      },
      ...(spec.suppressLayoutReady === true ? { skipLayoutReady: true } : {}),
    });
    // **Built here, not on the first `connectClient`.** The server subscribes to
    // the mirror, the notice log, the sequencer and the coexistence monitor the
    // moment it exists, so a case that commits a generation before any client
    // connects still has a host whose event sources are wired — and a client
    // that connects afterwards sees a host that has been watching all along
    // rather than one that started watching when it knocked.
    if (spec.config?.wireLateOps === true) {
      throw new Error(
        "wireLateOps: true needs Task 20b's broker, plugin config service and detector, none of " +
          "which exist yet. Leave it false (or unset) and the six late ops answer host_not_ready.",
      );
    }
    this.serverValue = new HostServer({
      config: this.config,
      lifecycle: this.lifecycle,
      harvest: this.harvest,
      mirror: this.mirror,
      client: this.assembly.client,
      quarantine: this.quarantine,
      coexistence: this.assembly.coexistence,
      noticeLog: this.noticeLog,
      app: this.app,
      dir: this.assembly.dir,
      queue: this.assembly.queue,
      errors: this.assembly.errors,
      policyRecorder: this.policyRecorder,
    });
  }

  /**
   * How the sequencer loads a plugin here: a class the case wrote, through the
   * real {@link BundleLoader}.
   *
   * Production compiles a bundle out of the config directory
   * (`bundlePluginLoader`); a test cannot, because "a plugin whose rename
   * handler throws" has to be expressible inline rather than as a compiled
   * fixture. What both share is everything that follows: registration before
   * `onload`, the attribution window, and the three-step teardown.
   */
  private pluginSeam(): PluginLoadSeam {
    return {
      load: async (id: string): Promise<void> => {
        const factory = this.factories.get(id);
        if (factory === undefined) {
          throw new Error(`this harness has no plugin factory for "${id}"`);
        }
        await this.load(this.instantiate(id, factory(this.api)));
      },
      unload: (id: string): Promise<void> => this.unload(id),
    };
  }

  /**
   * Connect a client to the host's socket, and say hello with the nonce.
   *
   * **Activated by Task 16a.** It listens first if nothing has: a case about
   * `host.list_commands` should not have to remember that a socket has to be
   * bound before anything can knock on it, and `listen()` is idempotent.
   *
   * `stalled: true` pauses the socket **after** the hello handshake, which is
   * the only order that works: a paused socket delivers no `data` events, so a
   * client that was paused from the first byte could never read the answer to
   * its own hello. A case that wants to subscribe before stalling calls
   * {@link HostTestClient.stall} instead, which is what the lag case does.
   */
  async connectClient(options: { stalled?: boolean } = {}): Promise<HostTestClient> {
    const socketPath = await this.server.listen();
    const client = await HostTestClient.open(socketPath);
    this.clients.push(client);
    // Kept on the client, because `host.hello` is answered once per connection
    // and a case that wants to assert on the payload — the casing walk does —
    // cannot ask for it a second time.
    client.rememberHello(await client.call("host.hello", { nonce: this.readNonce() }));
    if (options.stalled === true) client.stall();
    return client;
  }

  /** Resolve once the server has flushed every queued event. */
  serverQuiesce(): Promise<void> {
    return this.server.quiesce();
  }

  /** The host's protocol server, wired to this harness's mirror and lifecycle. */
  get server(): HostServer {
    if (this.serverValue === null) {
      throw new Error("this harness has not been assembled yet");
    }
    return this.serverValue;
  }

  /** The modal/suggester broker. **Activated by Task 18.** */
  get broker(): never {
    throw notActivated("broker", "18");
  }

  /** The `--dry-run` gate. **Activated by Task 19.** */
  get dryRun(): never {
    throw notActivated("dryRun", "19");
  }

  /** The compatibility detector. **Activated by Task 20.** */
  get detector(): never {
    throw notActivated("detector", "20");
  }

  setGuiEnabled(ids: string[] | null): void {
    this.guiEnabled = ids;
    // `null` is not an empty list: "Obsidian has no config file" and "Obsidian
    // has one that enables nothing" are different facts and the monitor treats
    // them differently, so the absent case has to be expressible. `unserveFile`
    // is the only way to take a path back off the wire — `autoServeFiles`
    // merges.
    if (ids === null) this.unserveFile(GUI_COMMUNITY_PLUGINS);
    else this.setConfigFile(GUI_COMMUNITY_PLUGINS, JSON.stringify(ids));
  }

  /** Run a command by id, through the same path a client call takes. */
  async invoke(commandId: string): Promise<void> {
    this.app.commands.executeCommandById(commandId);
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
   * Commit one generation on the fake daemon and let the host deliver it.
   *
   * `renamed` is sugar, and the shape of the sugar is the point: **the wire has
   * no rename**. A `rename_note` reaches a client as a delete plus a create, so
   * that is what this expands to, and the shim's pairing is what has to put
   * them back together. A helper that sent a rename event would be testing a
   * message the daemon never sends.
   *
   * **It answers its own refetch, and it has to.** A mirror handed a change set
   * asks `get_tree_entries` and then one `get_note` per surviving note; nothing
   * else in this harness answers those, so a version that only awaited
   * `applyMutation` could never resolve. The answers come from {@link fixtures},
   * which is moved to match the change first, so what the harness tells the
   * mirror is what the vault now holds rather than a second hand-written account
   * of it.
   *
   * **And it waits for the fan-out.** `applyMutation` resolves when the *mirror*
   * has applied the change; the plugins are told on a chain behind that, and
   * telling them includes reading each changed note's source back. A case that
   * awaited only the mirror would assert on an event list that was still being
   * filled in.
   */
  async commitGeneration(change: {
    generation?: number;
    created?: string[];
    modified?: string[];
    deleted?: string[];
    renamed?: Array<{ from: string; to: string }>;
    sources?: Record<string, string>;
    /**
     * Announce the commit as the daemon would, before the mirror applies it.
     *
     * Default `true`, because that is the real order: the daemon commits, the
     * subscription carries `generation_committed`, and this host's mirror
     * catches up behind it — which is exactly the window `HostServer` holds the
     * relay across. A case driving the relay by hand passes `false` so the only
     * event on the wire is the one it fed in.
     */
    announce?: boolean;
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
    // **A modified path with no new bytes is not a modification**, and the
    // mirror is right to say nothing about one: a batch reports a change, which
    // is what keeps a shim write to a single `changed` event. So a case that
    // names a path in `modified` and supplies no source gets an edit made for
    // it, rather than an event list that is silently one shorter than the case
    // expects. The marker is a line of its own so the note still parses as the
    // note it was.
    for (const path of modified) {
      if (change.sources?.[path] !== undefined) continue;
      this.fixtures.write(path, `${this.fixtures.source(path)}\nedited at ${String(generation)}\n`);
    }
    for (const path of created) {
      if (!(path in this.fixtures.files)) this.fixtures.write(path, "");
    }
    for (const path of deleted) this.fixtures.remove(path);
    this.serveFixtures(deleted);

    // **The daemon announces first.** A real commit reaches this host as a
    // subscription event and the mirror catches up behind it, so the harness
    // hands the server the event before it applies the change — which is the
    // window `HostServer` holds the relay across, and holding it is the only
    // reason a client cannot page a generation the mirror does not have.
    if (change.announce !== false) {
      this.serverValue?.relayDaemonEvent({
        type: "generation_committed",
        value: {
          previous_generation: this.mirror.generation(),
          generation,
          cause: "mutation",
          changes: {
            kind: "detailed",
            created: [...created],
            modified: [...modified],
            deleted: [...deleted],
          },
          affected_note_count: [...created, ...modified, ...deleted].filter((path) =>
            path.toLowerCase().endsWith(".md"),
          ).length,
          affected_reference_count: 0,
        },
      });
    }

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
    await this.settleHost();
  }

  /**
   * **There is no `restartEngine` here, and there must not be one.**
   *
   * The draft of this harness had one: it handed the mirror a
   * `resync_required { runtime_recovered }` with a wholesale new fixture vault,
   * which is the one shape that *guarantees* a synthetic batch. A real engine
   * replacement does not guarantee one. Measured against the real daemon —
   * SIGKILL the engine under a running sequencer, mutate the vault while it is
   * down, let the supervisor bring a new one up — the mirror re-hydrates to an
   * empty diff and then catches up through **ordinary delta batches**, and the
   * duplicate guard that was written against the other shape replayed every one
   * of those events a second time.
   *
   * A fake daemon cannot produce that: there is no process to kill, no
   * supervisor to restart it, and no race between a re-hydration and a
   * subscription catching up. So restart continuity is pinned where it is real,
   * in `test/lifecycle-restart-real-daemon.test.ts`, and this harness does not
   * offer a method that would make a green run mean less than it looks.
   */

  async advanceClock(ms: number): Promise<void> {
    await this.clock.advance(ms);
    await this.settleHost();
  }

  tick(): Promise<void> {
    return this.clock.tick();
  }

  /**
   * The last error a plugin's handler raised, or `null`.
   *
   * Read off the quarantine rather than off a second collector of this
   * harness's own: the tracker records every failure it is handed whether or
   * not the threshold is reached, which is exactly this question, and two
   * records of one fact would be two answers the day they disagreed.
   */
  lastHandlerError(pluginId: string): Error | null {
    return this.quarantine.lastError(pluginId);
  }

  /**
   * Every **mirror** request the daemon saw since `marker`.
   *
   * The marker is one the sequencer placed itself — every public lifecycle
   * operation logs its name through `onOperation` — so `mirrorRequestsSince("enableLate")`
   * is "what did the enable ask the index for", and the honest answer for an
   * enable is nothing at all: the vault did not change because a plugin was
   * switched on. Config reads are not mirror requests and are filtered out, so
   * "no mirror requests" means "no *indexed* mirror requests" — the assertion
   * still has teeth, because a re-hydration would send `open_snapshot` and a
   * refetch `get_tree_entries`. See {@link MIRROR_METHODS}.
   */
  mirrorRequestsSince(marker: string): readonly string[] {
    const seen = this.methodsSeen();
    const at = seen.lastIndexOf(marker);
    const since = at === -1 ? seen : seen.slice(at + 1);
    return since.filter((method) => MIRROR_METHODS.has(method));
  }

  /**
   * What the host last wrote to `path` through `write_file`, or `undefined`.
   *
   * The question a persistence assertion actually has: not "what would a read
   * answer" — the harness serves the write back, so that is circular — but
   * "did the host write it at all". A late enable that loaded its plugin and
   * never wrote the set is a plugin that runs now and is gone after a restart.
   */
  writtenFile(path: string): string | undefined {
    return this.written.get(path);
  }

  /**
   * Rename through the shim, the whole way: the op, the answer, the refetch.
   *
   * Four steps, because a shim rename is four, and a helper that answered fewer
   * hands back a promise that never settles. The fixture vault is moved before
   * the refetch is answered, so what the harness tells the mirror is what the
   * vault now holds.
   *
   * It is the **host-initiated** arm of the folder-move ruling: `Vault.rename`
   * records the pair, which is the only thing that lets a folder — which has no
   * content revision to pair on — reach a plugin as one `rename` rather than a
   * delete and a create. An external move has no such record and is driven
   * through {@link commitGeneration} instead.
   */
  async renameViaShim(from: string, to: string): Promise<void> {
    const node = this.vault.getAbstractFileByPath(from);
    if (node === null) throw new Error(`${from} is not in this harness's vault`);
    const folder = node instanceof TFolder;
    const method = folder ? "rename_folder" : "rename_note";
    const renaming = this.vault.rename(node, to);
    const request = await this.expectRequest(method);
    const generation = this.mirror.generation() + 1;

    const moved = Object.keys(this.fixtures.files).filter(
      (path) => path === from || path.startsWith(`${from}/`),
    );
    for (const path of moved) {
      this.fixtures.write(`${to}${path.slice(from.length)}`, this.fixtures.source(path));
      this.fixtures.remove(path);
    }
    this.serveFixtures(moved);
    this.respondOk(request.id, method, {
      generation,
      links_rewritten: 0,
      link_rewrite_failures: [],
    });
    await this.answerRefetch(generation, this.fixtures.notes(), {
      entries: this.fixtures.entries(),
      absent: [from, ...moved],
    });
    await renaming;
    await this.settleHost();
  }

  daemonMethodsSeen(): readonly string[] {
    return this.methodsSeen();
  }

  clearDaemonMethodLog(): void {
    this.clearMethodLog();
  }

  /**
   * Loosen the socket directory's mode, so the host's refusal can be tested.
   *
   * It **makes** the directory first, because the case that widens it runs
   * before `listen()` — which is the whole point, since `listen()` is what has
   * to refuse — and there would otherwise be nothing to `chmod`. The creation is
   * at `0700`, the mode the host would have used, so the only difference between
   * this and an ordinary startup is the widening the case asks for.
   */
  chmodSocketDir(mode: number): void {
    const directory = new DataDir(socketDirOf(this.config.socketPath));
    directory.ensureSecureDir(".");
    directory.chmod(".", mode);
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
    // Before the lifecycle, so nothing is broadcasting into sockets that are
    // being torn down — and it is safe on a harness that never listened, which
    // most of them are.
    await this.serverValue?.close();
    await this.lifecycle.stop();
    await super.stop();
  }

  /** Let the mirror, the fan-out and the event loop all catch up. */
  private async settleHost(): Promise<void> {
    await this.quiesce();
    await this.lifecycle.settled();
    await this.quiesce();
  }

  /**
   * The config zone as it stands before the host reads any of it.
   *
   * Every path the host's readers prime from has to **answer**, served or
   * `not_found`, or the prime's read sits in the request queue forever and the
   * next `nextRequest()` hands out a `read_file` a case expected to be its own
   * write. That is the rule the rest of this method exists to keep.
   */
  private seedConfigZone(spec: HostHarnessSpec): void {
    this.setConfigFile(
      `${this.config.configDirName}/community-plugins.json`,
      JSON.stringify(spec.enabled),
    );
    this.setGuiEnabled(this.guiEnabled);
    // **The daemon's copy, not the XDG state directory.** The pending draft of
    // this harness wrote a plugin's saved settings into `DataDir`, which is
    // where the host keeps its *own* state; Task 10 settled that a plugin's
    // `data.json` lives at `<vault>/<configDir>/plugins/<id>/data.json` and
    // reaches it through the daemon, and `Plugin.loadData` reads exactly that
    // path. A seed anywhere else is a seed no plugin can find.
    for (const [id, data] of Object.entries(spec.pluginData ?? {})) {
      this.setConfigFile(pluginDataPath(this.config.configDirName, id), JSON.stringify(data));
    }
    // **The plugins directory, as a directory.** `host.list_plugins` and
    // `host.enable_plugin` read the installed set through `read_dir` plus one
    // `manifest.json` per folder, and a harness that served neither would leave
    // those reads sitting in the request queue forever — a hang, not a failure,
    // which is the worst way for a harness to be incomplete. Every plugin the
    // spec supplies a factory for is installed here, with the manifest
    // `manifestFor` would give it, so "installed" means the same thing to the
    // host as it does to the case.
    const ids = [...this.factories.keys()].sort();
    for (const id of ids) {
      const { dir, ...manifest } = this.manifestFor(id);
      void dir;
      this.setConfigFile(
        `${pluginDirPath(this.config.configDirName, id)}/manifest.json`,
        JSON.stringify(manifest),
      );
    }
    this.autoServeDirs({
      [`${this.config.configDirName}/plugins`]: ids.map((id) => ({ name: id, kind: "folder" })),
    });
    this.serveVaultInfo();
    this.serveEditorNotes();
    this.serveFixtures([]);
    for (const path of configFilePathsFor(this)) {
      if (spec.configFiles?.[path] === undefined) this.unserveFile(path);
    }
  }

  /**
   * Serve every note the fixture vault now holds, and answer `not_found` for
   * the paths it no longer does.
   *
   * Called after every change, because two things read a note's bytes back off
   * the wire: the position warm-up, and the sequencer's own read of the source
   * a `metadataCache` `changed` event carries.
   */
  private serveFixtures(gone: readonly string[]): void {
    this.autoServeFiles({ ...this.fixtures.files });
    for (const path of gone) {
      if (!(path in this.fixtures.files)) this.unserveFile(path);
    }
  }

  /**
   * Answer the `get_note` an `Editor.open` issues, and only that one.
   *
   * **The `include` field is what separates the two callers**, exactly as it
   * does in `ShimHarness.serveNotes`: the mirror's refetch always asks for
   * `include: ["sections", "list_items"]` and an editor read asks for neither.
   * A `get_note` with an `include` is left for `answerRefetch` to answer.
   *
   * It is repeated here rather than inherited because `HostHarness` assembles
   * itself — it opens its own mirror rather than going through
   * `ShimHarness.start`, which is what fills that harness's note rows — so
   * without this an editor command hangs on a read nothing ever answers. Task
   * 16a's `host.invoke_command` with an `active_file` is the first caller to
   * find out.
   */
  private serveEditorNotes(): void {
    this.serve((request) => {
      if (request.request.method !== "get_note") return false;
      const params = request.request.params as { path?: string; include?: unknown };
      if (params.include !== undefined) return false;
      const path = params.path;
      if (path === undefined) return false;
      const row = this.fixtures.notes().find((note) => note.path === path);
      const source = this.fixtures.files[path];
      if (row === undefined || source === undefined) return false;
      this.respondOk(request.id, "get_note", {
        generation: this.mirror.generation(),
        note: { ...noteDto(row), source },
      });
      return true;
    });
  }

  /**
   * Answer `get_vault_info` from what this harness actually holds.
   *
   * The daemon op a client is most likely to send first, and the one Task 16a's
   * forwarding case uses to prove that a non-`host.` method reaches the daemon
   * verbatim: a harness that did not answer it would leave that case hanging on
   * a request nothing ever replies to, which proves nothing about forwarding.
   */
  private serveVaultInfo(): void {
    this.serve((request) => {
      if (request.request.method !== "get_vault_info") return false;
      this.respondOk(request.id, "get_vault_info", {
        generation: this.mirror.generation(),
        canonical_root: this.config.vaultRoot,
        vault_identity: "fake-vaultd",
        state: "ready",
        note_count: this.mirror.entries().filter((entry) => entry.kind === "note").length,
        refreshed_at_unix_ms: this.config.clock.now(),
        live_state: "watching",
      });
      return true;
    });
  }

  /**
   * Answer `write_file`, and remember what it wrote.
   *
   * The enabled set is written by a late enable and by a disable, and a
   * plugin's `saveData` writes its own `data.json`. Remembering is what makes
   * the next read see the write — so "the enable persisted" is a fact a case
   * can assert rather than a claim.
   */
  private serveWrites(): void {
    this.serve((request) => {
      if (request.request.method !== "write_file") return false;
      const params = request.request.params as { path?: string; content_base64?: string };
      const { path, content_base64: encoded } = params;
      if (path === undefined || encoded === undefined) return false;
      const content = Buffer.from(encoded, "base64").toString("utf8");
      this.written.set(path, content);
      this.setConfigFile(path, content);
      // `semantic: false`, and therefore no `generation`: every path this
      // harness is written for is inside a hidden config directory, and nothing
      // there joins a generation.
      this.respondOk(request.id, "write_file", {
        revision: revisionOfSource(content),
        semantic: false,
      });
      return true;
    });
  }
}

/** The refusal a member belonging to a later task answers with. */
function notActivated(member: string, task: string): Error {
  return new Error(
    `HostHarness.${member} is activated by Task ${task}, which has not run yet. The member is ` +
      "kept by name so a case written against it fails here rather than somewhere else.",
  );
}

/** The socket's own directory — the one whose mode the host checks. */
function socketDirOf(socketPath: string): string {
  const cut = socketPath.lastIndexOf("/");
  return cut === -1 ? "." : socketPath.slice(0, cut);
}

/** The prefix every harness socket directory starts with, and the sweep matches. */
const SOCKET_PREFIX = "host-sock-";

/**
 * A socket directory no other harness has, under the repository's `target/tmp`.
 *
 * `mkdtemp` makes it at `0700` — which is what the host asserts — and the short
 * name is deliberate: everything after `target/tmp/` counts against Darwin's
 * ~104-byte socket address limit, so the file inside it is called `s`.
 *
 * Swept on the same terms `ShimHarness` sweeps its data dirs: a six-hour floor,
 * so no live run's directory can be caught by another fork's sweep, and failures
 * are ignored because two forks tidying the same stale directory at once is the
 * ordinary case rather than an error.
 */
function freshSocketPath(): string {
  const root = resolve(__dirname, "..", "..", "..", "..", "..", "target", "tmp");
  fs.mkdirSync(root, { recursive: true });
  if (!sweptSockets) {
    sweptSockets = true;
    sweepStaleDataDirs(root, SOCKET_PREFIX);
  }
  return join(fs.mkdtempSync(join(root, SOCKET_PREFIX)), "s");
}

let sweptSockets = false;

/**
 * A refusal the host answered with, as an `Error`.
 *
 * The wire body is `{ code, message }` and both are kept: `code` is the stable
 * thing to branch on, the message is the sentence a failing case prints, and
 * `body` is the whole answer for anything that wants the rest of it.
 */
export class HostCallFailed extends Error {
  readonly code: string;
  readonly body: unknown;

  constructor(body: unknown) {
    const refusal = body as { code?: unknown; message?: unknown } | null;
    const message = typeof refusal?.message === "string" ? refusal.message : String(body);
    super(message);
    this.name = "HostCallFailed";
    this.code = typeof refusal?.code === "string" ? refusal.code : "unknown";
    this.body = body;
  }
}

/**
 * A client of the host's socket, as a test drives one.
 *
 * Line-delimited JSON, the same framing the real client uses, and no sleeps:
 * {@link quiesce} resolves on a quiet turn of the event loop rather than after
 * a chosen number of milliseconds. **Task 16a's cases are its consumers**; it is
 * real and unchanged here because nothing about it depends on a server existing.
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
  private stalled = false;
  /** What `host.hello` answered on this connection. See {@link rememberHello}. */
  private hello: unknown = null;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.absorb(chunk.toString("utf8"));
    });
  }

  static open(socketPath: string): Promise<HostTestClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        resolve(new HostTestClient(socket));
      });
      socket.once("error", reject);
    });
  }

  /** Keep the hello payload; a second `host.hello` is refused by the host. */
  rememberHello(payload: unknown): void {
    this.hello = payload;
  }

  /** What this connection's `host.hello` answered. */
  helloPayload(): unknown {
    return this.hello;
  }

  /**
   * Stop reading, so the host's bounded queue is what backs up.
   *
   * **A stall is not a state a connection can open in**, which is the one place
   * the phase brief's sketch could not work: a socket paused from the first byte
   * delivers no `data` events at all, so a client that stalled before its own
   * `host.hello` could never read the answer and every `call` on it would hang
   * forever. Attaching a `data` listener does not rescue it either — Node
   * re-resumes a stream on `on("data")` only when it was not explicitly paused.
   *
   * So a case does the handshake, subscribes, and *then* stalls, which is also
   * the honest shape of the failure being reproduced: a client that was working
   * and stopped reading. Nothing may be awaited until {@link resume}.
   */
  stall(): void {
    this.stalled = true;
    this.socket.pause();
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.sequence += 1;
    const id = `test-${String(this.sequence)}`;
    const frame = JSON.stringify({ version: 1, id, request: { method, params } });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (outcome) => {
        const body = outcome as { status: string; value: unknown };
        if (body.status === "ok") resolve((body.value as { value: T }).value);
        // A refusal is a `{ code, message }` body on the wire, and this used to
        // reject with the body itself. It rejects with an `Error` carrying both
        // instead: a rejection reason that is not an `Error` has no stack, is
        // reported by every runner as `[object Object]`, and is what the lint
        // rule of the same name exists to stop. `code` is still there to branch
        // on, and `body` still holds the whole refusal.
        else reject(new HostCallFailed(body.value));
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
