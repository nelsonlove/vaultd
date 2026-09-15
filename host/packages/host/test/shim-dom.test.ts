/* eslint-disable @typescript-eslint/require-await --
 * `async onload()` with nothing awaited inside it is what the corpus actually
 * writes, and it is the shape under test here too: the hits the last case
 * counts are recorded while the host is awaiting whatever `onload` returns.
 * Rewriting it as synchronous to satisfy the rule would test a different thing.
 */

/**
 * The DOM that is not there, and the globals a plugin bundle reads before it is
 * ever instantiated.
 *
 * There is no jsdom here on purpose: a host that behaved *almost* like a
 * browser would hide exactly the cases the compatibility report exists to
 * surface. What these cases pin is that the chain a settings tab builds cannot
 * throw, that every query answers with an empty collection rather than
 * `undefined`, and that the handful of globals the corpus reads at module scope
 * — `app`, `moment`, `i18next`, `MutationObserver` — are installed before any
 * bundle runs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { App } from "../src/shim/app";
import { Harvest } from "../src/shim/harvest";
import { HostErrors } from "../src/shim/errors";
import { ShimHarness } from "../src/testing/shim-harness";
import { defaultHostConfig } from "../src/config";
import { installGlobals } from "../src/shim/globals";
import { testClock } from "../src/testing/clock";

/**
 * Node's own timer functions, captured **before** any host is assembled.
 *
 * The one thing installing a `window` must never do is replace these: Node's
 * machinery, this runner and the host's own supervisor all call them, and a
 * `TestClock`-backed `globalThis.setTimeout` freezes the process. Captured at
 * module scope because after the first case there is no un-installed state left
 * to compare against.
 */
const NODE_TIMERS = {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
};

/**
 * The host's real state directory, computed exactly as `config.ts` computes it.
 *
 * Deliberately duplicated rather than imported: the guard below has to fail if
 * someone changes where the host writes *and* forgets the tests, and a guard
 * that imported the value under test would move with it.
 */
function realStateDir(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "vaultd-host");
}

/** A window, typed as the handful of members a case reaches for. */
function globalWindow(): {
  require: (specifier: string) => unknown;
  addEventListener: (type: string, listener: unknown) => void;
  removeEventListener: (type: string, listener: unknown) => void;
  dispatchEvent: (event: unknown) => boolean;
  setTimeout: (callback: () => void, ms: number) => number;
} {
  const installed = globalThis as unknown as { window: unknown };
  return installed.window as ReturnType<typeof globalWindow>;
}

/** `localStorage`, at the browser's own signature rather than the host's. */
function globalStorage(): {
  getItem(key: unknown): string | null;
  setItem(key: unknown, value: unknown): void;
  removeItem(key: unknown): void;
  clear(): void;
  length: number;
} {
  const installed = globalThis as unknown as { localStorage: unknown };
  return installed.localStorage as ReturnType<typeof globalStorage>;
}

