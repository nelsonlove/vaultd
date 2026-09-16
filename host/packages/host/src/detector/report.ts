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

export type Verdict = "runs" | "degrades" | "fails";

export interface CompatReportRow {
  readonly id: string;
  readonly version: string;
  readonly scan: ScanResult;
  readonly harness: HarnessResult | null;
  readonly schemaSource: SchemaSource;
  readonly verdict: Verdict;
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
 * With no harness (the host is not in dry-run) the tier estimate is all there
 * is, and it is mapped rather than invented: tiers 1 and 2 are the ones whose
 * entry points a headless host can reach, so they read `runs`, and 3 and 4 read
 * `degrades`. Never `fails` — nothing was run, so nothing failed.
 */
export function verdictFor(scan: ScanResult, harness: HarnessResult | null): Verdict {
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
      ? (row.notes[0] ?? "harness not run")
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
