import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installFsWriteGuard } from "../src/testing/fs-guard";

// The host and every plugin bundle it loads are CommonJS: they reach the file
// system through `require("node:fs")`, which is the door the guard watches.
// These tests therefore call fs the same way the guarded code does. A bare
// `import { writeFileSync } from "node:fs"` would NOT be seen: Node freezes the
// ESM namespace of a builtin and never re-syncs it from the CJS exports, so no
// in-process patch can reach a caller that imported the function by name. That
// blind spot is covered statically instead (no `src/` file outside `testing/`
// may import an fs write function by name).
const hostRequire = createRequire(resolve(process.cwd(), "fs-guard.test.anchor.js"));
const fs = hostRequire("node:fs") as typeof import("node:fs");

describe("installFsWriteGuard", () => {
  it("records a synchronous write inside the vault root", () => {
    const root = mkdtempSync(join(tmpdir(), "vaultd-guard-"));
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
    const root = mkdtempSync(join(tmpdir(), "vaultd-guard-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "vaultd-other-"));
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
    const root = mkdtempSync(join(tmpdir(), "vaultd-guard-"));
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
    const root = mkdtempSync(join(tmpdir(), "vaultd-guard-"));
    const guard = installFsWriteGuard(root);
    guard.release();
    fs.writeFileSync(join(root, "After.md"), "not watched\n");
    expect(guard.violations()).toHaveLength(0);
  });
});
