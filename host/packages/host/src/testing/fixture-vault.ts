/**
 * A vault made of strings, whose notes are parsed by **vaultd's own parser**.
 *
 * This is where the parity tests' honesty is decided. A fixture row can come
 * from one of three places, and only one of them is worth anything:
 *
 * 1. **Hand-written.** A parity test fed hand-written rows compares one
 *    person's idea of the parse against another's, and agrees with itself
 *    whatever the daemon does.
 * 2. **A second parser, in TypeScript.** Two parsers means two answers and no
 *    way to know which is right.
 * 3. **The real parser.** So the fixtures are produced by `cargo run --bin
 *    fixture-row`, which runs the production `vault_core` parse and prints the
 *    JSON a `snapshot_notes` page would carry — and the host converts it with
 *    {@link mirrorNoteRow}, the same function a real hydration uses.
 *
 * The third costs a subprocess, so the answers are memoized under
 * `host/fixtures/cache/`, which is gitignored. A cache hit spawns nothing; a
 * miss spawns once for the whole batch. A miss with no `cargo` on `PATH`
 * throws a message naming the cache directory and the command that refills it
 * — never a hand-written fallback, which would be shape 1 wearing shape 3's
 * clothes.
 *
 * **The cache key names the parser, not just the input.** The whole value of
 * shape 3 is that these rows are what `vault-core` really answers, and a cache
 * keyed on the fixture text alone quietly keeps answering what it answered
 * before the parser changed — so a parser fix lands and the host's parity tests
 * never see it. {@link fixtureParserStamp} therefore hashes the generator
 * binary into every key.
 *
 * One consequence, stated rather than discovered: **a machine with no
 * `target/debug/fixture-row` has a cold cache**, because there is no parser
 * identity to key on and a row of unknown provenance is worth less than a
 * rebuild. The "runs from the cache with no Rust toolchain" path therefore
 * needs the binary present, not merely the cache directory.
 *
 * **Resolution is a whole-vault question**, so a `FixtureVault` parses all of
 * its notes in one request and the binary resolves each note's links against
 * every other. {@link parseFixtureRow}, which is handed one note and no vault,
 * therefore reports a link to a note it was never shown as unresolved — which
 * is the truth about a one-note vault, not a limitation.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { mirrorNoteRow } from "../mirror/hydrate";
import { fs } from "../runtime/fs-access";
import { revisionOfSource } from "./daemon-harness";
import type { SnapshotNoteDto } from "../client/protocol";
import type { MirrorNoteRow } from "../mirror/types";
import type { FixtureEntry, FixtureNote } from "./mirror-harness";

/**
 * One note as the generator takes it.
 *
 * Exported because {@link warmFixtureCache} is the pre-test hook a suite uses
 * to fill the cache in one spawn before its first case runs, and a caller
 * assembling that batch needs the shape.
 */
export interface FixtureRequest {
  path: string;
  source: string;
}

/**
 * The workspace root: the directory holding both `Cargo.toml` and `crates/`.
 *
 * Walked up from this module rather than written down, because this package is
 * checked out at a different absolute path in every worktree and a literal
 * would be wrong in all but one of them.
 *
 * `process.cwd()` is no substitute and must not be used for this: under vitest
 * it is `host/`, so a path built from it lands in `host/target/`, which does not
 * exist. Exported for that reason — `live-host.ts` needs the release binary
 * beside the workspace, not beside whatever directory the runner started in.
 */
