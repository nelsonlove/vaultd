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
- `folder-notes` auto-creates a folder note whenever a folder appears. Its `autoCreate` and `autoCreateFocusFiles` were switched off for the staging step and switched back on afterwards, so the other seven inputs stayed clean. `folder-notes/scenario.json` records `false` for both, because that is what was in force at capture time.

  **What that toggle actually did, corrected.** The switch was made on the plugin's in-memory `settings` object with no call to `saveSettings`, and the first version of this README claimed on that basis that `data.json` was never written. **That claim was wrong.** The vault backup repo's 08:30 mid-capture commit (`53b202d`) holds `.obsidian/plugins/folder-notes/data.json` with `"autoCreate": false` and `"autoCreateFocusFiles": false` — the plugin persisted the change itself, through its own `saveData` path, without being asked to. Restoring the flags then wrote the file back. The live file is now **byte-identical to the 07:32 pre-capture version** in that same backup repo, so the vault is fully restored and nothing leaked; but the mechanism was not what was claimed.

  **Lesson for the next capture: an in-memory plugin flag toggle can persist through the plugin's own `saveData`.** Never assume `data.json` stays untouched. Snapshot the file before the toggle, diff it after the restore, and report the diff — do not infer "not written" from "did not call save".
- The one place contamination did show up is `tag-wrangler`'s menu capture, where three items came from other loaded plugins. They are separated out in `expected/editor-menu.json` under `otherPluginItems` and are not part of the assertion.

Two further honest limits, both recorded per case in `notes`:

- **Nothing was invoked that opens a modal in the human's live session.** `find-replace`, `nested-properties` and `quickadd` all put their file-mutating step behind a modal, so their goldens assert the outcome of the *invokable* surface — no file mutation — and `expected/` is byte-identical to `vault/`. Real mutation goldens for those three need a scratch vault driven by hand.
- **`nested-properties`' flagship commands are vault-wide.** `rename-nested-property-across-vault` and `delete-nested-property-across-vault` would rewrite frontmatter across every note in the vault they run in. They were categorically unsafe to invoke in a live vault and were not captured.

Four cases do carry a real, byte-level mutation: `folder-notes`, `obsidian-linter`, `automatic-linker`, and `obsidian-rollover-daily-todos`.

## What this corpus can and cannot be used to claim

**The conformance set is five cases: the four mutating goldens plus `tag-wrangler`'s menu harvest.** Those are the ones where a real Obsidian outcome exists to match against, so they are the ones Task 22 may report conformance for.

**`find-replace`, `nested-properties` and `quickadd` are load-and-invoke smoke tests, not conformance.** What they assert is: the plugin loads in the headless host, its command registry matches, the named command invokes without throwing, and no file changes. That will catch shim regressions and it is worth having, but it is **not** evidence that the plugin's flagship behaviour reproduces. Do not word Task 22's acceptance as "eight plugins conform". Real mutation captures for those three wait on a scratch vault opened by hand.

**Two of the four mutating goldens need editor-context support before a driver can reproduce them verbatim.** Their `action.op` records the command a human would run, which is the honest GUI record Step 4b asks for, but it is not the path that produced `expected/`:

| golden | recorded `op` | how it is registered | how `expected/` was actually produced |
| --- | --- | --- | --- |
| `automatic-linker` | `automatic-linker:format-file` | `editorCallback`, applies through a CodeMirror writer | `modifyLinks(content, path, frontmatter)` + `vault.modify` |
| `obsidian-linter` | `obsidian-linter:lint-all-files-in-folder` | `editorCheckCallback`, derives the folder from the live active file | `runLinterAllFilesInFolder(folder)` with the folder explicit |

A driver doing `await host.call(op, params)` verbatim will not reproduce either `expected/` until the host can supply an editor context (an active file plus an editor the command can read and write). **This is a Task 22 precondition, not a fixture defect** — so those two cases do not get read as conformance failures for a reason that has nothing to do with conformance.

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

## The two honesty notes

These two are not negotiable and are stated here rather than anywhere else, because this is the file somebody reads before trusting a green golden.

They are the implementation brief's wording with **two self-referential words changed**, both forced by the prose moving into the file it now lives in: the brief's "v1 of this plan" is "v1 of the plan" here, and its "the README says so plainly" is "this README says so plainly". Nothing else was adapted, and no claim was softened — the substitution is recorded rather than left for a reader to find by diffing.

First, every `expected/` tree was produced by **observing a real Obsidian perform the action**, never by reading `app.asar` or by running the host and blessing its output.

Second, obsidian-linter's primary write path in the GUI is a **CodeMirror 6 `dispatch` transaction** on the live editor — `editor.cm.dispatch({ changes })`, not `editor.setValue` — and a CM6 transaction has no headless equivalent at all: there is no CM6 instance, no view, and no state field to dispatch into. (v1 of the plan said `editor.setValue`, which is a different API and would have implied the gap was smaller than it is; the scope conclusion is unchanged, the description was wrong.) Its golden scenario therefore drives the **file** path — `vault.modify`, and the YAML `vault.process` the plugin runs from `metadataCache.on("changed")` — and this README says so plainly, so nobody later reads a passing linter case as proof the editor path works. What the host does provide is `Editor` (Task 12), a text buffer with a `write_note` flush; that is enough for `editorCallback` commands and is not a CM6 transaction.

## Provenance

What produced these fixtures, so that a future reader can tell whether a replay is comparing like with like.

