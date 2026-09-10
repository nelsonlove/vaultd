import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultHostConfig } from "../src/config";
import { hydrate } from "../src/mirror/hydrate";
import { SNAPSHOT_RETRY_BACKOFF_MS } from "../src/mirror/hydrate";
import type { HostConfig } from "../src/config";
import type { MutationResponse, OpenSnapshotResponse } from "../src/client/protocol";
import { FakeClock } from "./fake-clock";
import { BINARY, BINARY_EXISTS, cleanupRealDaemons, scratchRoot, startedOn } from "./real-daemon";

/**
 * Hydration against the **real** `vaultd`.
 *
 * `mirror-hydrate.test.ts` proves what this host does with a refusal, against a
 * fake that refuses on demand. Three things cannot be proved that way, because
 * they are facts about the shipped daemon rather than about this host:
 *
 * 1. **The wire is the wire.** `entries` and `notes` (never `items`), `include`
 *    naming `sections` and `list_items` as top-level facets, `snapshot_id` on
 *    every page — a fake agrees with whatever this client believes, and the
 *    daemon does not.
 * 2. **A session is coherent at one generation while the vault is written.**
 *    This is the entire reason snapshot sessions exist, and it is only
 *    observable with a writer running against the same daemon during the walk.
 * 3. **An attachment carries no revision.** Correction #13, ratified: the index
 *    stores no content revision for a non-note file, so `TreeEntryDto.revision`
 *    is absent for an attachment exactly as it is for a folder. The fake's
 *    fixture asserts this because this case measured it.
 *
 * The binary is a Rust build artifact and is not in the repository. Its absence
 * fails **`client-real-daemon.test.ts`** loudly — that file carries the
 * unconditional assertion plus the deliberate `VAULTD_ALLOW_MISSING_BINARY=1`
 * opt-out — and merely skips here, so the loud failure is stated once. If that
 * assertion is ever removed or that file renamed, the guard must move here in
 * the same motion. Build it with `cargo build --release --bin vaultd`.
 *
 * `startedOn` comes from `real-daemon.ts` rather than being spelled here, and
 * that is a fix rather than tidying: these cases previously started their
 * engines with a bare `await` and, under machine load, timed out at 60 s
 * reporting nothing whatsoever about why. The shared helper's watchdog reports
 * the supervisor's own view instead.
 */

/** Enough notes that paging is many round trips, so a writer can overlap it. */
const NOTE_COUNT = 200;

