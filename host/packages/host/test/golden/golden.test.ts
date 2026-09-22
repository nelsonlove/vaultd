/**
 * The golden-plugin conformance suite: a **real host** over a **real `vaultd`**,
 * running the **real community bundle**, against the outcome a **real Obsidian**
 * produced.
 *
 * Three honesty rules govern this file, and all three come from the fixture
 * corpus rather than from the host:
 *
 * 1. **Every `expected/` tree was produced by observing a live Obsidian**
 *    (1.13.4, 2026-09-09), never by reading `app.asar` and never by running
 *    this host and blessing its output. `host/fixtures/golden/README.md` records
 *    how each was taken and what it cost.
 * 2. **Four of the eight captured no file mutation at all**, because their
 *    flagship step is behind a modal that the capture would have left open in
 *    the human's live session. For those the honest claim is "loading the plugin
 *    and invoking the reachable command changes nothing", and that is what the
 *    tree comparison asserts — a smoke test, not a conformance claim. The
 *    README says so and so does {@link POLICY}.
 * 3. **Two captures are not byte-stable on their own**, and each declares the
 *    normalisation it needs rather than having it applied quietly: the linter
 *    writes `created`/`modified` from the wall clock, and the rollover's file
 *    names are the capture date. A comparison that silently ignored either
 *    would be a comparison that could not fail.
 *
 * What the suite is for is the fourth thing: a shim regression anywhere — a
 * surface returning `undefined` where Obsidian returns `[]`, a write path that
 * stopped flushing, a metadata event that stopped arriving — turns one of these
 * red against a tree nobody in this repository authored.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINARY_EXISTS, cleanupRealDaemons, scratchRoot } from "../real-daemon";
import { LiveHost, goldenRoot, goldenScenario } from "../../src/testing/live-host";
import { installFsWriteGuard } from "../../src/testing/fs-guard";

const GOLDEN_ROOT = goldenRoot();

/**
 * Excluded from the comparison, and each for its own reason.
 *
 * - `.obsidian` — the GUI's config dir. The host reads it (config fallback) and
 *   never writes it, but Obsidian rewrites `workspace.json` and
 *   `appearance.json` on its own schedule, so including it would make the
 *   golden tree a moving target.
 * - `.obsidian-headless` — the host's own config dir: plugin bundles,
 *   `data.json`. Not vault content and deliberately divergent.
 * - `.host-state` — where a {@link LiveHost} keeps its data directory and its
 *   socket, inside the vault root so a live case can never reach the
 *   developer's `$XDG_STATE_HOME`. Not vault content either.
 * - `.trash` — local trash, whose contents depend on delete mode.
 */
const EXCLUDED_DIRS = new Set([".obsidian", ".obsidian-headless", ".host-state", ".trash"]);

/**
 * Text is compared as text so a failure diff is readable. Everything else is
 * compared by hash, because `readFileSync(png, "utf8")` mangles the bytes
 * through lossy replacement characters — two different images can compare
 * equal, and an identical image can compare unequal across platforms. A golden
 * suite that cannot tell two PNGs apart is not proving what it claims.
 */
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".canvas", ".css", ".yaml", ".yml", ".csv", ".svg",
]);

