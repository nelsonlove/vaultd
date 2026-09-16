/**
 * `Editor` — one note's text, in memory, with Obsidian's editor surface over it
 * and exactly one write behind it.
 *
 * **Why this exists at all.** Half the corpus registers its real work as an
 * `editorCallback`: obsidian-linter's lint commands, automatic-linker's
 * `format-file`, find-replace's replacements. A host that handed those commands
 * nothing could not run them, and a host that handed them a class whose every
 * method throws (which is what this host had until this task) could only watch
 * them die on the first `getValue()`. So the editor is real: it holds the
 * note's text, it answers every position question against it, and what the
 * callback writes into it lands in the vault.
 *
 * **The lifecycle is per invocation, and that is the whole design.** There are
 * no keystrokes here, so there is nothing to sync: an editor is opened for one
 * command with one `get_note`, mutated in memory by the callback, and flushed
 * once with a single `write_note` when the callback returns — and only when the
 * buffer really differs from what was read. A callback that reads and does not
 * write costs one read and no mutation.
 *
 * **Positions are the mirror's, not a second answer.** Obsidian's editor
 * positions are `{ line, ch }` in **JavaScript string units**, and so are the
 * `line`/`col`/`offset` triples in `CachedMetadata` — the mirror's
 * {@link PositionIndex} is what converts the daemon's UTF-8 byte spans into
 * them. This class builds a `PositionIndex` over its own buffer and answers
 * `posToOffset` / `offsetToPos` from the very same line table, so an offset a
 * plugin reads out of `metadataCache` and feeds to `offsetToPos` lands where
 * the cache said it would — including on a line containing an emoji, which is
 * exactly where a hand-rolled `split("\n")` editor and the metadata cache
 * disagree silently.
 *
 * **Three members are inert, and say so.** `focus`, `blur` and `refresh` are
 * about a cursor in a window; there is no window. They are `safe_stub` rather
 * than `absent` because plugins call them at the end of an otherwise-real edit
 * and a throw there would discard work that had already succeeded.
 */

import { buildPositionIndex } from "../mirror/positions";
import { declarePolicy, recordUse, stub } from "./policy";
import type { GetNoteResponse } from "../client/protocol";
import type { Mirror } from "../mirror/mirror";
import type { MutationResponse } from "../client/protocol";
import type { PositionIndex } from "../mirror/positions";
import type { TFile } from "./files";
import type { RequestSink } from "../client/request-sink";
import type { WriteGate } from "./vault";

/** Obsidian's `EditorPosition`: a zero-based line and a UTF-16 column. */
export interface EditorPosition {
  line: number;
  ch: number;
}

/** Obsidian's `EditorRange`. */
export interface EditorRange {
  from: EditorPosition;
  to: EditorPosition;
}

/** One change in an {@link EditorTransaction}: `to` omitted means an insert. */
export interface EditorChange {
  text: string;
  from: EditorPosition;
  to?: EditorPosition;
}

/** As much of Obsidian's `EditorTransaction` as a headless host can honour. */
export interface EditorTransaction {
  changes?: EditorChange[];
  /** Replaces the current selection, after `changes` — see {@link Editor.transaction}. */
  replaceSelection?: string;
  selection?: { from: EditorPosition; to?: EditorPosition };
}

/** Which end of the selection {@link Editor.getCursor} is being asked for. */
export type EditorCursorEnd = "from" | "to" | "head" | "anchor";

/** What one editor needs to read its note and to write it back. */
export interface EditorDeps {
  readonly client: RequestSink;
  readonly mirror: Mirror;
  readonly writes: WriteGate;
  readonly file: TFile;
  /** Where the selection starts out. Absent means a caret at the very start. */
  readonly initialSelection?: EditorRange | undefined;
}

/** The bytes and the revision one editor was opened on. */
interface EditorSource {
  readonly source: string;
  readonly revision: string;
}

export class Editor {
  readonly file: TFile;

  private readonly deps: EditorDeps;
  /** The buffer. Every method here is a question about, or an edit to, this. */
  private text: string;
  /** What `open` read, so {@link dirty} is a comparison rather than a flag. */
  private baseline: string;
  /**
   * The revision the read carried, and the precondition the flush will send.
   *
   * Updated by a successful flush, so a command that writes twice through one
   * editor states the right precondition the second time rather than a stale
   * one the daemon would refuse.
   */
  private revision: string;
  private anchor: EditorPosition;
  private head: EditorPosition;
  /** Rebuilt on every edit; see {@link positions}. */
  private index: PositionIndex | null = null;

