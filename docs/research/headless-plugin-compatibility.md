Evidence gathered for a possible vaultd phase-5 design conversation. **Facts only — no design decisions, no plan.** Two independent investigations plus one parallel session's repo survey. Where they disagreed, the disagreement is recorded.

Corpus: one real working vault with 56 installed community plugins, Obsidian **1.13.4**, 3,597 notes.

## 1. Tier verdicts — where business logic lives relative to the UI

Classification used: T1 = logic in `onload`/event handlers/commands (needs only an API shim). T2 = logic in UI-registered callbacks whose bodies are UI-free (needs registration harvest). T3 = logic entangled with UI components, or config authored through the settings panel. T4 = the plugin is the UI.

| Plugin                | Tier                           | Decisive evidence                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| folder-notes          | **T1** (overview half T3)      | `main.ts:154-169` registers `vault.on('create'\|'rename'\|'delete')`; handlers hold all logic. Nothing is context-menu-only. Overview codeblock + `FvIndexDB` (`indexedDB.open`) are browser-bound.                                                                                       |
| breadcrumbs           | **T1**                         | Graph engine is a Rust crate (`breadcrumbs_graph_wasm`, petgraph `StableGraph`, zero `web_sys`) inlined as ~320 KB base64. `rebuild_graph()` never touches `app.workspace`.                                                                                                               |
| quickadd              | **Execution T1, authoring T4** | `IChoiceExecutor.interactive: boolean` (`src/IChoiceExecutor.ts:49`) — doc comment says "and any headless automation". Prompts throw rather than open modals (`completeFormatter.ts:459-466`). CLI handler table ships in the bundle: `quickadd:run`, `:list`, `:check`, `:run-template`. |
| obsidian42-brat       | **T2 (best case)**             | `onload` sets `window.bratAPI = this.bratApi`; whole install/update engine callable with no UI. Only `AddBetaPlugin` uses a Modal, and only to collect a repo string.                                                                                                                     |
| recent-files-obsidian | **T4 confirmed**               | Sole command reveals the sidebar leaf; view is `class extends ItemView` building `nav-folder`/`nav-file` DOM.                                                                                                                                                                             |
| tasknotes             | **T1**                         | `services/HTTPAPIService.ts:304` `require("http")` on `127.0.0.1`. Index builds from `metadataCache.on('changed'\|'deleted')` + `vault.on('rename')` only. MCP service: zero DOM hits across 1,059 lines.                                                                                 |

**Clean T1 shortlist** (would work early): automatic-linker, obsidian-linter, pickle, tasknotes-omnifocus, okf-enforcer, obsidian-rollover-daily-todos, find-replace, tag-wrangler, nested-properties, governor.

**tag-wrangler is the purest T2 in the corpus** — no `addCommand`, no `addSettingTab`; every entry point is a context menu. It, not folder-notes, is the plugin that justifies registration harvesting.

## 2. The load-bearing obstacle: startup lifecycle, not the DOM

Plugins do not break on missing DOM (shimmable/no-oppable). They break on **lifecycle gates that never fire**:

- `onLayoutReady` — **35 of 56** plugins wait on it.
- `metadataCache.on('resolved')` — 6 plugins gate their entire startup on it; deadlock silently if it never fires.

folder-notes illustrates both failure modes:
- `handleCreate.ts:17` — `if (!plugin.app.workspace.layoutReady) return;` → a shim that never sets `layoutReady` silently disables auto-create. No error.
- `main.ts:247` — `tabManager` is assigned only in `onLayoutReady`; `handleRename.ts:48` calls `plugin.tabManager.updateTab(...)` → **rename throws** if the callback is skipped.

Also needed by folder-notes: a leaf stub with `openFile` (`folderNoteFunctions.ts:142` calls `getLeaf(false)` unconditionally), `app.vault.getConfig('attachmentFolderPath')` (private API), the global `activeDocument` (56 uses). All CSS work self-disables cleanly when `getLeavesOfType('file-explorer')` is empty.

## 3. The write surface — empirically complete

**31 of 56 plugins mutate the vault; 25 are read-only.**

Every mutation across all 56 goes through **six primitives plus two extras**:
`create`, `createFolder`, `modify`, `process`, `rename`/`fileManager.renameFile`, `delete`/`trash`/`trashFile` — plus `processFrontMatter` and `adapter.write`.

