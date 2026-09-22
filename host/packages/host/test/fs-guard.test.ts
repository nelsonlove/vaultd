import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { fs, fsPromises } from "../src/runtime/fs-access";
import { installFsWriteGuard } from "../src/testing/fs-guard";
import { scratchRoot } from "./scratch";

// The guard watches the CommonJS door: `require("node:fs")`, which is what the
// compiled host and every esbuild-CJS plugin bundle use. These tests reach fs
// through `src/runtime/fs-access.ts` — the host's one fs seam — so they exercise
// exactly the door host code uses. A bare `import { writeFileSync } from
// "node:fs"` would not be seen: Node snapshots the ESM namespace of a builtin
// when it is first instantiated, and no later in-process patch can reach a
// caller holding one of those bindings. Under Vitest that snapshot is taken
// before any test code runs, which is why `fs-seam.test.ts` exists.

// **Both under `target/tmp`, and `outside` is still genuinely outside.** What
// the guard decides is "inside this vault root or not", and two sibling
// `mkdtemp` directories answer that exactly as two directories in the OS tmpdir
// did — neither is a prefix of the other. What changes is that they are
// registered for cleanup: these two call sites alone leaked 14,258 directories.
const vault = (): string => scratchRoot("vaultd-guard-");
const outside = (): string => scratchRoot("vaultd-other-");

describe("installFsWriteGuard", () => {
  it("records a synchronous write inside the vault root", () => {
    const root = vault();
    const guard = installFsWriteGuard(root);
    try {
      fs.writeFileSync(join(root, "Note.md"), "# leaked\n");
    } finally {
      guard.release();
    }
    const violations = guard.violations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.call).toBe("writeFileSync");
    expect(violations[0]?.path).toBe(join(root, "Note.md"));
    expect(violations[0]?.stack).toContain("fs-guard.test.ts");
  });

  it("ignores writes outside the vault root", () => {
    const root = vault();
    const elsewhere = outside();
    const guard = installFsWriteGuard(root);
    try {
      fs.writeFileSync(join(elsewhere, "state.json"), "{}");
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(0);
    expect(() => guard.assertClean()).not.toThrow();
  });

  it("assertClean names the call and the path it caught", () => {
    const root = vault();
    const guard = installFsWriteGuard(root);
    try {
      fs.appendFileSync(join(root, "Log.md"), "leaked\n");
    } finally {
      guard.release();
    }
    expect(() => guard.assertClean()).toThrow(/host wrote 1 vault path\(s\) directly/);
    expect(() => guard.assertClean()).toThrow(join(root, "Log.md"));
  });

  it("stops recording once released", () => {
    const root = vault();
    const guard = installFsWriteGuard(root);
    guard.release();
    fs.writeFileSync(join(root, "After.md"), "not watched\n");
    expect(guard.violations()).toHaveLength(0);
  });
});

