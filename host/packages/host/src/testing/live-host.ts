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
 * **The host itself is `startHost` in `src/host.ts` -- the binary's own
 * function**, which is fix round 1's first change. There used to be two copies
 * of the wiring, the binary's and this one, and only this one was under test:
 * four mutations of the binary's copy (the watchdog never started,
 * `allowNodeBuiltins` forced true, the user-script globals never provisioned,
 * the shutdown order reversed) survived the whole suite. What is left in this
 * file is what a *test* needs on top of a running host: staging a fixture on
 * disk, a client on the socket, a rendezvous with the vault, and a teardown
 * that also removes the scratch directories.
 *
 * It writes only inside the vault root it is given -- a scratch directory under
 * the repository's own `target/tmp`, never the developer's vault -- plus the
 * host's own state directory, which is a second scratch directory outside the
 * vault so a live test can never touch the developer's real `$XDG_STATE_HOME`.
 *
 * **Reconciled against the code, Task 22 Step 1.** The scaffold this file grew
 * from was written in Task 6b against interface sketches, and every constructor
 * it named had moved: it assembled a shim and never built a lifecycle, so no
 * plugin would have loaded; `server.start({ wireLateOps: true })` does not
 * exist (`listen()` binds and `attachWiring` carries the late services);
 * `Mirror.settled()` and `PolicyRecorder.unsupportedHits()` never existed; and
 * `startWithGoldenPlugin` installed the plugin from the vault root, which holds
 * the case's notes and no bundle. `task-22a-report.md` has the full table.
 */

import { join } from "node:path";

import { HostTestClient } from "./host-harness";
import { defaultHostConfig, systemClock } from "../config";
import { fs } from "../runtime/fs-access";
import { startHost } from "../host";
import { workspaceRoot } from "./fixture-vault";
import type { App } from "../shim/app";
import type { GetVaultInfoResponse } from "../client/protocol";
import type { Harvest } from "../shim/harvest";
import type { HostConfig } from "../config";
import type { PolicyRecorder } from "../shim/policy";
import type { QuarantineTracker } from "../runtime/quarantine";
import type { LifecycleSequencer } from "../runtime/lifecycle";
import type { RunningHost } from "../host";
import type { StartupReport } from "../runtime/lifecycle";

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
    /** Everything `startHost` built, including its ordered `stop()`. */
    readonly running: RunningHost,
    private readonly client: HostTestClient,
    private readonly root: string,
    private readonly dataDirPath: string,
    private readonly removeRootOnStop: boolean,
  ) {}

  /** What `lifecycle.start()` reported: which plugins loaded, and which did not. */
  get startup(): StartupReport {
    return this.running.startup;
  }

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
      // **A live case owns its daemon.** Under `auto` this host would bind an
      // engine socket in the developer's own XDG run directory and leave a
      // shareable daemon behind it; a golden is about a plugin, not about the
      // engine's provenance. `test/real-daemon.ts` carries the whole note, and
      // `spec.config` below can still ask for another mode.
      engine: "spawn",
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
  /**
   * Run a host over a config {@link stage} already put on disk.
   *
   * **The wiring is `startHost`'s, not this file's**, which is the fix round's
   * first change: the binary and this harness used to hold two copies of the
   * same order, and only the harness's was under test -- four mutations of the
   * binary's copy survived the whole suite. Everything below is what a *test*
   * needs on top of a running host: a client on its socket, a rendezvous, and
   * a teardown that also removes the scratch directories.
   */
  static async startOn(config: HostConfig, removeRootOnStop = false): Promise<LiveHost> {
    const running = await startHost(config);
    const client = await HostTestClient.open(running.socketPath);
    client.rememberHello(await client.call("host.hello", { nonce: readNonce(config) }));
    return new LiveHost(running, client, config.vaultRoot, config.dataDir, removeRootOnStop);
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
    const info = await this.running.supervisor.client().request<GetVaultInfoResponse>("get_vault_info");
    await waitFor(
      `the mirror to apply through generation ${String(info.generation)}`,
      () => this.running.mirror.appliedThrough() >= info.generation && !this.running.mirror.resyncing(),
      () =>
        `the mirror is at generation ${String(this.running.mirror.generation())}, applied through ` +
        `${String(this.running.mirror.appliedThrough())}, resyncing=${String(this.running.mirror.resyncing())}`,
    );
    await this.running.lifecycle.settled();
    await this.running.server.quiesce();
  }

  app(): App {
    return this.running.assembly.app;
  }

  harvest(): Harvest {
    return this.running.assembly.harvest;
  }

  quarantine(): QuarantineTracker {
    return this.running.quarantine;
  }

  lifecycle(): LifecycleSequencer {
    return this.running.lifecycle;
  }

  recorder(): PolicyRecorder {
    return this.running.assembly.policyRecorder;
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
    return this.running.assembly.policyRecorder
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
    // The client first, so the host is not answering a socket while it is
    // being taken down; then the host's own ordered teardown, which is the
    // binary's — plugins unloaded, queue drained, mirror stopped, timers
    // disarmed, and only then the process-wide globals.
    await this.client.disconnect();
    await this.running.stop();
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
