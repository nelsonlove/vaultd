#!/usr/bin/env node
"use strict";
/**
 * Generate the capture probes into the scratch corpus, and capture what
 * Obsidian answers for every view in it.
 *
 *   node host/scripts/bases-capture.js generate --corpus target/tmp/bases-corpus
 *   node host/scripts/bases-capture.js capture --corpus target/tmp/bases-corpus --vault-name bases-corpus \
 *        --out crates/vault-server/tests/fixtures/bases-captures [--corpus-out <dir>]
 *
 * Two outputs (ruled 2026-10-08: captures of a real vault's bases never
 * enter the repository). Every view of a generated base under `Captures/` goes to
 * --out, which is committed. Every view of any other base (the real vault's) goes
 * to --corpus-out, default `$XDG_DATA_HOME/vaultd/bases-captures/corpus`
 * (`~/.local/share/…` when XDG_DATA_HOME is unset), which is outside the
 * repository; the replay reads it through `VAULTD_CORPUS_CAPTURES`. Each
 * output has its own `meta.json`.
 *
 * `capture` never runs a command against any vault but the corpus: before
 * anything else, and again inside every `eval`, it checks that the vault the
 * CLI answers for is the corpus path, and exits 3 otherwise. Every CLI call
 * runs with the corpus as its working directory (the CLI's `eval` follows the
 * working directory, not `vault=`). It never reads or writes outside
 * --corpus, --out and --corpus-out.
 */

const { Buffer } = require("node:buffer");
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, relative, resolve, sep } = require("node:path");

const REPO = resolve(__dirname, "..", "..");
const SCRATCH = join(REPO, "target", "tmp");
const FAMILIES = ["coercion", "global", "any", "string", "number", "list", "object", "regexp", "date", "link", "file"];
const CAPTURES = join(REPO, "crates", "vault-bases", "tests", "fixtures", "captures");

