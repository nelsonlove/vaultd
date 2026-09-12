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
 * Four further divergences were **found by this task's parity run** and are
 * upstream parse differences, not assembly bugs. Each is recorded in the parity
 * test as a named allowance so that it fails loudly if either side changes:
 *
 * - `parity-blocks`: a standalone `^id` line after a heading. Obsidian folds the
 *   id onto the preceding block and emits no section for the id line; `vaultd`
 *   emits an extra `paragraph` section carrying the id, so the section list is
 *   one longer and `blocks["heading-standalone"].position` names the id line
 *   rather than the heading.
 * - `parity-frontmatter-links`: `vaultd` extracts wikilinks from a property
 *   value but not Markdown links, so `related.1` has no reference to derive a
 *   `frontmatterLinks` entry from.
 * - `parity-list-nested-3deep`: a nested **ordered** list item's span starts one
 *   column earlier than Obsidian's. Nested unordered items agree.
 * - `parity-tags-nested-unicode`: a tag containing a non-BMP emoji ends at the
 *   emoji in `vaultd` (`#tag-`) and includes it in Obsidian (`#tag-🙂`).
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

import { span } from "./positions";
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
      // and never touches the position index — see the module doc.
      const key = frontmatterKeyOf(row.properties, reference.span);
      if (key === null) continue;
      frontmatterLinks.push({ ...referenceFields(reference), key });
      continue;
    }
    const entry: ReferenceCache = { ...referenceFields(reference), position: at(reference.span) };
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
    ...referenceFields(reference),
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
function referenceFields(reference: ReferenceDto): Reference {
  return {
    link: linkTextOf(reference),
    original: originalOf(reference),
    displayText: displayTextOf(reference),
  };
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
 * `original`: the reference exactly as it was written.
 *
 * **Reconstructed from the reference's own parts rather than sliced out of the
 * source**, because this function is pure and holds no source — a
 * {@link PositionIndex} deliberately keeps line starts and wide characters and
 * not a single note body. The reconstruction is total for the four reference
 * kinds the daemon reports: a wikilink is `[[target]]` or `[[target|display]]`,
 * a Markdown link is `[display](target)`, and an embed is either of those with
 * a leading `!`. Every `original` in all eighteen captures comes out identical.
 */
function originalOf(reference: ReferenceDto): string {
  const bang = isEmbed(reference) ? "!" : "";
  if (reference.kind === "wikilink" || reference.kind === "wiki_embed") {
    const alias = reference.display === null ? "" : `|${reference.display}`;
    return `${bang}[[${reference.raw_target}${alias}]]`;
  }
  return `${bang}[${reference.display ?? ""}](${reference.raw_target})`;
}

/**
 * `displayText`: what the reader sees.
 *
 * An explicit display text — the alias after a `|`, or a Markdown link's label
 * — is used as written. Without one, Obsidian shows the link text with its
 * subpath separator spelled out: `[[Parity target#Some heading]]` displays as
 * `Parity target > Some heading`, and `[[Parity target#^blockid]]` as
 * `Parity target > ^blockid`.
 */
function displayTextOf(reference: ReferenceDto): string {
  if (reference.display !== null) return reference.display;
  return reference.raw_target.replace("#", " > ");
}

/**
 * The dotted frontmatter key a property-borne reference was written under, or
 * `null` when no property's value contains it.
 *
 * Ruling W2's client-side derivation: find the one property whose `value_span`
 * contains the reference, then descend its value tree by the same test.
 */
function frontmatterKeyOf(
  properties: readonly PropertyDto[],
  at: SpanDto,
): string | null {
  for (const property of properties) {
    if (!contains(property.value_span, at)) continue;
    return property.key + descend(property.value, at);
  }
  return null;
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