  constructor(deps: EditorDeps, initial: EditorSource) {
    this.deps = deps;
    this.file = deps.file;
    this.text = initial.source;
    this.baseline = initial.source;
    this.revision = initial.revision;
    const selection = deps.initialSelection;
    this.anchor = selection === undefined ? { line: 0, ch: 0 } : { ...selection.from };
    this.head = selection === undefined ? { line: 0, ch: 0 } : { ...selection.to };
  }

  /**
   * Read the note and build an editor over it. **One `get_note`, no `include`.**
   *
   * `get_note` rather than `read_file` because it is the note-shaped read — it
   * answers the source and the revision the mirror's own rows are keyed by — and
   * no facet is named because this class needs neither `sections` nor
   * `list_items`: the two optional facets are the only thing `include` can ask
   * for, and asking for what is not used is a round trip nobody reads.
   */
  static async open(deps: EditorDeps): Promise<Editor> {
    const response = await deps.client.request<GetNoteResponse>("get_note", {
      path: deps.file.path,
    });
    return new Editor(deps, { source: response.note.source, revision: response.note.revision });
  }

  // --- Reading --------------------------------------------------------------

  getValue(): string {
    recordUse("Editor.getValue");
    return this.text;
  }

  setValue(text: string): void {
    recordUse("Editor.setValue");
    this.text = text;
    this.index = null;
    this.clampSelection();
  }

  getLine(line: number): string {
    recordUse("Editor.getLine");
    return this.lines()[line] ?? "";
  }

  /**
   * Replace one line's text.
   *
   * A line outside the buffer is a **no-op**. Obsidian's editor is
   * CodeMirror-backed and CodeMirror throws a `RangeError` for a line it does
   * not have, so this is a deliberate divergence and it is **uncaptured**
   * whether a plugin in the corpus ever reaches it: nothing here does, and a
   * throw out of a command that had already made other edits would lose them.
   * The same reading governs {@link posToOffset}, which clamps.
   */
  setLine(line: number, text: string): void {
    recordUse("Editor.setLine");
    const lines = this.lines();
    if (line < 0 || line >= lines.length) return;
    this.replaceRange(text, { line, ch: 0 }, { line, ch: lines[line]!.length });
  }

  /**
   * How many lines the buffer has, counting the empty one a trailing newline
   * leaves behind.
   *
   * A note ending in `\n` has a last line that is empty, and that line is a
   * real position a plugin appends at — which is why this is `split("\n")`'s
   * length and not "the number of newlines".
   */
  lineCount(): number {
    recordUse("Editor.lineCount");
    return this.lines().length;
  }

  lastLine(): number {
    recordUse("Editor.lastLine");
    return this.lines().length - 1;
  }

  /**
   * Where the cursor is. `head` by default, which is Obsidian's own default.
   *
   * `from`/`to` are the selection in document order; `anchor`/`head` are the
   * ends in the order the selection was made. With no selection all four are
   * the same position.
   */
  getCursor(which?: EditorCursorEnd): EditorPosition {
    recordUse("Editor.getCursor");
    switch (which) {
      case "anchor":
        return { ...this.anchor };
      case "from":
        return { ...this.orderedSelection().from };
      case "to":
        return { ...this.orderedSelection().to };
      default:
        return { ...this.head };
    }
  }

  /**
   * Put the caret somewhere, collapsing the selection.
   *
   * The `(line, ch)` spelling is accepted beside the `EditorPosition` one
   * because Obsidian accepts both and the corpus uses both.
   */
  setCursor(pos: EditorPosition | number, ch?: number): void {
    recordUse("Editor.setCursor");
    const position =
      typeof pos === "number" ? { line: pos, ch: ch ?? 0 } : { line: pos.line, ch: pos.ch };
    const clamped = this.clamp(position);
    this.anchor = clamped;
    this.head = { ...clamped };
  }

  getSelection(): string {
    recordUse("Editor.getSelection");
    const { from, to } = this.orderedSelection();
    return this.getRange(from, to);
  }

  setSelection(anchor: EditorPosition, head?: EditorPosition): void {
    recordUse("Editor.setSelection");
    this.anchor = this.clamp(anchor);
    this.head = this.clamp(head ?? anchor);
  }

  somethingSelected(): boolean {
    recordUse("Editor.somethingSelected");
    return this.anchor.line !== this.head.line || this.anchor.ch !== this.head.ch;
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    recordUse("Editor.getRange");
    const start = this.posToOffset(from);
    const end = this.posToOffset(to);
    return start <= end ? this.text.slice(start, end) : this.text.slice(end, start);
  }

  // --- Editing --------------------------------------------------------------

