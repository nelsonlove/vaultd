import { describe, expect, it } from "vitest";

import { buildPositionIndex, locate, span } from "../src/mirror/positions";

/**
 * The byte ↔ UTF-16 conversion the whole Obsidian-facing surface stands on.
 *
 * `vaultd` reports half-open **UTF-8 byte** spans; Obsidian reports
 * `{ line, col, offset }` where every number counts **JavaScript string units**.
 * Every case here is a case where the two disagree, because a conversion that
 * is only tested on ASCII is a conversion that is not tested at all.
 */
describe("PositionIndex", () => {
  it("locates an ASCII offset exactly", () => {
    const source = "# Title\n\nBody Link end\n";
    const index = buildPositionIndex(source);
    const byteOffset = Buffer.from(source, "utf8").indexOf("Link");
    expect(locate(index, byteOffset)).toEqual({ line: 2, col: 5, offset: 14 });
  });

  it("converts byte offsets across multi-byte characters", () => {
    const source = "\u{1F600} — café 中 Link\n";
    const index = buildPositionIndex(source);
    const bytes = Buffer.from(source, "utf8");
    const byteOffset = bytes.indexOf("Link");
    const located = locate(index, byteOffset);
    expect(located.line).toBe(0);
    expect(located.offset).toBe(source.indexOf("Link"));
    expect(located.col).toBe(source.indexOf("Link"));
  });

  it("produces a Pos whose end follows its start", () => {
    const source = "line one\nline two é\n";
    const index = buildPositionIndex(source);
    const bytes = Buffer.from(source, "utf8");
    const pos = span(index, bytes.indexOf("two"), bytes.indexOf("two") + 3);
    expect(pos.start).toEqual({ line: 1, col: 5, offset: 14 });
    expect(pos.end).toEqual({ line: 1, col: 8, offset: 17 });
  });

  it("round-trips every character boundary of the wide fixture", () => {
    const source = "aéb中c\u{1F600}d\n—e\n";
    const index = buildPositionIndex(source);
    const bytes = Buffer.from(source, "utf8");
    for (let u16 = 0; u16 <= source.length; u16 += 1) {
      if (u16 > 0 && u16 < source.length) {
        const code = source.charCodeAt(u16);
        if (code >= 0xdc00 && code <= 0xdfff) continue; // low surrogate: not a boundary
      }
      const byteOffset = Buffer.from(source.slice(0, u16), "utf8").length;
      expect(locate(index, byteOffset).offset).toBe(u16);
      expect(byteOffset).toBeLessThanOrEqual(bytes.length);
    }
  });

  /**
   * A wide character on a **later** line is the case a per-line walk gets wrong
   * when it accumulates from the start of the note instead of from the start of
   * the line: the emoji on line 0 must not shift line 2's columns.
   */
  it("keeps a wide character on an earlier line out of a later line's column", () => {
    const source = "\u{1F600} first\nsecond\nthird Link\n";
    const index = buildPositionIndex(source);
    const byteOffset = Buffer.from(source, "utf8").indexOf("Link");
    expect(locate(index, byteOffset)).toEqual({
      line: 2,
      col: 6,
      offset: source.indexOf("Link"),
    });
  });

  /** A note with no trailing newline still ends at a locatable offset. */
  it("locates the end of a source that does not end in a newline", () => {
    const source = "one\ntwo";
    const index = buildPositionIndex(source);
    const bytes = Buffer.from(source, "utf8");
    expect(locate(index, bytes.length)).toEqual({ line: 1, col: 3, offset: 7 });
  });

  /**
   * An offset past the end, and one that lands **inside** a character, are the
   * two malformed inputs a daemon bug or a stale span produces. Neither may
   * throw and neither may return a nonsense `offset`: the first clamps to the
   * end of the source, the second resolves to the start of the character it
   * fell inside, which is the only position that is a real string index.
   */
  it("clamps an out-of-range offset and snaps an interior byte to its character", () => {
    const source = "a中b\n";
    const index = buildPositionIndex(source);
    const bytes = Buffer.from(source, "utf8");
    expect(locate(index, bytes.length + 99)).toEqual({ line: 1, col: 0, offset: 4 });
    // "中" occupies bytes 1..4; byte 2 and byte 3 are interior.
    expect(locate(index, 2)).toEqual({ line: 0, col: 1, offset: 1 });
    expect(locate(index, 3)).toEqual({ line: 0, col: 1, offset: 1 });
    expect(locate(index, -5)).toEqual({ line: 0, col: 0, offset: 0 });
  });

  /**
   * The index retains line starts and wide characters, never the source. A
   * 100k-note vault is the reason: the whole point of the mirror is that the
   * host answers `getFileCache` synchronously without holding every note body.
   */
  it("retains no more than line starts and wide characters", () => {
    const source = `${"ascii line\n".repeat(100)}wide é\n`;
    const index = buildPositionIndex(source);
    expect(index.lineStarts.length).toBe(102);
    expect(index.lineU16Starts.length).toBe(102);
    expect(index.wide.length).toBe(3); // one triple, for the single "é"
  });
});
