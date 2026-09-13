/**
 * One mirror row plus one position index in, Obsidian's `CachedMetadata` out.
 *
 * **Pure, and that is the whole design.** No host, no daemon, no plugin, no
 * clock: {@link buildCachedMetadata} is a function of a {@link MirrorNoteRow}
 * and a {@link PositionIndex}, which is what lets the Task 0 parity fixtures —
 * eighteen `CachedMetadata` objects captured from a live stock Obsidian 1.13.4
 * through `app.metadataCache.getFileCache` — drive it directly. A shape this
 * function gets wrong is a shape a plugin reads wrong, and the only way to know
 * is to compare against what the real application answered.
 *
 * ## The three conversions that are easy to get silently wrong
 *
 * 1. **Byte offsets are not string offsets.** `vaultd` reports every span as
 *    half-open UTF-8 byte offsets; Obsidian reports `line`/`col`/`offset` in
 *    UTF-16 code units. They agree only while a note is pure ASCII. Every
 *    position here goes through {@link span}, which converts bytes → UTF-16
 *    through the index, never the reverse. `parity-wide-offsets` is the fixture
 *    that fails the moment the conversion is approximated.
 * 2. **A float arrives as a string.** `PropertyValueDto`'s `float` variant
 *    carries a **string**, because a lossless YAML float has no faithful `f64`
 *    round trip through JSON. `ratio: 3.14` is `{ kind: "float", value: "3.14" }`
 *    on the wire and `3.14` — a JS number — in `frontmatter`.
 * 3. **A frontmatter link has no `position`.** `FrontmatterLinkCache extends
 *    Reference`, not `ReferenceCache`: its fields are exactly `link`,
 *    `original`, optional `displayText`, and `key`. The body branch and the
 *    frontmatter branch are written separately below so they cannot drift back
 *    together; the frontmatter branch never calls {@link span} at all.
 * 4. **`original` is the source, not a rendering of the parts.** It is read out
 *    of {@link PositionIndex.originals}, the exact slice the warm step retained
 *    for each reference span. Reconstructing it from `kind` + `raw_target` +
 *    `display` looks total and is not: `[a](T.md "the title")`,
 *    `[b](<Odd Name.md>)` and `[[Target|]]` all reconstruct short, and
 *    `original` is the field a plugin uses to find and rewrite a link in the
 *    body, so a short one is a find-and-replace that hits the wrong text.
 *
 *    **Those three forms are what guards this, and the parity corpus is not.**
 *    Every reference in the eighteen captures is a plain wikilink, Markdown
 *    link or embed, and all of them reconstruct exactly — so the corpus-wide
 *    "original width equals span width" check in `metadata-parity.test.ts`
 *    stays green even with the reconstruction restored (measured). The cases
 *    that red are `AWKWARD_LINKS_VAULT` in `shim-metadata-cache.test.ts` and
 *    the "refuses to guess" throw case. Capturing a titled, angle-bracketed or
 *    empty-alias link from a live Obsidian would put the forms in the corpus
 *    itself; until then they live in a `withVault` fixture.
 *
 * ## Where frontmatter keys and tag origins come from (Ruling W2)
 *
 * The wire carries no `property_path` on a reference and no `origin` on a tag,
 * and Ruling W2 settled that no protocol change would add them: both are
 * derived here, client-side, by **span containment**.
 *
 * - A reference with `origin === "property"` lies inside exactly one property's
 *   `value_span`. That property's key is the head of `frontmatterLinks[].key`,
 *   and descending the `PropertyValueDto` tree by the same containment test
 *   appends `.0` / `.1` for a sequence element and `.<key>` for a mapping entry
 *   — the dotted shape breadcrumbs reads, pinned by `parity-frontmatter-links`.
 * - A tag whose span lies inside any property's `value_span` is a **frontmatter**
 *   tag and is therefore absent from `cache.tags`: Obsidian puts those in
 *   `frontmatter.tags` and nowhere else, which `parity-tags-frontmatter` proves
 *   by having no `tags` key at all.
 *
 * ## Deliberate divergences from Obsidian, recorded rather than hidden
 *
 * `VAULTD-COMPATIBILITY.md` Tier 1 records four. Two of them reach this
 * function:
 *
 * - **A block id on a list item is not persisted on the item.** `ListItemDto`
 *   has no id field; the id is a `BlockDto` whose span falls inside the item's
 *   span, so {@link buildCachedMetadata} recovers `listItems[].id` by
 *   containment. `parity-blocks` pins it.
 * - **Zero-width phantom sections are not reproduced.** Obsidian can emit
 *   `text` and `element` sections at end of file whose start offset equals
 *   their end offset (`parity-footnotes` shows two). `vaultd` emits no such
 *   section and neither does this function; the parity comparison drops them
 *   from Obsidian's side rather than inventing them here.
 *
 * The other two Tier 1 divergences — no content revision for a non-Markdown
 * file, and a dot-prefixed *file* becoming a tree row — are about the tree, not
 * about this shape.
 *
 * Beyond those two, the parity corpus is **exact** as of `vault-core` 734f500:
 * all eighteen captures match field for field, and the four parser defects this
 * task's first parity run found were fixed there rather than recorded as
 * divergences.
 *
 * ## Fields this phase does not serve
 *
 * `footnotes`, `footnoteRefs` and `referenceLinks` are real `CachedMetadata`
 * fields (since 1.6.6 and 1.8.7) that `vaultd` does not parse. The keys are
 * **omitted entirely**, which is exactly what Obsidian does for a note that has
 * none — so a plugin reading them cannot tell "no footnotes" from "not served".
 * They are declared `absent` in the policy table by `shim/metadata-cache.ts`,
 * they appear in the compatibility report, and `parity-footnotes` measures the
 * gap rather than assuming it is empty.
 */

