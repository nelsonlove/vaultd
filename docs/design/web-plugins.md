# Stock plugins with a screen surface in vaultd-web — Style Settings first (DRAFT)

## Status

Draft for the owner's cut. Nothing here is accepted. It designs how an unchanged Obsidian community plugin that touches the screen runs in vaultd-web (`spikes/htmx-client/server.js`), using Style Settings 1.0.9 as the first case. The headless host (`host/`, [design](headless-plugin-host.md)) is the starting point and is not changed by this document; where this design needs something from it, the section says so. Edge cases go to issue #10, tagged (a) design gap or (b) missing API.

Evidence: the release bundle of Style Settings 1.0.9 (`main.js` 154,561 bytes, `styles.css` 13,906 bytes, `manifest.json`; downloaded to `target/tmp/style-settings/`, never committed), its source at tag `1.0.9` (`src/main.ts`, `src/SettingsManager.ts`, `src/settingsView/**`, `src/Utils.ts`, `src/lang/helpers.ts`), the shipped host shim (`host/packages/host/src/shim/`), and the web spike. The bundle is esbuild CommonJS and its only external `require` is `"obsidian"` (17 sites); Pickr (the colour picker), chroma-js, js-yaml, detect-indent and fuzzysort are bundled inside it.

## What the plugin does, in the order it does it

`onload` reads its saved values with `loadData()`, constructs a `CSSSettingsManager` that appends a `<style id="css-settings-manager">` to `document.getElementsByTagName('head')[0]`, adds a settings tab, registers a view and a command, listens to `app.workspace.on('css-change')` and `on('parse-style-settings')`, appends two hidden reference elements to `document.body` (`.theme-light.style-settings-ref` and `.theme-dark.style-settings-ref`), adds the class `css-settings-manager` to `body`, and calls `parseCSS()`.

`parseCSS()` is debounced: it arms `activeWindow.setTimeout(…, 100)`. When that fires it walks `document.styleSheets`, reads each sheet's `ownerNode.textContent`, finds every `/* @settings … */` block by regular expression, parses the YAML in it, and builds the section list. It then removes the class-toggle commands it added last time (through the undocumented `app.commands.removeCommand`), removes the classes it set last time, hands the list to the settings tab and to any open settings view, maps the config, sets `body` classes for class toggles and class selects, writes the CSS variables into its `<style>` element through `innerText`, raises `app.workspace.trigger('css-change', { source: 'style-settings' })` (which its own listener ignores), and adds one command per class toggle that asks for one.

Two facts from this order matter for every placement. First, **only `<style>` elements are read**: a `<link>` stylesheet has an empty `textContent`, so the plugin finds no settings in it. Obsidian loads themes, snippets and plugins' `styles.css` as `<style>` elements; the web spike loads them as `<link>`. Second, **`setConfig` can save during load**: if the saved data holds a key whose section exists but whose setting no longer does, it deletes the key and calls `saveData` with no user action.

The output of an apply is fully described by three things: the set of `body` classes the plugin added, the text of `<style id="css-settings-manager">`, and the class `css-settings-manager` on `body`. Theme mode (light or dark) does not need a re-run, because the themed variables are written under `body.theme-light.css-settings-manager` and `body.theme-dark.css-settings-manager` selectors.

## 1. The API surface Style Settings needs

"Host today" is the shipped `vaultd-host` shim and its policy from `shim/api.ts` and `declarePolicy` rows. "Needed" is what the stand-in must give for the web. The plugin does not use `app.customCss`; it learns about stylesheet changes only through `css-change`.

