import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  HeadlessUnsupported,
  currentPluginId,
  declarePolicy,
  declaredSymbols,
  enterPlugin,
  policyOf,
  recordUse,
  resetPolicyTable,
  setPolicyRecorder,
  stub,
  unsupported,
} from "../src/shim/policy";
import { memoryPolicyRecorder } from "../src/testing/assemble";
import type { PolicyRecorder } from "../src/shim/policy";

/**
 * The policy table, and the two ways a surface reports what a plugin asked for.
 *
 * The table is module-level state, which is why this file exists at all: every
 * assertion here is about something no other test can see, and Task 11b builds
 * its whole compatibility report out of exactly these functions.
 *
 * Each case installs its own recorder. Vitest gives every file its own process,
 * so the table one file writes is never the table another reads.
 */

function recorded(recorder: PolicyRecorder): string[] {
  return recorder.entries().map((entry) => `${entry.symbol}:${entry.policy}:${String(entry.hits)}`);
}

/**
 * The table is module-scoped, so a shim module's rows land the moment anything
 * imports it — and this file imports plenty, transitively:
 * `memoryPolicyRecorder` comes from `testing/assemble.ts`, which pulls in the
 * whole shim. Resetting before each case puts the table back to exactly that
 * import-time set, so a case's own declarations are the only difference between
 * what it finds and what it left.
 */
// **Here, at module scope, and not in a hook.** The first `resetPolicyTable()`
// call is what captures the import-time set, and this line is the one moment
// that is provably right: this file's own imports have finished evaluating, so
// every module-scope `declarePolicy` has run, and no hook or case has started.
// `policy.ts` cannot take the snapshot for itself — Vite awaits every import,
// so nothing inside that module can observe "the graph is loaded". Moving this
// into `beforeAll` or `beforeEach` reds the last case in this block.
resetPolicyTable();

beforeEach(() => {
  resetPolicyTable();
});

/**
 * Declared exactly where a later capture would swallow it.
 *
 * `beforeAll` runs after module scope and before the first `beforeEach`, so if
 * the capture above were moved into a hook this symbol would be taken for an
 * import-time row and restored for the rest of the process. The case at the end
 * of the block is what turns that into a failure rather than a surprise.
 */
beforeAll(() => {
  declarePolicy("Invented.inABeforeAll", "harvested");
});

/** What a freshly imported process holds, before any case declares anything. */
function importTimeSymbols(): string[] {
  resetPolicyTable();
  return [...declaredSymbols()].sort();
}

describe("the policy table", () => {
  it("answers absent for a symbol nobody declared", () => {
    expect(policyOf("Nothing.declaredThis")).toBe("absent");
    expect(declaredSymbols()).not.toContain("Nothing.declaredThis");
  });

  it("remembers what was declared, and only what was declared", () => {
    const base = importTimeSymbols();
    declarePolicy("Vault.read", "implemented");
    declarePolicy("Menu.showAtMouseEvent", "harvested");
    expect(policyOf("Vault.read")).toBe("implemented");
    expect(policyOf("Menu.showAtMouseEvent")).toBe("harvested");
    // Exactly the import-time set plus these two, so a row appearing from
    // anywhere else still fails this.
    expect([...declaredSymbols()].sort()).toEqual(
      [...base, "Menu.showAtMouseEvent", "Vault.read"].sort(),
    );
  });

  it("restores the import-time declarations on reset rather than emptying", () => {
    // Task 11b's compatibility report asserts the table IS the host's surface.
    // A reset that emptied the table would leave that assertion looking at
    // whatever the previous case had hollowed out; restoring makes "after a
    // reset the table is what a fresh process holds" true by construction.
    const base = importTimeSymbols();
    expect(base).toContain("MetadataCache.getFileCache");
    declarePolicy("Invented.forThisCase", "harvested");
    expect(declaredSymbols()).toContain("Invented.forThisCase");

    resetPolicyTable();
    expect([...declaredSymbols()].sort()).toEqual(base);
    expect(declaredSymbols()).not.toContain("Invented.forThisCase");
    // Restored with their policies, not merely their names.
    expect(policyOf("MetadataCache.getFileCache")).toBe("implemented");
    expect(policyOf("CachedMetadata.footnotes")).toBe("absent");
  });

  it("captures the import-time set at module scope, before any hook", () => {
    // The `beforeAll` above declared `Invented.inABeforeAll`, which is exactly
    // the shape a late capture swallows: it runs before the first `beforeEach`,
    // so a first `resetPolicyTable()` call from inside a hook would take it for
    // an import-time row and restore it forever. The capture at this file's
    // module scope puts the boundary where it belongs — after every
    // module-scope declaration, before any hook — so the symbol is test-local
    // and a reset drops it like any other.
    //
    // This is the case that enforces that placement: move the module-scope
    // `resetPolicyTable()` into a hook and this line fails.
    expect(declaredSymbols()).not.toContain("Invented.inABeforeAll");
    declarePolicy("Invented.inABeforeAll", "harvested");
    expect(declaredSymbols()).toContain("Invented.inABeforeAll");
    resetPolicyTable();
    expect(declaredSymbols()).not.toContain("Invented.inABeforeAll");
    // And the real rows are still there, so this is not just an empty table.
    expect(declaredSymbols()).toContain("MetadataCache.getFileCache");
  });

  it("does not declare a symbol merely because a plugin touched it", () => {
    const recorder = memoryPolicyRecorder();
    setPolicyRecorder(recorder);
    stub("DataAdapter.getResourcePath", "app://headless/x");
    // Task 11b asserts `declaredSymbols()` equals its own table exactly. A hit
    // that added a row would break that from a module it never imported.
    expect(declaredSymbols()).not.toContain("DataAdapter.getResourcePath");
    setPolicyRecorder(null);
  });
});

