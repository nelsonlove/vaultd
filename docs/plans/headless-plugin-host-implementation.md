# vaultd Headless Plugin Host Implementation Plan (DRAFT v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Status

**v2, revised against three independent reviews, 2026-08-30.** v1 was read by three fresh-context reviewers — a structural-rigor review (task decomposition, dependency order, placeholder hunting), an interface/type review (cross-task interface agreement, wire casing, constructor signatures), and a grounding review (every claim checked against `obsidian.d.ts`, the shipped plugin bundles, and the sibling plans). Every Blocking and Important finding is resolved in this revision. What changed structurally: a harness task (6b) now builds the test-harness family with real code before anything consumes it; Task 11 split into 11a and 11b; quarantine moved ahead of the lifecycle sequencer as Task 14b; the host server split into 16a (core ops) and 20b (wiring that needs the broker, config service, and detector); three prose-only test files written out; six collapsed run/implement steps split into observe-failure and implement halves. What changed on the wire: every DTO now matches the **revised** phase-5 plan field-for-field (`entries`/`notes`, `sections`/`list_items` as top-level facets, the corrected error-code union, the line-number `listItems.parent` model). Task count: 27.

Authorities, in precedence order: [Headless plugin host design for vaultd (draft)](../design/headless-plugin-host.md) (its trailing **Rulings** and **Corrections** sections win over its body); the revised [Vault mutations and bulk reads implementation plan for vaultd (draft)](vault-mutations-and-bulk-reads-implementation.md) (v2 — the wire authority for every op, DTO, and error code); and the **Pinned DDL and corrections** section of [Structural parse extension implementation plan for vaultd (draft)](structural-parse-extension-implementation.md) (the schema authority, including the corrected `ListItemParent` convention).

**Goal:** Ship a Node daemon that supervises `vaultd`, mirrors the vault, impersonates the Obsidian plugin API faithfully enough to run tier-1 community plugins unmodified with no Electron and no DOM, and publishes their harvested commands, menu items, protocol handlers, and settings as machine-readable capabilities over a Unix socket.

**Architecture:** A `host/` npm workspace inside the vaultd repo runs a supervisor that owns `vaultd`'s stdio, a mirror hydrated by snapshot sessions and kept current by `subscribe_events`, and a shim published as a real `obsidian` package on the host's module path so unmodified esbuild-CJS bundles resolve it through ordinary `require`. Plugin registrations are harvested rather than rendered, every vault write funnels through `vaultd` mutation ops, and every API symbol carries one of four declared policies — implemented, harvested, safe-stub, or loudly absent — so gaps surface in a compatibility report instead of as silent breakage.

**Tech Stack:** Node LTS (`engines.node: ">=24.0.0"`; the development machine runs v26.7.0), TypeScript 5.9 in `strict` mode compiled to CommonJS, `vitest` 3 as the test runner, npm workspaces for module resolution, `node:net` for the Unix socket, `node:worker_threads` + `SharedArrayBuffer` + `Atomics` for the watchdog, `js-yaml` 4 for `parseYaml`/`stringifyYaml`, `moment` 2 bundled for the `obsidian` re-export, global `fetch` for `requestUrl`. No Electron, no `vm.createContext`, no native addons.

**Spec:** [Headless plugin host design for vaultd (draft)](../design/headless-plugin-host.md) — including its **Rulings (2026-08-30)** section, which supersedes every inline `OPEN` marker above it. Dependency spec: [Vault mutations and bulk reads design for vaultd (draft)](../design/vault-mutations-and-bulk-reads.md) (this plan consumes `read_file`, `write_file`, `copy_file`, the snapshot-session ops, the mutation ops, and the `config_changed` notice). Pre-task: [Structural parse extension implementation plan for vaultd (draft)](structural-parse-extension-implementation.md). Evidence: [Headless plugin compatibility research for vaultd](../research/headless-plugin-compatibility.md) including its 2026-08-29 census corrections.

## Global Constraints

- Node LTS only: `engines.node` is `">=24.0.0"`. No transpiler beyond `tsc`; no bundler for host code.
- TypeScript `strict: true`, plus `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`, `useUnknownInCatchVariables: true`. `module: "commonjs"`, `target: "es2023"`, `moduleResolution: "node16"`. `any` is banned outside declared plugin-facing API surfaces, where it is Obsidian's own signature.
- **The host process never writes vault bytes directly.** Every byte that lands in the vault leaves the host as a `vaultd` mutation request (`write_note`, `write_file`, `patch_frontmatter`, `create_folder`, `rename_note`, `rename_folder`, `copy_file`, `delete_note`, `delete_folder`). Task 1 builds the `fs` instrumentation that proves it and Task 22 runs the whole golden suite under it; any `fs`/`fs.promises` write, open-for-write, `rename`, `unlink`, `mkdir`, `rm`, or `cp` whose resolved path is inside the vault root is a test failure with the offending stack.
- The host writes to exactly three places outside the vault: its own data directory (`$XDG_STATE_HOME/vaultd-host/`, default `~/.local/state/vaultd-host/`), its socket directory, and `stdout`/`stderr`. The vault-relative headless config directory (default `.obsidian-headless/`) is written **only** through `write_file`.
- Plugins run on one JS thread. Every plugin entry point — `onload`, `onunload`, an event handler, a command callback, a timer tick, a brokered-prompt resumption — is dispatched through a single FIFO async queue; two plugin callbacks are never in flight at once. The only other thread in the process is the watchdog worker, which touches no plugin state.
- The Unix socket is created inside a directory the host creates with mode `0o700` and `chmod`ed to `0o600` immediately after `listen`; both modes are asserted at startup and refused if wrong. The **directory** mode is the enforcement layer; the socket mode is defense in depth and may be advisory on Darwin. Every accepted connection presents an ownership nonce before any op is dispatched (Task 16a).
- No Electron dependency anywhere in the tree. A test asserts `electron` appears in neither `package.json` dependencies nor `npm ls --all` output; the `electron` module plugins import is a host-supplied stub package.
- **Four-way API policy.** Every symbol the shim exposes carries exactly one policy in a single declared table: `implemented` (real behavior), `harvested` (recorded as a capability, never rendered), `safe_stub` (silent no-op or inert value, recorded once per plugin+symbol), `absent` (throws a typed `HeadlessUnsupported`). A symbol not in the table defaults to `absent`, so an unimplemented gap throws typed and lands in the compatibility report rather than returning `undefined`. `HeadlessUnsupported extends Error` with `name = "HeadlessUnsupported"`, `code = "headless_unsupported"`, `symbol: string`, `pluginId: string | null`, `policy: "absent"`.
- Calibration values, fixed, all read from `HostConfig` so none needs a protocol change: brokered-prompt timeout `120_000` ms; quarantine threshold 5 handler failures in a rolling `60_000` ms; GUI-overlap poll `60_000` ms; `moment` locale `"en"`; headless config dir `.obsidian-headless`; snapshot page size 500, capped 2000; `write_file` cap 16 MiB; `onunload` shutdown budget `5_000` ms per plugin.
- **One clock, injected.** `HostConfig` carries a `clock: Clock` (`now()`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`). Every component whose behavior depends on time — `InteractionBroker`, `CoexistenceMonitor`, `QuarantineTracker`, `Watchdog`, the mirror's warm-up scheduler — takes its timing from `config.clock` and never from the global. Task 6b provides `TestClock`, which advances only when a test says so. Production uses `systemClock()`, a thin pass-through. Plugin-facing timers (`window.setInterval`, `registerInterval`) deliberately use the **real** globals, because a plugin observing a frozen clock is a plugin observing a lie; they are cleaned up by the component registry instead.
- Determinism discipline, inherited from phase 4: rendezvous over sleeps. No test may contain a bare `setTimeout` wait for a condition; wait on an awaited promise, an explicit test hook, or `TestClock.advance(ms)`. Every new test file passes 10 consecutive runs before its task commits.
  - **The one named exception:** `runtime/watchdog-worker.js` owns exactly one real timer — its own `Atomics.wait` timeout loop — because a watchdog driven by the clock it is watching cannot detect that clock stopping. That timer lives entirely inside the worker thread, touches no plugin state, and is the only real timer any test in this plan waits on. Everything on the main side of the watchdog (the heartbeat stamp, the threshold arithmetic) is driven by `config.clock` and is therefore `TestClock`-drivable. No other bare timer is admitted anywhere.
- **Wire casing: `host.*` fields are `snake_case`, without exception.** The daemon's wire is `snake_case` and the host's wire is the same grammar, so a client parses one convention. Internal TypeScript types (`HarvestedCommand`, `OverlapReport`, `PluginState`, …) stay `camelCase` where that reads better; `src/server/wire.ts` owns the one-way conversion and every server test asserts the `snake_case` spelling. A `host.*` response that leaks a `camelCase` key is a bug the wire test catches.
- Obsidian's own behavior is ground truth captured by **observing a running Obsidian** (the installed `js-engine` plugin evaluates JS in the live app). Never read, unpack, decompile, or quote `app.asar`. Every capture fixture records the observed Obsidian version beside it.
- Gate before every commit: `npm --prefix host run typecheck`, `npm --prefix host run lint`, `npm --prefix host test`. Do not combine task commits.
- The vault at `~/vault` is never a test target. Fixture vaults are created under `host/fixtures/` or a `tmpdir`; plugin bundles under test are **copied** from `.obsidian/plugins/` into the fixture at capture time and committed, so no test reads the live vault.
- **One cross-repo-directory step exists and is named once, here.** Task 6b adds a Rust binary to the `vaultd` workspace (`crates/vault-index/src/bin/fixture-row.rs`) so the parity tests can be fed by the real parser rather than by hand-written rows. It is the only change this phase makes outside `host/` and `docs/`, it is additive, and it ships in Task 6b's commit with its own `cargo` gate.

---

## Preflight gate

The gate splits in two. **Part A is universal** — every task in this plan needs it. **Part B is the phase-5 dependency** and is a precondition only on the tasks that talk to a real daemon: **2, 3, 4, 5, 6, 7, 8, 9, 12, 14, 14b, 15, 16a, 18, 19, 20b, 22**. Tasks 0, 1, 6b, 10, 11a, 11b, 13, 17, 20, and 21 are implementable and testable against fixtures and the fake daemon alone, so a stalled phase 5 does not stall them.

### Part A — universal (before Task 0)

```bash
cd ~/repos/system/vaultd
git status --short --branch
node --version
```

Expected: a clean worktree on a branch dedicated to this phase, and `node --version` at or above `v24`. If either fails, stop — no task in this plan is safe on a dirty tree or an old Node.

### Part B — phase-5 and pre-task dependency (before the tasks listed above)

```bash
cd ~/repos/system/vaultd
grep -c 'sections' crates/vault-core/src/semantic.rs
grep -c 'tree_entries' crates/vault-index/src/schema_v3.sql
grep -c '"open_snapshot"\|OpenSnapshot' crates/vault-protocol/src/operations.rs
grep -c '"write_note"\|WriteNote' crates/vault-protocol/src/operations.rs
grep -c 'config_changed\|ConfigChanged' crates/vault-protocol/src/events.rs
grep -c 'payload_too_large' crates/vault-protocol/src/error.rs
TMPDIR="$PWD/target/tmp" cargo test --workspace --all-targets
```

Expected:

- `sections` present in `vault-core` and `tree_entries` present in `schema_v3.sql` (the structural parse pre-task has landed, schema v3, including the file-tree addendum);
- `open_snapshot`, `write_note`, `config_changed`, and `payload_too_large` all present in `vault-protocol` (the mutation and bulk-read phase has landed, with the revised error-code union);
- the whole Rust suite green.

If any of those greps returns `0`, **stop before the dependent tasks**. This phase consumes those operations and cannot be implemented against a daemon that does not serve them. The correct action is to finish the mutation/bulk-read phase, not to stub it inside the host. Tasks 0, 1, 6b, 10, 11a, 11b, 13, 17, 20, and 21 may proceed meanwhile.

---

## Planned file map

### Workspace

- Create `host/package.json` — npm workspace root, scripts, `engines`.
- Create `host/tsconfig.base.json`, `host/vitest.config.ts`, `host/.eslintrc.json`, `host/.gitignore`.
- Create `host/packages/host/` — `@vaultd/host`, the daemon.
- Create `host/packages/obsidian/` — the package literally named `obsidian` that plugin bundles resolve.
- Create `host/packages/electron/` — the package literally named `electron`.
- Modify `.gitignore` (repo root) — ignore `host/node_modules`, `host/**/dist`.

### `@vaultd/host` source

Every file below is created by exactly one task, named in the right-hand column. A file that appears in a task's **Files** block and not here is a plan bug.

| File | Created by |
|---|---|
| `src/config.ts` — `HostConfig`, `Clock`, `systemClock()`, defaults | 4 |
| `src/datadir.ts` — the only module in `src/` outside `testing/` allowed to write files, and only under `config.dataDir` | 6b |
| `src/client/framing.ts`, `src/client/protocol.ts`, `src/client/errors.ts`, `src/client/client.ts` | 2 |
| `src/client/events.ts` | 3 |
| `src/supervisor.ts` | 4 |
| `src/mirror/types.ts`, `src/mirror/positions.ts`, `src/mirror/hydrate.ts` | 5 |
| `src/mirror/mirror.ts` | 6 |
| `src/mirror/metadata.ts` | 8 |
| `src/shim/app.ts` (skeleton container), `src/shim/events.ts` (`Events`, `EventRef`, `ShimEventBus`) | 6b |
| `src/shim/policy.ts`, `src/shim/files.ts`, `src/shim/adapter.ts` (`DataAdapter`), `src/shim/vault.ts` | 7 |
| `src/runtime/queue.ts` | 7 |
| `src/shim/metadata-cache.ts` | 8 |
| `src/shim/file-manager.ts` | 9 |
| `src/shim/plugin.ts`, `src/shim/harvest.ts`; `src/shim/events.ts` gains `Menu`/`MenuItem` | 10 |
| `src/shim/workspace.ts`, `src/shim/dom.ts`, `src/shim/globals.ts` | 11a |
| `src/shim/notice.ts` (`Notice`, `NoticeLog`), `src/shim/components.ts` (the ten `*Component` classes + `PluginSettingTab` + `Setting`), `src/shim/search.ts`, `src/shim/api.ts` (the barrel) | 11b |
| `src/shim/plugin-registry.ts`, `src/shim/internal-plugins.ts`, `src/shim/commands.ts`, `src/shim/editor.ts`, `src/shim/keymap.ts` (`Keymap`, `Scope`, `SettingRegistry`, `FoldManager`); `src/shim/app.ts` filled in | 12 |
| `src/runtime/intercept.ts`, `src/runtime/loader.ts`, `src/runtime/electron-stub.ts` | 13 |
| `src/pluginset/config-dir.ts`, `src/pluginset/coexistence.ts` | 14 |
| `src/runtime/quarantine.ts` | 14b |
| `src/runtime/lifecycle.ts` | 15 |
| `src/server/wire.ts`, `src/server/server.ts`, `src/server/ops.ts`, `src/server/snapshot.ts`, `src/server/subscriptions.ts` | 16a |
| `src/settings/ladder.ts`, `src/settings/plugin-config.ts`, `src/settings/key-registry.json` | 17 |
| `src/interaction/broker.ts`, `src/shim/modals.ts` | 18 |
| `src/dryrun/dry-run.ts` | 19 |
| `src/detector/scanner.ts`, `src/detector/harness.ts`, `src/detector/report.ts` | 20 |
| `src/server/ops-wiring.ts` (the interaction, config, compat, and overlap ops) | 20b |
| `src/runtime/watchdog.ts`, `src/runtime/watchdog-worker.js` | 21 |
| `src/main.ts` — the `vaultd-host` binary | 22 |

### `src/testing/` — the harness family

| File | Created by |
|---|---|
| `src/testing/fs-guard.ts` | 1 |
| `src/testing/fake-daemon.ts` | 2 |
| `src/testing/clock.ts` (`TestClock`) | 6b |
| `src/testing/daemon-harness.ts` (`DaemonHarness`) | 6b |
| `src/testing/mirror-harness.ts` (`MirrorHarness`, `harness_ref`) | 6b |
| `src/testing/fixture-vault.ts` (`FixtureVault`, `parseFixtureRow`) | 6b |
| `src/testing/assemble.ts` (`assembleShim`, `HostAssembly`) | 6b |
| `src/testing/pending/shim-harness.ts` → activated as `src/testing/shim-harness.ts` | written 6b, activated 7 |
| `src/testing/pending/pluginset-harness.ts` → `src/testing/pluginset-harness.ts` | written 6b, activated 14 |
| `src/testing/pending/host-harness.ts` → `src/testing/host-harness.ts` | written 6b, activated 15 |
| `src/testing/pending/settings-harness.ts` → `src/testing/settings-harness.ts` | written 6b, activated 17 |
| `src/testing/pending/live-host.ts` → `src/testing/live-host.ts` | written 6b, activated 22 |

### Outside `host/` — the one cross-repo-directory step

- Create `crates/vault-index/src/bin/fixture-row.rs` — the fixture-generator binary, Task 6b.
- Modify `crates/vault-index/Cargo.toml` — declare the `bin`, Task 6b.

### Fixtures and captures

- `host/fixtures/metadata-parity/<case>.md` + `<case>.expected.json` + `README.md` — Task 0.
- `host/fixtures/golden/README.md` — Task 0.
- `host/fixtures/golden/<plugin>/vault/`, `.../plugin/`, `.../expected/`, `.../scenario.json` — Task 0.
- `host/fixtures/cache/` (gitignored) — the `fixture-row` binary's memoized output, Task 6b.
- `host/fixtures/detector/<case>/main.js` + `ground-truth.json` — Task 20.
- `host/packages/host/test/fixtures/fake-vaultd.js` — Task 4.
- `host/packages/host/test/fixtures/bundles/cjs-plugin/main.js`, `.../rollup-interop/main.js`, `.../user-script.md` — Task 13.

### Documentation

- Modify `VAULTD-COMPATIBILITY.md` — Tier 3 moves from research target to measured status.
- Modify `README.md` — the `host/` workspace joins the workspace list.
- Create `docs/design/headless-plugin-host.md` — the design, imported from the vault note at implementation time.
- Create `docs/protocol-host.md` — the `host.*` wire contract (Task 16a, completed by 20b).
- Create `docs/performance/headless-host-baseline.md` — Task 22.

---

### Task 0: Capture ground truth from a running Obsidian

**This task produces fixtures, not code, and it gates Tasks 8 and 22.** Obsidian's metadata shapes and plugin outcomes are observed, never read out of `app.asar`. The installed `js-engine` plugin is the capture instrument.

**Files:**

- Create: `host/fixtures/metadata-parity/README.md`
- Create: `host/fixtures/metadata-parity/<case>.md` (16 cases, listed in Step 2)
- Create: `host/fixtures/metadata-parity/<case>.expected.json`
- Create: `host/fixtures/golden/README.md`
- Create: `host/fixtures/golden/<plugin>/vault/` (input vault per golden plugin)
- Create: `host/fixtures/golden/<plugin>/expected/` (byte-level outcome captured from real Obsidian)
- Create: `host/fixtures/golden/<plugin>/plugin/` (the copied bundle under test)
- Create: `host/fixtures/golden/<plugin>/scenario.json` (the machine-readable description of the captured action — see Step 4b; Task 22's driver reads it verbatim)

**Interfaces:**

- Produces: `<case>.expected.json` files shaped exactly `{ "obsidianVersion": string, "cache": CachedMetadata }`, consumed verbatim by Task 8's parity test and Task 22's suite.

- [ ] **Step 1: Write the capture block**

Create a scratch note in the live vault containing this `js-engine` block. It dumps the complete `CachedMetadata` for one file, not a hand-picked subset, because a subset is how a parity fixture silently stops covering a field:

```js
const path = "Fixtures/parity-headings.md";
const file = app.vault.getAbstractFileByPath(path);
const cache = app.metadataCache.getFileCache(file);
return engine.markdown.createCodeBlock("json", JSON.stringify({
    obsidianVersion: app.appVersion ?? "unknown",
    cache,
}, null, 2));
```

- [ ] **Step 2: Author the 17 parity cases**

One `.md` per case, each exercising a field the shim must reproduce:

`parity-frontmatter` (scalars, list, nested map), `parity-frontmatter-links` (a wikilink and a markdown link inside a frontmatter list, so `frontmatterLinks` keys come back as `field.0`/`field.1` — breadcrumbs' case), `parity-headings` (levels 1–6, duplicate text, trailing `#`), `parity-blocks` (block ids on a paragraph, a heading, and a list item), `parity-tags-body`, `parity-tags-frontmatter`, `parity-tags-nested-unicode`, `parity-links` (wikilink, alias pipe, heading subpath, block subpath, markdown link, percent-encoded target), `parity-embeds` (wiki embed, markdown embed, image attachment), `parity-sections` (heading, paragraph, fenced code, blockquote, table, thematic break, html), `parity-list-flat` (**with the first list starting on line 0**, so the `-0` question is captured rather than reasoned about), `parity-list-nested-3deep`, `parity-list-tasks` (`[ ]`, `[x]`, and `[/]`), `parity-list-with-links` (a list item containing a link and an embed — breadcrumbs' actual edge case), `parity-callout`, `parity-footnotes` (a footnote definition and a reference — the fixture that measures the three fields this phase does not serve), `parity-empty`.

- [ ] **Step 3: Author one non-ASCII position case**

Create `parity-wide-offsets.md` containing, on separate lines: an em dash, a curly quote, an accented Latin character, a CJK character, and an emoji outside the BMP, each followed by a wikilink on the same line. This is the fixture that proves the byte-offset to `line`/`col`/`offset` conversion is exact for characters whose UTF-8 byte length and UTF-16 unit length differ. Capture it the same way.

- [ ] **Step 4: Capture the eight golden-plugin outcomes**

For each of folder-notes, obsidian-linter, automatic-linker, obsidian-rollover-daily-todos, find-replace, nested-properties, tag-wrangler, and quickadd: build a small input vault, copy the plugin's `main.js`/`manifest.json`/`styles.css` from `.obsidian/plugins/<id>/` into `host/fixtures/golden/<id>/plugin/`, enable only that plugin in a scratch Obsidian vault pointed at a copy of the input vault, trigger the plugin's flagship behavior by hand, and save the resulting vault tree byte-for-byte into `expected/`. Record in `host/fixtures/golden/README.md`, per plugin: the Obsidian version, the plugin version, the exact user action performed, and the plugin's `data.json` at capture time.

- [ ] **Step 4b: Write one `scenario.json` per golden plugin**

The prose record in the README is for humans; Task 22's driver needs the same action as data. Create `host/fixtures/golden/<id>/scenario.json` with exactly this shape:

```json
{
  "obsidianVersion": "1.9.14",
  "pluginVersion": "1.7.24",
  "settings": { "…": "the plugin data.json at capture time, verbatim" },
  "action": {
    "op": "host.invoke_command",
    "params": { "command_id": "folder-notes:create-folder-note", "active_file": "Folder/Note.md" }
  },
  "humanAction": "Right-clicked the folder in the file explorer and chose Create folder note.",
  "notes": "Free text: anything about the capture a later reader needs."
}
```

`op` is a `host.*` method name and `params` is its params object, so the driver's whole job is `await host.call(scenario.action.op, scenario.action.params)`. `settings` is written into the headless `plugins/<id>/data.json` before the host starts. `humanAction` is the honest record of what was actually done in the GUI, which is not always expressible as one `host.*` call — where the two diverge, say so in `notes` and pick the closest host-invokable equivalent.

Two scenarios are constrained by what is reachable headless, and both are recorded as such:

- **obsidian-linter** — its GUI save path runs through a **CodeMirror 6 `dispatch` transaction** on the live editor (`editor.cm.dispatch(...)`), not through `editor.setValue`, and no headless equivalent of a CM6 transaction exists. Its scenario therefore drives the **file** path: `vault.modify` plus the YAML pass the plugin runs from `metadataCache.on("changed")`. `notes` says exactly that, so nobody later reads a passing linter case as proof the editor path works.
- **tag-wrangler** — it registers **zero commands**, so its scenario's `op` is `host.list_menu_items` on `editor-menu`, not `host.invoke_command`. See Step 4c.

- [ ] **Step 4c: Record tag-wrangler's measured ground truth beside its fixture**

Ground truth from the shipped bundle, measured 2026-08-30 and superseding the census's earlier count — write it into `host/fixtures/golden/tag-wrangler/scenario.json`'s `notes` and into the golden README, because Task 22's acceptance test asserts these numbers:

- `addCommand`: **0**.
- `file-menu` registrations: **0**.
- `editor-menu` registrations: **1** — this is the entire harvestable surface.
- DOM-delegated listeners: **10**, of which exactly **2** are `contextmenu`-typed; the other eight are pointerdown / drag / mouseover / click. All ten are structurally unreachable with no DOM and are recorded as `HarvestedUnreachable { kind: "dom_delegated_menu" }`.
- Plus a `Menu.prototype` patch for preview-mode tags, also unreachable.
- Its `onLayoutReady` body does four things, not one: `getCachedFiles().forEach(path => getCache(path)?.frontmatter)`, then `registerEvent(metadataCache.on("changed", …))`, then `registerEvent(vault.on("delete", …))`, then `workspace.getLeavesOfType("tag").forEach(leaf => leaf?.view?.requestUpdateTags?.())`. The shim must survive all four: the last one is the load-bearing case for `getLeavesOfType` returning `[]` (never `undefined`), and the two `registerEvent` calls mean tag-wrangler is a live subscriber to metadata changes for the rest of the session, not a one-shot scanner.

So the harvest recovers **one** menu hook and **ten** unreachable entry points. The acceptance test asserts that pair, not a flattering total.

- [ ] **Step 5: Record what must be reproduced exactly, from the captures — not from assumption**

Write these into `host/fixtures/metadata-parity/README.md`:

- every `Pos` is `{ start: { line, col, offset }, end: { line, col, offset } }` with zero-based `line` and `col`, and `offset` counted in JavaScript string units — **not** the UTF-8 byte offsets `vaultd` returns;
- the exact string vocabulary Obsidian emits in `sections[].type`;
- **`listItems[].parent` is always a line number, never an array index.** Real `obsidian.d.ts` (`ListItemCache.parent`, lines 3760–3769) says it exactly: "Line number of the parent list item (`position.start.line`). If this item has no parent (e.g. it's a root level list), then this value is **the negative of the line number of the first list item** (start of the list)." So the expected shape is `-list_start_line` for a root item and `parent_start_line` (positive) for a nested one. **The capture pins the exact negation form** — in particular what a list starting at line 0 produces, where `-0` and `0` are indistinguishable in JSON — and Task 8's conversion is written against the captured values, not against this paragraph. Record the observed values for `parity-list-flat` and `parity-list-nested-3deep` explicitly, including at least one list that starts on line 0;
- `listItems[].task` is the raw character between the brackets and is **absent**, not `null`, on a non-task item;
- **`frontmatterLinks[]` entries carry no `position`.** `FrontmatterLinkCache extends Reference` (not `ReferenceCache`), so its fields are `link`, `original`, optional `displayText`, and `key` — and nothing else. A shim that adds a `position` to them fails parity. Record the exact observed key spellings (`field`, `field.0`, `field.1`) from `parity-frontmatter-links`;
- which fields Obsidian omits entirely versus emits as an empty array on the empty note;
- **which `CachedMetadata` fields this phase does not serve:** `footnotes`, `footnoteRefs`, and `referenceLinks` are real fields in the current `obsidian.d.ts` (since 1.6.6 and 1.8.7) that `vaultd` does not parse. They are declared **absent-with-policy**, not forgotten: `buildCachedMetadata` omits the keys entirely (Obsidian omits them too when a note has none), the policy table records them as `absent`, and a plugin reading them sees `undefined` exactly as it would for a note with no footnotes. Capture at least one fixture containing a footnote so the gap is measured rather than assumed, and record in the README that the parity test skips those three keys by name.

- [ ] **Step 6: Commit**

```bash
git add host/fixtures
git commit -m "test(host): capture real Obsidian metadata and golden plugin outcomes"
```

---

### Task 1: Workspace scaffold and the no-direct-writes guard

**Files:**

- Create: `host/package.json`, `host/tsconfig.base.json`, `host/vitest.config.ts`, `host/.eslintrc.json`, `host/.gitignore`
- Create: `host/packages/host/package.json`, `host/packages/host/tsconfig.json`, `host/packages/host/src/index.ts`
- Create: `host/packages/obsidian/package.json`, `host/packages/obsidian/index.js`
- Create: `host/packages/electron/package.json`, `host/packages/electron/index.js`
- Create: `host/packages/host/src/testing/fs-guard.ts`
- Create: `host/packages/host/src/runtime/electron-registry.ts`
- Create: `host/packages/host/test/fs-guard.test.ts`
- Create: `host/packages/host/test/no-electron.test.ts`
- Create: `host/packages/host/test/electron-registry.test.ts`
- Modify: `.gitignore`

**Interfaces:**

- Produces:

```ts
export interface FsWriteViolation {
  readonly call: string;
  readonly path: string;
  readonly stack: string;
}

export interface FsWriteGuard {
  violations(): readonly FsWriteViolation[];
  assertClean(): void;
  release(): void;
}

export function installFsWriteGuard(vaultRoot: string): FsWriteGuard;
```

- Produces: the workspace layout that makes `require("obsidian")` and `require("electron")` resolve from a plugin bundle loaded by `@vaultd/host` with no loader patching at all — npm workspaces link `host/packages/obsidian` into `host/node_modules/obsidian`.

- [ ] **Step 1: Create the workspace root**

`host/package.json`:

```json
{
  "name": "vaultd-host-workspace",
  "private": true,
  "workspaces": ["packages/*"],
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "build": "tsc --build packages/host",
    "typecheck": "tsc --build --dry packages/host && tsc --noEmit -p packages/host",
    "lint": "eslint packages --ext .ts",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/js-yaml": "4.0.9",
    "@types/node": "24.9.2",
    "eslint": "9.39.0",
    "typescript": "5.9.3",
    "vitest": "3.2.4"
  }
}
```

`host/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "commonjs",
    "moduleResolution": "node16",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "useUnknownInCatchVariables": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 2: Create the three packages**

`host/packages/host/package.json` declares `"name": "@vaultd/host"`, `"main": "dist/index.js"`, `"bin": { "vaultd-host": "dist/main.js" }`, and dependencies `"js-yaml": "4.1.0"`, `"moment": "2.30.1"`.

`host/packages/obsidian/package.json` declares `"name": "obsidian"`, `"version": "0.0.0-headless"`, `"main": "index.js"`, and a dependency on `"@vaultd/host": "*"`. `host/packages/obsidian/index.js` is three lines and stays three lines — the shim itself lives in `@vaultd/host`, this package only makes it resolvable under the name plugins require:

```js
"use strict";
module.exports = require("@vaultd/host/dist/shim/api.js");
```

`host/packages/electron/package.json` declares `"name": "electron"`, `"version": "0.0.0-headless"`, `"main": "index.js"`, and a dependency on `"@vaultd/host": "*"`.

**The `electron` package resolves a runtime-registered singleton, not a factory.** This is the one place where the two shapes could contradict each other: `createElectronStub({ dryRun, spawn })` is a factory taking host state, but `require("electron")` is a namespace with no arguments. The package therefore exports whatever the host registered, and throws if the host registered nothing — which is the honest failure for "a plugin bundle got loaded before the host was assembled".

`host/packages/electron/index.js`:

```js
"use strict";
const { currentElectronStub } = require("@vaultd/host/dist/runtime/electron-registry.js");
module.exports = currentElectronStub();
```

`host/packages/host/src/runtime/electron-registry.ts`:

```ts
export interface ElectronStub {
  readonly shell: {
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  readonly ipcRenderer: {
    on(channel: string, listener: (...args: unknown[]) => void): void;
    off(channel: string, listener: (...args: unknown[]) => void): void;
    once(channel: string, listener: (...args: unknown[]) => void): void;
    removeListener(channel: string, listener: (...args: unknown[]) => void): void;
    removeAllListeners(channel?: string): void;
    send(channel: string, ...args: unknown[]): void;
    sendSync(channel: string, ...args: unknown[]): never;
    invoke(channel: string, ...args: unknown[]): never;
  };
}

export class ElectronNotRegistered extends Error {
  readonly code = "electron_not_registered";
  constructor() {
    super(
      "require(\"electron\") was resolved before the host registered its stub; " +
        "call registerElectronStub(createElectronStub(...)) during host assembly, " +
        "before any plugin bundle loads",
    );
    this.name = "ElectronNotRegistered";
  }
}

let registered: ElectronStub | null = null;

/** Called exactly once during host assembly, before any bundle loads. */
export function registerElectronStub(stub: ElectronStub): void {
  registered = stub;
}

/** Called by the `electron` package's `index.js` at require time. */
export function currentElectronStub(): ElectronStub {
  if (registered === null) throw new ElectronNotRegistered();
  return registered;
}

/** Test-only: drop the registration so a fresh assembly can install its own. */
export function clearElectronStub(): void {
  registered = null;
}
```

The host's assembly order therefore reads: build `HostConfig` → `registerElectronStub(createElectronStub({ dryRun: config.dryRun, spawn: osSpawn }))` → install module interception → load the first bundle. Task 13 builds `createElectronStub`; this task builds only the registry and its contract, because the `electron` package's `index.js` is written here and must not be rewritten later.

- [ ] **Step 3: Write the failing guard test**

Create `host/packages/host/test/fs-guard.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installFsWriteGuard } from "../src/testing/fs-guard";

describe("installFsWriteGuard", () => {
  it("records a synchronous write inside the vault root", () => {
    const root = mkdtempSync(join(tmpdir(), "vaultd-guard-"));
    const guard = installFsWriteGuard(root);
    try {
      writeFileSync(join(root, "Note.md"), "# leaked\n");
    } finally {
      guard.release();
    }
    const violations = guard.violations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.call).toBe("writeFileSync");
    expect(violations[0]?.path).toBe(join(root, "Note.md"));
    expect(violations[0]?.stack).toContain("fs-guard.test.ts");
  });

  it("ignores writes outside the vault root", () => {
    const root = mkdtempSync(join(tmpdir(), "vaultd-guard-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "vaultd-other-"));
    const guard = installFsWriteGuard(root);
    try {
      writeFileSync(join(elsewhere, "state.json"), "{}");
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(0);
    expect(() => guard.assertClean()).not.toThrow();
  });
});
```

- [ ] **Step 4: Run it and observe the missing module**

```bash
npm --prefix host install
npm --prefix host test -- fs-guard
```

Expected: the run fails to resolve `../src/testing/fs-guard` — the module does not exist.

- [ ] **Step 5: Implement the guard**

Create `host/packages/host/src/testing/fs-guard.ts`:

```ts
import { realpathSync } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export interface FsWriteViolation {
  readonly call: string;
  readonly path: string;
  readonly stack: string;
}

export interface FsWriteGuard {
  violations(): readonly FsWriteViolation[];
  assertClean(): void;
  release(): void;
}

const SYNC_CALLS = [
  "writeFileSync", "appendFileSync", "renameSync", "unlinkSync", "rmSync",
  "rmdirSync", "mkdirSync", "copyFileSync", "cpSync", "truncateSync",
  "openSync", "createWriteStream", "writevSync", "ftruncateSync",
] as const;

const PROMISE_CALLS = [
  "writeFile", "appendFile", "rename", "unlink", "rm", "rmdir",
  "mkdir", "copyFile", "cp", "truncate", "open",
] as const;

const WRITE_FLAGS = /[wax+]/;

export function installFsWriteGuard(vaultRoot: string): FsWriteGuard {
  const root = realpathSync(resolve(vaultRoot));
  const found: FsWriteViolation[] = [];
  const restore: Array<() => void> = [];

  const inside = (candidate: unknown): string | null => {
    if (typeof candidate !== "string" || !candidate.length) return null;
    const abs = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
    return abs === root || abs.startsWith(root + sep) ? abs : null;
  };

  const record = (call: string, path: string): void => {
    found.push({ call, path, stack: new Error(`${call} ${path}`).stack ?? "" });
  };

  const wrap = (holder: Record<string, unknown>, call: string, isOpen: boolean): void => {
    const original = holder[call];
    if (typeof original !== "function") return;
    const patched = (...args: unknown[]): unknown => {
      const target = inside(args[0]);
      const writing = !isOpen || typeof args[1] !== "string" || WRITE_FLAGS.test(args[1]);
      if (target !== null && writing) record(call, target);
      return (original as (...a: unknown[]) => unknown).apply(holder, args);
    };
    holder[call] = patched;
    restore.push(() => { holder[call] = original; });
  };

  for (const call of SYNC_CALLS) {
    wrap(fs as unknown as Record<string, unknown>, call, call === "openSync");
  }
  for (const call of PROMISE_CALLS) {
    wrap(fsp as unknown as Record<string, unknown>, call, call === "open");
  }

  return {
    violations: () => found,
    assertClean() {
      if (found.length === 0) return;
      const detail = found.map((v) => `${v.call} ${v.path}\n${v.stack}`).join("\n\n");
      throw new Error(`host wrote ${found.length} vault path(s) directly:\n\n${detail}`);
    },
    release() {
      while (restore.length) restore.pop()?.();
    },
  };
}
```

- [ ] **Step 6: Run it and observe it pass**

```bash
npm --prefix host test -- fs-guard
```

Expected: both cases pass. Note the guard patches the module namespace objects, so it catches host code that did `import { writeFile } from "node:fs/promises"` **only** if that code calls through the namespace; Task 22 therefore also asserts, statically, that no file under `src/` outside `testing/` imports a write function by name.

- [ ] **Step 7: Write and pass the no-Electron test**

Create `host/packages/host/test/no-electron.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The host compiles to CommonJS (`module: "commonjs"`), so `import.meta` does
// not exist here. `__dirname` is the correct accessor and is what the emitted
// JS actually has.
const workspaceRoot = resolve(__dirname, "..", "..", "..");

describe("dependency tree", () => {
  it("contains no real electron package", () => {
    const tree = execFileSync("npm", ["ls", "--all", "--json"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(tree) as { dependencies?: Record<string, { version?: string }> };
    const electron = parsed.dependencies?.["electron"];
    expect(electron?.version ?? "0.0.0-headless").toBe("0.0.0-headless");
    expect(tree).not.toContain("electron.zip");
  });

  it("declares electron nowhere in any package.json dependency block", () => {
    for (const pkg of ["package.json", "packages/host/package.json", "packages/obsidian/package.json"]) {
      const manifest = JSON.parse(
        execFileSync("cat", [resolve(workspaceRoot, pkg)], { encoding: "utf8" }),
      ) as Record<string, Record<string, string> | undefined>;
      for (const block of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        expect(Object.keys(manifest[block] ?? {}), `${pkg}.${block}`).not.toContain("electron");
      }
    }
  });
});
```

Run `npm --prefix host test -- no-electron`; expected: both pass, because the only `electron` in the tree is the workspace stub at version `0.0.0-headless` and nothing depends on it by name except the plugins that `require` it at runtime.

- [ ] **Step 8: Write the failing electron-registry test**

Create `host/packages/host/test/electron-registry.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  ElectronNotRegistered,
  clearElectronStub,
  currentElectronStub,
  registerElectronStub,
} from "../src/runtime/electron-registry";
import type { ElectronStub } from "../src/runtime/electron-registry";

const fakeStub = (): ElectronStub => ({
  shell: {
    openPath: () => Promise.resolve(""),
    showItemInFolder: () => Promise.resolve(),
    openExternal: () => Promise.resolve(),
  },
  ipcRenderer: {
    on: () => {}, off: () => {}, once: () => {},
    removeListener: () => {}, removeAllListeners: () => {}, send: () => {},
    sendSync: () => { throw new Error("unreachable"); },
    invoke: () => { throw new Error("unreachable"); },
  },
});

afterEach(() => clearElectronStub());

describe("electron registry", () => {
  it("throws a typed error when nothing is registered", () => {
    expect(() => currentElectronStub()).toThrow(ElectronNotRegistered);
    expect(() => currentElectronStub()).toThrow(/before the host registered its stub/);
  });

  it("returns the registered singleton, identically, on every call", () => {
    const stub = fakeStub();
    registerElectronStub(stub);
    expect(currentElectronStub()).toBe(stub);
    expect(currentElectronStub()).toBe(currentElectronStub());
  });

  it("lets a later registration replace an earlier one", () => {
    const first = fakeStub();
    const second = fakeStub();
    registerElectronStub(first);
    registerElectronStub(second);
    expect(currentElectronStub()).toBe(second);
  });
});
```

- [ ] **Step 9: Run it, observe the missing module, implement, observe it pass**

```bash
npm --prefix host test -- electron-registry
```

Expected first: cannot resolve `../src/runtime/electron-registry`. Create the module exactly as written in Step 2, re-run; expected: three cases pass.

- [ ] **Step 10: Commit**

```bash
git add host .gitignore
git commit -m "feat(host): scaffold the plugin host workspace and the direct-write guard"
```

---

### Task 2: The vaultd client — framing and request/response

**Files:**

- Create: `host/packages/host/src/client/framing.ts`
- Create: `host/packages/host/src/client/protocol.ts`
- Create: `host/packages/host/src/client/errors.ts`
- Create: `host/packages/host/src/client/client.ts`
- Create: `host/packages/host/src/testing/fake-daemon.ts`
- Create: `host/packages/host/test/client-framing.test.ts`
- Create: `host/packages/host/test/client-request.test.ts`

**Interfaces:**

- Produces (`protocol.ts`, mirroring `vault-protocol` field-for-field; every field is snake_case on the wire and stays snake_case in TypeScript, because renaming invites drift):

```ts
export const PROTOCOL_VERSION = 1;

export interface SpanDto { start: number; end: number }
export interface RequestEnvelope { version: number; id: string; request: { method: string; params?: unknown } }
export type ResponseOutcome =
  | { status: "ok"; value: { type: string; value: unknown } }
  | { status: "err"; value: ProtocolErrorBody };
export interface ResponseEnvelope { version: number; id: string; outcome: ResponseOutcome }
export interface EventEnvelope { version: number; subscription_id: string; event: RuntimeEventDto }
export interface ProtocolErrorBody {
  code: ErrorCode; message: string;
  supported_version?: number; current_generation?: number;
}
export type ErrorCode =
  | "incompatible_version" | "invalid_request" | "invalid_path" | "invalid_cursor"
  | "note_not_found" | "index_unavailable" | "generation_mismatch"
  | "vault_changed_during_refresh" | "incompatible_index" | "storage_failure"
  | "internal" | "index_in_use" | "watch_unavailable" | "subscription_not_found"
  | "runtime_not_ready" | "runtime_overloaded"
  | "revision_conflict" | "not_found" | "parent_not_found" | "target_exists"
  | "case_collision" | "zone_violation" | "payload_too_large" | "read_only"
  | "snapshot_not_found" | "too_many_snapshots"
  | (string & {});
```

**The union is copied from the revised phase-5 plan's `ErrorCode`, code for code.** Three corrections against v1 of this plan, each of which would otherwise have produced a `switch` arm that never fires: `size_limit_exceeded` **does not exist** — the daemon's oversize refusal is `payload_too_large`; `zone_violation` is the `.obsidian`-zone refusal every semantic op emits and the shim must branch on it when a plugin aims a `write_note` at a config path; and `too_many_snapshots` is the snapshot-session cap, which hydration must handle by backing off rather than by failing the host's startup. A grep for `size_limit_exceeded` anywhere under `host/` is a bug.

The trailing `(string & {})` on `ErrorCode` and the equivalent on every wire union is this client's unknown-variant tolerance: the daemon's phase-5 hardening added `#[serde(other)] Unknown` on its side, and this is the mirror-image obligation on ours. A new daemon variant must widen behavior, never crash the host.

- Produces (`framing.ts`):

```ts
export type Frame = ResponseEnvelope | EventEnvelope;
export interface PushResult {
  /** Every frame parsed from this chunk, in order, up to the bad line. */
  readonly frames: readonly Frame[];
  /** The first unparseable line in this chunk, if there was one. */
  readonly error?: FramingError;
}
export class LineFramer {
  push(chunk: Buffer): PushResult;
  static encode(envelope: RequestEnvelope): Buffer;
}
export class FramingError extends Error { readonly line: string }
```

**`push` returns the error, it does not throw it.** A daemon chunk can carry several complete lines; if the framer throws on a bad one it discards every good frame that arrived in the same chunk, and those good frames are responses that some `await` is waiting on. So a chunk containing `{response A}\n{garbage}\n{response B}\n` must settle A before the client dies, or A's caller hangs forever on a daemon that already answered it. `push` therefore parses forward, stops at the first bad line, and returns `{ frames: [A], error }` — B is discarded with the rest of the buffer, because after a framing error the stream's position is no longer trustworthy. The caller processes `frames` first and only then surfaces `error`.

- Produces (`client.ts`):

```ts
export interface VaultdClientOptions {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  onEvent(envelope: EventEnvelope): void;
  onFatal(error: Error): void;
}
export class VaultdClient {
  constructor(options: VaultdClientOptions);
  request<T>(method: string, params?: unknown): Promise<T>;
  pendingCount(): number;
  failAllPending(reason: Error): void;
  close(): void;
}
export class VaultdError extends Error {
  readonly code: ErrorCode;
  readonly currentGeneration: number | null;
  readonly supportedVersion: number | null;
}
```

`request` resolves with `outcome.value.value` — the inner payload — and rejects with a `VaultdError` on `status: "err"`. IDs are `h-<counter>` strings, never numbers, because `RequestEnvelope.id` is a Rust `String`.

- [ ] **Step 1: Write the failing framing test**

Create `host/packages/host/test/client-framing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FramingError, LineFramer } from "../src/client/framing";

describe("LineFramer", () => {
  it("reassembles a response split across three chunks", () => {
    const framer = new LineFramer();
    const line = '{"version":1,"id":"h-1","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd","status":"ok"}}}}\n';
    expect(framer.push(Buffer.from(line.slice(0, 20))).frames).toEqual([]);
    expect(framer.push(Buffer.from(line.slice(20, 60))).frames).toEqual([]);
    const { frames, error } = framer.push(Buffer.from(line.slice(60)));
    expect(error).toBeUndefined();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ version: 1, id: "h-1" });
  });

  it("yields two frames from one chunk and skips blank lines", () => {
    const framer = new LineFramer();
    const a = '{"version":1,"id":"a","outcome":{"status":"ok","value":{"type":"health","value":{}}}}';
    const b = '{"version":1,"subscription_id":"sub-1","event":{"type":"resync_required","value":{"current_generation":4,"reason":"watcher_overflow"}}}';
    const { frames, error } = framer.push(Buffer.from(`${a}\n\n${b}\n`));
    expect(error).toBeUndefined();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ subscription_id: "sub-1" });
  });

  it("splits multi-byte characters safely across a chunk boundary", () => {
    const framer = new LineFramer();
    const line = Buffer.from('{"version":1,"id":"x","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd\u{1F600}"}}}}\n', "utf8");
    expect(framer.push(line.subarray(0, line.length - 3)).frames).toEqual([]);
    expect(framer.push(line.subarray(line.length - 3)).frames).toHaveLength(1);
  });

  it("reports FramingError on a non-JSON line without throwing", () => {
    const framer = new LineFramer();
    const { frames, error } = framer.push(Buffer.from("not json\n"));
    expect(frames).toEqual([]);
    expect(error).toBeInstanceOf(FramingError);
    expect(error?.line).toBe("not json");
  });

  it("keeps the good frames that arrived in the same chunk as a bad line", () => {
    const framer = new LineFramer();
    const good = '{"version":1,"id":"h-7","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd","status":"ok"}}}}';
    const later = '{"version":1,"id":"h-8","outcome":{"status":"ok","value":{"type":"health","value":{}}}}';
    const { frames, error } = framer.push(Buffer.from(`${good}\n{oops\n${later}\n`));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: "h-7" });
    expect(error).toBeInstanceOf(FramingError);
    expect(error?.line).toBe("{oops");
  });
});
```

The last case is the one that matters. If `push` threw, `h-7`'s caller would wait forever on a response the daemon already sent — the framing error would turn one corrupt line into one hung promise per in-flight request.

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- client-framing
```

Expected: cannot resolve `../src/client/framing`.

- [ ] **Step 3: Implement the framer**

Create `host/packages/host/src/client/framing.ts`:

```ts
import type { EventEnvelope, RequestEnvelope, ResponseEnvelope } from "./protocol";

export type Frame = ResponseEnvelope | EventEnvelope;

export class FramingError extends Error {
  readonly line: string;
  constructor(line: string, cause: unknown) {
    super(`unparseable daemon line: ${line.slice(0, 200)}`);
    this.name = "FramingError";
    this.line = line;
    this.cause = cause;
  }
}

export class LineFramer {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): PushResult {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    let start = 0;
    for (;;) {
      const newline = this.buffer.indexOf(0x0a, start);
      if (newline === -1) break;
      const line = this.buffer.toString("utf8", start, newline);
      start = newline + 1;
      if (line.trim().length === 0) continue;
      let parsed: Frame;
      try {
        parsed = JSON.parse(line) as Frame;
      } catch (cause) {
        // Drop the rest of the buffer: after a bad line the stream position is
        // no longer trustworthy. Return what we already parsed so the caller
        // can settle those promises before it tears the connection down.
        this.buffer = Buffer.alloc(0);
        return { frames, error: new FramingError(line, cause) };
      }
      frames.push(parsed);
    }
    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start);
    return { frames };
  }

  static encode(envelope: RequestEnvelope): Buffer {
    return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  }
}
```

Slicing on the newline byte before decoding is what makes the multi-byte case work: a partial UTF-8 sequence stays in the buffer as bytes and is never turned into a replacement character.

- [ ] **Step 4: Run it and observe it pass**

```bash
npm --prefix host test -- client-framing
```

Expected: all five cases pass, including the mixed good-then-bad chunk.

- [ ] **Step 5: Write the failing request/response test**

Create `host/packages/host/test/client-request.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { VaultdClient, VaultdError } from "../src/client/client";
import { FakeDaemon } from "../src/testing/fake-daemon";

describe("VaultdClient", () => {
  it("correlates two in-flight requests answered out of order", async () => {
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout, stdin: daemon.stdin,
      onEvent: () => {}, onFatal: () => {},
    });
    const first = client.request<{ generation: number }>("get_vault_info");
    const second = client.request<{ service: string }>("health");
    expect(client.pendingCount()).toBe(2);
    const sent = await daemon.received(2);
    expect(sent[0]?.request.method).toBe("get_vault_info");
    expect(sent[0]?.id).not.toBe(sent[1]?.id);
    daemon.respondOk(sent[1]!.id, "health", { service: "vaultd", status: "ok" });
    daemon.respondOk(sent[0]!.id, "get_vault_info", { generation: 7 });
    await expect(second).resolves.toEqual({ service: "vaultd", status: "ok" });
    await expect(first).resolves.toEqual({ generation: 7 });
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects with a typed VaultdError carrying current_generation", async () => {
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout, stdin: daemon.stdin,
      onEvent: () => {}, onFatal: () => {},
    });
    const pending = client.request("list_notes", { cursor: "stale", limit: 100 });
    const [sent] = await daemon.received(1);
    daemon.respondErr(sent!.id, {
      code: "generation_mismatch",
      message: "cursor generation 2 does not match current generation 3",
      current_generation: 3,
    });
    await expect(pending).rejects.toBeInstanceOf(VaultdError);
    await pending.catch((error: VaultdError) => {
      expect(error.code).toBe("generation_mismatch");
      expect(error.currentGeneration).toBe(3);
    });
  });

  it("routes an event line to onEvent, never to a pending request", async () => {
    const daemon = new FakeDaemon();
    const events: string[] = [];
    const client = new VaultdClient({
      stdout: daemon.stdout, stdin: daemon.stdin,
      onEvent: (envelope) => events.push(envelope.event.type), onFatal: () => {},
    });
    const pending = client.request("health");
    const [sent] = await daemon.received(1);
    daemon.emit("sub-1", { type: "resync_required", value: { current_generation: 4, reason: "runtime_recovered" } });
    daemon.respondOk(sent!.id, "health", { service: "vaultd", status: "ok" });
    await pending;
    expect(events).toEqual(["resync_required"]);
  });

  it("fails every pending request when the stream dies", async () => {
    const daemon = new FakeDaemon();
    let fatal: Error | null = null;
    const client = new VaultdClient({
      stdout: daemon.stdout, stdin: daemon.stdin,
      onEvent: () => {}, onFatal: (error) => { fatal = error; },
    });
    const pending = client.request("health");
    await daemon.received(1);
    daemon.endStdout();
    await expect(pending).rejects.toThrow(/daemon stdout closed/);
    expect(fatal).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 6: Run it and observe the missing modules**

```bash
npm --prefix host test -- client-request
```

Expected: cannot resolve `../src/client/client` or `../src/testing/fake-daemon`.

- [ ] **Step 7: Implement `FakeDaemon`**

Create `host/packages/host/src/testing/fake-daemon.ts` exposing a `PassThrough` pair plus the four helpers the test calls:

```ts
import { PassThrough } from "node:stream";
import type { ProtocolErrorBody, RequestEnvelope, RuntimeEventDto } from "../client/protocol";

export class FakeDaemon {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  private readonly sent: RequestEnvelope[] = [];
  private readonly waiters: Array<{ count: number; resolve: (v: RequestEnvelope[]) => void }> = [];

  constructor() {
    let pending = "";
    this.stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim().length) this.sent.push(JSON.parse(line) as RequestEnvelope);
        newline = pending.indexOf("\n");
      }
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i]!;
        if (this.sent.length >= waiter.count) {
          this.waiters.splice(i, 1);
          waiter.resolve(this.sent.slice(0, waiter.count));
        }
      }
    });
  }

  received(count: number): Promise<RequestEnvelope[]> {
    if (this.sent.length >= count) return Promise.resolve(this.sent.slice(0, count));
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  respondOk(id: string, type: string, value: unknown): void {
    this.write({ version: 1, id, outcome: { status: "ok", value: { type, value } } });
  }

  respondErr(id: string, body: ProtocolErrorBody): void {
    this.write({ version: 1, id, outcome: { status: "err", value: body } });
  }

  emit(subscriptionId: string, event: RuntimeEventDto): void {
    this.write({ version: 1, subscription_id: subscriptionId, event });
  }

  endStdout(): void { this.stdout.end(); }

  /**
   * Write bytes to stdout verbatim, so a test can put several frames — or a
   * deliberately corrupt line — into one chunk. Task 3's subscribe-race case
   * and Task 2's mixed-chunk framing case both need this.
   */
  writeRaw(text: string): void { this.stdout.write(text); }

  private write(frame: unknown): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}
```

- [ ] **Step 8: Implement `VaultdClient`**

Create `host/packages/host/src/client/client.ts`. The whole correlation story is one `Map<string, Deferred>`; the frame router distinguishes a response from an event by the presence of `id`:

```ts
import { LineFramer } from "./framing";
import { PROTOCOL_VERSION } from "./protocol";
import type { ErrorCode, EventEnvelope, ProtocolErrorBody, ResponseEnvelope } from "./protocol";

export class VaultdError extends Error {
  readonly code: ErrorCode;
  readonly currentGeneration: number | null;
  readonly supportedVersion: number | null;
  constructor(body: ProtocolErrorBody) {
    super(`${body.code}: ${body.message}`);
    this.name = "VaultdError";
    this.code = body.code;
    this.currentGeneration = body.current_generation ?? null;
    this.supportedVersion = body.supported_version ?? null;
  }
}

interface Deferred { resolve(value: unknown): void; reject(error: Error): void }

export interface VaultdClientOptions {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  onEvent(envelope: EventEnvelope): void;
  onFatal(error: Error): void;
}

export class VaultdClient {
  private readonly framer = new LineFramer();
  private readonly pending = new Map<string, Deferred>();
  private counter = 0;
  private closed = false;

  constructor(private readonly options: VaultdClientOptions) {
    options.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    options.stdout.on("end", () => this.die(new Error("daemon stdout closed")));
    options.stdout.on("error", (error: Error) => this.die(error));
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("client is closed"));
    const id = `h-${(this.counter += 1)}`;
    const envelope = params === undefined
      ? { version: PROTOCOL_VERSION, id, request: { method } }
      : { version: PROTOCOL_VERSION, id, request: { method, params } };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.options.stdin.write(LineFramer.encode(envelope));
    });
  }

  pendingCount(): number { return this.pending.size; }

  failAllPending(reason: Error): void {
    for (const [, deferred] of this.pending) deferred.reject(reason);
    this.pending.clear();
  }

  close(): void { this.closed = true; this.failAllPending(new Error("client closed")); }

  private consume(chunk: Buffer): void {
    const { frames, error } = this.framer.push(chunk);
    // Settle every frame that did arrive intact BEFORE reporting the framing
    // failure. A response and a corrupt line can share one chunk, and the
    // response's caller is entitled to its answer even though the connection
    // is about to die.
    for (const frame of frames) {
      if ("id" in frame) this.settle(frame);
      else this.route(frame);
    }
    if (error) this.die(error);
  }

  private settle(frame: ResponseEnvelope): void {
    const deferred = this.pending.get(frame.id);
    if (!deferred) return;
    this.pending.delete(frame.id);
    if (frame.outcome.status === "ok") deferred.resolve(frame.outcome.value.value);
    else deferred.reject(new VaultdError(frame.outcome.value));
  }

  private die(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(error);
    this.options.onFatal(error);
  }
}
```

- [ ] **Step 9: Run and observe it pass**

```bash
npm --prefix host test -- client-request
npm --prefix host test -- client-framing
```

Expected: all cases pass. Run the request suite ten times (`for i in $(seq 10); do npm --prefix host test -- client-request || break; done`) and confirm no flake, because everything here is stream-timing sensitive.

- [ ] **Step 10: Commit**

```bash
git add host/packages/host/src/client host/packages/host/src/testing/fake-daemon.ts host/packages/host/test
git commit -m "feat(host): add the vaultd stdio client with framing and correlation"
```

---

### Task 3: The vaultd client — subscriptions and unknown-variant tolerance

**Files:**

- Modify: `host/packages/host/src/client/protocol.ts`
- Modify: `host/packages/host/src/client/client.ts`
- Create: `host/packages/host/src/client/events.ts`
- Create: `host/packages/host/test/client-events.test.ts`

**Interfaces:**

- Produces (`events.ts`), mirroring `vault-protocol::events` exactly, with the tolerance the daemon's hardening obliges:

```ts
export type LiveStateDto =
  | "starting" | "catching_up" | "watching" | "polling_fallback" | "stopped" | (string & {});
export type GenerationCauseDto =
  | "watcher" | "startup" | "periodic" | "manual" | "verified" | "mutation" | (string & {});
export type ResyncReasonDto =
  | "subscriber_lag" | "oversized_change_set" | "runtime_recovered"
  | "watcher_overflow" | "root_invalidated" | (string & {});

export type ChangeSetDto =
  | { kind: "detailed"; created: string[]; modified: string[]; deleted: string[] }
  | { kind: "counts_only"; created: number; modified: number; deleted: number }
  | { kind: string & {} };

export type RuntimeEventDto =
  | { type: "generation_committed"; value: GenerationCommittedEventDto }
  | { type: "runtime_state_changed"; value: RuntimeStateChangedEventDto }
  | { type: "resync_required"; value: ResyncRequiredEventDto }
  | { type: "config_changed"; value: ConfigChangedEventDto }
  | { type: string & {}; value: unknown };

export interface GenerationCommittedEventDto {
  previous_generation: number | null;
  generation: number;
  cause: GenerationCauseDto;
  changes: ChangeSetDto;
  affected_note_count: number;
  affected_reference_count: number;
}
export interface RuntimeStateChangedEventDto {
  generation: number | null; live_state: LiveStateDto;
  error_code?: string; message?: string;
}
export interface ResyncRequiredEventDto {
  current_generation: number | null; reason: ResyncReasonDto;
}
export interface ConfigChangedEventDto { path: string }
```

`ConfigChangedEventDto` carries **`path` and nothing else** — that is the whole payload in the revised phase-5 plan (`RuntimeEventDto::ConfigChanged(ConfigChangedEventDto { path: String })`). v1 of this plan invented a `revision` field. Any consumer that wants the new bytes re-reads the file through `read_file`, which returns the revision anyway.

- Produces (`client.ts` additions):

```ts
export interface SubscriptionHandle {
  readonly subscriptionId: string;
  readonly startGeneration: number | null;
  readonly liveState: LiveStateDto;
  close(): Promise<void>;
}
export interface VaultdClient {
  subscribeEvents(handler: (event: RuntimeEventDto) => void): Promise<SubscriptionHandle>;
}
```

**The subscription-registration race, and which way it is fixed.** The obvious fix is "register the handler before you send the request", but the client **cannot** do that: `subscribe_events` takes `{}` and the `subscription_id` is minted by the daemon and returned in the response (`SubscribeEventsParams {}` / `SubscribeEventsResponse { subscription_id, generation, live_state }` in `vault-protocol`). There is no client-generated token to key a handler on, and inventing one would be a protocol change this phase is not allowed to make.

So the fix is the other branch: **the client buffers events for a subscription it has not yet installed a handler for.** `await this.request(...)` yields the microtask queue, and the daemon's next chunk can be processed during that yield, so an event genuinely can be routed before `subscriptions.set(...)` runs — even though the daemon emits nothing before the response, the *client* can process the response frame and the first event frame in the same `consume` call. The router therefore appends an event whose `subscription_id` is unknown into `orphanEvents: Map<string, RuntimeEventDto[]>` (bounded at 256 per id, then the oldest are dropped and a `resync_required { subscriber_lag }` is synthesized for that subscription); `subscribeEvents` drains that buffer, in order, immediately after installing the handler and before it resolves. An id that is still orphaned after the subscribe settles is a genuinely unknown subscription and its buffer is discarded on the next drain sweep.

This also fixes the prose/code disagreement v1 carried: the prose claimed pre-registration while the code awaited the response first. The code below is the contract; the prose above describes it.

- [ ] **Step 1: Write the failing subscription test**

Create `host/packages/host/test/client-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { VaultdClient } from "../src/client/client";
import { FakeDaemon } from "../src/testing/fake-daemon";
import type { RuntimeEventDto } from "../src/client/events";

const connect = (daemon: FakeDaemon, seen: RuntimeEventDto[]) =>
  new VaultdClient({
    stdout: daemon.stdout, stdin: daemon.stdin,
    onEvent: (envelope) => seen.push(envelope.event), onFatal: () => {},
  });

describe("subscribeEvents", () => {
  it("returns the start generation and routes events to the handler", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [sent] = await daemon.received(1);
    expect(sent!.request.method).toBe("subscribe_events");
    expect(sent!.request.params).toEqual({});
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1", generation: 12, live_state: "watching",
    });
    const handle = await pending;
    expect(handle.subscriptionId).toBe("sub-1");
    expect(handle.startGeneration).toBe(12);
    daemon.emit("sub-1", {
      type: "generation_committed",
      value: {
        previous_generation: 12, generation: 13, cause: "mutation",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1, affected_reference_count: 0,
      },
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]!.type).toBe("generation_committed");
  });

  it("delivers an unknown event type instead of throwing", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [sent] = await daemon.received(1);
    daemon.respondOk(sent!.id, "subscribe_events", {
      subscription_id: "sub-1", generation: null, live_state: "starting",
    });
    await pending;
    daemon.emit("sub-1", { type: "future_event", value: { anything: true } } as RuntimeEventDto);
    daemon.emit("sub-1", {
      type: "generation_committed",
      value: {
        previous_generation: null, generation: 1, cause: "some_future_cause",
        changes: { kind: "some_future_kind" },
        affected_note_count: 0, affected_reference_count: 0,
      },
    } as RuntimeEventDto);
    expect(routed.map((event) => event.type)).toEqual(["future_event", "generation_committed"]);
  });

  it("ignores events for a subscription it already closed", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [subscribe] = await daemon.received(1);
    daemon.respondOk(subscribe!.id, "subscribe_events", {
      subscription_id: "sub-1", generation: 3, live_state: "watching",
    });
    const handle = await pending;
    const closing = handle.close();
    const sent = await daemon.received(2);
    expect(sent[1]!.request.method).toBe("unsubscribe");
    daemon.respondOk(sent[1]!.id, "unsubscribe", { subscription_id: "sub-1" });
    await closing;
    daemon.emit("sub-1", { type: "resync_required", value: { current_generation: 9, reason: "runtime_recovered" } });
    expect(routed).toHaveLength(0);
  });

  it("delivers an event that raced the subscribe response, in order, before resolving", async () => {
    const daemon = new FakeDaemon();
    const routed: RuntimeEventDto[] = [];
    const client = connect(daemon, []);
    const pending = client.subscribeEvents((event) => routed.push(event));
    const [sent] = await daemon.received(1);
    // One chunk carrying the subscribe response AND two events for the
    // subscription it is about to create. The client parses all three frames
    // in one `consume` call, so the handler is provably not installed yet when
    // the events are routed.
    daemon.writeRaw(
      `${JSON.stringify({
        version: 1, id: sent!.id,
        outcome: { status: "ok", value: { type: "subscribe_events", value: {
          subscription_id: "sub-1", generation: 5, live_state: "watching",
        } } },
      })}\n` +
      `${JSON.stringify({
        version: 1, subscription_id: "sub-1",
        event: { type: "generation_committed", value: {
          previous_generation: 5, generation: 6, cause: "watcher",
          changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
          affected_note_count: 1, affected_reference_count: 0,
        } },
      })}\n` +
      `${JSON.stringify({
        version: 1, subscription_id: "sub-1",
        event: { type: "resync_required", value: { current_generation: 7, reason: "watcher_overflow" } },
      })}\n`,
    );
    const handle = await pending;
    expect(handle.subscriptionId).toBe("sub-1");
    // Both events must already be delivered, in arrival order, by the time the
    // subscribe promise resolves. A dropped first event is the exact bug the
    // orphan buffer exists to prevent, and it is invisible without this test.
    expect(routed.map((event) => event.type)).toEqual([
      "generation_committed", "resync_required",
    ]);
  });
});
```

`writeRaw(text)` is one `FakeDaemon` helper this task adds: it writes the given string to `stdout` verbatim, so a test can put several frames in one chunk. Everything else about `FakeDaemon` is unchanged from Task 2.

- [ ] **Step 2: Run it and observe the missing method**

```bash
npm --prefix host test -- client-events
```

Expected: `client.subscribeEvents is not a function`.

- [ ] **Step 3: Implement subscriptions with the orphan buffer**

Add to `client.ts`:

```ts
private readonly subscriptions = new Map<string, (event: RuntimeEventDto) => void>();
private readonly orphanEvents = new Map<string, RuntimeEventDto[]>();
private readonly closedSubscriptions = new Set<string>();
private pendingSubscribes = 0;

private static readonly ORPHAN_LIMIT = 256;

/** The frame router `consume` calls for every event envelope. */
private route(frame: EventEnvelope): void {
  const handler = this.subscriptions.get(frame.subscription_id);
  if (handler) {
    handler(frame.event);
  } else if (this.pendingSubscribes > 0 && !this.closedSubscriptions.has(frame.subscription_id)) {
    const queued = this.orphanEvents.get(frame.subscription_id) ?? [];
    if (queued.length >= VaultdClient.ORPHAN_LIMIT) {
      queued.shift();
      queued[0] = { type: "resync_required", value: { current_generation: null, reason: "subscriber_lag" } };
    }
    queued.push(frame.event);
    this.orphanEvents.set(frame.subscription_id, queued);
  }
  this.options.onEvent(frame);
}

async subscribeEvents(handler: (event: RuntimeEventDto) => void): Promise<SubscriptionHandle> {
  this.pendingSubscribes += 1;
  let response: { subscription_id: string; generation: number | null; live_state: LiveStateDto };
  try {
    response = await this.request<typeof response>("subscribe_events", {});
  } finally {
    this.pendingSubscribes -= 1;
  }
  const id = response.subscription_id;
  this.subscriptions.set(id, handler);
  // Drain anything that arrived during the round trip, in arrival order,
  // before this promise resolves — so the caller never observes a gap.
  const buffered = this.orphanEvents.get(id);
  this.orphanEvents.delete(id);
  if (this.pendingSubscribes === 0) this.orphanEvents.clear();
  for (const event of buffered ?? []) handler(event);
  const self = this;
  return {
    subscriptionId: id,
    startGeneration: response.generation,
    liveState: response.live_state,
    async close(): Promise<void> {
      await self.request("unsubscribe", { subscription_id: id });
      self.subscriptions.delete(id);
      self.closedSubscriptions.add(id);
    },
  };
}
```

Two details are load-bearing. Deleting the handler only **after** the `unsubscribe` response resolves is what makes the third test case pass: the daemon flushes that subscription's queue before answering, so events arriving during the round trip are still that subscription's, and events after it are not. And `closedSubscriptions` is what stops a post-`close` event from being buffered as an orphan and replayed to a future subscription that happens to reuse the id.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- client-events
```

Expected: four cases pass, including the unknown-variant case — which is the point of the `(string & {})` unions. TypeScript keeps autocomplete for the known variants and still accepts anything the daemon sends.

- [ ] **Step 5: Commit**

```bash
git add host/packages/host/src/client host/packages/host/test/client-events.test.ts
git commit -m "feat(host): subscribe to daemon events with unknown-variant tolerance"
```

---

### Task 4: The supervisor

**Files:**

- Create: `host/packages/host/src/config.ts`
- Create: `host/packages/host/src/supervisor.ts`
- Create: `host/packages/host/test/supervisor.test.ts`
- Create: `host/packages/host/test/fixtures/fake-vaultd.js`

**Interfaces:**

- Produces:

```ts
/**
 * The one time source. Every component whose behavior depends on the clock
 * takes it from `HostConfig.clock`, never from the global — see Global
 * Constraints. Plugin-facing timers deliberately use the real globals.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}
export function systemClock(): Clock;

export interface HostConfig {
  readonly vaultRoot: string;
  readonly vaultdBinary: string;
  readonly vaultdArgs: readonly string[];
  /**
   * Extra environment for the spawned engine, merged over `process.env`. This
   * is the seam the supervisor tests drive: the fake daemon reads
   * `FAKE_VAULTD_MODE` from here, and without it there is no way to spawn the
   * fake in a chosen mode without mutating the test process's own env.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly indexPath: string | null;
  readonly configDirName: string;          // ".obsidian-headless"
  readonly dataDir: string;                // $XDG_STATE_HOME/vaultd-host
  readonly socketPath: string;
  readonly clock: Clock;                   // systemClock() by default
  readonly appVersion: string;             // the version the shim reports
  readonly promptTimeoutMs: number;        // 120_000
  readonly quarantineFailures: number;     // 5
  readonly quarantineWindowMs: number;     // 60_000
  readonly overlapPollMs: number;          // 60_000
  readonly snapshotPageSize: number;       // 500
  readonly snapshotPageSizeMax: number;    // 2_000
  readonly writeFileCapBytes: number;      // 16 * 1024 * 1024
  readonly unloadBudgetMs: number;         // 5_000
  readonly restartBackoffMs: readonly number[]; // [250, 500, 1000, 2000, 5000]
  readonly reloadPluginsOnEngineRestart: boolean; // false — Ruling 7
  readonly momentLocale: string;           // "en"
  readonly dryRun: boolean;
  readonly dryRunAllowNetwork: boolean;
  readonly forceShared: readonly string[];
}
export function defaultHostConfig(vaultRoot: string): HostConfig;
```

```ts
export type SupervisorState = "starting" | "running" | "restarting" | "stopped";
export interface SupervisorEvents {
  onClientReady(client: VaultdClient): void | Promise<void>;
  onEngineLost(reason: Error): void | Promise<void>;
  onStateChange(state: SupervisorState): void;
}
export class Supervisor {
  constructor(config: HostConfig, events: SupervisorEvents);
  start(): Promise<void>;
  state(): SupervisorState;
  restartCount(): number;
  client(): VaultdClient;
  stop(): Promise<void>;
}
```

The supervisor spawns with `env: { ...process.env, ...config.env }` and `stdio: ["pipe", "pipe", "inherit"]`, and waits the backoff through `config.clock.setTimeout`. Both are why `env` and `clock` sit on `HostConfig` rather than on a second options object: the supervisor already takes the whole config, and a parallel `SupervisorOptions` would be a second place for the same two values to drift.

The lifecycle runs in both directions and is stated here so nobody has to infer it: the supervisor owns `vaultd`'s `stdin`/`stdout`; when the host exits, `stdin` closes and `vaultd` exits with it, so no orphan daemon can survive a host crash and keep the writer lease. `stop()` closes `stdin` and waits for exit, escalating to `SIGTERM` after 2 s and `SIGKILL` after 5 s.

- [ ] **Step 1: Write the fake daemon binary**

Create `host/packages/host/test/fixtures/fake-vaultd.js` — a real child process, because in-process fakes cannot prove spawn/exit behavior:

```js
"use strict";
const readline = require("node:readline");
const mode = process.env.FAKE_VAULTD_MODE ?? "ok";
let generation = Number(process.env.FAKE_VAULTD_GENERATION ?? "1");
if (mode === "exit-immediately") process.exit(3);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const envelope = JSON.parse(line);
  const method = envelope.request.method;
  if (method === "health") {
    process.stdout.write(JSON.stringify({
      version: 1, id: envelope.id,
      outcome: { status: "ok", value: { type: "health", value: { service: "vaultd", status: "ok" } } },
    }) + "\n");
    if (mode === "die-after-health") process.exit(9);
    return;
  }
  if (method === "get_vault_info") {
    process.stdout.write(JSON.stringify({
      version: 1, id: envelope.id,
      outcome: { status: "ok", value: { type: "get_vault_info", value: {
        generation, canonical_root: process.env.FAKE_VAULTD_ROOT ?? "/tmp/vault",
        // Echo the mode so the supervisor test can prove config.env reached
        // this process rather than merely existing on the config object.
        vault_identity: `fake:${mode}`, state: { state: "ready" }, note_count: 0,
        refreshed_at_unix_ms: 0, live_state: "watching",
      } } },
    }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    version: 1, id: envelope.id,
    outcome: { status: "err", value: { code: "invalid_request", message: `unknown method ${method}` } },
  }) + "\n");
});
rl.on("close", () => process.exit(0));
```

- [ ] **Step 2: Write the failing supervisor test**

Create `host/packages/host/test/supervisor.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultHostConfig, systemClock } from "../src/config";
import { Supervisor } from "../src/supervisor";
import type { HostConfig } from "../src/config";

const fake = join(__dirname, "fixtures", "fake-vaultd.js");

// `env` is a real HostConfig field (see Interfaces above), so this spread
// type-checks and the value actually reaches the spawned child. Without it the
// three modes below would all spawn the same "ok" daemon and two of these
// three cases would silently assert nothing.
const configFor = (mode: string): HostConfig => {
  const root = mkdtempSync(join(tmpdir(), "vaultd-sup-"));
  return {
    ...defaultHostConfig(root),
    vaultdBinary: process.execPath,
    vaultdArgs: [fake],
    restartBackoffMs: [1, 1, 1],
    clock: systemClock(),   // real process spawning, real waits
    env: { FAKE_VAULTD_MODE: mode },
  };
};

describe("Supervisor", () => {
  it("passes config.env through to the spawned engine", async () => {
    const config = configFor("ok");
    const supervisor = new Supervisor(config, {
      onClientReady: () => {}, onEngineLost: () => {}, onStateChange: () => {},
    });
    await supervisor.start();
    // The fake echoes its own view of FAKE_VAULTD_MODE back through
    // get_vault_info's vault_identity, so this asserts the env actually
    // crossed the process boundary rather than that the object had a key.
    await expect(
      supervisor.client().request<{ vault_identity: string }>("get_vault_info"),
    ).resolves.toMatchObject({ vault_identity: "fake:ok" });
    await supervisor.stop();
  });

  it("spawns the engine and answers health through the client", async () => {
    const supervisor = new Supervisor(configFor("ok"), {
      onClientReady: () => {}, onEngineLost: () => {}, onStateChange: () => {},
    });
    await supervisor.start();
    expect(supervisor.state()).toBe("running");
    await expect(supervisor.client().request("health")).resolves.toEqual({
      service: "vaultd", status: "ok",
    });
    await supervisor.stop();
    expect(supervisor.state()).toBe("stopped");
  });

  it("restarts a dying engine and calls onEngineLost then onClientReady", async () => {
    const order: string[] = [];
    let ready = 0;
    const supervisor = new Supervisor(configFor("die-after-health"), {
      onClientReady: () => { ready += 1; order.push("ready"); },
      onEngineLost: () => { order.push("lost"); },
      onStateChange: (state) => order.push(`state:${state}`),
    });
    await supervisor.start();
    await supervisor.client().request("health").catch(() => undefined);
    await new Promise<void>((resolve) => {
      const check = () => (supervisor.restartCount() >= 1 ? resolve() : setImmediate(check));
      check();
    });
    expect(order).toContain("lost");
    expect(order).toContain("state:restarting");
    expect(ready).toBeGreaterThanOrEqual(2);
    await supervisor.stop();
  });

  it("gives up after the backoff ladder is exhausted", async () => {
    let lost = 0;
    const supervisor = new Supervisor(configFor("exit-immediately"), {
      onClientReady: () => {}, onEngineLost: () => { lost += 1; }, onStateChange: () => {},
    });
    await expect(supervisor.start()).rejects.toThrow(/engine failed to start/);
    expect(lost).toBe(3);
    expect(supervisor.state()).toBe("stopped");
  });
});
```

- [ ] **Step 3: Run it and observe the missing modules**

```bash
npm --prefix host test -- supervisor
```

Expected: cannot resolve `../src/config` or `../src/supervisor`.

- [ ] **Step 4: Implement `HostConfig`**

Create `config.ts` with `defaultHostConfig` filling every constant from the Global Constraints list, `env: {}`, `clock: systemClock()`, `dataDir` from `process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")` plus `"vaultd-host"`, and `socketPath` at `join(dataDir, "run", hashOfVaultRoot, "host.sock")` — one socket per vault root, in a directory the host owns. `systemClock()` is five one-line delegations to the globals; it exists so that nothing else in `src/` ever names `setTimeout` directly.

- [ ] **Step 5: Implement `Supervisor`**

Create `supervisor.ts`. `start()` runs `spawnOnce()`; on child `exit` while `state !== "stopped"`, it calls `events.onEngineLost`, transitions to `restarting`, waits `restartBackoffMs[attempt]` through `config.clock.setTimeout`, and re-spawns; when the ladder is exhausted it transitions to `stopped` and rejects (or, after a successful start, reports fatal). Each spawn is `spawn(config.vaultdBinary, config.vaultdArgs, { env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "inherit"] })`, builds a fresh `VaultdClient` over the new child's streams, awaits one `health` round trip as the readiness proof, then calls `events.onClientReady(client)`. The previous client's pending requests are failed with `new Error("vaultd restarted")` — never left hanging, because a hung shim write is indistinguishable from a wedged plugin.

- [ ] **Step 6: Run and observe it pass**

```bash
npm --prefix host test -- supervisor
```

Expected: four cases pass. Run ten times; process-spawn tests are the most flake-prone in the suite and this is where a hidden sleep would show up.

- [ ] **Step 7: Commit**

```bash
git add host/packages/host/src/config.ts host/packages/host/src/supervisor.ts host/packages/host/test
git commit -m "feat(host): supervise the vaultd engine with restart and readiness proof"
```

---

### Task 5: Mirror hydration from snapshot sessions

**Files:**

- Create: `host/packages/host/src/mirror/types.ts`
- Create: `host/packages/host/src/mirror/positions.ts`
- Create: `host/packages/host/src/mirror/hydrate.ts`
- Create: `host/packages/host/test/mirror-positions.test.ts`
- Create: `host/packages/host/test/mirror-hydrate.test.ts`

**Interfaces:**

- Produces (`types.ts`) — **the eight wire DTOs, transcribed field-for-field from the revised phase-5 plan's `crates/vault-protocol/src/semantic.rs` and `snapshots.rs`.** Every one of these was named but never defined in v1 of this plan, which meant eight opportunities for the mirror and the daemon to disagree in silence. `snake_case` is preserved exactly, because these are wire types and the camelCase conversion happens once, at the mirror boundary, in `hydrate.ts`:

```ts
export interface SpanDto { start: number; end: number }   // UTF-8 byte offsets, half-open

/** One frontmatter property. `value` is a recursive JSON-ish tree. */
export interface PropertyDto {
  key: string;
  value: PropertyValueDto;
  span: SpanDto;
}
export type PropertyValueDto =
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "int"; value: number }
  /** A float arrives as a STRING so no precision is lost crossing JSON. */
  | { kind: "float"; value: string }
  | { kind: "string"; value: string }
  | { kind: "list"; value: PropertyValueDto[] }
  | { kind: "map"; value: Array<{ key: string; value: PropertyValueDto }> }
  | { kind: string & {} };

export interface AliasDto { alias: string; span: SpanDto }

export interface HeadingDto { level: number; text: string; span: SpanDto }

/** A `^block-id` anchor. `span` covers the block the id belongs to. */
export interface BlockDto { id: string; span: SpanDto }

export interface TagDto {
  tag: string;                                 // canonical, WITHOUT the leading "#"
  origin: "body" | "property" | (string & {}); // frontmatter tags are "property"
  span: SpanDto;
}

/** From the schema-v3 `sections` rows. `kind` is Obsidian's own vocabulary. */
export interface SectionDto {
  kind: string;
  span: SpanDto;
  block_id?: string;
}

/**
 * From the schema-v3 `list_items` rows. The parent is a LINE NUMBER — never an
 * array index, never a sentinel. Exactly one of the two columns is set: a
 * top-level item names the start line of the list that contains it, a nested
 * item names its parent item's own start line. `task` is the raw character
 * inside the brackets, a one-character string, absent for a non-task item.
 */
export interface ListItemDto {
  span: SpanDto;
  list_start_line?: number;
  parent_start_line?: number;
  task?: string;
}

/** One link, embed, or frontmatter reference. */
export interface ReferenceDto {
  source_path: string;
  raw_target: string;                  // exactly as written, subpath included
  display_text?: string;
  kind: "wikilink" | "wiki_embed" | "markdown_link" | "markdown_embed" | (string & {});
  origin: "body" | "property" | (string & {});
  /** For a property-origin reference: the dot-and-index path, e.g. "up.0". */
  property_path?: string;
  span: SpanDto;
  target_span: SpanDto;
  resolution: ResolutionDto;
}
export interface ResolutionDto {
  status: "resolved" | "unresolved" | "ambiguous" | (string & {});
  target_path?: string;
  candidates?: string[];
}

export interface DiagnosticDto { code: string; message: string; span?: SpanDto }

export type EntryKind = "note" | "file" | "folder";

export interface MirrorEntry {
  readonly path: string;          // vault-relative, "/" separated, no leading slash
  readonly kind: EntryKind;
  readonly name: string;          // basename with extension
  readonly parent: string;        // "" for a vault-root child
  readonly revision: string | null;
  readonly size: number | null;
  readonly ctimeMs: number;       // from TreeEntryDto.ctime_unix_ms
  readonly mtimeMs: number;       // from TreeEntryDto.mtime_unix_ms
}

/**
 * The mirror's per-note row. This is the camelCase side of the boundary: the
 * DTO field names above become these, once, in `hydrate.ts`. Task 8 builds
 * Obsidian's `CachedMetadata` from exactly this shape plus a `PositionIndex`,
 * and Task 6b's `fixture-row` binary prints exactly this shape as JSON.
 */
export interface MirrorNoteRow {
  readonly path: string;
  readonly revision: string;
  readonly properties: readonly PropertyDto[];
  readonly aliases: readonly AliasDto[];
  readonly headings: readonly HeadingDto[];
  readonly blocks: readonly BlockDto[];
  readonly tags: readonly TagDto[];
  readonly diagnostics: readonly DiagnosticDto[];
  readonly sections: readonly SectionDto[];
  readonly listItems: readonly ListItemDto[];
  readonly outgoing: readonly ReferenceDto[];
}
```

- Produces (`types.ts`) — the snapshot response shapes, also transcribed from the revised phase-5 plan. **Three spellings here are corrections against v1 of this plan and each one would have produced a mirror that hydrated to nothing:**

```ts
export interface OpenSnapshotResponse {
  snapshot_id: string; generation: number; note_count: number; entry_count: number;
}

export type TreeEntryKindDto = "folder" | "note" | "file";
export interface TreeEntryDto {
  path: string;
  kind: TreeEntryKindDto;
  size?: number;             // absent for a folder
  ctime_unix_ms: number;     // birthtime, mtime where unavailable
  mtime_unix_ms: number;
  revision?: string;         // absent for a folder
}
export interface SnapshotTreeResponse {
  snapshot_id: string; generation: number;
  entries: TreeEntryDto[];          // NOT `items`
  next_cursor: string | null;
}

export type NoteFacetDto =
  | "metadata" | "references" | "resolutions" | "backlinks" | "sections" | "list_items";

export interface NoteMetadataDto {
  properties: PropertyDto[]; aliases: AliasDto[]; headings: HeadingDto[];
  blocks: BlockDto[]; tags: TagDto[]; diagnostics: DiagnosticDto[];
}
export interface SnapshotNoteDto {
  path: string;
  revision: string;
  metadata?: NoteMetadataDto;
  references?: ReferenceDto[];
  resolutions?: ResolutionDto[];
  backlinks?: ReferenceDto[];
  sections?: SectionDto[];          // TOP LEVEL, sibling of metadata
  list_items?: ListItemDto[];       // TOP LEVEL, sibling of metadata
}
export interface SnapshotNotesResponse {
  snapshot_id: string; generation: number;
  notes: SnapshotNoteDto[];         // NOT `items`
  next_cursor: string | null;
}
```

1. `snapshot_tree` answers `entries`, not `items`.
2. `snapshot_notes` answers `notes`, not `items`.
3. **`sections` and `list_items` are separate top-level facets, siblings of `metadata`, never nested inside it.** Both the pre-task's pinned DDL and the phase-5 plan's `NoteFacetDto` say so explicitly. A client that asks for `include: ["metadata"]` and expects `metadata.sections` gets nothing, silently, forever — which is precisely the failure the pre-task's wire-convention note exists to prevent. So hydration asks for `include: ["metadata", "references", "resolutions", "sections", "list_items"]`, and `TreeEntryDto` carries the two timestamps the host serves `TFile.stat` from.

- Produces (`positions.ts`) — the piece that makes a synchronous `getFileCache` possible without retaining note bodies:

```ts
export interface PositionIndex {
  readonly lineStarts: Uint32Array;   // byte offset of each line start
  readonly lineU16Starts: Uint32Array; // UTF-16 offset of each line start
  readonly wide: Uint32Array;          // flattened [byteStart, byteLen, u16Len] per non-ASCII char
}
export interface Loc { line: number; col: number; offset: number }
export interface Pos { start: Loc; end: Loc }
export function buildPositionIndex(source: string): PositionIndex;
export function locate(index: PositionIndex, byteOffset: number): Loc;
export function span(index: PositionIndex, start: number, end: number): Pos;
```

`vaultd` reports half-open UTF-8 **byte** spans; Obsidian reports `{ line, col, offset }` where `offset` counts JavaScript string units. `PositionIndex` stores only line starts plus the non-ASCII characters, so conversion is exact and the note body is not retained — roughly 8 bytes per line plus 12 bytes per non-ASCII character, versus retaining the whole vault in memory.

- Produces (`hydrate.ts`):

```ts
export interface HydrationResult {
  readonly generation: number;
  readonly entries: readonly MirrorEntry[];
  readonly notes: readonly MirrorNoteRow[];
  readonly pages: number;
  readonly elapsedMs: number;
}
export async function hydrate(client: VaultdClient, pageSize: number): Promise<HydrationResult>;
```

`hydrate` opens one snapshot session, pages `snapshot_tree` then `snapshot_notes` with `include: ["metadata", "references", "resolutions", "sections", "list_items"]`, and closes the session in a `finally` so a mid-hydration throw never leaks a WAL pin. It never issues a per-note request. On `too_many_snapshots` it retries with exponential backoff through `config.clock` (four attempts, 100/200/400/800 ms) before failing — the daemon caps concurrent sessions, and a host that treats a cap as fatal cannot start while any other client is paging.

- [ ] **Step 1: Write the failing position test**

Create `host/packages/host/test/mirror-positions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPositionIndex, locate, span } from "../src/mirror/positions";

describe("PositionIndex", () => {
  it("locates an ASCII offset exactly", () => {
    const source = "# Title\n\nBody Link end\n";
    const index = buildPositionIndex(source);
    const byteOffset = Buffer.from(source, "utf8").indexOf("Link");
    expect(locate(index, byteOffset)).toEqual({ line: 2, col: 5, offset: 14 });
  });

  it("converts byte offsets across multi-byte characters", () => {
    const source = "\u{1F600} — café 中 Link\n";
    const index = buildPositionIndex(source);
    const bytes = Buffer.from(source, "utf8");
    const byteOffset = bytes.indexOf("Link");
    const located = locate(index, byteOffset);
    expect(located.line).toBe(0);
    expect(located.offset).toBe(source.indexOf("Link"));
    expect(located.col).toBe(source.indexOf("Link"));
  });

  it("produces a Pos whose end follows its start", () => {
    const source = "line one\nline two é\n";
    const index = buildPositionIndex(source);
    const bytes = Buffer.from(source, "utf8");
    const pos = span(index, bytes.indexOf("two"), bytes.indexOf("two") + 3);
    expect(pos.start).toEqual({ line: 1, col: 5, offset: 14 });
    expect(pos.end).toEqual({ line: 1, col: 8, offset: 17 });
  });

  it("round-trips every character boundary of the wide fixture", () => {
    const source = "aéb中c\u{1F600}d\n—e\n";
    const index = buildPositionIndex(source);
    const bytes = Buffer.from(source, "utf8");
    for (let u16 = 0; u16 <= source.length; u16 += 1) {
      if (u16 > 0 && u16 < source.length) {
        const code = source.charCodeAt(u16);
        if (code >= 0xdc00 && code <= 0xdfff) continue; // low surrogate: not a boundary
      }
      const byteOffset = Buffer.from(source.slice(0, u16), "utf8").length;
      expect(locate(index, byteOffset).offset).toBe(u16);
      expect(byteOffset).toBeLessThanOrEqual(bytes.length);
    }
  });
});
```

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- mirror-positions
```

Expected: cannot resolve `../src/mirror/positions`.

- [ ] **Step 3: Implement the position index**

Create `positions.ts`. Build in one pass over the source, recording a line start at every `\n` and a `wide` triple at every code point whose UTF-8 length exceeds one byte:

```ts
export function buildPositionIndex(source: string): PositionIndex {
  const lineStarts: number[] = [0];
  const lineU16Starts: number[] = [0];
  const wide: number[] = [];
  let byte = 0;
  for (let u16 = 0; u16 < source.length; ) {
    const codePoint = source.codePointAt(u16)!;
    const u16Len = codePoint > 0xffff ? 2 : 1;
    const byteLen = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (byteLen > 1) wide.push(byte, byteLen, u16Len);
    byte += byteLen;
    u16 += u16Len;
    if (codePoint === 0x0a) { lineStarts.push(byte); lineU16Starts.push(u16); }
  }
  return {
    lineStarts: Uint32Array.from(lineStarts),
    lineU16Starts: Uint32Array.from(lineU16Starts),
    wide: Uint32Array.from(wide),
  };
}
```

`locate` binary-searches `lineStarts` for the line, then walks the `wide` triples between the line start and the target byte offset, accumulating `u16Total - byteTotal` so `offset = lineU16Start + (byteOffset - lineStart) + delta` and `col = offset - lineU16Start`. Because `wide` is sorted by byte offset, the walk is a second binary search plus a bounded scan, not a scan of the note.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- mirror-positions
```

Expected: four cases pass, including the exhaustive boundary round trip.

- [ ] **Step 5: Write the failing hydration test**

Create `host/packages/host/test/mirror-hydrate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { VaultdClient } from "../src/client/client";
import { FakeDaemon } from "../src/testing/fake-daemon";
import { hydrate } from "../src/mirror/hydrate";

describe("hydrate", () => {
  it("pages tree and notes inside one snapshot session and always closes it", async () => {
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout, stdin: daemon.stdin, onEvent: () => {}, onFatal: () => {},
    });
    const pending = hydrate(client, 2);

    const open = (await daemon.received(1))[0]!;
    expect(open.request.method).toBe("open_snapshot");
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-1", generation: 42, note_count: 3, entry_count: 4,
    });

    const treeA = (await daemon.received(2))[1]!;
    expect(treeA.request).toEqual({
      method: "snapshot_tree", params: { snapshot_id: "snap-1", cursor: null, limit: 2 },
    });
    // `entries`, not `items` — the revised phase-5 SnapshotTreeResponse.
    daemon.respondOk(treeA.id, "snapshot_tree", {
      snapshot_id: "snap-1", generation: 42, next_cursor: "c1", entries: [
        { path: "Folder", kind: "folder", ctime_unix_ms: 1, mtime_unix_ms: 1 },
        { path: "Folder/A.md", kind: "note", revision: "blake3:aa", size: 10, ctime_unix_ms: 2, mtime_unix_ms: 2 },
      ],
    });
    const treeB = (await daemon.received(3))[2]!;
    daemon.respondOk(treeB.id, "snapshot_tree", {
      snapshot_id: "snap-1", generation: 42, next_cursor: null, entries: [
        { path: "B.md", kind: "note", revision: "blake3:bb", size: 4, ctime_unix_ms: 3, mtime_unix_ms: 3 },
        { path: "img.png", kind: "file", revision: "blake3:cc", size: 99, ctime_unix_ms: 4, mtime_unix_ms: 4 },
      ],
    });

    const notes = (await daemon.received(4))[3]!;
    // sections and list_items are requested BY NAME as top-level facets. A
    // client that omits them gets no structural data and no error.
    expect(notes.request).toEqual({
      method: "snapshot_notes",
      params: {
        snapshot_id: "snap-1", cursor: null, limit: 2,
        include: ["metadata", "references", "resolutions", "sections", "list_items"],
      },
    });
    // `notes`, not `items`; sections and list_items are siblings of metadata.
    daemon.respondOk(notes.id, "snapshot_notes", {
      snapshot_id: "snap-1", generation: 42, next_cursor: null, notes: [
        {
          path: "Folder/A.md", revision: "blake3:aa",
          metadata: { properties: [], aliases: [], headings: [], blocks: [], tags: [], diagnostics: [] },
          references: [], resolutions: [], sections: [], list_items: [],
        },
      ],
    });

    const close = (await daemon.received(5))[4]!;
    expect(close.request).toEqual({ method: "close_snapshot", params: { snapshot_id: "snap-1" } });
    daemon.respondOk(close.id, "close_snapshot", { snapshot_id: "snap-1" });

    const result = await pending;
    expect(result.generation).toBe(42);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "Folder", "Folder/A.md", "B.md", "img.png",
    ]);
    expect(result.entries[1]).toMatchObject({ name: "A.md", parent: "Folder", kind: "note" });
    expect(result.notes).toHaveLength(1);
    expect(result.pages).toBe(3);
  });

  it("closes the snapshot even when a page fails", async () => {
    const daemon = new FakeDaemon();
    const client = new VaultdClient({
      stdout: daemon.stdout, stdin: daemon.stdin, onEvent: () => {}, onFatal: () => {},
    });
    const pending = hydrate(client, 500);
    const open = (await daemon.received(1))[0]!;
    daemon.respondOk(open.id, "open_snapshot", {
      snapshot_id: "snap-9", generation: 1, note_count: 0, entry_count: 0,
    });
    const tree = (await daemon.received(2))[1]!;
    daemon.respondErr(tree.id, { code: "storage_failure", message: "disk went away" });
    await expect(pending).rejects.toThrow(/storage_failure/);
    const close = (await daemon.received(3))[2]!;
    expect(close.request).toEqual({ method: "close_snapshot", params: { snapshot_id: "snap-9" } });
  });
});
```

- [ ] **Step 6: Run it and observe the missing module**

```bash
npm --prefix host test -- mirror-hydrate
```

Expected: cannot resolve `../src/mirror/hydrate`.

- [ ] **Step 7: Implement hydration**

Create `hydrate.ts` with a `try { ... } finally { await close }` around both paging loops, a `pages` counter incremented per page response, `name`/`parent` derived from the path by the last `/`, `ctime_unix_ms`/`mtime_unix_ms` mapped to `ctimeMs`/`mtimeMs`, and `list_items` renamed to `listItems` at the mirror boundary — the wire is snake_case, the Obsidian-facing shape is camelCase, and the conversion happens exactly once, here. Read `response.entries` and `response.notes`; a `response.items` anywhere in this file is the v1 bug.

- [ ] **Step 8: Run and observe it pass**

```bash
npm --prefix host test -- mirror-hydrate
```

Expected: both cases pass, including the close-on-failure case.

- [ ] **Step 9: Commit**

```bash
git add host/packages/host/src/mirror host/packages/host/test
git commit -m "feat(host): hydrate the mirror from a snapshot session"
```

---

### Task 6: Mirror deltas, resync, and the query surface

**Files:**

- Create: `host/packages/host/src/mirror/mirror.ts`
- Modify: `host/packages/host/src/mirror/types.ts`
- Create: `host/packages/host/test/mirror-delta.test.ts`
- Create: `host/packages/host/test/mirror-resync.test.ts`

**Interfaces:**

- Produces — the read surface every shim task consumes and nothing else may bypass:

```ts
export interface MirrorQuery {
  generation(): number;
  entry(path: string): MirrorEntry | undefined;
  entries(): readonly MirrorEntry[];
  children(folderPath: string): readonly MirrorEntry[];
  note(path: string): MirrorNoteRow | undefined;
  positions(path: string): PositionIndex | undefined;
  resolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>>;
  unresolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>>;
  backlinks(path: string): readonly ReferenceDto[];
  firstLinkpathDest(linkpath: string, sourcePath: string): MirrorEntry | undefined;
}

export interface MirrorChangeBatch {
  readonly generation: number;
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly cause: GenerationCauseDto;
  readonly synthetic: boolean;
}

export class Mirror implements MirrorQuery {
  static open(client: VaultdClient, config: HostConfig): Promise<Mirror>;
  applyEvent(event: RuntimeEventDto): Promise<void>;
  applyMutation(generation: number, paths: readonly string[]): Promise<void>;
  warmPositions(): Promise<{ warmed: number; elapsedMs: number }>;
  onBatch(listener: (batch: MirrorChangeBatch) => void): () => void;
  /**
   * The `config_changed` fan-out. `vaultd` emits `config_changed { path }` for
   * every write into the `.obsidian` zone; the mirror is the one place that
   * sees those events, so it is the one place that can tell the config readers
   * their cached JSON is stale. Task 12's `InternalPluginRegistry` and
   * `Vault.getConfig` cache both subscribe here.
   */
  onConfigChanged(listener: (path: string) => void | Promise<void>): () => void;
  snapshotRevisions(): ReadonlyMap<string, string>;
  synthesizeDiff(previous: ReadonlyMap<string, string>): MirrorChangeBatch;
  resyncing(): boolean;
}
```

**`MirrorChangeBatch` carries no `renamed` field, deliberately.** The wire has none: `ChangeSetDto` in `vault-protocol` is `Detailed { created, modified, deleted }` or `CountsOnly { created, modified, deleted }`, and the revised phase-5 plan's `rename_note` answers a `RenameResponse { generation, revision, links_rewritten, link_rewrite_failures }` while its generation reports the move as a delete plus a create. So the mirror does not invent a rename it was never told about; **the shim synthesizes `vault.on("rename")` from the delete/create pair**, in `FileIndex.applyBatch` (Task 7), where the revisions needed to pair them are already in hand. That is the honest layer for it: the mirror models the wire, the shim models Obsidian.

- Ordering contract, which is Goal 5 of the spec and is what makes read-your-writes true **inside plugin code**, not merely at the wire: a shim write calls `applyMutation(generation, paths)` and only resolves after it returns. `applyMutation` refetches those paths' rows at that generation and installs them. The `generation_committed` event that later describes the same generation is dropped by the `generation <= current` check, so the plugin never sees a duplicate `changed` event for its own write.
- `warmPositions()` builds a `PositionIndex` for every mirrored note by `read_file` at concurrency 16. Until a note's index exists, `positions(path)` returns `undefined` and `MetadataCache.getFileCache` returns `null` — which is Obsidian's own contract for a file it has not cached yet, not an invention. The lifecycle sequencer (Task 15) fires `resolved` only after warm-up completes, so no plugin ever observes a half-warm cache through the gate that means "the cache is complete".
- `synthesizeDiff` is the engine-restart continuity mechanism (Ruling 7) and the resync mechanism, one function: compare a previous revision map against the current one and emit `created`/`modified`/`deleted` with `synthetic: true`.

- [ ] **Step 1: Write the failing delta test**

Create `host/packages/host/test/mirror-delta.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Mirror } from "../src/mirror/mirror";
import { MirrorHarness } from "../src/testing/mirror-harness";

describe("Mirror deltas", () => {
  it("applies a detailed generation_committed and notifies one batch", async () => {
    const harness = await MirrorHarness.hydrated({
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1", headings: [] }],
      generation: 5,
    });
    const batches: string[][] = [];
    harness.mirror.onBatch((batch) => batches.push([...batch.modified]));
    const applied = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 5, generation: 6, cause: "watcher",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1, affected_reference_count: 0,
      },
    });
    harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2", headings: [{ level: 1, text: "New", span: { start: 0, end: 5 } }] }]);
    await applied;
    expect(harness.mirror.generation()).toBe(6);
    expect(harness.mirror.note("A.md")?.headings[0]?.text).toBe("New");
    expect(batches).toEqual("A.md");
  });

  it("drops a generation_committed the mirror already applied from a mutation response", async () => {
    const harness = await MirrorHarness.hydrated({
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1", headings: [] }],
      generation: 5,
    });
    const batches: number[] = [];
    harness.mirror.onBatch((batch) => batches.push(batch.generation));
    const mutating = harness.mirror.applyMutation(6, ["A.md"]);
    harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2", headings: [] }]);
    await mutating;
    await harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 5, generation: 6, cause: "mutation",
        changes: { kind: "detailed", created: [], modified: ["A.md"], deleted: [] },
        affected_note_count: 1, affected_reference_count: 0,
      },
    });
    expect(batches).toEqual([6]);
    expect(harness.pendingRequests()).toHaveLength(0);
  });

  it("removes deleted paths and their backlinks", async () => {
    const harness = await MirrorHarness.hydrated({
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "B.md", kind: "note", revision: "blake3:b1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1", outgoing: [harness_ref("A.md", "B", "B.md")] },
        { path: "B.md", revision: "blake3:b1" },
      ],
      generation: 5,
    });
    expect(harness.mirror.backlinks("B.md")).toHaveLength(1);
    const applied = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 5, generation: 7, cause: "watcher",
        changes: { kind: "detailed", created: [], modified: [], deleted: ["A.md"] },
        affected_note_count: 1, affected_reference_count: 1,
      },
    });
    await applied;
    expect(harness.mirror.entry("A.md")).toBeUndefined();
    expect(harness.mirror.note("A.md")).toBeUndefined();
    expect(harness.mirror.backlinks("B.md")).toHaveLength(0);
  });
});
```

`harness_ref` is a helper the harness exports that builds a resolved `ReferenceDto` from source, raw target, and resolved target.

- [ ] **Step 2: Run it and observe the missing modules**

```bash
npm --prefix host test -- mirror-delta
```

Expected: cannot resolve `../src/mirror/mirror` or `../src/testing/mirror-harness`.

- [ ] **Step 3: Implement the mirror stores**

Create `mirror.ts` holding six maps and rebuilding only what a batch touches: `entries: Map<string, MirrorEntry>`, `notes: Map<string, MirrorNoteRow>`, `positions: Map<string, PositionIndex>`, `childIndex: Map<string, Set<string>>`, `backlinkIndex: Map<string, ReferenceDto[]>`, and `linkTables` holding the two `Record<string, Record<string, number>>` shapes. On a note's replacement, remove its old outgoing references from `backlinkIndex` and the two link tables before inserting the new ones — a rebuild-the-world implementation passes these tests and fails at 100k notes, so the delta path is the implementation, not an optimization.

- [ ] **Step 4: Implement the generation guard and the batch notification**

`applyEvent` on `generation_committed` returns immediately when `value.generation <= this.currentGeneration`. On `counts_only` it escalates to the resync path rather than guessing paths. Otherwise it fetches the changed rows — `snapshot`-free, via `get_note` for up to 64 paths, and via a fresh hydration above that threshold — installs them, sets the generation, and calls every `onBatch` listener exactly once with the batch.

- [ ] **Step 5: Run and observe it pass**

```bash
npm --prefix host test -- mirror-delta
```

Expected: three cases pass, including the "no second fetch, no second batch" assertion in case two.

- [ ] **Step 6: Write the failing resync test**

Create `host/packages/host/test/mirror-resync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MirrorHarness } from "../src/testing/mirror-harness";

describe("Mirror resync", () => {
  it("re-hydrates on resync_required and reports a synthetic diff", async () => {
    const harness = await MirrorHarness.hydrated({
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a1" },
        { path: "Gone.md", kind: "note", revision: "blake3:g1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a1" },
        { path: "Gone.md", revision: "blake3:g1" },
      ],
      generation: 5,
    });
    const batches: Array<{ generation: number; created: string[]; modified: string[]; deleted: string[]; synthetic: boolean }> = [];
    harness.mirror.onBatch((batch) => batches.push({
      generation: batch.generation,
      created: [...batch.created], modified: [...batch.modified],
      deleted: [...batch.deleted], synthetic: batch.synthetic,
    }));
    const applying = harness.mirror.applyEvent({
      type: "resync_required",
      value: { current_generation: 11, reason: "watcher_overflow" },
    });
    expect(harness.mirror.resyncing()).toBe(true);
    harness.answerHydration({
      generation: 11,
      entries: [
        { path: "A.md", kind: "note", revision: "blake3:a2" },
        { path: "New.md", kind: "note", revision: "blake3:n1" },
      ],
      notes: [
        { path: "A.md", revision: "blake3:a2" },
        { path: "New.md", revision: "blake3:n1" },
      ],
    });
    await applying;
    expect(harness.mirror.resyncing()).toBe(false);
    expect(batches).toEqual([{
      generation: 11, created: ["New.md"], modified: ["A.md"],
      deleted: ["Gone.md"], synthetic: true,
    }]);
  });

  it("escalates a counts_only change set to a re-hydration", async () => {
    const harness = await MirrorHarness.hydrated({
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
      generation: 5,
    });
    const applying = harness.mirror.applyEvent({
      type: "generation_committed",
      value: {
        previous_generation: 5, generation: 6, cause: "periodic",
        changes: { kind: "counts_only", created: 2000, modified: 0, deleted: 0 },
        affected_note_count: 2000, affected_reference_count: 0,
      },
    });
    expect(harness.nextRequest().request.method).toBe("open_snapshot");
    harness.answerHydration({ generation: 6, entries: [], notes: [] });
    await applying;
    expect(harness.mirror.generation()).toBe(6);
  });

  it("survives an unknown resync reason", async () => {
    const harness = await MirrorHarness.hydrated({ entries: [], notes: [], generation: 1 });
    const applying = harness.mirror.applyEvent({
      type: "resync_required",
      value: { current_generation: 2, reason: "some_future_reason" },
    });
    harness.answerHydration({ generation: 2, entries: [], notes: [] });
    await expect(applying).resolves.toBeUndefined();
    expect(harness.mirror.generation()).toBe(2);
  });
});
```

- [ ] **Step 7: Run it and observe the failure**

```bash
npm --prefix host test -- mirror-resync
```

Expected: fails because `resyncing`, `synthesizeDiff`, and the counts-only escalation do not exist.

- [ ] **Step 8: Implement resync and synthetic diffs**

Add `snapshotRevisions()` returning a `Map<string, string>` of every entry's revision, `synthesizeDiff(previous)` comparing it against the current map, and a `resync()` private that sets `resyncing = true`, captures the previous revision map, re-runs `hydrate`, installs everything, warms positions for changed notes only, sets `resyncing = false`, and emits the synthetic batch. Every unknown `reason` takes the same path; the reason is recorded for the compatibility report and never branched on.

- [ ] **Step 9: Implement the `config_changed` fan-out**

`applyEvent` gains one more arm. `config_changed { path }` advances no generation, touches no note row, and produces no `MirrorChangeBatch` — it calls every `onConfigChanged` listener with the path and returns:

```ts
case "config_changed": {
  const { path } = event.value as ConfigChangedEventDto;
  for (const listener of this.configListeners) await listener(path);
  return;
}
```

Listeners are awaited in registration order so a config reader has finished re-reading before the next host op runs. A listener that throws is caught, logged against the mirror (not against a plugin — no plugin is on the stack), and does not stop the remaining listeners.

- [ ] **Step 10: Run and observe it pass**

```bash
npm --prefix host test -- mirror-resync
npm --prefix host test -- mirror-delta
```

Expected: all six cases pass. Run both files ten times.

- [ ] **Step 11: Commit**

```bash
git add host/packages/host/src/mirror host/packages/host/test
git commit -m "feat(host): apply mirror deltas and resynchronize by revision diff"
```

---

### Task 6b: The test-harness family, the fixture generator, and the injected clock

Every task from here on drives its subject through a harness — `ShimHarness.withVault(...)`, `HostHarness.create(...)`, `DaemonHarness.create()` — and v1 of this plan never built one. Twelve tasks called methods on objects that had no definition anywhere, which is the single largest source of "this plan looks executable and is not" in the whole document. This task builds the family, with real code, and enumerates every method later tasks call, so a divergence is a compile error rather than a surprise at implementation time.

**Files:**

- Create: `host/packages/host/src/testing/clock.ts`
- Create: `host/packages/host/src/testing/daemon-harness.ts`
- Create: `host/packages/host/src/testing/mirror-harness.ts`
- Create: `host/packages/host/src/testing/fixture-vault.ts`
- Create: `host/packages/host/src/testing/assemble.ts`
- Create: `host/packages/host/src/testing/pending/shim-harness.ts`
- Create: `host/packages/host/src/testing/pending/pluginset-harness.ts`
- Create: `host/packages/host/src/testing/pending/host-harness.ts`
- Create: `host/packages/host/src/testing/pending/settings-harness.ts`
- Create: `host/packages/host/src/testing/pending/live-host.ts`
- Create: `host/packages/host/src/datadir.ts`
- Create: `host/packages/host/src/shim/events.ts` (the `Events` base, `EventRef`, `ShimEventBus`)
- Create: `host/packages/host/src/shim/app.ts` (the skeleton container)
- Create: `host/packages/host/test/harness-selftest.test.ts`
- Create: `crates/vault-index/src/bin/fixture-row.rs` — **outside `host/`; the one named cross-repo-directory step**
- Modify: `crates/vault-index/Cargo.toml`
- Modify: `host/packages/host/tsconfig.json`, `host/vitest.config.ts` (exclude `src/testing/pending/`)
- Modify: `host/.gitignore` (ignore `host/fixtures/cache/`)

#### Two dependency resolutions this task settles

**1. `App` and `ShimEventBus` move here, ahead of their consumers.** `Vault` (Task 7) takes `events: ShimEventBus` in its deps and `harness.app` is read by tests from Task 7 onward, but v1 produced `App` in Task 12 and `events.ts` in Task 10 — both after their first consumer. The fix is to build both here as skeletons: `App` is a mutable container whose fields are assigned once by `assembleShim()`, and `ShimEventBus` is the complete `on`/`off`/`offref`/`trigger` machinery every shim surface reuses. Task 10 adds `Menu`/`MenuItem` to the same `events.ts` file; Task 12 fills `app.plugins`, `app.internalPlugins`, `app.commands`, `app.keymap`, `app.scope`, `app.setting`, and `app.foldManager`. Nothing is re-decided later.

**2. The shim-wrapping harnesses are written here in full and *activated* by their first consumer.** `ShimHarness` cannot compile before `src/shim/vault.ts` exists, and `src/shim/vault.ts` is Task 7. So the five shim-wrapping harnesses are written here — complete, no placeholders — into `src/testing/pending/`, which `tsconfig.json` and `vitest.config.ts` both exclude. The first task that consumes each one moves the single file up one directory in its Step 1 (`git mv src/testing/pending/shim-harness.ts src/testing/shim-harness.ts`) and that task's tests then compile. Activation points: `shim-harness` → Task 7, `pluginset-harness` → Task 14, `host-harness` → Task 15, `settings-harness` → Task 17, `live-host` → Task 22. This is stated once, here, and named again in each activating task's Step 1.

**Interfaces:**

- Produces (`clock.ts`) — the `TestClock` the Global Constraints' clock seam depends on:

```ts
export interface TestClock extends Clock {
  /** Run every timer due within `ms`, in due order, advancing `now()` as it goes. */
  advance(ms: number): Promise<void>;
  /** Flush the microtask queue without moving time. */
  tick(): Promise<void>;
  /** How many timers are armed right now — used to assert nothing leaked. */
  armed(): number;
  setNow(unixMs: number): void;
}
export function testClock(startUnixMs?: number): TestClock;
```

```ts
export function testClock(startUnixMs = 1_700_000_000_000): TestClock {
  let now = startUnixMs;
  let sequence = 0;
  interface Armed { id: number; due: number; every: number | null; fn: () => void }
  const armed = new Map<number, Armed>();
  const handleOf = (id: number): NodeJS.Timeout => ({ id } as unknown as NodeJS.Timeout);
  const idOf = (handle: NodeJS.Timeout): number => (handle as unknown as { id: number }).id;

  const arm = (fn: () => void, ms: number, every: number | null): NodeJS.Timeout => {
    const id = (sequence += 1);
    armed.set(id, { id, due: now + Math.max(0, ms), every, fn });
    return handleOf(id);
  };

  return {
    now: () => now,
    setNow(unixMs: number) { now = unixMs; },
    setTimeout: (fn, ms) => arm(fn, ms, null),
    clearTimeout(handle) { armed.delete(idOf(handle)); },
    setInterval: (fn, ms) => arm(fn, ms, Math.max(1, ms)),
    clearInterval(handle) { armed.delete(idOf(handle)); },
    armed: () => armed.size,
    async tick() { await Promise.resolve(); await Promise.resolve(); },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...armed.values()]
          .filter((entry) => entry.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        now = next.due;
        if (next.every === null) armed.delete(next.id);
        else next.due = now + next.every;
        next.fn();
        // Let anything the callback awaited settle before the next timer, so
        // ordering is causal rather than merely numeric.
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    },
  };
}
```

- Produces (`daemon-harness.ts`) — a `VaultdClient` wired to a `FakeDaemon`, plus the request/response helpers every later harness inherits:

```ts
export class DaemonHarness {
  static create(overrides?: Partial<HostConfig>): DaemonHarness;
  readonly client: VaultdClient;
  readonly daemon: FakeDaemon;
  readonly config: HostConfig;
  readonly clock: TestClock;
  /** The next request the subject sent, awaited. Consumes it. */
  nextRequest(): Promise<RequestEnvelope>;
  /** Every request sent so far and not yet consumed. Does not consume. */
  pendingRequests(): readonly RequestEnvelope[];
  /** Every method name the subject has sent, in order. */
  methodsSeen(): readonly string[];
  clearMethodLog(): void;
  respondOk(id: string, type: string, value: unknown): void;
  respondErr(id: string, body: ProtocolErrorBody): void;
  respondReadFile(id: string, content: string, revision: string): void;
  emit(subscriptionId: string, event: RuntimeEventDto): void;
  /** Answer every `read_file` for a known fixture path automatically. */
  autoServeFiles(files: Record<string, string>): void;
  stop(): Promise<void>;
}
```

`respondReadFile` base64-encodes `content` into `{ content_base64, revision }`, which is `ReadFileResponse`'s real shape — every later test that reads a config file goes through it, so the encoding lives in exactly one place.

- Produces (`mirror-harness.ts`):

```ts
export interface FixtureEntry {
  path: string; kind: EntryKind; revision?: string; size?: number;
  ctimeMs?: number; mtimeMs?: number;
}
export interface FixtureNote {
  path: string; revision: string;
  properties?: PropertyDto[]; aliases?: AliasDto[]; headings?: HeadingDto[];
  blocks?: BlockDto[]; tags?: TagDto[]; sections?: SectionDto[];
  listItems?: ListItemDto[]; outgoing?: ReferenceDto[];
}
export interface HydrationSpec {
  generation: number; entries: FixtureEntry[]; notes: FixtureNote[];
}
export class MirrorHarness extends DaemonHarness {
  /** Open a Mirror and answer its whole hydration handshake from the spec. */
  static hydrated(spec: HydrationSpec, overrides?: Partial<HostConfig>): Promise<MirrorHarness>;
  readonly mirror: Mirror;
  /**
   * Answer the refetch a pending applyEvent/applyMutation is waiting on, and
   * return the set of paths the subject actually asked for — which is how
   * Task 9 asserts that a rename refetches its referrers without the response
   * having named them.
   */
  answerRefetch(generation: number, notes: FixtureNote[]): ReadonlySet<string>;
  /** Answer a full re-hydration (open/tree/notes/close) from a new spec. */
  answerHydration(spec: HydrationSpec): void;
  /** Answer every read_file the position warm-up issues. */
  answerWarm(sources: Record<string, string>): void;
}
export function harness_ref(
  sourcePath: string, rawTarget: string, resolvedTarget: string | null,
): ReferenceDto;
```

- Produces (`fixture-vault.ts`) — and this is where the parity test's honesty is decided:

```ts
export class FixtureVault {
  constructor(files: Record<string, string>);
  readonly files: Readonly<Record<string, string>>;
  entries(): FixtureEntry[];          // synthesized tree, folders included
  notes(): FixtureNote[];             // parsed by the REAL vaultd parser
  source(path: string): string;
  revisionOf(path: string): string;
  write(path: string, content: string): void;   // in-memory; bumps the revision
}
/** One note, parsed by the real parser. Memoized under host/fixtures/cache/. */
export function parseFixtureRow(path: string, source: string): MirrorNoteRow;
```

**The semantic source for `parseFixtureRow` — decided, not left open.** `ShimHarness.withVault(rawMarkdown)` needs `MirrorNoteRow`s for arbitrary markdown, and there are only three ways to get them: hand-write them (a parity test fed by hand-written input proves nothing — it compares one person's idea of the parse against another's), reimplement the parser in TypeScript (two parsers means two answers and no way to know which is right), or **ask the real parser**. This plan takes the third.

`crates/vault-index/src/bin/fixture-row.rs` is a small Rust binary in the `vaultd` workspace that reads `{ "path": ..., "source": ... }` JSON lines on stdin, runs the production `vault_core` parse plus the schema-v3 structural extraction, and prints one `MirrorNoteRow`-shaped JSON object per line on stdout. `parseFixtureRow` invokes it once per test *run* (not per call), batching every fixture in the file, and memoizes the results under `host/fixtures/cache/<blake3-of-source>.json`, which is gitignored. A cache miss shells out; a cache hit does not. So the parity tests compare **vaultd's real semantics through the shim** against real Obsidian, which is the only comparison worth making, and CI without a Rust toolchain still runs from the committed-by-nobody, regenerable cache — with a clear error if the cache misses and `cargo` is absent.

```rust
//! crates/vault-index/src/bin/fixture-row.rs
//!
//! Print MirrorNoteRow-shaped JSON for markdown fed on stdin, one request per
//! line. This exists so the host's parity fixtures are produced by the real
//! parser rather than by hand. It is a test-support binary: it reads no vault,
//! opens no index, and writes nothing.

use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
struct Request {
    path: String,
    source: String,
}

#[derive(Serialize)]
struct Row {
    path: String,
    revision: String,
    properties: Vec<Value>,
    aliases: Vec<Value>,
    headings: Vec<Value>,
    blocks: Vec<Value>,
    tags: Vec<Value>,
    diagnostics: Vec<Value>,
    sections: Vec<Value>,
    list_items: Vec<Value>,
    outgoing: Vec<Value>,
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                writeln!(stdout, "{}", serde_json::json!({ "error": error.to_string() }))?;
                stdout.flush()?;
                continue;
            }
        };

        // The production parse. Nothing here is a reimplementation: this is the
        // same entry point `replace_note` uses.
        let parsed = vault_core::markdown::parse_note(&request.path, &request.source);
        let revision = vault_core::revision::revision_of(request.source.as_bytes());

        let row = Row {
            path: request.path,
            revision,
            properties: parsed.properties.iter().map(to_json).collect(),
            aliases: parsed.aliases.iter().map(to_json).collect(),
            headings: parsed.headings.iter().map(to_json).collect(),
            blocks: parsed.blocks.iter().map(to_json).collect(),
            tags: parsed.tags.iter().map(to_json).collect(),
            diagnostics: parsed.diagnostics.iter().map(to_json).collect(),
            sections: parsed.sections.iter().map(to_json).collect(),
            list_items: parsed.list_items.iter().map(to_json).collect(),
            outgoing: parsed.references.iter().map(to_json).collect(),
        };
        writeln!(stdout, "{}", serde_json::to_string(&row).expect("row serializes"))?;
        stdout.flush()?;
    }
    Ok(())
}

/// Serialize a domain value through the protocol DTO conversion the daemon
/// itself uses, so the fixture rows are byte-identical to what a snapshot page
/// would carry. `vault_protocol::convert` is the single source of that mapping.
fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("domain values serialize")
}
```

`crates/vault-index/Cargo.toml` gains:

```toml
bin
name = "fixture-row"
path = "src/bin/fixture-row.rs"
```

- Produces (`assemble.ts`) — one factory the five shim-wrapping harnesses share, so the wiring order lives in exactly one place:

```ts
export interface HostAssembly {
  readonly config: HostConfig;
  readonly clock: TestClock;
  readonly client: VaultdClient;
  readonly mirror: Mirror;
  readonly events: ShimEventBus;
  readonly queue: DispatchQueue;
  readonly harvest: Harvest;
  readonly policyRecorder: PolicyRecorder;
  readonly noticeLog: NoticeLog;
  readonly app: App;
  readonly api: ObsidianApi;          // the Task 11b barrel
  readonly writes: WriteGate;
}
export function assembleShim(deps: {
  config: HostConfig; client: VaultdClient; mirror: Mirror; clock: TestClock;
}): HostAssembly;
```

`assembleShim` is also what production uses (Task 22's `main.ts` calls it with `systemClock()` and the real `WriteGate`), so the harnesses exercise the real wiring order rather than a test-only one. It is the function that calls `registerElectronStub` before any bundle loads.

- Produces (`pending/shim-harness.ts`) — **every method Tasks 7–13 call, enumerated:**

```ts
export interface ShimHarnessOptions {
  layoutReady?: boolean;                       // default true
  warm?: boolean;                              // default true
  configFiles?: Record<string, string>;        // served through read_file
  config?: Partial<HostConfig>;
}
export class ShimHarness extends MirrorHarness {
  static withEntries(entries: FixtureEntry[], options?: ShimHarnessOptions): Promise<ShimHarness>;
  static withVault(files: Record<string, string>, options?: ShimHarnessOptions): Promise<ShimHarness>;

  readonly app: App;
  readonly vault: Vault;
  readonly api: ObsidianApi;
  readonly harvest: Harvest;
  readonly policyRecorder: PolicyRecorder;
  readonly noticeLog: NoticeLog;
  readonly writes: WriteGate;
  readonly hostModulePaths: readonly string[];

  /** Replace a config-zone file's contents; the next read_file serves it. */
  setConfigFile(path: string, contents: string): void;
  manifestFor(id: string): PluginManifest;
  instantiate<T extends Plugin>(id: string, ctor: new (app: App, m: PluginManifest) => T): T;
  load(plugin: Plugin): Promise<void>;
  unload(id: string): Promise<void>;
  flipLayoutReady(): Promise<void>;

  setFileContent(path: string, content: string): void;
  revisionOf(path: string): string;
  writeNote(path: string, content: string): Promise<void>;
  /** Resolves with the AppliedBatch, so a test can assert rename pairing. */
  emitBatch(batch: {
    generation: number; created?: string[]; modified?: string[]; deleted?: string[];
    revisions?: Record<string, string>; sizes?: Record<string, number>;
  }): Promise<AppliedBatch>;
  settleProcess(
    path: string, read: string, readRevision: string,
    generation: number, newRevision: string,
  ): Promise<void>;

  listMenuItems(context: "file-menu" | "editor-menu", path: string): Promise<HarvestedMenuItem[]>;
  invokeMenuItem(itemId: string, path: string): Promise<void>;
  invokeProtocol(action: string, params: Record<string, string>): Promise<void>;
  openFileIntents(): readonly string[];
  activeTimerCount(): number;
}
```

- Produces (`pending/pluginset-harness.ts`) — every method Task 14 calls:

```ts
export interface PluginSetSpec {
  hostEnabled: string[];
  guiEnabled: string[] | null;      // null = Obsidian has no config file
  forceShared?: string[];
  installed?: PluginManifest[];
}
export class PluginSetHarness extends DaemonHarness {
  static create(spec: PluginSetSpec): Promise<PluginSetHarness>;
  readonly dir: HeadlessConfigDir;
  readonly monitor: CoexistenceMonitor;
  setGuiEnabled(ids: string[] | null): void;
  setHostEnabled(ids: string[]): void;
  /** Fire the 60 s poll through the TestClock. Never sleeps. */
  advancePoll(): Promise<void>;
}
```

- Produces (`pending/host-harness.ts`) — every method Tasks 15, 16a, 18, 19, 20b, 21 call:

```ts
export type PluginFactory =
  (api: ObsidianApi) => new (app: App, m: PluginManifest) => Plugin;

export interface HostHarnessSpec {
  vault: Record<string, string>;
  enabled: string[];
  plugins?: Record<string, PluginFactory>;
  /** Seeds `<configDir>/plugins/<id>/data.json` before the host starts. */
  pluginData?: Record<string, Record<string, unknown>>;
  config?: Partial<HostConfig> & {
    /** 16a only: leave the six 20b ops answering host_not_ready. */
    wireLateOps?: boolean;
    subscriberQueueLimit?: number;
  };
  configFiles?: Record<string, string>;
  guiEnabled?: string[] | null;
  suppressLayoutReady?: boolean;
}
export class HostHarness extends ShimHarness {
  static create(spec: HostHarnessSpec): Promise<HostHarness>;

  /**
   * Reusable plugin factories the tests share instead of restating them.
   * `throwingPlugin` registers `boom` (throws) and `fine`; `suggestPlugin`
   * registers `pick`, opening a SuggestModal; `requestUrlPlugin` registers
   * `fetch`, calling requestUrl on https://example.test/; `settingsPlugin`
   * registers a settings tab plus one command, and is the one the config and
   * compat-report tests drive.
   */
  static readonly throwingPlugin: PluginFactory;
  static readonly suggestPlugin: PluginFactory;
  static readonly requestUrlPlugin: PluginFactory;
  static readonly settingsPlugin: PluginFactory;

  readonly lifecycle: LifecycleSequencer;
  readonly quarantine: QuarantineTracker;
  readonly server: HostServer;
  readonly broker: InteractionBroker;
  readonly dryRun: DryRunGate;
  readonly detector: Detector;
  readonly coexistence: CoexistenceMonitor;

  connectClient(options?: { stalled?: boolean }): Promise<HostTestClient>;
  /** Resolve once the server has flushed every queued event to every client. */
  serverQuiesce(): Promise<void>;
  setGuiEnabled(ids: string[] | null): void;
  setConfigFile(path: string, contents: string): void;
  readonly noticeLog: NoticeLog;
  readonly writes: WriteGate;
  invoke(commandId: string): Promise<void>;
  invokeExpectingError(commandId: string): Promise<{ code: string; message: string }>;
  commitGeneration(change: {
    generation?: number; created?: string[]; modified?: string[]; deleted?: string[];
    /** Sugar: expands to a delete+create pair on the wire, because the wire
     *  has no rename. The shim is what pairs them back up. */
    renamed?: Array<{ from: string; to: string }>;
  }): Promise<void>;
  restartEngine(spec: { generation: number; vault: Record<string, string> }): Promise<void>;
  advanceClock(ms: number): Promise<void>;
  tick(): Promise<void>;
  lastHandlerError(pluginId: string): Error | null;
  mirrorRequestsSince(marker: string): readonly string[];
  daemonMethodsSeen(): readonly string[];
  clearDaemonMethodLog(): void;
  chmodSocketDir(mode: number): void;
  noncePath(): string;
  readNonce(): string;
  stop(): Promise<void>;
}
export interface HostTestClient {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Resolve with the `value` of the next event of this type. */
  nextEvent(type: string): Promise<unknown>;
  onEvent(listener: (envelope: { subscription_id: string; event: { type: string; value: unknown } }) => void): void;
  /** Stalled clients only: start reading, then collect everything buffered. */
  resume(): void;
  drainEvents(): Promise<ReadonlyArray<{ type: string; value: unknown }>>;
  /** Resolve once the socket has been quiet for one turn of the event loop. */
  quiesce(): Promise<void>;
  disconnect(): Promise<void>;
}
```

- Produces (`pending/settings-harness.ts`) — every method Task 17 calls:

```ts
export interface SettingsTabSpec {
  getSettingDefinitions?: () => unknown[];
  display?: () => void;
  moduleExports?: Record<string, unknown>;
  onExternalSettingsChange?: () => void;
}
export class SettingsHarness extends DaemonHarness {
  static withTab(spec: SettingsTabSpec): Promise<SettingsHarness>;
  static withData(
    pluginId: string,
    data: Record<string, unknown>,
    options?: { schema?: CachedSchema; onExternalSettingsChange?: () => void },
  ): Promise<SettingsHarness>;
  readonly ladder: SchemaLadder;
  readonly service: PluginConfigService;
  readonly plugin: Plugin;
  readonly manifest: PluginManifest;
  readonly dataDir: string;
  readData(pluginId: string): Promise<Record<string, unknown>>;
}
```

- Produces (`pending/live-host.ts`) — every method Task 22 calls. This one starts a **real** `vaultd` child and a **real** host:

```ts
export interface LiveHostSpec {
  vaultRoot: string;
  installPlugin?: { id: string; from: string };
  data?: Record<string, unknown>;
  config?: Partial<HostConfig>;
}
export class LiveHost {
  static start(spec: LiveHostSpec): Promise<LiveHost>;
  static startWithGoldenPlugin(id: string, files: Record<string, string>): Promise<LiveHost>;
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Resolve when the mirror has applied everything in flight. No sleeps. */
  quiesce(): Promise<void>;
  app(): App;
  harvest(): Harvest;
  quarantine(): QuarantineTracker;
  unsupportedHits(): readonly { symbol: string; pluginId: string | null }[];
  stop(): Promise<void>;
}
```

- Produces (`datadir.ts`) — the one module in `src/` outside `testing/` allowed to touch `fs` write functions, named so Task 22's static check can exempt it by name:

```ts
export class DataDir {
  constructor(root: string);
  readonly root: string;
  /** Throws unless `relative` resolves inside `root`. */
  resolve(relative: string): string;
  ensure(relative: string): void;
  writeJson(relative: string, value: unknown, mode?: number): void;
  readJson<T>(relative: string): T | null;
  appendLine(relative: string, line: string): void;
  writeSecret(relative: string, contents: string): void;   // always mode 0o600
}
```

Every method calls `resolve` first, and `resolve` throws `new Error("datadir escape: " + relative)` when the resolved path is not under `root`. That is what makes "the host writes to exactly three places" checkable rather than aspirational: the data dir is one module, the socket dir is inside it, and everything else is `stdout`.

- [ ] **Step 1: Write the failing harness self-test**

Create `host/packages/host/test/harness-selftest.test.ts`. It exercises the four harness pieces that have no shim dependency, so this task can go green on its own:

```ts
import { describe, expect, it } from "vitest";
import { DaemonHarness } from "../src/testing/daemon-harness";
import { MirrorHarness } from "../src/testing/mirror-harness";
import { FixtureVault, parseFixtureRow } from "../src/testing/fixture-vault";
import { testClock } from "../src/testing/clock";
import { DataDir } from "../src/datadir";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("TestClock", () => {
  it("fires timers in due order and advances now()", async () => {
    const clock = testClock(1000);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("late"), 50);
    clock.setTimeout(() => fired.push("early"), 10);
    expect(fired).toEqual([]);
    await clock.advance(20);
    expect(fired).toEqual(["early"]);
    expect(clock.now()).toBe(1020);
    await clock.advance(40);
    expect(fired).toEqual(["early", "late"]);
    expect(clock.now()).toBe(1060);
    expect(clock.armed()).toBe(0);
  });

  it("re-arms an interval and stops when cleared", async () => {
    const clock = testClock();
    let ticks = 0;
    const handle = clock.setInterval(() => { ticks += 1; }, 100);
    await clock.advance(350);
    expect(ticks).toBe(3);
    clock.clearInterval(handle);
    await clock.advance(1000);
    expect(ticks).toBe(3);
    expect(clock.armed()).toBe(0);
  });

  it("never leaks a cleared timeout", async () => {
    const clock = testClock();
    const handle = clock.setTimeout(() => { throw new Error("must not fire"); }, 10);
    clock.clearTimeout(handle);
    await clock.advance(100);
    expect(clock.armed()).toBe(0);
  });
});

describe("DaemonHarness", () => {
  it("correlates a request and answers it", async () => {
    const harness = DaemonHarness.create();
    const pending = harness.client.request<{ status: string }>("health");
    const sent = await harness.nextRequest();
    expect(sent.request.method).toBe("health");
    harness.respondOk(sent.id, "health", { service: "vaultd", status: "ok" });
    await expect(pending).resolves.toEqual({ service: "vaultd", status: "ok" });
    expect(harness.methodsSeen()).toEqual(["health"]);
    await harness.stop();
  });

  it("base64-encodes read_file answers the way the daemon does", async () => {
    const harness = DaemonHarness.create();
    const pending = harness.client.request<{ content_base64: string; revision: string }>(
      "read_file", { path: ".obsidian/app.json" },
    );
    const sent = await harness.nextRequest();
    harness.respondReadFile(sent.id, '{"trashOption":"local"}', "blake3:a1");
    const answer = await pending;
    expect(Buffer.from(answer.content_base64, "base64").toString("utf8"))
      .toBe('{"trashOption":"local"}');
    expect(answer.revision).toBe("blake3:a1");
    await harness.stop();
  });
});

describe("MirrorHarness", () => {
  it("hydrates a mirror from a spec and answers a refetch", async () => {
    const harness = await MirrorHarness.hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    expect(harness.mirror.generation()).toBe(5);
    expect(harness.mirror.entry("A.md")?.kind).toBe("note");
    const applying = harness.mirror.applyMutation(6, ["A.md"]);
    harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    await applying;
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
    await harness.stop();
  });
});

describe("FixtureVault and the real parser", () => {
  it("parses fixture markdown with vaultd's own parser", () => {
    const row = parseFixtureRow("A.md", "---\ntags: [alpha]\n---\n# Title\n\nB\n");
    expect(row.path).toBe("A.md");
    expect(row.headings.map((h) => h.text)).toEqual(["Title"]);
    expect(row.outgoing.map((r) => r.raw_target)).toEqual(["B"]);
    expect(row.tags.map((t) => t.tag)).toEqual(["alpha"]);
    // Structural extraction must be present, or the pre-task did not land and
    // the parity fixtures would silently compare empty arrays.
    expect(row.sections.length).toBeGreaterThan(0);
  });

  it("synthesizes folders into the entry tree", () => {
    const vault = new FixtureVault({ "Folder/Sub/A.md": "x\n", "B.md": "y\n" });
    expect(vault.entries().map((e) => `${e.kind}:${e.path}`).sort()).toEqual([
      "folder:Folder", "folder:Folder/Sub", "note:B.md", "note:Folder/Sub/A.md",
    ]);
  });
});

describe("DataDir", () => {
  it("refuses a path that escapes its root", () => {
    const dir = new DataDir(mkdtempSync(join(tmpdir(), "vaultd-dd-")));
    expect(() => dir.resolve("../escape.json")).toThrow(/datadir escape/);
    expect(() => dir.writeJson("../escape.json", {})).toThrow(/datadir escape/);
  });

  it("writes a secret at mode 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "vaultd-dd-"));
    const dir = new DataDir(root);
    dir.writeSecret("nonce", "abcd");
    expect(readFileSync(join(root, "nonce"), "utf8")).toBe("abcd");
    expect(require("node:fs").statSync(join(root, "nonce")).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run it and observe the failures**

```bash
npm --prefix host test -- harness-selftest
```

Expected: cannot resolve `../src/testing/clock`, `../src/testing/daemon-harness`, `../src/testing/mirror-harness`, `../src/testing/fixture-vault`, or `../src/datadir`.

- [ ] **Step 3: Add the Rust fixture binary and prove it works standalone**

Create `crates/vault-index/src/bin/fixture-row.rs` and the `bin` entry, then:

```bash
cd ~/repos/system/vaultd
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
rustup run 1.85.0 cargo check --workspace --all-targets
echo '{"path":"A.md","source":"# Title\n\n- [ ] task\n"}' | cargo run -q --bin fixture-row
```

Expected: one JSON line whose `headings`, `sections`, and `list_items` are all populated. If `sections` is empty, the structural pre-task has not landed — stop, and finish it.

- [ ] **Step 4: Implement the clock, the data dir, and the three shim-free harnesses**

Create `clock.ts` exactly as above, `datadir.ts`, `daemon-harness.ts`, `mirror-harness.ts`, and `fixture-vault.ts`. `parseFixtureRow` hashes the source, checks `host/fixtures/cache/<hash>.json`, and on a miss spawns `cargo run -q --bin fixture-row --manifest-path <repo>/Cargo.toml` once per process with every pending request batched onto its stdin. A miss with no `cargo` on `PATH` throws a message naming the cache path and the command that regenerates it — never a silent hand-written fallback.

- [ ] **Step 5: Run and observe it pass**

```bash
npm --prefix host test -- harness-selftest
```

Expected: eleven cases pass. Run ten times.

- [ ] **Step 6: Write the shim-dependent harnesses into `pending/`**

Create `src/shim/events.ts` (the `Events` base with `on`/`off`/`offref`/`trigger`, `EventRef` with `detach()`, and `ShimEventBus` — a per-name `Set<listener>` with attribution so Task 14b can name the plugin whose handler threw), `src/shim/app.ts` (the mutable container), `src/testing/assemble.ts`, and the five `src/testing/pending/*.ts` harnesses, each implementing the interface listed above in full. Add `"src/testing/pending"` to `tsconfig.json`'s `exclude` and to `vitest.config.ts`'s `exclude`, with a comment naming the five activation points.

- [ ] **Step 7: Confirm the gate is green with `pending/` excluded**

```bash
npm --prefix host run typecheck
npm --prefix host run lint
npm --prefix host test
```

Expected: green. `src/testing/pending/` is excluded, so its unresolved imports of `../shim/vault` and friends do not fail the build — and each activating task's Step 1 is the moment that stops being true, one file at a time.

- [ ] **Step 8: Commit**

```bash
git add host crates/vault-index/src/bin/fixture-row.rs crates/vault-index/Cargo.toml
git commit -m "test(host): build the harness family, the test clock, and the fixture generator"
```

---

### Task 7: Shim — TAbstractFile, TFile, TFolder, and Vault

**Files:**

- **Activate** `src/testing/pending/shim-harness.ts` → `src/testing/shim-harness.ts` (`git mv`), and drop `"src/testing/pending"` from the `tsconfig`/`vitest` excludes only when the last harness is activated (Task 22) — until then the exclude stays and the moved file is picked up because it is no longer inside `pending/`.
- Create: `host/packages/host/src/shim/policy.ts`
- Create: `host/packages/host/src/shim/files.ts`
- Create: `host/packages/host/src/shim/adapter.ts`
- Create: `host/packages/host/src/shim/vault.ts`
- Create: `host/packages/host/src/runtime/queue.ts`
- Create: `host/packages/host/test/shim-files.test.ts`
- Create: `host/packages/host/test/shim-vault.test.ts`

**Interfaces:**

- Produces (`policy.ts`) — the four-way table other shim tasks register into:

```ts
export type ApiPolicy = "implemented" | "harvested" | "safe_stub" | "absent";

/**
 * ONE constructor signature, used at every call site in this plan. `name` is
 * derived, never passed; `message` always contains the symbol so a stack trace
 * with no structured logging is still diagnosable; `policy` is a literal
 * because an unsupported throw is by definition the `absent` policy.
 *
 * `detail` is where a subclass name goes (`Modal.open` naming the actual
 * subclass) or a channel name (`ipcRenderer.invoke` naming the channel). It is
 * appended to the message and never changes the shape.
 */
export class HeadlessUnsupported extends Error {
  readonly code = "headless_unsupported";
  readonly symbol: string;
  readonly pluginId: string | null;
  readonly policy = "absent" as const;
  readonly detail: string | null;
  constructor(symbol: string, pluginId: string | null, detail?: string) {
    super(
      detail === undefined
        ? `${symbol} is not available headless`
        : `${symbol} is not available headless (${detail})`,
    );
    this.name = "HeadlessUnsupported";
    this.symbol = symbol;
    this.pluginId = pluginId;
    this.detail = detail ?? null;
  }
}

export interface PolicyRecorder {
  record(symbol: string, policy: ApiPolicy, pluginId: string | null): void;
  entries(): readonly { symbol: string; policy: ApiPolicy; pluginId: string | null; hits: number }[];
}

export function declarePolicy(symbol: string, policy: ApiPolicy): void;
export function policyOf(symbol: string): ApiPolicy;   // defaults to "absent"
export function declaredSymbols(): readonly string[];  // every symbol in the table
export function stub<T>(symbol: string, value: T): T;  // records safe_stub on every call
/** Records the hit against the current plugin, then throws HeadlessUnsupported. */
export function unsupported(symbol: string, detail?: string): never;
export function currentPluginId(): string | null;      // set by the dispatch queue
```

**Every throw site in this plan constructs it the same way**, and there are exactly four spellings across the whole document, all of them `unsupported(symbol, detail?)` or `new HeadlessUnsupported(symbol, currentPluginId(), detail?)`:

- Task 9's three `promptFor*` — `unsupported("FileManager.promptForFileRename")`.
- Task 13's electron stub — `unsupported("electron.ipcRenderer.invoke", channel)` and `unsupported("electron." + property)` from the `Proxy`.
- Task 18's bespoke modal — `unsupported("Modal.open", subclassName)`, which is why that test asserts `error.symbol === "Modal.open"` and `error.message` contains the subclass name. The symbol is the API surface; the subclass is the detail. A test asserting `error.symbol === "Bespoke"` would be asserting the wrong thing.
- Task 11b's default arm — `unsupported(name)` for any barrel symbol whose declared policy is `absent`.

- Produces (`files.ts`) — real classes, because `instanceof TFile` is the corpus's most-used discrimination (33 plugins) and a structural fake fails it:

```ts
export abstract class TAbstractFile {
  path: string; name: string; parent: TFolder | null; vault: Vault;
}
export class TFile extends TAbstractFile {
  basename: string; extension: string;
  stat: { ctime: number; mtime: number; size: number };
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[];
  isRoot(): boolean;
}
export interface AppliedBatch {
  created: TAbstractFile[];
  modified: TFile[];
  deleted: TAbstractFile[];
  /** Synthesized: see below. `file` is the SAME instance that used to be at `from`. */
  renamed: Array<{ from: string; to: string; file: TAbstractFile }>;
}
export class FileIndex {
  constructor(mirror: MirrorQuery, vault: Vault);
  rebuild(): void;
  applyBatch(batch: MirrorChangeBatch): AppliedBatch;
  get(path: string): TAbstractFile | undefined;
  root(): TFolder;
  allFiles(): TFile[];
  allFolders(): TFolder[];
  allLoaded(): TAbstractFile[];
}
```

`FileIndex` keeps **object identity stable across updates**: a modified note keeps the same `TFile` instance with mutated `stat`, because plugins hold file references across events and an identity swap breaks `Map<TFile, …>` caches (tasknotes and breadcrumbs both keep one).

**Rename synthesis lives here, because the wire has no rename.** `vaultd`'s `generation_committed` change set is `created`/`modified`/`deleted` and nothing else — the daemon models a move as a delete plus a create, and its `RenameResponse` reports `links_rewritten` and `link_rewrite_failures` but names no `from`/`to` pair on the event. Obsidian's `vault.on("rename", file, oldPath)` is nonetheless load-bearing: folder-notes' tabManager handler is a rename handler, and Task 15's trap test is a rename test.

So `applyBatch` pairs them. Within **one** batch, a `deleted` path and a `created` path pair into a rename when both are notes and the created path's new revision equals the deleted path's last-known revision — a move is byte-identical content at a new path, which is exactly what the revision proves. Ambiguity is resolved by refusing to guess: if one revision matches two or more created paths, none of them pairs and all are reported as plain delete+create, because a wrong rename is worse than a missing one (it fires a handler with a `oldPath` that is a lie). Cross-batch pairs are never attempted; a move whose delete and create land in different generations is a delete and a create, which is also what a user watching Obsidian's own event stream would see under the same conditions.

The paired instance is **reused**: the `TFile` that was at `from` has its `path`/`name`/`basename`/`parent` mutated and is re-parented, so a plugin's `Map<TFile, …>` survives a rename exactly as it does under Obsidian. Task 15 turns `AppliedBatch.renamed` into `vault.trigger("rename", file, oldPath)` and emits no `create`/`delete` for those paths.

- Produces (`adapter.ts`) — `vault.adapter` was named in the design and defined nowhere in v1, yet quickadd does `adapter instanceof FileSystemAdapter` and several plugins call `adapter.read`/`adapter.exists` directly. The subset below is what the corpus actually touches; everything else on Obsidian's `DataAdapter` is `absent`:

```ts
export interface ListedFiles { files: string[]; folders: string[] }

/**
 * The `vault.adapter` subset. Policy per method, one line each:
 *   read/readBinary/exists/stat/list  — implemented, over `read_file` + mirror
 *   write/writeBinary/append/mkdir/remove/rmdir/rename/copy — implemented,
 *       over the mutation ops, through the same WriteGate as Vault
 *   getName/getBasePath/getResourcePath/getFullPath — implemented (paths) or
 *       safe_stub (getResourcePath returns an inert `app://headless/<path>`)
 *   trashSystem/trashLocal — implemented, over delete_note/delete_folder
 *   Anything else on Obsidian's DataAdapter — absent, throws typed.
 */
export class DataAdapter {
  constructor(deps: VaultDeps);
  getName(): string;
  getBasePath(): string;                                   // the vault root
  getFullPath(normalizedPath: string): string;
  getResourcePath(normalizedPath: string): string;         // safe_stub
  exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
  stat(normalizedPath: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null>;
  list(normalizedPath: string): Promise<ListedFiles>;
  read(normalizedPath: string): Promise<string>;
  readBinary(normalizedPath: string): Promise<ArrayBuffer>;
  write(normalizedPath: string, data: string): Promise<void>;
  writeBinary(normalizedPath: string, data: ArrayBuffer): Promise<void>;
  append(normalizedPath: string, data: string): Promise<void>;
  mkdir(normalizedPath: string): Promise<void>;
  remove(normalizedPath: string): Promise<void>;
  rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
  rename(normalizedPath: string, normalizedNewPath: string): Promise<void>;
  copy(normalizedPath: string, normalizedNewPath: string): Promise<void>;
  trashSystem(normalizedPath: string): Promise<boolean>;
  trashLocal(normalizedPath: string): Promise<void>;
}
/** Exists so `instanceof FileSystemAdapter` compiles and evaluates to false. */
export class FileSystemAdapter extends DataAdapter {}
```

`FileSystemAdapter` is declared but **never instantiated**: quickadd's `adapter instanceof FileSystemAdapter` must compile and must be `false`, because a `true` there sends quickadd down a `getBasePath()`-then-`fs` path that would write vault bytes behind the daemon. The class existing and no instance ever being one is the whole trick, and a test asserts both halves.

- Produces (`vault.ts`):

```ts
export interface VaultDeps {
  mirror: Mirror;
  client: VaultdClient;
  config: HostConfig;
  index: FileIndex;
  events: ShimEventBus;   // from Task 6b
  writes: WriteGate;      // dry-run interception point, Task 19
}
export class Vault {
  constructor(deps: VaultDeps);
  getName(): string;
  readonly configDir: string;                       // ".obsidian-headless"
  readonly adapter: DataAdapter;
  getAbstractFileByPath(path: string): TAbstractFile | null;
  getFileByPath(path: string): TFile | null;
  getFolderByPath(path: string): TFolder | null;
  getRoot(): TFolder;
  getFiles(): TFile[];
  getMarkdownFiles(): TFile[];
  getAllLoadedFiles(): TAbstractFile[];
  getAllFolders(includeRoot?: boolean): TFolder[];
  getConfig(key: string): unknown;
  read(file: TFile): Promise<string>;
  cachedRead(file: TFile): Promise<string>;
  readBinary(file: TFile): Promise<ArrayBuffer>;
  create(path: string, data: string): Promise<TFile>;
  createBinary(path: string, data: ArrayBuffer): Promise<TFile>;
  createFolder(path: string): Promise<TFolder>;
  modify(file: TFile, data: string): Promise<void>;
  modifyBinary(file: TFile, data: ArrayBuffer): Promise<void>;
  process(file: TFile, fn: (data: string) => string): Promise<string>;
  append(file: TFile, data: string): Promise<void>;
  copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T>;
  rename(file: TAbstractFile, newPath: string): Promise<void>;
  delete(file: TAbstractFile, force?: boolean): Promise<void>;
  trash(file: TAbstractFile, system: boolean): Promise<void>;
  on(name: "create" | "modify" | "delete" | "rename", cb: (...args: unknown[]) => void): EventRef;
  off(name: string, cb: unknown): void;
  offref(ref: EventRef): void;
}
```

- Wire mapping, pinned so no later task re-decides it: `create` → `write_note { expected: { absent: true } }`; `modify` → `write_note { expected: { revision } }` with the mirror's current revision; `append` → `process` with a concatenating callback, never an unconditional write; `createFolder` → `create_folder`; `rename` on a `TFile` → `rename_note { rewrite_links: true }`, on a `TFolder` → `rename_folder { rewrite_links: true }`; `copy` → `copy_file { if_exists: "error" }`; `trash(file, true)` → `delete_note { mode: "trash_system" }`; `trash(file, false)` → `delete_note { mode: "trash_local" }`; `delete(file)` → `delete_note { mode: "permanent" }` or `delete_folder { mode: "permanent", recursive: true }`. Per Ruling 3 of the mutation spec the shim passes the plugin's own choice through and consults `app.json`'s `trashOption` never.
- `getConfig(key)` reads `app.json` through `read_file` at startup and answers from a cache. **The cache invalidation is wired, not assumed:** the `Vault` constructor calls `deps.mirror.onConfigChanged(path => { if (path.endsWith("/app.json")) this.configCache = null; })`, so a GUI or plugin write into the config zone drops the cache and the next `getConfig` re-reads. Without that subscription the host would serve a stale `attachmentFolderPath` for the rest of the session, which is exactly the kind of silent staleness `config_changed` exists to prevent. The load-bearing keys are `attachmentFolderPath` (folder-notes), `newFileLocation`, `newFileFolderPath`, `alwaysUpdateLinks`, `useMarkdownLinks`, `trashOption`, `userIgnoreFilters`. An unknown key returns `undefined`, matching the private API's behavior, and is recorded as a `safe_stub` hit so the report shows what plugins actually ask for.

- Produces (`queue.ts`):

```ts
export class DispatchQueue {
  run<T>(pluginId: string | null, label: string, task: () => Promise<T> | T): Promise<T>;
  runExclusivePath<T>(path: string, task: () => Promise<T>): Promise<T>;
  depth(): number;
  inFlight(): { pluginId: string | null; label: string } | null;
}
```

`run` is the single FIFO that serializes every plugin entry point. `runExclusivePath` is a second, per-path lock layered on top, used only by `process`, so two plugins read-modify-writing the same note interleave at the host rather than racing to a `revision_conflict` (mutation-spec Ruling 2 assigns that serialization to the host explicitly).

- [ ] **Step 1: Write the failing file-index test**

Create `host/packages/host/test/shim-files.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TAbstractFile, TFile, TFolder } from "../src/shim/files";
import { ShimHarness } from "../src/testing/shim-harness";

describe("FileIndex", () => {
  it("builds real TFile and TFolder instances with working instanceof", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/Note.md", kind: "note", revision: "blake3:n1", size: 12 },
      { path: "Folder/img.png", kind: "file", revision: "blake3:i1", size: 40 },
    ]);
    const note = harness.vault.getAbstractFileByPath("Folder/Note.md");
    expect(note).toBeInstanceOf(TFile);
    expect(note).toBeInstanceOf(TAbstractFile);
    expect(note).not.toBeInstanceOf(TFolder);
    const file = note as TFile;
    expect(file.basename).toBe("Note");
    expect(file.extension).toBe("md");
    expect(file.name).toBe("Note.md");
    expect(file.parent).toBeInstanceOf(TFolder);
    expect(file.parent?.path).toBe("Folder");
    expect(file.stat).toEqual({ ctime: expect.any(Number), mtime: expect.any(Number), size: 12 });
    expect(harness.vault.getFolderByPath("Folder")?.children.map((c) => c.name).sort())
      .toEqual(["Note.md", "img.png"]);
    expect(harness.vault.getMarkdownFiles().map((f) => f.path)).toEqual(["Folder/Note.md"]);
    expect(harness.vault.getFiles().map((f) => f.path).sort())
      .toEqual(["Folder/Note.md", "Folder/img.png"]);
    expect(harness.vault.getRoot().isRoot()).toBe(true);
  });

  it("keeps TFile identity stable across a modification", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1", size: 3 },
    ]);
    const before = harness.vault.getFileByPath("A.md");
    await harness.emitBatch({ generation: 2, modified: ["A.md"], revisions: { "A.md": "blake3:a2" }, sizes: { "A.md": 9 } });
    const after = harness.vault.getFileByPath("A.md");
    expect(after).toBe(before);
    expect(after?.stat.size).toBe(9);
  });

  it("detaches a deleted file from its parent folder", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/A.md", kind: "note", revision: "blake3:a1" },
    ]);
    await harness.emitBatch({ generation: 3, deleted: ["Folder/A.md"] });
    expect(harness.vault.getAbstractFileByPath("Folder/A.md")).toBeNull();
    expect(harness.vault.getFolderByPath("Folder")?.children).toEqual([]);
  });

  it("pairs a same-revision delete and create into a rename, reusing the instance", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "Folder", kind: "folder" },
      { path: "Folder/A.md", kind: "note", revision: "blake3:a1" },
    ]);
    const before = harness.vault.getFileByPath("Folder/A.md");
    // The wire has no rename: this is what vaultd actually emits for a move.
    const applied = await harness.emitBatch({
      generation: 4,
      deleted: ["Folder/A.md"],
      created: ["Folder/Renamed.md"],
      revisions: { "Folder/Renamed.md": "blake3:a1" },
    });
    expect(applied.renamed).toEqual([
      { from: "Folder/A.md", to: "Folder/Renamed.md", file: before },
    ]);
    expect(applied.created).toEqual([]);
    expect(applied.deleted).toEqual([]);
    const after = harness.vault.getFileByPath("Folder/Renamed.md");
    expect(after).toBe(before);
    expect(after?.name).toBe("Renamed.md");
    expect(after?.basename).toBe("Renamed");
    expect(harness.vault.getAbstractFileByPath("Folder/A.md")).toBeNull();
  });

  it("refuses to guess when one revision matches two created paths", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:same" },
    ]);
    const applied = await harness.emitBatch({
      generation: 5,
      deleted: ["A.md"],
      created: ["Copy1.md", "Copy2.md"],
      revisions: { "Copy1.md": "blake3:same", "Copy2.md": "blake3:same" },
    });
    // A wrong rename fires a handler with a lying oldPath. Two plain creates
    // and one plain delete is the honest report.
    expect(applied.renamed).toEqual([]);
    expect(applied.created.map((f) => f.path).sort()).toEqual(["Copy1.md", "Copy2.md"]);
    expect(applied.deleted.map((f) => f.path)).toEqual(["A.md"]);
  });
});
```

`emitBatch` resolves with the `AppliedBatch` so these two cases can assert the pairing directly rather than inferring it from downstream events.

- [ ] **Step 2: Run it and observe the missing modules**

```bash
npm --prefix host test -- shim-files
```

Expected: cannot resolve `../src/shim/files`.

- [ ] **Step 3: Implement the file classes and index**

Create `files.ts` with the three classes and `FileIndex`. `rebuild()` walks `mirror.entries()` sorted by path so a parent folder always exists before its children; missing intermediate folders are materialized (`vaultd` reports folders, but a defensive `ensureFolder` keeps a sparse tree from producing a null parent). `applyBatch` runs in three passes: first pair renames (delete/create by matching revision, refusing on ambiguity) and re-parent those instances in place; then append the remaining created paths as new instances on their parent's `children`; then splice the remaining deleted paths out. Modified notes keep their instance and take a new `stat`.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- shim-files
```

Expected: five cases pass, including both rename cases.

- [ ] **Step 5: Write the failing Vault write-path test**

Create `host/packages/host/test/shim-vault.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("Vault writes", () => {
  it("routes modify to write_note with the mirror revision as the precondition", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
    ]);
    const file = harness.vault.getFileByPath("A.md")!;
    const pending = harness.vault.modify(file, "# changed\n");
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "write_note",
      params: { path: "A.md", content: "# changed\n", expected: { revision: "blake3:a1" } },
    });
    harness.respondOk(sent.id, "write_note", { generation: 6, revision: "blake3:a2" });
    harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    await pending;
    expect(harness.mirror.generation()).toBe(6);
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
  });

  it("routes create to write_note with an absent precondition and returns a TFile", async () => {
    const harness = await ShimHarness.withEntries([]);
    const pending = harness.vault.create("New.md", "body\n");
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "write_note",
      params: { path: "New.md", content: "body\n", expected: { absent: true } },
    });
    harness.respondOk(sent.id, "write_note", { generation: 2, revision: "blake3:n1" });
    harness.answerRefetch(2, [{ path: "New.md", revision: "blake3:n1" }]);
    const created = await pending;
    expect(created.path).toBe("New.md");
    expect(harness.vault.getFileByPath("New.md")).toBe(created);
  });

  it("retries process once on revision_conflict and never loses the update", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
    ]);
    harness.setFileContent("A.md", "one\n");
    const file = harness.vault.getFileByPath("A.md")!;
    const seen: string[] = [];
    const pending = harness.vault.process(file, (data) => { seen.push(data); return `${data}two\n`; });

    const readA = await harness.nextRequest();
    expect(readA.request.method).toBe("read_file");
    harness.respondReadFile(readA.id, "one\n", "blake3:a1");
    const writeA = await harness.nextRequest();
    expect(writeA.request.params).toMatchObject({ expected: { revision: "blake3:a1" } });
    harness.respondErr(writeA.id, {
      code: "revision_conflict", message: "revision moved", current_generation: 7,
    });

    const readB = await harness.nextRequest();
    expect(readB.request.method).toBe("read_file");
    harness.respondReadFile(readB.id, "one\nother\n", "blake3:a2");
    const writeB = await harness.nextRequest();
    expect(writeB.request.params).toEqual({
      path: "A.md", content: "one\nother\ntwo\n", expected: { revision: "blake3:a2" },
    });
    harness.respondOk(writeB.id, "write_note", { generation: 8, revision: "blake3:a3" });
    harness.answerRefetch(8, [{ path: "A.md", revision: "blake3:a3" }]);

    await expect(pending).resolves.toBe("one\nother\ntwo\n");
    expect(seen).toEqual(["one\n", "one\nother\n"]);
  });

  it("serializes two process calls on the same path", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
    ]);
    const file = harness.vault.getFileByPath("A.md")!;
    const order: string[] = [];
    const first = harness.vault.process(file, (d) => { order.push("first"); return `${d}1`; });
    const second = harness.vault.process(file, (d) => { order.push("second"); return `${d}2`; });
    await harness.settleProcess("A.md", "x", "blake3:a1", 6, "blake3:a2");
    await first;
    expect(order).toEqual(["first"]);
    await harness.settleProcess("A.md", "x1", "blake3:a2", 7, "blake3:a3");
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("maps the three deletion forms to the three modes", async () => {
    const harness = await ShimHarness.withEntries([
      { path: "A.md", kind: "note", revision: "blake3:a1" },
      { path: "B.md", kind: "note", revision: "blake3:b1" },
      { path: "C.md", kind: "note", revision: "blake3:c1" },
    ]);
    const modes: string[] = [];
    void harness.vault.trash(harness.vault.getFileByPath("A.md")!, true);
    modes.push(((await harness.nextRequest()).request.params as { mode: string }).mode);
    void harness.vault.trash(harness.vault.getFileByPath("B.md")!, false);
    modes.push(((await harness.nextRequest()).request.params as { mode: string }).mode);
    void harness.vault.delete(harness.vault.getFileByPath("C.md")!);
    modes.push(((await harness.nextRequest()).request.params as { mode: string }).mode);
    expect(modes).toEqual(["trash_system", "trash_local", "permanent"]);
  });
});
```

- [ ] **Step 6: Run it and observe the missing module**

```bash
npm --prefix host test -- shim-vault
```

Expected: cannot resolve `../src/shim/vault`.

- [ ] **Step 7: Implement the write paths**

Create `vault.ts`. Every mutating method has the same three-line shape and no other shape is permitted anywhere in the host:

```ts
async modify(file: TFile, data: string): Promise<void> {
  const expected = this.expectedFor(file.path);
  const result = await this.deps.writes.send<{ generation: number; revision: string }>(
    "write_note", { path: file.path, content: data, expected },
  );
  await this.deps.mirror.applyMutation(result.generation, [file.path]);
}
```

`process` is the documented client CAS loop: `read_file` → run the callback → `write_note` with `expected.revision` from the read → on `revision_conflict`, re-read and re-run the callback with the *new* content, up to 5 attempts, then reject with the typed error. The whole loop runs inside `runExclusivePath(file.path, …)`.

- [ ] **Step 8: Run and observe it pass**

```bash
npm --prefix host test -- shim-vault
```

Expected: five cases pass. Run ten times — the serialization case is the one that will flake if `runExclusivePath` is implemented with anything other than a real promise chain.

- [ ] **Step 9: Commit**

```bash
git add host/packages/host/src/shim host/packages/host/src/runtime/queue.ts host/packages/host/test
git commit -m "feat(host): implement the vault shim over vaultd mutation operations"
```

---

### Task 8: Shim — MetadataCache and CachedMetadata assembly

**Files:**

- Create: `host/packages/host/src/mirror/metadata.ts`
- Create: `host/packages/host/src/shim/metadata-cache.ts`
- Create: `host/packages/host/test/metadata-parity.test.ts`
- Create: `host/packages/host/test/shim-metadata-cache.test.ts`

**Interfaces:**

- Produces (`metadata.ts`) — the pure function that turns mirror rows into Obsidian's shape. It is pure so the parity fixtures from Task 0 can drive it with no host, no daemon, and no plugin:

```ts
export interface CachedMetadata {
  links?: LinkCache[];
  embeds?: EmbedCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
  sections?: SectionCache[];
  listItems?: ListItemCache[];
  frontmatter?: Record<string, unknown>;
  frontmatterPosition?: Pos;
  frontmatterLinks?: FrontmatterLinkCache[];
  blocks?: Record<string, BlockCache>;
  // Deliberately absent, with policy: `footnotes`, `footnoteRefs`, and
  // `referenceLinks` are real fields in the current obsidian.d.ts (since 1.6.6
  // and 1.8.7). vaultd does not parse them, so `buildCachedMetadata` omits the
  // keys entirely — which is also what Obsidian does for a note that has none,
  // so a plugin reading them cannot tell "no footnotes" from "not served".
  // They are registered `absent` in the policy table, they appear in the
  // compatibility report, and `parity-footnotes` measures the gap.
}

/** Mirrors obsidian.d.ts `Reference`. Note: NO position. */
export interface Reference { link: string; original: string; displayText?: string }
/** `ReferenceCache extends Reference, CacheItem` — this is the one with a position. */
export interface ReferenceCache extends Reference { position: Pos }
export type LinkCache = ReferenceCache;
export type EmbedCache = ReferenceCache;
/**
 * `FrontmatterLinkCache extends Reference` — NOT `ReferenceCache`. It has no
 * `position`, because a frontmatter link's location is its `key`, not a span.
 * Adding a `position` here fails parity against every captured fixture.
 */
export interface FrontmatterLinkCache extends Reference { key: string }
export interface TagCache { tag: string; position: Pos }
export interface HeadingCache { heading: string; level: number; position: Pos }
export interface SectionCache { type: string; position: Pos; id?: string }
/** `parent` is a LINE NUMBER. See Step 5 for the conversion and its pinning. */
export interface ListItemCache { position: Pos; parent: number; id?: string; task?: string }
export interface BlockCache { id: string; position: Pos }

export function buildCachedMetadata(row: MirrorNoteRow, positions: PositionIndex): CachedMetadata;
```

- Produces (`metadata-cache.ts`):

```ts
export class MetadataCache {
  getFileCache(file: TFile): CachedMetadata | null;        // public since 0.9.21
  getCache(path: string): CachedMetadata | null;           // PUBLIC since 0.14.5 — tag-wrangler
  getCachedFiles(): string[];                              // undocumented, tag-wrangler
  getTags(): Record<string, number>;                       // undocumented, tag-wrangler + quickadd
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension?: boolean): string;
  readonly resolvedLinks: Record<string, Record<string, number>>;
  readonly unresolvedLinks: Record<string, Record<string, number>>;
  getBacklinksForFile(file: TFile): CustomArrayDict<LinkCache>;
  on(name: "changed" | "deleted" | "resolve" | "resolved", cb: (...args: unknown[]) => void): EventRef;
  off(name: string, cb: unknown): void;
  offref(ref: EventRef): void;
  trigger(name: string, ...args: unknown[]): void;
}
export class CustomArrayDict<T> {
  readonly data: Record<string, T[]>;
  add(key: string, value: T): void;
  get(key: string): T[] | null;
  keys(): string[];
  count(): number;
  clear(key: string): void;
  clearAll(): void;
}
```

Those methods are not optional politeness — but the reason needs stating accurately, because v1 overstated it. `getCache` is **documented public since 0.14.5**; only `getCachedFiles` and `getTags` are genuinely undocumented. And tag-wrangler's `onLayoutReady` body is not *entirely* the scan: measured against the shipped bundle it does four things — `getCachedFiles().forEach(path => getCache(path)?.frontmatter)`, then `registerEvent(metadataCache.on("changed", …))`, then `registerEvent(vault.on("delete", …))`, then `workspace.getLeavesOfType("tag").forEach(leaf => leaf?.view?.requestUpdateTags?.())`. So a shim missing `getCachedFiles` harvests nothing from it, a shim whose `getLeavesOfType` returns `undefined` throws inside its `onLayoutReady`, and a shim whose `changed`/`delete` events never fire leaves its alias index frozen at boot. All four are covered: the first two here, the events in Task 15, the leaf list in Task 11a.

- `getFileCache` returns `null` when the mirror has no row **or** no position index for the path. That is Obsidian's own contract for an uncached file, and Task 15 ensures it never happens after `resolved`.

- [ ] **Step 1: Write the failing parity test**

Create `host/packages/host/test/metadata-parity.test.ts`. It is data-driven over the Task 0 captures so a new fixture needs no new test code:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCachedMetadata } from "../src/mirror/metadata";
import { buildPositionIndex } from "../src/mirror/positions";
import { parseFixtureRow } from "../src/testing/fixture-vault";

const dir = join(__dirname, "..", "..", "..", "fixtures", "metadata-parity");
const cases = readdirSync(dir)
  .filter((name) => name.endsWith(".expected.json"))
  .map((name) => name.replace(".expected.json", ""));

// The three fields vaultd does not parse. Declared absent-with-policy in the
// shim, so the comparison drops them from Obsidian's side rather than
// pretending they matched — and the assertion below proves the fixture corpus
// actually contains at least one note that has them, so this is a measured gap
// and not a blanket excuse.
const UNSERVED = ["footnotes", "footnoteRefs", "referenceLinks"] as const;
const without = (cache: Record<string, unknown>): Record<string, unknown> => {
  const copy = { ...cache };
  for (const key of UNSERVED) delete copy[key];
  return copy;
};

describe("CachedMetadata parity", () => {
  it("covers every captured fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(18);
    expect(cases).toContain("parity-frontmatter-links");
    expect(cases).toContain("parity-sections");
    expect(cases).toContain("parity-list-flat");
    expect(cases).toContain("parity-list-tasks");
    expect(cases).toContain("parity-footnotes");
    expect(cases).toContain("parity-wide-offsets");
  });

  it("measures the unserved fields rather than assuming they are always empty", () => {
    const captured = JSON.parse(
      readFileSync(join(dir, "parity-footnotes.expected.json"), "utf8"),
    ) as { cache: Record<string, unknown> };
    // If this fails, the footnote fixture does not actually exercise the gap
    // and UNSERVED is hiding nothing — fix the fixture, not this test.
    expect(UNSERVED.some((key) => captured.cache[key] !== undefined)).toBe(true);
  });

  for (const name of cases) {
    it(`matches real Obsidian for ${name}`, () => {
      const source = readFileSync(join(dir, `${name}.md`), "utf8");
      const captured = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), "utf8")) as {
        obsidianVersion: string; cache: Record<string, unknown>;
      };
      const row = parseFixtureRow(`${name}.md`, source);
      const built = buildCachedMetadata(row, buildPositionIndex(source));
      expect(JSON.parse(JSON.stringify(built))).toEqual(without(captured.cache));
    });
  }

  it("emits frontmatter links with no position field", () => {
    const source = readFileSync(join(dir, "parity-frontmatter-links.md"), "utf8");
    const built = buildCachedMetadata(
      parseFixtureRow("parity-frontmatter-links.md", source),
      buildPositionIndex(source),
    );
    expect(built.frontmatterLinks?.length).toBeGreaterThan(0);
    for (const entry of built.frontmatterLinks ?? []) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.displayText === undefined
          ? ["key", "link", "original"]
          : ["displayText", "key", "link", "original"],
      );
    }
  });
});
```

`parseFixtureRow` runs the real `vaultd` parser over the fixture — Task 6b's `fixture-row` binary prints a `MirrorNoteRow` as JSON — so this test compares **vaultd's semantics through the shim** against Obsidian, not a hand-built row against a hand-built expectation. A parity test fed by hand-written input proves nothing.

- [ ] **Step 2: Run it and observe the failure**

```bash
npm --prefix host test -- metadata-parity
```

Expected: cannot resolve `../src/mirror/metadata`; after that module exists but is empty, every case fails on a shape mismatch.

- [ ] **Step 3: Implement frontmatter, headings, blocks, and tags**

In `metadata.ts`, convert `row.properties` into a plain `frontmatter` object (a `PropertyValueDto` tree flattened to JS values; `float` arrives as a **string** on the wire and must be `Number(...)`-ed, which is the single most likely silent parity bug in this task), `frontmatterPosition` from the enclosing property span, `headings` from `row.headings` with `heading` = text and `level`, `blocks` as a `Record<id, BlockCache>`, and `tags` from `row.tags` filtered to `origin === "body"` — Obsidian puts frontmatter tags in `frontmatter.tags`, not in `cache.tags`, and the capture proves which.

- [ ] **Step 4: Implement links, embeds, and frontmatterLinks**

Split `row.outgoing` three ways. Body references with kind `wikilink`/`markdown_link` become `links`; `wiki_embed`/`markdown_embed` become `embeds`; every reference with `origin === "property"` becomes a `frontmatterLinks` entry whose `key` is the dot-and-index path into the frontmatter (`field`, or `field.0`/`field.1` for a list) — breadcrumbs reads exactly that key shape, and `parity-frontmatter-links` is the fixture that pins it.

Body entries (`links`, `embeds`) carry `link` (the raw target plus subpath as written), `original` (the exact source slice for the reference span), `displayText` when the reference has one, and `position` from `span(index, reference.span.start, reference.span.end)`.

**Frontmatter entries carry no `position`, and that is not an omission.** `FrontmatterLinkCache extends Reference`, not `ReferenceCache` — its fields are `link`, `original`, optional `displayText`, and `key`. So the frontmatter branch builds `{ link, original, displayText?, key }` and **never calls `span()`**, which also means it needs no position index and cannot be wrong about one. v1 of this plan built them through the same helper as body links and would have emitted a `position` on every entry, failing every `parity-frontmatter-links` comparison at once; write the two branches separately so they cannot drift back together.

- [ ] **Step 5: Implement sections and listItems**

`sections` maps `row.sections` one-to-one, `type` passed through as the string vaultd stored (the parse extension preserved Obsidian's vocabulary including unknown kinds), `id` present only when the section carries a block id.

`listItems` maps `row.listItems`. **The parent is a line number on both sides** — there is no `ListItemParent::Root`/`::Item` enum on the wire and no array index anywhere. The pre-task's `ListItemDto` gives exactly one of two optional columns, and the conversion is:

```ts
const parentOf = (item: ListItemDto): number => {
  if (item.list_start_line !== undefined) return -item.list_start_line;   // root
  if (item.parent_start_line !== undefined) return item.parent_start_line; // nested
  throw new Error("list item has neither list_start_line nor parent_start_line");
};
```

`obsidian.d.ts` (`ListItemCache.parent`, lines 3760–3769) states the semantics this implements: "Line number of the parent list item (`position.start.line`). If this item has no parent … then this value is **the negative of the line number of the first list item** (start of the list)." So `-list_start_line` is the expected shape.

**The exact negation form is pinned by the Task-0 capture fixtures, not by this paragraph.** The one case the typings cannot settle is a list starting on line 0, where `-0` and `0` are the same JSON number and a root item at line 0 is indistinguishable from a child of line 0. `parity-list-flat` is authored to start on line 0 precisely to capture what Obsidian actually emits there; if the capture shows an offset form (`-(line + 1)`), `parentOf` takes that form instead and the reason is recorded beside the fixture. Implement against the captured values; treat the formula above as the expected shape, not the specification. Getting this wrong is silent breakage for breadcrumbs, which reconstructs hierarchy by comparing `parent` against `position.start.line`.

`task` is set only when the row has one, so a non-task item omits the key rather than carrying `undefined`.

- [ ] **Step 6: Run and observe it pass**

```bash
npm --prefix host test -- metadata-parity
```

Expected: all 18 fixtures match field-for-field, including `parity-wide-offsets` (the case that fails if the byte-to-UTF-16 conversion is approximated), `parity-frontmatter-links` (the case that fails if a `position` is added), and `parity-list-flat` (the case that pins the negation form).

- [ ] **Step 7: Write the failing MetadataCache test**

Create `host/packages/host/test/shim-metadata-cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("MetadataCache", () => {
  it("answers the three undocumented methods tag-wrangler needs", async () => {
    const harness = await ShimHarness.withVault({
      "A.md": "---\ntags: [alpha, beta]\naliases: [Ay]\n---\n#gamma\n",
      "B.md": "#alpha\n",
    });
    const cache = harness.app.metadataCache;
    expect(cache.getCachedFiles().sort()).toEqual(["A.md", "B.md"]);
    expect(cache.getCache("A.md")?.frontmatter).toMatchObject({ tags: ["alpha", "beta"] });
    expect(cache.getCache("missing.md")).toBeNull();
    expect(cache.getTags()).toEqual({ "#alpha": 2, "#beta": 1, "#gamma": 1 });
  });

  it("returns null before a note's position index is warm and the cache after", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "# Title\n" }, { warm: false });
    const file = harness.vault.getFileByPath("A.md")!;
    expect(harness.app.metadataCache.getFileCache(file)).toBeNull();
    await harness.mirror.warmPositions();
    expect(harness.app.metadataCache.getFileCache(file)?.headings?.[0]?.heading).toBe("Title");
  });

  it("resolves a linkpath through vaultd resolution, not a filename guess", async () => {
    const harness = await ShimHarness.withVault({
      "Folder/Target.md": "body\n",
      "Other/Target.md": "body\n",
      "Folder/Source.md": "Target\n",
    });
    const dest = harness.app.metadataCache.getFirstLinkpathDest("Target", "Folder/Source.md");
    expect(dest?.path).toBe("Folder/Target.md");
    expect(harness.app.metadataCache.getFirstLinkpathDest("Nope", "Folder/Source.md")).toBeNull();
  });

  it("exposes resolvedLinks, unresolvedLinks, and backlinks from the mirror", async () => {
    const harness = await ShimHarness.withVault({
      "A.md": "B and Ghost\n",
      "B.md": "body\n",
    });
    const cache = harness.app.metadataCache;
    expect(cache.resolvedLinks["A.md"]).toEqual({ "B.md": 1 });
    expect(cache.unresolvedLinks["A.md"]).toEqual({ Ghost: 1 });
    const backlinks = cache.getBacklinksForFile(harness.vault.getFileByPath("B.md")!);
    expect(backlinks.keys()).toEqual(["A.md"]);
    expect(backlinks.get("A.md")).toHaveLength(1);
    expect(backlinks.count()).toBe(1);
  });

  it("fires changed with file, data, and cache in Obsidian's argument order", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "# One\n" });
    const seen: Array<[string, string, string | undefined]> = [];
    harness.app.metadataCache.on("changed", (file, data, cache) => {
      seen.push([
        (file as { path: string }).path,
        data as string,
        (cache as { headings?: Array<{ heading: string }> }).headings?.[0]?.heading,
      ]);
    });
    await harness.writeNote("A.md", "# Two\n");
    expect(seen).toEqual("A.md", "# Two\n", "Two");
  });
});
```

- [ ] **Step 8: Run it and observe the failure**

```bash
npm --prefix host test -- shim-metadata-cache
```

Expected: cannot resolve `../src/shim/metadata-cache`.

- [ ] **Step 9: Implement the cache facade**

Create `metadata-cache.ts`. `getFileCache` memoizes `buildCachedMetadata` per `(path, revision)` so repeated calls in a hot handler do not rebuild — 27 plugins call it and quickadd calls it **26** times in one bundle (measured 2026-08-30 against the shipped `quickadd/main.js`; v1 said 25). The memo is invalidated by revision, never by time. `changed` carries `(file, data, cache)` where `data` is the note's new source, which the mirror already fetched to build the position index, so the event costs no extra round trip.

- [ ] **Step 10: Run and observe it pass**

```bash
npm --prefix host test -- shim-metadata-cache
npm --prefix host test -- metadata-parity
```

Expected: all cases pass.

- [ ] **Step 11: Commit**

```bash
git add host/packages/host/src/mirror/metadata.ts host/packages/host/src/shim/metadata-cache.ts host/packages/host/test
git commit -m "feat(host): assemble Obsidian CachedMetadata from mirror rows"
```

---

### Task 9: Shim — FileManager

**Files:**

- Create: `host/packages/host/src/shim/file-manager.ts`
- Create: `host/packages/host/test/shim-file-manager.test.ts`

**Interfaces:**

- Produces:

```ts
export class FileManager {
  processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  renameFile(file: TAbstractFile, newPath: string): Promise<void>;
  generateMarkdownLink(file: TFile, sourcePath: string, subpath?: string, alias?: string): string;
  getNewFileParent(sourcePath: string, newFilePath?: string): TFolder;
  getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string>;
  trashFile(file: TAbstractFile): Promise<void>;
  createNewFolder(parent: TFolder): Promise<TFolder>;         // undocumented, folder-notes
  promptForDeletion(file: TAbstractFile): Promise<boolean>;    // IMPLEMENTED — brokered confirm
  promptForFileRename(file: TAbstractFile): Promise<void>;     // absent → HeadlessUnsupported
  promptForFolderDeletion(folder: TFolder): Promise<void>;     // absent → HeadlessUnsupported
}
```

- `processFrontMatter` is the sleeper the research flagged: 13 plugins use it and a weak YAML round trip silently rewrites every note it touches. The implementation therefore never re-serializes the document. It reads the current frontmatter as a plain object, hands it to the callback, **diffs the object before and after**, and sends `patch_frontmatter { path, patch: [{ key_path, value }], expected: { revision } }` carrying only the keys the callback actually changed. A key set to `undefined` or deleted becomes `{ key_path, value: null }`, which is the mutation spec's deletion form.
- `trashFile` maps to `delete_note`/`delete_folder` with `mode: "trash_local"`, matching Obsidian's `fileManager.trashFile` (which honors the user's trash preference — the host reads `trashOption` from `app.json` here, and only here, because unlike `vault.trash` this API has no per-call choice to pass through).
- **`promptForDeletion` is implemented, not absent, because it is a real documented API with a real answer to give.** `obsidian.d.ts` has it as `promptForDeletion(file: TAbstractFile): Promise<boolean>`, public since 0.15.0, documented as "Prompt the user to confirm they want to delete the specified file or folder … resolves to true if the prompt was confirmed or false if it was canceled." v1 of this plan classified it `absent` with a `Promise<void>` signature, which is wrong on both counts.

  The headless behavior follows from what the return value means. With an interaction handler attached, it brokers a `confirm` prompt (Task 18) and, on `true`, performs the deletion through `trashFile` — the same thing Obsidian does after its own dialog. With no handler attached it resolves **`false`**: nobody was asked, so nothing was confirmed, and the caller's own `if (confirmed)` branch does the right thing without any special-casing. It never deletes silently and it never throws, so folder-notes' delete path degrades into a no-op instead of a crash. A `safe_stub` hit is recorded for the unattended case so the compatibility report shows the plugin asked.
- `promptForFileRename` and `promptForFolderDeletion` stay `absent` and throw `unsupported(...)`. Neither appears in `obsidian.d.ts` at all, so there is no documented return contract to honor and no honest value to invent — unlike the confirm above, "the rename dialog resolved" has no meaningful headless answer.

- [ ] **Step 1: Write the failing test**

Create `host/packages/host/test/shim-file-manager.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HeadlessUnsupported } from "../src/shim/policy";
import { ShimHarness } from "../src/testing/shim-harness";

describe("FileManager", () => {
  it("sends only the keys processFrontMatter actually changed", async () => {
    const harness = await ShimHarness.withVault({
      "A.md": "---\ntitle: Old\nkeep: yes\nnested:\n  inner: 1\n---\nbody\n",
    });
    const file = harness.vault.getFileByPath("A.md")!;
    const pending = harness.app.fileManager.processFrontMatter(file, (fm) => {
      expect(fm).toMatchObject({ title: "Old", keep: "yes", nested: { inner: 1 } });
      fm["title"] = "New";
      (fm["nested"] as Record<string, unknown>)["inner"] = 2;
      delete fm["keep"];
    });
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "patch_frontmatter",
      params: {
        path: "A.md",
        patch: [
          { key_path: "title", value: "New" },
          { key_path: "nested.inner", value: 2 },
          { key_path: "keep", value: null },
        ],
        expected: { revision: harness.revisionOf("A.md") },
      },
    });
    harness.respondOk(sent.id, "patch_frontmatter", { generation: 4, revision: "blake3:new" });
    harness.answerRefetch(4, [{ path: "A.md", revision: "blake3:new" }]);
    await pending;
  });

  it("sends no request when the callback changes nothing", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "---\ntitle: Same\n---\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    await harness.app.fileManager.processFrontMatter(file, (fm) => {
      expect(fm["title"]).toBe("Same");
    });
    expect(harness.pendingRequests()).toHaveLength(0);
  });

  it("routes renameFile to rename_note with link rewriting on", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "x\n", "B.md": "A\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    const pending = harness.app.fileManager.renameFile(file, "Renamed.md");
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "rename_note",
      params: {
        from: "A.md", to: "Renamed.md",
        expected: { revision: harness.revisionOf("A.md") }, rewrite_links: true,
      },
    });
    harness.respondOk(sent.id, "rename_note", {
      generation: 5, revision: "blake3:r", links_rewritten: 1, link_rewrite_failures: [],
    });
    // The refetch set is [to] plus every path the mirror knew was linking to
    // `from` BEFORE the rename — here B.md, whose A the daemon rewrote.
    // `links_rewritten: 1` names no path, so the path list comes from the
    // mirror's backlink index, not from the response.
    harness.answerRefetch(5, [{ path: "Renamed.md", revision: "blake3:r" }, { path: "B.md", revision: "blake3:b2" }]);
    await pending;
    expect(harness.mirror.note("B.md")?.revision).toBe("blake3:b2");
    expect(harness.mirror.entry("A.md")).toBeUndefined();
  });

  it("refetches the referrers a failed rewrite names, and the ones it does not", async () => {
    const harness = await ShimHarness.withVault({
      "A.md": "x\n", "B.md": "A\n", "Busy.md": "A\n",
    });
    const file = harness.vault.getFileByPath("A.md")!;
    const pending = harness.app.fileManager.renameFile(file, "Renamed.md");
    const sent = await harness.nextRequest();
    harness.respondOk(sent.id, "rename_note", {
      generation: 6, revision: "blake3:r", links_rewritten: 1,
      // Failures carry paths; successes carry only a count. Both referrers
      // must still be refetched, because the mirror cannot tell from the
      // response which of the two the count referred to.
      link_rewrite_failures: [{ path: "Busy.md", reason: "revision_conflict" }],
    });
    const refetched = harness.answerRefetch(6, [
      { path: "Renamed.md", revision: "blake3:r" },
      { path: "B.md", revision: "blake3:b2" },
      { path: "Busy.md", revision: "blake3:busy1" },
    ]);
    await pending;
    expect([...refetched].sort()).toEqual(["B.md", "Busy.md", "Renamed.md"]);
    // The failure is surfaced, not swallowed: a caller that cares can read it.
    expect(harness.app.fileManager.lastRenameFailures()).toEqual([
      { path: "Busy.md", reason: "revision_conflict" },
    ]);
  });

  it("generates the shortest unambiguous wikilink and upgrades on ambiguity", async () => {
    const harness = await ShimHarness.withVault({
      "Folder/Target.md": "x\n",
      "Folder/Source.md": "x\n",
      "Other/Target.md": "x\n",
      "Solo.md": "x\n",
    });
    const fm = harness.app.fileManager;
    expect(fm.generateMarkdownLink(harness.vault.getFileByPath("Solo.md")!, "Folder/Source.md"))
      .toBe("Solo");
    expect(fm.generateMarkdownLink(harness.vault.getFileByPath("Folder/Target.md")!, "Folder/Source.md"))
      .toBe("Folder/Target");
    expect(fm.generateMarkdownLink(harness.vault.getFileByPath("Solo.md")!, "Folder/Source.md", "#Heading", "Alias"))
      .toBe("Alias");
  });

  it("resolves promptForDeletion false with no handler, and deletes nothing", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "x\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    // Real API, real signature: Promise<boolean>, public since 0.15.0.
    await expect(harness.app.fileManager.promptForDeletion(file)).resolves.toBe(false);
    expect(harness.pendingRequests()).toHaveLength(0);
    expect(harness.vault.getFileByPath("A.md")).not.toBeNull();
    expect(
      harness.policyRecorder.entries().find((e) => e.symbol === "FileManager.promptForDeletion")?.policy,
    ).toBe("safe_stub");
  });

  it("throws HeadlessUnsupported for the two undocumented prompt entry points", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "x\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    const folder = harness.vault.getRoot();
    await expect(harness.app.fileManager.promptForFileRename(file))
      .rejects.toBeInstanceOf(HeadlessUnsupported);
    await expect(harness.app.fileManager.promptForFolderDeletion(folder))
      .rejects.toBeInstanceOf(HeadlessUnsupported);
    await harness.app.fileManager.promptForFileRename(file).catch((error: HeadlessUnsupported) => {
      expect(error.symbol).toBe("FileManager.promptForFileRename");
      expect(error.pluginId).toBeNull();
    });
    expect(harness.pendingRequests()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- shim-file-manager
```

Expected: cannot resolve `../src/shim/file-manager`.

- [ ] **Step 3: Implement the frontmatter diff**

Create `file-manager.ts` with a `diffFrontMatter(before, after): Array<{ key_path: string; value: unknown }>` that walks both trees in parallel, emits a dot-path per changed leaf, emits `value: null` for a key present in `before` and absent in `after`, and emits the whole subtree value when a branch changes shape (object to scalar, or an array whose length changed) — because a dot-path into a reshaped branch would address a span that no longer exists.

- [ ] **Step 4: Implement `renameFile` and its refetch set**

**The mechanism, stated because the response cannot supply it.** The revised phase-5 `RenameResponse` is `{ generation, revision, links_rewritten, link_rewrite_failures }`: the **failures** carry paths (`LinkRewriteFailureDto { path, reason }`), the **successes** carry only a count. So after a rename the shim knows how many inbound links were repaired but not, from the response, which notes they were in — and every one of those notes now has different bytes and a different revision, so leaving them in the mirror is leaving the mirror wrong.

The shim does not invent path-level knowledge it was not given. It asks the mirror, **before** sending the request, for the thing the mirror already tracks:

```ts
async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
  const from = file.path;
  // Captured BEFORE the mutation: after it lands, `from` no longer exists and
  // its backlink entry is gone. `backlinks()` is the mirror's dependents-of
  // -target query, already built in Task 6.
  const referrers = new Set(
    this.deps.mirror.backlinks(from).map((reference) => reference.source_path),
  );
  const method = file instanceof TFolder ? "rename_folder" : "rename_note";
  const result = await this.deps.writes.send<RenameResponse>(method, {
    from, to: newPath,
    expected: this.expectedFor(from),
    rewrite_links: true,
  });
  this.lastFailures = result.link_rewrite_failures;
  // Every path whose bytes may have moved: the target, plus every note that
  // linked to the old path — including the ones the daemon FAILED to rewrite,
  // because a failure means that note is unchanged and the mirror must
  // confirm that rather than assume it.
  const affected = [newPath, ...referrers];
  await this.deps.mirror.applyMutation(result.generation, affected);
}
```

Three properties make this honest rather than clever. The referrer set comes from the mirror's own resolved-link index, which is the same data `vaultd` used to find the links it rewrote — so it is a superset of what changed, never a subset, and a superset only costs a refetch. Failed rewrites are refetched too, because "the daemon could not rewrite `Busy.md`" and "`Busy.md` is unchanged" are the same statement only if nothing else touched it, which the mirror cannot know without asking. And for `rename_folder` the referrer set is the union over every note under the folder, computed the same way before the request goes out.

`lastRenameFailures()` exposes `link_rewrite_failures` from the most recent rename so `host.info` and the compatibility report can surface partial repairs; nothing swallows them.

- [ ] **Step 5: Implement the remaining methods**

`generateMarkdownLink` asks the mirror whether the shortest form resolves back to the same file from `sourcePath` (via `firstLinkpathDest`) and uses the folder-qualified path when it does not — the same spelling policy `vaultd`'s rename repair uses, so a link the shim writes and a link the daemon rewrites look identical. `getAvailablePathForAttachment` reads `attachmentFolderPath` from `getConfig` and appends ` 1`, ` 2` … on collision, matching Obsidian's suffix form. `promptForDeletion` brokers a `confirm` through `deps.broker` when one is attached and resolves `false` when none is.

- [ ] **Step 6: Run and observe it pass**

```bash
npm --prefix host test -- shim-file-manager
```

Expected: six cases pass, including the no-op case that sends nothing and the rename-failure refetch case.

- [ ] **Step 6: Commit**

```bash
git add host/packages/host/src/shim/file-manager.ts host/packages/host/test/shim-file-manager.test.ts
git commit -m "feat(host): implement the file manager shim with surgical frontmatter patching"
```

---

### Task 10: Shim — the Plugin base class and registration harvesting

**Files:**

- Create: `host/packages/host/src/shim/plugin.ts`
- Create: `host/packages/host/src/shim/harvest.ts`
- Modify: `host/packages/host/src/shim/events.ts` (created in Task 6b; this task adds `Menu` and `MenuItem`)
- Create: `host/packages/host/test/shim-plugin.test.ts`
- Create: `host/packages/host/test/harvest.test.ts`

**Interfaces:**

- Produces (`events.ts` additions) — Task 6b created this file with `Events`, `EventRef`, and `ShimEventBus`; this task adds the menu-recording pair. The full file surface after this task:

```ts
/** Returned by every `on(...)`; `detach()` is what `registerEvent` calls. */
export interface EventRef { detach(): void }

/** The Obsidian `Events` base. Vault, MetadataCache, and Workspace all extend it. */
export abstract class Events {
  on(name: string, cb: (...args: unknown[]) => unknown, ctx?: unknown): EventRef;
  off(name: string, cb: unknown): void;
  offref(ref: EventRef): void;
  trigger(name: string, ...args: unknown[]): void;
  tryTrigger(ref: EventRef, args: unknown[]): void;
}

/**
 * The one bus every shim event surface shares. It exists separately from
 * `Events` because the host needs two things Obsidian's base does not give:
 * per-listener attribution (which plugin registered this handler, so Task 14b
 * can quarantine the right one when it throws) and dispatch through the FIFO
 * queue (so two plugin callbacks are never in flight at once).
 */
export class ShimEventBus {
  constructor(deps: { queue: DispatchQueue; onHandlerError(failure: HandlerFailure): void });
  register(owner: string, source: string, name: string, cb: (...args: unknown[]) => unknown): EventRef;
  unregister(ref: EventRef): void;
  /** Await every listener for `source:name`, in registration order, each
   *  dispatched through the queue and each failure attributed to its owner. */
  emit(source: string, name: string, args: readonly unknown[]): Promise<void>;
  /** Deliver to exactly one plugin's listeners — the synthetic-`resolved` path. */
  emitTo(pluginId: string, source: string, name: string, args: readonly unknown[]): Promise<void>;
  listenerCount(source: string, name: string): number;
  forgetPlugin(pluginId: string): void;
}

/** Added by this task: the recording menu a harvest round trip builds. */
export class Menu {
  addItem(cb: (item: MenuItem) => unknown): this;
  addSeparator(): this;
  setNoIcon(): this;
  showAtMouseEvent(evt: unknown): this;    // safe_stub
  showAtPosition(position: unknown): this; // safe_stub
  hide(): this;
  items(): readonly MenuItem[];
}
export class MenuItem {
  setTitle(title: string | DocumentFragment): this;
  setIcon(icon: string | null): this;
  setSection(section: string): this;
  setChecked(checked: boolean | null): this;
  setDisabled(disabled: boolean): this;
  setIsLabel(isLabel: boolean): this;
  onClick(cb: (evt: unknown) => unknown): this;
  readonly title: string;
  readonly icon: string | null;
  readonly section: string | null;
  readonly checked: boolean | null;
  invoke(): Promise<void>;
}
```

`ShimEventBus.forgetPlugin` is what makes quarantine complete: unloading a plugin drops its harvest (below) and its listeners (here), so a quarantined plugin can neither be invoked nor be woken by a vault change.

- Produces (`harvest.ts`) — the payoff of the whole design, so its shapes are pinned here and reused verbatim by the host protocol in Task 16a. **These are internal `camelCase` types; `src/server/wire.ts` converts them to `snake_case` at the socket, and the server tests assert the converted spelling** (see Global Constraints). Nothing on the wire ever says `pluginId`:

```ts
export interface HarvestedCommand {
  readonly pluginId: string;
  readonly id: string;                 // fully qualified: "<pluginId>:<localId>"
  readonly localId: string;
  readonly name: string;
  readonly icon: string | null;
  readonly kind: "callback" | "checkCallback" | "editorCallback" | "editorCheckCallback";
  readonly hotkeys: readonly { modifiers: string[]; key: string }[];
}
export interface HarvestedMenuHook {
  readonly pluginId: string;
  readonly id: string;                 // "<pluginId>:file-menu:<ordinal>"
  readonly context: "file-menu" | "editor-menu";
}
export interface HarvestedMenuItem {
  readonly hookId: string;
  readonly pluginId: string;
  readonly id: string;
  readonly title: string;
  readonly icon: string | null;
  readonly section: string | null;
  readonly checked: boolean | null;
}
export interface HarvestedProtocolHandler { readonly pluginId: string; readonly action: string }
/**
 * `tab` is the live `PluginSettingTab` instance the plugin passed to
 * `addSettingTab`. Task 17's schema ladder needs to CALL
 * `tab.getSettingDefinitions()` on it — a boolean saying the method exists is
 * not enough to climb rung 1, and re-finding the instance later is impossible
 * because nothing else holds a reference to it. It is excluded from the wire
 * shape (`src/server/wire.ts` sends `{ plugin_id, has_setting_definitions }`
 * only), so a live object never leaves the process.
 */
export interface HarvestedSettingTab {
  readonly pluginId: string;
  readonly hasSettingDefinitions: boolean;
  readonly tab: PluginSettingTab;
}
export interface HarvestedRibbonIcon { readonly pluginId: string; readonly id: string; readonly title: string; readonly icon: string }
export interface HarvestedTimer { readonly pluginId: string; readonly intervalMs: number; readonly createdAt: number }
export interface HarvestedUnreachable {
  readonly pluginId: string;
  readonly kind: "dom_delegated_menu" | "view" | "editor_extension" | "code_block_processor" | "editor_suggest";
  readonly detail: string;
}
export class Harvest {
  commands(): readonly HarvestedCommand[];
  menuHooks(): readonly HarvestedMenuHook[];
  protocolHandlers(): readonly HarvestedProtocolHandler[];
  settingTabs(): readonly HarvestedSettingTab[];
  ribbonIcons(): readonly HarvestedRibbonIcon[];
  timers(): readonly HarvestedTimer[];
  unreachable(): readonly HarvestedUnreachable[];
  forgetPlugin(pluginId: string): void;
}
```

`unreachable()` is not decoration. tag-wrangler registers **zero** commands and hooks `editor-menu` exactly once; its remaining surface comes from **ten DOM-delegated listeners — of which two are `contextmenu`-typed and the other eight are pointerdown, drag, mouseover, and click** — plus a `Menu.prototype` patch for preview-mode tags. A host with no DOM cannot reach any of the eleven. (v1 of this plan said all ten were `contextmenu` listeners; the shipped bundle says otherwise, and the corrected count is what Task 0 Step 4c records and Task 22 asserts.) Recording them as `dom_delegated_menu` is the difference between a report that says "tag-wrangler harvested 1 menu hook" and one that says "1 harvested, 10 unreachable and here is why".

- Produces (`plugin.ts`):

```ts
export abstract class Component {
  load(): void; onload(): void; unload(): void; onunload(): void;
  addChild<T extends Component>(child: T): T;
  removeChild<T extends Component>(child: T): T;
  register(cb: () => unknown): void;
  registerEvent(ref: EventRef): void;
  registerDomEvent(...args: unknown[]): void;      // safe_stub
  registerInterval(id: number): number;            // implemented, instrumented
}
export abstract class Plugin extends Component {
  readonly app: App;
  readonly manifest: PluginManifest;
  constructor(app: App, manifest: PluginManifest);
  addCommand(command: Command): Command;                    // harvested + invokable
  removeCommand(id: string): void;
  addRibbonIcon(icon: string, title: string, cb: (evt: unknown) => unknown): HTMLElement;  // harvested
  addStatusBarItem(): HTMLElement;                          // harvested
  addSettingTab(tab: PluginSettingTab): void;               // harvested
  registerView(type: string, ctor: unknown): void;          // safe_stub + unreachable
  registerEditorExtension(ext: unknown): void;              // safe_stub + unreachable
  registerMarkdownPostProcessor(p: unknown, sortOrder?: number): unknown;  // safe_stub
  registerMarkdownCodeBlockProcessor(lang: string, p: unknown): unknown;   // safe_stub
  registerEditorSuggest(s: unknown): void;                  // safe_stub + unreachable
  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void;
  registerHoverLinkSource(id: string, info: unknown): void; // safe_stub
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
  onExternalSettingsChange?(): void;
}
```

- **`Plugin.addCommand` delegates to `CommandRegistry`; it does not keep its own map.** This is stated in both tasks' interfaces because v1 left it ambiguous and the two would have drifted into two command lists. Concretely: `addCommand(command)` namespaces the id to `<pluginId>:<localId>`, records the `HarvestedCommand` here, and calls `this.app.commands.addCommand(namespaced)` — which is the map `app.commands.commands` exposes and which obsidian-linter and automatic-linker monkeypatch. `removeCommand(localId)` forgets both. Task 12 builds `CommandRegistry` and Task 12's test asserts a plugin-registered command is visible through `app.commands.listCommands()`; that test only passes because of this delegation. Until Task 12 lands, `app.commands` is the skeleton `App`'s field and this task's tests read the harvest rather than the registry.
- `loadData()` reads `<configDir>/plugins/<id>/data.json` through `read_file` and returns `null` on `not_found` — exactly what Obsidian returns for a plugin with no saved data, which 50 plugins branch on. `saveData()` writes it through `write_file`. Both stay inside the **host's** config dir (Ruling 1), so the GUI copy's `data.json` is structurally untouchable rather than merely left alone by convention.
- `registerInterval` really schedules, because 8 plugins depend on it, but every timer is recorded in the harvest with its cadence and cleared on unload. The idle-cost census found 5 Hz-forever timers in this corpus; a host that hides them is a host nobody can debug.
- `registerView`, `registerEditorExtension`, `registerEditorSuggest`, and the two markdown processors accept and discard. They run inside `onload`, so a throw there kills the plugin before its useful half loads — this is the single most important "never throw" rule in the shim.

- [ ] **Step 1: Write the failing plugin-base test**

Create `host/packages/host/test/shim-plugin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("Plugin base", () => {
  it("accepts and discards the registrations that must never throw", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.registerView("demo-view", () => ({}));
        this.registerEditorExtension({});
        this.registerMarkdownPostProcessor(() => {});
        this.registerMarkdownCodeBlockProcessor("demo", () => {});
        this.registerEditorSuggest({});
        this.registerHoverLinkSource("demo", {});
        this.registerDomEvent(harness.api.activeDocument, "click", () => {});
        this.register(() => {});
      }
    });
    await expect(harness.load(plugin)).resolves.toBeUndefined();
    expect(harness.harvest.unreachable().map((u) => u.kind).sort()).toEqual(
      ["code_block_processor", "editor_extension", "editor_suggest", "view"],
    );
  });

  it("round-trips loadData and saveData inside the host config dir", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {});
    await expect(plugin.loadData()).resolves.toBeNull();
    const saving = plugin.saveData({ enabled: true });
    const sent = await harness.nextRequest();
    expect(sent.request).toMatchObject({
      method: "write_file",
      params: { path: ".obsidian-headless/plugins/demo/data.json" },
    });
    const written = JSON.parse(
      Buffer.from((sent.request.params as { content_base64: string }).content_base64, "base64").toString("utf8"),
    ) as unknown;
    expect(written).toEqual({ enabled: true });
    harness.respondOk(sent.id, "write_file", { revision: "blake3:d1", semantic: false });
    await saving;
  });

  it("records every interval with its cadence and clears them on unload", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("ticker", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.registerInterval(harness.api.window.setInterval(() => {}, 200));
        this.registerInterval(harness.api.window.setInterval(() => {}, 30_000));
      }
    });
    await harness.load(plugin);
    expect(harness.harvest.timers().map((t) => t.intervalMs).sort((a, b) => a - b)).toEqual([200, 30_000]);
    await harness.unload("ticker");
    expect(harness.harvest.timers()).toEqual([]);
    expect(harness.activeTimerCount()).toBe(0);
  });

  it("runs every registered teardown exactly once on unload", async () => {
    const harness = await ShimHarness.withVault({});
    const order: string[] = [];
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.register(() => order.push("registered"));
        this.registerEvent(harness.app.vault.on("create", () => {}));
      }
      override onunload(): void { order.push("onunload"); }
    });
    await harness.load(plugin);
    await harness.unload("demo");
    await harness.unload("demo");
    expect(order).toEqual(["onunload", "registered"]);
  });
});
```

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- shim-plugin
```

Expected: cannot resolve `../src/shim/plugin`.

- [ ] **Step 3: Implement Component and Plugin**

Create `plugin.ts`. `Component` holds a `teardown: Array<() => unknown>`; `unload()` calls `onunload()` first, then drains the array in reverse registration order, then marks the component unloaded so a second `unload()` is a no-op. `registerEvent(ref)` pushes `() => ref.detach()`. `registerInterval(id)` pushes `() => clearInterval(id)` and records the cadence by reading it back from the timer registry the globals installer keeps (Task 11a owns `window.setInterval`; plugin-facing timers deliberately use the real globals, per Global Constraints).

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- shim-plugin
```

Expected: four cases pass.

- [ ] **Step 5: Write the failing harvest test**

Create `host/packages/host/test/harvest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("Harvest", () => {
  it("records commands with fully qualified ids and their callback kind", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.addCommand({ id: "plain", name: "Plain", icon: "star", callback: () => {} });
        this.addCommand({ id: "checked", name: "Checked", checkCallback: () => true });
        this.addCommand({ id: "edit", name: "Edit", editorCallback: () => {} });
      }
    });
    await harness.load(plugin);
    expect(harness.harvest.commands()).toEqual([
      { pluginId: "demo", id: "demo:plain", localId: "plain", name: "Plain", icon: "star", kind: "callback", hotkeys: [] },
      { pluginId: "demo", id: "demo:checked", localId: "checked", name: "Checked", icon: null, kind: "checkCallback", hotkeys: [] },
      { pluginId: "demo", id: "demo:edit", localId: "edit", name: "Edit", icon: null, kind: "editorCallback", hotkeys: [] },
    ]);
  });

  it("harvests a real file-menu hook into invokable items", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "x\n" });
    const chosen: string[] = [];
    const plugin = harness.instantiate("menus", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
          (menu as { addItem(cb: (item: unknown) => void): void }).addItem((item) => {
            const typed = item as { setTitle(t: string): unknown; setIcon(i: string): unknown; onClick(cb: () => void): unknown };
            typed.setTitle(`Do it to ${(file as { path: string }).path}`);
            typed.setIcon("wand");
            typed.onClick(() => chosen.push("clicked"));
          });
        }));
      }
    });
    await harness.load(plugin);
    const items = await harness.listMenuItems("file-menu", "A.md");
    expect(items).toEqual([{
      hookId: "menus:file-menu:0", pluginId: "menus", id: "menus:file-menu:0:0",
      title: "Do it to A.md", icon: "wand", section: null, checked: null,
    }]);
    await harness.invokeMenuItem("menus:file-menu:0:0", "A.md");
    expect(chosen).toEqual(["clicked"]);
  });

  it("harvests a protocol handler and invokes it with its params", async () => {
    const harness = await ShimHarness.withVault({});
    const received: Array<Record<string, string>> = [];
    const plugin = harness.instantiate("proto", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.registerObsidianProtocolHandler("run", (params) => { received.push(params); });
      }
    });
    await harness.load(plugin);
    expect(harness.harvest.protocolHandlers()).toEqual([{ pluginId: "proto", action: "run" }]);
    await harness.invokeProtocol("run", { choice: "Daily", value: "x" });
    expect(received).toEqual([{ action: "run", choice: "Daily", value: "x" }]);
  });

  it("forgets a quarantined plugin's whole harvest", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.addCommand({ id: "a", name: "A", callback: () => {} });
        this.registerObsidianProtocolHandler("go", () => {});
      }
    });
    await harness.load(plugin);
    expect(harness.harvest.commands()).toHaveLength(1);
    harness.harvest.forgetPlugin("demo");
    expect(harness.harvest.commands()).toEqual([]);
    expect(harness.harvest.protocolHandlers()).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it and observe the failure**

```bash
npm --prefix host test -- harvest
```

Expected: cannot resolve `../src/shim/harvest`.

- [ ] **Step 7: Implement the harvest and the menu round trip**

Create `harvest.ts` and the `Menu`/`MenuItem` classes in `events.ts`. `listMenuItems(context, path)` constructs a fresh recording `Menu`, triggers the workspace event with `(menu, file, source)` exactly as Obsidian does, and reads the items the handlers added. `invokeMenuItem(id, path)` repeats the construction — menus are rebuilt per invocation because a plugin's item text and `onClick` closure depend on the file — then calls the matching item's stored `onClick`. Rebuilding is the only correct choice: caching the closure from a previous listing would fire a handler bound to a stale file.

`registerObsidianProtocolHandler` stores the callback and the harvest entry; `invokeProtocol(action, params)` calls it with `{ action, ...params }`, which is the shape Obsidian passes.

- [ ] **Step 8: Run and observe it pass**

```bash
npm --prefix host test -- harvest
npm --prefix host test -- shim-plugin
```

Expected: eight cases pass.

- [ ] **Step 9: Commit**

```bash
git add host/packages/host/src/shim/plugin.ts host/packages/host/src/shim/harvest.ts host/packages/host/src/shim/events.ts host/packages/host/test
git commit -m "feat(host): harvest plugin registrations as invokable capabilities"
```

---

### Task 11a: Shim — Workspace, DOM stubs, and the global surface

Task 11 in v1 did two unrelated jobs in one commit: build the workspace and DOM stubs (behavior, with tests) and assemble a ninety-symbol export barrel (a policy decision per symbol, with no test at all). Splitting them means the barrel gets the completeness test it needs and the stubs get reviewed on their own.

**Files:**

- Create: `host/packages/host/src/shim/workspace.ts`
- Create: `host/packages/host/src/shim/dom.ts`
- Create: `host/packages/host/src/shim/globals.ts`
- Create: `host/packages/host/test/shim-workspace.test.ts`
- Create: `host/packages/host/test/shim-dom.test.ts`

**Interfaces:**

- Produces (`workspace.ts`):

```ts
export class Workspace extends Events {
  layoutReady: boolean;
  onLayoutReady(cb: () => unknown): void;
  getActiveFile(): TFile | null;
  /** HOST-ONLY. Not in obsidian.d.ts; the command dispatcher sets it so an
   *  editorCallback has an active file. Never reachable from a plugin. */
  setActiveFile(file: TFile | null): void;
  getActiveViewOfType<T>(ctor: unknown): T | null;   // always null
  getLeaf(newLeaf?: boolean | string): WorkspaceLeaf;
  getLeavesOfType(type: string): WorkspaceLeaf[];    // always []
  iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void;  // no leaves, no calls
  /** HOST-ONLY, same as setActiveFile: `getActiveFileView` is NOT in
   *  obsidian.d.ts. It stays because folder-notes reaches for a view of the
   *  active file through an undocumented path, and returning `null` is the
   *  honest answer; it is marked host-only so nobody later mistakes it for a
   *  documented surface the shim owes parity on. */
  getActiveFileView(): null;
  getLastOpenFiles(): string[];
  registerHoverLinkSource(id: string, info: unknown): void;
  on(name: string, cb: (...args: unknown[]) => unknown): EventRef;
  off(name: string, cb: unknown): void;
  offref(ref: EventRef): void;
  trigger(name: string, ...args: unknown[]): void;
}
export class WorkspaceLeaf {
  view: unknown;
  openFile(file: TFile, state?: unknown): Promise<void>;   // records intent, opens nothing
  setViewState(state: unknown): Promise<void>;
  detach(): void;
  getViewState(): unknown;
}
```

`getLeavesOfType` returning `[]` is a load-bearing safe stub, not laziness: folder-notes' `getFileExplorer` early-returns `void 0` on an empty list, and its CSS features then self-disable cleanly. `iterateAllLeaves` calling the callback zero times is what makes folder-notes' `TabManager.updateTabs()` a no-op instead of a crash. Both behaviors are pinned by tests below, because "return an empty array, never undefined" is the rule the research found breaks plugins when violated.

- Produces (`globals.ts`) — installed once at host start, before any bundle loads:

```ts
export interface GlobalInstallation { restore(): void }
export function installGlobals(app: App, config: HostConfig): GlobalInstallation;
```

It installs, on `globalThis`: `window` (an alias for `globalThis` carrying `setInterval`/`setTimeout`/`clearInterval`/`clearTimeout`/`require`/`moment`/`app`), `activeWindow`, `document`, `activeDocument`, `navigator` (`{ userAgent, platform, clipboard }`), `localStorage` (a `Map`-backed implementation persisted to the host data dir), `i18next` (`{ t: (key) => key, language: "en" }`), `MutationObserver` (an inert class whose `observe`/`disconnect` are no-ops), `HTMLElement`, `Element`, `Node`, `DocumentFragment`, `createDiv`/`createEl`/`createSpan`/`createFragment`, and the Obsidian prototype extensions `Array.prototype.first/last/contains/remove/unique`, `String.prototype.contains`, `Node.prototype.detach/empty/setText/createEl/createDiv/createSpan/addClass/removeClass/toggleClass/setAttr/appendText`. `window.app` is load-bearing — rollover-daily-todos' vendored `obsidian-daily-notes-interface` reaches `window.app`, not `this.app`, at 24 sites, and reads `window.moment` at 15.

- [ ] **Step 1: Write the failing workspace test**

Create `host/packages/host/test/shim-workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("Workspace", () => {
  it("queues onLayoutReady callbacks before ready and runs them in order", async () => {
    const harness = await ShimHarness.withVault({}, { layoutReady: false });
    const order: string[] = [];
    harness.app.workspace.onLayoutReady(() => order.push("first"));
    harness.app.workspace.onLayoutReady(() => order.push("second"));
    expect(harness.app.workspace.layoutReady).toBe(false);
    expect(order).toEqual([]);
    await harness.flipLayoutReady();
    expect(harness.app.workspace.layoutReady).toBe(true);
    expect(order).toEqual(["first", "second"]);
  });

  it("runs a callback immediately once layout is ready", async () => {
    const harness = await ShimHarness.withVault({}, { layoutReady: false });
    await harness.flipLayoutReady();
    const order: string[] = [];
    harness.app.workspace.onLayoutReady(() => order.push("late"));
    expect(order).toEqual(["late"]);
  });

  it("returns empty leaf collections and iterates nothing", async () => {
    const harness = await ShimHarness.withVault({});
    const workspace = harness.app.workspace;
    expect(workspace.getLeavesOfType("file-explorer")).toEqual([]);
    expect(workspace.getLeavesOfType("markdown")).toEqual([]);
    expect(workspace.getLeavesOfType("tag")).toEqual([]);
    expect(workspace.getActiveViewOfType(harness.api.MarkdownView)).toBeNull();
    expect(workspace.getActiveFileView()).toBeNull();
    let calls = 0;
    workspace.iterateAllLeaves(() => { calls += 1; });
    expect(calls).toBe(0);
  });

  it("survives folder-notes' TabManager shape without throwing", async () => {
    const harness = await ShimHarness.withVault({ "Folder/Folder.md": "x\n" });
    const tabManager = {
      app: harness.app,
      updateTabs(): void {
        this.app.workspace.iterateAllLeaves((leaf: { view?: unknown }) => {
          if (!(leaf.view instanceof harness.api.EditableFileView)) return;
          throw new Error("unreachable: there are no leaves headless");
        });
      },
    };
    expect(() => tabManager.updateTabs()).not.toThrow();
  });

  it("records an openFile intent on the inert leaf instead of opening anything", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "x\n" });
    const leaf = harness.app.workspace.getLeaf(false);
    await leaf.openFile(harness.vault.getFileByPath("A.md")!);
    expect(harness.openFileIntents()).toEqual(["A.md"]);
  });
});
```

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- shim-workspace
```

Expected: cannot resolve `../src/shim/workspace`.

- [ ] **Step 3: Implement Workspace and the inert leaf**

Create `workspace.ts` with an `Events` base carrying `on`/`off`/`offref`/`trigger` and a `layoutReadyCallbacks: Array<() => unknown>` that `onLayoutReady` either queues or, once `layoutReady` is true, invokes synchronously — which is real Obsidian's documented late-enable behavior and the thing Ruling 6 depends on.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- shim-workspace
```

Expected: five cases pass.

- [ ] **Step 5: Write the failing DOM-stub test**

Create `host/packages/host/test/shim-dom.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("DOM stubs", () => {
  it("swallows the whole createEl chain a settings tab builds", async () => {
    const harness = await ShimHarness.withVault({});
    const root = harness.api.createDiv({ cls: "panel" });
    const heading = root.createEl("h2", { text: "Title" });
    heading.addClass("big").setAttr("data-x", "1");
    const child = root.createDiv().createSpan({ text: "inner" });
    child.empty();
    root.detach();
    expect(typeof root.createEl).toBe("function");
    expect(root.querySelector("h2")).toBeNull();
    expect(root.querySelectorAll("h2")).toEqual([]);
    expect(root.children).toEqual([]);
  });

  it("installs the Obsidian prototype extensions plugins rely on", async () => {
    await ShimHarness.withVault({});
    expect([1, 2, 3].first()).toBe(1);
    expect([1, 2, 3].last()).toBe(3);
    expect([].first()).toBeUndefined();
    expect([1, 2].contains(2)).toBe(true);
    expect("abc".contains("b")).toBe(true);
  });

  it("exposes window.app and window.moment for the vendored daily-notes interface", async () => {
    const harness = await ShimHarness.withVault({});
    const globalWindow = globalThis as unknown as { app: unknown; moment: unknown };
    expect(globalWindow.app).toBe(harness.app);
    expect(typeof globalWindow.moment).toBe("function");
    expect((globalWindow.moment as () => { format(f: string): string })().format("YYYY")).toMatch(/^\d{4}$/);
  });

  it("provides an inert MutationObserver and i18next", async () => {
    await ShimHarness.withVault({});
    const g = globalThis as unknown as {
      MutationObserver: new (cb: () => void) => { observe(t: unknown, o: unknown): void; disconnect(): void };
      i18next: { t(key: string): string };
    };
    const observer = new g.MutationObserver(() => { throw new Error("must never fire"); });
    expect(() => observer.observe({}, { subtree: true })).not.toThrow();
    expect(() => observer.disconnect()).not.toThrow();
    expect(g.i18next.t("plugins.folder-notes.label")).toBe("plugins.folder-notes.label");
  });

  it("records a safe_stub hit per symbol per plugin, once", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.addRibbonIcon("star", "Go", () => {});
        harness.api.setIcon(harness.api.createDiv(), "star");
        harness.api.setIcon(harness.api.createDiv(), "star");
      }
    });
    await harness.load(plugin);
    const stubs = harness.policyRecorder.entries().filter((e) => e.policy === "safe_stub" && e.pluginId === "demo");
    const setIcon = stubs.find((e) => e.symbol === "setIcon");
    expect(setIcon?.hits).toBe(2);
    expect(stubs.filter((e) => e.symbol === "setIcon")).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run it and observe the failure**

```bash
npm --prefix host test -- shim-dom
```

Expected: cannot resolve `../src/shim/dom`.

- [ ] **Step 7: Implement the DOM stubs**

Create `dom.ts` with one hand-rolled `StubEl` class — no jsdom, because jsdom is a large dependency that would make the host behave *almost* like a browser and hide exactly the cases the compatibility report should surface. Every method returns either `this` or a new `StubEl`, every collection getter returns `[]`, every query returns `null` or `[]`, and `setText`/`textContent` store their value so a harvested menu title can be read back. Register the `safe_stub` policy for the whole family once, and record a hit per call with the current plugin id from `currentPluginId()`.

- [ ] **Step 8: Run and observe it pass**

```bash
npm --prefix host test -- shim-dom
npm --prefix host test -- shim-workspace
```

Expected: ten cases pass.

- [ ] **Step 9: Commit**

```bash
git add host/packages/host/src/shim/workspace.ts host/packages/host/src/shim/dom.ts host/packages/host/src/shim/globals.ts host/packages/host/test/shim-workspace.test.ts host/packages/host/test/shim-dom.test.ts
git commit -m "feat(host): stub the workspace, DOM, and global surface without a browser"
```

---

### Task 11b: Shim — the `obsidian` barrel and the policy table

This is the module `require("obsidian")` actually resolves to, and it is the place where "every symbol carries exactly one of four policies" stops being a principle and becomes a table someone has to fill in. v1 listed ninety-odd names in prose and tested none of them, which is precisely how a symbol ends up exported as `undefined` and a plugin dies three frames deeper with `x is not a function`.

**Files:**

- Create: `host/packages/host/src/shim/notice.ts`
- Create: `host/packages/host/src/shim/components.ts`
- Create: `host/packages/host/src/shim/search.ts`
- Create: `host/packages/host/src/shim/api.ts`
- Create: `host/packages/host/test/api-policy.test.ts`
- Create: `host/packages/host/test/api-symbols.test.ts`

**Interfaces:**

- Produces (`notice.ts`) — **and the notice log always records, dry-run or not.** v1 recorded notices only through the dry-run gate, which meant `host.invoke_command`'s `notices` field was empty in normal operation — the one mode anybody actually runs. The log is unconditional; dry-run's recorder becomes a *view* over it:

```ts
export interface NoticeEntry {
  readonly pluginId: string | null;
  readonly message: string;
  readonly atUnixMs: number;
  readonly timeoutMs: number | null;
}
export class NoticeLog {
  constructor(clock: Clock, limit?: number);   // ring buffer, default 1000
  record(message: string, timeoutMs: number | null): NoticeEntry;
  entries(): readonly NoticeEntry[];
  /** Everything recorded since `mark()`, used to fill an invoke response. */
  mark(): number;
  since(mark: number): readonly NoticeEntry[];
  clear(): void;
}
export class Notice {
  constructor(message: string | DocumentFragment, timeout?: number);
  setMessage(message: string | DocumentFragment): this;
  hide(): void;
  readonly noticeEl: StubEl;
  readonly messageEl: StubEl;
}
```

`new Notice(...)` calls `noticeLog.record(text, timeout)` with `currentPluginId()` from the dispatch queue and returns an object whose `hide()` is a no-op. `host.invoke_command` takes a `mark()` before dispatch and reports `since(mark)` in its response, so a client sees exactly the notices that command produced — in every mode. `DryRunGate.notices()` returns `noticeLog.entries()` filtered to the dry-run window; it owns no second log.

- Produces (`components.ts`) — `PluginSettingTab`, `Setting`, and the ten `*Component` classes, all built on the `StubEl` chain from 11a. Every method returns `this` and stores what it was given, so a settings tab's `display()` can be executed without a DOM if a later per-plugin adapter ever wants to — but nothing in this plan executes it (Task 17 explains why).

- Produces (`search.ts`) — `prepareFuzzySearch`, `prepareSimpleSearch`, `fuzzySearch`, `sortSearchResults`, `renderResults`. These are `implemented`, not stubbed: `FuzzySuggestModal` brokering (Task 18) needs a real fuzzy match to order its items, and quickadd calls `prepareFuzzySearch` directly. A simple subsequence scorer with a contiguity bonus is enough — Obsidian's exact ranking is not a contract anything in the corpus depends on, and the README says so.

- Produces (`api.ts`) — the barrel. **Every exported name appears in exactly one of four policy groups, and the groups are data, not prose:**

```ts
export const API_POLICY: Readonly<Record<string, ApiPolicy>> = {
  // ---- implemented: real behavior ----
  Plugin: "implemented", Component: "implemented", Events: "implemented",
  TFile: "implemented", TFolder: "implemented", TAbstractFile: "implemented",
  Vault: "implemented", DataAdapter: "implemented", MetadataCache: "implemented",
  FileManager: "implemented", Workspace: "implemented", Editor: "implemented",
  Notice: "implemented", Menu: "implemented", MenuItem: "implemented",
  SuggestModal: "implemented", FuzzySuggestModal: "implemented",
  Platform: "implemented", moment: "implemented",
  normalizePath: "implemented", parseYaml: "implemented", stringifyYaml: "implemented",
  parseFrontMatterAliases: "implemented", parseFrontMatterTags: "implemented",
  parseFrontMatterEntry: "implemented", parseFrontMatterStringArray: "implemented",
  getFrontMatterInfo: "implemented", getAllTags: "implemented",
  getLinkpath: "implemented", resolveSubpath: "implemented",
  requestUrl: "implemented", request: "implemented",
  requireApiVersion: "implemented", apiVersion: "implemented",
  debounce: "implemented", prepareFuzzySearch: "implemented",
  prepareSimpleSearch: "implemented", fuzzySearch: "implemented",
  sortSearchResults: "implemented", hexToRgb: "implemented", rgbToHex: "implemented",

  // ---- harvested: recorded as a capability, never rendered ----
  PluginSettingTab: "harvested", Setting: "harvested",

  // ---- safe_stub: inert value or no-op, recorded once per plugin+symbol ----
  WorkspaceLeaf: "safe_stub", View: "safe_stub", ItemView: "safe_stub",
  FileView: "safe_stub", EditableFileView: "safe_stub", MarkdownView: "safe_stub",
  FileSystemAdapter: "safe_stub", MarkdownRenderChild: "safe_stub",
  Scope: "safe_stub", Keymap: "safe_stub", EditorSuggest: "safe_stub",
  AbstractInputSuggest: "safe_stub", Modal: "safe_stub",
  ButtonComponent: "safe_stub", TextComponent: "safe_stub",
  TextAreaComponent: "safe_stub", DropdownComponent: "safe_stub",
  ToggleComponent: "safe_stub", SliderComponent: "safe_stub",
  ExtraButtonComponent: "safe_stub", SearchComponent: "safe_stub",
  ColorComponent: "safe_stub", SecretComponent: "safe_stub",
  setIcon: "safe_stub", addIcon: "safe_stub", setTooltip: "safe_stub",
  getIcon: "safe_stub", getIconIds: "safe_stub", renderResults: "safe_stub",
  sanitizeHTMLToDom: "safe_stub",

  // ---- absent: throws typed HeadlessUnsupported ----
  MarkdownRenderer: "absent", htmlToMarkdown: "absent",
  renderMath: "absent", finishRenderMath: "absent",
  loadMathJax: "absent", loadPrism: "absent", loadMermaid: "absent",
};
```

Three of those placements carry a reason worth stating, because a reviewer will ask.

`Modal` is **`safe_stub`, not `absent`**: constructing one and building its `contentEl` must succeed (that is ordinary `onload`-time work), and only `open()` throws. Putting `Modal` in the absent group would kill a plugin at construction, before the half that works ever runs. Task 18 owns `Modal.open`'s throw.

`EditableFileView` and `FileSystemAdapter` are `safe_stub` and exist as **real constructors** that are never instantiated. folder-notes does `leaf.view instanceof EditableFileView` and quickadd does `adapter instanceof FileSystemAdapter`; both need the constructor to exist and both need the test to be **false** — a `true` from `FileSystemAdapter` sends quickadd down a `getBasePath()`-then-`fs` path that would put bytes in the vault behind the daemon.

`MarkdownRenderer` and the four `load*` helpers are `absent` rather than stubbed because a plugin that renders markdown to a DOM node and then reads the result back gets a wrong answer from a stub and a diagnosable error from a throw. They are the clearest "this genuinely does not exist headless" cases in the corpus.

```ts
/** The barrel's own type, so the harness and `assembleShim` share one shape. */
export interface ObsidianApi { readonly [symbol: string]: unknown }
export function createObsidianApi(assembly: HostAssembly): ObsidianApi;
```

`createObsidianApi` walks `API_POLICY` and, for each name, exports the real class or function for `implemented`/`harvested`, a table-driven stub for `safe_stub`, and for `absent` a function that calls `unsupported(name)`. **Nothing is exported that is not in the table**, and nothing in the table is missing an export — which is what the next test proves.

- [ ] **Step 1: Write the failing policy-completeness test**

Create `host/packages/host/test/api-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { API_POLICY, createObsidianApi } from "../src/shim/api";
import { HeadlessUnsupported, declaredSymbols, policyOf } from "../src/shim/policy";
import { ShimHarness } from "../src/testing/shim-harness";

describe("the four-way API policy table", () => {
  it("exports exactly the symbols the table declares — no more, no fewer", async () => {
    const harness = await ShimHarness.withVault({});
    const exported = Object.keys(harness.api).sort();
    const declared = Object.keys(API_POLICY).sort();
    // Either direction is a bug: an export with no policy is an undeclared
    // surface, and a policy with no export is a symbol that resolves to
    // `undefined` at require time.
    expect(exported).toEqual(declared);
  });

  it("registers every table entry with the policy recorder", () => {
    for (const [symbol, policy] of Object.entries(API_POLICY)) {
      expect(policyOf(symbol), symbol).toBe(policy);
    }
    expect(declaredSymbols().sort()).toEqual(Object.keys(API_POLICY).sort());
  });

  it("resolves every symbol to a value whose shape matches its category", async () => {
    const harness = await ShimHarness.withVault({});
    for (const [symbol, policy] of Object.entries(API_POLICY)) {
      const value = (harness.api as Record<string, unknown>)[symbol];
      expect(value, `${symbol} (${policy})`).toBeDefined();
      // Nothing may be `undefined`, ever. That is the whole failure mode this
      // task exists to prevent: a plugin destructuring `undefined` off the
      // barrel dies with a message that names neither the symbol nor the host.
      expect(value, `${symbol} (${policy})`).not.toBeNull();
      if (policy === "absent") {
        expect(typeof value, symbol).toBe("function");
        expect(() => (value as () => void)(), symbol).toThrow(HeadlessUnsupported);
      } else {
        expect(["function", "object", "string"], symbol).toContain(typeof value);
      }
    }
  });

  it("names the symbol in the error an absent entry throws", async () => {
    const harness = await ShimHarness.withVault({});
    for (const symbol of Object.keys(API_POLICY).filter((s) => API_POLICY[s] === "absent")) {
      try {
        ((harness.api as Record<string, unknown>)[symbol] as () => void)();
        expect.unreachable(`${symbol} did not throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(HeadlessUnsupported);
        expect((error as HeadlessUnsupported).symbol).toBe(symbol);
        expect((error as HeadlessUnsupported).message).toContain(symbol);
      }
    }
  });

  it("records one safe_stub entry per plugin+symbol, counting every hit", async () => {
    const harness = await ShimHarness.withVault({});
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        harness.api.setIcon(harness.api.createDiv(), "star");
        harness.api.setIcon(harness.api.createDiv(), "star");
        harness.api.addIcon("custom", "<svg/>");
      }
    });
    await harness.load(plugin);
    const stubs = harness.policyRecorder.entries()
      .filter((e) => e.policy === "safe_stub" && e.pluginId === "demo");
    expect(stubs.filter((e) => e.symbol === "setIcon")).toHaveLength(1);
    expect(stubs.find((e) => e.symbol === "setIcon")?.hits).toBe(2);
    expect(stubs.find((e) => e.symbol === "addIcon")?.hits).toBe(1);
  });
});
```

- [ ] **Step 2: Write the failing behavior test for the nontrivial symbols**

The completeness test proves every symbol resolves; it does not prove the implemented ones work. Create `host/packages/host/test/api-symbols.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("implemented barrel symbols", () => {
  it("normalizePath collapses separators the way Obsidian does", async () => {
    const harness = await ShimHarness.withVault({});
    expect(harness.api.normalizePath("Folder//Note.md")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("/Folder/Note.md")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("./Folder/Note.md")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("Folder/Note.md/")).toBe("Folder/Note.md");
    expect(harness.api.normalizePath("")).toBe("/");
  });

  it("round-trips YAML without reordering or reformatting untouched keys", async () => {
    const harness = await ShimHarness.withVault({});
    const parsed = harness.api.parseYaml("b: 2\na: 1\nlist:\n  - x\n  - y\n");
    expect(parsed).toEqual({ b: 2, a: 1, list: ["x", "y"] });
    expect(harness.api.stringifyYaml(parsed)).toBe("b: 2\na: 1\nlist:\n  - x\n  - y\n");
  });

  it("parses frontmatter helpers off a real cache", async () => {
    const harness = await ShimHarness.withVault({
      "A.md": "---\naliases: [Ay, Bee]\ntags: [alpha, beta]\n---\n#gamma\n",
    });
    const cache = harness.app.metadataCache.getCache("A.md")!;
    expect(harness.api.parseFrontMatterAliases(cache.frontmatter)).toEqual(["Ay", "Bee"]);
    expect(harness.api.parseFrontMatterTags(cache.frontmatter)).toEqual(["#alpha", "#beta"]);
    expect(harness.api.getAllTags(cache)?.sort()).toEqual(["#alpha", "#beta", "#gamma"]);
  });

  it("getFrontMatterInfo reports the frontmatter span of a real note", async () => {
    const harness = await ShimHarness.withVault({});
    const info = harness.api.getFrontMatterInfo("---\na: 1\n---\nbody\n");
    expect(info).toMatchObject({ exists: true, frontmatter: "a: 1\n" });
    expect(harness.api.getFrontMatterInfo("body\n")).toMatchObject({ exists: false });
  });

  it("records a Notice outside dry-run and reports it since a mark", async () => {
    const harness = await ShimHarness.withVault({});
    const mark = harness.noticeLog.mark();
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> { new harness.api.Notice("hello"); }
    });
    await harness.load(plugin);
    // Not a dry run. The log records anyway — this is the field
    // host.invoke_command's `notices` reads from.
    expect(harness.noticeLog.since(mark)).toEqual([
      { pluginId: "demo", message: "hello", atUnixMs: expect.any(Number), timeoutMs: null },
    ]);
  });

  it("reports Platform as desktop and apiVersion as the configured version", async () => {
    const harness = await ShimHarness.withVault({}, { config: { appVersion: "1.9.14" } });
    expect(harness.api.Platform).toMatchObject({
      isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false,
    });
    expect(harness.api.apiVersion).toBe("1.9.14");
    expect(harness.api.requireApiVersion("1.5.0")).toBe(true);
    expect(harness.api.requireApiVersion("99.0.0")).toBe(false);
  });

  it("keeps EditableFileView and FileSystemAdapter constructible and never instanced", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "x\n" });
    expect(typeof harness.api.EditableFileView).toBe("function");
    expect(typeof harness.api.FileSystemAdapter).toBe("function");
    // folder-notes' and quickadd's actual tests, both of which must be false.
    expect(harness.app.workspace.getLeaf(false).view)
      .not.toBeInstanceOf(harness.api.EditableFileView);
    expect(harness.app.vault.adapter).not.toBeInstanceOf(harness.api.FileSystemAdapter);
  });

  it("orders fuzzy matches well enough for a brokered picker", async () => {
    const harness = await ShimHarness.withVault({});
    const scorer = harness.api.prepareFuzzySearch("dly");
    expect(scorer("Daily note")).not.toBeNull();
    expect(scorer("Weekly review")).toBeNull();
    const items = ["Weekly note", "Daily note", "Deadly nightshade"];
    const scored = items
      .map((text) => ({ text, match: scorer(text) }))
      .filter((entry) => entry.match !== null);
    harness.api.sortSearchResults(scored);
    expect(scored[0]?.text).toBe("Daily note");
  });
});
```

- [ ] **Step 3: Run both and observe the failures**

```bash
npm --prefix host test -- api-policy
npm --prefix host test -- api-symbols
```

Expected: cannot resolve `../src/shim/api`.

- [ ] **Step 4: Implement `notice.ts`, `components.ts`, and `search.ts`**

The three modules the barrel needs and nothing else owns. `NoticeLog` is a ring buffer over `config.clock`; `components.ts` is thirteen small classes over `StubEl`; `search.ts` is one subsequence scorer plus a comparator.

- [ ] **Step 5: Implement `api.ts` as a table walk, not a hand-written export list**

`createObsidianApi` iterates `API_POLICY`. `implemented` and `harvested` names index a `REAL` record of the actual bindings; `safe_stub` names index a `STUBS` record of inert values (a class, `() => undefined`, or a constant); `absent` names get `() => unsupported(name)` generated in the loop. `declarePolicy(name, policy)` is called for every entry as it is built, which is what makes the second test's `policyOf` assertion true by construction. A name in the table with no entry in `REAL` or `STUBS` throws **at assembly time**, not at plugin-load time — a missing binding is a host bug and should stop the host, not one plugin.

- [ ] **Step 6: Run both and observe them pass**

```bash
npm --prefix host test -- api-policy
npm --prefix host test -- api-symbols
```

Expected: five policy cases and eight symbol cases pass. The first policy case is the one that will fail whenever someone adds an export without a policy or a policy without an export, which is exactly the drift this task exists to catch.

- [ ] **Step 7: Commit**

```bash
git add host/packages/host/src/shim/notice.ts host/packages/host/src/shim/components.ts host/packages/host/src/shim/search.ts host/packages/host/src/shim/api.ts host/packages/host/test/api-policy.test.ts host/packages/host/test/api-symbols.test.ts
git commit -m "feat(host): export the obsidian barrel with a tested four-way policy table"
```

---

### Task 12: Shim — app.plugins, app.internalPlugins, app.commands, and the Editor

**Files:**

- Create: `host/packages/host/src/shim/plugin-registry.ts`
- Create: `host/packages/host/src/shim/internal-plugins.ts`
- Create: `host/packages/host/src/shim/commands.ts`
- Create: `host/packages/host/src/shim/editor.ts`
- Create: `host/packages/host/src/shim/keymap.ts`
- Modify: `host/packages/host/src/shim/app.ts` (the skeleton from Task 6b; this task fills its registry fields)
- Create: `host/packages/host/test/shim-cross-plugin.test.ts`
- Create: `host/packages/host/test/shim-internal-plugins.test.ts`
- Create: `host/packages/host/test/shim-editor.test.ts`
- Create: `host/packages/host/test/config-refresh.test.ts`

**Interfaces:**

- Produces (`plugin-registry.ts`) — the surface v1 of the design omitted and rollover-daily-todos would have died on:

```ts
export class PluginRegistry {
  readonly plugins: Record<string, Plugin>;
  readonly manifests: Record<string, PluginManifest>;
  readonly enabledPlugins: Set<string>;
  getPlugin(id: string): Plugin | null;
  enablePlugin(id: string): Promise<void>;
  disablePlugin(id: string): Promise<void>;
  isEnabled(id: string): boolean;
}
```

`getPlugin` returns `null` for an id that is not loaded, exactly as real Obsidian does for a plugin that is not installed or not yet loaded in manifest order. Plugins already defend against that (folder-notes' `obsidian-front-matter-title-plugin` lookup, rollover's `periodic-notes` lookup, quickadd's `templater` lookup), so no load-order computation is needed and none is done.

- Produces (`internal-plugins.ts`) — both access shapes, because the corpus uses both:

```ts
export interface InternalPluginEntry {
  readonly id: string;
  readonly enabled: boolean;
  readonly instance: unknown | null;
}
export class InternalPluginRegistry {
  readonly plugins: Record<string, InternalPluginEntry>;
  getPluginById(id: string): InternalPluginEntry | null;
  getEnabledPluginById(id: string): unknown | null;
  refresh(): Promise<void>;   // on startup and on config_changed
}
export interface DailyNotesInstance { options: { folder: string; format: string; template: string } }
export interface BookmarksInstance {
  items: BookmarkItem[];
  getBookmarks(): BookmarkItem[];
  getItemTitle(item: BookmarkItem): string;
}
export interface BookmarkItem {
  type: "file" | "folder" | "search" | "graph" | "group" | "url" | (string & {});
  title?: string; path?: string; subpath?: string; query?: string; url?: string;
  ctime?: number; items?: BookmarkItem[];
}
```

Per Ruling 4: `daily-notes` and `bookmarks` are reimplemented as config readers; `file-explorer`, `global-search`, `bases`, `file-recovery`, `properties`, and `workspaces` are reported present-but-absent (`instance: null`) so the consuming plugins take their already-existing degraded branch. Every other core plugin id — `templates` included — falls to the same default: an entry whose `enabled` is the real value from `core-plugins.json` and whose `instance` is `null`.

**Config file resolution, pinned once here and used by every reader in the host:** a config file is read from `<hostConfigDir>/<name>` first and from `.obsidian/<name>` as the fallback. So a fresh headless config dir inherits the user's real `daily-notes.json`, `app.json`, `bookmarks.json`, and `core-plugins.json` — which is what makes rollover-daily-todos work on day one — while an explicit headless override wins when someone writes one. Both reads go through `read_file`; the host never opens either file itself.

- Produces (`commands.ts`) — needed because two of six golden plugins **monkeypatch** it:

```ts
export interface Command {
  id: string; name: string; icon?: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: Editor, view: unknown) => unknown;
  editorCheckCallback?: (checking: boolean, editor: Editor, view: unknown) => boolean | void;
  hotkeys?: Array<{ modifiers: string[]; key: string }>;
}
export class CommandRegistry {
  readonly commands: Record<string, Command>;   // mutable by design
  addCommand(command: Command): Command;
  removeCommand(id: string): void;
  findCommand(id: string): Command | undefined;
  listCommands(): Command[];
  executeCommandById(id: string): boolean;
}
```

`commands` is seeded with a real `editor:save-file` entry whose `checkCallback(checking)` returns `true` and does nothing else. obsidian-linter and automatic-linker both replace that entry's `checkCallback` at load and call the original from inside their replacement; a missing entry makes both patches silently no-op, and a throwing entry breaks their save path. Seeding it is the whole fix.

`CommandRegistry.addCommand` is the **one** command map. `Plugin.addCommand` (Task 10) delegates here after namespacing the id; nothing keeps a second list. `executeCommandById(id)` runs the command through the `DispatchQueue` and returns `false` for an unknown id or a `checkCallback` that returns falsy.

- Produces (`editor.ts`) — the design named "a minimal `Editor` for `editorCallback`" and v1 defined neither the class nor how one gets constructed. Both are here, because `host.invoke_command` on an `editorCallback` command has to hand the plugin *something* and that something has to be able to write back:

```ts
export interface EditorPosition { line: number; ch: number }
export interface EditorRange { from: EditorPosition; to: EditorPosition }

/**
 * A text buffer over one note, with Obsidian's Editor surface. It is
 * constructed per invocation from `get_note`'s source, mutated in memory by
 * the plugin's callback, and flushed once through `write_note` when the
 * callback returns — never per keystroke, because there are no keystrokes.
 */
export class Editor {
  static async open(deps: {
    client: VaultdClient; mirror: Mirror; writes: WriteGate; file: TFile;
    initialSelection?: EditorRange;
  }): Promise<Editor>;

  getValue(): string;
  setValue(text: string): void;
  getLine(line: number): string;
  setLine(line: number, text: string): void;
  lineCount(): number;
  lastLine(): number;
  getCursor(which?: "from" | "to" | "head" | "anchor"): EditorPosition;
  setCursor(pos: EditorPosition | number, ch?: number): void;
  getSelection(): string;
  setSelection(anchor: EditorPosition, head?: EditorPosition): void;
  replaceSelection(replacement: string): void;
  getRange(from: EditorPosition, to: EditorPosition): string;
  replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition): void;
  posToOffset(pos: EditorPosition): number;
  offsetToPos(offset: number): EditorPosition;
  somethingSelected(): boolean;
  wordAt(pos: EditorPosition): EditorRange | null;
  focus(): void;      // safe_stub
  blur(): void;       // safe_stub
  refresh(): void;    // safe_stub

  /** Host-only. True when the buffer differs from what was read. */
  dirty(): boolean;
  /** Host-only. One write_note with the read revision as the precondition. */
  flush(): Promise<void>;
}
```

**The construction path, stated so it is not invented three times.** `host.invoke_command { command_id, active_file }` on a command whose `kind` is `editorCallback` or `editorCheckCallback`: the dispatcher resolves `active_file` to a `TFile` (erroring `not_found` if it does not resolve, and `invalid_request` if the command needs an editor and no `active_file` was given), calls `Editor.open(...)` which issues one `get_note` for the source and the revision, sets `workspace.setActiveFile(file)`, runs the callback through the `DispatchQueue` with `(editor, view)` where `view` is the inert leaf's view, and on return calls `editor.flush()` — which sends `write_note` with `expected: { revision }` from the read and then `mirror.applyMutation`, exactly like every other write in the host — but only when `dirty()`. A callback that reads and does not write costs one `get_note` and no mutation. `setActiveFile(null)` runs in a `finally`.

`Editor` is `implemented` in the policy table, and its line/character positions are computed with the same `PositionIndex` machinery the metadata assembly uses, so `posToOffset` agrees with `CachedMetadata` positions on a note containing astral-plane characters.

- Produces (`keymap.ts`) — four small typed stubs the `App` fields need, each with a one-line policy so none of them is a `{}` someone has to guess about later:

```ts
/** safe_stub. Obsidian's static helpers are pure predicates over a fake event. */
export class Keymap {
  static isModifier(evt: unknown, modifier: string): boolean;   // always false
  static isModEvent(evt: unknown): boolean | string;            // always false
  pushScope(scope: Scope): void;                                 // no-op
  popScope(scope: Scope): void;                                  // no-op
}
/** safe_stub. Registrations are accepted and discarded: there is no keyboard. */
export class Scope {
  constructor(parent?: Scope);
  register(modifiers: string[] | null, key: string | null, fn: unknown): unknown;
  unregister(handler: unknown): void;
}
/** safe_stub. `app.setting` is the settings WINDOW, which headless has none of. */
export class SettingRegistry {
  open(): void;                       // no-op
  close(): void;                      // no-op
  openTabById(id: string): null;      // null, never undefined
  readonly settingTabs: readonly unknown[];   // always []
  readonly pluginTabs: readonly unknown[];    // always []
}
/** safe_stub. Fold state is a UI concept; `null` is Obsidian's own "no info". */
export class FoldManager {
  load(file: TFile): unknown | null;  // always null
  save(file: TFile, info: unknown): void;  // no-op
}
```

- Produces (`app.ts`, filled in) — Task 6b created the container; this task assigns the registry fields:

```ts
export class App {
  readonly vault: Vault;
  readonly metadataCache: MetadataCache;
  readonly fileManager: FileManager;
  readonly workspace: Workspace;
  readonly plugins: PluginRegistry;
  readonly internalPlugins: InternalPluginRegistry;
  readonly commands: CommandRegistry;
  readonly keymap: Keymap;
  readonly scope: Scope;
  readonly setting: SettingRegistry;   // safe_stub
  readonly foldManager: FoldManager;   // safe_stub: load() -> null, save() -> void
  readonly appId: string;
  readonly appVersion: string;         // from HostConfig.appVersion
  readonly lastEvent: null;
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: unknown): void;
}
```

**`App` is produced in Task 6b, not here** — that is the fix for v1's ordering, where `App` appeared in Task 12 but `harness.app` was read from Task 7 onward. The skeleton is a container whose fields `assembleShim()` assigns once, in dependency order; this task supplies four of them.

`foldManager` is a safe stub with `load(file) => null` and `save(file, info) => undefined`. The reason needs stating accurately, because v1 overstated it: rollover-daily-todos calls `window.app.foldManager.load(templateFile)` **inside a `try`/`catch`** that logs and shows a Notice, so a missing `foldManager` does not throw past the plugin — it degrades the daily-note template read into a caught failure and the rollover proceeds without fold info. Stubbing it is still right (a caught error per rollover is noise that would mask real failures), but it is a quality fix, not a crash fix, and the plan should not claim otherwise.

- [ ] **Step 1: Write the failing cross-plugin test**

Create `host/packages/host/test/shim-cross-plugin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("app.plugins and app.commands", () => {
  it("exposes loaded plugins three ways and null for a missing one", async () => {
    const harness = await ShimHarness.withVault({});
    const alpha = harness.instantiate("alpha", class extends harness.api.Plugin {
      api = { hello: () => "from alpha" };
    });
    await harness.load(alpha);
    const plugins = harness.app.plugins;
    expect(plugins.getPlugin("alpha")).toBe(alpha);
    expect(plugins.plugins["alpha"]).toBe(alpha);
    expect(plugins.enabledPlugins.has("alpha")).toBe(true);
    expect(plugins.getPlugin("periodic-notes")).toBeNull();
    expect(plugins.plugins["periodic-notes"]).toBeUndefined();
    expect(plugins.enabledPlugins.has("periodic-notes")).toBe(false);
    const consumer = plugins.getPlugin("alpha") as unknown as { api: { hello(): string } };
    expect(consumer.api.hello()).toBe("from alpha");
  });

  it("seeds editor:save-file so a save monkeypatch installs and calls through", async () => {
    const harness = await ShimHarness.withVault({});
    const calls: string[] = [];
    const plugin = harness.instantiate("linterish", class extends harness.api.Plugin {
      original?: (checking: boolean) => boolean | void;
      override async onload(): Promise<void> {
        const entry = this.app.commands?.commands?.["editor:save-file"];
        this.original = entry?.checkCallback;
        if (entry && typeof this.original === "function") {
          entry.checkCallback = (checking: boolean) => {
            calls.push(`patched:${checking}`);
            return this.original!(checking);
          };
        }
      }
      override onunload(): void {
        const entry = this.app.commands?.commands?.["editor:save-file"];
        if (entry && this.original) entry.checkCallback = this.original;
      }
    });
    await harness.load(plugin);
    const patched = harness.app.commands.commands["editor:save-file"]!;
    expect(patched.checkCallback?.(false)).toBe(true);
    expect(calls).toEqual(["patched:false"]);
    await harness.unload("linterish");
    expect(harness.app.commands.commands["editor:save-file"]?.checkCallback?.(false)).toBe(true);
    expect(calls).toEqual(["patched:false"]);
  });

  it("lists and executes commands through app.commands", async () => {
    const harness = await ShimHarness.withVault({});
    let ran = 0;
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {
      override async onload(): Promise<void> {
        this.addCommand({ id: "go", name: "Go", callback: () => { ran += 1; } });
      }
    });
    await harness.load(plugin);
    expect(harness.app.commands.listCommands().map((c) => c.id)).toContain("demo:go");
    expect(harness.app.commands.executeCommandById("demo:go")).toBe(true);
    expect(harness.app.commands.executeCommandById("demo:missing")).toBe(false);
    expect(ran).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and observe the missing modules**

```bash
npm --prefix host test -- shim-cross-plugin
```

Expected: cannot resolve `../src/shim/plugin-registry`.

- [ ] **Step 3: Implement the registries**

Create `plugin-registry.ts`, `commands.ts`, and `app.ts`. `CommandRegistry.executeCommandById` runs the command through the `DispatchQueue` and returns `false` for an unknown id or a `checkCallback` that returns falsy — matching Obsidian, where a check that fails means the command did not run.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- shim-cross-plugin
```

Expected: three cases pass.

- [ ] **Step 5: Write the failing internal-plugins test**

Create `host/packages/host/test/shim-internal-plugins.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("app.internalPlugins", () => {
  it("serves daily-notes options from the config file and reports its real enabled flag", async () => {
    const harness = await ShimHarness.withVault({}, {
      configFiles: {
        ".obsidian/core-plugins.json": JSON.stringify({ "daily-notes": false, bookmarks: true, "file-explorer": true }),
        ".obsidian/daily-notes.json": JSON.stringify({
          folder: "Journal/Daily", format: "YYYY-MM/YYYY-MM-DD", template: "Templates/Daily.md",
        }),
      },
    });
    const internal = harness.app.internalPlugins;
    const entry = internal.getPluginById("daily-notes");
    expect(entry?.enabled).toBe(false);
    const instance = entry?.instance as { options: { folder: string; format: string; template: string } };
    expect(instance.options).toEqual({
      folder: "Journal/Daily", format: "YYYY-MM/YYYY-MM-DD", template: "Templates/Daily.md",
    });
    expect(internal.plugins["daily-notes"]?.enabled).toBe(false);
    expect(internal.getEnabledPluginById("daily-notes")).toBeNull();
  });

  it("prefers the headless config dir over Obsidian's when both exist", async () => {
    const harness = await ShimHarness.withVault({}, {
      configFiles: {
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "Gui", format: "YYYY", template: "" }),
        ".obsidian-headless/daily-notes.json": JSON.stringify({ folder: "Headless", format: "YYYY-MM-DD", template: "" }),
      },
    });
    const instance = harness.app.internalPlugins.getPluginById("daily-notes")?.instance as {
      options: { folder: string };
    };
    expect(instance.options.folder).toBe("Headless");
  });

  it("serves the bookmarks tree", async () => {
    const harness = await ShimHarness.withVault({}, {
      configFiles: {
        ".obsidian/core-plugins.json": JSON.stringify({ bookmarks: true }),
        ".obsidian/bookmarks.json": JSON.stringify({
          items: [
            { type: "folder", ctime: 1, path: "Inbox" },
            { type: "group", title: "Reading", items: [{ type: "file", ctime: 2, path: "A.md" }] },
          ],
        }),
      },
    });
    const instance = harness.app.internalPlugins.getEnabledPluginById("bookmarks") as {
      items: unknown[]; getBookmarks(): Array<{ type: string }>; getItemTitle(item: unknown): string;
    };
    expect(instance.getBookmarks()).toHaveLength(2);
    expect(instance.getItemTitle({ type: "folder", path: "Inbox" })).toBe("Inbox");
    expect(instance.getItemTitle({ type: "group", title: "Reading" })).toBe("Reading");
  });

  it("reports the six absent core plugins with a null instance", async () => {
    const harness = await ShimHarness.withVault({}, {
      configFiles: {
        ".obsidian/core-plugins.json": JSON.stringify({
          "file-explorer": true, "global-search": true, bases: true,
          "file-recovery": true, properties: true, workspaces: true, templates: true,
        }),
      },
    });
    const internal = harness.app.internalPlugins;
    for (const id of ["file-explorer", "global-search", "bases", "file-recovery", "properties", "workspaces", "templates"]) {
      expect(internal.getPluginById(id)?.instance, id).toBeNull();
      expect(internal.getEnabledPluginById(id), id).toBeNull();
    }
    expect(internal.getPluginById("file-explorer")?.enabled).toBe(true);
  });

  it("lets folder-notes and tag-wrangler degrade instead of throwing", async () => {
    const harness = await ShimHarness.withVault({});
    const explorer = harness.app.internalPlugins.getEnabledPluginById("file-explorer");
    expect(explorer).toBeNull();
    const search = harness.app.internalPlugins.getPluginById("global-search");
    const query = search?.instance as { getGlobalSearchQuery?(): string } | null;
    expect(query && query.getGlobalSearchQuery && query.getGlobalSearchQuery()).toBeFalsy();
    expect(harness.app.workspace.getLeavesOfType("file-explorer")).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it and observe the failure**

```bash
npm --prefix host test -- shim-internal-plugins
```

Expected: cannot resolve `../src/shim/internal-plugins`.

- [ ] **Step 7: Implement the internal-plugin registry**

Create `internal-plugins.ts` with a `readConfigJson(name)` helper implementing the two-step resolution above, a `DailyNotesInstance` built from `{ folder, format, template }` with Obsidian's defaults (`format: "YYYY-MM-DD"`, `folder: ""`, `template: ""`) when a key is missing, a `BookmarksInstance` over `bookmarks.json`'s `items`, and a hard-coded absent list of the six ids.

- [ ] **Step 8: Wire `config_changed` to the registry refresh**

`refresh()` re-reading "on every `config_changed` event" was an assertion with no subscription behind it in v1. The subscription is one line in the constructor, over the fan-out Task 6 added:

```ts
constructor(deps: InternalPluginDeps) {
  // …
  this.unsubscribe = deps.mirror.onConfigChanged(async (path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!InternalPluginRegistry.WATCHED.has(name)) return;
    await this.refresh();
  });
}
private static readonly WATCHED = new Set([
  "core-plugins.json", "daily-notes.json", "bookmarks.json", "app.json",
]);
```

The path filter matters: `config_changed` fires for **every** write into the `.obsidian` zone, including every plugin's own `data.json`, and re-reading four config files on each of those would turn one plugin's `saveData` into four `read_file` round trips. Watching by basename keeps it to the files this registry actually consumes. The `Vault.getConfig` cache (Task 7) subscribes separately and watches only `app.json`.

- [ ] **Step 9: Write the failing config-refresh test**

Create `host/packages/host/test/config-refresh.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ShimHarness } from "../src/testing/shim-harness";

describe("config_changed refreshes the config readers", () => {
  it("invalidates the daily-notes options when daily-notes.json is rewritten", async () => {
    const harness = await ShimHarness.withVault({}, {
      configFiles: {
        ".obsidian/core-plugins.json": JSON.stringify({ "daily-notes": true }),
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "Old", format: "YYYY", template: "" }),
      },
    });
    const internal = harness.app.internalPlugins;
    const before = internal.getPluginById("daily-notes")?.instance as { options: { folder: string } };
    expect(before.options.folder).toBe("Old");

    // The GUI (or another client) writes the file; vaultd notices and emits.
    harness.setConfigFile(".obsidian/daily-notes.json", JSON.stringify({
      folder: "New", format: "YYYY-MM-DD", template: "T.md",
    }));
    await harness.mirror.applyEvent({
      type: "config_changed", value: { path: ".obsidian/daily-notes.json" },
    });

    const after = internal.getPluginById("daily-notes")?.instance as {
      options: { folder: string; format: string; template: string };
    };
    expect(after.options).toEqual({ folder: "New", format: "YYYY-MM-DD", template: "T.md" });
  });

  it("invalidates the getConfig cache when app.json is rewritten", async () => {
    const harness = await ShimHarness.withVault({}, {
      configFiles: { ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Old" }) },
    });
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("Old");
    harness.setConfigFile(".obsidian/app.json", JSON.stringify({ attachmentFolderPath: "New" }));
    await harness.mirror.applyEvent({
      type: "config_changed", value: { path: ".obsidian/app.json" },
    });
    expect(harness.vault.getConfig("attachmentFolderPath")).toBe("New");
  });

  it("ignores a config_changed for a plugin data.json", async () => {
    const harness = await ShimHarness.withVault({}, {
      configFiles: { ".obsidian/daily-notes.json": JSON.stringify({ folder: "Old" }) },
    });
    harness.app.internalPlugins.getPluginById("daily-notes");
    harness.clearMethodLog();
    await harness.mirror.applyEvent({
      type: "config_changed", value: { path: ".obsidian-headless/plugins/demo/data.json" },
    });
    // A plugin saving its own settings must not cost four config re-reads.
    expect(harness.methodsSeen()).toEqual([]);
  });
});
```

- [ ] **Step 10: Write the failing Editor test**

Create `host/packages/host/test/shim-editor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Editor } from "../src/shim/editor";
import { ShimHarness } from "../src/testing/shim-harness";

describe("Editor", () => {
  it("reads a note through get_note and exposes it line by line", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "one\ntwo\nthree\n" });
    const editor = await Editor.open({
      client: harness.client, mirror: harness.mirror,
      writes: harness.writes, file: harness.vault.getFileByPath("A.md")!,
    });
    expect(editor.getValue()).toBe("one\ntwo\nthree\n");
    expect(editor.lineCount()).toBe(4);          // trailing newline yields an empty last line
    expect(editor.lastLine()).toBe(3);
    expect(editor.getLine(1)).toBe("two");
    expect(editor.getCursor()).toEqual({ line: 0, ch: 0 });
    expect(editor.somethingSelected()).toBe(false);
    expect(editor.dirty()).toBe(false);
  });

  it("replaceRange edits the buffer and flush writes it once", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "one\ntwo\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    const editor = await Editor.open({
      client: harness.client, mirror: harness.mirror, writes: harness.writes, file,
    });
    editor.replaceRange("TWO", { line: 1, ch: 0 }, { line: 1, ch: 3 });
    expect(editor.getValue()).toBe("one\nTWO\n");
    expect(editor.dirty()).toBe(true);

    const flushing = editor.flush();
    const sent = await harness.nextRequest();
    expect(sent.request).toEqual({
      method: "write_note",
      params: { path: "A.md", content: "one\nTWO\n", expected: { revision: harness.revisionOf("A.md") } },
    });
    harness.respondOk(sent.id, "write_note", { generation: 3, revision: "blake3:a2" });
    harness.answerRefetch(3, [{ path: "A.md", revision: "blake3:a2" }]);
    await flushing;
    expect(editor.dirty()).toBe(false);
  });

  it("writes nothing when the callback only read", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "one\n" });
    const editor = await Editor.open({
      client: harness.client, mirror: harness.mirror, writes: harness.writes,
      file: harness.vault.getFileByPath("A.md")!,
    });
    void editor.getValue();
    harness.clearMethodLog();
    await editor.flush();
    expect(harness.methodsSeen()).toEqual([]);
  });

  it("agrees with CachedMetadata positions across astral-plane characters", async () => {
    const source = "a\u{1F600}b Link\n";
    const harness = await ShimHarness.withVault({ "A.md": source });
    const editor = await Editor.open({
      client: harness.client, mirror: harness.mirror, writes: harness.writes,
      file: harness.vault.getFileByPath("A.md")!,
    });
    const link = harness.app.metadataCache.getCache("A.md")!.links![0]!;
    expect(editor.offsetToPos(link.position.start.offset)).toEqual({
      line: link.position.start.line, ch: link.position.start.col,
    });
    expect(editor.posToOffset({ line: link.position.start.line, ch: link.position.start.col }))
      .toBe(link.position.start.offset);
  });

  it("round-trips a selection and replaces it", async () => {
    const harness = await ShimHarness.withVault({ "A.md": "hello world\n" });
    const editor = await Editor.open({
      client: harness.client, mirror: harness.mirror, writes: harness.writes,
      file: harness.vault.getFileByPath("A.md")!,
      initialSelection: { from: { line: 0, ch: 6 }, to: { line: 0, ch: 11 } },
    });
    expect(editor.somethingSelected()).toBe(true);
    expect(editor.getSelection()).toBe("world");
    editor.replaceSelection("vaultd");
    expect(editor.getValue()).toBe("hello vaultd\n");
    expect(editor.getCursor("head")).toEqual({ line: 0, ch: 12 });
  });
});
```

- [ ] **Step 11: Run all four files, implement what is missing, observe them pass**

```bash
npm --prefix host test -- shim-internal-plugins
npm --prefix host test -- shim-cross-plugin
npm --prefix host test -- config-refresh
npm --prefix host test -- shim-editor
```

Expected: eight registry cases, three config-refresh cases, and five editor cases pass.

- [ ] **Step 12: Commit**

```bash
git add host/packages/host/src/shim host/packages/host/test
git commit -m "feat(host): serve cross-plugin registries, a real Editor, and config refresh"
```

---

### Task 13: Module interception, the electron stub, and user-script provisioning

**Files:**

- Create: `host/packages/host/src/runtime/intercept.ts`
- Create: `host/packages/host/src/runtime/loader.ts`
- Create: `host/packages/host/src/runtime/electron-stub.ts`
- Create: `host/packages/host/test/module-intercept.test.ts`
- Create: `host/packages/host/test/electron-stub.test.ts`
- Create: `host/packages/host/test/fixtures/bundles/cjs-plugin/main.js`
- Create: `host/packages/host/test/fixtures/bundles/rollup-interop/main.js`
- Create: `host/packages/host/test/fixtures/bundles/user-script.md`

**Interfaces:**

- Produces:

```ts
export interface InterceptionOptions {
  readonly hostModulePaths: readonly string[];   // where the workspace's obsidian/electron live
  readonly allowNodeBuiltins: boolean;           // false under dry-run
}
export interface Interception { restore(): void; interceptedCount(): number }
export function installModuleInterception(options: InterceptionOptions): Interception;

export interface BundleLoadRequest {
  readonly pluginId: string;
  readonly filename: string;   // absolute path of the materialized main.js
  readonly source: string;
  readonly hostModulePaths: readonly string[];
}
export interface LoadedBundle { readonly exports: unknown; readonly pluginClass: new (app: App, manifest: PluginManifest) => Plugin }
export function loadPluginBundle(request: BundleLoadRequest): LoadedBundle;
export function provisionUserScriptGlobals(hostRequire: NodeJS.Require): { restore(): void };
```

- Two mechanisms, in this order and for this reason. **Resolution first:** `loadPluginBundle` constructs a `Module` whose `paths` array begins with the host's `node_modules`, so an ordinary `require("obsidian")` inside a bundle sitting at `<vault>/.obsidian-headless/plugins/<id>/main.js` resolves to the workspace's `obsidian` package with no patching at all — Node's own algorithm does the work. **`Module._load` patch second, as the fallback:** some bundles are loaded by paths this does not cover (a plugin that re-requires itself, a nested worker file), so a patch maps the two bare specifiers `obsidian` and `electron` regardless of the requesting module. The patch is deliberately narrow: exactly two specifiers, everything else delegates to the original `_load`. A broad patch would make every unrelated `require` in the process slower and would be an unbounded behavior change.
- No `vm.createContext` anywhere. Plugins run with the host's Node privileges, as they do under Electron; the design's non-goals say so and the dry-run mode is explicitly not a sandbox.
- `provisionUserScriptGlobals` sets `globalThis.require` (aliased as `window.require`) to a `createRequire` bound to the host, plus defensive `globalThis.module = { exports: {} }` and `globalThis.exports`. The load-bearing one is `window.require`: QuickAdd's user-script loader is `new Function("require", "module", "exports", src)` called with `m => window.require && window.require(m)` — it supplies `module` and `exports` itself and only needs `window.require` to be a real function. The other two are a safe stub for scripts that reference them outside QuickAdd's wrapper.

- [ ] **Step 1: Write the two fixture bundles**

`host/packages/host/test/fixtures/bundles/cjs-plugin/main.js` — the esbuild-CJS shape every sampled bundle has:

```js
"use strict";
var __toCommonJS = (mod) => Object.assign({ __esModule: true }, mod);
var main_exports = {};
var import_obsidian = require("obsidian");
var CjsPlugin = class extends import_obsidian.Plugin {
  async onload() {
    this.loadedWith = import_obsidian.normalizePath("Folder//Note.md");
    this.addCommand({ id: "probe", name: "Probe", callback: () => {} });
  }
};
main_exports.default = CjsPlugin;
module.exports = __toCommonJS(main_exports);
```

`host/packages/host/test/fixtures/bundles/rollup-interop/main.js` — rollover-daily-todos' shape, which reaches through a default-interop wrapper and `window.app`:

```js
'use strict';
var obsidian = require('obsidian');
function _interopDefault(e) { return e && e.__esModule ? e : { 'default': e }; }
var obsidian__default = _interopDefault(obsidian);
class RollupPlugin extends obsidian.Plugin {
  async onload() {
    this.sawTFile = obsidian__default['default'].TFile;
    this.sawWindowApp = window.app;
    this.sawMoment = typeof window.moment;
  }
}
module.exports = RollupPlugin;
```

- [ ] **Step 2: Write the failing interception test**

Create `host/packages/host/test/module-intercept.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPluginBundle } from "../src/runtime/loader";
import { installModuleInterception } from "../src/runtime/intercept";
import { ShimHarness } from "../src/testing/shim-harness";

const bundle = (name: string): { filename: string; source: string } => {
  const filename = join(__dirname, "fixtures", "bundles", name, "main.js");
  return { filename, source: readFileSync(filename, "utf8") };
};

describe("module interception", () => {
  it("resolves require('obsidian') from a bundle outside the host tree", async () => {
    const harness = await ShimHarness.withVault({});
    const { filename, source } = bundle("cjs-plugin");
    const loaded = loadPluginBundle({
      pluginId: "cjs", filename, source, hostModulePaths: harness.hostModulePaths,
    });
    const instance = new loaded.pluginClass(harness.app, harness.manifestFor("cjs"));
    await instance.onload();
    expect((instance as unknown as { loadedWith: string }).loadedWith).toBe("Folder/Note.md");
    expect(harness.harvest.commands().map((c) => c.id)).toEqual(["cjs:probe"]);
  });

  it("serves the same class identities to a rollup default-interop bundle", async () => {
    const harness = await ShimHarness.withVault({});
    const { filename, source } = bundle("rollup-interop");
    const loaded = loadPluginBundle({
      pluginId: "rollup", filename, source, hostModulePaths: harness.hostModulePaths,
    });
    const instance = new loaded.pluginClass(harness.app, harness.manifestFor("rollup"));
    await instance.onload();
    const seen = instance as unknown as { sawTFile: unknown; sawWindowApp: unknown; sawMoment: string };
    expect(seen.sawTFile).toBe(harness.api.TFile);
    expect(seen.sawWindowApp).toBe(harness.app);
    expect(seen.sawMoment).toBe("function");
  });

  it("intercepts only obsidian and electron, delegating everything else", () => {
    const interception = installModuleInterception({
      hostModulePaths: [], allowNodeBuiltins: true,
    });
    try {
      const path = require("node:path") as { join(a: string, b: string): string };
      expect(path.join("a", "b")).toBe("a/b");
      const shim = require("obsidian") as { normalizePath(p: string): string };
      expect(typeof shim.normalizePath).toBe("function");
      const electron = require("electron") as { shell: unknown };
      expect(electron.shell).toBeDefined();
      expect(interception.interceptedCount()).toBe(2);
    } finally {
      interception.restore();
    }
    expect(() => require("obsidian")).toThrow(/Cannot find module/);
  });

  it("provisions window.require for a QuickAdd-shaped user script", async () => {
    const harness = await ShimHarness.withVault({});
    const source = readFileSync(join(__dirname, "fixtures", "bundles", "user-script.md"), "utf8");
    const requireShim = (m: string): unknown =>
      (globalThis as unknown as { require?: (s: string) => unknown }).require?.(m);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    new Function("require", "module", "exports", source)(requireShim, moduleObj, exportsObj);
    const entry = (exportsObj["default"] ?? moduleObj.exports) as (params: unknown) => string;
    expect(entry({})).toMatch(/^[0-9a-f]{8}$/);
    void harness;
  });
});
```

`user-script.md` is a QuickAdd user script that genuinely needs Node — this is the case the research called surprise #3:

```js
module.exports = () => {
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update("vaultd").digest("hex").slice(0, 8);
};
```

- [ ] **Step 3: Run it and observe the missing modules**

```bash
npm --prefix host test -- module-intercept
```

Expected: cannot resolve `../src/runtime/loader`.

- [ ] **Step 4: Implement the loader**

Create `loader.ts`:

```ts
import Module from "node:module";
import { dirname } from "node:path";

export function loadPluginBundle(request: BundleLoadRequest): LoadedBundle {
  // `undefined`, not `null`. Node's Module constructor is
  // `Module(id, parent?: Module)` and its body does `if (parent && parent.children)`
  // — passing `null` works today by accident, but the declared type is
  // `Module | undefined` and `strict` TypeScript rejects `null`. Use the
  // spelling the signature actually has.
  const mod = new Module(request.filename, undefined) as NodeModule & {
    _compile(code: string, filename: string): unknown;
    paths: string[];
  };
  mod.filename = request.filename;
  mod.paths = [
    ...request.hostModulePaths,
    ...(Module as unknown as { _nodeModulePaths(from: string): string[] })._nodeModulePaths(dirname(request.filename)),
  ];
  mod._compile(request.source, request.filename);
  const exported = mod.exports as { default?: unknown } | unknown;
  const candidate = (exported as { default?: unknown })?.default ?? exported;
  if (typeof candidate !== "function") {
    throw new Error(`plugin ${request.pluginId} exported no Plugin class`);
  }
  return { exports: mod.exports, pluginClass: candidate as LoadedBundle["pluginClass"] };
}
```

Taking `default ?? exports` covers both shapes in the corpus: esbuild bundles export `default` through `__toCommonJS`, rollup bundles assign the class straight to `module.exports`.

- [ ] **Step 5: Implement the narrow `_load` patch**

Create `intercept.ts` patching `Module._load` to return the shim for exactly `"obsidian"` and `"electron"`, counting each interception, and restoring the original on `restore()`. Under `allowNodeBuiltins: false` (dry-run), a `require` of `node:child_process`, `node:fs`, `node:http`, `node:https`, or `node:net` throws a typed `DryRunRefused` instead of resolving.

- [ ] **Step 6: Run and observe it pass**

```bash
npm --prefix host test -- module-intercept
```

Expected: four cases pass.

- [ ] **Step 7: Write the failing electron-stub test**

Create `host/packages/host/test/electron-stub.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadlessUnsupported } from "../src/shim/policy";
import { createElectronStub } from "../src/runtime/electron-stub";
import {
  ElectronNotRegistered, clearElectronStub, currentElectronStub, registerElectronStub,
} from "../src/runtime/electron-registry";

afterEach(() => clearElectronStub());

describe("electron stub", () => {
  it("bridges shell.openPath to the OS opener", async () => {
    const spawned: Array<[string, string[]]> = [];
    const stub = createElectronStub({
      dryRun: false,
      spawn: (cmd, args) => { spawned.push([cmd, args]); return Promise.resolve(); },
    });
    await expect(stub.shell.openPath("/tmp/x.md")).resolves.toBe("");
    await stub.shell.showItemInFolder("/tmp/x.md");
    await stub.shell.openExternal("https://example.test/");
    expect(spawned).toEqual([
      ["open", ["/tmp/x.md"]],
      ["open", ["-R", "/tmp/x.md"]],
      ["open", ["https://example.test/"]],
    ]);
  });

  it("makes ipcRenderer inert for listeners and typed for invoke", () => {
    const stub = createElectronStub({ dryRun: false, spawn: () => Promise.resolve() });
    const listener = vi.fn();
    expect(() => stub.ipcRenderer.on("channel", listener)).not.toThrow();
    expect(() => stub.ipcRenderer.send("channel", 1)).not.toThrow();
    expect(() => stub.ipcRenderer.removeListener("channel", listener)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    try {
      stub.ipcRenderer.invoke("some-channel");
      expect.unreachable("invoke must throw");
    } catch (error) {
      // One constructor signature everywhere: (symbol, pluginId, detail?).
      expect(error).toBeInstanceOf(HeadlessUnsupported);
      expect((error as HeadlessUnsupported).symbol).toBe("electron.ipcRenderer.invoke");
      expect((error as HeadlessUnsupported).detail).toBe("some-channel");
      expect((error as HeadlessUnsupported).message).toContain("electron.ipcRenderer.invoke");
    }
  });

  it("registers as the singleton the electron package resolves", () => {
    const stub = createElectronStub({ dryRun: false, spawn: () => Promise.resolve() });
    registerElectronStub(stub);
    expect(currentElectronStub()).toBe(stub);
    clearElectronStub();
    expect(() => currentElectronStub()).toThrow(ElectronNotRegistered);
  });

  it("refuses every OS bridge under dry-run", async () => {
    const stub = createElectronStub({
      dryRun: true,
      spawn: () => { throw new Error("must not spawn"); },
    });
    await expect(stub.shell.openPath("/tmp/x.md")).rejects.toThrow(/dry_run_refused/);
    await expect(stub.shell.openExternal("https://example.test/")).rejects.toThrow(/dry_run_refused/);
  });

  it("throws typed for remote and webFrame", () => {
    const stub = createElectronStub({ dryRun: false, spawn: () => Promise.resolve() }) as unknown as Record<string, unknown>;
    for (const property of ["remote", "webFrame", "clipboard", "nativeImage"]) {
      try {
        (stub[property] as () => void)();
        expect.unreachable(`${property} must throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(HeadlessUnsupported);
        expect((error as HeadlessUnsupported).symbol).toBe(`electron.${property}`);
      }
    }
  });
});
```

- [ ] **Step 8: Run it and observe the missing module**

```bash
npm --prefix host test -- electron-stub
```

Expected: cannot resolve `../src/runtime/electron-stub`.

- [ ] **Step 9: Implement the electron stub**

Create `electron-stub.ts` exporting `createElectronStub({ dryRun, spawn })`. `shell.openPath(p)` runs `spawn("open", [p])` and resolves `""` (Electron's success value is an empty error string); `showItemInFolder(p)` runs `spawn("open", ["-R", p])`; `openExternal(url)` runs `spawn("open", [url])`. Under `dryRun` all three reject with `DryRunRefused { surface: "os_bridge" }` and record the attempt. `ipcRenderer` accepts and discards every listener registration and `send`, and `invoke`/`sendSync` call `unsupported("electron.ipcRenderer.invoke", channel)`. The whole object is wrapped in a `Proxy` whose `get` for an unknown property returns `() => unsupported("electron." + String(property))`, so `remote`, `webFrame`, and anything else a bundle reaches for fails typed and named rather than as `undefined is not a function`.

Assembly registers it: `registerElectronStub(createElectronStub({ dryRun: config.dryRun, spawn: osSpawn }))` runs inside `assembleShim` (Task 6b) **before** module interception installs, which is before any bundle loads.

- [ ] **Step 10: Run and observe it pass**

```bash
npm --prefix host test -- electron-stub
```

Expected: five cases pass.

- [ ] **Step 11: Commit**

```bash
git add host/packages/host/src/runtime host/packages/host/test
git commit -m "feat(host): resolve the obsidian and electron modules for unmodified bundles"
```

---

### Task 14: The headless config directory, the enabled set, and GUI co-existence

**Files:**

- **Activate** `src/testing/pending/pluginset-harness.ts` → `src/testing/pluginset-harness.ts` (`git mv`), per Task 6b.
- Create: `host/packages/host/src/pluginset/config-dir.ts`
- Create: `host/packages/host/src/pluginset/coexistence.ts`
- Create: `host/packages/host/test/config-dir.test.ts`
- Create: `host/packages/host/test/coexistence.test.ts`

**Interfaces:**

- Produces (`config-dir.ts`) — Ruling 1's structure, with **no invented file format anywhere**:

```ts
export interface PluginManifest {
  id: string; name: string; version: string; minAppVersion: string;
  description?: string; author?: string; authorUrl?: string; isDesktopOnly?: boolean;
  dir?: string;
}
export interface InstalledPlugin { readonly id: string; readonly manifest: PluginManifest; readonly dir: string }
export class HeadlessConfigDir {
  constructor(client: VaultdClient, config: HostConfig);
  readonly configDir: string;                                   // ".obsidian-headless"
  ensure(): Promise<void>;                                       // create_folder x2, idempotent
  readEnabledSet(): Promise<string[]>;                           // <configDir>/community-plugins.json
  writeEnabledSet(ids: readonly string[]): Promise<void>;
  listInstalled(): Promise<InstalledPlugin[]>;                   // <configDir>/plugins/*/manifest.json
  readManifest(id: string): Promise<PluginManifest>;
  readBundleSource(id: string): Promise<string>;                 // <configDir>/plugins/<id>/main.js
  readConfigJson<T>(name: string): Promise<T | null>;            // host dir, then .obsidian
  dataPath(id: string): string;                                  // <configDir>/plugins/<id>/data.json
}
```

The layout is Obsidian's own, byte-for-byte: `community-plugins.json` is a JSON array of enabled ids; `plugins/<id>/` holds `manifest.json`, `main.js`, optional `styles.css`, and `data.json`. Nothing bespoke, so a future install/update flow is the same operation aimed at a different directory, and a plugin's headless `data.json` is structurally unreachable from the GUI copy.

- Produces (`coexistence.ts`):

```ts
export interface OverlapReport {
  readonly hostEnabled: readonly string[];
  readonly guiEnabled: readonly string[];
  readonly overlap: readonly string[];
  readonly forced: readonly string[];
  readonly guiReadable: boolean;
  readonly checkedAtMs: number;
}
export class CoexistenceMonitor {
  constructor(dir: HeadlessConfigDir, client: VaultdClient, config: HostConfig);
  check(): Promise<OverlapReport>;
  assertCanEnable(id: string): Promise<void>;   // throws OverlapRefused
  start(): void;   // 60_000 ms poll of Obsidian's community-plugins.json
  stop(): void;
  latest(): OverlapReport | null;
  onOverlapChanged(cb: (report: OverlapReport) => void): () => void;
}
export class OverlapRefused extends Error {
  readonly code = "overlap_refused";
  readonly pluginId: string;
  readonly reason: string;
}
```

The check is a comparison of two ordinary `community-plugins.json` files — the host's own and Obsidian's — both read through `read_file`. It runs at host startup, at every `host.enable_plugin`, and on the 60 s poll that closes the mid-session window (`.obsidian` is not watched by `vaultd`, so a poll is the honest mechanism, and the limitation is stated in `host_info` rather than hidden). `--force-shared <id>` admits a named plugin and the refusal message says exactly what makes double-running dangerous: event double-fire (two folder notes per folder, two lint passes) and port binding, since three plugins in the census bind servers at load.

- [ ] **Step 1: Write the failing config-dir test**

Create `host/packages/host/test/config-dir.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HeadlessConfigDir } from "../src/pluginset/config-dir";
import { DaemonHarness } from "../src/testing/daemon-harness";

describe("HeadlessConfigDir", () => {
  it("creates the two folders idempotently", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const pending = dir.ensure();
    const first = await harness.nextRequest();
    expect(first.request).toEqual({ method: "create_folder", params: { path: ".obsidian-headless" } });
    harness.respondOk(first.id, "create_folder", { generation: 1 });
    const second = await harness.nextRequest();
    expect(second.request).toEqual({ method: "create_folder", params: { path: ".obsidian-headless/plugins" } });
    harness.respondOk(second.id, "create_folder", { generation: 1 });
    await pending;
  });

  it("reads and writes community-plugins.json as an ordinary JSON array", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const reading = dir.readEnabledSet();
    const read = await harness.nextRequest();
    expect(read.request).toEqual({
      method: "read_file", params: { path: ".obsidian-headless/community-plugins.json" },
    });
    harness.respondReadFile(read.id, JSON.stringify(["folder-notes", "quickadd"]), "blake3:c1");
    await expect(reading).resolves.toEqual(["folder-notes", "quickadd"]);

    const writing = dir.writeEnabledSet(["folder-notes"]);
    const write = await harness.nextRequest();
    const body = Buffer.from(
      (write.request.params as { content_base64: string }).content_base64, "base64",
    ).toString("utf8");
    expect(JSON.parse(body)).toEqual(["folder-notes"]);
    harness.respondOk(write.id, "write_file", { revision: "blake3:c2", semantic: false });
    await writing;
  });

  it("returns an empty enabled set when the file does not exist yet", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const reading = dir.readEnabledSet();
    const read = await harness.nextRequest();
    harness.respondErr(read.id, { code: "not_found", message: "no such file" });
    await expect(reading).resolves.toEqual([]);
  });

  it("falls back to Obsidian's copy for a config file the host dir lacks", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const reading = dir.readConfigJson<{ trashOption: string }>("app.json");
    const headless = await harness.nextRequest();
    expect(headless.request).toEqual({
      method: "read_file", params: { path: ".obsidian-headless/app.json" },
    });
    harness.respondErr(headless.id, { code: "not_found", message: "no such file" });
    const gui = await harness.nextRequest();
    expect(gui.request).toEqual({ method: "read_file", params: { path: ".obsidian/app.json" } });
    harness.respondReadFile(gui.id, JSON.stringify({ trashOption: "local" }), "blake3:a1");
    await expect(reading).resolves.toEqual({ trashOption: "local" });
  });
});
```

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- config-dir
```

Expected: cannot resolve `../src/pluginset/config-dir`.

- [ ] **Step 3: Implement `HeadlessConfigDir` and observe the test pass**

`ensure()` sends two `create_folder` calls and treats `target_exists` as success. `readEnabledSet` maps `not_found` to `[]` and lets every other error through — a corrupt config file must be loud, an absent one must not. `readConfigJson(name)` tries `<configDir>/<name>` then `.obsidian/<name>`, returning `null` only when both are `not_found`. `writeEnabledSet` sends one `write_file` with the array as pretty JSON plus a trailing newline, matching what Obsidian writes, so a human diffing the two directories sees no gratuitous difference. Re-run `npm --prefix host test -- config-dir`; expected: four cases pass.

- [ ] **Step 4: Write the failing co-existence test**

Create `host/packages/host/test/coexistence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CoexistenceMonitor, OverlapRefused } from "../src/pluginset/coexistence";
import { PluginSetHarness } from "../src/testing/pluginset-harness";

describe("CoexistenceMonitor", () => {
  it("reports the overlap between the two enabled sets", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: ["folder-notes", "automatic-linker"],
      guiEnabled: ["folder-notes", "tag-wrangler"],
    });
    const report = await harness.monitor.check();
    expect(report.overlap).toEqual(["folder-notes"]);
    expect(report.hostEnabled).toEqual(["folder-notes", "automatic-linker"]);
    expect(report.guiEnabled).toEqual(["folder-notes", "tag-wrangler"]);
    expect(report.guiReadable).toBe(true);
  });

  it("refuses to enable a plugin the GUI already has enabled", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: ["obsidian-linter"] });
    await expect(harness.monitor.assertCanEnable("obsidian-linter")).rejects.toBeInstanceOf(OverlapRefused);
    await harness.monitor.assertCanEnable("obsidian-linter").catch((error: OverlapRefused) => {
      expect(error.code).toBe("overlap_refused");
      expect(error.message).toContain("event double-fire");
      expect(error.message).toContain("port binding");
    });
  });

  it("admits a plugin named in --force-shared", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: [], guiEnabled: ["obsidian-linter"], forceShared: ["obsidian-linter"],
    });
    await expect(harness.monitor.assertCanEnable("obsidian-linter")).resolves.toBeUndefined();
    expect((await harness.monitor.check()).forced).toEqual(["obsidian-linter"]);
  });

  it("catches a mid-session GUI enable on the next poll", async () => {
    const harness = await PluginSetHarness.create({
      hostEnabled: ["quickadd"], guiEnabled: [],
    });
    const seen: string[][] = [];
    harness.monitor.onOverlapChanged((report) => seen.push([...report.overlap]));
    expect((await harness.monitor.check()).overlap).toEqual([]);
    harness.setGuiEnabled(["quickadd"]);
    await harness.advancePoll();
    expect(seen).toEqual("quickadd");
    expect(harness.monitor.latest()?.overlap).toEqual(["quickadd"]);
  });

  it("reports guiReadable false rather than failing when Obsidian has no config", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: ["quickadd"], guiEnabled: null });
    const report = await harness.monitor.check();
    expect(report.guiReadable).toBe(false);
    expect(report.overlap).toEqual([]);
    await expect(harness.monitor.assertCanEnable("quickadd")).resolves.toBeUndefined();
  });
});
```

`advancePoll()` is `harness.clock.advance(config.overlapPollMs)` on the `TestClock` from Task 6b — the monitor arms its poll with `config.clock.setInterval`, never the global, so this test moves 60 seconds in no wall-clock time. The determinism rule forbids a sleep here and the clock seam is what makes obeying it possible.

- [ ] **Step 5: Run it and observe the missing module**

```bash
npm --prefix host test -- coexistence
```

Expected: cannot resolve `../src/pluginset/coexistence`.

- [ ] **Step 6: Implement `CoexistenceMonitor` and observe the test pass**

`check()` reads both `community-plugins.json` files through `read_file`, treats a `not_found` on Obsidian's copy as `guiReadable: false` with an empty overlap (a vault with no GUI Obsidian is not a conflict), and stamps `checkedAtMs` from `config.clock.now()`. `assertCanEnable(id)` re-checks and throws `OverlapRefused` unless the id is in `config.forceShared`; the message names both consequences by hand — "event double-fire (two folder notes per folder, two lint passes)" and "port binding (three plugins in the census bind servers at load)" — because a refusal that does not say why is a refusal someone will `--force-shared` past without thinking. `start()` arms `config.clock.setInterval(check, config.overlapPollMs)` and fires `onOverlapChanged` only when the overlap set actually differs from `latest()`. Re-run; expected: five cases pass.

- [ ] **Step 7: Commit**

```bash
git add host/packages/host/src/pluginset host/packages/host/test
git commit -m "feat(host): run plugins from a headless config directory with a GUI overlap check"
```

---

### Task 14b: Quarantine tracking

**Moved ahead of the lifecycle sequencer, and this is the honest order.** In v1 quarantine lived in Task 21, sharing a task with the watchdog because both are "failure handling" — but Task 15's trap tests assert `harness.quarantine.failuresFor(...)` and Task 16a's ops test asserts a `plugin_quarantined` refusal, so two tasks consumed a component that six tasks later produced. Quarantine is also what the `ShimEventBus`'s handler-error path reports into, which is a Task 15 wiring. So it moves here: after the config directory it needs to disable a plugin in, before everything that observes it. The watchdog stays in Task 21, where it is genuinely independent of everything else.

**Files:**

- Create: `host/packages/host/src/runtime/quarantine.ts`
- Create: `host/packages/host/test/quarantine.test.ts`

**Interfaces:**

```ts
export interface HandlerFailure {
  readonly pluginId: string;
  readonly label: string;       // "onload", "command:demo:go", "event:vault:modify", …
  readonly error: Error;
  readonly atUnixMs: number;
}
export class QuarantineTracker {
  constructor(
    config: HostConfig,   // reads quarantineFailures, quarantineWindowMs, and clock
    onQuarantine: (pluginId: string, failures: readonly HandlerFailure[]) => Promise<void>,
  );
  record(failure: HandlerFailure): Promise<void>;
  failuresFor(pluginId: string): number;
  lastError(pluginId: string): Error | null;
  isQuarantined(pluginId: string): boolean;
  quarantined(): readonly string[];
  reason(pluginId: string): readonly HandlerFailure[];
  release(pluginId: string): void;
  forgetPlugin(pluginId: string): void;
}
```

- **Quarantine at 5 handler failures in a rolling 60 s window** (Ruling 8), both read from `HostConfig`, and the window is measured with `config.clock.now()` — never `Date.now()`, because the "failures outside the window" test advances 61 seconds and must not take 61 seconds.
- The `onQuarantine` callback is supplied by the lifecycle sequencer (Task 15) and does three things: unload the plugin, call `harvest.forgetPlugin(id)` so its commands, menu hooks, and protocol handlers **disappear from `host.list_*`**, and call `events.forgetPlugin(id)` so no vault change can wake it again. `host.invoke_command` on a remembered id then returns typed `plugin_quarantined` (Task 16a). Removing the harvest is the point: a capability list that still advertises a dead plugin's commands is worse than one that says the plugin is quarantined.
- `lastError` exists because three later test files assert on it (`harness.lastHandlerError(pluginId)` is a thin wrapper). It holds the most recent failure's error whether or not the threshold was reached, and is cleared by `release`.

- [ ] **Step 1: Write the failing quarantine test**

Create `host/packages/host/test/quarantine.test.ts`. It drives `QuarantineTracker` directly plus one end-to-end case through the harness, so the unit is testable before the sequencer exists:

```ts
import { describe, expect, it } from "vitest";
import { QuarantineTracker } from "../src/runtime/quarantine";
import { defaultHostConfig } from "../src/config";
import { testClock } from "../src/testing/clock";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const trackerWith = () => {
  const clock = testClock();
  const config = {
    ...defaultHostConfig(mkdtempSync(join(tmpdir(), "vaultd-q-"))),
    clock, quarantineFailures: 5, quarantineWindowMs: 60_000,
  };
  const quarantined: string[] = [];
  const tracker = new QuarantineTracker(config, async (id) => { quarantined.push(id); });
  const fail = async (pluginId: string, message = "nope") => {
    await tracker.record({
      pluginId, label: "command:x", error: new Error(message), atUnixMs: clock.now(),
    });
  };
  return { clock, tracker, quarantined, fail };
};

describe("QuarantineTracker", () => {
  it("quarantines on the fifth failure inside the window, not the fourth", async () => {
    const { tracker, quarantined, fail } = trackerWith();
    for (let i = 0; i < 4; i += 1) await fail("flaky");
    expect(tracker.isQuarantined("flaky")).toBe(false);
    expect(tracker.failuresFor("flaky")).toBe(4);
    expect(quarantined).toEqual([]);
    await fail("flaky");
    expect(tracker.isQuarantined("flaky")).toBe(true);
    expect(quarantined).toEqual(["flaky"]);
  });

  it("prunes failures that fall out of the rolling window", async () => {
    const { clock, tracker, fail } = trackerWith();
    for (let i = 0; i < 4; i += 1) await fail("flaky");
    await clock.advance(61_000);
    await fail("flaky");
    expect(tracker.isQuarantined("flaky")).toBe(false);
    expect(tracker.failuresFor("flaky")).toBe(1);
  });

  it("counts per plugin, never across them", async () => {
    const { tracker, fail } = trackerWith();
    for (let i = 0; i < 4; i += 1) await fail("bad");
    await fail("other");
    expect(tracker.failuresFor("bad")).toBe(4);
    expect(tracker.failuresFor("other")).toBe(1);
    expect(tracker.quarantined()).toEqual([]);
  });

  it("calls onQuarantine exactly once no matter how many more failures arrive", async () => {
    const { tracker, quarantined, fail } = trackerWith();
    for (let i = 0; i < 8; i += 1) await fail("flaky");
    expect(quarantined).toEqual(["flaky"]);
    expect(tracker.reason("flaky")).toHaveLength(5);
  });

  it("keeps the last error and clears it on release", async () => {
    const { tracker, fail } = trackerWith();
    await fail("flaky", "first");
    await fail("flaky", "second");
    expect(tracker.lastError("flaky")?.message).toBe("second");
    tracker.release("flaky");
    expect(tracker.failuresFor("flaky")).toBe(0);
    expect(tracker.lastError("flaky")).toBeNull();
    expect(tracker.isQuarantined("flaky")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- quarantine
```

Expected: cannot resolve `../src/runtime/quarantine`.

- [ ] **Step 3: Implement the tracker**

Create `quarantine.ts` as a `Map<string, HandlerFailure[]>` pruned to `[now - windowMs, now]` on every `record`, plus a `Set<string>` of quarantined ids so `onQuarantine` fires exactly once. `record` returns after `onQuarantine` resolves, so a caller that awaits it knows the unload has completed before it reports the failure onward.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- quarantine
```

Expected: five cases pass.

- [ ] **Step 5: Commit**

```bash
git add host/packages/host/src/runtime/quarantine.ts host/packages/host/test/quarantine.test.ts
git commit -m "feat(host): track handler failures and quarantine on the threshold"
```

The four end-to-end quarantine cases — harvest removal, cross-plugin attribution, other plugins surviving, the typed `plugin_quarantined` refusal — live in Task 16a, where the server and the sequencer exist to make them true.

---

### Task 15: The lifecycle sequencer

**Files:**

- **Activate** `src/testing/pending/host-harness.ts` → `src/testing/host-harness.ts` (`git mv`), per Task 6b.
- Create: `host/packages/host/src/runtime/lifecycle.ts`
- Create: `host/packages/host/test/lifecycle-order.test.ts`
- Create: `host/packages/host/test/lifecycle-traps.test.ts`
- Create: `host/packages/host/test/lifecycle-restart.test.ts`

**Interfaces:**

- Produces:

```ts
export type LifecyclePhase =
  | "cold" | "hydrating" | "loading" | "layout_ready" | "resolving" | "steady" | "stopping" | "stopped";

export interface LifecycleDeps {
  supervisor: Supervisor;
  mirror: Mirror;
  app: App;
  harvest: Harvest;
  events: ShimEventBus;            // Task 6b — the fan-out and the failure attribution
  dir: HeadlessConfigDir;
  coexistence: CoexistenceMonitor;
  quarantine: QuarantineTracker;   // Task 14b — produced before this task, not after
  queue: DispatchQueue;
  config: HostConfig;
}
export class LifecycleSequencer {
  constructor(deps: LifecycleDeps);
  start(): Promise<StartupReport>;
  enableLate(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  onEngineRestart(previousRevisions: ReadonlyMap<string, string>): Promise<void>;
  stop(): Promise<void>;
  phase(): LifecyclePhase;
  loadTimings(): ReadonlyMap<string, number>;
}
export interface StartupReport {
  readonly generation: number;
  readonly loaded: readonly string[];
  readonly failed: readonly { id: string; error: string }[];
  readonly hydrationMs: number;
  readonly warmMs: number;
  readonly loadMs: number;
}
```

- The exact sequence, which is where plugins silently die and therefore the thing this task exists to pin:
  1. The supervisor starts `vaultd`; the mirror hydrates via a snapshot session at generation G; positions warm.
  2. The enabled set is read from the headless `community-plugins.json`, filtered by the co-existence check; bundles load; `onload` runs **sequentially in manifest order** through the dispatch queue. `workspace.layoutReady` is `false` throughout. Registrations harvest as they occur.
  3. `layoutReady` flips true; queued `onLayoutReady` callbacks fire in registration order.
  4. `metadataCache` fires `resolve` once per note, then `resolved` once. Thereafter `resolved` re-fires after every mirror batch completes.
  5. Steady state: mirror batches become `vault.on(create|modify|delete|rename)` and `metadataCache.on(changed|deleted)`, all serialized on the one JS thread.
- **How a `rename` event gets fired at all**, given that the wire has none: the sequencer feeds each `MirrorChangeBatch` to `FileIndex.applyBatch`, which returns an `AppliedBatch` whose `renamed` array was paired out of the delete/create pair by matching revisions (Task 7). The sequencer then emits, in this order: `vault.trigger("create", file)` per created path, `vault.trigger("modify", file)` per modified path followed by `metadataCache.trigger("changed", file, data, cache)` per changed note, `vault.trigger("rename", file, oldPath)` per paired rename, `vault.trigger("delete", file)` per remaining deleted path followed by `metadataCache.trigger("deleted", file, prevCache)` per deleted note, then one `resolved`. A path the batch both removes and re-creates — Ruling W6's replacement, and a `modified` path whose kind changed, which is the only spelling the real daemon has been measured to use — is hoisted: its delete fires ahead of everything. A renamed path emits **only** the rename — never a create and a delete for the same move — because folder-notes' handlers assume Obsidian's one-event-per-move semantics.

  > **Amended 2026-09-15 (RULING, Task 15, event order).** This paragraph used to group every `metadataCache` event after every `vault` event. The ruling: *"the shipped per-file grouping stands (create; modify with its changed; rename; delete with its deleted; then one resolved). Reason: Obsidian documented model is per-file; the brief only stated reason (one event per move) is satisfied by both; the plan text is amended (Task 15 brief + plan section) and one discriminating test is added."* The test is `lifecycle-order.test.ts` → "groups each file's cache event with its own vault event".
- **Handler failures are attributed and recorded, not swallowed.** `ShimEventBus.emit` catches per listener, builds a `HandlerFailure { pluginId, label, error, atUnixMs }` from the listener's owner, and calls `deps.quarantine.record(failure)`. One plugin's throwing handler never stops another plugin's handler for the same event, and never stops the batch.
- Late enable (Ruling 6): `onload`, then `layoutReady` callbacks invoked **immediately** because layout is already ready, then one **synthetic `resolved` delivered to that plugin only**, immediately. Waiting for the next real vault change is never, on a quiet vault, and that is exactly the silent-deadlock class the research identified for the six gate-waiting plugins.
- Engine restart (Ruling 7): plugins are **not** reloaded by default. The mirror re-hydrates at G′, `synthesizeDiff` produces the changed set, the sequencer replays it as ordinary `changed` events plus one `resolved` — the same shape as a bulk external edit, which plugins already tolerate. `reloadPluginsOnEngineRestart: true` forces the reload path instead.

- [ ] **Step 1: Write the failing order test**

Create `host/packages/host/test/lifecycle-order.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

describe("lifecycle order", () => {
  it("runs the five steps in the specified order across two plugins", async () => {
    const order: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "B.md": "# B\n" },
      enabled: ["first", "second"],
      plugins: {
        first: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            order.push("first:onload");
            order.push(`first:layoutReady=${this.app.workspace.layoutReady}`);
            this.app.workspace.onLayoutReady(() => order.push("first:layout"));
            this.registerEvent(this.app.metadataCache.on("resolved", () => order.push("first:resolved")));
            this.registerEvent(this.app.metadataCache.on("resolve", () => order.push("first:resolve")));
          }
        },
        second: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            order.push("second:onload");
            this.app.workspace.onLayoutReady(() => order.push("second:layout"));
          }
        },
      },
    });
    const report = await harness.lifecycle.start();
    expect(report.loaded).toEqual(["first", "second"]);
    expect(order).toEqual([
      "first:onload", "first:layoutReady=false", "second:onload",
      "first:layout", "second:layout",
      "first:resolve", "first:resolve", "first:resolved",
    ]);
    expect(harness.lifecycle.phase()).toBe("steady");
  });

  it("re-fires resolved after every steady-state mirror batch", async () => {
    const events: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["watcher"],
      plugins: {
        watcher: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(this.app.metadataCache.on("resolved", () => events.push("resolved")));
            this.registerEvent(this.app.metadataCache.on("changed", (file) =>
              events.push(`changed:${(file as { path: string }).path}`)));
            this.registerEvent(this.app.vault.on("create", (file) =>
              events.push(`create:${(file as { path: string }).path}`)));
          }
        },
      },
    });
    await harness.lifecycle.start();
    events.length = 0;
    await harness.commitGeneration({ created: ["New.md"], modified: ["A.md"] });
    expect(events).toEqual(["create:New.md", "changed:A.md", "resolved"]);
  });

  it("gives a late-enabled plugin layoutReady and a synthetic resolved immediately", async () => {
    const order: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      plugins: {
        late: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            order.push("onload");
            this.app.workspace.onLayoutReady(() => order.push("layout"));
            this.registerEvent(this.app.metadataCache.on("resolved", () => order.push("resolved")));
          }
        },
        bystander: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(this.app.metadataCache.on("resolved", () => order.push("bystander:resolved")));
          }
        },
      },
    });
    await harness.lifecycle.start();
    await harness.lifecycle.enableLate("bystander");
    order.length = 0;
    await harness.lifecycle.enableLate("late");
    expect(order).toEqual(["onload", "layout", "resolved"]);
  });
});
```

The third case's `bystander` is doing real work: it proves the synthetic `resolved` goes to the newly enabled plugin **only**. A broadcast would re-fire `resolved` at every already-running plugin for no reason and would make the assertion fail.

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- lifecycle-order
```

Expected: cannot resolve `../src/runtime/lifecycle`.

- [ ] **Step 3: Implement the sequencer**

Create `lifecycle.ts`. Each phase is one method, each awaits the previous, and every plugin entry point goes through `deps.queue.run(pluginId, label, fn)` so a plugin that awaits inside `onload` still cannot interleave with the next plugin's `onload`. `resolve` is fired per note in path order, then `resolved`, both through the queue.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- lifecycle-order
```

Expected: three cases pass.

- [ ] **Step 5: Write the failing trap test**

Create `host/packages/host/test/lifecycle-traps.test.ts`. These are the two named failure classes from the research, reproduced as tests rather than trusted as prose:

```ts
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

describe("lifecycle traps", () => {
  it("survives the folder-notes tabManager trap: rename after layoutReady", async () => {
    const harness = await HostHarness.create({
      vault: { "Folder/Folder.md": "note\n", "Other.md": "Folder\n" },
      enabled: ["folderish"],
      plugins: {
        folderish: (api) => class extends api.Plugin {
          tabManager?: { updateTab(path: string): void };
          override async onload(): Promise<void> {
            this.registerEvent(this.app.vault.on("rename", (file) => {
              this.tabManager!.updateTab((file as { path: string }).path);
            }));
            this.app.workspace.onLayoutReady(() => {
              this.tabManager = {
                updateTab: () => {
                  this.app.workspace.iterateAllLeaves((leaf: { view?: unknown }) => {
                    if (leaf.view instanceof api.EditableFileView) throw new Error("no leaves headless");
                  });
                },
              };
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    // `renamed:` is harness sugar. On the wire this becomes one
    // generation_committed carrying deleted: ["Folder/Folder.md"] and
    // created: ["Folder/Renamed.md"] with the same revision — there is no
    // rename on the wire. The shim is what pairs them back into one
    // vault.on("rename") delivery, and that pairing is what this test
    // exercises end to end.
    await expect(harness.commitGeneration({ renamed: [{ from: "Folder/Folder.md", to: "Folder/Renamed.md" }] }))
      .resolves.toBeUndefined();
    expect(harness.quarantine.failuresFor("folderish")).toBe(0);
  });

  it("delivers exactly one rename and no create or delete for a move", async () => {
    const seen: string[] = [];
    const harness = await HostHarness.create({
      vault: { "Folder/Folder.md": "note\n" },
      enabled: ["watcher"],
      plugins: {
        watcher: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(this.app.vault.on("rename", (file, oldPath) =>
              seen.push(`rename:${oldPath as string}->${(file as { path: string }).path}`)));
            this.registerEvent(this.app.vault.on("create", (file) =>
              seen.push(`create:${(file as { path: string }).path}`)));
            this.registerEvent(this.app.vault.on("delete", (file) =>
              seen.push(`delete:${(file as { path: string }).path}`)));
          }
        },
      },
    });
    await harness.lifecycle.start();
    seen.length = 0;
    await harness.commitGeneration({
      renamed: [{ from: "Folder/Folder.md", to: "Folder/Renamed.md" }],
    });
    expect(seen).toEqual(["rename:Folder/Folder.md->Folder/Renamed.md"]);
  });

  it("reproduces the trap when layoutReady never fires, proving the test has teeth", async () => {
    const harness = await HostHarness.create({
      vault: { "Folder/Folder.md": "note\n" },
      enabled: ["folderish"],
      suppressLayoutReady: true,
      plugins: {
        folderish: (api) => class extends api.Plugin {
          tabManager?: { updateTab(path: string): void };
          override async onload(): Promise<void> {
            this.registerEvent(this.app.vault.on("rename", (file) => {
              this.tabManager!.updateTab((file as { path: string }).path);
            }));
            this.app.workspace.onLayoutReady(() => { this.tabManager = { updateTab: () => {} }; });
          }
        },
      },
    });
    await harness.lifecycle.start();
    await harness.commitGeneration({ renamed: [{ from: "Folder/Folder.md", to: "Folder/Renamed.md" }] });
    expect(harness.quarantine.failuresFor("folderish")).toBe(1);
    expect(harness.lastHandlerError("folderish")?.message).toMatch(/tabManager/);
  });

  it("does not deadlock a plugin that gates its whole startup on resolved", async () => {
    let gateOpened = false;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["gated"],
      plugins: {
        gated: (api) => class extends api.Plugin {
          ready?: Promise<void>;
          override async onload(): Promise<void> {
            this.ready = new Promise<void>((resolve) => {
              this.registerEvent(this.app.metadataCache.on("resolved", () => { gateOpened = true; resolve(); }));
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    expect(gateOpened).toBe(true);
    const plugin = harness.app.plugins.getPlugin("gated") as unknown as { ready: Promise<void> };
    await expect(Promise.race([
      plugin.ready.then(() => "opened"),
      harness.tick().then(() => "deadlocked"),
    ])).resolves.toBe("opened");
  });

  it("opens the gate for a plugin enabled onto a quiet vault", async () => {
    let gateOpened = false;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      plugins: {
        gated: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(this.app.metadataCache.on("resolved", () => { gateOpened = true; }));
          }
        },
      },
    });
    await harness.lifecycle.start();
    await harness.lifecycle.enableLate("gated");
    expect(gateOpened).toBe(true);
    expect(harness.mirrorRequestsSince("enableLate")).toEqual([]);
  });
});
```

- [ ] **Step 6: Run, implement, observe it pass**

Run `npm --prefix host test -- lifecycle-traps`. The second case must **fail first in the opposite direction** — it asserts the crash happens with `suppressLayoutReady`, so if it passes before the sequencer exists, the harness is not wiring handlers at all. Confirm the first case fails, implement, and confirm all five pass.

- [ ] **Step 7: Write the failing restart-continuity test**

Create `host/packages/host/test/lifecycle-restart.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

describe("engine restart continuity", () => {
  it("keeps plugins loaded and synthesizes changed events for the revision diff", async () => {
    const events: string[] = [];
    let onloadCount = 0;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "Gone.md": "x\n" },
      enabled: ["observer"],
      plugins: {
        observer: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            onloadCount += 1;
            this.registerEvent(this.app.metadataCache.on("changed", (f) =>
              events.push(`changed:${(f as { path: string }).path}`)));
            this.registerEvent(this.app.vault.on("create", (f) =>
              events.push(`create:${(f as { path: string }).path}`)));
            this.registerEvent(this.app.vault.on("delete", (f) =>
              events.push(`delete:${(f as { path: string }).path}`)));
            this.registerEvent(this.app.metadataCache.on("resolved", () => events.push("resolved")));
          }
        },
      },
    });
    await harness.lifecycle.start();
    expect(onloadCount).toBe(1);
    events.length = 0;
    await harness.restartEngine({
      generation: 40,
      vault: { "A.md": "# A changed\n", "New.md": "fresh\n" },
    });
    expect(onloadCount).toBe(1);
    expect(events).toEqual([
      "create:New.md", "changed:A.md", "delete:Gone.md", "resolved",
    ]);
    expect(harness.lifecycle.phase()).toBe("steady");
  });

  it("reloads plugins when the knob is set", async () => {
    let onloadCount = 0;
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["observer"],
      config: { reloadPluginsOnEngineRestart: true },
      plugins: {
        observer: (api) => class extends api.Plugin {
          override async onload(): Promise<void> { onloadCount += 1; }
        },
      },
    });
    await harness.lifecycle.start();
    await harness.restartEngine({ generation: 40, vault: { "A.md": "# A\n" } });
    expect(onloadCount).toBe(2);
  });
});
```

- [ ] **Step 8: Run, implement, observe it pass**

Run `npm --prefix host test -- lifecycle-restart`, implement `onEngineRestart` over `Mirror.synthesizeDiff`, re-run. Expected: both cases pass. Run all three lifecycle files ten times.

- [ ] **Step 9: Commit**

```bash
git add host/packages/host/src/runtime/lifecycle.ts host/packages/host/test
git commit -m "feat(host): sequence plugin startup, late enable, and restart continuity"
```

---

### Task 16a: The host protocol server — core operations

**Why this is 16a and not 16.** v1's Task 16 took `broker`, `pluginConfig`, and `detector` in its `HostServerDeps` — all three produced in Tasks 17, 18, and 20, *after* it. Four ops (`attach_interaction`, `respond_interaction`, `get_plugin_config`, `compat_report`) genuinely cannot be built before their services exist. So the server splits: **16a** builds the socket, the security gate, the dispatch table, the forwarding rule, the mirror-served snapshots, the harvest ops, and the plugin ops — everything whose dependencies are already produced — and **Task 20b**, placed after 18 and 20, adds the four ops that were the forward references. The wire contract below is complete and pinned here; 20b implements the rows it marks, and neither task re-decides a shape.

**Files:**

- Create: `host/packages/host/src/server/wire.ts`
- Create: `host/packages/host/src/server/server.ts`
- Create: `host/packages/host/src/server/ops.ts`
- Create: `host/packages/host/src/server/subscriptions.ts`
- Create: `host/packages/host/src/server/snapshot.ts`
- Create: `docs/protocol-host.md`
- Create: `host/packages/host/test/server-ops.test.ts`
- Create: `host/packages/host/test/server-security.test.ts`
- Create: `host/packages/host/test/server-subscriptions.test.ts`
- Create: `host/packages/host/test/server-wire.test.ts`
- Create: `host/packages/host/test/server-uid.manual.test.ts`

#### The `host.*` wire contract, pinned

Same envelope as `vaultd`, because a client that already speaks one should not learn a second grammar. Requests: `{ "version": 1, "id": "<string>", "request": { "method": "<name>", "params": { … } } }`. Responses: `{ "version": 1, "id": "<string>", "outcome": { "status": "ok", "value": { "type": "<name>", "value": { … } } } }` or `{ "status": "err", "value": { "code": "<snake_case>", "message": "…" } }`. Events: `{ "version": 1, "subscription_id": "<string>", "event": { "type": "<name>", "value": { … } } }`. One JSON object per line, UTF-8, over a Unix stream socket.

**Multiplexing rule:** a method that does **not** begin with `host.` is forwarded verbatim to `vaultd` and its outcome relayed unchanged — so `get_note`, `write_note`, `list_notes` and every future daemon op work through the host with no host-side maintenance. The four snapshot ops are the exception: they are answered from the mirror (Ruling 5), so a client needs one connection rather than two.

**Every field name below is `snake_case`, without exception** (Global Constraints). `src/server/wire.ts` owns the conversion from the internal `camelCase` types, and `server-wire.test.ts` asserts it for every shape that crosses the socket. The **Task** column says which task implements the row.

| Method | Params | Result | Task |
|---|---|---|---:|
| `host.hello` | `{ nonce }` | `{ host_version, protocol_version, vault_root, config_dir, phase, generation, live_state, dry_run, plugins: PluginStateWire[] }` | 16a |
| `host.info` | `{ refresh?: bool }` | `{ plugins, timers, overlap, counters, unsupported }` | 16a |
| `host.list_plugins` | `{}` | `{ plugins: PluginStateWire[] }` | 16a |
| `host.enable_plugin` | `{ id, force_shared?: bool }` | `{ id, state }` | 16a |
| `host.disable_plugin` | `{ id }` | `{ id, state }` | 16a |
| `host.list_commands` | `{ plugin_id?: string }` | `{ commands: HarvestedCommandWire[] }` | 16a |
| `host.invoke_command` | `{ command_id, active_file?: string, selection?: string }` | `{ command_id, ran: bool, generation, notices: string[] }` | 16a |
| `host.list_menu_items` | `{ context: "file-menu" \| "editor-menu", path }` | `{ items: HarvestedMenuItemWire[] }` | 16a |
| `host.invoke_menu_item` | `{ item_id, path }` | `{ item_id, generation, notices: string[] }` | 16a |
| `host.list_protocol_handlers` | `{}` | `{ handlers: { plugin_id, action }[] }` | 16a |
| `host.invoke_protocol` | `{ action, params: Record<string,string> }` | `{ action, generation, notices: string[] }` | 16a |
| `host.subscribe` | `{}` | `{ subscription_id, generation }` | 16a |
| `host.unsubscribe` | `{ subscription_id }` | `{ subscription_id }` | 16a |
| `host.open_snapshot` | `{}` | `{ snapshot_id, generation, note_count, entry_count }` | 16a |
| `host.snapshot_tree` | `{ snapshot_id, cursor, limit? }` | `{ snapshot_id, generation, entries, next_cursor }` | 16a |
| `host.snapshot_notes` | `{ snapshot_id, cursor, limit?, include? }` | `{ snapshot_id, generation, notes, next_cursor }` | 16a |
| `host.close_snapshot` | `{ snapshot_id }` | `{ snapshot_id }` | 16a |
| `host.get_plugin_config` | `{ id, reveal_secrets?: bool }` | `{ id, values, schema: { source, items }, redacted_keys, state_keys }` | **20b** |
| `host.set_plugin_config` | `{ id, patch: Record<string, unknown> }` | `{ id, applied: string[], refused: { key, reason }[] }` | **20b** |
| `host.compat_report` | `{ plugin_id?: string }` | `{ report: CompatReport }` | **20b** |
| `host.attach_interaction` | `{}` | `{ attached: bool }` | **20b** |
| `host.detach_interaction` | `{}` | `{ attached: bool }` | **20b** |
| `host.respond_interaction` | `{ prompt_id, choice_index?: number, value?: string, cancelled?: bool }` | `{ prompt_id }` | **20b** |

Two of those rows changed shape from v1 and both changes are corrections, not preferences. `host.hello` takes **`{ nonce }`**, not `{}` — the nonce is the whole authentication gate described below, and a table saying `{}` while the security test sends a nonce is a contract document that lies. And the two snapshot pages answer **`entries`** and **`notes`**, matching `vaultd`'s own `SnapshotTreeResponse`/`SnapshotNotesResponse`, because Ruling 5's point is that a client pages the host exactly as it would page the daemon; renaming the field would force every client to branch on which door it came through.

Host events: `host.plugin_state_changed { id, state, reason }`, `host.notice { plugin_id, message, at_unix_ms }`, `host.interaction_request { prompt_id, plugin_id, kind, prompt, items, timeout_ms }` (emitted by 20b), `host.overlap_changed { overlap, gui_enabled }`, plus the relayed daemon events `generation_committed`, `runtime_state_changed`, `resync_required`, and `config_changed` carrying their `vaultd` payloads unchanged.

Host error codes, additive to `vaultd`'s: `host_not_ready`, `plugin_not_found`, `plugin_not_installed`, `plugin_quarantined`, `command_not_found`, `menu_item_not_found`, `protocol_handler_not_found`, `headless_unsupported`, `overlap_refused`, `config_key_refused`, `interaction_unavailable`, `interaction_timeout`, `dry_run_refused`, `not_owner`, `snapshot_not_found`.

**Interfaces:**

```ts
/** Internal. `src/server/wire.ts` converts to PluginStateWire at the socket. */
export interface PluginState {
  id: string; name: string; version: string;
  state: "loaded" | "disabled" | "failed" | "quarantined";
  loadMs: number | null; failureCount: number; reason: string | null;
}
/** On the wire. Every key snake_case; nothing mixed. */
export interface PluginStateWire {
  id: string; name: string; version: string;
  state: "loaded" | "disabled" | "failed" | "quarantined";
  load_ms: number | null; failure_count: number; reason: string | null;
}

export interface HarvestedCommandWire {
  plugin_id: string; id: string; local_id: string; name: string;
  icon: string | null; kind: string;
  hotkeys: Array<{ modifiers: string[]; key: string }>;
}
export interface HarvestedMenuItemWire {
  hook_id: string; plugin_id: string; id: string; title: string;
  icon: string | null; section: string | null; checked: boolean | null;
}

/** The whole conversion surface, in one module, tested exhaustively. */
export function toWirePluginState(state: PluginState): PluginStateWire;
export function toWireCommand(command: HarvestedCommand): HarvestedCommandWire;
export function toWireMenuItem(item: HarvestedMenuItem): HarvestedMenuItemWire;
export function toWireOverlap(report: OverlapReport): {
  host_enabled: string[]; gui_enabled: string[]; overlap: string[];
  forced: string[]; gui_readable: boolean; checked_at_ms: number;
};
export function toWireTreeEntry(entry: MirrorEntry): TreeEntryDto;

/** 16a's dependency set — every member is produced by an earlier task. */
export interface HostServerDeps {
  config: HostConfig; lifecycle: LifecycleSequencer; harvest: Harvest;
  mirror: Mirror; client: VaultdClient; quarantine: QuarantineTracker;
  coexistence: CoexistenceMonitor; noticeLog: NoticeLog; app: App;
}
/** 20b adds these three, as a second object rather than by widening the first. */
export interface HostServerWiring {
  broker: InteractionBroker; pluginConfig: PluginConfigService; detector: Detector;
}
export class HostServer {
  constructor(deps: HostServerDeps);
  /** Called by Task 20b once the three late services exist. Until then those
   *  four ops answer `host_not_ready`, which is a real, typed, documented
   *  state — not a crash and not a missing method. */
  attachWiring(wiring: HostServerWiring): void;
  listen(): Promise<string>;   // resolves with the socket path
  clientCount(): number;
  broadcast(event: { type: string; value: unknown }): void;
  close(): Promise<void>;
}
```

**Socket security, stated exactly because the trust model depends on it — and stated in the right order, because v1 implied the three layers were equals.**

**The enforcement layer is the directory mode.** The socket lives inside a directory the host creates with `mkdir(mode 0o700)`; at startup the host `stat`s it and refuses to listen unless the mode is exactly `0o700` and the owner is `process.getuid()`. A `0700` directory is what actually stops another user reaching the socket at all, on every Unix, because traversal requires execute permission on the directory. This is the layer the trust model rests on.

**The socket mode is defense in depth.** Immediately after `listen`, the socket file is `chmod`ed to `0o600` and `stat`ed to confirm. It is worth doing and it is worth asserting, but it is not what is holding the door: **Darwin (and the BSDs) historically ignore permission bits on `AF_UNIX` sockets at `connect()` time**, so a `0600` socket in a world-traversable directory is not, by itself, access control on macOS — which is the platform this host is developed on. Say so in `docs/protocol-host.md` rather than letting a reader infer protection that the kernel may not provide.

**The nonce is the application-level gate, and it is a substitute, not a supplement.** Node exposes no portable `SO_PEERCRED`/`LOCAL_PEERCRED` accessor without a native addon, so a peer-UID check is not available. Instead, the first line on any accepted connection must be `host.hello` carrying the host's ownership nonce — a 32-byte random value written to `<socketDir>/nonce` with mode `0o600` at startup. Only a process that can read a `0600` file owned by this user can produce it, which admits the same process set a UID check would, root excepted (and a root peer is already past every boundary the host has). Anything else is refused with `not_owner` and the socket is destroyed.

The honest summary, which belongs verbatim in the protocol document: **directory `0700` enforces, socket `0600` is defense in depth and may be advisory on Darwin, the nonce is the portable stand-in for the peer-UID check Node cannot make.**

- [ ] **Step 1: Write the failing security test**

Create `host/packages/host/test/server-security.test.ts`:

```ts
import { connect } from "node:net";
import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

const speak = (path: string, line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) { socket.destroy(); resolve(buffer.slice(0, newline)); }
    });
    socket.on("close", () => { if (!buffer.includes("\n")) resolve(buffer); });
    socket.on("error", reject);
  });

describe("host socket security", () => {
  it("asserts 0700 on the directory and 0600 on the socket", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    const socketPath = await harness.server.listen();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(require("node:path").dirname(socketPath)).mode & 0o777).toBe(0o700);
    await harness.server.close();
  });

  it("refuses to listen when the socket directory is group-writable", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    harness.chmodSocketDir(0o770);
    await expect(harness.server.listen()).rejects.toThrow(/socket directory mode/);
  });

  it("refuses a connection that cannot present the ownership nonce", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    const socketPath = await harness.server.listen();
    const reply = await speak(socketPath, JSON.stringify({
      version: 1, id: "x", request: { method: "host.hello", params: { nonce: "wrong" } },
    }));
    expect(JSON.parse(reply)).toMatchObject({
      outcome: { status: "err", value: { code: "not_owner" } },
    });
    expect(harness.server.clientCount()).toBe(0);
    await harness.server.close();
  });

  it("refuses any op before hello", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    const socketPath = await harness.server.listen();
    const reply = await speak(socketPath, JSON.stringify({
      version: 1, id: "x", request: { method: "host.list_commands", params: {} },
    }));
    expect(JSON.parse(reply)).toMatchObject({
      outcome: { status: "err", value: { code: "not_owner" } },
    });
    await harness.server.close();
  });

  it("admits a connection presenting the nonce from the 0600 file", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    const socketPath = await harness.server.listen();
    expect(statSync(harness.noncePath()).mode & 0o777).toBe(0o600);
    const reply = await speak(socketPath, JSON.stringify({
      version: 1, id: "x", request: { method: "host.hello", params: { nonce: harness.readNonce() } },
    }));
    expect(JSON.parse(reply)).toMatchObject({
      outcome: { status: "ok", value: { type: "host.hello" } },
    });
    await harness.server.close();
  });
});
```

Note what the second case is really asserting: the host refuses to listen when the **directory** is group-writable, because the directory mode is the layer that enforces. Step 11 adds the manual cross-UID half.

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- server-security
```

Expected: cannot resolve `../src/server/server`.

- [ ] **Step 3: Implement the socket, the mode assertions, and the nonce gate**

Create `server.ts`. `listen()` ensures the socket directory, `stat`s it, unlinks a stale socket, listens, `chmod`s to `0o600`, `stat`s again, writes the nonce with `{ mode: 0o600 }`, and resolves. Every connection starts in state `unauthenticated`; the only accepted method in that state is `host.hello` with a matching nonce, and anything else answers `not_owner` and destroys the socket.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- server-security
```

Expected: five cases pass.

- [ ] **Step 5: Write the failing ops test**

Create `host/packages/host/test/server-ops.test.ts` driving a real client over the real socket:

```ts
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

describe("host.* operations", () => {
  it("lists and invokes a harvested command, reporting notices", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["demo"],
      plugins: {
        demo: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({
              id: "shout", name: "Shout", icon: "megaphone",
              callback: () => { new api.Notice("shouted"); },
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    // snake_case on the wire, without exception. `pluginId`/`localId` are the
    // internal spellings and never leave the process; wire.ts converts.
    await expect(client.call("host.list_commands", {})).resolves.toEqual({
      commands: [{
        plugin_id: "demo", id: "demo:shout", local_id: "shout", name: "Shout",
        icon: "megaphone", kind: "callback", hotkeys: [],
      }],
    });
    const invoked = await client.call<{ ran: boolean; notices: string[] }>(
      "host.invoke_command", { command_id: "demo:shout" },
    );
    expect(invoked.ran).toBe(true);
    expect(invoked.notices).toEqual(["shouted"]);
  });

  it("sets the active file for an editorCallback command", async () => {
    const seen: string[] = [];
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: ["demo"],
      plugins: {
        demo: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({
              id: "edit", name: "Edit",
              editorCallback: (editor) => { seen.push(editor.getValue()); },
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    await client.call("host.invoke_command", { command_id: "demo:edit", active_file: "A.md" });
    expect(seen).toEqual(["# A\n"]);
  });

  it("refuses a quarantined plugin's command with a typed code", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["demo"],
      plugins: {
        demo: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "boom", name: "Boom", callback: () => { throw new Error("nope"); } });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    for (let i = 0; i < 5; i += 1) {
      await client.call("host.invoke_command", { command_id: "demo:boom" }).catch(() => undefined);
    }
    await expect(client.call("host.invoke_command", { command_id: "demo:boom" }))
      .rejects.toMatchObject({ code: "plugin_quarantined" });
    await expect(client.call("host.list_commands", {})).resolves.toEqual({ commands: [] });
  });

  it("forwards a non-host method to vaultd verbatim", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    const result = await client.call<{ generation: number }>("get_vault_info", undefined);
    expect(result.generation).toBe(harness.mirror.generation());
    expect(harness.daemonMethodsSeen()).toContain("get_vault_info");
  });

  it("serves snapshot pages from the mirror without touching the daemon", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n", "Folder/B.md": "# B\n" }, enabled: [],
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    harness.clearDaemonMethodLog();
    const opened = await client.call<{ snapshot_id: string; entry_count: number }>("host.open_snapshot", {});
    expect(opened.entry_count).toBe(3);
    // `entries`, matching vaultd's own SnapshotTreeResponse — a client pages
    // the host exactly as it pages the daemon (Ruling 5).
    const page = await client.call<{ entries: Array<{ path: string }>; next_cursor: string | null }>(
      "host.snapshot_tree", { snapshot_id: opened.snapshot_id, cursor: null, limit: 2 },
    );
    expect(page.entries.map((entry) => entry.path)).toEqual(["A.md", "Folder"]);
    expect(page.entries[0]).toMatchObject({
      kind: "note", ctime_unix_ms: expect.any(Number), mtime_unix_ms: expect.any(Number),
    });
    expect(page.next_cursor).not.toBeNull();
    const notes = await client.call<{ notes: Array<{ path: string; sections?: unknown[] }> }>(
      "host.snapshot_notes",
      { snapshot_id: opened.snapshot_id, cursor: null, limit: 10, include: ["metadata", "sections"] },
    );
    // sections is a TOP-LEVEL facet, never nested inside metadata.
    expect(notes.notes[0]?.sections).toBeDefined();
    expect((notes.notes[0] as { metadata?: { sections?: unknown } }).metadata?.sections).toBeUndefined();
    await client.call("host.close_snapshot", { snapshot_id: opened.snapshot_id });
    expect(harness.daemonMethodsSeen()).toEqual([]);
  });

  it("answers host_not_ready for the ops Task 20b wires, until it does", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [], config: { wireLateOps: false } });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    for (const method of [
      "host.attach_interaction", "host.detach_interaction",
      "host.get_plugin_config", "host.compat_report",
    ]) {
      await expect(client.call(method, { id: "demo" }))
        .rejects.toMatchObject({ code: "host_not_ready" });
    }
  });

  it("returns typed errors for unknown ids", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    await expect(client.call("host.invoke_command", { command_id: "nope:nope" }))
      .rejects.toMatchObject({ code: "command_not_found" });
    await expect(client.call("host.enable_plugin", { id: "not-installed" }))
      .rejects.toMatchObject({ code: "plugin_not_installed" });
    await expect(client.call("host.snapshot_tree", { snapshot_id: "gone", cursor: null }))
      .rejects.toMatchObject({ code: "snapshot_not_found" });
  });
});
```

- [ ] **Step 6: Run it and observe the missing module**

```bash
npm --prefix host test -- server-ops
```

Expected: cannot resolve `../src/server/ops`.

- [ ] **Step 7: Implement the dispatch table and the mirror-served snapshots**

Implement `ops.ts` as a `Record<string, (params, session) => Promise<unknown>>`; a method absent from the record and not starting with `host.` is forwarded verbatim to `vaultd` and its outcome relayed unchanged, so every future daemon op works through the host with no host-side maintenance. A `host.`-prefixed method absent from the record answers `invalid_request`. The four ops Task 20b owns are present in the record from the start, each answering `host_not_ready` until `attachWiring` supplies their service — a typed, documented state rather than a missing method.

Implement `snapshot.ts` over the mirror: `open` freezes the entry array and the note list at the current generation and mints an id; the cursor is the index, encoded so it is opaque; `close` drops it; an id that is unknown or closed answers `snapshot_not_found`; and a page whose pinned generation no longer matches the mirror's answers `generation_mismatch`, exactly as `vaultd` does, so a client's retry logic is identical through either door. Concurrent sessions are capped at `config.snapshotSessionCap` (default 8) and the cap answers `too_many_snapshots` — the same code the daemon uses for the same condition.

Re-run `npm --prefix host test -- server-ops`; expected: eight cases pass.

- [ ] **Step 8: Write the failing multi-client subscription test**

Create `host/packages/host/test/server-subscriptions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

describe("host subscriptions", () => {
  it("delivers one generation_committed to each of two connected clients", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    await harness.lifecycle.start();
    await harness.server.listen();
    const first = await harness.connectClient();
    const second = await harness.connectClient();
    const firstSub = await first.call<{ subscription_id: string; generation: number }>("host.subscribe", {});
    const secondSub = await second.call<{ subscription_id: string }>("host.subscribe", {});
    expect(firstSub.subscription_id).not.toBe(secondSub.subscription_id);
    expect(firstSub.generation).toBe(harness.mirror.generation());
    expect(harness.server.clientCount()).toBe(2);

    const firstEvent = first.nextEvent("generation_committed");
    const secondEvent = second.nextEvent("generation_committed");
    await harness.commitGeneration({ modified: ["A.md"] });

    for (const event of await Promise.all([firstEvent, secondEvent])) {
      expect(event).toMatchObject({
        generation: harness.mirror.generation(),
        changes: { kind: "detailed", modified: ["A.md"] },
      });
    }
    await first.disconnect();
    await second.disconnect();
    await harness.server.close();
  });

  it("gives one client two subscription ids and two deliveries", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    await harness.lifecycle.start();
    await harness.server.listen();
    const client = await harness.connectClient();
    const a = await client.call<{ subscription_id: string }>("host.subscribe", {});
    const b = await client.call<{ subscription_id: string }>("host.subscribe", {});
    expect(a.subscription_id).not.toBe(b.subscription_id);

    const delivered: string[] = [];
    client.onEvent((envelope) => {
      if (envelope.event.type === "generation_committed") delivered.push(envelope.subscription_id);
    });
    await harness.commitGeneration({ modified: ["A.md"] });
    await client.quiesce();
    expect(delivered.sort()).toEqual([a.subscription_id, b.subscription_id].sort());
    await client.disconnect();
    await harness.server.close();
  });

  it("drops a disconnected client's subscription without disturbing the other", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    await harness.lifecycle.start();
    await harness.server.listen();
    const leaving = await harness.connectClient();
    const staying = await harness.connectClient();
    await leaving.call("host.subscribe", {});
    await staying.call("host.subscribe", {});
    await leaving.disconnect();
    await harness.serverQuiesce();
    expect(harness.server.clientCount()).toBe(1);

    const event = staying.nextEvent("generation_committed");
    // Must not throw on the write to the dead socket, and must still deliver.
    await expect(harness.commitGeneration({ modified: ["A.md"] })).resolves.toBeUndefined();
    await expect(event).resolves.toMatchObject({ generation: harness.mirror.generation() });
    await staying.disconnect();
    await harness.server.close();
  });

  it("collapses a lagging subscriber to one resync_required and no partial detail", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: [],
      config: { subscriberQueueLimit: 64 },
    });
    await harness.lifecycle.start();
    await harness.server.listen();
    const client = await harness.connectClient({ stalled: true });   // reads nothing
    await client.call("host.subscribe", {});

    for (let i = 0; i < 200; i += 1) {
      await harness.commitGeneration({ modified: ["A.md"] });
    }
    client.resume();
    const events = await client.drainEvents();

    const resyncs = events.filter((event) => event.type === "resync_required");
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]).toMatchObject({
      value: { reason: "subscriber_lag", current_generation: harness.mirror.generation() },
    });
    // Bounded queue, and never a truncated change set pretending to be whole.
    expect(events.filter((event) => event.type === "generation_committed").length)
      .toBeLessThanOrEqual(64);
    await client.disconnect();
    await harness.server.close();
  });

  it("stops delivering after unsubscribe", async () => {
    const harness = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    await harness.lifecycle.start();
    await harness.server.listen();
    const client = await harness.connectClient();
    const sub = await client.call<{ subscription_id: string }>("host.subscribe", {});
    const seen: string[] = [];
    client.onEvent((envelope) => seen.push(envelope.event.type));
    await expect(client.call("host.unsubscribe", { subscription_id: sub.subscription_id }))
      .resolves.toEqual({ subscription_id: sub.subscription_id });
    seen.length = 0;
    await harness.commitGeneration({ modified: ["A.md"] });
    await client.quiesce();
    expect(seen).toEqual([]);
    await expect(client.call("host.unsubscribe", { subscription_id: "gone" }))
      .rejects.toMatchObject({ code: "subscription_not_found" });
    await client.disconnect();
    await harness.server.close();
  });
});
```

`connectClient({ stalled: true })` opens a socket and does not read from it, so the kernel buffer fills and the server's per-subscription queue is what backs up — the only way to exercise the bounded queue honestly. `resume()` starts reading; `drainEvents()` resolves once the socket goes quiet. Neither sleeps.

- [ ] **Step 9: Run it, implement `subscriptions.ts`, observe it pass**

```bash
npm --prefix host test -- server-subscriptions
```

Expected first: cannot resolve `../src/server/subscriptions`. Implement it as a per-client `Map<subscriptionId, { queue, dropped }>` with the same bounded-queue and drop-marker discipline `vaultd`'s own registry uses — enqueue up to `config.subscriberQueueLimit`, then set a `dropped` flag, discard further events for that subscription, and on the next flush emit one `resync_required { reason: "subscriber_lag", current_generation }` in place of everything dropped. Reimplemented here rather than reinvented: the shape a subscriber must handle is identical through either door. Re-run; expected: five cases pass. Run ten times.

- [ ] **Step 10: Write and pass the wire-casing test**

Create `host/packages/host/test/server-wire.test.ts` asserting, for each of `toWirePluginState`, `toWireCommand`, `toWireMenuItem`, `toWireOverlap`, and `toWireTreeEntry`: the output's key set is exactly the expected `snake_case` set, and **no key anywhere in the output matches `/[a-z][A-Z]/`**. Add one case that walks a live `host.info` response recursively and asserts the same predicate over every key at every depth — that is the one that catches a field somebody adds later and forgets to convert.

```ts
const noCamelCase = (value: unknown, path = "$"): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => noCamelCase(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(key, `${path}.${key}`).not.toMatch(/[a-z][A-Z]/);
    noCamelCase(child, `${path}.${key}`);
  }
};
```

- [ ] **Step 11: Write the manual cross-UID test**

A genuine cross-UID test needs a second UID and cannot run unattended. Create `host/packages/host/test/server-uid.manual.test.ts`, `describe.skipIf(!process.env["VAULTD_HOST_UID_TEST"])`, which `sudo -u nobody` runs a client against the live socket and asserts `EACCES` at connect — proving the `0700` **directory** is doing the work, which is the layer that actually enforces. Document in `docs/protocol-host.md` that this is the manual half of the security assertion and that the socket's own `0600` mode may be advisory on Darwin.

- [ ] **Step 12: Write the wire contract document**

Create `docs/protocol-host.md` containing the table above, one request/response JSON example per op copied from the passing tests, the event shapes, the error-code list, the three-layer socket security paragraph in its stated order (directory enforces, socket mode is defense in depth, nonce substitutes for the peer-UID check), and the manual cross-UID procedure. This is a contract document, so every example in it must be an example a test actually exercises. Mark the six Task-20b rows as "wired in 20b" until that task lands.

- [ ] **Step 13: Commit**

```bash
git add host/packages/host/src/server host/packages/host/test docs/protocol-host.md
git commit -m "feat(host): serve harvested capabilities over a multi-client unix socket"
```

---

### Task 17: Config machinery — the schema ladder and safe writes

**Files:**

- **Activate** `src/testing/pending/settings-harness.ts` → `src/testing/settings-harness.ts` (`git mv`), per Task 6b.
- Create: `host/packages/host/src/settings/ladder.ts`
- Create: `host/packages/host/src/settings/key-registry.json`
- Create: `host/packages/host/src/settings/plugin-config.ts`
- Create: `host/packages/host/test/settings-ladder.test.ts`
- Create: `host/packages/host/test/settings-safety.test.ts`

**Interfaces:**

```ts
export type SchemaSource = "definitions" | "descriptors" | "types" | "llm" | "none";
export interface SchemaItem {
  key: string;
  control: "toggle" | "dropdown" | "text" | "textarea" | "number" | "file" | "folder" | "slider" | "color" | "unknown";
  name?: string; description?: string;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
}
export interface CachedSchema {
  pluginId: string; pluginVersion: string; source: SchemaSource;
  items: SchemaItem[]; capturedAtUnixMs: number;
}
export class SchemaLadder {
  constructor(dataDir: string);
  read(pluginId: string, pluginVersion: string): CachedSchema | null;
  write(schema: CachedSchema): void;
  climb(plugin: Plugin, manifest: PluginManifest): CachedSchema;  // rungs 1-3 only
}
export interface KeyRegistryEntry { state_keys: string[]; secret_keys: string[] }
export type KeyRegistry = Record<string, KeyRegistryEntry>;
export class PluginConfigService {
  constructor(dir: HeadlessConfigDir, ladder: SchemaLadder, registry: KeyRegistry, config: HostConfig);
  get(id: string, revealSecrets: boolean): Promise<{
    values: Record<string, unknown>; schema: CachedSchema;
    redacted_keys: string[]; state_keys: string[];
  }>;
  set(id: string, patch: Record<string, unknown>): Promise<{
    applied: string[]; refused: Array<{ key: string; reason: "state_key" | "unknown_key" | "type_mismatch" }>;
  }>;
}
```

- **How the ladder reaches the tab, which v1 left dangling.** `climb(plugin, manifest)` needs the live `PluginSettingTab` the plugin passed to `addSettingTab`, and nothing but the harvest holds a reference to it — the tab is constructed inside `onload`, handed over, and dropped. So `HarvestedSettingTab` carries `tab: PluginSettingTab` (Task 10), and rung 1 is `harvest.settingTabs().find(entry => entry.pluginId === manifest.id)?.tab`. A plugin that registered no settings tab has no rung-1 candidate and falls straight to rung 2. The `tab` reference never crosses the socket: `src/server/wire.ts` sends `{ plugin_id, has_setting_definitions }` and nothing else, so a live object with a reference to the whole `App` cannot leak into a client's JSON.

- **Rung boundaries, exactly.** Rung 1 calls `settingTab.getSettingDefinitions()` when the method exists **and** returns items carrying `control.key` — the degenerate case (tasknotes and tasknotes-workflows return one opaque item whose `render` calls the old renderer) is detected by the missing `control.key` and demoted, not trusted. Rung 2 reads a plugin's own field-descriptor array when the bundle exposes one under a recognized name (`SETTINGS_CATALOG`, `settingsDefinitions`, `configFields`) with entries carrying `key` plus a control-ish field. Rung 3 extracts keys and defaults from a typed `DEFAULT_SETTINGS` object the bundle exports. Rungs 1–3 run inside the **Detector** (Task 20) and write `<dataDir>/schema/<pluginId>@<version>.json`. Rung 4 (LLM introspection) is an offline tool that is never invoked at runtime and emits the same file format, so runtime behavior is deterministic no matter which rung produced the artifact. `get_plugin_config` serves the cached file and tags it with `source`. `display()` is never executed — the research measured it as weaker than reading source in every sampled case, and governor's `display()` spawns the `claude` CLI, which would hang a headless harness.
- **The key registry** is a JSON data file in the host repo keyed by plugin id, seeded from the research's config census, PR-able per plugin (Ruling 8). Seed contents, from the census: `tasknotes` state `["pomodoroState","googleCalendarSyncQueue","lastSyncCursor","migrations"]` secret `["apiAuthToken","googleCalendarSyncTokens","microsoftCalendarSyncTokens"]`; `obsidian42-brat` secret `["personalAccessToken"]`; `recent-files-obsidian` state `["recentFiles"]`; `settings-sidebar-organizer` state `["collapsedGroups","seenPlugins"]`; `breadcrumbs` state `["is_dirty","_bc_migrations"]`; `quickadd` state `["migrations"]`; `iconic`, `execute-code`, `folder-notes` state `["lastOpenTab"]`; `forge`, `governor`, `obsidian42-brat` state their one-shot flags. Secret detection is registry-first with a name-shaped fallback (`/token|secret|password|apikey|api_key|credential/i`); the fallback only ever **adds** redaction, never removes it.
- **Write safety:** `set` refuses any key in `state_keys`, any key the schema does not know when the schema `source` is not `"none"`, and any value whose type contradicts the schema's control. Refusals are reported per key with a reason; the applied keys are written in one `write_file` of the whole `data.json`, preserving every key the patch did not mention. After writing, `onExternalSettingsChange()` is called on the loaded plugin if it defines one — Obsidian's own signal for "your data.json changed underneath you".

- [ ] **Step 1: Write the failing ladder test**

Create `host/packages/host/test/settings-ladder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SchemaLadder } from "../src/settings/ladder";
import { SettingsHarness } from "../src/testing/settings-harness";

describe("SchemaLadder", () => {
  it("rung 1: reads getSettingDefinitions when items carry control.key", async () => {
    const harness = await SettingsHarness.withTab({
      getSettingDefinitions: () => [
        { control: { key: "enabled", type: "toggle" }, defaultValue: true, name: "Enabled" },
        { control: { key: "count", type: "number" }, defaultValue: 3, name: "Count" },
      ],
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("definitions");
    expect(schema.items).toEqual([
      { key: "enabled", control: "toggle", name: "Enabled", defaultValue: true },
      { key: "count", control: "number", name: "Count", defaultValue: 3 },
    ]);
  });

  it("rung 1 demotes a degenerate implementation with no control.key", async () => {
    const harness = await SettingsHarness.withTab({
      getSettingDefinitions: () => [{ render: () => {} }],
      moduleExports: { DEFAULT_SETTINGS: { enabled: false, label: "x" } },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("types");
    expect(schema.items.map((i) => i.key).sort()).toEqual(["enabled", "label"]);
  });

  it("rung 2: reads a descriptor array", async () => {
    const harness = await SettingsHarness.withTab({
      moduleExports: {
        SETTINGS_CATALOG: [
          { key: "endpoint", control: "text", name: "Endpoint", description: "Where to call" },
          { key: "mode", control: "dropdown", options: [{ value: "a", label: "A" }] },
        ],
      },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("descriptors");
    expect(schema.items[0]).toEqual({
      key: "endpoint", control: "text", name: "Endpoint", description: "Where to call",
    });
  });

  it("rung 3: falls back to DEFAULT_SETTINGS keys and defaults", async () => {
    const harness = await SettingsHarness.withTab({
      moduleExports: { DEFAULT_SETTINGS: { alpha: 1, beta: "two", gamma: false } },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("types");
    expect(schema.items).toEqual([
      { key: "alpha", control: "number", defaultValue: 1 },
      { key: "beta", control: "text", defaultValue: "two" },
      { key: "gamma", control: "toggle", defaultValue: false },
    ]);
  });

  it("reports source none when no rung applies, and never calls display()", async () => {
    let displayCalls = 0;
    const harness = await SettingsHarness.withTab({ display: () => { displayCalls += 1; } });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    expect(schema.source).toBe("none");
    expect(schema.items).toEqual([]);
    expect(displayCalls).toBe(0);
  });

  it("caches to disk keyed by plugin version", async () => {
    const harness = await SettingsHarness.withTab({
      moduleExports: { DEFAULT_SETTINGS: { alpha: 1 } },
    });
    const schema = harness.ladder.climb(harness.plugin, harness.manifest);
    harness.ladder.write(schema);
    const reread = new SchemaLadder(harness.dataDir).read(harness.manifest.id, harness.manifest.version);
    expect(reread).toEqual(schema);
    expect(new SchemaLadder(harness.dataDir).read(harness.manifest.id, "9.9.9")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- settings-ladder
```

Expected: cannot resolve `../src/settings/ladder`.

- [ ] **Step 3: Implement the three rungs and the disk cache**

`climb` tries rung 1 (`harvest.settingTabs()` → `tab.getSettingDefinitions()`, accepted only when every returned item carries `control.key`), then rung 2 (the bundle's `SETTINGS_CATALOG` / `settingsDefinitions` / `configFields` export, accepted when entries carry `key` plus a control-ish field), then rung 3 (`DEFAULT_SETTINGS`, control inferred from the default's JS type), then `source: "none"`. `read`/`write` use `DataDir.readJson`/`writeJson` at `schema/<pluginId>@<version>.json`, so a version bump is a cache miss by construction and there is no invalidation logic to get wrong. `display()` is never called — the research measured it as weaker than reading source in every sampled case, and governor's `display()` spawns the `claude` CLI, which would hang a headless harness. Re-run; expected: six cases pass. The second case is the one that matters most: a ladder that trusts `getSettingDefinitions()` existing rather than its items carrying `control.key` reports a confident empty schema for tasknotes.

- [ ] **Step 4: Write the failing write-safety test**

Create `host/packages/host/test/settings-safety.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SettingsHarness } from "../src/testing/settings-harness";

describe("plugin config safety", () => {
  it("redacts secret-shaped keys by default and reveals them on request", async () => {
    const harness = await SettingsHarness.withData("tasknotes", {
      apiAuthToken: "s3cret", googleCalendarSyncTokens: { refresh: "r" },
      taskTag: "task", pomodoroState: { running: true },
    });
    const guarded = await harness.service.get("tasknotes", false);
    expect(guarded.values["apiAuthToken"]).toBe("[redacted]");
    expect(guarded.values["googleCalendarSyncTokens"]).toBe("[redacted]");
    expect(guarded.values["taskTag"]).toBe("task");
    expect(guarded.redacted_keys.sort()).toEqual(["apiAuthToken", "googleCalendarSyncTokens"]);
    expect(guarded.state_keys).toContain("pomodoroState");
    const revealed = await harness.service.get("tasknotes", true);
    expect(revealed.values["apiAuthToken"]).toBe("s3cret");
  });

  it("redacts a token-shaped key the registry does not list", async () => {
    const harness = await SettingsHarness.withData("unknown-plugin", {
      myServiceApiKey: "abc", label: "fine",
    });
    const guarded = await harness.service.get("unknown-plugin", false);
    expect(guarded.values["myServiceApiKey"]).toBe("[redacted]");
    expect(guarded.values["label"]).toBe("fine");
  });

  it("refuses a write to a registered state key and applies the rest", async () => {
    const harness = await SettingsHarness.withData("tasknotes", {
      pomodoroState: { running: true }, taskTag: "task",
    }, { schema: { source: "types", items: [
      { key: "taskTag", control: "text" }, { key: "pomodoroState", control: "unknown" },
    ] } });
    const result = await harness.service.set("tasknotes", {
      taskTag: "todo", pomodoroState: { running: false },
    });
    expect(result.applied).toEqual(["taskTag"]);
    expect(result.refused).toEqual([{ key: "pomodoroState", reason: "state_key" }]);
    expect(await harness.readData("tasknotes")).toEqual({
      pomodoroState: { running: true }, taskTag: "todo",
    });
  });

  it("refuses an unknown key when the schema is known", async () => {
    const harness = await SettingsHarness.withData("demo", { alpha: 1 }, {
      schema: { source: "definitions", items: [{ key: "alpha", control: "number" }] },
    });
    const result = await harness.service.set("demo", { alpha: 2, invented: true });
    expect(result.applied).toEqual(["alpha"]);
    expect(result.refused).toEqual([{ key: "invented", reason: "unknown_key" }]);
  });

  it("accepts an unknown key when the schema source is none", async () => {
    const harness = await SettingsHarness.withData("opaque", { alpha: 1 }, {
      schema: { source: "none", items: [] },
    });
    const result = await harness.service.set("opaque", { beta: 2 });
    expect(result.applied).toEqual(["beta"]);
    expect(result.refused).toEqual([]);
  });

  it("refuses a value whose type contradicts the control", async () => {
    const harness = await SettingsHarness.withData("demo", { flag: true }, {
      schema: { source: "definitions", items: [{ key: "flag", control: "toggle" }] },
    });
    const result = await harness.service.set("demo", { flag: "yes" });
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([{ key: "flag", reason: "type_mismatch" }]);
  });

  it("calls onExternalSettingsChange after a successful write", async () => {
    let notified = 0;
    const harness = await SettingsHarness.withData("demo", { alpha: 1 }, {
      schema: { source: "none", items: [] },
      onExternalSettingsChange: () => { notified += 1; },
    });
    await harness.service.set("demo", { alpha: 2 });
    expect(notified).toBe(1);
  });
});
```

- [ ] **Step 5: Run it and observe the missing module**

```bash
npm --prefix host test -- settings-safety
```

Expected: cannot resolve `../src/settings/plugin-config`.

- [ ] **Step 6: Seed the key registry and implement the config service**

Seed `key-registry.json` with the census entries listed above. Implement `plugin-config.ts`: `get` reads `data.json` through `HeadlessConfigDir`, redacts every key in `secret_keys` plus every key matching the name-shaped fallback, and reports `redacted_keys`/`state_keys` alongside the values. `set` classifies each patch key before touching anything — `state_key`, `unknown_key` (only when the schema `source` is not `"none"`), `type_mismatch` — then writes the surviving keys merged over the existing `data.json` in one `write_file`, preserving every key the patch did not mention. `onExternalSettingsChange()` is called on the loaded plugin after a successful write, through the `DispatchQueue`, because it is a plugin entry point like any other. Re-run; expected: seven cases pass.

- [ ] **Step 7: Commit**

```bash
git add host/packages/host/src/settings host/packages/host/test
git commit -m "feat(host): serve plugin configuration with a schema ladder and safe writes"
```

---

### Task 18: Interaction brokerage

> **Amended 2026-09-16 (RULING, Task 18, wiring and files).** This task's tests drive `host.attach_interaction`, `host.respond_interaction` and the `host.interaction_request` event over the wire, but 16a gated all six late ops behind one `attachWiring({ broker, pluginConfig, detector })` that Task 20b calls. The ruling: `HostServerWiring` is a partial that `attachWiring` merges, each late op answers `host_not_ready` naming its own missing service, and Task 18 wires the three interaction ops and the event itself; Task 20b keeps its attach/detach/respond cases as pins and wires the config service and the detector. Also: `Modal`, `SuggestModal` and `FuzzySuggestModal` already live in `shim/components.ts` (Tasks 10/11a), so there is no `shim/modals.ts` — `open()` changes in place — and `SuggestModal.open()` returns a promise that never surfaces an unhandled rejection, because real plugins do not await it.

**Files:**

- Create: `host/packages/host/src/interaction/broker.ts`
- Create: `host/packages/host/src/shim/modals.ts`
- Create: `host/packages/host/test/interaction.test.ts`

**Interfaces:**

```ts
export type PromptKind = "suggest" | "fuzzy_suggest" | "text" | "confirm";
export interface PromptRequest {
  readonly promptId: string;
  readonly pluginId: string;
  readonly kind: PromptKind;
  readonly prompt: string;
  readonly items: readonly string[];
  readonly timeoutMs: number;
}
export interface PromptAnswer {
  readonly choiceIndex?: number;
  readonly value?: string;
  readonly cancelled?: boolean;
}
export class InteractionBroker {
  constructor(config: HostConfig);   // reads promptTimeoutMs and clock
  attach(session: ClientSession): void;
  detach(session: ClientSession): void;
  attached(): boolean;
  ask(request: Omit<PromptRequest, "promptId" | "timeoutMs">): Promise<PromptAnswer>;
  answer(promptId: string, answer: PromptAnswer): boolean;
  pending(): readonly PromptRequest[];
}
export class InteractionUnavailable extends Error { readonly code = "interaction_unavailable" }
export class InteractionTimeout extends Error { readonly code = "interaction_timeout"; readonly promptId: string }
```

- **Scope, honestly.** Structural interception covers the `SuggestModal`/`FuzzySuggestModal` family — template-method classes where the base owns rendering and the subclass supplies `getItems`/`getItemText`/`getSuggestions`/`onChooseItem`/`onChooseSuggestion` — plus the shim's own prompt primitives. `SuggestModal.open()` therefore calls `getSuggestions("")` (or `getItems()` + `getItemText()` for the fuzzy variant), brokers the list, and invokes the choice handler with the item the client picked.
- **Bespoke `Modal.onOpen()` UIs are not interceptable and do not pretend to be.** `Modal.open()` throws `HeadlessUnsupported` naming the subclass. The research's QuickAdd `plugin.api` finding is the proof: `plugin.api` is a *getter* minting a fresh `ChoiceExecutor` with `interactive = true` on every read, so nothing can be injected through it — that path is permanently modal and belongs to per-plugin adapters, later.
- A prompt with no attached handler fails immediately with `interaction_unavailable`, never hangs. A prompt whose handler disconnects fails immediately. A prompt that exceeds `promptTimeoutMs` (120 s) fails with `interaction_timeout`. All three are typed errors the plugin sees as a rejected promise — the plugin's own error path, not a wedged process.

- [ ] **Step 1: Write the failing test**

Create `host/packages/host/test/interaction.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HeadlessUnsupported } from "../src/shim/policy";
import { HostHarness } from "../src/testing/host-harness";

describe("interaction brokerage", () => {
  it("round-trips a FuzzySuggestModal choice through an attached client", async () => {
    const chosen: string[] = [];
    const harness = await HostHarness.create({
      vault: {}, enabled: ["picker"],
      plugins: {
        picker: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({
              id: "pick", name: "Pick",
              // `open()` returns a promise that settles when the client
              // answers, so the callback must be async and must await it —
              // exactly like the interaction_unavailable case below. Without
              // the await, `host.invoke_command` resolves before the choice
              // arrives and the assertion on `chosen` races the broker.
              callback: async () => {
                class Picker extends api.FuzzySuggestModal {
                  override getItems(): string[] { return ["Alpha", "Beta", "Gamma"]; }
                  override getItemText(item: string): string { return item; }
                  override onChooseItem(item: string): void { chosen.push(item); }
                }
                await new Picker(this.app).open();
              },
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    await client.call("host.attach_interaction", {});
    const invoking = client.call("host.invoke_command", { command_id: "picker:pick" });
    const request = await client.nextEvent("host.interaction_request");
    expect(request).toMatchObject({
      plugin_id: "picker", kind: "fuzzy_suggest",
      items: ["Alpha", "Beta", "Gamma"], timeout_ms: 120000,
    });
    await client.call("host.respond_interaction", {
      prompt_id: (request as { prompt_id: string }).prompt_id, choice_index: 1,
    });
    await invoking;
    expect(chosen).toEqual(["Beta"]);
  });

  it("fails a prompt with interaction_unavailable when no client is attached", async () => {
    const errors: string[] = [];
    const harness = await HostHarness.create({
      vault: {}, enabled: ["picker"],
      plugins: {
        picker: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({
              id: "pick", name: "Pick",
              callback: async () => {
                class Picker extends api.SuggestModal {
                  override getSuggestions(): string[] { return ["only"]; }
                  override onChooseSuggestion(): void {}
                }
                try { await new Picker(this.app).open(); }
                catch (error) { errors.push((error as { code?: string }).code ?? "none"); }
              },
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    await client.call("host.invoke_command", { command_id: "picker:pick" });
    expect(errors).toEqual(["interaction_unavailable"]);
  });

  it("times out a prompt at 120 seconds without hanging the plugin", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["picker"], plugins: { picker: HostHarness.suggestPlugin },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    await client.call("host.attach_interaction", {});
    const invoking = client.call("host.invoke_command", { command_id: "picker:pick" });
    await client.nextEvent("host.interaction_request");
    await harness.advanceClock(120_000);
    await invoking;
    expect(harness.lastHandlerError("picker")?.message).toMatch(/interaction_timeout/);
    expect(harness.broker.pending()).toEqual([]);
  });

  it("fails a pending prompt when the handler disconnects", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["picker"], plugins: { picker: HostHarness.suggestPlugin },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    await client.call("host.attach_interaction", {});
    const invoking = client.call("host.invoke_command", { command_id: "picker:pick" }).catch(() => "gone");
    await client.nextEvent("host.interaction_request");
    await client.disconnect();
    await invoking;
    expect(harness.broker.attached()).toBe(false);
    expect(harness.broker.pending()).toEqual([]);
    expect(harness.lastHandlerError("picker")?.message).toMatch(/interaction_unavailable/);
  });

  it("throws typed for a bespoke Modal.onOpen UI", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["bespoke"],
      plugins: {
        bespoke: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({
              id: "show", name: "Show",
              callback: () => {
                class Bespoke extends api.Modal {
                  override onOpen(): void { this.contentEl.createEl("h2", { text: "hi" }); }
                }
                new Bespoke(this.app).open();
              },
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const client = await harness.connectClient();
    await client.call("host.invoke_command", { command_id: "bespoke:show" }).catch(() => undefined);
    const error = harness.lastHandlerError("bespoke");
    expect(error).toBeInstanceOf(HeadlessUnsupported);
    expect((error as HeadlessUnsupported).symbol).toBe("Modal.open");
    expect(error?.message).toContain("Bespoke");
  });
});
```

- [ ] **Step 2: Run it and observe the missing modules**

```bash
npm --prefix host test -- interaction
```

Expected: cannot resolve `../src/interaction/broker`.

- [ ] **Step 3: Implement the broker**

Create `broker.ts` with a `Map<string, { request, resolve, reject, timer }>`. `ask` rejects synchronously with `InteractionUnavailable` when nothing is attached, otherwise emits `host.interaction_request` to the attached session and arms a `config.clock.setTimeout(..., config.promptTimeoutMs)` — **the injected clock, never the global**, which is what lets the timeout test advance 120 seconds instantly instead of sleeping two minutes. `detach` rejects every pending prompt with `InteractionUnavailable`. The timer is cleared with `config.clock.clearTimeout` on answer and on detach so a resolved prompt cannot fire a late rejection, and `clock.armed()` is asserted back to zero at the end of the timeout test so a leaked timer is a failure rather than a slow leak.

`promptForDeletion` (Task 9) reaches the broker through the same `ask` with `kind: "confirm"`, and its no-handler branch catches `InteractionUnavailable` and resolves `false` rather than propagating — the one caller that deliberately swallows the typed error, because "nobody was asked" is a meaningful answer to a confirmation.

- [ ] **Step 4: Implement the modal family**

Create `modals.ts`. `Modal` has a real `contentEl`/`titleEl` (DOM stubs, so `onOpen` bodies do not throw while *building*) and an `open()` that records the subclass name and throws `HeadlessUnsupported("Modal.open")` — building the UI is allowed, showing it is not, which produces a message naming the actual subclass. `SuggestModal` and `FuzzySuggestModal` override `open()` to broker instead.

- [ ] **Step 5: Run and observe it pass**

```bash
npm --prefix host test -- interaction
```

Expected: five cases pass.

- [ ] **Step 6: Commit**

```bash
git add host/packages/host/src/interaction host/packages/host/src/shim/modals.ts host/packages/host/test/interaction.test.ts
git commit -m "feat(host): broker suggest modals and refuse bespoke modals typed"
```

---

### Task 19: Dry-run mode

> **Amended 2026-09-16 (RULING, Task 19 review — Task 19b added).** The review measured that under `--dry-run` a plugin which creates a note, binary, folder or copy and then uses it throws "the mirror has no row for it", and that `modify` then `read` returns the old bytes: the mirror never moves because nothing was written. That breaks "the plugin sees success" and would make the Task 20 detector verdict a daily-notes-shaped plugin `fails` for a harness defect. Ruling: a new **Task 19b, the dry-run overlay** — the gate holds the paths it synthesised and the last bytes it recorded; the vault index and the read paths consult it only after the mirror answers `null` (bytes before the mirror for read-your-writes); **no synthetic rows in the `Mirror`** (it mirrors the daemon; a resync would fight them); precedence removed > overlay bytes > mirror metadata; dry-run stays non-isolating for reads (a daemon delta still reaches the mirror). Also ruled at the review: the host's non-`host.` client proxy routes through the `WriteGate` (a dry run that forwards a client's `write_note` is a dry run that writes), and synthetic answers follow the daemon's dot-segment rule for `semantic`/`generation` presence while `kind` keeps the config-dir rule. Task 19b's brief lives in the SDD workspace and lands before Task 20.

**Files:**

- Create: `host/packages/host/src/dryrun/dry-run.ts`
- Modify: `host/packages/host/src/shim/vault.ts` (route through `WriteGate`)
- Create: `host/packages/host/test/dry-run.test.ts`

**Interfaces:**

```ts
export interface RecordedWrite {
  readonly kind: "vault" | "plugin_config";
  readonly method: string;
  readonly params: unknown;
  readonly pluginId: string | null;
  readonly atUnixMs: number;
}
export class DryRunRefused extends Error {
  readonly code = "dry_run_refused";
  readonly surface: "network" | "os_bridge" | "node_builtin";
}
export interface WriteGate {
  send<T>(method: string, params: unknown): Promise<T>;
}
export class DryRunGate implements WriteGate {
  constructor(client: VaultdClient, config: HostConfig, noticeLog: NoticeLog);
  writes(): readonly RecordedWrite[];
  /** A VIEW over the shared NoticeLog, not a second log. */
  notices(): readonly NoticeEntry[];
  refusals(): readonly { surface: string; detail: string }[];
  clear(): void;
}
```

**There is one notice log and dry-run does not own it.** v1 gave `DryRunGate` its own `RecordedNotice[]`, which meant `Notice` was recorded only under `--dry-run` — so `host.invoke_command`'s `notices` field, the field a client reads to find out what a command told the user, was empty in normal operation. The log moved to `src/shim/notice.ts` in Task 11b and records unconditionally, with the plugin id from `currentPluginId()`. `DryRunGate.notices()` returns `noticeLog.since(this.startMark)` — the same entries, windowed to the dry run. `clear()` re-marks; it does not erase the shared log.

**The intercepted surface, as an explicit list — and the not-intercepted list beside it, because a mitigation nobody can enumerate is not a mitigation.**

Intercepted: vault mutations (`write_note`, `write_file`, `patch_frontmatter`, `create_folder`, `rename_note`, `rename_folder`, `copy_file`, `delete_note`, `delete_folder`) are recorded and **not** forwarded, and the caller receives a synthetic success carrying the mirror's current generation and the file's current revision; plugin-config writes are recorded; `requestUrl`/`request` are refused with `DryRunRefused { surface: "network" }` unless `--dry-run-allow-network`; `Notice` and every log line are recorded; the electron stub's `shell.openPath`/`showItemInFolder`/`openExternal` are refused with `DryRunRefused { surface: "os_bridge" }`; `require` of `node:child_process`, `node:fs`, `node:http`, `node:https`, and `node:net` from a plugin bundle is refused with `DryRunRefused { surface: "node_builtin" }`.

Not intercepted: CPU, timers, and every read path. Dry-run is the detector's runtime-harness backend and an evaluation tool. **It is not a sandbox**, it does not claim to be one, and a plugin determined to reach the filesystem through a route not on the intercepted list will succeed — plugins run with the host's Node privileges, exactly as they do under Electron.

- [ ] **Step 1: Write the failing test**

Create `host/packages/host/test/dry-run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

describe("dry-run", () => {
  it("records a vault write instead of forwarding it, and reports success to the plugin", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: ["writer"], config: { dryRun: true },
      plugins: {
        writer: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({
              id: "write", name: "Write",
              callback: async () => {
                const file = this.app.vault.getFileByPath("A.md")!;
                await this.app.vault.modify(file, "# changed\n");
              },
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    harness.clearDaemonMethodLog();
    const client = await harness.connectClient();
    await client.call("host.invoke_command", { command_id: "writer:write" });
    expect(harness.daemonMethodsSeen()).toEqual([]);
    expect(harness.dryRun.writes()).toEqual([{
      kind: "vault", method: "write_note", pluginId: "writer",
      params: { path: "A.md", content: "# changed\n", expected: { revision: harness.revisionOf("A.md") } },
      atUnixMs: expect.any(Number),
    }]);
    expect(harness.lastHandlerError("writer")).toBeNull();
  });

  it("refuses network by default and allows it with the flag", async () => {
    const refused = await HostHarness.create({
      vault: {}, enabled: ["fetcher"], config: { dryRun: true },
      plugins: { fetcher: HostHarness.requestUrlPlugin },
    });
    await refused.lifecycle.start();
    await refused.invoke("fetcher:fetch");
    expect(refused.lastHandlerError("fetcher")?.message).toMatch(/dry_run_refused/);
    expect(refused.dryRun.refusals()).toEqual([{ surface: "network", detail: "https://example.test/" }]);

    const allowed = await HostHarness.create({
      vault: {}, enabled: ["fetcher"],
      config: { dryRun: true, dryRunAllowNetwork: true },
      plugins: { fetcher: HostHarness.requestUrlPlugin },
    });
    await allowed.lifecycle.start();
    await allowed.invoke("fetcher:fetch");
    expect(allowed.dryRun.refusals()).toEqual([]);
  });

  it("records notices and refuses the OS bridge", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["noisy"], config: { dryRun: true },
      plugins: {
        noisy: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({
              id: "go", name: "Go",
              callback: async () => {
                new api.Notice("hello");
                const electron = require("electron") as { shell: { openPath(p: string): Promise<string> } };
                await electron.shell.openPath("/tmp/x");
              },
            });
          }
        },
      },
    });
    await harness.lifecycle.start();
    await harness.invoke("noisy:go");
    expect(harness.dryRun.notices()).toEqual([{
      pluginId: "noisy", message: "hello",
      atUnixMs: expect.any(Number), timeoutMs: null,
    }]);
    // The same entry is in the shared log, because there is only one log.
    expect(harness.noticeLog.entries()).toContainEqual(harness.dryRun.notices()[0]);
    expect(harness.dryRun.refusals()).toEqual([{ surface: "os_bridge", detail: "openPath /tmp/x" }]);
  });

  it("leaves reads and timers untouched", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: ["reader"], config: { dryRun: true },
      plugins: {
        reader: (api) => class extends api.Plugin {
          read?: string;
          override async onload(): Promise<void> {
            this.read = await this.app.vault.read(this.app.vault.getFileByPath("A.md")!);
            this.registerInterval(window.setInterval(() => {}, 1000));
          }
        },
      },
    });
    await harness.lifecycle.start();
    const plugin = harness.app.plugins.getPlugin("reader") as unknown as { read: string };
    expect(plugin.read).toBe("# A\n");
    expect(harness.harvest.timers()).toHaveLength(1);
    expect(harness.dryRun.refusals()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- dry-run
```

Expected: cannot resolve `../src/dryrun/dry-run`.

- [ ] **Step 3: Implement `DryRunGate`**

It is the `WriteGate` the `Vault`, `FileManager`, `Editor`, and `PluginConfigService` already take as a dependency — **no new call sites**, because Task 7 routed every mutation through `deps.writes.send` for exactly this reason. `send` matches the method against the intercepted list, records a `RecordedWrite`, and returns a synthetic success carrying the mirror's current generation and the path's current revision; anything not on the list is forwarded. The network refusal lives in `requestUrl`/`request` (Task 11b) reading `config.dryRun && !config.dryRunAllowNetwork`; the OS-bridge refusal lives in the electron stub (Task 13); the node-builtin refusal lives in the interception patch (Task 13). All three record into this gate's `refusals()`, which is why `DryRunGate` is constructed before `assembleShim` wires them.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- dry-run
```

Expected: four cases pass.

- [ ] **Step 5: Commit**

```bash
git add host/packages/host/src/dryrun host/packages/host/src/shim/vault.ts host/packages/host/test/dry-run.test.ts
git commit -m "feat(host): add dry-run with an explicit intercepted-surface list"
```

---

### Task 20: The compatibility detector

**Files:**

- Create: `host/packages/host/src/detector/scanner.ts`
- Create: `host/packages/host/src/detector/harness.ts`
- Create: `host/packages/host/src/detector/report.ts`
- Create: `host/fixtures/detector/<case>/main.js` + `<case>/ground-truth.json` (8 cases, listed in Step 1)
- Create: `host/packages/host/test/detector-scanner.test.ts`
- Create: `host/packages/host/test/detector-harness.test.ts`

**Interfaces:**

```ts
export type Tier = 1 | 2 | 3 | 4;
export interface ScanResult {
  readonly pluginId: string;
  readonly minified: boolean;
  readonly bytes: number;
  readonly apiSymbols: Readonly<Record<string, number>>;  // property-position hits
  readonly lifecycleGates: {
    onLayoutReady: number; layoutReadyRead: number;
    metadataResolved: number; metadataResolve: number;
  };
  readonly registrations: Readonly<Record<string, number>>;
  readonly commandIds: readonly string[];
  readonly eventNames: readonly string[];
  readonly frameworks: readonly ("svelte" | "react" | "preact" | "vue")[];
  readonly crossPlugin: readonly string[];
  readonly internalPlugins: readonly string[];
  readonly requiresElectron: boolean;
  readonly requiresNode: readonly string[];
  readonly tierEstimate: Tier;
  readonly tierReasons: readonly string[];
}
export function scanBundle(pluginId: string, source: string): ScanResult;

export interface RecordedApiCall {
  readonly symbol: string; readonly pluginId: string;
  readonly policy: ApiPolicy; readonly threw: string | null; readonly atUnixMs: number;
}
export interface HarnessResult {
  readonly pluginId: string;
  readonly loaded: boolean;
  readonly loadError: string | null;
  readonly calls: readonly RecordedApiCall[];
  readonly throws: readonly RecordedApiCall[];
  readonly writes: readonly RecordedWrite[];
  readonly harvest: { commands: number; menuHooks: number; protocolHandlers: number; unreachable: number };
}
export class Detector {
  scan(pluginId: string): Promise<ScanResult>;
  runHarness(pluginId: string): Promise<HarnessResult>;   // loads under DryRunGate
  report(pluginId?: string): Promise<CompatReport>;
}
export interface CompatReport {
  readonly generatedAtUnixMs: number;
  readonly plugins: readonly {
    id: string; version: string; scan: ScanResult; harness: HarnessResult | null;
    schemaSource: SchemaSource; verdict: "runs" | "degrades" | "fails";
  }[];
}
```

- **Scan property positions and string literals, never bindings.** The 2026-08-28 minification study measured the boundary: anything reachable as `obj.name` survives minification at 97–100% (Obsidian API methods, DOM APIs, the plugin's own methods, event-name string literals, command ids/names/icons), while any *binding* — locals, parameters, and crucially **imported symbols** like `mount`, `requestUrl`, `normalizePath` — is renamed, surviving only by coincidence at 8–25%. So `apiSymbols` counts `\.(getFileCache|getAbstractFileByPath|…)\b` matches, `commandIds` comes from `id:` string literals inside `addCommand` argument objects, and `eventNames` from `.on("…")` literals. Counting bare identifiers would report `normalizePath: 0` for a plugin that calls it 9 times.
- **Framework detection uses framework-owned string constants only:** `__svelte_meta` and `svelte.dev/e/` for Svelte, `__SECRET_INTERNALS` for React. Searching for `mount(` gives false negatives on real users and false positives elsewhere. Two traps the study found are pinned as tests: the substring `vue` matches French locale strings, and `hydrat` matches ReactDOM — so both are excluded by requiring the full owned constant.
- **`class extends *.Plugin` is not the tier test.** It breaks on indirect base classes (2 of 34 sampled bundles), so the tier estimate is derived from where API calls sit relative to UI calls in the AST-free scan: a bundle whose `addCommand` callbacks contain vault/metadata calls and no `createEl` is tier 1; one whose only entry points are menu or DOM-delegated handlers is tier 2; one whose settings-authored config or UI-entangled logic dominates is tier 3; one whose whole body is view construction is tier 4. Every estimate carries `tierReasons` so a wrong answer is arguable rather than mysterious.
- The **harness** loads the plugin for real under `DryRunGate`, records every shim symbol touched with its policy and whether it threw, and produces the counts. It is the runtime half of the report; the scanner is the static half; neither is trusted alone.

- [ ] **Step 1: Author the eight fixture bundles with known ground truth**

`host/fixtures/detector/<case>/main.js` plus a hand-written `ground-truth.json` per case: `minified-tier1` (a minified bundle calling `getFileCache`, `vault.process`, two `addCommand`s, no DOM), `unminified-tier1` (the same logic unminified — the pair proves the scan is minification-independent), `menu-only-tier2` (zero `addCommand`, one `file-menu` hook), `dom-delegated-tier2` (zero `addCommand`, context menus only through delegated listeners), `svelte-tier3` (carrying `__svelte_meta` and `svelte.dev/e/`), `react-tier4` (carrying `__SECRET_INTERNALS`), `false-friend` (containing the literals `"vue"` inside a French locale string and `"hydration"` in a comment, and no framework), and `indirect-base` (a plugin class extending a local base class that extends `obsidian.Plugin`).

- [ ] **Step 2: Write the failing scanner test**

Create `host/packages/host/test/detector-scanner.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanBundle } from "../src/detector/scanner";

const dir = join(__dirname, "..", "..", "..", "fixtures", "detector");
const cases = readdirSync(dir);

describe("scanBundle", () => {
  it("matches ground truth for every fixture", () => {
    expect(cases).toHaveLength(8);
    for (const name of cases) {
      const source = readFileSync(join(dir, name, "main.js"), "utf8");
      const truth = JSON.parse(readFileSync(join(dir, name, "ground-truth.json"), "utf8")) as Record<string, unknown>;
      const result = scanBundle(name, source);
      expect({
        minified: result.minified,
        apiSymbols: result.apiSymbols,
        lifecycleGates: result.lifecycleGates,
        commandIds: result.commandIds,
        eventNames: result.eventNames,
        frameworks: result.frameworks,
        crossPlugin: result.crossPlugin,
        internalPlugins: result.internalPlugins,
        tierEstimate: result.tierEstimate,
      }, name).toEqual(truth);
    }
  });

  it("reports identical API symbols for the minified and unminified pair", () => {
    const minified = scanBundle("a", readFileSync(join(dir, "minified-tier1", "main.js"), "utf8"));
    const plain = scanBundle("b", readFileSync(join(dir, "unminified-tier1", "main.js"), "utf8"));
    expect(minified.apiSymbols).toEqual(plain.apiSymbols);
    expect(minified.commandIds).toEqual(plain.commandIds);
    expect(minified.tierEstimate).toBe(plain.tierEstimate);
    expect(minified.minified).toBe(true);
    expect(plain.minified).toBe(false);
  });

  it("does not invent frameworks from false-friend substrings", () => {
    const result = scanBundle("ff", readFileSync(join(dir, "false-friend", "main.js"), "utf8"));
    expect(result.frameworks).toEqual([]);
  });

  it("detects a plugin class behind an indirect base class", () => {
    const result = scanBundle("ib", readFileSync(join(dir, "indirect-base", "main.js"), "utf8"));
    expect(result.tierEstimate).toBe(1);
    expect(result.tierReasons).toContain("indirect Plugin base class");
  });

  it("separates a menu-only tier 2 from a DOM-delegated tier 2 in tierReasons", () => {
    const harvestable = scanBundle("m", readFileSync(join(dir, "menu-only-tier2", "main.js"), "utf8"));
    const delegated = scanBundle("d", readFileSync(join(dir, "dom-delegated-tier2", "main.js"), "utf8"));
    expect(harvestable.tierEstimate).toBe(2);
    expect(delegated.tierEstimate).toBe(2);
    expect(harvestable.tierReasons).toContain("entry points are harvestable menu hooks");
    expect(delegated.tierReasons).toContain("entry points are DOM-delegated and unreachable headless");
  });
});
```

- [ ] **Step 3: Run it and observe the missing module**

```bash
npm --prefix host test -- detector-scanner
```

Expected: cannot resolve `../src/detector/scanner`.

- [ ] **Step 4: Implement the scanner and observe it pass**

Implement `scanBundle` as property-position and string-literal matching only, per the minification study above: `apiSymbols` from `\.(symbol)\b` over the declared API surface, `commandIds` from `id:` string literals inside `addCommand(` argument objects, `eventNames` from `.on("…")` literals, `frameworks` from framework-owned constants only (`__svelte_meta`, `svelte.dev/e/`, `__SECRET_INTERNALS`), `minified` from mean line length and identifier-length distribution. Re-run; expected: five cases pass.

- [ ] **Step 5: Write the failing harness test**

Create `host/packages/host/test/detector-harness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

describe("Detector.runHarness", () => {
  it("records every shim symbol a scripted plugin touches, in order, with its policy", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" },
      enabled: [],
      config: { dryRun: true },
      plugins: {
        scripted: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            const file = this.app.vault.getFileByPath("A.md")!;
            this.app.metadataCache.getFileCache(file);          // implemented
            await this.app.vault.modify(file, "# changed\n");   // implemented + a write
            this.registerView("scripted-view", () => ({}));     // safe_stub + unreachable
            this.app.vault.adapter.getResourcePath("A.md");     // safe_stub
            try {
              (api as unknown as { htmlToMarkdown(html: string): string })
                .htmlToMarkdown("<p>x</p>");                    // absent -> throws
            } catch {
              // swallowed on purpose: the detector must record the throw even
              // when the plugin catches it, which is the common real case.
            }
          }
        },
      },
    });
    await harness.lifecycle.start();

    const result = await harness.detector.runHarness("scripted");
    expect(result.loaded).toBe(true);
    expect(result.loadError).toBeNull();

    expect(result.calls.map((call) => call.symbol)).toEqual([
      "MetadataCache.getFileCache",
      "Vault.modify",
      "Plugin.registerView",
      "DataAdapter.getResourcePath",
      "htmlToMarkdown",
    ]);
    expect(result.calls.map((call) => call.policy)).toEqual([
      "implemented", "implemented", "safe_stub", "safe_stub", "absent",
    ]);

    expect(result.throws).toHaveLength(1);
    expect(result.throws[0]).toMatchObject({
      symbol: "htmlToMarkdown", policy: "absent", pluginId: "scripted",
    });
    expect(result.throws[0]?.threw).toContain("htmlToMarkdown");

    // The write was recorded, not forwarded: the harness runs under DryRunGate.
    expect(result.writes).toEqual([{
      kind: "vault", method: "write_note", pluginId: "scripted",
      params: { path: "A.md", content: "# changed\n", expected: { revision: harness.revisionOf("A.md") } },
      atUnixMs: expect.any(Number),
    }]);
    expect(harness.daemonMethodsSeen()).not.toContain("write_note");

    expect(result.harvest).toEqual({
      commands: 0, menuHooks: 0, protocolHandlers: 0, unreachable: 1,
    });
  });

  it("records loadError and loaded false for a bundle that throws in onload", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        broken: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            throw new Error("boom during onload");
          }
        },
      },
    });
    await harness.lifecycle.start();
    // Must not propagate: the detector's whole job is to survive plugins that
    // do not, and report why.
    const result = await harness.detector.runHarness("broken");
    expect(result.loaded).toBe(false);
    expect(result.loadError).toContain("boom during onload");
    expect(result.calls).toEqual([]);
    expect(result.throws).toEqual([]);
  });

  it("attributes calls to the plugin under harness and to no other", async () => {
    const harness = await HostHarness.create({
      vault: { "A.md": "# A\n" }, enabled: ["bystander"], config: { dryRun: true },
      plugins: {
        bystander: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.registerEvent(this.app.metadataCache.on("changed", () => {
              this.app.vault.getMarkdownFiles();
            }));
          }
        },
        probed: (api) => class extends api.Plugin {
          override async onload(): Promise<void> { this.app.vault.getMarkdownFiles(); }
        },
      },
    });
    await harness.lifecycle.start();
    const result = await harness.detector.runHarness("probed");
    expect(result.calls.every((call) => call.pluginId === "probed")).toBe(true);
  });

  it("merges scan and harness into one verdict per plugin", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: [], config: { dryRun: true },
      plugins: {
        quiet: (api) => class extends api.Plugin {
          override async onload(): Promise<void> {
            this.addCommand({ id: "go", name: "Go", callback: () => {} });
          }
        },
      },
    });
    await harness.lifecycle.start();
    const report = await harness.detector.report("quiet");
    expect(report.plugins).toHaveLength(1);
    expect(report.plugins[0]).toMatchObject({
      id: "quiet", verdict: "runs", schemaSource: "none",
    });
    expect(report.plugins[0]?.harness).not.toBeNull();
    expect(report.generatedAtUnixMs).toBeGreaterThan(0);
  });
});
```

The verdict rule the last case pins: **`runs`** when the plugin loaded and threw no `absent` symbol; **`degrades`** when it loaded but hit at least one `absent` symbol or recorded at least one `unreachable` entry point; **`fails`** when it did not load. Three states, derived from the recorded facts, so a verdict is always arguable from the report rather than asserted by it.

- [ ] **Step 6: Run it and observe the missing modules**

```bash
npm --prefix host test -- detector-harness
```

Expected: cannot resolve `../src/detector/harness`.

- [ ] **Step 7: Implement the runtime harness and the report**

Implement `harness.ts` by loading the plugin under a fresh `DryRunGate` with a fresh `PolicyRecorder` scoped to that plugin id, catching everything `onload` throws into `loadError`, and reading `calls`/`throws` off the recorder. `PolicyRecorder` gains an ordered call log (it already counts hits; the detector needs the sequence) and every shim entry point records through it — which is already true for `safe_stub` and `absent` and needs adding for `implemented`, gated behind a `recordImplemented` flag so the ordinary host does not pay for a log nobody reads. Implement `report.ts` merging scan and harness into `CompatReport` with the verdict rule above. Re-run; expected: four cases pass.

- [ ] **Step 8: Commit**

```bash
git add host/packages/host/src/detector host/fixtures/detector host/packages/host/test
git commit -m "feat(host): detect plugin compatibility by bundle scan and runtime harness"
```

---

### Task 20b: Host server wiring — interaction, config, detector, and overlap ops

> **Amended 2026-09-16 (RULING, Task 18).** The three interaction ops and the `host.interaction_request` event are wired by Task 18 (see its amendment); this task attaches `{ pluginConfig, detector }` and its interaction cases are pins of Task 18's behaviour, so only the config and detector cases fail with `host_not_ready` on the first run.

> **Amended 2026-09-16 (CARRY from the Task 18 review, interaction delivery under lag).** A prompt's `host.interaction_request` rides the attached client's subscription queue, so a client that has fallen behind can have the request collapsed into `subscriber_lag` / `resync_required`. Task 18 ships the interim: delivery reports whether every subscription took the line, and a prompt whose delivery was collapsed fails at once with `interaction_unavailable` instead of waiting the full `promptTimeoutMs`. The durable fix is protocol surface for this task or Task 22: a client treats `resync_required` as "re-ask what is pending", backed by a `host.list_interactions` op that returns the broker's `pending()` rows. Note also that attaching subscribes the prompt client to the whole event stream, which is what makes it the likeliest client to lag.

This completes Task 16a. The six ops below all need a service that did not exist at 16a: the broker (Task 18), the config service (Task 17), and the detector (Task 20). Rather than let 16a take forward references, the server exposes `attachWiring(...)` and those ops answer `host_not_ready` until it is called; this task calls it and makes them real. Nothing about the wire contract changes — it was pinned in full at 16a and this task implements the rows it marked.

**Files:**

- Create: `host/packages/host/src/server/ops-wiring.ts`
- Modify: `host/packages/host/src/server/server.ts` (call `attachWiring`; broadcast `host.interaction_request` and `host.overlap_changed`)
- Modify: `host/packages/host/src/main.ts` is **not** touched here — Task 22 owns the binary
- Create: `host/packages/host/test/server-wiring.test.ts`
- Modify: `docs/protocol-host.md` (drop the "wired in 20b" markers, add the six examples)

**Interfaces:**

- Produces: the six op handlers, registered into the same `ops.ts` record 16a built, plus two event broadcasts.

```ts
export function registerWiredOps(server: HostServer, wiring: HostServerWiring): void;
```

- `host.attach_interaction` makes the calling session the broker's handler; a second attach from another session refuses with `interaction_unavailable` naming the holder, because two handlers racing to answer one prompt is worse than one client waiting. `host.detach_interaction` releases it and fails every pending prompt. A session that disconnects while attached detaches implicitly — that is Task 18's disconnect case, wired here.
- `host.respond_interaction` routes to `broker.answer(prompt_id, ...)` and returns `{ prompt_id }`; an unknown or already-answered id refuses with `interaction_unavailable` rather than resolving quietly.
- `host.get_plugin_config` / `host.set_plugin_config` are thin over `PluginConfigService`, with **`reveal_secrets` requiring the request to come from an authenticated session** — which every session is, by 16a's nonce gate, so this is a statement of fact rather than a second check.
- `host.compat_report` is thin over `Detector.report`, and its result is scrubbed by `wire.ts` before it goes out: no `tab` reference, no plugin instance, no config values. A compatibility report is a description of a plugin, never a copy of its settings.
- `host.overlap_changed` is broadcast from `CoexistenceMonitor.onOverlapChanged`, which 16a constructed but had nothing to broadcast into.

- [ ] **Step 1: Write the failing wiring test**

Create `host/packages/host/test/server-wiring.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HostHarness } from "../src/testing/host-harness";

describe("wired host ops", () => {
  it("attaches one interaction handler and refuses a second", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    await harness.lifecycle.start();
    await harness.server.listen();
    const first = await harness.connectClient();
    const second = await harness.connectClient();
    await expect(first.call("host.attach_interaction", {})).resolves.toEqual({ attached: true });
    await expect(second.call("host.attach_interaction", {}))
      .rejects.toMatchObject({ code: "interaction_unavailable" });
    await expect(first.call("host.detach_interaction", {})).resolves.toEqual({ attached: false });
    await expect(second.call("host.attach_interaction", {})).resolves.toEqual({ attached: true });
    await harness.server.close();
  });

  it("refuses respond_interaction for an unknown prompt", async () => {
    const harness = await HostHarness.create({ vault: {}, enabled: [] });
    await harness.lifecycle.start();
    await harness.server.listen();
    const client = await harness.connectClient();
    await client.call("host.attach_interaction", {});
    await expect(client.call("host.respond_interaction", { prompt_id: "nope", choice_index: 0 }))
      .rejects.toMatchObject({ code: "interaction_unavailable" });
    await harness.server.close();
  });

  it("serves and patches plugin config over the socket, snake_case throughout", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["demo"],
      pluginData: { demo: { taskTag: "task", myApiKey: "s3cret" } },
      plugins: { demo: HostHarness.settingsPlugin },
    });
    await harness.lifecycle.start();
    await harness.server.listen();
    const client = await harness.connectClient();

    const guarded = await client.call<{
      id: string; values: Record<string, unknown>;
      schema: { source: string; items: unknown[] };
      redacted_keys: string[]; state_keys: string[];
    }>("host.get_plugin_config", { id: "demo" });
    expect(guarded.values["myApiKey"]).toBe("[redacted]");
    expect(guarded.redacted_keys).toEqual(["myApiKey"]);
    expect(Object.keys(guarded)).toEqual(
      expect.arrayContaining(["id", "values", "schema", "redacted_keys", "state_keys"]),
    );

    const revealed = await client.call<{ values: Record<string, unknown> }>(
      "host.get_plugin_config", { id: "demo", reveal_secrets: true },
    );
    expect(revealed.values["myApiKey"]).toBe("s3cret");

    const set = await client.call<{ applied: string[]; refused: unknown[] }>(
      "host.set_plugin_config", { id: "demo", patch: { taskTag: "todo" } },
    );
    expect(set).toEqual({ id: "demo", applied: ["taskTag"], refused: [] });
    await harness.server.close();
  });

  it("serves a compat report that leaks no settings values and no live objects", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["demo"],
      pluginData: { demo: { myApiKey: "s3cret" } },
      plugins: { demo: HostHarness.settingsPlugin },
    });
    await harness.lifecycle.start();
    await harness.server.listen();
    const client = await harness.connectClient();
    const reported = await client.call<{ report: unknown }>("host.compat_report", { plugin_id: "demo" });
    const serialized = JSON.stringify(reported);
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain("\"tab\"");
    expect(serialized).not.toMatch(/[a-z][A-Z]/);   // no camelCase keys survived wire.ts
    await harness.server.close();
  });

  it("broadcasts host.overlap_changed when the GUI enables an overlapping plugin", async () => {
    const harness = await HostHarness.create({
      vault: {}, enabled: ["quickadd"], plugins: { quickadd: HostHarness.settingsPlugin },
    });
    await harness.lifecycle.start();
    await harness.server.listen();
    const client = await harness.connectClient();
    await client.call("host.subscribe", {});
    const event = client.nextEvent("host.overlap_changed");
    harness.setGuiEnabled(["quickadd"]);
    await harness.advanceClock(60_000);
    await expect(event).resolves.toMatchObject({
      overlap: ["quickadd"], gui_enabled: ["quickadd"],
    });
    await harness.server.close();
  });
});
```

- [ ] **Step 2: Run it and observe the failures**

```bash
npm --prefix host test -- server-wiring
```

Expected: every case fails with `host_not_ready`, because 16a registered the ops and nothing has called `attachWiring` yet. That is the right first failure — it proves 16a's placeholder is a real, typed state and not a missing method.

- [ ] **Step 3: Implement the wiring and observe it pass**

Create `ops-wiring.ts`, call `server.attachWiring({ broker, pluginConfig, detector })` from the assembly, and add the two broadcasts. Re-run; expected: five cases pass.

- [ ] **Step 4: Finish the protocol document**

Remove the "wired in 20b" markers from `docs/protocol-host.md` and add one request/response example per newly-live op, copied from the passing tests.

- [ ] **Step 5: Commit**

```bash
git add host/packages/host/src/server host/packages/host/test/server-wiring.test.ts docs/protocol-host.md
git commit -m "feat(host): wire the interaction, config, and detector operations"
```

---

### Task 21: The wedged-thread watchdog

Quarantine moved to Task 14b, where its consumers can reach it. What is left here is genuinely independent of everything else in the plan, which is why it can sit this late.

**Files:**

- Create: `host/packages/host/src/runtime/watchdog.ts`
- Create: `host/packages/host/src/runtime/watchdog-worker.js`
- Create: `host/packages/host/test/watchdog.test.ts`

**Interfaces:**

```ts
export interface WatchdogReport {
  readonly stalledForMs: number;
  readonly lastStampUnixMs: number;
  readonly detectedAtUnixMs: number;
}
export interface WatchdogOptions {
  readonly thresholdMs: number;
  readonly stampIntervalMs: number;
  readonly reportPath: string;
  /** The injected clock. Drives the MAIN-side heartbeat only. */
  readonly clock: Clock;
}
export class Watchdog {
  constructor(options: WatchdogOptions);
  start(): void;
  /** Stamp the shared buffer. Called by the heartbeat and by the dispatch
   *  queue between tasks, so a busy-but-healthy loop still stamps. */
  stamp(): void;
  /** Test seam: resolve when the worker has produced at least `n` reports. */
  awaitReports(n: number): Promise<readonly WatchdogReport[]>;
  stop(): Promise<void>;
  reports(): readonly WatchdogReport[];
}
```

- **The mechanism is named because the obvious one cannot work.** A wedged main thread cannot answer a `postMessage`, so a `postMessage` ping-pong structurally cannot report the only failure it exists to catch. Instead the main loop stamps `Atomics.store(view, 0, now - epoch)` in a `SharedArrayBuffer` every `stampIntervalMs`; a `worker_threads` worker wakes on its own timer, reads the stamp with `Atomics.load`, and when the gap exceeds `thresholdMs` writes a report **from the worker thread**, whose I/O does not touch the wedged loop. Report-only: nothing is interrupted, nothing is killed. The report path is inside the host data dir, never the vault.
- **The clock split, and why it is not a contradiction.** The Global Constraints ban bare timers in tests and require `config.clock`; this component is the one named exception, and the exception is precisely one timer. **Main side:** the heartbeat is `clock.setInterval(() => this.stamp(), stampIntervalMs)` — injected, so a test drives it with `TestClock.advance` and the stamp value comes from `clock.now()`. **Worker side:** the worker owns one real `Atomics.wait(view, 0, expected, pollMs)` loop, because a watchdog driven by the clock it is watching detects nothing — if the main thread is wedged, so is any timer the main thread would have to service. That one timer is declared in Global Constraints, lives entirely inside `watchdog-worker.js`, touches no plugin state, and is the only real timer any test in this plan waits on.
- **What that buys the test.** A wedge is not simulated by blocking the main thread for 600 ms and hoping: it is simulated by **advancing the TestClock past the threshold without stamping**, which is exactly what a wedged loop looks like from the worker's side of the shared buffer. The test then waits on `awaitReports(1)` — a promise the worker resolves — rather than on a sleep. One case still blocks the loop for real, because "the mechanism works against an actual synchronous wedge" is a claim only an actual synchronous wedge can support; that case waits on `awaitReports`, not on a timer, so it is bounded by the event it is testing rather than by a guessed duration.

- [ ] **Step 1: Write the failing watchdog test**

Create `host/packages/host/test/watchdog.test.ts`. Three of the four cases drive the heartbeat through the injected clock and never sleep; the fourth blocks the loop for real, because that claim needs a real wedge — and even it waits on `awaitReports`, not on a timer:

```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Watchdog } from "../src/runtime/watchdog";
import { systemClock } from "../src/config";
import { testClock } from "../src/testing/clock";

const reportPath = () => join(mkdtempSync(join(tmpdir(), "vaultd-wd-")), "stalls.jsonl");
const running: Watchdog[] = [];

const start = (options: { thresholdMs: number; stampIntervalMs: number; reportPath: string }) => {
  const clock = testClock();
  const watchdog = new Watchdog({ ...options, clock });
  running.push(watchdog);
  watchdog.start();
  return { watchdog, clock };
};

afterEach(async () => {
  while (running.length) await running.pop()!.stop();
});

describe("Watchdog", () => {
  it("writes nothing while the heartbeat keeps stamping", async () => {
    const path = reportPath();
    const { watchdog, clock } = start({ thresholdMs: 150, stampIntervalMs: 25, reportPath: path });
    // Twenty stamps at 25 ms: 500 ms of simulated healthy operation in no
    // wall-clock time at all, because the heartbeat runs on the injected clock.
    await clock.advance(500);
    expect(watchdog.reports()).toEqual([]);
    expect(existsSync(path) ? readFileSync(path, "utf8").trim() : "").toBe("");
  });

  it("reports a stall when the heartbeat stops stamping", async () => {
    const path = reportPath();
    const { watchdog, clock } = start({ thresholdMs: 150, stampIntervalMs: 25, reportPath: path });
    await clock.advance(100);          // healthy
    watchdog.suspendHeartbeat();       // exactly what a wedged loop looks like
    clock.setNow(clock.now() + 600);   // time passes, no stamp lands
    const [report] = await watchdog.awaitReports(1);
    expect(report!.stalledForMs).toBeGreaterThanOrEqual(150);
    expect(report!.lastStampUnixMs).toBeLessThan(report!.detectedAtUnixMs);
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ stalledForMs: expect.any(Number) });
  });

  it("stops reporting once the heartbeat resumes", async () => {
    const path = reportPath();
    const { watchdog, clock } = start({ thresholdMs: 150, stampIntervalMs: 25, reportPath: path });
    watchdog.suspendHeartbeat();
    clock.setNow(clock.now() + 600);
    await watchdog.awaitReports(1);
    watchdog.resumeHeartbeat();
    const after = watchdog.reports().length;
    await clock.advance(1_000);        // healthy again
    expect(watchdog.reports().length).toBe(after);
  });

  it("reports a genuinely wedged main thread, and interrupts nothing", async () => {
    // The one case that must use the real clock. A synchronous wedge is the
    // failure this component exists to catch, and only a real wedge proves the
    // SharedArrayBuffer path survives a blocked event loop. It still waits on
    // `awaitReports` rather than on a sleep, so it is bounded by the event
    // under test instead of by a guessed duration.
    const path = reportPath();
    const watchdog = new Watchdog({
      thresholdMs: 100, stampIntervalMs: 25, reportPath: path, clock: systemClock(),
    });
    running.push(watchdog);
    watchdog.start();
    let total = 0;
    const until = Date.now() + 400;
    while (Date.now() < until) total += 1;   // deliberately wedge the loop
    const [report] = await watchdog.awaitReports(1);
    expect(report!.stalledForMs).toBeGreaterThanOrEqual(100);
    expect(total).toBeGreaterThan(0);        // report-only: the work finished
  });
});
```

`suspendHeartbeat()` and `resumeHeartbeat()` are host-only seams on `Watchdog`: they stop and restart the stamping without stopping the worker, which is the only honest way to simulate "the main thread is wedged" while the test itself is still running. `awaitReports(n)` resolves from a `message` the worker posts alongside each report — the **worker** can post, because it is the healthy thread; it is the main thread that cannot answer, which is why the direction matters and why this is not the `postMessage` ping-pong the design ruled out.

- [ ] **Step 2: Run it and observe the missing module**

```bash
npm --prefix host test -- watchdog
```

Expected: cannot resolve `../src/runtime/watchdog`.

- [ ] **Step 3: Implement the worker and the main-side heartbeat**

Implement `watchdog-worker.js` as a plain CommonJS worker — plain JS, not TypeScript, so it needs no build step to be spawnable by path — that receives the `SharedArrayBuffer` and the options through `workerData`, loops on `Atomics.wait(view, 0, view[0], pollMs)` (**the one real timer this plan admits, declared in Global Constraints**), compares `Atomics.load(view, 0)` against its own `Date.now()`, and on a gap over the threshold appends a JSON line to `reportPath` and `postMessage`s the report. It reports at most once per stall, re-arming only after a fresh stamp lands, so a long wedge produces one line rather than a flood.

The main-side `Watchdog` stamps from `options.clock.setInterval(..., stampIntervalMs)` — `unref()`ed under the system clock so it never holds the process open — and also stamps from `DispatchQueue` between tasks, so a busy-but-healthy loop still stamps. `stop()` clears the interval, terminates the worker, and awaits its exit.

- [ ] **Step 4: Run and observe it pass**

```bash
npm --prefix host test -- watchdog
```

Expected: four cases pass. Run the file ten times. The first three cannot flake — they contain no wall-clock dependency at all. If the fourth flakes, raise `thresholdMs` and the wedge duration together; never add a sleep.

- [ ] **Step 5: Commit**

```bash
git add host/packages/host/src/runtime/watchdog.ts host/packages/host/src/runtime/watchdog-worker.js host/packages/host/test/watchdog.test.ts
git commit -m "feat(host): watch for a wedged main thread from a worker thread"
```

---

### Task 22: The golden-plugin conformance suite, baselines, and documentation

**Files:**

- **Activate** `src/testing/pending/live-host.ts` → `src/testing/live-host.ts` (`git mv`), and now that `pending/` is empty, drop it from the `tsconfig.json` and `vitest.config.ts` excludes.
- Create: `host/packages/host/test/golden/golden.test.ts`
- Create: `host/packages/host/test/golden/tag-wrangler.test.ts`
- Create: `host/packages/host/test/golden/quickadd.test.ts`
- Create: `host/packages/host/test/no-write-imports.test.ts`
- Create: `host/packages/host/src/main.ts`
- Create: `docs/design/headless-plugin-host.md`
- Create: `docs/performance/headless-host-baseline.md`
- Modify: `VAULTD-COMPATIBILITY.md`
- Modify: `README.md`

**Interfaces:**

- Produces: the `vaultd-host` binary — `vaultd-host --vault <path> [--config-dir <name>] [--socket <path>] [--dry-run] [--dry-run-allow-network] [--force-shared <id>]…` — and the conformance suite that gates every future change to the shim.

- [ ] **Step 1: Write the failing golden-suite driver**

Create `host/packages/host/test/golden/golden.test.ts`. It runs a **real host against a real `vaultd`** over a temp copy of each fixture vault, under the fs write guard:

```ts
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { installFsWriteGuard } from "../../src/testing/fs-guard";
import { LiveHost } from "../../src/testing/live-host";

const goldenRoot = join(__dirname, "..", "..", "..", "..", "fixtures", "golden");

// Excluded from the comparison, and each for its own reason.
//   .obsidian            — the GUI's config dir. The host reads it (config
//                          fallback) and never writes it, but Obsidian rewrites
//                          workspace.json and appearance.json on its own
//                          schedule, so including it makes the golden tree a
//                          moving target. v1 omitted this exclusion entirely.
//   .obsidian-headless   — the host's own config dir: plugin bundles, data.json.
//                          Not vault content and deliberately divergent.
//   .trash               — local trash, whose contents depend on delete mode.
const EXCLUDED_DIRS = new Set([".obsidian", ".obsidian-headless", ".trash"]);

// Text is compared as text so a failure diff is readable. Everything else is
// compared by hash, because `readFileSync(png, "utf8")` mangles the bytes
// through lossy replacement characters — two different images can compare
// equal, and an identical image can compare unequal across platforms. A
// golden suite that cannot tell two PNGs apart is not proving what it claims.
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".canvas", ".css", ".yaml", ".yml", ".csv", ".svg",
]);

const treeOf = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const key = relative(root, full);
      if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out[key] = readFileSync(full, "utf8");
      } else {
        const raw = readFileSync(full);            // Buffer, no encoding
        out[key] = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      }
    }
  };
  walk(root);
  return out;
};

describe("golden plugin conformance", () => {
  const cases = readdirSync(goldenRoot).filter((name) => statSync(join(goldenRoot, name)).isDirectory());

  for (const pluginId of cases) {
    it(`reproduces real Obsidian's outcome for ${pluginId}`, async () => {
      const work = mkdtempSync(join(tmpdir(), `vaultd-golden-${pluginId}-`));
      cpSync(join(goldenRoot, pluginId, "vault"), work, { recursive: true });
      const scenario = JSON.parse(
        readFileSync(join(goldenRoot, pluginId, "scenario.json"), "utf8"),
      ) as { action: { op: string; params: Record<string, unknown> }; settings: Record<string, unknown> };

      const guard = installFsWriteGuard(work);
      const host = await LiveHost.start({
        vaultRoot: work,
        installPlugin: { id: pluginId, from: join(goldenRoot, pluginId, "plugin") },
        data: scenario.settings,
      });
      try {
        await host.call(scenario.action.op, scenario.action.params);
        await host.quiesce();
      } finally {
        await host.stop();
        guard.release();
      }

      guard.assertClean();
      expect(treeOf(work)).toEqual(treeOf(join(goldenRoot, pluginId, "expected")));
      expect(host.unsupportedHits()).toEqual([]);
    }, 60_000);
  }

  it("covers all eight golden plugins", () => {
    expect(cases.sort()).toEqual([
      "automatic-linker", "find-replace", "folder-notes", "nested-properties",
      "obsidian-linter", "obsidian-rollover-daily-todos", "quickadd", "tag-wrangler",
    ]);
  });
});
```

Two honesty notes belong in `host/fixtures/golden/README.md` and are not negotiable.

First, every `expected/` tree was produced by **observing a real Obsidian perform the action**, never by reading `app.asar` or by running the host and blessing its output.

Second, obsidian-linter's primary write path in the GUI is a **CodeMirror 6 `dispatch` transaction** on the live editor — `editor.cm.dispatch({ changes })`, not `editor.setValue` — and a CM6 transaction has no headless equivalent at all: there is no CM6 instance, no view, and no state field to dispatch into. (v1 of this plan said `editor.setValue`, which is a different API and would have implied the gap was smaller than it is; the scope conclusion is unchanged, the description was wrong.) Its golden scenario therefore drives the **file** path — `vault.modify`, and the YAML `vault.process` the plugin runs from `metadataCache.on("changed")` — and the README says so plainly, so nobody later reads a passing linter case as proof the editor path works. What the host does provide is `Editor` (Task 12), a text buffer with a `write_note` flush; that is enough for `editorCallback` commands and is not a CM6 transaction.

- [ ] **Step 2: Run it and observe the failure**

```bash
npm --prefix host test -- golden
```

Expected: cannot resolve `../../src/testing/live-host`; after that exists, the first plugins fail on real behavioral gaps. Fix each gap in the shim with a focused commit naming the plugin and the missing behavior — that is the point of the suite.

- [ ] **Step 3: Write the tag-wrangler harvest test**

Create `host/packages/host/test/golden/tag-wrangler.test.ts`. This is the acceptance case for registration harvesting and it asserts the honest result, not a flattering one:

```ts
import { describe, expect, it } from "vitest";
import { LiveHost } from "../../src/testing/live-host";

describe("tag-wrangler harvest", () => {
  it("harvests menu entry points from a plugin with zero commands", async () => {
    const host = await LiveHost.startWithGoldenPlugin("tag-wrangler", {
      "Tagged.md": "---\ntags: [alpha]\n---\n#beta\n",
    });
    try {
      // Zero commands. Measured, not hoped.
      expect(await host.call("host.list_commands", {})).toEqual({ commands: [] });

      // Exactly ONE editor-menu hook is the entire harvestable surface, and
      // there are zero file-menu hooks. These are the honest numbers from the
      // shipped bundle, recorded in Task 0 Step 4c.
      const hooks = host.harvest().menuHooks().filter((hook) => hook.pluginId === "tag-wrangler");
      expect(hooks.map((hook) => hook.context)).toEqual(["editor-menu"]);
      expect(await host.call("host.list_menu_items", { context: "file-menu", path: "Tagged.md" }))
        .toEqual({ items: [] });

      const items = await host.call<{ items: Array<{ title: string }> }>(
        "host.list_menu_items", { context: "editor-menu", path: "Tagged.md" },
      );
      expect(items.items.length).toBeGreaterThan(0);

      const report = await host.call<{ report: { plugins: Array<{ scan: { tier_estimate: number } }> } }>(
        "host.compat_report", { plugin_id: "tag-wrangler" },
      );
      expect(report.report.plugins[0]?.scan.tier_estimate).toBe(2);

      // Ten DOM-delegated listeners, unreachable with no DOM. Not "at least
      // one": the count is ground truth and a drift in either direction means
      // either the bundle changed or the detector stopped seeing them.
      const unreachable = host.harvest().unreachable()
        .filter((entry) => entry.kind === "dom_delegated_menu");
      expect(unreachable).toHaveLength(10);
      // Two of those ten are contextmenu-typed; the other eight are
      // pointerdown/drag/mouseover/click. v1 claimed all ten were contextmenu.
      expect(unreachable.filter((entry) => entry.detail.includes("contextmenu"))).toHaveLength(2);

      expect(host.unsupportedHits()).toEqual([]);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it("survives all four things its onLayoutReady body does", async () => {
    const host = await LiveHost.startWithGoldenPlugin("tag-wrangler", {
      "Tagged.md": "---\ntags: [alpha]\naliases: [Ay]\n---\n#beta\n",
      "Other.md": "#alpha\n",
    });
    try {
      // 1. getCachedFiles() + getCache() — the frontmatter scan.
      // 2 & 3. registerEvent(metadataCache.on("changed")) and
      //        registerEvent(vault.on("delete")) — it stays a live subscriber,
      //        so a later edit must reach it without throwing.
      // 4. workspace.getLeavesOfType("tag") — must be [], never undefined.
      expect(host.app().workspace.getLeavesOfType("tag")).toEqual([]);
      await host.call("write_note", {
        path: "Tagged.md",
        content: "---\ntags: [alpha]\naliases: [Bee]\n---\n#beta\n",
        expected: { any: true },
      });
      await host.quiesce();
      await host.call("delete_note", { path: "Other.md", mode: "permanent", expected: { any: true } });
      await host.quiesce();
      expect(host.quarantine().failuresFor("tag-wrangler")).toBe(0);
      expect(host.unsupportedHits()).toEqual([]);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it("degrades honestly when it reaches for global-search", async () => {
    const host = await LiveHost.startWithGoldenPlugin("tag-wrangler", { "Tagged.md": "#beta\n" });
    try {
      const internal = host.app().internalPlugins.getPluginById("global-search");
      expect(internal?.instance).toBeNull();
      expect(host.quarantine().failuresFor("tag-wrangler")).toBe(0);
    } finally {
      await host.stop();
    }
  }, 60_000);
});
```

- [ ] **Step 4: Write the QuickAdd non-interactive test**

Create `host/packages/host/test/golden/quickadd.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LiveHost } from "../../src/testing/live-host";

const goldenRoot = join(__dirname, "..", "..", "..", "..", "fixtures", "golden", "quickadd");

describe("quickadd non-interactive flows", () => {
  it("creates a note byte-for-byte from a non-interactive Template choice", async () => {
    const host = await LiveHost.startWithGoldenPlugin("quickadd", {
      "Templates/Daily.md": readFileSync(join(goldenRoot, "vault", "Templates", "Daily.md"), "utf8"),
    });
    try {
      const commands = await host.call<{ commands: Array<{ id: string; name: string }> }>(
        "host.list_commands", { plugin_id: "quickadd" },
      );
      // QuickAdd registers one command per choice; the fixture's data.json
      // names exactly one non-interactive Template choice.
      const template = commands.commands.find((command) => command.name.includes("Daily"));
      expect(template).toBeDefined();

      const invoked = await host.call<{ ran: boolean; notices: string[] }>(
        "host.invoke_command", { command_id: template!.id },
      );
      expect(invoked.ran).toBe(true);
      await host.quiesce();

      const written = await host.call<{ content_base64: string }>(
        "read_file", { path: "Journal/2026-08-30.md" },
      );
      expect(Buffer.from(written.content_base64, "base64").toString("utf8"))
        .toBe(readFileSync(join(goldenRoot, "expected", "Journal", "2026-08-30.md"), "utf8"));
      expect(host.unsupportedHits()).toEqual([]);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it("runs a Macro whose step is a user script needing require('node:crypto')", async () => {
    // Research surprise #3: QuickAdd user scripts are Node-native. Its loader
    // is `new Function("require", "module", "exports", src)` called with
    // `m => window.require && window.require(m)`, so the whole feature rests on
    // `window.require` being a real function bound to the host's resolver.
    // This is the end-to-end proof that Task 13's provisioning works.
    const host = await LiveHost.startWithGoldenPlugin("quickadd", {
      "Scripts/hash.md": [
        "```js",
        "module.exports = async (params) => {",
        '  const crypto = require("node:crypto");',
        '  const digest = crypto.createHash("sha256").update("vaultd").digest("hex").slice(0, 8);',
        '  await params.app.vault.create("Out/hashed.md", `digest: ${digest}\\n`);',
        "};",
        "```",
        "",
      ].join("\n"),
      "Out/.keep": "",
    });
    try {
      const commands = await host.call<{ commands: Array<{ id: string; name: string }> }>(
        "host.list_commands", { plugin_id: "quickadd" },
      );
      const macro = commands.commands.find((command) => command.name.includes("Hash"));
      expect(macro).toBeDefined();

      await host.call("host.invoke_command", { command_id: macro!.id });
      await host.quiesce();

      const written = await host.call<{ content_base64: string }>(
        "read_file", { path: "Out/hashed.md" },
      );
      // sha256("vaultd") truncated to eight hex characters — the same value the
      // Task 13 unit fixture asserts, so the two agree end to end.
      expect(Buffer.from(written.content_base64, "base64").toString("utf8"))
        .toMatch(/^digest: [0-9a-f]{8}\n$/);
      expect(host.unsupportedHits()).toEqual([]);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it("fails an interactive choice with interaction_unavailable instead of hanging", async () => {
    const host = await LiveHost.startWithGoldenPlugin("quickadd", { "A.md": "x\n" });
    try {
      const commands = await host.call<{ commands: Array<{ id: string; name: string }> }>(
        "host.list_commands", { plugin_id: "quickadd" },
      );
      const interactive = commands.commands.find((command) => command.name.includes("Choose"));
      expect(interactive).toBeDefined();

      // No client has attached as the interaction handler. QuickAdd's
      // `plugin.api` is a GETTER that mints a fresh ChoiceExecutor with
      // `interactive = true` on every read, so nothing can be injected through
      // it — the prompt is unavoidable and the only correct outcome is a fast
      // typed failure. `await` proves it does not hang: the assertion is
      // reached, which a hang would prevent.
      await expect(host.call("host.invoke_command", { command_id: interactive!.id }))
        .rejects.toMatchObject({ code: "interaction_unavailable" });
      expect(host.quarantine().isQuarantined("quickadd")).toBe(false);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it("reports its own tier and unreachable surface honestly", async () => {
    const host = await LiveHost.startWithGoldenPlugin("quickadd", { "A.md": "x\n" });
    try {
      const report = await host.call<{
        report: { plugins: Array<{ id: string; verdict: string; scan: { tier_estimate: number } }> };
      }>("host.compat_report", { plugin_id: "quickadd" });
      const entry = report.report.plugins[0]!;
      expect(entry.id).toBe("quickadd");
      expect(entry.scan.tier_estimate).toBe(1);
      // "degrades", not "runs": its interactive choices genuinely do not work
      // headless, and a report that said "runs" would be a lie of omission.
      expect(entry.verdict).toBe("degrades");
    } finally {
      await host.stop();
    }
  }, 60_000);
});
```

The `scenario.json` for quickadd must therefore describe the **Template** choice (the one the golden tree compares), and its `settings` must contain all three choices — Template, Macro, and the interactive one — because three of the four cases above read commands QuickAdd only registers if its `data.json` declares them.

- [ ] **Step 5: Write the static no-direct-writes check**

Create `host/packages/host/test/no-write-imports.test.ts`. The runtime guard from Task 1 catches namespace calls; this catches the import form it cannot see:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = join(__dirname, "..", "src");
const BANNED = /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync|copyFile|copyFileSync|cp|cpSync|createWriteStream)\b/;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "testing" ? [] : files(full);
    return full.endsWith(".ts") ? [full] : [];
  });

describe("no direct filesystem writes in host source", () => {
  it("imports no fs write function outside src/testing", () => {
    const offenders: string[] = [];
    for (const file of files(srcRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:fs(?:\/promises)?["']/g)) {
        if (BANNED.test(match[1] ?? "")) offenders.push(`${file}: ${match[1]?.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

Note the deliberate exemptions, both of which the `files()` walk implements by name: `src/testing/` (the guard and the harness family) and `src/datadir.ts` (the one module allowed to write outside the vault, which asserts at runtime that every target resolves under `config.dataDir` — Task 6b). Add a third assertion to the same file: **`src/datadir.ts` exists and is the only non-`testing` file matching the banned import pattern**, so the exemption cannot silently grow to a second file.

```ts
it("has exactly one exempt writer, and it is datadir.ts", () => {
  const writers = files(srcRoot, { includeExempt: true })
    .filter((file) => BANNED.test(readFileSync(file, "utf8")));
  expect(writers.map((file) => relative(srcRoot, file)).sort()).toEqual(["datadir.ts"]);
});
```

- [ ] **Step 6: Run the whole suite and record baselines**

```bash
npm --prefix host run typecheck
npm --prefix host run lint
npm --prefix host test
```

Then create `docs/performance/headless-host-baseline.md` recording, each against a named benchmark case and measured three times: host cold start with the mirror plus 10 plugins on the 10k fixture (target < 2 s); plugin write round trip from `vault.modify` to the promise resolving with the mirror applied (target p50 < 50 ms); full hydration wall time and added RSS; per-plugin load time; the timer registry with cadences. Baselines, not contracts — but numbers, so they can fail.

- [ ] **Step 7: Prove the suite is stable**

Run the golden suite three consecutive times and record all three results in the baseline document. A suite that is green once is not green.

```bash
for i in 1 2 3; do npm --prefix host test -- golden || break; done
```

- [ ] **Step 8: Write the design document and update the contracts**

Import the design from the vault note into `docs/design/headless-plugin-host.md` so the repo is self-contained, noting the note as its source and the Rulings date. Update `VAULTD-COMPATIBILITY.md`: Tier 3 moves from "research contract" to a measured status naming the golden plugins that pass, the API policy counts by category, and the explicit statement that Obsidian parity is pinned against observed behavior at a named version and never derived from Obsidian's source. Update `README.md` to list the `host/` workspace and the `vaultd-host` binary.

- [ ] **Step 9: Commit documentation separately**

```bash
git add docs/design/headless-plugin-host.md docs/performance/headless-host-baseline.md VAULTD-COMPATIBILITY.md README.md
git commit -m "docs: document the headless plugin host and its measured compatibility"
```

- [ ] **Step 10: Independent review**

Use `superpowers:requesting-code-review` or a fresh review subagent that did not implement the code. Review the complete diff for: any path where a vault byte could be written without a mutation op; shim symbols returning `undefined` where Obsidian returns an empty array; policy-table gaps that would silently return `undefined` instead of throwing `HeadlessUnsupported`; lifecycle ordering that could deliver an event before `resolved`; mirror generation handling that could apply a delta twice or skip one; socket authentication bypasses; secret leakage through `host.info` or the compatibility report; unbounded queues; and `HostConfig` values that drifted from the Global Constraints list. Record each real finding, write a failing regression test first, fix it in a focused `fix(...)` commit, and have the same reviewer re-check. Do not self-declare the review clean.

- [ ] **Step 11: Produce the handoff report**

Report: branch and commit list; final test count and every verification command; independent review outcome and fix commits; the three baseline numbers and the three consecutive golden runs; the compatibility report for all eight golden plugins including their `unsupported` hits; confirmation that the fs guard recorded zero direct vault writes across the whole suite; confirmation that `~/vault` was never a test target; deviations from this plan with reasons; and local-only status unless the maintainer separately authorizes push, PR, or merge.

Do not push, open a PR, merge, or delete a worktree without explicit authorization.

---

## Spec coverage matrix

Twenty-seven tasks: 0, 1, 2, 3, 4, 5, 6, 6b, 7, 8, 9, 10, 11a, 11b, 12, 13, 14, 14b, 15, 16a, 17, 18, 19, 20, 20b, 21, 22 — in that order, which is also document order.

| Design requirement | Implementation task |
|---|---:|
| Ground truth observed from a running Obsidian, never from `app.asar` | 0 |
| Workspace, Node LTS, strict TypeScript, no Electron | 1 |
| Goal 4 — the host writes no vault bytes directly, proven by instrumentation | 1, 6b, 19, 22 |
| `vaultd` stdio client, framing, correlation, partial-chunk survival | 2 |
| Unknown-variant wire tolerance; subscription-registration race | 3 |
| Supervisor, restart, bidirectional process lifecycle, injected `env` | 4 |
| Mirror hydration via snapshot sessions; the eight wire DTOs | 5 |
| Goal 5 — read-your-writes ordering through the shim | 6, 7 |
| `resync_required`, revision-diff synthesis, `config_changed` fan-out | 6, 12, 15 |
| Test-harness family, injected clock, real-parser fixture generator | 6b |
| `TFile`/`TFolder`/`TAbstractFile` with real `instanceof`; `Vault`; `DataAdapter` | 7 |
| Rename synthesis from the delete/create pair (the wire has no rename) | 7, 15 |
| Same-path `process` serialization (mutation-spec Ruling 2) | 7 |
| `CachedMetadata` incl. `sections`, `listItems`, `frontmatterLinks`, positioned links | 8 |
| `FileManager`, surgical `processFrontMatter`, rename refetch by backlink set | 9 |
| Goal 2 — registration harvest as capabilities | 10, 16a |
| Four-way API policy with `absent` as the default, tested for completeness | 7, 11b, 20 |
| Workspace and DOM safe stubs; empty arrays, never `undefined` | 11a |
| The `obsidian` barrel, `Notice`/`NoticeLog`, components, search | 11b |
| `app.plugins`, `app.internalPlugins` (Ruling 4), `app.commands`, `Editor` | 12 |
| Module interception, `electron` stub + registry, QuickAdd `window.require` | 1, 13 |
| Headless config directory (Ruling 1, 2) | 14 |
| GUI co-existence check and 60 s poll (Ruling 3) | 14, 20b |
| Quarantine at 5/60 s (Ruling 8) — the tracker | 14b |
| Quarantine's harvest removal and typed refusal — end to end | 16a |
| Goal 3 — the exact lifecycle; late-enable synthetic `resolved` (Ruling 6) | 15 |
| Engine restart without plugin reload (Ruling 7) | 15 |
| Host socket, multi-client, mirror-served snapshots (Ruling 5) | 16a |
| Socket security: directory `0700` enforces, socket `0600` in depth, nonce gate | 16a |
| Goal 6 — config schema ladder and write safety (Ruling 8) | 17, 20b |
| Goal 8 — interaction brokerage, 120 s timeout (Ruling 8) | 18, 20b |
| Dry-run with an explicit intercepted-surface list | 19 |
| Goal 7 — the compatibility detector, with tests | 20, 20b |
| Wedged-thread watchdog over `SharedArrayBuffer` + `Atomics` | 21 |
| Golden-plugin suite, baselines, contracts, independent review | 22 |

### Deferred, and named rather than implied

The matrix above is only honest if it also says what this phase does **not** deliver. Five things:

1. **`CachedMetadata.footnotes`, `.footnoteRefs`, `.referenceLinks`** — real fields in the current `obsidian.d.ts` that `vaultd` does not parse. Declared `absent` with policy, measured by `parity-footnotes`, and excluded by name from the parity comparison (Task 0 Step 5, Task 8). Closing the gap is a `vault-core` parse change, not a host change.
2. **obsidian-linter's CodeMirror 6 editor path** — no CM6 exists headless, so its golden scenario drives the file path only. `Editor` (Task 12) covers `editorCallback` commands; it is not a CM6 transaction and the golden README says so.
3. **tag-wrangler's ten DOM-delegated entry points** — structurally unreachable with no DOM. Recorded as `HarvestedUnreachable`, asserted at exactly ten in Task 22, and fixable only by a per-plugin adapter, which is deferred by the design.
4. **QuickAdd's interactive choices** — `plugin.api` is a getter minting `interactive = true` on every read, so nothing can be injected. They fail typed with `interaction_unavailable` and quickadd's verdict is `degrades`, not `runs`.
5. **Schema ladder rung 4 (LLM introspection)** — an offline tool that emits the same cached format. Rungs 1–3 ship in Task 17; rung 4 is out of scope for this phase and `source: "llm"` simply never appears.

---

## Execution checkpoints

Pause for a fresh-context review after Tasks 4, 6b, 11b, 15, 16a, and 20b. Those are the six points where a wrong decision becomes expensive: the process boundary, the harness contract every later test depends on, the policy table, the lifecycle order, the wire, and the completed server. A reviewer should reject a checkpoint if an interface diverges from this plan, a test cannot prove the invariant it claims, a shim symbol returns `undefined` where Obsidian returns an empty array, a `host.*` field is `camelCase`, or any code path could put a byte in the vault without a `vaultd` mutation op.

Tasks 0 and 22 need the maintainer at a live Obsidian: Task 0 to capture the parity fixtures and the golden outcomes, Task 22 to confirm the captured scenarios still describe what the maintainer wants the plugins to do.

Reviewable groupings: Tasks 2–6 are the client and mirror, with no shim at all. Task 6b is the harness contract and should be reviewed on its own, because eleven later tasks are written against it. Tasks 7–13 are the shim and can be reviewed one API group at a time. Tasks 14–19 compose the daemon. Tasks 20–22 are measurement and proof.

**Tasks that do not need phase 5.** If the mutation/bulk-read phase is still landing, Tasks 0, 1, 6b, 10, 11a, 11b, 13, 17, 20, and 21 are all implementable and green against fixtures and the fake daemon (Preflight gate, Part B). That is ten of the twenty-seven, including the whole harness family and the policy table — enough to keep moving without stubbing the daemon inside the host, which is the thing the gate exists to prevent.

The implementation stays local-only until the maintainer chooses the GitHub or merge workflow. This plan authorizes implementation and local commits, not external publication or worktree deletion.
