import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Mirror } from "../src/mirror/mirror";
import { defaultHostConfig } from "../src/config";
import type { GenerationResponse, MutationResponse, RuntimeEventDto } from "../src/client/protocol";
import type { HostConfig } from "../src/config";
import type { MirrorChangeBatch } from "../src/mirror/types";
import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot, startedOn, waitFor } from "./real-daemon";

/**
 * The delta path against the **real** `vaultd`.
 *
 * `mirror-delta.test.ts` proves what this host does with a change set, against
 * a fake that answers whatever this host believes. Four things cannot be proved
 * that way, because every one of them is a fact about the shipped daemon:
 *
 * 1. **`get_note`'s `include` is real, and it is those two names.** The refetch
 *    path asks for `["sections", "list_items"]`; a daemon without the parameter
 *    answers `invalid_request` and every delta fails. A fake would agree with
 *    the request whatever it said.
 * 2. **`get_tree_entries { paths }` is real**, answers in one round trip for a
 *    batch of paths, and reports a path with no row in `absent` rather than
 *    refusing the whole call.
 * 3. **A watcher-driven generation really is `detailed`** for an ordinary edit,
 *    and its `changes` name the paths this host then refetches.
 * 4. **A deleted folder is named alone.** The subtree rule is not a nicety: the
 *    daemon's watcher path reports the folder and leaves the descendants
 *    implied, so a host that did not expand it would keep serving files that no
 *    longer exist.
 *
 * The binary is a Rust build artifact and is not in the repository; its absence
 * fails `client-real-daemon.test.ts` loudly and merely skips here. Build it with
 * `cargo build --release --bin vaultd`.
 */

/** A small vault: the interesting numbers here are round trips, not rows. */
function vaultFor(overrides: Partial<HostConfig> = {}): HostConfig {
  const root = scratchRoot("vaultd-delta-real-");
  const vault = join(root, "vault");
  mkdirSync(join(vault, "Folder"), { recursive: true });
  writeFileSync(
    join(vault, "A.md"),
    "---\ntitle: A\n---\n\n# A\n\nLinks to [[B]].\n\n- [ ] a task\n",
    "utf8",
  );
  writeFileSync(join(vault, "B.md"), "# B\n\nNothing here.\n", "utf8");
  writeFileSync(join(vault, "Folder", "Nested.md"), "# Nested\n\nUnder a folder.\n", "utf8");
  const index = join(root, "index.db");
  return {
    ...defaultHostConfig(vault),
    vaultdBinary: BINARY,
    vaultdArgs: ["--vault", vault, "--index", index],
    indexPath: index,
    restartBackoffMs: [50, 50],
    ...overrides,
  };
}

afterEach(cleanupRealDaemons);

