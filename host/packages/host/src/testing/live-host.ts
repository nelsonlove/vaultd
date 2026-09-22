/**
 * A **real** `vaultd` child and a **real** host over a real vault on disk: the
 * harness Task 22 drives.
 *
 * Everything else in the harness family fakes the daemon, and that is right for
 * a test about the host's own behaviour: a fake answers instantly, in an order
 * the test chose, and never flakes. This one fakes nothing, and that is right
 * for the last task's question, which is not "does the host behave" but "do the
 * two halves actually fit". The two kinds of test are complementary and neither
 * substitutes for the other.
 *
 * It writes only inside the vault root it is given — a scratch directory under
 * the repository's own `target/tmp`, never the developer's vault — plus the
 * host's own data directory, which is redirected into that same root so a live
 * test can never touch the developer's real `$XDG_STATE_HOME`.
 *
 * **Reconciled against the code, Task 22 Step 1.** The scaffold this file grew
 * from was written in Task 6b against interface sketches and every constructor
 * it named has moved since. What changed, and why each change was forced:
 *
 * - **It assembled a shim and never built a lifecycle**, so no plugin would
 *   ever have loaded. `bindHost` in {@link HostHarness} is the current pattern
 *   and this file follows it: quarantine and sequencer first (each names the
 *   other, so the arrow defers one read), then the config service, then the
 *   detector over the *same* gate, recorder and service, then `attachWiring`.
 * - **`server.start({ wireLateOps: true })` does not exist.** `listen()` binds
 *   the socket and `attachWiring` is how the late services arrive.
 * - **`spawn`ing the engine by hand is not how a host runs one.** A
 *   {@link Supervisor} is, and it is also what `LifecycleSequencer.stop()`
 *   stops — a hand-spawned child would have been left for the test to kill.
 * - **`Mirror.settled()` never existed.** The rendezvous here is the real one:
 *   ask the daemon what generation it is on, wait for the mirror to have
 *   applied through it, then let the sequencer's delivery chain drain. No
 *   sleeps, which is the property the scaffold's note asked for.
 * - **`PolicyRecorder.unsupportedHits()` never existed either.** The tally is
 *   `entries()`, and an unsupported surface is the `absent` policy — see
 *   {@link LiveHost.unsupportedHits}.
 * - **`startWithGoldenPlugin` installed the plugin from the vault root**, which
 *   holds the test's notes and no bundle. It installs from the golden fixture's
 *   `plugin/` directory.
 * - **Module interception is installed here**, because a live host is the first
 *   thing in this repository that loads a community bundle for real: the
 *   `@codemirror/*` specifiers have no package behind them, and under a dry run
 *   the node-builtin refusals have to be armed. Production's `main.ts` installs
 *   it the same way and with the same `allowNodeBuiltins: !config.dryRun`.
 */

import { join, resolve } from "node:path";

import { BundleLoader, provisionUserScriptGlobals } from "../runtime/loader";
import { Detector } from "../detector/harness";
import { DEFAULT_KEY_REGISTRY, PluginConfigService } from "../settings/plugin-config";
import { HostServer } from "../server/server";
import { HostTestClient } from "./host-harness";
import { LifecycleSequencer, bundlePluginLoader } from "../runtime/lifecycle";
import { Mirror } from "../mirror/mirror";
import { QuarantineTracker } from "../runtime/quarantine";
import { SchemaLadder } from "../settings/ladder";
import { Supervisor } from "../supervisor";
import { assembleShim } from "./assemble";
import { defaultHostConfig, systemClock } from "../config";
import { fs } from "../runtime/fs-access";
import { installModuleInterception } from "../runtime/intercept";
import { workspaceRoot } from "./fixture-vault";
import type { HostAssembly } from "./assemble";
import type { HostConfig } from "../config";
import type { Interception } from "../runtime/intercept";
import type { App } from "../shim/app";
import type { GetVaultInfoResponse } from "../client/protocol";
import type { Harvest } from "../shim/harvest";
import type { PolicyRecorder } from "../shim/policy";
import type { StartupReport } from "../runtime/lifecycle";
import type { VaultdClient } from "../client/client";

