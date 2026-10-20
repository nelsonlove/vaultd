/**
 * The stylesheet set in Obsidian's order (task 6 of `docs/design/web-plugins.md`,
 * edge case E8): the theme, then the enabled snippets, then the enabled
 * plugins' `styles.css`, built from `.obsidian/appearance.json` and a viewer's
 * appearance override.
 */

import { describe, expect, it } from "vitest";

import { buildSheetSet, sheetSetHash } from "../src/web/sheet-set";

/** A vault read as a map of vault-relative paths; a missing path reads `null`. */
function reader(files: Record<string, string>): (path: string) => Promise<string | null> {
  return (path) => Promise.resolve(files[path] ?? null);
}

const VAULT: Record<string, string> = {
  ".obsidian/appearance.json": JSON.stringify({
    cssTheme: "Minimal",
    theme: "obsidian",
    enabledCssSnippets: ["b-snippet", "a-snippet"],
  }),
  ".obsidian/community-plugins.json": JSON.stringify(["obsidian-style-settings", "no-styles"]),
  ".obsidian/themes/Minimal/theme.css": "/* minimal */",
  ".obsidian/themes/Other/theme.css": "/* other */",
  ".obsidian/snippets/a-snippet.css": "/* a */",
  ".obsidian/snippets/b-snippet.css": "/* b */",
  ".obsidian/snippets/c-snippet.css": "/* c */",
  ".obsidian/plugins/obsidian-style-settings/styles.css": "/* ss */",
};

describe("buildSheetSet", () => {
  it("puts the theme, then the enabled snippets, then enabled plugins' styles.css", async () => {
    const set = await buildSheetSet(reader(VAULT));
    expect(set.sheets).toEqual([
      { id: "theme:Minimal", text: "/* minimal */" },
      { id: "snippet:b-snippet", text: "/* b */" },
      { id: "snippet:a-snippet", text: "/* a */" },
      { id: "plugin:obsidian-style-settings", text: "/* ss */" },
    ]);
    // `no-styles` has no styles.css: that is ordinary, not a missing sheet.
    expect(set.missing).toEqual([]);
  });

  it("takes the mode from appearance.json's theme", async () => {
    expect((await buildSheetSet(reader(VAULT))).mode).toBe("dark");
    const light = { ...VAULT, ".obsidian/appearance.json": JSON.stringify({ theme: "moonstone" }) };
    expect((await buildSheetSet(reader(light))).mode).toBe("light");
    const system = { ...VAULT, ".obsidian/appearance.json": JSON.stringify({ theme: "system" }) };
    expect((await buildSheetSet(reader(system))).mode).toBe("light");
    expect((await buildSheetSet(reader(system), {}, { systemMode: "dark" })).mode).toBe("dark");
  });

  it("lets the viewer's override replace the theme, the mode and the snippet list", async () => {
    const set = await buildSheetSet(reader(VAULT), { theme: "Other", mode: "light", snippets: ["c-snippet"] });
    expect(set.mode).toBe("light");
    expect(set.sheets.map((sheet) => sheet.id)).toEqual([
      "theme:Other",
      "snippet:c-snippet",
      "plugin:obsidian-style-settings",
    ]);
  });

  it("drops the theme for the default theme (an empty name)", async () => {
    const set = await buildSheetSet(reader(VAULT), { theme: "" });
    expect(set.sheets.map((sheet) => sheet.id)).toEqual([
      "snippet:b-snippet",
      "snippet:a-snippet",
      "plugin:obsidian-style-settings",
    ]);
  });

  it("names a theme or snippet file that is missing, and leaves it out", async () => {
    const set = await buildSheetSet(reader(VAULT), { theme: "Gone", snippets: ["nope", "a-snippet"] });
    expect(set.sheets.map((sheet) => sheet.id)).toEqual(["snippet:a-snippet", "plugin:obsidian-style-settings"]);
    expect(set.missing).toEqual([".obsidian/themes/Gone/theme.css", ".obsidian/snippets/nope.css"]);
  });

  it("reads a vault with no appearance.json or plugin list as the default theme and no sheets", async () => {
    const set = await buildSheetSet(reader({}));
    expect(set.sheets).toEqual([]);
    expect(set.mode).toBe("light");
  });

  it("refuses an override of the wrong shape", async () => {
    await expect(buildSheetSet(reader(VAULT), { mode: "sepia" } as never)).rejects.toThrow(/mode/);
    await expect(buildSheetSet(reader(VAULT), { snippets: "a" } as never)).rejects.toThrow(/snippets/);
    await expect(buildSheetSet(reader(VAULT), { theme: 3 } as never)).rejects.toThrow(/theme/);
  });

  it("refuses a theme or snippet name that would leave its folder", async () => {
    await expect(buildSheetSet(reader(VAULT), { theme: "../x" })).rejects.toThrow(/theme/);
    await expect(buildSheetSet(reader(VAULT), { snippets: ["a/../../b"] })).rejects.toThrow(/snippet/);
  });

  it("reads another config directory when told to", async () => {
    const set = await buildSheetSet(
      reader({ ".alt/appearance.json": JSON.stringify({ cssTheme: "T" }), ".alt/themes/T/theme.css": "t" }),
      {},
      { configDir: ".alt" },
    );
    expect(set.sheets).toEqual([{ id: "theme:T", text: "t" }]);
  });
});

describe("sheetSetHash", () => {
  it("changes with any id, any text or the order, and not otherwise", () => {
    const base = [
      { id: "theme:A", text: "a" },
      { id: "snippet:b", text: "b" },
    ];
    const hash = sheetSetHash(base);
    expect(sheetSetHash(base.map((sheet) => ({ ...sheet })))).toBe(hash);
    expect(sheetSetHash([base[1]!, base[0]!])).not.toBe(hash);
    expect(sheetSetHash([{ id: "theme:A", text: "a2" }, base[1]!])).not.toBe(hash);
    expect(sheetSetHash([{ id: "theme:Z", text: "a" }, base[1]!])).not.toBe(hash);
    // No ambiguity at the boundary between an id and its text.
    expect(sheetSetHash([{ id: "a", text: "bc" }])).not.toBe(sheetSetHash([{ id: "ab", text: "c" }]));
  });
});