Widest write surfaces: stashpad (15 distinct calls), governor (13), tasknotes (9), quickadd (9), folder-notes (8), obsidian-importer (8). Deletion is rare (`vault.delete` 3, `vault.trash` 2, `trashFile` 6).

**Constraint:** `vault.process` (13 plugins) hands a callback the file's *current on-disk* content and writes the result back. Cannot be faked as read-then-write — it needs genuine read-modify-write consistency.

**Sleeper:** `processFrontMatter` (13 plugins) is the only write path for some plugins; weak YAML round-tripping silently rewrites every note it touches.

## 4. Aggregate API surface (counts = plugins containing the symbol, of 56)

- **Vault/file I/O** — `getAbstractFileByPath` 35 (most-used call in the corpus; needs real `TFile`/`TFolder` discrimination), `vault.on(*)` 29, `vault.adapter` 23, `cachedRead` 23, `create` 22, `read`/`modify`/`getMarkdownFiles` 20 each, `getFiles` 15, `createFolder` 14, `process` 13. No-oppable: `getResourcePath` 2, `vault.getConfig` 13.
- **MetadataCache** — `getFileCache` 27, `getFirstLinkpathDest` 18, `metadataCache.on(*)` 16, `resolvedLinks` 11, `getAllTags` 10, `unresolvedLinks` 8, `getBacklinksForFile` 5. **No plugin re-implements link resolution** — vaultd's resolver *is* the vault's link semantics.
- **Registration** — load-bearing: `addCommand` 49 (the only generic invocation entry point), `loadData`/`saveData` 50 each, `registerEvent` 39, `registerInterval` 8, `registerObsidianProtocolHandler` 5. Decoration: `addSettingTab` 50, `addRibbonIcon` 17, `addStatusBarItem` 11. **Must accept-and-discard, never throw:** `registerView` 16, `registerEditorExtension` 11 — they run at `onload`, so a throw kills the plugin before its useful half loads.
- **Workspace/UI** — mostly decoration. `Notice` 46 → log line. `Setting`/`containerEl`/`createEl` 45/51/48 need DOM-shaped stubs that swallow chained calls. `getActiveViewOfType` 28 returning `null` is safe, **but 10 plugins use `editorCallback`** and those commands never fire without a synthesized `Editor`. `getActiveFile()` 23 is load-bearing and means something new headlessly: "the file this command operates on" — the dispatcher must set it. Return empty arrays, never `undefined`.
- **Other** — load-bearing: `TFile`/`TFolder`/`TAbstractFile` 33/21/4 as real classes with working `instanceof`; `processFrontMatter` 13; `generateMarkdownLink` 10; `fileManager.renameFile` 6 (must rewrite inbound links); `requestUrl` 11 (real network); `moment` 17; `Platform` 26 (**must report `isDesktop: true`** or 9 plugins take a "mobile, unavailable" branch). Private but load-bearing: `app.plugins.getPlugin` 10, `app.plugins.plugins[]` 7, `internalPlugins` 21 — and 8 plugins publish `this.api = …` for exactly this.

## 5. Config taxonomy — four tiers plus two overlays

Measured across all 39 `data.json` files present (17 plugins have none).

- **Tier 0 — no persisted config.** 17 plugins. Seven have no `PluginSettingTab` at all: tag-wrangler, pane-relief, optimize-canvas-connections, nested-properties, hot-reload, heading-levels, find-replace.
- **Tier 1 — flat document.** Scalars / scalar arrays, depth ≤ 2, no minted ids. Hand-writable, diffable, safe to version. 21 plugins incl. advanced-canvas (74 keys), forge (87), fileclass (31), automatic-linker (30), meta-bind (12).
- **Tier 2 — structured but *named*.** Nested objects or arrays of objects, every identifier meaningful. obsidian-linter (65 rule sub-objects keyed by slug), breadcrumbs (depth 6, 33 arrays-of-objects, **zero** ids), governor, cmdr, homepage.
- **Tier 3 — compiled artifact.** Minted ids, and/or load-bearing ordering/index, and/or references into other files. quickadd (98 KB, depth 11, 239 id fields, 386 path strings), mermaid-tools (98 UUIDs), folder-notes (13 UUIDs + `position` integers), tasknotes (30 ids incl. timestamp-minted `field_1784678570216`), darlal-switcher-plus, iconic, settings-sidebar-organizer.

