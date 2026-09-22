# Detector fixtures

Eight **hand-authored** bundles, written for Task 20's static scanner. None of them is a real plugin: no line here was copied from a shipped bundle, from the golden corpus under `host/fixtures/golden/`, or from any vault. They are the smallest programs that carry the shapes the scanner has to tell apart, so that a failure names the shape rather than a plugin.

```
<case>/
  main.js            the bundle the scanner reads
  ground-truth.json  what the scanner MUST report for it
```

`ground-truth.json` was written **before** the scanner existed. It holds exactly the nine fields `test/detector-scanner.test.ts` compares — `minified`, `apiSymbols`, `lifecycleGates`, `commandIds`, `eventNames`, `frameworks`, `crossPlugin`, `internalPlugins`, `tierEstimate` — and nothing else, because a field nobody asserts is a field nobody maintains.

The eight cases:

| Case | What it pins |
| --- | --- |
| `unminified-tier1` | logic in command callbacks and event handlers, no DOM |
| `minified-tier1` | the same logic, minified — the pair is the whole minification claim |
| `menu-only-tier2` | zero commands, one harvestable `file-menu` hook |
| `dom-delegated-tier2` | zero commands, entry points only through delegated DOM listeners |
| `svelte-tier3` | Svelte's own constants, and settings-authored configuration |
| `react-tier4` | React's own constant, and a body that is view construction |
| `false-friend` | `"vue"` inside a French locale string and `hydration` in a comment, and no framework |
| `indirect-base` | the plugin class extends a local base class that extends `obsidian.Plugin` |

**`minified-tier1/main.js` is generated, not written.** It is `unminified-tier1/main.js` put through the repository's own esbuild:

```
host/node_modules/.bin/esbuild host/fixtures/detector/unminified-tier1/main.js \
  --minify --format=cjs --platform=node \
  --outfile=host/fixtures/detector/minified-tier1/main.js
```

Generated rather than hand-minified so the pair is genuinely the same logic: a scan that reported different API symbols for the two would be reporting the difference between two programs rather than the difference between two builds. Regenerate it with that command if the unminified twin changes, and re-check both ground truths.
