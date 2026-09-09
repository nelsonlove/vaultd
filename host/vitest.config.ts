import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    // Each test file gets its own process: the fs guard patches process-wide
    // module namespaces, so files must never share a worker with each other.
    pool: "forks",
    isolate: true,
  },
});
