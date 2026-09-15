/**
 * `.obsidian-headless/`: the directory this host runs plugins out of.
 *
 * **The layout is Obsidian's own, and nothing here is bespoke.**
 * `community-plugins.json` is a JSON array of enabled ids; `plugins/<id>/`
 * holds `manifest.json`, `main.js`, an optional `styles.css`, and the plugin's
 * `data.json`. Two things follow from that choice, and both are the reason for
 * it. A future install or update flow is the *same* operation aimed at a
 * different directory — nothing has to learn a second format on the way in —
 * and a human diffing the two config directories sees only the differences that
 * are real, because this host never writes a key or a file Obsidian would not
 * have written.
 *
 * **Why a separate directory at all.** A plugin's settings live in its
 * `data.json`, and a headless host sharing `.obsidian/plugins/<id>/data.json`
 * with a running GUI would have two writers on one file with no lock between
 * them — last writer wins, silently, on a file the user thinks of as their
 * settings. Under this layout the headless copy is *structurally* unreachable
 * from the GUI copy: they are different paths, so there is no race to lose.
 * {@link CoexistenceMonitor} handles the other half of the same problem, the
 * one a separate directory cannot fix — the plugin's own side effects.
 *
 * **Every byte moves through the daemon.** `read_file`, `write_file` and
 * `create_folder` are the three verbs this module uses, and it opens nothing
 * itself: the host's one file-system seam is `runtime/fs-access.ts` and this
 * module is not one of its callers. `write_file` never creates parents, so
 * {@link HeadlessConfigDir.ensure} creates the two folders explicitly with
 * `create_folder`, which is the one folder verb that serves hidden paths.
 *
 * **Writes here raise no notice, and that is the honest description.** The
 * daemon announces a raw write with `config_changed` only when it landed inside
 * `.obsidian/`; this directory is a hidden folder *outside* the zone, so a write
 * this host makes into it is announced to nobody — including to another vaultd
 * client. Nothing in this phase has two hosts on one headless directory, and if
 * something ever does, the poll in `coexistence.ts` is the mechanism that would
 * have to cover it.
 */

import type { HostConfig } from "../config";
import type { PluginManifest } from "../shim/plugin";
import type { ReadFileResponse, WriteFileResponse } from "../client/protocol";
import type { VaultdClient } from "../client/client";

export type { PluginManifest };

/**
 * Obsidian's own config directory: read for the fallback ladder, never written.
 *
 * Exported because `coexistence.ts` reads one file out of it directly, and a
 * second literal `".obsidian"` in the same folder is a second place to have to
 * change it.
 */
export const OBSIDIAN_CONFIG_DIR = ".obsidian";

/** The one file name the enabled set lives in, in either directory. */
const COMMUNITY_PLUGINS = "community-plugins.json";

/** A plugin present in the headless directory, with the manifest it ships. */
export interface InstalledPlugin {
  readonly id: string;
  readonly manifest: PluginManifest;
  /** `<configDir>/plugins/<id>` — what the manifest's own `dir` says. */
  readonly dir: string;
}

export class HeadlessConfigDir {
  /** `.obsidian-headless`, or whatever `configDirName` was configured to. */
  readonly configDir: string;

  private readonly client: VaultdClient;
  private readonly config: HostConfig;

  constructor(client: VaultdClient, config: HostConfig) {
    this.client = client;
    this.config = config;
    this.configDir = config.configDirName;
  }

  /**
   * Make `<configDir>/` and `<configDir>/plugins/`, in that order.
   *
   * **Idempotent because `create_folder` is.** A folder that is already there is
   * success rather than a conflict — the postcondition a caller wants is "a
   * folder is there", which is Obsidian's own `createFolder` behaviour — so this
   * needs no exists-check and no error swallowing. The two calls are sequential
   * rather than concurrent: `create_folder` does make the whole chain, but two
   * creates racing on the same parent is a needless way to find out whether the
   * daemon serialises them.
   *
   * **A `target_exists` is not caught here, against the brief's instruction to
   * treat it as success.** `docs/protocol.md` gives the code a narrower meaning
   * on this verb than that instruction assumes: an *existing folder* is already
   * plain success, and `target_exists` means a **file** is sitting on the name.
   * Swallowing it would leave the host writing into a directory that does not
   * exist and cannot be made, and the first symptom would be a `parent_not_found`
   * from an unrelated `write_file` several steps later. A file at
   * `.obsidian-headless` is a broken vault and must say so at the point it is
   * found.
   *
   * The response is discarded on purpose. A raw create into a hidden folder
   * joins no generation, so its `generation` key is **absent** rather than zero;
   * there is no number here worth reading, and a caller that needs to know about
   * the indexed segments above the target reads them back with
   * `get_tree_entries` instead of inferring them from this answer.
   */
  async ensure(): Promise<void> {
    await this.client.request<unknown>("create_folder", { path: this.configDir });
    await this.client.request<unknown>("create_folder", { path: this.pluginsDir() });
  }