export function workspaceRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(join(dir, "Cargo.toml")) && fs.existsSync(join(dir, "crates"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no vaultd workspace above ${__dirname}: found no Cargo.toml beside crates/`);
    }
    dir = parent;
  }
}

function cacheDir(): string {
  return join(workspaceRoot(), "host", "fixtures", "cache");
}

/** Where the memoized rows live. Exported so a test can see what a run wrote. */
export function fixtureCacheDir(): string {
  return cacheDir();
}

/**
 * How many times this process has spawned the generator.
 *
 * The seam that makes "one batch, one spawn" a measurement rather than a claim.
 * The spawn is the expensive thing here — a cold `cargo run` is seconds, and
 * Task 7 calls `ShimHarness.withVault` in every shim test file — so the claim is
 * worth a guard, and a guard needs something to count.
 */
export function fixtureGeneratorSpawns(): number {
  return spawns;
}

let spawns = 0;

/** The command a developer runs to refill the cache, quoted in every failure. */
function regenerateCommand(): string {
  return "cargo run -q -p vault-server --bin fixture-row";
}

/** The generator binary a `cargo run` of `fixture-row` produces. */
function fixtureRowBinary(): string {
  return join(workspaceRoot(), "target", "debug", "fixture-row");
}

let parserStamp: string | null = null;
let stampOverride: string | null = null;
/**
 * A per-process nonce for the no-binary case, so every key misses.
 *
 * Random rather than a constant: a constant would make "no parser" a cache
 * partition that persists across runs, which is exactly the "rows of unknown
 * provenance" the stamp exists to refuse.
 */
const absentStamp = `absent-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 16)}`;

/**
 * Which parser produced a cached row: a short digest of the generator binary.
 *
 * Not memoized while the binary is missing, so a process that builds it — a
 * `cargo run` does — starts keying on the real hash from the next call, rather
 * than staying on the nonce for its whole life. Once a hash is computed it
 * **is** memoized, so one run keys consistently even if a concurrent build
 * replaces the binary underneath it; the next run picks the new one up.
 */
export function fixtureParserStamp(): string {
  if (stampOverride !== null) return stampOverride;
  if (parserStamp !== null) return parserStamp;
  const binary = fixtureRowBinary();
  if (!fs.existsSync(binary)) return absentStamp;
  parserStamp = createHash("sha256").update(fs.readFileSync(binary)).digest("hex").slice(0, 16);
  return parserStamp;
}

/**
 * Force the stamp to a value. **Tests only**, and restore it with `null`.
 *
 * The seam that makes "a parser change invalidates the cache" a measurement
 * rather than a claim: a case sets two different stamps over identical input
 * and asserts {@link cacheKey} does not collide. Asserting on the key rather
 * than on a re-spawn is deliberate — it proves the same property and costs no
 * `cargo run`, which matters in a suite where a miss can block on a build lock
 * for minutes.
 */
export function overrideFixtureParserStamp(value: string | null): void {
  stampOverride = value;
}

/**
 * The cache key for one note inside one document set.
 *
 * Three things are in the digest. The whole document set, not just this note's
 * own bytes: a link out of `A.md` resolves differently depending on what else
 * is in the vault, so a key that named only `A.md` would serve a two-note
 * vault's answer to a one-note vault. The note's path. And the **parser**, so
 * that a change to `vault-core` invalidates every row rather than being
 * invisible to every test that reads one.
 */
export function cacheKey(documents: readonly FixtureRequest[], path: string): string {
  const digest = createHash("sha256");
  digest.update(fixtureParserStamp());
  digest.update("\0parser\0");
  for (const document of documents) {
    digest.update(document.path);
    digest.update("\0");
    digest.update(document.source);
    digest.update("\0");
  }
  digest.update("\0row\0");
  digest.update(path);
  return digest.digest("hex");
}

function readCached(key: string): SnapshotNoteDto | null {
  const file = join(cacheDir(), `${key}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotNoteDto;
}

function writeCached(key: string, dto: SnapshotNoteDto): void {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, `${key}.json`), JSON.stringify(dto), "utf8");
}

/**
 * Run the generator over `documents` and return one row each, in order.
 *
 * One spawn for the whole batch: the binary reads one request per line, and a
 * vault request carries every note at once so the resolver sees the whole set.
 */
