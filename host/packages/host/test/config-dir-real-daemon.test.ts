import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HeadlessConfigDir } from "../src/pluginset/config-dir";
import { HostErrors } from "../src/shim/errors";
import { defaultHostConfig } from "../src/config";
import type { HostConfig } from "../src/config";
import type { HostErrorEntry } from "../src/shim/errors";
import type { VaultdClient } from "../src/client/client";
import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot, startedOn } from "./real-daemon";

/**
 * A directory with a collector on its error seam.
 *
 * Without one the default `HostErrors` reports to its stderr floor, which in a
 * suite run is an unattributed `[vaultd-host] … failed during config` line that
 * reads like a failure — and a fact this file went to the trouble of creating
 * goes unasserted.
 */
function withErrorSeam(
  client: VaultdClient,
  config: HostConfig,
): { dir: HeadlessConfigDir; reported: HostErrorEntry[] } {
  const errors = new HostErrors();
  const reported: HostErrorEntry[] = [];
  errors.onError((error, pluginId, phase) => reported.push({ error, pluginId, phase }));
  return { dir: new HeadlessConfigDir(client, config, errors), reported };
}

/**
 * The headless config directory against the **real** `vaultd`.
 *
 * `config-dir.test.ts` proves what this host does with a listing, against a
 * fake that answers whatever it is told to. Three things cannot be proved that
 * way, because they are facts about the shipped daemon rather than about this
 * host:
 *
 * 1. **A hidden directory can be listed at all.** This is the whole reason the
 *    method changed. The tree index excludes every hidden *directory* by design,
 *    so `get_tree_entries` and both snapshot pagers can never report
 *    `.obsidian-headless/plugins/`; before `read_dir` a client that had not been
 *    told a plugin's folder name had no way to find one, and `listInstalled`
 *    could only enumerate the enabled set. A fake would have agreed with either
 *    belief.
 * 2. **An installed-but-disabled plugin is now visible.** The case below writes
 *    two plugin folders and enables one. The count the daemon's listing yields
 *    is two; the old implementation's answer was one, and no fake could have
 *    told the difference.
 * 3. **`symlink` is a kind of its own, from `lstat`.** A link to a directory is
 *    reported as `symlink` and not as `folder`, which is what makes "do not
 *    follow" a decision this host can act on rather than one it cannot see.
 *
 * The binary is a Rust build artifact and is not in the repository. Its absence
 * fails `client-real-daemon.test.ts` loudly — that file carries the
 * unconditional assertion and the deliberate `VAULTD_ALLOW_MISSING_BINARY=1`
 * opt-out — and merely skips here, so the loud failure is stated once. Build it
 * with `cargo build --release --bin vaultd`.
 */

/**
 * A scratch vault with a headless config directory already populated.
 *
 * Written with the file system directly rather than through the daemon, because
 * this case is about *reading* a directory that exists: routing the setup
 * through `create_folder` and `write_file` would prove those verbs again and
 * make the subject's own reads harder to see in the request log.
 */
