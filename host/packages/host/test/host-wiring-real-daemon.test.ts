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
import { CliRefusal, EXIT_CONFIG_DIR_REFUSED, runHost } from "../src/main";
import type { HostConfig } from "../src/config";
import type { RunningHost } from "../src/host";

/**
 * Where the parked plugin writes down what it saw during its own teardown.
 *
 * A global because a bundle is compiled and run in this very process: there is
 * no serialization between a plugin and the case driving it, and this is the
 * whole of the channel.
 */
declare global {
  var __t22unload: string[] | undefined;
}

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

/**
 * A plugin parked on something that is **not a shim timer**, and that is the
 * whole point of it.
 *
 * The first pin of the ordered shutdown could not tell the ordering from the
 * timer disarm: `GlobalInstallation.restore()` disarms this host's
 * `window.setTimeout` timers before it takes the `window` away, which defuses a
 * retry loop *whatever order the rest of the teardown runs in*. Two halves of
 * one fix, redundant in exactly that direction, and reversing the order left
 * both pins green.
 *
 * Two things about it, and the second is what actually pins the order.
 *
 * It parks on a **daemon round trip** rather than a timer, so no disarm can
 * reach it and the microtask queue cannot beat it: real I/O resolves in a
 * macrotask, well after everything a teardown does synchronously.
 *
 * And its `onunload` **writes down whether the host's globals were still
 * there**. That is the deterministic half. An in-flight loop is a race by
 * nature — a self-stopping plugin usually loses it, because unloading is
 * microtask work that finishes before the loop's next wake either way — but
 * `onunload` itself runs at a moment the ordering fixes exactly: before the
 * globals go, or after. A plugin's teardown is entitled to the host it has been
 * running against (Obsidian gives it one), and `typeof` records what it got
 * without throwing, so the assertion belongs to the test rather than to the
 * plugin's manners.
 */
const PARKED_BUNDLE = `
const obsidian = require("obsidian");
module.exports = class Parked extends obsidian.Plugin {
  async onload() {
    this.alive = true;
    this.addCommand({
      id: "park",
      name: "Park",
      callback: () => {
        // Parked on a **daemon round trip**, which is real I/O and cannot be
        // beaten by the microtask queue the way a \`setImmediate\` can. The read
        // is the only thing in the try: a ReferenceError from the global below
        // must reach the process, not this catch.
        (async () => {
          for (;;) {
            try {
              await this.app.vault.read(this.app.vault.getMarkdownFiles()[0]);
            } catch (error) {
              return;
            }
            if (!this.alive) return;
            void window.moment;
          }
        })();
      },
    });
  }
  onunload() {
    this.alive = false;
    // **The ordering, recorded from inside the teardown.** A plugin's
    // \`onunload\` is entitled to the host it has been running against — Obsidian
    // gives it one — and this writes down whether it got it. \`typeof\` on a
    // global that is gone is "undefined" rather than a throw, so the record is
    // made either way and the assertion is the test's, not the plugin's.
    const seen = (globalThis.__t22unload = globalThis.__t22unload || []);
    seen.push(typeof globalThis.window);
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

/**
 * A plugin that fails at module scope with "Obsidian" in its message.
 *
 * Not contrived: `obsidian-dev-utils`, which several corpus plugins bundle,
 * prints exactly `Error loading plugin <Name> (<id>)`. `PluginBundleFailed`
 * carries the reason through, so this text really does reach
 * `StartupReport.failed[].error` — which is what the banned substring test used
 * to read.
 */
const OBSIDIAN_NAMED_BUNDLE = `
throw new Error("Error loading plugin Obsidian Thing (obsidian-thing)");
`;

/** What the GUI has enabled, in the GUI's own config directory. */
function plantGuiEnabled(root: string, ids: readonly string[]): void {
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(
    join(root, ".obsidian", "community-plugins.json"),
    `${JSON.stringify([...ids], null, 2)}\n`,
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
    // Phase 6's road, pinned: this case owns its daemon. See the note in
    // `real-daemon.ts` on why a test never runs under `auto`.
    engine: "spawn" as const,
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

  it("stops a plugin parked on something that is not a shim timer, before the globals go", async () => {
    // **The pin for the shutdown ORDER itself.** Its sibling below is defused
    // by `ShimTimers.clearAll()` — disarming this host's window timers stops a
    // retry loop whatever order the rest of the teardown runs in — so reversing
    // the order left both green. This plugin parks on `setImmediate`, which the
    // bundle wrapper does not shadow onto `window` and no disarm can reach, and
    // stops only because `onunload` ran. Move `assembly.teardown()` above
    // `lifecycle.stop()` in `src/host.ts` and the loop wakes into a process
    // with no `window`: `ReferenceError` on a promise nobody holds, which the
    // `afterEach` above turns into a failing assertion.
    globalThis.__t22unload = [];
    const config = configFor();
    plant(config.vaultRoot, "parked", PARKED_BUNDLE);
    running = await startHost(config, { listen: false });
    expect(running.startup.loaded).toEqual(["parked"]);

    expect(running.assembly.app.commands.executeCommandById("parked:park")).toBe(true);
    // Several turns, so the loop is genuinely parked on a daemon read rather
    // than not yet begun.
    await new Promise<void>((settle) => setTimeout(settle, 60));

    await running.stop();
    running = null;
    // And several more, in which a loop that survived would wake and read.
    await new Promise<void>((settle) => setTimeout(settle, 60));

    // **The ordering assertion, and it is deterministic.** `onunload` ran while
    // the host's globals were still installed, which is only true if
    // `lifecycle.stop()` came before `assembly.teardown()`. Reverse the two in
    // `src/host.ts` and this reads "undefined" — no timing, no race, no
    // dependence on the timer disarm that defused the sibling case.
    expect(globalThis.__t22unload, "onunload must see the host it ran against").toEqual(["object"]);
  }, 120_000);

  it("exits 4 when the GUI has every enabled plugin, and only then", async () => {
    // **The typed overlap path, both directions.** The mechanism matters as
    // much as the outcome: this used to be decided by
    // `failure.error.includes(config.configDirName) || failure.error.includes("Obsidian")`,
    // and the second case below is the one that reinstating it turns red.
    const overlapping = configFor();
    plant(overlapping.vaultRoot, "shared", "module.exports = class {};");
    plantGuiEnabled(overlapping.vaultRoot, ["shared"]);

    let thrown: unknown;
    try {
      const host = await runHost(overlapping);
      // Unreachable when the refusal works; stopped so a failure here does not
      // leave a daemon behind.
      await host.stop();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "a GUI that has every enabled plugin is exit 4").toBeInstanceOf(CliRefusal);
    expect((thrown as CliRefusal).code).toBe(EXIT_CONFIG_DIR_REFUSED);
    expect((thrown as CliRefusal).message).toContain("shared");

    // **And a plugin merely *named* after Obsidian is not an overlap.** It
    // fails to load for its own reasons, nothing loads, the GUI has nothing
    // enabled — and the host keeps running rather than claiming a coexistence
    // problem that does not exist.
    const named = configFor();
    plant(named.vaultRoot, "obsidian-thing", OBSIDIAN_NAMED_BUNDLE);
    running = await runHost(named);
    expect(running.startup.loaded).toEqual([]);
    expect(running.startup.failed[0]?.error ?? "").toContain("Obsidian Thing");
    expect(running.overlap.overlap, "the GUI has nothing enabled").toEqual([]);
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
