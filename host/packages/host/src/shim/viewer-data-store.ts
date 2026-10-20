/**
 * The `viewer` plugin data store: the vault's settings with one viewer's patch.
 *
 * (docs/design/web-plugins.md, section 3 and edge case E4.)
 *
 * **Read.** The vault's `<vaultConfigDir>/plugins/<id>/data.json` is read
 * through vaultd and **never written**; the viewer's RFC 7396 merge patch is
 * applied over it. When the owner changes a value in desktop Obsidian, every
 * viewer who did not override that key sees the new value.
 *
 * **Write.** The saved document is diffed against the vault document *as read
 * at that moment*, and only the patch is stored, atomically (temp file and
 * rename, through {@link DataDir}), at
 * `<stateRoot>/<viewer>/<plugin-id>.json`. A patch that comes out empty deletes
 * the file ("use vault settings"). A prune-save at load (E4: `setConfig` saves
 * with no user action when stored keys no longer match the theme) therefore
 * records only the keys it removed, not a frozen copy.
 *
 * **A vault `data.json` that is missing or not JSON** reads as "no document"
 * (the second case is reported). A save then diffs against `{}`, so it stores a
 * full copy; once the vault file is valid again the viewer's keys override all
 * of the vault's, and nothing is re-diffed. Marking such a patch so it is
 * diffed again later would need a non-RFC wrapper in the file; not done.
 *
 * **Permissions.** The state root is created `0700`: viewer settings are not
 * for other local users.
 *
 * **Null.** RFC 7396 cannot say "set to null", so a null-valued object key in
 * a saved document is treated as absent (see `merge-patch.ts`).
 *
 * **Names.** A viewer id and a plugin id are arbitrary text (`/`, `..`,
 * unicode, case-only differences on a case-insensitive disk), so each is
 * encoded as one path segment by {@link encodeSegment}.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DataDir } from "../datadir";
import { OBSIDIAN_CONFIG_DIR, pluginDataPath } from "../pluginset/config-dir";
import { diffMergePatch, jsonEqual, mergePatch, withoutNullKeys } from "./merge-patch";
import { readDataFile } from "./plugin-data-store";
import type { DataStoreHost, PluginDataStore } from "./plugin-data-store";

/** `$XDG_STATE_HOME/vaultd-web/plugin-data`, outside any vault. */
export function viewerStateRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const stateHome =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ""
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(stateHome, "vaultd-web", "plugin-data");
}

const SAFE = /[a-z0-9_@-]/;
/** A directory entry name is limited to 255 bytes on the common file systems. */
const MAX_SEGMENT = 160;

/**
 * One text value as one path segment that cannot climb, collide or exceed a
 * name limit: every UTF-8 byte outside `[a-z0-9_@-]` becomes `%XX` (so `.`,
 * `/`, uppercase and non-ASCII are all escaped, and `A` and `a` stay apart on a
 * case-insensitive disk). A segment over the limit becomes `%h` plus a SHA-256
 * of the original; `%h` cannot begin an escaped segment, so the two forms never
 * meet.
 */
export function encodeSegment(text: string): string {
  if (text === "") throw new Error("a viewer id and a plugin id cannot be empty");
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const char = String.fromCharCode(byte);
    out += byte < 0x80 && SAFE.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (out.length <= MAX_SEGMENT) return out;
  return `%h${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export interface ViewerDataStoreOptions {
  readonly host: DataStoreHost;
  readonly viewerId: string;
  /** Defaults to {@link viewerStateRoot}. */
  readonly stateRoot?: string;
  /** The vault's own config directory name. Defaults to `.obsidian`. */
  readonly vaultConfigDirName?: string;
}

export class ViewerDataStore implements PluginDataStore {
  readonly kind = "viewer";
  private readonly dir: DataDir;
  private readonly viewerSegment: string;
  private readonly vaultConfigDirName: string;
  private readonly host: DataStoreHost;

  constructor(options: ViewerDataStoreOptions) {
    this.host = options.host;
    this.dir = new DataDir(options.stateRoot ?? viewerStateRoot());
    this.viewerSegment = encodeSegment(options.viewerId);
    this.vaultConfigDirName = options.vaultConfigDirName ?? OBSIDIAN_CONFIG_DIR;
  }

  async load(pluginId: string): Promise<unknown> {
    // The null rule applies on read as on write: a vault `{a: null}` reads as
    // `{}`, so a load and a save-then-load agree.
    const raw = await this.readVault(pluginId);
    const base = raw === null ? null : withoutNullKeys(raw);
    const patch = this.readPatch(pluginId);
    if (patch === undefined) return base;
    return mergePatch(base, patch);
  }

  save(pluginId: string, data: unknown): Promise<void> {
    const relative = this.patchPath(pluginId);
    return this.host.queue.runExclusivePath(`${this.dir.root}/${relative}`, async () => {
      const base = await this.readVault(pluginId);
      // A document with no object to diff against (the vault has no data.json)
      // is diffed against an empty one; `undefined` and `null` save as empty.
      const baseDoc = base ?? {};
      const saved = data === undefined || data === null ? {} : data;
      // "Use vault settings" when the saved document equals the vault's, of
      // whatever shape (an array or scalar vault document included).
      if (jsonEqual(withoutNullKeys(baseDoc), withoutNullKeys(saved))) {
        this.dir.remove(relative);
        return;
      }
      const patch = diffMergePatch(baseDoc, saved);
      this.dir.ensureSecureDir("");
      this.dir.writeJsonAtomic(relative, patch);
    });
  }

  /** The vault's document, read through vaultd. Never written. */
  private readVault(pluginId: string): Promise<unknown> {
    const vaultPath = pluginDataPath(this.vaultConfigDirName, pluginId);
    return readDataFile(this.host, vaultPath, pluginId);
  }

  /** The viewer's patch, or `undefined` when there is none (or it is unreadable). */
  private readPatch(pluginId: string): unknown {
    try {
      const patch = this.dir.readJson<unknown>(this.patchPath(pluginId));
      return patch === null ? undefined : patch;
    } catch (error) {
      // A hand-edited, unparseable patch is reported and ignored: the viewer
      // falls back to the vault's settings rather than losing the plugin.
      this.host.errors.report(error, pluginId, "plugin-data");
      return undefined;
    }
  }

  private patchPath(pluginId: string): string {
    return `${this.viewerSegment}/${encodeSegment(pluginId)}.json`;
  }
}
