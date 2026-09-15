/**
 * The inert half of the API: settings tabs, settings rows, the ten value
 * components, the modals, the suggesters, and the two `instanceof` targets a
 * plugin's keymap code tests against.
 *
 * **Every one of these is something a plugin builds during `onload` and shows
 * later.** That split is what makes them safe to stub and unsafe to omit:
 * constructing a `Modal` and filling its `contentEl` is ordinary load-time work
 * that must succeed, and *showing* it is the part with no headless meaning. So
 * the classes are real — real constructors, real fields, methods that store
 * what they were given and return `this` — and only the show step refuses.
 *
 * **Chains must not break.** A settings tab is written as one long chain:
 * `new Setting(el).setName("x").addToggle((t) => t.setValue(v).onChange(...))`.
 * A method that returned `undefined` anywhere in that chain would throw a
 * `TypeError` inside `onload` and take the whole plugin down over a control
 * nobody can see. Every builder here returns `this`, and every `add*` callback
 * really is called with a real component.
 *
 * **What is deliberately not here.** Nothing renders, nothing measures, nothing
 * is focused. A `display()` is never executed by this plan — Task 17 explains
 * why — so these classes exist to be constructed, chained, and read back, not
 * to be driven.
 */

import { Component } from "./plugin";
import { StubEl } from "./dom";
import { declarePolicy, recordUse, stub, unsupported } from "./policy";
import { prepareFuzzySearch, sortSearchResults } from "./search";
import type { App } from "./app";
import type { Plugin } from "./plugin";
import type { SearchResult } from "./search";

// ---------------------------------------------------------------------------
// The component hierarchy
// ---------------------------------------------------------------------------

/**
 * What every settings control has: a disabled flag and `then`.
 *
 * Not a barrel export. Obsidian exports it, but nothing in the golden corpus
 * reaches for it, and the rule this task enforces is that the table and the
 * exports agree — so a name nothing asks for stays internal rather than
 * becoming a row that claims a surface no capture supports.
 */
export class BaseComponent {
  disabled = false;

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  /** Obsidian's escape hatch for running code mid-chain. Really calls back. */
  then(callback: (component: this) => unknown): this {
    callback(this);
    return this;
  }
}

/**
 * A control that holds a value.
 *
 * `getValue`/`setValue` are concrete rather than abstract on purpose: a plugin
 * subclassing `ValueComponent` and overriding only one of them is a shape this
 * host has to survive, and an abstract member it did not override would be
 * `undefined` at the call site.
 */
export class ValueComponent<T> extends BaseComponent {
  protected currentValue: T | undefined;
  protected changeHandler: ((value: T) => unknown) | null = null;

  getValue(): T {
    return this.currentValue as T;
  }

  setValue(value: T): this {
    this.currentValue = value;
    return this;
  }

  /**
   * Remember the handler; never fire it.
   *
   * There is no user to change anything, so the handler is dead weight — but a
   * plugin reads its own settings back through the component, and Task 17's
   * settings service is what will call these deliberately. Storing it is what
   * makes that possible later; calling it now would be inventing input.
   */
  onChange(callback: (value: T) => unknown): this {
    this.changeHandler = callback;
    return this;
  }

  /** Obsidian's option-listener plumbing. Recorded, never wired. */
  registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string): this {
    void listeners;
    void key;
    return this;
  }

  /** What a later driver would call to simulate the user. */
  fireChange(): void {
    this.changeHandler?.(this.getValue());
  }
}

/** The text-like trio's shared surface. */
export class AbstractTextComponent<T extends StubEl> extends ValueComponent<string> {
  readonly inputEl: T;

  constructor(inputEl: T) {
    super();
    this.inputEl = inputEl;
    this.currentValue = "";
  }

  override setValue(value: string): this {
    this.currentValue = value;
    this.inputEl.value = value;
    return this;
  }

  override getValue(): string {
    return this.currentValue ?? "";
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.setAttr("placeholder", placeholder);
    return this;
  }

  override setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.inputEl.disabled = disabled;
    return this;
  }
}

export class TextComponent extends AbstractTextComponent<StubEl> {
  constructor(containerEl: StubEl) {
    super(containerEl.createEl("input", { type: "text" }));
    stub("TextComponent", undefined);
  }
}

