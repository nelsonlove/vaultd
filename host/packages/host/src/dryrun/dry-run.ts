/**
 * `--dry-run`: every mutation recorded instead of performed, and the plugin
 * told it worked.
 *
 * **It is not a sandbox, and the explicit lists below are why that claim is
 * checkable.** A mitigation nobody can enumerate is not a mitigation, so this
 * module names what it intercepts and names what it does not, and the host's
 * `docs/protocol-host.md` carries the same two lists for a client to read.
 *
 * Both lists are enumerated from the code they describe, and
 * `docs/protocol-host.md`'s `## Dry-run` section carries the same two for a
 * client to read. A line that says "and so on" belongs in neither.
 *
 * **Intercepted**
 *
 * - The nine mutating daemon verbs in {@link INTERCEPTED} — recorded, **not**
 *   forwarded, and answered with a response of the shape the daemon would have
 *   sent. A write into the headless config directory is recorded as
 *   `plugin_config`; everything else is `vault`.
 * - **A connected client's own daemon request**, proxied through this host by
 *   `server/ops.ts`'s non-`host.` road: it goes through this same gate, so a
 *   client's `write_note` is recorded (with `pluginId: null`, because no plugin
 *   asked for it) and never reaches the daemon. Its *reads* still forward. A
 *   host that answered `dry_run: true` on `host.hello` and then let a client
 *   mutate the vault through its own socket would be the worst kind of dry run.
 * - `requestUrl` / `request` — refused in `shim/helpers.ts` unless
 *   `--dry-run-allow-network`, and the refusal lands in {@link DryRunGate.refusals}.
 * - `electron.shell.openPath` / `showItemInFolder` / `openExternal` — refused in
 *   `runtime/electron-stub.ts`.
 * - A plugin bundle's `require` of thirteen node builtins, **each in both its
 *   bare and its `node:`-prefixed spelling**, because the two are one module and
 *   a list naming one is a list a bundle walks around by accident: the two
 *   file-system modules and their promise variants (spelled by the seam in
 *   `runtime/fs-access.ts`, the one file allowed to write them down), then
 *   `child_process`, `http`, `https`, `http2`, `net`, `tls`, `dns`, `dgram`,
 *   `worker_threads`, `vm` and `inspector`. Refused in `runtime/intercept.ts`,
 *   which owns the list — if the two ever disagree, that file is right.
 *   **Pending its production wiring:** `installModuleInterception` has no
 *   non-test caller yet, so today only `test/module-intercept.test.ts` arms it.
 *   Task 22's `main.ts` is what makes this surface real in a shipped run, by
 *   passing `allowNodeBuiltins: !config.dryRun`.
 * - `new Notice(...)` and every log line — recorded, but **in every mode**: the
 *   log is `shim/notice.ts`'s and this gate reads a *window* of it rather than
 *   keeping a second one. See {@link DryRunGate.notices}.
 *
 * **Not intercepted, by design**
 *
 * - Reads, timers and CPU. A plugin that reads a note under `--dry-run` really
 *   reads it, an interval really fires, and a loop really spins. A change made
 *   by somebody else still reaches the mirror, too: dry-run is not read
 *   isolation.
 * - `localStorage` — `shim/globals.ts` persists it into the host's own data
 *   directory, not into the vault, and a dry run writes it for real. Plugins
 *   commonly keep state there, so a run that looks like it changed nothing may
 *   still have changed that.
 * - Any route to the file system that is not on the list above. Plugins run
 *   with this host's Node privileges, exactly as they do under Electron, and a
 *   bundle determined to reach the disk another way will succeed. Dry-run is
 *   the detector's runtime-harness backend and an evaluation tool; it is a
 *   guard rail, not a wall.
 *
 * **What a dry run cannot pretend, today.** Nothing is written, so the mirror
 * gains no row — `Mirror.applyMutation` is a no-op under the flag, because
 * there is no generation to come forward to. Two consequences follow, and both
 * belong to **Task 19b's dry-run overlay** rather than to this module: a
 * plugin that creates or copies a path and then uses the `TFile` the call
 * answered with is told the mirror has no row for it, and a plugin that writes
 * and then reads gets the bytes that are really on disk rather than its own —
 * so a transcript of several writes to one path does not compose. Named here
 * rather than papered over with an invented file.
 */