  /**
   * The ids this host has enabled: `<configDir>/community-plugins.json`.
   *
   * **An absent file is `[]`; a corrupt one throws.** The two cases look alike
   * from a distance and are opposites in practice. A vault this host has never
   * run in has no such file, and starting with nothing enabled is exactly right.
   * A file that is there but is not a JSON array of strings is a file somebody
   * or something damaged, and a host that answered `[]` for it would quietly
   * disable every plugin the user had enabled — a silent data loss dressed up as
   * a fresh start. Every error other than `not_found` is let through for the
   * same reason.
   */
  async readEnabledSet(): Promise<string[]> {
    const source = await this.readFileOrNull(`${this.configDir}/${COMMUNITY_PLUGINS}`);
    if (source === null) return [];
    return parseEnabledSet(source, `${this.configDir}/${COMMUNITY_PLUGINS}`);
  }

  /**
   * Replace the enabled set with `ids`.
   *
   * Two spaces of indent and a trailing newline, which is the shape Obsidian's
   * own config writer produces, so the two directories stay diffable. No
   * `expected` precondition: this host is the only writer of its own config
   * directory, and a compare-and-swap against a revision nobody else can move is
   * a round trip that buys nothing. `Plugin.saveData` omits it for the same
   * reason.
   */
  async writeEnabledSet(ids: readonly string[]): Promise<void> {
    const body = `${JSON.stringify([...ids], null, 2)}\n`;
    await this.client.request<WriteFileResponse>("write_file", {
      path: `${this.configDir}/${COMMUNITY_PLUGINS}`,
      content_base64: Buffer.from(body, "utf8").toString("base64"),
    });
  }

  /**
   * Every plugin this host can see in its directory, with its manifest.
   *
   * **It enumerates the enabled set, because protocol version 1 cannot list a
   * hidden folder.** `get_tree_entries` answers about paths a client names and
   * says so plainly: "the index lists neither the `.obsidian` zone nor any
   * hidden folder", and there is no raw directory-listing verb at all. So the
   * only ids this host can ask about are the ids something already told it
   * about, and `community-plugins.json` is that something.
   *
   * The consequence, stated rather than hidden: a plugin folder that is present
   * on disk but absent from the enabled set is invisible here. That is the
   * "installed but disabled" case, and this method under-reports it. The fix is
   * a listing operation in the protocol, not a second index file in this
   * directory — a bespoke file would be exactly the invented format this layout
   * exists to avoid, and it would go stale the first time anything else wrote a
   * plugin folder.
   *
   * An id in the enabled set whose `manifest.json` is missing is skipped rather
   * than fatal: an enabled set naming a plugin that was deleted from disk is an
   * ordinary state, and the list is a list of what is *there*.
   */
  async listInstalled(): Promise<InstalledPlugin[]> {
    const ids = await this.readEnabledSet();
    const installed: InstalledPlugin[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const source = await this.readFileOrNull(this.manifestPath(id));
      if (source === null) continue;
      installed.push({
        id,
        manifest: parseManifest(source, id, this.pluginDir(id)),
        dir: this.pluginDir(id),
      });
    }
    return installed;
  }

  /**
   * One plugin's `manifest.json`, as Obsidian hands it to a plugin constructor.
   *
   * Absent or malformed is a throw, not a `null`: every caller of this is about
   * to load a bundle, and loading one whose manifest could not be read would put
   * a plugin on the air under an id, a name and a version that nobody verified.
   *
   * `dir` is filled in here. Obsidian fills it too, and plugins read it to find
   * their own bundled assets — a manifest handed over without it makes those
   * plugins look at `undefined/<asset>`.
   */
  async readManifest(id: string): Promise<PluginManifest> {
    const source = await this.readFile(this.manifestPath(id));
    return parseManifest(source, id, this.pluginDir(id));
  }

  /** One plugin's bundle source: `<configDir>/plugins/<id>/main.js`, as UTF-8. */
  readBundleSource(id: string): Promise<string> {
    return this.readFile(`${this.pluginDir(id)}/main.js`);
  }

  /**
   * A config file's parsed object: the host directory first, `.obsidian/` second.
   *
   * **A fresh headless directory inherits the real vault's settings**, which is
   * what makes rollover work on day one, while an explicit override in the host
   * directory wins. `Vault.getConfig` and `InternalPluginRegistry` climb the same
   * ladder for the same reason; this is the third copy of it and the three agree
   * on the order.
   *
   * `null` means neither copy is there. A copy that *is* there and does not parse
   * throws — deliberately unlike `InternalPluginRegistry.readConfigJson`, which
   * treats a bad parse as absent and falls through. The registry can afford that:
   * its answer is "which core plugins are on", and being wrong about it degrades
   * a feature. A caller here is reading settings it is about to act on, and
   * silently substituting Obsidian's copy for a damaged headless override would
   * act on settings the user never chose.
   */
  async readConfigJson<T>(name: string): Promise<T | null> {
    for (const path of [`${this.configDir}/${name}`, `${OBSIDIAN_CONFIG_DIR}/${name}`]) {
      const source = await this.readFileOrNull(path);
      if (source === null) continue;
      return parseJson<T>(source, path);
    }
    return null;
  }