export class TextAreaComponent extends AbstractTextComponent<StubEl> {
  constructor(containerEl: StubEl) {
    super(containerEl.createEl("textarea"));
    stub("TextAreaComponent", undefined);
  }
}

export class SearchComponent extends AbstractTextComponent<StubEl> {
  readonly clearButtonEl: StubEl;

  constructor(containerEl: StubEl) {
    const wrapper = containerEl.createDiv({ cls: "search-input-container" });
    super(wrapper.createEl("input", { type: "search" }));
    this.clearButtonEl = wrapper.createDiv({ cls: "search-input-clear-button" });
    stub("SearchComponent", undefined);
  }

  onChanged(): void {
    stub("SearchComponent", undefined);
  }
}

export class ButtonComponent extends BaseComponent {
  readonly buttonEl: StubEl;
  private clickHandler: ((event: unknown) => unknown) | null = null;

  constructor(containerEl: StubEl) {
    super();
    this.buttonEl = containerEl.createEl("button");
    stub("ButtonComponent", undefined);
  }

  setButtonText(text: string): this {
    this.buttonEl.setText(text);
    return this;
  }

  setIcon(icon: string): this {
    this.buttonEl.setAttr("data-icon", icon);
    return this;
  }

  setTooltip(tooltip: string): this {
    this.buttonEl.setAttr("aria-label", tooltip);
    return this;
  }

  setClass(cls: string): this {
    this.buttonEl.addClass(cls);
    return this;
  }

  setCta(): this {
    return this.setClass("mod-cta");
  }

  removeCta(): this {
    this.buttonEl.removeClass("mod-cta");
    return this;
  }

  setWarning(): this {
    return this.setClass("mod-warning");
  }

  override setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.buttonEl.disabled = disabled;
    return this;
  }

  onClick(callback: (event: unknown) => unknown): this {
    this.clickHandler = callback;
    return this;
  }

  /** What a later driver would call to simulate the click. */
  fireClick(event: unknown = { headless: true }): void {
    this.clickHandler?.(event);
  }
}

export class ExtraButtonComponent extends BaseComponent {
  readonly extraSettingsEl: StubEl;
  private clickHandler: ((event: unknown) => unknown) | null = null;

  constructor(containerEl: StubEl) {
    super();
    this.extraSettingsEl = containerEl.createDiv({ cls: "extra-setting-button" });
    stub("ExtraButtonComponent", undefined);
  }

  setIcon(icon: string): this {
    this.extraSettingsEl.setAttr("data-icon", icon);
    return this;
  }

  setTooltip(tooltip: string): this {
    this.extraSettingsEl.setAttr("aria-label", tooltip);
    return this;
  }

  override setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  onClick(callback: (event: unknown) => unknown): this {
    this.clickHandler = callback;
    return this;
  }

  fireClick(event: unknown = { headless: true }): void {
    this.clickHandler?.(event);
  }
}

export class DropdownComponent extends ValueComponent<string> {
  readonly selectEl: StubEl;
  /** Insertion-ordered, so a plugin reading its own options back gets its order. */
  readonly options = new Map<string, string>();

  constructor(containerEl: StubEl) {
    super();
    this.selectEl = containerEl.createEl("select");
    this.currentValue = "";
    stub("DropdownComponent", undefined);
  }

  addOption(value: string, display: string): this {
    this.options.set(value, display);
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.options.set(value, display);
    return this;
  }

  override getValue(): string {
    return this.currentValue ?? "";
  }

  override setValue(value: string): this {
    this.currentValue = value;
    this.selectEl.value = value;
    return this;
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  readonly toggleEl: StubEl;

  constructor(containerEl: StubEl) {
    super();
    this.toggleEl = containerEl.createDiv({ cls: "checkbox-container" });
    this.currentValue = false;
    stub("ToggleComponent", undefined);
  }

  override getValue(): boolean {
    return this.currentValue ?? false;
  }

  override setValue(value: boolean): this {
    this.currentValue = value;
    this.toggleEl.toggleClass("is-enabled", value);
    return this;
  }

  setTooltip(tooltip: string): this {
    this.toggleEl.setAttr("aria-label", tooltip);
    return this;
  }
}

export class SliderComponent extends ValueComponent<number> {
  readonly sliderEl: StubEl;
  private low = 0;
  private high = 100;
  private step = 1;