function generate(documents: readonly FixtureRequest[]): SnapshotNoteDto[] {
  const request =
    documents.length === 1 && documents[0] !== undefined
      ? JSON.stringify(documents[0])
      : JSON.stringify({ vault: documents });

  spawns += 1;
  const root = workspaceRoot();
  const temporary = join(root, "target", "tmp");
  fs.mkdirSync(temporary, { recursive: true });
  const result = spawnSync(
    "cargo",
    ["run", "-q", "-p", "vault-server", "--bin", "fixture-row", "--manifest-path", join(root, "Cargo.toml")],
    {
      input: `${request}\n`,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: temporary },
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  if (result.error !== undefined) {
    const reason = (result.error as NodeJS.ErrnoException).code === "ENOENT" ? "no cargo on PATH" : result.error.message;
    throw new Error(
      `the fixture generator could not run (${reason}). These rows are produced by vaultd's own ` +
        `parser and cached under ${cacheDir()}; a machine with no Rust toolchain runs from that ` +
        `cache. Refill it on a machine that has one with: ${regenerateCommand()}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${regenerateCommand()} exited ${String(result.status)}: ${result.stderr}`);
  }

  const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
  const first = lines[0];
  if (first === undefined) {
    throw new Error(`${regenerateCommand()} printed nothing for ${documents.length} fixture(s)`);
  }
  const answer = JSON.parse(first) as { error?: string; rows?: SnapshotNoteDto[] } & SnapshotNoteDto;
  if (answer.error !== undefined) {
    throw new Error(`the fixture generator refused the batch: ${answer.error}`);
  }
  const rows = answer.rows ?? [answer];
  if (rows.length !== documents.length) {
    throw new Error(
      `the fixture generator answered ${rows.length} row(s) for ${documents.length} fixture(s)`,
    );
  }
  return rows;
}

/**
 * Every document's snapshot row, from the cache where it is there and from one
 * spawn where it is not.
 *
 * Partial hits do not save a spawn: the batch is one request because resolution
 * is a whole-vault question, so a single miss re-runs all of them. It then
 * writes every row back, which is why a second run of the same suite spawns
 * nothing at all.
 */
function snapshotRows(documents: readonly FixtureRequest[]): SnapshotNoteDto[] {
  const keys = documents.map((document) => cacheKey(documents, document.path));
  const cached = keys.map(readCached);
  const hit = cached.every((row): row is SnapshotNoteDto => row !== null);
  if (hit) return cached;

  const rows = generate(documents);
  rows.forEach((row, index) => {
    const key = keys[index];
    if (key !== undefined) writeCached(key, row);
  });
  return rows;
}

/**
 * Parse every request in **one** spawn, and memoize the rows.
 *
 * The batching surface. `parseFixtureRow` cannot do this on a caller's behalf —
 * it is synchronous and returns a value, so it cannot defer to a batch that has
 * not been assembled yet — which means anything that knows its whole fixture
 * set up front has to say so. `FixtureVault` does, and so does a suite that
 * wants the cache warm before its first case: hand this every note and it costs
 * one `cargo run` rather than one per note.
 *
 * The rows come back in request order, and each is written to the same cache
 * file `parseFixtureRow` would read, so a warmed suite spawns nothing at all.
 */
export function warmFixtureCache(requests: readonly FixtureRequest[]): MirrorNoteRow[] {
  if (requests.length === 0) return [];
  return snapshotRows(requests).map(mirrorNoteRow);
}

/**
 * One note, parsed by the real parser. Memoized under `host/fixtures/cache/`.
 *
 * One note, one spawn on a miss. A caller holding several notes should use
 * {@link warmFixtureCache} instead — and *must*, if those notes link to each
 * other, because a note parsed alone is resolved against a vault containing
 * only itself.
 */
export function parseFixtureRow(path: string, source: string): MirrorNoteRow {
  const row = warmFixtureCache([{ path, source }])[0];
  if (row === undefined) throw new Error(`the fixture generator answered nothing for ${path}`);
  return row;
}

/** Does this path hold markdown the index would parse as a note? */
function isNote(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/**
 * A whole vault of fixtures: the tree it implies, and the parsed row of every
 * note in it.
 *
 * The parse is lazy and memoized on the instance, so constructing a
 * `FixtureVault` costs nothing until something asks it a question that only the
 * parser can answer.
 */
export class FixtureVault {
  private contents: Record<string, string>;
  private rows: Map<string, MirrorNoteRow> | null = null;

  constructor(files: Record<string, string>) {
    this.contents = { ...files };
  }

  get files(): Readonly<Record<string, string>> {
    return this.contents;
  }

  /**
   * The tree the files imply, folders included.
   *
   * The daemon's own tree carries a row for every folder, so a fixture that
   * listed only its files would hydrate a mirror in which `getAbstractFileByPath`
   * of a folder answers nothing — a difference from the real daemon that no
   * test would notice until it mattered.
   *
   * **A folder has no size and no revision, and neither has an attachment** —
   * correction #13: the index stores no content revision for a non-note file.
   */
  entries(): FixtureEntry[] {
    const folders = new Set<string>();
    const entries: FixtureEntry[] = [];
    for (const path of Object.keys(this.contents).sort()) {
      let cut = path.lastIndexOf("/");
      while (cut !== -1) {
        folders.add(path.slice(0, cut));
        cut = path.lastIndexOf("/", cut - 1);
      }
      const source = this.source(path);
      if (isNote(path)) {
        entries.push({
          path,
          kind: "note",
          revision: this.revisionOf(path),
          size: Buffer.byteLength(source, "utf8"),
        });
      } else {
        entries.push({ path, kind: "file", size: Buffer.byteLength(source, "utf8") });
      }
    }
    for (const folder of folders) entries.push({ path: folder, kind: "folder" });
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Every note, parsed by the real parser and resolved against the whole set. */
  notes(): FixtureNote[] {
    return [...this.parsed().values()].map((row) => ({
      path: row.path,
      revision: row.revision,
      properties: [...row.properties],
      aliases: [...row.aliases],
      headings: [...row.headings],
      blocks: [...row.blocks],
      tags: [...row.tags],
      sections: [...row.sections],
      listItems: [...row.listItems],
      outgoing: [...row.outgoing],
    }));
  }

  source(path: string): string {
    const source = this.contents[path];
    if (source === undefined) throw new Error(`${path} is not in this fixture vault`);
    return source;
  }

  /**
   * A note's real BLAKE3 revision, as the parser computed it.
   *
   * A non-note file gets the fixture stand-in instead, and nothing downstream
   * may pair its move by revision — the index stores no revision for one, so
   * there has never been a real value to answer with.
   */
  revisionOf(path: string): string {
    if (!isNote(path)) return revisionOfSource(this.source(path));
    const row = this.parsed().get(path);
    if (row === undefined) throw new Error(`${path} is not in this fixture vault`);
    return row.revision;
  }

  /**
   * Forget a file, as a delete would.
   *
   * A fixture vault that could only ever grow could not model the half of a
   * change set that matters most — a deleted note is what orphans a link, and a
   * rename is a delete plus a create. Removing an unknown path is a no-op, the
   * way deleting something that is not there is.
   */
  remove(path: string): void {
    if (!(path in this.contents)) return;
    const remaining = { ...this.contents };
    delete remaining[path];
    this.contents = remaining;
    this.rows = null;
  }

  /** In-memory only. Bumps the revision, because the bytes changed. */
  write(path: string, content: string): void {
    this.contents = { ...this.contents, [path]: content };
    // Every row in the set may have moved: a new note changes what the others'
    // links resolve to, and an edited one changes its own.
    this.rows = null;
  }

  private parsed(): Map<string, MirrorNoteRow> {
    if (this.rows !== null) return this.rows;
    const documents: FixtureRequest[] = Object.keys(this.contents)
      .filter(isNote)
      .sort()
      .map((path) => ({ path, source: this.source(path) }));
    // One spawn for the whole vault, never one per note — and it has to be one
    // request anyway, because the generator resolves each note's links against
    // the other notes in the same request.
    const rows = new Map<string, MirrorNoteRow>();
    for (const row of warmFixtureCache(documents)) rows.set(row.path, row);
    this.rows = rows;
    return rows;
  }
}
