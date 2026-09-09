# Golden plugin fixtures

Eight real community plugins, each with the input vault they ran against, the bundle that ran, the outcome a **live Obsidian 1.13.4** produced on **2026-09-09**, and a machine-readable `scenario.json` that Task 22's driver reads verbatim.

```
<plugin-id>/
  vault/          the input vault
  plugin/         main.js + manifest.json (+ styles.css) COPIED from the capture vault
  expected/       the vault tree after the action, byte-for-byte
  scenario.json   the same action as data
```

`plugin/` holds `main.js` and `manifest.json`, plus `styles.css` where the plugin ships one. `obsidian-linter` gets one extra file, `default-misspellings.md` (918 KB). It is load-bearing, not padding: the captured settings have `auto-correct-common-misspellings` **enabled**, and the plugin's `loadAutoCorrectFiles` reads that file out of the plugin directory at load time, so a host that omits it is not running the same plugin.

`scenario.json` is always `{ obsidianVersion, pluginVersion, settings, action: { op, params }, humanAction, notes }`. `op` is a `host.*` method name and `params` is its params object, so the driver's whole job is `await host.call(scenario.action.op, scenario.action.params)`. `settings` is written into the headless `plugins/<id>/data.json` before the host starts. `humanAction` is the honest record of what the GUI flow is; where it diverges from the host-invokable action, `notes` says so. **Read `notes` before trusting a case — four of the eight record a limit, not a triumph.**

## How the capture was made, and what that costs

Task 0's recipe is a scratch vault with only the plugin under test enabled. That is not what happened, and the difference matters:

The capture ran **inside a live vault with its full plugin set loaded**, in a disposable scratch folder (`Fixtures/vaultd-golden-capture/<id>/`, trashed afterwards), driven through the `obsidian` CLI. Opening a second vault by hand was not available to this session. The consequences were measured, not assumed:

- Before each action, the staged input tree was diffed against `vault/` in this repo. **All eight were byte-identical**, so no other loaded plugin rewrote an input during staging.
- `folder-notes` auto-creates a folder note whenever a folder appears. Its `autoCreate` and `autoCreateFocusFiles` were switched off **in memory** for the staging step (never written to its `data.json`, restored afterwards) so the other seven inputs stayed clean. `folder-notes/scenario.json` records `false` for both, because that is what was in force at capture time.
- The one place contamination did show up is `tag-wrangler`'s menu capture, where three items came from other loaded plugins. They are separated out in `expected/editor-menu.json` under `otherPluginItems` and are not part of the assertion.

Two further honest limits, both recorded per case in `notes`:

- **Nothing was invoked that opens a modal in the human's live session.** `find-replace`, `nested-properties` and `quickadd` all put their file-mutating step behind a modal, so their goldens assert the outcome of the *invokable* surface — no file mutation — and `expected/` is byte-identical to `vault/`. Real mutation goldens for those three need a scratch vault driven by hand.
- **`nested-properties`' flagship commands are vault-wide.** `rename-nested-property-across-vault` and `delete-nested-property-across-vault` would rewrite frontmatter across every note in the vault they run in. They were categorically unsafe to invoke in a live vault and were not captured.

Four cases do carry a real, byte-level mutation: `folder-notes`, `obsidian-linter`, `automatic-linker`, and `obsidian-rollover-daily-todos`.

## Per plugin