| Symbol | What the plugin does with it | Host today (policy) | Needed for the web |
| --- | --- | --- | --- |
| `Plugin` base, `onload`/`onunload`, `addChild`/`removeChild` (`Component`) | lifecycle; the settings markup is a child component | implemented | reuse as is |
| `Plugin.loadData` / `saveData` | read the 84-key value map; save on every change and on a prune at load | implemented, to `<hostConfigDir>/plugins/<id>/data.json` through vaultd | redirect per deployment (section 3) |
| `Plugin.addSettingTab`, `PluginSettingTab` (`containerEl`, `display`, `hide`) | the settings UI | harvested (recorded, never rendered) | real: `display()` into a real container in the web settings modal |
| `Plugin.addCommand`, `app.commands.removeCommand` | "Show style settings view" plus one command per class toggle; removed and re-added on each parse | implemented (`CommandRegistry.removeCommand` exists) | reuse; the web has no command palette yet, so commands are recorded only |
| `Plugin.registerView`, `ItemView`, `WorkspaceLeaf`, `workspace.getLeaf('tab')`, `getLeavesOfType`, `detachLeavesOfType`, `leaf.setViewState` | the optional settings view in a tab | safe-stub (`getLeavesOfType` answers `[]`) | safe-stub; the settings tab is the one surface |
| `app.workspace.on('css-change')`, `on('parse-style-settings')`, `trigger('css-change')` | re-parse when stylesheets change; announce its own change | implemented (`Events`) | reuse; the stand-in must raise `css-change` (section 4) |
| `app.workspace.onLayoutReady` | push settings to open views | implemented | reuse |
| `app.plugins.plugins['settings-search']`, `workspace.on('settings-search-loaded')`, `window.SettingsSearch` | optional integration with another plugin | implemented (registry) | reuse; the integration stays dormant |
| `activeWindow.setTimeout` / `clearTimeout` | the 100 ms parse debounce | implemented over the host clock | server: drive the clock so the apply completes without a real wait; browser: real timers |
| `activeWindow.requestAnimationFrame` | select the colour field when Pickr opens | absent (not on the host `window`) | browser: real; server: not reached |
| `document.styleSheets`, `sheet.ownerNode.textContent` | find `@settings` blocks | absent (the stub document has no `styleSheets`, so `.length` throws) | real list of `<style>` elements in Obsidian's order |
| `document.getElementsByTagName('head')[0].appendChild`, `document.createElement('style')`, `styleTag.innerText =` | the output `<style>` | stub answers `[]`, so `[0].appendChild` throws in the manager's constructor | real `head`, real element, `innerText` setter |
| `document.body.classList` add/remove | class toggles, class selects, `css-settings-manager` | safe-stub that remembers | real |
| `document.body.createDiv`, `createEl`, `createSpan`, `createDiv`, `createFragment`, `el.empty`, `addClass`, `toggleClass`, `setText`, `appendText`, `dataset`, `style.setProperty`, `remove` | building the settings markup and the reference elements | safe-stub family (`HTMLElement` row), nothing is a tree | real: Obsidian's DOM extensions on `Node.prototype` over a real DOM |
| `getComputedStyle(el).getPropertyValue('--x')` | only for a `color-gradient` setting whose end colour is not itself a setting | not installed (bare `ReferenceError`) | browser: real; server: see edge case E3 |
| `document.createTextNode`, `addEventListener('click' / 'change')` | markup and controls | stub | real (browser) |
| `Setting` (`setName`, `setDesc`, `setClass`, `setHeading`, `setTooltip`, `then`, `nameEl`, `descEl`, `controlEl`, `settingEl`, `addSearch`, `addText`, `addToggle`, `addDropdown`, `addSlider`, `addExtraButton`) | every row of the settings UI | harvested | real, rendering Obsidian's `setting-item` markup |
| `TextComponent`, `TextAreaComponent`, `SearchComponent`, `ToggleComponent`, `DropdownComponent`, `SliderComponent` (`setLimits`, `setDynamicTooltip`), `ButtonComponent`, `ExtraButtonComponent` (`setIcon`, `setTooltip`, `onClick`) | controls | safe-stub | real |
| `setIcon` | reset, collapse and other icons | safe-stub | real (Lucide subset the spike already inlines, extended) |
| `debounce` | search box and text inputs | implemented | reuse |
| `Modal` (`onOpen`, `contentEl`, `open`, `close`) | Import and Export dialogs | safe-stub | real (browser) |
| `MarkdownRenderer.renderMarkdown` | `info-text` settings with `markdown: true` | absent | edge case E5 |
| `document.execCommand('copy')` | Export "copy to clipboard" | stub | browser: real |
| `window.localStorage.getItem('language')` | locale, read once at module load | implemented (host store) | browser: real; server: host store, `en` by default |
| Pickr (bundled, not an Obsidian API) | colour pickers; needs layout, pointer events and `requestAnimationFrame` | n/a | browser only |

