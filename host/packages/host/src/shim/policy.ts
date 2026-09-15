/**
 * The four-way API policy table, and the one way this host refuses a call.
 *
 * Every surface a plugin can touch is one of four things, and saying which is
 * the whole point of the compatibility report: `implemented` (the host does the
 * real thing), `harvested` (the call is recorded and answered rather than
 * performed, because there is no GUI to perform it in), `safe_stub` (an inert
 * value that lets the plugin keep going) and `absent` (a typed throw). Task 8
 * and Task 11a/11b build the report out of {@link policyOf} and
 * {@link declaredSymbols}, so the names here are the names that reach a human.
 *
 * **Module-level, deliberately.** A policy lookup happens inside a getter on a
 * frozen barrel object, several layers below anything holding a reference to
 * the host, so threading a table through every call site would mean every call
 * site could be handed the wrong one — or none. There is one host per process
 * (`main.ts` starts one), so one table per module is the same table.
 *
 * The two pieces of mutable state that are *not* the table — the recorder and
 * the current plugin — are installed from outside: {@link setPolicyRecorder} by
 * the assembler, {@link enterPlugin} by the dispatch queue. Both are restored
 * on the way out, so a host torn down and rebuilt in one process (a test) does
 * not inherit the previous one's.
 */

export type ApiPolicy = "implemented" | "harvested" | "safe_stub" | "absent";

/**
 * ONE constructor signature, used at every call site in this plan. `name` is
 * derived, never passed; `message` always contains the symbol so a stack trace
 * with no structured logging is still diagnosable; `policy` is a literal
 * because an unsupported throw is by definition the `absent` policy.
 *
 * `detail` is where a subclass name goes (`Modal.open` naming the actual
 * subclass) or a channel name (`ipcRenderer.invoke` naming the channel). It is
 * appended to the message and never changes the shape.
 */
export class HeadlessUnsupported extends Error {
  readonly code = "headless_unsupported";
  readonly symbol: string;
  readonly pluginId: string | null;
  readonly policy = "absent" as const;
  readonly detail: string | null;
  constructor(symbol: string, pluginId: string | null, detail?: string) {
    super(
      detail === undefined
        ? `${symbol} is not available headless`
        : `${symbol} is not available headless (${detail})`,
    );
    this.name = "HeadlessUnsupported";
    this.symbol = symbol;
    this.pluginId = pluginId;
    this.detail = detail ?? null;
  }
}

/**
 * The other way this host refuses: the mode said no, rather than the surface.
 *
 * **A different error from {@link HeadlessUnsupported}, because it is a
 * different claim.** "This host has no window manager" is permanent and is what
 * the compatibility report is about; "this run was told to change nothing" is a
 * property of the run, and the same call on the same host succeeds with the
 * flag off. A reader who could not tell them apart would read every dry-run
 * report as a list of missing surfaces.
 *
 * `surface` is the group a dry-run report tallies by — `os_bridge` for the
 * `electron.shell` openers, and the names Task 19 adds for writes and network.
 * The code is in the message so a stack trace with no structured logging still
 * says which of the two refusals happened.
 *
 * Declared here beside {@link HeadlessUnsupported} because the two are the
 * host's whole refusal vocabulary and a caller should meet them in one place.
 * Task 19 owns dry-run itself and may relocate this; the type is what callers
 * name, so a move costs them nothing.
 */
export class DryRunRefused extends Error {
  readonly code = "dry_run_refused";
  readonly symbol: string;
  readonly pluginId: string | null;
  readonly surface: string;
  readonly detail: string | null;
  constructor(symbol: string, pluginId: string | null, surface: string, detail?: string) {
    super(
      `dry_run_refused: ${symbol} is a ${surface} and this host is in dry-run` +
        (detail === undefined ? "" : ` (${detail})`),
    );
    this.name = "DryRunRefused";
    this.symbol = symbol;
    this.pluginId = pluginId;
    this.surface = surface;
    this.detail = detail ?? null;
  }
}

