/**
 * `HeadlessConfigDir`: the host's own copy of Obsidian's configuration layout.
 *
 * Every case here is a wire assertion rather than a state assertion, because
 * the whole point of this module is *which bytes go where*. The directory is
 * Obsidian's own shape byte for byte — a `community-plugins.json` holding a
 * JSON array of enabled ids, and a `plugins/<id>/` folder holding
 * `manifest.json`, `main.js` and `data.json` — so a future install flow is the
 * same operation aimed at a different directory, and a human diffing the two
 * directories sees no gratuitous difference.
 */

import { describe, expect, it } from "vitest";

import { HeadlessConfigDir, ManifestIdMismatch } from "../src/pluginset/config-dir";
import { HostErrors } from "../src/shim/errors";
import { DaemonHarness } from "../src/testing/daemon-harness";
import { PluginSetHarness } from "../src/testing/pluginset-harness";
import type { HostErrorEntry } from "../src/shim/errors";

/** A directory with a collector on its error seam, so a report can be asserted. */
function withErrorSeam(harness: DaemonHarness): {
  dir: HeadlessConfigDir;
  reported: HostErrorEntry[];
} {
  const errors = new HostErrors();
  const reported: HostErrorEntry[] = [];
  errors.onError((error, pluginId, phase) => reported.push({ error, pluginId, phase }));
  return { dir: new HeadlessConfigDir(harness.client, harness.config, errors), reported };
}

