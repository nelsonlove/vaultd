import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { API_POLICY, GLOBAL_ONLY_SYMBOLS, createObsidianApi, declareTable } from "../src/shim/api";
import { CALLED, CONSTRUCTED, LIVE, NOT_CONSTRUCTED, VALUES } from "./api-shape";
import { HeadlessUnsupported, declaredSymbols, policyOf, resetPolicyTable } from "../src/shim/policy";
import { createDiv } from "../src/shim/dom";
import { StubEl } from "../src/shim/dom";
import { ShimHarness } from "../src/testing/shim-harness";
import type { ShapeContext } from "./api-shape";

/**
 * The four-way table, held to its own claims: the right symbols, the right
 * policies, and — the half a table cannot check about itself — a value of the
 * right **shape** behind every row.
 *
 * **Why both directions of the symbol check are bugs.** An export with no
 * policy is a surface this host never declared: it will not appear in the
 * compatibility report, and nobody reading that report will know a plugin can
 * reach it. A policy with no export is worse — the name resolves to `undefined`
 * at require time, the plugin destructures it without complaint, and it dies
 * several frames later with a message naming neither the symbol nor the host.
 *
 * **Why the shape check exists at all.** Those two directions compare the table
 * with itself, and a table can be consistently wrong. Flipping one row from
 * `safe_stub` to `absent` keeps every count, every key and every policy lookup
 * intact while turning a class plugins extend into a refusal. The shape buckets
 * in `api-shape.ts` are what make that edit red.
 *
 * **Dotted rows are not barrel exports.** `shim/metadata-cache.ts` declares
 * `MetadataCache.getFileCache`, `shim/events.ts` declares
 * `Menu.showAtPosition`: those are *members*, they belong to the modules that
 * own them, and they reach the report through `declaredSymbols()` without ever
 * being a name a plugin can import. So the comparisons below are against the
 * undotted rows, less the bare globals named in {@link GLOBAL_ONLY_SYMBOLS}.
 */
// **At module scope, and not in a hook.** The first `resetPolicyTable()` call
// is what captures the import-time set — see `shim/policy.ts` — and this line
// is the one moment that is provably right: this file's imports have finished
// evaluating, so every module-scope `declarePolicy` has run, including the
// barrel's own walk.
resetPolicyTable();

/** The rows that name a top-level export rather than a member of one. */
function undottedRows(): string[] {
  return declaredSymbols().filter((symbol) => !symbol.includes("."));
}

/** A vault with a folder in it, so the live `TFile`/`TFolder` rows have one. */
const SHAPE_VAULT = { "Folder/A.md": "# A\n\nbody\n" };

async function shapeContext(): Promise<ShapeContext> {
  const harness = await ShimHarness.withVault(SHAPE_VAULT);
  const plugin = harness.instantiate(
    "shape-probe",
    class extends harness.api.Plugin {
      override onload(): void {
        // Nothing: this plugin exists to be a `PluginSettingTab`'s owner.
      }
    },
  );
  await harness.load(plugin);
  return { harness, api: harness.api, plugin, containerEl: new StubEl("div") };
}

