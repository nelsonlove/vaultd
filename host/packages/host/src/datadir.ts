import { dirname, isAbsolute, resolve, sep } from "node:path";

import { fs } from "./runtime/fs-access";

/**
 * The host's own state directory, and the only module under `src/` outside
 * `testing/` that writes to the file system.
 *
 * Task 22's static check exempts this module **by name**, which is what makes
 * "the host writes to exactly three places" checkable rather than aspirational:
 * the data dir is this one module, the socket directory lives inside it, and
 * everything else the host emits is `stdout`. A write anywhere else in `src/`
 * is a check failure rather than a code review someone has to notice.
 *
 * Every method calls {@link DataDir.resolve} first, and `resolve` refuses a
 * relative path that climbs out of the root. That refusal is lexical: it is
 * `path.resolve` plus a prefix test, so it stops `../`, an absolute path, and
 * anything that normalises out of the tree, and it does **not** follow
 * symlinks. A root whose parent is attacker-writable is not a threat this
 * models — the root is `$XDG_STATE_HOME/vaultd-host`, which the host owns.
 */
export class DataDir {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Throws unless `relative` resolves inside `root`. */
  resolve(relative: string): string {
    if (isAbsolute(relative)) throw new Error("datadir escape: " + relative);
    const full = resolve(this.root, relative);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error("datadir escape: " + relative);
    }
    return full;
  }

  /** Create the directory named by `relative`, and every parent of it. */
  ensure(relative: string): void {
    fs.mkdirSync(this.resolve(relative), { recursive: true });
  }

  writeJson(relative: string, value: unknown, mode?: number): void {
    const full = this.resolve(relative);
    fs.mkdirSync(dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(value, null, 2) + "\n", "utf8");
    // Set separately rather than through the write's `mode` option, which is
    // applied only when the file is created — a rewrite of an existing file
    // would silently keep whatever mode it already had.
    if (mode !== undefined) fs.chmodSync(full, mode);
  }

  /**
   * The parsed contents, or `null` when the file is not there.
   *
   * Absent is `null`; **malformed throws**. A plugin's `data.json` that someone
   * hand-edited into invalid JSON is a thing to report, not a thing to silently
   * replace with defaults — that would eat the user's settings.
   */
  readJson<T>(relative: string): T | null {
    const full = this.resolve(relative);
    if (!fs.existsSync(full)) return null;
    return JSON.parse(fs.readFileSync(full, "utf8")) as T;
  }

  appendLine(relative: string, line: string): void {
    const full = this.resolve(relative);
    fs.mkdirSync(dirname(full), { recursive: true });
    fs.appendFileSync(full, line + "\n", "utf8");
  }

  /**
   * Write a file only this user may read, at mode `0600` — the host's
   * connection nonce is the one in tree.
   *
   * The mode is applied after the write for the same reason `writeJson`'s is:
   * a file that already existed keeps its old mode otherwise, so a nonce
   * rewritten into a world-readable file would stay world-readable.
   */
  writeSecret(relative: string, contents: string): void {
    const full = this.resolve(relative);
    fs.mkdirSync(dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
    fs.chmodSync(full, 0o600);
  }
}