export interface LiveHostSpec {
  vaultRoot: string;
  installPlugin?: { id: string; from: string };
  data?: Record<string, unknown>;
  config?: Partial<HostConfig>;
  /**
   * Files to write into the vault before the engine starts, vault-relative.
   *
   * Before, not after, because a note created while the daemon is watching is a
   * change event and a note that was there when it started is not — and a test
   * that means "a vault with these notes in it" should not have to wait for the
   * second one to arrive.
   */
  files?: Record<string, string>;
  /** Removed by {@link LiveHost.stop}. See {@link LiveHost.startWithGoldenPlugin}. */
  removeRootOnStop?: boolean;
}

/** Where the golden fixtures live: `host/fixtures/golden`. */
export function goldenRoot(): string {
  return join(workspaceRoot(), "host", "fixtures", "golden");
}

/** One golden's `scenario.json`, as data. See `host/fixtures/golden/README.md`. */
export interface GoldenScenario {
  readonly obsidianVersion: string;
  readonly pluginVersion: string;
  readonly settings: Record<string, unknown>;
  readonly action: { readonly op: string; readonly params: Record<string, unknown> };
  readonly humanAction: string;
  readonly notes: string;
}

export function goldenScenario(id: string): GoldenScenario {
  return JSON.parse(
    fs.readFileSync(join(goldenRoot(), id, "scenario.json"), "utf8"),
  ) as GoldenScenario;
}

/** The plugin's `data.json` at capture time. */
function goldenSettings(id: string): Record<string, unknown> {
  return goldenScenario(id).settings;
}

export class LiveHost {
  private stopped = false;

  private constructor(
    private readonly supervisor: Supervisor,
    private readonly mirror: Mirror,
    private readonly server: HostServer,
    private readonly assembly: HostAssembly,
    private readonly quarantineTracker: QuarantineTracker,
    private readonly sequencer: LifecycleSequencer,
    private readonly interception: Interception,
    private readonly userScripts: { restore(): void },
    private readonly client: HostTestClient,
    private readonly root: string,
    private readonly dataDirPath: string,
    private readonly removeRootOnStop: boolean,
    /** What `lifecycle.start()` reported: which plugins loaded, and which did not. */
    readonly startup: StartupReport,
  ) {}

