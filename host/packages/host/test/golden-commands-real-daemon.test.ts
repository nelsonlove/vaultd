/**
 * A golden plugin's **editor commands**, driven end to end against the real
 * `vaultd`.
 *
 * This is the acceptance case for the editor construction path, and it exists
 * because the path's first version could not run a single one of them. Six of
 * obsidian-linter's seven commands are `editorCheckCallback`s whose checking
 * arm reads the second argument's `file` — the `MarkdownFileInfo` Obsidian
 * hands over — and a host that handed them the inert leaf's `View` instead got
 * `false` from every one. Nothing threw, nothing was reported, no host error
 * was raised: the commands simply did not happen. A unit case with a fixture
 * plugin cannot see that, because a fixture plugin reads whatever it is given.
 * A real bundle asking a real question can.
 *
 * **What is asserted, and what each one proves.**
 *
 * 1. `obsidian-linter:ignore-folder` — an `editorCheckCallback` guarding on
 *    `ctx.file.parent.isRoot()`, with an effect that needs no editor at all.
 *    It runs, and the folder it was invoked on lands in the plugin's own
 *    settings. This is the B1 shape in its purest form.
 * 2. `obsidian-linter:lint-all-files-in-folder` — the golden's own captured
 *    action, same guard, and its effect is bytes: the note in that folder is
 *    rewritten in the vault, through `vault.modify`.
 * 3. `obsidian-linter:lint-file` — the remaining editor command, pinned at what
 *    it really does. Its check arm is `isMarkdownFile(ctx.file) && editor.cm != null`,
 *    so it now gets **past** `ctx.file` and stops at `editor.cm`: this host has
 *    no CodeMirror 6 `EditorView`, and `fixtures/golden/README.md` records that
 *    same gap from the capture ("the linter's GUI save path runs through a
 *    CodeMirror 6 dispatch transaction … no headless equivalent exists"). The
 *    case asserts the file half is satisfied and the `cm` half is not, so the
 *    day a CM6 surface arrives this case says what changed.
 *
 * **Two deliberate departures from the capture, neither of them a conformance
 * claim.** The note is staged in a subfolder (the check arms refuse a file at
 * the vault root — Obsidian refuses it too, which is why the capture called
 * `runLinterAllFilesInFolder` directly), and `auto-correct-common-misspellings`
 * is switched off in the staged settings so the run does not read the plugin's
 * 918 KB misspellings table on every test. What is asserted is that the command
 * ran and had its effect, never that the bytes match `expected/`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Mirror } from "../src/mirror/mirror";
import { assembleShim } from "../src/testing/assemble";
import { defaultHostConfig, systemClock } from "../src/config";
import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot, startedOn } from "./real-daemon";
import type { HostAssembly } from "../src/testing/assemble";
import type { HostConfig } from "../src/config";
import type { MirrorChangeBatch } from "../src/mirror/types";
import type { PluginManifest } from "../src/shim/plugin";

const GOLDEN = join(__dirname, "..", "..", "..", "fixtures", "golden", "obsidian-linter");
const PLUGIN_ID = "obsidian-linter";
const NOTE = "Notes/Messy note.md";

interface Staged {
  readonly assembly: HostAssembly;
  readonly vaultRoot: string;
  /** The live plugin instance, so a case can read the settings it changed. */
  readonly plugin: LinterPlugin;
}

/** As much of obsidian-linter's instance as this file reads. */
interface LinterPlugin {
  load(): Promise<void>;
  settings: { foldersToIgnore: string[] };
}

/** The captured settings, with the misspellings table switched off. */
function stagedSettings(): unknown {
  const scenario = JSON.parse(readFileSync(join(GOLDEN, "scenario.json"), "utf8")) as {
    settings: { ruleConfigs: Record<string, { enabled?: boolean }> };
  };
  const settings = scenario.settings;
  const autoCorrect = settings.ruleConfigs["auto-correct-common-misspellings"];
  if (autoCorrect !== undefined) autoCorrect.enabled = false;
  return settings;
}

function vaultFor(): HostConfig {
  const root = scratchRoot("vaultd-golden-cmd-");
  const vault = join(root, "vault");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, NOTE), readFileSync(join(GOLDEN, "vault", "Messy note.md"), "utf8"));
  const settingsDir = join(vault, ".obsidian-headless", "plugins", PLUGIN_ID);
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "data.json"), JSON.stringify(stagedSettings(), null, 2), "utf8");
  const index = join(root, "index.db");
  return {
    ...defaultHostConfig(vault),
    vaultdBinary: BINARY,
    vaultdArgs: ["--vault", vault, "--index", index],
    indexPath: index,
    restartBackoffMs: [50, 50],
  };
}

