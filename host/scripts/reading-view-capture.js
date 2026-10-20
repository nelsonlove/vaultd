#!/usr/bin/env node
"use strict";
/**
 * Capture what a live Obsidian renders in reading view for the reading-view fixture vault.
 *
 *   node host/scripts/reading-view-capture.js capture --vault <fixture vault path> \
 *        --out host/fixtures/reading-view/expected [--vault-name <name>] [--dry]
 *
 * The fixture is `host/fixtures/reading-view/vault/`. The owner copies it to a
 * scratch path outside the repository, opens that copy in Obsidian by hand, and
 * then runs this script with --vault set to the copy. Nothing in this script
 * opens a vault.
 *
 * Files written to --out:
 *
 *   html/<note>.html       the normalised `.markdown-preview-sizer` innerHTML of each note
 *   raw-html/<note>.html   the same innerHTML before normalisation
 *   frontmatter.json       per note, `metadataCache.getFileCache(file).frontmatter`
 *   render-markdown.json   `MarkdownRenderer.render` into a detached div, for the renderMarkdown
 *                          question (E27): whether blocks are wrapped in `div.el-*`
 *   meta.json              versions, the date, the normalisation, the notes that did not settle
 *
 * Per note, the script opens the note in a leaf in reading mode, then polls the
 * child count of that leaf's `.markdown-preview-sizer` until it has not changed
 * for 300 ms (at most 5 s; a note that never settles is recorded in meta.json
 * and its html is captured as it stands). The sizer is looked up inside the
 * leaf, not with `document.querySelector`, so a second open leaf cannot answer.
 *
 * Normalisations, applied here to the raw innerHTML (the raw copy is kept):
 *
 *   1. `style` is removed from the elements whose class is `markdown-preview-pusher`
 *      or `markdown-preview-sizer` (Obsidian sets width, height, margin and padding
 *      there from the window size). No other `style` attribute is touched.
 *   2. The `data-*` attributes in BOOKKEEPING_DATA are removed. They are the ones
 *      Obsidian adds for its own bookkeeping. `data-href`, `data-callout*`,
 *      `data-task` and `data-heading` are always kept. Any other `data-*` attribute
 *      is kept and listed in meta.json as `unlisted_data_attributes`, so a first
 *      live run shows which ones the list is missing.
 *   3. Whitespace between tags (`>` whitespace `<`) is collapsed to nothing. This also
 *      applies inside `<pre>`; the whitespace that matters in code is inside text nodes,
 *      which this does not touch.
 *
 * Safety, copied from `style-settings-capture.js`: before anything else, and
 * again inside every `eval`, the script checks that the vault the CLI answers
 * for is the path given, and exits 3 otherwise. Every CLI call runs with that
 * vault as its working directory (the CLI's `eval` follows the working
 * directory, not `vault=`), under a 60 s SIGKILL timeout. It refuses a path that
 * is not the fixture, and any path under `~/obsidian` or `~/obsidian-old`. It
 * writes only inside --out, which must be inside the repository.
 *
 * --dry runs no CLI command, writes nothing, and prints the code of every eval,
 * so the code can be read before the live run.
 */

const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve, sep } = require("node:path");

const REPO = resolve(__dirname, "..", "..");

/** Files that identify the fixture vault; a vault without all of them is refused. */
const FIXTURE_MARKERS = [
  join(".obsidian", "app.json"),
  "frontmatter-types.md",
  "view-field-code.md",
  "Embedded Base.base",
];

/** `data-*` attributes Obsidian adds for its own bookkeeping; removed by normalisation 2. A first live run checks the list. */
const BOOKKEEPING_DATA = ["data-line", "data-ln", "data-section", "data-section-index", "data-tooltip-position", "data-block-id"];
/** `data-*` attributes that are always kept. */
const KEPT_DATA = [/^data-href$/, /^data-callout/, /^data-task$/, /^data-heading$/];

const RENDER_SAMPLES = {
  two_paragraphs: "First paragraph with a [[Link Target]] and *emphasis*.\n\nSecond paragraph with **strong** text.",
  mixed_blocks: "# A heading\n\nA paragraph.\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\n> quoted",
};

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

function checkFixture(vault) {
  if (!existsSync(vault)) throw new Error(`--vault ${vault} does not exist`);
  const missing = FIXTURE_MARKERS.filter((marker) => !existsSync(join(vault, marker)));
  if (missing.length) throw new Error(`--vault is not the fixture vault; missing ${missing.join(", ")}`);
}

