import { describe, expect, it } from "vitest";

import { API_POLICY } from "../src/shim/api";
import { HeadlessUnsupported, policyOf } from "../src/shim/policy";
import { NetworkRefused, request, requestUrl } from "../src/shim/helpers";
import { ShimHarness } from "../src/testing/shim-harness";
import type { SearchResult } from "../src/shim/search";

/**
 * The barrel's `implemented` symbols doing what they claim — and the exact list
 * of names the module publishes.
 *
 * `api-policy.test.ts` proves every name resolves to a value of the right shape;
 * it cannot prove the implemented ones work, and a helper that resolves to a
 * function returning the wrong answer is worse than one that resolves to
 * `undefined` — the first silently corrupts a note, the second fails loudly. So
 * each case here is a surface where being wrong would be expensive: paths handed
 * to the daemon, YAML written back into frontmatter, the tags a plugin indexes
 * on, the notices a caller reads out of an invoke response, and the network a
 * test run must never reach.
 */

/**
 * Every name the `obsidian` module publishes, sorted — written out rather than
 * derived.
 *
 * **This is the one assertion the table cannot make about itself.** Every other
 * check here compares `API_POLICY` with the barrel built from it, so a row
 * deleted by a careless merge deletes the export with it and every consistency
 * check still passes — while `new Setting(...)` dies in every settings tab in
 * the corpus. A literal list makes an addition and a removal equally visible:
 * both become a diff a reviewer reads, which is what a compatibility contract
 * should be.
 *
 * The list is the value exports of the **published** `obsidian` typings
 * (1.13.1) — the documented API surface, not the application bundle. When
 * Obsidian publishes a new one, this list and the table move together,
 * deliberately.
 */
const PUBLISHED_SYMBOLS: readonly string[] = [
  "AbstractInputSuggest", "AbstractTextComponent", "App", "BaseComponent", "BasesEntry",
  "BasesEntryGroup", "BasesQueryResult", "BasesView", "BasesViewConfig", "BooleanValue",
  "ButtonComponent", "CapacitorAdapter", "ColorComponent", "Component", "ConfirmationButton",
  "ConfirmationModal", "DateValue", "DisplayValueComponent", "DropdownComponent",
  "DurationValue", "EditableFileView", "Editor", "EditorSuggest", "Events",
  "ExtraButtonComponent", "FileManager", "FileSystemAdapter", "FileValue", "FileView",
  "FuzzySuggestModal", "HTMLValue", "HoverPopover", "IconValue", "ImageValue", "ItemView",
  "Keymap", "LinkValue", "ListValue", "MarkdownEditView", "MarkdownPreviewRenderer",
  "MarkdownPreviewView", "MarkdownRenderChild", "MarkdownRenderer", "MarkdownView", "Menu",
  "MenuItem", "MenuSeparator", "MetadataCache", "Modal", "MomentFormatComponent",
  "NotNullValue", "Notice", "NullValue", "NumberValue", "ObjectValue", "Platform", "Plugin",
  "PluginSettingTab", "PopoverState", "PopoverSuggest", "PrimitiveValue",
  "ProgressBarComponent", "QueryController", "RegExpValue", "RelativeDateValue",
  "RenderContext", "Scope", "SearchComponent", "SecretComponent", "SecretStorage", "Setting",
  "SettingGroup", "SettingPage", "SettingTab", "SliderComponent", "StringValue",
  "SuggestModal", "TAbstractFile", "TFile", "TFolder", "TagValue", "Tasks",
  "TextAreaComponent", "TextComponent", "TextFileView", "ToggleComponent", "UrlValue", "Value",
  "ValueComponent", "Vault", "View", "Workspace", "WorkspaceContainer", "WorkspaceFloating",
  "WorkspaceItem", "WorkspaceLeaf", "WorkspaceMobileDrawer", "WorkspaceParent",
  "WorkspaceRibbon", "WorkspaceRoot", "WorkspaceSidedock", "WorkspaceSplit", "WorkspaceTabs",
  "WorkspaceWindow", "addIcon", "apiVersion", "arrayBufferToBase64", "arrayBufferToHex",
  "base64ToArrayBuffer", "debounce", "displayTooltip", "editorEditorField", "editorInfoField",
  "editorLivePreviewField", "editorViewField", "finishRenderMath", "getAllTags",
  "getBlobArrayBuffer", "getFrontMatterInfo", "getIcon", "getIconIds", "getLanguage",
  "getLinkpath", "hexToArrayBuffer", "htmlToMarkdown", "iterateCacheRefs", "iterateRefs",
  "livePreviewState", "loadMathJax", "loadMermaid", "loadPdfJs", "loadPrism", "moment",
  "normalizePath", "parseFrontMatterAliases", "parseFrontMatterEntry",
  "parseFrontMatterStringArray", "parseFrontMatterTags", "parseLinktext", "parsePropertyId",
  "parseYaml", "prepareFuzzySearch", "prepareSimpleSearch", "removeIcon", "renderMatches",
  "renderMath", "renderResults", "request", "requestUrl", "requireApiVersion",
  "resolveSubpath", "sanitizeHTMLToDom", "setIcon", "setTooltip", "sortSearchResults",
  "stringifyYaml", "stripHeading", "stripHeadingForLink",
];

