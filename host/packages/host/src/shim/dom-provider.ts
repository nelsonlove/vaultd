/**
 * The DOM provider seam: what a host installs behind `document`.
 *
 * **Two profiles, one shim.** The headless host installs the inert stub
 * document from `dom.ts`, on purpose — a host that behaved almost like a
 * browser would hide the cases its compatibility report exists to surface — and
 * it gets that by passing no provider at all, so nothing about it changes. A
 * *screen* host (the second profile in `docs/design/web-plugins.md`, owner
 * decision 1) runs plugins whose surface is the screen, such as Style Settings,
 * and those need a real document: a `head` to append a `<style>` to, a `body`
 * whose classes stick, and a `document.styleSheets` to walk. That host passes
 * a {@link DomProvider}, and `installGlobals` puts the provider's document and
 * node constructors where the stub's would have gone.
 *
 * **Providers live in their own modules** (`dom-providers/linkedom.ts`,
 * `dom-providers/happy-dom.ts`) and nothing in the headless path imports them,
 * so a headless host never loads a server DOM and does not need one installed;
 * both libraries are optional dependencies of this package. Both are offered
 * until task 4 of the design picks one by measurement.
 */

/**
 * The part of a server DOM's document this host's own code relies on.
 *
 * Structural rather than the standard `Document` type, because this package is
 * compiled without the DOM library (the headless host has no DOM, and its
 * types say so). A plugin sees the whole real document; these are only the
 * members the seam itself touches.
 */
export interface ServerDocument {
  readonly head: unknown;
  readonly body: unknown;
  createElement(tag: string): unknown;
  querySelectorAll(selectors: string): ArrayLike<unknown>;
}

/** One built document and the constructors that go with it. */
export interface DomEnvironment {
  /** The provider's name, for reports and errors: `linkedom`, `happy-dom`. */
  readonly name: string;
  readonly document: ServerDocument;
  /**
   * The node constructors a plugin reaches as bare globals: `Node`, `Element`,
   * `HTMLElement` and `DocumentFragment` — the same four names the stub
   * installs, so the policy table's rows are the same set under either
   * profile. Their prototypes are where Obsidian's DOM extensions go.
   */
  readonly constructors: {
    readonly Node: { readonly prototype: object };
    readonly Element: { readonly prototype: object };
    readonly HTMLElement: { readonly prototype: object };
    readonly DocumentFragment: { readonly prototype: object };
  };
  /** Release whatever the library holds open. Called on restore. */
  close(): void;
}

/** Builds a fresh {@link DomEnvironment}, once per installation. */
export interface DomProvider {
  readonly name: string;
  create(): DomEnvironment;
}

/** What `document.styleSheets` hands a plugin: array-like, iterable, `item(i)`. */
export interface ServerStyleSheetList extends ReadonlyArray<ServerStyleSheet> {
  item(index: number): ServerStyleSheet | null;
}

/** The members of a `CSSStyleSheet` the seam guarantees. */
export interface ServerStyleSheet {
  readonly ownerNode: unknown;
}

/** The selector for the elements a browser makes a style sheet for. */
const SHEET_OWNERS = 'style, link[rel~="stylesheet"]';

/**
 * Give a server document a browser's `document.styleSheets`.
 *
 * **Neither library has one that Style Settings can use**, measured on the
 * pinned versions: linkedom has no `document.styleSheets` at all, and
 * happy-dom's sheets carry no `ownerNode` — and `ownerNode.textContent` is the
 * one thing the plugin reads from a sheet. So both providers install this
 * getter on their document instance.
 *
 * **Read fresh on every access, in document order**, which is what a browser's
 * live list gives a caller that reads `length` and then `item(i)`: every
 * connected `<style>` element and every `<link rel="stylesheet">`, and nothing
 * that is not in the document. The library's own sheet object is used where it
 * has one, with `ownerNode` added when it lacks it; a `<link>` with no sheet
 * (linkedom loads nothing) gets a minimal one with `ownerNode` and empty
 * `cssRules`, which is what a cross-origin sheet looks like to a script.
 */
export function installStyleSheetList(document: ServerDocument): void {
  Object.defineProperty(document, "styleSheets", {
    configurable: true,
    enumerable: true,
    get(): ServerStyleSheetList {
      const sheets = Array.from(document.querySelectorAll(SHEET_OWNERS), sheetFor);
      return Object.assign(sheets, {
        item: (index: number): ServerStyleSheet | null => sheets[index] ?? null,
      });
    },
  });
}

function sheetFor(owner: unknown): ServerStyleSheet {
  const native = (owner as { sheet?: unknown }).sheet;
  if (typeof native !== "object" || native === null) return { ownerNode: owner, cssRules: [] } as ServerStyleSheet;
  if ((native as { ownerNode?: unknown }).ownerNode !== owner) {
    Object.defineProperty(native, "ownerNode", { value: owner, configurable: true, enumerable: true });
  }
  return native as ServerStyleSheet;
}

/**
 * Load a server-DOM library, or say plainly that it is not installed.
 *
 * Both libraries are **optional** dependencies of this package: the headless
 * host never needs them, so an install without optional dependencies is a
 * valid headless install. A screen host on such an install would otherwise
 * fail with Node's bare `MODULE_NOT_FOUND`; this names the package and the
 * profile that needs it. Any other failure is passed through unchanged.
 *
 * `load` is the provider's own literal `require`, passed in so the specifier
 * stays a literal at the call site.
 */
export function loadOptionalDom<T>(name: string, load: () => unknown): T {
  try {
    return load() as T;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : "";
    if (code === "MODULE_NOT_FOUND" && message.includes(`'${name}'`)) {
      throw new Error(
        `the screen host profile needs the optional dependency "${name}", which is not installed; ` +
          `install it in host/ (npm install, without --omit=optional) or pick another DOM provider`,
        { cause: error },
      );
    }
    throw error;
  }
}
