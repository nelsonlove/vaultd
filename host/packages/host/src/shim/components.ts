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
import { Scope } from "./keymap";
import { StubEl } from "./dom";
import { HOST_PLUGIN_ID } from "./errors";
import {
  InteractionTimeout,
  InteractionUnavailable,
  interactionBrokerFor,
} from "../interaction/broker";
import { currentPluginId, declarePolicy, recordUse, stub, unsupported } from "./policy";
import { prepareFuzzySearch, sortSearchResults } from "./search";
import type { App } from "./app";
import type { InteractionBroker, PromptKind } from "../interaction/broker";
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
 * A moment.js format field: a text input plus a live sample of what it renders.
 *
 * The sample is real — it formats `moment()` through the same library the
 * globals install — because a plugin reads `sampleEl.textContent` back to warn
 * a user that their format is wrong, and a blank sample reads as "your format
 * produces nothing".
 */
export class MomentFormatComponent extends AbstractTextComponent<StubEl> {
  readonly sampleEl: StubEl;
  private defaultFormatValue = "YYYY-MM-DD";
  private sampleFormatter: ((format: string) => string) | null = null;

  constructor(containerEl: StubEl) {
    super(containerEl.createEl("input", { type: "text" }));
    this.sampleEl = containerEl.createSpan({ cls: "u-pop" });
    stub("MomentFormatComponent", undefined);
  }

  setDefaultFormat(defaultFormat: string): this {
    this.defaultFormatValue = defaultFormat;
    this.inputEl.setAttr("placeholder", defaultFormat);
    return this;
  }

  setSampleEl(sampleEl: StubEl): this {
    void sampleEl;
    return this;
  }

  /** Install what turns a format into its sample. The barrel passes `moment`. */
  setFormatter(formatter: (format: string) => string): this {
    this.sampleFormatter = formatter;
    this.updateSample();
    return this;
  }

  override setValue(value: string): this {
    super.setValue(value);
    this.updateSample();
    return this;
  }

  updateSample(): void {
    const format = this.getValue() === "" ? this.defaultFormatValue : this.getValue();
    this.sampleEl.setText(this.sampleFormatter?.(format) ?? format);
  }
}

/** A progress bar: it holds a number between 0 and 100 and shows nothing. */
export class ProgressBarComponent extends ValueComponent<number> {
  readonly progressBar: StubEl;

  constructor(containerEl: StubEl) {
    super();
    this.progressBar = containerEl.createDiv({ cls: "setting-progress-bar" });
    this.currentValue = 0;
    stub("ProgressBarComponent", undefined);
  }

  override getValue(): number {
    return this.currentValue ?? 0;
  }

  override setValue(value: number): this {
    this.currentValue = Math.max(0, Math.min(100, value));
    this.progressBar.setAttr("data-value", String(this.currentValue));
    return this;
  }
}

/** A read-only label for a settings row. It stores what it was given. */
export class DisplayValueComponent extends ValueComponent<string> {
  readonly valueEl: StubEl;

  constructor(containerEl: StubEl) {
    super();
    this.valueEl = containerEl.createDiv({ cls: "setting-item-value" });
    this.currentValue = "";
    stub("DisplayValueComponent", undefined);
  }

  override getValue(): string {
    return this.currentValue ?? "";
  }

