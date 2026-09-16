/**
 * The lifecycle sequencer: the one component that turns a pile of parts into a
 * running plugin host.
 *
 * Tasks 1–14b built everything a plugin touches. None of it is wired to
 * anything else's events: the mirror publishes change batches nobody listens
 * to, the vault's file index has an `applyBatch` nobody calls, the metadata
 * cache exposes two notify seams with no caller, the workspace has a
 * layout-ready latch nothing flips, and the quarantine counts failures nothing
 * hands it. This is the wiring, and the order it happens in.
 *
 * ## The startup order, which is where plugins silently die
 *
 * 1. **Hydrating.** The mirror is already hydrated — `Mirror.open` is a static
 *    that has to run before `assembleShim`, because every shim surface is built
 *    around a mirror — so what this phase does is the rest of getting ready:
 *    warm the position indexes, read the enabled set, and take the coexistence
 *    reading. Nothing a plugin can see happens here.
 * 2. **Loading.** The enabled set, filtered by the coexistence check, loads
 *    **sequentially in file order** through the dispatch queue, so a plugin that
 *    awaits inside `onload` still cannot interleave with the next one's.
 *    `workspace.layoutReady` is `false` throughout, and registrations harvest as
 *    they are made.
 * 3. **Layout ready.** The latch flips and the queued `onLayoutReady` callbacks
 *    run, in registration order.
 * 4. **Resolving.** `metadataCache` fires `resolve` once per note, in path
 *    order, and then `resolved` once.
 * 5. **Steady.** Every mirror batch becomes an ordered run of
 *    `vault.on(create|modify|rename|delete)` and
 *    `metadataCache.on(changed|deleted)`, closed by one `resolved`.
 *
 * `resolved` after **every** batch is the load-bearing part of step 5. Six
 * plugins in the census gate their whole startup on it, and a host that fired it
 * once at boot would leave anything enabled afterwards waiting for a vault
 * change that a quiet vault never has. That is the silent-deadlock class this
 * component exists to close, and {@link LifecycleSequencer.enableLate} closes
 * the other half of it with a synthetic `resolved` delivered to the newly
 * enabled plugin alone.
 *
 * ## The event order inside one batch, and why it is not the order the brief
 * sketched
 *
 * Creates, then modifies with each modified note's `changed` behind them, then
 * renames, then deletes with each deleted note's `deleted` behind them, then one
 * `resolved`. The phase brief's prose put every `metadataCache` event after
 * every `vault` event — and its own restart-continuity test pins
 * `create`, `changed`, `delete`, which is the order written here. The test wins:
 * it is the executable half of the specification, and grouping a file's vault
 * event with its cache event is also what a reader of Obsidian's stream sees,
 * where a note's parse follows that note's write rather than the whole batch's.
 *
 * **One exception, and it is Ruling W6's.** A path that a batch both deletes
 * and creates is a folder replaced by a file of the same name, or the reverse:
 * the thing that was there went and a *different* thing took its name. Those
 * paths are replayed delete-first, ahead of everything else, because a handler
 * told "created" and then "deleted" about one path would conclude the path is
 * gone.
 *
 * **A renamed path emits only the rename** — never a create and a delete for
 * one move. folder-notes' tab manager is a rename handler, and half the corpus
 * keys a cache by `TFile`; a move reported as a death and a birth empties every
 * one of those caches and fires the wrong handler.
 *
 * ## What is attributed, and what is never counted
 *
 * `ShimEventBus` catches a throwing listener per listener, so one plugin's bug
 * can never skip another plugin's handler or stop the batch. Every such failure
 * arrives here with the owning plugin's id, becomes a `HandlerFailure` labelled
 * `event:<event name>`, and is counted by the quarantine. So does every failure
 * that reaches the host's error sink with a plugin's name on it. The host's own
 * failures — phase `config`, or the plugin id `host` — are dropped by
 * {@link failureFromReport} and counted against nobody, because a host that
 * quarantined a plugin for its own bug would disable working plugins one at a
 * time until somebody noticed.
 */

import { join } from "node:path";