**Overlay A — runtime state in the config file.** 12 plugins. Must not be hand-edited or committed: tasknotes (`pomodoroState`, `googleCalendarSyncQueue` 21 items, sync cursors, migration flags), recent-files (`recentFiles` — 9 KB, 100% cache), settings-sidebar-organizer (fold state + seen-plugins), breadcrumbs (`is_dirty`, `_bc_migrations`), quickadd (`migrations` 16 flags), iconic/execute-code/folder-notes (last-open tab), forge/governor/brat (one-shot flags, pin list). **False friends:** darlal-switcher-plus's `maxRecentCommands`, `shouldSearchRecentFiles` etc. match a "recent" grep but are config — the split needs per-key judgement, not a regex.

**Overlay B — secrets.** `obsidian42-brat.personalAccessToken`, `tasknotes.apiAuthToken`, `tasknotes.googleCalendarSyncTokens` / `microsoftCalendarSyncTokens`. The plugin config directory is therefore not blanket-committable.

**Tier belongs to the key, not the file.** folder-notes is the proof: 9,329 bytes, 56 keys — 44 flat booleans anyone could hand-write, plus one generated island (`excludeFolders`, 8 objects each with a UUID and a `position` integer).

**Embedded code / interpreted content** — a distinct class, 11 of 39 files: quickadd's 17 Macro choices reference vault notes *executed as code* (`{"type":"UserScript","path":"…/Unfill paragraph.md"}`); custom-sort's `additionalSortspecFile` points at a note whose body is a sort program; governor's `cliPolicy.allowOpaque` holds a cross-plugin QuickAdd choice UUID; mermaid-tools stores 98 live diagram sources; template DSLs in folder-notes (`{{folder_name}}`) and tasknotes (`{title|n(Title)}` pipe syntax); endpoints in automatic-linker (`http://localhost:1234/v1`).

## 6. Settings schemas — Obsidian already shipped one

**`getSettingDefinitions()`, added in Obsidian 1.13.0; this vault runs 1.13.4.** `SettingDefinitionItem` (`obsidian.d.ts:6147`) carries `key` ("The config/storage property name", `:5886-5887`), `defaultValue`, `validate`, `disabled`, `visible`, and a nine-member control union (`toggle|dropdown|text|textarea|number|file|folder|slider|color`, `:5877`). `display()` is `@deprecated Since 1.13.0` and **not called when `getSettingDefinitions()` returns non-empty** (`:6633-6642`).

**16 of 56 installed plugins already implement it**, 14 non-degenerately: advanced-canvas 78 controls, obsidian-minimal-settings 21, quickadd 13, obsidian-hider 11, brat 10, meta-bind 9, miller-columns 2.

**The API can lie.** tasknotes and tasknotes-workflows implement it degenerately — one opaque item whose `render` calls the old renderer. Check items carry `control.key`, not merely that the method exists.

**Predictable split.** Plugins declare scalars and hide collections behind `render:` escape hatches. meta-bind is exact: 9 scalar keys declared, its 3 array-of-object keys not. So a declarative schema recovers Tier 1 well and Tier 3 barely — i.e. it solves the half that was already easy.

**Other machine-readable sources**, in order of usefulness: a plugin's own field-descriptor array (automatic-linker's `SETTINGS_CATALOG`, 31 entries with key/control/name/description/options/`visibleWhen`, parity enforced by a test; governor's `ConfigField[]` manifests; forge's `settings-definitions.ts`, 547 lines of typed factories); then `interface` + `DEFAULT_SETTINGS` read from source (complete for keys and defaults — execute-code 211/211, automatic-linker 31/31, folder-notes 56/56 — but carries no human descriptions, and over-reports: folder-notes has 5 keys with no control anywhere). No zod, no JSON Schema anywhere in the sampled repos.

**Precedent in-vault:** obsidian-miller-columns (`src/settings.ts:1-66`) already harvests Breadcrumbs' schema by reading Breadcrumbs' *source* plus its persisted `data.json`, deliberately not touching its UI.

### Verdict on "harvest the schema by running `display()`"

Weaker than reading source, in every sampled case. Failure modes, with evidence:

