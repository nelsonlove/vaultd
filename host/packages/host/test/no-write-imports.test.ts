/**
 * The static half of Goal 4: **the host writes no vault bytes directly.**
 *
 * Task 1's runtime guard patches the CommonJS exports of the two fs builtins
 * and catches every namespace call — `fs.writeFileSync(...)`. It cannot catch
 * the other form. Node snapshots a builtin's ESM namespace when the facade is
 * first instantiated, so `import { writeFile } from "node:fs/promises"` holds a
 * binding taken before any patch and the guard never sees the call. A guard
 * with a blind spot is worse than none, because the green run reads as proof.
 *
 * So the blind spot is closed statically, here. This file is narrow on purpose
 * — it asks one question, "does any module under `src/` import an fs write
 * function by name" — and `test/fs-seam.test.ts` is the broader instrument: it
 * bans the *specifier* and every door to it (`createRequire`, a dynamic
 * `import()`, a computed require) across the same tree. The two overlap
 * deliberately. This one names the write functions, so a future seam that
 * exported a whole builtin under some other spelling would still be caught by
 * the function names it re-exports.
 *
 * **Two files are permitted, and both are permitted for a stated reason:**
 *
 * - `src/runtime/fs-access.ts` — the seam. It is the one module that names the
 *   fs builtins, and the CommonJS door it hands out is exactly the door the
 *   runtime guard patches, so every call through it is visible.
 * - `worker/watchdog-worker.js` — Task 21's stall reporter. It writes the
 *   report itself because the main thread is the thing being reported on, and
 *   it cannot reach the seam: the seam is TypeScript under `src/`, in another
 *   thread, behind the door the guard patches for the *main* thread.
 *
 * **What this file does NOT claim.** The brief's sketch named `src/datadir.ts`
 * as the second exempt file, on the reading that it is "the one module allowed
 * to write outside the vault". It still is — every `DataDir` target must
 * resolve under `config.dataDir` and the class asserts it — but it reaches the
 * file system *through the seam*, so it imports nothing from `node:fs` and is
 * not an exemption at all. Asserting an exemption that does not exist would
 * have been an assertion that could never fail. The list below is measured.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(__dirname, "..");
const SRC_ROOT = join(PACKAGE_ROOT, "src");

/**
 * Every fs export that can put a byte on disk, or take one off.
 *
 * `mkdir` and `rm` are here beside `writeFile` because a directory is a write
 * too: a host that created `Some folder/` in the vault without a `create_folder`
 * op has changed the vault behind the daemon's back just as surely as one that
 * wrote a note.
 */
const BANNED =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|link|linkSync|symlink|symlinkSync|open|openSync|createWriteStream)\b/;

/** `import { … } from "node:fs"` / `"node:fs/promises"`, and the bare spellings. */
const FS_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g;

/** The files permitted to name an fs write function, and nothing else. */
const PERMITTED = [join("src", "runtime", "fs-access.ts"), join("worker", "watchdog-worker.js")];

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFilesUnder(full));
      continue;
    }
    if (full.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

describe("no direct filesystem writes in host source", () => {
  const files = sourceFilesUnder(SRC_ROOT);

  it("finds the source tree it claims to be scanning", () => {
    // The instrument guard. A mis-rooted walk finds nothing and every
    // assertion below passes vacuously, which is the one failure mode a
    // grep-shaped test has.
    expect(files.length).toBeGreaterThan(40);
    expect(files.map((file) => relative(PACKAGE_ROOT, file))).toContain(PERMITTED[0]);
  });

  it("imports no fs write function outside the seam", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(PACKAGE_ROOT, file);
      if (PERMITTED.includes(rel)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(FS_IMPORT)) {
        const named = match[1] ?? "";
        if (BANNED.test(named)) offenders.push(`${rel}: ${named.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has exactly the two permitted writers, and they are the seam and the watchdog worker", () => {
    // Measured rather than assumed: the whole package minus its build output,
    // its dependencies and its test fixtures, filtered to the files that name
    // an fs module at all. `test/` is excluded because its `.js` files are
    // fixtures — a spawned stand-in daemon, plugin bundles compiled as a
    // browser would compile them — and its `.ts` files are the suite itself,
    // which reads and writes scratch directories by design.
    const writers = packageFilesNamingFs().filter((rel) =>
      BANNED.test(readFileSync(join(PACKAGE_ROOT, rel), "utf8")),
    );
    expect(writers.sort()).toEqual([...PERMITTED].sort());
  });
});

/** Every file in the package, outside build output and fixtures, naming an fs module. */
function packageFilesNamingFs(): string[] {
  const skip = new Set(["node_modules", "dist", "test", "target"]);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts") && !full.endsWith(".js")) continue;
      if (/["'](?:node:)?fs(?:\/promises)?["']/.test(readFileSync(full, "utf8"))) {
        found.push(relative(PACKAGE_ROOT, full));
      }
    }
  };
  walk(PACKAGE_ROOT);
  return found;
}
