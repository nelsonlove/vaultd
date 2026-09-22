/**
 * The per-run cleanup for {@link scratchRoot}, registered for every test file.
 *
 * A setup file rather than an `afterAll` copied into each file that takes a
 * scratch directory: the leak the final review measured was entirely
 * call sites that forgot, so the sweep has to be something a case cannot
 * forget. Vitest runs one process per file, so this is one `afterAll` per file,
 * removing exactly what that file took.
 */

import { afterAll } from "vitest";

import { cleanupScratchRoots } from "./scratch";

afterAll(() => {
  cleanupScratchRoots();
});