/** Records the hit against the current plugin, then throws {@link DryRunRefused}. */
export function refuseInDryRun(symbol: string, surface: string, detail?: string): never {
  // Recorded at the symbol's own declared policy: a surface this host really
  // implements is still implemented, and a report that relabelled it `absent`
  // because one run was pretending would be describing the flag, not the host.
  recorder?.record(symbol, policyOf(symbol), pluginId);
  throw new DryRunRefused(symbol, pluginId, surface, detail);
}

/**
 * The tally behind the compatibility report.
 *
 * An interface rather than a class because the host has exactly one ordinary
 * implementation (`memoryPolicyRecorder`, beside the assembler) and every other
 * one is a test's own. Counting per `(symbol, plugin)` rather than per call is
 * what makes the report readable.
 */
export interface PolicyRecorder {
  record(symbol: string, policy: ApiPolicy, pluginId: string | null): void;
  entries(): readonly { symbol: string; policy: ApiPolicy; pluginId: string | null; hits: number }[];
}

const declarations = new Map<string, ApiPolicy>();
let recorder: PolicyRecorder | null = null;
let pluginId: string | null = null;

/**
 * Declare what a symbol is. Last declaration wins.
 *
 * Called from the barrel builder (Task 11b) as it binds each name, and from any
 * surface that wants its own policy in the report. It is the **only** thing
 * that puts a name in {@link declaredSymbols}: a recorded hit does not, because
 * the table is the host's claim about its own surface and a hit is a plugin's
 * behaviour. Task 11b asserts `declaredSymbols()` equals its table exactly, and
 * a hit that quietly added a row would break that for no gain.
 */
export function declarePolicy(symbol: string, policy: ApiPolicy): void {
  declarations.set(symbol, policy);
}

/**
 * What a symbol is, defaulting to `absent`.
 *
 * Undeclared means absent on purpose: a name nobody bound is a name this host
 * does not have, and the honest answer to "what is your policy for it" is the
 * same as the answer for a name declared absent.
 */
export function policyOf(symbol: string): ApiPolicy {
  return declarations.get(symbol) ?? "absent";
}

/**
 * Every symbol in the table, in declaration order.
 *
 * **Complete at import, for the modules that declare.** A shim module that
 * declares its rows does so at module scope — `shim/metadata-cache.ts` is the
 * one that does today; `shim/vault.ts` declares nothing yet — so importing a
 * module is all it takes for its surface to appear here, with nothing
 * constructed. That is what lets a compatibility report be generated by a path
 * that never opens a vault.
 */
export function declaredSymbols(): readonly string[] {
  return [...declarations.keys()];
}

/**
 * The rows the imports declared, captured by the **first** call to
 * {@link resetPolicyTable}.
 *
 * **This module cannot capture it on its own, and that is a fact about the
 * loader rather than a shortcut.** "At load" cannot mean *this* file's load:
 * `shim/metadata-cache.ts` declares its twelve rows at its own module scope and
 * reaches them by importing this file, so this body runs first with the table
 * empty. Nor can a microtask queued here stand in for "when the graph has
 * finished" — Vite's SSR transform awaits every import, so the graph is loaded
 * asynchronously and a microtask queued during this body fires long before
 * `testing/assemble.ts` has pulled in the module that declares. Measured: the
 * snapshot came out empty and the restore produced `[]`.
 *
 * So the capture is where a caller can put it at a moment that provably works:
 * **call {@link resetPolicyTable} once at your test file's module scope**,
 * which runs after that file's own imports have evaluated and before any hook
 * or case. `policy.test.ts` does exactly that, and pins it with a case that
 * declares a symbol in a `beforeAll` and asserts the reset drops it — so a
 * future file that moves the first call later fails loudly instead of baking an
 * invented symbol into the set for the rest of the process.
 */
let importTimeDeclarations: ReadonlyArray<readonly [string, ApiPolicy]> | null = null;

