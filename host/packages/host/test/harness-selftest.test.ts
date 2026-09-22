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

import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DataDir } from "../src/datadir";
import { testClock } from "../src/testing/clock";
import { DaemonHarness } from "../src/testing/daemon-harness";
import {
  FixtureVault,
  cacheKey,
  fixtureCacheDir,
  fixtureGeneratorSpawns,
  overrideFixtureCacheDir,
  overrideFixtureParserStamp,
  parseFixtureRow,
} from "../src/testing/fixture-vault";
import { MirrorHarness } from "../src/testing/mirror-harness";
import { SCRATCH_BASE, scratchRoot } from "./scratch";

/**
 * Every case that can reach the fixture generator gets this instead of vitest's
 * five seconds.
 *
 * A cache miss shells out to `cargo run`, and a `cargo run` whose `target/` is
 * cold links the daemon first — minutes, not seconds, and measured at 231 s on
 * this machine after a toolchain switch invalidated the debug profile. The
 * five-second default turns that into a test failure that says "timed out"
 * rather than "your build is cold", which is the least useful sentence
 * available. A warm cache answers these in single-digit milliseconds.
 */
const FIXTURE_TIMEOUT_MS = 600_000;

/** The host package root — `src/`, `test/`, and `worker/` all sit under this. */
const PKG_ROOT = resolve(__dirname, "..");

/** The whole host source tree, `pending/` included. */
const SRC_ROOT = resolve(PKG_ROOT, "src");

/** This test tree itself — the NUL guard below now walks it too. */
const TEST_ROOT = resolve(PKG_ROOT, "test");

