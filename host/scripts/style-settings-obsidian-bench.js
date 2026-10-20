#!/usr/bin/env node
"use strict";
/**
 * Time stock Style Settings in a live Obsidian: from enabling the plugin to
 * `#css-settings-manager` holding its final text (it includes the plugin's own
 * 100 ms debounce). The comparison for `docs/performance/web-plugins-baseline.md`.
 *
 *   node host/scripts/style-settings-obsidian-bench.js --vault <scratch vault> \
 *        --realistic-vault <dir holding the realistic fixture> --out <json file> [--runs 20] [--vault-name <name>] [--dry]
 *
 * --vault is a disposable scratch copy of the Style Settings fixture that the
 * owner has open in Obsidian. The script drives only that vault, with the same
 * safety as `style-settings-capture.js`: every CLI call runs with that folder
 * as its working directory, every eval first checks `app.vault.adapter.basePath`
 * equals it (otherwise the eval does nothing and the script exits 3), and each
 * CLI call is killed after 60 s.
 *
 * What it does:
 *   1. "small": 20 runs with the vault as it is.
 *   2. Copies the Minimal theme and the realistic `data.json` from
 *      --realistic-vault into the scratch vault, switches the theme, and does
 *      20 runs again ("realistic").
 *   3. Always, at the end: restores the first `appearance.json` and
 *      `data.json`, switches the theme back, and removes the copied theme.
 *
 * Each run: disable the plugin, wait 300 ms, enable it, and take the time until
 * the element's text equals the text a calibration run settled on. A
 * MutationObserver takes the time, so the timer does not wait for a poll. A run
 * is void if `document.hasFocus()` is false; if the window is not in the
 * foreground the script stops and writes nothing but the reason.
 */

const { spawnSync } = require("node:child_process");
const { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve, sep } = require("node:path");

const PLUGIN_ID = "obsidian-style-settings";
const THEME = "Minimal";
const FIXTURE_THEME = "Fixture Theme";

function parseArgs(argv) {
  const out = { runs: 20, dry: false };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    if (flag === "--dry") { out.dry = true; continue; }
    const value = argv[at + 1];
    at += 1;
    if (value === undefined) throw new Error(`${flag} wants a value`);
    if (flag === "--vault") out.vault = resolve(value);
    else if (flag === "--vault-name") out.vaultName = value;
    else if (flag === "--realistic-vault") out.realistic = resolve(value);
    else if (flag === "--out") out.out = resolve(value);
    else if (flag === "--runs") out.runs = Number(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!out.vault || !out.realistic || !out.out) throw new Error("needs --vault, --realistic-vault and --out");
  if (!out.vaultName) out.vaultName = out.vault.split(sep).filter(Boolean).pop();
  for (const forbidden of [join(homedir(), "obsidian"), join(homedir(), "obsidian-old"), join(homedir(), "Downloads", "obsidian-old")]) {
    if (out.vault === forbidden || out.vault.startsWith(forbidden + sep)) throw new Error(`--vault must not be under ${forbidden}`);
  }
  return out;
}

let vaultCwd = null;

