import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Mirror } from "../src/mirror/mirror";
import { defaultHostConfig } from "../src/config";
import type { GenerationResponse, MutationResponse, RuntimeEventDto } from "../src/client/protocol";
import type { HostConfig } from "../src/config";
import type { MirrorChangeBatch } from "../src/mirror/types";
import type { VaultdClient } from "../src/client/client";
import {
  BINARY,
  BINARY_EXISTS,
  cleanupRealDaemons,
  freshMirrorAt,
  scratchRoot,
  startedOn,
  waitFor,
} from "./real-daemon";

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

  it("treats a path inside the .obsidian zone as an absence, not a refusal", async () => {
    const config = vaultFor();
    mkdirSync(join(config.vaultRoot, ".obsidian"), { recursive: true });
    writeFileSync(join(config.vaultRoot, ".obsidian", "app.json"), '{"a":1}\n', "utf8");
    const supervisor = await startedOn(config);
    const mirror = await Mirror.open(() => supervisor.client(), config);

    // Nothing under `.obsidian` is indexed, so the daemon has no row for it.
    // That is an answer the mirror knows how to apply, not a failure.
    await expect(
      mirror.applyMutation(mirror.generation(), [".obsidian/app.json", "A.md"]),
    ).resolves.toBeUndefined();
    expect(mirror.entry(".obsidian/app.json")).toBeUndefined();
    expect(mirror.note("A.md")).toBeDefined();
  }, 60_000);
});

/**
 * **The mirror must equal a fresh hydration**, and the one thing that used to
 * break that is invisible from the change set alone.
 *
 * `vaultd` re-resolves references when a link target appears or disappears and
 * reports it as `affected_reference_count` on the generation — but it never
 * names the *referring* note in `modified`, because that note did not change.
 * A mirror that refetched only the paths it was told about kept the referrer's
 * old resolutions forever, and `resolvedLinks()`, `unresolvedLinks()`,
 * `backlinks()` and `note(path).outgoing[].resolution` were then all wrong,
 * silently, until a resync a quiet vault never has. Task 8 hands all four to
 * plugin code with nothing in between.
 *
 * Every case here compares the live mirror against a **second mirror hydrated
 * from scratch at the same generation**, which is the only oracle that cannot
 * agree with a bug by sharing it.
 */
