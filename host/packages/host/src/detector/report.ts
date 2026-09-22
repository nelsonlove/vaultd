/**
 * The two halves merged: one verdict per plugin, and the sentence it reads as.
 *
 * Kept apart from `harness.ts` because it is the only part of the detector
 * with an opinion. The scanner counts, the harness records, and this decides —
 * so the rule lives in one file, where changing it is a change to one thing.
 */

import type { HarnessResult } from "./harness";
import type { ScanResult } from "./scanner";
import type { SchemaSource } from "../settings/ladder";

/**
 * What this host can say about running the plugin.
 *
 * `unknown` is the fourth, added in fix round 2 and ledgered as a plan
 * amendment. Task 20b's B3 fix made `harness === null` mean two different
 * things — "this host is not in dry-run, so no harness ran" and "this host
 * **refuses to run this plugin**" — and the tier mapping was applied to both,
 * so a quarantined plugin's row read `runs`. A verdict field exists so a
 * client can render one word; that word may not be green for a plugin the host
 * will not start. See {@link verdictFor} for which case is which, and
 * {@link CompatReportRow.harnessAttempted} for the discriminator that carries
 * it. Task 20b puts both the enum and `harness_attempted` on the wire.
 */
export type Verdict = "runs" | "degrades" | "fails" | "unknown";

export interface CompatReportRow {
  readonly id: string;
  readonly version: string;
  readonly scan: ScanResult;
  readonly harness: HarnessResult | null;
  readonly schemaSource: SchemaSource;
  readonly verdict: Verdict;
  /**
   * Whether this host tried to run the plugin, whatever came of it.
   *
   * The discriminator between the two ways `harness` is null: `false` is "this
   * host is not in dry-run, so nothing was attempted" — the scan is all there
   * is and the verdict is the tier's — and `true` with a null harness is "the
   * attempt was refused", which is `unknown` and a sentence in {@link notes}.
   * Task 20b carries it as `harness_attempted`.
   */
  readonly harnessAttempted: boolean;
  /**
   * Why this row's `harness` is null or partial, in the host's words.
   *
   * A report over every installed plugin must finish: a plugin that is
   * quarantined, or whose probe refused for any other reason, is one row with
   * a sentence in it and not a report that answers nothing about the other
   * forty. Empty when the harness ran normally. The run's *own* limits — an
   * already-loaded plugin, an overlay that still holds the probe's bytes —
   * are `harness.harnessLimits`, one level down, because they describe a run
   * that happened.
   */
  readonly notes: readonly string[];
}

export interface CompatReport {
  readonly generatedAtUnixMs: number;
  readonly plugins: readonly CompatReportRow[];
}

/**
 * Three states, every one of them derived from a recorded fact.
 *
 * `fails` is "it did not load"; `degrades` is "it loaded, and something it
 * reached for is not here or cannot be reached headlessly"; `runs` is the
 * rest. A verdict is never asserted — {@link HarnessResult.calls} and
 * {@link ScanResult.tierReasons} are what a reader argues with.
 *
 * `unknown` is the fourth and the narrowest: a harness was **attempted and
 * refused** — the plugin is quarantined, or the probe itself failed. The row
 * says why in its `notes`.
 *
 * With no harness and none attempted (the host is not in dry-run) the tier
 * estimate is all there is, and it is mapped rather than invented: tiers 1 and
 * 2 are the ones whose entry points a headless host can reach, so they read
 * `runs`, and 3 and 4 read `degrades`. Never `fails` — nothing was run, so
 * nothing failed.
 */
export function verdictFor(
  scan: ScanResult,
  harness: HarnessResult | null,
  harnessAttempted: boolean,
): Verdict {
  // Attempted and refused: the host would not run this plugin, so it has no
  // verdict about running it. Never the tier mapping — that mapping says
  // "nothing was tried here", and something was.
  if (harness === null && harnessAttempted) return "unknown";
  if (harness === null) return scan.tierEstimate <= 2 ? "runs" : "degrades";
  if (!harness.loaded) return "fails";
  const absent = harness.calls.some((call) => call.policy === "absent");
  return absent || harness.harvest.unreachable > 0 ? "degrades" : "runs";
}

/**
 * What `schemaSource` means in words, and the one wording `"none"` may have.
 *
 * **"not yet described", never "no settings".** All eight golden plugins reach
 * `"none"`, and not one of them is settings-free: esbuild ships `{ default }`,
 * so rung 2 of Task 17's ladder finds no catalogue to read and the climb ends
 * with nothing. A report that rendered that as "no settings" would be
 * describing this host's reach and calling it a fact about the plugin — and a
 * reader would act on it, because "no settings" is exactly the sentence that
 * stops someone looking for the setting they need.
 */
export function describeSchemaSource(source: SchemaSource): string {
  switch (source) {
    case "definitions":
      return "described by the plugin's own getSettingDefinitions()";
    case "descriptors":
      return "described by an exported settings catalogue";
    case "types":
      return "described by the plugin's exported defaults";
    case "llm":
      return "described by a cached reading of the plugin's settings tab";
    case "none":
      return "not yet described";
  }
}

/** One plugin's row as a line somebody reads. */
export function summaryLine(row: CompatReportRow): string {
  const tier = `tier ${String(row.scan.tierEstimate)}`;
  const version = row.version === "" ? "no version" : row.version;
  const settings = describeSchemaSource(row.schemaSource);
  const detail =
    row.harness === null
      ? (row.notes[0] ?? (row.harnessAttempted ? "harness attempted and refused" : "harness not run"))
      : row.harness.loaded
        ? `${String(row.harness.calls.length)} calls, ` +
          `${String(row.harness.throws.length)} refused, ` +
          `${String(row.harness.harvest.unreachable)} unreachable registrations`
        : `did not load: ${row.harness.loadError ?? "no reason recorded"}`;
  const refused =
    row.harness === null || row.harness.refusals.length === 0
      ? ""
      : `; ${String(row.harness.refusals.length)} refused by dry-run ` +
        `(${[...new Set(row.harness.refusals.map((refusal) => refusal.surface))].join(", ")})`;
  return `${row.id} ${version}: ${row.verdict} — ${tier}, settings ${settings}; ${detail}${refused}`;
}
