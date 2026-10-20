/**
 * Obsidian's DOM helpers, written against standard DOM only.
 *
 * **The shared DOM half of the stand-in** (task 3 of
 * `docs/design/web-plugins.md`). Obsidian extends `Node.prototype` and
 * `Element.prototype` with a family of helpers — `createEl`, `createDiv`,
 * `empty`, `addClass`, `setText` and the rest — and installs global builders
 * beside them. Plugins build all their markup with these. This module gives
 * the same helpers over any standards DOM: a browser, linkedom or happy-dom.
 *
 * **It imports nothing**, on purpose: no Node module, no host module, no DOM
 * library types. The same file has to run in a browser bundle later (task 10),
 * so everything it touches is reached through the node it is called on, and
 * its types are the structural slices below rather than the DOM library's
 * (this package compiles without that library, because the headless host has
 * no DOM).
 *
 * **Signatures follow Obsidian's published typings** (`obsidian.d.ts` from the
 * `obsidian` package, 1.13.1): `Node` gets `createEl`, `createDiv`,
 * `createSpan`, `empty`, `detach` and `appendText`; `Element` gets `addClass`,
 * `removeClass`, `toggleClass`, `hasClass`, `setText` and `setAttr`; and the
 * globals are `createEl`, `createDiv`, `createSpan` and `createFragment`. The
 * typings give signatures only, so the *behaviour* of each option is the
 * reading of Obsidian's own runtime this file records next to each one; where
 * that reading is uncertain, the comment says so.
 *
 * **Never installed onto the stub document.** The headless host's `StubEl`
 * carries its own inert versions of these, and `installGlobals` calls
 * {@link installObsidianDom} only under a real-DOM provider.
 */