import { originalOf, span } from "./positions";
import type { Pos, PositionIndex } from "./positions";
import type {
  BlockDto,
  ListItemDto,
  MirrorNoteRow,
  PropertyDto,
  PropertyValueDto,
  ReferenceDto,
  SectionDto,
  SpanDto,
} from "./types";

/**
 * Obsidian's `CachedMetadata`, as this host serves it.
 *
 * Every field is optional and **absent rather than empty** when a note has none
 * of that thing, which is Obsidian's own behaviour: across the eighteen
 * captures, `sections` appears in seventeen and the empty note carries no
 * content field at all.
 */
export interface CachedMetadata {
  links?: LinkCache[];
  embeds?: EmbedCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
  sections?: SectionCache[];
  listItems?: ListItemCache[];
  frontmatter?: Record<string, unknown>;
  frontmatterPosition?: Pos;
  frontmatterLinks?: FrontmatterLinkCache[];
  blocks?: Record<string, BlockCache>;
  /**
   * Obsidian's cache-format marker, and the one field that appears **only** on
   * a note with nothing else to report.
   *
   * `parity-empty.md` is zero bytes and its whole captured cache is `{ "v": 1 }`
   * — no empty arrays, no empty objects, and a `v` key no non-empty note in the
   * corpus carries. So it is emitted here under exactly that condition: the
   * assembled cache has no other key.
   *
   * **The condition is the assembled cache's emptiness, not the file's**, and
   * the corpus cannot tell the two apart: it has one empty note and no
   * whitespace-only one. A note of `"   \n"` or `"\n\n"` produces no sections
   * in `vaultd` and would therefore be answered `{ v: 1 }` here, which is
   * unverified rather than known-wrong. A whitespace-only capture would settle
   * it.
   */
  v?: number;
  // Deliberately absent, with policy: `footnotes`, `footnoteRefs`, and
  // `referenceLinks` are real fields in the current obsidian.d.ts (since 1.6.6
  // and 1.8.7). vaultd does not parse them, so `buildCachedMetadata` omits the
  // keys entirely — which is also what Obsidian does for a note that has none,
  // so a plugin reading them cannot tell "no footnotes" from "not served".
  // They are registered `absent` in the policy table, they appear in the
  // compatibility report, and `parity-footnotes` measures the gap.
}