  /**
   * Replace the selection, and leave the caret after what was inserted.
   *
   * With nothing selected this is an insert at the caret, which is what
   * Obsidian does and what a plugin writing a template at the cursor expects.
   */
  replaceSelection(replacement: string): void {
    recordUse("Editor.replaceSelection");
    const { from, to } = this.orderedSelection();
    this.replaceRange(replacement, from, to);
  }

  /**
   * Replace a range. `to` omitted means an insertion at `from`.
   *
   * The caret lands after the replacement, collapsed — the same place a typed
   * edit would leave it.
   */
  replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition): void {
    recordUse("Editor.replaceRange");
    const start = this.posToOffset(from);
    const end = to === undefined ? start : this.posToOffset(to);
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    this.text = this.text.slice(0, low) + replacement + this.text.slice(high);
    this.index = null;
    const after = this.offsetToPos(low + replacement.length);
    this.anchor = after;
    this.head = { ...after };
  }

  /**
   * Apply several changes at once, then `replaceSelection`, then the
   * transaction's selection.
   *
   * The changes are applied **last-first** by offset, because applying them in
   * document order would invalidate every later change's positions — which is
   * the bug a plugin batching edits into one transaction is trying to avoid in
   * the first place.
   *
   * The **order of the three fields relative to each other is uncaptured.**
   * `changes` first is the only order in which the positions those changes
   * carry mean anything; `replaceSelection` before `selection` is the only
   * order in which setting a selection and then replacing something else would
   * not be silently pointless. Both are least-harm readings of an interface
   * whose documentation states no order.
   */
  transaction(tx: EditorTransaction): void {
    recordUse("Editor.transaction");
    const changes = [...(tx.changes ?? [])].sort(
      (a, b) => this.posToOffset(b.from) - this.posToOffset(a.from),
    );
    for (const change of changes) this.replaceRange(change.text, change.from, change.to);
    if (tx.replaceSelection !== undefined) this.replaceSelection(tx.replaceSelection);
    if (tx.selection !== undefined) {
      this.setSelection(tx.selection.from, tx.selection.to ?? tx.selection.from);
    }
  }

  // --- Positions ------------------------------------------------------------

  /**
   * `{ line, ch }` to a JavaScript string index, clamped into the buffer.
   *
   * Clamped rather than thrown on, because a plugin computes positions from a
   * `CachedMetadata` that may describe the note as it was **before** the
   * plugin's own earlier edit in the same callback — and a throw there loses
   * the whole command, where a clamp loses one character of precision. What
   * CodeMirror does with an out-of-range position (a `RangeError`) is known;
   * what Obsidian's `Editor` wrapper does with one is **uncaptured**, and the
   * clamp is the least-harm reading.
   */
  posToOffset(pos: EditorPosition): number {
    recordUse("Editor.posToOffset");
    const starts = this.positions().lineU16Starts;
    const line = Math.min(Math.max(pos.line, 0), starts.length - 1);
    const lineStart = starts[line]!;
    const lineEnd = line + 1 < starts.length ? starts[line + 1]! - 1 : this.text.length;
    return Math.min(Math.max(lineStart + Math.max(pos.ch, 0), lineStart), lineEnd);
  }

  /** A JavaScript string index back to `{ line, ch }`, clamped the same way. */
  offsetToPos(offset: number): EditorPosition {
    recordUse("Editor.offsetToPos");
    const starts = this.positions().lineU16Starts;
    const target = Math.min(Math.max(offset, 0), this.text.length);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (starts[mid]! <= target) low = mid;
      else high = mid - 1;
    }
    return { line: low, ch: target - starts[low]! };
  }

  /**
   * The word around `pos`, or `null` where there is none.
   *
   * "Word" is letters, digits and underscore — Obsidian's own default word
   * characters — extended to any Unicode letter, so a plugin asking for the
   * word under the cursor in a non-Latin note gets the word rather than one
   * character of it.
   */
  wordAt(pos: EditorPosition): EditorRange | null {
    recordUse("Editor.wordAt");
    const at = this.clamp(pos);
    const line = this.getLine(at.line);
    let start = at.ch;
    let end = at.ch;
    while (start > 0 && isWordChar(line[start - 1]!)) start -= 1;
    while (end < line.length && isWordChar(line[end]!)) end += 1;
    if (start === end) return null;
    return { from: { line: at.line, ch: start }, to: { line: at.line, ch: end } };
  }

  // --- The window there is none of ------------------------------------------

  focus(): void {
    stub("Editor.focus", undefined);
  }

  blur(): void {
    stub("Editor.blur", undefined);
  }

  refresh(): void {
    stub("Editor.refresh", undefined);
  }

  // --- Host-only ------------------------------------------------------------

  /**
   * **HOST-ONLY.** Not in `obsidian.d.ts`. True when the buffer differs from
   * what was read.
   *
   * A comparison rather than a flag on purpose: a plugin that writes a value
   * and writes the original back — which is what a linter that finds nothing to
   * fix does — has not changed the note, and must not cost a `write_note` that
   * moves the note's revision for nothing.
   */
  dirty(): boolean {
    return this.text !== this.baseline;
  }

  /**
   * **HOST-ONLY.** One `write_note`, with the read's revision as the
   * precondition, and only when the buffer really changed.
   *
   * The same three steps every other write in this host takes: send through the
   * {@link WriteGate} (so `--dry-run` intercepts it like any other), then
   * `applyMutation` so the mirror is read-your-writes consistent before the
   * caller continues. A `revision_conflict` is **not** retried here: the
   * plugin's callback computed this text from bytes that have since moved, so
   * re-sending it would install an update derived from a note that no longer
   * exists. The typed error reaches the dispatcher, which is the layer that
   * knows whether re-running the command is safe.
   */
  async flush(): Promise<void> {
    if (!this.dirty()) return;
    const content = this.text;
    const result = await this.deps.writes.send<MutationResponse>("write_note", {
      path: this.file.path,
      content,
      expected: { revision: this.revision },
    });
    await this.deps.mirror.applyMutation(result.generation, [this.file.path]);
    this.baseline = content;
    this.revision = result.revision;
  }

  // --- Internals ------------------------------------------------------------

  /**
   * The conversion table for the current buffer, built at most once per edit.
   *
   * The same {@link buildPositionIndex} the mirror's metadata assembly uses, so
   * the line table this class answers from and the one `CachedMetadata`
   * positions were computed with are produced by one function rather than two.
   * Rebuilt rather than patched after an edit: an incremental update is a
   * second implementation of the same table, and a table that drifts from the
   * text is wrong in a way nothing would notice until a plugin sliced a string
   * with it.
   */
  private positions(): PositionIndex {
    this.index ??= buildPositionIndex(this.text);
    return this.index;
  }

  private lines(): string[] {
    return this.text.split("\n");
  }

  private orderedSelection(): EditorRange {
    const anchorOffset = this.posToOffset(this.anchor);
    const headOffset = this.posToOffset(this.head);
    return anchorOffset <= headOffset
      ? { from: { ...this.anchor }, to: { ...this.head } }
      : { from: { ...this.head }, to: { ...this.anchor } };
  }

  /** A position inside the buffer, whatever was asked for. */
  private clamp(pos: EditorPosition): EditorPosition {
    return this.offsetToPos(this.posToOffset(pos));
  }

  /** Keep the selection inside a buffer that has just been replaced wholesale. */
  private clampSelection(): void {
    this.anchor = this.clamp(this.anchor);
    this.head = this.clamp(this.head);
  }
}