  override setValue(value: string): this {
    this.currentValue = value;
    this.valueEl.setText(value);
    return this;
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

  addMomentFormat(callback: (component: MomentFormatComponent) => unknown): this {
    return this.add(new MomentFormatComponent(this.controlEl), callback);
  }

  addProgressBar(callback: (component: ProgressBarComponent) => unknown): this {
    return this.add(new ProgressBarComponent(this.controlEl), callback);
  }

  addDisplayValue(callback: (component: DisplayValueComponent) => unknown): this {
    return this.add(new DisplayValueComponent(this.controlEl), callback);
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
 * The published base of {@link PluginSettingTab}, and an `instanceof` target.
 *
 * Obsidian exports both names and `PluginSettingTab extends SettingTab`, so the
 * chain is reproduced rather than flattened: a plugin testing
 * `tab instanceof SettingTab` gets the answer it would get in the application.
 */
export class SettingTab {
  readonly app: App;
  readonly containerEl: StubEl;

  constructor(app: App) {
    this.app = app;
    this.containerEl = new StubEl("div", { cls: "vertical-tab-content" });
    stub("SettingTab", undefined);
  }

  display(): void {
    // A plugin overrides this. Nothing in the host calls it.
  }

  hide(): void {
    this.containerEl.empty();
  }
}

/**
 * The base a plugin's settings tab extends.
 *
 * `display()` is left empty rather than made abstract: a plugin always
 * overrides it, and a tab that somehow did not must still be constructible.
 * Nothing in this plan calls it.
 */
export class PluginSettingTab extends SettingTab {
  readonly plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    super(app);
    this.plugin = plugin;
    recordUse("PluginSettingTab");
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

  /**
   * There is no window to show it in. Names the subclass that asked.
   *
   * Declared `void | Promise<void>` although this one only ever throws, because
   * the two suggester subclasses override it with a promise that settles when
   * the client answers — and a base declared bare `void` would make each of
   * those overrides a type error. Obsidian's own is `void`, which **accepts** a
   * promise at every call site a plugin writes: `modal.open()` on its own
   * behaves exactly as it always did, and an `await` — what a plugin that wants
   * the answer writes — now means something.
   */
  open(): void | Promise<void> {
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
    // Its own row, at its own declared policy. Without it a plugin that uses a
    // suggester appears in the compatibility report as a bare `Modal` stub hit,
    // and the report cannot say which of the two surfaces it leaned on.
    recordUse("SuggestModal");
  }

  /**
   * The showing half, brokered rather than refused.
   *
   * **This is the one modal a headless host can honestly open**, because the
   * showing is the only part it is missing: the base owns the rendering, the
   * subclass supplies `getSuggestions` and `onChooseSuggestion`, and everything
   * between them is a list of strings and an index. So `open()` asks
   * `getSuggestions("")` — the unfiltered list, which is what a picker shows
   * before anybody types — hands it to whoever is attached, and runs the
   * subclass's own choice handler with the item that came back.
   *
   * **The plugin's own lifecycle hooks run, in Obsidian's order**: `onOpen()`
   * before the question is asked, then `close()` — and therefore `onClose()` —
   * before the choice handler, on a cancellation as much as on a choice. A
   * brokered open that skipped `onOpen` would run a plugin's cleanup with no
   * matching setup, and its `onChooseItem` against state that was never built.
   *
   * The promise settles when the choice handler has run, so a plugin that
   * awaits it resumes after its own `onChooseSuggestion`, exactly as it would
   * after Obsidian's dialog closed.
   *
   * It returns a promise where Obsidian's returns `void`, which is a **widening
   * a caller cannot notice**: `void` accepts a promise, an `open()` nobody
   * awaits behaves as it always did, and an `await` — which is what a plugin
   * that wants the answer writes — now means something. See
   * {@link brokerChoice} for the rejection every non-awaiting caller is spared.
   */
  override open(): Promise<void> {
    return brokerChoice(this, "SuggestModal.open", "suggest", {
      values: this.getSuggestions(""),
      label: displayText,
    });
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
  constructor(app: App) {
    super(app);
    recordUse("FuzzySuggestModal");
  }

  /**
   * The same brokerage as {@link SuggestModal.open}, over `getItems()`.
   *
   * `getItems()` rather than `getSuggestions("")`, which is what the base would
   * have called: the fuzzy `getSuggestions` runs every item past
   * `prepareFuzzySearch("")` and keeps only what matched, and an empty query is
   * not a question a scorer has a useful answer to. The unfiltered list, in the
   * plugin's own order, is what a picker shows before anybody types.
   *
   * Each item is wrapped as the {@link FuzzyMatch} the choice path expects, so
   * a subclass that overrode `onChooseSuggestion` rather than `onChooseItem` is
   * still the one that runs.
   */
  override open(): Promise<void> {
    const items = this.getItems();
    return brokerChoice(this, "FuzzySuggestModal.open", "fuzzy_suggest", {
      values: items.map((item) => ({ item, match: { score: 0, matches: [] } })),
      label: (value) => this.getItemText(value.item),
    });
  }

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
 * What a brokered picker is asked about: the choices, and what to call each.
 *
 * `values` may be a promise, because `SuggestModal.getSuggestions` may be — a
 * plugin that searches the vault for its suggestions returns one, and a version
 * of this that only accepted an array would broker a `Promise` object as the
 * single choice.
 */
interface BrokeredChoices<T> {
  readonly values: T[] | Promise<T[]>;
  readonly label: (value: T) => string;
}

/**
 * Ask whoever is attached to pick one of `choices`, and run the modal's own
 * choice path with what came back.
 *
 * **The rejection is handled here whether or not the plugin handles it**, which
 * is the one thing this helper exists for. Most plugins call `modal.open()`
 * without awaiting it — Obsidian's returns `void`, so there was never anything
 * to await — and a timeout or a detach on an ignored promise is a process-level
 * `unhandledRejection` naming nothing. Attaching a handler to the promise this
 * returns marks it handled without consuming it: a plugin that *does* await
 * still sees the rejection on its own path, and one that does not gets the
 * failure attributed in the host's error sink under the `interaction` phase,
 * which is visible and never counts toward a quarantine.
 *
 * Attribution is read **before the first await**. `enterPluginSync` closes its
 * window when the command callback returns, not when its promise settles, so
 * `currentPluginId()` is the asking plugin here and nobody a turn later.
 */
function brokerChoice<T>(
  modal: SuggestModal<T>,
  symbol: string,
  kind: PromptKind,
  choices: BrokeredChoices<T>,
): Promise<void> {
  const pluginId = currentPluginId();
  recordUse(symbol);
  const broker = interactionBrokerFor(modal.app);
  if (broker === null) {
    // **Refused synchronously, before a promise exists.** The one path where
    // there is no broker is a modal built against an `App` this host never
    // assembled — a plugin's own business — and there is no sink to report to
    // either, so a rejected promise here would be a failure nothing records.
    // A throw is the honest shape: it reaches the plugin's own `catch`, or the
    // command path, which does record it.
    throw new InteractionUnavailable(
      `${modal.constructor.name} was built against an App this host never assembled, so there ` +
        "is no channel to ask a human through",
    );
  }
  const settled = askAndChoose(modal, kind, pluginId, broker, choices);
  // Never a floating rejection. See the note above: this does not consume it.
  void settled.catch((error: unknown) => {
    // **Only the broker's own failures are reported here**, and the narrowing
    // is the point rather than a tidy-up. `askAndChoose` runs two pieces of
    // plugin code — an `async getSuggestions()` and the choice handler behind
    // `selectSuggestion` — and a throw from either is the plugin failing, which
    // must reach the counting path like any other handler failure. Reporting
    // those under the uncounted `interaction` phase would have been a hole in
    // the quarantine: a plugin whose `onChooseItem` throws every time could
    // never be quarantined for it.
    if (error instanceof InteractionUnavailable || error instanceof InteractionTimeout) {
      broker.reportUnobserved(error, pluginId);
      return;
    }
    // The plugin's own failure, with nobody awaiting it. Same phase and same
    // sink an unawaited command callback's rejection takes, so it counts.
    broker.reportHandlerFailure(error, pluginId);
  });
  return settled;
}

async function askAndChoose<T>(
  modal: SuggestModal<T>,
  kind: PromptKind,
  pluginId: string | null,
  broker: InteractionBroker,
  choices: BrokeredChoices<T>,
): Promise<void> {
  // **`onOpen()` before the question, which is Obsidian's order.** Its
  // `Modal.open()` shows the modal and calls `onOpen`, and a suggester subclass
  // that sets state there and reads it in `onChooseItem` is an ordinary shape —
  // so a brokered open that skipped it would run the plugin's `onClose` with no
  // matching setup, and its choice handler against state that was never built.
  modal.onOpen();
  const values = await choices.values;
  const answer = await broker.ask({
    pluginId: pluginId ?? HOST_PLUGIN_ID,
    kind,
    prompt: promptTextOf(modal),
    items: values.map((value) => choices.label(value)),
  });
  // Cancelled, or answered with no choice at all: the modal closes, `onClose`
  // runs, and no choice handler is called — which is exactly what pressing
  // escape does in Obsidian, and what a plugin's own cleanup expects.
  const index = answer.cancelled === true ? undefined : answer.choiceIndex;
  const chosen = index === undefined ? undefined : values[index];
  // Closed **before** the handler, which is Obsidian's own order: its
  // `selectSuggestion` closes and then chooses, and a plugin whose handler
  // opens a second modal relies on the first one being gone.
  modal.close();
  if (chosen === undefined) return;
  modal.selectSuggestion(chosen, null);
}

/**
 * What to show above the choices.
 *
 * The title if the plugin set one, the placeholder if it set that instead, and
 * the subclass's name when it set neither — because "a picker was opened" is
 * useless to whoever has to answer it and "QuickAdd's ChoiceSuggester" is not.
 */
function promptTextOf(modal: SuggestModal<unknown>): string {
  const title = modal.titleEl.textContent;
  if (title !== "") return title;
  const placeholder = modal.inputEl.getAttr("placeholder");
  if (placeholder !== null && placeholder !== "") return placeholder;
  return modal.constructor.name;
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
// `implemented`, not `absent`, since Task 18: the showing half is brokered to
// whoever is attached and the plugin's own choice handler really runs. Only
// `Modal.open` — a bespoke `onOpen()` UI nothing can intercept — stays absent.
declarePolicy("SuggestModal.open", "implemented");
declarePolicy("FuzzySuggestModal.open", "implemented");
declarePolicy("PopoverSuggest.open", "safe_stub");
declarePolicy("PopoverSuggest.close", "safe_stub");
