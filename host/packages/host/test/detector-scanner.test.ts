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

  it("separates a menu-only tier 2 from a DOM-delegated tier 2 in tierReasons", () => {
    const harvestable = scanBundle("m", readFileSync(join(dir, "menu-only-tier2", "main.js"), "utf8"));
    const delegated = scanBundle("d", readFileSync(join(dir, "dom-delegated-tier2", "main.js"), "utf8"));
    expect(harvestable.tierEstimate).toBe(2);
    expect(delegated.tierEstimate).toBe(2);
    expect(harvestable.tierReasons).toContain("entry points are harvestable menu hooks");
    expect(delegated.tierReasons).toContain("entry points are DOM-delegated and unreachable headless");
  });
});