  /**
   * Where a plugin's settings live: `<configDir>/plugins/<id>/data.json`.
   *
   * This must agree byte for byte with `Plugin.saveData`'s own path, which is
   * built from the same two pieces. It is a pure string so that a caller can
   * name the file without a round trip — Task 17's config service reads and
   * writes it, and the loader names it in an error long before anything has read
   * it.
   */
  dataPath(id: string): string {
    return `${this.pluginDir(id)}/data.json`;
  }

  /** `<configDir>/plugins`. */
  pluginsDir(): string {
    return `${this.configDir}/plugins`;
  }

  /** `<configDir>/plugins/<id>`. */
  pluginDir(id: string): string {
    return `${this.pluginsDir()}/${id}`;
  }

  /** `<configDir>/plugins/<id>/manifest.json`. */
  manifestPath(id: string): string {
    return `${this.pluginDir(id)}/manifest.json`;
  }

  private async readFile(path: string): Promise<string> {
    const response = await this.client.request<ReadFileResponse>("read_file", { path });
    return Buffer.from(response.content_base64, "base64").toString("utf8");
  }

  /**
   * {@link readFile}, with `not_found` turned into `null`.
   *
   * **Only `not_found`.** A `target_exists` (the code the daemon answers when a
   * path is a directory rather than a regular file), a `zone_violation`, a
   * `payload_too_large` — each of those means something is wrong that a caller
   * would want to hear about, and folding them all into "there is no file there"
   * is how a host ends up reporting an empty plugin set on a broken vault.
   */
  private async readFileOrNull(path: string): Promise<string | null> {
    try {
      return await this.readFile(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

/** Is this the daemon's "there is nothing at that path"? */
function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "not_found";
}

function parseJson<T>(source: string, path: string): T {
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/** A `community-plugins.json` body, insisting on the shape Obsidian writes. */
function parseEnabledSet(source: string, path: string): string[] {
  const parsed = parseJson<unknown>(source, path);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
    throw new Error(`${path} must be a JSON array of plugin ids`);
  }
  return parsed as string[];
}

/**
 * A `manifest.json` body.
 *
 * The four fields Obsidian requires are required here, and a manifest missing
 * one is a throw: `id`, `name`, `version` and `minAppVersion` are what the
 * shim's `PluginManifest` promises a plugin's constructor, and a plugin reading
 * `this.manifest.version` must not find `undefined` there.
 *
 * `description` and `author` are filled with the empty string when absent.
 * They are optional in a real manifest and required by the shim's interface —
 * the type the plugin actually receives — so somewhere has to reconcile the
 * two, and doing it at the read is what keeps every consumer from having to.
 *
 * `id` comes from the directory, not from the file. A manifest whose `id`
 * disagrees with its folder is a refusal rather than a silent preference for
 * one of them: every path this host builds for that plugin — its `data.json`,
 * its bundle — is built from the folder name, so believing the file would give
 * a plugin one identity in the registry and another on disk.
 */
function parseManifest(source: string, id: string, dir: string): PluginManifest {
  const path = `${dir}/manifest.json`;
  const parsed = parseJson<Record<string, unknown>>(source, path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object`);
  }
  for (const key of ["id", "name", "version", "minAppVersion"]) {
    if (typeof parsed[key] !== "string") {
      throw new Error(`${path} is missing the required string field "${key}"`);
    }
  }
  if (parsed["id"] !== id) {
    throw new Error(
      `${path} declares id "${String(parsed["id"])}", which disagrees with its folder "${id}"`,
    );
  }
  const manifest: PluginManifest = {
    id,
    name: parsed["name"] as string,
    version: parsed["version"] as string,
    minAppVersion: parsed["minAppVersion"] as string,
    description: typeof parsed["description"] === "string" ? parsed["description"] : "",
    author: typeof parsed["author"] === "string" ? parsed["author"] : "",
    dir,
  };
  if (typeof parsed["authorUrl"] === "string") {
    return { ...manifest, authorUrl: parsed["authorUrl"], ...isDesktopOnlyOf(parsed) };
  }
  return { ...manifest, ...isDesktopOnlyOf(parsed) };
}

/**
 * `isDesktopOnly`, spread in only when the manifest actually carries it.
 *
 * `exactOptionalPropertyTypes` is on, so an optional field set to `undefined`
 * is not the same type as an absent one — and it is not the same *fact*
 * either: a manifest that says nothing about desktop-only and one that says
 * `false` are different files, and the round trip should keep them apart.
 */
function isDesktopOnlyOf(parsed: Record<string, unknown>): { isDesktopOnly?: boolean } {
  return typeof parsed["isDesktopOnly"] === "boolean"
    ? { isDesktopOnly: parsed["isDesktopOnly"] }
    : {};
}