function obsidian(vaultName, args) {
  const result = spawnSync("timeout", ["-s", "KILL", "60", "obsidian", `vault=${vaultName}`, ...args], {
    cwd: vaultCwd ?? undefined, encoding: "utf8", timeout: 70_000, killSignal: "SIGKILL",
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function wrapEval(expected, body) {
  return `(async () => { const base = app.vault.adapter.basePath; if (base !== ${JSON.stringify(expected)}) return JSON.stringify({ refused: base }); return JSON.stringify({ value: await (${body})() }); })()`;
}

function evalIn(options, expected, body) {
  const answer = obsidian(options.vaultName, ["eval", `code=${wrapEval(expected, body)}`]);
  let parsed;
  try {
    parsed = JSON.parse(answer.stdout.trim().replace(/^=>\s*/, ""));
  } catch {
    throw new Error(`the eval gave no JSON (exit ${answer.code}): ${answer.stdout.slice(0, 400)} ${answer.stderr.slice(0, 400)}`);
  }
  if ("refused" in parsed) {
    console.error(`style-settings-obsidian-bench: eval ran in ${parsed.refused}, not the scratch vault; stopping`);
    process.exit(3);
  }
  return parsed.value;
}

const SLEEP = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));";

/** Disable, enable, wait for the text to settle, and keep the settled text and classes as the reference. */
const CALIBRATE = `async () => {
  ${SLEEP}
  const id = ${JSON.stringify(PLUGIN_ID)};
  await app.plugins.disablePlugin(id);
  await sleep(300);
  await app.plugins.enablePlugin(id);
  const deadline = Date.now() + 10000;
  let el = null;
  while (Date.now() < deadline) {
    el = document.getElementById("css-settings-manager");
    if (el && el.textContent.length > 0) break;
    await sleep(50);
  }
  await sleep(1500);
  el = document.getElementById("css-settings-manager");
  window.__ssFinal = el ? el.textContent : null;
  window.__ssClasses = [...document.body.classList].sort();
  return { length: window.__ssFinal ? window.__ssFinal.length : null, classes: window.__ssClasses, theme: app.vault.getConfig("cssTheme"), focus: document.hasFocus(), visibility: document.visibilityState };
}`;

const ONE_RUN = `async () => {
  ${SLEEP}
  const id = ${JSON.stringify(PLUGIN_ID)};
  const final = window.__ssFinal;
  if (typeof final !== "string") throw new Error("no calibration text");
  const focus = document.hasFocus();
  await app.plugins.disablePlugin(id);
  await sleep(300);
  let t1 = null;
  const check = () => {
    if (t1 !== null) return;
    const el = document.getElementById("css-settings-manager");
    if (el && el.textContent === final) t1 = performance.now();
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  const t0 = performance.now();
  await app.plugins.enablePlugin(id);
  const t1load = performance.now();
  while (t1 === null && performance.now() - t0 < 10000) { check(); await sleep(1); }
  observer.disconnect();
  await sleep(200);
  const el = document.getElementById("css-settings-manager");
  return { ms: t1 === null ? null : t1 - t0, enable_returned_ms: t1load - t0, same_text: !!el && el.textContent === final, focus, visibility: document.visibilityState };
}`;

const SET_THEME = (name) => `async () => {
  ${SLEEP}
  const id = ${JSON.stringify(PLUGIN_ID)};
  await app.plugins.disablePlugin(id);
  if (typeof app.customCss.readThemes === "function") await app.customCss.readThemes();
  await app.customCss.setTheme(${JSON.stringify(name)});
  await sleep(1000);
  await app.plugins.enablePlugin(id);
  await sleep(1500);
  return { theme: app.vault.getConfig("cssTheme"), themes: Object.keys(app.customCss.themes || {}) };
}`;

const PROBE = `async () => ({ focus: document.hasFocus(), visibility: document.visibilityState, theme: app.vault.getConfig("cssTheme"), version: typeof app.getVersion === "function" ? app.getVersion() : null,
  hasCustomCss: typeof (app.customCss && app.customCss.setTheme), plugin: !!app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}] })`;

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const mid = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: sorted.length, min: sorted[0], median, p95: pick(0.95), max: sorted[sorted.length - 1] };
}

function measure(options, expected, label) {
  const calibration = evalIn(options, expected, CALIBRATE);
  console.log(`${label}: calibration ${JSON.stringify({ ...calibration, classes: calibration.classes.length })}`);
  if (!calibration.focus) throw Object.assign(new Error("the Obsidian window is not in the foreground; the numbers would be void"), { void: true });
  const runs = [];
  for (let i = 0; i < options.runs; i += 1) {
    const run = evalIn(options, expected, ONE_RUN);
    if (!run.focus) throw Object.assign(new Error("the Obsidian window lost focus during the runs; the numbers are void"), { void: true });
    if (run.ms === null || !run.same_text) throw new Error(`run ${i} did not reach the settled text: ${JSON.stringify(run)}`);
    runs.push(run);
    console.log(`${label}: run ${i + 1} ${run.ms.toFixed(1)} ms`);
  }
  return { calibration, runs, ms: stats(runs.map((r) => r.ms)), enable_returned_ms: stats(runs.map((r) => r.enable_returned_ms)) };
}

