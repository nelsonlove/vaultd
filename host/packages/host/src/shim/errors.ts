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

/** Which part of a plugin's life a failure happened in. */
export type HostErrorPhase = "onload" | "onunload" | "teardown" | "menu-hook" | "plugin-data";

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
