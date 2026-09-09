import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";

export interface FsWriteViolation {
  readonly call: string;
  readonly path: string;
  readonly stack: string;
}

export interface FsWriteGuard {
  violations(): readonly FsWriteViolation[];
  assertClean(): void;
  release(): void;
}

const SYNC_CALLS = [
  "writeFileSync", "appendFileSync", "renameSync", "unlinkSync", "rmSync",
  "rmdirSync", "mkdirSync", "copyFileSync", "cpSync", "truncateSync",
  "openSync", "createWriteStream", "writevSync", "ftruncateSync",
] as const;

const PROMISE_CALLS = [
  "writeFile", "appendFile", "rename", "unlink", "rm", "rmdir",
  "mkdir", "copyFile", "cp", "truncate", "open",
] as const;

const WRITE_FLAGS = /[wax+]/;

/**
 * A require() anchored inside the workspace. Built-in ids ("node:fs") resolve
 * the same from any anchor, so the anchor only has to be a real absolute path.
 */
const nodeRequire = createRequire(resolve(process.cwd(), "fs-guard.anchor.js"));

/**
 * The CommonJS exports objects for the two fs modules.
 *
 * `import * as fs from "node:fs"` hands back a frozen ESM Module namespace that
 * cannot be assigned to, so the guard patches the mutable CJS objects instead.
 * Node keeps the ESM namespace of a builtin in step with its CJS exports, but
 * only when the builtin is required again: `require("node:fs")` runs
 * `compileForPublicLoader()`, which calls `syncExports()` and pushes the current
 * CJS values into the ESM live bindings. `syncFacades()` below is that re-require,
 * and it is what makes the patch visible to code that used `import`.
 */
const fsCjs = nodeRequire("node:fs") as Record<string, unknown>;
const fspCjs = nodeRequire("node:fs/promises") as Record<string, unknown>;

function syncFacades(): void {
  nodeRequire("node:fs");
  nodeRequire("node:fs/promises");
}

export function installFsWriteGuard(vaultRoot: string): FsWriteGuard {
  const given = resolve(vaultRoot);
  // On macOS the temp dir (and often the vault itself) sits behind a symlink,
  // so a caller can address the same file through either spelling. Both count
  // as "inside the vault"; the recorded path stays the one the caller used.
  const roots = [...new Set([given, realpathSync(given)])];
  const found: FsWriteViolation[] = [];
  const restore: Array<() => void> = [];

  const inside = (candidate: unknown): string | null => {
    if (typeof candidate !== "string" || !candidate.length) return null;
    const abs = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
    const hit = roots.some((root) => abs === root || abs.startsWith(root + sep));
    return hit ? abs : null;
  };

  const record = (call: string, path: string): void => {
    found.push({ call, path, stack: new Error(`${call} ${path}`).stack ?? "" });
  };

  // Some fs entry points delegate to another one that is also patched
  // (`appendFileSync` calls `writeFileSync`, for instance). Only the outermost
  // call is recorded, so a violation names the call the host actually made and
  // the count is the number of writes, not the depth of Node's own plumbing.
  let depth = 0;

  const wrap = (holder: Record<string, unknown>, call: string, isOpen: boolean): void => {
    const original = holder[call];
    if (typeof original !== "function") return;
    const patched = (...args: unknown[]): unknown => {
      const target = inside(args[0]);
      const writing = !isOpen || typeof args[1] !== "string" || WRITE_FLAGS.test(args[1]);
      if (depth === 0 && target !== null && writing) record(call, target);
      depth += 1;
      try {
        return (original as (...a: unknown[]) => unknown).apply(holder, args);
      } finally {
        depth -= 1;
      }
    };
    holder[call] = patched;
    restore.push(() => { holder[call] = original; });
  };

  for (const call of SYNC_CALLS) {
    wrap(fsCjs, call, call === "openSync");
  }
  for (const call of PROMISE_CALLS) {
    wrap(fspCjs, call, call === "open");
  }
  syncFacades();

  return {
    violations: () => found,
    assertClean() {
      if (found.length === 0) return;
      const detail = found.map((v) => `${v.call} ${v.path}\n${v.stack}`).join("\n\n");
      throw new Error(`host wrote ${found.length} vault path(s) directly:\n\n${detail}`);
    },
    release() {
      while (restore.length) restore.pop()?.();
      syncFacades();
    },
  };
}