function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`style-settings-obsidian-bench: ${error.message}`); process.exit(2); }
  if (options.dry) {
    const expected = options.vault;
    for (const [name, body] of [["probe", PROBE], ["calibrate", CALIBRATE], ["run", ONE_RUN], ["set theme", SET_THEME(THEME)]]) console.log(`// ---- ${name} ----\n${wrapEval(expected, body)}\n`);
    return;
  }
  const expected = realpathSync(options.vault);
  vaultCwd = expected;
  const info = obsidian(options.vaultName, ["vault", "info=path"]);
  if (info.code !== 0 || realpathSync(info.stdout.trim() || "/nonexistent-guard") !== expected) {
    console.error(`style-settings-obsidian-bench: the CLI answers for ${JSON.stringify(info.stdout.trim())}, not ${expected}`);
    process.exit(3);
  }
  const obs = join(expected, ".obsidian");
  const pluginData = join(obs, "plugins", PLUGIN_ID, "data.json");
  const appearance = join(obs, "appearance.json");
  const themeDir = join(obs, "themes", THEME);
  if (!existsSync(join(obs, "themes", FIXTURE_THEME, "theme.css"))) { console.error("the scratch vault does not hold the fixture theme"); process.exit(2); }
  const backup = join(options.out + ".backup");
  mkdirSync(backup, { recursive: true });
  copyFileSync(appearance, join(backup, "appearance.json"));
  copyFileSync(pluginData, join(backup, "data.json"));

  const result = { vault: "scratch copy of the Style Settings fixture", started: new Date().toISOString() };
  let failure = null;
  try {
    result.probe = evalIn(options, expected, PROBE);
    console.log(`probe: ${JSON.stringify(result.probe)}`);
    if (!result.probe.focus) throw Object.assign(new Error("the Obsidian window is not in the foreground; the numbers would be void"), { void: true });
    result.small = measure(options, expected, "small");

    cpSync(join(options.realistic, ".obsidian", "themes", THEME), themeDir, { recursive: true });
    copyFileSync(join(options.realistic, ".obsidian", "plugins", PLUGIN_ID, "data.json"), pluginData);
    result.set_theme = evalIn(options, expected, SET_THEME(THEME));
    console.log(`theme: ${JSON.stringify(result.set_theme)}`);
    if (result.set_theme.theme !== THEME) throw new Error("the theme did not switch");
    // setTheme may have rewritten the data file on enable; write the realistic one again and reload.
    copyFileSync(join(options.realistic, ".obsidian", "plugins", PLUGIN_ID, "data.json"), pluginData);
    result.realistic = measure(options, expected, "realistic");
  } catch (error) {
    failure = error;
    result.error = error.message;
    result.void = !!error.void;
  } finally {
    try {
      // Restore: plugin off, files back, theme back, copied theme removed, plugin on.
      evalIn(options, expected, `async () => { await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)}); return true; }`);
      copyFileSync(join(backup, "data.json"), pluginData);
      evalIn(options, expected, `async () => { if (app.customCss.readThemes) await app.customCss.readThemes(); await app.customCss.setTheme(${JSON.stringify(FIXTURE_THEME)}); return app.vault.getConfig("cssTheme"); }`);
      copyFileSync(join(backup, "appearance.json"), appearance);
      copyFileSync(join(backup, "data.json"), pluginData);
      if (existsSync(themeDir)) rmSync(themeDir, { recursive: true, force: true });
      result.restored = evalIn(options, expected, `async () => { if (app.customCss.readThemes) await app.customCss.readThemes(); await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)}); await new Promise((r) => setTimeout(r, 1500)); return { theme: app.vault.getConfig("cssTheme"), minimal_listed: Object.keys(app.customCss.themes || {}).includes(${JSON.stringify(THEME)}) }; }`);
      // The plugin may save its data when it loads; put the original bytes back last, then reload from them.
      copyFileSync(join(backup, "data.json"), pluginData);
      copyFileSync(join(backup, "appearance.json"), appearance);
    } catch (error) {
      result.restore_error = error.message;
      console.error(`restore failed: ${error.message}; the originals are in ${backup}`);
    }
  }
  result.finished = new Date().toISOString();
  writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${options.out}`);
  if (failure) { console.error(`style-settings-obsidian-bench: ${failure.message}`); process.exit(failure.void ? 4 : 2); }
}

main();
