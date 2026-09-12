/**
 * `app.metadataCache` — the surface plugins read the parse through.
 *
 * The assembly itself lives in `mirror/metadata.ts` and is a pure function; this
 * file is the facade around it: it finds the row, finds the position index,
 * memoizes the result, and answers the handful of link-graph questions that are
 * the mirror's to answer rather than the assembler's.
 *
 * ## Why the undocumented methods are here
 *
 * `getCache` is **documented public since 0.14.5**; only `getCachedFiles` and
 * `getTags` are genuinely undocumented, and both are load-bearing. Measured
 * against the shipped bundle, tag-wrangler's `onLayoutReady` does four things:
 * `getCachedFiles().forEach(path => getCache(path)?.frontmatter)`, then
 * `registerEvent(metadataCache.on("changed", …))`, then
 * `registerEvent(vault.on("delete", …))`, then
 * `workspace.getLeavesOfType("tag").forEach(leaf => leaf?.view?.requestUpdateTags?.())`.
 * A shim missing `getCachedFiles` harvests nothing from it, a shim whose
 * `getLeavesOfType` returns `undefined` throws inside its `onLayoutReady`, and a
 * shim whose `changed` / `delete` events never fire leaves its alias index
 * frozen at boot. The first two are answered here, the events by Task 15, and
 * the leaf list by Task 11a.
 *
 * ## `null` is a real answer
 *
 * `getFileCache` returns `null` when the mirror has no row for the path **or**
 * no position index for it. That is Obsidian's own contract for a file it has
 * not cached yet, not an invention: a position index exists only once the
 * note's source has been read (`Mirror.warmPositions`), and Task 15 fires
 * `resolved` only after that completes, so no plugin observes the gap through
 * the gate that means "complete". The mirror re-warms a changed note after an
 * apply, so the state is transient in every other case too.
 *
 * ## The memo is keyed by revision, never by time
 *
 * Twenty-seven plugins call `getFileCache`, and quickadd calls it **26** times
 * in one bundle (measured 2026-08-30 against the shipped `quickadd/main.js`),
 * so a hot handler must not rebuild the same cache twice. The memo is keyed by
 * the row's content revision: a row whose revision has not moved parses to the
 * same cache, and a row whose revision has moved invalidates itself. Nothing
 * expires on a timer, because a timer would either be wrong or be a guess.
 *
 * ## This surface does not subscribe to the mirror
 *
 * `Mirror.onBatch` belongs to Task 15's lifecycle sequencer, which is the one
 * place allowed to turn a change batch into an ordered run of events. So this
 * class reads the mirror on demand and exposes {@link MetadataCache.notifyChanged}
 * and {@link MetadataCache.notifyDeleted} as the seams that sequencer calls.
 * Two subscribers turning one batch into two event streams is the race the
 * single-sequencer rule exists to prevent.
 */

import { Events } from "./events";
import { TFile } from "./files";
import { buildCachedMetadata, referenceCacheOf } from "../mirror/metadata";
import { declarePolicy, recordUse } from "./policy";
import type { EventCallback, EventRef, ShimEventBus } from "./events";
import type { FileIndex } from "./files";
import type { CachedMetadata, LinkCache } from "../mirror/metadata";
import type { MirrorQuery } from "../mirror/types";

export interface MetadataCacheDeps {
  readonly mirror: MirrorQuery;
  readonly events: ShimEventBus;
  readonly index: FileIndex;
}

/** The four `MetadataCache` events Obsidian fires. */
export type MetadataCacheEvent = "changed" | "deleted" | "resolve" | "resolved";

/**
 * Obsidian's `CustomArrayDict`: a `Record<string, T[]>` with a few methods
 * bolted on, which is what `getBacklinksForFile` answers with.
 *
 * A plain object would fail every plugin that calls `.keys()` or `.count()` on
 * the result — dataview and breadcrumbs both do — so it is a real class with
 * the data exposed under `data`, exactly as the application has it.
 */
export class CustomArrayDict<T> {
  readonly data: Record<string, T[]> = {};

  add(key: string, value: T): void {
    const bucket = this.data[key];
    if (bucket === undefined) this.data[key] = [value];
    else bucket.push(value);
  }

  get(key: string): T[] | null {
    return this.data[key] ?? null;
  }

  keys(): string[] {
    return Object.keys(this.data);
  }

  /**
   * How many **keys** the dict holds — source notes, not references.
   *
   * Obsidian's own `CustomArrayDict` is undocumented and this host has not
   * disassembled it, so this is the reading the plan pinned rather than a claim
   * about the application's internals: `getBacklinksForFile` on a target linked
   * once from one note counts `1`. If a plugin is ever found relying on the
   * other reading, the fixture that proves it is what changes this.
   */
  count(): number {
    return Object.keys(this.data).length;
  }

