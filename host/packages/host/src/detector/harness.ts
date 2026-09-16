/**
 * The runtime half of the compatibility detector: load the plugin and watch.
 *
 * The scanner reads what a bundle says about itself; this loads it for real,
 * under `--dry-run`, and records every shim symbol it touched with the policy
 * that symbol declares and whether it threw. Neither half is trusted alone —
 * a scan cannot see a plugin that builds its command ids at runtime, and a
 * harness cannot see the half of a plugin that never ran.
 *
 * **It runs inside the host's own dry-run assembly, not a second one.** The
 * brief said "a fresh `DryRunGate` and a fresh `PolicyRecorder` scoped to the
 * plugin", and a second assembly cannot be what that means: the gate and the
 * recorder are installed module-level (see `shim/policy.ts` on why), so a
 * second live pair would displace the running host's and the next refusal
 * anywhere in the process would land in the detector's copy. What it means
 * here is **windowing**: mark the gate's write log and the recorder's ordered
 * call log before the load, read what landed after it, and filter every row to
 * the plugin under probe. The result is the same rows a fresh pair would have
 * held, and the running host keeps the pair it was assembled with.
 *
 * So the detector refuses outside dry-run, typed and by name
 * ({@link DETECTOR_REQUIRES_DRY_RUN}). Loading a plugin for real in a host that
 * is not pretending would run its `onload` against the vault — and a plugin
 * whose `onload` writes is ordinary.
 */

import { DryRunGate } from "../dryrun/dry-run";
import { HostError } from "../server/wire";
import { scanBundle } from "./scanner";
import { verdictFor } from "./report";
import type { Clock, HostConfig } from "../config";
import type { Harvest } from "../shim/harvest";
import type { HeadlessConfigDir } from "../pluginset/config-dir";
import type { LifecycleSequencer } from "../runtime/lifecycle";
import type { PluginConfigService } from "../settings/plugin-config";
import type { PolicyRecorder, RecordedApiCall } from "../shim/policy";
import type { QuarantineTracker } from "../runtime/quarantine";
import type { RecordedRefusal, RecordedWrite, WriteGate } from "../dryrun/dry-run";
import type { CompatReport, CompatReportRow } from "./report";
import type { ScanResult } from "./scanner";

export type { RecordedApiCall } from "../shim/policy";
export type { ScanResult, Tier } from "./scanner";
export type { CompatReport, CompatReportRow, Verdict } from "./report";

/** The refusal code for a harness run asked of a host that is not pretending. */
export const DETECTOR_REQUIRES_DRY_RUN = "detector_requires_dry_run";

export interface HarnessResult {
  readonly pluginId: string;
  readonly loaded: boolean;
  readonly loadError: string | null;
  readonly calls: readonly RecordedApiCall[];
  readonly throws: readonly RecordedApiCall[];
  readonly writes: readonly RecordedWrite[];
  /**
   * Every refusal the dry-run gate answered during the load — the network
   * calls, the OS bridges and the node builtins this run would not perform.
   *
   * **Beside `writes`, and not among `throws`.** A `DryRunRefused` says
   * something about the *run*, not about this host's surface: the same call on
   * the same host succeeds with the flag off, so it is recorded at the
   * symbol's declared policy with `threw: null` and it never moves a verdict.
   * But it is still a fact the reader of a report needs — a plugin whose one
   * job is to fetch has not been exercised by a run that refused the fetch —
   * and before this field existed it lived in `DryRunGate.refusals()` and
   * nowhere a client could reach. Task 20b carries it as `harness.refusals`
   * on the wire.
   */
  readonly refusals: readonly RecordedRefusal[];
  readonly harvest: {
    commands: number;
    menuHooks: number;
    protocolHandlers: number;
    unreachable: number;
  };
  /**
   * What this run could not see, in the host's words rather than the plugin's.
   *
   * Task 19b left three known holes in the dry-run overlay — a frontmatter
   * patch records a row and no bytes, `listInstalled` is blind to a plugin
   * folder a dry run created, and an overlay-only file has `null` metadata —
   * and a plugin that trips one of them has not failed. A verdict must not
   * turn a limit of the instrument into a finding about the subject, so the
   * limit is reported here, beside the result, where a reader can weigh it.
   */
  readonly harnessLimits: readonly string[];
}

