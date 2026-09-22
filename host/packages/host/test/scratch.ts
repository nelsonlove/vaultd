/**
 * Every scratch directory this suite makes, in one place, under `target/tmp`.
 *
 * **Why not `os.tmpdir()`.** It was, and the final review counted the cost:
 * **17,533 abandoned `vaultd-*` directories** in the OS tmpdir beside 12,322
 * under `target/tmp`. The leak was never the helper — `cleanupRealDaemons`
 * removed what it registered — it was the call sites that reached for
 * `mkdtempSync(join(tmpdir(), …))` directly and so registered nothing. Two
 * changes close it together: the base moves inside the repository, which is the
 * host's half of the same rule the Rust side keeps with `TMPDIR=target/tmp`, so
 * anything that does escape cleanup is swept with the build tree rather than
 * accumulating in a directory nobody looks at; and the helper is the only door,
 * so registration is not something a case can forget.
 *
 * **It is `node:fs` in a test, which is allowed.** `test/fs-seam.test.ts` bans
 * the import under `src/` — host code reaches the filesystem through
 * `runtime/fs-access.ts` — and this is the suite's own scaffolding, which has to
 * make directories before any host exists.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * `<repo>/target/tmp`, the same directory the crates' `TMPDIR` names.
 *
 * Resolved from this file rather than from `process.cwd()`, which vitest sets
 * to `host/` and a case may not depend on.
 */
export const SCRATCH_BASE = resolve(__dirname, "..", "..", "..", "..", "target", "tmp");

const roots: string[] = [];

/**
 * A fresh scratch directory under {@link SCRATCH_BASE}, registered for cleanup.
 *
 * `prefix` is the `mkdtemp` prefix, so it keeps naming what made the directory —
 * which is how the review attributed the leak to four call sites in the first
 * place.
 */
export function scratchRoot(prefix: string): string {
  mkdirSync(SCRATCH_BASE, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_BASE, prefix));
  roots.push(root);
  return root;
}

/**
 * Remove every scratch directory taken since the last call.
 *
 * Registered as an `afterAll` for **every** test file by
 * `test/scratch-setup.ts`, so a file that takes a scratch directory and forgets
 * to clean up cannot leak one. `cleanupRealDaemons` calls it too, so a
 * real-daemon file still sweeps per case rather than per file.
 *
 * `force` because a case that removed its own directory is not an error here,
 * and a failed removal must never be the reason a green run reports red.
 */
export function cleanupScratchRoots(): void {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A directory a case has already removed, or one the OS is still holding.
    }
  }
}