- **meta-bind: fails outright** — `display()` is dead code while `getSettingDefinitions()` is non-empty.
- **folder-notes: ~1/6 recovery** — six tabs rendered **lazily** (`SettingsTab.ts:257-280`, click at `:314`); 52 `this.display()` self-re-renders across 13 files; conditional rendering; per-item rows open separate Modals outside the tab's DOM tree.
- **governor: structurally blind to part of its own config** — the auto-accept allowlist and migration controls are raw `createEl("button")`/`createEl("input")` with **zero** `new Setting(` calls (`governance/wiring.ts:1591,1648`, `governance/pane.ts:475-496`). Its `display()` also calls `findClaudeBinary()` and spawns the `claude` CLI (`connection-ui.ts:457,461`) — would hang or error a headless harness.
- **automatic-linker: 30/31** — static grep is misleading (3 source sites drive 31 fields via a generic renderer); executing `display()` recovers all but one `visibleWhen`-gated field.
- **execute-code: works well** — only a Windows-gated toggle (`process.platform === "win32"`) and Tangle's data-driven rows need special casing.

**Tab rendering is not one pattern** — governor renders every pane eagerly and CSS-toggles visibility (`connection-ui.ts:378-404`, `applyActiveTab` only calls `classList.toggle`; doc comment: "no full re-render"); folder-notes, tasknotes and forge render lazily on click. A harvester must handle both. *(One investigation initially got this backwards and self-corrected — recorded as evidence that it cannot be assumed either way.)*

**Scraping `onChange` bodies over-reports as well as under-reports.** governor's `tool-runner.ts:142-188` writes `this.values[field.name] = v` on a dev-tool form — a repo-wide regex invents five settings keys that do not exist. Read the settings tab and the typed interface; never a repo-wide pattern hunt.

## 7. Surprises worth carrying into any design

1. **Breadcrumbs' graph engine is already a headless Rust crate** — hosting it is re-hosting a Rust library, not shimming a plugin. In this vault only 2 of its 10 edge builders are live; every `BC-*` frontmatter key appears zero times across 3,597 notes.
2. **QuickAdd's authoring problem is already solved here, by a different route** — all 164 choices carry the `qan:` compiler prefix; governor compiles them from markdown, so the settings panel is a read-only viewer of generated output.
3. **QuickAdd's user scripts are Node-native** — `getUserScript` does `vault.read` then `new Function("require","module","exports", src)`. No `import()`, no `app://`. Runs *easier* in Node than in Electron.
4. **`plugin.api` is a getter, not a field** (`quickadd/src/main.ts:105-111`) — every read mints a fresh `ChoiceExecutor` with `interactive = true`, so that path is permanently modal and nothing can be injected through it. Governor works around this by convention (`_invoked-by: "agent"`), not structurally.
5. **TaskNotes has already been factored out of Obsidian** — `@tasknotes/model` on npm (zod/yaml/rrule, no `obsidian` dependency), a `tasknotes-spec` repo with a `conformance/` fixture suite driven by a `TASKNOTES_ADAPTER` env hook, and two non-Obsidian hosts (`mdbase-tasknotes` CLI, `tasknotes-app`). Spec says frontmatter is normative, body is not. **This vault renames four fields** via `data.json.fieldMapping` (`title→name`, `completedDate→completed`, `dateCreated→created`, `dateModified→modified`) and identifies tasks by tag, not property.
6. **Three plugins run servers inside Obsidian** — governor (`node:net` Unix socket), tasknotes (`node:http` + OAuth callback), quickadd (OAuth/AI callback). They bind at load: a collision source under multi-instance, and a security surface.
7. **Framework contamination is low** — Svelte 5 in 4 plugins only (js-engine, multi-properties, meta-bind, quickadd); React in exactly 1 (obsidian-plugin-update-tracker); Preact 0; Express 0 (all 22 apparent hits were the substring inside `"expression"`).
8. **backlink-cache is the one true shim-breaker** — its entire purpose is monkey-patching `metadataCache`'s private link index, the exact thing a Rust runtime owns natively. A spec to read, not a plugin to host.
9. **Config rots silently** — all 8 folder-notes `excludeFolders` paths in the sampled vault point at folders deleted in an earlier reorganisation. Nothing prunes them. recent-files has 0 of 50 stale because it self-prunes.
10. **Index-as-identity** — settings-sidebar-organizer stores fold state against group *positions* (`collapsedGroups: {"0":true,"1":true,…}`). Reorder the groups and the state silently attaches to the wrong ones. Strongest single argument that Tier 3 files must not be hand-edited.
11. **Config files as content databases** — mermaid-tools' `data.json` is 36 KB of 98 UUID-keyed diagram snippets under 6 top-level keys; recent-files' is 9 KB and 100% cache. Neither is "settings" in any useful sense.

## 8. Open questions this research did not settle

