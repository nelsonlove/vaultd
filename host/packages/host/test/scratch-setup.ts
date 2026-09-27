/**
 * The per-run cleanup for {@link scratchRoot}, registered for every test file.
 *
 * A setup file rather than an `afterAll` copied into each file that takes a
 * scratch directory: the leak the final review measured was entirely
 * call sites that forgot, so the sweep has to be something a case cannot
 * forget. Vitest runs one process per file, so this is one `afterAll` per file,
 * removing exactly what that file took.
 */

import { join } from "node:path";
import { afterAll } from "vitest";

import { SCRATCH_BASE, cleanupScratchRoots } from "./scratch";

/**
 * **The engine socket's default path is redirected into the scratch base, for
 * every file, whatever mode it runs under.**
 *
 * `defaultHostConfig` derives `engineSocketPath` from `vaultdSocketPathFor`,
 * which honours `$XDG_RUNTIME_DIR` and otherwise lands in `~/.cache/vaultd/run`
 * — outside `target/tmp`, unswept, and shared between every run on the machine.
 * Fourteen config factories pin `engine: "spawn"` so they never bind it, and
 * those pins are right for their own reasons, but they are discipline: the next
 * factory that forgets one would bind a daemon in the developer's own run
 * directory and leave it there, with no gate to say so. This is the gate, in
 * the one file vitest already loads for every test.
 *
 * **Unconditionally, not only when unset**, because a developer's real
 * `XDG_RUNTIME_DIR` is exactly as far outside the scratch base as the cache
 * fallback is. The two derivation cases in `test/engine-probe.test.ts` set and
 * restore the variable themselves, so they still pin the rule this defeats.
 *
 * `r` is one character because the budget is real: a Unix socket address holds
 * 103 bytes on Darwin, this worktree's own path is 61 of them, and the derived
 * path adds `/target/tmp/r` + `/vaultd/` + a 16-character digest + `.sock` —
 * 103 exactly. A longer name would be refused by the daemon's own
 * `check_path_length`, loudly and by name, which is the failure this would
 * rather have than a silent bind somewhere else.
 */
process.env.XDG_RUNTIME_DIR = join(SCRATCH_BASE, "r");

afterAll(() => {
  cleanupScratchRoots();
});
