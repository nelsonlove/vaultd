import { describe, expect, it } from "vitest";

import { API_POLICY, GLOBAL_ONLY_SYMBOLS, createObsidianApi } from "../src/shim/api";
import { HeadlessUnsupported, declaredSymbols, policyOf, resetPolicyTable } from "../src/shim/policy";
import { ShimHarness } from "../src/testing/shim-harness";

/**
 * The four-way table, held to its own claim: every symbol the `obsidian` module
 * exports carries exactly one policy, and every policy has an export.
 *
 * **Why both directions are bugs.** An export with no policy is a surface this
 * host never declared — it will not appear in the compatibility report, and
 * nobody reading that report will know a plugin can reach it. A policy with no
 * export is worse: the name resolves to `undefined` at require time, the plugin
 * destructures it without complaint, and it dies several frames later with a
 * message naming neither the symbol nor the host. This file is what makes both
 * impossible to introduce quietly.
 *
 * **Dotted rows are not barrel exports.** `shim/metadata-cache.ts` declares
 * `MetadataCache.getFileCache`, `shim/events.ts` declares
 * `Menu.showAtPosition`, and so on: those are *members*, they belong to the
 * modules that own them, and they reach the report through `declaredSymbols()`
 * without ever being a name a plugin can import. So the comparisons below are
 * against the undotted rows, less the handful of bare globals named in
 * {@link GLOBAL_ONLY_SYMBOLS}.
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
    // `globals.ts` and `dom.ts` declare — `document`, `app`, `localStorage` and
    // the rest, which a plugin reaches without importing anything. A new global
    // row has to be added to `GLOBAL_ONLY_SYMBOLS` deliberately, or this fails.
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

  it("declares no symbol twice, and never contradicts the module that owns it", () => {
    // `declarePolicy` is last-write-wins, so a second declaration of the same
    // symbol is invisible at runtime — which is exactly why the barrel refuses
    // to make one: its walk skips every symbol a module already declared, and
    // throws at import if the table and the module disagree. What is observable
    // here is the consequence: one row per symbol, and every row agreeing with
    // the table above.
    const rows = declaredSymbols();
    expect(new Set(rows).size).toBe(rows.length);
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

  it("names the symbol in the error an absent entry throws", async () => {
    const harness = await ShimHarness.withVault({});
    const absent = Object.keys(API_POLICY).filter((symbol) => API_POLICY[symbol] === "absent");
    expect(absent.length).toBeGreaterThan(0);
    for (const symbol of absent) {
      try {
        ((harness.api as Record<string, unknown>)[symbol] as () => void)();
        expect.unreachable(`${symbol} did not throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(HeadlessUnsupported);
        expect((error as HeadlessUnsupported).symbol).toBe(symbol);
        expect((error as HeadlessUnsupported).message).toContain(symbol);
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

  it("records one safe_stub entry per plugin+symbol, counting every hit", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          harness.api.setIcon(harness.api.createDiv(), "star");
          harness.api.setIcon(harness.api.createDiv(), "star");
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
});