function defaultCorpusOut() {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "vaultd", "bases-captures", "corpus");
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const out = { mode, corpusOut: defaultCorpusOut() };
  for (let at = 0; at < rest.length; at += 1) {
    const flag = rest[at];
    const value = rest[at + 1];
    at += 1;
    if (value === undefined) throw new Error(`${flag} wants a value`);
    if (flag === "--corpus") out.corpus = resolve(value);
    else if (flag === "--vault-name") out.vaultName = value;
    else if (flag === "--out") out.out = resolve(value);
    else if (flag === "--corpus-out") out.corpusOut = resolve(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (out.corpusOut.startsWith(REPO + sep)) throw new Error("--corpus-out must be outside the repository");
  if (!["generate", "capture"].includes(out.mode)) throw new Error("the mode is generate or capture");
  if (!out.corpus || !out.corpus.startsWith(SCRATCH + sep)) throw new Error(`--corpus must be inside ${SCRATCH}`);
  if (out.mode === "capture" && (!out.vaultName || !out.out)) throw new Error("capture needs --vault-name and --out");
  return out;
}

const yamlString = (text) => `'${text.replace(/'/g, "''")}'`;
const slug = (text) => text.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");

function rows(family) {
  return readFileSync(join(CAPTURES, `${family}.jsonl`), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Frontmatter for a row's props, as YAML Obsidian reads back to the same values. */
function frontmatter(props = {}) {
  const lines = Object.entries(props).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return lines.length ? `---\n${lines.join("\n")}\n---\n` : "";
}

/** The body every capture row's note carries: the shape `capture_vault` gives `Capture.md`. */
const ROW_BODY = "#book #Project/Active [[Other]] [[Missing]] ![[Folder/image.png]]\n";

function generate(options) {
  const root = join(options.corpus, "Captures");
  // The companions every row links to live at the corpus root, exactly where
  // `capture_vault` puts them, so a row's literal answer (`Other.md`,
  // `Folder/image.png`, `Folder/README`) is the same in the corpus as in the
  // unit fixtures. `Capture.md` is there too, so `link("Capture")` resolves.
  // A second run (after a probe is added) finds its own `Captures/` and
  // rewrites every generated file in place.
  const companions = ["Capture.md", "Other.md", "Root-probe.md", "Folder"];
  for (const companion of companions) {
    if (!existsSync(root) && existsSync(join(options.corpus, companion))) {
      throw new Error(`${companion} already exists in the corpus; the capture rows need that path`);
    }
  }
  mkdirSync(root, { recursive: true });
  mkdirSync(join(options.corpus, "Folder", "Deep"), { recursive: true });
  writeFileSync(join(options.corpus, "Folder", "image.png"), Buffer.alloc(1000));
  writeFileSync(join(options.corpus, "Folder", "README"), Buffer.alloc(10));
  writeFileSync(join(options.corpus, "Folder", ".gitignore"), Buffer.alloc(5));
  writeFileSync(join(options.corpus, "Folder", "Deep", "Inner.md"), "");
  writeFileSync(join(options.corpus, "Capture.md"), ROW_BODY);
  writeFileSync(join(options.corpus, "Root-probe.md"), "root\n");
  const rowPaths = ["Capture"];
  for (const family of FAMILIES) {
    const dir = join(root, family);
    mkdirSync(dir, { recursive: true });
    const views = [];
    const formulas = [];
    rows(family).forEach((row, index) => {
      // `this` is the base when a view is opened directly; rows about `this`
      // are captured through the corpus views instead.
      if (/\bthis\b/.test(row.expr)) return;
      const note = `r${index}`;
      writeFileSync(join(dir, `${note}.md`), `${frontmatter(row.props)}${ROW_BODY}`);
      rowPaths.push(`Captures/${family}/${note}`);
      formulas.push(`  f${index}: ${yamlString(row.expr)}`);
      views.push(`  - type: table\n    name: ${note}\n    filters: ${yamlString(`file.path == "Captures/${family}/${note}.md"`)}\n    order: [formula.f${index}]`);
    });
    writeFileSync(join(root, `${family}.base`), `formulas:\n${formulas.join("\n")}\nviews:\n${views.join("\n")}\n`);
  }
  // `Other.md` links back to every row, so a row's first backlink is
  // `Other.md` here as it is in `capture_vault`.
  writeFileSync(
    join(options.corpus, "Other.md"),
    `---\nstatus: done\n---\n${rowPaths.map((path) => `[[${path}]]`).join("\n")}\n`,
  );

  // The view family (`view.jsonl`): the four notes of `view_vault`, and one
  // base per row, its view kept as written and narrowed to this folder by a
  // base-level filter (which every view ANDs with its own).
  const viewDir = join(root, "view");
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(join(viewDir, "a.md"), `${frontmatter({ list: ["x"], status: "p" })}#book\n`);
  writeFileSync(join(viewDir, "b.md"), `${frontmatter({ list: ["x"] })}#Book/fiction\n`);
  writeFileSync(join(viewDir, "c.md"), `${frontmatter({ list: ["x", "y"] })}#other\n`);
  writeFileSync(join(viewDir, "d.md"), "");
  rows("view").forEach((row, index) => {
    writeFileSync(join(viewDir, `v${index}.base`), `filters: ${yamlString('file.inFolder("Captures/view") && file.ext == "md"')}\n${row.base}`);
  });

  // A probe note is [name, props, body]: props an object (written as JSON
  // flow YAML) or a string (written as the frontmatter verbatim, for the
  // YAML-only values `.inf`, `-.inf` and `.nan`).
  const note = (props, body = "") => {
    const front = typeof props === "string" ? `---\n${props}\n---\n` : frontmatter(props);
    return `${front}${body}`;
  };
  const probe = (name, notes, view) => ({ name, notes, view });
  const probes = [
    // Narrowed to its own notes first, so none of the copied notes that carry
    // a `price` joins the probe.
    probe("filter_error_row", [["a", { price: 3 }], ["b", {}]],
      "    filters:\n      and:\n        - 'file.inFolder(\"Captures/probes\") && file.name.startsWith(\"filter_error_row-\")'\n        - 'price > 2'"),
    probe("sort_default", [["z", {}], ["a", {}], ["m", {}]], ""),
    probe("sort_mixed", [["n", { mix: 5 }], ["s", { mix: "five" }], ["d", { mix: "2025-01-01" }], ["b", { mix: true }], ["l", { mix: [1] }], ["e", {}]],
      "    order: [mix]\n    sort:\n      - property: mix\n        direction: ASC"),
    probe("sort_mixed_desc", [["n", { mix: 5 }], ["s", { mix: "five" }], ["d", { mix: "2025-01-01" }], ["b", { mix: true }], ["l", { mix: [1] }], ["e", {}]],
      "    order: [mix]\n    sort:\n      - property: mix\n        direction: DESC"),
    probe("stddev", [2, 4, 4, 4, 5, 5, 7, 9].map((v, i) => [`v${i}`, { v }]), "    order: [v]\n    summaries:\n      v: Stddev"),
    probe("limit_group", [["a", { g: 1, k: 1 }], ["b", { g: 2, k: 2 }], ["c", { g: 1, k: 3 }], ["d", { g: 2, k: 4 }]],
      "    order: [k]\n    limit: 2\n    sort:\n      - property: k\n        direction: DESC\n    groupBy:\n      property: g\n      direction: ASC"),
    probe("hyphen", [["h", { image: 10, property: 3, "image-property": 99 }]], "    order: [formula.hyphen]"),
    probe("tags_spelling", [["t", {}, "#Mixed/Case\n"]], "    order: [formula.tags]"),
    probe("folder_root", [], "    filters: 'file.path == \"Root-probe.md\"'\n    order: [formula.folder]"),
    probe("has_link_embed", [["e", {}, "![[Other]]\n"]], "    order: [formula.has_embed]"),
    probe("file_missing", [["f", {}]], "    order: [formula.missing_file]"),
    // The carries from Tasks 7 and 11.
    probe("nonfinite", [["i", "n: .inf"], ["m", "n: -.inf"], ["q", "n: .nan"]], "    order: [n, formula.n_text]"),
    probe("unique_nan", [["u", "xs: [.nan, .nan, 1, 1]"]], "    order: [formula.unique_nan]"),
    probe("types_case", [["k", { t13typed: "2025-03-04" }]], "    order: [t13typed, formula.typed_date]"),
    probe("eq_string_date", [["x", {}]], "    order: [formula.eq_sd, formula.eq_ds]"),
  ];
  const probeDir = join(root, "probes");
  mkdirSync(probeDir, { recursive: true });
  const views = probes.map((p) => {
    for (const [name, props, body] of p.notes) writeFileSync(join(probeDir, `${p.name}-${name}.md`), note(props, body));
    const filter = p.view.includes("filters:") ? "" : `    filters: ${yamlString(`file.inFolder("Captures/probes") && file.name.startsWith("${p.name}-")`)}\n`;
    return `  - type: table\n    name: ${p.name}\n${filter}${p.view}`.replace(/\n$/, "");
  });
  const probeFormulas = {
    hyphen: "image-property",
    tags: "file.tags",
    folder: "file.folder",
    has_embed: 'file.hasLink("Other.md")',
    missing_file: 'file("path to nowhere")',
    n_text: "n.toString()",
    unique_nan: "xs.unique().length",
    typed_date: 't13typed.isType("date")',
    eq_sd: 'date("2025-01-01") == "2025-01-01"',
    eq_ds: '"2025-01-01" == date("2025-01-01")',
  };
  writeFileSync(
    join(root, "probes.base"),
    `formulas:\n${Object.entries(probeFormulas).map(([key, expr]) => `  ${key}: ${yamlString(expr)}`).join("\n")}\nviews:\n${views.join("\n")}\n  - type: table\n    name: Sort_Default\n    filters: 'file.path == \"Root-probe.md\"'\n`,
  );
  // `types.json` key case: declare `T13Typed` as a date while the note writes
  // `t13typed`. The copy's own declarations are kept as they are.
  const typesPath = join(options.corpus, ".obsidian", "types.json");
  const types = existsSync(typesPath) ? JSON.parse(readFileSync(typesPath, "utf8")) : {};
  if (!types.types || typeof types.types !== "object") types.types = {};
  types.types.T13Typed = "date";
  mkdirSync(join(options.corpus, ".obsidian"), { recursive: true });
  writeFileSync(typesPath, `${JSON.stringify(types, null, 2)}\n`);
  // The same-stem rule: a base and a note that share a stem.
  writeFileSync(join(root, "stem.base"), "views:\n  - type: table\n    name: Stem\n    filters: 'file.path == \"Root-probe.md\"'\n");
  writeFileSync(join(root, "stem.md"), "stem note\n");
  writeFileSync(
    join(root, "embeds.md"),
    "![[probes.base#Sort_Default]]\n![[probes.base#sort_default]]\n![[Captures/stem]]\n[[Captures/stem]]\n![[stem]]\n",
  );
  console.log(`generated Captures/ in ${options.corpus}`);
}

let corpusCwd = null;

function obsidian(vaultName, args) {
  // The corpus as the working directory, and SIGKILL on timeout: the CLI's
  // `eval` follows the working directory, and the CLI ignores SIGTERM.
  const result = spawnSync("obsidian", [`vault=${vaultName}`, ...args], {
    cwd: corpusCwd ?? undefined,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function guard(options) {
  const expected = realpathSync(options.corpus);
  corpusCwd = expected;
  const info = obsidian(options.vaultName, ["vault", "info=path"]);
  if (info.code !== 0 || realpathSync(info.stdout.trim() || "/nonexistent-guard") !== expected) {
    console.error(`bases-capture: the CLI answers for ${JSON.stringify(info.stdout.trim())}, not ${expected}; is the corpus open as ${options.vaultName}?`);
    process.exit(3);
  }
  return expected;
}

/** Run JavaScript in the app, refusing the answer unless it came from the corpus. */
function evalInCorpus(options, expected, body) {
  const code = `(() => { const base = app.vault.adapter.basePath; if (base !== ${JSON.stringify(expected)}) return JSON.stringify({ refused: base }); return JSON.stringify({ value: (${body})() }); })()`;
  const answer = obsidian(options.vaultName, ["eval", `code=${code}`]);
  // The CLI prints the expression's value; a leading "=> " marker, where the
  // installed CLI writes one, is not part of it.
  const parsed = JSON.parse(answer.stdout.trim().replace(/^=>\s*/, ""));
  if ("refused" in parsed) {
    console.error(`bases-capture: eval ran in ${parsed.refused}, not the corpus; stopping`);
    process.exit(3);
  }
  return parsed.value;
}

function baseFiles(corpus) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".base")) out.push(relative(corpus, full).split(sep).join("/"));
    }
  };
  visit(corpus);
  return out.sort();
}

function viewNames(corpus, base) {
  // Read with the daemon's own parser, so the capture asks Obsidian about
  // exactly the views vaultd will evaluate.
  const listing = execFileSync(join(REPO, "target", "release", "fixture-row"), ["--base-views"], { input: readFileSync(join(corpus, base)), encoding: "utf8" });
  return JSON.parse(listing);
}

function capture(options) {
  const expected = guard(options);
  const outputs = { synthetic: options.out, corpus: options.corpusOut };
  for (const dir of Object.values(outputs)) {
    mkdirSync(join(dir, "views"), { recursive: true });
    mkdirSync(join(dir, "functions"), { recursive: true });
  }
  const meta = evalInCorpus(options, expected, "() => ({ now: Date.now(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone, appVersion: navigator.userAgent.match(/obsidian\\/([\\d.]+)/i)?.[1] ?? null })");
  const resolved = evalInCorpus(options, expected, "() => app.metadataCache.resolvedLinks['Captures/embeds.md'] ?? null");
  const common = { captured_at_ms: meta.now, zone: meta.zone, obsidian_version: meta.appVersion, corpus: relative(REPO, options.corpus) };
  writeFileSync(join(outputs.synthetic, "meta.json"), `${JSON.stringify({ ...common, embeds_resolved: resolved }, null, 2)}\n`);
  writeFileSync(join(outputs.corpus, "meta.json"), `${JSON.stringify(common, null, 2)}\n`);
  const counts = { synthetic: 0, corpus: 0 };
  for (const base of baseFiles(options.corpus)) {
    // Only a generated base's views are committed; real ones stay outside
    // the repository.
    const synthetic = base.startsWith("Captures/");
    const out = synthetic ? outputs.synthetic : outputs.corpus;
    const family = /^Captures\/([a-z]+)\.base$/.exec(base)?.[1];
    for (const view of viewNames(options.corpus, base)) {
      // The instant this view was asked at, from this Mac's clock (the app
      // runs on it), so a row reading `now()` replays at its own instant.
      const at = Date.now();
      const answer = obsidian(options.vaultName, ["base:query", `path=${base}`, `view=${view}`, "format=json"]);
      const record = { base, view, captured_at_ms: at, exit_code: answer.code, stdout: answer.stdout, stderr: answer.stderr };
      const dir = synthetic && family && family !== "probes" ? join(out, "functions", family) : join(out, "views");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${slug(base)}__${slug(view)}.json`), `${JSON.stringify(record, null, 2)}\n`);
      counts[synthetic ? "synthetic" : "corpus"] += 1;
    }
  }
  console.log(`${counts.synthetic} synthetic views into ${outputs.synthetic}; ${counts.corpus} corpus views into ${outputs.corpus}`);
  console.log(`captured into ${options.out}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "generate") generate(options);
  else capture(options);
} catch (error) {
  console.error(`bases-capture: ${error.message}`);
  process.exit(2);
}
