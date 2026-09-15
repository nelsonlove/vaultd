/**
 * The pure helpers the `obsidian` module exports: paths, YAML, frontmatter,
 * links, versions, timing and HTTP.
 *
 * **A file of its own, which the brief did not name.** Task 11b's file list is
 * `notice.ts`, `components.ts`, `search.ts` and `api.ts`, and these eighteen
 * functions belong to none of the first three. Putting them in `api.ts` would
 * bury the policy table — the one thing that file exists to make readable —
 * under four hundred lines of string handling. So they live here and the barrel
 * binds them, which changes nothing about the table.
 *
 * **Everything here is `implemented`, and that word is doing work.** These are
 * the surfaces where a stub would be *wrong* rather than merely empty: a
 * `normalizePath` that did not collapse a double slash hands a plugin a path
 * the daemon will refuse, and a `parseFrontMatterTags` that answered `null` for
 * a note that really has tags tells the plugin the note is untagged. Each one
 * is small enough to get right and too load-bearing to fake.
 */

import { dump, load } from "js-yaml";
import type { CachedMetadata } from "../mirror/metadata";
import type { Clock } from "../config";
import type { Pos } from "../mirror/positions";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A vault path in the one spelling every surface of this host accepts.
 *
 * Backslashes become slashes, runs of slashes collapse, a leading `./` and any
 * leading or trailing slash come off, and the result is NFC-normalised —
 * Obsidian normalises because macOS hands out NFD filenames and a vault written
 * on one machine has to be addressable from another.
 *
 * The empty path answers `"/"`, which is the vault root and is what Obsidian
 * answers. It is the one case where the output is longer than the input, and
 * plugins depend on it: `normalizePath(folder.path)` for the root folder is how
 * half the corpus spells "the whole vault".
 */
