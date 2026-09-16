/**
 * The harvest: every registration a plugin makes, written down as something
 * that can be invoked — or as something that cannot, with the reason.
 *
 * This is the payoff of the whole shim. Obsidian's API is mostly a way of
 * telling a GUI what to draw: a command for the palette, an item for a context
 * menu, an icon for the ribbon, a tab for the settings pane. A host with no GUI
 * cannot draw any of it, and the two dishonest answers are to throw (which
 * kills the plugin inside `onload`) or to swallow (which leaves a host that
 * loaded forty plugins and can do nothing with any of them). The third answer
 * is this one: record what was registered, keep whatever the plugin handed over
 * — the callback, the item's title, the protocol action — and let something
 * outside the process ask for it by name.
 *
 * **These are internal `camelCase` shapes.** `src/server/wire.ts` (Task 16a)
 * converts them to `snake_case` at the socket; nothing on the wire ever says
 * `pluginId`. The shapes are pinned here because that task reuses them verbatim.
 *
 * **`unreachable()` is not decoration.** tag-wrangler registers zero commands
 * and hooks `editor-menu` exactly once; the rest of its surface is ten
 * DOM-delegated listeners plus a `Menu.prototype` patch, none of which a host
 * with no DOM can reach. Recording them is the difference between a report that
 * says "1 menu hook harvested" and one that says "1 harvested, 10 unreachable,
 * and here is why".
 */

import { Menu } from "./events";
import type { MenuItem } from "./events";
import type { PluginSettingTab } from "./plugin";

/** The two menus a headless host can still build: both are per-file. */
export type MenuContext = "file-menu" | "editor-menu";

export interface HarvestedCommand {
  readonly pluginId: string;
  /** Fully qualified: `<pluginId>:<localId>`, the id the palette knows. */
  readonly id: string;
  readonly localId: string;
  readonly name: string;
  readonly icon: string | null;
  readonly kind: "callback" | "checkCallback" | "editorCallback" | "editorCheckCallback";
  readonly hotkeys: readonly { modifiers: string[]; key: string }[];
}

export interface HarvestedMenuHook {
  readonly pluginId: string;
  /** `<pluginId>:<context>:<ordinal>` — the ordinal counts this plugin's hooks. */
  readonly id: string;
  readonly context: MenuContext;
}

export interface HarvestedMenuItem {
  readonly hookId: string;
  readonly pluginId: string;
  /** `<hookId>:<ordinal>` — the ordinal is the item's position in its menu. */
  readonly id: string;
  readonly title: string;
  readonly icon: string | null;
  readonly section: string | null;
  readonly checked: boolean | null;
}

export interface HarvestedProtocolHandler {
  readonly pluginId: string;
  readonly action: string;
}

/**
 * `tab` is the live `PluginSettingTab` instance the plugin passed to
 * `addSettingTab`.
 *
 * Task 17's schema ladder has to **call** `tab.getSettingDefinitions()` on it —
 * a boolean saying the method exists is not enough to climb rung 1, and
 * re-finding the instance later is impossible because nothing else holds a
 * reference to it. It is excluded from the wire shape (Task 16a sends
 * `{ plugin_id, has_setting_definitions }` only), so a live object never leaves
 * the process.
 */
export interface HarvestedSettingTab {
  readonly pluginId: string;
  readonly hasSettingDefinitions: boolean;
  readonly tab: PluginSettingTab;
}

export interface HarvestedRibbonIcon {
  readonly pluginId: string;
  readonly id: string;
  readonly title: string;
  readonly icon: string;
}

export interface HarvestedTimer {
  readonly pluginId: string;
  /**
   * The cadence, or `null` when the timer was armed outside the shim's own
   * `window` and there is none to read back. `null` rather than `0`, which
   * would read as a timer firing as fast as the loop allows — the one shape the
   * idle-cost census must not invent.
   */
  readonly intervalMs: number | null;
  readonly createdAt: number;
}