  /**
   * Put the vault, the bundle and the settings on disk, and answer the config
   * the host will run on. **Nothing is started.**
   *
   * Separate from {@link start} because of the write guard. A golden case
   * installs `installFsWriteGuard(vaultRoot)` and then asserts the host wrote
   * no vault byte directly — and staging a fixture *is* a direct write, by the
   * test rather than by the host. Staging first and arming the guard second is
   * what keeps the guard's claim about the subject rather than about the
   * scaffolding.
   */
  static stage(spec: LiveHostSpec): HostConfig {
    // **The state directory is outside the vault**, and short. Outside because
    // the fs write guard watches the vault root and the host's own state is not
    // vault content — a guard that counted the host writing its own nonce would
    // report a violation for the thing the design explicitly permits. Short
    // because a Unix socket address is capped at about 104 bytes on Darwin, and
    // a scratch vault path plus a nested directory is already past it: the
    // failure is an `EINVAL` from `listen` that names no limit.
    const dataDir = scratchVault("hs-");
    const config: HostConfig = {
      ...defaultHostConfig(spec.vaultRoot),
      dataDir,
      socketPath: join(dataDir, "s"),
      vaultdBinary: liveBinary(),
      clock: systemClock(),
      // A live case loads real community bundles. None of them may reach the
      // network, whatever their `onload` tries — the same rule every harness in
      // this suite holds, and for the same reason.
      allowNetwork: false,
      // No watchdog thread per live host: the component has its own file, and a
      // golden case is not about it.
      watchdogThresholdMs: 0,
      ...spec.config,
    };
    // **`0700`, and chmod after the create**: the host refuses to bind a socket
    // in a directory another user could reach, and `mkdir`'s mode argument is
    // masked by the process umask.
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(config.dataDir, 0o700);

    for (const [path, contents] of Object.entries(spec.files ?? {})) {
      writeUnder(config.vaultRoot, path, contents);
    }
    if (spec.installPlugin !== undefined) {
      installPlugin(config, spec.installPlugin.id, spec.installPlugin.from);
      enableOnly(config, [spec.installPlugin.id]);
    }
    if (spec.data !== undefined && spec.installPlugin !== undefined) {
      // **Inside the vault, not in the host's state directory.** Task 10 settled
      // that a plugin's settings live at
      // `<vault>/<configDir>/plugins/<id>/data.json` and that `Plugin.loadData`
      // reads exactly that path through the daemon; this file seeded
      // `config.dataDir/plugins/<id>/` — the XDG state directory — where no
      // plugin could ever find it. Corrected by Task 15's fix round, which hit
      // the same defect in `host-harness.ts`.
      const dir = join(config.vaultRoot, config.configDirName, "plugins", spec.installPlugin.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, "data.json"), JSON.stringify(spec.data), "utf8");
    }
    return config;
  }

  static start(spec: LiveHostSpec): Promise<LiveHost> {
    return LiveHost.startOn(LiveHost.stage(spec), spec.removeRootOnStop ?? false);
  }

  /** Run a host over a config {@link stage} already put on disk. */
  static async startOn(config: HostConfig, removeRootOnStop = false): Promise<LiveHost> {
    const dataDir = config.dataDir;
    const supervisor = new Supervisor(config, {
      onClientReady: () => {},
      onEngineLost: () => {},
      onStateChange: () => {},
    });
    await supervisor.start();
    await supervisor.whenWatching();
    const clientOf = (): VaultdClient => supervisor.client();
    const mirror = await Mirror.open(clientOf, config);
    await supervisor.subscribe((event) => {
      void mirror.applyEvent(event).catch(() => undefined);
    });

    const assembly = assembleShim({ config, client: clientOf, mirror, clock: config.clock, dataDir });
    // **Before any bundle is compiled**, which is the only placement that
    // works: a bundle that resolved `@codemirror/view` first would take Node's
    // answer (there is no such package) rather than the host's stub.
    const interception = installModuleInterception({
      hostModulePaths: hostModulePaths(),
      allowNodeBuiltins: !config.dryRun,
      harvest: assembly.harvest,
    });
    // **After the globals exist and before any plugin runs.** Task 13's
    // provisioning: `window.require` is the whole of what a QuickAdd user
    // script needs from this host, because its loader is
    // `new Function("require", "module", "exports", src)` called with a shim
    // that forwards to it. Without this the shim's Task 11a refusal stands and
    // every user script in the corpus fails with
    // `window.require is not available headless`. It goes through this host's
    // own resolver, which means through the patched `Module._load` above — so
    // a dry run still refuses a script the file system.
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
    // takes the tracker as a dependency, so one of the two has to be named
    // before it exists. The arrow defers that read to the moment a plugin is
    // actually quarantined, by which time both are built.
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

    // **After the sequencer, because the detector drives one**, and over the
    // assembly's own objects: the same `DryRunGate` (`inDryRun()` is an
    // `instanceof` check), the same `PolicyRecorder` (the assembly turns
    // `recordCalls` on under `--dry-run`; an injected one without it yields an
    // empty call log and a `runs` verdict on no evidence), and one
    // `PluginConfigService` shared by the detector and the socket.
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
      lifecycle: sequencer,
      harvest: assembly.harvest,
      recorder: assembly.policyRecorder,
      writes: assembly.writes,
      quarantine,
      pluginConfig,
    });
    const server = new HostServer({
      config,
      lifecycle: sequencer,
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

    const startup = await sequencer.start();
    const socketPath = await server.listen();
    const client = await HostTestClient.open(socketPath);
    client.rememberHello(await client.call("host.hello", { nonce: readNonce(config) }));

    return new LiveHost(
      supervisor,
      mirror,
      server,
      assembly,
      quarantine,
      sequencer,
      interception,
      userScripts,
      client,
      config.vaultRoot,
      dataDir,
      removeRootOnStop,
      startup,
    );
  }

  /**
   * A live host with one **golden** plugin installed, over a scratch vault this
   * method makes and {@link stop} removes.
   *
   * The golden plugins are small on purpose: a compatibility claim proved by a
   * plugin this repository wrote is weaker than one proved by a plugin it did
   * not, so these exist to prove the *mechanism* and the real-plugin corpus
   * proves the claim.
   */
  static startWithGoldenPlugin(
    id: string,
    files: Record<string, string>,
    spec: Omit<LiveHostSpec, "vaultRoot" | "installPlugin" | "files"> = {},
  ): Promise<LiveHost> {
    const root = scratchVault(`live-${id}-`);
    return LiveHost.start({
      // **The settings come from the fixture's `scenario.json` unless the
      // caller names its own.** They are the plugin's `data.json` at capture
      // time, and for a plugin whose commands are declared by its settings —
      // QuickAdd registers one command per configured choice — a host that
      // started it with an empty `data.json` would find no commands to invoke
      // and the case would be asserting on a plugin that is not configured.
      data: goldenSettings(id),
      ...spec,
      vaultRoot: root,
      installPlugin: { id, from: join(goldenRoot(), id, "plugin") },
      files,
      removeRootOnStop: true,
    });
  }

  /** Everything a request over the host's own socket answers. */
  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.client.call<T>(method, params);
  }

  /**
   * Resolve when the vault has stopped moving and every plugin has been told.
   *
   * Three rendezvous and no sleeps: the daemon says what generation it is on,
   * the mirror is waited on until it has applied through that generation, and
   * the sequencer's delivery chain is drained — because "the mirror applied a
   * change" and "the plugins have been told about it" are different moments.
   * The server is quiesced last so an event a case is about to read has been
   * flushed to the socket.
   */
  async quiesce(): Promise<void> {
    const info = await this.supervisor.client().request<GetVaultInfoResponse>("get_vault_info");
    await waitFor(
      `the mirror to apply through generation ${String(info.generation)}`,
      () => this.mirror.appliedThrough() >= info.generation && !this.mirror.resyncing(),
      () =>
        `the mirror is at generation ${String(this.mirror.generation())}, applied through ` +
        `${String(this.mirror.appliedThrough())}, resyncing=${String(this.mirror.resyncing())}`,
    );
    await this.sequencer.settled();
    await this.server.quiesce();
  }

  app(): App {
    return this.assembly.app;
  }

  harvest(): Harvest {
    return this.assembly.harvest;
  }

  quarantine(): QuarantineTracker {
    return this.quarantineTracker;
  }

  lifecycle(): LifecycleSequencer {
    return this.sequencer;
  }

  recorder(): PolicyRecorder {
    return this.assembly.policyRecorder;
  }

  /** The vault this host is running over. */
  vaultRoot(): string {
    return this.root;
  }

  /**
   * Every unsupported-API symbol a plugin touched, with who touched it.
   *
   * **`absent` is the policy an unsupported surface carries** — there is no
   * fourth value called "unsupported". `HeadlessUnsupported` is thrown by the
   * `absent` branch of the policy walk and the recorder tallies the symbol with
   * that policy, so this filter is the whole of the question. One row per
   * `(symbol, plugin)` pair, which is what makes a failure readable.
   */
  unsupportedHits(): readonly { symbol: string; pluginId: string | null }[] {
    return this.assembly.policyRecorder
      .entries()
      .filter((entry) => entry.policy === "absent")
      .map((entry) => ({ symbol: entry.symbol, pluginId: entry.pluginId }));
  }

  /**
   * Stop everything this host started, in the order that leaves nothing behind.
   *
   * Idempotent, because a case that stops in its own body and again in a
   * `finally` is the ordinary shape rather than a mistake.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.client.disconnect();
    await this.server.close();
    // The sequencer unloads every plugin and stops the supervisor with them.
    await this.sequencer.stop();
    await this.supervisor.stop();
    this.userScripts.restore();
    this.interception.restore();
    await this.assembly.teardown();
    // **Always the state directory, and the vault only when this host made it.**
    // A per-run cleanup rather than a sweep: `target/tmp` collected tens of
    // thousands of entries across this phase because every harness made a
    // directory and nothing removed it in the same breath.
    fs.rmSync(this.dataDirPath, { recursive: true, force: true });
    if (this.removeRootOnStop) fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * The release binary beside the workspace.
 *
 * Named rather than resolved through `PATH`: a live test must exercise *this*
 * build, and a `vaultd` that happened to be installed elsewhere would make a
 * green run mean nothing.
 *
 * Anchored on {@link workspaceRoot}, never `process.cwd()`. Under vitest the
 * working directory is `host/`, so `process.cwd()` would name
 * `host/target/release/vaultd` — a path that does not exist, which is the worst
 * available failure for a file whose whole point is running *this* build.
 */
