/**
 * The five-way API policy table, and the one way this host refuses a call.
 *
 * Every surface a plugin can touch is one of five things, and saying which is
 * the whole point of the compatibility report: `implemented` (the host does the
 * real thing), `harvested` (the call is recorded and answered rather than
 * performed, because there is no GUI to perform it in), `safe_stub` (an inert
 * value that lets the plugin keep going), `absent` (a typed throw) and
 * `absent_field` (a field-shaped symbol that is simply not there, so a reader
 * gets `undefined` and nothing throws). Task 8 and Task 11a/11b build the
 * report out of {@link policyOf} and {@link declaredSymbols}, so the names here
 * are the names that reach a human.
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

/**
 * What this host claims about one symbol.
 *
 * **`absent` and `absent_field` are separated because `absent` meant two
 * things.** A callable declared `absent` throws {@link HeadlessUnsupported}
 * when a plugin reaches it, and the throw is the claim — the detector records
 * it with a `threw` message and a reader of the compatibility report can see
 * which plugins hit it. A *field-shaped* symbol — `CachedMetadata.footnotes`
 * and the two beside it, the frontmatter fields `vaultd` does not parse — is
 * never called at all: it is read off an object, the read answers `undefined`,
 * and nothing throws or is recorded. Declaring both `absent` made the table say
 * "typed throw" about three rows where the honest answer is "not populated", so
 * a report could count a missing field as a refusal. The two are different
 * claims, so they are different kinds.
 *
 * A fifth kind rather than a note on the row because the distinction has to
 * hold for a machine: every filter in this host that means "this host refused
 * it" is written `policy === "absent"`, and a note beside the row would leave
 * each of those filters free to be wrong. `absent_field` never reaches the wire
 * in a recorded call — nothing records a field read, because there is no call
 * site to record from — so it appears in the policy table and nowhere else.
 */
export type ApiPolicy = "implemented" | "harvested" | "safe_stub" | "absent" | "absent_field";

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

/**
 * Where a dry run's refusals are tallied: `DryRunGate` installs itself here for
 * its lifetime, and nothing else implements this.
 *
 * **Beside the policy recorder, and installed the same way, because it has the
 * same problem.** The three surfaces that refuse under `--dry-run` — the HTTP
 * helpers, the electron stub and the module patch — sit several layers below
 * anything holding the host, and two of them are reached through a frozen
 * barrel or a `Module._load` patch no host can thread an argument through. So
 * the sink is module-level and installed from outside, exactly as
 * {@link setPolicyRecorder} is, and is taken back out by the assembly's
 * teardown.
 */
export interface DryRunRefusalSink {
  record(surface: string, detail: string): void;
}

let refusalSink: DryRunRefusalSink | null = null;

/**
 * Install the sink every {@link refuseInDryRun} hit is tallied into.
 *
 * **Last installed wins**, like the recorder. One host per process is the
 * supported shape, so the displacement only happens in a test that builds two
 * — and {@link currentDryRunRefusalSink} is what lets a gate check whether it
 * is still the owner before taking the sink back out.
 */
export function setDryRunRefusalSink(next: DryRunRefusalSink | null): void {
  refusalSink = next;
}

/** Who is installed right now. For an owner check on the way out; nothing else. */
export function currentDryRunRefusalSink(): DryRunRefusalSink | null {
  return refusalSink;
}

/**
 * Records the hit against the current plugin **and** against the dry-run sink,
 * then throws {@link DryRunRefused}.
 *
 * Two records of two different facts, rather than one fact written twice. The
 * policy recorder answers "which surfaces did this plugin reach for", which is
 * true of this host whatever mode it is in; the sink answers "what did this run
 * refuse", which is a property of the run. A report that read the first as the
 * second would call every refusal a missing surface.
 */
export function refuseInDryRun(symbol: string, surface: string, detail?: string): never {
  // Recorded at the symbol's own declared policy: a surface this host really
  // implements is still implemented, and a report that relabelled it `absent`
  // because one run was pretending would be describing the flag, not the host.
  recorder?.record(symbol, policyOf(symbol), pluginId);
  // `detail ?? symbol` rather than an empty string: a refusal row with nothing
  // in its detail column is a row a reader cannot act on, and the symbol is the
  // least this host always knows.
  refusalSink?.record(surface, detail ?? symbol);
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
  record(symbol: string, policy: ApiPolicy, pluginId: string | null, threw?: string | null): void;
  entries(): readonly { symbol: string; policy: ApiPolicy; pluginId: string | null; hits: number }[];
  /**
   * The ordered call log, when this recorder keeps one — Task 20's detector is
   * the only reader, and `memoryPolicyRecorder({ recordCalls: true })` the only
   * writer.
   *
   * **Optional, and both halves together.** A tally answers "what did this
   * plugin reach for", which is what a compatibility report prints; a sequence
   * answers "in what order, and which of them threw", which is what a harness
   * run is. They are different questions and the second one costs memory that
   * grows with the length of a session, so a recorder is allowed not to have
   * one — see {@link PolicyRecorder.callMark} for how a reader windows it.
   */
  callMark?(): number;
  callsSince?(mark: number): readonly RecordedApiCall[];
}