/**
 * Put the table back to what the imports declared. **Tests only.**
 *
 * **It restores rather than empties**, and the difference is the point.
 * Declarations are module-scoped: they land the moment a module is imported and
 * there is no un-importing them, so a test file whose import graph reaches a
 * shim module inherits that module's rows. A test asserting "the table holds
 * exactly what I declared" needs those rows gone — but a test asserting "the
 * table is the host's whole surface" (Task 11b's compatibility report) needs
 * them **there**, and an emptying reset would leave whichever test ran second
 * looking at a table some earlier test had hollowed out.
 *
 * Restoring to the import-time set satisfies both by construction: after a
 * reset the table is exactly what a freshly imported process would hold, which
 * is the only state either kind of test can reason about — and the set itself
 * is captured by {@link importTimeDeclarations}'s own microtask rather than by
 * whoever calls this first, so it does not matter where in a file's lifecycle
 * the reset lands.
 *
 * Nothing in production may call it. A host that reset its own policy table
 * mid-run would discard every row a later module had added.
 */
export function resetPolicyTable(): void {
  // The first call is the capture — see {@link importTimeDeclarations} for why
  // this module cannot take the snapshot itself, and why that first call
  // belongs at a test file's module scope rather than in a hook.
  importTimeDeclarations ??= [...declarations.entries()];
  declarations.clear();
  for (const [symbol, policy] of importTimeDeclarations) declarations.set(symbol, policy);
}

/**
 * Answer with an inert value and record that the plugin asked.
 *
 * The record is the point. A stub that answered silently would leave the
 * compatibility report unable to say which plugins depend on the thing that is
 * not really there — which is exactly what a reader of that report is asking.
 */
export function stub<T>(symbol: string, value: T): T {
  recorder?.record(symbol, "safe_stub", pluginId);
  return value;
}

/** Records the hit against the current plugin, then throws HeadlessUnsupported. */
export function unsupported(symbol: string, detail?: string): never {
  recorder?.record(symbol, "absent", pluginId);
  throw new HeadlessUnsupported(symbol, pluginId, detail);
}

/**
 * Record one ordinary use of a declared symbol, at whatever policy it declares.
 *
 * The counterpart to {@link stub} for surfaces that really do the work: the
 * report is about what plugins reach for, and a surface that is `implemented`
 * is still worth counting.
 */
export function recordUse(symbol: string): void {
  recorder?.record(symbol, policyOf(symbol), pluginId);
}

/** The plugin whose call is running right now — set by the dispatch queue. */
export function currentPluginId(): string | null {
  return pluginId;
}

/** Install the tally every `stub`/`unsupported`/`recordUse` reports into. */
export function setPolicyRecorder(next: PolicyRecorder | null): void {
  recorder = next;
}

/**
 * Run `body` with `id` as the current plugin, and restore whatever was current
 * before — nesting included.
 *
 * Attribution is ambient rather than a parameter for the same reason the event
 * bus's is: the surfaces that record hits are several layers below anything
 * that knows which plugin is running. The dispatch queue is the one caller, and
 * because it is a strict FIFO there is never a second plugin running inside the
 * window this opens.
 */
export async function enterPlugin<T>(
  id: string | null,
  body: () => Promise<T> | T,
): Promise<T> {
  const previous = pluginId;
  pluginId = id;
  try {
    return await body();
  } finally {
    pluginId = previous;
  }
}

/**
 * The synchronous counterpart, for an entry point that **must** answer without
 * awaiting.
 *
 * There is exactly one: `app.commands.executeCommandById`, which is synchronous
 * in Obsidian and whose boolean plugins branch on. Its attribution window has to
 * open and close inside one turn, and `enterPlugin` cannot do that — an `async`
 * function returns to its caller at the first `await`, with the id still set.
 *
 * A promise the body returns is **not** covered by this window: the id is
 * restored when the body returns, not when its promise settles. That is the
 * honest boundary — a callback that continues after an `await` is no longer
 * inside anything this function can attribute — and the queue's asynchronous
 * {@link enterPlugin} is what covers the paths that can wait.
 */
export function enterPluginSync<T>(id: string | null, body: () => T): T {
  const previous = pluginId;
  pluginId = id;
  try {
    return body();
  } finally {
    pluginId = previous;
  }
}
