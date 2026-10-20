/**
 * A {@link DomProvider} over happy-dom — a fuller server DOM with a window,
 * and the screen host's one provider (task 4 of `docs/design/web-plugins.md`).
 *
 * **Loaded only when asked for.** This module is imported by a screen host and
 * by tests, never by the headless path, and happy-dom is an optional
 * dependency of this package. It is reached through a literal `require`
 * because the package is an ES module and this package compiles to CommonJS
 * under `module: node16`, where a static `import` of an ES module is a type
 * error; Node 24 loads it synchronously through `require`.
 *
 * **Everything that would reach outside the process is switched off.** A
 * screen host renders plugin output; it must never run a script a stylesheet
 * set or a plugin put into the document, or fetch a file one names. The
 * settings below are happy-dom's own switches for exactly that.
 */

import { installStyleSheetList, loadOptionalDom } from "../dom-provider";
import type { ComputedStyle, DomEnvironment, DomProvider, ServerDocument } from "../dom-provider";

/** The slice of happy-dom's `Window` this provider uses. */
interface HappyWindow {
  readonly document: ServerDocument;
  readonly Node: { prototype: object };
  readonly Element: { prototype: object };
  readonly HTMLElement: { prototype: object };
  readonly DocumentFragment: { prototype: object };
  readonly happyDOM: { close(): Promise<void> };
  getComputedStyle(element: unknown): ComputedStyle;
}

/** The slice of an element the inheritance walk reads. */
interface WalkedElement {
  readonly parentElement: WalkedElement | null;
}

interface HappyDom {
  Window: new (options?: { settings?: Record<string, unknown> }) => HappyWindow;
}

const SETTINGS = {
  disableJavaScriptEvaluation: true,
  disableJavaScriptFileLoading: true,
  disableCSSFileLoading: true,
  disableIframePageLoading: true,
};

export function happyDomProvider(): DomProvider {
  return {
    name: "happy-dom",
    create(): DomEnvironment {
      const happyDom = loadOptionalDom<HappyDom>("happy-dom", () =>
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- an ES module, loaded lazily; see the header.
        require("happy-dom"),
      );
      const window = new happyDom.Window({ settings: SETTINGS });
      installStyleSheetList(window.document);
      return {
        name: "happy-dom",
        document: window.document,
        constructors: {
          Node: window.Node,
          Element: window.Element,
          HTMLElement: window.HTMLElement,
          DocumentFragment: window.DocumentFragment,
        },
        getComputedStyle: (element) => inheritingCustomProperties(window, element),
        close: () => {
          // Asynchronous in happy-dom, and nothing waits on it: closing only
          // aborts the window's pending tasks, and a host that is restoring its
          // globals has none it still wants.
          window.happyDOM.close().catch(() => undefined);
        },
      };
    },
  };
}

/**
 * happy-dom's `getComputedStyle`, with custom properties inherited.
 *
 * **Measured on 20.14.5:** happy-dom cascades an element's own matching rules
 * (selector specificity and source order included), but a custom property set
 * on an ancestor reads as `""` on a descendant. In a browser every custom
 * property inherits, and Style Settings depends on that: it reads
 * `--<end colour>` from two `<div>`s it appends to `body`, which carry no rule
 * of their own. So for a name that starts with `--`, the first non-empty value
 * on the element or an ancestor is the answer, which is what inheritance gives
 * when nothing in the chain says `initial` or `inherit`. Every other property is
 * happy-dom's answer unchanged.
 */
function inheritingCustomProperties(window: HappyWindow, element: unknown): ComputedStyle {
  const style = window.getComputedStyle(element);
  const own = style.getPropertyValue.bind(style);
  Object.defineProperty(style, "getPropertyValue", {
    configurable: true,
    value: (name: string): string => {
      if (!name.startsWith("--")) return own(name);
      for (let node = element as WalkedElement | null; node !== null; node = node.parentElement) {
        const value = node === element ? own(name) : window.getComputedStyle(node).getPropertyValue(name);
        if (value !== "") return value;
      }
      return "";
    },
  });
  return style;
}