describe("read intent is not write intent", () => {
  it("ignores an openSync with no flags, which defaults to read-only", () => {
    const root = vault();
    const note = join(root, "Read.md");
    fs.writeFileSync(note, "before the guard\n");
    const guard = installFsWriteGuard(root);
    try {
      // @types/node insists on a flags argument; Node itself defaults it to
      // "r", which is precisely the case under test. The cast is read at call
      // time, so it still goes through the patched property.
      const openWithoutFlags = fs.openSync as unknown as (path: string) => number;
      fs.closeSync(openWithoutFlags(note));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(0);
  });

  it("ignores an openSync with a numeric O_RDONLY flag", () => {
    const root = vault();
    const note = join(root, "Read.md");
    fs.writeFileSync(note, "before the guard\n");
    const guard = installFsWriteGuard(root);
    try {
      fs.closeSync(fs.openSync(note, fs.constants.O_RDONLY));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(0);
  });

  it("ignores a promise open with no flags", async () => {
    const root = vault();
    const note = join(root, "Read.md");
    fs.writeFileSync(note, "before the guard\n");
    const guard = installFsWriteGuard(root);
    try {
      const handle = await fsPromises.open(note);
      await handle.close();
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(0);
  });

  it("records an openSync with a write flag", () => {
    const root = vault();
    const guard = installFsWriteGuard(root);
    try {
      fs.closeSync(fs.openSync(join(root, "Written.md"), "w"));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.call).toBe("openSync");
    expect(guard.violations()[0]?.path).toBe(join(root, "Written.md"));
  });

  it("records an openSync with numeric write flags", () => {
    const root = vault();
    const guard = installFsWriteGuard(root);
    try {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT;
      fs.closeSync(fs.openSync(join(root, "Numeric.md"), flags));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.call).toBe("openSync");
  });

  it("records a read-write flag, because it can write", () => {
    const root = vault();
    const note = join(root, "Plus.md");
    fs.writeFileSync(note, "before the guard\n");
    const guard = installFsWriteGuard(root);
    try {
      fs.closeSync(fs.openSync(note, "r+"));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
  });
});

describe("destination arguments are watched too", () => {
  it("records a copy whose destination is inside the vault", () => {
    const root = vault();
    const elsewhere = outside();
    const source = join(elsewhere, "Source.md");
    fs.writeFileSync(source, "from outside\n");
    const guard = installFsWriteGuard(root);
    try {
      fs.copyFileSync(source, join(root, "Copied.md"));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.call).toBe("copyFileSync");
    expect(guard.violations()[0]?.path).toBe(join(root, "Copied.md"));
  });

  it("ignores a copy that only reads the vault", () => {
    const root = vault();
    const elsewhere = outside();
    const source = join(root, "Source.md");
    fs.writeFileSync(source, "inside the vault\n");
    const guard = installFsWriteGuard(root);
    try {
      fs.copyFileSync(source, join(elsewhere, "Copied.md"));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(0);
  });

  it("records a rename whose destination is inside the vault", () => {
    const root = vault();
    const elsewhere = outside();
    const source = join(elsewhere, "Source.md");
    fs.writeFileSync(source, "from outside\n");
    const guard = installFsWriteGuard(root);
    try {
      fs.renameSync(source, join(root, "Moved.md"));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.call).toBe("renameSync");
    expect(guard.violations()[0]?.path).toBe(join(root, "Moved.md"));
  });

  it("records a temp directory created inside the vault", () => {
    const root = vault();
    const guard = installFsWriteGuard(root);
    let made = "";
    try {
      made = fs.mkdtempSync(join(root, "scratch-"));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.call).toBe("mkdtempSync");
    // The argument is a prefix, not the created directory; the guard records
    // what the caller passed, and the directory it made starts with it.
    expect(guard.violations()[0]?.path).toBe(join(root, "scratch-"));
    expect(made.startsWith(join(root, "scratch-"))).toBe(true);
  });

  it("records a promise temp directory created inside the vault", async () => {
    const root = vault();
    const guard = installFsWriteGuard(root);
    try {
      await fsPromises.mkdtemp(join(root, "scratch-"));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.call).toBe("mkdtemp");
  });

  it("ignores a temp directory created outside the vault", () => {
    const root = vault();
    const elsewhere = outside();
    const guard = installFsWriteGuard(root);
    try {
      fs.mkdtempSync(join(elsewhere, "scratch-"));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(0);
  });

  it("records a rename whose source is inside the vault", () => {
    const root = vault();
    const elsewhere = outside();
    const source = join(root, "Source.md");
    fs.writeFileSync(source, "inside the vault\n");
    const guard = installFsWriteGuard(root);
    try {
      fs.renameSync(source, join(elsewhere, "Moved.md"));
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.path).toBe(source);
  });
});

describe("every path form is normalised before the containment test", () => {
  it("records a Buffer path", () => {
    const root = vault();
    const target = join(root, "Buffered.md");
    const guard = installFsWriteGuard(root);
    try {
      fs.writeFileSync(Buffer.from(target), "leaked\n");
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.path).toBe(target);
  });

  it("records a file URL path", () => {
    const root = vault();
    const target = join(root, "Urled.md");
    const guard = installFsWriteGuard(root);
    try {
      fs.writeFileSync(pathToFileURL(target), "leaked\n");
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.path).toBe(target);
  });

  it("records a relative path that resolves into the vault", () => {
    const root = vault();
    const guard = installFsWriteGuard(root);
    const previous = process.cwd();
    let expected = "";
    try {
      process.chdir(root);
      // macOS resolves the symlinked temp dir on chdir, so cwd is the realpath
      // spelling of the root. Both spellings are inside the vault; the recorded
      // path is the one the call actually resolved to.
      expected = resolve(process.cwd(), "Relative.md");
      fs.writeFileSync("Relative.md", "leaked\n");
    } finally {
      process.chdir(previous);
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.path).toBe(expected);
    expect(guard.violations()[0]?.path.endsWith(`${sep}Relative.md`)).toBe(true);
  });
});

describe("the fs/promises half of the guard", () => {
  it("records a promise write inside the vault root", async () => {
    const root = vault();
    const guard = installFsWriteGuard(root);
    try {
      await fsPromises.writeFile(join(root, "Note.md"), "# leaked\n");
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(1);
    expect(guard.violations()[0]?.call).toBe("writeFile");
    expect(guard.violations()[0]?.path).toBe(join(root, "Note.md"));
  });

  it("ignores a promise write outside the vault root", async () => {
    const root = vault();
    const elsewhere = outside();
    const guard = installFsWriteGuard(root);
    try {
      await fsPromises.writeFile(join(elsewhere, "state.json"), "{}");
    } finally {
      guard.release();
    }
    expect(guard.violations()).toHaveLength(0);
  });

  it("records mkdir, rename, copyFile, open and rm", async () => {
    const root = vault();
    const elsewhere = outside();
    const source = join(elsewhere, "Source.md");
    await fsPromises.writeFile(source, "from outside\n");
    const doomed = join(root, "Doomed.md");
    fs.writeFileSync(doomed, "gone soon\n");

    const guard = installFsWriteGuard(root);
    try {
      await fsPromises.mkdir(join(root, "Folder"));
      await fsPromises.copyFile(source, join(root, "Copied.md"));
      await fsPromises.rename(join(root, "Copied.md"), join(root, "Renamed.md"));
      const handle = await fsPromises.open(join(root, "Opened.md"), "w");
      await handle.close();
      await fsPromises.rm(doomed);
    } finally {
      guard.release();
    }
    expect(guard.violations().map((v) => v.call)).toEqual([
      "mkdir",
      "copyFile",
      "rename",
      "open",
      "rm",
    ]);
    expect(guard.violations()[1]?.path).toBe(join(root, "Copied.md"));
  });
});
