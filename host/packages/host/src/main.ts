#!/usr/bin/env node
/**
 * `vaultd-host` - the binary.
 *
 * It is deliberately thin, and thinner since fix round 1: the wiring it used to
 * hold is `src/host.ts`, which `src/testing/live-host.ts` drives as well, so the
 * order the binary runs is the order every golden exercises. What is left here
 * is the process: parse the flags, start a host, print one machine-readable
 * ready line, wait for a signal, stop.
 *
 * Exit codes are a contract; see {@link USAGE}. Two of them are decided here
 * from **typed** failures rather than from anything's message: a
 * {@link DaemonUnreachable} becomes 3, and the GUI overlap report becomes 4.
 *
 * **It names no fs function.** The state directory is reached through
 * {@link DataDir}, the one module allowed to write outside the vault.
 */

import { resolve } from "node:path";

import { DaemonUnreachable, startHost } from "./host";
import { OBSIDIAN_CONFIG_DIR } from "./pluginset/config-dir";
import { defaultHostConfig, socketPathFor, systemClock } from "./config";
import type { HostConfig } from "./config";
import type { RunningHost } from "./host";

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
  1  any other unhandled failure, outside the shutdown window: a refusal this
     binary has no typed code for. The message is on stderr.
  2  a usage error: an unknown flag, a missing value, or no --vault
  3  the daemon was unreachable: vaultd did not start, or did not reach a
     watching state
  4  the config directory was refused: --config-dir named the GUI's own
     directory, or the GUI has every enabled plugin open too (the overlap
     check) and there was nothing left to run
`;

export const EXIT_OK = 0;
/**
 * Anything with no typed code of its own, outside the shutdown window.
 *
 * Named rather than left as a bare `1` at two return sites, because the README
 * calls these codes a contract and a reachable code missing from the contract is
 * the half of it a client cannot handle. See the `Exit codes` block in
 * {@link USAGE}.
 */
export const EXIT_FAILED = 1;
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

  // **Absolute, once, here.** The vault root is two things downstream: the
  // daemon's `--vault` argument and the key the socket digest is derived from.
  // Left as the operator typed it, one vault reached from two directories is
  // two different hosts with two different sockets, each believing it is the
  // only one — and `./vault` means nothing at all to a daemon spawned with a
  // different working directory.
  const vaultRoot = resolve(vault);
  const base = defaultHostConfig(vaultRoot);
  const config: HostConfig = {
    ...base,
    clock: systemClock(),
    ...(configDirName === null ? {} : { configDirName }),
    ...(vaultdBinary === null ? {} : { vaultdBinary }),
    ...(socketPath === null ? { socketPath: socketPathFor(base.dataDir, vaultRoot) } : { socketPath }),
    dryRun,
    dryRunAllowNetwork,
    forceShared,
  };
  return { config, help: false };
}

/**
 * Bring a host up over `config`, and turn the typed startup failures into the
 * exit codes `--help` documents.
 *
 * **The wiring itself lives in `src/host.ts`**, which `src/testing/live-host.ts`
 * drives too. That is not tidiness: four separate mutations of the order this
 * file used to hold -- the watchdog never started, `allowNodeBuiltins` forced
 * true, the user-script globals never provisioned, the shutdown order reversed
 * -- survived the whole suite, because the copy under test was the harness's.
 * One copy means every golden is a test of the code the binary runs.
 */
export async function runHost(config: HostConfig): Promise<RunningHost> {
  let running: RunningHost;
  try {
    running = await startHost(config);
  } catch (error) {
    if (error instanceof DaemonUnreachable) {
      throw new CliRefusal(EXIT_DAEMON_UNREACHABLE, error.message);
    }
    throw error;
  }

  // **Decided from the typed overlap report, never from a failure message.**
  // The GUI overlap check refuses a plugin the GUI already has enabled, and
  // `--force-shared` is the documented escape; a host where that accounted for
  // *everything* has nothing to run and says so with its own exit code rather
  // than idling. The first version of this read `failure.error.includes(...)`,
  // which any plugin whose display name contains "Obsidian" -- the corpus's own
  // obsidian-linter among them -- would have tripped, exiting 4 about a GUI
  // overlap that did not exist.
  const forced = new Set(running.overlap.forced);
  const refused = running.overlap.overlap.filter((id) => !forced.has(id));
  if (running.startup.loaded.length === 0 && refused.length > 0) {
    await running.stop();
    throw new CliRefusal(
      EXIT_CONFIG_DIR_REFUSED,
      `every enabled plugin is also enabled in the GUI's ${OBSIDIAN_CONFIG_DIR}: ` +
        `${refused.join(", ")}. Disable them there, or pass --force-shared <id> for each one ` +
        "you mean to share.",
    );
  }
  return running;
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
        loaded: running.startup.loaded,
        failed: running.startup.failed,
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
    return EXIT_FAILED;
  } finally {
    await stopQuietly(running, err);
  }
}

/**
 * Stop the host, and do not let a plugin's parting shot change the exit code.
 *
 * **Targeted, and only for the shutdown window.** `startHost`'s teardown is
 * ordered precisely so that nothing of a plugin's is still running when the
 * globals go — plugins unloaded, queue drained, mirror stopped, timers
 * disarmed — and that ordering is the fix. This is the residue: a plugin can
 * hold a promise of its own that rejects for its own reasons at any moment, and
 * `SIGTERM` is exactly when a busy one does. Node's default for a rejection
 * nobody holds is to kill the process, which would turn the documented "0 = a
 * clean shutdown" into a 1 whenever the host was doing something.
 *
 * **What this is not: the only guard, or a guard during the run.**
 * `HostServer`'s constructor installs a refcounted process-wide
 * `unhandledRejection` handler for the life of the server
 * (`guardUnhandledRejections`, uninstalled by `close()`), which reports every
 * stray rejection to the error sink and keeps the host serving — so the host
 * does **not** die loudly during normal operation, by design, and a plugin's
 * stray rejection reaches the quarantine tracker rather than the process. That
 * also says exactly where the old exit 1 came from: only *after* `close()` had
 * disarmed the server's guard, which is when the teardown used to pull the
 * globals. This listener covers that window and no other — installed for the
 * duration of the stop and removed in a `finally`. What it does is report;
 * what it does not do is change the answer.
 *
 * **The residue it does not cover:** once `stop()` has returned and this
 * listener is off, the server's guard is down too, so a rejection from work
 * that outlived the drain budget can still turn a clean shutdown into an exit
 * 1. Documented rather than guarded — see `startHost`'s `stop()`.
 */
async function stopQuietly(
  running: RunningHost | null,
  err: (line: string) => void,
): Promise<void> {
  if (running === null) return;
  const duringShutdown = (reason: unknown): void => {
    err(
      `a promise rejected while the host was shutting down, after its plugins were unloaded: ${
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      }`,
    );
  };
  process.on("unhandledRejection", duringShutdown);
  try {
    await running.stop();
    // One turn of the loop after the teardown, so a rejection raised by the
    // teardown itself lands while the listener is still up rather than after it
    // has been removed.
    await new Promise<void>((settle) => setImmediate(settle));
  } finally {
    process.off("unhandledRejection", duringShutdown);
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
      process.exitCode = EXIT_FAILED;
    },
  );
}
/* c8 ignore stop */
