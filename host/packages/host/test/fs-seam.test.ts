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
 * Two kinds of ban, because there are two kinds of escape.
 *
 * The first three patterns ban the **specifier**: any literal spelling of the
 * fs modules, whichever door it is handed to. The last four ban the **door**:
 * the ways a module can be reached without naming it literally. Banning doors
 * is what closes the computed specifier — `require("f" + "s")` names no fs
 * module a grep can see, so the grep has to refuse the dynamic call instead.
 *
 * What is deliberately NOT banned: a literal `require("some-package")` for a
 * non-fs module, and the word `require` in prose or in an error message. Those
 * appear in `runtime/electron-registry.ts` today and are not fs doors.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["the node:fs specifier", /node:fs/],
  ["a bare \"fs\" specifier", /["']fs["']/],
  ["a bare \"fs/promises\" specifier", /["']fs\/promises["']/],
  ["createRequire", /\bcreateRequire\b/],
  ["a dynamic import()", /\bimport\s*\(/],
  // Narrowed with a negative lookahead so the pattern matches only what its
  // label claims: `= require` *not* followed by a call. Without it this also
  // flagged `const mod = require("some-package")` — an ordinary literal
  // require of a non-fs module, which the specifier bans already cover and
  // which the "still allows" case below says is fine.
  ["require aliased into a variable", /=\s*require\b(?!\s*\()/],
  ["require() with a computed specifier", /\brequire\s*\(\s*[^"'\s)\\]/],
];

/**
 * Every spell-around the re-review named. Each of these MUST be caught: they
 * are the negative fixtures that keep the ban above from quietly rotting into
 * a pattern that matches nothing anyone would actually write.
 */
const SPELL_AROUNDS: ReadonlyArray<readonly [string, string]> = [
  ["dynamic import of a literal", 'const mod = await import("fs");'],
  ["dynamic import of a computed specifier", 'const mod = await import(chosen);'],
  ["aliased createRequire", 'const make = createRequire;\nconst req = make(__filename);\nreq("fs");'],
  ["require aliased into a variable", 'const req = require;\nreq("fs");'],
  ["require with a computed specifier", 'const spec = "f" + "s";\nconst mod = require(spec);'],
  ["node:fs/promises by name", 'import { writeFile } from "node:fs/promises";'],
];

/**
 * The seam exports module objects, not functions, and callers must keep the
 * property access: `fs.writeFileSync(...)`. Destructuring takes a snapshot of
 * the function at import time, and a snapshot taken before the guard installs
 * its patch is exactly what the guard cannot see.
 *
 * Residual, and it is fine: `const f = fs; f.writeFileSync(...)` aliases the
 * *object*, so the call is still a property read on the patched object and the
 * guard sees it. Only destructuring the functions out breaks the instrument.
 * `const { O_WRONLY } = fs.constants` is likewise fine — constants are values,
 * and nothing patches them.
 *
 * One further residual, and it is deliberate: `const f = fs; const { writeFileSync } = f;`
 * destructures the seam through an alias and this check does not see it, because
 * the check matches on the seam's own two names rather than tracking assignment.
 * Following aliases would mean parsing rather than grepping, and the grep is
 * meant to catch the shape someone writes by habit, not the two-step one nobody
 * writes by accident. The fs-guard test is the backstop for a call that does
 * escape.
 */
const DESTRUCTURES_SEAM = /(?:const|let|var)\s*\{[^}]*\}\s*=\s*(?:fs|fsPromises)(?![\w.])/;

function typescriptFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...typescriptFilesUnder(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

function filesToCheck(): Array<readonly [string, string]> {
  return typescriptFilesUnder(SRC_ROOT)
    .map((file) => [relative(SRC_ROOT, file), readFileSync(file, "utf8")] as const)
    .filter(([name]) => name !== SEAM);
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
    expect(filesToCheck().length).toBeGreaterThanOrEqual(2);
  });

  it("catches every spell-around the ban is meant to close", () => {
    for (const [label, sample] of SPELL_AROUNDS) {
      const caught = FORBIDDEN.some(([, pattern]) => pattern.test(sample));
      expect(caught, `the ban must catch ${label}: ${sample}`).toBe(true);
    }
  });

  it("still allows the shapes that are not fs doors", () => {
    // A ban that flagged these would be unusable: the first is in
    // `runtime/electron-registry.ts` today, and the second is ordinary prose.
    const allowed = ['throw new Error("require(\\"electron\\") was resolved too early");', "/** at require time. */"];
    for (const sample of allowed) {
      const caught = FORBIDDEN.filter(([, pattern]) => pattern.test(sample));
      expect(caught.map(([label]) => label), `wrongly flagged: ${sample}`).toEqual([]);
    }
  });

  it("lets no other file under src reach the fs modules directly", () => {
    for (const [name, source] of filesToCheck()) {
      for (const [label, pattern] of FORBIDDEN) {
        expect(pattern.test(source), `${name} must reach fs through ${SEAM}, not ${label}`).toBe(
          false,
        );
      }
    }
  });
});

describe("the seam is used as a live object, never destructured", () => {
  it("catches a planted destructuring, and tolerates the safe shapes", () => {
    expect(DESTRUCTURES_SEAM.test("const { writeFileSync } = fs;")).toBe(true);
    expect(DESTRUCTURES_SEAM.test("const { writeFile, mkdir } = fsPromises;")).toBe(true);
    expect(DESTRUCTURES_SEAM.test("const { O_WRONLY, O_CREAT } = fs.constants;")).toBe(false);
    expect(DESTRUCTURES_SEAM.test("const alias = fs;")).toBe(false);
  });

  it("finds no file under src that destructures the seam", () => {
    for (const [name, source] of filesToCheck()) {
      expect(
        DESTRUCTURES_SEAM.test(source),
        `${name} must call through the seam object (fs.writeFileSync), not destructure it`,
      ).toBe(false);
    }
  });
});
