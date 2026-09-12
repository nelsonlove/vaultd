/**
 * `vault.adapter` — the low-level file surface, over the daemon and nothing
 * else.
 *
 * Obsidian's `DataAdapter` is a file system. This one is not: every read is a
 * `read_file` or a mirror lookup, and every write is a mutation op through the
 * same {@link WriteGate} `Vault` uses, so `--dry-run` intercepts an adapter
 * write exactly as it intercepts `vault.modify`. Nothing here touches the file
 * system, which is not a style choice — the host has exactly one fs seam, in
 * `runtime/fs-access.ts`, and the vault is not behind it. (The static check in
 * `fs-seam.test.ts` bans the specifier in prose as well as in code, which is
 * why this sentence spells it no other way.)
 *
 * The subset below is what the plugin corpus actually touches; everything else
 * on Obsidian's `DataAdapter` is `absent`.
 *
 * **`FileSystemAdapter` exists and is never instantiated.** quickadd does
 * `adapter instanceof FileSystemAdapter`, which must *compile* and must
 * evaluate to `false`: a `true` there sends quickadd down a `getBasePath()`
 * -then-file-system path that would write vault bytes behind the daemon. The
 * class existing while no instance is ever one of them is the whole trick.
 */

import { basename, posix } from "node:path";

import { stub } from "./policy";
import type { Vault, VaultDeps } from "./vault";
import type {
  GenerationResponse,
  MutationResponse,
  ReadFileResponse,
  RenameResponse,
  WriteFileResponse,
} from "../client/protocol";

export interface ListedFiles {
  files: string[];
  folders: string[];
}

export class DataAdapter {
  /**
   * `vault` is a thunk rather than the vault itself: the adapter is built
   * inside the `Vault` constructor, so one of the two has to be reachable
   * lazily, and a function that answers later is honest where a field holding
   * `undefined` for one statement is not.
   */
  constructor(
    protected readonly deps: VaultDeps,
    private readonly vault: () => Vault,
  ) {}

  /** The vault's own name, which is the last segment of its root. */
  getName(): string {
    return basename(this.deps.config.vaultRoot);
  }

  getBasePath(): string {
    return this.deps.config.vaultRoot;
  }

  /**
   * The absolute path of a vault-relative one.
   *
   * A path that climbs out of the vault is refused rather than answered: the
   * daemon would refuse the read anyway (`invalid_path`), and an adapter that
   * handed back a path outside the vault would be telling a plugin that a place
   * it may not touch exists.
   */
  getFullPath(normalizedPath: string): string {
    const full = posix.normalize(posix.join(this.deps.config.vaultRoot, normalizedPath));
    const root = posix.normalize(this.deps.config.vaultRoot);
    if (full !== root && !full.startsWith(`${root}/`)) {
      throw new Error(`${normalizedPath} climbs out of the vault`);
    }
    return full;
  }

  /**
   * An inert `app://` URL.
   *
   * A resource path is a thing a renderer loads, and there is no renderer. The
   * honest answer is a URL shaped like the one Obsidian gives that resolves to
   * nothing, recorded so the report can say which plugins wanted to display a
   * file rather than read one.
   */
  getResourcePath(normalizedPath: string): string {
    return stub("DataAdapter.getResourcePath", `app://headless/${normalizedPath}`);
  }

  /**
   * Does this path exist?
   *
   * The mirror answers for anything inside the indexed universe. A `read_file`
   * answers for everything else — the config zone is not indexed, and
   * "community-plugins.json is not there" is a question Task 14 asks often.
   *
   * `sensitive` is Obsidian's case-sensitivity flag: with it, only an exact
   * path counts; without it, a case-insensitive match does too. Inside the
   * index the flag is exact, because the mirror knows the real spelling. For a
   * path outside it — the config zone — the answer comes from a `read_file`
   * that a case-insensitive file system may answer for a differently-cased
   * name, and no amount of asking will tell this host which spelling is on
   * disk.
   */
  async exists(normalizedPath: string, sensitive?: boolean): Promise<boolean> {
    if (this.deps.mirror.entry(normalizedPath) !== undefined) return true;
    const wanted = normalizedPath.toLowerCase();
    let folded = false;
    for (const entry of this.deps.mirror.entries()) {
      if (entry.path.toLowerCase() !== wanted) continue;
      if (sensitive !== true) return true;
      folded = true;
    }
    // The mirror holds this path under another spelling and the caller asked
    // for an exact answer. Falling through to `read_file` would let the file
    // system answer `true` for the spelling the caller said it did not want.
    if (folded) return false;
    try {
      await this.deps.client.request<ReadFileResponse>("read_file", { path: normalizedPath });
      return true;
    } catch {
      return false;
    }
  }

