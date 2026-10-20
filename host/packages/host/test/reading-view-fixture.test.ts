/**
 * The reading-view parity fixture keeps one note per construct.
 *
 * `host/fixtures/reading-view/vault/` is what `host/scripts/reading-view-capture.js`
 * is run against in a live Obsidian. A construct whose note is deleted or
 * renamed would drop out of the parity check without any failure, so this list
 * names every note the brief requires, with a marker string each must still
 * contain.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const capture = require("../../../scripts/reading-view-capture.js") as {
  FIXTURE_MARKERS: string[];
  normalise: (html: string) => { html: string; unlisted: string[] };
};

const VAULT = resolve(__dirname, "../../../fixtures/reading-view/vault");

/** note -> a string the note must still contain (the construct itself). */
const NOTES: Record<string, string> = {
  "headings.md": "###### Heading 6",
  "inline-formatting.md": "==highlight==",
  "wikilinks.md": "[[Block Target#^fixture-block]]",
  "links.md": "https://example.com/bare",
  "embeds.md": "![[Embedded Base.base]]",
  "images.md": "![[assets/pixel.png|100x50]]",
  "lists.md": "    - doubly nested item",
  "task-lists.md": "- [/] half-done task",
  "blockquotes.md": ">>> Doubly nested",
  "callouts.md": "[!danger]-",
  "code-blocks.md": "```mb",
  "tables.md": "| :--- | :----: | ----: |",
  "horizontal-rules.md": "***",
  "footnotes.md": "^[This footnote is written inline.]",
  "math.md": "$$",
  "comments.md": "%%",
  "tags.md": "#fixture-inline",
  "frontmatter-types.md": "show-properties: true",
  "inline-html.md": "<span class=\"fixture-span\"",
  "escaped-characters.md": "\\*not emphasis\\*",
  "hard-line-breaks.md": "\\\n",
  "view-field-code.md": "`VIEW[*{description}*][text(renderMarkdown)]`",
  "Link Target.md": "",
  "Target With Headings.md": "## Second heading",
  "Block Target.md": "^fixture-block",
  "Embedded Base.base": "views:",
  "assets/pixel.png": "",
};

describe("reading-view fixture", () => {
  for (const [note, marker] of Object.entries(NOTES)) {
    it(`${note} exists and holds its construct`, () => {
      const path = join(VAULT, note);
      expect(existsSync(path), `${note} is missing`).toBe(true);
      if (marker) expect(readFileSync(path, "utf8")).toContain(marker);
    });
  }

  it("view-field-code.md starts with the field as inline code", () => {
    expect(readFileSync(join(VAULT, "view-field-code.md"), "utf8").split("\n")[0]).toBe(
      "`VIEW[*{description}*][text(renderMarkdown)]`",
    );
  });

  it("the settings are the defaults the brief names", () => {
    const app = JSON.parse(readFileSync(join(VAULT, ".obsidian/app.json"), "utf8")) as Record<string, unknown>;
    expect(app.readableLineLength).toBe(true);
    expect(app.strictLineBreaks).toBe(false);
    expect(existsSync(join(VAULT, ".obsidian/community-plugins.json"))).toBe(false);
  });

  it("the capture script's fixture markers all exist", () => {
    for (const marker of capture.FIXTURE_MARKERS) expect(existsSync(join(VAULT, marker)), marker).toBe(true);
  });
});

describe("reading-view capture normalisation", () => {
  it("drops pusher and sizer style, drops listed bookkeeping, keeps the named data attributes, reports the rest", () => {
    const raw =
      '<div class="markdown-preview-pusher" style="width: 1px; height: 0.1px"></div>\n' +
      '<div class="el-p" data-line="3" data-x="1">\n  <p style="color:red"><a data-href="A" href="A">A</a></p>\n</div>' +
      '<div data-callout="note" data-task="x" data-heading="H"></div>';
    const { html, unlisted } = capture.normalise(raw);
    expect(html).not.toContain("width: 1px");
    expect(html).toContain('style="color:red"');
    expect(html).not.toContain("data-line");
    expect(html).toContain('data-href="A"');
    expect(html).toContain('data-callout="note"');
    expect(html).toContain('data-task="x"');
    expect(html).toContain('data-heading="H"');
    expect(html).not.toMatch(/>\s+</);
    expect(unlisted).toEqual(["data-x"]);
  });
});
