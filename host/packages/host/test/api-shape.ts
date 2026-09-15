/**
 * What kind of thing each barrel row is, and how to prove it.
 *
 * **This file is the answer to "a wrong policy row ships green".** The policy
 * table says what a symbol *is*; nothing in the table says what a plugin can
 * *do* with the value, and those are different claims: flipping `Modal` from
 * `safe_stub` to `absent` leaves a name that is still a function, still throws
 * a typed error when called, and still passes every completeness assertion —
 * while turning the class six of the eight golden bundles extend into something
 * a plugin cannot construct. The buckets below carry the missing half. Each row
 * lands in exactly one of them, `api-policy.test.ts` asserts that the buckets
 * cover the table exactly, and a row that changes policy has to change bucket
 * too — which is a visible, reviewable diff rather than a silent regression.
 *
 * Kept beside the tests rather than in `src/` because it is test data: it names
 * arguments, live instances and reasons, none of which the host needs at
 * runtime.
 */

import { StubEl } from "../src/shim/dom";
import type { ObsidianApi } from "../src/shim/api";
import type { ShimHarness } from "../src/testing/shim-harness";

/** What a bucket entry is handed to build its arguments. */
export interface ShapeContext {
  readonly harness: ShimHarness;
  readonly api: ObsidianApi;
  /** A loaded plugin of this host, for the rows that need one. */
  readonly plugin: unknown;
  /** A detached element, for the component rows. */
  readonly containerEl: StubEl;
}

/**
 * Classes a plugin constructs, with the arguments Obsidian's own signature
 * takes.
 *
 * Construction is the assertion: `implemented` and `safe_stub` both promise a
 * plugin can *get one*, and the failure this catches — a class that has become
 * a refusal — shows up nowhere else.
 */
export const CONSTRUCTED: Record<string, (ctx: ShapeContext) => unknown[]> = {
  Plugin: (ctx) => [ctx.harness.app, ctx.harness.manifestFor("shape-probe")],
  Component: () => [],
  Events: (ctx) => [ctx.harness.bus],
  Notice: () => ["shape probe"],
  Menu: () => [],
  MenuItem: () => [],
  Modal: (ctx) => [ctx.harness.app],
  SuggestModal: (ctx) => [ctx.harness.app],
  FuzzySuggestModal: (ctx) => [ctx.harness.app],
  PopoverSuggest: (ctx) => [ctx.harness.app],
  AbstractInputSuggest: (ctx) => [ctx.harness.app, new StubEl("input")],
  EditorSuggest: (ctx) => [ctx.harness.app],
  SettingTab: (ctx) => [ctx.harness.app],
  PluginSettingTab: (ctx) => [ctx.harness.app, ctx.plugin],
  Setting: (ctx) => [ctx.containerEl],
  BaseComponent: () => [],
  ValueComponent: () => [],
  AbstractTextComponent: () => [new StubEl("input")],
  ButtonComponent: (ctx) => [ctx.containerEl],
  ExtraButtonComponent: (ctx) => [ctx.containerEl],
  TextComponent: (ctx) => [ctx.containerEl],
  TextAreaComponent: (ctx) => [ctx.containerEl],
  SearchComponent: (ctx) => [ctx.containerEl],
  DropdownComponent: (ctx) => [ctx.containerEl],
  ToggleComponent: (ctx) => [ctx.containerEl],
  SliderComponent: (ctx) => [ctx.containerEl],
  ColorComponent: (ctx) => [ctx.containerEl],
  SecretComponent: (ctx) => [ctx.containerEl],
  MomentFormatComponent: (ctx) => [ctx.containerEl],
  ProgressBarComponent: (ctx) => [ctx.containerEl],
  DisplayValueComponent: (ctx) => [ctx.containerEl],
  MarkdownRenderChild: (ctx) => [ctx.containerEl],
  Scope: () => [],
  Keymap: () => [],
  Editor: () => [],
  View: () => [],
  ItemView: () => [],
  FileView: () => [],
  EditableFileView: () => [],
  MarkdownView: () => [],
  WorkspaceLeaf: (ctx) => [ctx.harness.app.workspace],
};

/**
 * Classes the host builds for itself, proved by the live instance.
 *
 * Constructing a second `Vault` would mean handing a test the wiring the
 * assembler owns, and the claim that matters is stronger anyway: the object a
 * plugin is handed really is an instance of the class the barrel exports. A
 * barrel that exported some *other* `Vault` would pass a construction check and
 * fail this one.
 */