export interface HarvestedUnreachable {
  readonly pluginId: string;
  readonly kind:
    /**
     * A delegated DOM listener, as the **running host** is handed one.
     *
     * `Node.on(type, selector, handler)` is Obsidian's own delegation helper:
     * it binds a handler to every future element matching a selector, which is
     * how a plugin attaches to parts of the UI it never built. There is no DOM
     * to delegate through here, so every such registration is an entry point
     * that structurally cannot be reached. `globals.ts` records one per
     * registration with the **event type** as the detail, and `Node.off`
     * withdraws it.
     *
     * tag-wrangler is the corpus's case: loading it records **seventeen** of
     * these, **three** of them `contextmenu`-typed, and Task 22 asserts those
     * numbers by this kind. Its Task 0 capture record states a different
     * figure, counted a different way; the record stays as it is, and the
     * runtime count is what a compatibility report is built from.
     *
     * "Delegated" is what the name means, not "context menu": splitting the
     * rows by event type would make the count unsatisfiable.
     *
     * (An earlier draft reserved this kind for a static bundle scan in Task 14.
     * Task 14's brief has no scan, and the registrations are visible at runtime
     * through the helper the stub already implements, so the producer is the
     * host — corrected when Task 13 wired it.)
     */
    | "dom_delegated_menu"
    /**
     * A listener the **running host** was handed and can never deliver to.
     *
     * The runtime counterpart, added in Task 11a:
     * `window.addEventListener` and `document.addEventListener` record one of
     * these per registration, whatever the event type — `contextmenu` included,
     * so that the two producers cannot write the same kind and mean different
     * things. `detail` is the event type.
     */
    | "dom_listener"
    | "view"
    | "editor_extension"
    | "code_block_processor"
    | "editor_suggest";
  readonly detail: string;
}

/** What a menu hook is called with: `(menu, ...subject)`, as Obsidian calls it. */
export type MenuHookCallback = (menu: Menu, ...subject: unknown[]) => unknown;

/** A hook the harvest can still drive, and the handle that drops it. */
export interface MenuHookRegistration {
  readonly hook: HarvestedMenuHook;
  /** Drops this one hook — what the plugin's own `EventRef.detach` calls. */
  detach(): void;
}

/** One menu hook's row plus the closure that fills a menu. */
interface MenuHookRecord {
  readonly hook: HarvestedMenuHook;
  readonly callback: MenuHookCallback;
}

/** One protocol action's row plus the handler that answers it. */
interface ProtocolRecord {
  readonly row: HarvestedProtocolHandler;
  readonly handler: (params: Record<string, string>) => unknown;
}

/** One ribbon icon's row plus the click handler nothing can click. */
interface RibbonRecord {
  readonly row: HarvestedRibbonIcon;
  readonly callback: (evt: unknown) => unknown;
}

/** One command's row plus the `Command` object the plugin registered. */
interface CommandRecord {
  readonly row: HarvestedCommand;
}

export interface HarvestDeps {
  /**
   * Reported when a plugin's own menu hook throws while a menu is being built.
   *
   * A hook that throws must not blank the menu for every other plugin, so the
   * build carries on and the failure is handed here instead — which is what
   * lets Task 14b attribute it rather than lose it.
   */
  onHookError?(failure: { pluginId: string; context: MenuContext; error: unknown }): void;
}

export class Harvest {
  private readonly commandRecords: CommandRecord[] = [];
  private readonly menuHookRecords: MenuHookRecord[] = [];
  private readonly protocolRecords: ProtocolRecord[] = [];
  private readonly settingTabRows: HarvestedSettingTab[] = [];
  private readonly ribbonRecords: RibbonRecord[] = [];
  private readonly timerRows: HarvestedTimer[] = [];
  private readonly unreachableRows: HarvestedUnreachable[] = [];
  /**
   * The next ordinal for each `<pluginId>:<context>` pair.
   *
   * Monotonic **within one plugin's lifetime** rather than "however many hooks
   * are registered right now": a plugin that detaches a hook and registers
   * another would otherwise get an id that a caller still holding the old one
   * would follow to the new hook. {@link forgetPlugin} drops the counter with
   * everything else, so a plugin loaded again starts at `0` — deliberately: a
   * forgotten plugin's ids are not addressable by anything any more, and a
   * counter that survived a quarantine would make a reloaded plugin's ids
   * depend on how many times it had been reloaded.
   */
  private readonly hookOrdinals = new Map<string, number>();
  private readonly ribbonOrdinals = new Map<string, number>();
  /**
   * What each plugin's bundle exported from its module scope.
   *
   * Recorded here rather than held by the loader because the harvest is what a
   * caller holding a `Plugin` can reach — `pluginHostFor(plugin.app).harvest` —
   * and rungs 2 and 3 of Task 17's schema ladder read a plugin's own
   * `SETTINGS_CATALOG` or `DEFAULT_SETTINGS` off exactly this object. Obsidian
   * throws the exports away after it has read the plugin class out of them; a
   * host that did the same could not climb either rung, because nothing else
   * in the process would still hold them.
   *
   * It is **never** sent: `server/wire.ts` builds its rows from the reading
   * methods above, and this one is not among them. See {@link HarvestedSettingTab}
   * for the same argument about the live tab.
   */
  private readonly moduleExportRows = new Map<string, unknown>();

  constructor(private readonly deps: HarvestDeps = {}) {}

  // --- Reading ---------------------------------------------------------------

  commands(): readonly HarvestedCommand[] {
    return this.commandRecords.map((record) => record.row);
  }