describe("the four-way API policy table", () => {
  it("exports exactly the symbols the table declares — no more, no fewer", async () => {
    const harness = await ShimHarness.withVault({});
    const exported = Object.keys(harness.api).sort();
    const declared = Object.keys(API_POLICY).sort();
    expect(exported).toEqual(declared);
  });

  it("registers every table entry with the policy recorder", () => {
    for (const [symbol, policy] of Object.entries(API_POLICY)) {
      expect(policyOf(symbol), symbol).toBe(policy);
    }
    // The undotted rows are the barrel's exports plus the bare globals that
    // `globals.ts` and `dom.ts` declare — `document`, `app`, `window`,
    // `createDiv` and the rest, which a plugin reaches without importing
    // anything and which Obsidian's module does not export. A new global row
    // has to be added to `GLOBAL_ONLY_SYMBOLS` deliberately, or this fails.
    const exportRows = undottedRows().filter((symbol) => !GLOBAL_ONLY_SYMBOLS.includes(symbol));
    expect(exportRows.sort()).toEqual(Object.keys(API_POLICY).sort());
  });

  it("keeps the bare globals declared and unexported", async () => {
    const harness = await ShimHarness.withVault({});
    for (const symbol of GLOBAL_ONLY_SYMBOLS) {
      expect(undottedRows(), symbol).toContain(symbol);
      expect(Object.keys(harness.api), symbol).not.toContain(symbol);
    }
  });

  it("gives every row a shape bucket, and only one", () => {
    const buckets = new Map<string, string[]>();
    for (const symbol of Object.keys(API_POLICY)) {
      const found: string[] = [];
      if (API_POLICY[symbol] === "absent") found.push("absent");
      if (symbol in CONSTRUCTED) found.push("constructed");
      if (symbol in LIVE) found.push("live");
      if (symbol in NOT_CONSTRUCTED) found.push("not-constructed");
      if (symbol in CALLED) found.push("called");
      if (VALUES.includes(symbol)) found.push("value");
      buckets.set(symbol, found);
    }
    // A new row with no bucket, or a row that changed policy without changing
    // bucket, lands here — which is the point: the shape of a symbol is a
    // decision, and this is where it has to be written down.
    const wrong = [...buckets.entries()].filter(([, found]) => found.length !== 1);
    expect(wrong).toEqual([]);
  });

  it("resolves every implemented and safe_stub class to something constructible", async () => {
    const ctx = await shapeContext();
    for (const [symbol, args] of Object.entries(CONSTRUCTED)) {
      const value = (ctx.api as Record<string, unknown>)[symbol];
      expect(typeof value, symbol).toBe("function");
      const ctor = value as new (...rest: unknown[]) => unknown;
      expect(typeof ctor.prototype, symbol).toBe("object");
      // The two things a bundle does with a class at load time, in order: extend
      // it while the module is still evaluating, and build one later.
      expect(() => {
        const Extended = class extends (ctor as new (...rest: unknown[]) => object) {};
        return Extended;
      }, symbol).not.toThrow();
      let built: unknown;
      expect(() => {
        built = new ctor(...args(ctx));
      }, symbol).not.toThrow();
      expect(built, symbol).toBeInstanceOf(ctor);
    }
  });

  it("answers the live surfaces with instances of the classes it exports", async () => {
    const ctx = await shapeContext();
    for (const [symbol, instance] of Object.entries(LIVE)) {
      const value = (ctx.api as Record<string, unknown>)[symbol];
      expect(typeof value, symbol).toBe("function");
      expect(instance(ctx), symbol).toBeInstanceOf(value as new () => unknown);
    }
  });

  it("keeps the never-instantiated classes extensible and false to instanceof", async () => {
    const ctx = await shapeContext();
    for (const symbol of Object.keys(NOT_CONSTRUCTED)) {
      const value = (ctx.api as Record<string, unknown>)[symbol];
      expect(typeof value, symbol).toBe("function");
      expect(() => {
        const Extended = class extends (value as new (...rest: unknown[]) => object) {};
        return Extended;
      }, symbol).not.toThrow();
    }
    // quickadd's actual test, which must be false: a `true` sends it down a
    // `getBasePath()`-then-direct-write path, behind the daemon's back.
    expect(ctx.harness.app.vault.adapter).not.toBeInstanceOf(
      ctx.api.FileSystemAdapter as new () => unknown,
    );
  });

  it("lets every implemented and safe_stub function be called", async () => {
    const ctx = await shapeContext();
    for (const [symbol, args] of Object.entries(CALLED)) {
      const value = (ctx.api as Record<string, unknown>)[symbol];
      expect(typeof value, symbol).toBe("function");
      const fn = value as (...rest: unknown[]) => unknown;
      let answered: unknown;
      try {
        answered = fn(...args(ctx));
      } catch (error) {
        // Any other failure is the function's own argument handling and is not
        // this file's business; a refusal is exactly what these rows promise
        // cannot happen.
        expect(error, symbol).not.toBeInstanceOf(HeadlessUnsupported);
      }
      // `requestUrl` and friends answer a promise, and a rejection nobody
      // catches would fail the run somewhere else entirely.
      if (answered instanceof Promise) answered.catch(() => undefined);
    }
  });

  it("answers the value rows with a constant rather than a function", async () => {
    const ctx = await shapeContext();
    for (const symbol of VALUES) {
      const value = (ctx.api as Record<string, unknown>)[symbol];
      expect(value, symbol).toBeDefined();
      expect(typeof value, symbol).not.toBe("function");
    }
  });

  it("resolves every symbol to a value whose shape matches its category", async () => {
    const harness = await ShimHarness.withVault({});
    for (const [symbol, policy] of Object.entries(API_POLICY)) {
      const value = (harness.api as Record<string, unknown>)[symbol];
      // Nothing may be `undefined`, ever. That is the whole failure mode this
      // task exists to prevent.
      expect(value, `${symbol} (${policy})`).toBeDefined();
      expect(value, `${symbol} (${policy})`).not.toBeNull();
      if (policy === "absent") {
        expect(typeof value, symbol).toBe("function");
        expect(() => (value as () => void)(), symbol).toThrow(HeadlessUnsupported);
      } else {
        expect(["function", "object", "string"], symbol).toContain(typeof value);
      }
    }
  });

  it("names the symbol in the error an absent entry throws, called or constructed", async () => {
    const harness = await ShimHarness.withVault({});
    const absent = Object.keys(API_POLICY).filter((symbol) => API_POLICY[symbol] === "absent");
    expect(absent.length).toBeGreaterThan(0);
    for (const symbol of absent) {
      const value = (harness.api as Record<string, unknown>)[symbol];
      // Most of the absent rows are published **classes**, and a bundle extends
      // a class while its module is still evaluating — so the binding has to be
      // constructible even though constructing it refuses. An arrow function
      // here would be a `TypeError` at `class extends`, before the plugin has
      // run a line.
      expect(() => {
        const Extended = class extends (value as new (...rest: unknown[]) => object) {};
        return Extended;
      }, symbol).not.toThrow();
      for (const reach of [(): unknown => (value as () => unknown)(), (): unknown => new (value as new () => unknown)()]) {
        try {
          reach();
          expect.unreachable(`${symbol} did not throw`);
        } catch (error) {
          expect(error, symbol).toBeInstanceOf(HeadlessUnsupported);
          expect((error as HeadlessUnsupported).symbol, symbol).toBe(symbol);
          expect((error as HeadlessUnsupported).message, symbol).toContain(symbol);
        }
      }
    }
  });

  it("refuses a MarkdownRenderer static by name rather than by TypeError", async () => {
    const harness = await ShimHarness.withVault({});
    const renderer = harness.api.MarkdownRenderer as { render: () => void };
    // Every caller in the corpus reaches this through the static, never by
    // calling the export, so the static has to be the thing that refuses.
    expect(() => {
      renderer.render();
    }).toThrow(HeadlessUnsupported);
    expect(policyOf("MarkdownRenderer.render")).toBe("absent");
  });

  it("freezes the module object", async () => {
    const harness = await ShimHarness.withVault({});
    expect(Object.isFrozen(harness.api)).toBe(true);
    // A plugin that assigned onto the module object would otherwise poison
    // every later plugin in the process.
    const mutable = harness.api as unknown as Record<string, unknown>;
    expect(() => {
      mutable.Notice = null;
    }).toThrow(TypeError);
    expect(harness.api.Notice).not.toBeNull();
  });

  it("stops the host when a table entry has no binding", async () => {
    const harness = await ShimHarness.withVault({});
    const { assembly } = harness as unknown as {
      assembly: Parameters<typeof createObsidianApi>[0];
    };
    // The drift this guard exists for: someone adds a row and forgets the
    // binding. It must stop the whole host at assembly, not one plugin at its
    // first call — so the failure lands while the stack still names the cause.
    const table = API_POLICY as Record<string, string>;
    const added = "aSymbolNothingBinds";
    table[added] = "implemented";
    try {
      expect(() => createObsidianApi(assembly)).toThrow(/aSymbolNothingBinds/);
    } finally {
      delete table[added];
    }
  });

  it("refuses to contradict a policy a shim module already declared", () => {
    // `declarePolicy` is last-write-wins, so "no symbol is declared twice" is
    // not observable after the fact; the real guard is this throw, and handing
    // it a table that disagrees with a module is the only way to test it.
    // `setIcon` is `dom.ts`'s row and it says `safe_stub`.
    expect(() => {
      declareTable({ setIcon: "implemented" }, new Set(declaredSymbols()));
    }).toThrow(/setIcon/);
    // And a table that agrees is accepted in silence, leaving the row alone.
    declareTable({ setIcon: "safe_stub" }, new Set(declaredSymbols()));
    expect(policyOf("setIcon")).toBe("safe_stub");
  });

  it("records one safe_stub entry per plugin+symbol, counting every hit", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          harness.api.setIcon(createDiv(), "star");
          harness.api.setIcon(createDiv(), "star");
          harness.api.addIcon("custom", "<svg/>");
          return Promise.resolve();
        }
      },
    );
    await harness.load(plugin);
    const stubs = harness.policyRecorder
      .entries()
      .filter((entry) => entry.policy === "safe_stub" && entry.pluginId === "demo");
    expect(stubs.filter((entry) => entry.symbol === "setIcon")).toHaveLength(1);
    expect(stubs.find((entry) => entry.symbol === "setIcon")?.hits).toBe(2);
    expect(stubs.find((entry) => entry.symbol === "addIcon")?.hits).toBe(1);
  });

  it("records the harvested rows at their declared policy, not as stubs", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "tabbed",
      class extends harness.api.Plugin {
        override onload(): void {
          const tab = new harness.api.PluginSettingTab(harness.app, this);
          new harness.api.Setting(tab.containerEl).setName("A setting");
        }
      },
    );
    await harness.load(plugin);
    const rows = harness.policyRecorder.entries().filter((entry) => entry.pluginId === "tabbed");
    // `harvested` is a claim the compatibility report makes about every plugin
    // with a settings tab: the call was **recorded as a capability**, not
    // answered with an inert value. A `stub()` in either constructor would
    // report `safe_stub` here and quietly change what the report says.
    for (const symbol of ["PluginSettingTab", "Setting"]) {
      const row = rows.find((entry) => entry.symbol === symbol);
      expect(row, symbol).toBeDefined();
      expect(row?.policy, symbol).toBe("harvested");
      expect(policyOf(symbol), symbol).toBe("harvested");
    }
  });
});

