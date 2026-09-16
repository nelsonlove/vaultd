/**
 * `--dry-run`: every mutation recorded instead of performed, and the plugin
 * told it worked.
 *
 * **It is not a sandbox, and the explicit lists below are why that claim is
 * checkable.** A mitigation nobody can enumerate is not a mitigation, so this
 * module names what it intercepts and names what it does not, and the host's
 * `docs/protocol-host.md` carries the same two lists for a client to read.
 *
 * **Intercepted**
 *
 * - The nine mutating daemon verbs in {@link INTERCEPTED} — recorded, **not**
 *   forwarded, and answered with a response of the shape the daemon would have
 *   sent. A write into the headless config directory is recorded as
 *   `plugin_config`; everything else is `vault`.
 * - `requestUrl` / `request` — refused in `shim/helpers.ts` unless
 *   `--dry-run-allow-network`, and the refusal lands in {@link DryRunGate.refusals}.
 * - `electron.shell.openPath` / `showItemInFolder` / `openExternal` — refused in
 *   `runtime/electron-stub.ts`.
 * - `require` of the file-system modules (both spellings, named by the seam in
 *   `runtime/fs-access.ts`, which is the one file allowed to write them down),
 *   `node:child_process`, `node:http`, `node:https` and `node:net` from a
 *   plugin bundle — refused in `runtime/intercept.ts`.
 * - `new Notice(...)` and every log line — recorded, but **in every mode**: the
 *   log is `shim/notice.ts`'s and this gate reads a *window* of it rather than
 *   keeping a second one. See {@link DryRunGate.notices}.
 *
 * **Not intercepted, by design**
 *
 * - Reads, timers and CPU. A plugin that reads a note under `--dry-run` really
 *   reads it, an interval really fires, and a loop really spins.
 * - Any route to the file system that is not on the list above. Plugins run
 *   with this host's Node privileges, exactly as they do under Electron, and a
 *   bundle determined to reach the disk another way will succeed. Dry-run is
 *   the detector's runtime-harness backend and an evaluation tool; it is a
 *   guard rail, not a wall.
 *
 * **What a dry run cannot pretend.** Nothing is written, so the mirror gains no
 * row — `Mirror.applyMutation` is a no-op under the flag, because there is no
 * generation to come forward to. A plugin that creates a path and then uses the
 * `TFile` the create answered with is therefore told the mirror has no row for
 * it. That is a real limit of recording rather than performing, and it is named
 * here rather than papered over with an invented file.
 */

