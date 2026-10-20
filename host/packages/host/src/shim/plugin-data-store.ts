/**
 * Where `Plugin.loadData` and `Plugin.saveData` go.
 *
 * `loadData` and `saveData` are methods of the stand-in's `Plugin` base class,
 * which a plugin inherits and does not override, so putting a store behind them
 * changes no plugin byte. The deployment picks the store:
 *
 * - `vault` — today's behaviour and the default: the host's own config
 *   directory, written through vaultd ({@link VaultDataStore}). The headless
 *   profile keeps it and behaves exactly as before this seam.
 * - `viewer` — the vault's `data.json` read-only, with one viewer's merge patch
 *   over it, kept outside the vault (`shim/viewer-data-store.ts`).
 * - `browser` — the page's `localStorage`. Interface only for now: the browser
 *   build belongs to stage 2, so there is no class for it yet.
 */

import { pluginDataPath } from "../pluginset/config-dir";
import { VaultdError } from "../client/errors";
import { readThroughOverlay } from "../dryrun/dry-run";
import type { WriteFileResponse } from "../client/protocol";
import type { PluginHostContext } from "./plugin";

export type PluginDataStoreKind = "vault" | "viewer" | "browser";

export interface PluginDataStore {
  readonly kind: PluginDataStoreKind;
  /** The plugin's saved document, or `null` when it has none. */
  load(pluginId: string): Promise<unknown>;
  save(pluginId: string, data: unknown): Promise<void>;
}

/** What a store needs of the host. */
export type DataStoreHost = Pick<PluginHostContext, "client" | "writes" | "queue" | "errors">;

/**
 * Read and parse a `data.json` through vaultd (and the dry-run overlay), or
 * `null` if it is not there.
 *
 * `null` rather than `{}`: a plugin with no saved data is the ordinary case,
 * and fifty plugins in the corpus branch on a falsy answer to install their
 * defaults. **A file that is not JSON is reported and answered `null` too** —
 * the least-harm choice pending a runtime capture of what the GUI really does
 * with one; a throw here would happen inside `onload` and kill the whole plugin
 * over one bad byte in a settings file.
 *
 * Reads go **through the dry-run overlay**, which is what makes `saveData` then
 * `loadData` round-trip under `--dry-run`.
 */
export async function readDataFile(
  host: DataStoreHost,
  path: string,
  pluginId: string,
): Promise<unknown> {
  let source: string;
  try {
    const read = await readThroughOverlay(host.client, host.writes.overlay, path);
    source = read.content.toString("utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (source.trim() === "") return null;
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    host.errors.report(error, pluginId, "plugin-data");
    return null;
  }
}

/**
 * `<hostConfigDir>/plugins/<id>/data.json`, written through vaultd.
 *
 * It stays inside the **host's** config directory, so the GUI copy's
 * `data.json` is structurally untouchable rather than merely left alone by
 * convention.
 */
export class VaultDataStore implements PluginDataStore {
  readonly kind = "vault";

  constructor(
    private readonly host: DataStoreHost,
    private readonly configDirName: string,
  ) {}

  load(pluginId: string): Promise<unknown> {
    return readDataFile(this.host, pluginDataPath(this.configDirName, pluginId), pluginId);
  }

  /**
   * Write the plugin's `data.json`, creating its folder if the daemon says it
   * is not there.
   *
   * The folder is created **on the refusal** rather than ahead of every write:
   * a plugin that saves its settings on every keystroke would otherwise send a
   * `create_folder` per save for a folder that has existed since the first one.
   *
   * **It holds the file's path lock**, the same lock Task 17's
   * `PluginConfigService.set` takes, keyed by the same path string. The host's
   * `set` is a read-modify-write and this is a blind whole-file write, so with
   * no lock between them a save landing in the middle of a `set` is lost
   * silently.
   *
   * **The lock is not re-entrant, so do not await this from inside one.**
   * `DispatchQueue.runExclusivePath` is a promise chain per path (Task 7), so
   * code already holding *this file's* path lock that then **awaits** a
   * `saveData` waits for itself, for ever. `set` releases the lock before it
   * calls `onExternalSettingsChange` so that a handler may save.
   *
   * **The trailing newline is deliberate and matches
   * `HeadlessConfigDir.writeEnabledSet` and `writePluginData`.** Two writers of
   * one file that disagree about the last byte flip it on every alternation.
   */
  save(pluginId: string, data: unknown): Promise<void> {
    const path = pluginDataPath(this.configDirName, pluginId);
    return this.host.queue.runExclusivePath(path, async () => {
      const params = {
        path,
        content_base64: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8").toString(
          "base64",
        ),
      };
      try {
        await this.host.writes.send<WriteFileResponse>("write_file", params);
        return;
      } catch (error) {
        if (!isParentMissing(error)) throw error;
      }
      await this.host.writes.send<unknown>("create_folder", { path: parentOf(path) });
      await this.host.writes.send<WriteFileResponse>("write_file", params);
    });
  }
}

const defaults = new WeakMap<PluginHostContext, PluginDataStore>();

/** The store behind a host: the one it was given, else its vault store. */
export function dataStoreOf(host: PluginHostContext): PluginDataStore {
  if (host.dataStore !== undefined) return host.dataStore;
  let store = defaults.get(host);
  if (store === undefined) {
    store = new VaultDataStore(host, host.config.configDirName);
    defaults.set(host, store);
  }
  return store;
}

/** The daemon's two ways of saying "there is no such file". */
function isMissing(error: unknown): boolean {
  return (
    error instanceof VaultdError &&
    (error.code === "not_found" || error.code === "parent_not_found")
  );
}

function isParentMissing(error: unknown): boolean {
  return error instanceof VaultdError && error.code === "parent_not_found";
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}