export interface DetectorDeps {
  readonly config: HostConfig;
  readonly clock: Clock;
  readonly dir: HeadlessConfigDir;
  readonly lifecycle: LifecycleSequencer;
  readonly harvest: Harvest;
  readonly recorder: PolicyRecorder;
  readonly writes: WriteGate;
  readonly quarantine: QuarantineTracker;
  /**
   * How the report answers `schemaSource`, or nothing.
   *
   * Optional because the service is Task 17's and a host may be assembled
   * without one; a report built without it says `"none"`, which is the same
   * word the service itself answers for a plugin whose schema was never
   * climbed. "Not yet described" either way — never "no settings".
   */
  readonly pluginConfig?: PluginConfigService;
}

export class Detector {
  /**
   * The single slot every harness run takes in turn.
   *
   * **A chain of this detector's own, not the dispatch queue.** A run loads a
   * plugin, and loading one already goes through the queue for its `onload` —
   * wrapping the whole run in a queued slot would have the run waiting on a
   * slot it is itself holding. So concurrency is settled one level up: two
   * `runHarness` calls land on this promise and the second starts when the
   * first has finished restoring the enabled set. Two runs interleaving would
   * make both results wrong rather than one slow, because the windows they
   * read are windows over one shared log.
   */
  private work: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DetectorDeps) {}

  /** What the shipped bundle says about itself. See `detector/scanner.ts`. */
  async scan(pluginId: string): Promise<ScanResult> {
    let source: string;
    try {
      source = await this.deps.dir.readBundleSource(pluginId);
    } catch (error) {
      // **An empty scan with a reason, not a throw.** A plugin can be
      // installed with no readable `main.js` — a half-finished install, a
      // harness whose plugins are classes rather than bundles — and a report
      // that refused the whole plugin for it would answer nothing about the
      // half this host *can* see, which is the runtime half.
      const scanned = scanBundle(pluginId, "");
      return {
        ...scanned,
        // **The only reason, not an extra one.** The empty scan's own reason
        // ("nothing is registered as an entry point") asserts something about
        // a file that does not exist, and a reader weighing two sentences
        // would weigh one of them wrongly.
        tierReasons: [
          `no bundle source to scan (${messageOf(error)}): the tier is a default, not a finding`,
        ],
      };
    }
    return scanBundle(pluginId, source);
  }

  /**
   * Load the plugin under the dry-run gate and report what it touched.
   *
   * Loading is {@link LifecycleSequencer.enableLate} — the host's own late
   * enable, not a second loader — so the plugin gets the registration order,
   * the attribution window and the teardown every other plugin gets. A plugin
   * that was not enabled before the run is disabled again afterwards; one that
   * was already running is left alone, because a detector must not be the
   * reason a plugin stopped.
   */
  runHarness(pluginId: string): Promise<HarnessResult> {
    const run = this.work.then(
      () => this.probe(pluginId),
      () => this.probe(pluginId),
    );
    // Held whatever happens, so a refused run does not poison the chain for
    // the next caller.
    this.work = run.catch(() => undefined);
    return run;
  }

  /**
   * One plugin's report, or every installed plugin's.
   *
   * `harness` is `null` when the host is not in dry-run — the scan still runs,
   * because reading a bundle changes nothing — and populated otherwise.
   */
  async report(pluginId?: string): Promise<CompatReport> {
    const ids =
      pluginId === undefined
        ? (await this.deps.dir.listInstalled()).map((plugin) => plugin.id)
        : [pluginId];
    const plugins: CompatReportRow[] = [];
    for (const id of ids) {
      const scan = await this.scan(id);
      // **One plugin's refusal is one row's, never the report's.** A host
      // holding a quarantined plugin is exactly the host an operator wants a
      // compatibility report from, and a `report()` that rejected on the first
      // one it could not probe would answer nothing about the other forty.
      // The refusal becomes a note on the row it belongs to and the walk goes
      // on — the same shape `HeadlessConfigDir.listInstalled` takes for a
      // broken manifest.
      let harness: HarnessResult | null = null;
      const notes: string[] = [];
      if (this.inDryRun()) {
        try {
          harness = await this.runHarness(id);
        } catch (error) {
          notes.push(`harness not run: ${messageOf(error)}`);
        }
      } else {
        notes.push("harness not run: this host is not in dry-run");
      }
      plugins.push({
        id,
        version: await this.versionOf(id),
        scan,
        harness,
        schemaSource: this.deps.pluginConfig?.schemaSourceFor(id) ?? "none",
        verdict: verdictFor(scan, harness),
        notes,
      });
    }
    return { generatedAtUnixMs: this.deps.clock.now(), plugins };
  }

  private async probe(pluginId: string): Promise<HarnessResult> {
    const gate = this.gateOrRefuse();
    if (this.deps.quarantine.isQuarantined(pluginId)) {
      const reason = this.deps.quarantine.reason(pluginId);
      throw new HostError(
        "plugin_quarantined",
        `"${pluginId}" is quarantined after ${String(reason.length)} handler failures ` +
          `(${reason.map((failure) => failure.label).join(", ")}) and this host will not run its ` +
          "code, which is what a harness run would do",
        { plugin_id: pluginId },
      );
    }
    // **The enabled SET, read before the load — not the loaded list.** The two
    // are different sets and the difference is a plugin the user switched on
    // whose `onload` threw: enabled, not loaded. Deciding the restore from
    // `loadedPlugins()` made the detector disable exactly that plugin, so
    // asking for a compatibility report silently un-enabled the plugin the
    // report was most likely being asked about. What has to be put back is
    // what the host was asked to run, which is this set.
    const wasEnabled = (await this.deps.dir.readEnabledSet()).includes(pluginId);
    const wasLoaded = this.deps.lifecycle.loadedPlugins().includes(pluginId);
    const mark = gate.mark();
    const callMark = this.deps.recorder.callMark?.() ?? null;
    const harnessLimits: string[] = [];
    if (callMark === null) {
      harnessLimits.push(
        "this host's policy recorder keeps no ordered call log, so `calls` and `throws` are empty",
      );
    }

    let loaded = false;
    let loadError: string | null = null;
    try {
      if (wasLoaded) {
        // Already running, so there is nothing to load and nothing to restore.
        // The window is still taken, and it is honestly empty: what this
        // plugin touched during *its* load happened before the detector was
        // asked, and inventing rows for it would be reporting a run that did
        // not happen.
        loaded = true;
        harnessLimits.push(
          `${pluginId} was already loaded, so this run records nothing it did at load time — ` +
            "`calls`, `throws` and `writes` are empty for that reason and not because the plugin " +
            "touched nothing, while the `harvest` counts below are its real registrations, so the " +
            "verdict for this row rides on those alone",
        );
      } else {
        await this.deps.lifecycle.enableLate(pluginId);
        loaded = true;
      }
    } catch (error) {
      // **The plugin's own message, added back.** The sequencer turns a load
      // failure into a sentence before it throws — `loadOne` keeps the message
      // and builds a fresh `Error` from it — so the cause chain ends at "threw
      // during onload and has been rolled back" and the plugin's own words are
      // gone by the time they reach here. The quarantine tracker still holds
      // them: it records every failure it is handed whether or not the
      // threshold is reached, and `lastError` is that record. Reading it here
      // is what makes `loadError` name the bug rather than the layer that
      // caught it.
      loadError = withLastError(messageOf(error), this.deps.quarantine.lastError(pluginId));
    }

    // **Read before the restore.** The restore's unload forgets the plugin's
    // harvest, so a count taken afterwards would report zero registrations for
    // every plugin the detector itself switched off.
    const calls =
      callMark === null
        ? []
        : (this.deps.recorder.callsSince?.(callMark) ?? []).filter(
            (call) => call.pluginId === pluginId,
          );
    const result: HarnessResult = {
      pluginId,
      loaded,
      loadError,
      calls,
      throws: calls.filter((call) => call.threw !== null),
      writes: gate
        .writes()
        .slice(mark.writes)
        // The enabled-set write the lifecycle makes on the way in carries
        // `pluginId: null` — it is this host's bookkeeping, not the plugin's —
        // and so does the one the restore makes on the way out.
        .filter((write) => write.pluginId === pluginId),
      // **Windowed, not attributed**, because a `RecordedRefusal` carries no
      // plugin id: the refusal is raised below every surface that knows one.
      // The window is the whole attribution available, and the detector
      // serializes its runs, so what it holds is what this load provoked.
      refusals: gate.refusals().slice(mark.refusals),
      harvest: {
        commands: this.deps.harvest.commands().filter((row) => row.pluginId === pluginId).length,
        menuHooks: this.deps.harvest.menuHooks().filter((row) => row.pluginId === pluginId).length,
        protocolHandlers: this.deps.harvest
          .protocolHandlers()
          .filter((row) => row.pluginId === pluginId).length,
        unreachable: this.deps.harvest.unreachable().filter((row) => row.pluginId === pluginId)
          .length,
      },
      harnessLimits,
    };

    if (!wasEnabled) {
      // Put the enabled set back, whether or not the load worked: a failed
      // `enableLate` has already written the plugin into it (that order is the
      // lifecycle's, and it is the one that fails safely for a real enable).
      // A failure here is the host's, not the plugin's, and must not turn a
      // finished probe into a refusal.
      //
      // **`preserveDiagnostics`, because this is a restore and not a
      // decision.** A user's `disable` forgets the plugin's failure window and
      // its load failure on purpose — the next enable should start from
      // nothing — but a detector that forgot them would clear the host's
      // answer to "why isn't this running" for every plugin it probed, and
      // would hand a plugin sitting at four of five failures a clean slate.
      try {
        await this.deps.lifecycle.disable(pluginId, { preserveDiagnostics: true });
      } catch (error) {
        harnessLimits.push(`could not disable ${pluginId} after the run: ${messageOf(error)}`);
      }
    }
    // **Last, and only this run's rows.** The gate is the host's, and its log
    // is what an operator reads to decide whether a dry run is safe to perform
    // for real. Everything between the two marks was caused by the detector
    // loading a plugin nobody asked to run — two enabled-set rewrites that
    // cancel out, and whatever the probed plugin's `onload` did — so leaving
    // them would tell that operator the host intends writes it does not. The
    // rows are already copied into `result`, which is where they belong.
    gate.dropSince(mark);
    if (result.writes.length > 0) {
      harnessLimits.push(
        "this run's recorded writes were taken back out of the host's dry-run log, but the " +
          "dry-run overlay still reflects them: a note this probe modified reads back modified " +
          "for the rest of the session",
      );
    }
    return result;
  }

  private inDryRun(): boolean {
    return this.deps.config.dryRun && this.deps.writes instanceof DryRunGate;
  }

  private gateOrRefuse(): DryRunGate {
    const gate = this.deps.writes;
    if (!this.deps.config.dryRun || !(gate instanceof DryRunGate)) {
      throw new HostError(
        DETECTOR_REQUIRES_DRY_RUN,
        "a harness run loads the plugin for real, so this host will only do it under --dry-run: " +
          "every write the plugin makes is then recorded instead of performed. Start the host " +
          "with --dry-run, or ask for the scan alone.",
      );
    }
    return gate;
  }

  private async versionOf(pluginId: string): Promise<string> {
    try {
      return (await this.deps.dir.readManifest(pluginId)).version;
    } catch {
      // A manifest this host cannot read is a plugin it cannot name a version
      // for, and an empty string says that without pretending to a number.
      return "";
    }
  }
}

/**
 * An error's message **and its causes**, which is where the plugin's own is.
 *
 * A failed `onload` reaches a caller three layers deep: the loader wraps the
 * plugin's throw in `PluginLoadFailed` ("threw during onload and has been
 * rolled back"), and the sequencer's `enableLate` wraps that again ("could not
 * be enabled"). Both sentences are worth keeping — they say where the failure
 * was caught — but neither is the one the plugin author needs, and a
 * `loadError` that stopped at the outermost would report every broken plugin
 * with the same words. So the chain is walked and joined.
 */
/** `message`, with the plugin's own last error appended when it adds anything. */
function withLastError(message: string, last: Error | null): string {
  if (last === null || message.includes(last.message)) return message;
  return `${message}: ${last.message}`;
}

function messageOf(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (!(current instanceof Error)) {
      messages.push(typeof current === "string" ? current : JSON.stringify(current));
      break;
    }
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(": ");
}