describe("HeadlessConfigDir", () => {
  it("creates the two folders idempotently", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const pending = dir.ensure();
    const first = await harness.nextRequest();
    expect(first.request).toEqual({
      method: "create_folder",
      params: { path: ".obsidian-headless" },
    });
    harness.respondOk(first.id, "create_folder", { generation: 1 });
    const second = await harness.nextRequest();
    expect(second.request).toEqual({
      method: "create_folder",
      params: { path: ".obsidian-headless/plugins" },
    });
    harness.respondOk(second.id, "create_folder", { generation: 1 });
    await pending;
  });

  it("reads and writes community-plugins.json as an ordinary JSON array", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const reading = dir.readEnabledSet();
    const read = await harness.nextRequest();
    expect(read.request).toEqual({
      method: "read_file",
      params: { path: ".obsidian-headless/community-plugins.json" },
    });
    harness.respondReadFile(read.id, JSON.stringify(["folder-notes", "quickadd"]), "blake3:c1");
    await expect(reading).resolves.toEqual(["folder-notes", "quickadd"]);

    const writing = dir.writeEnabledSet(["folder-notes"]);
    const write = await harness.nextRequest();
    const body = Buffer.from(
      (write.request.params as { content_base64: string }).content_base64,
      "base64",
    ).toString("utf8");
    expect(JSON.parse(body)).toEqual(["folder-notes"]);
    harness.respondOk(write.id, "write_file", { revision: "blake3:c2", semantic: false });
    await writing;
  });

  it("returns an empty enabled set when the file does not exist yet", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const reading = dir.readEnabledSet();
    const read = await harness.nextRequest();
    harness.respondErr(read.id, { code: "not_found", message: "no such file" });
    await expect(reading).resolves.toEqual([]);
  });

  it("falls back to Obsidian's copy for a config file the host dir lacks", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const reading = dir.readConfigJson<{ trashOption: string }>("app.json");
    const headless = await harness.nextRequest();
    expect(headless.request).toEqual({
      method: "read_file",
      params: { path: ".obsidian-headless/app.json" },
    });
    harness.respondErr(headless.id, { code: "not_found", message: "no such file" });
    const gui = await harness.nextRequest();
    expect(gui.request).toEqual({ method: "read_file", params: { path: ".obsidian/app.json" } });
    harness.respondReadFile(gui.id, JSON.stringify({ trashOption: "local" }), "blake3:a1");
    await expect(reading).resolves.toEqual({ trashOption: "local" });
  });

  /**
   * A **file** sitting on the directory's name is `target_exists`, and the
   * daemon answers the *second* create with it too — so swallowing the code,
   * as the brief instructed, would make both calls look like success and send
   * the host on to write into a directory that cannot exist. An existing
   * *folder* is plain success and needs no swallowing at all.
   */
  it("surfaces a target_exists out of ensure rather than swallowing it", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const pending = dir.ensure();
    const first = await harness.nextRequest();
    harness.respondErr(first.id, {
      code: "target_exists",
      message: ".obsidian-headless is a file",
    });
    await expect(pending).rejects.toMatchObject({ code: "target_exists" });
    // And it stopped there: no second create was sent against a name it already
    // knows it cannot use.
    await harness.quiesce();
    expect(harness.pendingRequests()).toEqual([]);
  });

  /**
   * `not_found` is the only code that means "there is no file there". A
   * `zone_violation`, a `payload_too_large`, a `target_exists` from a read (the
   * daemon's code for "this path is a directory") each mean something is wrong
   * that a caller wants to hear about; folding them into an empty answer is how
   * a host reports an empty plugin set on a broken vault.
   */
  it("lets an error that is not not_found through", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const reading = dir.readEnabledSet();
    const read = await harness.nextRequest();
    harness.respondErr(read.id, { code: "zone_violation", message: "refused" });
    await expect(reading).rejects.toMatchObject({ code: "zone_violation" });
  });

  /**
   * A damaged enabled set degrades to `[]` **and says so**, once.
   *
   * It cannot throw: this read runs on the 60 s coexistence poll, and a throw
   * there takes the poll down and leaves the host blind rather than merely
   * empty. It cannot be silent either — that is the "quietly disabled every
   * plugin the user had enabled" failure the doc comment argues against. And it
   * reports once per spell of damage rather than once per read, because the
   * poll would otherwise report the same broken file 1,440 times a day.
   */
  it("reports a corrupt enabled set once and answers empty", async () => {
    const harness = DaemonHarness.create();
    const { dir, reported } = withErrorSeam(harness);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reading = dir.readEnabledSet();
      const read = await harness.nextRequest();
      harness.respondReadFile(read.id, '{"not": "an array"}', "blake3:c9");
      await expect(reading).resolves.toEqual([]);
    }
    expect(reported.map((entry) => [entry.pluginId, entry.phase])).toEqual([["host", "config"]]);
    expect(String((reported[0] as HostErrorEntry).error)).toContain("must be a JSON array");
  });

  /** A manifest whose id is not its folder is a typed refusal, not a preference. */
  it("refuses a manifest whose id disagrees with its folder", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const reading = dir.readManifest("folder-notes");
    const read = await harness.nextRequest();
    expect(read.request).toEqual({
      method: "read_file",
      params: { path: ".obsidian-headless/plugins/folder-notes/manifest.json" },
    });
    harness.respondReadFile(
      read.id,
      JSON.stringify({ id: "folder-notes-fork", name: "N", version: "1", minAppVersion: "1" }),
      "blake3:m1",
    );
    await expect(reading).rejects.toBeInstanceOf(ManifestIdMismatch);
    await reading.catch((error: ManifestIdMismatch) => {
      expect(error.code).toBe("manifest_id_mismatch");
      expect(error.pluginId).toBe("folder-notes");
      expect(error.declaredId).toBe("folder-notes-fork");
    });
  });

  /**
   * `listInstalled` reads the directory, not the enabled set.
   *
   * The whole point of the switch: a plugin that is **installed but disabled**
   * is on disk and absent from `community-plugins.json`, and before `read_dir`
   * it was invisible to this host. The wire shape is asserted here — one
   * `read_dir` of `<configDir>/plugins`, then one `read_file` per folder entry —
   * against the fake; the real daemon proves the same sequence in
   * `config-dir-real-daemon.test.ts`.
   */
  it("lists the plugins directory and reads a manifest per folder", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const listing = dir.listInstalled();
    const read = await harness.nextRequest();
    expect(read.request).toEqual({
      method: "read_dir",
      params: { path: ".obsidian-headless/plugins" },
    });
    harness.respondReadDir(read.id, ".obsidian-headless/plugins", [
      // A file beside the folders, and a folder with no manifest: both are
      // ordinary leftovers, and neither is an installed plugin.
      { name: "stale.json", kind: "file", size: 42 },
      { name: "quickadd", kind: "folder" },
      { name: "folder-notes", kind: "folder" },
      { name: "empty", kind: "folder" },
    ]);
    // Byte order, which the daemon promises and the harness honours.
    const first = await harness.nextRequest();
    expect((first.request.params as { path: string }).path).toBe(
      ".obsidian-headless/plugins/empty/manifest.json",
    );
    harness.respondErr(first.id, { code: "not_found", message: "no manifest" });
    const second = await harness.nextRequest();
    expect((second.request.params as { path: string }).path).toBe(
      ".obsidian-headless/plugins/folder-notes/manifest.json",
    );
    harness.respondReadFile(
      second.id,
      JSON.stringify({
        id: "folder-notes",
        name: "Folder notes",
        version: "1.7.0",
        minAppVersion: "1.5.0",
      }),
      "blake3:m1",
    );
    const third = await harness.nextRequest();
    expect((third.request.params as { path: string }).path).toBe(
      ".obsidian-headless/plugins/quickadd/manifest.json",
    );
    harness.respondReadFile(
      third.id,
      JSON.stringify({ id: "quickadd", name: "QuickAdd", version: "1.0", minAppVersion: "1.0" }),
      "blake3:m2",
    );
    const installed = await listing;
    expect(installed.map((plugin) => plugin.id)).toEqual(["folder-notes", "quickadd"]);
    expect(installed[0]?.dir).toBe(".obsidian-headless/plugins/folder-notes");
    expect(installed[0]?.manifest.dir).toBe(".obsidian-headless/plugins/folder-notes");
    // No read of `community-plugins.json` anywhere: the enabled set is a
    // different question, and this method no longer asks it.
    expect(harness.methodsSeen()).toEqual(["read_dir", "read_file", "read_file", "read_file"]);
  });

  /** A vault this host has never run in has no plugins directory. Not an error. */
  it("answers empty when the plugins directory is not there", async () => {
    const harness = DaemonHarness.create();
    const dir = new HeadlessConfigDir(harness.client, harness.config);
    const listing = dir.listInstalled();
    const read = await harness.nextRequest();
    harness.respondErr(read.id, { code: "not_found", message: "no such directory" });
    await expect(listing).resolves.toEqual([]);
  });

  /**
   * A symlinked plugin folder is skipped **and reported**.
   *
   * The daemon classifies from `lstat`, so a link to a directory arrives as
   * `symlink` rather than `folder` and this host does not follow it. Reported
   * rather than silently dropped because the person most likely to have made
   * one is a plugin developer linking a repository checkout into the vault, and
   * "my plugin does not load and nothing said why" is the worst possible answer
   * for them.
   */
  it("does not follow a symlinked plugin folder, and says so once", async () => {
    const harness = DaemonHarness.create();
    const { dir, reported } = withErrorSeam(harness);
    const listing = dir.listInstalled();
    const read = await harness.nextRequest();
    harness.respondReadDir(read.id, ".obsidian-headless/plugins", [
      { name: "linked-plugin", kind: "symlink" },
    ]);
    await expect(listing).resolves.toEqual([]);
    expect(reported.map((entry) => [entry.pluginId, entry.phase])).toEqual([["host", "config"]]);
    expect(String((reported[0] as HostErrorEntry).error)).toContain("linked-plugin");
  });

  /**
   * `dataPath` and `Plugin.saveData` name the same file.
   *
   * Asserted against the bytes a real `saveData` puts on the wire rather than
   * against a second copy of the literal, because the claim is that the two
   * agree — and two literals in two files agree right up until someone changes
   * one of them. They share {@link pluginDataPath} now; this is what holds them
   * to it.
   */
  it("names the same data.json a plugin's saveData writes", async () => {
    const harness = await PluginSetHarness.create({ hostEnabled: [], guiEnabled: [] });
    expect(harness.dir.dataPath("demo")).toBe(".obsidian-headless/plugins/demo/data.json");
    const plugin = harness.instantiate("demo", class extends harness.api.Plugin {});
    const saving = plugin.saveData({ enabled: true });
    const sent = await harness.expectRequest("write_file");
    expect((sent.request.params as { path: string }).path).toBe(harness.dir.dataPath("demo"));
    harness.respondOk(sent.id, "write_file", { revision: "blake3:d1", semantic: false });
    await saving;
    await harness.stop();
  });
});
