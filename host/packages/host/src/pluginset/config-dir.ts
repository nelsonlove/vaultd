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

import { HOST_PLUGIN_ID, HostErrors } from "../shim/errors";
import type { HostConfig } from "../config";
import type { PluginManifest } from "../shim/plugin";
import type {
  ReadDirEntryDto,
  ReadDirResponse,
  ReadFileResponse,
  WriteFileResponse,
} from "../client/protocol";
import type { RequestSink } from "../client/request-sink";
import { forwardingWriteGate } from "../dryrun/dry-run";
import type { WriteGate } from "../dryrun/dry-run";

export type { PluginManifest };

/**
 * Obsidian's own config directory: read for the fallback ladder, never written.
 *
 * **This is the package's one definition of the string.** `shim/vault.ts` and
 * `shim/internal-plugins.ts` each had a private copy of it — three literals for
 * one fact — and both now import this one. The dependency runs shim → pluginset
 * rather than the other way: where a file lives is a lower-level fact than what
 * the shim does with it, and `config-dir.ts` names nothing from the shim at
 * runtime (its `PluginManifest` import is type-only, and erased).
 */
export const OBSIDIAN_CONFIG_DIR = ".obsidian";

/** The one file name the enabled set lives in, in either directory. */
const COMMUNITY_PLUGINS = "community-plugins.json";

/**
 * A plugin's folder inside a config directory.
 *
 * Exported, and `shim/plugin.ts` calls it, because `Plugin.saveData` and
 * {@link HeadlessConfigDir.dataPath} must name the same file **by
 * construction** rather than by two authors agreeing. They were two identical
 * template strings; a review asked for one, and this is it.
 */
export function pluginDirPath(configDirName: string, id: string): string {
  return `${configDirName}/plugins/${id}`;
}

/** Where a plugin's settings live. See {@link pluginDirPath}. */
export function pluginDataPath(configDirName: string, id: string): string {
  return `${pluginDirPath(configDirName, id)}/data.json`;
}

/** A `manifest.json` whose `id` is not the folder it sits in. */
export class ManifestIdMismatch extends Error {
  readonly code = "manifest_id_mismatch";
  /** The folder name, which is the id every path this host builds uses. */
  readonly pluginId: string;
  /** What the file claims instead. */
  readonly declaredId: string;

  constructor(pluginId: string, declaredId: string, path: string) {
    super(
      `${path} declares id "${declaredId}", which disagrees with its folder "${pluginId}". ` +
        "Every path this host builds for a plugin — its bundle, its data.json — comes from " +
        "the folder, so believing the file would give one plugin two identities.",
    );
    this.name = "ManifestIdMismatch";
    this.pluginId = pluginId;
    this.declaredId = declaredId;
  }
}

/**
 * The enabled set was not written, because the copy on disk is damaged.
 *
 * Typed rather than a bare `Error` because a caller can do something with it:
 * an enable that refuses for this reason has left the user's file exactly as it
 * was, which is the point, and the message is what tells them where to look.
 * See {@link HeadlessConfigDir.writeEnabledSet}.
 */
export class EnabledSetDamaged extends Error {
  readonly code = "enabled_set_damaged";
  readonly path: string;

