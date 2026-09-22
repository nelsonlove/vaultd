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

/**
 * Files that spawn a real daemon, and must not race each other.
 *
 * The golden conformance suite is in the list by **directory** rather than by
 * filename suffix, which is Task 22's one change here. Every file under
 * `test/golden/` drives a `LiveHost` — a real `vaultd` child, a real host, a
 * real community bundle — so each one is a real-daemon file whatever it is
 * called, and the brief names them `golden.test.ts`, `tag-wrangler.test.ts` and
 * `quickadd.test.ts`. Left in the parallel project they would spawn daemons
 * beside thirty other files, which is the exact condition this split exists to
 * prevent.
 */
const REAL_DAEMON = [
  "packages/*/test/**/*-real-daemon.test.ts",
  "packages/*/test/golden/**/*.test.ts",
];

const shared = {
  environment: "node" as const,
  // **One `afterAll` per test file, removing that file's scratch directories.**
  // A setup file rather than a hook copied into each file that takes one: the
  // 17,533 abandoned directories the final review counted were entirely call
  // sites that forgot to register, so the sweep has to be something a case
  // cannot forget. See `packages/host/test/scratch.ts`.
  setupFiles: ["packages/host/test/scratch-setup.ts"],
  // Each test file gets its own process: the fs guard patches process-wide
  // module namespaces, so files must never share a worker with each other.
  pool: "forks" as const,
  isolate: true,
  // The `src/testing/pending/` exclusion is gone: the five shim-wrapping
  // harnesses and the shim assembler were written in Task 6b and activated one
  // file at a time by their first consumers — `assemble.ts` and
  // `shim-harness.ts` in Task 7, `pluginset-harness.ts` in Task 14,
  // `host-harness.ts` in Task 15, `settings-harness.ts` in Task 17, and
  // `live-host.ts` in Task 22 — and with the last of them moved up the
  // directory no longer exists.
  exclude: [...configDefaults.exclude],
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
