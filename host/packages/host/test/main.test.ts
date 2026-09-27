/**
 * The binary's flag surface and its exit codes, without starting anything.
 *
 * Exit codes are the only thing a script that runs `vaultd-host` can branch on,
 * so they are a contract rather than a detail: `--help` prints them and these
 * cases pin them. The live half — a real daemon, a socket, a `host.hello` and a
 * clean `SIGTERM` — is `test/main-real-daemon.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { defaultHostConfig, socketPathFor, vaultdSocketPathFor } from "../src/config";
import { SCRATCH_BASE, scratchRoot } from "./scratch";
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

/**
 * An absolute path that cannot exist, so `realpath` has nothing to resolve.
 *
 * It used to be the literal `/tmp/vault`, and that was a dependence on the
 * developer's own machine: `parseArgs` canonicalizes, `/tmp` is a symlink to
 * `/private/tmp` on Darwin, and the day somebody actually had a `/tmp/vault`
 * these cases would fail with a confusing `/private/tmp/vault` diff and
 * nothing pointing at the cause.
 */
const ABSENT = join(SCRATCH_BASE, `no-such-vault-${randomUUID()}`);

describe("vaultd-host argument parsing", () => {
  it("builds a config from --vault alone", () => {
    const { config, help } = parseArgs(["--vault", ABSENT]);
    expect(help).toBe(false);
    expect(config.vaultRoot).toBe(ABSENT);
    // An absolute path that resolves to itself is left alone; the relative
    // case is below and the symlink case is beside it.
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

  it("hashes the daemon's own canonical root, through a symlinked --vault", () => {
    // **The digest is a join key between two processes.** The daemon hashes
    // `vault_index::canonical_root`, which is a realpath; a host that hashed
    // the string an operator typed would derive a path no daemon ever binds,
    // and under the default `auto` that is not a quiet miss — it is a second
    // daemon spawned beside a healthy one on every single start.
    const root = scratchRoot("canon-");
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link);
    const canonical = realpathSync(real);

    const { config } = parseArgs(["--vault", link]);
    expect(config.vaultRoot).toBe(canonical);
    expect(config.engineSocketPath).toBe(vaultdSocketPathFor(canonical));
    // And the daemon is told the same root the digest was taken from.
    expect(config.vaultdArgs).toContain(canonical);
  });

  it("canonicalizes for a programmatic config too, not only for the binary", () => {
    // `LiveHost`, an embedder calling `startHost`, and every test factory all
    // build their config through `defaultHostConfig` and never touch
    // `parseArgs`. Canonicalizing in the CLI alone would leave every one of
    // them hashing a root the daemon will not.
    const root = scratchRoot("canon-prog-");
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link);
    const canonical = realpathSync(real);

    const config = defaultHostConfig(link);
    expect(config.vaultRoot).toBe(canonical);
    expect(config.engineSocketPath).toBe(vaultdSocketPathFor(canonical));
  });

  it("carries every flag the help text advertises", () => {
    const { config } = parseArgs([
      "--vault", ABSENT,
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
    const { config } = parseArgs(["--vault", ABSENT]);
    expect(config.engine).toBe("auto");
    expect(config.leaveEngineRunning).toBe(false);
  });

  it("refuses an --engine mode it does not have", () => {
    let thrown: unknown;
    try {
      parseArgs(["--vault", ABSENT, "--engine", "adopt"]);
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
      parseArgs(["--vault", ABSENT, "--config-dir", ".obsidian"]);
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
