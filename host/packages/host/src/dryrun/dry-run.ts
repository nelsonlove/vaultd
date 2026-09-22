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
 * **What a dry run pretends instead, and where.** Nothing is written, so the
 * mirror gains no row — `Mirror.applyMutation` is a no-op under the flag,
 * because there is no generation to come forward to. What closes the gap is
 * {@link DryRunOverlay}, which this gate owns: every mutation it records also
 * lands there, and the file index and the read paths consult it. A plugin that
 * creates, copies or renames a path and then uses the `TFile` the call answered
 * with gets one; a plugin that writes and then reads gets its own bytes, so a
 * transcript of several writes to one path composes.
 *
 * Four rules bound it, and each is a promise this module keeps rather than a
 * detail of the implementation:
 *
 * - **Nothing is written into the `Mirror`.** The mirror mirrors the daemon, and
 *   a row the daemon never produced would pollute the metadata cache, link
 *   resolution and the server's snapshots, and would fight the next resync. The
 *   overlay is a second, smaller structure, consulted after the mirror for a
 *   node and before it for bytes.
 * - **Precedence is removed, then overlay bytes, then the mirror.** A path this
 *   run deleted, trashed, or renamed away reads as gone — including everything
 *   under it — whatever is really on disk, and its node leaves its parent's
 *   `children` as well as every listing. The **one exception** is a path this
 *   run *invented* that the daemon has since really made: the pretend file gives
 *   way to the real one, everywhere at once, because a plugin holding a `TFile`
 *   with zero times for a file that exists is the contradiction all of this is
 *   here to prevent. A path the run merely *modified* keeps answering the run's
 *   own bytes; that is read-your-writes, and the mirror holding a row for it is
 *   not news.
 * - **Metadata stays the mirror's.** `getFileCache` of an overlay-only file
 *   answers `null`, and of a modified one answers the daemon's cached metadata,
 *   stale by design: a dry run does not re-parse its own bytes. A synthetic
 *   node's `stat` carries the recorded byte length and zero times, because a dry
 *   run invents no clock readings either.
 * - **No vault events are fired for synthetic writes.** `create`, `modify`,
 *   `rename` and `delete` events come from a mirror batch, the mirror does not
 *   move, and nothing here manufactures one. A plugin listening to its own
 *   writes hears nothing under `--dry-run`.
 *
 * **What consults it.** `Vault`'s reads and its file index, `DataAdapter`'s
 * `read`/`readBinary`/`append`/`exists`/`stat`/`list`, `Plugin.loadData`, and
 * `HeadlessConfigDir`'s read half — so the two readers of a plugin's
 * `data.json` agree, and `host.set_plugin_config`'s read-modify-write merges
 * over a save the plugin made in the same run rather than erasing it.
 *
 * **Two things it deliberately does not do.** `patch_frontmatter` records no
 * bytes, because `FileManager.processFrontMatter` sends key-path patches and
 * never serializes a note, so a frontmatter read after a dry-run patch is the
 * pre-patch text. And `HeadlessConfigDir.listInstalled` walks the config
 * directory with `read_dir`, which is the daemon's own listing and knows
 * nothing of this — so a plugin folder a dry run "created" is not an installed
 * plugin. Both are deliberate and both are in `docs/protocol-host.md`.
 */

import { VaultdError } from "../client/errors";
import { currentDryRunRefusalSink, currentPluginId, setDryRunRefusalSink } from "../shim/policy";
import { enabledSetPath } from "../pluginset/config-dir";
import type { ReadFileResponse } from "../client/protocol";
import type { RequestSink } from "../client/request-sink";
import type { HostConfig } from "../config";
import type { Mirror } from "../mirror/mirror";
import type { MirrorQuery } from "../mirror/types";
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
  /**
   * What this gate is pretending exists, when it is pretending at all.
   *
   * Optional, and absent on {@link forwardingWriteGate}: a gate that really
   * writes has nothing to overlay, and the consultation points all spell the
   * question `gate.overlay` rather than testing for a class. That is what keeps
   * `shim/vault.ts`, `shim/adapter.ts` and `shim/plugin.ts` free of a value
   * import of {@link DryRunGate} — and what makes a harness that injects its
   * own gate work unchanged.
   */
  readonly overlay?: DryRunOverlay;
}

