#!/usr/bin/env node
"use strict";
/**
 * Copy a vault's bases, and the notes they name, into a scratch vault.
 *
 * The one program in the Bases phase that reads the live vault. It is run by
 * hand, by the vault's owner, and it only ever reads there:
 *
 *   node host/scripts/bases-corpus-copy.js --from ~/vault --to target/tmp/bases-corpus
 *
 * What it reads: every `.base` file under --from (skipping dot-directories
 * and the guarded private folder, unconditionally), every `.md` note's text (to find
 * tags and embeds), and `.obsidian/types.json`. What it writes: only under
 * --to, which must be inside this repository's `target/tmp/`, and which it
 * replaces wholesale when --fresh is given. What it copies, per base: the
 * base; the notes in every folder an `inFolder("…")` names; the notes that
 * carry a tag a `hasTag("…")` names; the notes a `[[link]]`, `link("…")`,
 * `file("…")` or `hasLink("…")` in the base names; the notes that embed the
 * base; and, for a base none of those narrow, the notes beside it — each set
 * capped at --max-per-set (default 200), in path order. `MANIFEST.json` lists
 * every copied path with every reason it was copied.
 */

const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join, relative, resolve, sep } = require("node:path");

const REPO = resolve(__dirname, "..", "..");
const SCRATCH = join(REPO, "target", "tmp");
// A private folder the copy never reads. Set VAULTD_CORPUS_GUARDED to name
// your own; the default is a placeholder.
const GUARDED = process.env.VAULTD_CORPUS_GUARDED || "Private";

function parseArgs(argv) {
  const out = { maxPerSet: 200, fresh: false };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const next = () => {
      at += 1;
      if (at >= argv.length) throw new Error(`${flag} wants a value`);
      return argv[at];
    };
    switch (flag) {
      case "--from": out.from = resolve(next()); break;
      case "--to": out.to = resolve(next()); break;
      case "--max-per-set": out.maxPerSet = Number(next()); break;
      case "--fresh": out.fresh = true; break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!out.from || !out.to) throw new Error("--from and --to are both required");
  if (!out.to.startsWith(SCRATCH + sep)) throw new Error(`--to must be inside ${SCRATCH}, not ${out.to}`);
  if (out.from.startsWith(out.to) || out.to.startsWith(out.from + sep)) throw new Error("--to and --from must not contain each other");
  if (!Number.isInteger(out.maxPerSet) || out.maxPerSet < 1) throw new Error("--max-per-set wants a positive integer");
  return out;
}

/** Every file under root, vault-relative, skipping dot-directories and the guarded area. */
function walk(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (rel === GUARDED || rel.startsWith(`${GUARDED}/`)) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(rel);
    }
  };
  visit(root);
  return files.sort();
}

const strings = (text, fn) => [...text.matchAll(new RegExp(`${fn}\\(\\s*(["'])(.*?)\\1`, "g"))].map((m) => m[2]);

function tagsOf(text) {
  const tags = new Set();
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (front) {
    const line = /^tags?:\s*(.*)$/m.exec(front[1]);
    if (line) for (const t of line[1].replace(/[[\]]/g, "").split(",")) if (t.trim()) tags.add(t.trim().replace(/^#/, "").toLowerCase());
    for (const m of front[1].matchAll(/^\s*-\s*#?([^\s#][^\n]*)$/gm)) tags.add(m[1].trim().toLowerCase());
  }
  for (const m of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(m[1].toLowerCase());
  return tags;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (existsSync(options.to) && readdirSync(options.to).length > 0) {
    if (!options.fresh) throw new Error(`${options.to} is not empty; pass --fresh to replace it`);
    rmSync(options.to, { recursive: true, force: true });
  }
  const files = walk(options.from);
  const notes = files.filter((f) => f.endsWith(".md"));
  const bases = files.filter((f) => f.endsWith(".base"));
  const text = new Map();
  const read = (rel) => {
    if (!text.has(rel)) text.set(rel, readFileSync(join(options.from, rel), "utf8"));
    return text.get(rel);
  };
  const reasons = new Map();
  const add = (rel, reason) => {
    if (!reasons.has(rel)) reasons.set(rel, []);
    reasons.get(rel).push(reason);
  };
  const capped = (list) => list.slice(0, options.maxPerSet);
  const byName = (name) => {
    const wanted = name.replace(/^\[\[|\]\]$/g, "").split(/[#|]/)[0].toLowerCase();
    return notes.filter((n) => n.toLowerCase() === wanted || n.toLowerCase() === `${wanted}.md` || n.toLowerCase().endsWith(`/${wanted}.md`) || n.toLowerCase().endsWith(`/${wanted}`));
  };

  for (const base of bases) {
    const source = read(base);
    add(base, "base");
    const folders = strings(source, "inFolder");
    const tags = strings(source, "hasTag").map((t) => t.replace(/^#/, "").toLowerCase());
    const named = [
      ...[...source.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]),
      ...strings(source, "link"), ...strings(source, "file"), ...strings(source, "hasLink"),
    ];
    for (const folder of folders) for (const n of capped(notes.filter((n) => n.startsWith(`${folder.replace(/\/$/, "")}/`)))) add(n, `${base}: inFolder ${folder}`);
    for (const tag of tags) {
      const tagged = notes.filter((n) => [...tagsOf(read(n))].some((t) => t === tag || t.startsWith(`${tag}/`)));
      for (const n of capped(tagged)) add(n, `${base}: hasTag ${tag}`);
    }
    for (const name of named) for (const n of byName(name)) add(n, `${base}: names ${name}`);
    const stem = base.split("/").pop();
    for (const n of capped(notes.filter((n) => read(n).includes(`![[${stem}`) || read(n).includes(`![[${base}`)))) add(n, `${base}: embeds it`);
    if (folders.length === 0 && tags.length === 0) {
      const here = dirname(base) === "." ? "" : `${dirname(base)}/`;
      for (const n of capped(notes.filter((n) => n.startsWith(here) && !n.slice(here.length).includes("/")))) add(n, `${base}: beside it`);
    }
  }

  for (const rel of [...reasons.keys()].sort()) {
    const target = join(options.to, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(options.from, rel), target, { preserveTimestamps: true });
  }
  const types = join(options.from, ".obsidian", "types.json");
  if (existsSync(types) && statSync(types).isFile()) {
    mkdirSync(join(options.to, ".obsidian"), { recursive: true });
    cpSync(types, join(options.to, ".obsidian", "types.json"));
    add(".obsidian/types.json", "property types");
  }
  const manifest = {
    from: options.from,
    copied: Object.fromEntries([...reasons.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    bases: bases.length,
    excluded: `${GUARDED}/ and every dot-directory, unconditionally`,
  };
  writeFileSync(join(options.to, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`bases: ${bases.length}, files copied: ${reasons.size}, manifest: ${join(options.to, "MANIFEST.json")}`);
}

try {
  main();
} catch (error) {
  console.error(`bases-corpus-copy: ${error.message}`);
  process.exit(2);
}
