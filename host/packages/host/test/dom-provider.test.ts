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
 * The cases run over happy-dom, the one provider task 4 of
 * `docs/design/web-plugins.md` kept; the table form stays so a second provider
 * is one row.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/shim/app";
import { Harvest } from "../src/shim/harvest";
import { HostErrors } from "../src/shim/errors";
import { StubEl, StubNode, createEl as stubCreateEl } from "../src/shim/dom";
import { ShimHarness } from "../src/testing/shim-harness";
import { defaultHostConfig } from "../src/config";
import { installGlobals } from "../src/shim/globals";
import { happyDomProvider } from "../src/shim/dom-providers/happy-dom";
import { testClock } from "../src/testing/clock";
import { loadOptionalDom } from "../src/shim/dom-provider";
import type { DomEnvironment, DomProvider } from "../src/shim/dom-provider";

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

const PROVIDERS: ReadonlyArray<readonly [string, () => DomProvider]> = [["happy-dom", happyDomProvider]];

/**
 * Every harness a case builds, torn down after it.
 *
 * A server-DOM harness installs globals and puts helpers on the library's
 * shared prototypes; left standing, it would be what the next case sees as
 * "before", and a restore case would be comparing against a leaked server
 * document rather than the stub.
 */
const live: ShimHarness[] = [];

async function harness(dom?: DomProvider): Promise<ShimHarness> {
  const built = await ShimHarness.withVault({}, dom === undefined ? {} : { dom });
  live.push(built);
  return built;
}

afterEach(async () => {
  for (const built of live.splice(0).reverse()) {
    await built.teardown();
    await built.stop();
  }
});

/** The globals a provider swaps, read off `globalThis` and the host `window`. */
function swapped(): Record<string, unknown> {
  const scope = globalThis as unknown as Record<string, unknown> & { window?: { document?: unknown } };
  return {
    document: scope.document,
    activeDocument: scope.activeDocument,
    windowDocument: scope.window?.document,
    Node: scope.Node,
    Element: scope.Element,
    HTMLElement: scope.HTMLElement,
    DocumentFragment: scope.DocumentFragment,
    createEl: scope.createEl,
    createDiv: scope.createDiv,
    createSpan: scope.createSpan,
    createFragment: scope.createFragment,
    self: scope.self,
    getComputedStyle: scope.getComputedStyle,
  };
}

/** Every own descriptor on `globalThis`, for an all-or-nothing comparison. */
function snapshot(target: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key) as Record<string, unknown>;
    // The whole descriptor, copied as data: value, accessors and flags.
    out[String(key)] = { ...descriptor };
  }
  return out;
}

describe("the default DOM provider", () => {
  it("is still the inert stub document, with the stub builders", async () => {
    const built = await harness();
    const installed = globalDocument() as unknown;
    expect(installed).toBe(built.document);
    expect(built.document.body).toBeInstanceOf(StubEl);
    expect((globalThis as unknown as { createEl: unknown }).createEl).toBe(stubCreateEl);
    expect((globalThis as unknown as { Node: unknown }).Node).toBe(StubNode);
  });
});

