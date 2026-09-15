/**
 * Refusing to run a plugin that a GUI Obsidian is already running.
 *
 * `config-dir.ts` gives the host its own configuration directory, which keeps
 * the two copies of a plugin's `data.json` structurally apart. That fixes the
 * settings race and nothing else, because a plugin's interesting behaviour is
 * not in its settings file:
 *
 * - **Event double-fire.** Both instances see the same vault events through
 *   their own watchers. folder-notes creates a folder note per new folder, so
 *   two instances create two; obsidian-linter runs a lint pass per save, so two
 *   instances run two, each over the other's output.
 * - **Port binding.** Three plugins in the census bind a server socket at load.
 *   The second binder either fails — a plugin that throws in `onload` is a
 *   plugin that never finished loading — or wins the port from the instance the
 *   user is actually looking at.
 *
 * Neither is something a host can arbitrate after the fact, so the answer is to
 * refuse before loading and to say exactly why. `--force-shared <id>` admits a
 * named plugin for the operator who knows their plugin is inert on both counts;
 * the refusal names the two consequences by hand so that the flag is reached for
 * after reading them rather than instead of.
 *
 * **Why this polls, and what the poll honestly covers (Ruling W7).** The daemon
 * emits `config_changed` for raw writes into `.obsidian/` *that it performs* —
 * this host's, or another vaultd client's. A GUI Obsidian editing
 * `.obsidian/community-plugins.json` through its own file writer is not watched
 * and raises nothing. There is therefore no event to subscribe to for "the user
 * just enabled a plugin in the GUI", and a poll is the honest mechanism rather
 * than a lazy one. `overlapPollMs` (60 s) is the width of the window in which
 * this host can be wrong, and it is reported through `host_info` instead of
 * being hidden.
 *
 * **The poll tick is also where every other external config edit is noticed.**
 * The same silence covers `core-plugins.json`, `daily-notes.json`,
 * `bookmarks.json` and `app.json`: a GUI edit of any of them reaches no
 * subscriber. So {@link CoexistenceMonitor.onPoll} exists for the assembly to
 * hang `InternalPluginRegistry.refresh()` and `Vault.configReady()` off — one
 * timer for one class of problem, rather than three timers that each notice a
 * third of it at a different moment.
 */

import { OBSIDIAN_CONFIG_DIR } from "./config-dir";
import type { HeadlessConfigDir } from "./config-dir";
import type { HostConfig } from "../config";
import type { ReadFileResponse } from "../client/protocol";
import type { VaultdClient } from "../client/client";

/** What the two enabled sets say, and what that implies, at one instant. */
export interface OverlapReport {
  /** `<configDir>/community-plugins.json`, in file order. */
  readonly hostEnabled: readonly string[];
  /** `.obsidian/community-plugins.json`, or `[]` when it could not be read. */
  readonly guiEnabled: readonly string[];
  /** Ids in both sets, in `hostEnabled` order. Always `[]` when not readable. */
  readonly overlap: readonly string[];
  /** The `--force-shared` ids: admitted regardless of what the GUI says. */
  readonly forced: readonly string[];
  /**
   * Did Obsidian's own `community-plugins.json` actually answer?
   *
   * **An overlap can only be asserted when this is true.** False means the file
   * was absent, unreadable, or not the shape it should be — a vault with no GUI
   * Obsidian, a vault whose Obsidian has never enabled a community plugin, or a
   * genuinely broken file. None of those is a conflict, and none of them is
   * evidence of the *absence* of a conflict either. The report says which it is
   * rather than letting an empty `overlap` stand for both.
   */
  readonly guiReadable: boolean;
  /** `config.clock.now()` at the read, never `Date.now()`. */
  readonly checkedAtMs: number;
}

/** A refusal to enable a plugin the GUI is already running. */
export class OverlapRefused extends Error {
  readonly code = "overlap_refused";
  readonly pluginId: string;
  /**
   * A stable machine-readable tag, not the prose.
   *
   * The sentence a human needs is the `message`, and it is long on purpose. A
   * JSON-RPC caller that wants to branch on the refusal needs something that
   * does not change when that sentence is reworded, so it gets this.
   */
  readonly reason: string;