What the table says in one line: the **apply** half needs a small real document (head, body, style elements, classes, a stylesheet list) plus the existing app half; the **settings UI** half needs a real browser DOM, real `Setting` and component classes, `Modal`, and Pickr's layout.

## 2. Placement options

**(A) Everything in the browser.** The page loads a browser build of the stand-in (`obsidian` module plus `app`) and the plugin's `main.js`; `loadData`/`saveData` and vault reads go to the server over HTTP. Per page view: the browser downloads (once, then cached) about 155 KB of plugin plus the stand-in, evaluates it, fetches the text of each stylesheet, waits the plugin's 100 ms debounce, parses the theme's YAML, then changes `body` classes and variables, which forces a full restyle after first paint. That is a visible flash on every full load unless the stand-in caches the last output and applies it before first paint. Note navigation is an htmx swap, so the cost is paid once per page load, not per note. Per settings change: local, one frame plus a background save. Memory: nothing on the server. Kindle-class client: needs a JavaScript engine strong enough for the bundle; a client without one gets no Style Settings at all. Shared with the headless host: the app half could be shared only if it is split from its Node dependencies (`Buffer`, the socket client, `Module._load`), which it is not today. Fidelity: highest, because it is a browser, as in Obsidian.

**(B) Everything on the server.** A screen-capable host instance per web server runs the plugin against a server-side DOM (linkedom or happy-dom) and ships `body` classes, the `<style>` text, and the rendered settings markup. Per page view: a cache lookup once the output for that stylesheet set and value map is known; the output is in the first HTML byte, so no restyle and no client script. Per settings change: a round trip in which the server replays the event on its DOM, reruns the plugin's handler, and returns the new markup and style; Pickr cannot run without layout, so colour settings fall back to a plain text field or do not work. Memory: one document and one plugin instance per active context (a few MB; to be measured). Kindle-class client: full support for the applied look, and a server-rendered settings form without colour pickers. Shared with the headless host: the whole app half, with a DOM provider swapped in. Fidelity: high for the apply (it is the same code over a standards DOM), low for the UI.

**(C) Split: apply on the server, settings UI in the browser.** Stage 1 is (B)'s apply: the server runs the stock plugin on a server DOM, caches the output per (stylesheet set, value map), and writes the classes and the `<style id="css-settings-manager">` into the page it serves. Stage 2 is (A)'s UI, loaded only when the viewer opens the plugin's tab in the settings modal: the browser loads the stand-in and `main.js`, takes over the server's output (removes the server-rendered `<style>` and classes as its own appear), and from then on applies changes locally and saves them to the server. Per page view: (B)'s cost. Per settings change: (A)'s cost. Memory: (B)'s. Kindle-class client: the applied look always; the settings UI only where the browser can run it. Shared with the headless host: the app half on the server; the DOM half (Obsidian's `Node.prototype` extensions, `Setting`, components, `Modal`, `setIcon`) is one source used in both the browser and the server DOM. Fidelity: the apply runs the same plugin code in both places, and the UI runs in a real browser.

