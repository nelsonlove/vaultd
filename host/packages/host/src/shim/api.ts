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
 * **Which names get a row: the module's published value exports, all of them.**
 * The list is the `obsidian` package's own typings — published documentation,
 * never the application bundle — and every value it exports (158 of them at
 * 1.13.1) carries a row here. A name with no row would resolve to `undefined`
 * at require time with no diagnostic, so the default for a surface this host
 * does not provide is `absent`, which refuses by name. The counterpart holds
 * too: a name Obsidian's module does **not** export gets no row, however
 * reachable it is here — `window`, `createDiv`, `HTMLElement` and the rest are
 * *globals*, they are declared in {@link GLOBAL_ONLY_SYMBOLS}, and exporting
 * them would put a surface in the compatibility report that no capture and no
 * documentation supports.
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
import { FileSystemAdapter } from "./adapter";
import { Events, Menu, MenuItem } from "./events";
import { FileManager } from "./file-manager";
import { MetadataCache } from "./metadata-cache";
import {
  addIcon,
  displayTooltip,
  getIcon,
  getIconIds,
  removeIcon,
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
  AbstractTextComponent,
  BaseComponent,
  ButtonComponent,
  ColorComponent,
  DisplayValueComponent,
  DropdownComponent,
  Editor,
  EditorSuggest,
  ExtraButtonComponent,
  FuzzySuggestModal,
  Keymap,
  MarkdownRenderChild,
  Modal,
  MomentFormatComponent,
  PluginSettingTab,
  PopoverSuggest,
  ProgressBarComponent,
  Scope,
  SearchComponent,
  SecretComponent,
  Setting,
  SettingTab,
  SliderComponent,
  SuggestModal,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
  ValueComponent,
} from "./components";
import {
  Platform,
  arrayBufferToBase64,
  arrayBufferToHex,
  atLeastVersion,
  base64ToArrayBuffer,
  createDebounce,
  createHttp,
  getAllTags,
  getBlobArrayBuffer,
  getFrontMatterInfo,
  getLanguage,
  getLinkpath,
  hexToArrayBuffer,
  iterateCacheRefs,
  iterateRefs,
  normalizePath,
  parseFrontMatterAliases,
  parseFrontMatterEntry,
  parseFrontMatterStringArray,
  parseFrontMatterTags,
  parseLinktext,
  parseYaml,
  resolveSubpath,
  stringifyYaml,
  stripHeading,
  stripHeadingForLink,
} from "./helpers";
import { noticeClassFor } from "./notice";
import {
  prepareFuzzySearch,
  prepareSimpleSearch,
  renderMatches,
  renderResults,
  sortSearchResults,
} from "./search";
import { declarePolicy, declaredSymbols, policyOf, unsupported } from "./policy";
import type { ApiPolicy } from "./policy";
import type { HostAssembly } from "../testing/assemble";
import type { HostWindow } from "./globals";
import type { HttpBindings } from "./helpers";
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
  App: "implemented", Plugin: "implemented", Component: "implemented",
  Events: "implemented", TFile: "implemented", TFolder: "implemented",
  TAbstractFile: "implemented", Vault: "implemented", MetadataCache: "implemented",
  FileManager: "implemented", Workspace: "implemented", Notice: "implemented",
  Menu: "implemented", MenuItem: "implemented", SuggestModal: "implemented",
  FuzzySuggestModal: "implemented", Platform: "implemented", moment: "implemented",
  apiVersion: "implemented", requireApiVersion: "implemented", getLanguage: "implemented",
  debounce: "implemented", normalizePath: "implemented", getLinkpath: "implemented",
  parseLinktext: "implemented", stripHeading: "implemented",
  stripHeadingForLink: "implemented", resolveSubpath: "implemented",
  parseYaml: "implemented", stringifyYaml: "implemented",
  getFrontMatterInfo: "implemented", parseFrontMatterEntry: "implemented",
  parseFrontMatterStringArray: "implemented", parseFrontMatterAliases: "implemented",
  parseFrontMatterTags: "implemented", getAllTags: "implemented",
  iterateCacheRefs: "implemented", iterateRefs: "implemented",
  prepareFuzzySearch: "implemented", prepareSimpleSearch: "implemented",
  sortSearchResults: "implemented", requestUrl: "implemented", request: "implemented",
  arrayBufferToBase64: "implemented", base64ToArrayBuffer: "implemented",
  arrayBufferToHex: "implemented", hexToArrayBuffer: "implemented",
  getBlobArrayBuffer: "implemented",

  // ---- harvested: recorded as a capability, never rendered ----
  PluginSettingTab: "harvested", Setting: "harvested",

  // ---- safe_stub: inert value or no-op, recorded once per plugin+symbol ----
  WorkspaceLeaf: "safe_stub", View: "safe_stub", ItemView: "safe_stub",
  FileView: "safe_stub", EditableFileView: "safe_stub", MarkdownView: "safe_stub",
  FileSystemAdapter: "safe_stub", MarkdownRenderChild: "safe_stub", Scope: "safe_stub",
  Keymap: "safe_stub", Editor: "safe_stub", EditorSuggest: "safe_stub",
  AbstractInputSuggest: "safe_stub", PopoverSuggest: "safe_stub", Modal: "safe_stub",
  SettingTab: "safe_stub", BaseComponent: "safe_stub", ValueComponent: "safe_stub",
  AbstractTextComponent: "safe_stub", ButtonComponent: "safe_stub",
  ExtraButtonComponent: "safe_stub", TextComponent: "safe_stub",
  TextAreaComponent: "safe_stub", SearchComponent: "safe_stub",
  DropdownComponent: "safe_stub", ToggleComponent: "safe_stub",
  SliderComponent: "safe_stub", ColorComponent: "safe_stub", SecretComponent: "safe_stub",
  MomentFormatComponent: "safe_stub", ProgressBarComponent: "safe_stub",
  DisplayValueComponent: "safe_stub", setIcon: "safe_stub", addIcon: "safe_stub",
  removeIcon: "safe_stub", getIcon: "safe_stub", getIconIds: "safe_stub",
  setTooltip: "safe_stub", displayTooltip: "safe_stub", renderResults: "safe_stub",
  renderMatches: "safe_stub", sanitizeHTMLToDom: "safe_stub",

  // ---- absent: throws typed HeadlessUnsupported, by exact name ----
  BasesEntry: "absent", BasesEntryGroup: "absent", BasesQueryResult: "absent",
  BasesView: "absent", BasesViewConfig: "absent", BooleanValue: "absent",
  CapacitorAdapter: "absent", ConfirmationButton: "absent", ConfirmationModal: "absent",
  DateValue: "absent", DurationValue: "absent", FileValue: "absent", HTMLValue: "absent",
  HoverPopover: "absent", IconValue: "absent", ImageValue: "absent", LinkValue: "absent",
  ListValue: "absent", MarkdownEditView: "absent", MarkdownPreviewRenderer: "absent",
  MarkdownPreviewView: "absent", MarkdownRenderer: "absent", MenuSeparator: "absent",
  NotNullValue: "absent", NullValue: "absent", NumberValue: "absent",
  ObjectValue: "absent", PopoverState: "absent", PrimitiveValue: "absent",
  QueryController: "absent", RegExpValue: "absent", RelativeDateValue: "absent",
  RenderContext: "absent", SecretStorage: "absent", SettingGroup: "absent",
  SettingPage: "absent", StringValue: "absent", TagValue: "absent", Tasks: "absent",
  TextFileView: "absent", UrlValue: "absent", Value: "absent",
  WorkspaceContainer: "absent", WorkspaceFloating: "absent", WorkspaceItem: "absent",
  WorkspaceMobileDrawer: "absent", WorkspaceParent: "absent", WorkspaceRibbon: "absent",
  WorkspaceRoot: "absent", WorkspaceSidedock: "absent", WorkspaceSplit: "absent",
  WorkspaceTabs: "absent", WorkspaceWindow: "absent", editorEditorField: "absent",
  editorInfoField: "absent", editorLivePreviewField: "absent", editorViewField: "absent",
  finishRenderMath: "absent", htmlToMarkdown: "absent", livePreviewState: "absent",
  loadMathJax: "absent", loadMermaid: "absent", loadPdfJs: "absent", loadPrism: "absent",
  parsePropertyId: "absent", renderMath: "absent",
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
  "window",
  "activeWindow",
  "activeDocument",
  "localStorage",
  "navigator",
  "i18next",
  "MutationObserver",
  "Element",
  "Node",
  "HTMLElement",
  "DocumentFragment",
  "createEl",
  "createDiv",
  "createSpan",
  "createFragment",
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
  readonly parseLinktext: typeof parseLinktext;
  readonly stripHeading: typeof stripHeading;
  readonly stripHeadingForLink: typeof stripHeadingForLink;
  readonly iterateCacheRefs: typeof iterateCacheRefs;
  readonly iterateRefs: typeof iterateRefs;
  readonly arrayBufferToBase64: typeof arrayBufferToBase64;
  readonly base64ToArrayBuffer: typeof base64ToArrayBuffer;
  readonly arrayBufferToHex: typeof arrayBufferToHex;
  readonly hexToArrayBuffer: typeof hexToArrayBuffer;
  readonly getBlobArrayBuffer: typeof getBlobArrayBuffer;
  readonly resolveSubpath: typeof resolveSubpath;
  readonly requestUrl: HttpBindings["requestUrl"];
  readonly request: HttpBindings["request"];
  readonly getLanguage: typeof getLanguage;
  readonly prepareFuzzySearch: typeof prepareFuzzySearch;
  readonly prepareSimpleSearch: typeof prepareSimpleSearch;
  readonly sortSearchResults: typeof sortSearchResults;
  readonly renderResults: typeof renderResults;
  readonly renderMatches: typeof renderMatches;
  readonly SettingTab: typeof SettingTab;
  readonly BaseComponent: typeof BaseComponent;
  readonly AbstractTextComponent: typeof AbstractTextComponent;
  readonly PopoverSuggest: typeof PopoverSuggest;
  readonly MomentFormatComponent: typeof MomentFormatComponent;
  readonly ProgressBarComponent: typeof ProgressBarComponent;
  readonly DisplayValueComponent: typeof DisplayValueComponent;
  readonly removeIcon: typeof removeIcon;
  readonly displayTooltip: typeof displayTooltip;
  readonly Platform: typeof Platform;
  readonly debounce: ReturnType<typeof createDebounce>;
  readonly apiVersion: string;
  readonly requireApiVersion: (version: string) => boolean;
  readonly moment: HostWindow["moment"];
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
  const bound: Record<string, unknown> = {};
  for (const [symbol, policy] of Object.entries(API_POLICY)) {
    if (policy === "absent") {
      bound[symbol] = absentBinding(symbol);
      continue;
    }
    const source = policy === "safe_stub" ? SAFE_STUBS : real;
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
    parseLinktext,
    stripHeading,
    stripHeadingForLink,
    iterateCacheRefs,
    iterateRefs,
    arrayBufferToBase64,
    base64ToArrayBuffer,
    arrayBufferToHex,
    hexToArrayBuffer,
    getBlobArrayBuffer,
    resolveSubpath,
    getLanguage,
    prepareFuzzySearch,
    prepareSimpleSearch,
    sortSearchResults,
    // Bound to this host's network policy: a harness refuses before a socket is
    // opened, production forwards. The policy row stays `implemented` either
    // way — this host *can* reach the network; this run may not.
    ...createHttp(config),
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
 * The `safe_stub` bindings: inert values real enough to be held, chained and
 * `instanceof`-tested.
 *
 * Module-level, because none of them depends on the host — a class that answers
 * `instanceof` is the same class for every host in the process, and a stub
 * function that records a hit reaches the recorder through the policy module's
 * own installed one. The globals that *are* per host — `window`,
 * `activeDocument`, the element builders — are not exports of Obsidian's module
 * and are no longer exports of this one either; see {@link GLOBAL_ONLY_SYMBOLS}.
 */
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
  MomentFormatComponent,
  ProgressBarComponent,
  DisplayValueComponent,
  SettingTab,
  BaseComponent,
  AbstractTextComponent,
  PopoverSuggest,
  setIcon,
  addIcon,
  removeIcon,
  setTooltip,
  displayTooltip,
  getIcon,
  getIconIds,
  renderResults,
  renderMatches,
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
  // A **function declaration**, not an arrow, and the difference is
  // load-bearing: more than half of the absent rows are published *classes*,
  // and `class X extends (an arrow function) {}` is a `TypeError` thrown while
  // the bundle is still evaluating — before the plugin has run a line, and with
  // a message naming nothing. A plain function is a constructor, so the class
  // definition succeeds and the refusal lands where the plugin actually reaches
  // for the thing: at `new X()`, or at the call, naming the symbol either way.
  function refuse(): never {
    return unsupported(symbol);
  }
  Object.defineProperty(refuse, "name", { value: symbol });
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
 * Declare a table, and never declare a symbol twice.
 *
 * A module that already declared a row keeps it: `dom.ts` says what `setIcon`
 * is, `workspace.ts` says what `MarkdownView` is, and those files carry the
 * reasoning for their own surfaces. The table has to **agree** with them, and a
 * disagreement throws rather than becoming a compatibility report that
 * contradicts itself.
 *
 * Exported so the guard itself can be tested. `declarePolicy` is
 * last-write-wins, so a second declaration of the same symbol is invisible at
 * runtime and an assertion about it can only be decorative; the real property
 * is *this throw*, and a case that hands this function a contradicting table is
 * a real test of it.
 *
 * @param table the rows to declare
 * @param alreadyDeclared what the modules declared before this table was seen
 */
export function declareTable(
  table: Readonly<Record<string, ApiPolicy>>,
  alreadyDeclared: ReadonlySet<string>,
): void {
  for (const [symbol, policy] of Object.entries(table)) {
    if (!alreadyDeclared.has(symbol)) {
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
}

// At module scope, so importing the barrel is all it takes for the whole
// surface to appear in the report — with nothing constructed and no vault open.
declareTable(API_POLICY, new Set(declaredSymbols()));

// The members of the two absent surfaces that are reached through a static
// rather than by calling the export itself.
declarePolicy("MarkdownRenderer.render", "absent");
declarePolicy("MarkdownRenderer.renderMarkdown", "absent");
