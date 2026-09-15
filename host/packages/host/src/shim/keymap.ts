/**
 * The four small surfaces `App` needs that are all about a window: the keyboard,
 * the settings dialog and the editor's fold state.
 *
 * Each one is a `safe_stub` with a stated policy rather than a `{}` a later
 * reader has to guess about, and each one is inert for the same reason: there
 * is no keyboard, no settings window and no editor gutter in a headless host.
 * What matters is that none of them throws — every one is reached from inside
 * an `onload` or from inside a command, where a throw costs the plugin the rest
 * of its work.
 *
 * **`Keymap` and `Scope` moved here from `components.ts`** with this task and
 * did not change: they are the keyboard, not a settings component, and the two
 * `App` fields that hold them are assigned a few lines from the two fields
 * below. The barrel exports both from this file now; nothing else about them
 * moved.
 *
 * **`foldManager` is a quality fix, not a crash fix, and the difference is
 * worth recording.** rollover-daily-todos calls `window.app.foldManager.load(templateFile)`
 * **inside a `try`/`catch`** that logs and shows a Notice, so a missing
 * `foldManager` does not throw past the plugin — it turns the template read
 * into a caught failure and the rollover proceeds without fold information.
 * Stubbing it is still right, because a caught error per rollover is noise that
 * would mask a real failure; it is simply not the difference between working
 * and not.
 */

import { declarePolicy, stub } from "./policy";
import type { TFile } from "./files";

/**
 * A keymap scope: it accepts registrations and there is no keyboard.
 *
 * Registrations are kept rather than discarded so that `unregister` really
 * removes the thing `register` handed back — a plugin that counts its own
 * handlers sees a consistent story.
 */
export class Scope {
  readonly parent: Scope | null;
  private readonly handlers: { modifiers: string | null; key: string | null; run: unknown }[] = [];

  constructor(parent?: Scope) {
    this.parent = parent ?? null;
  }

  register(modifiers: string[] | null, key: string | null, func: unknown): unknown {
    const handler = { modifiers: modifiers === null ? null : modifiers.join(","), key, run: func };
    this.handlers.push(handler);
    return stub("Scope", handler);
  }

  unregister(handler: unknown): void {
    const at = this.handlers.indexOf(handler as (typeof this.handlers)[number]);
    if (at !== -1) this.handlers.splice(at, 1);
    stub("Scope", undefined);
  }
}

/**
 * The modifier helpers, as statics.
 *
 * Every question they answer is about an event that never happened, so every
 * answer is `false` — which is the same answer a real Obsidian gives for a
 * command invoked from the palette with no modifier held, and that is the case
 * a headless invocation most resembles.
 */
export class Keymap {
  static isModifier(event: unknown, modifier: string): boolean {
    void event;
    void modifier;
    return stub("Keymap", false);
  }

  static isModEvent(event?: unknown): boolean | string {
    void event;
    return stub("Keymap", false);
  }

  pushScope(scope: Scope): void {
    void scope;
    stub("Keymap", undefined);
  }

  popScope(scope: Scope): void {
    void scope;
    stub("Keymap", undefined);
  }
}

/**
 * `app.setting` — the settings **window**, which this host has none of.
 *
 * A plugin reaches it to open its own tab after a one-click affordance
 * ("configure this in settings"), so the calls are accepted and do nothing.
 * `openTabById` answers `null` rather than `undefined` because a plugin that
 * chains off the returned tab gets a value it can test; both plural fields are
 * empty arrays, never `undefined`, for the same reason every plural in this
 * shim is.
 */
export class SettingRegistry {
  readonly settingTabs: readonly unknown[] = [];
  readonly pluginTabs: readonly unknown[] = [];

  open(): void {
    stub("SettingRegistry.open", undefined);
  }

  close(): void {
    stub("SettingRegistry.close", undefined);
  }

  openTabById(id: string): null {
    void id;
    return stub("SettingRegistry.openTabById", null);
  }
}

/**
 * `app.foldManager` — which headings and lists are folded in a note.
 *
 * `null` is Obsidian's own "no fold information for this file", which is the
 * truthful answer for every file here: fold state is UI state, and this host
 * has no UI to have folded anything in. `save` accepts and discards.
 */
export class FoldManager {
  load(file: TFile): unknown {
    void file;
    return stub("FoldManager.load", null);
  }

  save(file: TFile, info: unknown): void {
    void file;
    void info;
    stub("FoldManager.save", undefined);
  }
}

// The member rows this file owns. `Keymap` and `Scope` are barrel exports and
// are declared by the table in `api.ts`; `SettingRegistry` and `FoldManager`
// are not — Obsidian's module publishes neither — so their rows are here.
declarePolicy("SettingRegistry.open", "safe_stub");
declarePolicy("SettingRegistry.close", "safe_stub");
declarePolicy("SettingRegistry.openTabById", "safe_stub");
declarePolicy("FoldManager.load", "safe_stub");
declarePolicy("FoldManager.save", "safe_stub");
