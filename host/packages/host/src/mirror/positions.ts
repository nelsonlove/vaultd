/**
 * Byte offsets in, Obsidian positions out — without retaining a single note
 * body.
 *
 * `vaultd` reports every span as **half-open UTF-8 byte offsets** into a note's
 * exact source. Obsidian reports every position as `{ line, col, offset }`
 * where `line` is zero-based, `col` counts **JavaScript string units** from the
 * start of the line, and `offset` counts them from the start of the file. The
 * two agree only while a note is pure ASCII, so a host that hands one to a
 * plugin expecting the other is wrong on the first emoji, em dash, or CJK
 * character — silently, in a position a plugin then slices a string with.
 *
 * A {@link PositionIndex} is the conversion table for one note. It holds the
 * start of every line, in both units, plus one triple per character whose UTF-8
 * encoding is longer than one byte. That is roughly 8 bytes per line and 12
 * bytes per non-ASCII character, against the alternative of keeping every
 * note's source in memory for the lifetime of the host — which is the whole
 * reason the mirror exists.
 */

/**
 * One note's byte ↔ UTF-16 conversion table.
 *
 * `wide` is a flat `Uint32Array` of `[byteStart, byteLen, u16Len]` triples in
 * ascending `byteStart` order — flat rather than an array of objects because a
 * note of CJK prose has one triple per character and 100k of those as objects
 * is the memory this class exists to avoid.
 *
 * `byteLength` and `u16Length` are additive to the shape the phase plan sketched
 * and they earn their place: without a length there is no way to tell an offset
 * past the end of the note from one inside it, and a stale span outliving an
 * edit is exactly how that arrives.
 */
export interface PositionIndex {
  /** Byte offset of each line start. Always begins with 0. */
  readonly lineStarts: Uint32Array;
  /** UTF-16 offset of each line start, index-for-index with {@link lineStarts}. */
  readonly lineU16Starts: Uint32Array;
  /** Flattened `[byteStart, byteLen, u16Len]` per non-ASCII character. */
  readonly wide: Uint32Array;
  /** Total UTF-8 length of the source this index was built from. */
  readonly byteLength: number;
  /** Total UTF-16 length of the same source. */
  readonly u16Length: number;
  /**
   * The **exact source text** of each span the caller asked to retain, keyed
   * `"<byteStart>:<byteEnd>"`.
   *
   * Obsidian's `LinkCache.original` is the reference exactly as it was written,
   * and a plugin uses it to find and rewrite a link in the note body — so a
   * value that merely *reconstructs* the reference from its parts is a
   * find-and-replace that silently misses. Three ordinary Markdown forms defeat
   * any reconstruction: a link title (`[a](T.md "the title")`), an
   * angle-bracket target (`[b](<Odd Name.md>)`), and an empty alias
   * (`[[Target|]]`). The daemon's span is right in all three; only the
   * reconstruction was short.
   *
   * So the warm step, which is holding the note's bytes anyway to build this
   * table, keeps the slice for each **outgoing reference span** — and nothing
   * else. A note with no links retains nothing; a note of ordinary prose
   * retains a few dozen bytes. That is the whole cost of never being wrong
   * about `original`, against the alternative of keeping every note's source in
   * memory, which is the thing this class exists to avoid.
   */
  readonly originals: ReadonlyMap<string, string>;
}

/** Obsidian's own position shape: zero-based line, UTF-16 column and offset. */
export interface Loc {
  line: number;
  col: number;
  offset: number;
}

/** Obsidian's `Pos`: a half-open range of two {@link Loc}s. */
export interface Pos {
  start: Loc;
  end: Loc;
}

/** A half-open byte range, structurally the wire's `SpanDto`. */
export interface ByteSpan {
  readonly start: number;
  readonly end: number;
}

/** The key one retained span is filed under. */
function spanKey(start: number, end: number): string {
  return `${String(start)}:${String(end)}`;
}

/**
 * Build the conversion table for one source, in a single pass.
 *
 * A line starts after every `\n`. A lone `\r` is *not* a line break here,
 * matching Obsidian's own line counting, and a `\r\n` therefore leaves the `\r`
 * as the last character of the preceding line — which is also where Obsidian
 * puts it.
 *
 * `retain` names the byte spans whose **exact source text** the index should
 * keep — the note's outgoing reference spans, and nothing else. See
 * {@link PositionIndex.originals} for why the alternative (reconstructing the
 * text from the reference's parts) is wrong rather than merely approximate.
 * Passing none keeps none, which is right for every caller that only wants
 * positions.
 */