  constructor(containerEl: StubEl) {
    super();
    this.sliderEl = containerEl.createEl("input", { type: "range" });
    this.currentValue = 0;
    stub("SliderComponent", undefined);
  }

  setLimits(min: number, max: number, step: number): this {
    this.low = min;
    this.high = max;
    this.step = step;
    return this;
  }

  /** The limits a plugin set, so a later driver can honour them. */
  limits(): { min: number; max: number; step: number } {
    return { min: this.low, max: this.high, step: this.step };
  }

  override getValue(): number {
    return this.currentValue ?? 0;
  }

  override setValue(value: number): this {
    this.currentValue = value;
    this.sliderEl.value = String(value);
    return this;
  }

  getValuePretty(): string {
    return String(this.getValue());
  }

  setDynamicTooltip(): this {
    return this;
  }

  showTooltip(): void {
    stub("SliderComponent", undefined);
  }
}

export class ColorComponent extends ValueComponent<string> {
  readonly colorEl: StubEl;

  constructor(containerEl: StubEl) {
    super();
    this.colorEl = containerEl.createEl("input", { type: "color" });
    this.currentValue = "#000000";
    stub("ColorComponent", undefined);
  }

  override getValue(): string {
    return this.currentValue ?? "#000000";
  }

  override setValue(value: string): this {
    this.currentValue = value;
    this.colorEl.value = value;
    return this;
  }

  getValueRgb(): { r: number; g: number; b: number } {
    return hexToRgbValue(this.getValue());
  }

  setValueRgb(rgb: { r: number; g: number; b: number }): this {
    return this.setValue(rgbToHexValue(rgb));
  }

  getValueHsl(): { h: number; s: number; l: number } {
    return rgbToHsl(this.getValueRgb());
  }

  setValueHsl(hsl: { h: number; s: number; l: number }): this {
    return this.setValueRgb(hslToRgb(hsl));
  }
}

/**
 * The secret field, which is a text field that never shows what it holds.
 *
 * It really stores the value, because a plugin reads its own setting back — but
 * nothing here writes it anywhere, and the host's own settings service (Task
 * 17) is what decides where a secret may land.
 */
export class SecretComponent extends ValueComponent<string> {
  readonly inputEl: StubEl;

  constructor(containerEl: StubEl) {
    super();
    this.inputEl = containerEl.createEl("input", { type: "password" });
    this.currentValue = "";
    stub("SecretComponent", undefined);
  }

  override getValue(): string {
    return this.currentValue ?? "";
  }

  override setValue(value: string): this {
    this.currentValue = value;
    return this;
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.setAttr("placeholder", placeholder);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The settings rows built inside one container, in the order they were built.
 *
 * A `WeakMap` rather than a field on the element, because the element class is
 * 11a's and a settings-shaped field on every node in the host would be a lie
 * about what a node is. Task 17 reads this to answer "what settings does this
 * plugin declare" without executing anything of its own.
 */
const settingsByContainer = new WeakMap<StubEl, Setting[]>();

/** Every `Setting` built into `containerEl`, in build order. */
export function settingsIn(containerEl: StubEl): readonly Setting[] {
  return settingsByContainer.get(containerEl) ?? [];
}

/**
 * One settings row: a name, a description, and the controls hung off it.
 *
 * `harvested` rather than `safe_stub`, because the row is not thrown away: it
 * is the record of a setting this plugin offers, and something outside the
 * process can act on that. What cannot happen is the rendering.
 */
export class Setting {
  readonly settingEl: StubEl;
  readonly infoEl: StubEl;
  readonly nameEl: StubEl;
  readonly descEl: StubEl;
  readonly controlEl: StubEl;
  readonly components: BaseComponent[] = [];
  private nameText = "";
  private descText = "";

  constructor(containerEl: StubEl) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
    const built = settingsByContainer.get(containerEl);
    if (built === undefined) settingsByContainer.set(containerEl, [this]);
    else built.push(this);
    recordUse("Setting");
  }

  /** The name and description a plugin gave, as plain text. */
  get name(): string {
    return this.nameText;
  }

  get description(): string {
    return this.descText;
  }

  setName(name: string | StubEl): this {
    this.nameText = typeof name === "string" ? name : name.textContent;
    this.nameEl.setText(this.nameText);
    return this;
  }

  setDesc(desc: string | StubEl): this {
    this.descText = typeof desc === "string" ? desc : desc.textContent;
    this.descEl.setText(this.descText);
    return this;
  }

  setClass(cls: string): this {
    this.settingEl.addClass(cls);
    return this;
  }

  setTooltip(tooltip: string): this {
    this.settingEl.setAttr("aria-label", tooltip);
    return this;
  }

  setHeading(): this {
    return this.setClass("setting-item-heading");
  }

  setDisabled(disabled: boolean): this {
    this.settingEl.toggleClass("is-disabled", disabled);
    return this;
  }

  addButton(callback: (component: ButtonComponent) => unknown): this {
    return this.add(new ButtonComponent(this.controlEl), callback);
  }

  addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
    return this.add(new ExtraButtonComponent(this.controlEl), callback);
  }

