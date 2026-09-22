/**
 * The binary's flag surface and its exit codes, without starting anything.
 *
 * Exit codes are the only thing a script that runs `vaultd-host` can branch on,
 * so they are a contract rather than a detail: `--help` prints them and these
 * cases pin them. The live half — a real daemon, a socket, a `host.hello` and a
 * clean `SIGTERM` — is `test/main-real-daemon.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  CliRefusal,
  EXIT_CONFIG_DIR_REFUSED,
  EXIT_OK,
  EXIT_USAGE,
  USAGE,
  main,
  parseArgs,
} from "../src/main";

describe("vaultd-host argument parsing", () => {
  it("builds a config from --vault alone", () => {
    const { config, help } = parseArgs(["--vault", "/tmp/vault"]);
    expect(help).toBe(false);
    expect(config.vaultRoot).toBe("/tmp/vault");
    expect(config.configDirName).toBe(".obsidian-headless");
    expect(config.dryRun).toBe(false);
    // The socket defaults under the state directory, never beside the vault.
    expect(config.socketPath.startsWith(config.dataDir)).toBe(true);
  });

  it("carries every flag the help text advertises", () => {
    const { config } = parseArgs([
      "--vault", "/tmp/vault",
      "--config-dir", ".headless",
      "--socket", "/tmp/s.sock",
      "--vaultd", "/opt/vaultd",
      "--dry-run",
      "--dry-run-allow-network",
      "--force-shared", "alpha",
      "--force-shared", "beta",
    ]);
    expect(config.configDirName).toBe(".headless");
    expect(config.socketPath).toBe("/tmp/s.sock");
    expect(config.vaultdBinary).toBe("/opt/vaultd");
    expect(config.dryRun).toBe(true);
    expect(config.dryRunAllowNetwork).toBe(true);
    expect(config.forceShared).toEqual(["alpha", "beta"]);
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
