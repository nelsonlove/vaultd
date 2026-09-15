/**
 * The `obsidian` module, as a plugin bundle resolves it — and the table that
 * says what every name in it is.
 *
 * **The table is data, not prose.** An earlier draft of this phase listed
 * ninety-odd names in a design document and tested none of them, which is
 * exactly how a symbol ends up exported as `undefined`: the plugin destructures
 * it, nothing complains, and three frames later it dies with a message naming
 * neither the symbol nor the host. {@link API_POLICY} is the list, every entry
 * carries one of four policies, and `test/api-policy.test.ts` asserts in both
 * directions — an export with no policy is an undeclared surface, a policy with
 * no export is a name that resolves to `undefined` at require time.
 *
 * **The four policies, and what each one promises.**
 *
 * - `implemented` — the host really does it. A plugin cannot tell the
 *   difference, except where this file's own comments say it can.
 * - `harvested` — the call is recorded as a capability and answered rather than
 *   performed, because there is no GUI to perform it in. Something outside the
 *   process can act on the record.
 * - `safe_stub` — an inert value that lets the plugin keep going, recorded once
 *   per plugin and symbol so the compatibility report can say who leaned on it.
 * - `absent` — a typed {@link HeadlessUnsupported}, thrown with the symbol in
 *   the message. Reserved for the surfaces where a stub would give a *wrong*
 *   answer rather than an empty one.
 *
 * **Three placements carry a reason, because a reviewer will ask.**
 *
 * `Modal` is `safe_stub`, not `absent`: constructing one and building its
 * `contentEl` is ordinary `onload`-time work, and only `open()` throws. In the
 * absent group it would kill a plugin at construction, before the half that
 * works ever ran. Task 18 owns what happens to that throw.
 *
 * `EditableFileView` and `FileSystemAdapter` are `safe_stub` **real
 * constructors that are never instantiated**. folder-notes does `leaf.view
 * instanceof EditableFileView` and quickadd does `adapter instanceof
 * FileSystemAdapter`; both need the name to exist and both need the test to be
 * **false** — a `true` from `FileSystemAdapter` sends quickadd down a
 * `getBasePath()`-then-direct-write path that would put bytes in the vault
 * behind the daemon's back.
 *
 * `MarkdownRenderer` and the four `load*` helpers are `absent` rather than
 * stubbed because a plugin that renders markdown into a node and reads the
 * result back gets a wrong answer from a stub and a diagnosable error from a
 * throw. They are the clearest "this genuinely does not exist headless" cases
 * in the corpus.
 *
 * **What this file does not declare.** The shim modules declare their own
 * **member** rows at module scope — `MetadataCache.getFileCache`,
 * `Menu.showAtPosition`, `Workspace.openLinkText`, `window.addEventListener`
 * and the rest — and none of those is a barrel export. {@link API_POLICY} holds
 * top-level export symbols only; the dotted rows stay with the modules that own
 * them and reach the compatibility report through `declaredSymbols()`. The walk
 * below declares only the symbols no module has declared yet, so no symbol is
 * ever declared twice and a module's own reasoning about its rows is never
 * silently overwritten by the table.
 */

import { App } from "./app";
import { Component, Plugin } from "./plugin";
import { DataAdapter, FileSystemAdapter } from "./adapter";
import { Events, Menu, MenuItem } from "./events";
import { FileManager } from "./file-manager";
import { MetadataCache } from "./metadata-cache";
import {
  StubEl,
  StubFragment,
  addIcon,
  createDiv,
  createEl,
  createFragment,
  createSpan,
  getIcon,
  getIconIds,
  sanitizeHTMLToDom,
  setIcon,
  setTooltip,
} from "./dom";
import { TAbstractFile, TFile, TFolder } from "./files";
import { Vault } from "./vault";
import {
  EditableFileView,
  FileView,
  ItemView,
  MarkdownView,
  View,
  Workspace,
  WorkspaceLeaf,
} from "./workspace";
import {
  AbstractInputSuggest,
  ButtonComponent,
  ColorComponent,
  DropdownComponent,
  Editor,
  EditorSuggest,
  ExtraButtonComponent,
  FuzzySuggestModal,
  Keymap,
  MarkdownRenderChild,
  Modal,
  PluginSettingTab,
  Scope,
  SearchComponent,
  SecretComponent,
  Setting,
  SliderComponent,
  SuggestModal,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
  ValueComponent,
  hexToRgbValue,
  rgbToHexValue,
} from "./components";
import {
  Platform,
  atLeastVersion,
  createDebounce,
  getAllTags,
  getFrontMatterInfo,
  getLanguage,
  getLinkpath,
  normalizePath,
  parseFrontMatterAliases,
  parseFrontMatterEntry,
  parseFrontMatterStringArray,
  parseFrontMatterTags,
  parseYaml,
  request,
  requestUrl,
  resolveSubpath,
  stringifyYaml,
} from "./helpers";
import { noticeClassFor } from "./notice";
import {
  fuzzySearch,
  prepareFuzzySearch,
  prepareSimpleSearch,
  renderResults,
  sortSearchResults,
} from "./search";
import { declarePolicy, declaredSymbols, policyOf, unsupported } from "./policy";
import type { ApiPolicy } from "./policy";
import type { HostAssembly } from "../testing/assemble";
import type { HostWindow } from "./globals";
import type { Notice } from "./notice";
import type { StubDocument } from "./dom";

