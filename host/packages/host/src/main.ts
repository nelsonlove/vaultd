#!/usr/bin/env node
/**
 * `vaultd-host` — the binary.
 *
 * It is deliberately thin. Everything it does is done somewhere else in this
 * package already, and the value of the file is that the *order* is written
 * down once, in production, rather than being re-derived by each harness:
 *
 * 1. parse the flags into a {@link HostConfig};
 * 2. start the engine through the {@link Supervisor} and hydrate a {@link Mirror};
 * 3. `assembleShim` — which builds the {@link DryRunGate} from `config.dryRun`,
 *    the policy recorder with `recordCalls` on in that mode, and the watchdog
 *    when its threshold is positive;
 * 4. install the module interception, with `allowNodeBuiltins: !config.dryRun`,
 *    **before** any bundle can be compiled;
 * 5. the loader, the quarantine and the {@link LifecycleSequencer};
 * 6. the plugin config service, then the {@link Detector} over the *same* gate,
 *    recorder and service — after the sequencer, because the detector drives
 *    one;
 * 7. the {@link HostServer}, with `attachWiring` for all three late services;
 * 8. `lifecycle.start()`, then `watchdog.start()`, then `listen()`.
 *
 * **It never injects a `deps.writes` of its own.** The assembly builds the
 * write gate from the configuration, and a binary that handed one in would be
 * the one place in the system where `--dry-run` and the gate could disagree.
 *
 * **It names no fs function.** The socket and the state directory are reached
 * through {@link DataDir}, which is the one module allowed to write outside the
 * vault and asserts that every target resolves under `config.dataDir`.
 *
 * Exit codes are a contract; see {@link USAGE}.
 */

import { resolve } from "node:path";

import { BundleLoader, provisionUserScriptGlobals } from "./runtime/loader";
import { DataDir } from "./datadir";
import { Detector } from "./detector/harness";
import { DEFAULT_KEY_REGISTRY, PluginConfigService } from "./settings/plugin-config";
import { HostServer } from "./server/server";
import { LifecycleSequencer, bundlePluginLoader } from "./runtime/lifecycle";
import { Mirror } from "./mirror/mirror";
import { OBSIDIAN_CONFIG_DIR } from "./pluginset/config-dir";
import { QuarantineTracker } from "./runtime/quarantine";
import { SchemaLadder } from "./settings/ladder";
import { Supervisor } from "./supervisor";
import { assembleShim } from "./testing/assemble";
import { defaultHostConfig, socketPathFor, systemClock } from "./config";
import { installModuleInterception } from "./runtime/intercept";
import type { HostConfig } from "./config";
import type { VaultdClient } from "./client/client";

/** What `--help` prints, and the whole of this binary's interface. */
export const USAGE = `vaultd-host — run Obsidian community plugins headless against a vaultd vault

  vaultd-host --vault <path> [options]

Options:
  --vault <path>            The vault to run over. Required.
  --config-dir <name>       The host's own config directory inside the vault.
                            Default: .obsidian-headless. Never ".obsidian" —
                            that is the GUI's, and sharing it is refused.
  --socket <path>           Where to bind the host's control socket.
                            Default: <state dir>/run/<vault digest>/host.sock.
  --vaultd <path>           The vaultd binary to run. Default: "vaultd" on PATH.
  --dry-run                 Intercept every write instead of performing it, and
                            refuse the file system, process spawning and the
                            network to plugin bundles.
  --dry-run-allow-network   Under --dry-run, let requestUrl through anyway.
  --force-shared <id>       Run <id> even though the GUI has it enabled too.
                            Repeatable.
  -h, --help                Print this and exit 0.

Exit codes:
  0  a clean shutdown (SIGINT or SIGTERM)
  2  a usage error: an unknown flag, a missing value, or no --vault
  3  the daemon was unreachable: vaultd did not start, or did not reach a
     watching state
  4  the config directory was refused: --config-dir named the GUI's own
     directory, or the GUI has every enabled plugin open too (the overlap
     check) and there was nothing left to run
`;

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_DAEMON_UNREACHABLE = 3;
export const EXIT_CONFIG_DIR_REFUSED = 4;

/** A refusal that names its own exit code. */
export class CliRefusal extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "CliRefusal";
    this.code = code;
  }
}

export interface ParsedArgs {
  readonly config: HostConfig;
  readonly help: boolean;
}

