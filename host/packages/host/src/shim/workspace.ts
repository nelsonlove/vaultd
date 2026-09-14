/**
 * `app.workspace`, as much of it as a menu hook needs.
 *
 * **A seed, and Task 11a owns the rest.** That task builds the workspace this
 * host really has — leaves, `getActiveFile`, `openLinkText`, `onLayoutReady`
 * and the layout-ready latch. What is here is the one piece Task 10 cannot do
 * without: a plugin registers its context-menu hook with
 * `app.workspace.on("file-menu", ...)`, and a harvest that could not see that
 * registration would have nothing to build a menu from. Task 11a extends this
 * class rather than replacing it, and the menu-hook recording below moves
 * nowhere when it does.
 *
 * The recording sits in `on` rather than in the harvest, because the two menu
 * events are the only ones where *registering* is the whole of the plugin's
 * contribution. Every other workspace event is delivered when it happens; these
 * two are questions the host asks whenever someone wants a menu, so the handler
 * has to be kept rather than merely attached.
 */

import { Events } from "./events";
import type { EventCallback, EventRef, ShimEventBus } from "./events";
import type { Harvest, MenuContext, MenuHookCallback, MenuHookRegistration } from "./harvest";

export interface WorkspaceDeps {
  readonly events: ShimEventBus;
  readonly harvest: Harvest;
}

const MENU_EVENTS = new Set<string>(["file-menu", "editor-menu"]);

/** One harvested hook, and the callback `off(name, callback)` will name it by. */
interface HookEntry {
  readonly callback: EventCallback;
  readonly registration: MenuHookRegistration;
}

export class Workspace extends Events {
  /**
   * The harvested hooks, by event name.
   *
   * Kept here because a plugin has three ways to withdraw a listener — the ref
   * it was given, `offref(ref)`, and `off(name, callback)` — and only the first
   * two carry anything that knows about the harvest. Without this map the third
   * one would leave the host holding a menu hook the plugin had withdrawn: the
   * harvest would report it, and a menu build would invoke it.
   */
  private readonly hooks = new Map<string, HookEntry[]>();

  constructor(private readonly deps: WorkspaceDeps) {
    super(deps.events);
    // A hook registered without `registerEvent` has no ref teardown to run, so
    // an owner-wide detach — what a quarantine does — is the only thing that
    // can withdraw it. Without this the map would keep one dead entry per
    // quarantined plugin for the life of the host.
    deps.events.onOwnerDetached((pluginId) => {
      this.forgetPlugin(pluginId);
    });
  }

  /** Drop every hook one plugin registered, listener refs or not. */
  forgetPlugin(pluginId: string): void {
    for (const [name, entries] of [...this.hooks]) {
      for (const entry of [...entries]) {
        if (entry.registration.hook.pluginId === pluginId) this.withdraw(name, entry);
      }
    }
  }

  /**
   * How many hook entries this workspace is holding.
   *
   * Public so a case can assert the map is empty after a plugin is forgotten:
   * a leak of one entry per plugin lifetime is invisible to every other
   * assertion, which is exactly why it needs one of its own.
   */
  hookEntryCount(): number {
    let total = 0;
    for (const entries of this.hooks.values()) total += entries.length;
    return total;
  }

  /**
   * Attach the listener, and — for the two menu events — record the hook.
   *
   * Both, not either: the bus registration is what keeps `off`, `offref` and
   * the listener count honest, and the harvest record is what lets a menu be
   * built on demand. The returned ref drops both, so a plugin that detaches its
   * own hook really loses it.
   *
   * A registration made outside a plugin's load has no owner to attribute it
   * to, and is attached without being harvested: an unowned hook could not be
   * quarantined, reported, or addressed by id.
   */
  override on(name: string, callback: EventCallback, context?: unknown): EventRef {
    const ref = super.on(name, callback, context);
    if (!MENU_EVENTS.has(name)) return ref;
    const pluginId = this.deps.events.attribution();
    if (pluginId === null) return ref;
    const registration = this.deps.harvest.recordMenuHook(
      pluginId,
      name as MenuContext,
      // The bus types every listener as Obsidian does — untyped — and a menu
      // hook's real signature is `(menu, file, source)`. The cast is the one
      // place the shim states that.
      callback as unknown as MenuHookCallback,
    );
    const entry: HookEntry = { callback, registration };
    this.entriesFor(name).push(entry);
    return {
      detach: (): void => {
        ref.detach();
        this.withdraw(name, entry);
      },
    };
  }

  /**
   * Detach every listener of `callback` for `name`, and withdraw the hooks with
   * them.
   *
   * By callback, and therefore possibly several at once — which is what the bus
   * does, and what a plugin that registered the same function twice is asking
   * for.
   */
  override off(name: string, callback: EventCallback): void {
    super.off(name, callback);
    const entries = this.hooks.get(name);
    if (entries === undefined) return;
    for (const entry of [...entries]) {
      if (entry.callback === callback) this.withdraw(name, entry);
    }
  }

  protected override prefix(): string {
    return "workspace";
  }

  private entriesFor(name: string): HookEntry[] {
    const existing = this.hooks.get(name);
    if (existing !== undefined) return existing;
    const created: HookEntry[] = [];
    this.hooks.set(name, created);
    return created;
  }

  /** Drop one hook from the harvest and from this map. Safe to call twice. */
  private withdraw(name: string, entry: HookEntry): void {
    entry.registration.detach();
    const entries = this.hooks.get(name);
    if (entries === undefined) return;
    const at = entries.indexOf(entry);
    if (at !== -1) entries.splice(at, 1);
    if (entries.length === 0) this.hooks.delete(name);
  }
}