/**
 * `window` and `document`, as a plugin uses them.
 *
 * **Aliases since Task 11a**, and that is the point: the `window` a plugin
 * reaches through the `obsidian` module and the `window` it reaches as a bare
 * global have to be the same object, or a plugin that arms an interval through
 * one and clears it through the other would leak a timer the host cannot see.
 * The names stay because Task 10's surfaces are typed with them.
 */
export type ShimWindow = HostWindow;
export type ShimDocument = StubDocument;

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const API_POLICY: Readonly<Record<string, ApiPolicy>> = {
  // ---- implemented: real behaviour ----
  App: "implemented",
  Plugin: "implemented",
  Component: "implemented",
  Events: "implemented",
  TFile: "implemented",
  TFolder: "implemented",
  TAbstractFile: "implemented",
  Vault: "implemented",
  DataAdapter: "implemented",
  MetadataCache: "implemented",
  FileManager: "implemented",
  Workspace: "implemented",
  Notice: "implemented",
  Menu: "implemented",
  MenuItem: "implemented",
  SuggestModal: "implemented",
  FuzzySuggestModal: "implemented",
  Platform: "implemented",
  moment: "implemented",
  normalizePath: "implemented",
  parseYaml: "implemented",
  stringifyYaml: "implemented",
  parseFrontMatterAliases: "implemented",
  parseFrontMatterTags: "implemented",
  parseFrontMatterEntry: "implemented",
  parseFrontMatterStringArray: "implemented",
  getFrontMatterInfo: "implemented",
  getAllTags: "implemented",
  getLinkpath: "implemented",
  resolveSubpath: "implemented",
  requestUrl: "implemented",
  request: "implemented",
  requireApiVersion: "implemented",
  apiVersion: "implemented",
  getLanguage: "implemented",
  debounce: "implemented",
  prepareFuzzySearch: "implemented",
  prepareSimpleSearch: "implemented",
  fuzzySearch: "implemented",
  sortSearchResults: "implemented",
  hexToRgb: "implemented",
  rgbToHex: "implemented",

  // ---- harvested: recorded as a capability, never rendered ----
  PluginSettingTab: "harvested",
  Setting: "harvested",

  // ---- safe_stub: inert value or no-op, recorded once per plugin+symbol ----
  WorkspaceLeaf: "safe_stub",
  View: "safe_stub",
  ItemView: "safe_stub",
  FileView: "safe_stub",
  EditableFileView: "safe_stub",
  MarkdownView: "safe_stub",
  FileSystemAdapter: "safe_stub",
  MarkdownRenderChild: "safe_stub",
  Scope: "safe_stub",
  Keymap: "safe_stub",
  Editor: "safe_stub",
  EditorSuggest: "safe_stub",
  AbstractInputSuggest: "safe_stub",
  Modal: "safe_stub",
  ValueComponent: "safe_stub",
  ButtonComponent: "safe_stub",
  TextComponent: "safe_stub",
  TextAreaComponent: "safe_stub",
  DropdownComponent: "safe_stub",
  ToggleComponent: "safe_stub",
  SliderComponent: "safe_stub",
  ExtraButtonComponent: "safe_stub",
  SearchComponent: "safe_stub",
  ColorComponent: "safe_stub",
  SecretComponent: "safe_stub",
  HTMLElement: "safe_stub",
  DocumentFragment: "safe_stub",
  createEl: "safe_stub",
  createDiv: "safe_stub",
  createSpan: "safe_stub",
  createFragment: "safe_stub",
  setIcon: "safe_stub",
  addIcon: "safe_stub",
  setTooltip: "safe_stub",
  getIcon: "safe_stub",
  getIconIds: "safe_stub",
  renderResults: "safe_stub",
  sanitizeHTMLToDom: "safe_stub",
  window: "safe_stub",
  activeWindow: "safe_stub",
  activeDocument: "safe_stub",

  // ---- absent: throws typed HeadlessUnsupported ----
  MarkdownRenderer: "absent",
  htmlToMarkdown: "absent",
  renderMath: "absent",
  finishRenderMath: "absent",
  loadMathJax: "absent",
  loadPrism: "absent",
  loadMermaid: "absent",
};