describe("recording", () => {
  it("counts stub hits per symbol and per plugin", async () => {
    const recorder = memoryPolicyRecorder();
    setPolicyRecorder(recorder);
    expect(stub("Vault.getConfig(theme)", undefined)).toBeUndefined();
    await enterPlugin("folder-notes", () => {
      stub("Vault.getConfig(theme)", undefined);
      stub("Vault.getConfig(theme)", undefined);
    });
    expect(recorded(recorder)).toEqual([
      "Vault.getConfig(theme):safe_stub:1",
      "Vault.getConfig(theme):safe_stub:2",
    ]);
    expect(recorder.entries().map((entry) => entry.pluginId)).toEqual([null, "folder-notes"]);
    setPolicyRecorder(null);
  });

  it("records an ordinary use at whatever the symbol declares", () => {
    const recorder = memoryPolicyRecorder();
    setPolicyRecorder(recorder);
    declarePolicy("Vault.create", "implemented");
    recordUse("Vault.create");
    expect(recorded(recorder)).toEqual(["Vault.create:implemented:1"]);
    setPolicyRecorder(null);
  });

  it("records the hit before it throws, and throws the typed refusal", async () => {
    const recorder = memoryPolicyRecorder();
    setPolicyRecorder(recorder);
    await enterPlugin("quickadd", () => {
      expect(() => {
        unsupported("Modal.open", "MyBespokeModal");
      }).toThrow(HeadlessUnsupported);
    });
    expect(recorded(recorder)).toEqual(["Modal.open:absent:1"]);
    expect(recorder.entries()[0]?.pluginId).toBe("quickadd");
    setPolicyRecorder(null);
  });

  it("survives having no recorder at all", () => {
    setPolicyRecorder(null);
    expect(stub("Anything.at.all", 7)).toBe(7);
    expect(() => {
      unsupported("Anything.else");
    }).toThrow(HeadlessUnsupported);
  });
});

describe("HeadlessUnsupported", () => {
  it("carries the symbol, the plugin, the policy and the detail", async () => {
    setPolicyRecorder(null);
    await enterPlugin("quickadd", () => {
      try {
        unsupported("Modal.open", "MyBespokeModal");
        expect.unreachable("unsupported must throw");
      } catch (error) {
        expect(error).toBeInstanceOf(HeadlessUnsupported);
        const refusal = error as HeadlessUnsupported;
        expect(refusal.name).toBe("HeadlessUnsupported");
        expect(refusal.code).toBe("headless_unsupported");
        expect(refusal.policy).toBe("absent");
        // The symbol is the API surface; the subclass is the detail. A test
        // asserting `symbol === "MyBespokeModal"` would assert the wrong thing.
        expect(refusal.symbol).toBe("Modal.open");
        expect(refusal.detail).toBe("MyBespokeModal");
        expect(refusal.pluginId).toBe("quickadd");
        expect(refusal.message).toBe("Modal.open is not available headless (MyBespokeModal)");
      }
    });
  });

  it("says it plainly when there is no detail and no plugin", () => {
    setPolicyRecorder(null);
    const refusal = new HeadlessUnsupported("FileManager.promptForFileRename", currentPluginId());
    expect(refusal.message).toBe("FileManager.promptForFileRename is not available headless");
    expect(refusal.detail).toBeNull();
    expect(refusal.pluginId).toBeNull();
  });
});