/** A shim over a real engine, with the real bundle loaded into it. */
async function stagedHost(): Promise<Staged> {
  const config = vaultFor();
  const supervisor = await startedOn(config);
  const mirror = await Mirror.open(() => supervisor.client(), config);
  const assembly = assembleShim({
    config,
    client: () => supervisor.client(),
    mirror,
    clock: systemClock(),
  });
  mirror.onBatch((batch: MirrorChangeBatch) => {
    assembly.app.vault.applyBatch(batch);
  });

  const manifest = JSON.parse(
    readFileSync(join(GOLDEN, "plugin", "manifest.json"), "utf8"),
  ) as PluginManifest;
  manifest.dir = `${config.configDirName}/plugins/${PLUGIN_ID}`;
  const code = readFileSync(join(GOLDEN, "plugin", "main.js"), "utf8");
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  // The only way to evaluate a CommonJS bundle the way the host's own loader
  // will. The code is a checked-in fixture copied from a real plugin.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("module", "exports", "require", "process", "global", code) as (
    m: unknown,
    e: unknown,
    r: unknown,
    p: unknown,
    g: unknown,
  ) => void;
  factory(
    moduleObject,
    moduleObject.exports,
    (specifier: string): unknown => {
      if (specifier === "obsidian") return assembly.api;
      throw new Error(`no module ${specifier}`);
    },
    process,
    globalThis,
  );
  const exported = moduleObject.exports as { default?: unknown };
  const ctor = (typeof exported === "function" ? exported : exported.default) as new (
    app: unknown,
    manifest: PluginManifest,
  ) => LinterPlugin;
  const plugin = new ctor(assembly.app, manifest);
  await assembly.queue.run(PLUGIN_ID, `${PLUGIN_ID}:onload`, () =>
    assembly.events.attributingTo(PLUGIN_ID, () => plugin.load()),
  );
  assembly.app.workspace.markLayoutReady();
  // The host's own loader (Task 13/14) is what registers a plugin with
  // `app.plugins`; this file stands in for it, because the commands under test
  // are reached through `app.commands` rather than through the registry.
  assembly.app.plugins.register(plugin as never);
  return { assembly, vaultRoot: config.vaultRoot, plugin };
}

/**
 * Wait for `check` to hold, or say what it still saw.
 *
 * The linter's folder lint is fired and not awaited by the command callback —
 * `createFolderLintModal` returns before `runLinterAllFilesInFolder` has
 * written anything — so the effect lands after the command has answered. A bare
 * assertion would race it.
 */
async function waitFor(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(cleanupRealDaemons);

describe.skipIf(!BINARY_EXISTS)("a golden plugin's editor commands against a real vaultd", () => {
  it("runs the linter's folder commands, which every one of them guards on ctx.file", async () => {
    const { assembly, vaultRoot, plugin } = await stagedHost();
    const { app } = assembly;
    const file = app.vault.getFileByPath(NOTE);
    expect(file, "the staged note is in the vault").not.toBeNull();

    // Every one of these is registered as an editorCheckCallback.
    for (const id of ["lint-file", "lint-all-files-in-folder", "ignore-folder"]) {
      expect(app.commands.kindOf(`${PLUGIN_ID}:${id}`), id).toBe("editorCheckCallback");
    }

    // 1. `lint-all-files-in-folder`: the golden's own captured action. Its
    //    effect is bytes in the vault. It runs FIRST: step 2 puts this very
    //    folder on the plugin's ignore list, after which the linter skips it.
    const before = readFileSync(join(vaultRoot, NOTE), "utf8");
    const linted = await app.commands.invokeCommandById(
      `${PLUGIN_ID}:lint-all-files-in-folder`,
      { file },
    );
    expect(linted, "lint-all-files-in-folder ran").toBe(true);
    await waitFor("the folder lint to rewrite the note", () => {
      return readFileSync(join(vaultRoot, NOTE), "utf8") !== before;
    });
    const after = readFileSync(join(vaultRoot, NOTE), "utf8");
    // The linter's own fixes, on the golden's own messy note: the padded hash
    // and the trailing whitespace both go.
    expect(before).toContain("#  Heading with padded hash");
    expect(after).toContain("# Heading with padded hash");
    expect(after).not.toContain("trailing spaces.   ");

    // 2. `ignore-folder`: guards on `ctx.file.parent`, needs no editor, and its
    //    effect is in the plugin's own settings. Before the context carried a
    //    `file`, this answered `false` and changed nothing.
    expect(plugin.settings.foldersToIgnore).not.toContain("Notes");
    const ran = await app.commands.invokeCommandById(`${PLUGIN_ID}:ignore-folder`, { file });
    expect(ran, "ignore-folder ran").toBe(true);
    await waitFor("the folder to reach the ignore list", () =>
      plugin.settings.foldersToIgnore.includes("Notes"),
    );

    // 3. `lint-file`: now reaches its second guard. `ctx.file` is satisfied;
    //    `editor.cm` is not, because this host has no CodeMirror 6 view — the
    //    gap `fixtures/golden/README.md` records from the capture.
    const editorPath = await app.commands.invokeCommandById(`${PLUGIN_ID}:lint-file`, { file });
    expect(editorPath, "lint-file still needs a CodeMirror 6 editor").toBe(false);
  }, 120_000);
});