/**
 * One call into the shim, as the detector reads it back.
 *
 * `threw` is the message of the refusal, or `null` for a call that answered.
 * It is set on the `absent`/{@link unsupported} path, which is the throw that
 * says something about *this host's surface*. A `DryRunRefused` is deliberately
 * **not** recorded as a throw: it says something about the run — the same call
 * on the same host succeeds with the flag off — and a detector that reported it
 * as a failed symbol would read every dry run as a list of missing surfaces,
 * which is the exact confusion {@link DryRunRefused} exists to prevent.
 */
export interface RecordedApiCall {
  readonly symbol: string;
  readonly pluginId: string | null;
  readonly policy: ApiPolicy;
  readonly threw: string | null;
  readonly atUnixMs: number;
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
 * same as the answer for a name declared absent. Never `absent_field`: a field
 * this host does not populate is a row somebody wrote down deliberately, and
 * guessing that an unknown name is one would be inventing the claim.
 */
export function policyOf(symbol: string, profile: HostProfile = "headless"): ApiPolicy {
  if (profile === "screen") {
    const screen = screenDeclarations.get(symbol);
    if (screen !== undefined) return screen;
  }
  return declarations.get(symbol) ?? "absent";
}

/**
 * Which host a policy row describes. `headless` is the shipped host with the
 * inert stub document; `screen` is the second profile that runs screen plugins
 * over a real server DOM (docs/design/web-plugins.md, section 2).
 */
export type HostProfile = "headless" | "screen";

/**
 * The screen profile's own rows, **a second column rather than an edit of the
 * first**: a symbol the screen host implements over its server DOM (`document`,
 * the DOM helpers) reads `implemented` here and stays `safe_stub` in the
 * headless table. A symbol with no row here reads as its headless row.
 */
const screenDeclarations = new Map<string, ApiPolicy>();

/** Declare a symbol's policy in the screen profile. Never touches a headless row. */
export function declareScreenPolicy(symbol: string, policy: ApiPolicy): void {
  screenDeclarations.set(symbol, policy);
}

/** The symbols the screen profile has a row of its own for. */
export function screenSymbols(): readonly string[] {
  return [...screenDeclarations.keys()];
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

/**
 * Records the hit against the current plugin, then throws HeadlessUnsupported.
 *
 * The error is built **before** the record so the message can go into it: a
 * detector reading the ordered call log is answering "what happened when this
 * plugin reached for that", and "it threw" without the sentence is half an
 * answer. The plugin sees exactly the error it always did.
 */
export function unsupported(symbol: string, detail?: string): never {
  const refusal = new HeadlessUnsupported(symbol, pluginId, detail);
  recorder?.record(symbol, "absent", pluginId, refusal.message);
  throw refusal;
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
 * that knows which plugin is running.
 *
 * **What the window covers, exactly, and what it does not.** The dispatch queue
 * is the ordinary caller, and because it is a strict FIFO there is never a
 * second *plugin* running inside the window this opens. That is all the FIFO
 * says. The window is open across every `await` inside `body`, so it is as wide
 * as the longest wait in a plugin's entry point, and **anything else that runs
 * in the process while a plugin is parked reads that plugin's id** — a timer
 * callback of the host's own, or an operation arriving on a road that is not the
 * queue. Two consequences, both measured by the final review:
 *
 * - **The client road pins itself to `null`.** `server/ops.ts`'s dispatch does
 *   not go through the queue, so it opens its own `enterPlugin(null, …)` window
 *   rather than inheriting whoever happens to be parked. Without it a client's
 *   `write_note` was recorded against a parked plugin and then dropped from the
 *   dry-run transcript by that plugin's own compatibility probe.
 * - **A host-internal callback inside a parked window still inherits the id.**
 *   A bare timer firing while a plugin waits is attributed to that plugin, which
 *   can count a host-internal failure toward its quarantine. That residual is
 *   documented under "Known limits" in `docs/design/headless-plugin-host.md`
 *   rather than papered over: closing it needs context propagation across every
 *   entry point (`AsyncLocalStorage`), which would undo the correctness property
 *   {@link enterPluginSync}'s second caller exists for.
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
 * The synchronous counterpart, for a window that **must** open and close inside
 * one turn.
 *
 * Three callers, each for its own reason:
 *
 * - `app.commands.executeCommandById` (`shim/commands.ts`), which is
 *   synchronous in Obsidian and whose boolean plugins branch on;
 * - `ShimEventBus.tryTrigger` (`shim/events.ts`), because a fan-out is
 *   synchronous and each handler has to run attributed to the plugin that
 *   **registered** it rather than to whoever raised the event — Task 20 found
 *   the hole, where a bystander's API hits were recorded against the plugin
 *   whose `onload` had triggered the event;
 * - `DispatchQueue.runInline` (`runtime/queue.ts`), the nesting arm of the
 *   queue, which dispatches inside another entry point rather than awaiting a
 *   slot of its own.
 *
 * `enterPlugin` cannot do this: an `async` function returns to its caller at
 * the first `await`, with the id still set.
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
