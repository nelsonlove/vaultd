/**
 * `startHost` — **the production wiring, driven in this process.**
 *
 * Every requirement in this file was unpinned before fix round 1. The binary
 * held its own copy of the wiring, nothing exercised it, and four separate
 * mutations of it survived the entire suite: the watchdog never started,
 * `allowNodeBuiltins` forced to `true`, the user-script globals never
 * provisioned, and the shutdown order reversed. The goldens tested the
 * harness's copy — the one that cannot ship.
 *
 * There is one copy now, `src/host.ts`, and these are its pins. They are
 * in-process rather than through the binary because each asserts something the
 * socket cannot show: whether a worker thread is alive, what a global holds,
 * and whether a plugin's in-flight work survived the teardown.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot } from "./real-daemon";
import { defaultHostConfig, systemClock } from "../src/config";
import { startHost } from "../src/host";
import type { HostConfig } from "../src/config";
import type { RunningHost } from "../src/host";

/** A plugin shaped like the one that broke the binary's exit code. */
const RETRY_BUNDLE = `
const obsidian = require("obsidian");
module.exports = class Retrier extends obsidian.Plugin {
  async onload() {
    this.addCommand({
      id: "spin",
      name: "Spin",
      callback: () => {
        // **Dropped on purpose, and this is the shape that matters.** A plugin
        // waiting for something it will never see — folder-notes waits for a
        // file-explorer element — parks on a window timer and reads \`window\`
        // again when it wakes. Nobody holds this promise, so if the host's
        // globals go while a timer is armed, the wake is a ReferenceError that
        // kills the process.
        (async () => {
          for (;;) {
            await new Promise((resolve) => window.setTimeout(resolve, 20));
            void window.moment;
          }
        })();
      },
    });
  }
};
`;

/** A plugin whose `onload` reaches for a Node builtin a dry run refuses. */
const BUILTIN_BUNDLE = `
const obsidian = require("obsidian");
module.exports = class Builtin extends obsidian.Plugin {
  async onload() {
    require("node:child_process");
    this.addCommand({ id: "noop", name: "No-op", callback: () => undefined });
  }
};
`;

function plant(root: string, id: string, source: string): void {
  const dir = join(root, ".obsidian-headless", "plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.js"), source, "utf8");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ id, name: id, version: "0.0.0", minAppVersion: "1.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(root, ".obsidian-headless", "community-plugins.json"),
    `${JSON.stringify([id], null, 2)}\n`,
    "utf8",
  );
}

/** A config over a scratch vault, with the host's own state outside it. */
function configFor(overrides: Partial<HostConfig> = {}): HostConfig {
  const vault = scratchRoot("vaultd-wiring-");
  writeFileSync(join(vault, "A.md"), "# A\n", "utf8");
  const state = scratchRoot("vaultd-wiring-state-");
  return {
    ...defaultHostConfig(vault),
    vaultdBinary: BINARY,
    dataDir: state,
    socketPath: join(state, "s"),
    clock: systemClock(),
    allowNetwork: false,
    ...overrides,
  };
}

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeAll(() => {
  process.on("unhandledRejection", recordUnhandled);
});

afterAll(() => {
  process.off("unhandledRejection", recordUnhandled);
});

afterEach(async () => {
  await cleanupRealDaemons();
  await new Promise<void>((settle) => setTimeout(settle, 0));
  const found = unhandled.splice(0);
  expect(
    found.map((reason) => (reason instanceof Error ? reason.message : String(reason))),
    "a promise rejected with nobody holding it",
  ).toEqual([]);
});