| plugin id | version | outcome | action captured |
| --- | --- | --- | --- |
| `folder-notes` | 1.8.26-nl.5 | creates `Project/Project.md` | `host.invoke_command` `folder-notes:create-folder-note-for-current-folder` |
| `obsidian-linter` | 1.32.1-nl.1 | rewrites `Messy note.md` | `host.invoke_command` `obsidian-linter:lint-all-files-in-folder` |
| `automatic-linker` | 4.9.0 | links the first bare mention | `host.invoke_command` `automatic-linker:format-file` |
| `obsidian-rollover-daily-todos` | 1.2.0 | moves unfinished todos between two daily notes | `host.invoke_command` `obsidian-rollover-daily-todos:obsidian-rollover-daily-todos-rollover` |
| `find-replace` | 0.1.0 | no file change (modal-gated) | `host.invoke_command` `find-replace:open` |
| `nested-properties` | 1.6.0 | no file change (modal-gated, vault-wide) | `host.invoke_command` `nested-properties:toggle-full-key-display` |
| `tag-wrangler` | 0.6.5-nl.2 | six menu items, no file change | `host.list_menu_items` on `editor-menu` |
| `quickadd` | 2.24.2 | no file change (modal-gated) | `host.invoke_command` `quickadd:runQuickAdd` |

Each plugin's `data.json` at capture time is embedded verbatim in its `scenario.json` `settings`, with two deliberate exceptions, both stated in `notes`: `folder-notes` (the two auto-create flags as forced above) and `quickadd` (empty — the live file is 99 KB of the human's personal choices and their vault paths, and the captured action mutates nothing, so it is not load-bearing).

### folder-notes 1.8.26-nl.5

Opened `Project/Existing note.md` in a tab, ran *Create folder note for current folder*. `Project/Project.md` appeared, empty (`templatePath` is `""`). The command carries a `checkCallback` that requires an active markdown file, so the host must make `active_file` active before invoking.

### obsidian-linter 1.32.1-nl.1

Ran the plugin's `runLinterAllFilesInFolder` over the scratch folder — the same entry point the *Lint all files in folder* command calls, and the **file** path (`vault.modify`), not the editor path. The linter's GUI save path runs through a CodeMirror 6 `dispatch` transaction on the live editor and has no headless equivalent, so **a passing linter case is not evidence that the editor path works.** `lintOnFileChange` is `false` in these settings, so the `metadataCache.on("changed")` pass never fires; the rewrite is entirely the folder lint.

**This golden is not byte-stable on its own.** The captured `expected/Messy note.md` carries `created: 2026-09-09T12:19:22+00:00` and `modified: 2026-09-09T12:20:01+00:00`, written from the wall clock and the file's stat. A replay produces different values, so the comparison must normalise those two frontmatter keys.

### automatic-linker 4.9.0

`format-file` is an `editorCallback` that applies its result through a CodeMirror writer, so the command is not invokable without an editor; the capture drove `modifyLinks(content, path, frontmatter)`, the pure transform the command applies, and wrote the output with `vault.modify`.

**The trie is built from the whole vault.** A first run inside the live vault also linked the words *text* and *file*, because notes with those names exist there. The fixture was re-authored with a target name that cannot collide (`Zarquon fixture target`), and a replay must build the trie from this fixture vault only. `linkFrequency` is `once-per-file`, which is why the second mention stays bare.

### obsidian-rollover-daily-todos 1.2.0

**Date-dependent.** The capture ran on 2026-09-09, so `Daily/2026-09-09.md` is "today" and `Daily/2026-09-08.md` is the previous daily note; a replay must pin the clock or shift both file names. The host must enable the core daily-notes plugin with `{folder: "Daily", format: "YYYY-MM-DD", template: ""}` — the plugin reads those settings on every call.

`rollover(file)` with an explicit file is refused unless the file was created within the plugin's `MAX_TIME_SINCE_CREATION` window, so the command path (file `undefined`, which sets `ignoreCreationTime`) is the only reliable entry point. `deleteOnComplete` is `true`, which is why the rolled-over todos are removed from the previous day's note and the finished one stays. This plugin is not enabled in the capture vault: it was loaded at runtime with `enablePlugin` (never `enablePluginAndSave`), guarded so it could only ever see the scratch daily notes, and unloaded again.

### find-replace 0.1.0

Registers exactly two commands, `find-replace:open` and `find-replace:open-folder`, and both do nothing but open a panel; the replacement step lives inside that panel and its `applyReplacements` is module-local, not reachable on the plugin instance. `expected/` equals `vault/`.

### nested-properties 1.6.0

