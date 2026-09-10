import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Mirror } from "../src/mirror/mirror";
import { defaultHostConfig } from "../src/config";
import type { HostConfig } from "../src/config";
import type { MirrorChangeBatch } from "../src/mirror/types";
import type { RuntimeEventDto } from "../src/client/protocol";
import {
  BINARY,
  BINARY_EXISTS,
  cleanupRealDaemons,
  freshMirrorAt,
  scratchRoot,
  startedOn,
} from "./real-daemon";

/**
 * **The drift oracle.** A mirror kept current by deltas must equal a mirror
 * hydrated from scratch — that is the whole promise of this phase, and it is a
 * promise no single-shape test can check, because the ways two views can part
 * are combinations rather than cases.
 *
 * So: three hundred random mutations against the real `vaultd`, with a live
 * mirror subscribed and applying every event, and after every thirty of them a
 * **second mirror hydrated from scratch at the same generation** and eight full
 * state projections compared byte for byte — the tree rows, every note row,
 * both link tables, the backlinks of every path, the position index of every
 * path, and the children of every folder.
 *
 * The mutations are drawn from the mirror's own live entry list, so the mix
 * follows the vault as it changes rather than replaying a script against a
 * vault that has moved on. Two fixed seeds, because a fuzz that picks a new
 * seed each run reports a different bug every time and pins none of them: these
 * two are the seeds the Task 6 review ran, and on the code as reviewed they
 * both produced four divergent state keys — the referrer staleness the mirror
 * now refetches for, and the folder `mtime` it now asks for the ancestors of.
 * This file is what stops either coming back, and it is the standing oracle for
 * Tasks 7 through 9, which read this surface directly.
 *
 * A comparison the vault moved under is **skipped, not counted** — `undefined`
 * from `freshMirrorAt` means the two mirrors never landed on one generation —
 * so a busy machine loses samples rather than inventing failures.
 *
 * Tunable by environment for a longer soak: `FUZZ_TOTAL` (default 300) and
 * `FUZZ_BATCH` (default 30). The seeds are not tunable, deliberately.
 */

const TOTAL = Number(process.env.FUZZ_TOTAL ?? "300");
const BATCH = Number(process.env.FUZZ_BATCH ?? "30");
const SEEDS = [20260910, 777];