/**
 * The undotted rows that are **not** barrel exports, and never will be.
 *
 * `globals.ts` and `dom.ts` declare these because a plugin really does reach
 * them — as bare globals, at module scope, before anything is handed to it —
 * but Obsidian's module exports none of them, and exporting them here would put
 * a surface in the compatibility report that no capture supports. The list is
 * named rather than filtered by a heuristic so that a new global row has to be
 * added here deliberately, and `test/api-policy.test.ts` fails until it is.
 */
export const GLOBAL_ONLY_SYMBOLS: readonly string[] = [
  "app",
  "document",
  "localStorage",
  "navigator",
  "i18next",
  "MutationObserver",
  "Element",
  "Node",
];

// ---------------------------------------------------------------------------
// The barrel
// ---------------------------------------------------------------------------

/**
 * The barrel's own type, so the harness and `assembleShim` share one shape.
 *
 * The index signature is what a module object really is — a plugin may read any
 * name off it — and the named members are the ones this host's own code and
 * tests use as types: an index signature alone types every one of them
 * `unknown`, and `class extends (something: unknown)` does not compile.
 */
export interface ObsidianApi {
  readonly App: typeof App;
  readonly Plugin: typeof Plugin;
  readonly Component: typeof Component;
  readonly Events: typeof Events;
  readonly TAbstractFile: typeof TAbstractFile;
  readonly TFile: typeof TFile;
  readonly TFolder: typeof TFolder;
  readonly Vault: typeof Vault;
  readonly DataAdapter: typeof DataAdapter;
  readonly FileSystemAdapter: typeof FileSystemAdapter;
  readonly MetadataCache: typeof MetadataCache;
  readonly FileManager: typeof FileManager;
  readonly Workspace: typeof Workspace;
  readonly WorkspaceLeaf: typeof WorkspaceLeaf;
  readonly View: typeof View;
  readonly ItemView: typeof ItemView;
  readonly FileView: typeof FileView;
  readonly EditableFileView: typeof EditableFileView;
  readonly MarkdownView: typeof MarkdownView;
  readonly Menu: typeof Menu;
  readonly MenuItem: typeof MenuItem;
  readonly Notice: typeof Notice;
  readonly Modal: typeof Modal;
  readonly SuggestModal: typeof SuggestModal;
  readonly FuzzySuggestModal: typeof FuzzySuggestModal;
  readonly AbstractInputSuggest: typeof AbstractInputSuggest;
  readonly EditorSuggest: typeof EditorSuggest;
  readonly Editor: typeof Editor;
  readonly Scope: typeof Scope;
  readonly Keymap: typeof Keymap;
  readonly MarkdownRenderChild: typeof MarkdownRenderChild;
  readonly PluginSettingTab: typeof PluginSettingTab;
  readonly Setting: typeof Setting;
  readonly ValueComponent: typeof ValueComponent;
  readonly ButtonComponent: typeof ButtonComponent;
  readonly ExtraButtonComponent: typeof ExtraButtonComponent;
  readonly TextComponent: typeof TextComponent;
  readonly TextAreaComponent: typeof TextAreaComponent;
  readonly SearchComponent: typeof SearchComponent;
  readonly DropdownComponent: typeof DropdownComponent;
  readonly ToggleComponent: typeof ToggleComponent;
  readonly SliderComponent: typeof SliderComponent;
  readonly ColorComponent: typeof ColorComponent;
  readonly SecretComponent: typeof SecretComponent;
  readonly HTMLElement: typeof StubEl;
  readonly DocumentFragment: typeof StubFragment;
  readonly createEl: typeof createEl;
  readonly createDiv: typeof createDiv;
  readonly createSpan: typeof createSpan;
  readonly createFragment: typeof createFragment;
  readonly setIcon: typeof setIcon;
  readonly addIcon: typeof addIcon;
  readonly getIcon: typeof getIcon;
  readonly getIconIds: typeof getIconIds;
  readonly setTooltip: typeof setTooltip;
  readonly sanitizeHTMLToDom: typeof sanitizeHTMLToDom;
  readonly normalizePath: typeof normalizePath;
  readonly parseYaml: typeof parseYaml;
  readonly stringifyYaml: typeof stringifyYaml;
  readonly parseFrontMatterAliases: typeof parseFrontMatterAliases;
  readonly parseFrontMatterTags: typeof parseFrontMatterTags;
  readonly parseFrontMatterEntry: typeof parseFrontMatterEntry;
  readonly parseFrontMatterStringArray: typeof parseFrontMatterStringArray;
  readonly getFrontMatterInfo: typeof getFrontMatterInfo;
  readonly getAllTags: typeof getAllTags;
  readonly getLinkpath: typeof getLinkpath;
  readonly resolveSubpath: typeof resolveSubpath;
  readonly requestUrl: typeof requestUrl;
  readonly request: typeof request;
  readonly getLanguage: typeof getLanguage;
  readonly hexToRgb: typeof hexToRgbValue;
  readonly rgbToHex: typeof rgbToHexValue;
  readonly prepareFuzzySearch: typeof prepareFuzzySearch;
  readonly prepareSimpleSearch: typeof prepareSimpleSearch;
  readonly fuzzySearch: typeof fuzzySearch;
  readonly sortSearchResults: typeof sortSearchResults;
  readonly renderResults: typeof renderResults;
  readonly Platform: typeof Platform;
  readonly debounce: ReturnType<typeof createDebounce>;
  readonly apiVersion: string;
  readonly requireApiVersion: (version: string) => boolean;
  readonly moment: HostWindow["moment"];
  readonly window: ShimWindow;
  readonly activeWindow: ShimWindow;
  readonly activeDocument: ShimDocument;
  readonly [symbol: string]: unknown;
}