import { currentPluginId, setDryRunRefusalSink } from "../shim/policy";
import type { RequestSink } from "../client/request-sink";
import type { HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { NoticeEntry, NoticeLog } from "../shim/notice";

export type { DryRunRefused } from "../shim/policy";

/**
 * The one seam every host write passes through.
 *
 * Declared here, with the one implementation that is not the forwarding
 * default, because this is the task the seam exists for. `shim/vault.ts`
 * re-exports the type so its eight importers keep naming it where they always
 * did: every consumer names the type and none of them names an implementation,
 * which is what made the move free.
 */
export interface WriteGate {
  send<T>(method: string, params: unknown): Promise<T>;
}

/**
 * A `WriteGate` that forwards, which is what the host does when it is not
 * pretending.
 *
 * Beside {@link DryRunGate} rather than beside the assembler, so the two
 * implementations of one interface are read together. `testing/assemble.ts`
 * re-exports it for the callers that already import it from there.
 */
export function forwardingWriteGate(client: RequestSink): WriteGate {
  return {
    send<T>(method: string, params: unknown): Promise<T> {
      return client.request<T>(method, params);
    },
  };
}

/** One mutation a dry run recorded instead of performing. */
export interface RecordedWrite {
  readonly kind: "vault" | "plugin_config";
  readonly method: string;
  readonly params: unknown;
  readonly pluginId: string | null;
  readonly atUnixMs: number;
}

/** One refusal a dry run answered, as a report tallies them. */
export interface RecordedRefusal {
  readonly surface: string;
  readonly detail: string;
}

/**
 * The nine mutating verbs. Anything else — every read, and every operation a
 * later protocol version adds that this list has not been taught about — is
 * forwarded unchanged.
 *
 * **A deliberate allow-list rather than a deny-list.** A verb this host does
 * not know about is not silently swallowed and reported as a success that never
 * happened; it goes to the daemon, and whatever the daemon says about it is the
 * answer. The cost is that a *new* mutating verb has to be added here, which is
 * a line in a review rather than a silent hole in a report.
 */
const INTERCEPTED: ReadonlySet<string> = new Set([
  "write_note",
  "write_file",
  "patch_frontmatter",
  "create_folder",
  "rename_note",
  "rename_folder",
  "copy_file",
  "delete_note",
  "delete_folder",
]);

/**
 * The three verbs that can land in the headless config directory.
 *
 * `write_note` cannot: a note is vault content by definition, and the config
 * zone holds no notes. A rename or a copy names two paths and belongs to the
 * vault whichever end is where — there is no such thing as half a plugin-config
 * write.
 */
const CONFIG_CAPABLE: ReadonlySet<string> = new Set([
  "write_file",
  "create_folder",
  "delete_note",
  "delete_folder",
]);

/**
 * The revision a synthetic answer carries when nothing better is known: the
 * caller named no precondition and the mirror holds no row for the path.
 *
 * Stable rather than random, and spelled so a human reading a transcript can
 * see at a glance that no daemon produced it. A plugin that stores it and
 * passes it back as a precondition on the *next* write under the same dry run
 * gets a consistent answer; one that stores it and uses it in a real run gets a
 * `revision_conflict`, which is the correct outcome for a revision that never
 * described any bytes.
 */
const SYNTHETIC_REVISION = "blake3:dry-run";

/** Params carry a `path`, or two ends, or neither. Read defensively. */
interface MutationParams {
  readonly path?: unknown;
  readonly to?: unknown;
  readonly expected?: unknown;
}

export class DryRunGate implements WriteGate {
  private readonly client: RequestSink;
  private readonly config: HostConfig;
  private readonly noticeLog: NoticeLog;
  private readonly mirror: Mirror | null;
  private readonly recorded: RecordedWrite[] = [];
  private readonly refused: RecordedRefusal[] = [];
  /**
   * Where {@link notices} starts reading the shared log from.
   *
   * Re-taken by {@link clear}, which is the whole difference between a window
   * and a log: clearing a dry run's view must not erase notices that
   * `host.invoke_command` and the compatibility report are also reading.
   */
  private startMark: number;
  private installed = true;

  /**
   * `mirror` is optional, and the optionality is the brief's constructor
   * meeting a synthetic answer's needs.
   *
   * The three-argument form cannot see the mirror, and a synthetic success has
   * to carry the mirror's current generation and the path's current revision or
   * it is not the shape the daemon would have sent. So the mirror is a fourth
   * argument: a caller that has one (every assembly does) gets answers a plugin
   * can act on, and a caller that does not gets generation `0` and the
   * {@link SYNTHETIC_REVISION}, which is still the right *shape*.
   */
  constructor(client: RequestSink, config: HostConfig, noticeLog: NoticeLog, mirror?: Mirror) {
    this.client = client;
    this.config = config;
    this.noticeLog = noticeLog;
    this.mirror = mirror ?? null;
    this.startMark = noticeLog.mark();
    // Module-level, exactly as the policy recorder is installed, and for the
    // same reason: the three surfaces that refuse — the HTTP helpers, the
    // electron stub and the module patch — sit far below anything holding this
    // gate, and threading one through every call site would mean every call
    // site could be handed the wrong one.
    setDryRunRefusalSink(this);
  }

  send<T>(method: string, params: unknown): Promise<T> {
    if (!INTERCEPTED.has(method)) return this.client.request<T>(method, params);
    this.recorded.push({
      kind: this.kindOf(method, params),
      method,
      params,
      pluginId: currentPluginId(),
      atUnixMs: this.config.clock.now(),
    });
    return Promise.resolve(this.syntheticAnswer(method, params) as T);
  }

  /** Every mutation this run recorded instead of performing, in order. */
  writes(): readonly RecordedWrite[] {
    return [...this.recorded];
  }

  /**
   * The notices raised since this gate was built — **a view over the one shared
   * log**, not a second log.
   *
   * `shim/notice.ts` records unconditionally, so `host.invoke_command`'s
   * `notices` field is populated in normal operation too. This is the same
   * entries, windowed.
   */
  notices(): readonly NoticeEntry[] {
    return this.noticeLog.since(this.startMark);
  }

  /** Every typed refusal this run answered, in order. */
  refusals(): readonly RecordedRefusal[] {
    return [...this.refused];
  }

  /**
   * Forget this run's writes and refusals, and re-mark the notice window.
   *
   * The asymmetry is deliberate: the writes and the refusals are this gate's
   * own and are emptied; the notices belong to the host's log and are only
   * re-windowed. A clear that erased the shared log would take
   * `host.invoke_command`'s answer with it.
   */
  clear(): void {
    this.recorded.length = 0;
    this.refused.length = 0;
    this.startMark = this.noticeLog.mark();
  }

  /** The {@link setDryRunRefusalSink} contract. Not called by hand. */
  record(surface: string, detail: string): void {
    this.refused.push({ surface, detail });
  }

  /**
   * Stop receiving refusals. Called by the assembly's teardown, so a process
   * that tears one host down and builds another does not leave the first one's
   * gate collecting the second one's refusals.
   */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    setDryRunRefusalSink(null);
  }

  /**
   * `plugin_config` or `vault`, from the path — see {@link CONFIG_CAPABLE}.
   *
   * Derived here rather than passed in, because the call sites are the shim's
   * eleven write methods and none of them knows or should know which half of
   * the host's storage it is addressing. The directory is this host's own
   * (`.obsidian-headless` by default), never Obsidian's `.obsidian`: the host
   * reads that one and writes it never.
   */
  private kindOf(method: string, params: unknown): RecordedWrite["kind"] {
    if (!CONFIG_CAPABLE.has(method)) return "vault";
    const path = pathOf(params);
    if (path === null) return "vault";
    const root = this.config.configDirName;
    return path === root || path.startsWith(`${root}/`) ? "plugin_config" : "vault";
  }

  /**
   * The answer the daemon would have sent, per verb.
   *
   * Four shapes, and the shape has to be right rather than merely truthy: the
   * shim branches on `generation === undefined` in three places (a raw write or
   * a folder create in a hidden zone joins no generation, and answering `0`
   * there would send the caller down the indexed path), reads `revision` back
   * as the precondition for its next write, and reads `links_rewritten` off a
   * rename.
   */
  private syntheticAnswer(method: string, params: unknown): unknown {
    const generation = this.mirror?.generation() ?? 0;
    const revision = this.revisionFor(params);
    const semantic = this.kindOf(method, params) === "vault";
    switch (method) {
      case "write_note":
      case "patch_frontmatter":
      case "copy_file":
        return { generation, revision };
      case "write_file":
        // `semantic` answers "did these bytes land inside the indexed
        // universe", and `generation` is present exactly when it is true.
        return semantic ? { generation, revision, semantic } : { revision, semantic };
      case "create_folder":
      case "delete_note":
      case "delete_folder":
        return semantic ? { generation } : {};
      case "rename_note":
        return { generation, revision, links_rewritten: 0, link_rewrite_failures: [] };
      case "rename_folder":
        // No `revision`: a folder has no bytes to hash, and the wire omits it.
        return { generation, links_rewritten: 0, link_rewrite_failures: [] };
      default:
        // Unreachable: `send` forwards anything not in `INTERCEPTED`, and this
        // switch covers that set exactly.
        return { generation, revision };
    }
  }

  /**
   * The revision to echo: the caller's own precondition, then the mirror's row,
   * then {@link SYNTHETIC_REVISION}.
   *
   * The caller's precondition comes first because it is the strongest claim
   * available — `Vault.modify` reads the mirror for it one line before the send,
   * so echoing it keeps a read-your-writes caller consistent with itself — and
   * because `Editor.flush` and `Vault.process` both carry a revision the mirror
   * may not hold.
   */
  private revisionFor(params: unknown): string {
    const expected = (params as MutationParams | null)?.expected;
    const named = (expected as { revision?: unknown } | null | undefined)?.revision;
    if (typeof named === "string") return named;
    const path = pathOf(params);
    if (path !== null) {
      const held = this.mirror?.entry(path)?.revision;
      if (typeof held === "string") return held;
    }
    return SYNTHETIC_REVISION;
  }
}

/**
 * The path a mutation addresses: `path`, or a rename's or copy's destination.
 *
 * The **destination**, because that is where the bytes land and therefore which
 * half of the host's storage this write belongs to.
 */
function pathOf(params: unknown): string | null {
  const shaped = params as MutationParams | null;
  if (typeof shaped?.path === "string") return shaped.path;
  if (typeof shaped?.to === "string") return shaped.to;
  return null;
}
