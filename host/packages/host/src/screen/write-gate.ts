/**
 * The screen profile's opt-in write gate: **with `--read-only` it refuses
 * every vault write.** The switch is off by default.
 *
 * The screen host loads stock plugins to read back what they do to the page.
 * By default a plugin's vault writes go through vaultd as in the headless
 * host: they are that plugin's own behaviour on one more device (the owner's
 * pick A, E20 of `docs/design/web-plugins-meta-bind.md`). The vault may be
 * kept by Obsidian Sync, where such a write reaches every device, so `--read-only`
 * (`readOnly` in `startScreenHost`) installs this gate. Then every mutation
 * the shim makes (`app.vault` create, modify, process, rename and delete, the
 * adapter's writes, `fileManager.processFrontMatter`, folder creates) goes
 * through it; it answers each with a typed {@link ScreenWriteRefused}, records
 * it, and reports it to the host's error sink with phase `write`. Nothing
 * reaches vaultd. The gate covers vault writes only; the node modules a
 * bundle may not load under `--read-only` are set in `screen-host.ts`.
 *
 * Unlike the dry-run gate it pretends nothing: a plugin that writes sees the
 * write fail, as it would on a read-only vault. The apply service does not
 * count a refusal against the apply (`apply-service.ts`), so the page is still
 * served. A plugin's own data goes through the plugin data store (the `viewer`
 * store, outside the vault), not through this gate.
 */

import { HOST_PLUGIN_ID } from "../shim/errors";
import { currentPluginId } from "../shim/policy";
import type { HostErrorPhase } from "../shim/errors";
import type { WriteGate } from "../dryrun/dry-run";

/** How many refusals the gate keeps for a reader; the count goes on past it. */
export const REFUSAL_LOG_LIMIT = 100;

/** A vault write the screen profile refused. */
export class ScreenWriteRefused extends Error {
  readonly code = "screen_write_refused";
  constructor(
    readonly method: string,
    readonly path: string | null,
    readonly pluginId: string | null,
  ) {
    super(
      `screen_write_refused: ${method}${path === null ? "" : ` ${JSON.stringify(path)}`} ` +
        `by ${pluginId ?? "the host"}: the screen host runs with --read-only`,
    );
    this.name = "ScreenWriteRefused";
  }
}

/** Is `error` a refusal of this gate (or a loader error that wraps one)? */
export function isScreenWriteRefusal(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 5; depth += 1) {
    if (at instanceof ScreenWriteRefused) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

export interface RefusedWrite {
  readonly method: string;
  readonly path: string | null;
  readonly pluginId: string | null;
}

interface ErrorSink {
  report(error: unknown, pluginId: string, phase: HostErrorPhase): void;
}

export class RefusingWriteGate implements WriteGate {
  private sink: ErrorSink | null = null;
  private readonly log: RefusedWrite[] = [];
  private total = 0;

  /** Where each refusal is reported; set once the assembly's error sink exists. */
  reportTo(sink: ErrorSink): void {
    this.sink = sink;
  }

  send<T>(method: string, params: unknown): Promise<T> {
    const pluginId = currentPluginId();
    const path = pathOf(params);
    const refusal = new ScreenWriteRefused(method, path, pluginId);
    this.total += 1;
    this.log.push({ method, path, pluginId });
    if (this.log.length > REFUSAL_LOG_LIMIT) this.log.shift();
    this.sink?.report(refusal, pluginId ?? HOST_PLUGIN_ID, "write");
    return Promise.reject(refusal);
  }

  /** Every write refused so far. */
  get refusals(): number {
    return this.total;
  }

  /** The last {@link REFUSAL_LOG_LIMIT} refusals, oldest first. */
  recent(): readonly RefusedWrite[] {
    return [...this.log];
  }
}

function pathOf(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const record = params as Record<string, unknown>;
  for (const key of ["path", "from", "source", "old_path"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}
