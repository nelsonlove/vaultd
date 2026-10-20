/**
 * Obsidian's DOM helpers, over the server DOM.
 *
 * `shim/obsidian-dom.ts` is written against standard DOM only, so the same
 * module can run in a browser and over a server DOM. These cases hold it to
 * Obsidian's published typings (`obsidian.d.ts`, 1.13.1: `Node`, `Element` and
 * the global builders, and the `DomElementInfo` options) over each provider the
 * DOM seam offers, installed directly rather than through a host, so a failure
 * here is the helpers' and not the seam's.
 */

import { afterEach, describe, expect, it } from "vitest";

import { installObsidianDom } from "../src/shim/obsidian-dom";
import { happyDomProvider } from "../src/shim/dom-providers/happy-dom";
import type { DomEnvironment, DomProvider } from "../src/shim/dom-provider";
import type { DomDocument, DomElementInfo, ObsidianBuilders } from "../src/shim/obsidian-dom";

/** A node as these cases read it: standard members plus Obsidian's. */
interface N {
  nodeType: number;
  nodeName: string;
  tagName: string;
  textContent: string | null;
  className: string;
  title: string;
  value: string;
  type: string;
  placeholder: string;
  parentNode: N | null;
  ownerDocument: DomDocument | null;
  firstChild: N | null;
  lastChild: N | null;
  childNodes: ArrayLike<N>;
  children: ArrayLike<N>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  appendChild<T>(child: T): T;
  insertBefore<T>(child: T, reference: N | null): T;
  removeChild<T>(child: T): T;
  createEl(tag: string, o?: DomElementInfo | string, callback?: (el: N) => void): N;
  createDiv(o?: DomElementInfo | string, callback?: (el: N) => void): N;
  createSpan(o?: DomElementInfo | string, callback?: (el: N) => void): N;
  empty(): void;
  detach(): void;
  appendText(val: string): void;
  addClass(...classes: string[]): void;
  removeClass(...classes: string[]): void;
  toggleClass(classes: string | string[], value: boolean): void;
  hasClass(cls: string): boolean;
  setText(val: string | N): void;
  setAttr(name: string, value: string | number | boolean | null): void;
}

const PROVIDERS: ReadonlyArray<readonly [string, () => DomProvider]> = [["happy-dom", happyDomProvider]];

