import { configDefaults, defineConfig } from "vitest/config";

/**
 * Two projects, because two kinds of test file have different physics.
 *
 * **`real-daemon` files each spawn a real `vaultd`.** Seven of them do, and one
 * — `mirror-fuzz-real-daemon` — drives three hundred random mutations through a
 * live daemon and compares the incremental mirror against a fresh hydration.
 * Run alongside thirty other files on a loaded machine it diverges (measured:
 * nine divergences, then three, on two default-parallelism runs; every serial,
 * isolated and daemon-only run passed). A suite whose green depends on how busy
 * the machine is is not a gate, so those files get a project of their own with
 * `fileParallelism` off: one daemon at a time, however many cores are free.
 *
 * Everything else stays parallel, which is where the wall-clock comes from.
 *
 * The shared options are repeated in both projects rather than inherited,
 * because a project config is a config: `pool` and `isolate` are what keep the
 * fs guard's process-wide patches from leaking between files, and a project
 * that silently dropped them would be a different kind of flake.
 */

/** Files that spawn a real daemon, and must not race each other. */
const REAL_DAEMON = ["packages/*/test/**/*-real-daemon.test.ts"];

const shared = {
  environment: "node" as const,
  // Each test file gets its own process: the fs guard patches process-wide
  // module namespaces, so files must never share a worker with each other.
  pool: "forks" as const,
  isolate: true,
  // The five shim-wrapping harnesses and the shim assembler are written in
  // Task 6b and activated one file at a time by their first consumers —
  // `assemble.ts` and `shim-harness.ts` in Task 7, `pluginset-harness.ts` in
  // Task 14, `host-harness.ts` in Task 15, `settings-harness.ts` in Task 17,
  // and `live-host.ts` in Task 22 — each moved up one directory in that
  // task's Step 1. Until then they name modules that do not exist yet, so
  // nothing may load them.
  exclude: [...configDefaults.exclude, "**/src/testing/pending/**"],
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "host",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: [...shared.exclude, ...REAL_DAEMON],
        },
      },
      {
        test: {
          ...shared,
          name: "real-daemon",
          include: REAL_DAEMON,
          // One at a time. See the note at the top of this file.
          fileParallelism: false,
        },
      },
    ],
  },
});