/**
 * What a dry run pretends exists: paths it synthesised, and the last bytes it
 * recorded for any path.
 *
 * Read-only to every consumer. {@link DryRunGate} owns the one implementation
 * and is the only thing that writes it, from the mutations it is already
 * recording.
 */
export interface DryRunOverlay {
  /** A folder or file the run created, renamed into, or copied to; absent from the mirror. */
  has(path: string): boolean;
  /** The last content recorded for `path` by this run, or null when the run never wrote it. */
  contentOf(path: string): string | Uint8Array | null;
  /** Paths the run deleted or renamed away, so a later read reports them gone. */
  removed(path: string): boolean;
  /** Synthetic rows for `getAbstractFileByPath` / listing: kind, and the synthetic revision the gate answered. */
  entry(path: string): { kind: "file" | "folder"; revision: string | null } | null;
  /**
   * Where `path`'s bytes really are, for a path the run renamed or copied into
   * whose source it never wrote.
   *
   * **Beyond the brief's four, and the alternative was worse.** Ruling 5 says a
   * rename's destination takes "the source's bytes (overlay's if present, else
   * the mirror's content read through the daemon)". Reading them *into* the
   * overlay would make {@link DryRunGate.send} issue a `read_file` — per
   * descendant, for a folder move — from inside a synchronous recording step.
   * Naming the source instead costs nothing, and the read happens where every
   * other read happens: at the read path, on demand, once.
   */
  sourceOf(path: string): string | null;
  /**
   * Every path this run holds a row for and has not since removed.
   *
   * **Beyond the brief's four**, because `FileIndex` has to *enumerate* the
   * synthetic nodes to put them in the tree — `has(path)` answers about a path
   * the caller already knows, and `getFiles()` knows none.
   */
  paths(): readonly string[];
  /**
   * The roots this run removed: the paths a delete, a trash or a rename's
   * source named, whether or not anything still stands at them.
   *
   * **Beyond the brief's four**, and the counterpart to {@link paths} for the
   * other half of the tree's job: `FileIndex` has to take a removed node out of
   * its parent's `children` and put it back if the overlay is cleared, and
   * asking `removed()` about every node in the vault to find out which ones is
   * the cost this avoids. A removal covers its whole subtree, so the roots are
   * all the index needs — everything under one leaves the tree with it.
   */
  removedPaths(): readonly string[];
  /**
   * A counter bumped by every record and by every {@link DryRunGate.clear}.
   *
   * **Beyond the brief's four**, so that a consumer caching a reconciliation
   * against this overlay can tell in one integer comparison that nothing has
   * changed. `FileIndex.get` is on the link-resolution path and is called once
   * per link in every note; walking {@link paths} there would be a real cost for
   * a question that is almost always "nothing moved".
   */
  version(): number;
}

/** What a read of one path should do under a dry run. See {@link overlayRead}. */
export type OverlayRead =
  /** The run removed it: answer the way a missing path answers. */
  | { readonly kind: "gone" }
  /** The run wrote it: these bytes, not the daemon's. */
  | { readonly kind: "bytes"; readonly content: string | Uint8Array }
  /** The run moved or copied it here; the bytes are still at this other path. */
  | { readonly kind: "elsewhere"; readonly path: string };

/**
 * The one precedence rule, written once: removed, then overlay bytes, then the
 * source a rename or a copy named, then `null` for "ask the daemon".
 *
 * Every read path in the shim calls this rather than spelling the three
 * branches itself, because three spellings of one precedence is three chances
 * to disagree about it.
 *
 * **The `elsewhere` path is read unconditionally**, and that is deliberate: a
 * rename marks its source removed, and the destination's bytes are exactly the
 * bytes at that removed path. Checking `removed` again on the way through would
 * make every renamed file unreadable.
 */
export function overlayRead(
  overlay: DryRunOverlay | undefined,
  path: string,
): OverlayRead | null {
  if (overlay === undefined) return null;
  if (overlay.removed(path)) return { kind: "gone" };
  const content = overlay.contentOf(path);
  if (content !== null) return { kind: "bytes", content };
  const source = overlay.sourceOf(path);
  if (source !== null && source !== path) return { kind: "elsewhere", path: source };
  return null;
}