  constructor(pluginId: string, message: string, reason = "gui_enabled") {
    super(message);
    this.name = "OverlapRefused";
    this.pluginId = pluginId;
    this.reason = reason;
  }
}

/** A callback the poll runs, so external config edits are noticed with it. */
export type PollHook = () => void | Promise<void>;

export class CoexistenceMonitor {
  private readonly dir: HeadlessConfigDir;
  private readonly client: VaultdClient;
  private readonly config: HostConfig;

  private timer: NodeJS.Timeout | null = null;
  private report: OverlapReport | null = null;
  private readonly overlapSubscribers = new Set<(report: OverlapReport) => void>();
  private readonly pollSubscribers = new Set<PollHook>();
  /** The poll's own check, so two ticks never interleave two reads. */
  private polling: Promise<void> | null = null;

  constructor(dir: HeadlessConfigDir, client: VaultdClient, config: HostConfig) {
    this.dir = dir;
    this.client = client;
    this.config = config;
  }

  /**
   * Read both enabled sets and compare them.
   *
   * The host's side is `HeadlessConfigDir.readEnabledSet`, which is loud about a
   * corrupt file; Obsidian's side is read directly through `read_file` rather
   * than through the directory's config ladder, because the ladder would answer
   * with the *host's* copy and this is the one question in the host where the
   * two files must not be allowed to stand in for each other.
   *
   * Recording the result is part of the operation: {@link latest} is what
   * `host_info` reports, and a `check()` whose answer went only to its caller
   * would leave the reported state older than the state the host acted on.
   */
  async check(): Promise<OverlapReport> {
    const hostEnabled = await this.dir.readEnabledSet();
    const gui = await this.readGuiEnabled();
    const guiSet = new Set(gui ?? []);
    const report: OverlapReport = {
      hostEnabled,
      guiEnabled: gui ?? [],
      overlap: gui === null ? [] : hostEnabled.filter((id) => guiSet.has(id)),
      forced: [...this.config.forceShared],
      guiReadable: gui !== null,
      checkedAtMs: this.config.clock.now(),
    };
    this.record(report);
    return report;
  }

  /**
   * Throw {@link OverlapRefused} if the GUI already has `id` enabled.
   *
   * It re-checks rather than reading {@link latest}: this runs on the path of
   * `host.enable_plugin`, where the answer is about to be acted on, and a
   * minute-old answer is exactly the thing the poll exists to admit it cannot
   * avoid elsewhere.
   *
   * **Three ways to pass, and they are not the same.** The id is in
   * `--force-shared`; the GUI does not have it enabled; or the GUI's config
   * could not be read at all. The third is a genuine limit and not a judgement:
   * a host that refused everything it could not disprove would be unusable in
   * any vault without a GUI Obsidian, which is most headless vaults.
   */
  async assertCanEnable(id: string): Promise<void> {
    if (this.config.forceShared.includes(id)) return;
    const report = await this.check();
    if (!report.guiReadable) return;
    if (!report.guiEnabled.includes(id)) return;
    throw new OverlapRefused(id, refusalMessage(id, this.config.configDirName));
  }

  /**
   * Arm the poll. Idempotent; a second call does not stack a second timer.
   *
   * **It does not check.** The startup check belongs to whoever is starting the
   * host, because its result gates loading plugins at all and a refusal has to
   * reach that caller rather than a timer's error handler.
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = this.config.clock.setInterval(() => {
      void this.tick();
    }, this.config.overlapPollMs);
  }

  /** Disarm the poll. Idempotent, and safe to call before {@link start}. */
  stop(): void {
    if (this.timer === null) return;
    this.config.clock.clearInterval(this.timer);
    this.timer = null;
  }

  /** The last report {@link check} produced, or `null` before the first one. */
  latest(): OverlapReport | null {
    return this.report;
  }