export const LIVE: Record<string, (ctx: ShapeContext) => unknown> = {
  App: (ctx) => ctx.harness.app,
  Vault: (ctx) => ctx.harness.app.vault,
  MetadataCache: (ctx) => ctx.harness.app.metadataCache,
  FileManager: (ctx) => ctx.harness.app.fileManager,
  Workspace: (ctx) => ctx.harness.app.workspace,
  TFile: (ctx) => ctx.harness.vault.getAbstractFileByPath("Folder/A.md"),
  TFolder: (ctx) => ctx.harness.vault.getAbstractFileByPath("Folder"),
  TAbstractFile: (ctx) => ctx.harness.vault.getAbstractFileByPath("Folder/A.md"),
};

/**
 * The one class this host deliberately never instantiates, with its reason.
 *
 * `FileSystemAdapter`'s constructor takes the vault's own dependency object,
 * and the whole point of the row is that nothing ever builds one: quickadd asks
 * `adapter instanceof FileSystemAdapter` and must be told **no**, because a
 * `yes` sends it down a path that writes to the file system behind the daemon.
 * So what is asserted is what a plugin actually does with the name — extend it,
 * test against it — and never that a construction succeeds.
 *
 * **It must stay at exactly one member, and that is a rule rather than an
 * observation.** This list is the shape guard's own exemption: a row named here
 * is a row nothing constructs, which is precisely where a wrong binding would
 * hide from the check built to catch it. A second entry means either a class
 * whose constructor is awkward to call from a test — in which case the fix is
 * arguments in {@link CONSTRUCTED} or an instance in {@link LIVE}, both of which
 * assert more — or a surface nobody can build, which is a policy question and
 * not an exemption. Growing this list is how the guard quietly stops guarding.
 */
export const NOT_CONSTRUCTED: Record<string, string> = {
  FileSystemAdapter:
    "its constructor takes the vault's private deps, and nothing may ever instantiate one",
};

/**
 * Functions a plugin calls, with arguments that exercise them.
 *
 * A call that throws {@link HeadlessUnsupported} fails the case: `implemented`
 * and `safe_stub` both promise the call goes through. Any other throw is
 * tolerated — these are real functions with real argument validation, and this
 * file is not where their behaviour is pinned.
 */
export const CALLED: Record<string, (ctx: ShapeContext) => unknown[]> = {
  moment: () => [],
  normalizePath: () => ["a//b"],
  getLinkpath: () => ["Note#Heading"],
  parseLinktext: () => ["Note#Heading"],
  stripHeading: () => ["A #heading"],
  stripHeadingForLink: () => ["A #heading"],
  resolveSubpath: () => [{ headings: [] }, "#none"],
  parseYaml: () => ["a: 1\n"],
  stringifyYaml: () => [{ a: 1 }],
  getFrontMatterInfo: () => ["---\na: 1\n---\nbody\n"],
  parseFrontMatterEntry: () => [{ a: 1 }, "a"],
  parseFrontMatterStringArray: () => [{ a: ["x"] }, "a"],
  parseFrontMatterAliases: () => [{ aliases: ["x"] }],
  parseFrontMatterTags: () => [{ tags: ["x"] }],
  getAllTags: () => [null],
  iterateCacheRefs: () => [{}, () => false],
  iterateRefs: () => [[], () => false],
  prepareFuzzySearch: () => ["ab"],
  prepareSimpleSearch: () => ["ab"],
  sortSearchResults: () => [[]],
  requestUrl: () => ["https://example.invalid/"],
  request: () => ["https://example.invalid/"],
  arrayBufferToBase64: () => [new ArrayBuffer(2)],
  base64ToArrayBuffer: () => ["AAA="],
  arrayBufferToHex: () => [new ArrayBuffer(2)],
  hexToArrayBuffer: () => ["0000"],
  getBlobArrayBuffer: () => [new Blob(["x"])],
  requireApiVersion: () => ["1.0.0"],
  debounce: () => [(): void => undefined, 0],
  getLanguage: () => [],
  setIcon: () => [new StubEl("div"), "star"],
  addIcon: () => ["shape-probe-icon", "<svg/>"],
  removeIcon: () => ["shape-probe-icon"],
  getIcon: () => ["star"],
  getIconIds: () => [],
  setTooltip: () => [new StubEl("div"), "tip"],
  displayTooltip: () => [new StubEl("div"), "tip"],
  renderResults: () => [new StubEl("div"), "text", { score: 0, matches: [] }],
  renderMatches: () => [new StubEl("div"), "text", []],
  sanitizeHTMLToDom: () => ["<b>x</b>"],
};

/** Rows that are neither class nor function: a constant a plugin reads. */
export const VALUES: readonly string[] = ["Platform", "apiVersion"];