describe.each(PROVIDERS)("Obsidian's DOM helpers over %s", (_name, provider) => {
  let env: DomEnvironment | null = null;
  const undo: Array<() => void> = [];

  afterEach(() => {
    for (const step of undo.reverse()) step();
    undo.length = 0;
    env?.close();
    env = null;
  });

  /** Build a document and install the helpers on it, recording every undo. */
  function setup(): { builders: ObsidianBuilders<N, N>; document: N; enumerable: Map<string, boolean> } {
    env = provider().create();
    const enumerable = new Map<string, boolean>();
    const global: Record<string, unknown> = {};
    const builders = installObsidianDom(
      { Node: env.constructors.Node, Element: env.constructors.Element, document: env.document, global },
      (target, key, value, isEnumerable) => {
        const previous = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: isEnumerable });
        enumerable.set(`${target === global ? "global" : "prototype"}.${key}`, isEnumerable);
        undo.push(() => {
          if (previous === undefined) delete (target as Record<string, unknown>)[key];
          else Object.defineProperty(target, key, previous);
        });
      },
    ) as unknown as ObsidianBuilders<N, N>;
    expect(global.createEl).toBe(builders.createEl);
    return { builders, document: env.document as unknown as N, enumerable };
  }

  function body(document: N): N {
    return (document as unknown as { body: N }).body;
  }

  it("puts the prototype extensions on Node and Element, hidden from for-in", () => {
    const { enumerable } = setup();
    const node = env!.constructors.Node.prototype;
    const element = env!.constructors.Element.prototype;
    for (const name of ["createEl", "createDiv", "createSpan", "empty", "detach", "appendText"]) {
      expect(typeof (node as Record<string, unknown>)[name], `Node.prototype.${name}`).toBe("function");
      expect(enumerable.get(`prototype.${name}`), name).toBe(false);
    }
    for (const name of ["addClass", "removeClass", "toggleClass", "hasClass", "setText", "setAttr"]) {
      expect(typeof (element as Record<string, unknown>)[name], `Element.prototype.${name}`).toBe("function");
      expect(enumerable.get(`prototype.${name}`), name).toBe(false);
    }
    for (const name of ["createEl", "createDiv", "createSpan", "createFragment"]) {
      expect(enumerable.get(`global.${name}`), name).toBe(true);
    }
  });

  it("builds a detached element in the document with the global createEl", () => {
    const { builders, document } = setup();
    const el = builders.createEl("div");
    expect(el.tagName).toBe("DIV");
    expect(el.parentNode).toBeNull();
    expect(el.ownerDocument).toBe(document);
    expect(builders.createDiv().tagName).toBe("DIV");
    expect(builders.createSpan().tagName).toBe("SPAN");
  });

  it("reads a string option as the class", () => {
    const { builders } = setup();
    expect(builders.createDiv("theme-light style-settings-ref").className).toBe("theme-light style-settings-ref");
  });

  it("applies cls as a string or an array, and text as text", () => {
    const { builders } = setup();
    expect(builders.createEl("p", { cls: ["a", "b"] }).className).toBe("a b");
    const el = builders.createEl("p", { cls: "c", text: "<b>not markup</b>" });
    expect(el.className).toBe("c");
    expect(el.textContent).toBe("<b>not markup</b>");
    expect(el.children.length).toBe(0);
  });

  it("takes text as a fragment, moving its nodes in", () => {
    const { builders } = setup();
    const fragment = builders.createFragment((frag) => {
      frag.createSpan({ text: "one" });
      frag.appendText(" two");
    });
    const el = builders.createDiv({ text: fragment });
    expect(el.textContent).toBe("one two");
    expect(el.children.length).toBe(1);
    expect(fragment.childNodes.length).toBe(0);
  });

  it("sets attr values as strings and leaves a null one unset", () => {
    const { builders } = setup();
    const el = builders.createEl("div", { attr: { "data-n": 3, "aria-hidden": true, "data-s": "x", "data-null": null } });
    expect(el.getAttribute("data-n")).toBe("3");
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.getAttribute("data-s")).toBe("x");
    expect(el.hasAttribute("data-null")).toBe(false);
  });

  it("sets title, and value, type and placeholder on an input", () => {
    const { builders } = setup();
    const input = builders.createEl("input", { title: "tip", value: "42", type: "number", placeholder: "n" });
    expect(input.getAttribute("title")).toBe("tip");
    expect(input.value).toBe("42");
    expect(input.type).toBe("number");
    expect(input.placeholder).toBe("n");
  });

  it("ignores value, type, placeholder and href on elements that do not take them", () => {
    const { builders } = setup();
    const div = builders.createDiv({ value: "v", type: "t", placeholder: "p", href: "h" });
    expect(div.hasAttribute("value")).toBe(false);
    expect(div.hasAttribute("type")).toBe(false);
    expect(div.hasAttribute("placeholder")).toBe(false);
    expect(div.hasAttribute("href")).toBe(false);
  });

  it("sets href on a link and a selected value on an option", () => {
    const { builders } = setup();
    expect(builders.createEl("a", { href: "https://example.com/" }).getAttribute("href")).toBe("https://example.com/");
    expect(builders.createEl("option", { value: "dark" }).value).toBe("dark");
  });

  it("sets type on a style element", () => {
    const { builders } = setup();
    expect(builders.createEl("style", { type: "text/css" }).getAttribute("type")).toBe("text/css");
  });

  it("appends to parent, or prepends, after the callback has run", () => {
    const { builders, document } = setup();
    const parent = builders.createDiv();
    const first = builders.createSpan({ parent });
    let parentSeen: N | null | undefined;
    const second = builders.createSpan({ parent, prepend: true }, (el) => {
      parentSeen = el.parentNode;
    });
    expect(parentSeen).toBeNull();
    expect(parent.firstChild).toBe(second);
    expect(parent.childNodes[1]).toBe(first);
    expect(first.ownerDocument).toBe(document);
  });

  it("creates children of a node with node.createEl, createDiv and createSpan", () => {
    const { document } = setup();
    const root = body(document);
    const options: DomElementInfo = { cls: "row" };
    const div = root.createDiv(options);
    const span = div.createSpan("label");
    const heading = div.createEl("h2", { text: "Title", prepend: true });
    expect(div.parentNode).toBe(root);
    expect(div.className).toBe("row");
    expect(span.parentNode).toBe(div);
    expect(span.className).toBe("label");
    expect(div.firstChild).toBe(heading);
    expect(heading.textContent).toBe("Title");
    // The caller's options object is not written into.
    expect(options).toEqual({ cls: "row" });
  });

  it("creates children of a fragment and of the document's own nodes", () => {
    const { builders } = setup();
    const fragment = builders.createFragment();
    expect(fragment.nodeType).toBe(11);
    const div = fragment.createDiv({ text: "in fragment" });
    expect(div.parentNode).toBe(fragment);
  });

  it("calls createFragment's callback with the fragment", () => {
    const { builders } = setup();
    let seen: N | null = null;
    const fragment = builders.createFragment((frag) => {
      seen = frag;
    });
    expect(seen).toBe(fragment);
  });

  it("empties a node of elements and text", () => {
    const { builders } = setup();
    const el = builders.createDiv({ text: "text" });
    el.createSpan();
    el.empty();
    expect(el.childNodes.length).toBe(0);
    expect(el.textContent).toBe("");
  });

  it("detaches a node, and detaching a detached node does nothing", () => {
    const { builders } = setup();
    const parent = builders.createDiv();
    const child = parent.createDiv();
    child.detach();
    expect(child.parentNode).toBeNull();
    expect(parent.childNodes.length).toBe(0);
    expect(() => {
      child.detach();
    }).not.toThrow();
  });

  it("appends text as a text node", () => {
    const { builders } = setup();
    const el = builders.createDiv({ text: "a" });
    el.appendText("<b>");
    expect(el.textContent).toBe("a<b>");
    expect(el.childNodes.length).toBe(2);
    expect(el.childNodes[1]?.nodeType).toBe(3);
  });

  it("adds, removes, toggles and tests classes", () => {
    const { builders } = setup();
    const el = builders.createDiv();
    el.addClass("a", "b", "c");
    expect(el.hasClass("b")).toBe(true);
    el.removeClass("a", "c");
    expect(el.className).toBe("b");
    el.toggleClass("d", true);
    el.toggleClass(["b", "d"], false);
    el.toggleClass(["e", "f"], true);
    expect(el.className).toBe("e f");
    expect(el.hasClass("b")).toBe(false);
  });

  it("returns nothing from the void helpers, as the typings say", () => {
    const { builders } = setup();
    const el = builders.createDiv();
    expect(el.addClass("a")).toBeUndefined();
    expect(el.setText("x")).toBeUndefined();
    expect(el.setAttr("k", "v")).toBeUndefined();
  });

  it("sets text, replacing every child, from a string or a fragment", () => {
    const { builders } = setup();
    const el = builders.createDiv();
    el.createSpan({ text: "old" });
    el.setText("new");
    expect(el.textContent).toBe("new");
    expect(el.children.length).toBe(0);
    const fragment = builders.createFragment((frag) => frag.createEl("b", { text: "bold" }));
    el.setText(fragment);
    expect(el.textContent).toBe("bold");
    expect(el.children.length).toBe(1);
  });

  it("sets an attribute, stringifying it, and removes it on null", () => {
    const { builders } = setup();
    const el = builders.createDiv();
    el.setAttr("data-n", 7);
    el.setAttr("draggable", false);
    expect(el.getAttribute("data-n")).toBe("7");
    expect(el.getAttribute("draggable")).toBe("false");
    el.setAttr("data-n", null);
    expect(el.hasAttribute("data-n")).toBe(false);
  });
});
