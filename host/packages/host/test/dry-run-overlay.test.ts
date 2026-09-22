import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Mirror } from "../src/mirror/mirror";
import { assembleShim } from "../src/testing/assemble";
import { defaultHostConfig, systemClock } from "../src/config";
import { DryRunGate } from "../src/dryrun/dry-run";
import { VaultdError } from "../src/client/errors";
import { DEFAULT_KEY_REGISTRY, PluginConfigService } from "../src/settings/plugin-config";
import { HostHarness } from "../src/testing/host-harness";
import { SchemaLadder } from "../src/settings/ladder";
import { TFile, TFolder } from "../src/shim/files";
import type { HostConfig } from "../src/config";
import type { MirrorChangeBatch } from "../src/mirror/types";
import type { RuntimeEventDto } from "../src/client/protocol";
import type { Plugin } from "../src/shim/plugin";
import {
  BINARY,
  BINARY_EXISTS,
  cleanupRealDaemons,
  scratchRoot,
  startedOn,
  waitFor,
} from "./real-daemon";

/**
 * Task 19b's dry-run overlay: create-then-use, and read-your-writes.
 *
 * `dry-run.test.ts` proves what the gate records and refuses. This file proves
 * the half that Task 19's review measured as missing: under `--dry-run` a
 * plugin that creates a note, a binary, a folder or a copy and then *uses* it
 * was told the mirror has no row for it, and one that modified and then read
 * got the bytes really on disk. Both break the promise the mode makes — the
 * plugin sees success — for the most ordinary plugin shape there is, and both
 * would have Task 20's detector verdict a working plugin `fails` for a defect
 * of the harness.
 *
 * The overlay is the gate's own structure and **nothing is written into the
 * `Mirror`**: the mirror mirrors the daemon, and a row the daemon never
 * produced would pollute the metadata cache, link resolution and the server's
 * snapshots, and would fight the next resync. So the index and the read paths
 * consult the overlay, in one precedence — removed, then overlay bytes, then
 * the mirror.
 */

/** The nine cases all run against one shape of harness. */
function dryRunHarness(vault: Record<string, string>): Promise<HostHarness> {
  return HostHarness.create({ vault, enabled: [], config: { dryRun: true } });
}

/** A scratch vault for the real-daemon case. */
function realVaultFor(files: Record<string, string>): HostConfig {
  const root = scratchRoot("vaultd-dryrun-overlay-real-");
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  for (const [path, source] of Object.entries(files)) {
    const full = join(vault, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, source, "utf8");
  }
  const index = join(root, "index.db");
  return {
    ...defaultHostConfig(vault),
    vaultdBinary: BINARY,
    vaultdArgs: ["--vault", vault, "--index", index],
    indexPath: index,
    restartBackoffMs: [50, 50],
    dryRun: true,
  };
}

afterEach(cleanupRealDaemons);

