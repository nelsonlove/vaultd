/**
 * The DOM this host does not have.
 *
 * **One hand-rolled class, and deliberately not jsdom.** jsdom is a large
 * dependency whose whole purpose is to behave *almost* like a browser, and
 * "almost" is the failure mode this phase exists to avoid: a plugin whose
 * layout code half-works against a fake document produces a compatibility
 * report that says it is fine. What is here cannot be mistaken for a browser.
 * Every method answers with `this` or with a fresh {@link StubEl}, every
 * collection getter answers `[]`, every query answers `null` or `[]`, and
 * nothing is ever attached to anything.
 *
 * **Empty collections, never `undefined`.** That is the one rule the corpus
 * research found plugins break on: `getFileExplorer()` early-returns on an
 * empty list and disables its features cleanly, while `undefined.length`
 * throws inside `onload` and takes the whole plugin with it. It applies to
 * `children`, `childNodes`, `querySelectorAll`, `findAll` and every other
 * plural here.
 *
 * **Nothing is a tree.** `createEl` hands back a detached element and forgets
 * it; `children` is therefore always empty even straight after a `createDiv`.
 * A host that kept the tree would be keeping a model nobody renders and nobody
 * queries — the queries all answer `null` — so it would cost memory to make
 * the stub *look* more real without making any plugin work better. The one
 * thing that is really stored is the text, because a harvested menu title is
 * read back out of `textContent`.
 *
 * **What is not here is a finding, not a bug to paper over.** The class has an
 * explicit member list rather than a catch-all proxy, so a plugin that reaches
 * for a member this list does not have fails visibly and lands in the
 * compatibility report instead of being silently swallowed. That is the
 * opposite of the choice `shim/plugin.ts` makes for the element
 * `addRibbonIcon` returns, and the difference is intentional: that one is a
 * value handed *to* a plugin mid-`onload`, where a throw costs the whole load
 * and the host learns nothing.
 */

import { declarePolicy, stub } from "./policy";

/**
 * The family symbol every element call is recorded under.
 *
 * One row rather than forty. A compatibility report that listed `addClass`,
 * `setAttr`, `createSpan` and thirty-seven siblings separately would bury the
 * one fact a reader wants — *this plugin builds DOM, and none of it is real* —
 * under rows nobody can act on individually. The free functions below keep
 * their own rows because a plugin may call `setIcon` without ever touching an
 * element.
 */
const ELEMENT_SYMBOL = "HTMLElement";

/** Obsidian's `DomElementInfo`, as much of it as anything here reads. */
export interface ElInfo {
  cls?: string | string[];
  text?: string | StubEl;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  value?: string;
  type?: string;
  placeholder?: string;
  href?: string;
  parent?: StubEl | null;
  prepend?: boolean;
}

/** The text of whatever a caller passed as `text`. */
function textOf(value: string | StubEl | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.textContent;
}

/**
 * An element, a node, a fragment and a text node — all of them this.
 *
 * The four constructors the globals install (`Node`, `Element`, `HTMLElement`,
 * `DocumentFragment`) collapse onto one class because nothing this host does
 * distinguishes them: plugins use the names for `instanceof` branches, and one
 * class answers those branches without four layers that differ in nothing.
 * {@link StubFragment} is the one exception, because `x instanceof
 * DocumentFragment` is a branch plugins take to mean "this is not an element",
 * and answering `true` for a `div` there would send them down the wrong arm.
 */
export class StubEl {
  /** `1` — an element, as far as any plugin's `nodeType` check is concerned. */
  readonly nodeType: number = 1;
  readonly tagName: string;
  readonly nodeName: string;
  /** Really stored: `Menu.setTitle` reads a title back out of a fragment. */
  textContent = "";
  className = "";
  id = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  /** Always empty — see the header: nothing here is a tree. */
  readonly classList = new StubClassList();

  constructor(tag = "div", info?: ElInfo) {
    this.tagName = tag.toUpperCase();
    this.nodeName = this.tagName;
    if (info !== undefined) this.applyInfo(info);
  }

  // -- the collections, all empty, none of them `undefined` ----------------

  get children(): StubEl[] {
    return [];
  }

  get childNodes(): StubEl[] {
    return [];
  }

  get firstChild(): StubEl | null {
    return null;
  }

  get lastChild(): StubEl | null {
    return null;
  }

  get firstElementChild(): StubEl | null {
    return null;
  }

  get lastElementChild(): StubEl | null {
    return null;
  }

  get parentNode(): StubEl | null {
    return null;
  }

