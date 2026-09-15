/**
 * `App` — the object every plugin is handed, and the container the shim
 * assembles itself into.
 *
 * Built here, in Task 6b, ahead of its consumers: `harness.app` is read by
 * tests from Task 7 onward and `new Plugin(app, manifest)` needs the type, so a
 * plan that produced `App` in Task 12 produced it five tasks after its first
 * consumer.
 *
 * **A container assigned once, and `readonly` from everywhere else.** Every
 * field below is `readonly` with definite assignment: `assembleShim` fills it
 * through `assignOnce`, which writes through a generic index (where TypeScript
 * does not enforce `readonly`) and refuses a second assignment at runtime. So
 * the brief's `readonly` is what a plugin — and every other file in this host —
 * actually sees, while the one function allowed to assemble still can.
 *
 * The shim's surfaces refer to each other in a cycle — the vault's rename event
 * reaches the metadata cache, which resolves links through the vault — so no
 * construction order builds them all with constructor-set fields, which is why
 * they are assigned rather than passed in. `assembleShim()` is the one
 * function allowed to fill this in, it does so exactly once, and every field
 * arrives non-null before any plugin bundle is loaded. A plugin therefore never
 * observes a half-built app; only the assembler does, and only for the length
 * of its own body.
 *
 * The fields land as their tasks build them, and this comment is the map:
 * Task 7 added `vault`, Task 8 adds `metadataCache`, Task 9 `fileManager`,
 * Task 10 `workspace` — seeded rather than built: Task 11a still owns the real
 * workspace (`WorkspaceLeaf`, the active file, the layout-ready latch) and
 * extends the same class, but a `file-menu` hook is registered through
 * `app.workspace.on` inside `onload`, so Task 10's harvest needed the field one
 * task earlier — Task 12 `plugins`, `internalPlugins`, `commands`,
 * `keymap`, `scope`, `setting` and `foldManager`. Nothing here is re-decided later — a task adds its field and
 * the assembler's one assignment, and that is all.
 */
import { FoldManager, Keymap, Scope, SettingRegistry } from "./keymap";
import type { CommandRegistry } from "./commands";
import type { FileManager } from "./file-manager";
import type { HostLocalStorage } from "./globals";
import type { InternalPluginRegistry } from "./internal-plugins";
import type { MetadataCache } from "./metadata-cache";
import type { PluginRegistry } from "./plugin-registry";
import type { Vault } from "./vault";
import type { Workspace } from "./workspace";

export class App {
  /**
   * Obsidian's own per-vault identifier: a 16-character hex string a plugin may
   * use to key per-vault storage.
   *
   * Stable for a given vault root, because a plugin that keyed anything by it
   * would otherwise find its data orphaned on every host restart. The host
   * derives it from the vault path — see `assembleShim`.
   */
  readonly appId: string;

  /**
   * `app.vault` — filled by `assembleShim`, exactly once.
   *
   * Definite-assignment rather than a constructor argument, because the vault
   * holds surfaces that hold the app: there is no order in which both can be
   * built with their fields final. `assignOnce` refuses a second assignment, so
   * "assigned once by the assembler" is enforced rather than asserted, and no
   * plugin bundle is loaded before it lands.
   */
  readonly vault!: Vault;

  /**
   * `app.metadataCache` — filled by `assembleShim`, exactly once, straight
   * after the vault.
   *
   * It is built second because it resolves links to the very `TFile` instances
   * the vault's index hands out, and it is assigned rather than constructed
   * into a `readonly` field for the same reason the vault is: the two surfaces
   * refer to each other, so no construction order leaves both final.
   */
  readonly metadataCache!: MetadataCache;

  /**
   * `app.fileManager` — filled by `assembleShim`, exactly once, after the
   * metadata cache.
   *
   * Third because it reads both of the others: it patches frontmatter the
   * mirror's rows describe, it moves the files the vault's index hands out, and
   * it composes links through the metadata cache's resolver. Assigned rather
   * than constructed into a `readonly` field for the same reason as its two
   * peers — the surfaces refer to each other, so no construction order leaves
   * them all final.
   */
  readonly fileManager!: FileManager;

