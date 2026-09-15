import { describe, expect, it } from "vitest";

import { ShimHarness } from "../src/testing/shim-harness";
import type { SearchResult } from "../src/shim/search";

/**
 * The barrel's `implemented` symbols, doing the thing they claim to do.
 *
 * `api-policy.test.ts` proves every name resolves to something of the right
 * shape; it cannot prove that the implemented ones work, and a helper that
 * resolves to a function returning the wrong answer is worse than one that
 * resolves to `undefined` — the first silently corrupts a note, the second
 * fails loudly. So each case here is a surface where being wrong would be
 * expensive: paths handed to the daemon, YAML written back into frontmatter,
 * the tags a plugin indexes on, and the notices a caller reads out of an invoke
 * response.
 */
describe("implemented barrel symbols", () => {
  it("normalizePath collapses separators the way Obsidian does", async () => {
    const harness = await ShimHarness.withVault({});
    expect(harness.api.normalizePath("Folder//Note.md")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("/Folder/Note.md")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("./Folder/Note.md")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("Folder/Note.md/")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("")).toBe("/");
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

  it("keeps EditableFileView and FileSystemAdapter constructible and never instanced", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "x\n" });
    expect(typeof harness.api.EditableFileView).toBe("function");
    expect(typeof harness.api.FileSystemAdapter).toBe("function");
    // folder-notes' and quickadd's actual tests, both of which must be false.
    expect(harness.app.workspace.getLeaf(false).view).not.toBeInstanceOf(harness.api.EditableFileView);
    expect(harness.app.vault.adapter).not.toBeInstanceOf(harness.api.FileSystemAdapter);
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
});