  get parentElement(): StubEl | null {
    return null;
  }

  get innerHTML(): string {
    return "";
  }

  set innerHTML(value: string) {
    void value;
    this.hit();
  }

  get innerText(): string {
    return this.textContent;
  }

  set innerText(value: string) {
    this.textContent = value;
  }

  get offsetWidth(): number {
    return 0;
  }

  get offsetHeight(): number {
    return 0;
  }

  get clientWidth(): number {
    return 0;
  }

  get clientHeight(): number {
    return 0;
  }

  get scrollHeight(): number {
    return 0;
  }

  scrollTop = 0;
  scrollLeft = 0;

  // -- Obsidian's element extensions ---------------------------------------

  createEl(tag: string, info?: ElInfo, callback?: (el: StubEl) => unknown): StubEl {
    this.hit();
    const created = new StubEl(tag, info);
    callback?.(created);
    return created;
  }

  createDiv(info?: ElInfo | string, callback?: (el: StubEl) => unknown): StubEl {
    return this.createEl("div", infoOf(info), callback);
  }

  createSpan(info?: ElInfo | string, callback?: (el: StubEl) => unknown): StubEl {
    return this.createEl("span", infoOf(info), callback);
  }

  createSvg(tag: string, info?: ElInfo): StubEl {
    return this.createEl(tag, info);
  }

  setText(text: string | StubEl): this {
    this.hit();
    this.textContent = textOf(text);
    return this;
  }

  getText(): string {
    this.hit();
    return this.textContent;
  }

  appendText(text: string): this {
    this.hit();
    this.textContent += text;
    return this;
  }

  /**
   * Chainable, and Obsidian's own is not.
   *
   * Uncaptured: no runtime capture of `Element.addClass`'s return value exists
   * in this repository, so the shim takes the shape that cannot break a
   * caller. A plugin that chains works; a plugin that ignores the return value
   * — which is every plugin written against a `void` signature — is unaffected.
   */
  addClass(...classes: string[]): this {
    this.hit();
    for (const name of classes) this.classList.add(name);
    return this;
  }

  addClasses(classes: string[]): this {
    return this.addClass(...classes);
  }

  removeClass(...classes: string[]): this {
    this.hit();
    for (const name of classes) this.classList.remove(name);
    return this;
  }

  removeClasses(classes: string[]): this {
    return this.removeClass(...classes);
  }

  toggleClass(classes: string | string[], value?: boolean): this {
    this.hit();
    const names = typeof classes === "string" ? [classes] : classes;
    for (const name of names) this.classList.toggle(name, value);
    return this;
  }

  hasClass(name: string): boolean {
    this.hit();
    return this.classList.contains(name);
  }

  setAttr(name: string, value: string | number | boolean | null): this {
    this.hit();
    if (name === "id" && typeof value === "string") this.id = value;
    if (name === "class" && typeof value === "string") this.className = value;
    return this;
  }

  setAttrs(attrs: Record<string, string | number | boolean | null>): this {
    for (const [name, value] of Object.entries(attrs)) this.setAttr(name, value);
    return this;
  }

  getAttr(name: string): string | null {
    void name;
    return stub(ELEMENT_SYMBOL, null);
  }

  setAttribute(name: string, value: string): void {
    this.setAttr(name, value);
  }

  getAttribute(name: string): string | null {
    return this.getAttr(name);
  }

  removeAttribute(name: string): void {
    void name;
    this.hit();
  }

  hasAttribute(name: string): boolean {
    void name;
    return stub(ELEMENT_SYMBOL, false);
  }

  setCssStyles(styles: Record<string, string>): void {
    this.hit();
    Object.assign(this.style, styles);
  }

  setCssProps(props: Record<string, string>): void {
    this.setCssStyles(props);
  }

  /** Removes nothing, because nothing was ever attached. */
  detach(): this {
    this.hit();
    return this;
  }

  remove(): void {
    this.hit();
  }

  empty(): this {
    this.hit();
    this.textContent = "";
    return this;
  }

  appendChild(child: StubEl): StubEl {
    this.hit();
    return child;
  }

  removeChild(child: StubEl): StubEl {
    this.hit();
    return child;
  }

  insertBefore(child: StubEl, before?: StubEl | null): StubEl {
    void before;
    this.hit();
    return child;
  }

  replaceChild(next: StubEl, previous: StubEl): StubEl {
    void next;
    this.hit();
    return previous;
  }

  append(...children: unknown[]): void {
    void children;
    this.hit();
  }