import { HOST_PLUGIN_ID } from "../shim/errors";
import { OverlapRefused, overlapRefusalMessage } from "../pluginset/coexistence";
import { TFile } from "../shim/files";
import { failureFromReport } from "./quarantine";
import type { App } from "../shim/app";
import type { BundleLoader } from "./loader";
import type { CoexistenceMonitor } from "../pluginset/coexistence";
import type { DispatchQueue } from "./queue";
import type { HandlerFailure, QuarantineTracker } from "./quarantine";
import type { HeadlessConfigDir } from "../pluginset/config-dir";
import type { Harvest } from "../shim/harvest";
import type { HostConfig } from "../config";
import type { HostErrorEntry, HostErrors } from "../shim/errors";
import type { Mirror } from "../mirror/mirror";
import type { MirrorChangeBatch } from "../mirror/types";
import type { ShimEventBus } from "../shim/events";
import type { Supervisor } from "../supervisor";
import type { TAbstractFile } from "../shim/files";

export type LifecyclePhase =
  | "cold"
  | "hydrating"
  | "loading"
  | "layout_ready"
  | "resolving"
  | "steady"
  | "stopping"
  | "stopped";

/**
 * How the host turns a plugin id into a running plugin, and back.
 *
 * A seam rather than a method on this class, because the two callers answer it
 * from different places. Production reads a bundle out of the headless config
 * directory and compiles it — {@link bundlePluginLoader} is that answer, in one
 * place so Task 22 does not write a second one. A test hands the loader a class
 * it wrote inline, which is the only way to express "a plugin that throws from
 * its rename handler" without shipping a compiled fixture for every case.
 *
 * Both go through Task 13's {@link BundleLoader} underneath, so both get the
 * same registration order, the same attribution window, and the same three-step
 * teardown. The seam chooses where the code comes from, never what the
 * lifecycle does with it.
 */
export interface PluginLoadSeam {
  load(id: string): Promise<void>;
  unload(id: string): Promise<void>;
}

export interface LifecycleDeps {
  /**
   * The engine, or `null` for a host driven straight off a client.
   *
   * It is **not** started here: the mirror cannot hydrate without an engine and
   * the mirror is built before the shim is, so whoever opened the mirror has
   * already started one. What this class does with it is stop it — see
   * {@link LifecycleSequencer.stop}.
   */
  supervisor: Supervisor | null;
  mirror: Mirror;
  app: App;
  harvest: Harvest;
  /** Task 6b's bus — the fan-out and the failure attribution. */
  events: ShimEventBus;
  /** Where a failure nobody is waiting on goes, and where they are read from. */
  errors: HostErrors;
  dir: HeadlessConfigDir;
  coexistence: CoexistenceMonitor;
  /** Task 14b. Built with {@link LifecycleSequencer.onQuarantine} as its callback. */
  quarantine: QuarantineTracker;
  queue: DispatchQueue;
  config: HostConfig;
  /** See {@link PluginLoadSeam}. */
  plugins: PluginLoadSeam;
  /**
   * Called once at the head of each public operation, with its label.
   *
   * The host's operation log seam: a running host wants a line per `start`,
   * `enableLate`, `disable`, `onEngineRestart` and `stop`, and a test wants a
   * marker in the daemon's request log so it can assert which requests an
   * operation caused. One hook answers both, and it is the only observability
   * this class has that is not a return value.
   */
  onOperation?: (label: string) => void;
  /**
   * Leave `workspace.layoutReady` false forever. **Tests only.**
   *
   * It reproduces the failure mode the trap cases are about — a plugin whose
   * rename handler needs something its `onLayoutReady` callback builds — so that
   * the case which proves the handler *survives* has a companion proving it
   * would otherwise have crashed. Production never sets it; a host that did
   * would be a host no plugin finishes starting on.
   */
  skipLayoutReady?: boolean;
}

export interface StartupReport {
  readonly generation: number;
  readonly loaded: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
  readonly hydrationMs: number;
  readonly warmMs: number;
  readonly loadMs: number;
}

