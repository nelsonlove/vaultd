/**
 * Time and memory of the stock Style Settings apply over one server DOM.
 * **Manual**: skipped unless `VAULTD_DOM_BENCH` names a provider, and run once
 * per provider so each is measured in a process of its own (the first load of
 * a DOM library is part of what it costs):
 *
 * ```bash
 * VAULTD_DOM_BENCH=happy-dom npm --prefix host test -- style-settings-dom-bench.manual
 * ```
 *
 * - **Load to apply**: from the start of `loadBundle` (compile, construct,
 *   `onload`) to the end of the first apply, median of 20 runs after 3 warm-up
 *   runs. The plugin's 100 ms debounce is driven by the test clock, so it is not
 *   in the figure; Obsidian's own figure includes it.
 * - **Heap and RSS added**: one host with the provider, the plugin loaded and
 *   applied, against one host with the stub document, each measured after a
 *   full GC.
 *
 * A provider with no `getComputedStyle` is given one that answers `""`, so the
 * apply completes and the timing compares like with like; that is generous to
 * it, since its output is then missing the gradient.
 */

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { runStyleSettings } from "./style-settings-run";
import { ShimHarness } from "../src/testing/shim-harness";
import { happyDomProvider } from "../src/shim/dom-providers/happy-dom";
import type { DomProvider } from "../src/shim/dom-provider";

const PROVIDERS: Record<string, () => DomProvider> = {
  "happy-dom": happyDomProvider,
};

const chosen = process.env.VAULTD_DOM_BENCH;
const factory = chosen === undefined ? undefined : PROVIDERS[chosen];

function completing(provider: DomProvider): DomProvider {
  return {
    name: provider.name,
    create: () => {
      const env = provider.create();
      return env.getComputedStyle === undefined
        ? { ...env, getComputedStyle: () => ({ getPropertyValue: () => "" }) }
        : env;
    },
  };
}

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

function settled(): NodeJS.MemoryUsage {
  for (let i = 0; i < 3; i += 1) gc();
  return process.memoryUsage();
}

const MB = 1024 * 1024;

describe.skipIf(factory === undefined)(`Style Settings over ${chosen ?? "(none)"}`, () => {
  it("reports load-to-apply time and memory added", async () => {
    const make = (): DomProvider => completing((factory as () => DomProvider)());

    const stub = await ShimHarness.withVault({});
    const before = settled();
    const kept = await runStyleSettings(make(), "dark");
    const after = settled();
    expect(kept.styleText).not.toBeNull();
    await kept.harness.teardown();
    await kept.harness.stop();
    await stub.stop();

    const times: number[] = [];
    for (let i = 0; i < 23; i += 1) {
      const done = await runStyleSettings(make(), i % 2 === 0 ? "dark" : "light");
      if (i >= 3) times.push(done.loadToApplyMs);
      await done.harness.teardown();
      await done.harness.stop();
    }
    times.sort((a, b) => a - b);
    const median = ((times[9] ?? 0) + (times[10] ?? 0)) / 2;
    console.log(
      JSON.stringify({
        provider: chosen,
        runs: times.length,
        loadToApplyMedianMs: Number(median.toFixed(2)),
        loadToApplyMinMs: Number((times[0] ?? 0).toFixed(2)),
        loadToApplyMaxMs: Number((times[times.length - 1] ?? 0).toFixed(2)),
        heapAddedMB: Number(((after.heapUsed - before.heapUsed) / MB).toFixed(2)),
        rssAddedMB: Number(((after.rss - before.rss) / MB).toFixed(2)),
      }),
    );
  }, 120_000);
});
