#!/usr/bin/env node
"use strict";
/**
 * Capture what a live Obsidian does with the Style Settings fixture vault.
 *
 *   node host/scripts/style-settings-capture.js capture --vault <fixture vault path> \
 *        --out host/fixtures/style-settings/expected [--vault-name <name>] [--dry]
 *
 * The fixture is `host/fixtures/style-settings/vault/`. The owner copies it to a
 * scratch path outside the repository, opens that copy in Obsidian by hand, and
 * then runs this script with --vault set to the copy. Nothing in this script
 * opens a vault.
 *
 * Five files go to --out:
 *
 *   classes.json      `body.className` as a sorted class list, in light and in dark mode
 *   style-text.json   the text of `#css-settings-manager`, in light and in dark mode
 *   plugin-data.json  the plugin's saved values as Obsidian holds them after load
 *                     (the plugin prunes keys on load), and the file on disk
 *   dom-probe.json    Obsidian's DOM helpers (`createEl` and the rest), `outerHTML` per case
 *   meta.json         Obsidian, installer and plugin versions, and the date
 *
 * Safety, copied from `bases-capture.js`: before anything else, and again
 * inside every `eval`, the script checks that the vault the CLI answers for is
 * the path given, and exits 3 otherwise. Every CLI call runs with that vault as
 * its working directory (the CLI's `eval` follows the working directory, not
 * `vault=`). It refuses a path that is not the fixture (the theme, snippet and
 * plugin must be there), and any path under `~/obsidian` or `~/obsidian-old`.
 * It writes only inside --out, which must be inside the repository.
 *
 * --dry runs no CLI command, writes nothing, and prints the code of every eval,
 * so the code can be read before the live run.
 */

const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, realpathSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve, sep } = require("node:path");

const REPO = resolve(__dirname, "..", "..");
const PLUGIN_ID = "obsidian-style-settings";