- **The application.** Obsidian **1.13.4**, the installed desktop build, driven through the `obsidian` CLI. Not a fresh install and not a scratch vault: see "How the capture was made" above for what ran alongside and what that cost.
- **The capture date.** **2026-09-09**, for all eight. `tag-wrangler`'s registration counts were first measured 2026-08-30 and re-confirmed against the running app on 2026-09-09.
- **The bundles.** `plugin/` holds the bytes that were actually loaded during the capture, copied out of the capture vault — never re-downloaded from a release page afterwards, because a version string is not a guarantee that two files are the same file.
- **Stock or patched, per bundle.** A version ending in `-nl.N` is a **local fork build**, not the upstream release: `folder-notes` 1.8.26-nl.5, `obsidian-linter` 1.32.1-nl.1 and `tag-wrangler` 0.6.5-nl.2 are patched. `automatic-linker` 4.9.0, `obsidian-rollover-daily-todos` 1.2.0, `find-replace` 0.1.0, `nested-properties` 1.6.0 and `quickadd` 2.24.2 are stock at those versions.
- **The stamp form.** `<upstream>-nl.N` — the upstream version, a hyphen, `nl`, a dot, and a local build number. So `1.8.26-nl.5` is a local build on top of upstream 1.8.26. **The trap the form exists to close:** a build whose `version` alone says it is patched proves nothing about what changed, so a fork bundle must be compared against a preserved stock copy of the same upstream version rather than against its own manifest.
- **Settings.** Each plugin's `data.json` at capture time is embedded verbatim in its `scenario.json` `settings`, with the two exceptions stated above (`folder-notes`' two forced auto-create flags, and `quickadd`'s deliberately empty set).

## Corrections (2026-09-22)

Everything above this line is the capture record and stays as it was written. These are dated corrections from running the suite against the shipped host; where they conflict with the text above, these are the measurements.

- **The conformance set is three, not five.** The section "What this corpus can and cannot be used to claim" says five — the four mutating goldens plus tag-wrangler's menu harvest. Measured against the shipped host, **three** goldens compare a tree a live Obsidian changed: `folder-notes`, `obsidian-linter` and `obsidian-rollover-daily-todos`. The two that fall out are `automatic-linker`, whose command runs and writes nothing because `getActiveViewOfType(MarkdownView)` is `null` headless and its `format-file` body needs both a file and an editor, so its case compares its own input; and `tag-wrangler`, whose vault is unchanged as captured but whose menu is not reproduced, so `expected/editor-menu.json` is excluded from the comparison. Neither is a fixture defect and neither is a regression: both are the two editor-context preconditions this README already named, still open. `VAULTD-COMPATIBILITY.md`'s Tier 3 section carries the full eight-row accounting, and the suite itself asserts which goldens carry a real mutation so the count cannot drift silently.
- **tag-wrangler's unreachable count is 17 with 3 contextmenu-typed at runtime, against the capture record's 10 and 2.** The section "tag-wrangler 0.6.5-nl.2 — measured ground truth" records ten DOM-delegated listeners of which two are `contextmenu`-typed, and says the acceptance test asserts that pair. **It does not.** The acceptance test asserts the **runtime** numbers — 17 `dom_delegated_menu` rows, 3 of them contextmenu-typed — because those are what the shipped bundle produces through the harvest. The capture's ten call sites stay as the capture record; **the difference between the two is unexplained**, it is an open capture item, and it was not reconciled by adjusting either number to match the other. Everything else in that section holds as captured: zero commands, zero `file-menu` registrations, exactly one `editor-menu` hook, and the `Menu.prototype` patch.
- **The menu items are not reproduced at all, for a reason narrower than "no DOM".** `tag-wrangler`'s scenario params were respelled for the shipped operation (`menu_id`/`active_file`/`cursor` became `context`/`path`), because `host.list_menu_items` **has no cursor parameter** — the host builds an editor-menu subject of a headless editor stub plus `{ file }`. The one harvestable hook is therefore reached with no cursor and contributes nothing, so the capture's six items are absent. Whether to give the operation a cursor is an open design call, not a defect.
- **`nested-properties` does not load.** The per-plugin row above records "no file change (modal-gated, vault-wide)", which was true of the capture. On the shipped host the plugin never gets that far: its `onload` builds property-editor widgets off `app.metadataTypeManager.registeredTypeWidgets` and asserts each is non-null, the host answers an empty map, and the load is rolled back with its command refused. The vault is unchanged either way, so the golden still passes — but it passes for a different reason than the capture describes, and the case asserts the load failure explicitly.
- **`quickadd`'s scenario was re-authored, and its `settings` are authored rather than captured.** The captured `settings` were empty on purpose and the captured action (`runQuickAdd`) only opens a suggester, so `expected/` is not a capture of anything the driver can invoke. The scenario now describes the **Template** choice and carries all three choices — Template, Macro, and the interactive one — because three of the four `quickadd` cases read commands QuickAdd only registers if its `data.json` declares them. `scenario.json`'s own `humanAction` and `notes` say plainly that the three choices are authored, not captured.
- **`obsidian-linter`'s capture ran one folder deep, and the fixture promoted that folder to the root.** `lint-all-files-in-folder` is an `editorCheckCallback` whose arm is `view.file.parent ? !view.file.parent.isRoot() : false`, so it refuses at a vault root by its own rule. This is a declared normalisation of the replay, alongside the `created`/`modified` wall-clock keys the section above already names.