/** A scratch vault of `NOTE_COUNT` notes, one folder, and one attachment. */
function vaultFor(overrides: Partial<HostConfig> = {}): HostConfig {
  const root = scratchRoot("vaultd-hydrate-real-");
  const vault = join(root, "vault");
  mkdirSync(join(vault, "Folder"), { recursive: true });
  for (let i = 0; i < NOTE_COUNT; i += 1) {
    const body =
      `---\ntitle: Note ${String(i)}\ntags:\n  - mirrored\n---\n\n` +
      `# Note ${String(i)}\n\nLinks to [[Note ${String((i + 1) % NOTE_COUNT)}]] and a — dash.\n\n` +
      `- [ ] a task\n- a plain item\n`;
    writeFileSync(join(vault, `Note ${String(i)}.md`), body, "utf8");
  }
  writeFileSync(join(vault, "Folder", "Nested.md"), "# Nested\n", "utf8");
  // A real PNG header is enough: the point is a non-note file in the tree.
  writeFileSync(
    join(vault, "Folder", "pixel.png"),
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  );
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

describe.skipIf(!BINARY_EXISTS)("hydrate against a real vaultd", () => {
  it("mirrors the whole vault at one generation while the vault is being written", async () => {
    // A small page size on purpose: many pages means many round trips, which is
    // the window the concurrent writer has to commit inside.
    const config = vaultFor({ snapshotPageSize: 5 });
    const supervisor = await startedOn(config);
    const client = supervisor.client();

    // A writer that runs for as long as the hydration does, against the same
    // daemon. `expected` is omitted entirely — an unconditional write is spelled
    // by its absence, never by `{}`.
    let writing = true;
    const committed: number[] = [];
    const writer = (async (): Promise<void> => {
      for (let i = 0; writing; i += 1) {
        const response = await client.request<MutationResponse>("write_note", {
          path: `Note ${String(i % NOTE_COUNT)}.md`,
          content: `# Rewritten ${String(i)}\n\nA new body, written during hydration.\n`,
        });
        committed.push(response.generation);
      }
    })();

    const result = await hydrate(client, config);
    writing = false;
    await writer;

    expect(result.pages).toBeGreaterThan(2);
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.noteCount).toBe(NOTE_COUNT + 1);
    // Every note, the folder, and the attachment.
    expect(result.entryCount).toBe(NOTE_COUNT + 3);

    // **The coherence assertion.** The tree walk and the note walk are separate
    // page sequences; the only thing that makes them one view of one vault is
    // the pinned transaction they share. A note that was rewritten between the
    // two walks would show a tree revision that disagrees with its note
    // revision — so agreement across every note, while a writer is rewriting
    // those very notes, is the guarantee holding.
    const treeRevisions = new Map(result.entries.map((entry) => [entry.path, entry.revision]));
    for (const note of result.notes) {
      expect(treeRevisions.get(note.path)).toBe(note.revision);
    }

    // And the writer really did commit past the pin: at least one write landed
    // in a generation the snapshot does not contain. Without this the case
    // could pass on a vault nobody was writing to.
    expect(Math.max(...committed)).toBeGreaterThan(result.generation);
    expect(committed.length).toBeGreaterThan(0);

    // A folder has no bytes and no revision; **an attachment has no revision
    // either** — the ratified correction, measured against the daemon.
    const folder = result.entries.find((entry) => entry.path === "Folder");
    expect(folder).toMatchObject({ kind: "folder", revision: null, size: null, parent: "" });
    const attachment = result.entries.find((entry) => entry.path === "Folder/pixel.png");
    expect(attachment).toMatchObject({
      kind: "file",
      revision: null,
      parent: "Folder",
      name: "pixel.png",
    });
    expect(attachment?.size).toBeGreaterThan(0);
    expect(attachment?.mtimeMs).toBeGreaterThan(0);

    // The semantic facets really arrived, all five of them requested by name.
    const nested = result.notes.find((note) => note.path === "Folder/Nested.md");
    expect(nested?.headings[0]?.text).toBe("Nested");
    const first = result.notes.find((note) => note.path === "Note 0.md");
    expect(first).toBeDefined();
    // `sections` and `list_items` are top-level facets: a client that asked for
    // `metadata` alone would find both of these empty, silently.
    const structural = result.notes.filter(
      (note) => note.sections.length > 0 && note.listItems.length > 0,
    );
    expect(structural.length).toBeGreaterThan(0);
    const withTasks = result.notes.filter((note) =>
      note.listItems.some((item) => item.task !== undefined),
    );
    expect(withTasks.length).toBeGreaterThan(0);
    const withLinks = result.notes.filter((note) => note.outgoing.length > 0);
    expect(withLinks.length).toBeGreaterThan(0);
    expect(withLinks[0]?.outgoing[0]?.resolution.kind).toBeDefined();
    const withProperties = result.notes.filter((note) => note.properties.length > 0);
    expect(withProperties.length).toBeGreaterThan(0);

    // The other end of the same measurement: the **production** page size, on a
    // quiet vault, taken from configuration rather than from a literal. Both
    // numbers go on the record, because "how long does a hydration take" has
    // two answers and the page size is which one you get.
    const quiet = await hydrate(client, {
      ...config,
      snapshotPageSize: defaultHostConfig(config.vaultRoot).snapshotPageSize,
    });
    expect(quiet.noteCount).toBe(result.noteCount);
    expect(quiet.entryCount).toBe(result.entryCount);
    expect(quiet.generation).toBeGreaterThanOrEqual(result.generation);
    expect(quiet.pages).toBeLessThan(result.pages);

    // Reported so the timing of a real hydration is on the record rather than
    // in somebody's memory.
    console.log(
      `[hydrate-real] ${String(result.noteCount)} notes / ${String(result.entryCount)} entries ` +
        `in ${String(result.pages)} pages at page size ${String(config.snapshotPageSize)}: ` +
        `${String(result.elapsedMs)} ms, generation ${String(result.generation)}, ` +
        `${String(committed.length)} concurrent writes committed. ` +
        `Quiet, at page size ${String(defaultHostConfig(config.vaultRoot).snapshotPageSize)}: ` +
        `${String(quiet.pages)} pages, ${String(quiet.elapsedMs)} ms`,
    );
  }, 60_000);

  it("backs off and retries when the daemon's session cap is really reached", async () => {
    const clock = new FakeClock();
    const config = vaultFor({ clock, snapshotPageSize: 500 });
    const supervisor = await startedOn(config);
    const client = supervisor.client();

    // The daemon caps concurrent sessions at four. Hold all four, and the
    // hydration below meets a refusal no fake had to invent.
    const held: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const session = await client.request<OpenSnapshotResponse>("open_snapshot", {});
      held.push(session.snapshot_id);
    }

    const pending = hydrate(client, config);
    // The retry is armed on the config clock, so the rendezvous is the arming
    // itself: no sleep, and no guess about how long the refusal takes.
    await clock.armed(1);
    expect(clock.armedWaits()).toEqual([SNAPSHOT_RETRY_BACKOFF_MS[0]]);

    // Free a slot, then let the ladder's first rung elapse.
    await client.request("close_snapshot", { snapshot_id: held.pop() });
    clock.advance(SNAPSHOT_RETRY_BACKOFF_MS[0]!);

    const result = await pending;
    expect(result.generation).toBeGreaterThan(0);
    expect(result.noteCount).toBe(NOTE_COUNT + 1);
    for (const snapshotId of held) {
      await client.request("close_snapshot", { snapshot_id: snapshotId });
    }
  }, 60_000);
});
