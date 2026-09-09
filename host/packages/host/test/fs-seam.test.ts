import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The host has exactly one fs seam: `src/runtime/fs-access.ts`. Every other
 * module under `src/` reaches the file system through it, and therefore through
 * the CommonJS door the write guard watches.
 *
 * This is the invariant Task 22's static check inherits. It is written here, at
 * the moment the seam is created, so that every later task is held to it while
 * its fs call sites are being written rather than after.
 */
const SRC_ROOT = resolve(__dirname, "..", "src");
const SEAM = join("runtime", "fs-access.ts");

/**
 * Every spelling that reaches the file system module directly. A name-by-name
 * ban (`writeFile`, `appendFile`, …) is defeated by a namespace import, a
 * computed member, or a re-export; banning the *module* cannot be spelled
 * around.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["node:fs", /node:fs/],
  ["fs/promises", /["']fs\/promises["']/],
  ["from \"fs\"", /from\s+["']fs["']/],
  ["require(\"fs\")", /require\(\s*["']fs["']\s*\)/],
];

function typescriptFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...typescriptFilesUnder(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

describe("the host has one fs seam", () => {
  it("finds the seam, and the seam does name the fs modules", () => {
    const seam = readFileSync(join(SRC_ROOT, SEAM), "utf8");
    expect(seam).toContain("node:fs");
    expect(seam).toContain("node:fs/promises");
  });

  it("sees a src tree worth checking", () => {
    // Guards the instrument itself: an empty or mis-rooted walk would make
    // every assertion below pass without checking anything.
    const files = typescriptFilesUnder(SRC_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.map((f) => relative(SRC_ROOT, f))).toContain(SEAM);
  });

  it("lets no other file under src reach the fs modules directly", () => {
    for (const file of typescriptFilesUnder(SRC_ROOT)) {
      const name = relative(SRC_ROOT, file);
      if (name === SEAM) continue;
      const source = readFileSync(file, "utf8");
      for (const [label, pattern] of FORBIDDEN) {
        expect(pattern.test(source), `${name} must reach fs through ${SEAM}, not ${label}`).toBe(
          false,
        );
      }
    }
  });
});
