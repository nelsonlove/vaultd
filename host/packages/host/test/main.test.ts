/**
 * The binary's flag surface and its exit codes, without starting anything.
 *
 * Exit codes are the only thing a script that runs `vaultd-host` can branch on,
 * so they are a contract rather than a detail: `--help` prints them and these
 * cases pin them. The live half — a real daemon, a socket, a `host.hello` and a
 * clean `SIGTERM` — is `test/main-real-daemon.test.ts`.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { defaultHostConfig, socketPathFor } from "../src/config";
import { scratchRoot } from "./scratch";
import type { HostConfig } from "../src/config";

import {
  CliRefusal,
  EXIT_CONFIG_DIR_REFUSED,
  EXIT_DAEMON_UNREACHABLE,
  EXIT_OK,
  EXIT_USAGE,
  USAGE,
  main,
  parseArgs,
  runHost,
} from "../src/main";

describe("vaultd-host argument parsing", () => {
  it("builds a config from --vault alone", () => {
    const { config, help } = parseArgs(["--vault", "/tmp/vault"]);
    expect(help).toBe(false);
    expect(config.vaultRoot).toBe("/tmp/vault");
    // An absolute path is left alone; the relative case is below.
    expect(config.configDirName).toBe(".obsidian-headless");
    expect(config.dryRun).toBe(false);
    // The socket defaults under the state directory, never beside the vault.
    expect(config.socketPath.startsWith(config.dataDir)).toBe(true);
  });

  it("makes a relative --vault absolute, so one vault is one socket", () => {
    // The vault root is the daemon's `--vault` argument *and* the key the
    // socket digest comes from. Left relative, the same vault reached from two
    // directories is two hosts with two sockets, each believing it is alone.
    const { config } = parseArgs(["--vault", "some/vault"]);
    expect(config.vaultRoot).toBe(resolve("some/vault"));
    expect(config.socketPath).toBe(socketPathFor(config.dataDir, resolve("some/vault")));
  });

  it("carries every flag the help text advertises", () => {
    const { config } = parseArgs([
      "--vault", "/tmp/vault",
      "--config-dir", ".headless",
      "--socket", "/tmp/s.sock",
      "--vaultd", "/opt/vaultd",
      "--dry-run",
      "--dry-run-allow-network",
      "--engine", "connect",
      "--leave-engine-running",
      "--force-shared", "alpha",
      "--force-shared", "beta",
    ]);
    expect(config.configDirName).toBe(".headless");
    expect(config.socketPath).toBe("/tmp/s.sock");
    expect(config.vaultdBinary).toBe("/opt/vaultd");
    expect(config.dryRun).toBe(true);
    expect(config.dryRunAllowNetwork).toBe(true);
    expect(config.engine).toBe("connect");
    expect(config.leaveEngineRunning).toBe(true);
    expect(config.forceShared).toEqual(["alpha", "beta"]);
    // Every flag asserted above is advertised, which is what makes this case a
    // test of the interface rather than of the parser alone.
    for (const flag of ["--engine", "--leave-engine-running"]) expect(USAGE).toContain(flag);
  });

  it("defaults the engine to auto and keeps the daemon this host spawns", () => {
    const { config } = parseArgs(["--vault", "/tmp/vault"]);
    expect(config.engine).toBe("auto");
    expect(config.leaveEngineRunning).toBe(false);
  });

  it("refuses an --engine mode it does not have", () => {
    let thrown: unknown;
    try {
      parseArgs(["--vault", "/tmp/vault", "--engine", "adopt"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliRefusal);
    expect((thrown as CliRefusal).code).toBe(EXIT_USAGE);
    expect((thrown as CliRefusal).message).toContain("auto, connect or spawn");
  });

  it("answers exit 3 when --engine connect finds nothing listening", async () => {
    // The mode's whole promise, and the one the config's doc comment makes:
    // `connect` never spawns, so an absent daemon is *the* failure it has, and
    // it must arrive as the documented code rather than as a stack trace. No
    // daemon binary is involved — that is the point.
    const root = scratchRoot("main-connect-");
    const vault = join(root, "v");
    mkdirSync(vault, { recursive: true });
    const config: HostConfig = {
      ...defaultHostConfig(vault),
      dataDir: join(root, "state"),
      socketPath: join(root, "state", "host.sock"),
      engine: "connect",
      engineSocketPath: join(root, "nobody.sock"),
      // The ladder is climbed and exhausted here on purpose; the real rungs
      // would be nine seconds of waiting for an answer already known.
      restartBackoffMs: [1, 1],
    };
    let thrown: unknown;
    try {
      await runHost(config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliRefusal);
    expect((thrown as CliRefusal).code).toBe(EXIT_DAEMON_UNREACHABLE);
    expect((thrown as CliRefusal).message).toMatch(/no vaultd is listening/i);
  });

  it("refuses a missing --vault, an unknown flag and a flag with no value, all as usage errors", () => {
    for (const argv of [[], ["--nope"], ["--vault"]]) {
      let thrown: unknown;
      try {
        parseArgs(argv);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(argv)).toBeInstanceOf(CliRefusal);
      expect((thrown as CliRefusal).code, JSON.stringify(argv)).toBe(EXIT_USAGE);
    }
  });

  it("refuses --config-dir .obsidian with the config-dir code, not the usage one", () => {
    // The GUI's own directory. A host that ran out of it would load the GUI's
    // plugin set out from under a running Obsidian and write its data.json
    // files; the whole coexistence design rests on the two being different.
    let thrown: unknown;
    try {
      parseArgs(["--vault", "/tmp/vault", "--config-dir", ".obsidian"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliRefusal);
    expect((thrown as CliRefusal).code).toBe(EXIT_CONFIG_DIR_REFUSED);
  });

  it("prints the help and exits 0 without starting a daemon", async () => {
    const lines: string[] = [];
    const code = await main(["--help"], (line) => lines.push(line));
    expect(code).toBe(EXIT_OK);
    expect(lines.join("\n")).toBe(USAGE);
  });

  it("documents every exit code it can return", () => {
    for (const code of ["0", "2", "3", "4"]) expect(USAGE).toContain(`\n  ${code}  `);
  });

  it("answers a usage error with the code and the help on stderr", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["--nope"], (line) => out.push(line), (line) => err.push(line));
    expect(code).toBe(EXIT_USAGE);
    expect(err[0]).toContain("--nope");
    expect(err.join("\n")).toContain("Exit codes:");
    expect(out).toEqual([]);
  });
});