/** The notes to capture: every `.md` file at the top of the vault, sorted. */
function listNotes(vault) {
  return readdirSync(vault, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

let vaultCwd = null;

function obsidian(vaultName, args) {
  // The vault as the working directory, and SIGKILL on timeout: the CLI's
  // `eval` follows the working directory, and the CLI ignores SIGTERM.
  const result = spawnSync("obsidian", [`vault=${vaultName}`, ...args], {
    cwd: vaultCwd ?? undefined,
    encoding: "utf8",
    timeout: 60_000, // the same as `timeout -s KILL 60`, without needing GNU coreutils on PATH
    killSignal: "SIGKILL",
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function guard(options) {
  const expected = realpathSync(options.vault);
  vaultCwd = expected;
  const info = obsidian(options.vaultName, ["vault", "info=path"]);
  if (info.code !== 0 || realpathSync(info.stdout.trim() || "/nonexistent-guard") !== expected) {
    console.error(`reading-view-capture: the CLI answers for ${JSON.stringify(info.stdout.trim())}, not ${expected}; is the fixture open as ${options.vaultName}?`);
    process.exit(3);
  }
  return expected;
}

/** The code one eval runs: it refuses to run its body unless the app's vault is the fixture. */
function wrapEval(expected, body) {
  return `(async () => { const base = app.vault.adapter.basePath; if (base !== ${JSON.stringify(expected)}) return JSON.stringify({ refused: base }); return JSON.stringify({ value: await (${body})() }); })()`;
}

function evalInFixture(options, expected, body, { tolerate = false } = {}) {
  const answer = obsidian(options.vaultName, ["eval", `code=${wrapEval(expected, body)}`]);
  let parsed;
  try {
    parsed = JSON.parse(answer.stdout.trim().replace(/^=>\s*/, ""));
  } catch {
    const message = `the eval gave no JSON (exit ${answer.code}): ${answer.stdout.slice(0, 500)} ${answer.stderr.slice(0, 500)}`;
    if (tolerate) throw new Error(message);
    console.error(`reading-view-capture: ${message}`);
    process.exit(2);
  }
  if ("refused" in parsed) {
    console.error(`reading-view-capture: eval ran in ${parsed.refused}, not the fixture; stopping`);
    process.exit(3);
  }
  return parsed.value;
}

// ---------------------------------------------------------------------------
// Normalisation (runs in Node on the raw innerHTML).
// ---------------------------------------------------------------------------

function normalise(rawHtml) {
  const unlisted = new Set();
  let html = rawHtml.replace(/<([a-zA-Z][\w-]*)((?:\s[^<>]*?)?)(\/?)>/g, (whole, tag, attrs, close) => {
    if (!attrs) return whole;
    let next = attrs;
    if (/\bclass="[^"]*\bmarkdown-preview-(?:pusher|sizer)\b[^"]*"/.test(next)) {
      next = next.replace(/\sstyle="[^"]*"/, "");
    }
    next = next.replace(/\s(data-[\w-]+)(?:="[^"]*")?/g, (attr, name) => {
      if (BOOKKEEPING_DATA.includes(name)) return "";
      if (!KEPT_DATA.some((pattern) => pattern.test(name))) unlisted.add(name);
      return attr;
    });
    return `<${tag}${next}${close}>`;
  });
  html = html.replace(/>\s+</g, "><");
  return { html, unlisted: [...unlisted] };
}

// ---------------------------------------------------------------------------
// The evals. Each is the source of an async arrow function that runs in the app.
// ---------------------------------------------------------------------------

/** Open `path` in reading mode and wait until the sizer's child count has been stable for 300 ms (5 s at most). */
const stepNote = (path) => `async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const path = ${JSON.stringify(path)};
  const file = app.vault.getFileByPath ? app.vault.getFileByPath(path) : app.vault.getAbstractFileByPath(path);
  if (!file) throw new Error("no such file " + path);
  const leaf = app.workspace.getLeaf();
  await leaf.openFile(file, { state: { mode: "preview" } });
  if (leaf.view.getMode && leaf.view.getMode() !== "preview") {
    await leaf.setViewState({ type: "markdown", state: { file: path, mode: "preview" } });
  }
  if (!leaf.view.getMode || leaf.view.getMode() !== "preview") throw new Error("the leaf is not in reading mode for " + path);
  const sizerOf = () => leaf.view.containerEl.querySelector(".markdown-preview-sizer");
  let settled = false;
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const sizer = sizerOf();
    const count = sizer ? sizer.childElementCount : -1;
    if (count !== last) { last = count; stableSince = Date.now(); }
    else if (count > 0 && Date.now() - stableSince >= 300) { settled = true; break; }
    await sleep(50);
  }
  const sizer = sizerOf();
  if (!sizer) throw new Error("no .markdown-preview-sizer for " + path);
  // The metadata cache can lag the open; give it up to 2 s.
  let cache = app.metadataCache.getFileCache(file);
  const cacheDeadline = Date.now() + 2000;
  while (!cache && Date.now() < cacheDeadline) { await sleep(50); cache = app.metadataCache.getFileCache(file); }
  return {
    settled,
    html: sizer.innerHTML,
    frontmatter: cache && cache.frontmatter ? JSON.parse(JSON.stringify(cache.frontmatter)) : null,
  };
}`;

/** The renderMarkdown question: does `MarkdownRenderer.render` wrap blocks in `div.el-*`? */
const STEP_RENDER_MARKDOWN = `async () => {
  const obs = require("obsidian");
  const samples = ${JSON.stringify(RENDER_SAMPLES)};
  const results = {};
  for (const [name, text] of Object.entries(samples)) {
    const component = new obs.Component();
    component.load();
    const el = document.createElement("div");
    try {
      await obs.MarkdownRenderer.render(app, text, el, "Link Target.md", component);
      await new Promise((r) => setTimeout(r, 300));
      const children = [...el.children];
      results[name] = {
        html: el.innerHTML,
        top_level: children.map((child) => ({ tag: child.tagName.toLowerCase(), class: child.className })),
        wrapped_in_el: children.some((child) => [...child.classList].some((c) => c.startsWith("el-"))),
      };
    } catch (error) {
      results[name] = { error: String(error && error.message || error) };
    } finally {
      component.unload();
    }
  }
  return results;
}`;

const STEP_META = `async () => {
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
    theme: app.vault.getConfig("cssTheme") || "default",
    readable_line_length: app.vault.getConfig("readableLineLength") ?? null,
    strict_line_breaks: app.vault.getConfig("strictLineBreaks") ?? null,
    base_color_scheme: document.body.classList.contains("theme-dark") ? "dark" : "light",
  };
}`;

function writeJson(dir, name, value) {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function dry(options) {
  const expected = resolve(options.vault);
  const notes = existsSync(options.vault) ? listNotes(options.vault) : ["<note>.md"];
  console.log(`// --dry: no CLI command runs and nothing is written; the vault would be ${expected}, the output ${options.out}`);
  console.log(`// ${notes.length} notes: ${notes.join(", ")}`);
  console.log(`\n// ---- per-note eval (shown for ${notes[0]}; the same code runs for each note) ----\n${wrapEval(expected, stepNote(notes[0]))}`);
  console.log(`\n// ---- render-markdown.json ----\n${wrapEval(expected, STEP_RENDER_MARKDOWN)}`);
  console.log(`\n// ---- meta.json ----\n${wrapEval(expected, STEP_META)}`);
}

function capture(options) {
  checkFixture(options.vault);
  const expected = guard(options);
  const notes = listNotes(options.vault);
  mkdirSync(join(options.out, "html"), { recursive: true });
  mkdirSync(join(options.out, "raw-html"), { recursive: true });
  const frontmatter = {};
  const unsettled = [];
  const unlisted = new Set();
  for (const note of notes) {
    const result = evalInFixture(options, expected, stepNote(note));
    const stem = note.replace(/\.md$/, "");
    const normalised = normalise(result.html);
    writeFileSync(join(options.out, "raw-html", `${stem}.html`), `${result.html}\n`);
    writeFileSync(join(options.out, "html", `${stem}.html`), `${normalised.html}\n`);
    normalised.unlisted.forEach((name) => unlisted.add(name));
    frontmatter[note] = result.frontmatter;
    if (!result.settled) unsettled.push(note);
    console.log(`wrote ${stem}.html${result.settled ? "" : " (did not settle within 5 s)"}`);
  }
  writeJson(options.out, "frontmatter.json", frontmatter);
  // `require("obsidian")` is not reachable from the CLI's eval in a vault with no
  // plugin (measured 2026-10-20: "Cannot find module 'obsidian'"), so this step
  // records its failure and the capture goes on; the Meta Bind fixture, which
  // has a plugin, answers E27.
  let renderMarkdown;
  try {
    renderMarkdown = evalInFixture(options, expected, STEP_RENDER_MARKDOWN, { tolerate: true });
  } catch (error) {
    renderMarkdown = { error: String(error && error.message || error) };
    console.log("render-markdown.json: the step failed; recorded the error");
  }
  writeJson(options.out, "render-markdown.json", renderMarkdown);
  const meta = evalInFixture(options, expected, STEP_META);
  const cli = obsidian(options.vaultName, ["version"]);
  writeJson(options.out, "meta.json", {
    ...meta,
    cli_version: cli.code === 0 ? cli.stdout.trim() : null,
    captured_at: new Date().toISOString(),
    fixture: "host/fixtures/reading-view/vault",
    notes,
    unsettled_notes: unsettled,
    unlisted_data_attributes: [...unlisted].sort(),
    normalisation: {
      style_stripped_on: ["markdown-preview-pusher", "markdown-preview-sizer"],
      bookkeeping_data_removed: BOOKKEEPING_DATA,
      data_kept: ["data-href", "data-callout*", "data-task", "data-heading"],
      whitespace_between_tags_collapsed: true,
    },
  });
  console.log(`captured ${notes.length} notes into ${options.out}`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`reading-view-capture: ${error.message}`);
    process.exit(2);
  }
  if (options.dry) {
    dry(options);
    return;
  }
  try {
    capture(options);
  } catch (error) {
    console.error(`reading-view-capture: ${error.message}`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { BOOKKEEPING_DATA, FIXTURE_MARKERS, RENDER_SAMPLES, listNotes, normalise, parseArgs, stepNote, wrapEval };