/** The scoped bus name of `metadataCache`'s events, for the labels below. */
const METADATA_PREFIX = "metadataCache";

export class LifecycleSequencer {
  private phaseValue: LifecyclePhase = "cold";
  /**
   * The one chain every batch delivery runs on.
   *
   * Batches arrive from a synchronous fan-out inside the mirror, each becomes
   * an asynchronous run of plugin entry points, and two of them interleaving
   * would deliver one batch's `resolved` in the middle of another's events. The
   * chain never rejects: a delivery that throws is reported and the next one
   * still runs, because one batch's failure must not stop the vault.
   */
  private work: Promise<void> = Promise.resolve();
  private readonly detachers: Array<() => void> = [];
  private readonly loadedIds: string[] = [];
  private readonly timings = new Map<string, number>();
  /**
   * The generation of the last **synthetic** batch this sequencer delivered.
   *
   * {@link onEngineRestart} reads it to tell "the mirror already replayed this
   * re-hydration" from "the mirror emitted nothing and the diff is mine to
   * replay". See that method.
   */
  private lastSyntheticGeneration = -1;

  constructor(private readonly deps: LifecycleDeps) {
    // In the constructor rather than in `start()`, so nothing can arrive in the
    // gap. A plugin that writes from its own `onload` produces a batch while
    // the host is still loading, and a subscription opened afterwards would
    // drop it.
    this.detachers.push(
      deps.mirror.onBatch((batch) => {
        void this.enqueue(() => this.deliver(batch));
      }),
    );
    // The mirror's own answer to an application it could not complete is
    // already a resync, so this seam is a place to report rather than a place
    // to repair. The `null` event is a re-warm that failed after a mutation,
    // which belongs to no event at all.
    this.detachers.push(
      deps.mirror.onApplyError((error) => {
        deps.errors.report(error, HOST_PLUGIN_ID, "event");
      }),
    );
    // A plugin's event handler threw. The bus knows who owned it; the phase and
    // the event name become the quarantine's label.
    this.detachers.push(
      deps.events.onHandlerError((failure) => {
        this.recordFailure(
          {
            error: failure.error,
            pluginId: failure.owner ?? HOST_PLUGIN_ID,
            phase: "event",
          },
          failure.event,
        );
      }),
    );
    // Everything else a plugin can fail at with nobody waiting: `onload`,
    // `onunload`, a teardown, a menu hook, a command's rejected promise, a
    // `data.json` that will not parse. `failureFromReport` is what drops the
    // host's own two kinds.
    this.detachers.push(
      deps.errors.onError((error, pluginId, phase) => {
        this.recordFailure({ error, pluginId, phase });
      }),
    );
  }

  phase(): LifecyclePhase {
    return this.phaseValue;
  }

  /** How long each plugin's `onload` took, by id, in the order they loaded. */
  loadTimings(): ReadonlyMap<string, number> {
    return this.timings;
  }

  /**
   * Resolve once every batch delivery in flight has finished.
   *
   * Not in the phase brief's interface and it has to be: a batch arrives on a
   * synchronous callback from inside the mirror, so "the mirror has applied the
   * change" and "the plugins have been told about it" are different moments,
   * and nothing else in the host can bridge them. {@link stop} waits on it, and
   * so does any caller that wants to assert on what a change did.
   */
  settled(): Promise<void> {
    return this.work;
  }