/**
 * Bind one assembled host's `obsidian` module.
 *
 * It takes the assembly rather than nothing because several bindings are
 * per-host: the timer behind `debounce` has to arm on **this** host's clock,
 * `new Notice(...)` has to land in **this** host's log, and `window` has to be
 * the object this host installed. A module-level pair would give every host the
 * last one assembled.
 *
 * The parameter is spelled `Omit<HostAssembly, "api">` so the assembler can
 * call it while building the very object it returns; a full {@link HostAssembly}
 * is assignable to it, so a later caller holding one passes it unchanged.
 */
export function createObsidianApi(assembly: Omit<HostAssembly, "api">): ObsidianApi {
  const real = realBindings(assembly);
  const stubs = stubBindings(assembly);
  const bound: Record<string, unknown> = {};
  for (const [symbol, policy] of Object.entries(API_POLICY)) {
    if (policy === "absent") {
      bound[symbol] = absentBinding(symbol);
      continue;
    }
    const source = policy === "safe_stub" ? stubs : real;
    if (!Object.prototype.hasOwnProperty.call(source, symbol)) {
      // **At assembly time, not at plugin-load time.** A table entry with no
      // binding is a host bug: the symbol would be exported as `undefined` and
      // the first plugin to touch it would fail somewhere else entirely. Stop
      // the host instead, while the stack still names the cause.
      throw new Error(`the obsidian barrel declares ${symbol} (${policy}) and binds nothing to it`);
    }
    bound[symbol] = source[symbol];
  }
  return Object.freeze(bound) as ObsidianApi;
}

/**
 * The `implemented` and `harvested` bindings, which are the real things.
 *
 * Built per host rather than held module-level, for the per-host reasons in
 * {@link createObsidianApi}. Everything that does not depend on the assembly is
 * still written here rather than hoisted, so one table is one place to read.
 */
function realBindings(assembly: Omit<HostAssembly, "api">): Record<string, unknown> {
  const { config, clock, globals, noticeLog } = assembly;
  return {
    App,
    Plugin,
    Component,
    Events,
    TFile,
    TFolder,
    TAbstractFile,
    Vault,
    DataAdapter,
    MetadataCache,
    FileManager,
    Workspace,
    Menu,
    MenuItem,
    SuggestModal,
    FuzzySuggestModal,
    PluginSettingTab,
    Setting,
    Platform,
    normalizePath,
    parseYaml,
    stringifyYaml,
    parseFrontMatterAliases,
    parseFrontMatterTags,
    parseFrontMatterEntry,
    parseFrontMatterStringArray,
    getFrontMatterInfo,
    getAllTags,
    getLinkpath,
    resolveSubpath,
    requestUrl,
    request,
    getLanguage,
    prepareFuzzySearch,
    prepareSimpleSearch,
    fuzzySearch,
    sortSearchResults,
    hexToRgb: hexToRgbValue,
    rgbToHex: rgbToHexValue,
    // `new Notice(...)` records into this host's log, in every mode — dry-run
    // or not. `host.invoke_command` reads that log through `mark()`/`since()`,
    // so a notice a command produced reaches its caller.
    Notice: noticeClassFor(noticeLog),
    // Armed on this host's clock, so a test that advances its own clock sees
    // its own plugin's debounced call fire.
    debounce: createDebounce(clock),
    apiVersion: config.appVersion,
    requireApiVersion: (version: string): boolean => atLeastVersion(config.appVersion, version),
    // The same library the globals install, at the second address plugins read
    // it from: `import { moment } from "obsidian"`. Two of the eight golden
    // bundles take that road and `window.moment` the other, and handing them
    // two different objects would be a bug waiting for a locale change.
    moment: globals.window.moment,
  };
}