/** A tiny deterministic PRNG, so a seed really does reproduce a run. */
function mulberry32(a: number): () => number {
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A vault with every shape the delta path has a rule about: nested folders, a
 * sibling whose name is a prefix of a folder (`F2x` is not under `F2`), links
 * that resolve, a link that does not, a relative link, a duplicate link, an
 * attachment, frontmatter, tasks, and non-ASCII bytes.
 */
function seedVault(): HostConfig {
  const root = scratchRoot("vaultd-fuzz-");
  const vault = join(root, "vault");
  mkdirSync(join(vault, "F1"), { recursive: true });
  mkdirSync(join(vault, "F2", "Deep"), { recursive: true });
  mkdirSync(join(vault, "F2x"), { recursive: true });
  writeFileSync(join(vault, "A.md"), "---\ntags: [a]\n---\n# A\n\nLink [[B]] and [[F1/N1]].\n", "utf8");
  writeFileSync(join(vault, "B.md"), "# B\n\n- [ ] one\n- [x] two\n\nSee [[Missing]].\n", "utf8");
  writeFileSync(join(vault, "C.md"), "# C\n\nCafé — naïve ünicode ✅ 漢字.\n\n[[A]]\n", "utf8");
  writeFileSync(join(vault, "F1", "N1.md"), "# N1\n\n[[../B]]\n", "utf8");
  writeFileSync(join(vault, "F1", "N2.md"), "# N2\n\n[[A]] [[A]] [[C]]\n", "utf8");
  writeFileSync(join(vault, "F2", "Deep", "D1.md"), "# D1\n\n[[N1]]\n", "utf8");
  writeFileSync(join(vault, "F2x", "Sib.md"), "# Sib\n\nnot under F2\n", "utf8");
  writeFileSync(join(vault, "img.png"), "not really a png", "utf8");
  const index = join(root, "index.db");
  return {
    ...defaultHostConfig(vault),
    vaultdBinary: BINARY,
    vaultdArgs: ["--vault", vault, "--index", index],
    indexPath: index,
    restartBackoffMs: [50, 50],
  };
}

/** The eight projections a comparison covers. */
interface Snap {
  generation: number;
  entries: string;
  notes: string;
  resolved: string;
  unresolved: string;
  backlinks: string;
  positions: string;
  children: string;
}

/** JSON with object keys sorted, so two equal states stringify identically. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const record = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) out[key] = record[key];
      return out;
    }
    return v;
  });
}

function snapshotOf(mirror: Mirror): Snap {
  const paths = mirror.entries().map((entry) => entry.path);
  return {
    generation: mirror.generation(),
    entries: stable(
      mirror.entries().map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        name: entry.name,
        parent: entry.parent,
        revision: entry.revision,
        size: entry.size,
        ctimeMs: entry.ctimeMs,
        mtimeMs: entry.mtimeMs,
      })),
    ),
    notes: stable(
      paths
        .map((path) => mirror.note(path))
        .filter((row) => row !== undefined)
        .map((row) => ({
          path: row.path,
          revision: row.revision,
          properties: row.properties,
          aliases: row.aliases,
          headings: row.headings,
          blocks: row.blocks,
          tags: row.tags,
          // **`diagnostics` is deliberately not compared, and the reason is a
          // daemon asymmetry rather than a host one.** `get_note` answers the
          // *union* of a note's diagnostics — `query::diagnostics`, which reads
          // `note_diagnostics` **and** `resolution_diagnostics` — while
          // `snapshot_notes`' `metadata` facet reads `load_metadata_with`,
          // which reads only `note_diagnostics`. So a refetched note carries
          // `unresolved_reference` and a hydrated one does not, for the same
          // bytes at the same generation, and no host can make the two agree:
          // hydration has no facet that would yield the resolution half.
          //
          // FOLLOW-UP (vaultd): have the snapshot metadata facet read the same
          // union `get_note` does, and delete this exclusion. Until then the
          // mirror's `note(path).diagnostics` is "whatever road that row came
          // by", which nothing downstream reads — Obsidian's `CachedMetadata`
          // has no diagnostics concept — but which this oracle would otherwise
          // report as drift on every single comparison, drowning the drift it
          // exists to catch.
          sections: row.sections,
          listItems: row.listItems,
          outgoing: row.outgoing,
        })),
    ),
    resolved: stable(mirror.resolvedLinks()),
    unresolved: stable(mirror.unresolvedLinks()),
    backlinks: stable(
      paths.map((path) => [
        path,
        [...mirror.backlinks(path)].map((reference) => stable(reference)).sort(),
      ]),
    ),
    positions: stable(
      paths.map((path) => {
        const index = mirror.positions(path);
        return [
          path,
          index
            ? {
                lineStarts: [...index.lineStarts],
                lineU16Starts: [...index.lineU16Starts],
                wide: [...index.wide],
                byteLength: index.byteLength,
                u16Length: index.u16Length,
              }
            : null,
        ];
      }),
    ),
    children: stable(
      ["", ...paths].map((path) => [path, mirror.children(path).map((entry) => entry.path)]),
    ),
  };
}

afterEach(cleanupRealDaemons);

describe.skipIf(!BINARY_EXISTS)("mirror fuzz: deltas against a fresh hydration", () => {
  it.each(SEEDS)(
    "never diverges from a fresh hydration over random mutations (seed %i)",
    async (seed: number) => {
      const config = seedVault();
      const supervisor = await startedOn(config);
      const client = (): ReturnType<typeof supervisor.client> => supervisor.client();
      const live = await Mirror.open(client, config);

      const failures: string[] = [];
      const batches: MirrorChangeBatch[] = [];
      const events: RuntimeEventDto[] = [];
      live.onBatch((batch) => batches.push(batch));
      live.onApplyError((error) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
      await supervisor.subscribe((event) => {
        events.push(event);
        void live.applyEvent(event).catch(() => undefined);
      });

      const random = mulberry32(seed);
      const pick = <T>(items: readonly T[]): T | undefined =>
        items.length === 0 ? undefined : items[Math.floor(random() * items.length)];
      const refused = new Map<string, number>();
      const applied = new Map<string, number>();
      let counter = 0;

      const notePaths = (): string[] =>
        live
          .entries()
          .filter((entry) => entry.kind === "note")
          .map((entry) => entry.path);
      const folderPaths = (): string[] =>
        live
          .entries()
          .filter((entry) => entry.kind === "folder")
          .map((entry) => entry.path);
      const filePaths = (): string[] =>
        live
          .entries()
          .filter((entry) => entry.kind !== "folder" && entry.kind !== "note")
          .map((entry) => entry.path);

      const body = (): string => {
        const targets = notePaths();
        const links: string[] = [];
        const count = Math.floor(random() * 4);
        for (let i = 0; i < count; i += 1) {
          const target = pick(targets);
          const raw =
            target === undefined
              ? `Ghost${String(Math.floor(random() * 5))}`
              : target.replace(/\.md$/, "");
          links.push(`[[${raw}]]`);
        }
        const unicode = random() < 0.25 ? "Café — 漢字 ✅\n" : "";
        const task = random() < 0.4 ? "\n- [ ] todo\n- [x] done\n" : "";
        const front = random() < 0.3 ? `---\ntags: [t${String(Math.floor(random() * 3))}]\n---\n` : "";
        return `${front}# H${String(counter)}\n\n${unicode}${links.join(" ")}\n${task}\n## Sub\n\ntext\n`;
      };

      const freshNote = (): string => {
        const folders = ["", ...folderPaths()];
        const folder = pick(folders) ?? "";
        return `${folder === "" ? "" : `${folder}/`}New${String((counter += 1))}.md`;
      };

      const run = async (method: string, params: unknown): Promise<void> => {
        try {
          await client().request(method, params);
          applied.set(method, (applied.get(method) ?? 0) + 1);
        } catch (error) {
          // A refusal is data, not a failure: the vault moved under the choice.
          const code = (error as { code?: string }).code ?? "unknown";
          refused.set(`${method}:${code}`, (refused.get(`${method}:${code}`) ?? 0) + 1);
        }
      };

      const mutate = async (): Promise<void> => {
        const roll = random();
        if (roll < 0.24) {
          const target = random() < 0.5 ? pick(notePaths()) : freshNote();
          if (target === undefined) return;
          await run("write_note", { path: target, content: body() });
          return;
        }
        if (roll < 0.34) {
          const target = pick(notePaths());
          if (target === undefined) return;
          await run("patch_frontmatter", {
            path: target,
            patch: [
              { key_path: "fuzz", value: Math.floor(random() * 1000) },
              { key_path: "flag", value: random() < 0.5 ? null : "on" },
            ],
          });
          return;
        }
        if (roll < 0.46) {
          const from = pick(notePaths());
          if (from === undefined) return;
          await run("rename_note", { from, to: freshNote(), rewrite_links: random() < 0.5 });
          return;
        }
        if (roll < 0.54) {
          const from = pick(folderPaths());
          if (from === undefined) return;
          await run("rename_folder", {
            from,
            to: `R${String((counter += 1))}`,
            rewrite_links: random() < 0.5,
          });
          return;
        }
        if (roll < 0.66) {
          const target = pick(notePaths());
          if (target === undefined) return;
          await run("delete_note", { path: target, mode: "permanent" });
          return;
        }
        if (roll < 0.74) {
          const target = pick(folderPaths());
          if (target === undefined) return;
          await run("delete_folder", { path: target, mode: "permanent", recursive: true });
          return;
        }
        if (roll < 0.82) {
          const from = pick([...notePaths(), ...filePaths()]);
          if (from === undefined) return;
          const to = from.endsWith(".md") ? freshNote() : `copy${String((counter += 1))}.png`;
          await run("copy_file", { from, to, if_exists: "suffix" });
          return;
        }
        if (roll < 0.9) {
          const parent = pick(["", ...folderPaths()]) ?? "";
          await run("create_folder", {
            path: `${parent === "" ? "" : `${parent}/`}Dir${String((counter += 1))}`,
          });
          return;
        }
        if (roll < 0.96) {
          const parent = pick(["", ...folderPaths()]) ?? "";
          await run("write_file", {
            path: `${parent === "" ? "" : `${parent}/`}bin${String((counter += 1))}.png`,
            content_base64: Buffer.from(`bytes-${String(random())}`, "utf8").toString("base64"),
          });
          return;
        }
        // A zone write: `.obsidian` is unindexed, so this must move no row at
        // all — only `config_changed`, which advances nothing.
        await run("write_file", {
          path: `.obsidian/fuzz${String((counter += 1))}.json`,
          content_base64: Buffer.from(`{"n":${String(Math.floor(random() * 100))}}`, "utf8").toString(
            "base64",
          ),
        });
      };

      let divergences = 0;
      let comparisons = 0;
      let skipped = 0;
      const started = Date.now();

      for (let index = 0; index < TOTAL; index += 1) {
        await mutate();
        if ((index + 1) % BATCH !== 0 && index + 1 !== TOTAL) continue;

        const fresh = await freshMirrorAt(live, config, client);
        if (!fresh) {
          // The vault never went quiet enough for the two to share a
          // generation. Not a divergence; not a sample either.
          skipped += 1;
          continue;
        }
        // Warm both sides: an unwarmed index is `undefined` on both, which
        // would compare equal and prove nothing about the position tables.
        await live.warmPositions();
        await fresh.warmPositions();
        if (fresh.generation() !== live.generation()) {
          skipped += 1;
          continue;
        }
        comparisons += 1;

        const a = snapshotOf(live);
        const b = snapshotOf(fresh);
        // When a projection parts, say **which rows** parted. A 200 kB JSON
        // diff names a character offset; this names a path, which is the thing
        // a reader then goes and reasons about.
        if (a.entries !== b.entries || a.notes !== b.notes) {
          const paths = new Set([
            ...live.entries().map((entry) => entry.path),
            ...fresh.entries().map((entry) => entry.path),
          ]);
          const off: string[] = [];
          for (const path of paths) {
            if (stable(live.entry(path)) !== stable(fresh.entry(path))) {
              off.push(
                `ENTRY ${path}\n    live  ${stable(live.entry(path))}\n    fresh ${stable(fresh.entry(path))}`,
              );
            }
            const liveRow = live.note(path);
            const freshRow = fresh.note(path);
            if (stable(liveRow?.outgoing) !== stable(freshRow?.outgoing)) {
              off.push(
                `NOTE ${path} outgoing\n    live  ${stable(
                  liveRow?.outgoing.map((reference) => [reference.raw_target, reference.resolution]),
                )}\n    fresh ${stable(
                  freshRow?.outgoing.map((reference) => [reference.raw_target, reference.resolution]),
                )}`,
              );
            } else if (stable(liveRow) !== stable(freshRow)) {
              off.push(`NOTE ${path} (a field other than outgoing)`);
            }
          }
          console.error(
            `[fuzz seed ${String(seed)} gen ${String(live.generation())}] rows that parted:\n  ` +
              off.join("\n  "),
          );
        }
        for (const key of Object.keys(a) as Array<keyof Snap>) {
          if (a[key] === b[key]) continue;
          divergences += 1;
          // A bounded diff at the first differing character, so one failure
          // names the shape rather than printing two whole vaults.
          const left = String(a[key]);
          const right = String(b[key]);
          let at = 0;
          while (at < left.length && at < right.length && left[at] === right[at]) at += 1;
          console.error(
            `[fuzz seed ${String(seed)}] [after ${String(index + 1)} mutations, generation ` +
              `${String(live.generation())}] ${key} DIVERGED at char ${String(at)}\n` +
              `  live : ...${left.slice(Math.max(0, at - 120), at + 240)}\n` +
              `  fresh: ...${right.slice(Math.max(0, at - 120), at + 240)}`,
          );
        }
      }

      console.log(
        `[fuzz seed ${String(seed)}] ${String(TOTAL)} mutations, ${String(comparisons)} full ` +
          `comparisons (${String(skipped)} skipped), ${String(divergences)} divergences, ` +
          `${String(batches.length)} batches, ${String(events.length)} events, ` +
          `${String(Date.now() - started)} ms\n` +
          `  applied: ${[...applied].map(([k, v]) => `${k}=${String(v)}`).join(" ")}\n` +
          `  refused: ${[...refused].map(([k, v]) => `${k}=${String(v)}`).join(" ")}\n` +
          `  apply failures: ${failures.length === 0 ? "none" : failures.join(" | ")}`,
      );

      expect(divergences).toBe(0);
      expect(comparisons).toBeGreaterThan(5);
      expect(failures).toEqual([]);
    },
    600_000,
  );
});