/**
 * The eight golden bundles, evaluated against this barrel.
 *
 * **Module scope only** — no `onload`, no daemon, no harness fixtures. What it
 * pins is the failure the whole task exists to prevent and which no other
 * committed case can see: a bundle reads its base classes off the module object
 * *while it is still evaluating*, so a barrel that has lost `Modal`, or turned
 * it into something that cannot be extended, kills six of the eight plugins
 * before a single line of their code runs.
 */
const GOLDEN = resolve(__dirname, "..", "..", "..", "fixtures", "golden");
const BUNDLES = [
  "automatic-linker",
  "find-replace",
  "folder-notes",
  "obsidian-linter",
  "obsidian-rollover-daily-todos",
  "quickadd",
  "tag-wrangler",
];

describe("the golden bundles against the barrel", () => {
  it("evaluates every bundle, reading nothing undefined off the module", async () => {
    const harness = await ShimHarness.withVault({});
    const readUndefined = new Map<string, string[]>();
    for (const id of BUNDLES) {
      const missing: string[] = [];
      const barrel = new Proxy(harness.api, {
        get(source, property: string | symbol): unknown {
          if (typeof property === "symbol") return Reflect.get(source, property);
          const value: unknown = Reflect.get(source, property);
          // `__esModule` and `default` are a bundler's interop probes: they are
          // *meant* to be absent, and answering them would make this host
          // pretend to be an ES module.
          if (value === undefined && property !== "__esModule" && property !== "default") {
            missing.push(property);
          }
          return value;
        },
      });
      const code = readFileSync(join(GOLDEN, id, "plugin", "main.js"), "utf8");
      const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
      // The only way to evaluate a CommonJS bundle the way the host's own
      // loader will. The code is a checked-in fixture copied from a real
      // plugin, and the lint rule is about untrusted strings.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const factory = new Function("module", "exports", "require", "process", "global", code) as (
        m: unknown,
        e: unknown,
        r: unknown,
        p: unknown,
        g: unknown,
      ) => void;
      factory(
        moduleObject,
        moduleObject.exports,
        (specifier: string): unknown => {
          if (specifier === "obsidian") return barrel;
          // Task 13 owns the Node builtins and `@codemirror/*`. A bundle that
          // needs one is not this task's failure, and `nested-properties` —
          // which needs `tty` at module scope — is left out of the list above
          // for that reason.
          throw new Error(`no module ${specifier}`);
        },
        process,
        globalThis,
      );
      const exported = moduleObject.exports as { default?: unknown };
      const ctor = typeof exported === "function" ? exported : exported.default;
      expect(typeof ctor, id).toBe("function");
      if (missing.length > 0) readUndefined.set(id, missing);
    }
    expect([...readUndefined.entries()]).toEqual([]);
  }, 60_000);
});
