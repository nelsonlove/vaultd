import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The one time source.
 *
 * Every component whose behaviour depends on the clock takes it from
 * {@link HostConfig.clock}, never from the global — that is a Global
 * Constraint of this phase, and the reason is that a host whose timers come
 * from the globals can only be tested by waiting. Task 6b's `TestClock`
 * advances when a test says so; production uses {@link systemClock}, which is
 * five one-line delegations and exists so nothing else under `src/` ever names
 * `setTimeout` directly.
 *
 * Plugin-facing timers (`window.setInterval`, `registerInterval`) deliberately
 * use the **real** globals: a plugin observing a frozen clock is a plugin
 * observing a lie. They are cleaned up by the component registry instead.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

/** The real clock: a pass-through to the Node globals, and nothing else. */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => {
      clearInterval(handle);
    },
  };
}

/**
 * Everything the host reads that is not a runtime decision.
 *
 * The calibration values are fixed by the phase plan and all live here so that
 * none of them needs a protocol change to move, and so that a test can drive a
 * different value without patching a module-level constant.
 */
export interface HostConfig {
  readonly vaultRoot: string;
  readonly vaultdBinary: string;
  readonly vaultdArgs: readonly string[];
  /**
   * Extra environment for the spawned engine, merged over `process.env`. This
   * is the seam the supervisor tests drive: the fake daemon reads
   * `FAKE_VAULTD_MODE` from here, and without it there is no way to spawn the
   * fake in a chosen mode without mutating the test process's own env.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly indexPath: string | null;
  /** The vault-relative headless config directory. Written only through `write_file`. */
  readonly configDirName: string;
  /** `$XDG_STATE_HOME/vaultd-host`. One of the three places the host may write. */
  readonly dataDir: string;
  readonly socketPath: string;
  readonly clock: Clock;
  /** The version the shim reports as Obsidian's own. */
  readonly appVersion: string;
  readonly promptTimeoutMs: number;
  readonly quarantineFailures: number;
  readonly quarantineWindowMs: number;
  readonly overlapPollMs: number;
  readonly snapshotPageSize: number;
  readonly snapshotPageSizeMax: number;
  readonly writeFileCapBytes: number;
  readonly unloadBudgetMs: number;
  /**
   * The restart ladder.
   *
   * **Its length is the number of spawn attempts, not the number of retries**,
   * and entry `i` is the wait between attempt `i` and attempt `i + 1` — so the
   * last entry is never waited on, because no attempt follows it. A ladder of
   * `[250, 500, 1000, 2000, 5000]` therefore means: try, wait 250 ms, try,
   * wait 500 ms, try, wait 1 s, try, wait 2 s, try, give up. An empty ladder
   * means one attempt and no restart at all.
   */
  readonly restartBackoffMs: readonly number[];
  /**
   * The flap ceiling: more than {@link restartFlapLimit} restarts inside this
   * many milliseconds and the supervisor stops instead of spawning again.
   *
   * The ladder alone does not bound this. Reaching readiness clears the ladder
   * — deliberately, so an engine that ran for hours and then crashed is not
   * punished for a failure hours ago — which means an engine that answers
   * `health` and then dies restarts forever, taking the index's writer lease on
   * every attempt. This is the engine-side twin of `quarantineWindowMs` /
   * `quarantineFailures` on the plugin side, and it is measured with
   * `clock.now()` like every other duration here.
   */
  readonly restartFlapWindowMs: number;
  readonly restartFlapLimit: number;
  /** Ruling 7: an engine restart does not reload plugins. */
  readonly reloadPluginsOnEngineRestart: boolean;
  readonly momentLocale: string;
  readonly dryRun: boolean;
  readonly dryRunAllowNetwork: boolean;
  readonly forceShared: readonly string[];
}

/**
 * Where the host keeps its own state: `$XDG_STATE_HOME/vaultd-host`, or
 * `~/.local/state/vaultd-host` when that variable is unset.
 */
function hostDataDir(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "vaultd-host");
}

/**
 * One socket per vault root, under a directory the host owns.
 *
 * The root is hashed rather than embedded: a vault path can be longer than the
 * ~104-byte cap a Unix domain socket address has on Darwin, and it can contain
 * separators. Sixteen hex characters of SHA-256 keep the whole address short
 * and stable for a given root.
 */
function socketPathFor(dataDir: string, vaultRoot: string): string {
  const digest = createHash("sha256").update(vaultRoot).digest("hex").slice(0, 16);
  return join(dataDir, "run", digest, "host.sock");
}

/**
 * The default configuration for one vault root.
 *
 * `vaultdBinary` is the bare name: resolving it is `PATH`'s job, and a caller
 * that wants a specific build (every test in this repository, which uses the
 * release binary beside the workspace) overrides it. Every calibration value
 * below comes from the phase plan's Global Constraints list.
 */
export function defaultHostConfig(vaultRoot: string): HostConfig {
  const dataDir = hostDataDir();
  return {
    vaultRoot,
    vaultdBinary: "vaultd",
    vaultdArgs: ["--vault", vaultRoot],
    env: {},
    indexPath: null,
    configDirName: ".obsidian-headless",
    dataDir,
    socketPath: socketPathFor(dataDir, vaultRoot),
    clock: systemClock(),
    appVersion: "1.7.7",
    promptTimeoutMs: 120_000,
    quarantineFailures: 5,
    quarantineWindowMs: 60_000,
    overlapPollMs: 60_000,
    snapshotPageSize: 500,
    snapshotPageSizeMax: 2_000,
    writeFileCapBytes: 16 * 1024 * 1024,
    unloadBudgetMs: 5_000,
    restartBackoffMs: [250, 500, 1_000, 2_000, 5_000],
    restartFlapWindowMs: 60_000,
    restartFlapLimit: 5,
    reloadPluginsOnEngineRestart: false,
    momentLocale: "en",
    dryRun: false,
    dryRunAllowNetwork: false,
    forceShared: [],
  };
}