  addText(callback: (component: TextComponent) => unknown): this {
    return this.add(new TextComponent(this.controlEl), callback);
  }

  addTextArea(callback: (component: TextAreaComponent) => unknown): this {
    return this.add(new TextAreaComponent(this.controlEl), callback);
  }

  addSearch(callback: (component: SearchComponent) => unknown): this {
    return this.add(new SearchComponent(this.controlEl), callback);
  }

  addDropdown(callback: (component: DropdownComponent) => unknown): this {
    return this.add(new DropdownComponent(this.controlEl), callback);
  }

  addToggle(callback: (component: ToggleComponent) => unknown): this {
    return this.add(new ToggleComponent(this.controlEl), callback);
  }

  addSlider(callback: (component: SliderComponent) => unknown): this {
    return this.add(new SliderComponent(this.controlEl), callback);
  }

  addColorPicker(callback: (component: ColorComponent) => unknown): this {
    return this.add(new ColorComponent(this.controlEl), callback);
  }

  addSecret(callback: (component: SecretComponent) => unknown): this {
    return this.add(new SecretComponent(this.controlEl), callback);
  }

  then(callback: (setting: this) => unknown): this {
    callback(this);
    return this;
  }

  clear(): this {
    this.components.length = 0;
    this.controlEl.empty();
    return this;
  }

  private add<T extends BaseComponent>(component: T, callback: (component: T) => unknown): this {
    this.components.push(component);
    callback(component);
    return this;
  }
}

/**
 * The base a plugin's settings tab extends.
 *
 * `display()` is left empty rather than made abstract: a plugin always
 * overrides it, and a tab that somehow did not must still be constructible.
 * Nothing in this plan calls it.
 */
export class PluginSettingTab {
  readonly app: App;
  readonly plugin: Plugin;
  readonly containerEl: StubEl;

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new StubEl("div", { cls: "vertical-tab-content" });
    recordUse("PluginSettingTab");
  }

  display(): void {
    // A plugin overrides this. Nothing in the host calls it.
  }

