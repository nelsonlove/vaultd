import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    // The five shim-wrapping harnesses and the shim assembler are written in
    // Task 6b and activated one file at a time by their first consumers —
    // `assemble.ts` and `shim-harness.ts` in Task 7, `pluginset-harness.ts` in
    // Task 14, `host-harness.ts` in Task 15, `settings-harness.ts` in Task 17,
    // and `live-host.ts` in Task 22 — each moved up one directory in that
    // task's Step 1. Until then they name modules that do not exist yet, so
    // nothing may load them.
    exclude: [...configDefaults.exclude, "**/src/testing/pending/**"],
    // Each test file gets its own process: the fs guard patches process-wide
    // module namespaces, so files must never share a worker with each other.
    pool: "forks",
    isolate: true,
  },
});