function liveBinary(): string {
  return join(workspaceRoot(), "target", "release", "vaultd");
}

/** `host/node_modules`, where the workspace links `obsidian` and `electron`. */
export function hostModulePaths(): readonly string[] {
  return [resolve(workspaceRoot(), "host", "node_modules")];
}

/**
 * A scratch vault under the repository's own `target/tmp`, swept by age.
 *
 * Inside the worktree on purpose: a test suite that writes outside the tree it
 * was checked out into is the one class of defect a suite must not have. The
 * name is short because everything after `target/tmp/` counts against Darwin's
 * ~104-byte socket address limit and the host binds a socket inside it.
 */
export function scratchVault(prefix: string): string {
  const root = join(workspaceRoot(), "target", "tmp");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(join(root, prefix));
}

function writeUnder(root: string, path: string, contents: string): void {
  const full = join(root, path);
  fs.mkdirSync(full.slice(0, Math.max(full.lastIndexOf("/"), 0)), { recursive: true });
  fs.writeFileSync(full, contents, "utf8");
}

/** Copy a plugin's files into `<vault>/<configDir>/plugins/<id>/`. */
function installPlugin(config: HostConfig, id: string, from: string): void {
  const target = join(config.vaultRoot, config.configDirName, "plugins", id);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(join(from, entry.name), join(target, entry.name));
  }
}