  /** The mirror's row, in Obsidian's `Stat` shape. `null` for a path it has no row for. */
  stat(
    normalizedPath: string,
  ): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
    const entry = this.deps.mirror.entry(normalizedPath);
    if (entry === undefined) return Promise.resolve(null);
    return Promise.resolve({
      type: entry.kind === "folder" ? "folder" : "file",
      ctime: entry.ctimeMs,
      mtime: entry.mtimeMs,
      size: entry.size ?? 0,
    });
  }

  /** One folder's direct children, split the way Obsidian splits them. */
  list(normalizedPath: string): Promise<ListedFiles> {
    const listed: ListedFiles = { files: [], folders: [] };
    for (const entry of this.deps.mirror.children(normalizedPath === "/" ? "" : normalizedPath)) {
      if (entry.kind === "folder") listed.folders.push(entry.path);
      else listed.files.push(entry.path);
    }
    return Promise.resolve(listed);
  }

  async read(normalizedPath: string): Promise<string> {
    const response = await this.deps.client.request<ReadFileResponse>("read_file", {
      path: normalizedPath,
    });
    return Buffer.from(response.content_base64, "base64").toString("utf8");
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    const response = await this.deps.client.request<ReadFileResponse>("read_file", {
      path: normalizedPath,
    });
    return toArrayBuffer(Buffer.from(response.content_base64, "base64"));
  }

  /**
   * An unconditional write, because Obsidian's adapter write is unconditional.
   *
   * No `expected`: a plugin calling `adapter.write` has said it wants these
   * bytes at this path, and inventing a precondition it did not ask for would
   * turn a write it expects to succeed into a `revision_conflict` it has no
   * handler for. `Vault.modify` is the surface with a precondition.
   *
   * **Routed by zone and extension**, which is not a nicety: the daemon refuses
   * `write_file` for a Markdown note — *"is a Markdown note; write it with
   * write_note so it joins a generation"* — while Obsidian's
   * `adapter.write("Note.md", ...)` simply succeeds. A note outside the config
   * zone therefore goes to `write_note`, and everything else, a `.md` file
   * inside the zone included, keeps `write_file`.
   */
  write(normalizedPath: string, data: string): Promise<void> {
    if (isIndexedNote(normalizedPath)) return this.writeNote(normalizedPath, data);
    return this.writeBytes(normalizedPath, Buffer.from(data, "utf8"));
  }

  /**
   * Binary bytes at a path.
   *
   * A note written as binary is still a note to the daemon, so it takes the
   * same routing — decoded as UTF-8, which is what those bytes are if they are
   * a note at all.
   */
  writeBinary(normalizedPath: string, data: ArrayBuffer): Promise<void> {
    const bytes = Buffer.from(data);
    if (isIndexedNote(normalizedPath)) {
      return this.writeNote(normalizedPath, bytes.toString("utf8"));
    }
    return this.writeBytes(normalizedPath, bytes);
  }

  /**
   * Read, concatenate, write — with the read's revision as the precondition.
   *
   * Obsidian appends at the file system. Here the read and the write are two
   * round trips, so the precondition is what keeps a writer that landed between
   * them from being silently overwritten: the append fails loudly instead.
   */
  async append(normalizedPath: string, data: string): Promise<void> {
    const response = await this.deps.client.request<ReadFileResponse>("read_file", {
      path: normalizedPath,
    });
    const existing = Buffer.from(response.content_base64, "base64").toString("utf8");
    const content = `${existing}${data}`;
    const expected = { revision: response.revision };
    if (isIndexedNote(normalizedPath)) {
      const note = await this.deps.writes.send<MutationResponse>("write_note", {
        path: normalizedPath,
        content,
        expected,
      });
      await this.settle(note.generation, normalizedPath);
      return;
    }
    const result = await this.deps.writes.send<WriteFileResponse>("write_file", {
      path: normalizedPath,
      content_base64: Buffer.from(content, "utf8").toString("base64"),
      expected,
    });
    await this.settle(result.generation, normalizedPath);
  }

  async mkdir(normalizedPath: string): Promise<void> {
    const result = await this.deps.writes.send<GenerationResponse>("create_folder", {
      path: normalizedPath,
    });
    await this.settle(result.generation, normalizedPath);
  }

  /** Obsidian's `remove` is for a file; a folder goes through `rmdir`. */
  async remove(normalizedPath: string): Promise<void> {
    const result = await this.deps.writes.send<GenerationResponse>("delete_note", {
      path: normalizedPath,
      mode: "permanent",
    });
    await this.settle(result.generation, null, [normalizedPath]);
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    const result = await this.deps.writes.send<GenerationResponse>("delete_folder", {
      path: normalizedPath,
      mode: "permanent",
      recursive,
    });
    await this.settle(result.generation, null, [normalizedPath, ...this.subtreeOf(normalizedPath)]);
  }

  /**
   * Rename, with the whole subtree named when it is a folder.
   *
   * The same rule, and the same reason, as `Vault.rename`: the wire's answer
   * names neither the descendants nor their destinations, and a refetch of the
   * two named paths alone loses every row under them permanently.
   */
  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    const folder = this.deps.mirror.entry(normalizedPath)?.kind === "folder";
    const affected = folder
      ? movedPaths(this.subtreeOf(normalizedPath), normalizedPath, normalizedNewPath)
      : [normalizedPath, normalizedNewPath];
    const result = await this.deps.writes.send<RenameResponse>(
      folder ? "rename_folder" : "rename_note",
      { from: normalizedPath, to: normalizedNewPath, rewrite_links: true },
    );
    // Neither path is synchronized here: the pair is what Task 15's sequencer
    // turns into one `rename` event, and an index that had already moved the
    // node would leave it nothing to pair.
    await this.settle(result.generation, null, affected);
  }

  async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    const result = await this.deps.writes.send<MutationResponse>("copy_file", {
      from: normalizedPath,
      to: normalizedNewPath,
      if_exists: "error",
    });
    await this.settle(result.generation, normalizedNewPath);
  }

  /**
   * The OS trash. Answers `true` because the daemon did it, not because
   * something was found there afterwards.
   */
  async trashSystem(normalizedPath: string): Promise<boolean> {
    await this.trashWith(normalizedPath, "trash_system");
    return true;
  }

  /** The vault-local `.trash` folder. */
  async trashLocal(normalizedPath: string): Promise<void> {
    await this.trashWith(normalizedPath, "trash_local");
  }

  // --- Internals ------------------------------------------------------------

  private async trashWith(
    normalizedPath: string,
    mode: "trash_system" | "trash_local",
  ): Promise<void> {
    const folder = this.deps.mirror.entry(normalizedPath)?.kind === "folder";
    const result = folder
      ? await this.deps.writes.send<GenerationResponse>("delete_folder", {
          path: normalizedPath,
          mode,
          recursive: true,
        })
      : await this.deps.writes.send<GenerationResponse>("delete_note", {
          path: normalizedPath,
          mode,
        });
    const affected = folder
      ? [normalizedPath, ...this.subtreeOf(normalizedPath)]
      : [normalizedPath];
    await this.settle(result.generation, null, affected);
  }

  /** Every path the mirror holds under `path`, `path` itself excluded. */
  private subtreeOf(path: string): string[] {
    const prefix = `${path}/`;
    return this.deps.mirror
      .entries()
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => entry.path);
  }

  private async writeNote(normalizedPath: string, content: string): Promise<void> {
    const result = await this.deps.writes.send<MutationResponse>("write_note", {
      path: normalizedPath,
      content,
    });
    await this.settle(result.generation, normalizedPath);
  }

  private async writeBytes(normalizedPath: string, bytes: Buffer): Promise<void> {
    const result = await this.deps.writes.send<WriteFileResponse>("write_file", {
      path: normalizedPath,
      content_base64: bytes.toString("base64"),
    });
    await this.settle(result.generation, normalizedPath);
  }

  /**
   * Bring the mirror to the generation this write landed in, and synchronize
   * the one path the caller is about to read back.
   *
   * `generation` is absent exactly when the bytes landed outside the indexed
   * universe — the config zone, a hidden folder — and there is then no
   * generation to wait for and nothing in the mirror to synchronize.
   */
  private async settle(
    generation: number | undefined,
    sync: string | null,
    paths?: readonly string[],
  ): Promise<void> {
    // Awaited: a plugin that writes `app.json` and reads a key back must see
    // its own bytes, and `getConfig` is synchronous, so the reload has to be
    // inside the promise this write hands back.
    if (sync !== null) await this.vault().configWritten(sync);
    if (generation === undefined) return;
    const affected = paths ?? (sync === null ? [] : [sync]);
    if (affected.length > 0) await this.deps.mirror.applyMutation(generation, affected);
    if (sync !== null) this.vault().index.sync(sync);
  }
}

/**
 * Is this a path the daemon indexes as a note?
 *
 * Markdown, and outside every hidden directory: nothing under a dot-segment is
 * scanned, so a `.md` file in the config zone is bytes rather than a note and
 * `write_note` would refuse it for being outside the indexed universe — which
 * is the mirror image of `write_file` refusing a real note.
 */
function isIndexedNote(path: string): boolean {
  if (!path.toLowerCase().endsWith(".md")) return false;
  return !path.split("/").some((segment) => segment.startsWith("."));
}

/** Both ends of a folder move, and every row under both ends. */
function movedPaths(under: readonly string[], from: string, to: string): string[] {
  return [from, to, ...under, ...under.map((path) => `${to}${path.slice(from.length)}`)];
}

/** Exists so `instanceof FileSystemAdapter` compiles and evaluates to false. */
export class FileSystemAdapter extends DataAdapter {}

/**
 * A `Buffer`'s bytes as a standalone `ArrayBuffer`.
 *
 * `buffer.buffer` is the whole pooled allocation Node handed out, so returning
 * it would hand a plugin every other small buffer allocated near it.
 */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}