1. Does a client talk to the plugin host directly, or does the host register harvested commands with vaultd so there is one door? (One door: nicer for clients, worse for isolation.)
2. vaultd has no bulk-hydration op — a host mirror would need thousands of round trips at startup (`list_notes` + `get_note` per note for 3,597 notes). Same shape as the known cold-open miss.
3. vaultd has no write path at all; the six-primitive list above is the empirical spec for a minimal one.
4. Whether `getSettingDefinitions()` adoption is rising fast enough to make legacy harvesting a shrinking problem rather than a permanent one.

## Follow-up findings (2026-08-28)

Second research wave: minification, UI frameworks, idle costs, and third-party infrastructure.

### Minification does not block tier detection

Tested against three plugins with both local source and shipped minified bundles: the boundary is **property-position vs binding-position**. Anything reachable as `obj.name` survives minification (97–100% — Obsidian API methods, DOM APIs, the plugin's own methods, event-name string literals, command ids/names/icons); any *binding* (locals, parameters, **imported symbols** like `mount`, `requestUrl`, `normalizePath`) is renamed (8–25% coincidental survival). Minification preserves the AST, so *which callback contains which API calls* — including whether a callback body touches the DOM — is fully readable from the bundle. UI framework presence is detectable via framework-owned string constants only (`__svelte_meta`, `svelte.dev/e/` codes, `__SECRET_INTERNALS`); searching for `mount(` gives false negatives on real users and false positives elsewhere. Destroyed: module boundaries (zero build banners in every minified bundle), framework runtime composition, types/comments/dead branches. Sourcemaps: **0 of 56** ship a usable one; 22 of 56 are unminified; of the 34 minified, only 9 have local source and `stashpad` has no public source at all. **Verdict: build detection on shipped bundles; source is enrichment.** Traps found: naive substrings false-positive (`vue` matches French locale strings; `hydrat` matches ReactDOM); named-class prototype patching is precisely detectable (2 hits in 56: governor, iconic) but instance-level patching (backlink-cache) needs a different pattern; `class extends *.Plugin` matching breaks on indirect base classes (2 of 34).

### UI frameworks: what they are for and what they cost idle

Six framework plugins (Svelte 5: js-engine, meta-bind, multi-properties, quickadd, **breadcrumbs**; React 18: obsidian-plugin-update-tracker) = 19% of 28.4 MB installed bundle bytes. Eager V8 compile for all 56 bundles: ~58 ms total.

- **Every Svelte plugin mounts nothing at `onload` and holds nothing live at idle** — no timers, observers, or subscriptions from the framework. Svelte 5 compiles components at build time; measured runtimes cluster at 45–72 KB minified. multi-properties ships unminified: 77.5% of its 193 KB is Svelte runtime serving four modal forms over 2,155 bytes of logic.
- **quickadd/meta-bind/js-engine keep all business logic outside Svelte** (quickadd's final 125 KB — engine, formatter, executor — has zero Svelte fingerprints). meta-bind is the exception where widgets are the product (63 components rendering inline note content).
- **obsidian-plugin-update-tracker (React) is the one real idle cost**: mounts a live React root + Redux store subscription at load, runs a 30 s interval walking all plugin manifests, POSTs to a third-party AWS lambda at every Obsidian start and (with this vault's `hoursBetweenCheckingForUpdates: 0.5`) every 30 min, and attaches `file-open`/`active-leaf-change` via raw `.on()` (never cleaned up). React core+Redux = 25% of its 715 KB; the React-adjacent stack (react-markdown/parse5, FontAwesome, styled-components) = 62%; the plugin's own logic = 6%.
- **js-engine's Svelte is inherited scaffolding, not need** (same author as meta-bind — Moritz Jung/mProjectsCode): its init commit carried the full Svelte toolchain two weeks before any `.svelte` file existed, with a package.json copied from meta-bind's (including an unused dataview dep); components are copy-pasted between repos (one byte-identical); only 1 of 9 components does real reactive work; three wrap Obsidian's own primitives; and the plugin's flagship dynamic feature (`engine.reactive`) is framework-free hand-rolled signals. Only stated rationale anywhere: a PR comment ("Svelte makes complicated UIs like this easier") rejecting a working plain-Setting-API reimplementation (js-engine PR #34).

### The update-tracker lambda

Endpoint `https://jc5gpa3gs7o2uge6iq5mgjd53q0daomi.lambda-url.us-east-1.on.aws/obsidian-plugin-update-tracker`, operated personally by the plugin author (swar8080, CDK infra in-repo; installed manifest's `"author": "Obsidian"` is simply wrong). Payload: the **complete installed plugin list with versions** (disabled plugins included — `excludeDisabledPlugins` filters display, not the request); no user id/vault name, but the server logs a salted MD5 of the client IP and the README concedes IP visibility. Purpose: GitHub rate-limit proxy + cache (shared token, Redis/DynamoDB), not telemetry — but there is **no off switch, no self-host option, and no direct-GitHub fallback**. A full plugin-set fingerprint + IP hash per 30 min is enough to recognize a returning vault.

### backlink-cache vendoring verdict

Mostly *necessary* vendoring done competently, not a tree-shaking failure: Obsidian plugins must bundle everything; backlink-cache deep-imports 17 subpaths (never the barrel) and obsidian-dev-utils' 2.16 MB reachable code shrinks 91% to 187 KB. Real defects: dev-utils publishes a dev-mode stylesheet whose inline SCSS sourcemap (23.5 KB, 59% of the CSS file) every PluginBase consumer inlines; a demo-vault command drags adm-zip (38 KB) into a backlink cache; `keepNames: true` costs 23 KB. Config-only ceiling: ~46 KB (~11%). dev-utils itself: 14 MB / 1,561 files / 59 runtime deps (incl. esbuild, eslint, typescript as *runtime* deps); only two vault plugins carry it (both mnaoumov). No upstream issue exists for any of this.

### Always-on idle work across the 56 (renderer-resident cost the headless host would not run)

meta-bind ticks `metadataManager.cycle()` **5×/sec forever** (200 ms `syncInterval`; ~10 promises + 5 arrays allocated per tick even with zero fields, because the global source always yields one cache item). External change detection is already event-driven (`metadataCache.on('changed')`); the tick's load-bearing jobs (write-back flush, post-write lock countdown) matter only when a field is mounted — and `MountableManager.activeMountables.size` is a ready-made gate with register/unregister as start/stop hooks. The installed build is the local fork, so the fix needs no upstream cooperation. Worse offenders by the same standard: **stashpad** (250 ms watchdog from load — highest-frequency timer in the vault, plus 30 s/45 s/5 min pollers), **current-view** (MutationObserver on body → 150 ms debounce → **full vault scan** `getFiles()`+`getAllFolders()`, default-on), obsidian-outliner (2×1 s ungated CSS togglers), tasknotes-workflows (5 s ungated), governor (2.5 s journal poll), tasknotes (30 s/5 min/60 s/5 s), iconic (60 s self-rescheduling regardless of rules), folder-notes (MutationObserver on the entire document subtree), nested-properties (input listeners across all windows). Clean on this standard: 42 of 56. Confidence medium (minified, unproven load-time registration) on: quickadd 60 s cleanup, tasknotes-workflows tick, fileclass/supercharged-links body observers.

### Corrections to the 2026-08-27 sections above

- The earlier framework census line ("Svelte 5: only 4 plugins") missed **breadcrumbs**; it is five Svelte plugins plus one React.
- The backlink-cache bundle IS minified (built with `keepNames: true`, which mimics unminified naming); the "~90% vendored" framing above stands but is mostly justified vendoring per the verdict here.

## Census corrections (2026-08-29, from design-review findings)

- **`vault.copy` was undercounted to zero.** stashpad calls `vault.copy` twice (duplicate-task flow, verified in the shipped bundle). The write surface is six primitives plus THREE extras: `copy` joins `processFrontMatter` and `adapter.write`.
- **`CachedMetadata.sections` and `.listItems` were never measured** and are load-bearing: tasknotes reads `.listItems` (line counting) and `.sections` (yaml-section test); breadcrumbs combines `.listItems` with links/embeds to build edges. vault-core's `ParsedNote` currently stores neither — a named gap for any shim building `getFileCache`.
- **Restored from the raw wave-1 report (dropped in condensation):** breadcrumbs needs synthesized `frontmatterLinks` with `field.N` keys plus positioned `links`/`embeds` in `getFileCache` output.
- **`require('electron')` was not counted:** darlal-switcher-plus, stashpad, tasknotes use it (`ipcRenderer`, `shell.openPath`/`showItemInFolder`/`openExternal`); some call sites try/caught, stashpad's Finder-reveal is real functionality.
- **This vault's live trash config:** `.obsidian/app.json` has `"trashOption": "local"` — deletes go to `.trash/` inside the vault root (a hidden dir, so excluded from scanning by the existing rule).
