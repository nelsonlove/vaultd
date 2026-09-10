/**
 * The harness family's own test.
 *
 * Every task from here on drives its subject through one of these harnesses, so
 * a harness that lies is a suite that lies — quietly, in the same direction, in
 * every file at once. This exercises the four pieces that have no shim
 * dependency (the clock, the data dir, the daemon and mirror harnesses, and the
 * fixture vault) so Task 6b can go green on its own, before `src/shim/` exists.
 *
 * The five shim-wrapping harnesses under `src/testing/pending/` are deliberately
 * not exercised here: they cannot compile until their first consumer's task
 * builds the shim surface they wrap, which is why they are excluded from both
 * `tsconfig.json` and `vitest.config.ts`.
 */

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DataDir } from "../src/datadir";
import { testClock } from "../src/testing/clock";
import { DaemonHarness } from "../src/testing/daemon-harness";
import { FixtureVault, parseFixtureRow } from "../src/testing/fixture-vault";
import { MirrorHarness } from "../src/testing/mirror-harness";

describe("TestClock", () => {
  it("fires timers in due order and advances now()", async () => {
    const clock = testClock(1000);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("late"), 50);
    clock.setTimeout(() => fired.push("early"), 10);
    expect(fired).toEqual([]);
    await clock.advance(20);
    expect(fired).toEqual(["early"]);
    expect(clock.now()).toBe(1020);
    await clock.advance(40);
    expect(fired).toEqual(["early", "late"]);
    expect(clock.now()).toBe(1060);
    expect(clock.armed()).toBe(0);
  });

  it("re-arms an interval and stops when cleared", async () => {
    const clock = testClock();
    let ticks = 0;
    const handle = clock.setInterval(() => {
      ticks += 1;
    }, 100);
    await clock.advance(350);
    expect(ticks).toBe(3);
    clock.clearInterval(handle);
    await clock.advance(1000);
    expect(ticks).toBe(3);
    expect(clock.armed()).toBe(0);
  });

  it("never leaks a cleared timeout", async () => {
    const clock = testClock();
    const handle = clock.setTimeout(() => {
      throw new Error("must not fire");
    }, 10);
    clock.clearTimeout(handle);
    await clock.advance(100);
    expect(clock.armed()).toBe(0);
  });
});

describe("DaemonHarness", () => {
  it("correlates a request and answers it", async () => {
    const harness = DaemonHarness.create();
    const pending = harness.client.request<{ status: string }>("health");
    const sent = await harness.nextRequest();
    expect(sent.request.method).toBe("health");
    harness.respondOk(sent.id, "health", { service: "vaultd", status: "ok" });
    await expect(pending).resolves.toEqual({ service: "vaultd", status: "ok" });
    expect(harness.methodsSeen()).toEqual(["health"]);
    await harness.stop();
  });

  it("base64-encodes read_file answers the way the daemon does", async () => {
    const harness = DaemonHarness.create();
    const pending = harness.client.request<{ content_base64: string; revision: string }>(
      "read_file",
      { path: ".obsidian/app.json" },
    );
    const sent = await harness.nextRequest();
    harness.respondReadFile(sent.id, '{"trashOption":"local"}', "blake3:a1");
    const answer = await pending;
    expect(Buffer.from(answer.content_base64, "base64").toString("utf8")).toBe(
      '{"trashOption":"local"}',
    );
    expect(answer.revision).toBe("blake3:a1");
    await harness.stop();
  });
});

describe("MirrorHarness", () => {
  it("hydrates a mirror from a spec and answers a refetch", async () => {
    const harness = await MirrorHarness.hydrated({
      generation: 5,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    expect(harness.mirror.generation()).toBe(5);
    expect(harness.mirror.entry("A.md")?.kind).toBe("note");
    const applying = harness.mirror.applyMutation(6, ["A.md"]);
    await harness.answerRefetch(6, [{ path: "A.md", revision: "blake3:a2" }]);
    await applying;
    expect(harness.mirror.note("A.md")?.revision).toBe("blake3:a2");
    await harness.stop();
  });
});

describe("FixtureVault and the real parser", () => {
  it("parses fixture markdown with vaultd's own parser", () => {
    const row = parseFixtureRow("A.md", "---\ntags: [alpha]\n---\n# Title\n\n[[B]]\n");
    expect(row.path).toBe("A.md");
    expect(row.headings.map((heading) => heading.text)).toEqual(["Title"]);
    expect(row.outgoing.map((reference) => reference.raw_target)).toEqual(["B"]);
    expect(row.tags.map((tag) => tag.value)).toEqual(["alpha"]);
    // Structural extraction must be present, or the pre-task did not land and
    // the parity fixtures would silently compare empty arrays.
    expect(row.sections.length).toBeGreaterThan(0);
  });

  it("resolves links across the vault it was given", () => {
    const vault = new FixtureVault({ "A.md": "[[B]]\n", "B.md": "# B\n" });
    const a = vault.notes().find((note) => note.path === "A.md");
    expect(a?.outgoing?.map((reference) => reference.resolution)).toEqual([
      { kind: "resolved", target: "B.md", subpath: null },
    ]);
  });

  it("synthesizes folders into the entry tree", () => {
    const vault = new FixtureVault({ "Folder/Sub/A.md": "x\n", "B.md": "y\n" });
    expect(
      vault
        .entries()
        .map((entry) => `${entry.kind}:${entry.path}`)
        .sort(),
    ).toEqual(["folder:Folder", "folder:Folder/Sub", "note:B.md", "note:Folder/Sub/A.md"]);
  });

  it("bumps a revision on write and serves the new source", () => {
    const vault = new FixtureVault({ "A.md": "one\n" });
    const before = vault.revisionOf("A.md");
    vault.write("A.md", "two\n");
    expect(vault.source("A.md")).toBe("two\n");
    expect(vault.revisionOf("A.md")).not.toBe(before);
  });
});

describe("DataDir", () => {
  it("refuses a path that escapes its root", () => {
    const dir = new DataDir(mkdtempSync(join(tmpdir(), "vaultd-dd-")));
    expect(() => dir.resolve("../escape.json")).toThrow(/datadir escape/);
    expect(() => {
      dir.writeJson("../escape.json", {});
    }).toThrow(/datadir escape/);
  });

  it("writes a secret at mode 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "vaultd-dd-"));
    const dir = new DataDir(root);
    dir.writeSecret("nonce", "abcd");
    expect(readFileSync(join(root, "nonce"), "utf8")).toBe("abcd");
    expect(statSync(join(root, "nonce")).mode & 0o777).toBe(0o600);
  });

  it("round-trips JSON and answers null for a file that is not there", () => {
    const dir = new DataDir(mkdtempSync(join(tmpdir(), "vaultd-dd-")));
    expect(dir.readJson("plugins/demo/data.json")).toBeNull();
    dir.writeJson("plugins/demo/data.json", { ok: true });
    expect(dir.readJson<{ ok: boolean }>("plugins/demo/data.json")).toEqual({ ok: true });
    dir.appendLine("log.ndjson", '{"n":1}');
    dir.appendLine("log.ndjson", '{"n":2}');
    expect(readFileSync(join(dir.root, "log.ndjson"), "utf8")).toBe('{"n":1}\n{"n":2}\n');
  });
});