**Recommendation for the first build: (C).** It is the fastest on the measure that happens most (page load), it is the only option that gives a Kindle-class client the applied look with no client script, and it keeps the settings UI in a real browser where Pickr and layout work. The parts that carry to a deployment that picks differently are: the DOM half of the stand-in (written against standard DOM, so it runs in any browser and over any server DOM), the data store interface (section 3), the stylesheet-set builder that puts sheets in Obsidian's order as `<style>` elements, and the `css-change` raiser. A browser-only deployment drops the server apply; a server-only deployment (a terminal-class client) drops the browser UI and renders the settings tab to markup over the same server DOM.

**Where the server apply runs.** Not inside the headless host process: that process installs an inert stub `document` and `window` as process globals on purpose ("cannot be mistaken for a browser"), and other headless plugins depend on that. The screen host is a second host profile — the same shim with a DOM provider seam in `globals.ts` that installs a real server DOM instead of `StubDocument` — run as its own instance beside the web server and loading only plugins whose surface is the screen. This needs one new seam in the host (the DOM provider) and one new dependency (a server DOM).

**Where isolation will bite (not solved now).** `document` and `window` are process globals in the host, and the plugin reads `document` at call time, so one host instance can hold one live plugin instance at a time. The first build runs one context per screen host and, on a cache miss, reloads the plugin (`onunload`, then `onload` with the new sheet set and value map), serialised through the dispatch queue. With several viewers who each hold their own values, misses queue behind each other; the cache hides that while values change rarely. Before there are several active viewers, this needs either a context per worker thread or per-context globals.

## 3. Data writes

`loadData` and `saveData` are methods of the stand-in's `Plugin` base class, which the plugin inherits and does not override, so redirecting them changes no plugin byte. The base class calls a **plugin data store** chosen by the deployment: `vault` (today's host behaviour: the host's own config directory through vaultd), `viewer` (below), or `browser` (the page's `localStorage`, for a deployment with no server state).

The default for the Orange deployment is `viewer`. A read returns the vault's `.obsidian/plugins/obsidian-style-settings/data.json` (read through vaultd, never written) with the viewer's overlay applied. A write computes a JSON merge patch (RFC 7396) of the saved document against the vault document as read at that moment and stores only that patch, in the web server's state directory outside the vault, keyed by viewer and plugin id. "Use vault settings" deletes the patch. Storing a patch rather than a copy is what keeps a viewer current: when the owner changes a value in desktop Obsidian, every viewer who did not override that key sees the new value, and the prune-save at load (which writes with no user action) records only the keys it removed rather than freezing a full copy. Nothing in this path writes the vault's `data.json`, so neither a running desktop Obsidian nor Obsidian Sync ever sees a web write.

A viewer is identified by the `Tailscale-User-Login` header that `tailscale serve` adds when it is present, else by a random id in a cookie. The viewer's appearance override (theme, mode, snippets, font size), which the spike keeps in `localStorage` today, must move to the same store (or a cookie mirror of it): the server apply needs the viewer's effective stylesheet set before it can render the page, and it cannot read the browser's `localStorage`.

## 4. Events

The plugin re-parses on `css-change` with any source other than its own. The stand-in raises it at the one place that knows the stylesheet set changed, after the new text is in the document:

- **Server.** The stylesheet set for a context is computed from the effective appearance (vault `appearance.json` plus the viewer's override), the theme file, the enabled snippet files and enabled plugins' `styles.css`. A change to any of these (a vaultd file event under `.obsidian/`, or the viewer changing an appearance setting) yields a new set key; on the next render for that key the screen host rebuilds the `<style>` elements, raises `app.workspace.trigger('css-change')`, advances its clock past the 100 ms debounce, and reads the output.
- **Browser.** The spike's `apply()` in `CLIENT_JS` already changes the theme and snippets. When the stand-in is loaded, `apply()` loads each sheet's text (an ordinary `fetch` that hits the HTTP cache), replaces the `<link>` with a `<style>` holding that text in the same position (Obsidian's own form, which the plugin needs), and then raises `css-change`. A mode switch only toggles `theme-light`/`theme-dark` and raises nothing, as in Obsidian.

## 5. Performance

Measure the same three things in desktop Obsidian (same vault, Minimal plus the owner's snippets and 84 values) and in vaultd-web on the same Mac, and later on a phone and on a Kindle-class browser:

1. **Page load with the plugin applied:** from navigation start to the first paint that already carries the plugin's classes and variables, and the count of restyles after first paint. Obsidian's comparable figure is from plugin `onload` to the end of `setCSSVariables` (it includes the 100 ms debounce). Target: server time added per page under 5 ms on a cache hit, zero client script for the apply, zero restyles after first paint; a cache miss under Obsidian's own onload-to-apply time.
2. **Settings open:** from the click on the plugin's tab to all sections rendered. Target: no slower than Obsidian's `display()` on the same theme; the first open in a session includes loading the stand-in and `main.js`, and that load is measured and reported separately.
3. **One change applied:** from a control change to the new variables taking effect on screen. Target: within one frame (16 ms) in the browser, with the save to the server in the background and off the critical path.

Each figure is reported as a median of repeated runs with the run count, as the existing baselines in `docs/performance/` are.

## 6. Tasks

Stage 1 — apply the saved values on every page:

1. **Parity capture.** In a live Obsidian, with a fixture vault holding a small theme with an `@settings` block (class toggle, class select, variable number, text, select, colour, themed colour, and one gradient), a snippet with its own block, and a `data.json`, record the resulting `body` class list and the text of `#css-settings-manager`. Commit the fixture and the capture. Test: the capture files exist and name the Obsidian version.
2. **DOM provider seam in the host.** `globals.ts` takes a DOM provider; the default stays `StubDocument`, so the headless host is unchanged. Test: the full host suite passes unchanged; a test host built with a real-DOM provider exposes a working `document.head`, `body.classList` and `styleSheets`.
3. **Shared DOM half of the stand-in.** Obsidian's `Node.prototype` extensions (`createEl`, `createDiv`, `createSpan`, `empty`, `addClass`, `toggleClass`, `setText`, `appendText`) and `createFragment`, written against standard DOM. Test: unit tests over the chosen server DOM.
4. **Server DOM choice.** Run the stock `main.js` against linkedom and against happy-dom with the fixture of task 1; pick the one that reproduces the capture with less load time and memory. Test: the capture is reproduced byte for byte (after whitespace normalisation the plugin itself applies).
5. **Viewer data store.** The `viewer` store with the merge-patch overlay, the vault read through vaultd, and the viewer id. Test: a write stores only the patch; a vault change to a key the viewer did not override is seen; no write reaches the vault (the host's fs write guard counts zero).
6. **Apply service and cache.** The screen host builds the stylesheet set in Obsidian's order as `<style>` elements, loads the plugin, drives the debounce, and returns (classes, style text) cached by (set key, value revision). Test: the fixture capture is reproduced through the service; a second request for the same key does not reload the plugin.
7. **Render into the page.** The web server writes the classes onto `<body>` and the `<style id="css-settings-manager">` into the head, and moves the viewer's appearance override to the server store. Test: the smoke test sees the classes and the style in the first HTML response, and a viewer's theme change yields the matching output.
8. **Events.** A vaultd event under `.obsidian/` (theme, snippet, `appearance.json`, the plugin's `data.json`) invalidates the affected cache entries. Test: changing a snippet's `@settings` block changes the next page's output.
9. **Measure stage 1** against Obsidian (section 5, item 1) and record the numbers.

Stage 2 — the plugin's own settings UI in the web settings modal, changes kept per viewer:

10. **Browser build of the stand-in.** The DOM half from task 3 plus a browser app half whose data calls go to `GET/PUT /plugin-data/<id>` (the `viewer` store), and real `Setting`, components, `setIcon` and `Modal`. Test: the stock `main.js` loads in a headless browser and its `onload` completes with no unsupported-symbol report.
11. **Hand-over.** On load in the browser, `<link>` sheets become `<style>` sheets in place, the server-rendered output is removed as the plugin's own appears, and the page shows no change in computed style across the hand-over. Test: a computed-style snapshot of a fixture page before and after the hand-over is equal.
12. **Settings tab in the modal.** The web settings modal gains a vertical tab per harvested settings tab; opening it calls `display()` into the tab's container, closing it calls `hide()`. Test: the fixture's sections render with Obsidian's `setting-item` markup; a toggle change updates `body` at once and stores a patch.
13. **Colour pickers, Import and Export.** Pickr with the plugin's own `styles.css` loaded; the Import and Export modals. Test: a colour change applies and is stored; an Export then Import round-trips the values.
14. **Measure stage 2** (section 5, items 2 and 3) and record the numbers.

## 7. Edge-case log seeds for #10

- **E1 (a).** The plugin reads only `<style>` elements (`ownerNode.textContent`), and the web client loads stylesheets as `<link>`. The design now builds stylesheet sets as `<style>` elements on the server and converts `<link>` to `<style>` in the browser before raising `css-change`.
- **E2 (a).** The viewer's appearance override lives in the browser's `localStorage`, which a server-side apply cannot read. The override moves to the server's per-viewer store (or a cookie mirror).
- **E3 (b).** `getComputedStyle(…).getPropertyValue('--x')` for a `color-gradient` whose end colour is not a setting needs the cascade; a server DOM does not compute it faithfully. Server apply resolves the variable from the parsed stylesheets for the `body`, `.theme-light` and `.theme-dark` selectors only, and a gradient it cannot resolve is reported, not guessed.
- **E4 (a).** `setConfig` calls `saveData` during load when stored keys no longer match the theme's settings. Under a per-viewer store that would freeze a copy without user action; the merge-patch store records only the removed keys.
- **E5 (b).** `MarkdownRenderer.renderMarkdown` for `info-text` with `markdown: true` is absent in the host. The web server already renders Obsidian reading-view markup, so the browser stand-in can call a server render endpoint for it.
- **E6 (a).** `document` and `window` are process globals in the host, so one screen host holds one live plugin context at a time; per-viewer values are served by reload-on-miss and a cache, and several active viewers will queue. Context isolation is designed before there are several clients.
- **E7 (b).** The settings view (`registerView` plus a leaf opened in a tab) has no web surface; it stays a safe-stub and the settings tab is the one surface. The class-toggle commands are recorded but have no command palette in the web yet.
- **E8 (a).** Other enabled plugins' `styles.css` may carry `@settings` blocks, and the web client does not load enabled plugins' styles today. The stylesheet set must include them, in Obsidian's order, for the settings list to match Obsidian's.
- **E9 (b).** `requestAnimationFrame` is not on the host's `window`; only Pickr reaches it, which runs in the browser, so the server needs nothing. Recorded so a server-only deployment that renders the UI knows it.
- **E10 (a).** Pickr needs layout and pointer events, so a server-only placement cannot offer colour pickers; a Kindle-class client gets the applied look but no colour editing.

## Owner decisions

1. **A second host profile with a real server DOM.** The headless host chose "deliberately not jsdom" so that no plugin is mistaken for working. This design keeps that for the headless host and adds a screen host profile, its own instance, with a real server DOM (linkedom or happy-dom, picked by task 4) behind a DOM provider seam. Pick: yes. **Ruled yes** by the owner, 2026-10-19 ("your picks").
2. **Who a viewer is.** Per-viewer values need an identity. Pick: the Tailscale login header that `tailscale serve` adds (the same person on every device), with a cookie id only when the header is absent. **Ruled yes** by the owner, 2026-10-19 ("your picks").
