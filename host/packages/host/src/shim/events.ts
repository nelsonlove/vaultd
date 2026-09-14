/**
 * Obsidian's `Events` base, and the bus every shim surface reuses.
 *
 * Built here, in Task 6b, ahead of its consumers: `Vault` (Task 7) takes a
 * {@link ShimEventBus} in its deps and `harness.app` is read from Task 7
 * onward, so a plan that produced this in Task 10 produced it two tasks after
 * its first consumer. Task 10 adds `Menu` and `MenuItem` to this same file.
 *
 * Three things it gets right that a naive `EventEmitter` would not:
 *
 * 1. **`off` matches on the callback, `offref` on the registration.** A plugin
 *    that registered the same function for two events, or the same function
 *    twice for one event, must be able to detach exactly one of them —
 *    `registerEvent(...)` keeps the ref precisely so it can.
 * 2. **A throwing handler never stops the fan-out.** Obsidian catches per
 *    listener and logs; a shim that let one plugin's exception skip every other
 *    plugin's handler would produce failures that look like the *other*
 *    plugin's bug. The error goes to {@link ShimEventBus.onHandlerError} with
 *    the owning plugin's id attached, which is what lets Task 14b's quarantine
 *    name the plugin whose handler threw rather than "someone's".
 * 3. **Attribution is ambient, not a parameter.** A listener is registered deep
 *    inside a plugin's own `onload`, through API surfaces that know nothing
 *    about plugins, so asking every call site to pass an id would mean every
 *    call site could forget. {@link ShimEventBus.attributingTo} wraps the load
 *    instead, and every registration made inside it is owned by that plugin.
 */

import { declarePolicy, stub } from "./policy";

/** Anything a shim event hands its listeners. Obsidian's own signature is untyped. */
export type EventCallback = (...data: never[]) => unknown;

/**
 * The handle `off`-ing one registration needs.
 *
 * Obsidian's own `EventRef` is opaque — `export interface EventRef {}` — and a
 * plugin only ever hands it back to `offref` or to `Component.registerEvent`.
 * `detach()` is this host's addition, so the shim's own surfaces can drop a
 * registration without holding a reference to the bus it came from.
 */
export interface EventRef {
  detach(): void;
}

/** One live registration. */
interface Registration {
  readonly name: string;
  readonly callback: EventCallback;
  readonly context: unknown;
  /** The plugin whose load registered this, or `null` for the host's own. */
  readonly owner: string | null;
}

/** What a failed handler reports: the error, and who owned the handler. */
export interface HandlerFailure {
  readonly event: string;
  readonly owner: string | null;
  readonly error: unknown;
}

export class ShimEventBus {
  private readonly registrations = new Map<string, Set<Registration>>();
  private readonly failureListeners = new Set<(failure: HandlerFailure) => void>();
  /** The plugin every registration made right now belongs to. */
  private owner: string | null = null;

  /**
   * Run `body` with every registration it makes attributed to `pluginId`.
   *
   * Synchronous by design: an `await` inside `body` would let a second plugin's
   * load interleave and steal the attribution. Task 14's loader therefore wraps
   * the synchronous `onload` call, not the promise it returns — a listener a
   * plugin registers from a later microtask is genuinely unattributable, and
   * saying `null` there is honest where guessing would not be.
   */
  attributingTo<T>(pluginId: string | null, body: () => T): T {
    const previous = this.owner;
    this.owner = pluginId;
    try {
      return body();
    } finally {
      this.owner = previous;
    }
  }

  /** Who owns the registrations being made right now. */
  attribution(): string | null {
    return this.owner;
  }

  on(name: string, callback: EventCallback, context?: unknown): EventRef {
    const registration: Registration = { name, callback, context, owner: this.owner };
    let set = this.registrations.get(name);
    if (set === undefined) {
      set = new Set<Registration>();
      this.registrations.set(name, set);
    }
    set.add(registration);
    return {
      detach: (): void => {
        this.remove(registration);
      },
    };
  }

  /**
   * Detach **every** registration of `callback` for `name`.
   *
   * Obsidian's own `off` is by callback, so a function registered twice comes
   * off twice. A plugin that wants one of the two uses the ref.
   */
  off(name: string, callback: EventCallback): void {
    const set = this.registrations.get(name);
    if (set === undefined) return;
    for (const registration of [...set]) {
      if (registration.callback === callback) set.delete(registration);
    }
    if (set.size === 0) this.registrations.delete(name);
  }