/**
 * Turn `argv` into a {@link HostConfig}.
 *
 * Exported so the flag surface can be pinned without starting a daemon: every
 * refusal here is a {@link CliRefusal} carrying {@link EXIT_USAGE}, and a test
 * asserting on the code is asserting on the contract `--help` prints.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let vault: string | null = null;
  let configDirName: string | null = null;
  let socketPath: string | null = null;
  let vaultdBinary: string | null = null;
  let dryRun = false;
  let dryRunAllowNetwork = false;
  const forceShared: string[] = [];

  const valueOf = (flag: string, at: number): string => {
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliRefusal(EXIT_USAGE, `${flag} needs a value`);
    }
    return value;
  };

  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    switch (flag) {
      case "-h":
      case "--help":
        return { config: defaultHostConfig("."), help: true };
      case "--vault":
        vault = valueOf(flag, at);
        at += 1;
        break;
      case "--config-dir":
        configDirName = valueOf(flag, at);
        at += 1;
        break;
      case "--socket":
        socketPath = valueOf(flag, at);
        at += 1;
        break;
      case "--vaultd":
        vaultdBinary = valueOf(flag, at);
        at += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--dry-run-allow-network":
        dryRunAllowNetwork = true;
        break;
      case "--force-shared":
        forceShared.push(valueOf(flag, at));
        at += 1;
        break;
      default:
        throw new CliRefusal(EXIT_USAGE, `unknown flag "${String(flag)}"`);
    }
  }

  if (vault === null) throw new CliRefusal(EXIT_USAGE, "--vault is required");
  // **Refused here rather than at the first write.** A host pointed at the
  // GUI's own directory would load the GUI's plugin set out from under a
  // running Obsidian and write its `data.json` files; the whole coexistence
  // design (Task 14) rests on the two directories being different.
  if (configDirName === OBSIDIAN_CONFIG_DIR) {
    throw new CliRefusal(
      EXIT_CONFIG_DIR_REFUSED,
      `--config-dir ${OBSIDIAN_CONFIG_DIR} is the GUI's own directory and is never shared; ` +
        "run out of .obsidian-headless (the default) or another name of your own",
    );
  }

  const base = defaultHostConfig(vault);
  const config: HostConfig = {
    ...base,
    clock: systemClock(),
    ...(configDirName === null ? {} : { configDirName }),
    ...(vaultdBinary === null ? {} : { vaultdBinary }),
    ...(socketPath === null ? { socketPath: socketPathFor(base.dataDir, vault) } : { socketPath }),
    dryRun,
    dryRunAllowNetwork,
    forceShared,
  };
  return { config, help: false };
}

/** A running host, and the one call that takes it down. */
export interface RunningHost {
  readonly config: HostConfig;
  readonly socketPath: string;
  readonly loaded: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
  stop(): Promise<void>;
}

/**
 * Bring a host up over `config`, in the one order that works.
 *
 * Exported and separate from {@link main} so the wiring can be driven by a test
 * without a process to signal, and so the process half of this file stays what
 * it looks like: parse, run, wait for a signal, stop.
 */