import { VaultdError } from "../client/errors";
import { currentDryRunRefusalSink, currentPluginId, setDryRunRefusalSink } from "../shim/policy";
import type { RequestSink } from "../client/request-sink";
import type { HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { NoticeEntry, NoticeLog } from "../shim/notice";

/**
 * Re-exported as a **value**, not a type, so a consumer that imports it from
 * this module can write `error instanceof DryRunRefused`. The class itself
 * lives in `shim/policy.ts`, beside `HeadlessUnsupported`, because the two are
 * this host's whole refusal vocabulary and a reader should meet them together.
 */
export { DryRunRefused } from "../shim/policy";

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

/**
 * Is this path inside the indexed universe?
 *
 * **The daemon's own predicate, not the config-directory one.** `kind` asks
 * "which half of this host's storage is this" and answers from
 * `configDirName` — that is ruling 5 and it is right. `semantic`, and whether a
 * synthetic answer carries a `generation` at all, ask a different question, and
 * `docs/protocol.md` answers it: a write "into the configuration zone, **or
 * into any hidden folder**, answers `semantic: false` with no `generation` —
 * nothing there is indexed, so no generation will ever contain it". Hidden
 * means a dot segment, anywhere in the path: `.obsidian/`, `.trash/`,
 * `.obsidian-headless/` and a plugin's own `.cache/` alike.
 *
 * `shim/adapter.ts`'s `isIndexedNote` is the precedent — the same split, spelled
 * the same way, for the same reason. Conflating the two questions is what made
 * `Vault.createFolder(".hidden/x")` throw under dry-run while it worked for
 * real: the gate answered with a generation the daemon would have withheld, and
 * the shim took the indexed branch on the strength of it.
 */
function isIndexedPath(path: string): boolean {
  return !path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * The verbs the daemon refuses outright on an unindexable path.
 *
 * `docs/protocol.md`: `read_file`, `read_dir`, `write_file` and `create_folder`
 * accept paths under `.obsidian/` and in hidden folders; "every other operation
 * refuses them with `zone_violation` — `write_note`, `patch_frontmatter`, the
 * renames, the copies, the deletes, and the two destructive folder verbs
 * alike". A dry run that answered one of those with a synthetic success would
 * put "worked" in a report for a call that cannot work — which is the one thing
 * a detector must never read.
 *
 * **Five of the seven are listed, and the two that are missing are missing
 * because nothing in this host can reach them at a dot path.** `write_note` and
 * `patch_frontmatter` are routed away from one before the gate ever sees them:
 * `DataAdapter.write`/`writeBinary`/`append` branch on `isIndexedNote` and send
 * `write_file` for a hidden path, and `FileManager.processFrontMatter` takes a
 * `TFile` the index owns — and the index holds no row for anything hidden. A
 * refusal for a call nothing can make would be untested code.
 *
 * **The other three are reachable, and the route is the adapter.**
 * `DataAdapter.rename` and `DataAdapter.copy` take the caller's own two paths
 * with no indexability check and send `rename_note`, `rename_folder` or
 * `copy_file` straight through. `app.vault.adapter` is an ordinary documented
 * surface — it is the one `HeadlessConfigDir` itself uses — so a plugin
 * shuffling a file inside its own cache directory under `.obsidian-headless/`,
 * or inside `.trash/` or `.obsidian/`, hits exactly this. Until they were
 * listed here those calls answered a synthetic success and recorded a row
 * saying the daemon would have done it, for a call the daemon refuses.
 *
 * The daemon checks **both ends, source first** (`crates/vault-index/src/mutate.rs`:
 * "a path the scan never lists is a path this operation cannot address in
 * either direction"), and so does {@link offendingZonePath}.
 */
const ZONE_REFUSING: ReadonlySet<string> = new Set([
  "delete_note",
  "delete_folder",
  "rename_note",
  "rename_folder",
  "copy_file",
]);

/** Params carry a `path`, or two ends, or neither. Read defensively. */
interface MutationParams {
  readonly path?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly expected?: unknown;
}

/**
 * The gate `--dry-run` installs in place of the forwarding one.
 *
 * **One per process is the supported shape.** The refusal sink it installs is
 * module-level, like the policy recorder and for the same reason, so the
 * last gate constructed is the one every refusal reaches. Production builds
 * exactly one (`main.ts` starts one host); two live gates at once is a
 * test-only situation, and {@link uninstall} is written for it — it clears the
 * module sink **only if this gate still owns it**, so tearing the first one
 * down does not take the second one's installation with it.
 */
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
    // **Refused before it is recorded**, because it did not happen — not even
    // in the pretend sense the other rows describe. A `writes()` row means "the
    // daemon would have done this"; a `zone_violation` means it would have
    // refused, and putting one in the transcript as a recorded write would tell
    // a detector the opposite of the truth.
    if (ZONE_REFUSING.has(method)) {
      const offending = offendingZonePath(params);
      if (offending !== null) return Promise.reject(zoneViolation(offending));
    }
    this.recorded.push({
      kind: this.kindOf(method, params),
      method,
      // **Cloned, not aliased.** A recorded write is read after the fact — by a
      // report, by the detector, by a human reading a transcript — and a row
      // that held the caller's own object would follow any later mutation of
      // it. Every shim call site builds a fresh literal today, so this costs a
      // copy and closes a class of bug rather than a live one.
      params: clone(params),
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
   *
   * **Only if this gate still owns the sink.** Last-installed wins, so a second
   * gate built while this one is alive has already displaced it; clearing the
   * module sink unconditionally here would then uninstall *that* gate, and the
   * next refusal would reach nobody. Measured before the guard existed: gate A
   * torn down silently deafened gate B.
   */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    if (currentDryRunRefusalSink() === this) setDryRunRefusalSink(null);
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
   *
   * **`semantic` is {@link isIndexedPath}, not {@link kindOf}.** The two look
   * alike and answer different questions — see `isIndexedPath` for the
   * divergence this cost, measured against the release daemon.
   */
  private syntheticAnswer(method: string, params: unknown): unknown {
    const generation = this.mirror?.generation() ?? 0;
    const revision = this.revisionFor(params);
    const path = pathOf(params);
    const semantic = path === null || isIndexedPath(path);
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

/**
 * The end of a mutation that lies outside the indexed universe, or `null` when
 * neither does.
 *
 * **Both ends, source first**, which is the daemon's own order: `copy_file`,
 * `rename_note` and `rename_folder` each check `from` and then `to` before
 * touching the filesystem, and the error names whichever end tripped first. A
 * check that read only the destination would let a plugin move a note *out* of
 * `.trash/` and be told it worked.
 *
 * Distinct from {@link pathOf}, which answers "where do the bytes land" for
 * classification and for the synthetic revision, and therefore prefers the
 * destination. Two questions, two readings of the same object.
 */
function offendingZonePath(params: unknown): string | null {
  const shaped = params as MutationParams | null;
  for (const end of [shaped?.path, shaped?.from, shaped?.to]) {
    if (typeof end === "string" && !isIndexedPath(end)) return end;
  }
  return null;
}

/**
 * The refusal the daemon would have sent, as the daemon sends it.
 *
 * A {@link VaultdError} rather than an error of this module's own, with the
 * daemon's code and the daemon's message verbatim from
 * `crates/vault-index/src/mutate.rs` (`docs/protocol.md` lists the code). A
 * caller that catches `zone_violation` from a real run must catch the same
 * thing here — anything else would make the refusal a fact about the flag
 * rather than about the operation.
 */
function zoneViolation(path: string): VaultdError {
  return new VaultdError({
    code: "zone_violation",
    message: `${path} is outside the vault, or is not a valid target for this operation`,
  });
}

/**
 * A deep copy of a recorded mutation's params. See {@link DryRunGate.send}.
 *
 * `structuredClone` rather than a JSON round trip: the params are plain wire
 * objects today, but a JSON copy would silently drop an `undefined` and rewrite
 * a `Date`, and a transcript that quietly differs from what was sent is worse
 * than one that throws. A value it cannot clone is kept by reference rather
 * than losing the row — the report's honesty matters more than its immutability.
 */
function clone(params: unknown): unknown {
  try {
    return structuredClone(params);
  } catch {
    return params;
  }
}