function vaultWithPlugins(): HostConfig {
  const root = scratchRoot("vaultd-configdir-real-");
  const vault = join(root, "vault");
  const plugins = join(vault, ".obsidian-headless", "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(vault, "Note.md"), "# Note\n", "utf8");

  const shipped: ReadonlyArray<readonly [string, string]> = [
    ["folder-notes", "1.7.0"],
    ["quickadd", "1.11.3"],
  ];
  for (const [id, version] of shipped) {
    mkdirSync(join(plugins, id), { recursive: true });
    writeFileSync(
      join(plugins, id, "manifest.json"),
      JSON.stringify({
        id,
        name: id,
        version,
        minAppVersion: "1.5.0",
        description: `the ${id} plugin`,
        author: "someone",
      }),
      "utf8",
    );
    writeFileSync(join(plugins, id, "main.js"), `module.exports = ${JSON.stringify(id)};\n`, "utf8");
  }

  // **Only one of the two is enabled.** The other is the case's whole point.
  writeFileSync(
    join(vault, ".obsidian-headless", "community-plugins.json"),
    `${JSON.stringify(["folder-notes"], null, 2)}\n`,
    "utf8",
  );

  // A folder with no manifest, a stray file, and a symlink to a real plugin
  // folder: three shapes a real vault grows and none of them an installed
  // plugin this host will run.
  mkdirSync(join(plugins, "leftover"), { recursive: true });
  writeFileSync(join(plugins, "stale.json"), "{}", "utf8");
  symlinkSync(join(plugins, "quickadd"), join(plugins, "linked-quickadd"), "dir");

  const index = join(root, "index.db");
  return {
    ...defaultHostConfig(vault),
    vaultdBinary: BINARY,
    vaultdArgs: ["--vault", vault, "--index", index],
    indexPath: index,
    restartBackoffMs: [50, 50],
  };
}

afterEach(cleanupRealDaemons);

describe.skipIf(!BINARY_EXISTS)("HeadlessConfigDir against a real vaultd", () => {
  it("lists a plugin that is installed but not enabled", async () => {
    const config = vaultWithPlugins();
    const supervisor = await startedOn(config);
    const { dir, reported } = withErrorSeam(supervisor.client(), config);

    // The enabled set names one plugin. The directory holds two.
    await expect(dir.readEnabledSet()).resolves.toEqual(["folder-notes"]);

    const installed = await dir.listInstalled();
    expect(installed.map((plugin) => plugin.id)).toEqual(["folder-notes", "quickadd"]);
    expect(installed.map((plugin) => plugin.manifest.version)).toEqual(["1.7.0", "1.11.3"]);
    expect(installed.map((plugin) => plugin.dir)).toEqual([
      ".obsidian-headless/plugins/folder-notes",
      ".obsidian-headless/plugins/quickadd",
    ]);

    // The manifest a plugin's constructor receives carries its own folder.
    expect(installed[0]?.manifest.dir).toBe(".obsidian-headless/plugins/folder-notes");
    // And the bundle beside it is readable through the same directory.
    await expect(dir.readBundleSource("quickadd")).resolves.toContain("quickadd");

    // The fixture's symlink, asserted rather than merely created. The daemon
    // classifies it from its own `lstat`, so it arrives as `symlink` and is
    // never taken for a folder — which is what makes "do not follow" a decision
    // this host can act on. Passing a sink also keeps the report out of the
    // suite's output: without one it lands on `HostErrors`' stderr floor, where
    // it reads as an unattributed failure in every full-suite run.
    expect(reported.map((entry) => [entry.pluginId, entry.phase])).toEqual([
      ["linked-quickadd", "config"],
    ]);
    // Twice is still once: the same spell of trouble.
    await dir.listInstalled();
    expect(reported).toHaveLength(1);
  });

  /**
   * A **file** where the plugins directory should be is a broken vault, and it
   * says so rather than answering "no plugins installed".
   *
   * `target_exists` is the daemon's code for "this path is not a directory", the
   * mirror of the one `read_file` answers for a path that is not a regular file.
   * Degrading it to `[]` would report an empty plugin set for a vault that
   * cannot hold plugins at all.
   */
  it("refuses a listing when a file sits where the plugins directory belongs", async () => {
    const root = scratchRoot("vaultd-configdir-file-");
    const vault = join(root, "vault");
    mkdirSync(join(vault, ".obsidian-headless"), { recursive: true });
    writeFileSync(join(vault, "Note.md"), "# Note\n", "utf8");
    writeFileSync(join(vault, ".obsidian-headless", "plugins"), "not a directory\n", "utf8");
    const index = join(root, "index.db");
    const config: HostConfig = {
      ...defaultHostConfig(vault),
      vaultdBinary: BINARY,
      vaultdArgs: ["--vault", vault, "--index", index],
      indexPath: index,
      restartBackoffMs: [50, 50],
    };
    const supervisor = await startedOn(config);
    const dir = new HeadlessConfigDir(supervisor.client(), config);
    await expect(dir.listInstalled()).rejects.toMatchObject({ code: "target_exists" });
  });

  it("ensures its two folders, idempotently, against the real verb", async () => {
    const config = vaultWithPlugins();
    const supervisor = await startedOn(config);
    const dir = new HeadlessConfigDir(supervisor.client(), config);
    // Both folders are already there, which is the interesting arm: a folder
    // that exists is plain success rather than `target_exists`, so `ensure()`
    // needs no exists-check and swallows nothing.
    await expect(dir.ensure()).resolves.toBeUndefined();
    await expect(dir.ensure()).resolves.toBeUndefined();
  });

  it("answers an empty list for a vault with no headless directory", async () => {
    const root = scratchRoot("vaultd-configdir-empty-");
    const vault = join(root, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "Note.md"), "# Note\n", "utf8");
    const index = join(root, "index.db");
    const config: HostConfig = {
      ...defaultHostConfig(vault),
      vaultdBinary: BINARY,
      vaultdArgs: ["--vault", vault, "--index", index],
      indexPath: index,
      restartBackoffMs: [50, 50],
    };
    const supervisor = await startedOn(config);
    const dir = new HeadlessConfigDir(supervisor.client(), config);
    // `not_found` on the directory, not a throw: a vault this host has never run
    // in is an ordinary vault.
    await expect(dir.listInstalled()).resolves.toEqual([]);
    await expect(dir.readEnabledSet()).resolves.toEqual([]);
  });
});
