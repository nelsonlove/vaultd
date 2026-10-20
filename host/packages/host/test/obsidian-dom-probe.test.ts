/**
 * Obsidian's DOM helpers over each server DOM, against what Obsidian 1.14.4
 * itself built (`host/fixtures/style-settings/expected/dom-probe.json`).
 *
 * The cases are the capture script's (`host/scripts/style-settings-capture.js`,
 * `STEP_DOM_PROBE`), one for one and with the same names, run through a host
 * built with the provider so the helpers are the installed globals and
 * prototype extensions, exactly as a plugin reaches them. Each case's
 * `outerHTML` must equal the capture's.
 */

import { afterEach, describe, expect, it } from "vitest";

import { EXPECTED } from "./style-settings-run";
import { ShimHarness } from "../src/testing/shim-harness";
import { happyDomProvider } from "../src/shim/dom-providers/happy-dom";
import type { DomProvider } from "../src/shim/dom-provider";
import type { DomElementInfo } from "../src/shim/obsidian-dom";

interface P {
  outerHTML: string;
  createEl(tag: string, o?: DomElementInfo | string, callback?: (el: P) => void): P;
  createDiv(o?: DomElementInfo | string, callback?: (el: P) => void): P;
  createSpan(o?: DomElementInfo | string, callback?: (el: P) => void): P;
  appendText(val: string): void;
  appendChild<T>(child: T): T;
  empty(): void;
  addClass(...classes: string[]): void;
  removeClass(...classes: string[]): void;
  toggleClass(classes: string | string[], value: boolean): void;
  hasClass(cls: string): boolean;
  setText(val: string | P): void;
  setAttr(name: string, value: string | number | boolean | null): void;
  remove(): void;
}

/** The global builders, as bare functions: a plugin calls them unbound. */
interface Builders {
  createEl: (tag: string, o?: DomElementInfo, callback?: (el: P) => void) => P;
  createDiv: (o?: DomElementInfo) => P;
  createSpan: (o?: DomElementInfo) => P;
  createFragment: (callback: (fragment: P) => void) => P;
}

/** The capture script's probe, case for case. `attr` deliberately carries `undefined`. */
function probe(host: P, g: Builders): Record<string, () => P | string> {
  const { createEl, createDiv, createSpan, createFragment } = g;
  const fragment = (): P =>
    createFragment((f) => {
      f.createEl("b", { text: "frag" });
      f.appendText(" tail");
    });
  const attrs = { a: null, b: false, c: 0, d: 1, e: "s", f: true, g: undefined } as unknown as NonNullable<DomElementInfo["attr"]>;
  return {
    cls_string: () => createEl("div", { cls: "a b" }),
    cls_array: () => createEl("div", { cls: ["a", "b"] }),
    text_string: () => createEl("div", { text: "hi <b>&amp;" }),
    text_fragment: () => createEl("div", { text: fragment() as never }),
    attr_null_false_number: () => createEl("div", { attr: attrs }),
    title: () => createEl("div", { title: "tip" }),
    value_input: () => createEl("input", { value: "v" }),
    value_div: () => createEl("div", { value: "v" }),
    type_input: () => createEl("input", { type: "checkbox" }),
    placeholder: () => createEl("input", { placeholder: "ph" }),
    href: () => createEl("a", { href: "https://example.invalid/", text: "l" }),
    parent: () => {
      const p = host.createDiv();
      createEl("span", { parent: p as never, text: "kid" });
      return p;
    },
    prepend: () => {
      const p = host.createDiv();
      p.createSpan({ text: "first" });
      p.createSpan({ text: "second", prepend: true });
      return p;
    },
    callback: () => createEl("p", { text: "cb" }, (el) => el.addClass("from-callback")),
    createDiv: () => createDiv({ cls: "d", text: "t" }),
    createSpan: () => createSpan({ cls: "s", text: "t" }),
    el_createEl: () => {
      const p = host.createDiv();
      p.createEl("em", { text: "e" });
      return p;
    },
    setAttr_string: () => {
      const e = createDiv();
      e.setAttr("data-x", "1");
      return e;
    },
    setAttr_null: () => {
      const e = createDiv({ attr: { "data-x": "1" } });
      e.setAttr("data-x", null);
      return e;
    },
    setAttr_false: () => {
      const e = createDiv({ attr: { "data-x": "1" } });
      e.setAttr("data-x", false);
      return e;
    },
    setAttr_zero: () => {
      const e = createDiv();
      e.setAttr("data-x", 0);
      return e;
    },
    setAttr_true: () => {
      const e = createDiv();
      e.setAttr("data-x", true);
      return e;
    },
    setText_string: () => {
      const e = createDiv({ text: "old" });
      e.setText("new");
      return e;
    },
    setText_fragment: () => {
      const e = createDiv({ text: "old" });
      e.setText(fragment());
      return e;
    },
    appendText: () => {
      const e = createDiv({ text: "a" });
      e.appendText("b");
      return e;
    },
    empty: () => {
      const e = createDiv();
      e.createSpan({ text: "x" });
      e.appendText("y");
      e.empty();
      return e;
    },
    addClass_many: () => {
      const e = createDiv();
      e.addClass("a", "b");
      return e;
    },
    removeClass: () => {
      const e = createDiv({ cls: ["a", "b"] });
      e.removeClass("a");
      return e;
    },
    toggleClass_true: () => {
      const e = createDiv();
      e.toggleClass("on", true);
      return e;
    },
    toggleClass_false: () => {
      const e = createDiv({ cls: "on" });
      e.toggleClass("on", false);
      return e;
    },
    toggleClass_array: () => {
      const e = createDiv();
      e.toggleClass(["a", "b"], true);
      return e;
    },
    hasClass: () => String(createDiv({ cls: "a" }).hasClass("a")),
    createFragment_callback: () => {
      const d = createDiv();
      d.appendChild(fragment());
      return d;
    },
  };
}

/**
 * The screen host's one provider. Task 4 also ran linkedom 0.18.13 here and
 * removed it: see the "Task 4 result" in section 2 of the design.
 */
const PROVIDERS: ReadonlyArray<readonly [string, () => DomProvider]> = [["happy-dom", happyDomProvider]];

const live: ShimHarness[] = [];

afterEach(async () => {
  for (const built of live.splice(0).reverse()) {
    await built.teardown();
    await built.stop();
  }
});

describe("the probe", () => {
  it("has exactly the capture's cases", async () => {
    const harness = await ShimHarness.withVault({}, { dom: happyDomProvider() });
    live.push(harness);
    const g = globalThis as unknown as Builders;
    const cases = probe((globalThis as unknown as { document: { body: P } }).document.body, g);
    expect(Object.keys(cases).sort()).toEqual(Object.keys(EXPECTED.domProbe).sort());
  });
});

describe.each(PROVIDERS)("Obsidian's DOM helpers over %s, against Obsidian 1.14.4", (_name, provider) => {
  it.each(Object.keys(EXPECTED.domProbe))("%s", async (name) => {
    const harness = await ShimHarness.withVault({}, { dom: provider() });
    live.push(harness);
    const g = globalThis as unknown as Builders;
    const host = (globalThis as unknown as { document: { body: P } }).document.body.createDiv({ cls: "vaultd-probe-host" });
    const result = probe(host, g)[name]?.();
    host.remove();
    const html = typeof result === "string" ? result : result?.outerHTML;
    expect(html).toBe(EXPECTED.domProbe[name]?.html);
  });
});