/** Files that identify the fixture vault; a vault without all of them is refused. */
const FIXTURE_MARKERS = [
  join(".obsidian", "themes", "Fixture Theme", "theme.css"),
  join(".obsidian", "snippets", "fixture-snippet.css"),
  join(".obsidian", "plugins", PLUGIN_ID, "manifest.json"),
];

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const out = { mode, dry: false };
  for (let at = 0; at < rest.length; at += 1) {
    const flag = rest[at];
    if (flag === "--dry") {
      out.dry = true;
      continue;
    }
    const value = rest[at + 1];
    at += 1;
    if (value === undefined) throw new Error(`${flag} wants a value`);
    if (flag === "--vault") out.vault = resolve(value);
    else if (flag === "--vault-name") out.vaultName = value;
    else if (flag === "--out") out.out = resolve(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (mode !== "capture") throw new Error("the mode is capture");
  if (!out.vault || !out.out) throw new Error("capture needs --vault and --out");
  if (!out.vaultName) out.vaultName = out.vault.split(sep).filter(Boolean).pop();
  for (const forbidden of [join(homedir(), "obsidian"), join(homedir(), "obsidian-old"), join(homedir(), "Downloads", "obsidian-old")]) {
    if (out.vault === forbidden || out.vault.startsWith(forbidden + sep)) throw new Error(`--vault must not be under ${forbidden}`);
  }
  if (!out.out.startsWith(REPO + sep)) throw new Error(`--out must be inside ${REPO}`);
  return out;
}

/** The fixture check: the vault holds the fixture's theme, snippet and plugin. */
function checkFixture(vault) {
  if (!existsSync(vault)) throw new Error(`--vault ${vault} does not exist`);
  const missing = FIXTURE_MARKERS.filter((marker) => !existsSync(join(vault, marker)));
  if (missing.length) throw new Error(`--vault is not the fixture vault; missing ${missing.join(", ")}`);
}

let vaultCwd = null;

function obsidian(vaultName, args) {
  // The vault as the working directory, and SIGKILL on timeout: the CLI's
  // `eval` follows the working directory, and the CLI ignores SIGTERM.
  const result = spawnSync("obsidian", [`vault=${vaultName}`, ...args], {
    cwd: vaultCwd ?? undefined,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function guard(options) {
  const expected = realpathSync(options.vault);
  vaultCwd = expected;
  const info = obsidian(options.vaultName, ["vault", "info=path"]);
  if (info.code !== 0 || realpathSync(info.stdout.trim() || "/nonexistent-guard") !== expected) {
    console.error(`style-settings-capture: the CLI answers for ${JSON.stringify(info.stdout.trim())}, not ${expected}; is the fixture open as ${options.vaultName}?`);
    process.exit(3);
  }
  return expected;
}

/** The code one eval runs: it refuses to run its body unless the app's vault is the fixture. */
function wrapEval(expected, body) {
  return `(async () => { const base = app.vault.adapter.basePath; if (base !== ${JSON.stringify(expected)}) return JSON.stringify({ refused: base }); return JSON.stringify({ value: await (${body})() }); })()`;
}

/** Run JavaScript in the app, refusing the answer unless it came from the fixture. */
function evalInFixture(options, expected, body) {
  const answer = obsidian(options.vaultName, ["eval", `code=${wrapEval(expected, body)}`]);
  let parsed;
  try {
    parsed = JSON.parse(answer.stdout.trim().replace(/^=>\s*/, ""));
  } catch {
    console.error(`style-settings-capture: the eval gave no JSON (exit ${answer.code}): ${answer.stdout.slice(0, 500)} ${answer.stderr.slice(0, 500)}`);
    process.exit(2);
  }
  if ("refused" in parsed) {
    console.error(`style-settings-capture: eval ran in ${parsed.refused}, not the fixture; stopping`);
    process.exit(3);
  }
  return parsed.value;
}

// ---------------------------------------------------------------------------
// The evals. Each is the source of an async arrow function that runs in the app.
// ---------------------------------------------------------------------------

/** Poll until `#css-settings-manager` exists and holds text (10 s), then let the debounce and the load-time save settle. */
const WAIT_FOR_PLUGIN = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 10000;
  let el = null;
  while (Date.now() < deadline) {
    el = document.getElementById("css-settings-manager");
    if (el && el.textContent.length > 0) break;
    await sleep(100);
  }
  if (!el) throw new Error("#css-settings-manager did not appear within 10 s; is Style Settings enabled and Restricted mode off?");
  // The plugin's parse is debounced by 100 ms, and it may save once while it loads.
  await sleep(700);
`;

/** Run `fn` in light mode and in dark mode, and restore the theme the app had. */
const WITH_BOTH_MODES = `
  const original = app.vault.getConfig("theme");
  // The Obsidian build captured against switches the mode with changeTheme; setTheme does not
  // change the body class there. Fall back to setTheme on builds without changeTheme.
  const switchMode = (theme) => (typeof app.changeTheme === "function" ? app.changeTheme(theme) : app.setTheme(theme));
  const results = {};
  try {
    for (const [mode, theme] of [["light", "moonstone"], ["dark", "obsidian"]]) {
      switchMode(theme);
      await sleep(300);
      app.workspace.trigger("css-change");
      await sleep(700);
      const isLight = document.body.classList.contains("theme-light");
      const isDark = document.body.classList.contains("theme-dark");
      if (mode === "light" ? !isLight || isDark : !isDark || isLight) throw new Error("the app did not switch to " + mode + " mode");
      results[mode] = capture();
    }
  } finally {
    switchMode(original);
    await sleep(300);
  }
`;

const STEP_CLASSES = `async () => {
  ${WAIT_FOR_PLUGIN}
  const capture = () => [...document.body.classList].sort();
  ${WITH_BOTH_MODES}
  return { light: results.light, dark: results.dark };
}`;

const STEP_STYLE_TEXT = `async () => {
  ${WAIT_FOR_PLUGIN}
  const capture = () => document.getElementById("css-settings-manager").textContent;
  ${WITH_BOTH_MODES}
  return { light: results.light, dark: results.dark, equal: results.light === results.dark };
}`;

const STEP_PLUGIN_DATA = `async () => {
  ${WAIT_FOR_PLUGIN}
  const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
  if (!plugin) throw new Error("the plugin is not loaded");
  const inMemory = plugin.settingsManager ? JSON.parse(JSON.stringify(plugin.settingsManager.settings)) : null;
  const onDisk = JSON.parse(await app.vault.adapter.read(app.vault.configDir + "/plugins/" + ${JSON.stringify(PLUGIN_ID)} + "/data.json"));
  return { in_memory: inMemory, on_disk: onDisk };
}`;

/** The probe of Obsidian's DOM helpers: one case per option, `outerHTML` for each. */
const STEP_DOM_PROBE = `async () => {
  const host = document.body.createDiv({ cls: "vaultd-probe-host" });
  const cases = {};
  const record = (name, fn) => {
    try {
      const result = fn();
      cases[name] = { html: typeof result === "string" ? result : result.outerHTML };
    } catch (error) {
      cases[name] = { error: String(error && error.message || error) };
    }
  };
  const fragment = () => createFragment((f) => { f.createEl("b", { text: "frag" }); f.appendText(" tail"); });
  try {
    // createEl / createDiv / createSpan options
    record("cls_string", () => createEl("div", { cls: "a b" }));
    record("cls_array", () => createEl("div", { cls: ["a", "b"] }));
    record("text_string", () => createEl("div", { text: "hi <b>&amp;" }));
    record("text_fragment", () => createEl("div", { text: fragment() }));
    record("attr_null_false_number", () => createEl("div", { attr: { a: null, b: false, c: 0, d: 1, e: "s", f: true, g: undefined } }));
    record("title", () => createEl("div", { title: "tip" }));
    record("value_input", () => createEl("input", { value: "v" }));
    record("value_div", () => createEl("div", { value: "v" }));
    record("type_input", () => createEl("input", { type: "checkbox" }));
    record("placeholder", () => createEl("input", { placeholder: "ph" }));
    record("href", () => createEl("a", { href: "https://example.invalid/", text: "l" }));
    record("parent", () => { const p = host.createDiv(); createEl("span", { parent: p, text: "kid" }); return p; });
    record("prepend", () => { const p = host.createDiv(); p.createSpan({ text: "first" }); p.createSpan({ text: "second", prepend: true }); return p; });
    record("callback", () => createEl("p", { text: "cb" }, (el) => el.addClass("from-callback")));
    record("createDiv", () => createDiv({ cls: "d", text: "t" }));
    record("createSpan", () => createSpan({ cls: "s", text: "t" }));
    record("el_createEl", () => { const p = host.createDiv(); p.createEl("em", { text: "e" }); return p; });
    // setAttr
    record("setAttr_string", () => { const e = createDiv(); e.setAttr("data-x", "1"); return e; });
    record("setAttr_null", () => { const e = createDiv({ attr: { "data-x": "1" } }); e.setAttr("data-x", null); return e; });
    record("setAttr_false", () => { const e = createDiv({ attr: { "data-x": "1" } }); e.setAttr("data-x", false); return e; });
    record("setAttr_zero", () => { const e = createDiv(); e.setAttr("data-x", 0); return e; });
    record("setAttr_true", () => { const e = createDiv(); e.setAttr("data-x", true); return e; });
    // setText / appendText / empty
    record("setText_string", () => { const e = createDiv({ text: "old" }); e.setText("new"); return e; });
    record("setText_fragment", () => { const e = createDiv({ text: "old" }); e.setText(fragment()); return e; });
    record("appendText", () => { const e = createDiv({ text: "a" }); e.appendText("b"); return e; });
    record("empty", () => { const e = createDiv(); e.createSpan({ text: "x" }); e.appendText("y"); e.empty(); return e; });
    // classes
    record("addClass_many", () => { const e = createDiv(); e.addClass("a", "b"); return e; });
    record("removeClass", () => { const e = createDiv({ cls: ["a", "b"] }); e.removeClass("a"); return e; });
    record("toggleClass_true", () => { const e = createDiv(); e.toggleClass("on", true); return e; });
    record("toggleClass_false", () => { const e = createDiv({ cls: "on" }); e.toggleClass("on", false); return e; });
    record("toggleClass_array", () => { const e = createDiv(); e.toggleClass(["a", "b"], true); return e; });
    record("hasClass", () => String(createDiv({ cls: "a" }).hasClass("a")));
    // fragments
    record("createFragment_callback", () => { const d = createDiv(); d.appendChild(fragment()); return d; });
  } finally {
    host.remove();
  }
  return cases;
}`;

const STEP_META = `async () => {
  const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
  let installer = null;
  try { installer = navigator.userAgent.match(/obsidian\\/([\\d.]+)/i)?.[1] ?? null; } catch { /* none */ }
  let appVersion = null;
  try { appVersion = (typeof app.getVersion === "function" ? app.getVersion() : null) ?? app.appVersion ?? null; } catch { /* none */ }
  if (!appVersion) {
    try { appVersion = require("electron").ipcRenderer.sendSync("version"); } catch { /* none */ }
  }
  let apiVersion = null;
  try { apiVersion = require("obsidian").apiVersion ?? null; } catch { /* none */ }
  return {
    obsidian_version: appVersion,
    installer_version: installer,
    api_version: apiVersion,
    user_agent: navigator.userAgent,
    plugin_version: plugin ? plugin.manifest.version : null,
    theme: app.vault.getConfig("cssTheme") ?? null,
  };
}`;

const STEPS = [
  ["classes.json", STEP_CLASSES],
  ["style-text.json", STEP_STYLE_TEXT],
  ["plugin-data.json", STEP_PLUGIN_DATA],
  ["dom-probe.json", STEP_DOM_PROBE],
];

function writeJson(dir, name, value) {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function dry(options) {
  const expected = resolve(options.vault);
  console.log(`// --dry: no CLI command runs and nothing is written; the vault would be ${expected}, the output ${options.out}`);
  for (const [name, body] of [...STEPS, ["meta.json", STEP_META]]) {
    console.log(`\n// ---- ${name} ----\n${wrapEval(expected, body)}`);
  }
}

function capture(options) {
  checkFixture(options.vault);
  const expected = guard(options);
  mkdirSync(options.out, { recursive: true });
  for (const [name, body] of STEPS) {
    writeJson(options.out, name, evalInFixture(options, expected, body));
    console.log(`wrote ${name}`);
  }
  const meta = evalInFixture(options, expected, STEP_META);
  // The CLI's own version, where the installed CLI answers it.
  const cli = obsidian(options.vaultName, ["version"]);
  writeJson(options.out, "meta.json", {
    ...meta,
    cli_version: cli.code === 0 ? cli.stdout.trim() : null,
    captured_at: new Date().toISOString(),
    fixture: "host/fixtures/style-settings/vault",
  });
  console.log(`wrote meta.json; captured into ${options.out}`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`style-settings-capture: ${error.message}`);
    process.exit(2);
  }
  if (options.dry) {
    dry(options);
    return;
  }
  try {
    capture(options);
  } catch (error) {
    console.error(`style-settings-capture: ${error.message}`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { STEPS, STEP_META, parseArgs, wrapEval };
