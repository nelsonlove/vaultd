import { createHash } from "node:crypto";

/**
 * The stylesheet set a page is styled with, in Obsidian's order
 * (docs/design/web-plugins.md, section 4 and edge case E8).
 *
 * The order is the theme, then the enabled snippets, then each enabled
 * community plugin's `styles.css`. Every sheet is the text of one `<style>`
 * element: Style Settings reads `ownerNode.textContent`, so a `<link>` would
 * hide its `@settings` blocks (E1).
 *
 * Plain code with no host imports, so the web server can `require` the
 * compiled `dist/web/sheet-set.js` and build the same set the screen host is
 * asked to apply. It reads the vault through a function it is given; it never
 * reads a file itself.
 *
 * **Not checked against Obsidian:** the snippet order. This takes the order of
 * `enabledCssSnippets` (or of the viewer's override). Obsidian may instead
 * apply them in the order of its snippet folder listing.
 */

export type Mode = "light" | "dark";

/** One stylesheet: a stable id (`theme:<name>`, `snippet:<name>`, `plugin:<id>`) and its text. */
export interface Sheet {
  readonly id: string;
  readonly text: string;
}

/**
 * What a viewer changed in the appearance settings. Every field is optional;
 * an absent field means "as the vault says".
 *
 * - `theme`: the community theme's name; `""` is Obsidian's default theme.
 * - `mode`: `"light"` or `"dark"`.
 * - `snippets`: the enabled snippet names, replacing the vault's list.
 */
export interface AppearanceOverride {
  readonly theme?: string;
  readonly mode?: Mode;
  readonly snippets?: readonly string[];
}

/** Reads one vault-relative file as text, or `null` when it is not there. */
export type ReadVaultText = (vaultPath: string) => Promise<string | null>;

export interface SheetSetOptions {
  /** The vault's config directory. Default `.obsidian`. */
  readonly configDir?: string;
  /** The mode for `"theme": "system"` or no theme key. Default `"light"`. */
  readonly systemMode?: Mode;
}

export interface SheetSet {
  readonly sheets: Sheet[];
  readonly mode: Mode;
  /** Theme and snippet files the appearance names that are not there. */
  readonly missing: string[];
}

interface Appearance {
  cssTheme?: unknown;
  theme?: unknown;
  enabledCssSnippets?: unknown;
}

/** Build the set from `<configDir>/appearance.json`, the enabled plugin list and `override`. */
export async function buildSheetSet(
  read: ReadVaultText,
  override: AppearanceOverride = {},
  options: SheetSetOptions = {},
): Promise<SheetSet> {
  checkOverride(override);
  const configDir = options.configDir ?? ".obsidian";
  const appearance = parseObject<Appearance>(await read(`${configDir}/appearance.json`)) ?? {};

  const themeName = override.theme ?? (typeof appearance.cssTheme === "string" ? appearance.cssTheme : "");
  const snippetNames =
    override.snippets ??
    (Array.isArray(appearance.enabledCssSnippets)
      ? appearance.enabledCssSnippets.filter((name): name is string => typeof name === "string")
      : []);
  const mode = override.mode ?? modeOf(appearance.theme, options.systemMode ?? "light");

  const sheets: Sheet[] = [];
  const missing: string[] = [];
  const add = async (id: string, path: string, required: boolean): Promise<void> => {
    const text = await read(path);
    if (text === null) {
      if (required) missing.push(path);
      return;
    }
    sheets.push({ id, text });
  };

  if (themeName !== "") {
    checkName(themeName, "theme");
    await add(`theme:${themeName}`, `${configDir}/themes/${themeName}/theme.css`, true);
  }
  for (const name of snippetNames) {
    checkName(name, "snippet");
    await add(`snippet:${name}`, `${configDir}/snippets/${name}.css`, true);
  }
  const plugins = parseArray(await read(`${configDir}/community-plugins.json`));
  for (const id of plugins) {
    if (!isPlainName(id)) continue;
    // A plugin with no `styles.css` is ordinary, so its absence is not "missing".
    await add(`plugin:${id}`, `${configDir}/plugins/${id}/styles.css`, false);
  }
  return { sheets, mode, missing };
}

/**
 * A digest of the whole set: every id, every text and their order. Two sets
 * with the same digest style a page the same way.
 */
export function sheetSetHash(sheets: readonly Sheet[]): string {
  const hash = createHash("sha256");
  for (const sheet of sheets) {
    // Length-prefixed, so no id/text boundary can be moved without a change.
    for (const part of [sheet.id, sheet.text]) {
      const bytes = Buffer.from(part, "utf8");
      hash.update(`${String(bytes.length)}:`);
      hash.update(bytes);
    }
  }
  return hash.digest("hex");
}

/** `"obsidian"` is dark and `"moonstone"` is light; anything else is the system's mode. */
function modeOf(theme: unknown, systemMode: Mode): Mode {
  if (theme === "obsidian") return "dark";
  if (theme === "moonstone") return "light";
  return systemMode;
}

function checkOverride(override: AppearanceOverride): void {
  if (typeof override !== "object" || override === null) {
    throw new TypeError("the appearance override must be an object");
  }
  if (override.theme !== undefined && typeof override.theme !== "string") {
    throw new TypeError("the override's theme must be a string");
  }
  if (override.mode !== undefined && override.mode !== "light" && override.mode !== "dark") {
    throw new TypeError('the override\'s mode must be "light" or "dark"');
  }
  if (
    override.snippets !== undefined &&
    (!Array.isArray(override.snippets) || !override.snippets.every((name) => typeof name === "string"))
  ) {
    throw new TypeError("the override's snippets must be an array of names");
  }
}

/** A theme, snippet or plugin name is one path segment, never a way out of its folder. */
function isPlainName(name: unknown): name is string {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

function checkName(name: string, what: string): void {
  if (!isPlainName(name)) throw new TypeError(`the ${what} name ${JSON.stringify(name)} is not one folder entry`);
}

function parseObject<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

function parseArray(text: string | null): unknown[] {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