/**
 * The `safe_stub` bindings, plus the three that are this host's own objects.
 *
 * Almost none of them depends on the host: a class that answers `instanceof` is
 * the same class for every host in the process, and a stub function that
 * records a hit reaches the recorder through the policy module's own installed
 * one. The exceptions are `window`, `activeWindow` and `activeDocument`, which
 * must be **the very objects this host installed as globals** — a plugin that
 * arms an interval through `window.setInterval` and clears it through the bare
 * global has to be talking to one registry, or the host leaks a timer it cannot
 * count.
 */
function stubBindings(assembly: Omit<HostAssembly, "api">): Record<string, unknown> {
  const { globals } = assembly;
  return {
    ...SAFE_STUBS,
    window: globals.window,
    activeWindow: globals.window,
    activeDocument: globals.document,
  };
}

/** The host-independent half of the stub bindings. */
const SAFE_STUBS: Record<string, unknown> = {
  WorkspaceLeaf,
  View,
  ItemView,
  FileView,
  EditableFileView,
  MarkdownView,
  FileSystemAdapter,
  MarkdownRenderChild,
  Scope,
  Keymap,
  Editor,
  EditorSuggest,
  AbstractInputSuggest,
  Modal,
  ValueComponent,
  ButtonComponent,
  TextComponent,
  TextAreaComponent,
  DropdownComponent,
  ToggleComponent,
  SliderComponent,
  ExtraButtonComponent,
  SearchComponent,
  ColorComponent,
  SecretComponent,
  HTMLElement: StubEl,
  DocumentFragment: StubFragment,
  createEl,
  createDiv,
  createSpan,
  createFragment,
  setIcon,
  addIcon,
  setTooltip,
  getIcon,
  getIconIds,
  renderResults,
  sanitizeHTMLToDom,
};

/**
 * What an `absent` name is: a function that refuses, by name.
 *
 * `MarkdownRenderer` gets its two statics attached because that is how every
 * caller reaches it — `MarkdownRenderer.render(...)`, never `MarkdownRenderer()`
 * — and a bare function would fail with "render is not a function", which names
 * neither the symbol nor the reason. The other six absent names really are
 * called as functions.
 */
function absentBinding(symbol: string): unknown {
  const refuse = (): never => unsupported(symbol);
  if (symbol !== "MarkdownRenderer") return refuse;
  return Object.assign(refuse, {
    render: (): never => unsupported("MarkdownRenderer.render"),
    renderMarkdown: (): never => unsupported("MarkdownRenderer.renderMarkdown"),
  });
}

// ---------------------------------------------------------------------------
// The declarations
// ---------------------------------------------------------------------------

/**
 * Declare the table, at module scope, and never a symbol twice.
 *
 * A module that already declared a row keeps it: `dom.ts` says what `setIcon`
 * is, `workspace.ts` says what `MarkdownView` is, and those files carry the
 * reasoning for their own surfaces. The table has to **agree** with them, and a
 * disagreement stops the host here rather than becoming a compatibility report
 * that contradicts itself — this runs at import, so the failure lands before
 * any plugin is loaded and names both policies.
 */
/** What the imports above declared, before this file adds anything. */
const declaredByModules = new Set(declaredSymbols());

for (const [symbol, policy] of Object.entries(API_POLICY)) {
  if (!declaredByModules.has(symbol)) {
    declarePolicy(symbol, policy);
    continue;
  }
  const declared = policyOf(symbol);
  if (declared !== policy) {
    throw new Error(
      `the obsidian barrel says ${symbol} is ${policy}, and its own module already declared it ${declared}`,
    );
  }
}

// The members of the two absent surfaces that are reached through a static
// rather than by calling the export itself.
declarePolicy("MarkdownRenderer.render", "absent");
declarePolicy("MarkdownRenderer.renderMarkdown", "absent");
