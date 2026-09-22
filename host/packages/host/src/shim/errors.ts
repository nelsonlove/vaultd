/**
 * Where a failure goes when there is nobody to hand it back to.
 *
 * Most of this host's errors have a caller: a plugin asks for a file, the
 * daemon refuses, the rejection travels back up the promise. These are the
 * other kind — a plugin's `onunload` throwing while the host tears it down, a
 * teardown callback throwing on the way out, a `file-menu` hook throwing while
 * a menu is being built, a `data.json` that is not JSON. Nothing is waiting on
 * any of them, and every one of them must not propagate: a throw on the unload
 * path would strand the rest of the teardown, and the plugin most likely to
 * throw there is exactly the one a quarantine is trying to remove.
 *
 * So they are **reported** instead, with the plugin they belong to and the
 * phase they happened in. Task 14b's quarantine listens here to decide which
 * plugin to stop trusting; the harness listens so a case can assert that a
 * failure was seen rather than swallowed; and when nobody listens at all the
 * report still lands in {@link HostErrors.entries} and on the process's error
 * stream, because a host that loses a plugin's crash silently is a host nobody
 * can debug.
 */

/**
 * Which part of a plugin's life a failure happened in.
 *
 * `command` is the one nobody is waiting on for a reason worth stating: a
 * command callback may be `async`, and `executeCommandById` is synchronous, so
 * the rejection of a command a plugin started has no caller left to reach. It
 * lands here instead of becoming an unhandled rejection with no plugin name on
 * it.
 *
 * `event` is a listener that threw while the host was fanning a vault or
 * metadata change out to it. Nobody is waiting on one either: `ShimEventBus`
 * catches per listener so that one plugin's exception cannot skip every other
 * plugin's handler, and the report is what turns "swallowed" into "attributed".
 * Task 15's sequencer pairs it with the event's own name — the detail
 * `vault:rename` gives the quarantine the label `event:vault:rename`.
 *
 * `config` is the host's own failure rather than any plugin's, and it carries
 * the plugin id `"host"`: a damaged `community-plugins.json`, a coexistence
 * poll whose read failed, a subscriber to that poll that threw. It is a
 * separate phase rather than a stretched `plugin-data` so that Task 14b's
 * quarantine — which counts failures *per plugin* to decide which one to stop
 * trusting — can tell "the host could not read its own config" apart from "this
 * plugin keeps breaking", and never quarantines anything on the strength of the
 * former.
 *
 * `interaction` is a brokered prompt that failed with nobody looking: most
 * plugins call `modal.open()` without awaiting it, so a timeout or a detach has
 * no caller left to reach and would otherwise be a process-level
 * `unhandledRejection` naming nothing. It is attributed to the plugin that
 * asked — so `lastError` can say what went wrong — and, like `config`, it is
 * **never counted** toward a quarantine: a human who closed their laptop is not
 * evidence that a plugin is broken, and five abandoned prompts would otherwise
 * disable one that works. See `runtime/quarantine.ts`.
 */
export type HostErrorPhase =
  | "onload"
  | "onunload"
  | "teardown"
  | "menu-hook"
  | "plugin-data"
  | "command"
  | "event"
  | "config"
  | "interaction";

/**
 * The plugin id the host reports its own failures under.
 *
 * **One definition, named here because this is where a report's `pluginId`
 * field is declared.** It had three: `shim/commands.ts` used it for a command
 * invoked with no plugin on the stack, `pluginset/config-dir.ts` for a config
 * file it could not read, and `runtime/quarantine.ts` for the id it refuses to
 * count against. Three string literals for one fact is three chances for a
 * rename to leave the quarantine counting the host's own bugs against a plugin
 * called `"host"`, which would disable working plugins one at a time until
 * somebody noticed. `runtime/quarantine.ts` re-exports it, so a caller that
 * thinks of it as a quarantine concept still finds it there.
 *
 * Nothing under this id is ever a plugin, so nothing under it is ever counted.
 */
export const HOST_PLUGIN_ID = "host";

export type HostErrorListener = (error: unknown, pluginId: string, phase: HostErrorPhase) => void;

export interface HostErrorEntry {
  readonly error: unknown;
  readonly pluginId: string;
  readonly phase: HostErrorPhase;
}

/** How many reports are kept, so a plugin failing in a loop cannot grow without bound. */
const KEPT = 256;

export class HostErrors {
  private readonly listeners = new Set<HostErrorListener>();
  private readonly recent: HostErrorEntry[] = [];

  /** Listen to every report. Returns the function that stops listening. */
  onError(listener: HostErrorListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** The reports still kept, oldest first. */
  entries(): readonly HostErrorEntry[] {
    return [...this.recent];
  }

  /**
   * Report one failure. Never throws — including when a listener does.
   *
   * A listener that throws is dropped on the floor deliberately: this is the
   * last place left to report to, and re-entering the same fan-out would be an
   * unbounded loop.
   */
  report(error: unknown, pluginId: string, phase: HostErrorPhase): void {
    this.recent.push({ error, pluginId, phase });
    if (this.recent.length > KEPT) this.recent.splice(0, this.recent.length - KEPT);
    if (this.listeners.size === 0) {
      // The floor. Task 22's `main.ts` registers a real logger, and every
      // harness registers a collector, so this is reached only by a host that
      // asked for neither — where losing the report silently would be worse
      // than one line on stderr.
      console.error(`[vaultd-host] ${pluginId} failed during ${phase}`, error);
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(error, pluginId, phase);
      } catch {
        // Nowhere left to report to.
      }
    }
  }
}
