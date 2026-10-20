#!/usr/bin/env node
/**
 * `vaultd-screen-host` - the screen host's binary (docs/design/web-plugins.md,
 * section 2; `src/screen/screen-host.ts` is the wiring).
 *
 * Thin like `main.ts`: parse the flags, start the host, print one ready line,
 * wait for a signal, stop. The exit codes are `main.ts`'s.
 */

import { resolve } from "node:path";

import { CliRefusal, EXIT_DAEMON_UNREACHABLE, EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./main";
import { DaemonUnreachable } from "./host";
import { defaultHostConfig, systemClock } from "./config";
import { screenDataDir, screenSocketPathFor, startScreenHost } from "./screen/screen-host";
import type { EngineMode, HostConfig } from "./config";
import type { RunningScreenHost } from "./screen/screen-host";

export { EXIT_USAGE } from "./main";

export const SCREEN_USAGE = `vaultd-screen-host — apply plugins to the page for vaultd-web

  vaultd-screen-host --vault <path> [options]

It loads the plugins the vault's .obsidian enables (all of them, or those
--plugins names), never writes the vault, and answers screen.apply on its
socket (docs/protocol-host.md, "The screen host").

Options:
  --vault <path>        The vault. Required.
  --socket <path>       Where to bind the socket.
                        Default: <state dir>/run/<vault digest>/screen.sock.
  --vaultd <path>       The vaultd binary. Default: "vaultd" on PATH.
  --vaultd-socket <path>
                        The socket of the vaultd to connect to. Default: the
                        socket vaultd derives for this vault.
  --data-dir <path>     The screen host's own state (the nonce, and the
                        socket's default place).
                        Default: $XDG_STATE_HOME/vaultd-screen-host.
  --engine <mode>       connect (default): use the vaultd already listening for
                        this vault; exit 3 if none is. auto and spawn as for
                        vaultd-host.
  --plugins <ids>       Load only these plugins, a comma list of ids, each
                        still only when the vault enables it.
                        Default: every plugin the vault enables.
  --state-root <path>   Where the viewer store keeps each viewer's values.
                        Default: $XDG_STATE_HOME/vaultd-web/plugin-data.
  --revalidate-ms <ms>  How often .obsidian is checked again when no
                        config_changed came (an edit made outside vaultd).
                        0 trusts events alone. Default: 10000.
  -h, --help            Print this and exit 0.

Exit codes: 0 clean shutdown, 1 other failure, 2 usage error, 3 daemon
unreachable.
`;

export interface ParsedScreenArgs {
  readonly config: HostConfig;
  readonly stateRoot: string | null;
  readonly revalidateMs: number | null;
  /** `--plugins`, or `null` for every enabled plugin. */
  readonly plugins: readonly string[] | null;
  readonly help: boolean;
}

export function parseScreenArgs(argv: readonly string[]): ParsedScreenArgs {
  let vault: string | null = null;
  let socketPath: string | null = null;
  let vaultdBinary: string | null = null;
  let stateRoot: string | null = null;
  let vaultdSocket: string | null = null;
  let dataDirFlag: string | null = null;
  let engine: EngineMode = "connect";
  let revalidateMs: number | null = null;
  let plugins: string[] | null = null;

  const valueOf = (flag: string, at: number): string => {
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) throw new CliRefusal(EXIT_USAGE, `${flag} needs a value`);
    return value;
  };

  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    switch (flag) {
      case "-h":
      case "--help":
        return { config: defaultHostConfig("."), stateRoot: null, revalidateMs: null, plugins: null, help: true };
      case "--vault":
        vault = valueOf(flag, at);
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
      case "--vaultd-socket":
        vaultdSocket = resolve(valueOf(flag, at));
        at += 1;
        break;
      case "--data-dir":
        dataDirFlag = resolve(valueOf(flag, at));
        at += 1;
        break;
      case "--state-root":
        stateRoot = resolve(valueOf(flag, at));
        at += 1;
        break;
      case "--plugins": {
        const ids = valueOf(flag, at)
          .split(",")
          .map((id) => id.trim());
        if (ids.some((id) => id === "")) throw new CliRefusal(EXIT_USAGE, "--plugins must be a comma list of plugin ids, with none empty");
        plugins = ids;
        at += 1;
        break;
      }
      case "--revalidate-ms": {
        const value = valueOf(flag, at);
        if (!/^\d+$/.test(value)) throw new CliRefusal(EXIT_USAGE, `--revalidate-ms must be a whole number, not "${value}"`);
        revalidateMs = Number(value);
        at += 1;
        break;
      }
      case "--engine": {
        const value = valueOf(flag, at);
        if (value !== "auto" && value !== "connect" && value !== "spawn") {
          throw new CliRefusal(EXIT_USAGE, `--engine must be auto, connect or spawn, not "${value}"`);
        }
        engine = value;
        at += 1;
        break;
      }
      default:
        throw new CliRefusal(EXIT_USAGE, `unknown flag "${String(flag)}"`);
    }
  }
  if (vault === null) throw new CliRefusal(EXIT_USAGE, "--vault is required");

  const base = defaultHostConfig(resolve(vault));
  const dataDir = dataDirFlag ?? screenDataDir();
  const config: HostConfig = {
    ...base,
    clock: systemClock(),
    dataDir,
    socketPath: socketPath ?? screenSocketPathFor(dataDir, base.vaultRoot),
    ...(vaultdBinary === null ? {} : { vaultdBinary }),
    ...(vaultdSocket === null ? {} : { engineSocketPath: vaultdSocket }),
    engine,
    // No stall watchdog: the screen host's work is a few milliseconds per apply.
    watchdogThresholdMs: 0,
  };
  return { config, stateRoot, revalidateMs, plugins, help: false };
}

export async function screenMain(
  argv: readonly string[],
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  err: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  let running: RunningScreenHost | null = null;
  try {
    const parsed = parseScreenArgs(argv);
    if (parsed.help) {
      out(SCREEN_USAGE);
      return EXIT_OK;
    }
    try {
      running = await startScreenHost(parsed.config, {
        ...(parsed.stateRoot === null ? {} : { stateRoot: parsed.stateRoot }),
        ...(parsed.revalidateMs === null ? {} : { revalidateMs: parsed.revalidateMs }),
        ...(parsed.plugins === null ? {} : { plugins: parsed.plugins }),
      });
    } catch (error) {
      if (error instanceof DaemonUnreachable) throw new CliRefusal(EXIT_DAEMON_UNREACHABLE, error.message);
      throw error;
    }
    out(
      JSON.stringify({
        ready: true,
        profile: "screen",
        socket: running.socketPath,
        vault: running.config.vaultRoot,
        plugins: running.plugins,
        failed: running.failed,
      }),
    );
    await untilSignal();
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CliRefusal) {
      err(error.message);
      if (error.code === EXIT_USAGE) err(SCREEN_USAGE);
      return error.code;
    }
    err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return EXIT_FAILED;
  } finally {
    await running?.stop();
  }
}

function untilSignal(): Promise<void> {
  return new Promise<void>((settle) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      settle();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

/* c8 ignore start — the process entry point. */
if (require.main === module) {
  void screenMain(process.argv.slice(2)).then(
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