  /**
   * Start the host: hydrate, load, flip the latch, resolve, go steady.
   *
   * Every phase awaits the one before it. The report is what a caller needs to
   * say whether the host came up: which plugins are running, which were refused
   * or threw, and what each stage cost.
   */
  async start(): Promise<StartupReport> {
    if (this.phaseValue !== "cold") {
      throw new Error(`the host lifecycle has already started (phase ${this.phaseValue})`);
    }
    this.deps.onOperation?.("start");
    const clock = this.deps.config.clock;
    const startedAt = clock.now();

    this.phaseValue = "hydrating";
    const warmStartedAt = clock.now();
    await this.deps.mirror.warmPositions();
    const warmMs = clock.now() - warmStartedAt;
    const enabled = await this.deps.dir.readEnabledSet();
    // One reading for the whole set. `assertCanEnable` re-checks per id, which
    // is right on the enable path where the answer is about to be acted on and
    // wrong here, where it would be two config reads per plugin for a question
    // already answered. The monitor's poll is armed straight after, so the
    // reading this filters on is never more than one tick old.
    const overlap = await this.deps.coexistence.check();
    this.deps.coexistence.start();
    const hydrationMs = clock.now() - startedAt;

    this.phaseValue = "loading";
    const loadStartedAt = clock.now();
    const failed: { id: string; error: string }[] = [];
    const refused = new Set(overlap.overlap.filter((id) => !overlap.forced.includes(id)));
    for (const id of enabled) {
      if (refused.has(id)) {
        failed.push({
          id,
          error: new OverlapRefused(id, overlapRefusalMessage(id, this.deps.config.configDirName))
            .message,
        });
        continue;
      }
      const failure = await this.loadOne(id);
      if (failure !== null) failed.push({ id, error: failure });
    }
    const loadMs = clock.now() - loadStartedAt;

    this.phaseValue = "layout_ready";
    if (this.deps.skipLayoutReady !== true) {
      await this.deps.queue.run(null, "workspace:layout-ready", () => {
        this.deps.app.workspace.markLayoutReady();
      });
    }

    this.phaseValue = "resolving";
    await this.resolveEveryNote();
    this.phaseValue = "steady";

    return {
      generation: this.deps.mirror.generation(),
      loaded: [...this.loadedIds],
      failed,
      hydrationMs,
      warmMs,
      loadMs,
    };
  }

  /**
   * Enable a plugin on a host that is already running (Ruling 6).
   *
   * `onload`, then the `layoutReady` callbacks — which run **immediately**,
   * because `Workspace.onLayoutReady` calls back at once when the latch is
   * already flipped, so a plugin enabled at minute forty does its startup work
   * at minute forty — then one synthetic `resolved` **delivered to this plugin
   * alone**. Broadcasting it would re-fire `resolved` at every plugin already
   * running, for a fact that is true of none of them.
   *
   * The enabled set is written **before** the load, which is the order that
   * fails safely: a plugin persisted and then failing to load is retried on the
   * next start, where one that loaded and then failed to persist would run now
   * and vanish at the next start with nothing to say why.
   *
   * Nothing here touches the daemon's index: no re-hydration, no refetch. The
   * vault did not change because a plugin was enabled.
   */
  async enableLate(id: string): Promise<void> {
    this.deps.onOperation?.("enableLate");
    if (this.phaseValue !== "steady") {
      throw new Error(`enableLate(${id}) needs a started host; the phase is ${this.phaseValue}`);
    }
    // The overlap question is asked again rather than read off the last poll:
    // this is the path where the answer is about to be acted on, and a
    // minute-old answer is exactly what the poll admits it cannot avoid
    // elsewhere.
    await this.deps.coexistence.assertCanEnable(id);
    const enabled = await this.deps.dir.readEnabledSet();
    if (!enabled.includes(id)) await this.deps.dir.writeEnabledSet([...enabled, id]);
    const failure = await this.loadOne(id);
    if (failure !== null) throw new Error(`plugin ${id} could not be enabled: ${failure}`);
    await this.deps.queue.run(null, `${METADATA_PREFIX}:resolved:${id}`, () => {
      this.deps.app.metadataCache.notifyResolvedTo(id);
    });
  }

  /**
   * Disable a plugin: take it out of the enabled set, then tear it down.
   *
   * The quarantine record goes with it, because a plugin that is enabled again
   * later starts from nothing. Keeping four stale failures would quarantine it
   * on its first failure after being re-enabled, which is not a rolling window
   * but a grudge.
   */
  async disable(id: string): Promise<void> {
    this.deps.onOperation?.("disable");
    const enabled = await this.deps.dir.readEnabledSet();
    if (enabled.includes(id)) {
      await this.deps.dir.writeEnabledSet(enabled.filter((other) => other !== id));
    }
    await this.deps.plugins.unload(id);
    this.forget(id);
    this.deps.quarantine.forgetPlugin(id);
  }