export function normalizePath(path: string): string {
  const collapsed = path
    .replace(/[\\/]+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (collapsed === "") return "/";
  return collapsed.normalize("NFC");
}

/**
 * The file part of a link target: everything before a `#` subpath.
 *
 * `[[Note#Heading]]` links to `Note`, `[[#Heading]]` links to the note the link
 * is in — which is why an empty answer is a real answer and not a failure.
 */
export function getLinkpath(linktext: string): string {
  const cut = linktext.indexOf("#");
  if (cut === -1) return linktext;
  return linktext.slice(0, cut);
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/**
 * Obsidian's `parseYaml`, which is `js-yaml`'s `load` — the same library, at
 * the version this package depends on.
 *
 * A document that will not parse throws, exactly as it does in Obsidian: a
 * plugin parsing user-authored YAML wants the `YAMLException`, and a `null`
 * would be indistinguishable from a document that really is empty.
 */
export function parseYaml(yaml: string): unknown {
  return load(yaml);
}

/**
 * Obsidian's `stringifyYaml`.
 *
 * `lineWidth: -1` because the default wraps long lines, and a wrapped link or
 * a wrapped path written back into a note's frontmatter is a value that no
 * longer round-trips through anything reading it as one string.
 */
export function stringifyYaml(value: unknown): string {
  return dump(value, { lineWidth: -1 });
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Obsidian's `FrontMatterInfo`. */
export interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
}

/** The fence a frontmatter block opens and closes with. */
const FENCE = /^---\r?\n/;

/**
 * Where a note's frontmatter is, measured in the note's own text.
 *
 * Offsets rather than lines, because that is what a caller does with them:
 * `content.slice(info.contentStart)` is how a plugin gets the body, and
 * `content.slice(0, info.from) + next + content.slice(info.to)` is how it
 * rewrites the block without touching the rest of the note.
 *
 * A block must open on the very first byte — Obsidian does not recognise
 * frontmatter after a blank line, and neither does the daemon's parser — and
 * must close on a line that is exactly `---`. An unterminated block is not
 * frontmatter.
 */
export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const absent: FrontMatterInfo = { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  const opener = FENCE.exec(content);
  if (opener === null) return absent;
  const from = opener[0].length;
  const closer = /^---(\r?\n|$)/m.exec(content.slice(from));
  if (closer === null) return absent;
  const to = from + closer.index;
  return {
    exists: true,
    frontmatter: content.slice(from, to),
    from,
    to,
    contentStart: to + closer[0].length,
  };
}

/**
 * One frontmatter key, by name or by pattern.
 *
 * The `RegExp` form is Obsidian's and plugins use it for case-insensitive
 * lookups (`/^tags$/i`). A missing key answers `null` rather than `undefined`,
 * which is the shape every caller in the corpus tests against.
 */
export function parseFrontMatterEntry(frontmatter: unknown, key: string | RegExp): unknown {
  const record = asRecord(frontmatter);
  if (record === null) return null;
  if (typeof key === "string") return record[key] ?? null;
  for (const [name, value] of Object.entries(record)) {
    if (key.test(name)) return value;
  }
  return null;
}

/**
 * A frontmatter value as a list of strings, however it was written.
 *
 * YAML lets the same field be a scalar, a comma-separated scalar or a
 * sequence, and notes in the wild are all three. Every form answers a list, and
 * a key that is not there answers `null` — the difference between "no tags" and
 * "a tags field that is empty" is one a plugin is entitled to see.
 */
export function parseFrontMatterStringArray(
  frontmatter: unknown,
  key: string | RegExp,
  nospaces?: boolean,
): string[] | null {
  const value = parseFrontMatterEntry(frontmatter, key);
  if (value === null || value === undefined) return null;
  const parts: string[] = [];
  for (const item of Array.isArray(value) ? (value as unknown[]) : [value]) {
    if (typeof item === "string") {
      // A scalar written `a, b` is two values in Obsidian, and notes written by
      // hand use that form constantly.
      for (const piece of item.split(",")) {
        const trimmed = piece.trim();
        if (trimmed !== "") parts.push(trimmed);
      }
      continue;
    }
    if (typeof item === "number" || typeof item === "boolean") parts.push(String(item));
  }
  if (nospaces === true) return parts.filter((part) => !/\s/.test(part));
  return parts;
}

/** The note's aliases, from either spelling of the key. */
export function parseFrontMatterAliases(frontmatter: unknown): string[] | null {
  const aliases = parseFrontMatterStringArray(frontmatter, /^alias(es)?$/i);
  if (aliases !== null) return aliases;
  return null;
}

/**
 * The note's frontmatter tags, each with its `#`.
 *
 * The `#` is added because `cache.tags` — the body tags — carry one, and a
 * caller merging the two lists must not have to know which half it is holding.
 * A tag already written with a `#` in the frontmatter keeps exactly one.
 */
export function parseFrontMatterTags(frontmatter: unknown): string[] | null {
  const tags = parseFrontMatterStringArray(frontmatter, /^tags?$/i, true);
  if (tags === null) return null;
  return tags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
}

/**
 * Every tag on a note: the body's and the frontmatter's, deduplicated.
 *
 * `null` for a cache that is not there at all, which is what `getFileCache`
 * answers for a file the mirror has never seen — a plugin that wrote
 * `getAllTags(cache).length` against a missing file is asking for the crash it
 * gets, and inventing `[]` would hide the missing file instead.
 */
export function getAllTags(cache: CachedMetadata | null): string[] | null {
  if (cache === null) return null;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of cache.tags ?? []) {
    if (seen.has(entry.tag)) continue;
    seen.add(entry.tag);
    tags.push(entry.tag);
  }
  for (const tag of parseFrontMatterTags(cache.frontmatter) ?? []) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Subpaths
// ---------------------------------------------------------------------------

/** What `resolveSubpath` answers for a heading, and for a block. */
export interface HeadingSubpathResult {
  type: "heading";
  current: { heading: string; level: number; position: Pos };
  next: { heading: string; level: number; position: Pos } | null;
  start: Pos;
  end: Pos | null;
}

export interface BlockSubpathResult {
  type: "block";
  block: { id: string; position: Pos };
  start: Pos;
  end: Pos | null;
}

export type SubpathResult = HeadingSubpathResult | BlockSubpathResult;

/**
 * Where a `#heading` or a `#^block` lands inside a note.
 *
 * Heading matching is Obsidian's: case-insensitive, on the heading text with
 * its markup already stripped by the parser. The **end** of a heading's span is
 * the start of the next heading at the same level or shallower — that is what
 * makes an embed of `#Section` stop where the section stops — and `null` when
 * there is no such heading, meaning "to the end of the note".
 */
export function resolveSubpath(cache: CachedMetadata, subpath: string): SubpathResult | null {
  const trimmed = subpath.startsWith("#") ? subpath.slice(1) : subpath;
  if (trimmed === "") return null;
  if (trimmed.startsWith("^")) {
    const id = trimmed.slice(1).toLowerCase();
    const block = cache.blocks?.[id];
    if (block === undefined) return null;
    return { type: "block", block: { id, position: block.position }, start: block.position, end: block.position };
  }
  const headings = cache.headings ?? [];
  const wanted = trimmed.toLowerCase();
  const at = headings.findIndex((heading) => heading.heading.toLowerCase() === wanted);
  const current = headings[at];
  if (at === -1 || current === undefined) return null;
  let next: (typeof headings)[number] | null = null;
  for (let index = at + 1; index < headings.length; index += 1) {
    const candidate = headings[index];
    if (candidate === undefined) continue;
    if (candidate.level <= current.level) {
      next = candidate;
      break;
    }
  }
  return {
    type: "heading",
    current: { heading: current.heading, level: current.level, position: current.position },
    next: next === null ? null : { heading: next.heading, level: next.level, position: next.position },
    start: current.position,
    end: next === null ? null : next.position,
  };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * Is `current` at least `required`?
 *
 * Numeric, part by part, with a missing part read as zero — so `"1.9"` is
 * `1.9.0` and compares the way a plugin means it to. A pre-release suffix on
 * either side is ignored rather than refused: this host's own version string
 * carries none, and a plugin comparing against `"1.5.0-beta"` means 1.5.0.
 */
export function atLeastVersion(current: string, required: string): boolean {
  const left = versionParts(current);
  const right = versionParts(required);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function versionParts(version: string): number[] {
  return version
    .split("-")[0]
    ?.split(".")
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    }) ?? [0];
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Obsidian's `Debouncer`: callable, cancellable, and forceable. */
export interface Debouncer<A extends unknown[], R> {
  (...args: A): Debouncer<A, R>;
  cancel(): Debouncer<A, R>;
  run(): R | void;
}

/**
 * `debounce`, armed on **this host's** clock.
 *
 * A factory rather than a free function because the clock is per host: a test
 * that advances its own `TestClock` has to see its own plugin's debounced call
 * fire, and a bare `setTimeout` would arm on the runtime's clock instead —
 * where nothing advances it and the call never lands, or worse, lands after the
 * test has finished.
 *
 * `resetTimer` is Obsidian's parameter and means what it says: when true, every
 * call restarts the wait; when false, the first call sets the deadline and
 * later calls only update the arguments.
 */
export function createDebounce(clock: Clock): DebounceFn {
  function debounce<A extends unknown[], R>(
    callback: (...args: A) => R,
    timeout = 0,
    resetTimer = false,
  ): Debouncer<A, R> {
    let handle: NodeJS.Timeout | null = null;
    let pending: A | null = null;

    const fire = (): void => {
      handle = null;
      const args = pending;
      pending = null;
      if (args !== null) callback(...args);
    };

    const debounced = ((...args: A): Debouncer<A, R> => {
      pending = args;
      if (handle !== null) {
        if (!resetTimer) return debounced;
        clock.clearTimeout(handle);
      }
      handle = clock.setTimeout(fire, timeout);
      return debounced;
    }) as Debouncer<A, R>;

    debounced.cancel = (): Debouncer<A, R> => {
      if (handle !== null) clock.clearTimeout(handle);
      handle = null;
      pending = null;
      return debounced;
    };

    /** Fire now if something is pending, and answer what the callback did. */
    debounced.run = (): R | void => {
      if (handle !== null) clock.clearTimeout(handle);
      handle = null;
      const args = pending;
      pending = null;
      if (args === null) return undefined;
      return callback(...args);
    };

    return debounced;
  }
  return debounce;
}

/** The shape {@link createDebounce} hands back. */
export interface DebounceFn {
  <A extends unknown[], R>(
    callback: (...args: A) => R,
    timeout?: number,
    resetTimer?: boolean,
  ): Debouncer<A, R>;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Obsidian's `RequestUrlParam`. */
export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

/** Obsidian's `RequestUrlResponse`: fields, not methods. */
export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

/**
 * A real HTTP request, because there is nothing headless about one.
 *
 * Obsidian's `requestUrl` exists to bypass the renderer's CORS rules; a Node
 * process has none to bypass, so the honest implementation is the request
 * itself. `throw` defaults to **true**, which is Obsidian's default: a 4xx
 * rejects unless the caller said it wanted to inspect the status.
 *
 * The response body is read once and served three ways, because
 * `RequestUrlResponse`'s `text`, `json` and `arrayBuffer` are fields that are
 * all readable on the same response — a plugin reading `.text` after `.json` is
 * ordinary, and a body that could only be read once would give it an empty
 * string.
 */
export async function requestUrl(param: string | RequestUrlParam): Promise<RequestUrlResponse> {
  const request = typeof param === "string" ? { url: param } : param;
  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  if (request.contentType !== undefined) headers["Content-Type"] = request.contentType;
  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(buffer);
  const answered: RequestUrlResponse = {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    arrayBuffer: buffer,
    get json(): unknown {
      // Lazy, and deliberately not caught: a caller reading `.json` off a
      // response that is not JSON wants the parse error, not a `null` it will
      // rediscover three frames later.
      return JSON.parse(text) as unknown;
    },
    text,
  };
  if ((request.throw ?? true) && response.status >= 400) {
    throw new Error(`Request failed, status ${String(response.status)}`);
  }
  return answered;
}

/** The text-only spelling of {@link requestUrl}. */
export async function request(param: string | RequestUrlParam): Promise<string> {
  return (await requestUrl(param)).text;
}

// ---------------------------------------------------------------------------
// The environment a plugin asks about
// ---------------------------------------------------------------------------

/**
 * `Platform`, answered as a desktop application.
 *
 * Because that is what this host is: a Node process on a desktop operating
 * system, with a real file system behind the daemon and no touch input. Several
 * plugins branch on `isMobile` to pick a storage path or to skip a feature, and
 * answering "mobile" would send them down the path meant for a sandbox this
 * host is not.
 */
export const Platform = Object.freeze({
  isDesktop: true,
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
  isPhone: false,
  isTablet: false,
  isIosApp: false,
  isAndroidApp: false,
  isMacOS: process.platform === "darwin",
  isWin: process.platform === "win32",
  isLinux: process.platform === "linux",
  isSafari: false,
  resourcePathPrefix: "app://local/",
});

/**
 * The display language, which is English.
 *
 * **Uncaptured.** Obsidian answers whatever the user chose in its own settings,
 * and this host has no such setting to read. `"en"` is the least-harm answer: a
 * plugin uses it to pick a translation bundle, every bundle in the corpus has
 * an English one, and a code naming a language the bundle lacks would fall back
 * to English anyway — through a path that is less tested than the direct one.
 */
export function getLanguage(): string {
  return "en";
}

/** A frontmatter object, or `null` for anything that is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