interface CasePolicy {
  /**
   * What this case may compare against.
   *
   * - `tree` — the whole vault against `expected/`. The conformance claim.
   * - `input` — the whole vault against `vault/`: this action **changes
   *   nothing on this host**, and the `why` says which surface it is missing.
   *   It is an assertion, not a shrug: the day the host grows that surface this
   *   case goes red and is upgraded to `tree` rather than drifting green.
   * - `none` — `expected/` is not a capture of the action the scenario names,
   *   so comparing the two would assert a tree nobody observed.
   */
  readonly compare: "tree" | "input" | "none";
  /**
   * The command drops the promise its own work is on, so the host cannot know
   * when it has finished and the only honest wait is on the vault itself.
   *
   * `callback: () => { this.rollover(); }` — no `return`, no `await`. Obsidian
   * cannot tell either; a human sees the note change a moment after the palette
   * closes. So the driver waits for the tree rather than for the call, and a
   * wrong tree still fails: the wait ends at the first match or at the deadline,
   * and the assertion that follows is the same one.
   */
  readonly asyncCommand?: boolean;
  /** The plugin's `onload` is expected to throw, and the message to match this. */
  readonly expectLoadFailure?: RegExp;
  /** The scenario's action is expected to be refused, with this message. */
  readonly expectRefusal?: RegExp;
  /** Files in `expected/` that are records of the outcome, not vault content. */
  readonly expectedNotVaultFiles?: readonly string[];
  /** Frontmatter keys the capture wrote from the wall clock. */
  readonly normalizeFrontmatter?: readonly string[];
  /** Config files the plugin needs, written into the headless config dir. */
  readonly configFiles?: Readonly<Record<string, unknown>>;
  /**
   * Extra vault files the scenario's action needs and the capture's `vault/`
   * does not hold.
   *
   * One case uses it. quickadd's captured action was `runQuickAdd`, which only
   * opens a suggester, so the capture never needed a template; the scenario now
   * names a Template choice, and a Template choice without its template is a
   * refusal rather than a test.
   */
  readonly stageFiles?: Readonly<Record<string, string>>;
  /** Rename `vault/` and `expected/` paths from the capture date to today's. */
  readonly dateRemap?: boolean;
  /**
   * Stage the fixture one folder deep instead of at the vault root, and read
   * `expected/` the same way.
   *
   * Declared, never quiet, and it exists for exactly one plugin. The capture
   * ran inside `Fixtures/vaultd-golden-capture/<id>/` in a live vault, so the
   * notes were in a folder; the fixture promoted that folder to a vault root.
   * For most plugins that is invisible. obsidian-linter's
   * `lint-all-files-in-folder` is an `editorCheckCallback` whose checking arm
   * is `view.file.parent ? !view.file.parent.isRoot() : false` — it refuses,
   * by its own rule, for a note at the vault root — so replaying at the root
   * measures the flattening rather than the plugin.
   */
  readonly stageUnder?: string;
  /** Why this case claims what it claims. Quoted in a failure. */
  readonly why: string;
}

/**
 * What each golden may honestly claim, from `host/fixtures/golden/README.md`.
 *
 * The table is here rather than in the fixtures because it is a statement about
 * *this driver* — what it compares and what it declines to compare — and the
 * README is the statement about the capture. They have to agree, and the `why`
 * lines are the README's own reasons so a drift between the two is visible.
 */