describe.skipIf(!BINARY_EXISTS)("mirror referrers against a real vaultd", () => {
  /** X links to Y; both exist. The smallest vault that can show referrer drift. */
  function xLinksY(overrides: Partial<HostConfig> = {}): HostConfig {
    const root = scratchRoot("vaultd-referrers-real-");
    const vault = join(root, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "X.md"), "# X\n\n[[Y]]\n", "utf8");
    writeFileSync(join(vault, "Y.md"), "# Y\n", "utf8");
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

  async function subscribed(
    config: HostConfig,
  ): Promise<{
    supervisor: Awaited<ReturnType<typeof startedOn>>;
    mirror: Mirror;
    events: RuntimeEventDto[];
    failures: Error[];
  }> {
    const supervisor = await startedOn(config);
    const mirror = await Mirror.open(() => supervisor.client(), config);
    const events: RuntimeEventDto[] = [];
    const failures: Error[] = [];
    mirror.onApplyError((error) => {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    });
    await supervisor.subscribe((event) => {
      events.push(event);
      void mirror.applyEvent(event).catch(() => undefined);
    });
    return { supervisor, mirror, events, failures };
  }

  /** Both link tables and the backlink count, live against a fresh hydration. */
  async function expectNoDrift(
    mirror: Mirror,
    config: HostConfig,
    client: () => VaultdClient,
    target: string,
  ): Promise<void> {
    const fresh = await freshMirrorAt(mirror, config, client);
    expect(fresh, "the vault never went quiet enough to compare two mirrors").toBeDefined();
    expect(mirror.resolvedLinks()).toEqual(fresh!.resolvedLinks());
    expect(mirror.unresolvedLinks()).toEqual(fresh!.unresolvedLinks());
    expect(mirror.backlinks(target)).toHaveLength(fresh!.backlinks(target).length);
  }

  it("refetches the referrer when this host deletes a link target", async () => {
    const config = xLinksY();
    const { supervisor, mirror, events, failures } = await subscribed(config);
    expect(mirror.resolvedLinks()).toEqual({ "X.md": { "Y.md": 1 } });

    const response = await supervisor
      .client()
      .request<GenerationResponse>("delete_note", { path: "Y.md", mode: "permanent" });
    const generation = response.generation!;
    await waitFor(
      "the mirror to apply the delete of Y.md",
      () => mirror.appliedThrough() >= generation,
      () => `applied through ${String(mirror.appliedThrough())}`,
    );

    // The daemon's own words: a reference moved, and the change set names Y.md
    // alone. X.md is refetched because the mirror asked, not because it was
    // told.
    const changed = events
      .filter((event) => event.type === "generation_committed")
      .map((event) => event.value as { changes: unknown; affected_reference_count: number });
    expect(changed.some((value) => value.affected_reference_count > 0)).toBe(true);

    expect(mirror.resolvedLinks()).toEqual({});
    expect(mirror.unresolvedLinks()).toEqual({ "X.md": { Y: 1 } });
    expect(mirror.backlinks("Y.md")).toHaveLength(0);
    await expectNoDrift(mirror, config, () => supervisor.client(), "Y.md");
    expect(failures).toEqual([]);
  }, 60_000);

  it("refetches the referrer when something outside this host deletes a link target", async () => {
    const config = xLinksY();
    const { supervisor, mirror, failures } = await subscribed(config);

    // No mutation call: the watcher is the only thing that will notice.
    rmSync(join(config.vaultRoot, "Y.md"));
    await waitFor(
      "the watcher to deliver the delete of Y.md",
      () => mirror.entry("Y.md") === undefined,
      () => `entries: ${mirror.entries().map((entry) => entry.path).join(", ")}`,
      30_000,
    );

    await expectNoDrift(mirror, config, () => supervisor.client(), "Y.md");
    expect(mirror.unresolvedLinks()).toEqual({ "X.md": { Y: 1 } });
    expect(failures).toEqual([]);
  }, 60_000);

  it("refetches the referrer when a creation fills in a link somebody already wrote", async () => {
    const config = xLinksY();
    rmSync(join(config.vaultRoot, "Y.md"));
    const { supervisor, mirror, failures } = await subscribed(config);
    expect(mirror.unresolvedLinks()).toEqual({ "X.md": { Y: 1 } });

    // The single most ordinary thing that happens in a vault, and the shape the
    // review called out: after it, the host's graph must not still say the link
    // is unresolved.
    writeFileSync(join(config.vaultRoot, "Y.md"), "# Y\n", "utf8");
    await waitFor(
      "the watcher to deliver the creation of Y.md",
      () => mirror.entry("Y.md") !== undefined,
      () => `entries: ${mirror.entries().map((entry) => entry.path).join(", ")}`,
      30_000,
    );

    expect(mirror.resolvedLinks()).toEqual({ "X.md": { "Y.md": 1 } });
    expect(mirror.unresolvedLinks()).toEqual({});
    expect(mirror.backlinks("Y.md")).toHaveLength(1);
    await expectNoDrift(mirror, config, () => supervisor.client(), "Y.md");
    expect(failures).toEqual([]);
  }, 60_000);

  it("refetches the referrer when a link target is renamed without link rewriting", async () => {
    const config = xLinksY();
    const { supervisor, mirror, failures } = await subscribed(config);

    // Reported as a delete plus a create, and X.md's link is left pointing at a
    // name that no longer exists.
    await supervisor
      .client()
      .request("rename_note", { from: "Y.md", to: "Renamed.md", rewrite_links: false });
    await waitFor(
      "the mirror to apply the rename",
      () => mirror.entry("Renamed.md") !== undefined && mirror.entry("Y.md") === undefined,
      () => `entries: ${mirror.entries().map((entry) => entry.path).join(", ")}`,
      30_000,
    );

    expect(mirror.resolvedLinks()).toEqual({});
    expect(mirror.unresolvedLinks()).toEqual({ "X.md": { Y: 1 } });
    await expectNoDrift(mirror, config, () => supervisor.client(), "Y.md");
    expect(failures).toEqual([]);
  }, 60_000);

  it("refreshes a folder's own row when a child is added", async () => {
    const config = xLinksY();
    mkdirSync(join(config.vaultRoot, "F"), { recursive: true });
    writeFileSync(join(config.vaultRoot, "F", "A.md"), "# A\n", "utf8");
    const { supervisor, mirror, failures } = await subscribed(config);

    // The daemon never names a folder whose child moved — it names what moved —
    // so a mirror that asked only for unseen ancestors would serve `F`'s
    // hydration-time `mtime` forever, and Task 7's `DataAdapter.stat` reports
    // it.
    const response = await supervisor.client().request<MutationResponse>("write_note", {
      path: "F/B.md",
      content: "# B\n",
      expected: { absent: true },
    });
    await waitFor(
      "the mirror to apply the new note",
      () => mirror.appliedThrough() >= response.generation,
      () => `applied through ${String(mirror.appliedThrough())}`,
    );

    const fresh = await freshMirrorAt(mirror, config, () => supervisor.client());
    expect(fresh).toBeDefined();
    expect(mirror.entry("F")).toEqual(fresh!.entry("F"));
    expect(failures).toEqual([]);
  }, 60_000);

  it("re-warms the position index of a note a re-hydration replaced", async () => {
    const config = xLinksY();
    const supervisor = await startedOn(config);
    const mirror = await Mirror.open(() => supervisor.client(), config);
    await mirror.warmPositions();
    expect(mirror.positions("X.md")).toBeDefined();
    expect(mirror.positions("Y.md")).toBeDefined();

    await supervisor.client().request<MutationResponse>("write_note", {
      path: "Y.md",
      content: "# Y rewritten\n\nWith a — dash, so the two counts part.\n",
    });
    // The resync road, taken directly rather than through the delta path: this
    // is what `watcher_overflow`, `subscriber_lag` and an engine restart all
    // reduce to.
    await mirror.applyEvent({
      type: "resync_required",
      value: { current_generation: null, reason: "watcher_overflow" },
    });

    // X did not move, so `adoptPositions` kept its table — a `read_file` well
    // saved. Y moved, and **its table is rebuilt**: nothing else ever would,
    // and Task 8's `getFileCache` would answer `null` for Y to every plugin for
    // the rest of the session.
    expect(mirror.positions("X.md")).toBeDefined();
    expect(mirror.positions("Y.md")).toBeDefined();
    expect(mirror.positions("Y.md")!.u16Length).toBeLessThan(
      mirror.positions("Y.md")!.byteLength,
    );
  }, 60_000);
});
