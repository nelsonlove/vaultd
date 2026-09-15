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
  text?: string | StubNode;
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
function textOf(value: string | StubNode | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.textContent;
}

/**
 * Everything a node can do, which here is everything.
 *
 * **The whole surface lives on the base class on purpose.** Obsidian's DOM
 * extensions are installed on `Node.prototype`, not on `HTMLElement.prototype`
 * — which is why `createFragment().createEl("span")` works in Obsidian — so a
 * host that put them on the element class would break the fragment builders
 * plugins write. Putting them here reproduces that by construction.
 *
 * The three classes below it are thin on purpose too: they exist to answer
 * `instanceof`, which is the only thing a plugin does with these names.
 * `globals.ts` installs {@link StubNode} as `Node`, {@link StubEl} as both
 * `Element` and `HTMLElement` — nothing this host does distinguishes those two
 * — and {@link StubFragment} as `DocumentFragment`. So the two branches a
 * plugin actually writes both answer as they would in a browser: an element is
 * a `Node` and an `HTMLElement` and not a `DocumentFragment`, and a fragment is
 * a `Node` and a `DocumentFragment` and not an `HTMLElement`.
 */
export class StubNode {
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
  /** Really remembers, so a plugin can read a class back off an element. */
  readonly classList = new StubClassList();
  /**
   * Really remembers too, for the same reason.
   *
   * A half-measure is worse than either end: an earlier draft wrote `id` and
   * `class` through to their fields and answered `getAttr` with `null`, so a
   * plugin that set an attribute and read it back got nothing. Everything set
   * is readable, and `id`/`className` stay in step because plugins reach them
   * both ways.
   */
  private readonly attributes = new Map<string, string>();

  constructor(tag = "div", info?: ElInfo) {
    this.tagName = tag.toUpperCase();
    this.nodeName = this.tagName;
    if (info !== undefined) this.applyInfo(info);
  }

  // -- the collections, all empty: nothing here is a tree -------------------

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

