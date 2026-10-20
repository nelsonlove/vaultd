/**
 * A {@link DomProvider} over happy-dom — a fuller server DOM with a window.
 *
 * **Loaded only when asked for**, for the same reasons as the linkedom
 * provider: an optional dependency, an ES module, reached through a literal
 * `require` that Node 24 resolves synchronously.
 *
 * **Everything that would reach outside the process is switched off.** A
 * screen host renders plugin output; it must never run a script a stylesheet
 * set or a plugin put into the document, or fetch a file one names. The
 * settings below are happy-dom's own switches for exactly that.
 */

import { installStyleSheetList } from "../dom-provider";
import type { DomEnvironment, DomProvider, ServerDocument } from "../dom-provider";

/** The slice of happy-dom's `Window` this provider uses. */
interface HappyWindow {
  readonly document: ServerDocument;
  readonly Node: { prototype: object };
  readonly Element: { prototype: object };
  readonly HTMLElement: { prototype: object };
  readonly DocumentFragment: { prototype: object };
  readonly happyDOM: { close(): Promise<void> };
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- an ES module, loaded lazily; see the header.
      const happyDom = require("happy-dom") as HappyDom;
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
