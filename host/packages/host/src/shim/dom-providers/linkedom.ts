/**
 * A {@link DomProvider} over linkedom — a small, fast server DOM.
 *
 * **Loaded only when asked for.** This module is imported by a screen host and
 * by tests, never by the headless path, and linkedom is an optional dependency
 * of this package. It is reached through a literal `require` because the
 * package is an ES module and this package compiles to CommonJS under
 * `module: node16`, where a static `import` of an ES module is a type error;
 * Node 24 loads it synchronously through `require`.
 *
 * The document is a minimal HTML skeleton, which is all Obsidian's own window
 * starts from as far as a plugin can tell: `<html>`, an empty `<head>` and an
 * empty `<body>`.
 */

import { installStyleSheetList } from "../dom-provider";
import type { DomEnvironment, DomProvider, ServerDocument } from "../dom-provider";

/** The slice of linkedom's module this provider uses. */
interface Linkedom {
  parseHTML(html: string): {
    document: ServerDocument;
    Node: { prototype: object };
    Element: { prototype: object };
    HTMLElement: { prototype: object };
    DocumentFragment: { prototype: object };
  };
}

const SKELETON = "<!doctype html><html><head></head><body></body></html>";

export function linkedomProvider(): DomProvider {
  return {
    name: "linkedom",
    create(): DomEnvironment {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- an ES module, loaded lazily; see the header.
      const linkedom = require("linkedom") as Linkedom;
      const window = linkedom.parseHTML(SKELETON);
      installStyleSheetList(window.document);
      return {
        name: "linkedom",
        document: window.document,
        constructors: {
          Node: window.Node,
          Element: window.Element,
          HTMLElement: window.HTMLElement,
          DocumentFragment: window.DocumentFragment,
        },
        close: () => {
          // linkedom holds nothing open: no timers, no sockets, no workers.
        },
      };
    },
  };
}
