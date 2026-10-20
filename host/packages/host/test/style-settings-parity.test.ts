/**
 * The stock Style Settings 1.0.9 bundle over a server DOM reproduces what a
 * live Obsidian 1.14.4 did with the same fixture (task 4 of
 * `docs/design/web-plugins.md`).
 *
 * Compared, in light and in dark mode:
 *
 * - **`body` classes the plugin owns**: `css-settings-manager` plus every
 *   class-toggle id and class-select option, derived from the fixture's
 *   `@settings` blocks. The capture's other classes are the app's.
 * - **The text of `#css-settings-manager`**, exactly. The plugin already
 *   normalises it (`.trim().replace(/[\r\n\s]+/g, " ")` before it writes), so
 *   there is no further normalisation to apply.
 * - **The plugin's values after load**, in memory and as saved by the
 *   load-time prune, against `plugin-data.json`.
 *
 * The run itself is `style-settings-run.ts`; see there for the order of steps
 * and why the plugin parses twice.
 */

import { afterEach, describe, expect, it } from "vitest";

import { EXPECTED, pluginOwnedClasses, runStyleSettings } from "./style-settings-run";
import { happyDomProvider } from "../src/shim/dom-providers/happy-dom";
import type { DomProvider } from "../src/shim/dom-provider";
import type { Mode, StyleSettingsRun } from "./style-settings-run";

/**
 * The screen host's one provider. Task 4 also ran linkedom 0.18.13 here and
 * removed it: see the "Task 4 result" in section 2 of the design.
 */
const PROVIDERS: ReadonlyArray<readonly [string, () => DomProvider]> = [["happy-dom", happyDomProvider]];

const MODES: readonly Mode[] = ["light", "dark"];

const live: StyleSettingsRun[] = [];

afterEach(async () => {
  for (const run of live.splice(0).reverse()) {
    await run.harness.teardown();
    await run.harness.stop();
  }
});

async function run(provider: () => DomProvider, mode: Mode): Promise<StyleSettingsRun> {
  const done = await runStyleSettings(provider(), mode);
  live.push(done);
  return done;
}

describe("the capture this test compares against", () => {
  it("names the Obsidian and plugin versions", () => {
    expect(EXPECTED.meta.obsidian_version).toBe("1.14.4");
    expect(EXPECTED.meta.plugin_version).toBe("1.0.9");
  });

  it("derives the plugin's classes from the fixture, not from the capture", () => {
    const owned = pluginOwnedClasses();
    expect(owned).toContain("css-settings-manager");
    expect(owned).toContain("fx-compact");
    expect(owned).toContain("fx-airy");
    expect(owned).toContain("sn-hide-status");
    expect(owned).not.toContain("mod-macos");
  });
});

describe.each(PROVIDERS)("stock Style Settings over %s", (_name, provider) => {
  describe.each(MODES)("in %s mode", (mode) => {
    it("sets the body classes the capture shows", async () => {
      const done = await run(provider, mode);
      const owned = pluginOwnedClasses();
      const expected = EXPECTED.classes[mode].filter((name) => owned.has(name));
      expect(done.classes.filter((name) => owned.has(name))).toEqual(expected);
      expect(done.classes).toContain(mode === "light" ? "theme-light" : "theme-dark");
      expect(done.harness.hostErrors).toEqual([]);
    });

    it("writes the style text the capture shows", async () => {
      const done = await run(provider, mode);
      expect(done.styleText).toBe(EXPECTED.styleText[mode]);
    });

    it("holds and saves the values the capture shows", async () => {
      const done = await run(provider, mode);
      expect(done.inMemory).toEqual(EXPECTED.pluginData.in_memory);
      expect(done.saved).toEqual(EXPECTED.pluginData.on_disk);
    });
  });
});