  hide(): void {
    this.containerEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Modals and suggesters
// ---------------------------------------------------------------------------

/**
 * A modal that can be built and cannot be shown.
 *
 * `safe_stub`, not `absent`, and the distinction is the whole reason this class
 * is shaped the way it is: constructing a modal and filling its `contentEl` is
 * ordinary `onload`-time work — plugins build one in a command's callback long
 * before anyone runs the command — so a class that threw on construction would
 * kill the half of the plugin that works. Only {@link open} refuses, and the
 * refusal names the **subclass**, because "a modal was opened" is useless and
 * "quickadd's `ChoiceSuggester` was opened" is a diagnosis.
 *
 * Task 18 owns what happens to that throw: it brokers the ones whose choice can
 * be answered from outside the process.
 */
export class Modal {
  readonly app: App;
  readonly scope: Scope;
  readonly containerEl: StubEl;
  readonly modalEl: StubEl;
  readonly titleEl: StubEl;
  readonly contentEl: StubEl;
  shouldRestoreSelection = false;

  constructor(app: App) {
    this.app = app;
    this.scope = new Scope();
    this.containerEl = new StubEl("div", { cls: "modal-container" });
    this.modalEl = this.containerEl.createDiv({ cls: "modal" });
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
    stub("Modal", undefined);
  }

  setTitle(title: string): this {
    this.titleEl.setText(title);
    return this;
  }

  setContent(content: string | StubEl): this {
    if (typeof content === "string") this.contentEl.setText(content);
    else this.contentEl.empty().appendChild(content);
    return this;
  }

  /** There is no window to show it in. Names the subclass that asked. */
  open(): void {
    unsupported("Modal.open", this.constructor.name);
  }

  /**
   * Closing is a no-op rather than a throw.
   *
   * A modal that was never opened is already closed, and `close()` is what a
   * plugin calls on its own cleanup paths — including inside the `catch` that
   * an `open()` throw lands in. A throw here would turn one diagnosable failure
   * into two.
   */
  close(): void {
    stub("Modal.close", undefined);
    this.onClose();
  }

  onOpen(): void {
    // A plugin overrides this.
  }

  onClose(): void {
    // A plugin overrides this.
  }
}

/** Obsidian's `FuzzyMatch<T>`: the item and how well it matched. */
export interface FuzzyMatch<T> {
  item: T;
  match: SearchResult;
}

/**
 * The suggester base: a query box, a list, and a choice.
 *
 * The **selection** half is real — `getSuggestions` is called, the list is
 * ordered, `onChooseSuggestion` runs — and only the showing is not. That is why
 * it is `implemented` rather than `safe_stub` despite inheriting
 * {@link Modal.open}'s refusal: everything a broker outside the process needs
 * to answer the picker is here and works. Task 18 supplies the broker.
 */
export class SuggestModal<T> extends Modal {
  readonly inputEl: StubEl;
  readonly resultContainerEl: StubEl;
  limit = 50;
  emptyStateText = "No results found.";

  constructor(app: App) {
    super(app);
    this.inputEl = this.modalEl.createEl("input", { type: "text", cls: "prompt-input" });
    this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" });
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.setAttr("placeholder", placeholder);
    return this;
  }

  setInstructions(instructions: { command: string; purpose: string }[]): this {
    void instructions;
    return this;
  }

  /** A plugin overrides this. The base offers nothing. */
  getSuggestions(query: string): T[] | Promise<T[]> {
    void query;
    return [];
  }

  renderSuggestion(value: T, el: StubEl): void {
    el.setText(displayText(value));
  }

  onChooseSuggestion(item: T, event: unknown): void {
    void item;
    void event;
  }

  onNoSuggestion(): void {
    // A plugin overrides this.
  }

  selectSuggestion(value: T, event: unknown): void {
    this.onChooseSuggestion(value, event);
  }

  selectActiveSuggestion(event: unknown): void {
    void event;
  }
}

/**
 * The fuzzy picker, and the one suggester with real behaviour of its own.
 *
 * `getSuggestions` is implemented here rather than left to the subclass: the
 * plugin supplies `getItems()` and `getItemText()`, and the matching and
 * ordering are the host's — which is exactly the part a brokered picker needs
 * to be right, because the order it offers is the order a caller picks from.
 */
export class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  /** A plugin overrides this. */
  getItems(): T[] {
    return [];
  }

  /** A plugin overrides this. */
  getItemText(item: T): string {
    return displayText(item);
  }

  onChooseItem(item: T, event: unknown): void {
    void item;
    void event;
  }

  override getSuggestions(query: string): FuzzyMatch<T>[] {
    const scorer = prepareFuzzySearch(query);
    const scored: { item: T; match: SearchResult | null }[] = this.getItems().map((item) => ({
      item,
      match: scorer(this.getItemText(item)),
    }));
    sortSearchResults(scored);
    const kept: FuzzyMatch<T>[] = [];
    for (const entry of scored) {
      if (entry.match === null) continue;
      kept.push({ item: entry.item, match: entry.match });
      if (kept.length >= this.limit) break;
    }
    return kept;
  }

  override renderSuggestion(value: FuzzyMatch<T>, el: StubEl): void {
    el.setText(this.getItemText(value.item));
  }

  override onChooseSuggestion(item: FuzzyMatch<T>, event: unknown): void {
    this.onChooseItem(item.item, event);
  }
}

/**
 * The popover base the two non-modal suggesters share.
 *
 * Not a barrel export — Obsidian exports `PopoverSuggest`, nothing in the
 * corpus reaches for it, and an export nothing asks for would be a row this
 * host cannot back with a capture.
 */
export class PopoverSuggest<T> {
  readonly app: App;
  limit = 100;