/** The options every builder takes, as `obsidian.d.ts` declares them. */
export interface DomElementInfo {
  /** The class to be assigned: a space-separated string or an array of strings. */
  cls?: string | string[];
  /** The text content, or a fragment whose nodes are moved in. */
  text?: string | DomNode;
  /** Attributes; a `null` value leaves the attribute unset. */
  attr?: { [key: string]: string | number | boolean | null };
  /** The `title` attribute (a hover tooltip). */
  title?: string;
  /** The node to append the new element to. */
  parent?: DomNode;
  value?: string;
  type?: string;
  /** Insert as `parent`'s first child rather than its last. */
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

/** The slice of a standard `Node` these helpers touch. */
export interface DomNode {
  readonly nodeType: number;
  readonly parentNode: DomNode | null;
  readonly firstChild: DomNode | null;
  readonly lastChild: DomNode | null;
  readonly ownerDocument: DomDocument | null;
  textContent: string | null;
  appendChild(child: DomNode): DomNode;
  insertBefore(child: DomNode, reference: DomNode | null): DomNode;
  removeChild(child: DomNode): DomNode;
}

/** The slice of a standard `Element` these helpers touch. */
export interface DomElement extends DomNode {
  readonly tagName: string;
  className: string;
  readonly classList: {
    add(...tokens: string[]): void;
    remove(...tokens: string[]): void;
    contains(token: string): boolean;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** The slice of a standard `Document` these helpers touch. */
export interface DomDocument extends DomNode {
  createElement(tag: string): DomElement;
  createDocumentFragment(): DomNode;
  createTextNode(text: string): DomNode;
}

/** The global builders, bound to one document. */
export interface ObsidianBuilders<E = DomElement, F = DomNode> {
  readonly createEl: (tag: string, o?: DomElementInfo | string, callback?: (el: E) => void) => E;
  readonly createDiv: (o?: DomElementInfo | string, callback?: (el: E) => void) => E;
  readonly createSpan: (o?: DomElementInfo | string, callback?: (el: E) => void) => E;
  readonly createFragment: (callback?: (fragment: F) => void) => F;
}

/**
 * How a property is put on its target. The host passes its own, which
 * remembers the previous descriptor so a restore can put it back; a browser
 * takes the default.
 */
export type DefineProperty = (target: object, key: string, value: unknown, enumerable: boolean) => void;

/** Where {@link installObsidianDom} puts things. */
export interface ObsidianDomScope {
  readonly Node: { readonly prototype: object };
  readonly Element: { readonly prototype: object };
  /** The document the global builders create in. */
  readonly document: unknown;
  /** Where the global builders go: `globalThis`, or a browser's `window`. */
  readonly global: object;
}

const DOCUMENT_NODE = 9;

/** A plain, writable, configurable property. */
const defineDefault: DefineProperty = (target, key, value, enumerable) => {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable });
};

/**
 * Install the prototype extensions and the global builders, and return the
 * builders.
 *
 * The prototype extensions are **non-enumerable**, so they never join a
 * `for…in` over a node; the global builders are enumerable, as the host's
 * other globals are.
 */
export function installObsidianDom(scope: ObsidianDomScope, define: DefineProperty = defineDefault): ObsidianBuilders {
  for (const [key, value] of Object.entries(NODE_EXTENSIONS)) define(scope.Node.prototype, key, value, false);
  for (const [key, value] of Object.entries(ELEMENT_EXTENSIONS)) define(scope.Element.prototype, key, value, false);
  const builders = obsidianBuilders(scope.document as DomDocument);
  for (const [key, value] of Object.entries(builders)) define(scope.global, key, value, true);
  return builders;
}

/** The global builders, over one document. */
export function obsidianBuilders(document: DomDocument): ObsidianBuilders {
  return {
    createEl: (tag, o, callback) => buildElement(document, tag, normalise(o), callback),
    createDiv: (o, callback) => buildElement(document, "div", normalise(o), callback),
    createSpan: (o, callback) => buildElement(document, "span", normalise(o), callback),
    createFragment: (callback) => {
      const fragment = document.createDocumentFragment();
      callback?.(fragment);
      return fragment;
    },
  };
}

/** A string option is the class, as in Obsidian. */
function normalise(o: DomElementInfo | string | undefined): DomElementInfo {
  return typeof o === "string" ? { cls: o } : (o ?? {});
}

/**
 * Obsidian's `createEl`, in the order its runtime applies the options: class,
 * text, attributes, title, the element-specific four, then the callback, and
 * the insertion into `parent` last — so a callback sees the element before it
 * is in the tree.
 */
function buildElement(
  document: DomDocument,
  tag: string,
  info: DomElementInfo,
  callback: ((el: DomElement) => void) | undefined,
): DomElement {
  const el = document.createElement(tag);
  if (info.cls !== undefined) el.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
  if (info.text !== undefined) setText.call(el, info.text);
  if (info.attr !== undefined) {
    for (const [name, value] of Object.entries(info.attr)) setAttr.call(el, name, value);
  }
  if (info.title !== undefined) el.setAttribute("title", info.title);
  const kind = el.tagName.toUpperCase();
  // `value` is the *property*, not the attribute: on an input it is the current
  // value, and on a select it has no attribute at all. Obsidian sets it on
  // inputs, selects and options only.
  if (info.value !== undefined && (kind === "INPUT" || kind === "SELECT" || kind === "OPTION")) {
    (el as DomElement & { value: string }).value = info.value;
  }
  if (info.type !== undefined && (kind === "INPUT" || kind === "STYLE")) el.setAttribute("type", info.type);
  if (info.placeholder !== undefined && kind === "INPUT") el.setAttribute("placeholder", info.placeholder);
  if (info.href !== undefined && (kind === "A" || kind === "LINK" || kind === "BASE")) {
    el.setAttribute("href", info.href);
  }
  callback?.(el);
  if (info.parent !== undefined) {
    if (info.prepend === true) info.parent.insertBefore(el, info.parent.firstChild);
    else info.parent.appendChild(el);
  }
  return el;
}

/** The document a node creates in: itself, if it is one. */
function documentOf(node: DomNode): DomDocument {
  if (node.nodeType === DOCUMENT_NODE) return node as DomDocument;
  if (node.ownerDocument === null) throw new TypeError("this node belongs to no document");
  return node.ownerDocument;
}

/** `node.createEl(tag, o)`: a new child of `node`. The caller's options are not written into. */
function createElOn(node: DomNode, tag: string, o: DomElementInfo | string | undefined, callback?: (el: DomElement) => void): DomElement {
  return buildElement(documentOf(node), tag, { ...normalise(o), parent: node }, callback);
}

/**
 * `setText`: a string becomes the text content; a fragment replaces every
 * child with its own nodes. The typings allow only those two. Any other node is
 * put in as the one child, where Obsidian would stringify it — a deliberate
 * difference, since `"[object HTMLElement]"` is never what a caller meant.
 */
function setText(this: DomNode, val: string | DomNode): void {
  if (typeof val === "string") {
    this.textContent = val;
    return;
  }
  empty.call(this);
  this.appendChild(val);
}

/**
 * `setAttr`: a `null` removes the attribute, anything else is stringified —
 * `false` becomes `"false"`, as `setAttribute` itself would make it. Obsidian's
 * typings allow `boolean`; that `false` is written rather than removed is this
 * file's reading of Obsidian's runtime, and is unverified.
 */
function setAttr(this: DomElement, name: string, value: string | number | boolean | null): void {
  if (value === null) this.removeAttribute(name);
  else this.setAttribute(name, String(value));
}

function empty(this: DomNode): void {
  while (this.lastChild !== null) this.removeChild(this.lastChild);
}

/** Methods on `Node.prototype`. */
const NODE_EXTENSIONS: Record<string, unknown> = {
  createEl(this: DomNode, tag: string, o?: DomElementInfo | string, callback?: (el: DomElement) => void): DomElement {
    return createElOn(this, tag, o, callback);
  },
  createDiv(this: DomNode, o?: DomElementInfo | string, callback?: (el: DomElement) => void): DomElement {
    return createElOn(this, "div", o, callback);
  },
  createSpan(this: DomNode, o?: DomElementInfo | string, callback?: (el: DomElement) => void): DomElement {
    return createElOn(this, "span", o, callback);
  },
  empty,
  detach(this: DomNode): void {
    this.parentNode?.removeChild(this);
  },
  appendText(this: DomNode, val: string): void {
    this.appendChild(documentOf(this).createTextNode(val));
  },
};

/** Methods on `Element.prototype`. */
const ELEMENT_EXTENSIONS: Record<string, unknown> = {
  addClass(this: DomElement, ...classes: string[]): void {
    this.classList.add(...classes);
  },
  removeClass(this: DomElement, ...classes: string[]): void {
    this.classList.remove(...classes);
  },
  toggleClass(this: DomElement, classes: string | string[], value: boolean): void {
    const list = Array.isArray(classes) ? classes : [classes];
    if (value) this.classList.add(...list);
    else this.classList.remove(...list);
  },
  hasClass(this: DomElement, cls: string): boolean {
    return this.classList.contains(cls);
  },
  setText,
  setAttr,
};