export async function runHost(config: HostConfig): Promise<RunningHost> {
  const state = new DataDir(config.dataDir);
  state.ensureSecureDir(".");

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
    throw new CliRefusal(
      EXIT_DAEMON_UNREACHABLE,
      `the daemon did not come up: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  // mode: a shipped dry run has to refuse the file-system modules to a plugin
  // that requires one by name (the specifiers are not spelled out here, because
  // `test/fs-seam.test.ts` bans them under `src/` and a grep cannot tell a
  // quoted example from a call), and
  // an ordinary run must not.
  const interception = installModuleInterception({
    hostModulePaths: hostModulePaths(),
    allowNodeBuiltins: !config.dryRun,
    harvest: assembly.harvest,
  });

  // **Task 13's provisioning, and nothing else in production did it.** A
  // QuickAdd user script is loaded with
  // `new Function("require", "module", "exports", src)` and handed a one-line
  // shim that forwards to `window.require`, so that global being a real
  // function bound to this host's resolver is the whole of the feature. Without
  // this call the shim's Task 11a refusal stands and every user script in the
  // corpus fails with `window.require is not available headless` — measured,
  // not supposed: it is what the golden macro case reported before this line
  // existed. The resolver is this module's own `require`, which goes through
  // the patched `Module._load` above, so a dry run still refuses a script the
  // file system, process spawning and the network.
  const userScripts = provisionUserScriptGlobals(require);

  const loader = new BundleLoader({
    app: assembly.app,
    queue: assembly.queue,
    events: assembly.events,
    harvest: assembly.harvest,
    errors: assembly.errors,
  });
  assembly.app.plugins.setLoader(loader);

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
  // The `let` above exists only so the quarantine's callback can name the
  // sequencer before it is built; everything below holds the real thing.
  const lifecycle = sequencer;

  // After the sequencer, over the assembly's own objects. The three traps, all
  // from Task 20b's report: the detector's `writes` must be the assembly's
  // `DryRunGate` (`inDryRun()` is an `instanceof` check); its recorder must be
  // the one built with `recordCalls` on, or the harness reports `runs` on an
  // empty call log; and one `PluginConfigService` is shared by the detector and
  // the socket, because the cache and the key registry are what the two must
  // agree about.
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
  const socketPath = await server.listen();

  // The overlap check refuses a plugin the GUI has open; `--force-shared` is
  // the documented escape. A host where that accounted for *everything* has
  // nothing to run and says so with its own exit code rather than idling.
  const overlapRefused = startup.failed.filter((failure) =>
    failure.error.includes(config.configDirName) || failure.error.includes("Obsidian"),
  );
  if (startup.loaded.length === 0 && overlapRefused.length > 0) {
    await shutdown();
    throw new CliRefusal(
      EXIT_CONFIG_DIR_REFUSED,
      `every enabled plugin is also enabled in the GUI's ${OBSIDIAN_CONFIG_DIR}: ` +
        `${overlapRefused.map((failure) => failure.id).join(", ")}. Disable them there, or ` +
        "pass --force-shared <id> for each one you mean to share.",
    );
  }

  async function shutdown(): Promise<void> {
    // The order is the reverse of the order things were started, and it matters
    // at both ends: the sequencer unloads every plugin (and stops the engine
    // with them) before the socket stops answering, so a client's last call is
    // answered by a host that still has the plugin it names; and the watchdog
    // is stopped last, so a shutdown that itself wedges is still reported.
    await lifecycle.stop();
    await server.close();
    await assembly.watchdog?.stop();
    userScripts.restore();
    interception.restore();
    await assembly.teardown();
    await supervisor.stop();
  }

  return {
    config,
    socketPath,
    loaded: startup.loaded,
    failed: startup.failed,
    stop: shutdown,
  };
}

/**
 * `host/node_modules`, where the workspace links `obsidian` and `electron`.
 *
 * Derived from this module's own location rather than from `process.cwd()`: a
 * binary is run from wherever the operator happens to be standing, and the two
 * packages sit beside the compiled host. From `dist/main.js` that is two levels
 * up (`packages/host/dist` → `packages/host` → `packages` → `host`); the same
 * arithmetic holds from `src/main.ts`.
 */
function hostModulePaths(): readonly string[] {
  return [resolve(__dirname, "..", "..", "..", "node_modules")];
}

/**
 * The process half: parse, run, wait for a signal, stop.
 *
 * Resolves with the exit code rather than calling `process.exit`, so the same
 * function can be awaited by a test.
 */
export async function main(
  argv: readonly string[],
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  err: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  let running: RunningHost | null = null;
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      out(USAGE);
      return EXIT_OK;
    }
    running = await runHost(parsed.config);
    // One machine-readable line on stdout, so whatever started this host knows
    // where its socket is without guessing at the digest.
    out(
      JSON.stringify({
        ready: true,
        socket: running.socketPath,
        vault: running.config.vaultRoot,
        dry_run: running.config.dryRun,
        loaded: running.loaded,
        failed: running.failed,
      }),
    );
    await untilSignal();
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CliRefusal) {
      err(error.message);
      if (error.code === EXIT_USAGE) err(USAGE);
      return error.code;
    }
    err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  } finally {
    await running?.stop();
  }
}

/** Resolve on the first `SIGINT` or `SIGTERM`, and stop listening for more. */
function untilSignal(): Promise<NodeJS.Signals> {
  return new Promise<NodeJS.Signals>((resolve) => {
    const settle = (signal: NodeJS.Signals) => (): void => {
      process.off("SIGINT", handlers.SIGINT);
      process.off("SIGTERM", handlers.SIGTERM);
      resolve(signal);
    };
    const handlers = { SIGINT: settle("SIGINT"), SIGTERM: settle("SIGTERM") };
    process.on("SIGINT", handlers.SIGINT);
    process.on("SIGTERM", handlers.SIGTERM);
  });
}

/* c8 ignore start — the process entry point, exercised by test/main-real-daemon.test.ts. */
if (require.main === module) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
/* c8 ignore stop */
