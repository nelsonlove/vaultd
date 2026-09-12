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
    const body = JSON.stringify(value, null, 2) + "\n";
    // Both, and both are load-bearing. The `mode` option applies only when the
    // file is *created*, so on its own it would leave a rewrite of an existing
    // file at whatever mode that file already had. `chmod` on its own would
    // create the file at `0666 & ~umask` first and narrow it one syscall
    // later, which is a window in which the bytes are readable by anyone.
    if (mode === undefined) fs.writeFileSync(full, body, "utf8");
    else {
      fs.writeFileSync(full, body, { encoding: "utf8", mode });
      fs.chmodSync(full, mode);
    }
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

  /**
   * The file's bytes as text, or `null` when it is not there.
   *
   * {@link writeSecret}'s counterpart. A secret is written verbatim — the
   * host's connection nonce is raw hex, not a JSON document — so reading one
   * back through {@link readJson} would `JSON.parse` it and throw. Task 21's
   * watchdog reads the nonce through this.
   */
  readText(relative: string): string | null {
    const full = this.resolve(relative);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf8");
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
   * The mode is set twice, on purpose, because the two halves close different
   * holes. The write's own `mode` applies at **creation**, so the file is never
   * observable at `0666 & ~umask`, not even for the one syscall between the
   * write and a later `chmod` — and a secret readable for one syscall is a
   * secret. The `chmod` then covers the **rewrite**: `mode` is ignored for a
   * file that already exists, so a nonce written over a `0644` file left by
   * anything else would otherwise stay world-readable.
   */
  writeSecret(relative: string, contents: string): void {
    const full = this.resolve(relative);
    fs.mkdirSync(dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(full, 0o600);
  }
}
