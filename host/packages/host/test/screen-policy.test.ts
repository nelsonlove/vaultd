/**
 * The screen profile's policy rows (task 6 of `docs/design/web-plugins.md`;
 * the ruling of tasks 2-3 deferred them here).
 *
 * A screen host implements the DOM symbols over a real server DOM, so its
 * column reads `implemented` where the headless column reads `safe_stub`. The
 * headless rows do not change, and a symbol with no screen row reads as its
 * headless row.
 */

import { describe, expect, it } from "vitest";

import "../src/screen/apply-service";
import "../src/shim/dom-provider";
import "../src/shim/api";
import "../src/shim/globals";
import { declaredSymbols, policyOf, screenSymbols } from "../src/shim/policy";

const IMPLEMENTED_ON_SCREEN = [
  "document",
  "activeDocument",
  "self",
  "getComputedStyle",
  "Node",
  "Element",
  "HTMLElement",
  "DocumentFragment",
  "createEl",
  "createDiv",
  "createSpan",
  "createFragment",
  "Node.createEl",
  "Node.createDiv",
  "Node.createSpan",
  "Node.empty",
  "Node.detach",
  "Node.appendText",
  "Element.addClass",
  "Element.removeClass",
  "Element.toggleClass",
  "Element.hasClass",
  "Element.setText",
  "Element.setAttr",
];

describe("the screen profile's policy column", () => {
  it.each(IMPLEMENTED_ON_SCREEN)("implements %s", (symbol) => {
    expect(policyOf(symbol, "screen")).toBe("implemented");
  });

  it("stubs the view surface Style Settings unloads through", () => {
    expect(policyOf("Workspace.detachLeavesOfType", "screen")).toBe("safe_stub");
  });

  it("leaves the headless rows as they were", () => {
    for (const symbol of ["document", "activeDocument", "Node", "Element", "DocumentFragment", "createEl", "createDiv"]) {
      expect(policyOf(symbol)).toBe("safe_stub");
      expect(policyOf(symbol, "headless")).toBe("safe_stub");
    }
    // The screen-only globals and the screen workspace stub have no headless row.
    for (const symbol of ["self", "getComputedStyle", "Workspace.detachLeavesOfType"]) {
      expect(declaredSymbols()).not.toContain(symbol);
      expect(policyOf(symbol)).toBe("absent");
    }
  });

  it("falls back to the headless row for a symbol with no screen row", () => {
    for (const symbol of ["Plugin", "Workspace.getLeavesOfType", "localStorage", "window.require"]) {
      expect(screenSymbols()).not.toContain(symbol);
      expect(policyOf(symbol, "screen")).toBe(policyOf(symbol));
    }
  });

  it("declares exactly the rows the profile implements", () => {
    expect([...screenSymbols()].sort()).toEqual([...IMPLEMENTED_ON_SCREEN, "Workspace.detachLeavesOfType"].sort());
  });
});