/**
 * The assembler's own refusal: a row and an index that cannot be turned into a
 * `CachedMetadata` between them.
 *
 * Typed rather than a bare `Error` because it is **plugin-reachable**.
 * `buildCachedMetadata` is called from `getFileCache`, so anything thrown here
 * surfaces inside whatever a plugin was doing, and a host that wants to
 * quarantine the plugin, or log the note, or serve `null` and carry on, needs
 * to be able to tell this apart from the plugin's own failures. Both cases that
 * raise it are host bugs rather than data conditions — see the two call sites —
 * so the right response is to fix the caller, not to catch it in a loop.
 */
export class CachedMetadataError extends Error {
  readonly code = "cached_metadata_assembly";
  readonly path: string;
  readonly span: SpanDto;
  constructor(message: string, path: string, span: SpanDto) {
    super(message);
    this.name = "CachedMetadataError";
    this.path = path;
    this.span = span;
  }
}

/** Mirrors obsidian.d.ts `Reference`. Note: NO position. */
export interface Reference {
  link: string;
  original: string;
  displayText?: string;
}

/** `ReferenceCache extends Reference, CacheItem` — this is the one with a position. */
export interface ReferenceCache extends Reference {
  position: Pos;
}

export type LinkCache = ReferenceCache;
export type EmbedCache = ReferenceCache;

/**
 * `FrontmatterLinkCache extends Reference` — NOT `ReferenceCache`. It has no
 * `position`, because a frontmatter link's location is its `key`, not a span.
 * Adding a `position` here fails parity against every captured fixture.
 */
export interface FrontmatterLinkCache extends Reference {
  key: string;
}

export interface TagCache {
  tag: string;
  position: Pos;
}

export interface HeadingCache {
  heading: string;
  level: number;
  position: Pos;
}

export interface SectionCache {
  type: string;
  position: Pos;
  id?: string;
}

/** `parent` is a LINE NUMBER. See {@link parentOf} for the conversion. */
export interface ListItemCache {
  position: Pos;
  parent: number;
  id?: string;
  task?: string;
}

export interface BlockCache {
  id: string;
  position: Pos;
}

/**
 * Assemble one note's `CachedMetadata`.
 *
 * The order below is the order the fields were pinned in, and every branch that
 * adds a key tests for emptiness first: a note with no links has no `links`
 * key, not an empty array.
 */
