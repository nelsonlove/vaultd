import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanBundle } from "../src/detector/scanner";

const dir = join(__dirname, "..", "..", "..", "fixtures", "detector");
/**
 * The **directories** under the fixture root, not everything in it.
 *
 * The brief's listing was a bare `readdirSync(dir)`, which the dispatch's
 * ruling 7 makes unsatisfiable: that ruling requires a `README.md` beside the
 * eight case folders — provenance for a corpus of hand-written bundles is not
 * optional — and a bare listing would count it as a ninth case and then try to
 * read `README.md/main.js`. Filtering to directories keeps the count assertion
 * meaning what it says (eight cases) and covers the other file a macOS
 * checkout grows on its own, `.DS_Store`.
 */
const cases = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("scanBundle", () => {
  it("matches ground truth for every fixture", () => {
    expect(cases).toHaveLength(8);
    for (const name of cases) {
      const source = readFileSync(join(dir, name, "main.js"), "utf8");
      const truth = JSON.parse(readFileSync(join(dir, name, "ground-truth.json"), "utf8")) as Record<string, unknown>;
      const result = scanBundle(name, source);
      expect({
        minified: result.minified,
        apiSymbols: result.apiSymbols,
        genericSymbols: result.genericSymbols,
        lifecycleGates: result.lifecycleGates,
        commandIds: result.commandIds,
        eventNames: result.eventNames,
        frameworks: result.frameworks,
        crossPlugin: result.crossPlugin,
        internalPlugins: result.internalPlugins,
        tierEstimate: result.tierEstimate,
      }, name).toEqual(truth);
    }
  });

  it("reports identical API symbols for the minified and unminified pair", () => {
    const minified = scanBundle("a", readFileSync(join(dir, "minified-tier1", "main.js"), "utf8"));
    const plain = scanBundle("b", readFileSync(join(dir, "unminified-tier1", "main.js"), "utf8"));
    expect(minified.apiSymbols).toEqual(plain.apiSymbols);
    expect(minified.commandIds).toEqual(plain.commandIds);
    expect(minified.tierEstimate).toBe(plain.tierEstimate);
    expect(minified.minified).toBe(true);
    expect(plain.minified).toBe(false);
  });

  it("does not invent frameworks from false-friend substrings", () => {
    const result = scanBundle("ff", readFileSync(join(dir, "false-friend", "main.js"), "utf8"));
    expect(result.frameworks).toEqual([]);
  });

  it("detects a plugin class behind an indirect base class", () => {
    const result = scanBundle("ib", readFileSync(join(dir, "indirect-base", "main.js"), "utf8"));
    expect(result.tierEstimate).toBe(1);
    expect(result.tierReasons).toContain("indirect Plugin base class");
  });

  it("counts against the whole declared surface, not the part one import reaches", () => {
    // The scanner's sixteen side-effect imports are what fill the policy table
    // before the first scan, and dropping one of them fails nothing on its own
    // — the affected members simply stop being counted, everywhere, silently.
    // One member from each family that `shim/api.ts` alone does not reach.
    const source = [
      "document.addEventListener('x', f);", // shim/globals
      "el.on('click', '.sel', f);", // shim/dom (Node.on)
      "app.plugins.getPlugin('other');", // shim/plugin-registry
      "app.internalPlugins.getPluginById('sync');", // shim/internal-plugins
      "shell.openPath('/tmp');", // runtime/electron-stub
      "window.require('electron');", // runtime/intercept
      "vault.modify(file, 'x');", // shim/vault
    ].join("\n");
    const result = scanBundle("surface", source);
    const counted = { ...result.apiSymbols, ...result.genericSymbols };
    expect(Object.keys(counted).sort()).toEqual(
      ["addEventListener", "getPlugin", "getPluginById", "modify", "on", "openPath", "require"].sort(),
    );
  });

  it("keeps everyday JavaScript names out of the specific surface", () => {
    // `.on(` is a declared row (`Node.on`) and also how every plugin
    // subscribes, so it is counted — in the other bucket. The fixture's two
    // `.on(` calls are Obsidian's; a bundle's `map.delete(k)` would land in
    // the same bucket for the opposite reason, and that is the point of it.
    const result = scanBundle("u", readFileSync(join(dir, "unminified-tier1", "main.js"), "utf8"));
    expect(result.apiSymbols["on"]).toBeUndefined();
    expect(result.genericSymbols).toEqual({ on: 2 });
  });

  it("needs all three clauses to call the corpus's bundles right", () => {
    // One synthetic bundle per clause, each satisfying exactly that clause, so
    // removing any one of the three is a failure rather than a survivor. The
    // fixtures cannot do this: `minified-tier1` clears clauses 1 and 2 at once
    // and the plain ones clear none.
    // Measured: 620.5 / 0.000, 9.0 / 1.000, 120.0 / 0.167 — one clause each.
    const longLines = `${"const someDescriptiveName = 1; ".repeat(40)}\n`;
    const shortNames = Array.from({ length: 200 }, (_, i) => `a${String(i % 7)} = b${String(i % 5)};`).join("\n");
    const middling = `${"const alphaValue = betaValue; const gammaValue = ab; ".repeat(3)}\n`.repeat(3);

    expect(scanBundle("l", longLines).minified).toBe(true); // mean line ≥ 200 only
    expect(scanBundle("s", shortNames).minified).toBe(true); // short-id ratio ≥ 0.25 only
    expect(scanBundle("m", middling).minified).toBe(true); // the combined clause only
    // And the plain fixtures satisfy none of the three.
    for (const name of ["unminified-tier1", "menu-only-tier2", "false-friend"]) {
      expect(scanBundle(name, readFileSync(join(dir, name, "main.js"), "utf8")).minified).toBe(false);
    }
  });

  it("sees a builtin whose name carries a digit", () => {
    expect(scanBundle("h", 'const h = require("http2");').requiresNode).toEqual(["http2"]);
    expect(scanBundle("h", 'const h = require("node:http2");').requiresNode).toEqual(["http2"]);
  });

  it("does not count a plugin's own addCommand helper as a command", () => {
    // obsidian-linter's shape: a settings-tab helper with the same name and the
    // same receiver as the registration, told apart by the argument holding no
    // command id.
    const source = [
      'class L extends obsidian.Plugin {',
      '  onload() {',
      '    this.addCommand({ id: "lint", name: "Lint", callback: () => this.app.vault.process(f, t => t) });',
      '    this.addCommand(containerEl, "a description", 3);',
      '  }',
      '}',
    ].join("\n");
    const result = scanBundle("linterish", source);
    expect(result.commandIds).toEqual(["lint"]);
    expect(result.tierEstimate).toBe(1);
    expect(result.tierReasons).toContain(
      "command callbacks hold vault or metadata calls and build no DOM",
    );
  });

  it("separates a menu-only tier 2 from a DOM-delegated tier 2 in tierReasons", () => {
    const harvestable = scanBundle("m", readFileSync(join(dir, "menu-only-tier2", "main.js"), "utf8"));
    const delegated = scanBundle("d", readFileSync(join(dir, "dom-delegated-tier2", "main.js"), "utf8"));
    expect(harvestable.tierEstimate).toBe(2);
    expect(delegated.tierEstimate).toBe(2);
    expect(harvestable.tierReasons).toContain("entry points are harvestable menu hooks");
    expect(delegated.tierReasons).toContain("entry points are DOM-delegated and unreachable headless");
  });
});