The scenario drives `toggle-full-key-display`, the plugin's one plain-`callback` command with no modal and no file effect. Its two file-mutating commands are modal-driven **and** vault-wide and were not captured. `expected/` equals `vault/`.

### tag-wrangler 0.6.5-nl.2 — measured ground truth

First measured 2026-08-30, re-confirmed 2026-09-09 against the running app. **Task 22's acceptance test asserts these numbers:**

- `addCommand`: **0**. Confirmed live — the plugin registers no commands at all, which is why its `op` is `host.list_menu_items` and not `host.invoke_command`.
- `file-menu` registrations: **0**.
- `editor-menu` registrations: **1** — the entire harvestable surface.
- DOM-delegated listeners: **10**, of which exactly **2** are `contextmenu`-typed; the other eight are pointerdown / drag / mouseover / click. All ten are structurally unreachable with no DOM and are recorded as `HarvestedUnreachable { kind: "dom_delegated_menu" }`.
- Plus a `Menu.prototype` patch for preview-mode tags, also unreachable.

**So the harvest recovers one menu hook and ten unreachable entry points. The acceptance test asserts that pair, not a flattering total.**

Its `onLayoutReady` body does four things, not one: `getCachedFiles().forEach(path => getCache(path)?.frontmatter)`, then `registerEvent(metadataCache.on("changed", …))`, then `registerEvent(vault.on("delete", …))`, then `workspace.getLeavesOfType("tag").forEach(leaf => leaf?.view?.requestUpdateTags?.())`. The shim must survive all four: the last is the load-bearing case for `getLeavesOfType` returning `[]` and **never** `undefined`, and the two `registerEvent` calls mean tag-wrangler is a live subscriber to metadata changes for the rest of the session, not a one-shot scanner.

The one `editor-menu` hook was fired against a real editor with the cursor inside `#project/alpha` (line 5, ch 18) and contributed **six** items, in `expected/editor-menu.json`:

| section | title |
| --- | --- |
| `tag-rename` | Rename #project/alpha |
| `tag-rename` | Remove #project/alpha from all notes |
| `tag-page` | Create tag page |
| `tag-search` | New search for #project/alpha |
| `tag-search` | Require #project/alpha in search |
| `tag-search` | Exclude #project/alpha from search |

### quickadd 2.24.2

`runQuickAdd` opens a suggester modal and the choice-running step lives behind it, so `expected/` equals `vault/`. One observation worth carrying into Task 22: besides its six fixed commands, QuickAdd registers **one command per configured choice**, with an id of the form `quickadd:choice:qan:<vault path to the choice note>#choice`. Those per-choice commands *do* mutate files and are the only headless-invokable path to a real capture; a golden that exercises one needs a choice authored inside the fixture vault.

## Command callback kinds, observed live

Which callback a command carries decides whether the host can invoke it at all. Observed on 1.13.4 with these bundles:

| plugin | command | callbacks |
| --- | --- | --- |
| folder-notes | create-folder-note | `callback` |
| folder-notes | create-folder-note-for-current-folder | `checkCallback` |
| folder-notes | turn-into-folder-note | `checkCallback` |
| obsidian-linter | lint-all-files | `callback` |
| obsidian-linter | lint-file, lint-all-files-in-folder | `checkCallback`, `editorCheckCallback` |
| automatic-linker | format-file, format-vault, rebuild-index | `checkCallback`, `editorCallback` |
| find-replace | open, open-folder | `callback` |
| nested-properties | toggle-full-key-display, rename/delete-across-vault | `callback` |
| nested-properties | unlock-active-note | `checkCallback` |
| quickadd | runQuickAdd, runTemplateFromFolder, openQuickAddSettings | `callback` |
| quickadd | resumePrompt, applyTemplateToActiveFile, reloadQuickAdd | `checkCallback` |
| obsidian-rollover-daily-todos | …-rollover, …-undo | registered only while the plugin is loaded |
| tag-wrangler | — | no commands at all |