  setText(text: string | StubNode): this {
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
    // `null` removes, which is what a browser's `setAttribute(name, null)`
    // does not do but what Obsidian's own `setAttr` is used for.
    if (value === null) {
      this.attributes.delete(name);
      return this;
    }
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "id") this.id = text;
    if (name === "class") this.className = text;
    return this;
  }

  setAttrs(attrs: Record<string, string | number | boolean | null>): this {
    for (const [name, value] of Object.entries(attrs)) this.setAttr(name, value);
    return this;
  }

  getAttr(name: string): string | null {
    this.hit();
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.setAttr(name, value);
  }

  getAttribute(name: string): string | null {
    return this.getAttr(name);
  }

  removeAttribute(name: string): void {
    this.hit();
    this.attributes.delete(name);
    if (name === "id") this.id = "";
    if (name === "class") this.className = "";
  }

  hasAttribute(name: string): boolean {
    this.hit();
    return this.attributes.has(name);
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

  /**
   * Obsidian's delegated-listener helper: accepted, recorded, never delivered
   * from.
   *
   * `Node.on(type, selector, handler)` is Obsidian's own prototype extension
   * and it is how a plugin attaches behaviour to elements it never created —
   * tag-wrangler's whole surface is ten of these, wrapped in one three-argument
   * helper. There is no DOM to delegate through, so the registration is
   * structurally unreachable, and the honest thing to do with it is write it
   * down: {@link setDelegatedListenerSink} is where it goes, and the compat
   * report says "ten entry points this host cannot reach" instead of silence.
   */
  on(...args: unknown[]): void {
    this.hit();
    if (typeof args[0] === "string") delegated?.add(args[0], args[1], args[2]);
  }

  off(...args: unknown[]): void {
    this.hit();
    if (typeof args[0] === "string") delegated?.remove(args[0], args[1], args[2]);
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
 * `Element` and `HTMLElement` — the same class, because nothing this host does
 * tells the two apart and plugins use both names only as `instanceof` targets.
 *
 * It adds nothing to {@link StubNode}: the whole surface is on the base,
 * because Obsidian installs its DOM extensions on `Node.prototype` and a
 * fragment builder depends on that.
 */
export class StubEl extends StubNode {}

/**
 * `DocumentFragment` — a sibling of {@link StubEl}, not a subclass of it.
 *
 * A plugin branching `if (x instanceof HTMLElement) … else if (x instanceof
 * DocumentFragment)` writes those two tests in that order, so a fragment that
 * answered `true` to the first would take the element arm and never reach its
 * own. Sibling classes under one `Node` are what make both tests answer the way
 * a browser answers them.
 */
export class StubFragment extends StubNode {
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

/**
 * `getIcon(name)` — an element for an icon a plugin added, and `null` otherwise.
 *
 * The two halves are deliberate. Obsidian's built-in icon set is
 * **uncaptured**, so a name this host never saw registered answers `null`: a
 * plugin told "yes, that icon exists" would go on to place something this host
 * cannot draw. But an icon the plugin registered itself through {@link addIcon}
 * really is known, and answering `null` for that one would tell a plugin its
 * own icon failed to register — which is the single thing {@link addedIcons}
 * exists to prevent, and which {@link getIconIds} already contradicts.
 */
export function getIcon(icon: string): StubEl | null {
  const svg = addedIcons.get(icon);
  if (svg === undefined) return stub("getIcon", null);
  const element = new StubEl("svg", { cls: `svg-icon ${icon}` });
  element.setAttr("data-icon", icon);
  element.innerHTML = svg;
  return stub("getIcon", element);
}

/**
 * The icons plugins have added, by name.
 *
 * Really remembered, even though nothing draws them: {@link getIconIds} is how
 * a plugin checks whether its own icon registered, and a registry that forgot
 * would make a plugin register the same icon on every load — or, worse, take a
 * "the icon is missing" branch that does something else instead.
 */
const addedIcons = new Map<string, string>();

/** `addIcon(name, svg)` — recorded, and nothing is drawn. */
export function addIcon(name: string, svgContent: string): void {
  addedIcons.set(name, svgContent);
  stub("addIcon", undefined);
}

/**
 * Every icon id this host knows, which is every one a plugin added.
 *
 * Obsidian's answer also contains its own built-in set, and that set is
 * **uncaptured** — nothing in the corpus records it. Inventing a list would be
 * worse than a short one: a plugin that tests `getIconIds().includes("lucide-x")`
 * and gets `false` skips an icon, while one that gets a `true` this host cannot
 * back goes on to use a name nothing here can draw.
 */
export function getIconIds(): string[] {
  return stub("getIconIds", [...addedIcons.keys()]);
}

/** `removeIcon(name)` — really forgets an icon a plugin added. */
export function removeIcon(iconId: string): void {
  addedIcons.delete(iconId);
  stub("removeIcon", undefined);
}

/** `displayTooltip(el, content)` — the imperative spelling; nothing to hover. */
export function displayTooltip(element: unknown, content: unknown, options?: unknown): void {
  void element;
  void content;
  void options;
  stub("displayTooltip", undefined);
}

/** `setTooltip(el, text)` — there is nothing to hover. */
export function setTooltip(element: unknown, tooltip: string, options?: unknown): void {
  void element;
  void tooltip;
  void options;
  stub("setTooltip", undefined);
}

/**
 * `sanitizeHTMLToDom(html)` — a fragment carrying the text, and no markup.
 *
 * There is no parser here, so the tags cannot become nodes. The **text** is
 * kept rather than dropped, because the calls in the corpus build a notice or a
 * label out of this and then read it back: an empty fragment turns a message
 * into a blank, while the text alone is the message with its formatting lost.
 */
export function sanitizeHTMLToDom(html: string): StubFragment {
  const fragment = new StubFragment();
  fragment.setText(decodeEntities(html.replace(/<[^>]*>/g, "")));
  return stub("sanitizeHTMLToDom", fragment);
}

/**
 * The five XML entities, decoded, plus numeric references.
 *
 * A browser's parser decodes them on the way in, so a plugin that built
 * `"Tom &amp; Jerry"` and read the text back sees `"Tom & Jerry"` in Obsidian
 * and would have seen a literal `&amp;` here. Five is the whole set that
 * matters; the wider named-entity table is one this host has no reason to
 * carry, and `&amp;` is decoded **last** so `&amp;lt;` stays `&lt;`.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");
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

/**
 * Where a listener nothing will ever deliver to is written down.
 *
 * An interface rather than the `Harvest` itself, because this module knows
 * nothing about plugins or attribution: `globals.ts` owns the one
 * implementation and hands it in, so a `document` listener and a `window`
 * listener land in the same place, under the same kind, with the same
 * withdrawal rule. A document built without one still accepts listeners — it
 * simply has nobody to tell.
 */
export interface DomListenerSink {
  add(type: string, listener: unknown): void;
  remove(type: string, listener: unknown): void;
}

/**
 * Where a **delegated** listener is written down — `Node.on(type, selector,
 * handler)`, Obsidian's own prototype extension.
 *
 * A separate seam from {@link DomListenerSink}, and a separate harvest kind,
 * because the two are different offers: `addEventListener` binds a handler to
 * the element it is called on, while `on` binds a handler to *every future
 * element matching a selector*, which is how a plugin attaches to parts of the
 * UI it never built. A report that merged them could not say how much of a
 * plugin's surface is delegated — which for tag-wrangler is all of it.
 */
export interface DelegatedListenerSink {
  add(type: string, selector: unknown, handler: unknown): void;
  remove(type: string, selector: unknown, handler: unknown): void;
}

/**
 * Module-level, like the policy table and for the same reason: `on` is a method
 * on a class instantiated everywhere, several layers below anything that holds a
 * reference to the host, so there is no parameter to thread it through. One host
 * per process makes one sink the right sink; `globals.ts` installs it beside the
 * `window` listener recorder and takes it down again on restore.
 */
let delegated: DelegatedListenerSink | null = null;

export function setDelegatedListenerSink(sink: DelegatedListenerSink | null): void {
  delegated = sink;
}

export function createStubDocument(listeners?: DomListenerSink): StubDocument {
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
    addEventListener: (...args: unknown[]) => {
      stub("document", undefined);
      if (typeof args[0] === "string") listeners?.add(args[0], args[1]);
    },
    removeEventListener: (...args: unknown[]) => {
      stub("document", undefined);
      if (typeof args[0] === "string") listeners?.remove(args[0], args[1]);
    },
    dispatchEvent: () => stub("document", true),
    // Delegated from the document itself, which is where a plugin puts a
    // listener meant to survive every re-render. Recorded exactly as an
    // element's is — same sink, same kind — so a report does not depend on
    // which node a plugin happened to delegate from.
    on: (...args: unknown[]) => {
      stub("document", undefined);
      if (typeof args[0] === "string") delegated?.add(args[0], args[1], args[2]);
    },
    off: (...args: unknown[]) => {
      stub("document", undefined);
      if (typeof args[0] === "string") delegated?.remove(args[0], args[1], args[2]);
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
declarePolicy("addIcon", "safe_stub");
declarePolicy("removeIcon", "safe_stub");
declarePolicy("getIconIds", "safe_stub");
declarePolicy("setTooltip", "safe_stub");
declarePolicy("displayTooltip", "safe_stub");
declarePolicy("sanitizeHTMLToDom", "safe_stub");
declarePolicy("document", "safe_stub");
