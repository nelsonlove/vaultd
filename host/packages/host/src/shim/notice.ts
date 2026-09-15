/**
 * `new Notice(...)`, and the one log every notice lands in.
 *
 * **The log records unconditionally, and that is the whole correction this
 * module carries.** The first design recorded notices only through the dry-run
 * gate, so `host.invoke_command`'s `notices` field was empty in normal
 * operation — the one mode anybody actually runs. Here the log is the host's
 * own, `new Notice(...)` always writes to it, and Task 19's `DryRunGate` reads
 * a *window* of it rather than keeping a second log of its own.
 *
 * **Why a mark rather than a timestamp.** `host.invoke_command` wants exactly
 * the notices one command produced. Two notices recorded inside the same
 * millisecond are indistinguishable by `atUnixMs` — and under a `TestClock`,
 * which does not move unless a case advances it, *every* notice in a case
 * shares one timestamp. So {@link NoticeLog.mark} hands back a sequence number
 * that only ever increases, and {@link NoticeLog.since} answers from it.
 *
 * **A ring buffer, because a plugin in a loop must not grow the host.** The
 * oldest entries are dropped once the limit is reached; `since(mark)` then
 * answers with what survives, which is the honest answer rather than a
 * pretended-complete one.
 */

import { currentPluginId, declarePolicy, recordUse } from "./policy";
import { StubEl, StubFragment } from "./dom";
import type { Clock } from "../config";

/**
 * One recorded notice.
 *
 * Exactly four fields, and no internal sequence number among them: this object
 * is what a client sees in an invoke response, and a bookkeeping field that
 * meant nothing outside the host would be one more thing to explain.
 */
export interface NoticeEntry {
  readonly pluginId: string | null;
  readonly message: string;
  readonly atUnixMs: number;
  readonly timeoutMs: number | null;
}

/** How many notices are kept when a caller does not say. */
const DEFAULT_LIMIT = 1000;

export class NoticeLog {
  private readonly clock: Clock;
  private readonly limit: number;
  /** Oldest first, at most {@link limit} long. */
  private readonly kept: NoticeEntry[] = [];
  /**
   * The sequence number of `kept[0]`.
   *
   * Kept as a separate counter so a dropped entry does not shift what an
   * outstanding mark means: a mark taken before a flood still answers with
   * everything that flood left behind, rather than with a window computed from
   * an index that has since moved.
   */
  private firstSeq = 0;
  private nextSeq = 0;

  constructor(deps: { clock: Clock; limit?: number }) {
    this.clock = deps.clock;
    this.limit = deps.limit ?? DEFAULT_LIMIT;
  }

  /**
   * Record one notice against whichever plugin is running.
   *
   * Attribution is ambient — {@link currentPluginId} — for the same reason
   * every policy hit's is: a `Notice` is constructed several layers below
   * anything that knows which plugin's `onload` is on the stack, and the
   * dispatch queue is a strict FIFO, so there is never a second plugin running
   * inside the window it opens.
   */
  record(message: string, timeoutMs: number | null): NoticeEntry {
    const entry: NoticeEntry = {
      pluginId: currentPluginId(),
      message,
      atUnixMs: this.clock.now(),
      timeoutMs,
    };
    this.kept.push(entry);
    this.nextSeq += 1;
    if (this.kept.length > this.limit) {
      const dropped = this.kept.length - this.limit;
      this.kept.splice(0, dropped);
      this.firstSeq += dropped;
    }
    return entry;
  }

  /** Every notice still kept, oldest first. */
  entries(): readonly NoticeEntry[] {
    return [...this.kept];
  }

  /** Where the log stands now. Pass it back to {@link since}. */
  mark(): number {
    return this.nextSeq;
  }

  /** Everything recorded after `mark`, as far back as the ring still reaches. */
  since(mark: number): readonly NoticeEntry[] {
    const from = Math.max(0, mark - this.firstSeq);
    return this.kept.slice(from);
  }

  /** Forget everything, and keep counting from where the log stood. */
  clear(): void {
    this.kept.length = 0;
    this.firstSeq = this.nextSeq;
  }
}

/**
 * Which log a given `Notice` class writes to.
 *
 * Keyed by the constructor rather than held in a module-level variable, so two
 * hosts in one process — a live host beside a harness — never record into each
 * other's log. {@link noticeClassFor} binds one; the base class below finds it
 * by walking `new.target`'s prototype chain, which is what keeps a plugin's own
 * `class MyNotice extends Notice` recording into the same place.
 */
const logs = new WeakMap<object, NoticeLog>();

/**
 * `Notice`, as a plugin constructs it: it shows nothing and it records.
 *
 * The constructor signature is Obsidian's exactly, which is why the log arrives
 * through {@link logs} rather than as a third parameter — a plugin writing
 * `new Notice("saved", 4000)` must reach the same class the host bound.
 *
 * An unbound base — `new Notice(...)` on the class this module exports, rather
 * than on the one a host bound — records nowhere rather than throwing. Nothing
 * in the host does that; a test importing the module directly might, and a
 * throw there would be a failure about the test's own wiring rather than about
 * anything a plugin can reach.
 */
export class Notice {
  readonly noticeEl: StubEl;
  readonly messageEl: StubEl;
  private readonly log: NoticeLog | null;
  private readonly timeoutMs: number | null;

  constructor(message: string | StubFragment, timeout?: number) {
    this.log = logFor(new.target);
    this.timeoutMs = timeout ?? null;
    this.noticeEl = new StubEl("div", { cls: "notice" });
    this.messageEl = this.noticeEl.createDiv({ cls: "notice-message" });
    // Written directly rather than through `setMessage`, so **one** notice
    // records **one** hit and **one** entry. Routing the constructor through
    // the setter cost a second `Notice` row in the compatibility report for
    // every notice ever raised, which reads as twice the use.
    this.write(message);
  }

  /**
   * Replace the text, and record the replacement as its own notice.
   *
   * Obsidian's `setMessage` is how a plugin turns one notice into a progress
   * indicator, so the second and third texts are as much a message to the user
   * as the first. Recording each one is what lets an invoke response report the
   * sequence rather than only whichever text happened to be last.
   */
  setMessage(message: string | StubFragment): this {
    this.write(message);
    return this;
  }

  /** Store the text and record it, once. */
  private write(message: string | StubFragment): void {
    const text = typeof message === "string" ? message : message.textContent;
    this.messageEl.setText(text);
    recordUse("Notice");
    this.log?.record(text, this.timeoutMs);
  }

  /** There is nothing on screen to take down. */
  hide(): void {
    recordUse("Notice.hide");
  }
}

/**
 * The `Notice` class one host binds, recording into that host's log.
 *
 * A subclass rather than a per-host copy of the class body, so
 * `x instanceof api.Notice` and `x instanceof Notice` are both true — a plugin
 * that holds a reference to one of them and tests against the other is not
 * doing anything unusual.
 */
export function noticeClassFor(log: NoticeLog): typeof Notice {
  const bound = class extends Notice {};
  Object.defineProperty(bound, "name", { value: "Notice" });
  logs.set(bound, log);
  return bound;
}

/** The nearest log bound to `target` or to anything it extends. */
function logFor(target: unknown): NoticeLog | null {
  let cursor: unknown = target;
  while (typeof cursor === "function") {
    const found = logs.get(cursor);
    if (found !== undefined) return found;
    cursor = Object.getPrototypeOf(cursor);
  }
  return null;
}

// The rows this file owns. `Notice` itself is declared by the barrel, with
// every other top-level export; these are the members.
declarePolicy("Notice.setMessage", "implemented");
declarePolicy("Notice.hide", "safe_stub");