export function buildCachedMetadata(row: MirrorNoteRow, positions: PositionIndex): CachedMetadata {
  const cache: CachedMetadata = {};
  const at = (bytes: SpanDto): Pos => span(positions, bytes.start, bytes.end);

  const links: LinkCache[] = [];
  const embeds: EmbedCache[] = [];
  const frontmatterLinks: FrontmatterLinkCache[] = [];
  for (const reference of row.outgoing) {
    if (reference.origin === "property") {
      // The frontmatter branch. It builds `{ link, original, displayText?, key }`
      // and never calls `span()` — see the module doc. It still reads the
      // index, for the retained source slice `original` is.
      const key = frontmatterKeyOf(row.path, row.properties, reference.span);
      frontmatterLinks.push({ ...referenceFields(reference, positions, row.path), key });
      continue;
    }
    const entry: ReferenceCache = {
      ...referenceFields(reference, positions, row.path),
      position: at(reference.span),
    };
    if (isEmbed(reference)) embeds.push(entry);
    else links.push(entry);
  }
  if (links.length > 0) cache.links = links;
  if (embeds.length > 0) cache.embeds = embeds;

  const tags: TagCache[] = [];
  for (const tag of row.tags) {
    // A tag inside a property's value is a frontmatter tag, and Obsidian keeps
    // those in `frontmatter.tags` alone.
    if (containedByAnyProperty(row.properties, tag.span)) continue;
    tags.push({ tag: `#${tag.value}`, position: at(tag.span) });
  }
  if (tags.length > 0) cache.tags = tags;

  if (row.headings.length > 0) {
    cache.headings = row.headings.map((heading) => ({
      heading: heading.text,
      level: heading.level,
      position: at(heading.span),
    }));
  }

  if (row.sections.length > 0) {
    cache.sections = row.sections.map((section) => {
      const entry: SectionCache = { type: section.kind, position: at(section.span) };
      // Present only when the section owns a block id, exactly like `task` on a
      // list item: a section without one carries no key at all.
      if (section.block_id !== undefined) entry.id = section.block_id;
      return entry;
    });
  }

  if (row.listItems.length > 0) {
    cache.listItems = row.listItems.map((item) => {
      const entry: ListItemCache = { position: at(item.span), parent: parentOf(item) };
      const owned = row.blocks.find((block) => contains(item.span, block.span));
      if (owned !== undefined) entry.id = owned.value;
      if (item.task !== undefined) entry.task = item.task;
      return entry;
    });
  }

  if (row.properties.length > 0) {
    const frontmatter: Record<string, unknown> = {};
    for (const property of row.properties) frontmatter[property.key] = plainValue(property.value);
    cache.frontmatter = frontmatter;
  }

  // `frontmatterPosition` spans the whole YAML block, **fences included**, so it
  // cannot be derived from the property spans — those start after the opening
  // `---`. The `yaml` section is the one row that carries it, and the two are
  // byte-identical in every capture that has frontmatter at all.
  const yaml = row.sections.find((section) => section.kind === "yaml");
  if (yaml !== undefined) {
    cache.frontmatterPosition = at(yaml.span);
    // Present as `[]` whenever frontmatter exists at all, even with no links in
    // it — `parity-frontmatter` and `parity-tags-frontmatter` both pin that.
    cache.frontmatterLinks = frontmatterLinks;
  }

  if (row.blocks.length > 0) {
    const blocks: Record<string, BlockCache> = {};
    for (const block of row.blocks) {
      const owner = blockOwnerSpan(row, block);
      if (owner === undefined) continue;
      blocks[block.value] = { id: block.value, position: at(owner) };
    }
    cache.blocks = blocks;
  }

  // The empty note. See {@link CachedMetadata.v}.
  if (Object.keys(cache).length === 0) return { v: 1 };
  return cache;
}

/**
 * One outgoing reference as a `ReferenceCache`, for a consumer that holds a
 * reference without holding the row it came from.
 *
 * `getBacklinksForFile` is that consumer: a backlink is a reference stored
 * against its **source** note, so it is converted with the source's position
 * index rather than the target's. The field derivation is shared with
 * {@link buildCachedMetadata} so a backlink and the same link read out of
 * `links[]` can never disagree about their own text.
 */
export function referenceCacheOf(
  reference: ReferenceDto,
  positions: PositionIndex,
): ReferenceCache {
  return {
    ...referenceFields(reference, positions, reference.source_path),
    position: span(positions, reference.span.start, reference.span.end),
  };
}

/**
 * What a block id's `position` points at: the **block it belongs to**, never the
 * `^id` token itself.
 *
 * `BlockDto.span` is the anchor's own span — `^para-block` is bytes 179..190 of
 * `parity-blocks` — while Obsidian reports the paragraph that carries it,
 * 140..190. So the owner is looked up in three steps, innermost first:
 *
 * 1. a **list item** whose span contains the anchor (a list is one section, so
 *    the section would be far too wide);
 * 2. the section that **declares** this id, which is the ordinary case;
 * 3. any section containing the anchor, for an id `vaultd` recorded without
 *    attaching it to a section.
 */
function blockOwnerSpan(row: MirrorNoteRow, block: BlockDto): SpanDto | undefined {
  const item = row.listItems.find((entry) => contains(entry.span, block.span));
  if (item !== undefined) return item.span;
  const declaring = row.sections.find((section) => section.block_id === block.value);
  if (declaring !== undefined) return declaring.span;
  return row.sections.find((section: SectionDto) => contains(section.span, block.span))?.span;
}