describe.skipIf(!BINARY_EXISTS)("the production host wiring", () => {
  let running: RunningHost | null = null;

  afterEach(async () => {
    await running?.stop();
    running = null;
  });

  it("starts the watchdog after the sequencer and joins it on the way out", async () => {
    // Task 21 built the watchdog, left it stopped, and said in its concern 1
    // that nothing would start it until this wiring did. The threshold is the
    // production default's shape — positive — rather than the zero every
    // harness uses, because that is the configuration the claim is about.
    running = await startHost(configFor({ watchdogThresholdMs: 30_000 }), { listen: false });
    expect(running.assembly.watchdog, "a positive threshold builds one").not.toBeNull();
    expect(running.assembly.watchdog?.exited(), "and the wiring starts it").toBe(false);

    await running.stop();
    expect(running.assembly.watchdog?.exited(), "and joins its thread on the way out").toBe(true);
    running = null;
  }, 120_000);

  it("provisions window.require for a user script, and takes it back", async () => {
    // Task 13's provisioning. `window.require` being a real function bound to
    // this host's resolver is the whole of QuickAdd's user-script feature, and
    // nothing in production called it before fix round 1.
    const before = (globalThis as { window?: { require?: unknown } }).window?.require;
    expect(before, "nothing has provisioned it yet").toBeUndefined();

    running = await startHost(configFor(), { listen: false });
    const during = (globalThis as { window?: { require?: unknown } }).window?.require;
    expect(typeof during).toBe("function");

    await running.stop();
    running = null;
    expect(
      (globalThis as { window?: { require?: unknown } }).window,
      "and the process is put back",
    ).toBeUndefined();
  }, 120_000);

  it("refuses a Node builtin to a bundle under --dry-run, and allows it otherwise", async () => {
    // `allowNodeBuiltins: !config.dryRun`. A dry run whose plugins could still
    // reach the file system is not a dry run, and the flag is the only thing
    // between the two.
    const dry = configFor({ dryRun: true });
    plant(dry.vaultRoot, "builtin", BUILTIN_BUNDLE);
    running = await startHost(dry, { listen: false });
    expect(running.startup.loaded, "refused under --dry-run").toEqual([]);
    expect(running.startup.failed.map((failure) => failure.id)).toEqual(["builtin"]);
    // **The module is named in the cause, not in the rollback message.** The
    // sequencer's message is about the plugin ("threw during onload and has
    // been rolled back"); what the plugin reached for is the error that
    // reached the host's own sink, with phase `onload`.
    const reported = running.assembly.errors
      .entries()
      .map((entry) => (entry.error instanceof Error ? entry.error.message : String(entry.error)))
      .join(" | ");
    expect(reported, "and the refusal names the module").toMatch(/child_process/);
    await running.stop();

    const wet = configFor();
    plant(wet.vaultRoot, "builtin", BUILTIN_BUNDLE);
    running = await startHost(wet, { listen: false });
    expect(running.startup.loaded, "and allowed in an ordinary run").toEqual(["builtin"]);
    await running.stop();
    running = null;
  }, 120_000);

  it("unloads plugins and drains the queue before the globals go", async () => {
    // **The shutdown-order pin, and the one the binary's exit code rests on.**
    // With a plugin parked on a window timer, a teardown that restored the
    // globals first would wake it into a process with no `window`: a
    // ReferenceError on a promise nobody holds, which Node answers by killing
    // the process. The `afterEach` above fails this case if one appears.
    const config = configFor();
    plant(config.vaultRoot, "retrier", RETRY_BUNDLE);
    running = await startHost(config, { listen: false });
    expect(running.startup.loaded).toEqual(["retrier"]);

    expect(running.assembly.app.commands.executeCommandById("retrier:spin")).toBe(true);
    // Let the loop go round a few times, so it is genuinely parked on a timer
    // when the teardown starts rather than not yet started.
    await new Promise<void>((settle) => setTimeout(settle, 120));

    await running.stop();
    running = null;
    // Two turns of the loop: a timer that survived the teardown would fire in
    // one of them, and the `afterEach` assertion is what reports it.
    await new Promise<void>((settle) => setTimeout(settle, 60));
  }, 120_000);
});