export function buildPositionIndex(
  source: string,
  retain: readonly ByteSpan[] = [],
): PositionIndex {
  const lineStarts: number[] = [0];
  const lineU16Starts: number[] = [0];
  const wide: number[] = [];
  let byte = 0;
  for (let u16 = 0; u16 < source.length; ) {
    // `codePointAt` returns the whole astral code point at a high surrogate, so
    // a surrogate pair is visited once and advances `u16` by two.
    const codePoint = source.codePointAt(u16)!;
    const u16Len = codePoint > 0xffff ? 2 : 1;
    const byteLen = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (byteLen > 1) wide.push(byte, byteLen, u16Len);
    byte += byteLen;
    u16 += u16Len;
    if (codePoint === 0x0a) {
      lineStarts.push(byte);
      lineU16Starts.push(u16);
    }
  }
  const index: PositionIndex = {
    lineStarts: Uint32Array.from(lineStarts),
    lineU16Starts: Uint32Array.from(lineU16Starts),
    wide: Uint32Array.from(wide),
    byteLength: byte,
    u16Length: source.length,
    originals: new Map<string, string>(),
  };
  // After the table exists, because slicing a byte span out of a JS string
  // means converting both ends through the very table being built.
  const originals = index.originals as Map<string, string>;
  for (const span of retain) {
    const from = locate(index, span.start).offset;
    const to = locate(index, span.end).offset;
    originals.set(spanKey(span.start, span.end), source.slice(from, to));
  }
  return index;
}

/**
 * The exact source text of a retained span, or `undefined` if it was not
 * retained.
 *
 * `undefined` is not a value a caller may paper over: the point of retaining
 * the slice is that no reconstruction is faithful, so a consumer that meets
 * `undefined` has been handed an index built without the spans it needs, and
 * saying so loudly is the only honest answer.
 */
export function originalOf(index: PositionIndex, span: ByteSpan): string | undefined {
  return index.originals.get(spanKey(span.start, span.end));
}

/**
 * Convert one UTF-8 byte offset into an Obsidian {@link Loc}.
 *
 * Two malformed inputs are answered rather than thrown, because both are
 * reachable from a stale span and neither is the caller's fault:
 *
 * - an offset **outside** `0 .. byteLength` clamps into that range;
 * - an offset **inside** a multi-byte character resolves to the start of that
 *   character, which is the only nearby position that is a real string index.
 *
 * The cost is two binary searches plus a scan bounded by the number of
 * non-ASCII characters on the target line — never a scan of the note.
 */
export function locate(index: PositionIndex, byteOffset: number): Loc {
  const target = byteOffset < 0 ? 0 : byteOffset > index.byteLength ? index.byteLength : byteOffset;
  const line = lineAt(index.lineStarts, target);
  const lineStart = index.lineStarts[line]!;
  const lineU16Start = index.lineU16Starts[line]!;
  // Where this line's first wide character sits in the flat triple array.
  let triple = firstWideAtOrAfter(index.wide, lineStart);
  let delta = 0;
  for (; triple < index.wide.length; triple += 3) {
    const start = index.wide[triple]!;
    if (start >= target) break;
    const byteLen = index.wide[triple + 1]!;
    const u16Len = index.wide[triple + 2]!;
    if (start + byteLen > target) {
      // The offset landed inside this character: snap to its start.
      const offset = lineU16Start + (start - lineStart) + delta;
      return { line, col: offset - lineU16Start, offset };
    }
    delta += u16Len - byteLen;
  }
  const offset = lineU16Start + (target - lineStart) + delta;
  return { line, col: offset - lineU16Start, offset };
}

/**
 * Convert one half-open byte span into an Obsidian {@link Pos}.
 *
 * The daemon's spans are half-open and Obsidian's are too, so `end` is
 * converted exactly like `start` and no ±1 is applied anywhere.
 *
 * **Ordering is the caller's**: `span(index, 7, 3)` answers a `Pos` whose end
 * precedes its start. Every span the daemon sends is ordered, and silently
 * swapping the two here would hide a malformed one rather than surface it —
 * unlike an out-of-range or interior offset, which {@link locate} does defend
 * against because both are reachable from an ordinary stale span.
 */
export function span(index: PositionIndex, start: number, end: number): Pos {
  return { start: locate(index, start), end: locate(index, end) };
}

/** The greatest `i` with `lineStarts[i] <= byteOffset`. */
function lineAt(lineStarts: Uint32Array, byteOffset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (lineStarts[mid]! <= byteOffset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The index of the first triple whose `byteStart >= byteOffset`, or `wide.length`. */
function firstWideAtOrAfter(wide: Uint32Array, byteOffset: number): number {
  let low = 0;
  let high = wide.length / 3;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (wide[mid * 3]! < byteOffset) low = mid + 1;
    else high = mid;
  }
  return low * 3;
}