  /**
   * Subscribe to changes in the overlap set. Returns the unsubscribe.
   *
   * **Fires on a change, not on every check.** The first report changes nothing
   * — there was no previous set for it to differ from — so it notifies nobody;
   * a subscriber that wants the current state reads {@link latest}. After that,
   * a callback means the set of doubly-enabled plugins is genuinely different
   * from the one the subscriber was last told about, which is what makes it
   * usable as a `host.overlap_changed` broadcast rather than a minute-by-minute
   * heartbeat.
   */
  onOverlapChanged(cb: (report: OverlapReport) => void): () => void {
    this.overlapSubscribers.add(cb);
    return () => {
      this.overlapSubscribers.delete(cb);
    };
  }

  /**
   * Subscribe to the poll tick itself. Returns the unsubscribe.
   *
   * This is the seam the assembly hangs the external-config re-reads off — see
   * this file's header. It runs **only** on the timer, never on an explicit
   * {@link check}: `check()` is called on every `host.enable_plugin`, and
   * re-reading four config files per enable would be round trips nobody asked
   * for.
   */
  onPoll(cb: PollHook): () => void {
    this.pollSubscribers.add(cb);
    return () => {
      this.pollSubscribers.delete(cb);
    };
  }

  /**
   * One poll tick: re-check, then run the external-config hooks.
   *
   * **Nothing here may throw.** A timer callback's rejection has no caller, and
   * a poll that died on one unreadable file would take the next fifty-nine
   * minutes' worth of ticks with it. A failed check leaves {@link latest}
   * holding the previous answer, which is the honest state: the host does not
   * know any more than it did a minute ago.
   *
   * Ticks do not overlap. A check that is somehow still in flight when the next
   * minute arrives absorbs that tick rather than starting a second read.
   */
  private tick(): Promise<void> {
    if (this.polling !== null) return this.polling;
    const run = (async (): Promise<void> => {
      try {
        await this.check();
      } catch {
        // Deliberate: see above. The previous report stands.
      }
      for (const hook of this.pollSubscribers) {
        try {
          await hook();
        } catch {
          // A subscriber's failure is its own; the next one still runs.
        }
      }
    })().finally(() => {
      this.polling = null;
    });
    this.polling = run;
    return run;
  }

  /**
   * Obsidian's enabled set, or `null` when there is no honest answer.
   *
   * `null` covers three different facts — no file, an unreadable file, a file
   * that is not an array of strings — and the monitor treats them alike because
   * its question has only one useful answer for all three: *this host cannot
   * assert an overlap*. What it must never do is turn any of them into an empty
   * list, which would read as "Obsidian has nothing enabled" and license every
   * load the refusal exists to stop.
   */
  private async readGuiEnabled(): Promise<string[] | null> {
    try {
      const response = await this.client.request<ReadFileResponse>("read_file", {
        path: `${OBSIDIAN_CONFIG_DIR}/community-plugins.json`,
      });
      const source = Buffer.from(response.content_base64, "base64").toString("utf8");
      const parsed: unknown = JSON.parse(source);
      if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) return null;
      return parsed as string[];
    } catch {
      return null;
    }
  }

  /** Install a report, and notify only if the overlap set really moved. */
  private record(report: OverlapReport): void {
    const previous = this.report;
    this.report = report;
    if (previous === null) return;
    if (sameIds(previous.overlap, report.overlap)) return;
    for (const subscriber of this.overlapSubscribers) subscriber(report);
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The refusal, in full.
 *
 * It names both consequences by hand because a refusal that does not say why is
 * a refusal someone will `--force-shared` past without thinking — and the two
 * reasons are not obvious from the outside: a user who has just been told the
 * two copies have separate settings files has every reason to assume the
 * separation is complete.
 */
function refusalMessage(id: string, configDirName: string): string {
  return (
    `refusing to enable "${id}": Obsidian has it enabled too ` +
    `(.obsidian/community-plugins.json), and a separate ${configDirName}/ directory ` +
    "only separates the two copies' settings. It does not separate what they do: " +
    "event double-fire (two folder notes per folder, two lint passes over the same write) " +
    "and port binding (three plugins in the census bind a server at load, and the second " +
    `one either fails or takes the port). Disable it in Obsidian, or pass --force-shared ${id} ` +
    "if you know this plugin does neither."
  );
}
