/**
 * **The host, built once.** One function that brings a whole `vaultd` host up
 * over a `HostConfig`, and one that takes it down in order.
 *
 * It exists because there were two copies of this wiring and only one of them
 * could ship. `main.ts` had the production order and nothing exercised it —
 * four separate mutations of it (the watchdog never started,
 * `allowNodeBuiltins` forced true, the user-script globals never provisioned,
 * the shutdown order reversed) all survived the whole suite, because the only
 * copy under test was `src/testing/live-host.ts`'s. Now there is one copy,
 * `live-host.ts` drives it, and every golden is a test of the code the binary
 * runs.
 *
 * **The order is the content of this file**, and each step is where it is for a
 * reason the code says at the call site: the electron stub and the module
 * interception before anything can compile a bundle; the detector after the
 * sequencer, over the assembly's own gate and recorder; the watchdog started
 * after the sequencer, because nothing else starts it.
 *
 * **Shutdown is ordered, and that is a correctness property rather than
 * tidiness.** The globals this host installs are process-wide, and a plugin's
 * in-flight work reads them: a retry loop parked on `window.setTimeout` wakes
 * to find no `window` if the globals go first, throws onto a promise nobody
 * holds, and Node kills the process — measured as the binary exiting 1 on
 * `SIGTERM` whenever a plugin was busy. So: unload the plugins, drain the
 * dispatch queue, stop the mirror, and only then take the globals down.
 */

import { resolve } from "node:path";

import { BundleLoader, provisionUserScriptGlobals } from "./runtime/loader";
import { DataDir } from "./datadir";
import { Detector } from "./detector/harness";
import { DEFAULT_KEY_REGISTRY, PluginConfigService } from "./settings/plugin-config";
import { HostServer } from "./server/server";
import { LifecycleSequencer, bundlePluginLoader } from "./runtime/lifecycle";
import { Mirror } from "./mirror/mirror";
import { QuarantineTracker } from "./runtime/quarantine";
import { SchemaLadder } from "./settings/ladder";
import { Supervisor } from "./supervisor";
import { assembleShim } from "./testing/assemble";
import { installModuleInterception } from "./runtime/intercept";
import type { HostAssembly } from "./testing/assemble";
import type { HostConfig } from "./config";
import type { OverlapReport } from "./pluginset/coexistence";
import type { StartupReport } from "./runtime/lifecycle";
import type { VaultdClient } from "./client/client";

/** A started host, and the one call that takes it down. */
export interface RunningHost {
  readonly config: HostConfig;
  readonly supervisor: Supervisor;
  readonly mirror: Mirror;
  readonly assembly: HostAssembly;
  readonly lifecycle: LifecycleSequencer;
  readonly quarantine: QuarantineTracker;
  readonly pluginConfig: PluginConfigService;
  readonly detector: Detector;
  readonly server: HostServer;
  /** Where the control socket is bound. */
  readonly socketPath: string;
  /** What `lifecycle.start()` reported. */
  readonly startup: StartupReport;
  /**
   * The GUI overlap reading taken at startup, **typed**.
   *
   * Kept because the binary's exit code depends on it: a host where the GUI
   * had every enabled plugin open has nothing to run, and the only honest way
   * to know that is the report the coexistence monitor produced — never a
   * substring match on a failure message, which would fire for any plugin
   * whose display name happens to contain "Obsidian".
   */
  readonly overlap: OverlapReport;
  /** True once {@link stop} has run. */
  stopped(): boolean;
  stop(): Promise<void>;
}

export interface StartHostOptions {
  /**
   * Bind the control socket. Default `true`.
   *
   * A caller that only wants the host — a harness measuring startup, a probe —
   * can leave the socket unbound; everything else is built either way, because
   * the server subscribes to the mirror and the sequencer the moment it exists.
   */
  readonly listen?: boolean;
  /**
   * How long the shutdown waits for the dispatch queue to drain, in ms of the
   * config's clock. Default 5 000.
   *
   * Bounded because a plugin can keep the queue busy for ever; the wait is an
   * attempt to be orderly, not a promise to be blocked by a broken plugin.
   */
  readonly drainBudgetMs?: number;
}

/**
 * The engine could not be started or never reached `watching`.
 *
 * Typed so the binary can answer its documented exit code without reading
 * anything's message.
 */