  constructor(app: App) {
    this.app = app;
  }

  open(): void {
    stub("PopoverSuggest.open", undefined);
  }

  close(): void {
    stub("PopoverSuggest.close", undefined);
  }

  renderSuggestion(value: T, el: StubEl): void {
    el.setText(displayText(value));
  }

  selectSuggestion(value: T, event: unknown): void {
    void value;
    void event;
  }
}

/**
 * The suggester a plugin attaches to a text input — a folder picker, a tag
 * picker, a file picker.
 *
 * There is no input to attach to and no popover to show, so this is inert. It
 * exists because five of the eight golden bundles **extend** it at module scope:
 * a missing base class is `class extends undefined`, which is a `TypeError`
 * thrown while the bundle is still evaluating, before a single line of the
 * plugin has run.
 */
export class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  readonly textInputEl: StubEl;

  constructor(app: App, textInputEl: StubEl) {
    super(app);
    this.textInputEl = textInputEl;
    stub("AbstractInputSuggest", undefined);
  }

  getSuggestions(query: string): T[] | Promise<T[]> {
    void query;
    return [];
  }

  setValue(value: string): void {
    this.textInputEl.value = value;
  }

  getValue(): string {
    return this.textInputEl.value;
  }

  onSelect(callback: (value: T, event: unknown) => unknown): this {
    this.selectHandler = callback;
    return this;
  }

  override selectSuggestion(value: T, event: unknown): void {
    this.selectHandler?.(value, event);
  }

  private selectHandler: ((value: T, event: unknown) => unknown) | null = null;
}

/** The in-editor suggester. Inert for the same reason: there is no editor. */
export class EditorSuggest<T> extends PopoverSuggest<T> {
  context: unknown = null;

  constructor(app: App) {
    super(app);
    stub("EditorSuggest", undefined);
  }

  onTrigger(cursor: unknown, editor: unknown, file: unknown): unknown {
    void cursor;
    void editor;
    void file;
    return null;
  }

  getSuggestions(context: unknown): T[] | Promise<T[]> {
    void context;
    return [];
  }

  setInstructions(instructions: { command: string; purpose: string }[]): this {
    void instructions;
    return this;
  }
}

// ---------------------------------------------------------------------------
// The remaining instanceof targets
// ---------------------------------------------------------------------------

/**
 * A child of a rendered markdown block.
 *
 * A real {@link Component}, so its lifecycle works: a plugin that adds one as a
 * child and later unloads gets its `onunload` and its registrations undone.
 * What it has no part of is the rendering that would have created it.
 */
export class MarkdownRenderChild extends Component {
  readonly containerEl: StubEl;

  constructor(containerEl: StubEl) {
    super();
    this.containerEl = containerEl;
    stub("MarkdownRenderChild", undefined);
  }
}

/** A keymap scope: it accepts registrations and there is no keyboard. */
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
 * The editor, as a name a plugin can test against and nothing more.
 *
 * **Every method refuses, and none of them lies.** This host has no editor: a
 * `getValue()` that answered `""` would tell a plugin the note is empty, and a
 * plugin that then wrote that back would empty the note. So the class exists —
 * `leaf.view instanceof MarkdownView` guards and `editor instanceof Editor`
 * guards both need it to — and every call throws a `HeadlessUnsupported` naming
 * the member. Nothing in this host constructs one, so nothing reaches those
 * throws today; a later task that supplies a real editor context replaces the
 * body rather than the name.
 */
export class Editor {
  getValue(): string {
    return unsupported("Editor.getValue");
  }