  clear(key: string): void {
    delete this.data[key];
  }

  clearAll(): void {
    for (const key of Object.keys(this.data)) delete this.data[key];
  }
}

/** One memoized build, and the revision that makes it still valid. */
interface Memo {
  readonly revision: string;
  readonly cache: CachedMetadata;
}

export class MetadataCache extends Events {
  private readonly memo = new Map<string, Memo>();

  constructor(private readonly deps: MetadataCacheDeps) {
    super(deps.events);
    declarePolicies();
  }

  // --- Reading the parse ----------------------------------------------------

  getFileCache(file: TFile): CachedMetadata | null {
    recordUse("MetadataCache.getFileCache");
    return this.cacheFor(file.path);
  }

  /** Documented public since 0.14.5, and the path-keyed twin of the above. */
  getCache(path: string): CachedMetadata | null {
    recordUse("MetadataCache.getCache");
    return this.cacheFor(path);
  }

  /**
   * Every path this cache can answer for.
   *
   * The note rows the mirror holds, which is what "cached" means here. A path
   * listed may still answer `null` from {@link getCache} while its position
   * index is cold — the same transient window {@link getFileCache} documents —
   * so a caller that iterates these and reads each one must tolerate `null`,
   * exactly as tag-wrangler's `getCache(path)?.frontmatter` already does.
   */
  getCachedFiles(): string[] {
    recordUse("MetadataCache.getCachedFiles");
    const paths: string[] = [];
    for (const entry of this.deps.mirror.entries()) {
      if (entry.kind !== "note") continue;
      if (this.deps.mirror.note(entry.path) === undefined) continue;
      paths.push(entry.path);
    }
    return paths;
  }