/** Recorded content as text. A dry run's own bytes are UTF-8 if they are text at all. */
export function overlayText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
}

/** Recorded content as bytes. */
export function overlayBytes(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

/**
 * One path's current bytes and the revision to write against — **the one read
 * that knows about the overlay**, and the only implementation of its
 * precedence.
 *
 * `Vault.read`, `Vault.readBinary`, `Vault.process`, `DataAdapter.read`,
 * `DataAdapter.readBinary` and `DataAdapter.append` all go through it. Three
 * classes spelling the same three branches would be three chances to disagree
 * about what "current" means, and the one that disagreed would be the one a
 * plugin's compare-and-swap loop ran on.
 *
 * The revision is the **addressed path's**, never the source's: for a path a
 * rename or a copy put here, the bytes come from wherever they really are and
 * the precondition is the one the gate answered for the destination. Writing
 * the source's revision back at the destination would be a precondition
 * describing a different file.
 */
export async function readThroughOverlay(
  client: RequestSink,
  overlay: DryRunOverlay | undefined,
  path: string,
): Promise<{ content: Buffer; revision: string | undefined }> {
  const overlaid = overlayRead(overlay, path);
  if (overlaid?.kind === "gone") throw missingPath(path);
  const held = overlay?.entry(path)?.revision ?? undefined;
  if (overlaid?.kind === "bytes") {
    return { content: overlayBytes(overlaid.content), revision: held };
  }
  const response = await client.request<ReadFileResponse>("read_file", {
    path: overlaid?.kind === "elsewhere" ? overlaid.path : path,
  });
  return {
    content: Buffer.from(response.content_base64, "base64"),
    // **The overlay's revision whenever it holds one**, so that `process`,
    // `append` and `modify` state the same precondition for one path. The
    // fall-through case that made them disagree is `patch_frontmatter`, which
    // records a revision and no bytes: the bytes then come off the wire and the
    // wire's revision is the *pre-patch* one, while `Vault.expectedFor` was
    // already answering the patch's (review finding N6).
    revision: held ?? response.revision,
  };
}

/**
 * The refusal a read of a path this run removed answers with.
 *
 * The daemon's own code and the daemon's own message — `MutationError::NotFound`
 * is `#[error("{} does not exist", path.as_str())]` — so a plugin that catches
 * `not_found` from a real run catches the same thing here. A refusal that were a
 * fact about the flag rather than about the path would be a worse lie than the
 * stale read it replaces.
 */
export function missingPath(path: string): VaultdError {
  return new VaultdError({ code: "not_found", message: `${path} does not exist` });
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

/** One path's row in the overlay. Sequenced, so a create after a delete wins. */
interface OverlayRow {
  readonly seq: number;
  readonly kind: "file" | "folder";
  readonly revision: string | null;
  readonly content: string | Uint8Array | null;
  readonly source: string | null;
  /**
   * Did this row invent a path the mirror had no row for, or restate one it
   * already held?
   *
   * The two behave differently the moment the daemon produces a row at the same
   * path — see {@link RecordedOverlay.superseded}. A `modify` of a note that
   * exists keeps answering the run's own bytes for ever, because that is
   * read-your-writes; a `create` of a note the daemon then really creates gives
   * way, because pretending past a fact is how a plugin comes to see two worlds.
   */
  readonly synthesised: boolean;
}

/** What {@link RecordedOverlay.put} is told; an omitted field keeps what was there. */
interface OverlayPatch {
  readonly kind: "file" | "folder";
  readonly revision: string | null;
  readonly content?: string | Uint8Array | null;
  readonly source?: string | null;
}

/**
 * The gate's overlay, as a pair of maps and a sequence number.
 *
 * **The sequence is what makes order legible.** A path can be created, deleted
 * and created again inside one run, and a removal covers a whole subtree by
 * prefix — so "is this removed" is not a set membership question but a
 * comparison: the newest removal covering the path against the row's own stamp.
 * Without it, a plugin that cleans a folder out and rebuilds it would find its
 * rebuild invisible.
 */
class RecordedOverlay implements DryRunOverlay {
  private readonly rows = new Map<string, OverlayRow>();
  private readonly removals = new Map<string, number>();
  private seq = 0;
  private stamp = 0;

  /**
   * The mirror, read-only, so a row can tell when the daemon has overtaken it.
   *
   * `null` only for a gate built without one — the three-argument constructor,
   * which is a test shape. A run with no mirror can never be overtaken.
   */
  constructor(private readonly mirror: MirrorQuery | null) {}

  has(path: string): boolean {
    return this.rowFor(path) !== null;
  }

  contentOf(path: string): string | Uint8Array | null {
    return this.rowFor(path)?.content ?? null;
  }

  sourceOf(path: string): string | null {
    return this.rowFor(path)?.source ?? null;
  }

  entry(path: string): { kind: "file" | "folder"; revision: string | null } | null {
    const row = this.rowFor(path);
    return row === null ? null : { kind: row.kind, revision: row.revision };
  }

  removed(path: string): boolean {
    const at = this.removalSeq(path);
    if (at === null) return false;
    const row = this.rows.get(path);
    return row === undefined || row.seq < at;
  }

  paths(): readonly string[] {
    const live: string[] = [];
    for (const path of this.rows.keys()) if (this.rowFor(path) !== null) live.push(path);
    return live;
  }

  removedPaths(): readonly string[] {
    return [...this.removals.keys()];
  }

  version(): number {
    return this.stamp;
  }

  // --- Written by the gate, and by nothing else -------------------------------

  /** Record what one path now is. An omitted `content` or `source` is kept. */
  put(path: string, patch: OverlayPatch): void {
    const carried = this.rowFor(path);
    this.seq += 1;
    this.stamp += 1;
    this.rows.set(path, {
      seq: this.seq,
      kind: patch.kind,
      revision: patch.revision,
      content: patch.content === undefined ? (carried?.content ?? null) : patch.content,
      source: patch.source === undefined ? (carried?.source ?? null) : patch.source,
      // Decided once, when the row is first laid down, and carried by every
      // later write to the same path: what matters is whether this run *invented*
      // the path, not whether the daemon has since caught up with it.
      synthesised: carried?.synthesised ?? this.mirror?.entry(path) === undefined,
    });
  }

  /** Record that `path`, and everything under it, is gone. */
  remove(path: string): void {
    this.seq += 1;
    this.stamp += 1;
    this.removals.set(path, this.seq);
  }

  /** Forget everything. {@link DryRunGate.clear}'s half of the asymmetry. */
  reset(): void {
    this.rows.clear();
    this.removals.clear();
    this.stamp += 1;
  }

  /** The row for a path that is neither removed nor overtaken, or `null`. */
  private rowFor(path: string): OverlayRow | null {
    const row = this.rows.get(path);
    if (row === undefined || this.removed(path) || this.superseded(path, row)) return null;
    return row;
  }

  /**
   * Has the daemon produced a real row at a path this run invented?
   *
   * Then the run's pretend file gives way to the real one, everywhere at once:
   * the index installs the mirror's node, `read` answers the daemon's bytes,
   * `stat` answers the daemon's times, and `exists` is true because the mirror
   * says so rather than because this overlay does. The alternative is the
   * measured contradiction of review finding B1 — a plugin holding a `TFile`
   * with `{ctime: 0}` for a file that really exists, reading seven pretend bytes
   * out of a nine-byte file.
   *
   * **Only for a path this run invented.** A `modify` of a note that already
   * existed keeps answering the run's own bytes for the life of the run; that is
   * read-your-writes, and the mirror holding a row for it is not news.
   */
  private superseded(path: string, row: OverlayRow): boolean {
    return row.synthesised && this.mirror?.entry(path) !== undefined;
  }

  /**
   * The newest removal covering `path` — its own, or an ancestor's.
   *
   * **Walks the path's own ancestors rather than the removal set**, so the cost
   * is the path's depth and not the number of paths this run has deleted.
   * `removed()` is asked once per row by `paths()` and once per node in the
   * vault by `FileIndex.live()`, so scanning the removals here made a plugin
   * that deletes a few hundred paths quadratic on `getFiles()` (review finding
   * N7).
   */
  private removalSeq(path: string): number | null {
    if (this.removals.size === 0) return null;
    let newest = this.removals.get(path) ?? null;
    for (let at = parentOf(path); at !== ""; at = parentOf(at)) {
      const seq = this.removals.get(at);
      if (seq !== undefined && (newest === null || seq > newest)) newest = seq;
    }
    return newest;
  }
}

/** Params carry a `path`, or two ends, or neither. Read defensively. */
interface MutationParams {
  readonly path?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly expected?: unknown;
  readonly content?: unknown;
  readonly content_base64?: unknown;
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
   * What this run pretends exists. Owned here, read everywhere.
   *
   * The concrete type is private and the public one is the read-only
   * {@link DryRunOverlay}: the gate is the only writer, and a consumer that
   * could `put` into it would be inventing a file the report never mentions.
   */
  private readonly overlayState: RecordedOverlay;
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
   * The compatibility probe running right now, and the rows it has caused.
   *
   * Sets of the row objects themselves, so removal is by identity: two writes
   * of the same bytes to the same path are two rows, and only the one the
   * probe caused may go. See {@link beginProbe}.
   */
  private probe: {
    readonly token: string;
    readonly pluginId: string;
    readonly writes: Set<RecordedWrite>;
    readonly refusals: Set<RecordedRefusal>;
  } | null = null;
  private probeSeq = 0;

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
    this.overlayState = new RecordedOverlay(this.mirror);
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
    const row: RecordedWrite = {
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
    };
    this.recorded.push(row);
    this.tagForProbe(row, params);
    const answer = this.syntheticAnswer(method, params);
    // **After the answer, because the answer is where the revision comes
    // from.** Ruling 4: the synthetic revision this call hands back is the one
    // `overlay.entry(path).revision` reports and the one the caller's *next*
    // write must carry as its precondition, so recording it from anywhere else
    // would be recording a second opinion.
    this.recordOverlay(method, params, answer);
    return Promise.resolve(answer as T);
  }

  /** What this run pretends exists. See {@link DryRunOverlay}. */
  get overlay(): DryRunOverlay {
    return this.overlayState;
  }

  /** Every mutation this run recorded instead of performing, in order. */
  writes(): readonly RecordedWrite[] {
    return [...this.recorded];
  }

  /**
   * Start tagging the rows a compatibility probe of `pluginId` causes.
   *
   * **Tagged at record time, never selected by position afterwards.** The
   * first version of this pair marked the two logs and truncated back to the
   * mark, which deleted every row *anybody* recorded in between: a bystander
   * plugin's write from a handler the probed plugin's load woke, and a second
   * client's `write_note` sent while the probe was open, both measured. A
   * probe's window is not a period of time the detector owns — the host goes
   * on serving everyone through it.
   *
   * What the tag claims, exactly:
   *
   * - **any row whose `pluginId` is the probed plugin.** That is the plugin
   *   nobody asked to run, so its writes are the detector's doing.
   * - **a write to `<configDir>/community-plugins.json`.** The lifecycle's own
   *   bookkeeping on the way in and out, which carries `pluginId: null`
   *   because it belongs to the host rather than to a plugin. This is the one
   *   part that is a shape rather than an identity, and the residual is
   *   stated: a *client* rewriting the enabled set itself while a probe is
   *   open would be tagged with it. Nothing else the host does writes that
   *   path, and the alternative — leaving the two rewrites in — tells the
   *   operator this host intends to change the enabled set, which it does not.
   *
   * Everything else recorded while a probe is open is somebody else's and
   * stays — **as long as its row carries somebody else's id**, which is the
   * part that is a property of the attribution window rather than of this tag.
   * Attribution is ambient over a plugin's `await`s (see `shim/policy.ts`'s
   * {@link enterPlugin}), and the thing parked on an `await` during a probe is
   * precisely the probed plugin's `onload`. So a row recorded by an actor that
   * is *not* the probed plugin is only safe here if that actor sets its own id.
   * The client road does: `server/ops.ts` dispatches every non-`host.` method
   * inside `enterPlugin(null, …)`, so a client's `write_note` sent through a
   * probe's window is `pluginId: null`, is not tagged, and survives
   * {@link dropProbe}. Measured before that window existed: it was tagged with
   * the probed plugin's id and deleted. The residual that remains is a
   * host-internal callback firing inside a parked window, which does inherit
   * the plugin's id; it is named under "Known limits" in
   * `docs/design/headless-plugin-host.md`.
   *
   * Returns the token {@link dropProbe} takes.
   */
  beginProbe(pluginId: string): string {
    const token = `probe-${String(this.probeSeq++)}-${pluginId}`;
    this.probe = { token, pluginId, writes: new Set(), refusals: new Set() };
    return token;
  }

  /**
   * Stop tagging, and remove the rows this probe's token carries. **Harness-only.**
   *
   * Not a general undo, and it must not become one: a dry run's write log is
   * what an operator reads to decide whether the run is safe to perform for
   * real, and a caller that could delete rows from it could hide a write the
   * host would make. The one caller that may is the detector, because the rows
   * it removes are rows *it* caused by loading a plugin nobody asked to run —
   * and {@link beginProbe} is where "it caused" is decided, at record time,
   * one row at a time.
   *
   * **What it cannot take back is the overlay.** A recorded write also put
   * bytes in {@link DryRunGate.overlay}, and those have no per-row removal:
   * for the rest of the session a note the probe modified reads back modified.
   * The detector says so in its own result rather than pretending otherwise.
   *
   * A token that is not the open probe's removes nothing: a probe whose rows
   * were already dropped has nothing left to drop, and a stale token must not
   * reach into a later probe's window.
   */
  dropProbe(token: string): void {
    const probe = this.probe;
    if (probe === null || probe.token !== token) return;
    this.probe = null;
    keepUntagged(this.recorded, probe.writes);
    keepUntagged(this.refused, probe.refusals);
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
    this.overlayState.reset();
    this.startMark = this.noticeLog.mark();
  }

  /** The {@link setDryRunRefusalSink} contract. Not called by hand. */
  record(surface: string, detail: string): void {
    const row: RecordedRefusal = { surface, detail };
    this.refused.push(row);
    // A refusal carries no plugin id of its own, so the attribution is taken
    // here, where `currentPluginId()` still names whoever is running. Only the
    // probed plugin's refusals are the probe's; a bystander refused inside the
    // window keeps its row, exactly as its writes do.
    if (this.probe !== null && currentPluginId() === this.probe.pluginId) {
      this.probe.refusals.add(row);
    }
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

  /** See {@link beginProbe} for what the tag claims and what it deliberately does not. */
  private tagForProbe(row: RecordedWrite, params: unknown): void {
    const probe = this.probe;
    if (probe === null) return;
    if (row.pluginId === probe.pluginId || pathOf(params) === this.enabledSetPath()) {
      probe.writes.add(row);
    }
  }

  private enabledSetPath(): string {
    return enabledSetPath(this.config.configDirName);
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
   * Put one recorded mutation into the overlay, per verb.
   *
   * The same nine verbs {@link INTERCEPTED} names, and the mapping is the whole
   * of what "the plugin sees success" means after the call returns: bytes for
   * the three that carry bytes, a node for the two that make one, a removal for
   * the two that take one away, and both for the two that move one.
   *
   * **`patch_frontmatter` records a row and no bytes.**
   * `FileManager.processFrontMatter` sends key-path patches and deliberately
   * never serializes a note — that is the whole reason it does not rewrite the
   * user's YAML — so there is no patched text here to record. The row still
   * carries the revision the call answered, so the *next* write to that note
   * states the right precondition; the bytes a later read sees are the ones
   * before the patch. Named in the module header and in `docs/protocol-host.md`.
   */
  private recordOverlay(method: string, params: unknown, answer: unknown): void {
    const path = (params as MutationParams | null)?.path;
    const revision = revisionOf(answer);
    switch (method) {
      case "write_note":
        if (typeof path !== "string") return;
        this.overlayState.put(path, {
          kind: "file",
          revision,
          content: typeof (params as MutationParams).content === "string"
            ? ((params as MutationParams).content as string)
            : null,
          source: null,
        });
        return;
      case "write_file": {
        if (typeof path !== "string") return;
        const encoded = (params as MutationParams).content_base64;
        this.overlayState.put(path, {
          kind: "file",
          revision,
          content:
            typeof encoded === "string" ? new Uint8Array(Buffer.from(encoded, "base64")) : null,
          source: null,
        });
        return;
      }
      case "patch_frontmatter":
        if (typeof path !== "string") return;
        this.overlayState.put(path, { kind: "file", revision });
        return;
      case "create_folder":
        if (typeof path !== "string") return;
        this.overlayState.put(path, {
          kind: "folder",
          revision: null,
          content: null,
          source: null,
        });
        return;
      case "delete_note":
      case "delete_folder":
        if (typeof path !== "string") return;
        this.overlayState.remove(path);
        return;
      case "rename_note":
      case "rename_folder":
      case "copy_file": {
        const shaped = params as MutationParams | null;
        const from = shaped?.from;
        const to = shaped?.to;
        if (typeof from !== "string" || typeof to !== "string") return;
        this.graft(from, to, method === "rename_folder" ? "folder" : "file", revision);
        if (method !== "copy_file") this.overlayState.remove(from);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Put `from`'s whole subtree down at `to`, for a rename or a copy.
   *
   * **The subtree, not the named pair**, for the same reason `Vault.rename`
   * refetches one: the wire's answer names two paths and a folder move carries
   * every row under them. A dry run that moved only the named pair would leave
   * a plugin that renames a folder and then walks it seeing nothing at the new
   * path — the failure this task exists to stop, one level down.
   *
   * Bytes come across when the run itself wrote them; otherwise the destination
   * **names its source** and the read path fetches from there, so no read
   * happens inside this synchronous recording step. A chain of moves follows the
   * chain back to the path that really holds the bytes.
   */
  private graft(from: string, to: string, kindOfFrom: "file" | "folder", revision: string | null): void {
    for (const source of this.subtreeOf(from)) {
      const destination = `${to}${source.slice(from.length)}`;
      const content = this.overlayState.contentOf(source);
      this.overlayState.put(destination, {
        kind: source === from ? kindOfFrom : this.kindAt(source),
        revision: source === from ? revision : this.revisionAt(source),
        content,
        source: content === null ? (this.overlayState.sourceOf(source) ?? source) : null,
      });
    }
  }

  /** `from` and every live path under it, the overlay's and the mirror's, parents first. */
  private subtreeOf(from: string): string[] {
    const prefix = `${from}/`;
    const under = new Set<string>([from]);
    for (const path of this.overlayState.paths()) if (path.startsWith(prefix)) under.add(path);
    for (const entry of this.mirror?.entries() ?? []) {
      if (entry.path.startsWith(prefix) && !this.overlayState.removed(entry.path)) {
        under.add(entry.path);
      }
    }
    return [...under].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private kindAt(path: string): "file" | "folder" {
    const held = this.overlayState.entry(path);
    if (held !== null) return held.kind;
    return this.mirror?.entry(path)?.kind === "folder" ? "folder" : "file";
  }

  private revisionAt(path: string): string | null {
    const held = this.overlayState.entry(path);
    if (held !== null) return held.revision;
    return this.mirror?.entry(path)?.revision ?? null;
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
/** A path's parent, or `""` at the vault root. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** The revision a synthetic answer carried, when it carried one. */
function revisionOf(answer: unknown): string | null {
  const named = (answer as { revision?: unknown } | null)?.revision;
  return typeof named === "string" ? named : null;
}

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

/**
 * Drop the rows in `tagged` from `rows`, in place, by identity.
 *
 * In place because both logs are `readonly` fields on the gate — which is what
 * keeps a caller from swapping one out — and by identity because two writes of
 * the same bytes to the same path are two rows and only one of them may go.
 */
function keepUntagged<T>(rows: T[], tagged: ReadonlySet<T>): void {
  if (tagged.size === 0) return;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row !== undefined && tagged.has(row)) rows.splice(i, 1);
  }
}