  setValue(value: string): void {
    void value;
    unsupported("Editor.setValue");
  }

  getLine(line: number): string {
    void line;
    return unsupported("Editor.getLine");
  }

  setLine(line: number, text: string): void {
    void line;
    void text;
    unsupported("Editor.setLine");
  }

  lineCount(): number {
    return unsupported("Editor.lineCount");
  }

  getCursor(string?: string): unknown {
    void string;
    return unsupported("Editor.getCursor");
  }

  setCursor(pos: unknown): void {
    void pos;
    unsupported("Editor.setCursor");
  }

  getSelection(): string {
    return unsupported("Editor.getSelection");
  }

  replaceSelection(replacement: string): void {
    void replacement;
    unsupported("Editor.replaceSelection");
  }

  replaceRange(replacement: string, from: unknown, to?: unknown): void {
    void replacement;
    void from;
    void to;
    unsupported("Editor.replaceRange");
  }

  getRange(from: unknown, to: unknown): string {
    void from;
    void to;
    return unsupported("Editor.getRange");
  }

  transaction(tx: unknown): void {
    void tx;
    unsupported("Editor.transaction");
  }
}

/**
 * A label for a value of unknown shape.
 *
 * Plugins hand these suggesters their own objects, so the base class cannot
 * assume a useful `toString`. A primitive reads as itself; anything else reads
 * as its `text`/`name`/`title` field if it has one, and otherwise as the empty
 * string — which renders as a blank row rather than as `[object Object]`.
 */
function displayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "name", "title", "path"]) {
      const candidate = record[key];
      if (typeof candidate === "string") return candidate;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Colour conversion, shared by the colour component and the two barrel helpers
// ---------------------------------------------------------------------------

/** `#rgb` or `#rrggbb` to channels. An unparseable colour reads as black. */
export function hexToRgbValue(hex: string): { r: number; g: number; b: number } {
  const text = hex.startsWith("#") ? hex.slice(1) : hex;
  const full =
    text.length === 3
      ? [text.charAt(0), text.charAt(0), text.charAt(1), text.charAt(1), text.charAt(2), text.charAt(2)].join("")
      : text;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return { r: 0, g: 0, b: 0 };
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** Channels to `#rrggbb`, clamped and lower-case, which is what Obsidian emits. */
export function rgbToHexValue(rgb: { r: number; g: number; b: number }): string {
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

function channel(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, "0");
}

function rgbToHsl(rgb: { r: number; g: number; b: number }): { h: number; s: number; l: number } {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const span = max - min;
  const s = l > 0.5 ? span / (2 - max - min) : span / (max + min);
  let h: number;
  if (max === r) h = (g - b) / span + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / span + 2;
  else h = (r - g) / span + 4;
  return { h: h / 6, s, l };
}

function hslToRgb(hsl: { h: number; s: number; l: number }): { r: number; g: number; b: number } {
  const { h, s, l } = hsl;
  if (s === 0) {
    const grey = Math.round(l * 255);
    return { r: grey, g: grey, b: grey };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToChannel(p, q, h) * 255),
    b: Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  };
}

function hueToChannel(p: number, q: number, t: number): number {
  let hue = t;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}

// The rows this file owns: the members, which the barrel never sees. The
// classes themselves are declared by the barrel, from the policy table.
declarePolicy("Modal.open", "absent");
declarePolicy("Modal.close", "safe_stub");
declarePolicy("PopoverSuggest.open", "safe_stub");
declarePolicy("PopoverSuggest.close", "safe_stub");
declarePolicy("Editor.getValue", "absent");
declarePolicy("Editor.setValue", "absent");
declarePolicy("Editor.getLine", "absent");
declarePolicy("Editor.setLine", "absent");
declarePolicy("Editor.lineCount", "absent");
declarePolicy("Editor.getCursor", "absent");
declarePolicy("Editor.setCursor", "absent");
declarePolicy("Editor.getSelection", "absent");
declarePolicy("Editor.replaceSelection", "absent");
declarePolicy("Editor.replaceRange", "absent");
declarePolicy("Editor.getRange", "absent");
declarePolicy("Editor.transaction", "absent");
