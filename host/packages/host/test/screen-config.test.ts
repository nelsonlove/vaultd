/**
 * Which `config_changed` paths make the screen host read `.obsidian` again
 * (task 8 of `docs/design/web-plugins.md`).
 */

import { describe, expect, it } from "vitest";

import { affectsScreen } from "../src/screen/screen-host";

describe("affectsScreen", () => {
  it.each([
    ".obsidian",
    ".obsidian/appearance.json",
    ".obsidian/community-plugins.json",
    ".obsidian/themes",
    ".obsidian/themes/Minimal",
    ".obsidian/themes/Minimal/theme.css",
    ".obsidian/snippets",
    ".obsidian/snippets/wide.css",
    ".obsidian/plugins",
    ".obsidian/plugins/obsidian-style-settings",
    ".obsidian/plugins/obsidian-style-settings/data.json",
    ".obsidian/plugins/obsidian-style-settings/main.js",
    ".obsidian/plugins/obsidian-style-settings/manifest.json",
    ".obsidian/plugins/other-plugin/styles.css",
  ])("%s can change the output", (path) => {
    expect(affectsScreen(path)).toBe(true);
  });

  it.each([
    ".obsidian/app.json",
    ".obsidian/workspace.json",
    ".obsidian/types.json",
    ".obsidian/plugins/other-plugin/data.json.tmp",
    ".obsidian/plugins/other-plugin/sub/styles.css",
    ".obsidian-headless/appearance.json",
    "notes/appearance.json",
    "",
  ])("%s cannot", (path) => {
    expect(affectsScreen(path)).toBe(false);
  });

  it("follows another config directory", () => {
    expect(affectsScreen(".config/appearance.json", ".config")).toBe(true);
    expect(affectsScreen(".obsidian/appearance.json", ".config")).toBe(false);
  });
});