describe("the dry-run overlay", () => {
  /** 1. Create, then use what the create answered with. */
  it("reads back a created note and puts it in the tree, forwarding nothing", async () => {
    const harness = await dryRunHarness({ "A.md": "# A\n" });
    harness.clearDaemonMethodLog();

    const made = await harness.vault.create("New.md", "# New\n");
    expect(made).toBeInstanceOf(TFile);
    expect(made.path).toBe("New.md");

    expect(await harness.vault.read(made)).toBe("# New\n");
    expect(harness.vault.getFileByPath("New.md")).toBe(made);
    expect(harness.vault.getMarkdownFiles().map((file) => file.path)).toContain("New.md");
    // The binary road answers the same way.
    const bytes = new TextEncoder().encode("raw bytes");
    const binary = await harness.vault.createBinary("Pic.bin", bytes.buffer.slice(0));
    expect(Buffer.from(await harness.vault.readBinary(binary)).toString("utf8")).toBe("raw bytes");

    // Nothing was forwarded, and nothing was written into the mirror.
    for (const method of harness.daemonMethodsSeen()) {
      expect(method).not.toBe("write_note");
      expect(method).not.toBe("write_file");
    }
    expect(harness.mirror.entry("New.md")).toBeUndefined();
    expect(harness.mirror.entry("Pic.bin")).toBeUndefined();
  });

  /** 2. A synthetic folder is a folder in the tree, with its children. */
  it("hangs a created file under a created folder", async () => {
    const harness = await dryRunHarness({});
    await harness.vault.createFolder("Plain");
    await harness.vault.create("Plain/A.md", "# A\n");

    const folder = harness.vault.getAbstractFileByPath("Plain");
    expect(folder).toBeInstanceOf(TFolder);
    expect((folder as TFolder).children.map((child) => child.path)).toEqual(["Plain/A.md"]);
    expect((folder as TFolder).parent).toBe(harness.vault.getRoot());
    expect(harness.vault.getRoot().children.map((child) => child.path)).toContain("Plain");
    // Metadata stays the mirror's, and the mirror has no row: a dry run does
    // not re-parse its own bytes.
    expect(harness.app.metadataCache.getFileCache(harness.vault.getFileByPath("Plain/A.md")!))
      .toBeNull();
  });

  /** 3. Read-your-writes, and the revision a later write carries. */
  it("reads back a modified note and carries its synthetic revision forward", async () => {
    const harness = await dryRunHarness({ "A.md": "# A\n" });
    const file = harness.vault.getFileByPath("A.md")!;

    await harness.vault.modify(file, "# first\n");
    expect(await harness.vault.read(file)).toBe("# first\n");
    const answered = harness.dryRun.overlay.entry("A.md")?.revision;
    expect(typeof answered).toBe("string");

    await harness.vault.modify(file, "# second\n");
    expect(await harness.vault.read(file)).toBe("# second\n");
    expect(await harness.vault.cachedRead(file)).toBe("# second\n");
    const writes = harness.dryRun.writes();
    expect(writes).toHaveLength(2);
    expect((writes[1]?.params as { expected: { revision?: string } }).expected.revision).toBe(
      answered,
    );

    // The same rule for a note that exists only in the overlay: the create
    // answered the synthetic revision, and the modify after it must carry that
    // rather than declaring itself unconditional.
    const made = await harness.vault.create("New.md", "one\n");
    await harness.vault.modify(made, "two\n");
    expect(await harness.vault.read(made)).toBe("two\n");
    const last = harness.dryRun.writes().at(-1);
    expect((last?.params as { expected: { revision?: string } }).expected.revision).toBe(
      harness.dryRun.overlay.entry("New.md")?.revision,
    );
    expect(harness.dryRun.overlay.entry("New.md")?.revision).toBe("blake3:dry-run");

    // An append composes with itself, which is the whole "a transcript of
    // several writes to one path" complaint.
    await harness.vault.append(made, "three\n");
    expect(await harness.vault.read(made)).toBe("two\nthree\n");
  });

  /** 4. A copy reads back the source's bytes. */
  it("reads the source's bytes back off a copy's destination", async () => {
    const harness = await dryRunHarness({ "A.md": "# A\n" });
    const file = harness.vault.getFileByPath("A.md")!;

    const copy = await harness.vault.copy(file, "B.md");
    expect(copy).toBeInstanceOf(TFile);
    expect(copy.path).toBe("B.md");
    expect(await harness.vault.read(copy)).toBe("# A\n");

    // A copy of bytes the run itself wrote takes those, not the disk's.
    await harness.vault.modify(file, "# changed\n");
    const second = await harness.vault.copy(file, "C.md");
    expect(await harness.vault.read(second)).toBe("# changed\n");
  });

  /** 5. A rename takes the source away and gives the destination its bytes. */
  it("moves a note's bytes to the destination and takes the source away", async () => {
    const harness = await dryRunHarness({ "A.md": "# A\n" });
    const file = harness.vault.getFileByPath("A.md")!;

    await harness.vault.rename(file, "B.md");

    expect(harness.vault.getAbstractFileByPath("A.md")).toBeNull();
    await expect(harness.vault.read(file)).rejects.toMatchObject({
      code: "not_found",
      body: { code: "not_found", message: "A.md does not exist" },
    });

    const moved = harness.vault.getFileByPath("B.md");
    expect(moved).toBeInstanceOf(TFile);
    expect(await harness.vault.read(moved!)).toBe("# A\n");
  });

  /** 6. A delete takes the path away, and a read of it fails the ordinary way. */
  it("takes a deleted path out of the tree and refuses a read of it", async () => {
    const harness = await dryRunHarness({ "A.md": "# A\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    await harness.vault.delete(file);

    expect(harness.vault.getFileByPath("A.md")).toBeNull();
    expect(harness.vault.getMarkdownFiles().map((each) => each.path)).not.toContain("A.md");
    expect(await harness.vault.adapter.exists("A.md")).toBe(false);

    const refusal = await harness.vault.read(file).then(
      () => null,
      (error: unknown) => error,
    );

    // "The same error a missing file gives outside dry-run", measured rather
    // than asserted from memory: a second harness with no flag, whose daemon
    // says the path is gone.
    const plain = await HostHarness.create({ vault: { "A.md": "# A\n" }, enabled: [] });
    const stillThere = plain.vault.getFileByPath("A.md")!;
    plain.unserveFile("A.md");
    const real = await plain.vault.read(stillThere).then(
      () => null,
      (error: unknown) => error,
    );
    expect(real).toBeInstanceOf(VaultdError);
    expect(refusal).toBeInstanceOf(VaultdError);
    expect((refusal as VaultdError).body).toEqual((real as VaultdError).body);
    expect((refusal as VaultdError).message).toBe((real as VaultdError).message);
  });

  /** 7. A plugin's own settings round-trip inside the run. */
  it("round-trips saveData through loadData", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["saver"],
      config: { dryRun: true },
      plugins: {
        saver: (api) =>
          class extends api.Plugin {
            override onload(): void {
              /* nothing to register: the case drives the two methods itself. */
            }
          },
      },
    });
    await harness.lifecycle.start();
    const plugin = harness.app.plugins.getPlugin("saver") as Plugin;
    expect(await plugin.loadData()).toBeNull();

    await plugin.saveData({ greeting: "hello" });
    expect(await plugin.loadData()).toEqual({ greeting: "hello" });

    await plugin.saveData({ greeting: "goodbye" });
    expect(await plugin.loadData()).toEqual({ greeting: "goodbye" });

    // Still nothing on the daemon's side of the wire.
    const dataPath = `${harness.config.configDirName}/plugins/saver/data.json`;
    expect(harness.writtenFile(dataPath)).toBeUndefined();
  });

  /**
   * 8. Dry-run is **not** read isolation, and the overlay does not make it one.
   *
   * Against the real daemon, because the fact under test is the daemon's: a
   * change somebody else makes still reaches this host's mirror while the
   * overlay holds the run's own paths. A fake would agree with either belief.
   */
  it.skipIf(!BINARY_EXISTS)(
    "lets a real delta for an untouched path reach the mirror while the overlay holds others",
    async () => {
      const config = realVaultFor({ "A.md": "# A\n" });
      const supervisor = await startedOn(config);
      const mirror = await Mirror.open(() => supervisor.client(), config);
      const assembly = assembleShim({
        config,
        client: () => supervisor.client(),
        mirror,
        clock: systemClock(),
      });
      const vault = assembly.app.vault;
      mirror.onBatch((batch: MirrorChangeBatch) => {
        vault.applyBatch(batch);
      });
      const gate = assembly.writes;
      expect(gate).toBeInstanceOf(DryRunGate);
      const failures: Error[] = [];
      await supervisor.subscribe((event: RuntimeEventDto) => {
        void mirror.applyEvent(event).catch((error: unknown) => {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        });
      });

      // The run's own paths: a create and a delete, neither of which lands.
      const made = await vault.create("Made.md", "# Made\n");
      await vault.delete(vault.getFileByPath("A.md")!);
      expect(vault.getFileByPath("Made.md")).toBe(made);
      expect(vault.getFileByPath("A.md")).toBeNull();

      // Somebody else's change, to a path this run never touched.
      writeFileSync(join(config.vaultRoot, "Untouched.md"), "# Untouched\n", "utf8");
      await waitFor(
        "the mirror to learn of Untouched.md",
        () => mirror.entry("Untouched.md") !== undefined,
        () =>
          `The mirror is at generation ${String(mirror.generation())}; it holds ` +
          `${mirror.entries().map((entry) => entry.path).join(", ")}. Failures: ` +
          `${failures.map((error) => error.message).join(" | ")}.`,
      );
      expect(failures).toEqual([]);

      // The delta landed, and the overlay still holds what it held.
      expect(vault.getFileByPath("Untouched.md")).toBeInstanceOf(TFile);
      expect(vault.getFileByPath("Made.md")).toBe(made);
      expect(vault.getFileByPath("A.md")).toBeNull();
      expect(await vault.read(made)).toBe("# Made\n");
      // Nothing the run "did" is on disk: the daemon never heard of either.
      expect(mirror.entry("Made.md")).toBeUndefined();
      expect(mirror.entry("A.md")).not.toBeUndefined();
    },
    60_000,
  );

  /** 9. `clear()` forgets the overlay along with the writes. */
  it("empties the overlay on clear, and the created path is gone again", async () => {
    const harness = await dryRunHarness({ "A.md": "# A\n" });
    const file = harness.vault.getFileByPath("A.md")!;
    await harness.vault.create("New.md", "# New\n");
    await harness.vault.createFolder("Plain");
    await harness.vault.modify(file, "# changed\n");
    await harness.vault.delete(file);

    expect(harness.dryRun.overlay.has("New.md")).toBe(true);
    expect(harness.dryRun.overlay.removed("A.md")).toBe(true);

    harness.dryRun.clear();

    expect(harness.dryRun.overlay.has("New.md")).toBe(false);
    expect(harness.dryRun.overlay.contentOf("New.md")).toBeNull();
    expect(harness.dryRun.overlay.entry("New.md")).toBeNull();
    expect(harness.dryRun.overlay.removed("A.md")).toBe(false);
    expect(harness.vault.getFileByPath("New.md")).toBeNull();
    expect(harness.vault.getAbstractFileByPath("Plain")).toBeNull();
    expect(harness.vault.getRoot().children.map((child) => child.path)).not.toContain("Plain");
    // The mirror's own row is back in view, with the mirror's own bytes.
    expect(harness.vault.getFileByPath("A.md")).not.toBeNull();
    expect(await harness.vault.read(harness.vault.getFileByPath("A.md")!)).toBe("# A\n");
  });

  /** The adapter's read paths take the same overlay, on the same precedence. */
  it("answers the adapter's exists, stat and read from the overlay", async () => {
    const harness = await dryRunHarness({ "A.md": "# A\n" });
    const adapter = harness.vault.adapter;

    await adapter.write("New.md", "# New\n");
    expect(await adapter.exists("New.md")).toBe(true);
    expect(await adapter.read("New.md")).toBe("# New\n");
    expect(await adapter.stat("New.md")).toMatchObject({ type: "file", size: 6 });

    await adapter.write("A.md", "# changed\n");
    expect(await adapter.read("A.md")).toBe("# changed\n");

    await adapter.mkdir("Made");
    expect(await adapter.exists("Made")).toBe(true);
    expect(await adapter.stat("Made")).toMatchObject({ type: "folder" });

    await adapter.remove("New.md");
    expect(await adapter.exists("New.md")).toBe(false);
    expect(await adapter.stat("New.md")).toBeNull();
  });

  // --- Fix round 1 -----------------------------------------------------------

  /**
   * I5/M2. Removed beats bytes, for a path the run itself wrote.
   *
   * The brief's headline precedence had no case holding it: every fixture the
   * nine cases delete or rename away was one the run had never written, so
   * `contentOf` was `null` there and the ordering never decided anything.
   * Reordering `overlayRead` survived the whole mutation battery.
   */
  it("lets a removal beat bytes the same run recorded", async () => {
    const harness = await dryRunHarness({});
    const made = await harness.vault.create("Ghost.md", "# Ghost\n");
    expect(await harness.vault.read(made)).toBe("# Ghost\n");

    await harness.vault.delete(made);

    expect(harness.dryRun.overlay.contentOf("Ghost.md")).toBeNull();
    expect(harness.dryRun.overlay.has("Ghost.md")).toBe(false);
    expect(harness.vault.getFileByPath("Ghost.md")).toBeNull();
    expect(await harness.vault.adapter.exists("Ghost.md")).toBe(false);
    await expect(harness.vault.read(made)).rejects.toMatchObject({ code: "not_found" });
    // And the sequence keeps going: a second create at the same path wins again.
    const again = await harness.vault.create("Ghost.md", "# Back\n");
    expect(await harness.vault.read(again)).toBe("# Back\n");
  });

  /**
   * I5/M9. `graft` walks the subtree, which is its stated reason for existing.
   *
   * Case 5 renames one file, so nothing held the folder shape — the failure
   * this task exists to stop, one level down.
   */
  it("moves a renamed folder's whole subtree, and walks at the new path", async () => {
    const harness = await dryRunHarness({
      "Src/A.md": "# A\n",
      "Src/Sub/B.md": "# B\n",
    });
    const folder = harness.vault.getFolderByPath("Src")!;
    await harness.vault.rename(folder, "Dst");

    expect(harness.vault.getAbstractFileByPath("Src")).toBeNull();
    expect(harness.vault.getAbstractFileByPath("Src/Sub/B.md")).toBeNull();

    const moved = harness.vault.getFolderByPath("Dst");
    expect(moved).toBeInstanceOf(TFolder);
    expect(moved!.children.map((child) => child.path).sort()).toEqual(["Dst/A.md", "Dst/Sub"]);
    expect(harness.vault.getMarkdownFiles().map((file) => file.path).sort()).toEqual([
      "Dst/A.md",
      "Dst/Sub/B.md",
    ]);
    // The bytes are still the source's, fetched from where they really are.
    expect(await harness.vault.read(harness.vault.getFileByPath("Dst/Sub/B.md")!)).toBe("# B\n");
    expect(await harness.vault.adapter.exists("Dst/Sub/B.md")).toBe(true);
    expect(await harness.vault.adapter.exists("Src/Sub/B.md")).toBe(false);
  });

  /**
   * I5/M10. A write invents the folders above it, and `clear()` takes them away.
   *
   * The daemon makes a write's parents implicitly, so a plugin that creates
   * `Deep/Down/A.md` without a `createFolder` first is ordinary. Case 2 makes
   * its folder explicitly, so the ancestor rule was unguarded.
   */
  it("materializes the ancestors a write invents, and drops them on clear", async () => {
    const harness = await dryRunHarness({});
    const made = await harness.vault.create("Deep/Down/A.md", "# A\n");

    const deep = harness.vault.getAbstractFileByPath("Deep");
    const down = harness.vault.getAbstractFileByPath("Deep/Down");
    expect(deep).toBeInstanceOf(TFolder);
    expect(down).toBeInstanceOf(TFolder);
    expect((deep as TFolder).children.map((child) => child.path)).toEqual(["Deep/Down"]);
    expect((down as TFolder).children).toEqual([made]);
    expect(harness.vault.getRoot().children.map((child) => child.path)).toContain("Deep");

    harness.dryRun.clear();

    expect(harness.vault.getAbstractFileByPath("Deep")).toBeNull();
    expect(harness.vault.getAbstractFileByPath("Deep/Down")).toBeNull();
    expect(harness.vault.getRoot().children).toEqual([]);
  });

  /**
   * I3. A deleted file leaves its parent's `children` too.
   *
   * `TFolder.children` is a public field and walking it is the ordinary way to
   * enumerate a folder, so a node the rest of the index denies must not still
   * sit in it. The node stays in the index's own map — a later real batch looks
   * it up there to fire `delete` — which is why this is a detach and not a
   * splice out of everything.
   */
  it("takes a deleted node out of its parent's children", async () => {
    const harness = await dryRunHarness({
      "Folder/A.md": "# A\n",
      "Folder/B.md": "# B\n",
    });
    const doomed = harness.vault.getFileByPath("Folder/A.md")!;
    const folder = harness.vault.getFolderByPath("Folder")!;

    await harness.vault.delete(doomed);

    expect(folder.children.map((child) => child.path)).toEqual(["Folder/B.md"]);
    expect(harness.vault.getFileByPath("Folder/A.md")).toBeNull();
    expect(harness.vault.getMarkdownFiles().map((file) => file.path)).toEqual(["Folder/B.md"]);
    expect(await harness.vault.adapter.exists("Folder/A.md")).toBe(false);
    expect(await harness.vault.adapter.list("Folder")).toEqual({
      files: ["Folder/B.md"],
      folders: [],
    });

    // A whole folder leaves the root's children the same way, and `clear()`
    // puts back the very node a plugin was holding.
    await harness.vault.delete(folder, true);
    expect(harness.vault.getRoot().children).toEqual([]);

    harness.dryRun.clear();
    expect(harness.vault.getRoot().children).toEqual([folder]);
    expect(folder.children.map((child) => child.path).sort()).toEqual([
      "Folder/A.md",
      "Folder/B.md",
    ]);
  });

  /**
   * I2. `adapter.list` agrees with `TFolder.children` — the daily-notes shape.
   *
   * Write into a folder, then list the folder. Periodic notes, templater and
   * every scanner that walks a directory it has just populated do this, and a
   * listing that came back empty is exactly how Task 20's detector would
   * verdict a working plugin `fails` for a defect of the harness.
   */
  it("lists a folder the run has just created and written into", async () => {
    const harness = await dryRunHarness({ "Kept.md": "# Kept\n" });
    const adapter = harness.vault.adapter;

    await harness.vault.createFolder("Daily/2026-10");
    await harness.vault.create("Daily/2026-10/2026-10-01.md", "# Today\n");
    expect(await adapter.list("Daily/2026-10")).toEqual({
      files: ["Daily/2026-10/2026-10-01.md"],
      folders: [],
    });
    expect(await adapter.list("Daily")).toEqual({ files: [], folders: ["Daily/2026-10"] });

    // The adapter's own two verbs answer the same way.
    await adapter.mkdir("Made");
    await adapter.write("Made/A.md", "# A\n");
    expect(await adapter.list("Made")).toEqual({ files: ["Made/A.md"], folders: [] });

    // The mirror's rows are still listed, and a removal takes one out.
    expect(await adapter.list("/")).toEqual({
      files: ["Kept.md"],
      folders: ["Daily", "Made"],
    });
    await harness.vault.delete(harness.vault.getFileByPath("Kept.md")!);
    expect(await adapter.list("/")).toEqual({ files: [], folders: ["Daily", "Made"] });
  });

  /**
   * I4. The config directory's read half sees the plugin's own save.
   *
   * `readPluginData` is the read half of `PluginConfigService.set`'s
   * read-modify-write, so a read blind to a dry-run `saveData` merged over the
   * pre-run document and recorded a write that erased the save — a lost update
   * inside the very lock that exists to prevent one.
   */
  it("makes readPluginData and loadData agree, so a config set merges over the save", async () => {
    const harness = await HostHarness.create({
      vault: {},
      enabled: ["saver"],
      config: { dryRun: true },
      plugins: {
        saver: (api) =>
          class extends api.Plugin {
            override onload(): void {
              /* the case drives the methods itself. */
            }
          },
      },
    });
    await harness.lifecycle.start();
    const plugin = harness.app.plugins.getPlugin("saver") as Plugin;
    await plugin.saveData({ greeting: "hello" });

    expect(await harness.dir.readPluginData("saver")).toEqual({ greeting: "hello" });
    expect(await plugin.loadData()).toEqual({ greeting: "hello" });

    const service = new PluginConfigService(
      harness.dir,
      new SchemaLadder(harness.config.dataDir, harness.config.clock),
      DEFAULT_KEY_REGISTRY,
      harness.config,
    );
    await service.set("saver", { other: 1 });

    // The merged document the set recorded carries both keys: the plugin's save
    // survived rather than being written over.
    const recorded = harness.dryRun.writes().at(-1);
    const encoded = (recorded?.params as { content_base64: string }).content_base64;
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toMatchObject({
      greeting: "hello",
      other: 1,
    });
    expect(await plugin.loadData()).toMatchObject({ greeting: "hello", other: 1 });
  });

  /**
   * B1. A real row at a synthesised path wins, everywhere at once.
   *
   * The collision the whole task exists for: the detector runs a periodic-notes
   * plugin under `--dry-run` while the user's own Obsidian creates today's note.
   * Before the fix the index evicted the daemon's row on the next overlay change
   * and left it evicted, so `getFiles` denied a file `adapter.exists` affirmed.
   *
   * Real daemon, because "the daemon produced a row" is the daemon's own fact.
   */
  it.skipIf(!BINARY_EXISTS)(
    "yields a synthesised path to the daemon's real row when one arrives",
    async () => {
      const config = realVaultFor({ "A.md": "# A\n" });
      const supervisor = await startedOn(config);
      const mirror = await Mirror.open(() => supervisor.client(), config);
      const assembly = assembleShim({
        config,
        client: () => supervisor.client(),
        mirror,
        clock: systemClock(),
      });
      const vault = assembly.app.vault;
      mirror.onBatch((batch: MirrorChangeBatch) => {
        vault.applyBatch(batch);
      });
      const failures: Error[] = [];
      await supervisor.subscribe((event: RuntimeEventDto) => {
        void mirror.applyEvent(event).catch((error: unknown) => {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        });
      });

      await vault.create("Collide.md", "# mine\n");
      expect(vault.getFileByPath("Collide.md")).not.toBeNull();

      // The user's own Obsidian makes exactly the path the run is pretending to.
      writeFileSync(join(config.vaultRoot, "Collide.md"), "# theirs\n", "utf8");
      await waitFor(
        "the mirror to learn of the real Collide.md",
        () => mirror.entry("Collide.md") !== undefined,
        () =>
          `The mirror is at generation ${String(mirror.generation())}; it holds ` +
          `${mirror.entries().map((entry) => entry.path).join(", ")}. Failures: ` +
          `${failures.map((error) => error.message).join(" | ")}.`,
      );
      // One unrelated overlay write, which is what used to trigger the eviction.
      await vault.create("Unrelated.md", "# other\n");

      const real = vault.getFileByPath("Collide.md");
      expect(real).toBeInstanceOf(TFile);
      expect(vault.getAbstractFileByPath("Collide.md")).toBe(real);
      expect(vault.getFiles().map((file) => file.path)).toContain("Collide.md");
      expect(vault.getRoot().children.map((child) => child.path)).toContain("Collide.md");
      expect(await vault.adapter.exists("Collide.md")).toBe(true);
      // Every surface agrees it is the daemon's file, not the run's pretend one.
      expect(await vault.read(real!)).toBe("# theirs\n");
      expect(real!.stat.mtime).toBeGreaterThan(0);
      expect(await vault.adapter.stat("Collide.md")).toMatchObject({ type: "file", size: 9 });
      expect(await vault.adapter.read("Collide.md")).toBe("# theirs\n");
      // The run's other pretend path is untouched by any of it.
      expect(await vault.read(vault.getFileByPath("Unrelated.md")!)).toBe("# other\n");
      expect(failures).toEqual([]);
    },
    60_000,
  );
});