  menuHooks(): readonly HarvestedMenuHook[] {
    return this.menuHookRecords.map((record) => record.hook);
  }

  protocolHandlers(): readonly HarvestedProtocolHandler[] {
    return this.protocolRecords.map((record) => record.row);
  }

  settingTabs(): readonly HarvestedSettingTab[] {
    return [...this.settingTabRows];
  }

  ribbonIcons(): readonly HarvestedRibbonIcon[] {
    return this.ribbonRecords.map((record) => record.row);
  }

  timers(): readonly HarvestedTimer[] {
    return [...this.timerRows];
  }

  unreachable(): readonly HarvestedUnreachable[] {
    return [...this.unreachableRows];
  }

  /** What this plugin's bundle exported, or `undefined`. See {@link moduleExportRows}. */
  moduleExports(pluginId: string): unknown {
    return this.moduleExportRows.get(pluginId);
  }

  // --- Recording -------------------------------------------------------------

  recordCommand(row: HarvestedCommand): void {
    this.commandRecords.push({ row });
  }

  /** Drop one command, by the fully qualified id. */
  forgetCommand(id: string): void {
    const at = this.commandRecords.findIndex((record) => record.row.id === id);
    if (at !== -1) this.commandRecords.splice(at, 1);
  }

  recordMenuHook(
    pluginId: string,
    context: MenuContext,
    callback: MenuHookCallback,
  ): MenuHookRegistration {
    const key = `${pluginId}\0${context}`;
    const ordinal = this.hookOrdinals.get(key) ?? 0;
    this.hookOrdinals.set(key, ordinal + 1);
    const hook: HarvestedMenuHook = {
      pluginId,
      id: `${pluginId}:${context}:${String(ordinal)}`,
      context,
    };
    const record: MenuHookRecord = { hook, callback };
    this.menuHookRecords.push(record);
    return {
      hook,
      detach: (): void => {
        const at = this.menuHookRecords.indexOf(record);
        if (at !== -1) this.menuHookRecords.splice(at, 1);
      },
    };
  }

  recordProtocolHandler(
    pluginId: string,
    action: string,
    handler: (params: Record<string, string>) => unknown,
  ): void {
    this.protocolRecords.push({ row: { pluginId, action }, handler });
  }

  recordSettingTab(row: HarvestedSettingTab): void {
    this.settingTabRows.push(row);
  }

  /** Keep one plugin's module exports. See {@link moduleExportRows}. */
  recordModuleExports(pluginId: string, exports: unknown): void {
    this.moduleExportRows.set(pluginId, exports);
  }

  /**
   * Drop them again on their own.
   *
   * {@link forgetPlugin} is the ordinary way, and it covers every plugin that
   * reached `onload`. This is for the one that did not: a plugin **constructor**
   * that throws leaves a loader with exports recorded, no instance, and no
   * teardown to run — a whole module scope held for the life of the host, for a
   * plugin that never existed.
   */
  forgetModuleExports(pluginId: string): void {
    this.moduleExportRows.delete(pluginId);
  }

  recordRibbonIcon(
    pluginId: string,
    title: string,
    icon: string,
    callback: (evt: unknown) => unknown,
  ): HarvestedRibbonIcon {
    const ordinal = this.ribbonOrdinals.get(pluginId) ?? 0;
    this.ribbonOrdinals.set(pluginId, ordinal + 1);
    const row: HarvestedRibbonIcon = {
      pluginId,
      id: `${pluginId}:ribbon:${String(ordinal)}`,
      title,
      icon,
    };
    this.ribbonRecords.push({ row, callback });
    return row;
  }

  recordTimer(row: HarvestedTimer): void {
    this.timerRows.push(row);
  }

  recordUnreachable(row: HarvestedUnreachable): void {
    this.unreachableRows.push(row);
  }

  /**
   * Drop one unreachable row, by the identity of the row that was recorded.
   *
   * By identity rather than by value, because a plugin may register the same
   * event type twice and withdraw one of them — the same distinction `off` and
   * `offref` draw for listeners. A row that was never recorded, or was already
   * withdrawn, is a no-op: `removeEventListener` for something never added is
   * ordinary plugin code, not an error.
   */
  forgetUnreachable(row: HarvestedUnreachable): void {
    const at = this.unreachableRows.indexOf(row);
    if (at !== -1) this.unreachableRows.splice(at, 1);
  }

  // --- Invoking --------------------------------------------------------------

  /** The handler a protocol action was registered with, or `null`. */
  protocolHandlerFor(action: string): {
    pluginId: string;
    handler: (params: Record<string, string>) => unknown;
  } | null {
    const record = this.protocolRecords.find((entry) => entry.row.action === action);
    if (record === undefined) return null;
    return { pluginId: record.row.pluginId, handler: record.handler };
  }