export class DaemonUnreachable extends Error {
  constructor(cause: unknown) {
    super(`the daemon did not come up: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DaemonUnreachable";
  }
}

/** Build and start a host over `config`, in the one order that works. */
export async function startHost(
  config: HostConfig,
  options: StartHostOptions = {},
): Promise<RunningHost> {
  new DataDir(config.dataDir).ensureSecureDir(".");

  const supervisor = new Supervisor(config, {
    onClientReady: () => {},
    onEngineLost: () => {},
    onStateChange: () => {},
  });
  try {
    await supervisor.start();
    await supervisor.whenWatching();
  } catch (error) {
    await supervisor.stop();
    throw new DaemonUnreachable(error);
  }

  const clientOf = (): VaultdClient => supervisor.client();
  const mirror = await Mirror.open(clientOf, config);
  await supervisor.subscribe((event) => {
    void mirror.applyEvent(event).catch(() => undefined);
  });

  // **No `writes` and no `policyRecorder` are passed.** The assembly builds the
  // `DryRunGate` from `config.dryRun` and turns `recordCalls` on in the same
  // breath; handing either in from here is how the two come apart.
  const assembly = assembleShim({ config, client: clientOf, mirror, clock: config.clock });
  // **Before anything can compile a bundle.** `allowNodeBuiltins` follows the
  // mode: a shipped dry run has to refuse the file-system modules, process
  // spawning and the network to a plugin that requires one by name (the
  // specifiers are not spelled out here, because `test/fs-seam.test.ts` bans
  // them under `src/` and a grep cannot tell a quoted example from a call), and
  // an ordinary run must not.
  const interception = installModuleInterception({
    hostModulePaths: hostModulePaths(),
    allowNodeBuiltins: !config.dryRun,
    harvest: assembly.harvest,
  });
  // **Task 13's provisioning, which nothing in production did before Task 22.**
  // A QuickAdd user script is loaded with
  // `new Function("require", "module", "exports", src)` and handed a one-line
  // shim that forwards to `window.require`, so that global being a real
  // function bound to this host's resolver is the whole of the feature.
  // Measured, not supposed: the golden macro case failed with
  // `window.require is not available headless (node:crypto)` until this call
  // existed. The resolver is this module's own, so it goes through the patched
  // module loader above and a dry run still refuses what a dry run refuses.
  const userScripts = provisionUserScriptGlobals(require);

  const loader = new BundleLoader({
    app: assembly.app,
    queue: assembly.queue,
    events: assembly.events,
    harvest: assembly.harvest,
    errors: assembly.errors,
  });
  assembly.app.plugins.setLoader(loader);

  // The tracker's callback reaches back into the sequencer and the sequencer
  // takes the tracker as a dependency, so one of the two has to be named before
  // it exists. The arrow defers that read to the moment a plugin is actually
  // quarantined, by which time both are built.
  let sequencer: LifecycleSequencer | null = null;
  const quarantine = new QuarantineTracker(config, (id, failures) =>
    sequencer === null ? Promise.resolve() : sequencer.onQuarantine(id, failures),
  );
  sequencer = new LifecycleSequencer({
    supervisor,
    mirror,
    app: assembly.app,
    harvest: assembly.harvest,
    events: assembly.events,
    errors: assembly.errors,
    dir: assembly.dir,
    coexistence: assembly.coexistence,
    quarantine,
    queue: assembly.queue,
    config,
    plugins: bundlePluginLoader({
      dir: assembly.dir,
      loader,
      config,
      hostModulePaths: hostModulePaths(),
    }),
  });
  const lifecycle = sequencer;

  // **After the sequencer, because the detector drives one**, and over the
  // assembly's own objects. The three traps, all from Task 20b's report: the
  // detector's `writes` must be the assembly's `DryRunGate` (`inDryRun()` is an
  // `instanceof` check); its recorder must be the one built with `recordCalls`
  // on, or the harness reports `runs` on an empty call log; and one
  // `PluginConfigService` is shared by the detector and the socket, because the
  // cache and the key registry are what the two must agree about.
  const pluginConfig = new PluginConfigService(
    assembly.dir,
    new SchemaLadder(config.dataDir, config.clock),
    DEFAULT_KEY_REGISTRY,
    config,
    { plugins: assembly.app.plugins, queue: assembly.queue, errors: assembly.errors },
  );
  const detector = new Detector({
    config,
    clock: config.clock,
    dir: assembly.dir,
    lifecycle,
    harvest: assembly.harvest,
    recorder: assembly.policyRecorder,
    writes: assembly.writes,
    quarantine,
    pluginConfig,
  });

  const server = new HostServer({
    config,
    lifecycle,
    harvest: assembly.harvest,
    mirror,
    client: assembly.client,
    writes: assembly.writes,
    quarantine,
    coexistence: assembly.coexistence,
    noticeLog: assembly.noticeLog,
    app: assembly.app,
    dir: assembly.dir,
    queue: assembly.queue,
    errors: assembly.errors,
    policyRecorder: assembly.policyRecorder,
    liveState: () => supervisor.liveState(),
  });
  server.attachWiring({ broker: assembly.broker, pluginConfig, detector });

  const startup = await lifecycle.start();
  // **After the sequencer starts, and nothing else starts it** — Task 21's
  // concern 1. The assembly builds it when `config.watchdogThresholdMs` is
  // positive and leaves it stopped, because an assembler that spawned a thread
  // would spawn one in every harness that merely assembled a host.
  assembly.watchdog?.start();
  const socketPath = options.listen === false ? config.socketPath : await server.listen();
  // The reading `lifecycle.start()` filtered on, taken after the start so it is
  // the one the startup actually used.
  const overlap = assembly.coexistence.latest() ?? (await assembly.coexistence.check());

  let stopped = false;
  const drainBudgetMs = options.drainBudgetMs ?? 5_000;

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    // 1. The plugins go first. `lifecycle.stop()` unloads each one — its
    //    `onunload`, its component teardown, its registered timers and its
    //    harvest — and stops the engine with them.
    await lifecycle.stop();
    // 2. Then the queue drains, bounded. A handler still inside its dispatch
    //    slot is a plugin running against globals this teardown is about to
    //    remove. `idle()` is the drain; the budget is because a plugin can
    //    keep the queue busy for ever and an orderly shutdown must still end.
    await withBudget(assembly.queue.idle(), drainBudgetMs);
    // 3. The socket stops answering. After the plugins, so a client's last call
    //    is answered by a host that still has the plugin it names.
    await server.close();
    // 4. The mirror stops applying: anything queued behind this point would
    //    reach for an engine the teardown has stopped.
    mirror.stop();
    // 5. The watchdog, awaited — it terminates a worker thread and joins it.
    await assembly.watchdog?.stop();
    // 6. And only now the process-wide state: the user-script globals, the
    //    module interception, and the assembly's own globals (whose `restore`
    //    disarms every timer this host's `window` handed out, so nothing can
    //    wake into a host that is gone).
    userScripts.restore();
    interception.restore();
    await assembly.teardown();
    // 7. Last, the engine itself. `lifecycle.stop()` has already asked it to
    //    go; this is the join, and it is idempotent.
    await supervisor.stop();
  }

  return {
    config,
    supervisor,
    mirror,
    assembly,
    lifecycle,
    quarantine,
    pluginConfig,
    detector,
    server,
    socketPath,
    startup,
    overlap,
    stopped: () => stopped,
    stop,
  };
}

/**
 * Wait for `pending`, but never longer than `budgetMs`.
 *
 * A resolved race rather than a rejected one: a drain that did not finish is
 * not a failure, it is a plugin that is still busy, and the shutdown carries on
 * regardless. The timer is `unref`ed so it can never be the reason a process
 * stays alive.
 */
function withBudget(pending: Promise<void>, budgetMs: number): Promise<void> {
  return new Promise<void>((settle) => {
    const timer = setTimeout(settle, budgetMs);
    timer.unref();
    void pending.then(
      () => {
        clearTimeout(timer);
        settle();
      },
      () => {
        clearTimeout(timer);
        settle();
      },
    );
  });
}

/**
 * `host/node_modules`, where the workspace links `obsidian` and `electron`.
 *
 * Derived from this module's own location rather than from `process.cwd()`: a
 * binary is run from wherever the operator happens to be standing, and the two
 * packages sit beside the compiled host. From `dist/host.js` that is three
 * levels up (`packages/host/dist` → `packages/host` → `packages` → `host`);
 * the same arithmetic holds from `src/host.ts`.
 */
export function hostModulePaths(): readonly string[] {
  return [resolve(__dirname, "..", "..", "..", "node_modules")];
}
