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
import type { Harvest, MenuContext, MenuHookCallback } from "./harvest";

export interface WorkspaceDeps {
  readonly events: ShimEventBus;
  readonly harvest: Harvest;
}

const MENU_EVENTS = new Set<string>(["file-menu", "editor-menu"]);

export class Workspace extends Events {
  constructor(private readonly deps: WorkspaceDeps) {
    super(deps.events);
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
    return {
      detach: (): void => {
        ref.detach();
        registration.detach();
      },
    };
  }

  protected override prefix(): string {
    return "workspace";
  }
}