  /**
   * The engine was replaced (Ruling 7).
   *
   * **Plugins are not reloaded by default.** The index is on disk, so the new
   * engine resumes where the old one committed; the mirror re-hydrates, its
   * `synthesizeDiff` says what moved while this host had no connection, and the
   * sequencer replays that as ordinary events — the same shape as a bulk
   * external edit, which every plugin already tolerates. `onunload` runs for
   * nobody, so a plugin keeps its settings, its timers and its in-memory index.
   *
   * **The mirror usually gets there first, and that is not a duplicate.** The
   * re-hydration the supervisor's `runtime_recovered` marker triggers emits its
   * own synthetic batch, which this class has already delivered by the time a
   * caller reports the restart. So the diff is replayed here only when the
   * mirror emitted nothing for it — which is also the honest fallback for a
   * caller whose revision map predates a re-hydration this host never saw.
   *
   * `reloadPluginsOnEngineRestart` takes the other road: every plugin is torn
   * down and loaded again, and the diff is not replayed at all, because a plugin
   * that has just started has no stale view for it to correct.
   */
  async onEngineRestart(previousRevisions: ReadonlyMap<string, string>): Promise<void> {
    this.deps.onOperation?.("onEngineRestart");
    // Whatever the re-hydration already produced is delivered before anything
    // below looks at what is left to do.
    await this.settled();
    if (this.deps.config.reloadPluginsOnEngineRestart) {
      await this.reloadEveryPlugin();
      this.phaseValue = "steady";
      return;
    }
    const diff = this.deps.mirror.synthesizeDiff(previousRevisions);
    const moved = diff.created.length + diff.modified.length + diff.deleted.length;
    if (moved > 0 && this.lastSyntheticGeneration !== diff.generation) {
      await this.enqueue(() => this.deliver(diff));
    }
    this.phaseValue = "steady";
  }

  /**
   * Stop: no more events, no more polling, every plugin torn down, engine down.
   *
   * The subscriptions go **first**. A batch delivered while plugins are being
   * unloaded would fire a handler belonging to a plugin that is half gone, and
   * the plugin most likely to throw on the way out is exactly the one a
   * shutdown is trying to remove.
   */
  async stop(): Promise<void> {
    if (this.phaseValue === "stopped") return;
    this.deps.onOperation?.("stop");
    this.phaseValue = "stopping";
    for (const detach of this.detachers) detach();
    this.detachers.length = 0;
    this.deps.coexistence.stop();
    // Anything already in flight still finishes: a delivery abandoned halfway
    // would leave half a batch's events fired and no `resolved` behind them.
    await this.settled();
    for (const id of [...this.loadedIds].reverse()) {
      await this.deps.plugins.unload(id);
    }
    this.loadedIds.length = 0;
    await this.deps.supervisor?.stop();
    this.phaseValue = "stopped";
  }