  prepend(...children: unknown[]): void {
    void children;
    this.hit();
  }

  replaceChildren(...children: unknown[]): void {
    void children;
    this.hit();
  }

  insertAdjacentHTML(position: string, html: string): void {
    void position;
    void html;
    this.hit();
  }

  cloneNode(deep?: boolean): StubEl {
    void deep;
    this.hit();
    const copy = new StubEl(this.tagName);
    copy.textContent = this.textContent;
    return copy;
  }

  hasChildNodes(): boolean {
    return stub(ELEMENT_SYMBOL, false);
  }

  normalize(): void {
    this.hit();
  }

  // -- the queries, all empty ----------------------------------------------

  querySelector(selector: string): StubEl | null {
    void selector;
    return stub(ELEMENT_SYMBOL, null);
  }

  querySelectorAll(selector: string): StubEl[] {
    void selector;
    return stub(ELEMENT_SYMBOL, []);
  }

  find(selector: string): StubEl | null {
    return this.querySelector(selector);
  }

  findAll(selector: string): StubEl[] {
    return this.querySelectorAll(selector);
  }

  findAllSelf(selector: string): StubEl[] {
    return this.querySelectorAll(selector);
  }

  closest(selector: string): StubEl | null {
    return this.querySelector(selector);
  }

  matches(selector: string): boolean {
    void selector;
    return stub(ELEMENT_SYMBOL, false);
  }

  contains(node: unknown): boolean {
    void node;
    return stub(ELEMENT_SYMBOL, false);
  }

  getBoundingClientRect(): {
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    x: number;
    y: number;
  } {
    return stub(ELEMENT_SYMBOL, {
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
    });
  }

  // -- events and focus, all inert -----------------------------------------

  addEventListener(...args: unknown[]): void {
    void args;
    this.hit();
  }

  removeEventListener(...args: unknown[]): void {
    void args;
    this.hit();
  }

  dispatchEvent(event: unknown): boolean {
    void event;
    return stub(ELEMENT_SYMBOL, true);
  }

  /** Obsidian's delegated-listener helpers: accepted, never delivered from. */
  on(...args: unknown[]): void {
    void args;
    this.hit();
  }

  off(...args: unknown[]): void {
    void args;
    this.hit();
  }

  onClickEvent(handler: unknown): this {
    void handler;
    this.hit();
    return this;
  }

  onNodeInserted(handler: unknown): () => void {
    void handler;
    return stub(ELEMENT_SYMBOL, () => undefined);
  }

  show(): this {
    this.hidden = false;
    return this;
  }

  hide(): this {
    this.hidden = true;
    return this;
  }

  toggle(shown: boolean): this {
    this.hidden = !shown;
    return this;
  }

  toggleVisibility(shown: boolean): this {
    return this.toggle(shown);
  }

  focus(): void {
    this.hit();
  }

  blur(): void {
    this.hit();
  }

  click(): void {
    this.hit();
  }

  select(): void {
    this.hit();
  }

  scrollIntoView(options?: unknown): void {
    void options;
    this.hit();
  }

  instanceOf(type: unknown): boolean {
    return typeof type === "function" && this instanceof (type as new () => unknown);
  }

  /** One recorded touch of the element family, against the running plugin. */
  private hit(): void {
    stub(ELEMENT_SYMBOL, undefined);
  }

  private applyInfo(info: ElInfo): void {
    if (info.cls !== undefined) this.addClass(...(typeof info.cls === "string" ? info.cls.split(" ") : info.cls));
    if (info.text !== undefined) this.textContent = textOf(info.text);
    if (info.attr !== undefined) this.setAttrs(info.attr);
    if (info.value !== undefined) this.value = info.value;
  }
}

/**
 * `DocumentFragment`, and the one subclass this file has.
 *
 * A plugin branching on `x instanceof DocumentFragment` means "this is a bag
 * of nodes, not an element", so the branch has to be able to answer `false`
 * for an ordinary `div`.
 */
export class StubFragment extends StubEl {
  override readonly nodeType = 11;

  constructor() {
    super("#document-fragment");
  }
}

/** `classList`, which really remembers — a plugin may read a class back. */
export class StubClassList {
  private readonly names = new Set<string>();

  get length(): number {
    return this.names.size;
  }

  add(...names: string[]): void {
    for (const name of names) if (name !== "") this.names.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.names.has(name);
    if (next) this.names.add(name);
    else this.names.delete(name);
    return next;
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }

  item(index: number): string | null {
    return [...this.names][index] ?? null;
  }

  values(): string[] {
    return [...this.names];
  }
}

