/**
 * The Style Settings parity fixture (`host/fixtures/style-settings/vault/`)
 * must keep one setting of each type, so the capture taken from it covers the
 * plugin's whole surface. This reads the fixture's `@settings` blocks and fails
 * if a type, a variant or a saved-value case is lost. It also compiles the
 * capture script's evals, so a syntax slip is found before the live run.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const REPO = resolve(__dirname, "..", "..", "..", "..");
const VAULT = join(REPO, "host", "fixtures", "style-settings", "vault", ".obsidian");

interface Setting {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface Section {
  name: string;
  id: string;
  settings: Setting[];
}

/** The YAML of every `/* @settings … *\/` block in a stylesheet, parsed. */
function sections(css: string): Section[] {
  const blocks = [...css.matchAll(/\/\*\s*@settings([\s\S]*?)\*\//g)];
  return blocks.map((block) => yaml.load(block[1] ?? "") as Section);
}

const theme = sections(readFileSync(join(VAULT, "themes", "Fixture Theme", "theme.css"), "utf8"));
const snippet = sections(readFileSync(join(VAULT, "snippets", "fixture-snippet.css"), "utf8"));
const css = readFileSync(join(VAULT, "themes", "Fixture Theme", "theme.css"), "utf8");

describe("style-settings fixture", () => {
  it("has one block per source, with the section ids the capture names", () => {
    expect(theme.map((s) => s.id)).toEqual(["fixture-theme"]);
    expect(snippet.map((s) => s.id)).toEqual(["fixture-snippet"]);
    expect(snippet[0]?.settings).toHaveLength(2);
  });

  it("has every setting type in the theme", () => {
    const types = new Set(theme[0]?.settings.map((s) => s.type));
    for (const type of [
      "heading",
      "info-text",
      "class-toggle",
      "class-select",
      "variable-text",
      "variable-number",
      "variable-number-slider",
      "variable-select",
      "variable-color",
      "variable-themed-color",
      "color-gradient",
    ]) {
      expect(types, type).toContain(type);
    }
  });

  it("has the variants the brief names", () => {
    const settings = theme[0]?.settings ?? [];
    const ofType = (type: string) => settings.filter((s) => s.type === type);
    const infos = ofType("info-text");
    expect(infos.some((s) => s.markdown === true)).toBe(true);
    expect(infos.some((s) => s.markdown === undefined)).toBe(true);
    const toggles = ofType("class-toggle");
    expect(toggles.some((s) => s.default === true)).toBe(true);
    expect(toggles.some((s) => s.default === undefined || s.default === false)).toBe(true);
    expect(ofType("class-select")[0]?.default).toBeTruthy();
    const colours = ofType("variable-color");
    expect(colours.some((s) => s.format === "hex")).toBe(true);
    expect(colours.some((s) => s.format === "rgb" && s.opacity === true)).toBe(true);
    const themed = ofType("variable-themed-color");
    expect(themed.length).toBeGreaterThanOrEqual(2);
    for (const s of themed) {
      expect(s["default-light"]).toBeTruthy();
      expect(s["default-dark"]).toBeTruthy();
    }
    const gradient = ofType("color-gradient")[0];
    const themedIds = themed.map((s) => s.id);
    expect(themedIds).toContain(gradient?.from);
    expect(themedIds).toContain(gradient?.to);
  });

  it("uses every setting id in real CSS", () => {
    for (const setting of [...(theme[0]?.settings ?? []), ...(snippet[0]?.settings ?? [])]) {
      if (["heading", "info-text"].includes(setting.type)) continue;
      const body = css.replace(/\/\* @settings[\s\S]*?\*\//, "");
      const snippetCss = readFileSync(join(VAULT, "snippets", "fixture-snippet.css"), "utf8").replace(/\/\* @settings[\s\S]*?\*\//, "");
      const used = `${body}\n${snippetCss}`;
      if (setting.type === "class-select") {
        for (const option of setting["options"] as Array<string | { value: string }>) {
          const value = typeof option === "string" ? option : option.value;
          expect(used, value).toContain(`.${value}`);
        }
      } else if (setting.type === "class-toggle") {
        expect(used, setting.id).toContain(`.${setting.id}`);
      } else if (setting.type === "color-gradient") {
        expect(used, setting.id).toContain(`--${setting.id}-50`);
      } else {
        expect(used, setting.id).toContain(`--${setting.id}`);
      }
    }
  });

  it("saves values for about half the settings, with the four special keys", () => {
    const data = JSON.parse(readFileSync(join(VAULT, "plugins", "obsidian-style-settings", "data.json"), "utf8")) as Record<string, unknown>;
    const keys = Object.keys(data);
    expect(keys.some((k) => k.endsWith("@@light"))).toBe(true);
    expect(keys.some((k) => k.endsWith("@@dark"))).toBe(true);
    const known = new Set([...(theme[0]?.settings ?? []).map((s) => `fixture-theme@@${s.id}`), ...(snippet[0]?.settings ?? []).map((s) => `fixture-snippet@@${s.id}`)]);
    const base = (k: string) => k.replace(/@@(light|dark)$/, "");
    // a key for a setting the theme no longer has, in a section that is loaded
    expect(keys.some((k) => base(k).startsWith("fixture-theme@@") && !known.has(base(k)))).toBe(true);
    // a key for a section that is not loaded
    expect(keys.some((k) => !base(k).startsWith("fixture-theme@@") && !base(k).startsWith("fixture-snippet@@"))).toBe(true);
    const live = new Set(keys.map(base).filter((k) => known.has(k)));
    expect(live.size).toBeGreaterThanOrEqual(known.size / 2 - 2);
    expect(live.size).toBeLessThan(known.size);
  });

  it("enables the theme, the snippet and the plugin", () => {
    const appearance = JSON.parse(readFileSync(join(VAULT, "appearance.json"), "utf8")) as { cssTheme: string; enabledCssSnippets: string[] };
    expect(appearance.cssTheme).toBe("Fixture Theme");
    expect(appearance.enabledCssSnippets).toEqual(["fixture-snippet"]);
    expect(JSON.parse(readFileSync(join(VAULT, "community-plugins.json"), "utf8"))).toEqual(["obsidian-style-settings"]);
  });
});

describe("style-settings capture script", () => {
  const require = createRequire(__filename);
  const script = require(join(REPO, "host", "scripts", "style-settings-capture.js")) as {
    STEPS: Array<[string, string]>;
    STEP_META: string;
    wrapEval: (expected: string, body: string) => string;
  };

  it("builds evals that compile", () => {
    for (const [name, body] of [...script.STEPS, ["meta.json", script.STEP_META]]) {
      // Compiles without running (a vm Script is never run here): a syntax error throws here.
      expect(() => new Script(script.wrapEval("/x", body as string)), name as string).not.toThrow();
    }
  });
});