const POLICY: Readonly<Record<string, CasePolicy>> = {
  "automatic-linker": {
    compare: "input",
    why:
      "The command runs and writes nothing, and the reason is one symbol. `format-file` is an " +
      "editorCallback whose whole body is gated on `captureFormattingTarget()`, which is " +
      "`{ file: workspace.getActiveFile(), editor: workspace.getActiveViewOfType(MarkdownView)?.editor }` " +
      "and returns null unless BOTH are there. This host sets the active file for an editor " +
      "command and answers `getActiveViewOfType` with null — a Task 12 decision taken on purpose, " +
      "because a MarkdownView would satisfy `instanceof` and promise a rendering surface, a " +
      "previewMode and a getMode() that do not exist. So the capture's own note holds: `expected/` " +
      "was produced by calling `modifyLinks(...)` + `vault.modify` directly, not by the command. " +
      "Reversing the Task 12 decision is a design call, not Task 22's to make; see " +
      "task-22a-report.md.",
  },
  "find-replace": {
    compare: "tree",
    why: "Smoke, not conformance: both its commands only open a panel, so expected/ equals vault/ and the claim is that nothing changed.",
  },
  "folder-notes": {
    compare: "tree",
    why: "A real mutation capture: Create folder note for current folder produced Project/Project.md, empty.",
  },
  "nested-properties": {
    compare: "tree",
    expectLoadFailure: /threw during onload/,
    expectRefusal: /no plugin registered a command "nested-properties:toggle-full-key-display"/,
    why:
      "It does not load, and that is the honest outcome rather than a defect to hide. Its " +
      "`onload` builds property-editor widgets off `app.metadataTypeManager.registeredTypeWidgets` " +
      "and asserts each is non-null; this host answers an empty map — a Task 12 decision, written " +
      "down there: the widgets are a GUI rendering surface the host does not have, and inventing " +
      "one would be inventing behaviour from no capture. So the plugin throws at its `listWidget` " +
      "getter, is rolled back, registers no command, and the scenario's action is refused. " +
      "expected/ equals vault/, so the tree still compares. Whether that is acceptable is a " +
      "recorded decision (VAULTD-COMPATIBILITY.md).",
  },
  "obsidian-linter": {
    compare: "tree",
    normalizeFrontmatter: ["created", "modified"],
    stageUnder: "Lint",
    why: "A real mutation capture of the FILE path (vault.modify), not the CodeMirror 6 editor path, which has no headless equivalent. created/modified are wall-clock and are normalised.",
  },
  "obsidian-rollover-daily-todos": {
    compare: "tree",
    dateRemap: true,
    asyncCommand: true,
    configFiles: {
      "core-plugins.json": ["daily-notes"],
      "daily-notes.json": { folder: "Daily", format: "YYYY-MM-DD", template: "" },
    },
    why: "A real mutation capture, date-dependent: the capture's 2026-09-09 is 'today', so both file names are remapped onto the replay date.",
  },
  quickadd: {
    compare: "none",
    // QuickAdd's per-choice command is `callback: () => this.runChoice(...)`:
    // it drops the promise, so `host.invoke_command` answers `ran: true` while
    // the choice is still writing.
    asyncCommand: true,
    stageFiles: {
      "Templates/Daily.md": "# Daily\n\n- [ ] first thing\n",
      // The folder the choice writes into, present before the daemon starts:
      // a root-level folder created under a live watcher is a
      // `resync_required { watcher_overflow }`, which is the daemon's
      // behaviour and not this case's subject.
      "Journal/.keep": "",
    },
    why: "expected/ is byte-identical to vault/ because the capture ran runQuickAdd, which only opens a suggester. The scenario now names a Template choice that really writes a note, and NO live Obsidian produced that tree — comparing against expected/ would assert an outcome nobody observed. See test/golden/quickadd.test.ts for what is asserted instead; a capture in a scratch vault driven by hand would close this.",
  },
  "tag-wrangler": {
    compare: "tree",
    expectedNotVaultFiles: ["editor-menu.json"],
    why: "The plugin registers no commands; the capture is the six editor-menu items in expected/editor-menu.json, and the vault is unchanged.",
  },
};

/** The capture date the rollover fixture's file names carry. */
const ROLLOVER_CAPTURE = { today: "2026-09-09", yesterday: "2026-09-08" };

const treeOf = (root: string, policy: CasePolicy): Record<string, string> => {
  const skip = new Set(policy.expectedNotVaultFiles ?? []);
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
      if (skip.has(key)) continue;
      if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out[key] = normalize(readFileSync(full, "utf8"), policy);
      } else {
        const raw = readFileSync(full); // Buffer, no encoding.
        out[key] = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      }
    }
  };
  walk(root);
  return out;
};

/**
 * Blank out the frontmatter values a capture wrote from the wall clock.
 *
 * Declared per case rather than applied to every case: a normalisation nobody
 * asked for is a comparison that cannot fail, and the two keys this exists for
 * are named in the linter fixture's own notes.
 */
function normalize(source: string, policy: CasePolicy): string {
  let out = source;
  for (const key of policy.normalizeFrontmatter ?? []) {
    out = out.replace(new RegExp(`^${key}: .*$`, "gm"), `${key}: <normalized>`);
  }
  return out;
}

/** The capture's date in a path, replaced by the replay's. */
function remapDates(path: string, dates: { today: string; yesterday: string }): string {
  return path
    .replace(ROLLOVER_CAPTURE.today, dates.today)
    .replace(ROLLOVER_CAPTURE.yesterday, dates.yesterday);
}