  /**
   * Every tag in the vault against how many times it occurs, `#` included.
   *
   * **Body tags and frontmatter tags both count**, because Obsidian's own tag
   * pane counts both — a note tagged only through `tags:` in its frontmatter is
   * not an untagged note. That is why this reads the mirror's rows rather than
   * the assembled caches, where a frontmatter tag deliberately does not appear
   * under `tags` (it lives in `frontmatter.tags`). Reading rows also means the
   * answer does not depend on whether a note's position index is warm.
   */
  getTags(): Record<string, number> {
    recordUse("MetadataCache.getTags");
    const counts: Record<string, number> = {};
    for (const entry of this.deps.mirror.entries()) {
      if (entry.kind !== "note") continue;
      const row = this.deps.mirror.note(entry.path);
      if (row === undefined) continue;
      for (const tag of row.tags) {
        const key = `#${tag.value}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }

  // --- The link graph -------------------------------------------------------

  /**
   * Obsidian's link resolution, answered by the mirror rather than guessed here.
   *
   * `Mirror.firstLinkpathDest` consults the daemon's own answer for the source
   * note first and only falls back to a name search for a linkpath that is not
   * written in it — so a link a plugin read out of the cache resolves the way
   * the index says it resolves, not the way a filename comparison would.
   */
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    recordUse("MetadataCache.getFirstLinkpathDest");
    const entry = this.deps.mirror.firstLinkpathDest(linkpath, sourcePath);
    if (entry === undefined) return null;
    const file = this.deps.index.get(entry.path);
    return file instanceof TFile ? file : null;
  }

  /**
   * The shortest link text that still reaches `file` from `sourcePath`.
   *
   * Obsidian's rule, and the one every "insert a link" plugin depends on: use
   * the bare name when the bare name resolves back to this very file, and the
   * full path when it does not because another file shares the name. The `.md`
   * extension is dropped unless the caller says otherwise, which is what
   * `omitMdExtension` defaulting to `true` means.
   */
  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension?: boolean): string {
    recordUse("MetadataCache.fileToLinktext");
    const omit = omitMdExtension !== false && file.extension.toLowerCase() === "md";
    const name = omit ? file.basename : file.name;
    const path = omit ? file.path.slice(0, file.path.length - file.extension.length - 1) : file.path;
    return this.getFirstLinkpathDest(name, sourcePath)?.path === file.path ? name : path;
  }

  /**
   * The mirror's own table, handed over live rather than copied.
   *
   * `obsidian.d.ts` declares these mutable and the application hands out its
   * own objects too, so a plugin that walks a vault-sized table pays nothing
   * here either. The mirror rebuilds the table whenever its link epoch moves,
   * so a plugin that scribbles on one is scribbling on a value that is about to
   * be replaced rather than on the mirror's own indexes.
   */
  get resolvedLinks(): Record<string, Record<string, number>> {
    recordUse("MetadataCache.resolvedLinks");
    return this.deps.mirror.resolvedLinks();
  }

  get unresolvedLinks(): Record<string, Record<string, number>> {
    recordUse("MetadataCache.unresolvedLinks");
    return this.deps.mirror.unresolvedLinks();
  }

  /**
   * Every reference that points at `file`, grouped by the note it was written in.
   *
   * Each entry is converted with the **source** note's position index, because
   * that is the note the span is an offset into. A source whose index is still
   * cold contributes nothing rather than a fabricated position: a wrong offset
   * is a string slice in the wrong place, which is worse than a backlink that
   * arrives one warm-up later.
   */
  getBacklinksForFile(file: TFile): CustomArrayDict<LinkCache> {
    recordUse("MetadataCache.getBacklinksForFile");
    const dict = new CustomArrayDict<LinkCache>();
    for (const reference of this.deps.mirror.backlinks(file.path)) {
      const positions = this.deps.mirror.positions(reference.source_path);
      if (positions === undefined) continue;
      dict.add(reference.source_path, referenceCacheOf(reference, positions));
    }
    return dict;
  }

  // --- Events ---------------------------------------------------------------

  override on(name: MetadataCacheEvent, callback: EventCallback, context?: unknown): EventRef {
    return super.on(name, callback, context);
  }

  protected override prefix(): string {
    return "metadataCache";
  }

  /**
   * Fire `changed` for one note, in Obsidian's argument order: `(file, data,
   * cache)`.
   *
   * `data` is the note's new source, which the mirror has already read to
   * rebuild the position index, so the event costs no extra round trip. The
   * memo is dropped first, so a handler that calls `getFileCache` inside the
   * event sees the same object the event carried rather than the previous one.
   *
   * **Called by Task 15's lifecycle sequencer, not by a subscription here** —
   * see the module doc.
   */
  notifyChanged(file: TFile, data: string): void {
    this.memo.delete(file.path);
    this.trigger("changed", ...([file, data, this.cacheFor(file.path)] as never[]));
  }

  /**
   * Fire `deleted` for one note, carrying the cache it had before it went.
   *
   * Obsidian hands the handler the *previous* cache, which is the only thing
   * left to identify what was lost; the mirror's row is already gone by then,
   * so the value is taken from the memo before it is dropped.
   */
  notifyDeleted(file: TFile): void {
    const previous = this.memo.get(file.path)?.cache ?? null;
    this.memo.delete(file.path);
    this.trigger("deleted", ...([file, previous] as never[]));
  }

  /** Drop one path's memo without firing anything. */
  forget(path: string): void {
    this.memo.delete(path);
  }

  // --- Internals ------------------------------------------------------------

  private cacheFor(path: string): CachedMetadata | null {
    const row = this.deps.mirror.note(path);
    if (row === undefined) return null;
    const positions = this.deps.mirror.positions(path);
    if (positions === undefined) return null;
    const memo = this.memo.get(path);
    if (memo !== undefined && memo.revision === row.revision) return memo.cache;
    const cache = buildCachedMetadata(row, positions);
    this.memo.set(path, { revision: row.revision, cache });
    return cache;
  }
}

/**
 * What this surface claims about itself, for Task 11b's compatibility report.
 *
 * The three `CachedMetadata.*` rows are the fields `vaultd` does not parse:
 * `absent` rather than missing from the table, so the report can say the gap
 * exists instead of being silent about it. The rest are the surface this file
 * really implements, listed whether or not a plugin ever calls one — the report
 * is a claim about the host, not a trace of one session.
 *
 * **Called from the constructor, not at module load**, because the policy table
 * is module-level process-wide state: declaring on import would put these rows
 * in the table of every test whose import graph happens to reach this file,
 * including `policy.test.ts`, which pins `declaredSymbols()` to exactly what it
 * declared itself. Declaring when a `MetadataCache` is built ties the rows to a
 * host that really has this surface, and `assembleShim` builds exactly one.
 */
function declarePolicies(): void {
  declarePolicy("MetadataCache.getFileCache", "implemented");
  declarePolicy("MetadataCache.getCache", "implemented");
  declarePolicy("MetadataCache.getCachedFiles", "implemented");
  declarePolicy("MetadataCache.getTags", "implemented");
  declarePolicy("MetadataCache.getFirstLinkpathDest", "implemented");
  declarePolicy("MetadataCache.fileToLinktext", "implemented");
  declarePolicy("MetadataCache.resolvedLinks", "implemented");
  declarePolicy("MetadataCache.unresolvedLinks", "implemented");
  declarePolicy("MetadataCache.getBacklinksForFile", "implemented");
  declarePolicy("CachedMetadata.footnotes", "absent");
  declarePolicy("CachedMetadata.footnoteRefs", "absent");
  declarePolicy("CachedMetadata.referenceLinks", "absent");
}