  offref(ref: EventRef): void {
    ref.detach();
  }

  /**
   * Fan `data` out to every listener of `name`, in registration order.
   *
   * The set is copied first: a handler that registers or detaches during its
   * own event is ordinary — `registerEvent` inside a `layout-ready` handler is
   * the common case — and mutating a set being iterated is how that turns into
   * a listener silently skipped.
   */
  trigger(name: string, ...data: never[]): void {
    const set = this.registrations.get(name);
    if (set === undefined) return;
    for (const registration of [...set]) {
      this.tryTrigger(registration, data);
    }
  }

  /** Every listener a plugin registered, dropped in one call. */
  detachOwner(pluginId: string): number {
    let detached = 0;
    for (const [name, set] of [...this.registrations]) {
      for (const registration of [...set]) {
        if (registration.owner !== pluginId) continue;
        set.delete(registration);
        detached += 1;
      }
      if (set.size === 0) this.registrations.delete(name);
    }
    return detached;
  }

  /** How many listeners are attached — to `name`, or to everything. */
  count(name?: string): number {
    if (name !== undefined) return this.registrations.get(name)?.size ?? 0;
    let total = 0;
    for (const set of this.registrations.values()) total += set.size;
    return total;
  }

  /** The owners of `name`'s listeners, in registration order. */
  owners(name: string): readonly (string | null)[] {
    return [...(this.registrations.get(name) ?? [])].map((registration) => registration.owner);
  }

  /** Report every handler that throws. Returns the detach function. */
  onHandlerError(listener: (failure: HandlerFailure) => void): () => void {
    this.failureListeners.add(listener);
    return (): void => {
      this.failureListeners.delete(listener);
    };
  }

  private tryTrigger(registration: Registration, data: never[]): void {
    try {
      registration.callback.apply(registration.context, data);
    } catch (error) {
      this.report({ event: registration.name, owner: registration.owner, error });
    }
  }

  private remove(registration: Registration): void {
    const set = this.registrations.get(registration.name);
    if (set === undefined) return;
    set.delete(registration);
    if (set.size === 0) this.registrations.delete(registration.name);
  }

  /**
   * A failure listener that throws is dropped on the floor here, deliberately:
   * it is the only place left to report to, and re-entering the same fan-out
   * would be an unbounded loop.
   */
  private report(failure: HandlerFailure): void {
    for (const listener of [...this.failureListeners]) {
      try {
        listener(failure);
      } catch {
        // Nowhere left to report to.
      }
    }
  }
}

/**
 * Obsidian's `Events` base class, as a plugin sees it.
 *
 * Every eventful shim surface — `Vault`, `MetadataCache`, `Workspace` — extends
 * this, and they all share one {@link ShimEventBus} so attribution and error
 * reporting are the host's, not each surface's own. The bus is passed in rather
 * than created here for exactly that reason.
 */
export class Events {
  constructor(protected readonly bus: ShimEventBus) {}

  on(name: string, callback: EventCallback, context?: unknown): EventRef {
    return this.bus.on(this.scoped(name), callback, context);
  }

  off(name: string, callback: EventCallback): void {
    this.bus.off(this.scoped(name), callback);
  }

  offref(ref: EventRef): void {
    this.bus.offref(ref);
  }

  trigger(name: string, ...data: never[]): void {
    this.bus.trigger(this.scoped(name), ...data);
  }

  /**
   * The bus-wide name of one of this surface's events.
   *
   * One bus serves every surface, and `"rename"` means different things on the
   * vault and on the workspace, so each surface prefixes its own. The base
   * prefixes nothing; a surface overrides {@link prefix}.
   */
  protected scoped(name: string): string {
    const prefix = this.prefix();
    return prefix === "" ? name : `${prefix}:${name}`;
  }

  protected prefix(): string {
    return "";
  }
}

// ---------------------------------------------------------------------------
// The recording menu (Task 10)
// ---------------------------------------------------------------------------

/**
 * What a plugin may pass to {@link MenuItem.setTitle}.
 *
 * Obsidian's own signature is `string | DocumentFragment`. This host compiles
 * against `lib: es2023` with no DOM, so the fragment arm is spelled
 * structurally: anything carrying a `textContent`. A plugin that builds its
 * title out of nodes therefore still gets a title, and the harvest still has a
 * string to report, rather than the shim throwing on a type it cannot name.
 */
