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

import { HeadlessConfigDir } from "../src/pluginset/config-dir";
import { DaemonHarness } from "../src/testing/daemon-harness";

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
});