describe("DOM stubs", () => {
  it("swallows the whole createEl chain a settings tab builds", async () => {
    const harness = await ShimHarness.withVault({});
    const root = harness.api.createDiv({ cls: "panel" });
    const heading = root.createEl("h2", { text: "Title" });
    heading.addClass("big").setAttr("data-x", "1");
    const child = root.createDiv().createSpan({ text: "inner" });
    child.empty();
    root.detach();
    expect(typeof root.createEl).toBe("function");
    expect(root.querySelector("h2")).toBeNull();
    expect(root.querySelectorAll("h2")).toEqual([]);
    expect(root.children).toEqual([]);
  });

  it("installs the Obsidian prototype extensions plugins rely on", async () => {
    await ShimHarness.withVault({});
    expect([1, 2, 3].first()).toBe(1);
    expect([1, 2, 3].last()).toBe(3);
    expect([].first()).toBeUndefined();
    expect([1, 2].contains(2)).toBe(true);
    expect("abc".contains("b")).toBe(true);
  });

  it("exposes window.app and window.moment for the vendored daily-notes interface", async () => {
    const harness = await ShimHarness.withVault({});
    const globalWindow = globalThis as unknown as { app: unknown; moment: unknown };
    expect(globalWindow.app).toBe(harness.app);
    expect(typeof globalWindow.moment).toBe("function");
    expect((globalWindow.moment as () => { format(f: string): string })().format("YYYY")).toMatch(/^\d{4}$/);
  });

  it("provides an inert MutationObserver and i18next", async () => {
    await ShimHarness.withVault({});
    const g = globalThis as unknown as {
      MutationObserver: new (cb: () => void) => { observe(t: unknown, o: unknown): void; disconnect(): void };
      i18next: { t(key: string): string };
    };
    const observer = new g.MutationObserver(() => { throw new Error("must never fire"); });
    expect(() => { observer.observe({}, { subtree: true }); }).not.toThrow();
    expect(() => { observer.disconnect(); }).not.toThrow();
    expect(g.i18next.t("plugins.folder-notes.label")).toBe("plugins.folder-notes.label");
  });

  it("records a safe_stub hit per symbol per plugin, once", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.addRibbonIcon("star", "Go", () => {});
        harness.api.setIcon(harness.api.createDiv(), "star");
        harness.api.setIcon(harness.api.createDiv(), "star");
      }
    });
    await harness.load(plugin);
    const stubs = harness.policyRecorder.entries().filter((e) => e.policy === "safe_stub" && e.pluginId === "demo");
    const setIcon = stubs.find((e) => e.symbol === "setIcon");
    expect(setIcon?.hits).toBe(2);
    expect(stubs.filter((e) => e.symbol === "setIcon")).toHaveLength(1);
  });

  it("keeps a fragment out of the element branch", async () => {
    const harness = await ShimHarness.withVault({});
    const g = globalThis as unknown as {
      HTMLElement: new () => unknown;
      DocumentFragment: new () => unknown;
      Node: new () => unknown;
    };
    const fragment = harness.api.createFragment();
    const element = harness.api.createDiv();
    // A plugin branches `if (x instanceof HTMLElement) … else if (x instanceof
    // DocumentFragment)`, so a fragment answering `true` to the first test
    // takes it down the wrong arm — which is what a browser would never do.
    expect(fragment instanceof g.DocumentFragment).toBe(true);
    expect(fragment instanceof g.HTMLElement).toBe(false);
    expect(fragment instanceof g.Node).toBe(true);
    expect(element instanceof g.HTMLElement).toBe(true);
    expect(element instanceof g.Node).toBe(true);
    expect(element instanceof g.DocumentFragment).toBe(false);
  });

  it("answers getAttr with what setAttr wrote", async () => {
    const harness = await ShimHarness.withVault({});
    const element = harness.api.createEl("input", { attr: { placeholder: "Name" } });
    element.setAttr("data-x", "1");
    expect(element.getAttr("data-x")).toBe("1");
    expect(element.getAttribute("placeholder")).toBe("Name");
    expect(element.hasAttribute("data-x")).toBe(true);
    expect(element.getAttr("nothing")).toBeNull();
    element.removeAttribute("data-x");
    expect(element.getAttr("data-x")).toBeNull();
  });
});

describe("the host's own state directory", () => {
  it("never lets a harness write to the real XDG state directory", async () => {
    const real = realStateDir();
    const existedBefore = existsSync(real);
    const harness = await ShimHarness.withVault({});
    // The guard itself: a harness's data dir is neither the real one nor
    // anywhere under it. Everything the host persists — `localStorage` today,
    // plugin data later — lands under this root.
    expect(harness.config.dataDir).not.toBe(real);
    expect(harness.config.dataDir.startsWith(real + sep)).toBe(false);

    globalStorage().setItem("vaultd-host-test", "written");
    expect(globalStorage().getItem("vaultd-host-test")).toBe("written");
    const stored = join(harness.config.dataDir, "localstorage.json");
    expect(existsSync(stored)).toBe(true);
    expect(JSON.parse(readFileSync(stored, "utf8"))).toEqual({ "vaultd-host-test": "written" });
    // And the write really did not reach the developer's home directory.
    expect(existsSync(real)).toBe(existedBefore);
  });

  it("starts empty and reports when the stored document is torn", async () => {
    const harness = await ShimHarness.withVault({});
    const stored = join(harness.config.dataDir, "localstorage.json");
    mkdirSync(dirname(stored), { recursive: true });
    // What a crash mid-rewrite used to leave behind: a truncated document.
    writeFileSync(stored, '{"theme": "dar', "utf8");
    expect(() => globalStorage().getItem("theme")).not.toThrow();
    expect(globalStorage().getItem("theme")).toBeNull();
    expect(harness.hostErrors.map((entry) => entry.phase)).toContain("plugin-data");
    // Still usable afterwards: a corrupt document costs the stored values, not
    // the store.
    globalStorage().setItem("theme", "light");
    expect(globalStorage().getItem("theme")).toBe("light");
  });
});