/**
 * A list item's `parent`, which is a **line number on both sides**.
 *
 * `obsidian.d.ts` says: "Line number of the parent list item
 * (`position.start.line`). If this item has no parent … then this value is the
 * negative of the line number of the first list item (start of the list)."
 * `ListItemDto` carries exactly one of the two columns that answers it.
 *
 * **The line-0 case is settled by the captures, not by the typings.** A list
 * starting on line 0 would negate to `-0`, which JSON cannot tell from `0` —
 * and `0` is already the line number of a real parent. Obsidian answers `-1`
 * there: `parity-list-flat` (a list starting on line 0) and `parity-list-tasks`
 * both report `parent: -1` for their root items, while every other list reports
 * the plain negation of its own start line. So line 0 is special-cased to `-1`
 * because that is what the running application does.
 */
function parentOf(item: ListItemDto): number {
  if (item.list_start_line !== undefined) {
    return item.list_start_line === 0 ? -1 : -item.list_start_line;
  }
  if (item.parent_start_line !== undefined) return item.parent_start_line;
  throw new Error("list item has neither list_start_line nor parent_start_line");
}

/** True for the two embed kinds; `links` takes the other two. */
function isEmbed(reference: ReferenceDto): boolean {
  return reference.kind === "wiki_embed" || reference.kind === "markdown_embed";
}

/**
 * The three fields a body link and a frontmatter link share.
 *
 * `displayText` is always present in every capture, so it is always emitted;
 * the field stays optional on {@link Reference} because that is what
 * `obsidian.d.ts` declares.
 */
function referenceFields(
  reference: ReferenceDto,
  positions: PositionIndex,
  path: string,
): Reference {
  return {
    link: linkTextOf(reference),
    original: sourceTextOf(reference, positions, path),
    displayText: displayTextOf(reference),
  };
}

/**
 * `original`: the reference exactly as it was written, read out of the index.
 *
 * The slice was retained by the warm step, which is the one moment the host
 * holds the note's bytes and its row at the same time. A missing slice is a
 * **host bug**, not a data condition — an index built without the row's
 * reference spans — and it throws rather than falling back to a reconstruction,
 * because the whole reason the slice exists is that no reconstruction is
 * faithful. Every caller of `buildCachedMetadata` builds its index from the
 * same row's `outgoing`, so the throw is unreachable by design and loud if the
 * design is ever broken.
 */
function sourceTextOf(reference: ReferenceDto, positions: PositionIndex, path: string): string {
  const text = originalOf(positions, reference.span);
  if (text === undefined) {
    throw new CachedMetadataError(
      `${path} has no retained source for the reference at bytes ` +
        `${String(reference.span.start)}..${String(reference.span.end)}: the position index was ` +
        `built without this row's outgoing spans, so \`original\` cannot be exact`,
      path,
      reference.span,
    );
  }
  return text;
}

/**
 * `link`: the target **as a linkpath**, with the subpath still attached.
 *
 * `file_target` is the file half after the daemon has percent-decoded a
 * Markdown link's destination (`Parity%20target.md` → `Parity target.md`) and
 * left a wikilink's alone (`[[Parity%20target]]` stays encoded, and Obsidian
 * agrees). The subpath is taken from `raw_target` rather than re-composed from
 * `SubpathDto`, because Obsidian reports it exactly as written — `#Some heading`
 * and `#^blockid`, the caret included.
 */
function linkTextOf(reference: ReferenceDto): string {
  if (reference.file_target === null) return reference.raw_target;
  const hash = reference.raw_target.indexOf("#");
  return hash === -1 ? reference.file_target : reference.file_target + reference.raw_target.slice(hash);
}

/**
 * `displayText`: what the reader sees.
 *
 * An explicit display text — the alias after a `|`, or a Markdown link's label
 * — is used as written. Without one, Obsidian shows the link text with its
 * subpath separators spelled out: `[[Parity target#Some heading]]` displays as
 * `Parity target > Some heading`, and `[[Parity target#^blockid]]` as
 * `Parity target > ^blockid`.
 *
 * **Every separator, not the first.** A heading path can nest —
 * `[[Note#H1#H2]]` displays as `Note > H1 > H2` — and a string-pattern
 * `replace` would have spelled only the first, leaving `Note > H1#H2`. No
 * capture covers a multi-level subpath, so a case pins it directly.
 */