/**
 * Write the enabled set the sequencer reads at startup.
 *
 * Two spaces and a trailing newline, which is what `HeadlessConfigDir` writes
 * and what Obsidian's own config writer produces, so a host that rewrites this
 * file later leaves it byte-identical.
 */
function enableOnly(config: HostConfig, ids: readonly string[]): void {
  const dir = join(config.vaultRoot, config.configDirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    join(dir, "community-plugins.json"),
    `${JSON.stringify([...ids], null, 2)}\n`,
    "utf8",
  );
}

/** The nonce the host wrote for its socket, which every client must present. */
function readNonce(config: HostConfig): string {
  const path = join(config.dataDir, "nonce");
  const nonce = fs.readFileSync(path, "utf8").trim();
  if (nonce.length === 0) throw new Error(`the host wrote no nonce at ${path}`);
  return nonce;
}

/**
 * Resolve when `predicate` holds — a rendezvous on observable state, never a
 * sleep — and **say what was true instead** when it does not.
 *
 * The same shape `test/real-daemon.ts` uses, written here because this file is
 * under `src/` and cannot import from the test tree.
 */
function waitFor(
  description: string,
  predicate: () => boolean,
  diagnose: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((settle, reject) => {
    const check = (): void => {
      if (predicate()) {
        settle();
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(
            `timed out after ${String(timeoutMs)}ms waiting for ${description}. ${diagnose()}`,
          ),
        );
        return;
      }
      setImmediate(check);
    };
    check();
  });
}