  constructor(path: string) {
    super(
      `refusing to write ${path}: this host read it and found it damaged, so the set it would ` +
        "write back is not the set that is in there. Repair or remove the file and the next " +
        "successful read lifts this refusal.",
    );
    this.name = "EnabledSetDamaged";
    this.path = path;
  }
}

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

  private readonly client: RequestSink;
  private readonly config: HostConfig;
  private readonly errors: HostErrors;
  /**
   * Where this directory's **writes** go — the same seam every other writer in
   * the host holds, so `--dry-run` intercepts a plugin-config write exactly as
   * it intercepts a vault write.
   *
   * Reads stay on the {@link RequestSink}. A dry run reads the real files: the
   * point is to find out what a plugin would do to the settings it actually
   * has, and a run that read an invented `data.json` would answer about a
   * vault nobody owns.
   */
  private readonly writes: WriteGate;
  /**
   * Paths already reported as a problem, so the report happens once.
   *
   * The enabled set is re-read on every coexistence poll — once a minute, for
   * the life of the host — and a file that stays broken would otherwise report
   * itself 1,440 times a day. The plugins directory is listed as often. Cleared
   * when a path is well again, so a file that is fixed and then broken a second
   * time reports a second time: "once" means once per spell of trouble, not once
   * per process.
   */
  private readonly reportedCorrupt = new Set<string>();

  /**
   * `errors` is optional so that the two-argument form the brief pins keeps
   * working; `assembleShim` passes the host's real sink. Defaulting to a fresh
   * {@link HostErrors} rather than to nothing means an unwired directory still
   * prints a damaged config file to stderr instead of losing it — the same
   * floor `HostErrors.report` describes.
   *
   * `writes` is optional on the same terms, and its default is the forwarding
   * gate over the client this directory was already given — which is byte for
   * byte what it did before the parameter existed, so no existing caller
   * changes behaviour. `assembleShim` passes the host's real gate, and that is
   * the one that matters: it is what makes a plugin-config write recordable
   * under `--dry-run` instead of landing on disk.
   */
  constructor(
    client: RequestSink,
    config: HostConfig,
    errors: HostErrors = new HostErrors(),
    writes: WriteGate = forwardingWriteGate(client),
  ) {
    this.client = client;
    this.config = config;
    this.errors = errors;
    this.writes = writes;
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
   *
   * **It creates without probing first, which is the answer to a carry from
   * Task 7.** `adapter.exists` cannot see an unindexed folder, so "is the
   * directory already there?" is a question this host cannot ask cheaply — it
   * would have to probe for a file inside it. It never needs to: the create is
   * the probe, and it is idempotent.
   *
   * **The first root-level create costs one resync, once per vault.** Measured
   * against the release daemon: creating `.obsidian-headless` at the vault root
   * makes the watcher report `resync_required { watcher_overflow }` and drop to
   * `catching_up` before returning to `watching`. The nested create, every write
   * into the directory, and every repeat create are silent. So a caller that
   * already has a mirror open pays a full re-hydration for it — call `ensure()`
   * **before** opening the mirror and nobody pays anything.
   */
  async ensure(): Promise<void> {
    await this.writes.send<unknown>("create_folder", { path: this.configDir });
    await this.writes.send<unknown>("create_folder", { path: this.pluginsDir() });
  }

  /**
   * The ids this host has enabled: `<configDir>/community-plugins.json`.
   *
   * **Absent is `[]` silently. Damaged is `[]` reported.** The two are not the
   * same fact and must not look the same: a vault this host has never run in has
   * no such file, and starting with nothing enabled is exactly right; a file
   * that is there and is not a JSON array of strings is one somebody or
   * something broke, and answering `[]` for it *silently* would quietly disable
   * every plugin the user had enabled — a data loss dressed up as a fresh start.
   *
   * So it degrades and says so, through the host's error seam, with the plugin
   * id `"host"` and the phase `config`. The host still starts, because the
   * alternative — a throw out of a read that runs on a 60 s timer — takes the
   * coexistence poll down with it and leaves the host blind rather than merely
   * empty. {@link reportedCorrupt} is what keeps the report to one per spell of
   * damage.
   *
   * A read error that is not `not_found` still propagates: see
   * {@link readFileOrNull}.
   */
  async readEnabledSet(): Promise<string[]> {
    const path = `${this.configDir}/${COMMUNITY_PLUGINS}`;
    const source = await this.readFileOrNull(path);
    if (source === null) return [];
    try {
      const ids = parseEnabledSet(source, path);
      this.reportedCorrupt.delete(path);
      return ids;
    } catch (error) {
      this.reportOnce(path, HOST_PLUGIN_ID, error);
      return [];
    }
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
   *
   * **It refuses to write over a file it has already reported as damaged**, and
   * that guard is the whole reason this method has a failure mode at all. The
   * caller is an "enable a plugin" path — Task 15's `enableLate`, Task 16b's
   * `host.enable_plugin` — which reads the set, appends an id and writes it
   * back; and {@link readEnabledSet} answers `[]` for a *damaged* file, having
   * reported the damage only to the error seam. Read-append-write over that `[]`
   * would overwrite a file the user may still want, silently, on the strength of
   * a report nobody was obliged to read. The two halves are each correct and
   * only dangerous together, so the guard lives at the write: a path this
   * directory currently holds in {@link reportedCorrupt} is refused with
   * {@link EnabledSetDamaged} rather than replaced.
   *
   * The refusal is narrow on purpose. It fires only after *this* directory has
   * read the file and found it damaged, so a host that has never read it writes
   * freely — and one spell of damage is cleared by the next successful read, so
   * repairing the file by hand is all it takes to lift the refusal.
   */
  async writeEnabledSet(ids: readonly string[]): Promise<void> {
    const enabledSetPath = `${this.configDir}/${COMMUNITY_PLUGINS}`;
    if (this.reportedCorrupt.has(enabledSetPath)) throw new EnabledSetDamaged(enabledSetPath);
    const body = `${JSON.stringify([...ids], null, 2)}\n`;
    await this.writes.send<WriteFileResponse>("write_file", {
      path: `${this.configDir}/${COMMUNITY_PLUGINS}`,
      content_base64: Buffer.from(body, "utf8").toString("base64"),
    });
  }

  /**
   * Every plugin installed in this directory, with its manifest.
   *
   * **It lists the directory.** One `read_dir` of `<configDir>/plugins`, then
   * one `manifest.json` per `folder` entry, in the byte order the daemon sorts
   * its listing into. The enabled set is a different question and this method no
   * longer asks it — which is the point of the change: a plugin that is
   * *installed but disabled* is on disk and absent from `community-plugins.json`,
   * and enumerating the enabled set could never see one. Protocol version 1 had
   * no way to list a hidden directory at all (`get_tree_entries` says plainly
   * that "the index lists neither the `.obsidian` zone nor any hidden folder"),
   * so the fix was the listing operation rather than a bespoke index file in this
   * directory — a file that would have been exactly the invented format this
   * layout exists to avoid, and that would have gone stale the first time
   * anything else wrote a plugin folder.
   *
   * **Three things in the listing are not installed plugins, and each is an
   * ordinary state rather than an error.** A `file` beside the folders (a stray
   * `stale.json`); a folder with no `manifest.json` (a half-deleted plugin, an
   * editor's leftover); and an `other` kind. All three are skipped in silence.
   *
   * **Two things are skipped *and reported*, once each, naming the folder.** A
   * `symlink`: the daemon classifies every entry from its own `lstat`, so a link
   * to a directory arrives as `symlink` and never as `folder`, and this host
   * does not follow it — following would mean loading a bundle from wherever the
   * link happens to point, past the containment the vault's own path rules give
   * every other read. And a `manifest.json` this host refuses — one that lies
   * about its id ({@link ManifestIdMismatch}), or is missing a required field.
   *
   * Both are reported rather than dropped in silence because both make a plugin
   * the user installed fail to appear, and "my plugin does not load and nothing
   * said why" is the worst answer available to them — the person most likely to
   * have made a symlink is a developer linking a repository checkout into their
   * vault. The report carries the **folder name** as its plugin id, so the seam
   * says which plugin went missing.
   *
   * **The refusal costs that plugin and not the answer.** It used to propagate,
   * which made plugin discovery unavailable because one folder was bad — a host
   * that could not start over a plugin it was never going to run. The plugin
   * stays unavailable, which is the refusal doing its job; the listing goes on,
   * which is the rest of the vault not paying for it. {@link readManifest}
   * called directly still throws, because a caller naming one plugin is asking
   * about that plugin and is there to handle the answer.
   */
  async listInstalled(): Promise<InstalledPlugin[]> {
    const listing = await this.readDirOrNull(this.pluginsDir());
    if (listing === null) return [];
    const installed: InstalledPlugin[] = [];
    for (const entry of listing) {
      if (entry.kind === "symlink") {
        this.reportOnce(
          this.pluginDir(entry.name),
          entry.name,
          new Error(
            `${this.pluginDir(entry.name)} is a symlink, and this host does not follow one: ` +
              "what a plugin loads comes from inside the vault or not at all. If it links a " +
              "plugin folder, copy the folder in or point the host at the directory it targets; " +
              "if it links something else, nothing here was going to load it anyway. " +
              "(The kind comes from the entry's own lstat, so this host cannot tell which " +
              "without following the link — which is the thing it will not do.)",
          ),
        );
        continue;
      }
      if (entry.kind !== "folder") continue;
      const source = await this.readFileOrNull(this.manifestPath(entry.name));
      if (source === null) continue;
      let manifest: PluginManifest;
      try {
        manifest = parseManifest(source, entry.name, this.pluginDir(entry.name));
      } catch (error) {
        // The cost of a broken manifest is **that plugin**, not the answer. A
        // refusal that propagated from here made plugin discovery unavailable
        // because one folder was bad — a host that cannot start over a plugin it
        // was never going to run. The plugin stays unavailable, which is the
        // refusal doing its job; the listing goes on, which is the rest of the
        // vault not paying for it.
        this.reportOnce(this.manifestPath(entry.name), entry.name, error);
        continue;
      }
      // Well again. Both keys, because either arm could have reported this name:
      // the folder may have been a symlink last time, or its manifest may have
      // been the broken one. Without this, "once per spell of trouble" would be
      // "once per process" for everything but the enabled set — a plugin
      // repaired and broken again would report only the first time, which is
      // the report you least want to lose.
      this.reportedCorrupt.delete(this.pluginDir(entry.name));
      this.reportedCorrupt.delete(this.manifestPath(entry.name));
      installed.push({ id: entry.name, manifest, dir: this.pluginDir(entry.name) });
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
   * This agrees byte for byte with `Plugin.saveData`'s own path because both
   * call {@link pluginDataPath} — not because two template strings happen to
   * match. It is a pure string so that a caller can
   * name the file without a round trip — Task 17's config service reads and
   * writes it, and the loader names it in an error long before anything has read
   * it.
   */
  dataPath(id: string): string {
    return pluginDataPath(this.configDir, id);
  }

  /**
   * A plugin's settings document, or `null` when it has never saved one.
   *
   * The counterpart of `Plugin.loadData` for a caller that is **not** the
   * plugin, and it is stricter than that method on purpose. `loadData` answers
   * `null` for a file that will not parse, because the alternative is a throw
   * inside `onload` that costs the plugin everything after it; nobody's `onload`
   * is at stake here, and a config service that silently reported "no settings"
   * for a `data.json` a human damaged would invite the caller to write a fresh
   * document over it and eat the user's settings.
   *
   * A document that parses to an **array or a scalar** is refused for the same
   * reason: every key-level operation above this — redaction, the state-key
   * refusal, the merge that preserves unmentioned keys — is defined over an
   * object's keys, and an array or a bare number has none.
   *
   * **The literal `null` is the one exception, and it reads as an empty
   * document.** A plugin that calls `saveData(null)` writes exactly that file —
   * `Plugin.loadData` answers `null` for it and every plugin in the corpus
   * handles that as "nothing saved yet" — so refusing it would make a config
   * service throw forever on a file the plugin considers ordinary. It is the
   * only JSON value with an unambiguous "there is nothing here" reading.
   */
  async readPluginData(id: string): Promise<Record<string, unknown> | null> {
    const path = this.dataPath(id);
    const source = await this.readFileOrNull(path);
    if (source === null) return null;
    // An empty file is Obsidian's own "nothing saved yet" — a plugin that wrote
    // one and a plugin that never wrote at all are the same state to a reader.
    if (source.trim() === "") return null;
    const parsed = parseJson<unknown>(source, path);
    if (parsed === null) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * Replace a plugin's settings document, in **one** `write_file`.
   *
   * One write rather than a key-at-a-time patch because `data.json` has no
   * partial-update verb and never will: the file is the unit Obsidian reads and
   * a plugin's own `saveData` rewrites whole. A caller preserving keys it did
   * not mean to change does so by merging *before* it calls this — which is
   * what `PluginConfigService.set` does, over the document it has just read.
   *
   * **What it preserves is keys and values under JSON semantics, not bytes.**
   * A caller that merged over a document this class parsed gets every key and
   * every value back, and the serialization is deterministic — the same
   * document written twice is byte-identical — but the round trip is a parse
   * and a re-serialize, so a hand-written file is normalized on its first write
   * through here: indentation becomes two spaces, a trailing newline is added,
   * `1.0` and `1e3` become `1` and `1000`, non-ASCII escapes are rewritten to
   * the characters they name, and an integer past 2^53 is rounded by the parse
   * before this method ever sees it. Same values, sometimes different bytes,
   * and once rather than on every write.
   *
   * The folder is created **on the refusal** rather than ahead of every write,
   * exactly as `Plugin.saveData` does it and for the same reason: the folder
   * exists for every write after the first, and `create_folder` walks its own
   * segments, so one call covers however much of the chain is missing.
   */
  async writePluginData(id: string, data: Record<string, unknown>): Promise<void> {
    const path = this.dataPath(id);
    const params = {
      path,
      content_base64: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8").toString("base64"),
    };
    try {
      await this.writes.send<WriteFileResponse>("write_file", params);
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "parent_not_found") throw error;
    }
    await this.writes.send<unknown>("create_folder", { path: this.pluginDir(id) });
    await this.writes.send<WriteFileResponse>("write_file", params);
  }

  /** `<configDir>/plugins`. */
  pluginsDir(): string {
    return `${this.configDir}/plugins`;
  }

  /** `<configDir>/plugins/<id>`. */
  pluginDir(id: string): string {
    return pluginDirPath(this.configDir, id);
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
   * One directory's immediate entries, or `null` when there is no such
   * directory.
   *
   * The same absence rule {@link readFileOrNull} follows, for the same reason: a
   * vault this host has never run in has no `<configDir>/plugins`, and that is
   * an answer rather than a failure. A `target_exists` — the daemon's code for
   * "this path is not a directory", which here would mean a *file* named
   * `plugins` — propagates, because that is a broken vault and not an empty one.
   */
  private async readDirOrNull(path: string): Promise<ReadDirEntryDto[] | null> {
    try {
      const response = await this.client.request<ReadDirResponse>("read_dir", { path });
      return response.entries;
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
  }

  /**
   * {@link readFile}, with the two absence codes turned into `null`.
   *
   * **Only the absence codes.** A `target_exists` (the code the daemon answers
   * when a path is a directory rather than a regular file), a `zone_violation`, a
   * `payload_too_large` — each of those means something is wrong that a caller
   * would want to hear about, and folding them all into "there is no file there"
   * is how a host ends up reporting an empty plugin set on a broken vault.
   */
  private async readFileOrNull(path: string): Promise<string | null> {
    try {
      return await this.readFile(path);
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
  }

  /**
   * Report a path's problem once, and only once. See {@link reportedCorrupt}.
   *
   * `pluginId` is the folder name when the trouble belongs to one plugin — a
   * symlinked folder, a manifest that lies about its id — and `"host"` when it
   * belongs to the host itself, as a damaged `community-plugins.json` does. An
   * operator reading the seam then learns *which* plugin went missing rather
   * than only that something did, and Task 14b's quarantine can tell a plugin's
   * trouble from the host's. The `config` phase is what keeps either from being
   * counted as a plugin crash.
   */
  private reportOnce(key: string, pluginId: string, error: unknown): void {
    if (this.reportedCorrupt.has(key)) return;
    this.reportedCorrupt.add(key);
    this.errors.report(error, pluginId, "config");
  }
}

/**
 * Is this the daemon's "there is nothing at that path"?
 *
 * **Two codes, not one**, and the second was found by running this module
 * against the real daemon rather than a fake: reading
 * `.obsidian-headless/community-plugins.json` in a vault that has no
 * `.obsidian-headless` at all answers `parent_not_found`, because the daemon
 * resolves the parent before it looks for the file. A host that treated only
 * `not_found` as absence threw on the most ordinary state there is — a vault it
 * has never run in — which is exactly the case `readEnabledSet` promises to
 * answer `[]` for.
 *
 * They are the same fact from a caller's side: the file is not there. Every
 * other code still propagates, which is the distinction that matters —
 * "there is nothing here" against "something is wrong here".
 */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "not_found" || code === "parent_not_found";
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
  if (parsed["id"] !== id) throw new ManifestIdMismatch(id, String(parsed["id"]), path);
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