  /**
   * The quarantine's callback: stop trusting this plugin, completely.
   *
   * Public because of an ordering knot rather than a design preference. The
   * tracker is a dependency of this class and its callback has to reach back
   * into it, so a caller builds the tracker with
   * `(id, failures) => sequencer.onQuarantine(id, failures)` once both exist.
   *
   * Three steps, and a quarantine needs all three: the plugin's own teardown,
   * its whole harvest, and every listener it registered. {@link BundleLoader}
   * already does all three, and they are repeated here because the load seam is
   * injectable — a seam that only ran `onunload` would leave a quarantined
   * plugin still invokable by name and still woken by every vault change.
   */
  async onQuarantine(pluginId: string, failures: readonly HandlerFailure[]): Promise<void> {
    // The tracker holds them, and `reason(id)` is where a report reads them
    // from. Naming the parameter is what makes the callback's shape obvious at
    // the call site that builds the tracker.
    void failures;
    await this.deps.plugins.unload(pluginId);
    this.deps.harvest.forgetPlugin(pluginId);
    this.deps.events.detachOwner(pluginId);
    this.forget(pluginId);
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Load one plugin and time it. Answers the failure, or `null`.
   *
   * A plugin that throws from `onload` has already been rolled back by the
   * loader, so there is nothing to undo here: it is recorded and the next one
   * loads. A host that stopped at the first broken plugin would be a host one
   * bad bundle can keep offline.
   */
  private async loadOne(id: string): Promise<string | null> {
    const clock = this.deps.config.clock;
    const startedAt = clock.now();
    try {
      await this.deps.plugins.load(id);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    this.timings.set(id, clock.now() - startedAt);
    if (!this.loadedIds.includes(id)) this.loadedIds.push(id);
    return null;
  }

  /** `resolve` per note in path order, then `resolved`, both through the queue. */
  private resolveEveryNote(): Promise<void> {
    const notes = [...this.deps.app.vault.getMarkdownFiles()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    return this.deps.queue.run(null, `${METADATA_PREFIX}:resolve`, () => {
      const cache = this.deps.app.metadataCache;
      for (const note of notes) cache.trigger("resolve", ...([note] as never[]));
      cache.trigger("resolved");
    });
  }

  /** Tear every plugin down and load them all again, in the same order. */
  private async reloadEveryPlugin(): Promise<void> {
    const ids = [...this.loadedIds];
    for (const id of [...ids].reverse()) await this.deps.plugins.unload(id);
    this.loadedIds.length = 0;
    for (const id of ids) await this.loadOne(id);
    await this.deps.queue.run(null, `${METADATA_PREFIX}:resolved`, () => {
      this.deps.app.metadataCache.trigger("resolved");
    });
  }

  /** Queue one delivery behind everything already queued. Never rejects. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.work.then(async () => {
      try {
        await task();
      } catch (error) {
        this.deps.errors.report(error, HOST_PLUGIN_ID, "event");
      }
    });
    this.work = run;
    return run;
  }

  /**
   * One change batch, as an ordered run of Obsidian events.
   *
   * The index moves first and synchronously, because every event below carries
   * a `TFile` or a `TFolder` out of it; then the sources of the changed notes
   * are read, *outside* the dispatch queue, so a slow daemon does not hold a
   * plugin's commands behind a read; then the whole fan-out happens in one
   * queued slot, so nothing else runs in the middle of a batch.
   */
  private async deliver(batch: MirrorChangeBatch): Promise<void> {
    if (batch.synthetic) this.lastSyntheticGeneration = batch.generation;
    const vault = this.deps.app.vault;
    const cache = this.deps.app.metadataCache;
    const renames = expandFolderMoves(vault.takeFolderMoves(), batch);
    const applied = vault.applyBatch(batch, { renames });

    // Ruling W6: a path in both lists is a thing replaced by a different thing
    // under the same name, and the two steps have to reach a handler in that
    // order or it concludes the path is gone.
    const replaced = new Set(batch.created.filter((path) => batch.deleted.includes(path)));
    const replacedDeletes = applied.deleted.filter((node) => replaced.has(node.path));
    const plainDeletes = applied.deleted.filter((node) => !replaced.has(node.path));

    const modifiedNotes = applied.modified.filter(isNote);
    const sources = new Map<string, string>();
    for (const file of modifiedNotes) {
      try {
        sources.set(file.path, await vault.cachedRead(file));
      } catch (error) {
        // The note went between the batch and the read. `changed` carries the
        // note's new source and there is none, so the event is skipped rather
        // than fired with an invented one — a plugin that reparses `data` would
        // reparse a lie. The delete that really removed it is already on its
        // way.
        this.deps.errors.report(error, HOST_PLUGIN_ID, "event");
      }
    }

    await this.deps.queue.run(null, `vault:batch:${String(batch.generation)}`, () => {
      for (const node of replacedDeletes) {
        vault.trigger("delete", ...([node] as never[]));
        if (isNote(node)) cache.notifyDeleted(node);
      }
      for (const node of applied.created) vault.trigger("create", ...([node] as never[]));
      for (const file of applied.modified) vault.trigger("modify", ...([file] as never[]));
      for (const file of modifiedNotes) {
        const data = sources.get(file.path);
        if (data !== undefined) cache.notifyChanged(file, data);
      }
      for (const move of applied.renamed) {
        // The old path's retained assembly is dropped by hand: a rename fires
        // no `deleted`, so nothing else would ever reclaim it, and
        // `MetadataCache.cacheFor` deliberately does not evict on a gone row.
        cache.forget(move.from);
        vault.trigger("rename", ...([move.file, move.from] as never[]));
      }
      for (const node of plainDeletes) {
        vault.trigger("delete", ...([node] as never[]));
        if (isNote(node)) cache.notifyDeleted(node);
      }
      cache.trigger("resolved");
    });
  }

  /** Count one failure against a plugin — unless it is the host's own. */
  private recordFailure(report: HostErrorEntry, detail?: string): void {
    const failure = failureFromReport(report, this.deps.config.clock.now(), detail);
    if (failure === null) return;
    void this.deps.quarantine.record(failure).catch((error: unknown) => {
      // Task 14b's carry: a rejecting `onQuarantine` propagates *after* the
      // transition, so the plugin is already quarantined and this cannot loop
      // back through `record`. The teardown is what failed, so that is the
      // phase it is reported under.
      this.deps.errors.report(error, failure.pluginId, "teardown");
    });
  }

  private forget(pluginId: string): void {
    const at = this.loadedIds.indexOf(pluginId);
    if (at !== -1) this.loadedIds.splice(at, 1);
  }
}

/**
 * The production load seam: read the bundle out of the headless config
 * directory and compile it.
 *
 * Here rather than in Task 22's `main.ts` so that the one path a real host
 * takes to a real plugin is written once, beside the sequence that drives it.
 */
export function bundlePluginLoader(deps: {
  dir: HeadlessConfigDir;
  loader: BundleLoader;
  config: HostConfig;
  /** Directories prepended to the bundle's `module.paths`. See `runtime/loader.ts`. */
  hostModulePaths: readonly string[];
}): PluginLoadSeam {
  return {
    async load(id: string): Promise<void> {
      const manifest = await deps.dir.readManifest(id);
      const source = await deps.dir.readBundleSource(id);
      await deps.loader.loadBundle({
        manifest,
        request: {
          pluginId: id,
          // Absolute, because it is what a stack trace prints and what Node
          // walks upwards from to resolve every specifier the bundle names.
          filename: join(deps.config.vaultRoot, deps.dir.pluginDir(id), "main.js"),
          source,
          hostModulePaths: deps.hostModulePaths,
        },
      });
    },
    unload(id: string): Promise<void> {
      return deps.loader.unload(id);
    },
  };
}

/**
 * Turn the folder moves this host performed into pairs the file index can
 * replay as renames.
 *
 * A folder carries no content revision, so revision pairing cannot see the move
 * — but a host-initiated one knows both ends exactly, and every descendant's
 * ends with them, because a move is one prefix substitution. The pairs are
 * filtered against the batch rather than trusted: a recorded move whose batch
 * never arrived pairs nothing.
 *
 * An **external** folder move has no record and gets no pairs here. Its notes
 * still pair by revision; the folder row itself is reported as a delete and a
 * create, which is the honest report of the only thing this host can know about
 * it. See `shim/files.ts`.
 */
function expandFolderMoves(
  moves: readonly { from: string; to: string }[],
  batch: MirrorChangeBatch,
): Array<{ from: string; to: string }> {
  if (moves.length === 0) return [];
  const created = new Set(batch.created);
  const pairs: Array<{ from: string; to: string }> = [];
  for (const move of moves) {
    for (const from of batch.deleted) {
      if (from !== move.from && !from.startsWith(`${move.from}/`)) continue;
      const to = `${move.to}${from.slice(move.from.length)}`;
      if (created.has(to)) pairs.push({ from, to });
    }
  }
  return pairs;
}

/** Is this node a note — the only kind of file the metadata cache describes? */
function isNote(node: TAbstractFile): node is TFile {
  return node instanceof TFile && node.extension.toLowerCase() === "md";
}
