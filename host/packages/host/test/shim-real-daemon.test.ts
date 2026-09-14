import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Mirror } from "../src/mirror/mirror";
import { defaultHostConfig, systemClock } from "../src/config";
import { assembleShim } from "../src/testing/assemble";
import type { HostConfig } from "../src/config";
import type { MirrorChangeBatch } from "../src/mirror/types";
import type { App } from "../src/shim/app";
import type { TFile } from "../src/shim/files";
import type { Vault } from "../src/shim/vault";
import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot, startedOn } from "./real-daemon";

/**
 * The shim's write paths against the **real** `vaultd`.
 *
 * `shim-vault.test.ts` proves what the shim sends, against a fake that accepts
 * whatever this host believes. Three things cannot be proved that way, because
 * every one of them is a fact about the shipped daemon rather than about this
 * host's intent:
 *
 * 1. **A folder rename moves a subtree the change set never names.** The wire
 *    answer is one generation and one pair of paths; every descendant lands at
 *    a new path that nothing tells the host about. A shim that refetched only
 *    the two named paths reported the vault as having lost every file in that
 *    folder — silently, permanently, with no error and no event. That was a
 *    shipped bug found in review, and a fake daemon agreed with it.
 * 2. **`write_file` refuses a Markdown note.** The daemon answers
 *    `invalid_request: … is a Markdown note; write it with write_note so it
 *    joins a generation`. Obsidian's `adapter.write("Note.md", …)` succeeds, so
 *    the adapter has to route by zone and extension.
 * 3. **`create_folder` inside the config zone answers no generation**, because
 *    nothing there is indexed. That is a success a plugin host depends on: it
 *    is how `<configDir>/plugins/<id>/` comes to exist.
 *
 * The binary is a Rust build artifact and is not in the repository; its absence
 * fails `client-real-daemon.test.ts` loudly and merely skips here. Build it with
 * `cargo build --release --bin vaultd`.
 */

function vaultFor(files: Record<string, string>): HostConfig {
  const root = scratchRoot("vaultd-shim-real-");
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
  };
}

/**
 * A shim over a real engine, with every batch replayed into the file index.
 *
 * The replay is what Task 15's sequencer will do. Doing it here is how a case
 * can assert that the tree a plugin sees after a mutation is the tree the vault
 * actually holds — which is the half of the folder-rename bug that lived in the
 * shim rather than in the mirror.
 */
async function shimOn(config: HostConfig): Promise<{ app: App; vault: Vault; mirror: Mirror }> {
  const supervisor = await startedOn(config);
  const mirror = await Mirror.open(() => supervisor.client(), config);
  const assembly = assembleShim({
    config,
    client: supervisor.client(),
    mirror,
    clock: systemClock(),
  });
  const vault = assembly.app.vault;
  mirror.onBatch((batch: MirrorChangeBatch) => {
    vault.applyBatch(batch);
  });
  return { app: assembly.app, vault, mirror };
}

afterEach(cleanupRealDaemons);

