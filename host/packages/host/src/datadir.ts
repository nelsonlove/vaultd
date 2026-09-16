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

  /**
   * Create a directory only this user may enter, at mode `0700`.
   *
   * **This is the layer the socket's trust model rests on.** A `0700` directory
   * is what stops another user reaching anything inside it, on every Unix,
   * because traversal requires execute permission on the directory — unlike the
   * mode on an `AF_UNIX` socket file, which Darwin and the BSDs historically
   * ignore at `connect()` time.
   *
   * The mode is passed to `mkdir` **and** applied afterwards, for the same two
   * reasons {@link DataDir.writeSecret} sets a file's mode twice: `mkdir`'s mode
   * is masked by the process umask and applies only at creation, so a directory
   * created under a permissive umask would be born wider than asked, and a
   * directory that already exists would keep whatever mode it already had.
   * Neither residual is acceptable for the directory that is doing the
   * enforcing, and the caller still `stat`s it afterwards rather than trusting
   * this to have worked.
   *
   * **A directory that is already there is left exactly as it is.** Widening it
   * back to `0700` here would be this host quietly repairing the very condition
   * it is about to refuse to start on — and the refusal is the point: a socket
   * directory somebody has opened up is a fact the operator needs to be told,
   * not one a `chmod` should paper over.
   */
  ensureSecureDir(relative: string): string {
    const full = this.resolve(relative);
    if (fs.existsSync(full)) return full;
    fs.mkdirSync(full, { recursive: true, mode: 0o700 });
    fs.chmodSync(full, 0o700);
    return full;
  }

  /** The permission bits and owner of `relative`, or `null` when it is absent. */
  ownership(relative: string): { mode: number; uid: number } | null {
    const full = this.resolve(relative);
    if (!fs.existsSync(full)) return null;
    const stats = fs.statSync(full);
    return { mode: stats.mode & 0o777, uid: stats.uid };
  }

  chmod(relative: string, mode: number): void {
    fs.chmodSync(this.resolve(relative), mode);
  }

  /** Remove `relative` if it is there. A path that is not there is not an error. */
  remove(relative: string): void {
    fs.rmSync(this.resolve(relative), { force: true });
  }

  exists(relative: string): boolean {
    return fs.existsSync(this.resolve(relative));
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
   * As {@link writeJson}, but a reader never sees a half-written document.
   *
   * `writeFileSync` truncates and then writes, so a crash, a full disk or a
   * killed process between the two leaves a **truncated** file — which for JSON
   * means an unparseable one, and for a store that is read at the next startup
   * means the values are gone and the read throws. Writing a sibling and
   * renaming it makes the swap atomic within the directory: a reader sees
   * either the whole previous document or the whole new one, never a prefix.
   *
   * The sibling is in the same directory rather than the system temp dir,
   * because `rename` is only atomic within a file system and a temp dir may be
   * on another one. It carries the process id so two hosts writing at once
   * cannot truncate each other's half-written file, and it is removed on the
   * way out of a failure so a crashed write leaves no litter.
   */
  writeJsonAtomic(relative: string, value: unknown, mode?: number): void {
    const full = this.resolve(relative);
    fs.mkdirSync(dirname(full), { recursive: true });
    const sibling = `${full}.${String(process.pid)}.tmp`;
    const body = JSON.stringify(value, null, 2) + "\n";
    try {
      if (mode === undefined) fs.writeFileSync(sibling, body, "utf8");
      else {
        fs.writeFileSync(sibling, body, { encoding: "utf8", mode });
        fs.chmodSync(sibling, mode);
      }
      fs.renameSync(sibling, full);
    } catch (error) {
      try {
        fs.rmSync(sibling, { force: true });
      } catch {
        // The cleanup is best-effort: the write already failed, and a failure
        // to remove the sibling must not replace the error that matters.
      }
      throw error;
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
