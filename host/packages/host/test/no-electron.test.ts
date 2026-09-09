import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The host compiles to CommonJS, so `import.meta` is not the accessor the
// emitted JS has. `__dirname` is, and Vitest provides it to transformed
// modules as well, so the same line works in both places.
const workspaceRoot = resolve(__dirname, "..", "..", "..");

describe("dependency tree", () => {
  it("contains no real electron package", () => {
    const tree = execFileSync("npm", ["ls", "--all", "--json"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(tree) as { dependencies?: Record<string, { version?: string }> };
    const electron = parsed.dependencies?.["electron"];
    expect(electron?.version ?? "0.0.0-headless").toBe("0.0.0-headless");
    expect(tree).not.toContain("electron.zip");
  });

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