/** Letters, digits and underscore — Obsidian's own word characters. */
function isWordChar(character: string): boolean {
  return /[\p{L}\p{N}_]/u.test(character);
}

// The rows this file owns. Module-level, so importing the module is all it
// takes for the compatibility report to know about them — with nothing
// constructed and no vault open. The class itself is declared by the barrel.
//
// **These twelve were `absent` until this task**, declared by `components.ts`
// beside a class whose every method threw. The class moved here and the bodies
// are real, so the rows say so; the three that are still inert say that too.
declarePolicy("Editor.getValue", "implemented");
declarePolicy("Editor.setValue", "implemented");
declarePolicy("Editor.getLine", "implemented");
declarePolicy("Editor.setLine", "implemented");
declarePolicy("Editor.lineCount", "implemented");
declarePolicy("Editor.lastLine", "implemented");
declarePolicy("Editor.getCursor", "implemented");
declarePolicy("Editor.setCursor", "implemented");
declarePolicy("Editor.getSelection", "implemented");
declarePolicy("Editor.setSelection", "implemented");
declarePolicy("Editor.somethingSelected", "implemented");
declarePolicy("Editor.replaceSelection", "implemented");
declarePolicy("Editor.replaceRange", "implemented");
declarePolicy("Editor.getRange", "implemented");
declarePolicy("Editor.transaction", "implemented");
declarePolicy("Editor.posToOffset", "implemented");
declarePolicy("Editor.offsetToPos", "implemented");
declarePolicy("Editor.wordAt", "implemented");
declarePolicy("Editor.focus", "safe_stub");
declarePolicy("Editor.blur", "safe_stub");
declarePolicy("Editor.refresh", "safe_stub");
