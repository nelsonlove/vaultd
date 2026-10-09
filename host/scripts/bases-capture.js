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
  // Compared as real paths, so a symlink cannot put the corpus captures
  // inside the repository.
  const real = (path) => {
    let at = path;
    while (!existsSync(at)) at = resolve(at, "..");
    return join(realpathSync(at), relative(at, path));
  };
  if (real(out.corpusOut).startsWith(realpathSync(REPO) + sep)) throw new Error("--corpus-out must be outside the repository");
  if (!["generate", "wait-indexed", "capture"].includes(out.mode)) throw new Error("the mode is generate, wait-indexed or capture");
  if (!out.corpus || !out.corpus.startsWith(SCRATCH + sep)) throw new Error(`--corpus must be inside ${SCRATCH}`);
  if (out.mode === "capture" && (!out.vaultName || !out.out)) throw new Error("capture needs --vault-name and --out");
  if (out.mode === "wait-indexed" && !out.vaultName) throw new Error("wait-indexed needs --vault-name");
  return out;
}

// Plain ASCII as a single-quoted scalar; anything else double-quoted with
// every non-ASCII character escaped, so a YAML line break such as U+2028
// cannot cut the expression.
const yamlString = (text) => {
  if (/^[\x20-\x7e]*$/.test(text)) return `'${text.replace(/'/g, "''")}'`;
  const escaped = [...text]
    .map((c) => {
      const code = c.codePointAt(0);
      if (c === '"' || c === "\\") return `\\${c}`;
      if (code >= 0x20 && code <= 0x7e) return c;
      return code > 0xffff ? `\\U${code.toString(16).padStart(8, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
    })
    .join("");
  return `"${escaped}"`;
};
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
  // Everything under `Captures/` is committed as synthetic: refuse a corpus
  // whose copied files already hold a `Captures/` folder.
  const manifest = join(options.corpus, "MANIFEST.json");
  if (existsSync(manifest)) {
    const copied = Object.keys(JSON.parse(readFileSync(manifest, "utf8")).copied ?? {});
    const clash = copied.find((path) => path === "Captures" || path.startsWith("Captures/"));
    if (clash) throw new Error(`the copied vault holds ${clash}; Captures/ is reserved for generated probes`);
  }
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
      // The last column, `t13_now`, is the instant Obsidian evaluated the
      // view at; the replay evaluates at that instant and drops the column.
      views.push(`  - type: table\n    name: ${note}\n    filters: ${yamlString(`file.path == "Captures/${family}/${note}.md"`)}\n    order: [formula.f${index}, formula.t13_now]`);
    });
    writeFileSync(join(root, `${family}.base`), `formulas:\n${formulas.join("\n")}\n  t13_now: 'now().format("x")'\nviews:\n${views.join("\n")}\n`);
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
  // `prefix` reuses another probe's notes (default: the probe's own).
  const probe = (name, notes, view, prefix = `${name}-`) => ({ name, notes, view, prefix });
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
    // Round four (not yet captured: the scratch vault was closed first).
    // A sort key no column shows, which the corpus suggests changes
    // nothing; and a sort key every row leaves empty, which the corpus
    // suggests keeps collated path order.
    probe("sort_hidden", [["a", { k: 3 }], ["b", { k: 1 }], ["c", { k: 2 }]],
      "    order: [file.name]\n    sort:\n      - property: k\n        direction: ASC"),
    probe("sort_shown", [], "    order: [file.name, k]\n    sort:\n      - property: k\n        direction: ASC", "sort_hidden-"),
    probe("sort_all_empty", [["Zb", {}], ["ab", {}], ["Mm", {}]],
      "    order: [file.name, nothing]\n    sort:\n      - property: nothing\n        direction: ASC"),
    // A second mixed-type sort, its path order unlike any type rank, two
    // values of most kinds.
    probe("sort_mixed2", [["a", { mix: "abc" }], ["b", { mix: 10 }], ["c", { mix: [2] }], ["d", { mix: false }], ["e", {}], ["f", { mix: 2 }],
      ["g", { mix: "Zed" }], ["h", { mix: true }], ["i", { mix: ["b", "a"] }], ["j", { mix: { k: 1 } }], ["k", { mix: "" }], ["l", { mix: null }]],
      "    order: [mix]\n    sort:\n      - property: mix\n        direction: ASC"),
    probe("sort_mixed2_desc", [], "    order: [mix]\n    sort:\n      - property: mix\n        direction: DESC", "sort_mixed2-"),
    probe("group_dir", [], "    order: [k]\n    groupBy:\n      property: g\n      direction: DESC", "limit_group-"),
    probe("group_list", [], "    order: [l]\n    groupBy:\n      property: l\n      direction: ASC", "summaries-"),
    // Every built-in summary, over numbers, dates, checkboxes and lists.
    probe("summaries", [
      ["s1", { v: 3, c: true, t13typed: "2025-01-05", l: ["x"] }],
      ["s2", { v: 1, c: false, t13typed: "2024-12-31", l: ["x"] }],
      ["s3", { v: 10, l: ["x", "y"] }],
      ["s4", {}],
    ], "    order: [v, t13typed, c, l]"),
    ...[
      ["Average", "v"], ["Min", "v"], ["Max", "v"], ["Sum", "v"], ["Range", "v"], ["Median", "v"], ["Stddev", "v"],
      ["Earliest", "t13typed"], ["Latest", "t13typed"], ["Range", "t13typed"], ["Checked", "c"], ["Unchecked", "c"],
      ["Empty", "l"], ["Filled", "l"], ["Unique", "l"], ["Sum", "missing"],
    ].map(([fn, key]) => probe(`summ_${fn}_${key}`, [], `    order: [v, t13typed, c, l]\n    summaries:\n      ${key}: ${fn}`, "summaries-")),
  ];
  const probeDir = join(root, "probes");
  mkdirSync(probeDir, { recursive: true });
  const views = probes.map((p) => {
    for (const [name, props, body] of p.notes) writeFileSync(join(probeDir, `${p.name}-${name}.md`), note(props, body));
    const filter = p.view.includes("filters:") ? "" : `    filters: ${yamlString(`file.inFolder("Captures/probes") && file.name.startsWith("${p.prefix}")`)}\n`;
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
  // The syntax probes, one base each (a formula Obsidian cannot parse may
  // refuse its whole base): which forms parse, and how an error shows.
  const syntaxFormulas = {
    x_num_paren_method: "(0).isTruthy()",
    x_num_dot_method: "0.isTruthy()",
    x_exp: "1e3",
    x_exp_frac: "1.5e3",
    x_obj: '{"a": 1}',
    x_obj_keys: '({"a": 1}).keys()',
    x_obj_empty: "{}",
    x_unknown_method: "(5).frobnicate()",
    x_bad_syntax: "1 +",
    x_unknown_prop: "nosuch.length",
    x_str_times: '"5" * 2',
    x_nested_list: "[1, [2, [3]]]",
    x_div_zero: "(1 / 0).toString()",
    x_dur: 'duration("1d")',
    x_date_minus: 'date("2024-01-02") - date("2024-01-01")',
    x_date_minus_ms: '(date("2024-01-02") - date("2024-01-01")).milliseconds',
    // How `base:query` shows each kind of value.
    r_file: 'file("Other.md")',
    r_file_row: "file",
    r_icon: 'icon("plus")',
    r_html: 'html("<b>x</b>")',
    r_regexp: "/a+/i",
    r_list_nulls: '[1, null, "a"]',
    r_list_empty: "[]",
    r_list_bools: "[true, false, 1.5]",
    r_date_ms: 'date("2025-01-01 10:00:00.123")',
    r_neg_duration: 'date("2024-01-01") - date("2024-01-02")',
    r_dur_months: 'duration("2 months")',
    r_dur_hours: 'duration("36h")',
    r_png_name: 'file("Folder/image.png").name',
    r_png_basename: 'file("Folder/image.png").basename',
    r_png_ext: 'file("Folder/image.png").ext',
    r_link_url: 'link("https://obsidian.md")',
    r_link_file: 'link(file("Other.md"))',
    r_link_path: 'link("Folder/Deep/Inner.md")',
    r_link_display_file: 'link("Other", file("Other.md"))',
    r_obj_prop: "o",
    r_obj_nested_list: "o.a",
    // Semantics the first captures left open.
    s_unique: "[3, 1, 3, 2].unique()",
    s_truthy_empty_obj: "e.isTruthy()",
    s_if_empty_list: 'if([], "y", "n")',
    s_str_plus_num: '"a" + 1',
    s_num_plus_str: '1 + "a"',
    s_str_plus_date: '"d:" + date("2025-01-01")',
    s_null_eq_null: "missing == null",
    s_list_eq_order: "[1, 2] == [2, 1]",
    s_list_eq_coerce: '[1] == ["1"]',
    s_cmp_str_str: '"10" < "9"',
    s_cmp_list: "[1] < [2]",
    s_cmp_bool: "false < true",
    s_cmp_null: "missing < 1",
    s_flat_deep: "[1, [2, [3, [4]]]].flat()",
    s_trim_plain: '" hi ".trim()',
    s_null_plus_null: "missing + missing",
    s_neg_str: '-"5"',
    s_not_empty_list: "![]",
    s_dur_plus_dur: 'duration("1d") + duration("12h")',
    s_date_plus_25h: '(date("2026-03-07 12:00:00") + "25h").format("YYYY-MM-DD HH:mm")',
    s_today_plus_1d: 'date("2025-01-01") + "1d"',
    s_today_plus_36h: 'date("2025-01-01") + "36h"',
    s_datetime_plus_1d: 'date("2025-01-01 10:00:00") + "1d"',
    s_date_lt_str: 'date("2025-01-01") < "2025-01-02"',
    s_link_eq_str: 'link("Other") == "Other"',
    s_file_eq_str: 'file("Other.md") == "Other.md"',
    s_contains_link: '[link("Other")].contains(file("Other.md"))',
    s_str_index_oob: '"abc"[5]',
    s_mean_mixed: '[1, "2", 3].mean()',
    s_sum_mixed: '[1, 2, "3"].sum()',
    s_number_bool: "number(true)",
    s_number_date: 'number(date("2025-01-01"))',
    s_tostring_date: 'date("2025-01-01 10:30:00").toString()',
    s_tostring_day: 'date("2025-01-01").toString()',
    s_tostring_file: 'file("Other.md").toString()',
    s_tostring_link: 'link("Other").toString()',
    s_tostring_obj: "o.toString()",
    s_tostring_dur: 'duration("1d").toString()',
    s_tostring_list_nested: "[1, [2, 3]].toString()",
    s_date_minus_number: 'date("2025-01-02") - 86400000',
    s_dur_ms_field: 'duration("1d").days',
    s_round_half: "(2.5).round()",
    s_round_neg_half: "(-2.5).round()",
    s_tofixed_half: "(1.005).toFixed(2)",
    // Round four: whether text `contains` ignores case (the corpus suggests
    // it does), and how an option's non-finite number travels.
    t_contains_case: '"Probe/Value".contains("probe")',
    t_contains_any_case: '"Probe".containsAny("PROBE", "x")',
    t_starts_case: '"Probe".startsWith("probe")',
    t_list_contains_case: '["Probe"].contains("probe")',
  };
  writeFileSync(join(probeDir, "syntax-x.md"), frontmatter({ o: { a: [1, 2], b: { c: true }, d: null }, e: {} }));
  // Every file field as a column, over a note, an attachment and the root
  // probe: the columns' display names and how each field shows.
  writeFileSync(
    join(root, "probe-fields.base"),
    `views:\n  - type: table\n    name: fields\n    filters: ${yamlString('file.path == "Captures/view/a.md" || file.path == "Folder/image.png" || file.path == "Root-probe.md" || file.path == "Capture.md"')}\n    order: [file.name, file.basename, file.ext, file.path, file.folder, file.size, file.ctime, file.mtime, file.tags, file.links, file.embeds, file.backlinks, file.properties, file.file]\n`,
  );
  for (const [key, expr] of Object.entries(syntaxFormulas)) {
    writeFileSync(
      join(root, `probe-syntax-${key.replace(/_/g, "-")}.base`),
      `formulas:\n  ${key}: ${yamlString(expr)}\nviews:\n  - type: table\n    name: ${key}\n    filters: 'file.path == "Captures/probes/syntax-x.md"'\n    order: [formula.${key}]\n`,
    );
  }
  writeFileSync(
    join(root, "probes.base"),
    `formulas:\n${Object.entries(probeFormulas).map(([key, expr]) => `  ${key}: ${yamlString(expr)}`).join("\n")}\nviews:\n${views.join("\n")}\n  - type: table\n    name: Sort_Default\n    filters: 'file.path == "Root-probe.md"'\n`,
  );
  // `types.json` key case: declare `T13Typed` as a date while the note writes
  // `t13typed`. The copy's own declarations are kept as they are.
  const typesPath = join(options.corpus, ".obsidian", "types.json");
  const types = existsSync(typesPath) ? JSON.parse(readFileSync(typesPath, "utf8")) : {};
  if (!types.types || typeof types.types !== "object") types.types = {};
  types.types.T13Typed = "date";
  mkdirSync(join(options.corpus, ".obsidian"), { recursive: true });
  writeFileSync(typesPath, `${JSON.stringify(types, null, 2)}\n`);
  // The mixed-type comparator, one pair at a time: for every ordered pair of
  // values of different kinds, two notes (the first value, then the second,
  // in path order) sorted ascending and descending. A two-row sort shows the
  // comparator's answer for that pair alone, whatever the sort algorithm.
  const pairValues = [
    ["n5", 5], ["n10", 10], ["sabc", "abc"], ["sZed", "Zed"], ["sempty", ""], ["s5", "5"], ["btrue", true], ["bfalse", false],
    ["l2", [2]], ["lba", ["b", "a"]], ["obj", { k: 1 }], ["null", null], ["missing", undefined], ["date", "2025-01-01"],
  ];
  const pairDir = join(root, "pairs");
  mkdirSync(pairDir, { recursive: true });
  const pairViews = [];
  for (const [xName, x] of pairValues) {
    for (const [yName, y] of pairValues) {
      if (xName === yName) continue;
      const stem = `${xName}~${yName}`;
      writeFileSync(join(pairDir, `${stem}-1.md`), x === undefined ? "" : frontmatter({ mix: x }));
      writeFileSync(join(pairDir, `${stem}-2.md`), y === undefined ? "" : frontmatter({ mix: y }));
      for (const direction of ["ASC", "DESC"]) {
        pairViews.push(`  - type: table\n    name: ${stem}~${direction}\n    filters: ${yamlString(`file.inFolder("Captures/pairs") && file.name.startsWith("${stem}-")`)}\n    order: [mix]\n    sort:\n      - property: mix\n        direction: ${direction}`);
      }
    }
  }
  writeFileSync(join(root, "probe-pairs.base"), `views:\n${pairViews.join("\n")}\n`);
  // groupBy without a direction (the view family's `group:list` row), in a
  // base of its own: Obsidian refuses the whole file over one such view.
  writeFileSync(
    join(root, "probe-groupby.base"),
    `views:\n  - type: table\n    name: group_nodir\n    filters: ${yamlString('file.inFolder("Captures/probes") && file.name.startsWith("limit_group-")')}\n    order: [k]\n    groupBy:\n      property: g\n`,
  );
  // Round three: what the corpus captures left open.
  const extraDir = join(root, "extra");
  mkdirSync(extraDir, { recursive: true });
  // `this` in `base:query` and in the rendered table.
  writeFileSync(join(extraDir, "this-x.md"), "");
  writeFileSync(
    join(root, "probe-this.base"),
    `formulas:\n  this_name: 'this.file.name'\n  this_path: 'this.file.path'\n  this_null: 'this == null'\nviews:\n  - type: table\n    name: this_fields\n    filters: 'file.path == "Captures/extra/this-x.md"'\n    order: [formula.this_name, formula.this_path, formula.this_null]\n  - type: table\n    name: this_folder\n    filters: 'file.folder == this.file.folder'\n`,
  );
  // YAML timestamps: unquoted and quoted dates, untyped keys.
  writeFileSync(
    join(extraDir, "yaml-dates.md"),
    "---\nu_date: 2025-01-01\nu_dt: 2025-01-01T10:00:00\nu_dt_space: 2025-01-01 10:00:00\nu_dt_off: 2025-01-01T10:00:00-04:00\nu_dt_z: 2025-01-01T10:00:00Z\nq_date: \"2025-01-01\"\nq_dt_off: \"2025-01-01T10:00:00-04:00\"\nobj:\n  at: 2025-01-01T10:00:00-04:00\n  q: \"2025-01-01\"\n---\n",
  );
  const dateKeys = ["u_date", "u_dt", "u_dt_space", "u_dt_off", "u_dt_z", "q_date", "q_dt_off"];
  writeFileSync(
    join(root, "probe-yaml-dates.base"),
    `formulas:\n${dateKeys.map((key) => `  is_${key}: '${key}.isType("date")'`).join("\n")}\nviews:\n  - type: table\n    name: yaml_dates\n    filters: 'file.path == "Captures/extra/yaml-dates.md"'\n    order: [${[...dateKeys, "obj", ...dateKeys.map((key) => `formula.is_${key}`)].join(", ")}]\n`,
  );
  // View types other than a table, with no `order`.
  writeFileSync(
    join(root, "probe-view-types.base"),
    ["cards", "list", "tasknotesKanban"].reduce((text, kind) => `${text}  - type: ${kind}\n    name: type_${kind}\n    filters: 'file.path == "Root-probe.md"'\n`, "views:\n"),
  );
  // Empty operands, `date()` of nothing, tags properties, unknown fields.
  writeFileSync(
    join(extraDir, "tags-x.md"),
    "---\ntags: [alpha, Beta/gamma]\naliases: [One, two]\n---\n#alpha #ALPHA #delta\n",
  );
  const extraFormulas = {
    not_missing: "!missing",
    neg_missing: "-missing",
    and_missing: "missing && true",
    and_true_missing: "true && missing",
    or_missing: "missing || 1",
    if_not_missing: 'if(!missing, "t", "f")',
    date_missing: "date(missing)",
    date_missing_empty: "date(missing).isEmpty()",
    duration_missing: "duration(missing)",
    tags_contains: 'tags.contains("alpha")',
    tags_contains_hash: 'tags.contains("#alpha")',
    tags_first: "tags[0]",
    tags_type: 'tags[0].isType("string")',
    file_tags: "file.tags",
    file_unknown: "file.tasks",
    file_unknown_two: "file.nosuch",
  };
  writeFileSync(
    join(root, "probe-extra.base"),
    `formulas:\n${Object.entries(extraFormulas).map(([key, expr]) => `  ${key}: ${yamlString(expr)}`).join("\n")}\nviews:\n  - type: table\n    name: extra\n    filters: 'file.path == "Captures/extra/tags-x.md"'\n    order: [tags, aliases, ${Object.keys(extraFormulas).map((key) => `formula.${key}`).join(", ")}]\n`,
  );
  // Text order: names that test the collation (no `sort`, so name order).
  const collationDir = join(extraDir, "collation");
  mkdirSync(collationDir, { recursive: true });
  for (const name of ["ab", "Ab", "a b", "a-b", "a—b", "a​b", "a1", "a10", "a2", "é", "e", "f", "⚡x", "_x", "(x", "x.y", "B", "b", "10", "9", "Zü", "Zu"]) {
    writeFileSync(join(collationDir, `${name}.md`), "");
  }
  writeFileSync(
    join(root, "probe-collation.base"),
    "views:\n  - type: table\n    name: collation\n    filters: 'file.inFolder(\"Captures/extra/collation\")'\n  - type: table\n    name: collation_sorted\n    filters: 'file.inFolder(\"Captures/extra/collation\")'\n    sort:\n      - property: file.basename\n        direction: ASC\n",
  );
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
  // The CLI awaits a promise the expression returns, so `body` may be async.
  const code = `(async () => { const base = app.vault.adapter.basePath; if (base !== ${JSON.stringify(expected)}) return JSON.stringify({ refused: base }); return JSON.stringify({ value: await (${body})() }); })()`;
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

/**
 * Open one view of a base in a tab of the corpus window and read what the
 * table shows: each group's heading value and its rows' cell texts (an
 * editable cell's input value, else its text), and each footer summary as
 * its column index, function name and value. The tab is reused across
 * views and closed at the end of `capture`.
 */
function renderedView(options, expected, base, view) {
  return evalInCorpus(
    options,
    expected,
    `async () => {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(base)});
      let leaf = window.__vaultdCaptureLeaf;
      if (!leaf || !app.workspace.getLeavesOfType("bases").includes(leaf)) { leaf = app.workspace.getLeaf("tab"); window.__vaultdCaptureLeaf = leaf; }
      await leaf.setViewState({ type: "bases", state: { file: file.path, viewName: ${JSON.stringify(view)} } });
      await new Promise((r) => setTimeout(r, 1200));
      const root = leaf.view.containerEl;
      const error = root.querySelector(".bases-error")?.innerText ?? "";
      const el = root.querySelector(".bases-view");
      if (!el) return { error, groups: [], summaries: [] };
      const cell = (td) => { const input = td.querySelector("input"); return input ? input.value : td.innerText; };
      const groups = [...el.querySelectorAll(".bases-table")].map((t) => ({
        value: t.querySelector(".bases-group-value")?.innerText ?? null,
        rows: [...t.querySelectorAll(".bases-tbody .bases-tr")].map((tr) => [...tr.querySelectorAll(".bases-td")].map(cell)),
      }));
      const footer = el.querySelector(".bases-table-footer");
      const summaries = footer ? [...footer.querySelectorAll(":scope > .bases-td")].map((td, column) => ({
        column,
        name: td.querySelector(".summary-function-name")?.innerText ?? null,
        value: td.querySelector(".summary-function-value")?.innerText ?? null,
      })).filter((s) => s.name !== null) : [];
      return { error, groups, summaries };
    }`,
  );
}

function closeCaptureTab(options, expected) {
  evalInCorpus(options, expected, `() => { window.__vaultdCaptureLeaf?.detach(); window.__vaultdCaptureLeaf = undefined; return true; }`);
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
  // Round four (`view:case`): open `Captures/embeds.md` in reading view and
  // record, for each embed, its link text and the view the embedded base
  // shows. Not yet run.
  const embedViews = evalInCorpus(
    options,
    expected,
    `async () => {
      const leaf = app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: "markdown", state: { file: "Captures/embeds.md", mode: "preview" } });
      await new Promise((r) => setTimeout(r, 2000));
      const embeds = [...leaf.view.containerEl.querySelectorAll(".internal-embed")].map((embed) => ({
        src: embed.getAttribute("src"),
        view: embed.querySelector(".bases-toolbar-views-menu")?.innerText ?? null,
        error: embed.querySelector(".bases-error")?.innerText ?? null,
      }));
      leaf.detach();
      return embeds;
    }`,
  );
  const common = { captured_at_ms: meta.now, zone: meta.zone, obsidian_version: meta.appVersion, corpus: relative(REPO, options.corpus) };
  writeFileSync(join(outputs.synthetic, "meta.json"), `${JSON.stringify({ ...common, embeds_resolved: resolved, embed_views: embedViews }, null, 2)}\n`);
  writeFileSync(join(outputs.corpus, "meta.json"), `${JSON.stringify(common, null, 2)}\n`);
  const counts = { synthetic: 0, corpus: 0 };
  for (const base of baseFiles(options.corpus)) {
    // Only a generated base's views are committed; real ones stay outside
    // the repository.
    const synthetic = base.startsWith("Captures/");
    const out = synthetic ? outputs.synthetic : outputs.corpus;
    const family = /^Captures\/([a-z]+)\.base$/.exec(base)?.[1];
    for (const [index, view] of viewNames(options.corpus, base).entries()) {
      // The instant this view was asked at, from this Mac's clock (the app
      // runs on it), so a row reading `now()` replays at its own instant.
      const at = Date.now();
      // The CLI now and then hangs after it printed (status null at the
      // timeout); such a call is asked again, at most three times in all.
      let answer = obsidian(options.vaultName, ["base:query", `path=${base}`, `view=${view}`, "format=json"]);
      for (let retry = 0; retry < 2 && answer.code !== 0; retry += 1) {
        answer = obsidian(options.vaultName, ["base:query", `path=${base}`, `view=${view}`, "format=json"]);
      }
      const record = { base, view, captured_at_ms: at, exit_code: answer.code, stdout: answer.stdout, stderr: answer.stderr };
      const functionRow = synthetic && family && family !== "probes";
      // `base:query` gives neither groups nor summaries, so a generated
      // view's rendered table is read as well.
      if (synthetic && !functionRow && base !== "Captures/probe-pairs.base") record.rendered = renderedView(options, expected, base, view);
      const dir = functionRow ? join(out, "functions", family) : join(out, "views");
      mkdirSync(dir, { recursive: true });
      // The view's index keeps two names that differ only in case apart on a
      // case-insensitive disk (`Sort_Default` and `sort_default`).
      writeFileSync(join(dir, `${slug(base)}__${index}_${slug(view)}.json`), `${JSON.stringify(record, null, 2)}\n`);
      counts[synthetic ? "synthetic" : "corpus"] += 1;
    }
  }
  closeCaptureTab(options, expected);
  console.log(`${counts.synthetic} synthetic views into ${outputs.synthetic}; ${counts.corpus} corpus views into ${outputs.corpus}`);
  console.log(`captured into ${options.out}`);
}

/** Every generated file Obsidian should index: `Captures/` and the root companions, no dotfiles. */
function generatedFiles(corpus) {
  const out = ["Capture.md", "Other.md", "Root-probe.md", "Folder/image.png", "Folder/README", "Folder/Deep/Inner.md"];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(relative(corpus, full).split(sep).join("/"));
    }
  };
  visit(join(corpus, "Captures"));
  return out.sort();
}

/**
 * Wait, with a bound, until Obsidian has indexed every generated file: each
 * is in the vault's file list, and each note has a metadata cache entry.
 */
function waitIndexed(options) {
  const expected = guard(options);
  const wanted = generatedFiles(options.corpus);
  const deadline = Date.now() + 300_000;
  for (;;) {
    const missing = evalInCorpus(
      options,
      expected,
      `() => { const wanted = ${JSON.stringify(wanted)}; const known = new Set(app.vault.getFiles().map((f) => f.path)); return wanted.filter((p) => !known.has(p) || (p.endsWith(".md") && !app.metadataCache.getCache(p))); }`,
    );
    if (missing.length === 0) {
      console.log(`indexed: all ${wanted.length} generated files are in the file list and every note in the metadata cache`);
      return;
    }
    if (Date.now() > deadline) {
      console.error(`bases-capture: ${missing.length} generated files not indexed after 300 s, e.g. ${missing.slice(0, 5).join(", ")}`);
      process.exit(4);
    }
    console.log(`waiting: ${missing.length} of ${wanted.length} not indexed yet`);
    spawnSync("sleep", ["5"]);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "generate") generate(options);
  else if (options.mode === "wait-indexed") waitIndexed(options);
  else capture(options);
} catch (error) {
  console.error(`bases-capture: ${error.message}`);
  process.exit(2);
}
