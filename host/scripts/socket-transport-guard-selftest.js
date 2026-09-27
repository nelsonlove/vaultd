#!/usr/bin/env node
"use strict";
/**
 * The one rail between a typo and a real vault, tested.
 *
 * `socket-transport-baseline.js`'s `assertSafeToBuild` is what stops the harness
 * building a thousand-note fixture over notes that matter: a path under the
 * repository's `target/` is its own scratch and is filled without ceremony,
 * anywhere else an existing non-empty directory is refused. That rule was
 * lexical once, and a symlink under `target/` pointing at a real vault walked
 * straight through it. This is the pin, and it is a plain node script rather
 * than a vitest case because the harnesses are scripts and have no test project.
 *
 *     node host/scripts/socket-transport-guard-selftest.js   # exits 0 or 1
 *
 * It writes only under `target/tmp/guard-selftest` and one directory of its own
 * under the user's home directory (deliberately *outside* `target/`, since that
 * is the thing being refused), and it removes both.
 *
 * The "outside" directory is rooted at `homedir()` rather than `tmpdir()` on
 * purpose: `tmpdir()` reads `$TMPDIR`, and this project's own Rust gates
 * mandate `TMPDIR="$PWD/target/tmp"` — under which the "outside" directory
 * would land *inside* `target/`, and case 3 below would fail red (`allowed`
 * where it expects `refused`) for an environment reason, not a guard defect.
 */

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const { REPO, assertSafeToBuild } = require("./socket-transport-baseline.js");

const SCRATCH = join(REPO, "target", "tmp", "guard-selftest");

/** What the guard did, as a word, so a case can assert either outcome. */
function verdict(path) {
  try {
    assertSafeToBuild(path);
    return "allowed";
  } catch {
    return "refused";
  }
}

function main() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  // A stand-in for a real vault: outside `target/`, existing, and not empty.
  const outside = mkdtempSync(join(homedir(), ".vaultd-guard-selftest-"));
  writeFileSync(join(outside, "Note.md"), "# a note that matters\n");

  try {
    // 1. The harness's own scratch is scratch.
    const own = join(SCRATCH, "vault");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "Note-000000.md"), "# fixture\n");
    assert.equal(verdict(own), "allowed", "a non-empty directory under target/ is the harness's own");

    // 2. A path that does not exist yet is fine wherever it is.
    assert.equal(verdict(join(outside, "not-there-yet")), "allowed", "a path with nothing at it");

    // 3. An existing non-empty directory outside target/ is refused.
    assert.equal(verdict(outside), "refused", "somebody's notes are not a fixture site");

    // 4. **The case the lexical guard got wrong.** A symlink *under* target/
    //    whose target is that same directory outside it must be refused: the
    //    bytes would land on the far side of the link, not in the scratch.
    const trojan = join(SCRATCH, "link-to-it");
    symlinkSync(outside, trojan);
    assert.equal(verdict(trojan), "refused", "a symlink out of target/ is not under target/");

    // 5. And the reverse must still work: a symlink under target/ pointing at
    //    another place under target/ is still scratch, so the fix cannot be "any
    //    symlink is refused".
    const inner = join(SCRATCH, "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "Note-000000.md"), "# fixture\n");
    const friendly = join(SCRATCH, "link-to-inner");
    symlinkSync(inner, friendly);
    assert.equal(verdict(friendly), "allowed", "a symlink within target/ is still scratch");

    process.stdout.write("guard-selftest: 5 cases, all as expected\n");
  } finally {
    rmSync(SCRATCH, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `guard-selftest: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
