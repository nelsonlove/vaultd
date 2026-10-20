/**
 * The DOM provider seam: what `installGlobals` puts behind `document`.
 *
 * The headless host keeps its inert stub document — that is the default, and
 * the first case pins it. A screen host passes a real-DOM provider instead, and
 * the cases after it hold each provider to what Style Settings actually reads
 * from the document: `head` to append its `<style>` to, `body.classList` for
 * its classes, `createElement("style")` with a writable `textContent`, and
 * `document.styleSheets` iterating the document's `<style>` elements, each with
 * an `ownerNode` whose text it parses.
 *
 * Both server DOMs are held to the same cases, because task 4 of
 * `docs/design/web-plugins.md` picks one of them by measurement and the seam
 * must not have decided that already.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { App } from "../src/shim/app";
import { Harvest } from "../src/shim/harvest";
import { HostErrors } from "../src/shim/errors";
import { StubEl, StubNode, createEl as stubCreateEl } from "../src/shim/dom";
import { ShimHarness } from "../src/testing/shim-harness";
import { defaultHostConfig } from "../src/config";
import { installGlobals } from "../src/shim/globals";
import { happyDomProvider } from "../src/shim/dom-providers/happy-dom";
import { linkedomProvider } from "../src/shim/dom-providers/linkedom";
import { testClock } from "../src/testing/clock";
import type { DomProvider } from "../src/shim/dom-provider";

/** The handful of standard DOM members these cases reach for. */
interface El {
  tagName: string;
  textContent: string | null;
  classList: { add(...c: string[]): void; contains(c: string): boolean; remove(...c: string[]): void };
  setAttribute(name: string, value: string): void;
  appendChild<T>(child: T): T;
  remove(): void;
}
interface Sheet {
  ownerNode: El | null;
}
interface SheetList extends Iterable<Sheet> {
  length: number;
  item(index: number): Sheet | null;
  [index: number]: Sheet | undefined;
}
interface Doc {
  head: El;
  body: El;
  createElement(tag: string): El;
  styleSheets: SheetList;
}

function globalDocument(): Doc {
  return (globalThis as unknown as { document: Doc }).document;
}

const PROVIDERS: ReadonlyArray<readonly [string, () => DomProvider]> = [
  ["linkedom", linkedomProvider],
  ["happy-dom", happyDomProvider],
];

describe("the default DOM provider", () => {
  it("is still the inert stub document, with the stub builders", async () => {
    const harness = await ShimHarness.withVault({});
    const installed = globalDocument() as unknown;
    expect(installed).toBe(harness.document);
    expect(harness.document.body).toBeInstanceOf(StubEl);
    expect((globalThis as unknown as { createEl: unknown }).createEl).toBe(stubCreateEl);
    expect((globalThis as unknown as { Node: unknown }).Node).toBe(StubNode);
  });
});

describe.each(PROVIDERS)("the %s provider", (name, provider) => {
  it("names itself", () => {
    expect(provider().name).toBe(name);
  });

  it("installs a document with a working head and body", async () => {
    const harness = await ShimHarness.withVault({}, { dom: provider() });
    const document = globalDocument();
    expect(harness.serverDom?.document).toBe(document);
    expect(document.head.tagName).toBe("HEAD");
    expect(document.body.tagName).toBe("BODY");
    document.body.classList.add("css-settings-manager", "theme-dark");
    expect(document.body.classList.contains("css-settings-manager")).toBe(true);
    document.body.classList.remove("theme-dark");
    expect(document.body.classList.contains("theme-dark")).toBe(false);
  });

  it("refuses the stub document accessor on a server-DOM harness", async () => {
    const harness = await ShimHarness.withVault({}, { dom: provider() });
    expect(() => harness.document).toThrow(/server DOM/);
  });

  it("makes <style> elements whose text can be set and read back", () => {
    const installation = install(provider());
    try {
      const document = globalDocument();
      const style = document.createElement("style");
      style.textContent = "body { --x: 1; }";
      document.head.appendChild(style);
      expect(style.tagName).toBe("STYLE");
      expect(style.textContent).toBe("body { --x: 1; }");
    } finally {
      installation.restore();
    }
  });

  it("lists the document's style sheets in order, each with its ownerNode", () => {
    const installation = install(provider());
    try {
      const document = globalDocument();
      expect(document.styleSheets.length).toBe(0);
      const first = document.createElement("style");
      first.textContent = "/* @settings\nname: A\nid: a\nsettings: []\n*/";
      document.head.appendChild(first);
      const link = document.createElement("link");
      link.setAttribute("rel", "stylesheet");
      link.setAttribute("href", "theme.css");
      document.head.appendChild(link);
      const second = document.createElement("style");
      second.textContent = "body { --y: 2; }";
      document.body.appendChild(second);
      // A style element that is not in the document has no sheet in a browser.
      const detached = document.createElement("style");
      detached.textContent = "x {}";

      const sheets = document.styleSheets;
      expect(sheets.length).toBe(3);
      // Style Settings reads the list exactly like this: `length`, then `item(i)`.
      const owners: unknown[] = [];
      for (let i = 0; i < sheets.length; i += 1) owners.push(sheets.item(i)?.ownerNode);
      expect(owners).toEqual([first, link, second]);
      expect(sheets.item(0)?.ownerNode?.textContent).toContain("@settings");
      expect(sheets.item(3)).toBeNull();
      expect(sheets[2]?.ownerNode).toBe(second);
      expect([...sheets].map((sheet) => sheet.ownerNode)).toEqual([first, link, second]);

      second.remove();
      expect(document.styleSheets.length).toBe(2);
    } finally {
      installation.restore();
    }
  });

  it("puts the stub globals back on restore", () => {
    const before = globalDocument();
    const installation = install(provider());
    expect(globalDocument()).not.toBe(before);
    installation.restore();
    expect(globalDocument()).toBe(before);
  });
});

/** Install the globals with a provider, outside any harness. */
function install(dom: DomProvider): { restore(): void } {
  const app = new App({ appId: "0".repeat(16), appVersion: "1.0.0" });
  return installGlobals(app, defaultHostConfig("/vault"), {
    dataDir: join(process.cwd(), "target", "tmp", "dom-provider-probe"),
    errors: new HostErrors(),
    harvest: new Harvest(),
    clock: testClock(),
    dom,
  });
}
