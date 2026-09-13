import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The host compiles to CommonJS, so `import.meta` is not the accessor the
// emitted JS has. `__dirname` is, and Vitest provides it to transformed
// modules as well, so the same line works in both places.
const workspaceRoot = resolve(__dirname, "..", "..", "..");

/**
 * `npm ls --all --json` walks the whole installed tree, and on a loaded machine
 * that is slower than vitest's five-second default by a wide margin — measured
 * at 9.4 s wall for 0.88 s of user CPU (13 % CPU, pure contention) while the
 * Rust suite was running in the same worktree. A shell-out to another package
 * manager is not a five-second operation, and a timeout here reports "test
 * failed" for what is actually "the machine is busy", which is the same
 * least-useful sentence `FIXTURE_TIMEOUT_MS` exists to avoid in the harness
 * self-test. The assertion is unchanged; only the budget is.
 */
const NPM_LS_TIMEOUT_MS = 120_000;

describe("dependency tree", () => {
  it("contains no real electron package", () => {
    const tree = execFileSync("npm", ["ls", "--all", "--json"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(tree) as { dependencies?: Record<string, { version?: string }> };
    // No `?? "0.0.0-headless"` fallback: that would also pass if `electron`
    // vanished from the tree entirely, so the assertion would go quiet instead
    // of red the day the workspace layout stopped linking the stub.
    expect(parsed.dependencies?.["electron"]?.version).toBe("0.0.0-headless");
    expect(tree).not.toContain("electron.zip");
  }, NPM_LS_TIMEOUT_MS);

  it("declares electron nowhere in any package.json dependency block", () => {
    for (const pkg of ["package.json", "packages/host/package.json", "packages/obsidian/package.json"]) {
      const manifest = JSON.parse(
        execFileSync("cat", [resolve(workspaceRoot, pkg)], { encoding: "utf8" }),
      ) as Record<string, Record<string, string> | undefined>;
      for (const block of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        expect(Object.keys(manifest[block] ?? {}), `${pkg}.${block}`).not.toContain("electron");
      }
    }
  });
});