/** The worker bundle, when the package has one. */
const WORKER_ROOT = resolve(PKG_ROOT, "worker");

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

  it("fires two timers due inside one advance in due order, not registration order", async () => {
    // The case above never exercises the comparator: each `advance` admits one
    // candidate, so a clock that fired in registration order would pass it.
    // This one arms in reverse due order and lets both come due at once, which
    // is the only shape that can tell the two orderings apart.
    const clock = testClock(1000);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("late"), 50);
    clock.setTimeout(() => fired.push("early"), 10);
    await clock.advance(100);
    expect(fired).toEqual(["early", "late"]);
    expect(clock.now()).toBe(1100);
    expect(clock.armed()).toBe(0);
  });

  it("advances now() to each timer's due time as it fires it", async () => {
    // The callback reads the clock, so an implementation that fired everything
    // and then jumped to the target would be caught: a timer must observe the
    // moment it was due, not the end of the window.
    const clock = testClock(1000);
    const seen: number[] = [];
    clock.setTimeout(() => seen.push(clock.now()), 50);
    clock.setTimeout(() => seen.push(clock.now()), 10);
    await clock.advance(100);
    expect(seen).toEqual([1010, 1050]);
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

  it("serves a file, then reports it absent once it is unserved", async () => {
    // `autoServeFiles` merges, so it can never take a path away — and "the file
    // is not there" is a state the config-zone tests need: Obsidian having no
    // `community-plugins.json` is a different claim from Obsidian having one
    // that enables nothing.
    const harness = DaemonHarness.create();
    harness.autoServeFiles({ ".obsidian/community-plugins.json": '["dataview"]' });

    const served = harness.client.request<{ content_base64: string }>("read_file", {
      path: ".obsidian/community-plugins.json",
    });
    await expect(served).resolves.toMatchObject({
      content_base64: Buffer.from('["dataview"]', "utf8").toString("base64"),
    });

    harness.unserveFile(".obsidian/community-plugins.json");
    // Answered, not forgotten: a path left unanswered would hang the subject
    // rather than tell it the file is gone.
    await expect(
      harness.client.request("read_file", { path: ".obsidian/community-plugins.json" }),
    ).rejects.toMatchObject({ code: "not_found" });

    // And it can come back, because a file can.
    harness.autoServeFiles({ ".obsidian/community-plugins.json": "[]" });
    const again = await harness.client.request<{ content_base64: string }>("read_file", {
      path: ".obsidian/community-plugins.json",
    });
    expect(Buffer.from(again.content_base64, "base64").toString("utf8")).toBe("[]");
    await harness.stop();
  });

  it("installs one read_file hook however many times files are registered", async () => {
    // The first call passed nothing, which under the old "is the map empty"
    // guard left the hook uninstalled and let the second call add a second one.
    const harness = DaemonHarness.create();
    harness.autoServeFiles({});
    harness.autoServeFiles({ "a.md": "one" });
    harness.autoServeFiles({ "b.md": "two" });

    const first = await harness.client.request<{ content_base64: string }>("read_file", {
      path: "a.md",
    });
    expect(Buffer.from(first.content_base64, "base64").toString("utf8")).toBe("one");
    // A duplicate hook would answer the same request twice, and the second
    // answer would arrive for an id the client has already settled.
    await harness.quiesce();
    expect(harness.pendingRequests()).toEqual([]);
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

  it("serves a read_file at the mirror's own revision, so a warm-up warms", async () => {
    const harness = await MirrorHarness.hydrated({
      generation: 1,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    harness.autoServeFiles({ "A.md": "# Title\n" });
    // `Mirror.warmOne` skips a note whose read comes back at a revision it did
    // not expect, so an auto server answering its own stand-in hash would warm
    // nothing — which is exactly what it did until Task 8 needed an index.
    expect((await harness.mirror.warmPositions()).warmed).toBe(1);
    expect(harness.mirror.positions("A.md")).toBeDefined();
    await harness.stop();
  });

  it("skips a note whose bytes have moved past its row", async () => {
    const harness = await MirrorHarness.hydrated({
      generation: 1,
      entries: [{ path: "A.md", kind: "note", revision: "blake3:a1" }],
      notes: [{ path: "A.md", revision: "blake3:a1" }],
    });
    harness.autoServeFiles({ "A.md": "# Title\n" });
    // The production guard: an index built from newer bytes than the row would
    // put every span in the note slightly wrong, silently. Nothing in the suite
    // could reach it through the auto-served path once the harness started
    // answering the row's own revision, so the harness can force a mismatch.
    harness.forceServedRevision("A.md", "blake3:newer");
    expect((await harness.mirror.warmPositions()).warmed).toBe(0);
    expect(harness.mirror.positions("A.md")).toBeUndefined();
    // And it is the revision doing it, not the path: put it back and it warms.
    harness.forceServedRevision("A.md", null);
    expect((await harness.mirror.warmPositions()).warmed).toBe(1);
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
  }, FIXTURE_TIMEOUT_MS);

  it("resolves links across the vault it was given", () => {
    const vault = new FixtureVault({ "A.md": "[[B]]\n", "B.md": "# B\n" });
    const a = vault.notes().find((note) => note.path === "A.md");
    expect(a?.outgoing?.map((reference) => reference.resolution)).toEqual([
      { kind: "resolved", target: "B.md", subpath: null },
    ]);
  }, FIXTURE_TIMEOUT_MS);

  it("parses a whole vault in one spawn, and writes nowhere but its own cache", () => {
    // Two claims, and the second is what makes the first safe to measure.
    //
    // "One batch, one spawn" is the point: Task 7 calls `withVault` in every
    // shim test file, and three files costing three spawns instead of one is the
    // difference between a suite that runs and a suite nobody waits for.
    //
    // The second claim is that measuring it touches nobody else's rows. This
    // case used to diff the **shared** cache directory and delete every file it
    // had not seen before. Once the cache key started naming the parser binary
    // that became destructive: `metadata-parity` and `shim-metadata-cache`
    // regenerate their corpora in sibling processes at exactly the same moment
    // — the first run after any `crates/` change — so this case saw their files,
    // failed its count, and then deleted them. The run that most needed a warm
    // cache was the one throwing the regeneration away. So it now gets a cache
    // directory of its own through the seam, and asserts the shared one came out
    // exactly as it went in.
    const isolated = scratchRoot("vaultd-fixture-cache-");
    const shared = readdirSync(fixtureCacheDir()).sort();
    const spawnsBefore = fixtureGeneratorSpawns();

    try {
      overrideFixtureCacheDir(isolated);
      // No per-run marker needed any more: an empty private directory is a
      // guaranteed miss, which is what the marker was faking.
      const vault = new FixtureVault({
        "One.md": "# One\n\n[[Two]]\n",
        "Two.md": "# Two\n\n[[Three]]\n",
        "Three.md": "# Three\n",
      });
      expect(vault.notes().map((note) => note.path)).toEqual(["One.md", "Three.md", "Two.md"]);
      expect(fixtureGeneratorSpawns() - spawnsBefore).toBe(1);

      // The batch really did write one cache file per note, together.
      expect(readdirSync(isolated)).toHaveLength(3);

      // Reading the same vault again spawns nothing: the rows are memoized on
      // the instance, and a second instance answers from those same cache files.
      const again = new FixtureVault(vault.files);
      expect(again.notes()).toHaveLength(3);
      expect(fixtureGeneratorSpawns() - spawnsBefore).toBe(1);
    } finally {
      overrideFixtureCacheDir(null);
      // Only what this case created, and all of it: the directory is its own.
      rmSync(isolated, { recursive: true, force: true });
    }

    // **Nothing disappeared** — not "nothing changed". The shared directory is
    // written by every vitest worker at once, and this case spawns the
    // generator by design (an empty private directory is a guaranteed miss), so
    // its window is seconds wide and a sibling warming its own corpus inside it
    // is ordinary work rather than a fault. An equality here made the first
    // `npm test` on a clean checkout red for exactly that reason — the same
    // gate defect the destructive `finally` caused, wearing the opposite sign.
    //
    // The real claim is that this case destroyed nothing, and that is what this
    // asserts. Bypassing the seam still reds: the three rows would land in the
    // shared directory and `readdirSync(isolated)` would count zero first.
    expect(readdirSync(fixtureCacheDir())).toEqual(expect.arrayContaining(shared));
  }, FIXTURE_TIMEOUT_MS);

  it("keys a cached row on the parser that produced it", () => {
    // The whole value of these rows is that they are what `vault-core` really
    // answers, so a cache keyed on the fixture text alone keeps serving what the
    // parser said *before* it was fixed — and every host parity test goes on
    // comparing against the old answer, which is exactly where a parser fix most
    // needs to be visible.
    //
    // Asserted on the key rather than by watching a spawn, so this costs no
    // subprocess: two stamps over identical input must not collide, and one
    // stamp over identical input must.
    const documents = [{ path: "Stamp.md", source: "# Stamp\n" }];
    const spawnsBefore = fixtureGeneratorSpawns();
    try {
      overrideFixtureParserStamp("parser-before-the-fix");
      const before = cacheKey(documents, "Stamp.md");
      expect(cacheKey(documents, "Stamp.md")).toBe(before);

      overrideFixtureParserStamp("parser-after-the-fix");
      const after = cacheKey(documents, "Stamp.md");
      expect(after).not.toBe(before);

      // And the input still matters: a different note under one parser is still
      // a different key, so the stamp was added to the digest rather than
      // replacing what was there.
      expect(cacheKey([{ path: "Stamp.md", source: "# Other\n" }], "Stamp.md")).not.toBe(after);
    } finally {
      overrideFixtureParserStamp(null);
    }
    // The point of asserting on the key: nothing was generated.
    expect(fixtureGeneratorSpawns()).toBe(spawnsBefore);
  });

  it("synthesizes folders into the entry tree", () => {
    const vault = new FixtureVault({ "Folder/Sub/A.md": "x\n", "B.md": "y\n" });
    expect(
      vault
        .entries()
        .map((entry) => `${entry.kind}:${entry.path}`)
        .sort(),
    ).toEqual(["folder:Folder", "folder:Folder/Sub", "note:B.md", "note:Folder/Sub/A.md"]);
  }, FIXTURE_TIMEOUT_MS);

  it("bumps a revision on write and serves the new source", () => {
    const vault = new FixtureVault({ "A.md": "one\n" });
    const before = vault.revisionOf("A.md");
    vault.write("A.md", "two\n");
    expect(vault.source("A.md")).toBe("two\n");
    expect(vault.revisionOf("A.md")).not.toBe(before);
  }, FIXTURE_TIMEOUT_MS);
});

describe("the source tree stays text", () => {
  it("has no NUL byte in any file under src/, test/, or worker/", () => {
    // A literal U+0000 inside a string literal is invisible on screen, compiles
    // and runs correctly, and makes git classify the whole file as binary — so
    // every later diff, blame and three-way merge on it is lost. It happened
    // once in `fixture-vault.ts` (the review's Blocking finding), again in
    // `assemble.ts` while fixing it, and a third time in `shim-dom.test.ts` —
    // that third one landed in `test/`, which this guard never walked, so the
    // whole of the pin it was meant to protect went invisible in the diff too.
    // `"\0"` is the escape; this is the guard that says so, over every tree the
    // package ships.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) &&
          readFileSync(full).includes(0)
        ) {
          offenders.push(relative(PKG_ROOT, full));
        }
      }
    };
    walk(SRC_ROOT);
    walk(TEST_ROOT);
    if (existsSync(WORKER_ROOT)) walk(WORKER_ROOT);
    expect(offenders, "write \\0 rather than a literal NUL byte").toEqual([]);
  });
});

describe("scratchRoot", () => {
  it("takes its base under the repository root, not the OS tmpdir", () => {
    // The final review found no pin for this: it put `scratchRoot`'s base back
    // on `os.tmpdir()` and every affected suite stayed green, because nothing
    // asserted where the base actually was — the regression would only ever
    // have shown up later, as litter in the OS tmpdir, which is exactly how the
    // 17,533-directory leak this helper replaced was born. `REPO_ROOT` is
    // resolved the same way `scratch.ts` resolves `SCRATCH_BASE` — from this
    // file's own location, not `process.cwd()` — so the two can be compared
    // directly.
    const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
    expect(SCRATCH_BASE).toBe(join(REPO_ROOT, "target", "tmp"));
  });
});

describe("DataDir", () => {
  it("refuses a path that escapes its root", () => {
    const dir = new DataDir(scratchRoot("vaultd-dd-"));
    expect(() => dir.resolve("../escape.json")).toThrow(/datadir escape/);
    expect(() => {
      dir.writeJson("../escape.json", {});
    }).toThrow(/datadir escape/);
  });

  it("writes a secret at mode 0600", () => {
    const root = scratchRoot("vaultd-dd-");
    const dir = new DataDir(root);
    dir.writeSecret("nonce", "abcd");
    expect(readFileSync(join(root, "nonce"), "utf8")).toBe("abcd");
    expect(statSync(join(root, "nonce")).mode & 0o777).toBe(0o600);
  });

  it("narrows a secret rewritten over a world-readable file", () => {
    // The half the write's own `mode` cannot do: `mode` is ignored for a file
    // that already exists, so without the chmod a nonce written over anything
    // left at 0644 would stay readable by everyone.
    const root = scratchRoot("vaultd-dd-");
    const dir = new DataDir(root);
    writeFileSync(join(root, "nonce"), "stale", { encoding: "utf8", mode: 0o644 });
    chmodSync(join(root, "nonce"), 0o644);
    dir.writeSecret("nonce", "abcd");
    expect(statSync(join(root, "nonce")).mode & 0o777).toBe(0o600);
  });

  it("reads a secret back as text, and answers null for one that is not there", () => {
    // `readJson` would `JSON.parse` a raw nonce and throw; this is the reader
    // that matches `writeSecret`.
    const dir = new DataDir(scratchRoot("vaultd-dd-"));
    expect(dir.readText("nonce")).toBeNull();
    dir.writeSecret("nonce", "9f2c1ab4");
    expect(dir.readText("nonce")).toBe("9f2c1ab4");
    expect(() => dir.readJson("nonce")).toThrow();
  });

  it("round-trips JSON and answers null for a file that is not there", () => {
    const dir = new DataDir(scratchRoot("vaultd-dd-"));
    expect(dir.readJson("plugins/demo/data.json")).toBeNull();
    dir.writeJson("plugins/demo/data.json", { ok: true });
    expect(dir.readJson<{ ok: boolean }>("plugins/demo/data.json")).toEqual({ ok: true });
    dir.appendLine("log.ndjson", '{"n":1}');
    dir.appendLine("log.ndjson", '{"n":2}');
    expect(readFileSync(join(dir.root, "log.ndjson"), "utf8")).toBe('{"n":1}\n{"n":2}\n');
  });
});