describe.skipIf(!BINARY_EXISTS)("mirror deltas against a real vaultd", () => {
  it("follows the real subscription through an edit, a create and a delete", async () => {
    const config = vaultFor();
    const supervisor = await startedOn(config);
    // The supplier form, which is also what production uses: the connection
    // dies with its engine, so a mirror that captured one client could not
    // survive a restart.
    const mirror = await Mirror.open(() => supervisor.client(), config);
    expect(mirror.entries().map((entry) => entry.path).sort()).toEqual([
      "A.md",
      "B.md",
      "Folder",
      "Folder/Nested.md",
    ]);
    expect(mirror.backlinks("B.md")).toHaveLength(1);

    const batches: MirrorChangeBatch[] = [];
    const seen: RuntimeEventDto[] = [];
    const failures: Error[] = [];
    mirror.onBatch((batch) => batches.push(batch));
    await supervisor.subscribe((event) => {
      seen.push(event);
      void mirror.applyEvent(event).catch((error: unknown) => {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      });
    });

    const started = Date.now();
    const client = supervisor.client();
    // An ordinary edit: A stops linking to B and grows a second heading.
    await client.request<MutationResponse>("write_note", {
      path: "A.md",
      content: "# A\n\n## Second\n\nNo links now.\n\n- [x] done\n",
    });
    await waitFor(
      "the mirror to apply the edit to A.md",
      () => mirror.note("A.md")?.headings.length === 2,
      () =>
        `The mirror is at generation ${String(mirror.generation())} (applied through ` +
        `${String(mirror.appliedThrough())}), events seen: ` +
        `${seen.map((event) => event.type).join(", ")}, failures: ` +
        `${failures.map((error) => error.message).join(" | ")}.`,
    );

    expect(failures).toEqual([]);
    // The whole point of `include`: a daemon without it answers
    // `invalid_request` and this row would never have been installed.
    expect(mirror.note("A.md")!.sections.length).toBeGreaterThan(0);
    expect(mirror.note("A.md")!.listItems.some((item) => item.task !== undefined)).toBe(true);
    // The link went away, so the backlink went with it.
    expect(mirror.backlinks("B.md")).toHaveLength(0);
    expect(mirror.resolvedLinks()["A.md"]).toBeUndefined();
    // The tree row moved too — `get_note` reports neither size nor mtime, and
    // `TFile.stat` is served from what `get_tree_entries` answered.
    expect(mirror.entry("A.md")!.size).toBe(42);
    expect(mirror.entry("A.md")!.revision).toBe(mirror.note("A.md")!.revision);

    // A create, inside a folder that already exists.
    await client.request<MutationResponse>("write_note", {
      path: "Folder/New.md",
      content: "# New\n\nLinks to [[B]].\n",
      expected: { absent: true },
    });
    await waitFor(
      "the mirror to apply the new note",
      () => mirror.entry("Folder/New.md") !== undefined,
      () => `Events seen: ${seen.map((event) => event.type).join(", ")}.`,
    );
    expect(mirror.children("Folder").map((entry) => entry.path)).toEqual([
      "Folder/Nested.md",
      "Folder/New.md",
    ]);
    expect(mirror.backlinks("B.md")).toHaveLength(1);

    // And a folder delete. The daemon names the folder; the subtree is implied,
    // and expanding it is this host's job.
    await client.request<GenerationResponse>("delete_folder", {
      path: "Folder",
      mode: "permanent",
      recursive: true,
    });
    await waitFor(
      "the mirror to drop the deleted folder",
      () => mirror.entry("Folder") === undefined,
      () => `Events seen: ${seen.map((event) => event.type).join(", ")}.`,
    );
    expect(mirror.entry("Folder/Nested.md")).toBeUndefined();
    expect(mirror.entry("Folder/New.md")).toBeUndefined();
    expect(mirror.note("Folder/New.md")).toBeUndefined();
    expect(mirror.backlinks("B.md")).toHaveLength(0);
    expect(mirror.entries().map((entry) => entry.path).sort()).toEqual(["A.md", "B.md"]);
    expect(failures).toEqual([]);

    // Monotonic, and it really did move: each of the three edits committed a
    // generation and the mirror never went backwards.
    expect(mirror.generation()).toBeGreaterThanOrEqual(mirror.appliedThrough());
    expect(mirror.appliedThrough()).toBeGreaterThanOrEqual(3);
    const detailed = seen.filter(
      (event) =>
        event.type === "generation_committed" &&
        (event.value as { changes: { kind: string } }).changes.kind === "detailed",
    );
    expect(detailed.length).toBeGreaterThanOrEqual(3);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(batches.every((batch) => !batch.synthetic)).toBe(true);
    console.log(
      `[delta-real] three deltas applied in ${String(Date.now() - started)} ms, ` +
        `${String(seen.length)} events, ${String(batches.length)} batches, ` +
        `final generation ${String(mirror.generation())}`,
    );
  }, 60_000);

  it("reads its own write before the subscription echoes it, and drops the echo", async () => {
    const config = vaultFor();
    const supervisor = await startedOn(config);
    const mirror = await Mirror.open(() => supervisor.client(), config);

    const batches: MirrorChangeBatch[] = [];
    const committed: number[] = [];
    mirror.onBatch((batch) => batches.push(batch));
    await supervisor.subscribe((event) => {
      if (event.type === "generation_committed") {
        committed.push((event.value as { generation: number }).generation);
      }
      void mirror.applyEvent(event).catch(() => undefined);
    });

    const response = await supervisor.client().request<MutationResponse>("write_note", {
      path: "B.md",
      content: "# B rewritten\n\nBy this host.\n",
      expected: { revision: mirror.note("B.md")!.revision },
    });
    await mirror.applyMutation(response.generation, ["B.md"]);

    // Read-your-writes, synchronously, before the event describing the same
    // generation has necessarily arrived.
    expect(mirror.note("B.md")!.revision).toBe(response.revision);
    expect(mirror.note("B.md")!.headings[0]!.text).toBe("B rewritten");
    expect(mirror.appliedThrough()).toBeGreaterThanOrEqual(response.generation);
    // **Exactly one batch for one write**, whichever side produced it. Which
    // side wins is a genuine race — the subscription's echo can outrun the
    // mutation response — and the invariant that matters to a plugin is that it
    // is told once, not which of the two told it.
    const afterMutation = batches.length;
    expect(afterMutation).toBe(1);
    expect([...batches[0]!.modified, ...batches[0]!.created]).toContain("B.md");
    expect(["mutation", "watcher"]).toContain(batches[0]!.cause);

    // Now let the echo arrive. It names a generation already applied through,
    // so it is dropped: no refetch, and no second `changed` for the plugin that
    // did the writing.
    await waitFor(
      "the subscription to deliver this host's own generation",
      () => committed.includes(response.generation),
      () => `Generations seen: ${committed.join(", ")}.`,
    );
    expect(batches).toHaveLength(afterMutation);
  }, 60_000);

  it("answers a path with no row as absent rather than refusing the batch", async () => {
    const config = vaultFor();
    const supervisor = await startedOn(config);
    const mirror = await Mirror.open(() => supervisor.client(), config);

    // A path the index has never had a row for, applied as a modification. The
    // daemon reports it in `absent`, and the mirror treats an absence as the
    // removal it is — never as a failure.
    await mirror.applyMutation(mirror.generation(), ["Never existed.md", "A.md"]);
    expect(mirror.entry("Never existed.md")).toBeUndefined();
    expect(mirror.note("A.md")).toBeDefined();
    expect(mirror.note("A.md")!.sections.length).toBeGreaterThan(0);
  }, 60_000);
});