  /**
   * `app.workspace` — filled by `assembleShim`, exactly once.
   *
   * **Seeded by Task 10, expanded by Task 11a.** The field was always Task
   * 11a's, but a plugin registers its context-menu hook with
   * `app.workspace.on("file-menu", ...)` inside `onload`, so the harvest needed
   * something to register against one task earlier. What Task 10 assigns is the
   * menu-hook half of the real surface; Task 11a adds the leaves, the active
   * file, and the layout-ready latch to the same class.
   */
  readonly workspace!: Workspace;

  /**
   * `app.plugins` — filled by `assembleShim`, exactly once.
   *
   * Assigned rather than constructed into a `readonly` field like its three
   * peers above: the registry holds the very `Plugin` instances that hold this
   * `App`, so there is no order in which both are final.
   */
  readonly plugins!: PluginRegistry;

  /**
   * `app.internalPlugins` — filled by `assembleShim`, exactly once.
   *
   * It reads config files through the client and subscribes to the mirror's
   * `config_changed`, so it is built where those are in scope rather than here.
   */
  readonly internalPlugins!: InternalPluginRegistry;

  /**
   * `app.commands` — filled by `assembleShim`, exactly once, and the **one**
   * command map. `Plugin.addCommand` delegates into it; nothing keeps a second
   * list. See `shim/commands.ts` for why the map is a plain mutable object.
   */
  readonly commands!: CommandRegistry;

  /**
   * The four surfaces that are about a window, and hold nothing of this host's.
   *
   * Constructed here rather than assigned by the assembler, and that is not an
   * inconsistency with the four fields above: those four are in a reference
   * cycle with this object and these are not. A `Keymap` holds nothing, so
   * there is no order problem to solve and `readonly` is honest.
   */
  readonly keymap: Keymap = new Keymap();
  readonly scope: Scope = new Scope();
  readonly setting: SettingRegistry = new SettingRegistry();
  readonly foldManager: FoldManager = new FoldManager();

  /**
   * The Obsidian version this host reports, from `HostConfig.appVersion` — the
   * same string `apiVersion` and `requireApiVersion` answer from.
   */
  readonly appVersion: string;

  /**
   * Obsidian's `app.lastEvent`: the DOM event that triggered what is running.
   *
   * Always `null`, because nothing here is triggered by a DOM event. Plugins
   * read it to decide where to place a menu or whether a modifier was held, and
   * every one of them handles the null case — it is null in Obsidian too for
   * anything not driven by a click.
   */
  readonly lastEvent: null = null;

  /**
   * Where {@link loadLocalStorage} and {@link saveLocalStorage} really store.
   *
   * Assigned by `assembleShim` from the same installation that backs the bare
   * `localStorage` global, so a plugin that writes through one and reads
   * through the other sees one value rather than two stores.
   */
  readonly localStorageStore!: HostLocalStorage;

  constructor(options: { appId: string; appVersion: string }) {
    this.appId = options.appId;
    this.appVersion = options.appVersion;
  }

  /**
   * Obsidian's `app.loadLocalStorage(key)`: the vault-scoped JSON store.
   *
   * Keyed `<appId>-<key>`, which is Obsidian's own scheme and the reason
   * `appId` is derived from the vault path rather than being random: a plugin
   * that stored a value on one run finds it on the next.
   *
   * A stored document that will not parse answers `null` rather than throwing.
   * The call is made from inside `onload` in half the corpus, and a
   * `SyntaxError` there costs the plugin everything after it.
   */
  loadLocalStorage(key: string): unknown {
    const raw = this.localStorageStore.getItem(this.storageKey(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * The counterpart. `null` or `undefined` **removes** the key, which is
   * Obsidian's own behaviour and what a plugin clearing a setting relies on.
   */
  saveLocalStorage(key: string, value: unknown): void {
    if (value === null || value === undefined) {
      this.localStorageStore.removeItem(this.storageKey(key));
      return;
    }
    this.localStorageStore.setItem(this.storageKey(key), JSON.stringify(value));
  }

  private storageKey(key: string): string {
    return `${this.appId}-${key}`;
  }
}
