import { createRequire } from "node:module";

/**
 * The host's single file-system seam.
 *
 * **This is the only module under `src/` allowed to name `node:fs`.**
 * `test/fs-seam.test.ts` enforces that, and Task 22's static check inherits it.
 *
 * Two reasons the seam exists, and both matter:
 *
 * 1. **The write guard can see through it.** `src/testing/fs-guard.ts` proves
 *    the host never writes vault bytes by patching the *CommonJS* exports of
 *    `node:fs` and `node:fs/promises` — the door the compiled host and every
 *    esbuild-CJS plugin bundle use. A caller that instead wrote
 *    `import { writeFile } from "node:fs/promises"` would be invisible to it:
 *    Node snapshots the ESM namespace of a builtin when it is first
 *    instantiated, and no later patch of the CJS exports can reach a binding
 *    taken from that snapshot. (Under Vitest the snapshot is taken before any
 *    test code runs, so the ordering escape hatch is not available there
 *    either.) Routing every fs call through this module means every fs call is
 *    a property access on the patchable object, made at call time.
 * 2. **It is an injection point.** A fake or read-only fs can be substituted
 *    here later without touching a single call site.
 *
 * The modules are exported as objects on purpose. Destructuring a function out
 * of them at module load would take a snapshot of exactly the kind described
 * above and defeat the guard, so callers must keep the property access:
 * `fs.writeFileSync(...)`, never `const { writeFileSync } = fs`.
 */
const nodeRequire = createRequire(__filename);

/** The CommonJS `node:fs` exports object — mutable, and therefore watchable. */
export const fs = nodeRequire("node:fs") as typeof import("node:fs");

/** The CommonJS `node:fs/promises` exports object. */
export const fsPromises = nodeRequire("node:fs/promises") as typeof import("node:fs/promises");

/** Resolve a path through every symlink. Kept as a call so the guard sees it. */
export function realpathSync(target: string): string {
  return fs.realpathSync(target);
}

/**
 * Every spelling of the file-system modules, as a `require` specifier.
 *
 * **Here because this is the one file allowed to name them.** The dry-run
 * refusal list in `runtime/intercept.ts` has to name the fs modules in order to
 * refuse them, and `test/fs-seam.test.ts` bans the literal spellings everywhere
 * else under `src/` — rightly, since a grep cannot tell "names it to refuse it"
 * from "names it to use it". So the list lives with the seam and the module that
 * refuses imports it, which also means a new spelling is added once, beside the
 * others, rather than in two places that drift.
 */
export const FS_MODULE_SPECIFIERS: readonly string[] = [
  "node:fs",
  "node:fs/promises",
  "fs",
  "fs/promises",
];