function isoDay(offsetDays: number): string {
  const at = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return at.toISOString().slice(0, 10);
}

/** Rename every capture-dated file under `root` onto the replay's dates. */
function applyDateRemap(root: string, dates: { today: string; yesterday: string }): void {
  const daily = join(root, "Daily");
  if (!existsSync(daily)) return;
  for (const name of readdirSync(daily)) {
    const renamed = remapDates(name, dates);
    if (renamed !== name) renameSync(join(daily, name), join(daily, renamed));
  }
}

/** Write the core-plugin config a golden declares it needs. */
function seedConfigFiles(root: string, policy: CasePolicy): void {
  const dir = join(root, ".obsidian-headless");
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(policy.configFiles ?? {})) {
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

afterEach(async () => {
  await cleanupRealDaemons();
});

describe.skipIf(!BINARY_EXISTS)("golden plugin conformance", () => {
  const cases = readdirSync(GOLDEN_ROOT).filter((name) =>
    statSync(join(GOLDEN_ROOT, name)).isDirectory(),
  );

  it("covers all eight golden plugins", () => {
    expect(cases.sort()).toEqual([
      "automatic-linker", "find-replace", "folder-notes", "nested-properties",
      "obsidian-linter", "obsidian-rollover-daily-todos", "quickadd", "tag-wrangler",
    ]);
  });

  it("has a declared policy for every golden", () => {
    expect(Object.keys(POLICY).sort()).toEqual(cases.sort());
  });

  for (const pluginId of cases) {
    it(`reproduces real Obsidian's outcome for ${pluginId}`, async () => {
      const policy = POLICY[pluginId];
      if (policy === undefined) throw new Error(`no policy for ${pluginId}`);
      const scenario = goldenScenario(pluginId);
      const dates = { today: isoDay(0), yesterday: isoDay(-1) };

      const work = scratchRoot(`vaultd-golden-${pluginId}-`);
      const stagedAt = policy.stageUnder === undefined ? work : join(work, policy.stageUnder);
      cpSync(join(GOLDEN_ROOT, pluginId, "vault"), stagedAt, { recursive: true });
      if (policy.dateRemap === true) applyDateRemap(stagedAt, dates);
      seedConfigFiles(work, policy);
      for (const [path, body] of Object.entries(policy.stageFiles ?? {})) {
        const full = join(work, path);
        mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
        writeFileSync(full, body, "utf8");
      }

      // **Staged before the guard is armed.** Copying a fixture in is a direct
      // write by this test; the claim the guard exists to make is about the
      // *host*, and arming it over the scaffolding would make every case red
      // for the one thing it is not about.
      const config = LiveHost.stage({
        vaultRoot: work,
        installPlugin: { id: pluginId, from: join(GOLDEN_ROOT, pluginId, "plugin") },
        data: scenario.settings,
      });

      const guard = installFsWriteGuard(work);
      let host: LiveHost | null = null;
      let diagnosis = "the host never started";
      try {
        host = await LiveHost.startOn(config);
        const live = host;
        // **Set before the call, refreshed after it.** A command the host
        // refuses outright — `command_not_found`, because the plugin's `onload`
        // never got as far as registering it — rejects before any assertion,
        // and a failure with no startup report beside it is a failure that
        // needs a second run to read.
        const view = (answer: unknown): string =>
          JSON.stringify(
            {
              answer,
              loaded: live.startup.loaded,
              failed: live.startup.failed,
              unsupported: live.unsupportedHits(),
              quarantined: [...live.quarantine().quarantined()],
            },
            null,
            2,
          );
        diagnosis = view("not called yet");
        if (policy.expectLoadFailure !== undefined) {
          const failure = live.startup.failed.find((entry) => entry.id === pluginId);
          expect(failure?.error ?? "the plugin loaded", policy.why).toMatch(
            policy.expectLoadFailure,
          );
        } else {
          expect(live.startup.loaded, `${policy.why}\n\n${view("not called yet")}`).toContain(
            pluginId,
          );
        }

        const params = remapParams(scenario.action.params, policy, dates);
        let answer: unknown;
        try {
          answer = await host.call(scenario.action.op, params);
          if (policy.expectRefusal !== undefined) {
            throw new Error(
              `${scenario.action.op} was expected to be refused and answered ` +
                `${JSON.stringify(answer)} instead`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (policy.expectRefusal === undefined || !policy.expectRefusal.test(message)) {
            throw new Error(
              `${scenario.action.op} ${JSON.stringify(params)} was refused: ${message}\n\n` +
                `The host's own view:\n${view("refused")}`,
            );
          }
          answer = { refused: message };
        }
        await host.quiesce();
        if (policy.asyncCommand === true) {
          // **Wait for the vault, because the command cannot be waited on.**
          // Two ends to the wait: the tree reaches what the capture says it
          // should (the fast, exact end), or it stops moving across three
          // consecutive round trips (the end for a case with nothing to
          // compare against). Both are bounded, and either way the assertion
          // that follows is the same one — a wrong tree still fails.
          //
          // The stability end is not optional even for a `compare: "none"`
          // case: stopping the host while a dropped promise is still writing
          // leaves the plugin calling a supervisor that has gone, which
          // surfaces as an unhandled `no engine is running` and fails the run
          // without failing a test.
          const want =
            policy.compare === "none"
              ? null
              : JSON.stringify(
                  remapTree(
                    treeOf(join(GOLDEN_ROOT, pluginId, policy.compare === "tree" ? "expected" : "vault"), policy),
                    policy,
                    dates,
                  ),
                );
          const deadline = Date.now() + 15_000;
          let previous: string | null = null;
          let still = 0;
          for (;;) {
            await host.quiesce();
            const now = JSON.stringify(treeOf(work, policy));
            if (want !== null && now === want) break;
            still = now === previous ? still + 1 : 0;
            previous = now;
            if (still >= 2 || Date.now() > deadline) break;
          }
        }
        // **The host's own view, kept for the failure message.** A tree diff
        // says what is different; this says what the host thought it did — did
        // the plugin load, did the command run, what did it reach for that this
        // host does not have. Without it every failure here starts with a
        // re-run to find out.
        diagnosis = view(answer);
      } finally {
        await host?.stop();
        guard.release();
      }

      guard.assertClean();
      if (policy.compare !== "none") {
        // `tree` is the capture; `input` is the fixture's own input tree, which
        // is what "this action changes nothing here" means as an assertion.
        const against = join(GOLDEN_ROOT, pluginId, policy.compare === "tree" ? "expected" : "vault");
        const expected = remapTree(treeOf(against, policy), policy, dates);
        expect(treeOf(work, policy), `${policy.why}\n\nThe host's own view:\n${diagnosis}`).toEqual(
          expected,
        );
      }
    }, 120_000);
  }
});

/**
 * The scenario's params, moved onto the replay: the capture's dates become the
 * replay's, and a vault path becomes the staged one.
 *
 * Only the two keys that carry a vault path are prefixed, by name. A blanket
 * "prefix every string" would rewrite a command id, and a command id with a
 * folder in front of it names nothing.
 */
const VAULT_PATH_PARAMS = new Set(["active_file", "path"]);

function remapParams(
  params: Record<string, unknown>,
  policy: CasePolicy,
  dates: { today: string; yesterday: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    const dated = policy.dateRemap === true ? remapDates(value, dates) : value;
    out[key] =
      policy.stageUnder !== undefined && VAULT_PATH_PARAMS.has(key)
        ? `${policy.stageUnder}/${dated}`
        : dated;
  }
  return out;
}

function remapTree(
  tree: Record<string, string>,
  policy: CasePolicy,
  dates: { today: string; yesterday: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, body] of Object.entries(tree)) {
    const dated = policy.dateRemap === true ? remapDates(path, dates) : path;
    out[policy.stageUnder === undefined ? dated : join(policy.stageUnder, dated)] = body;
  }
  return out;
}
