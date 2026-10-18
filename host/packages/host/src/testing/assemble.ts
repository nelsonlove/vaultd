/**
 * One factory, one wiring order — for the harnesses and for production alike.
 *
 * **Activated by Task 7**, which moved this file and `shim-harness.ts` up out of
 * `src/testing/pending/` when it built the first shim surface they refer to. The
 * `src/testing/pending` line stays in `tsconfig.json`'s and `vitest.config.ts`'s
 * excludes until the last file leaves that directory (Task 22).
 *
 * **Why one factory.** The shim's surfaces refer to each other in a cycle, so
 * the order they are built in is a real decision with a real failure mode — a
 * surface handed a half-built peer works until the day it reads a field during
 * construction. Writing that order once, here, and having the harnesses use the
 * same function production does means the tests exercise the real wiring rather
 * than a test-only arrangement that happens to work. Task 22's `main.ts` calls
 * this with `systemClock()`, and with Task 19's `DryRunGate` as the
 * {@link WriteGate} when `--dry-run` is on — otherwise with nothing, which
 * takes the {@link forwardingWriteGate} default below.
 */

import { App } from "../shim/app";
import { CoexistenceMonitor } from "../pluginset/coexistence";
import {
  InteractionBroker,
  InteractionTimeout,
  InteractionUnavailable,
  installInteractionBroker,
} from "../interaction/broker";
import { CommandRegistry } from "../shim/commands";
import { HeadlessConfigDir } from "../pluginset/config-dir";
import { FileManager } from "../shim/file-manager";
import { InternalPluginRegistry } from "../shim/internal-plugins";
import { GlobalSearchInstance } from "../shim/global-search";
import { PluginRegistry } from "../shim/plugin-registry";
import { ShimEventBus } from "../shim/events";
import { MetadataCache } from "../shim/metadata-cache";
import { DispatchQueue } from "../runtime/queue";
import { watchdogFor } from "../runtime/watchdog";
import type { Watchdog } from "../runtime/watchdog";
import { HOST_PLUGIN_ID, HostErrors } from "../shim/errors";
import { currentPluginId, setPolicyRecorder } from "../shim/policy";
import { Vault } from "../shim/vault";
import { Harvest } from "../shim/harvest";
import { NoticeLog } from "../shim/notice";
import { Workspace } from "../shim/workspace";
import { createObsidianApi } from "../shim/api";
import { installGlobals } from "../shim/globals";
import { installPluginHost } from "../shim/plugin";
import { forwardingSink } from "../runtime/forwarding-sink";
import type { ConfirmBroker } from "../shim/file-manager";
import type { RequestSink } from "../client/request-sink";
import type { VaultdClient } from "../client/client";
import type { Clock, HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { ObsidianApi } from "../shim/api";
import type { ApiPolicy, PolicyRecorder, RecordedApiCall } from "../shim/policy";
import type { GlobalInstallation } from "../shim/globals";
import { DryRunGate, forwardingWriteGate } from "../dryrun/dry-run";
import type { WriteGate } from "../dryrun/dry-run";
import { createElectronStub, osSpawn } from "../runtime/electron-stub";
import {
  clearElectronStub,
  clearObsidianApi,
  registerElectronStub,
  registerObsidianApi,
} from "../runtime/electron-registry";
import type { OsSpawn } from "../runtime/electron-stub";

/**
 * Everything one assembled shim consists of.
 *
 * The `clock` is a {@link Clock}, not a `TestClock`: the same function serves
 * production, which passes `systemClock()`. (The phase plan's sketch said
 * `TestClock` in both places, which no production call could satisfy.) A
 * harness that needs to advance time holds its own `TestClock` and passes it in
 * — it is the same object, at a narrower type.
 */
export interface HostAssembly {
  readonly config: HostConfig;
  readonly clock: Clock;
  /**
   * How every shim surface asks the daemon a question — **a forwarding sink,
   * not a connection**.
   *
   * It resolves the current engine's client at every call, so the assembly
   * survives a restart. See `runtime/forwarding-sink.ts` for the defect that
   * made this the type: a captured client left `Vault.cachedRead` talking to a
   * dead socket, and metadata-change events stopped reaching plugins for the
   * life of the process.
   */
  readonly client: RequestSink;
  readonly mirror: Mirror;
  readonly events: ShimEventBus;
  readonly queue: DispatchQueue;
  /**
   * The wedged-thread watchdog, **built and not started**, or `null` when
   * `config.watchdogThresholdMs` is `0` — which is every harness.
   *
   * Starting it is the host lifecycle's call, not the assembler's, for the same
   * reason the coexistence monitor is handed over unstarted: an assembler that
   * spawned a worker thread would spawn one in every harness that merely
   * assembled a host. {@link HostAssembly.teardown} stops it, so nothing that
   * tears an assembly down leaves a thread behind.
   */
  readonly watchdog: Watchdog | null;
  readonly policyRecorder: PolicyRecorder;
  readonly app: App;
  readonly writes: WriteGate;
  readonly harvest: Harvest;
  /**
   * Where a failure nobody is waiting on goes: a plugin's `onunload` throwing,
   * a teardown throwing, a menu hook throwing, a `data.json` that is not JSON.
   * Task 14b's quarantine listens here.
   */
  readonly errors: HostErrors;
  /** The headless config directory this host runs plugins out of. */
  readonly dir: HeadlessConfigDir;
  /**
   * How a plugin asks a human a question, when a client is attached to answer.
   *
   * Built here and handed to two places: the `App`, so a `SuggestModal` several
   * layers down can reach it without every call site passing one, and the
   * `FileManager`, whose `promptForDeletion` is the only shim surface that asks
   * a question of its own. Task 22's `main.ts` hands the same object to
   * `HostServer.attachWiring`, which is what puts the three `host.*interaction`
   * operations on the socket.
   */
  readonly broker: InteractionBroker;
  /**
   * The GUI overlap check, wired to the config re-reads and **not started**.
   *
   * `start()` is the host lifecycle's call (Task 15), not the assembler's: a
   * startup overlap refusal has to reach the caller that is about to load
   * plugins, and an assembler that armed a 60 s timer would also arm one in
   * every harness that never advances its clock far enough to fire it.
   */
  readonly coexistence: CoexistenceMonitor;
  /**
   * The `window`, `document` and prototype extensions this host installed on
   * `globalThis`, and the undo for them.
   *
   * Part of the assembly rather than a side effect nobody holds, because they
   * are process-wide state: a caller that assembles a second host — Task 22's
   * live host beside a harness — has to be able to put the first one's globals
   * back, and a caller that never asks still has the objects the `obsidian`
   * barrel binds `window` and `activeDocument` to.
   */
  readonly globals: GlobalInstallation;
  /**
   * Every notice a plugin raised, in order, **in every mode**.
   *
   * Unconditional rather than gated on dry-run, which is the correction Task
   * 11b carries: `host.invoke_command` takes a `mark()` before dispatch and
   * reports `since(mark)` in its response, so a client sees exactly the notices
   * that command produced whether or not the host is pretending. Task 19's
   * `DryRunGate` reads a window of this log; it owns no second one.
   */
  readonly noticeLog: NoticeLog;
  /**
   * The host's one `global-search` instance.
   *
   * Built beside the {@link InternalPluginRegistry} it is handed to, which
   * gives it to a plugin only while `core-plugins.json` enables it, and exposed
   * here because the server needs the same object: `host.search_state` reads
   * its state and `host.search_opened` relays its answers. One per host, so a
   * search a plugin opens is the one a host client reads.
   */
  readonly globalSearch: GlobalSearchInstance;
  /**
   * The module object a plugin bundle resolves `obsidian` to.
   *
   * Bound minimally in Task 10 — it is that task's tests that first write
   * `class extends api.Plugin` — and filled in by Task 11b's policy-driven
   * walk. It is last in the assembly because it names every surface above it.
   */
  readonly api: ObsidianApi;
  /**
   * Put this process back the way it was found: the module registries the
   * `obsidian` and `electron` packages read through, and every global.
   *
   * One call rather than three, because the three are one fact — "this host is
   * no longer the host of this process" — and a caller that put the globals
   * back while leaving a torn-down assembly registered would hand the next
   * bundle to load a barrel whose surfaces point at a vault that is gone.
   */
  /**
   * Put this process back the way it was found, and **join what has to be
   * joined**.
   *
   * `Promise<void>` rather than `void` because of the watchdog: its `stop()`
   * terminates a worker thread and waits for the thread's `exit`, and a
   * teardown that fired that off and returned would let a caller assert "this
   * host is gone" while a thread of it was still alive. Everything else here is
   * synchronous and stays synchronous.
   */
  teardown(): Promise<void>;
}

/**
 * A `WriteGate` that forwards, which is what the host does when it is not
 * pretending.
 *
 * **Moved to `dryrun/dry-run.ts` by Task 19** and re-exported here, so the two
 * implementations of the one interface are read side by side and every caller
 * that already imports it from this module keeps working.
 */
export { forwardingWriteGate } from "../dryrun/dry-run";

/**
 * The `PolicyRecorder` the host uses when nobody supplies one.
 *
 * `PolicyRecorder` is an interface too, and what it describes is a tally: every
 * time a plugin touches an API surface, record the symbol, the policy that
 * surface declares, and who touched it — then answer how many times. Counting
 * per `(symbol, plugin)` rather than per call is what makes the compatibility
 * report readable: "this plugin reached for `Modal.open` 400 times" is one row,
 * not four hundred.
 *
 * Exported beside {@link assembleShim} because the two are used together and
 * Task 7 owns `shim/policy.ts`; it may relocate this there without changing a
 * caller, since the type is the interface and not this function.
 */
export function memoryPolicyRecorder(options: MemoryRecorderOptions = {}): PolicyRecorder {
  interface Tally {
    symbol: string;
    policy: ApiPolicy;
    pluginId: string | null;
    hits: number;
  }
  // Insertion-ordered, so `entries()` reports surfaces in the order a plugin
  // first reached for them — which reads as a trace of what it tried to do.
  const tallies = new Map<string, Tally>();
  const now = options.clock?.now.bind(options.clock) ?? (() => 0);
  const calls: RecordedApiCall[] = [];
  // The sequence number of `calls[0]`, so a window survives the trim below: a
  // caller marks at 40,000, the log drops the oldest 1,000 while the plugin
  // runs, and `callsSince(40_000)` still answers the right rows rather than
  // rows shifted by whatever fell off the front.
  let firstSeq = 0;
  let nextSeq = 0;
  const recorder: PolicyRecorder = {
    record(symbol: string, policy: ApiPolicy, pluginId: string | null, threw?: string | null): void {
      const key = `${symbol}\0${pluginId ?? ""}`;
      const existing = tallies.get(key);
      if (existing === undefined) tallies.set(key, { symbol, policy, pluginId, hits: 1 });
      else existing.hits += 1;
      if (options.recordCalls !== true) return;
      calls.push({ symbol, pluginId, policy, threw: threw ?? null, atUnixMs: now() });
      nextSeq += 1;
      // **Bounded, oldest first.** A host left running for a week under
      // `--dry-run` would otherwise grow a row per shim call for ever, and the
      // only reader wants the last few hundred of them. The tally is not
      // trimmed: it is one row per `(symbol, plugin)` pair whatever the traffic.
      if (calls.length > CALL_LOG_LIMIT) {
        const dropped = calls.length - CALL_LOG_LIMIT;
        calls.splice(0, dropped);
        firstSeq += dropped;
      }
    },
    entries() {
      return [...tallies.values()].map((tally) => ({ ...tally }));
    },
  };
  if (options.recordCalls === true) {
    recorder.callMark = (): number => nextSeq;
    recorder.callsSince = (mark: number): readonly RecordedApiCall[] =>
      calls.slice(Math.max(mark - firstSeq, 0));
  }
  return recorder;
}

/**
 * How many ordered calls a recorder keeps. See {@link memoryPolicyRecorder}.
 *
 * The log grows per **call**, not per symbol, so the number that matters is
 * traffic and not surface: a plugin's `onload` makes tens of calls, a busy
 * session's event fan-out makes thousands an hour, and the only reader — one
 * harness run's window — wants the last few hundred. 20,000 rows is a few
 * megabytes at worst, leaves a window three orders of magnitude wider than any
 * load needs, and turns an unbounded leak into a bounded ring. A mark survives
 * the trim: see `firstSeq` above.
 */
const CALL_LOG_LIMIT = 20_000;

/**
 * **`recordCalls` is off by default, and that is the flag the brief asks for.**
 *
 * The tally is cheap and every host pays for it; the ordered log is the thing
 * "the ordinary host does not pay for a log nobody reads" is about. The
 * assembly turns it on exactly when `--dry-run` is on, because that is the only
 * mode in which `Detector.runHarness` runs at all (Task 20, ruling 1) and so
 * the only mode with a reader.
 */
export interface MemoryRecorderOptions {
  readonly clock?: Clock;
  readonly recordCalls?: boolean;
}

/**
 * Build the shim, in the one order that works.
 *
 * The electron stub is registered **first**, before anything that could load a
 * plugin bundle: a bundle that resolves `electron` before the stub is in place
 * gets the real module or a throw, and either way the failure surfaces far from
 * its cause.
 *
 * `writes` and `policyRecorder` are **injected rather than constructed**,
 * because both are interfaces: there is no `new WriteGate` and no
 * `new PolicyRecorder` to call. Omitting them gives the ordinary host — a gate
 * that forwards to the daemon and a recorder that tallies in memory. Task 19's
 * `DryRunGate` is what `--dry-run` passes for the first, and a test that wants
 * to read back what a plugin touched passes its own for the second.
 */
export function assembleShim(deps: {
  config: HostConfig;
  /**
   * The engine's client, **as a supplier read per request**.
   *
   * The same signature `Mirror.open` has, and for the same reason: a connection
   * dies with its engine, so anything that captured one would go on asking a
   * socket nobody is listening to after the first restart. The supplier is
   * resolved here, once, into the {@link RequestSink} every module below takes
   * — never handed down, because a module given a supplier can resolve it into
   * a field and a module given a sink cannot.
   */
  client: () => VaultdClient;
  mirror: Mirror;
  clock: Clock;
  /**
   * Where this host may write its own state — `localStorage` today.
   *
   * A parameter rather than `config.dataDir`, because the default config's
   * value is `$XDG_STATE_HOME/vaultd-host`: a harness assembled from it would
   * persist into the developer's home directory, and two test files would share
   * one document. Task 22's `main.ts` passes the real path; every harness
   * passes a fresh directory of its own. Omitting it falls back to the config,
   * which is what a caller that really means the real one is saying.
   */
  dataDir?: string;
  writes?: WriteGate;
  policyRecorder?: PolicyRecorder;
  /**
   * How `electron.shell.openPath` reaches the platform opener.
   *
   * Injected so a test can watch what would have been run without running it.
   * Production takes the default, which really spawns.
   */
  spawn?: OsSpawn;
}): HostAssembly {
  const { config, mirror, clock } = deps;
  const client = forwardingSink(deps.client);
  const dataDir = deps.dataDir ?? config.dataDir;
  // **First**, before anything that could load a plugin bundle: a bundle that
  // resolves `electron` before the stub is in place gets the real module or a
  // throw — and either way the failure surfaces far from its cause. The barrel
  // the `obsidian` package resolves is registered at the very end instead,
  // because it is the last thing built; nothing can load a bundle in between,
  // since only the assembler is running.
  registerElectronStub(
    createElectronStub({ dryRun: config.dryRun, spawn: deps.spawn ?? osSpawn }),
  );

  // Nothing below observes anything but its own arguments during construction,
  // which is what lets a cycle be wired at all: the vault holds the event bus,
  // the bus holds nobody, and every cross-surface read happens later, from a
  // method.
  const events = new ShimEventBus();
  // **`recordCalls` follows `--dry-run`**, which is the honest place for it:
  // `Detector.runHarness` refuses outside dry-run, so outside dry-run the
  // ordered log has no reader and the host should not be keeping one.
  const policyRecorder =
    deps.policyRecorder ?? memoryPolicyRecorder({ clock, recordCalls: config.dryRun });
  // The policy table is module-level — a lookup happens inside a getter on a
  // frozen barrel, far below anything holding the host — so the recorder every
  // `stub`/`unsupported` hit lands in is installed rather than passed.
  setPolicyRecorder(policyRecorder);
  // **Above the queue, because the queue stamps it.** Built rather than
  // started, and `null` unless `config.watchdogThresholdMs` is positive — which
  // every harness sets to zero. The hook is how the two are joined: the
  // watchdog knows what a dispatch queue is, and the queue is not made to know
  // what a watchdog is. See `runtime/watchdog.ts`.
  const watchdog = watchdogFor(config, dataDir);
  const queue =
    watchdog === null
      ? new DispatchQueue()
      : new DispatchQueue({
          afterTask: () => {
            watchdog.stamp();
          },
        });
  // **Above the write gate, because the gate reads a window of it**, and it can
  // be: the log needs nothing but the clock. It is the host's one notice log in
  // every mode — see the `noticeLog` field on {@link HostAssembly} — and a
  // dry run windows it rather than keeping a second one.
  const noticeLog = new NoticeLog({ clock });
  // **The gate the whole of `--dry-run` hangs off.** An injected gate always
  // wins (a test hands its own); otherwise the flag picks between recording and
  // forwarding, and nothing downstream knows which it got, because every writer
  // in this host names the interface and none of them names an implementation.
  const writes =
    deps.writes ??
    (config.dryRun
      ? new DryRunGate(client, config, noticeLog, mirror)
      : forwardingWriteGate(client));
  // The error sink and the harvest are built here, above every surface that
  // writes into them, because the globals need both: a torn `localStorage`
  // document is reported to the first, and a `window` listener nothing can
  // deliver to is recorded in the second. Neither reads anything during
  // construction, so moving them up costs nothing.
  //
  // A menu hook that throws is reported to the same sink a plugin's teardown
  // failures go to. Without the wiring the `Harvest` would catch the throw and
  // hand it nowhere, which is how a quarantine ends up unable to name the
  // plugin whose handler is broken.
  const errors = new HostErrors();
  const harvest = new Harvest({
    onHookError: (failure) => {
      errors.report(failure.error, failure.pluginId, "menu-hook");
    },
  });
  const app = new App({ appId: appIdFor(config.vaultRoot), appVersion: config.appVersion });
  // Straight after the `App` and before anything else, for the same reason the
  // electron stub goes first: a plugin bundle reads `globalThis.app`,
  // `window.moment` and `document` while its *module* is still evaluating —
  // before any instance exists to hand an `App` to — so the globals have to be
  // standing before a bundle can be loaded. The `App`'s own surfaces land a few
  // lines below, and nothing reads them in between: only the assembler is
  // running.
  const globals = installGlobals(app, config, { dataDir, errors, harvest, clock });
  const vault = new Vault({ config, client, mirror, events, writes, queue, errors });
  // After the vault, because it resolves link paths to the `TFile` instances
  // the vault's index owns — and it reads that index rather than holding a
  // copy, so a file the vault renames is the same object this answers with.
  const metadataCache = new MetadataCache({ mirror, events, index: vault.index });
  // Third, because it reads both of the others: the vault's index for the files
  // it moves and the metadata cache's resolver for the links it composes.
  const fileManager = new FileManager({ mirror, vault, metadataCache, writes, queue, errors });
  // How a plugin asks a human. Built before the `App`'s surfaces are installed
  // because two of them need it, and it reads nothing during construction.
  const broker = new InteractionBroker({ config, errors });
  installInteractionBroker(app, broker);
  fileManager.setConfirmBroker(confirmAdapter(broker, queue));
  // (The notice log is built further up, above the write gate that windows it.
  // It is on this host's clock, so a notice's `atUnixMs` is the same time base
  // every other timestamp in this host is measured against.)
  // The workspace needs the harvest at construction — its `on` records menu
  // hooks — and the harvest is built above, with the error sink.
  const workspace = new Workspace({ events, harvest });

  // The assign-once step. `App` is a mutable container precisely so this can
  // happen after every surface exists; a plugin never sees the gap, because no
  // bundle has been loaded yet.
  assignOnce(app, "vault", vault);
  assignOnce(app, "metadataCache", metadataCache);
  assignOnce(app, "fileManager", fileManager);
  assignOnce(app, "workspace", workspace);
  // The cross-plugin registries. `plugins` holds nothing until a loader
  // registers one; `internalPlugins` starts its first config read in its
  // constructor, so `app.internalPlugins.ready()` is what a caller awaits
  // before the first synchronous `getPluginById`; `commands` seeds
  // `editor:save-file` and is the map `Plugin.addCommand` delegates into.
  assignOnce(app, "plugins", new PluginRegistry());
  const globalSearch = new GlobalSearchInstance({ client });
  const internalPlugins = new InternalPluginRegistry({ client, mirror, config, globalSearch });
  assignOnce(app, "internalPlugins", internalPlugins);
  assignOnce(
    app,
    "commands",
    new CommandRegistry({ queue, client, mirror, writes, workspace, errors, app }),
  );
  // The store behind `app.loadLocalStorage`, which is the same one the bare
  // `localStorage` global is backed by — one store, two addresses.
  assignOnce(app, "localStorageStore", globals.localStorage);

  // Everything a `Plugin` needs that its two constructor arguments cannot
  // carry. Installed against the `App`, keyed by it, so two hosts in one
  // process never read each other's wiring — see `shim/plugin.ts`.
  installPluginHost(app, { config, client, writes, harvest, events, queue, clock, errors });

  // The headless config directory and the GUI overlap check, and the one piece
  // of wiring that makes the poll worth having.
  //
  // **Ruling W7 is the whole reason this is here.** The daemon announces a raw
  // write into `.obsidian/` that *it* performed; a GUI Obsidian editing those
  // files is not watched and raises nothing. So there is no event for "the user
  // changed a setting in the GUI", and the only mechanism left is to look —
  // once a minute, on this host's clock. Hanging the two config re-reads off
  // that one tick is what keeps it to one timer for one class of problem.
  //
  // `Vault.reprimeConfig` rather than `configReady`: the latter returns
  // immediately once the cache is warm, so on a poll it would re-read nothing,
  // ever. `InternalPluginRegistry.refresh()` with no argument re-reads all
  // three of its files, which is right here — the poll is told nothing about
  // what changed, because nothing told it anything changed.
  // The same gate every other writer holds: a plugin-config write is a write,
  // and `--dry-run` has to intercept it for the same reason it intercepts a
  // vault write. Reads stay on the client.
  const dir = new HeadlessConfigDir(client, config, errors, writes);
  const coexistence = new CoexistenceMonitor(dir, client, config, errors);
  coexistence.onPoll(async () => {
    await internalPlugins.refresh();
    await vault.reprimeConfig();
  });

  const assembled = {
    config,
    clock,
    client,
    mirror,
    events,
    queue,
    watchdog,
    policyRecorder,
    app,
    writes,
    harvest,
    errors,
    dir,
    broker,
    coexistence,
    globals,
    noticeLog,
    globalSearch,
  };
  // Last, and built from the assembly itself: the barrel binds this host's
  // clock into the timer functions a plugin calls, so a test advancing its own
  // clock sees its own plugin's intervals fire.
  const api = createObsidianApi(assembled);
  // And registered immediately, because this is the object the workspace's
  // `obsidian` package forwards every property read to. A bundle resolving the
  // specifier before this line would find nothing registered and be told so by
  // name; after it, it finds this host.
  registerObsidianApi(api);
  return {
    ...assembled,
    api,
    async teardown(): Promise<void> {
      // Before the registries, because a poll that fired after the globals were
      // restored would read a vault this host no longer owns. Idempotent, and a
      // no-op when nothing ever started it.
      coexistence.stop();
      // **Awaited, and it is why this method is async.** `stop()` clears the
      // heartbeat synchronously and then waits for the worker thread's `exit`.
      // Firing it off would swallow a rejection as well as the wait, and would
      // let a caller believe a torn-down host has no threads left while one of
      // its threads was still running.
      await watchdog?.stop();
      // The refusal sink is module-level, like the policy recorder, so a host
      // that went away while still installed would go on collecting the next
      // host's refusals into a report nobody is reading. Only the gate this
      // assembly built takes itself out; an injected one belongs to whoever
      // injected it.
      if (writes instanceof DryRunGate && deps.writes === undefined) writes.uninstall();
      clearObsidianApi();
      clearElectronStub();
      globals.restore();
    },
  };
}

/**
 * `FileManager.promptForDeletion`'s question, as an interaction prompt.
 *
 * **The one caller that deliberately swallows the typed failure.** Every other
 * consumer of the broker lets `InteractionUnavailable` reach the plugin,
 * because "nobody could be asked" is not an answer to "which of these did you
 * pick". For a confirmation it is: nobody was asked, so nothing was confirmed,
 * and `false` is exactly what the caller's own `if (confirmed)` branch should
 * see. `promptForDeletion` never deletes silently and never throws, which is
 * what keeps folder-notes' delete path a no-op rather than a crash.
 *
 * **The compatibility report now reads `implemented` where it used to read
 * `safe_stub`**, and that is the truer reading rather than a loss. Before Task
 * 18 a host with no broker installed took `promptForDeletion`'s unattended
 * branch, which recorded a stub hit; now the surface is really reached and
 * really asks, and whether a human was there is a fact about the session rather
 * than about the plugin's compatibility. (The recorder tallies one policy per
 * symbol-and-plugin pair, so a second reading for the same call could not have
 * been recorded alongside the first in any case.)
 *
 * **Attribution is the ambient plugin id, like every other prompt path.** It
 * used to prefer `queue.inFlight()?.pluginId`, on the argument that a
 * `promptForDeletion` is `async` all the way down and the synchronous window
 * may have closed by the time the confirm is raised. That argument is still
 * true and the preference was still wrong, because the queue names the *entry
 * point* — the plugin whose slot is open — and since Task 20's fix to
 * `ShimEventBus.tryTrigger` a handler runs inside the entry point of whoever
 * *raised* the event. So a bystander's `promptForDeletion`, fired from a
 * handler during another plugin's load, was attributed to that other plugin,
 * while a modal raised on the same line was attributed to the bystander: two
 * prompt paths disagreeing about who is asking, inside one handler turn.
 * `components.ts`'s `open()` reads `currentPluginId()`, so this does too.
 *
 * The residual the old comment named is real and is the honest cost: a confirm
 * raised after an `await` is outside every attribution window and falls back to
 * {@link HOST_PLUGIN_ID}. Naming the host is at least true; naming whichever
 * plugin's slot happened to be open is not.
 */
function confirmAdapter(broker: InteractionBroker, queue: DispatchQueue): ConfirmBroker {
  return {
    async confirm(request): Promise<boolean> {
      const pluginId = currentPluginId() ?? queue.inFlight()?.pluginId ?? HOST_PLUGIN_ID;
      try {
        const answer = await broker.ask({
          pluginId,
          kind: "confirm",
          prompt: request.message,
          // Pinned, and in this order: `choice_index` 0 is yes and anything
          // else — including a cancel — is no, so a client that answers with an
          // index it did not think about answers "no".
          items: CONFIRM_ITEMS,
        });
        return answer.cancelled !== true && answer.choiceIndex === 0;
      } catch (error) {
        // `InteractionUnavailable` — nobody was asked — is the deliberate
        // swallow. A timeout is swallowed the same way and for the same
        // reason: somebody was asked and did not answer, which is still not a
        // confirmation, and this surface's contract is `Promise<boolean>` — a
        // rejection would crash a delete path that has a perfectly good answer
        // available. Anything else is a bug in this host and is not hidden.
        if (error instanceof InteractionUnavailable) return false;
        if (error instanceof InteractionTimeout) return false;
        throw error;
      }
    },
  };
}

/** What a confirm prompt offers, in the order the answer mapping reads them. */
const CONFIRM_ITEMS: readonly string[] = ["confirm", "cancel"];

/**
 * Obsidian's `app.appId`: sixteen hex characters, stable for a vault root.
 *
 * Derived rather than random because a plugin that keys per-vault storage by it
 * would find its data orphaned on every host restart otherwise.
 */
function appIdFor(vaultRoot: string): string {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let i = 0; i < vaultRoot.length; i += 1) {
    high = Math.imul(high ^ vaultRoot.charCodeAt(i), 0x01000193) >>> 0;
    low = Math.imul(low + vaultRoot.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

/**
 * Fill one container field, and refuse to fill it twice.
 *
 * The refusal is the point: "assigned once by `assembleShim`" is a claim the
 * whole mutable-container design rests on, and a second assembler run against a
 * live `App` — two hosts in one process, a harness that forgot to stop — would
 * otherwise leave plugins holding surfaces belonging to a vault that is no
 * longer there.
 */
function assignOnce<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  if (target[key] !== undefined) {
    throw new Error(`the shim's ${String(key)} was already assembled`);
  }
  target[key] = value;
}