describe("the installed globals", () => {
  it("puts every descriptor back exactly as it found it", () => {
    const targets: Array<[string, object]> = [
      ["globalThis", globalThis],
      ["Array.prototype", Array.prototype],
      ["String.prototype", String.prototype],
    ];
    const before = targets.map(([, target]) => snapshot(target));
    const installation = installGlobals(new App({ appId: "0".repeat(16) }), defaultHostConfig("/vault"), {
      dataDir: join(process.cwd(), "target", "tmp", "descriptor-probe"),
      errors: new HostErrors(),
      harvest: new Harvest(),
      clock: testClock(),
    });
    // The install is real: at least the sixteen names it adds are there.
    expect(Object.getOwnPropertyDescriptor(globalThis, "i18next")).toBeDefined();
    installation.restore();
    targets.forEach(([label, target], at) => {
      expect(snapshot(target), `${label} was not restored`).toEqual(before[at]);
    });
  });

  it("leaves Node's own timers alone and routes window's through the clock", async () => {
    const harness = await ShimHarness.withVault({});
    expect(globalThis.setTimeout).toBe(NODE_TIMERS.setTimeout);
    expect(globalThis.setInterval).toBe(NODE_TIMERS.setInterval);
    expect(globalThis.clearTimeout).toBe(NODE_TIMERS.clearTimeout);
    expect(globalThis.clearInterval).toBe(NODE_TIMERS.clearInterval);
    // `window` is not `globalThis`, but everything it does not own resolves
    // through it — which is what makes it usable as a stand-in at all.
    expect(Object.getPrototypeOf(globalWindow())).toBe(globalThis);
    expect(globalWindow().setTimeout).not.toBe(NODE_TIMERS.setTimeout);
    const before = harness.activeTimerCount();
    globalWindow().setTimeout(() => undefined, 10_000);
    expect(harness.activeTimerCount()).toBe(before + 1);
  });

  it("installs the prototype extensions without joining any for-in loop", async () => {
    await ShimHarness.withVault({});
    for (const name of ["first", "last", "contains", "remove", "unique"]) {
      const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, name);
      expect(descriptor?.enumerable, `Array.prototype.${name}`).toBe(false);
    }
    expect(Object.getOwnPropertyDescriptor(String.prototype, "contains")?.enumerable).toBe(false);
    const keys: string[] = [];
    /* eslint-disable-next-line @typescript-eslint/no-for-in-array --
     * The `for...in` is the assertion, not an accident: it is the loop an
     * enumerable prototype extension would corrupt, in this host's own code,
     * the runner's, and every plugin's.
     */
    for (const key in [1, 2]) keys.push(key);
    expect(keys).toEqual(["0", "1"]);
  });

  it("stores localStorage keys and values as strings, as a browser does", async () => {
    await ShimHarness.withVault({});
    globalStorage().clear();
    globalStorage().setItem("count", 42);
    globalStorage().setItem(7, "seven");
    expect(globalStorage().getItem("count")).toBe("42");
    expect(globalStorage().getItem("7")).toBe("seven");
    expect(globalStorage().getItem("never-written")).toBeNull();
    expect(globalStorage().length).toBe(2);
    globalStorage().removeItem(7);
    expect(globalStorage().getItem("7")).toBeNull();
  });

  it("refuses window.require by name instead of answering undefined", async () => {
    const harness = await ShimHarness.withVault({});
    expect(typeof globalWindow().require).toBe("function");
    expect(() => globalWindow().require("child_process")).toThrowError(
      /window\.require is not available headless \(child_process\)/,
    );
    const refused = harness.policyRecorder
      .entries()
      .filter((entry) => entry.symbol === "window.require" && entry.policy === "absent");
    expect(refused).toHaveLength(1);
  });

  it("records a window event listener as unreachable, and withdraws it again", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override onload(): void {
        const onMenu = (): void => undefined;
        globalWindow().addEventListener("contextmenu", onMenu);
        globalWindow().addEventListener("keydown", () => undefined);
        globalWindow().removeEventListener("contextmenu", onMenu);
      }
    });
    await harness.load(plugin);
    // The withdrawn one is gone; the kept one carries the event type, which is
    // the whole of what a GUI-less host can say about a listener it will never
    // deliver to.
    expect(harness.harvest.unreachable()).toEqual([
      { pluginId: "demo", kind: "dom_listener", detail: "keydown" },
    ]);
    expect(globalWindow().dispatchEvent({ type: "keydown" })).toBe(true);
  });

  it("records a contextmenu listener as a delegated menu", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override onload(): void {
        globalWindow().addEventListener("contextmenu", () => undefined);
      }
    });
    await harness.load(plugin);
    expect(harness.harvest.unreachable()).toEqual([
      { pluginId: "demo", kind: "dom_delegated_menu", detail: "contextmenu" },
    ]);
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method --
 * A property descriptor's `value` is `any` by declaration, and its `get` and
 * `set` are functions this helper compares by identity rather than calls. Both
 * rules are about *using* such values; this one only records them, and a
 * restore that put back a different getter is exactly what it has to catch.
 */

/** Every own property descriptor of `target`, flattened for comparison. */
function snapshot(target: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(target))) {
    out[key] = {
      value: descriptor.value,
      get: descriptor.get,
      set: descriptor.set,
      writable: descriptor.writable,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
    };
  }
  return out;
}