/** Accept Obsidian's `createDiv("cls")` shorthand as well as the info object. */
function infoOf(info: ElInfo | string | undefined): ElInfo | undefined {
  if (info === undefined) return undefined;
  return typeof info === "string" ? { cls: info } : info;
}

// ---------------------------------------------------------------------------
// The free functions — globals in Obsidian, and members of the `obsidian`
// barrel besides.
// ---------------------------------------------------------------------------

export function createEl(tag: string, info?: ElInfo, callback?: (el: StubEl) => unknown): StubEl {
  const created = new StubEl(tag, info);
  callback?.(created);
  return stub("createEl", created);
}

export function createDiv(info?: ElInfo | string, callback?: (el: StubEl) => unknown): StubEl {
  const created = new StubEl("div", infoOf(info));
  callback?.(created);
  return stub("createDiv", created);
}

export function createSpan(info?: ElInfo | string, callback?: (el: StubEl) => unknown): StubEl {
  const created = new StubEl("span", infoOf(info));
  callback?.(created);
  return stub("createSpan", created);
}

export function createFragment(callback?: (fragment: StubFragment) => unknown): StubFragment {
  const fragment = new StubFragment();
  callback?.(fragment);
  return stub("createFragment", fragment);
}

/**
 * `setIcon(el, name)` — accepted, and nothing is drawn.
 *
 * Its own row rather than the element family's, because a plugin can reach it
 * without building any DOM of its own: it is handed the element a ribbon or a
 * menu gave it. The report reads better for the separation — "this plugin
 * wants icons" is a different fact from "this plugin builds DOM".
 */
export function setIcon(element: unknown, icon: string): void {
  void element;
  void icon;
  stub("setIcon", undefined);
}

/** `getIcon(name)` — there is no icon to hand back. */
export function getIcon(icon: string): StubEl | null {
  void icon;
  return stub("getIcon", null);
}

/**
 * The document, as inert as the elements.
 *
 * `body`, `head` and `documentElement` are real {@link StubEl}s rather than
 * the document itself, because a plugin appends to `document.body` and would
 * otherwise be appending to the thing it queries.
 */
export interface StubDocument {
  readonly nodeType: number;
  readonly body: StubEl;
  readonly head: StubEl;
  readonly documentElement: StubEl;
  readonly activeElement: StubEl | null;
  readonly readyState: string;
  defaultView: unknown;
  createElement(tag: string): StubEl;
  createDocumentFragment(): StubFragment;
  createTextNode(text: string): StubEl;
  querySelector(selector: string): StubEl | null;
  querySelectorAll(selector: string): StubEl[];
  getElementById(id: string): StubEl | null;
  getElementsByClassName(name: string): StubEl[];
  getElementsByTagName(name: string): StubEl[];
  addEventListener(...args: unknown[]): void;
  removeEventListener(...args: unknown[]): void;
  dispatchEvent(event: unknown): boolean;
  on(...args: unknown[]): void;
  off(...args: unknown[]): void;
}

export function createStubDocument(): StubDocument {
  const body = new StubEl("body");
  return {
    nodeType: 9,
    body,
    head: new StubEl("head"),
    documentElement: new StubEl("html"),
    activeElement: null,
    readyState: "complete",
    defaultView: null,
    createElement: (tag) => new StubEl(tag),
    createDocumentFragment: () => new StubFragment(),
    createTextNode: (text) => {
      const node = new StubEl("#text");
      node.textContent = text;
      return node;
    },
    querySelector: () => stub("document", null),
    querySelectorAll: () => stub("document", []),
    getElementById: () => stub("document", null),
    getElementsByClassName: () => stub("document", []),
    getElementsByTagName: () => stub("document", []),
    addEventListener: () => {
      stub("document", undefined);
    },
    removeEventListener: () => {
      stub("document", undefined);
    },
    dispatchEvent: () => stub("document", true),
    on: () => {
      stub("document", undefined);
    },
    off: () => {
      stub("document", undefined);
    },
  };
}

// The rows this file owns, declared at module scope so a compatibility report
// can be generated with nothing constructed and no vault open.
declarePolicy(ELEMENT_SYMBOL, "safe_stub");
declarePolicy("createEl", "safe_stub");
declarePolicy("createDiv", "safe_stub");
declarePolicy("createSpan", "safe_stub");
declarePolicy("createFragment", "safe_stub");
declarePolicy("setIcon", "safe_stub");
declarePolicy("getIcon", "safe_stub");
declarePolicy("document", "safe_stub");
