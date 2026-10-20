/**
 * The `vaultd-screen-host` binary's flags (task 6 of `docs/design/web-plugins.md`).
 * The process itself is exercised by `screen-host-real-daemon.test.ts` through
 * `startScreenHost`, which the binary calls.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { EXIT_USAGE, SCREEN_USAGE, parseScreenArgs } from "../src/screen-main";
import { CliRefusal } from "../src/main";
import { screenDataDir, screenSocketPathFor } from "../src/screen/screen-host";

describe("parseScreenArgs", () => {
  it("connects to a running vaultd by default, with its own state directory and socket", () => {
    const parsed = parseScreenArgs(["--vault", "/tmp"]);
    expect(parsed.help).toBe(false);
    const { config } = parsed;
    expect(config.engine).toBe("connect");
    expect(config.dataDir).toBe(screenDataDir());
    expect(config.socketPath).toBe(screenSocketPathFor(screenDataDir(), config.vaultRoot));
    expect(config.socketPath.endsWith("screen.sock")).toBe(true);
    expect(config.watchdogThresholdMs).toBe(0);
    expect(parsed.stateRoot).toBeNull();
  });

  it("takes the engine mode, the socket, the vaultd binary and the viewer state root", () => {
    const parsed = parseScreenArgs([
      "--vault",
      "/tmp",
      "--engine",
      "spawn",
      "--socket",
      "/tmp/x/s",
      "--vaultd",
      "/bin/vaultd",
      "--state-root",
      "rel/state",
    ]);
    expect(parsed.config.engine).toBe("spawn");
    expect(parsed.config.socketPath).toBe("/tmp/x/s");
    expect(parsed.config.vaultdBinary).toBe("/bin/vaultd");
    expect(parsed.stateRoot).toBe(resolve("rel/state"));
  });

  it("takes the vaultd socket to connect to, and its own state directory", () => {
    const parsed = parseScreenArgs(["--vault", "/tmp", "--vaultd-socket", "rel/h.sock", "--data-dir", "rel/screen"]);
    expect(parsed.config.engineSocketPath).toBe(resolve("rel/h.sock"));
    expect(parsed.config.dataDir).toBe(resolve("rel/screen"));
    // The socket's default follows the moved state directory.
    expect(parsed.config.socketPath).toBe(screenSocketPathFor(resolve("rel/screen"), parsed.config.vaultRoot));
    expect(SCREEN_USAGE).toContain("--vaultd-socket");
    expect(SCREEN_USAGE).toContain("--data-dir");
  });

  it("takes the re-read period, and refuses one that is not a whole number", () => {
    expect(parseScreenArgs(["--vault", "/tmp"]).revalidateMs).toBeNull();
    expect(parseScreenArgs(["--vault", "/tmp", "--revalidate-ms", "0"]).revalidateMs).toBe(0);
    expect(() => parseScreenArgs(["--vault", "/tmp", "--revalidate-ms", "-1"])).toThrow(CliRefusal);
    expect(SCREEN_USAGE).toContain("--revalidate-ms");
  });

  it("keeps its state apart from the headless host's", () => {
    expect(screenDataDir({ XDG_STATE_HOME: "/s" })).toBe(join("/s", "vaultd-screen-host"));
  });

  it("refuses a missing vault, an unknown flag and a bad engine mode with the usage code", () => {
    for (const argv of [[], ["--vault", "/tmp", "--nope"], ["--vault", "/tmp", "--engine", "x"], ["--vault"]]) {
      expect(() => parseScreenArgs(argv)).toThrow(CliRefusal);
      try {
        parseScreenArgs(argv);
      } catch (error) {
        expect((error as CliRefusal).code).toBe(EXIT_USAGE);
      }
    }
  });

  it("answers --help", () => {
    expect(parseScreenArgs(["--help"]).help).toBe(true);
    expect(SCREEN_USAGE).toContain("screen.apply");
  });
});