describe.each(PROVIDERS)("the %s provider", (name, provider) => {
  it("names itself", () => {
    expect(provider().name).toBe(name);
  });

  it("installs a document with a working head and body", async () => {
    const built = await harness(provider());
    const document = globalDocument();
    expect(built.serverDom?.document).toBe(document);
    expect(document.head.tagName).toBe("HEAD");
    expect(document.body.tagName).toBe("BODY");
    document.body.classList.add("css-settings-manager", "theme-dark");
    expect(document.body.classList.contains("css-settings-manager")).toBe(true);
    document.body.classList.remove("theme-dark");
    expect(document.body.classList.contains("theme-dark")).toBe(false);
  });

  it("refuses the stub document accessor on a server-DOM harness", async () => {
    const built = await harness(provider());
    expect(() => built.document).toThrow(/server DOM/);
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

  it("installs Obsidian's DOM helpers over the real document", async () => {
    const built = await harness(provider());
    const document = globalDocument() as Doc & { body: El & { createDiv(o?: string): El } };
    const ref = document.body.createDiv("theme-light style-settings-ref");
    expect(ref.classList.contains("style-settings-ref")).toBe(true);
    const builders = globalThis as unknown as { createEl(tag: string, o?: { cls: string }): El; HTMLElement: new () => unknown };
    const style = builders.createEl("style", { cls: "probe" });
    expect(style.tagName).toBe("STYLE");
    expect(style).toBeInstanceOf(builders.HTMLElement);
    expect(built.serverDom?.constructors.HTMLElement).toBe(builders.HTMLElement);
  });

  it("puts the library's prototypes back as it found them on restore", () => {
    const env = provider().create();
    const prototype = env.constructors.Node.prototype;
    env.close();
    // The libraries share their prototypes across every document in the
    // process, so a harness earlier in this file may have left its own helpers
    // there. A sentinel makes "whatever was there before" observable.
    const original = Object.getOwnPropertyDescriptor(prototype, "createDiv");
    const sentinel = { value: "sentinel", writable: false, configurable: true, enumerable: true };
    Object.defineProperty(prototype, "createDiv", sentinel);
    try {
      const installation = install(provider());
      const during = Object.getOwnPropertyDescriptor(prototype, "createDiv");
      expect(typeof during?.value).toBe("function");
      expect(during?.enumerable).toBe(false);
      installation.restore();
      expect(Object.getOwnPropertyDescriptor(prototype, "createDiv")).toEqual(sentinel);
    } finally {
      if (original === undefined) delete (prototype as Record<string, unknown>).createDiv;
      else Object.defineProperty(prototype, "createDiv", original);
    }
  });

  it("puts the stub globals back on restore", () => {
    // A real stub installation underneath, so "before" is the stub document,
    // the stub `Node` and the stub builders — not whatever an earlier case left.
    const stub = install();
    try {
      const before = swapped();
      expect(before.document).toBe(stub.document);
      expect(before.Node).toBe(StubNode);
      expect(before.createEl).toBe(stubCreateEl);
      const installation = install(provider());
      const during = swapped();
      for (const key of Object.keys(before)) expect(during[key], key).not.toBe(before[key]);
      installation.restore();
      expect(swapped()).toEqual(before);
      for (const key of Object.keys(before)) expect(swapped()[key], key).toBe(before[key]);
    } finally {
      stub.restore();
    }
  });

  it("installs self as the window, as a browser has it", async () => {
    const built = await harness(provider());
    expect((globalThis as unknown as { self: unknown }).self).toBe(built.window);
  });

  it("answers getComputedStyle with inherited custom properties", async () => {
    await harness(provider());
    const document = globalDocument();
    const style = document.createElement("style");
    style.textContent =
      "body { --plain: 1px; } body.theme-dark { --ink: #eeeeee; } body.theme-dark.css-settings-manager { --ink: #d0e0ff; } .own { --plain: 2px; }";
    document.head.appendChild(style);
    document.body.classList.add("theme-dark", "css-settings-manager");
    const child = document.createElement("div");
    child.classList.add("theme-light");
    document.body.appendChild(child);
    const own = document.createElement("div");
    own.classList.add("own");
    child.appendChild(own);
    const read = (globalThis as unknown as { getComputedStyle: (el: unknown) => { getPropertyValue(n: string): string } })
      .getComputedStyle;
    // The more specific rule wins on the element that matches it.
    expect(read(document.body).getPropertyValue("--ink").trim()).toBe("#d0e0ff");
    // A descendant with no rule of its own inherits, as in a browser.
    expect(read(child).getPropertyValue("--ink").trim()).toBe("#d0e0ff");
    expect(read(child).getPropertyValue("--plain").trim()).toBe("1px");
    // Its own declaration beats the inherited one.
    expect(read(own).getPropertyValue("--plain").trim()).toBe("2px");
    expect(read(own).getPropertyValue("--missing")).toBe("");
  });

  it("is what window.document and activeDocument resolve to", async () => {
    const built = await harness(provider());
    const document = built.serverDom?.document;
    expect(document).toBeDefined();
    expect(built.window.document).toBe(document);
    expect((globalThis as unknown as { activeDocument: unknown }).activeDocument).toBe(document);
  });
});

describe("a provider that fails", () => {
  it("leaves the process unchanged when create() throws", () => {
    const before = snapshot(globalThis);
    const failing: DomProvider = {
      name: "failing",
      create: () => {
        throw new Error("no DOM today");
      },
    };
    expect(() => install(failing)).toThrow("no DOM today");
    expect(snapshot(globalThis)).toEqual(before);
  });

  it("undoes everything and closes the DOM when a later step throws", () => {
    const env = happyDomProvider().create();
    let closed = 0;
    // A frozen prototype refuses the first helper, after the document and
    // constructors are already installed.
    const frozen = Object.freeze(Object.create(null) as object);
    const broken: DomEnvironment = {
      ...env,
      constructors: { ...env.constructors, Node: { prototype: frozen } },
      close: () => {
        closed += 1;
        env.close();
      },
    };
    const before = snapshot(globalThis);
    const elementPrototype = snapshot(env.constructors.Element.prototype);
    expect(() => install({ name: "broken", create: () => broken })).toThrow(TypeError);
    expect(closed).toBe(1);
    expect(snapshot(globalThis)).toEqual(before);
    expect(snapshot(env.constructors.Element.prototype)).toEqual(elementPrototype);
  });
});

describe("a missing optional dependency", () => {
  it("is named, with the profile that needs it", () => {
    const missing = Object.assign(new Error("Cannot find module 'happy-dom'\nRequire stack: ..."), {
      code: "MODULE_NOT_FOUND",
    });
    expect(() =>
      loadOptionalDom("happy-dom", () => {
        throw missing;
      }),
    ).toThrow(/screen host profile needs the optional dependency "happy-dom"/);
  });

  it("passes any other failure through unchanged", () => {
    const other = Object.assign(new Error("Cannot find module 'whatwg-mimetype'"), { code: "MODULE_NOT_FOUND" });
    expect(() =>
      loadOptionalDom("happy-dom", () => {
        throw other;
      }),
    ).toThrow(other);
  });
});

/** Install the globals, with a provider or with the stub, outside any harness. */
function install(dom?: DomProvider): { readonly document: unknown; restore(): void } {
  const app = new App({ appId: "0".repeat(16), appVersion: "1.0.0" });
  return installGlobals(app, defaultHostConfig("/vault"), {
    dataDir: join(process.cwd(), "target", "tmp", "dom-provider-probe"),
    errors: new HostErrors(),
    harvest: new Harvest(),
    clock: testClock(),
    ...(dom === undefined ? {} : { dom }),
  });
}