function displayTextOf(reference: ReferenceDto): string {
  if (reference.display !== null) return reference.display;
  return reference.raw_target.replaceAll("#", " > ");
}

/**
 * The dotted frontmatter key a property-borne reference was written under.
 *
 * Ruling W2's client-side derivation: find the one property whose `value_span`
 * contains the reference, then descend its value tree by the same test.
 *
 * **Refuses rather than dropping the reference.** A reference the daemon marked
 * `origin: "property"` came out of a property value by construction, so no
 * containing property means the two sides disagree about where frontmatter
 * ends — and the silent `continue` this replaced would have dropped a
 * `frontmatterLinks` entry with no diagnostic anywhere, which is precisely the
 * failure a future change to the property scanner would produce.
 *
 * **Know the blast radius before changing the property scanner.** This runs
 * inside `buildCachedMetadata`, which `getFileCache` calls, so a daemon that
 * started emitting a property-origin reference outside every value span would
 * turn one missing key into a {@link CachedMetadataError} on **every**
 * `getFileCache` for that note — loud, which is the point, but loud in a
 * plugin's hot path rather than in a log. The refusal is typed so a host can
 * tell it apart from a plugin's own failure and decide what to do; it is still
 * a bug to be fixed at the source rather than caught.
 */
function frontmatterKeyOf(path: string, properties: readonly PropertyDto[], at: SpanDto): string {
  for (const property of properties) {
    if (!contains(property.value_span, at)) continue;
    return property.key + descend(property.value, at);
  }
  throw new CachedMetadataError(
    `${path} has a property-origin reference at bytes ${String(at.start)}..${String(at.end)} ` +
      `that lies inside no property's value span`,
    path,
    at,
  );
}

/**
 * The rest of the dotted path, below a property's own key.
 *
 * A sequence element is `.<index>` and a mapping entry is `.<key>`, and both
 * recurse — so a link inside `nested.deeper.flags[1]` is
 * `nested.deeper.flags.1`. A scalar adds nothing, which is why a top-level
 * `single:` is the bare key.
 */
function descend(value: PropertyValueDto, at: SpanDto): string {
  if (value.kind === "sequence") {
    for (const [index, element] of value.value.entries()) {
      if (contains(element.span, at)) return `.${String(index)}${descend(element.value, at)}`;
    }
    return "";
  }
  if (value.kind === "mapping") {
    for (const entry of value.value) {
      if (contains(entry.value.span, at)) return `.${entry.key}${descend(entry.value.value, at)}`;
    }
    return "";
  }
  return "";
}

/** Does any property's value contain this span? Used to spot frontmatter tags. */
function containedByAnyProperty(properties: readonly PropertyDto[], at: SpanDto): boolean {
  return properties.some((property) => contains(property.value_span, at));
}

/** Half-open containment, in bytes. Equal spans count as contained. */
function contains(outer: SpanDto, inner: SpanDto): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * A `PropertyValueDto` tree as plain JS, the way `frontmatter` carries it.
 *
 * `null` is a unit variant with no `value` key at all. `float` is the trap: it
 * arrives as a **string** and must be `Number(...)`-ed, or every plugin that
 * does arithmetic on a frontmatter number silently concatenates instead.
 */
function plainValue(value: PropertyValueDto): unknown {
  switch (value.kind) {
    case "null":
      return null;
    case "boolean":
      return value.value;
    case "integer":
      return value.value;
    case "float":
      return Number(value.value);
    case "string":
      return value.value;
    case "sequence":
      return value.value.map((element) => plainValue(element.value));
    case "mapping": {
      const mapping: Record<string, unknown> = {};
      for (const entry of value.value) mapping[entry.key] = plainValue(entry.value.value);
      return mapping;
    }
  }
}