  /** The click handler a ribbon icon was registered with, or `null`. */
  ribbonCallbackFor(id: string): {
    pluginId: string;
    callback: (evt: unknown) => unknown;
  } | null {
    const record = this.ribbonRecords.find((entry) => entry.row.id === id);
    if (record === undefined) return null;
    return { pluginId: record.row.pluginId, callback: record.callback };
  }

  /**
   * Build every hook's menu for `context` over `subject`, and report the items.
   *
   * `subject` is what Obsidian passes after the menu — `(file, source)` for a
   * file menu, `(editor, view)` for an editor menu — and it is passed straight
   * through, so a plugin that branches on the source sees the source.
   */
  listMenuItems(context: MenuContext, subject: readonly unknown[]): HarvestedMenuItem[] {
    const items: HarvestedMenuItem[] = [];
    for (const record of [...this.menuHookRecords]) {
      if (record.hook.context !== context) continue;
      const menu = this.buildMenu(record, subject);
      menu.items().forEach((item, index) => {
        items.push(harvestedItem(record.hook, item, index));
      });
    }
    return items;
  }

  /**
   * Rebuild the menu that owns `id` and hand back the live item.
   *
   * **Rebuilt, never cached.** A plugin's item text and its `onClick` closure
   * both close over the file the menu was opened for, so firing an item kept
   * from an earlier listing would run a handler bound to a stale file.
   */
  menuItemFor(
    id: string,
    subject: readonly unknown[],
  ): { pluginId: string; item: MenuItem } | null {
    const cut = id.lastIndexOf(":");
    if (cut === -1) return null;
    const hookId = id.slice(0, cut);
    const ordinal = Number.parseInt(id.slice(cut + 1), 10);
    if (!Number.isInteger(ordinal)) return null;
    const record = this.menuHookRecords.find((entry) => entry.hook.id === hookId);
    if (record === undefined) return null;
    const item = this.buildMenu(record, subject).items()[ordinal];
    if (item === undefined) return null;
    return { pluginId: record.hook.pluginId, item };
  }

  // --- Forgetting ------------------------------------------------------------

  /**
   * Drop everything one plugin registered.
   *
   * Half of what makes a quarantine complete: this drops what the plugin can be
   * asked to do, and `ShimEventBus.detachOwner` drops what can wake it. A
   * plugin that survived one of the two could still be reached through the
   * other.
   */
  forgetPlugin(pluginId: string): void {
    keepOthers(this.commandRecords, (record) => record.row.pluginId !== pluginId);
    keepOthers(this.menuHookRecords, (record) => record.hook.pluginId !== pluginId);
    keepOthers(this.protocolRecords, (record) => record.row.pluginId !== pluginId);
    keepOthers(this.settingTabRows, (row) => row.pluginId !== pluginId);
    keepOthers(this.ribbonRecords, (record) => record.row.pluginId !== pluginId);
    keepOthers(this.timerRows, (row) => row.pluginId !== pluginId);
    keepOthers(this.unreachableRows, (row) => row.pluginId !== pluginId);
    // The exports go with everything else: a quarantined plugin's module scope
    // is a live object graph — its prototypes, its closures, whatever it built
    // at load — and keeping it would hold the whole bundle in memory for a
    // plugin this host has decided is gone.
    this.moduleExportRows.delete(pluginId);
    for (const key of [...this.hookOrdinals.keys()]) {
      if (key.startsWith(`${pluginId}\0`)) this.hookOrdinals.delete(key);
    }
    this.ribbonOrdinals.delete(pluginId);
  }

  private buildMenu(record: MenuHookRecord, subject: readonly unknown[]): Menu {
    const menu = new Menu();
    try {
      record.callback(menu, ...subject);
    } catch (error) {
      this.deps.onHookError?.({ pluginId: record.hook.pluginId, context: record.hook.context, error });
    }
    return menu;
  }
}

/** One live `MenuItem`, as the wire sees it. */
function harvestedItem(hook: HarvestedMenuHook, item: MenuItem, index: number): HarvestedMenuItem {
  return {
    hookId: hook.id,
    pluginId: hook.pluginId,
    id: `${hook.id}:${String(index)}`,
    title: item.title,
    icon: item.icon,
    section: item.section,
    checked: item.checked,
  };
}

/**
 * Filter an array in place.
 *
 * In place rather than by reassignment because every collection here is
 * `readonly` on the instance — which is what keeps a caller from swapping one
 * out — and because a `Harvest` handed to Task 16a is the same object for the
 * life of the host.
 */
function keepOthers<T>(rows: T[], keep: (row: T) => boolean): void {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row !== undefined && !keep(row)) rows.splice(i, 1);
  }
}