describe.skipIf(!BINARY_EXISTS)("the shim against a real vaultd", () => {
  it("keeps a renamed folder's whole subtree, in the mirror and in the tree", async () => {
    const config = vaultFor({
      "A.md": "# A\n",
      "Folder/Nested.md": "# Nested\n",
      "Folder/Other.md": "# Other\n",
      "Folder/pic.png": "not really a png\n",
      "Folder/Sub/Deep.md": "# Deep\n",
    });
    const { vault, mirror } = await shimOn(config);
    expect(mirror.entries().map((entry) => entry.path).sort()).toEqual([
      "A.md",
      "Folder",
      "Folder/Nested.md",
      "Folder/Other.md",
      "Folder/Sub",
      "Folder/Sub/Deep.md",
      "Folder/pic.png",
    ]);

    const folder = vault.getFolderByPath("Folder");
    expect(folder).not.toBeNull();
    await vault.rename(folder!, "Folder2");

    // Every row, at its new path — the four the wire never named included.
    expect(mirror.entries().map((entry) => entry.path).sort()).toEqual([
      "A.md",
      "Folder2",
      "Folder2/Nested.md",
      "Folder2/Other.md",
      "Folder2/Sub",
      "Folder2/Sub/Deep.md",
      "Folder2/pic.png",
    ]);
    expect(vault.getFiles().map((file) => file.path).sort()).toEqual([
      "A.md",
      "Folder2/Nested.md",
      "Folder2/Other.md",
      "Folder2/Sub/Deep.md",
      "Folder2/pic.png",
    ]);
    expect(vault.getAllFolders().map((f) => f.path).sort()).toEqual(["Folder2", "Folder2/Sub"]);
  });

  it("deletes a folder without leaving its descendants behind", async () => {
    const config = vaultFor({ "A.md": "# A\n", "Folder/Nested.md": "# Nested\n" });
    const { vault, mirror } = await shimOn(config);
    await vault.delete(vault.getFolderByPath("Folder")!, true);
    expect(mirror.entries().map((entry) => entry.path).sort()).toEqual(["A.md"]);
    expect(vault.getFiles().map((file) => file.path)).toEqual(["A.md"]);
  });

  it("moves a folder with contents through the adapter, readable at the new paths", async () => {
    const config = vaultFor({
      "Keep.md": "# Keep\n",
      "Outer/Top.md": "# Top\n",
      "Outer/pic.png": "not really a png\n",
      "Outer/Mid/Deep.md": "# Deep\n",
    });
    const { vault, mirror } = await shimOn(config);
    await vault.adapter.rename("Outer", "Renamed");

    expect(mirror.entries().map((entry) => entry.path).sort()).toEqual([
      "Keep.md",
      "Renamed",
      "Renamed/Mid",
      "Renamed/Mid/Deep.md",
      "Renamed/Top.md",
      "Renamed/pic.png",
    ]);
    // Present in the mirror is not the same claim as readable: every descendant
    // answers through the adapter at its new path.
    expect(await vault.adapter.read("Renamed/Top.md")).toBe("# Top\n");
    expect(await vault.adapter.read("Renamed/Mid/Deep.md")).toBe("# Deep\n");
    expect((await vault.adapter.readBinary("Renamed/pic.png")).byteLength).toBe(17);
    expect(vault.getFiles().map((file) => file.path).sort()).toEqual([
      "Keep.md",
      "Renamed/Mid/Deep.md",
      "Renamed/Top.md",
      "Renamed/pic.png",
    ]);
  });

  it("routes an adapter write of a note to write_note and of a zone file to write_file", async () => {
    const config = vaultFor({ "A.md": "# A\n" });
    const { vault, mirror } = await shimOn(config);

    // The shape the daemon refuses for a note is `write_file`; this must not
    // raise `invalid_request`, and the note must join a generation.
    await vault.adapter.write("AdapterNote.md", "# Adapter\n");
    expect(mirror.entry("AdapterNote.md")?.kind).toBe("note");
    expect(await vault.adapter.read("AdapterNote.md")).toBe("# Adapter\n");

    await vault.adapter.append("AdapterNote.md", "more\n");
    expect(await vault.adapter.read("AdapterNote.md")).toBe("# Adapter\nmore\n");

    // A config-zone file is not a note however it is spelled, and nothing
    // there joins a generation.
    await vault.createFolder(config.configDirName);
    const zonePath = `${config.configDirName}/notes.md`;
    await vault.adapter.write(zonePath, "{}\n");
    expect(await vault.adapter.read(zonePath)).toBe("{}\n");
    expect(mirror.entry(zonePath)).toBeUndefined();
  });

  it("creates a plugin folder inside the config zone, where no generation exists", async () => {
    const config = vaultFor({ "A.md": "# A\n" });
    const { vault } = await shimOn(config);
    const folder = await vault.createFolder(`${config.configDirName}/plugins/sample`);
    expect(folder.path).toBe(`${config.configDirName}/plugins/sample`);
    expect(folder.isRoot()).toBe(false);
    // The folder is real: a file written into it lands and reads back. There is
    // no `exists` assertion here on purpose — nothing in the zone is indexed,
    // and the daemon has no stat op, so a folder outside the index is a thing
    // this host can create and cannot see.
    await vault.adapter.write(`${config.configDirName}/plugins/sample/data.json`, "{}\n");
    expect(await vault.adapter.read(`${config.configDirName}/plugins/sample/data.json`)).toBe(
      "{}\n",
    );
  });

  it("writes Markdown links the daemon's own parser resolves, subpath and all", async () => {
    // A fake daemon agrees with whatever spelling this host invents, so the one
    // thing it cannot check is the thing that matters: does vaultd read the
    // link back? `encodeURI` alone leaves `#` and a space untouched, which made
    // `[Solo](Solo.md#My Heading)` unresolved and `[Hash #1](Hash %231.md)` not
    // a link at all.
    const config = vaultFor({
      "Solo.md": "# My Heading\n\ntext ^blockid\n",
      "Hash #1.md": "body\n",
      "Note.md": "placeholder\n",
      ".obsidian/app.json": '{"useMarkdownLinks":true}\n',
    });
    const { app, vault, mirror } = await shimOn(config);
    await vault.configReady();
    const solo = vault.getFileByPath("Solo.md") as TFile;
    const hash = vault.getFileByPath("Hash #1.md") as TFile;
    const links = [
      app.fileManager.generateMarkdownLink(solo, "Note.md", "#My Heading"),
      app.fileManager.generateMarkdownLink(solo, "Note.md", "#^blockid"),
      app.fileManager.generateMarkdownLink(hash, "Note.md"),
    ];
    expect(links).toEqual([
      "[Solo](Solo.md#My%20Heading)",
      "[Solo](Solo.md#^blockid)",
      "[Hash #1](Hash%20%231.md)",
    ]);

    // Write them into a note and ask the daemon what it made of them.
    await vault.modify(vault.getFileByPath("Note.md") as TFile, `${links.join("\n\n")}\n`);
    const outgoing = mirror.note("Note.md")?.outgoing ?? [];
    expect(
      outgoing.map((reference) => ({
        target: reference.resolution.kind === "resolved" ? reference.resolution.target : null,
        subpath: reference.subpath,
      })),
    ).toEqual([
      { target: "Solo.md", subpath: { kind: "heading", value: "My Heading" } },
      { target: "Solo.md", subpath: { kind: "block", value: "blockid" } },
      { target: "Hash #1.md", subpath: null },
    ]);
  });

  /**
   * The two patch shapes that need the daemon's additive wire forms.
   *
   * Both are **written now and skipped until the release binary carries them**:
   * the array `key_path` (so a key whose name contains a dot is addressable at
   * all) and `set_null` (so `fm.key = null` writes a YAML null instead of
   * deleting). Against the current build every `patch_frontmatter` this shim
   * sends is refused `invalid_request` at decode — loud, and incapable of
   * corrupting a note, which is the property that made shipping the array form
   * first the safe order. Unskip this block, and flip
   * `DOTTED_KEYS_ADDRESSABLE` in `shim/file-manager.ts`, together.
   */
  describe.skip("patching frontmatter through the additive wire forms", () => {
    it("addresses a key whose name contains a dot, and deletes and adds one", async () => {
      const config = vaultFor({
        "A.md": "---\nmy.key: dotted\nplain: kept\n---\nbody\n",
      });
      const { app, vault, mirror } = await shimOn(config);
      const file = vault.getFileByPath("A.md") as TFile;

      await app.fileManager.processFrontMatter(file, (fm) => {
        expect(fm["my.key"]).toBe("dotted");
        fm["my.key"] = "changed";
      });
      expect(mirror.note("A.md")?.properties.map((p) => p.key)).toEqual(["my.key", "plain"]);
      expect(await vault.adapter.read("A.md")).toBe(
        "---\nmy.key: changed\nplain: kept\n---\nbody\n",
      );

      await app.fileManager.processFrontMatter(file, (fm) => {
        fm["other.key"] = "added";
      });
      expect(await vault.adapter.read("A.md")).toBe(
        "---\nmy.key: changed\nplain: kept\nother.key: added\n---\nbody\n",
      );

      await app.fileManager.processFrontMatter(file, (fm) => {
        delete fm["my.key"];
      });
      // Gone, and nothing phantom left behind: the old dotted spelling created
      // a `my:` mapping and left the real key exactly where it was.
      expect(await vault.adapter.read("A.md")).toBe(
        "---\nplain: kept\nother.key: added\n---\nbody\n",
      );
    });

    it("writes a YAML null with set_null and removes the key with value null", async () => {
      const config = vaultFor({ "A.md": "---\ntitle: Old\nkeep: yes\n---\nbody\n" });
      const { app, vault } = await shimOn(config);
      const file = vault.getFileByPath("A.md") as TFile;
      await app.fileManager.processFrontMatter(file, (fm) => {
        fm["title"] = null;
        delete fm["keep"];
      });
      expect(await vault.adapter.read("A.md")).toBe("---\ntitle: null\n---\nbody\n");
    });
  });

  it("answers getConfig from .obsidian/app.json when the host directory has none", async () => {
    const config = vaultFor({
      "A.md": "# A\n",
      ".obsidian/app.json": '{"attachmentFolderPath":"Attachments","trashOption":"local"}\n',
    });
    const { vault } = await shimOn(config);
    await vault.configReady();
    expect(vault.getConfig("attachmentFolderPath")).toBe("Attachments");
    expect(vault.getConfig("trashOption")).toBe("local");
    expect(vault.getConfig("nothingIsHere")).toBeUndefined();
  });
});