describe("the published symbol list", () => {
  it("is exactly what the table declares", () => {
    expect(Object.keys(API_POLICY).sort()).toEqual([...PUBLISHED_SYMBOLS].sort());
  });

  it("is exactly what the barrel exports", async () => {
    const harness = await ShimHarness.withVault({});
    expect(Object.keys(harness.api).sort()).toEqual([...PUBLISHED_SYMBOLS].sort());
  });
});

describe("implemented barrel symbols", () => {
  it("normalizePath collapses separators the way Obsidian does", async () => {
    const harness = await ShimHarness.withVault({});
    expect(harness.api.normalizePath("Folder//Note.md")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("/Folder/Note.md")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("./Folder/Note.md")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("Folder/Note.md/")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("")).toBe("/");
    // Spelling, not structure: `..` is left alone, and path-escape defence is
    // the daemon's job on every request rather than this function's.
    expect(harness.api.normalizePath("../Secret.md")).toBe("../Secret.md");
  });

  it("splits a link target into its path and its subpath", async () => {
    const harness = await ShimHarness.withVault({});
    expect(harness.api.getLinkpath("Note#Heading")).toBe("Note");
    expect(harness.api.getLinkpath("Note")).toBe("Note");
    // `[[#Heading]]` links inside the note it is written in, so an empty path
    // is a real answer — a `getLinkpath` that returned the whole text would
    // send a resolver looking for a file called `#Heading`.
    expect(harness.api.getLinkpath("#Heading")).toBe("");
    expect(harness.api.parseLinktext("Note#Heading")).toEqual({
      path: "Note",
      subpath: "#Heading",
    });
    expect(harness.api.parseLinktext("Note")).toEqual({ path: "Note", subpath: "" });
  });

  it("strips the characters a heading cannot carry into a link", async () => {
    const harness = await ShimHarness.withVault({});
    // Removed, then collapsed: the doubled space the stripped `|` leaves behind
    // would make the heading unmatchable against `cache.headings[].heading`.
    expect(harness.api.stripHeading("A #tag [[link]] | alias ^block")).toBe("A tag link alias block");
    expect(harness.api.stripHeading("  Plain heading  ")).toBe("Plain heading");
    expect(harness.api.stripHeadingForLink("A #tag")).toBe(harness.api.stripHeading("A #tag"));
  });

  it("round-trips bytes through base64 and hex", async () => {
    const harness = await ShimHarness.withVault({});
    const bytes = new Uint8Array([0, 1, 250, 255]);
    const base64 = harness.api.arrayBufferToBase64(bytes.buffer);
    expect(base64).toBe("AAH6/w==");
    expect(new Uint8Array(harness.api.base64ToArrayBuffer(base64))).toEqual(bytes);
    const hex = harness.api.arrayBufferToHex(bytes.buffer);
    expect(hex).toBe("0001faff");
    expect(new Uint8Array(harness.api.hexToArrayBuffer(hex))).toEqual(bytes);
    expect(new Uint8Array(await harness.api.getBlobArrayBuffer(new Blob([bytes])))).toEqual(bytes);
  });

  it("interrupts a reference walk when the callback says so", async () => {
    const harness = await ShimHarness.withVault({
      "A.md": "[[One]] and [[Two]] and ![[Three]]\n",
    });
    const cache = harness.app.metadataCache.getCache("A.md");
    expect(cache).not.toBeNull();
    const seen: string[] = [];
    // The published contract is the return value: `true` from the callback
    // stops the walk and the function reports that it was stopped. A version
    // that ran to the end and always answered `false` turns a caller's search
    // for the first match into a full scan with the wrong answer.
    expect(
      harness.api.iterateCacheRefs(cache!, (ref) => {
        seen.push(ref.link);
        return seen.length === 2;
      }),
    ).toBe(true);
    expect(seen).toHaveLength(2);
    expect(harness.api.iterateRefs([], () => true)).toBe(false);
  });

  it("round-trips YAML without reordering or reformatting untouched keys", async () => {
    const harness = await ShimHarness.withVault({});
    const parsed = harness.api.parseYaml("b: 2\na: 1\nlist:\n  - x\n  - z\n");
    expect(parsed).toEqual({ b: 2, a: 1, list: ["x", "z"] });
    expect(harness.api.stringifyYaml(parsed)).toBe("b: 2\na: 1\nlist:\n  - x\n  - z\n");
  });

  it("quotes the one-letter values that YAML 1.1 would read as booleans", async () => {
    const harness = await ShimHarness.withVault({});
    // `js-yaml`'s dumper quotes `y` and `n`, and this host keeps that default
    // deliberately: the value is a **string**, and a bare `y` is read back as
    // `true` by any YAML 1.1 reader — which includes plenty of tooling that
    // sees a vault's frontmatter after this host has written it. A quote that
    // survives a round trip is worth more than a byte-identical line that does
    // not. The brief's own example asserted the unquoted form; it was measured
    // against `js-yaml` 4.1.0 here and is not what the library emits.
    expect(harness.api.stringifyYaml({ answer: "y" })).toBe("answer: 'y'\n");
    expect(harness.api.parseYaml("answer: 'y'\n")).toEqual({ answer: "y" });
  });

  it("never wraps a long value, however long the line becomes", async () => {
    const harness = await ShimHarness.withVault({});
    const long = `https://example.com/${"segment/".repeat(20)}page`;
    // The dumper's default folds at 80 columns, and a folded URL written back
    // into a note's frontmatter is a value that no longer round-trips through
    // anything reading it as one string.
    const dumped = harness.api.stringifyYaml({ url: long });
    expect(dumped).toBe(`url: ${long}\n`);
    expect(dumped.split("\n")).toHaveLength(2);
  });

  it("parses frontmatter helpers off a real cache", async () => {
    const harness = await ShimHarness.withVault({
      "A.md": "---\naliases: [Ay, Bee]\ntags: [alpha, beta]\n---\n#gamma\n",
    });
    const cache = harness.app.metadataCache.getCache("A.md");
    expect(cache).not.toBeNull();
    expect(harness.api.parseFrontMatterAliases(cache?.frontmatter)).toEqual(["Ay", "Bee"]);
    expect(harness.api.parseFrontMatterTags(cache?.frontmatter)).toEqual(["#alpha", "#beta"]);
    expect(harness.api.getAllTags(cache)?.sort()).toEqual(["#alpha", "#beta", "#gamma"]);
  });

  it("answers null for a key a note does not have, prototype included", async () => {
    const harness = await ShimHarness.withVault({});
    // A plain property read would answer `Object.prototype.toString` here, and
    // `parseFrontMatterStringArray` would then answer `[]` — turning "this note
    // has no such field" into "this note has an empty one", which is a
    // difference the two answers exist to preserve.
    expect(harness.api.parseFrontMatterEntry({ a: 1 }, "toString")).toBeNull();
    expect(harness.api.parseFrontMatterEntry({ a: 1 }, "constructor")).toBeNull();
    expect(harness.api.parseFrontMatterStringArray({ a: 1 }, "toString")).toBeNull();
    expect(harness.api.parseFrontMatterEntry({ a: 1 }, "a")).toBe(1);
  });

  it("getFrontMatterInfo reports the frontmatter span of a real note", async () => {
    const harness = await ShimHarness.withVault({});
    const info = harness.api.getFrontMatterInfo("---\na: 1\n---\nbody\n");
    expect(info).toMatchObject({ exists: true, frontmatter: "a: 1\n" });
    // The offsets are what a caller rewrites a note with, so they are asserted
    // rather than taken on trust: everything from `contentStart` is the body.
    expect("---\na: 1\n---\nbody\n".slice(info.contentStart)).toBe("body\n");
    expect(harness.api.getFrontMatterInfo("body\n")).toMatchObject({ exists: false });
  });

  it("records a Notice outside dry-run and reports it since a mark", async () => {
    const harness = await ShimHarness.withVault({});
    const mark = harness.noticeLog.mark();
    const plugin = harness.instantiate(
      "demo",
      class extends harness.api.Plugin {
        override async onload(): Promise<void> {
          new harness.api.Notice("hello");
          return Promise.resolve();
        }
      },
    );
    await harness.load(plugin);
    // Not a dry run. The log records anyway — this is the field
    // `host.invoke_command`'s `notices` reads from.
    expect(harness.noticeLog.since(mark)).toEqual([
      {
        pluginId: "demo",
        message: "hello",
        atUnixMs: expect.any(Number) as unknown,
        timeoutMs: null,
      },
    ]);
  });

  it("answers a mark with the notices raised after it, and no others", async () => {
    const harness = await ShimHarness.withVault({});
    const log = harness.noticeLog;
    log.record("before", null);
    const mark = log.mark();
    log.record("after", 4000);
    // The whole point of the mark: `host.invoke_command` reports **this
    // command's** notices. A `since` that ignored its argument would answer
    // with the earlier one too, and a client would be told a command said
    // something it did not.
    expect(log.since(mark).map((entry) => entry.message)).toEqual(["after"]);
    expect(log.entries().map((entry) => entry.message)).toEqual(["before", "after"]);
    // Two notices in one case share an `atUnixMs`, because a `TestClock` does
    // not move unless a case advances it — which is exactly why the window is
    // a sequence number and not a timestamp.
    expect(log.entries()[0]?.atUnixMs).toBe(log.entries()[1]?.atUnixMs);
  });

  it("keeps an outstanding mark meaningful after the ring has wrapped", async () => {
    const harness = await ShimHarness.withVault({});
    const log = new (harness.noticeLog.constructor as new (deps: {
      clock: typeof harness.clock;
      limit?: number;
    }) => typeof harness.noticeLog)({ clock: harness.clock, limit: 3 });
    const mark = log.mark();
    for (const message of ["one", "two", "three", "four", "five"]) log.record(message, null);
    // Three kept of five recorded: the answer is what survives, not a pretended
    // complete one — and it must not be the *wrong* three, which is what an
    // index-based window would give once the buffer started dropping.
    expect(log.entries().map((entry) => entry.message)).toEqual(["three", "four", "five"]);
    expect(log.since(mark).map((entry) => entry.message)).toEqual(["three", "four", "five"]);
    expect(log.since(log.mark())).toEqual([]);
  });

  it("records one policy hit per notice, not two", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "noticer",
      class extends harness.api.Plugin {
        override onload(): void {
          new harness.api.Notice("one");
        }
      },
    );
    await harness.load(plugin);
    const row = harness.policyRecorder
      .entries()
      .find((entry) => entry.symbol === "Notice" && entry.pluginId === "noticer");
    // The constructor used to route through `setMessage`, which recorded a
    // second hit for every notice ever raised and made the report read as twice
    // the use.
    expect(row?.hits).toBe(1);
  });

  it("reports Platform as desktop and apiVersion as the configured version", async () => {
    const harness = await ShimHarness.withVault({}, { config: { appVersion: "1.9.14" } });
    expect(harness.api.Platform).toMatchObject({
      isDesktop: true,
      isDesktopApp: true,
      isMobile: false,
      isMobileApp: false,
    });
    expect(harness.api.apiVersion).toBe("1.9.14");
    expect(harness.api.requireApiVersion("1.5.0")).toBe(true);
    expect(harness.api.requireApiVersion("99.0.0")).toBe(false);
  });

  it("compares versions part by part as numbers, not as strings", async () => {
    const harness = await ShimHarness.withVault({}, { config: { appVersion: "1.9.14" } });
    // The single most common bug in this function: `"1.9.14" < "1.10.0"` is
    // false as a string comparison and true as a version comparison.
    expect(harness.api.requireApiVersion("1.10.0")).toBe(false);
    expect(harness.api.requireApiVersion("1.9.2")).toBe(true);
    expect(harness.api.requireApiVersion("1.9.14")).toBe(true);
    // A missing part is zero, so `1.9` means `1.9.0` and is satisfied.
    expect(harness.api.requireApiVersion("1.9")).toBe(true);
  });

  it("keeps EditableFileView and FileSystemAdapter constructible and never instanced", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "x\n" });
    expect(typeof harness.api.EditableFileView).toBe("function");
    expect(typeof harness.api.FileSystemAdapter).toBe("function");
    // folder-notes' and quickadd's actual tests, both of which must be false.
    expect(harness.app.workspace.getLeaf(false).view).not.toBeInstanceOf(harness.api.EditableFileView);
    expect(harness.app.vault.adapter).not.toBeInstanceOf(harness.api.FileSystemAdapter);
  });

  it("names the subclass when a modal is opened", async () => {
    const harness = await ShimHarness.withVault({});
    class ChoiceSuggester extends harness.api.Modal {}
    const modal = new ChoiceSuggester(harness.app);
    // "A modal was opened" is useless in a compatibility report; "quickadd's
    // ChoiceSuggester was opened" is a diagnosis, and Task 18 brokers by name.
    try {
      // `void`: `Modal.open` is declared `void | Promise<void>` since Task 18,
      // because the suggester subclasses override it with a promise. This one
      // still only ever throws.
      void modal.open();
      expect.unreachable("Modal.open did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HeadlessUnsupported);
      expect((error as HeadlessUnsupported).symbol).toBe("Modal.open");
      expect((error as HeadlessUnsupported).detail).toBe("ChoiceSuggester");
      expect((error as HeadlessUnsupported).message).toContain("ChoiceSuggester");
    }
    // Closing is not a throw: a plugin calls it on the cleanup path an `open()`
    // throw lands in, and a second throw there would hide the first.
    expect(() => {
      modal.close();
    }).not.toThrow();
  });

  it("brokers a suggester rather than refusing it, and says so when nobody can answer", async () => {
    const harness = await ShimHarness.withVault({});
    class Picker extends harness.api.FuzzySuggestModal<string> {}
    // **Not a `HeadlessUnsupported`, since Task 18.** The suggester family is
    // the one modal shape a headless host can honestly open: the base owns the
    // rendering and the subclass supplies only a list and a choice handler, so
    // `open()` brokers to whatever client is attached. This harness has no
    // socket and therefore nobody attached, which is a different refusal — the
    // channel is missing, not the surface.
    await expect(new Picker(harness.app).open()).rejects.toMatchObject({
      code: "interaction_unavailable",
    });
    expect(policyOf("FuzzySuggestModal.open")).toBe("implemented");
    // A bespoke `Modal.onOpen()` UI stays absent: there is no seam in it.
    expect(policyOf("Modal.open")).toBe("absent");
  });

  it("orders fuzzy matches well enough for a brokered picker", async () => {
    const harness = await ShimHarness.withVault({});
    const scorer = harness.api.prepareFuzzySearch("dly");
    expect(scorer("Daily note")).not.toBeNull();
    expect(scorer("Weekly review")).toBeNull();
    const items = ["Weekly note", "Daily note", "Deadly nightshade"];
    const scored: { text: string; match: SearchResult | null }[] = items
      .map((text) => ({ text, match: scorer(text) }))
      .filter((entry) => entry.match !== null);
    harness.api.sortSearchResults(scored);
    expect(scored[0]?.text).toBe("Daily note");
    // An empty search box matches everything, and a box holding only spaces is
    // an empty search box.
    expect(harness.api.prepareFuzzySearch("   ")("Daily note")).toEqual({ score: 0, matches: [] });
  });

  it("answers getIcon for an icon a plugin registered, and null otherwise", async () => {
    const harness = await ShimHarness.withVault({});
    expect(harness.api.getIcon("plugin-icon")).toBeNull();
    harness.api.addIcon("plugin-icon", "<svg/>");
    // `getIconIds` lists it, so `getIcon` answering `null` would tell the plugin
    // its own registration failed. A name this host never saw still answers
    // `null`, because Obsidian's built-in set is uncaptured and a `true` this
    // host cannot back is worse than a `false`.
    expect(harness.api.getIconIds()).toContain("plugin-icon");
    expect(harness.api.getIcon("plugin-icon")).not.toBeNull();
    expect(harness.api.getIcon("lucide-not-registered-here")).toBeNull();
    harness.api.removeIcon("plugin-icon");
    expect(harness.api.getIconIds()).not.toContain("plugin-icon");
    expect(harness.api.getIcon("plugin-icon")).toBeNull();
  });

  it("decodes the entities a browser's parser would have decoded", async () => {
    const harness = await ShimHarness.withVault({});
    // A plugin builds a notice out of this and reads the text back; a literal
    // `&amp;` on screen is the failure.
    expect(harness.api.sanitizeHTMLToDom("<b>Tom</b> &amp; Jerry").textContent).toBe("Tom & Jerry");
    expect(harness.api.sanitizeHTMLToDom("&lt;not a tag&gt;").textContent).toBe("<not a tag>");
    // `&amp;` is decoded last, so an escaped entity survives as text.
    expect(harness.api.sanitizeHTMLToDom("&amp;lt;").textContent).toBe("&lt;");
  });

  it("builds a settings row with every control, including the two late additions", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate(
      "settings",
      class extends harness.api.Plugin {
        override onload(): void {
          // Nothing: this plugin owns the tab below.
        }
      },
    );
    await harness.load(plugin);
    const tab = new harness.api.PluginSettingTab(harness.app, plugin);
    let formatted = "";
    // A chain that throws anywhere takes the whole plugin down inside `onload`,
    // over controls nobody can see — so the whole chain is exercised, and the
    // two components a plugin would otherwise reach through `undefined` are in
    // it.
    expect(() => {
      new harness.api.Setting(tab.containerEl)
        .setName("Everything")
        .setDesc("one of each")
        .addText((text) => text.setValue("t"))
        .addTextArea((area) => area.setValue("a"))
        .addSearch((search) => search.setValue("s"))
        .addDropdown((drop) => drop.addOption("a", "A").setValue("a"))
        .addToggle((toggle) => toggle.setValue(true))
        .addSlider((slider) => slider.setLimits(0, 10, 2).setValue(4))
        .addColorPicker((colour) => colour.setValue("#ff0000"))
        .addSecret((secret) => secret.setValue("hunter2"))
        .addMomentFormat((format) => {
          format.setFormatter(() => "2026-09-14");
          format.setValue("YYYY-MM-DD");
          formatted = format.sampleEl.textContent;
        })
        .addProgressBar((bar) => bar.setValue(50))
        .addButton((button) => button.setButtonText("Go"))
        .addExtraButton((button) => button.setIcon("gear"));
    }).not.toThrow();
    expect(formatted).toBe("2026-09-14");
  });

  it("debounces on the host's clock rather than on the runtime's", async () => {
    const harness = await ShimHarness.withVault({});
    const seen: string[] = [];
    const debounced = harness.api.debounce((value: string) => seen.push(value), 500, true);
    debounced("first");
    debounced("second");
    expect(seen).toEqual([]);
    // The clock is the harness's own. A `debounce` armed on the runtime's
    // timers would never fire here — which is the bug this case exists to
    // catch, because it would pass for a plugin and fail for every test.
    await harness.clock.advance(500);
    expect(seen).toEqual(["second"]);
  });

  it("refuses the network without opening a socket", async () => {
    const harness = await ShimHarness.withVault({});
    const realFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      attempts += 1;
      return realFetch(...args);
    };
    try {
      const refusals: unknown[] = [];
      const plugin = harness.instantiate(
        "phone-home",
        class extends harness.api.Plugin {
          override async onload(): Promise<void> {
            for (const call of [
              (): Promise<unknown> => harness.api.requestUrl("https://example.com/ping"),
              (): Promise<unknown> => harness.api.request({ url: "https://example.com/ping" }),
            ]) {
              try {
                await call();
              } catch (error) {
                refusals.push(error);
              }
            }
          }
        },
      );
      await harness.load(plugin);
      // Both spellings refuse, both name the address, and **nothing was
      // attempted**: a test suite that loads real community bundles must not be
      // able to reach the internet, and "the request failed" is not the same
      // claim as "no request was made".
      expect(refusals).toHaveLength(2);
      for (const refusal of refusals) {
        expect(refusal).toBeInstanceOf(NetworkRefused);
        expect((refusal as NetworkRefused).url).toBe("https://example.com/ping");
        expect((refusal as NetworkRefused).code).toBe("network_refused");
      }
      expect(attempts).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a direct module import too, so the unsafe direction is never the default", async () => {
    const harness = await ShimHarness.withVault({});
    const realFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      attempts += 1;
      return realFetch(...args);
    };
    try {
      // Not through the barrel: this is the next in-host caller who imports the
      // function from `shim/helpers` and forgets the second argument. The
      // default answers for them, and it answers **no** — a default of `true`
      // would hand that caller the network silently, and nobody would notice
      // until a test run reached the internet.
      await expect(requestUrl("https://example.com/direct")).rejects.toBeInstanceOf(NetworkRefused);
      await expect(request({ url: "https://example.com/direct" })).rejects.toBeInstanceOf(
        NetworkRefused,
      );
      expect(attempts).toBe(0);
      // And the harness's own barrel is still bound to its config, not to the
      // default — the two are different mechanisms and both have to hold.
      expect(harness.config.allowNetwork).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("forwards when the host is allowed to reach the network", async () => {
    const harness = await ShimHarness.withVault({}, { config: { allowNetwork: true } });
    const realFetch = globalThis.fetch;
    let asked: string | null = null;
    globalThis.fetch = ((input: string) => {
      asked = input;
      return Promise.resolve(new Response("pong", { status: 200 }));
    }) as unknown as typeof fetch;
    try {
      // Production is the other half of the switch, and it has to work: the
      // policy row stays `implemented` because this host really can make the
      // request — it is the *run* that may be forbidden, not the API.
      const answered = await harness.api.requestUrl("https://example.com/ping");
      expect(asked).toBe("https://example.com/ping");
      expect(answered.status).toBe(200);
      expect(answered.text).toBe("pong");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