export type MenuTitle = string | { readonly textContent?: string | null };

/** The string form of whatever a plugin handed {@link MenuItem.setTitle}. */
function titleTextOf(title: MenuTitle): string {
  if (typeof title === "string") return title;
  return title.textContent ?? "";
}

/**
 * One item a plugin added to a menu, recorded rather than drawn.
 *
 * Every setter returns `this` because plugins chain them, and every one of them
 * is really stored: the harvest reports the title, icon, section and checked
 * state a plugin asked for, and {@link invoke} calls the very closure it
 * registered. Nothing here is a stub — a context menu is one of the two places
 * (commands being the other) where a GUI-less host can still do the whole of
 * what the plugin meant.
 */
export class MenuItem {
  private titleValue = "";
  private iconValue: string | null = null;
  private sectionValue: string | null = null;
  private checkedValue: boolean | null = null;
  private disabledValue = false;
  private isLabelValue = false;
  private click: ((evt: unknown) => unknown) | null = null;

  get title(): string {
    return this.titleValue;
  }

  get icon(): string | null {
    return this.iconValue;
  }

  get section(): string | null {
    return this.sectionValue;
  }

  get checked(): boolean | null {
    return this.checkedValue;
  }

  get disabled(): boolean {
    return this.disabledValue;
  }

  get isLabel(): boolean {
    return this.isLabelValue;
  }

  setTitle(title: MenuTitle): this {
    this.titleValue = titleTextOf(title);
    return this;
  }

  setIcon(icon: string | null): this {
    this.iconValue = icon;
    return this;
  }

  setSection(section: string): this {
    this.sectionValue = section;
    return this;
  }

  setChecked(checked: boolean | null): this {
    this.checkedValue = checked;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabledValue = disabled;
    return this;
  }

  setIsLabel(isLabel: boolean): this {
    this.isLabelValue = isLabel;
    return this;
  }

  onClick(callback: (evt: unknown) => unknown): this {
    this.click = callback;
    return this;
  }

  /**
   * Run this item's `onClick`, as a chooser picking it would.
   *
   * It `await`s the result, so an item whose handler is async has finished by
   * the time the host answers whoever asked for the click. An item with no
   * handler — a label, a separator's neighbour — is a no-op rather than a
   * throw.
   */
  async invoke(evt?: unknown): Promise<void> {
    if (this.click === null) return;
    await this.click(evt);
  }
}

/**
 * The menu a `file-menu` or `editor-menu` handler is handed.
 *
 * Obsidian's `Menu` draws itself; this one records. A plugin adds its items
 * exactly as it always has, and what would have been pixels is instead a list
 * something outside the process can read and pick from.
 *
 * **Built fresh for every listing and every invocation.** A plugin's item text
 * and its `onClick` closure both close over the file the menu was opened for,
 * so caching the items from one listing and firing them later would run a
 * handler bound to a stale file.
 */
export class Menu {
  private readonly entries: MenuItem[] = [];

  addItem(callback: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    callback(item);
    this.entries.push(item);
    return this;
  }

  /**
   * Separators are dropped rather than recorded.
   *
   * The items are addressed by their ordinal, and a chooser has nothing to do
   * with a divider — recording one would shift every id after it for a thing
   * nobody can pick.
   */
  addSeparator(): this {
    return this;
  }

  setNoIcon(): this {
    return this;
  }

  showAtMouseEvent(evt: unknown): this {
    void evt;
    return stub("Menu.showAtMouseEvent", this);
  }

  showAtPosition(position: unknown): this {
    void position;
    return stub("Menu.showAtPosition", this);
  }

  hide(): this {
    return this;
  }

  items(): readonly MenuItem[] {
    return [...this.entries];
  }
}

// The two surfaces in this file a plugin can reach that do not do what they
// say. Declared at module scope, so the compatibility report knows about them
// with nothing constructed: a surface that is really a `safe_stub` and answers
// `absent` to `policyOf` would be mis-stated in the one report a reader
// consults to find out what this host does not do.
declarePolicy("Menu.showAtMouseEvent", "safe_stub");
declarePolicy("Menu.showAtPosition", "safe_stub");
