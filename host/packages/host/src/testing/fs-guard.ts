import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fs, fsPromises, realpathSync } from "../runtime/fs-access";

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

/**
 * Which door this guard watches, and why that is the right door.
 *
 * The guard patches the **CommonJS exports objects** of the two fs builtins,
 * reached through the host's one fs seam
 * (`src/runtime/fs-access.ts`). That is the door the compiled host uses — it
 * ships as CommonJS — and the door every esbuild-CJS plugin bundle uses, so the
 * threat the guard exists for is covered.
 *
 * It is **not** a door that a by-name ESM import goes through. Node snapshots
 * the ESM namespace of a builtin when that builtin's facade is first
 * instantiated; a later patch of the CJS exports cannot reach a caller holding
 * a binding from that snapshot, and the namespace object's properties cannot be
 * assigned to either. Under Vitest the facade is instantiated before any test
 * code runs, so ordering does not rescue it. That blind spot is closed
 * statically instead: `test/fs-seam.test.ts` asserts that no module under
 * `src/` except the seam so much as names an fs builtin — that is why the
 * paragraph above spells none of them out — which is the invariant Task 22
 * inherits.
 */

/**
 * A patched fs entry point: which of its arguments name a path that the call
 * *writes to*, and which argument (if any) carries open flags.
 *
 * Only write targets count. `copyFileSync(vaultNote, elsewhere)` reads the
 * vault and writes outside it, so its source argument is not a violation, while
 * `renameSync` writes both ends — it unlinks the source and creates the
 * destination — so both of its arguments are.
 */
interface CallSpec {
  readonly name: string;
  readonly writeArgs: readonly number[];
  /** Index of the flags argument, or -1 when the call is always a write. */
  readonly flagsArg: number;
}

const spec = (name: string, writeArgs: readonly number[], flagsArg = -1): CallSpec => ({
  name,
  writeArgs,
  flagsArg,
});

const SYNC_CALLS: readonly CallSpec[] = [
  spec("writeFileSync", [0]),
  spec("appendFileSync", [0]),
  spec("renameSync", [0, 1]),
  spec("unlinkSync", [0]),
  spec("rmSync", [0]),
  spec("rmdirSync", [0]),
  spec("mkdirSync", [0]),
  spec("copyFileSync", [1]),
  spec("cpSync", [1]),
  spec("linkSync", [1]),
  spec("symlinkSync", [1]),
  spec("truncateSync", [0]),
  spec("openSync", [0], 1),
  spec("createWriteStream", [0]),
  // fd-based: patched for completeness, but an fd carries no path, so these
  // can only ever be reached through a descriptor an earlier open produced.
  spec("writevSync", []),
  spec("ftruncateSync", []),
];

const PROMISE_CALLS: readonly CallSpec[] = [
  spec("writeFile", [0]),
  spec("appendFile", [0]),
  spec("rename", [0, 1]),
  spec("unlink", [0]),
  spec("rm", [0]),
  spec("rmdir", [0]),
  spec("mkdir", [0]),
  spec("copyFile", [1]),
  spec("cp", [1]),
  spec("link", [1]),
  spec("symlink", [1]),
  spec("truncate", [0]),
  spec("open", [0], 1),
];

/** String flags that can write: `w`rite, `a`ppend, `x`clusive-create, `r+`. */
const WRITE_FLAGS = /[wax+]/;

/**
 * Does this flags argument admit a write? An absent argument means Node's
 * default of `"r"`, which does not — reading a vault note is not a violation.
 */
function isWriteIntent(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "string") return WRITE_FLAGS.test(flags);
  if (typeof flags === "number") {
    const { O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_TRUNC } = fs.constants;
    return (flags & (O_WRONLY | O_RDWR | O_APPEND | O_CREAT | O_TRUNC)) !== 0;
  }
  // An unrecognised shape is treated as a write: a guard that misses a real
  // write is worse than one that reports an extra.
  return true;
}

/** Normalise every path form Node accepts — string, Buffer, `file:` URL. */
function toPath(candidate: unknown): string | null {
  if (typeof candidate === "string") return candidate.length > 0 ? candidate : null;
  if (Buffer.isBuffer(candidate)) {
    const decoded = candidate.toString();
    return decoded.length > 0 ? decoded : null;
  }
  if (candidate instanceof URL) return candidate.protocol === "file:" ? fileURLToPath(candidate) : null;
  return null;
}

export function installFsWriteGuard(vaultRoot: string): FsWriteGuard {
  const given = resolve(vaultRoot);
  // On macOS the temp dir (and often the vault itself) sits behind a symlink,
  // so a caller can address the same file through either spelling. Both count
  // as "inside the vault"; the recorded path stays the one the caller used.
  const roots = [...new Set([given, realpathSync(given)])];
  const found: FsWriteViolation[] = [];
  const restore: Array<() => void> = [];
  let released = false;

  // Some fs entry points delegate to another one that is also patched
  // (`appendFileSync` calls `writeFileSync`, for instance). Only the outermost
  // call is recorded, so a violation names the call the host actually made and
  // the count is the number of writes, not the depth of Node's own plumbing.
  let depth = 0;

  const inside = (candidate: unknown): string | null => {
    const path = toPath(candidate);
    if (path === null) return null;
    const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
    const hit = roots.some((root) => abs === root || abs.startsWith(root + sep));
    return hit ? abs : null;
  };

  const record = (call: string, path: string): void => {
    found.push({ call, path, stack: new Error(`${call} ${path}`).stack ?? "" });
  };

  const wrap = (holder: Record<string, unknown>, call: CallSpec): void => {
    const original = holder[call.name];
    if (typeof original !== "function") return;
    const patched = (...args: unknown[]): unknown => {
      const writing = call.flagsArg < 0 || isWriteIntent(args[call.flagsArg]);
      if (!released && depth === 0 && writing) {
        for (const index of call.writeArgs) {
          const target = inside(args[index]);
          // One violation per call: a rename with both ends in the vault is one
          // write by the host, not two.
          if (target !== null) {
            record(call.name, target);
            break;
          }
        }
      }
      depth += 1;
      try {
        return (original as (...a: unknown[]) => unknown).apply(holder, args);
      } finally {
        depth -= 1;
      }
    };
    holder[call.name] = patched;
    restore.push(() => {
      holder[call.name] = original;
    });
  };

  for (const call of SYNC_CALLS) {
    wrap(fs as unknown as Record<string, unknown>, call);
  }
  for (const call of PROMISE_CALLS) {
    wrap(fsPromises as unknown as Record<string, unknown>, call);
  }

  return {
    violations: () => found,
    assertClean() {
      if (found.length === 0) return;
      const detail = found.map((v) => `${v.call} ${v.path}\n${v.stack}`).join("\n\n");
      throw new Error(`host wrote ${found.length} vault path(s) directly:\n\n${detail}`);
    },
    release() {
      // `released` is checked before recording as well as here: guards released
      // out of order can leave one another's patches installed, and a released
      // guard must never grow new violations whatever is still patched.
      released = true;
      while (restore.length) restore.pop()?.();
    },
  };
}
