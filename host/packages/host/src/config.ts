import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The one time source.
 *
 * Every component whose behaviour depends on the clock takes it from
 * {@link HostConfig.clock}, never from the global — that is a Global
 * Constraint of this phase, and the reason is that a host whose timers come
 * from the globals can only be tested by waiting. Task 6b's `TestClock`
 * advances when a test says so; production uses {@link systemClock}, which is
 * five one-line delegations and exists so nothing else under `src/` ever names
 * `setTimeout` directly.
 *
 * **Plugin-facing timers come from here too** (`window.setInterval`,
 * `registerInterval`) — corrected in Task 10, where an earlier draft had them
 * using the real globals on the grounds that a plugin observing a frozen clock
 * is a plugin observing a lie. A plugin cannot tell which clock armed its
 * callback, and a host whose own timers it cannot count is a host that cannot
 * report them: `shim/timers.ts` arms every one of them on this clock, records
 * the cadence for the harvest, and the component registry still clears them on
 * unload.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

/** The real clock: a pass-through to the Node globals, and nothing else. */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => {
      clearInterval(handle);
    },
  };
}

/**
 * Everything the host reads that is not a runtime decision.
 *
 * The calibration values are fixed by the phase plan and all live here so that
 * none of them needs a protocol change to move, and so that a test can drive a
 * different value without patching a module-level constant.
 */
export interface HostConfig {
  readonly vaultRoot: string;
  readonly vaultdBinary: string;
  readonly vaultdArgs: readonly string[];
  /**
   * Extra environment for the spawned engine, merged over `process.env`. This
   * is the seam the supervisor tests drive: the fake daemon reads
   * `FAKE_VAULTD_MODE` from here, and without it there is no way to spawn the
   * fake in a chosen mode without mutating the test process's own env.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly indexPath: string | null;
  /** The vault-relative headless config directory. Written only through `write_file`. */
  readonly configDirName: string;
  /** `$XDG_STATE_HOME/vaultd-host`. One of the three places the host may write. */
  readonly dataDir: string;
  readonly socketPath: string;
  readonly clock: Clock;
  /** The version the shim reports as Obsidian's own. */
  readonly appVersion: string;
  /**
   * May a plugin reach the network through `requestUrl`/`request`?
   *
   * **True in production, false in every harness.** `requestUrl` exists in
   * Obsidian to bypass the renderer's CORS rules; a Node process has none to
   * bypass, so the honest implementation is the request itself and the policy
   * row stays `implemented`. The switch is here rather than in the policy
   * because "can this host reach the internet" is a property of the *run*, not
   * of the API: a test suite that loads real community bundles must not be able
   * to phone home, and a production host must be able to.
   *
   * When it is false, `requestUrl` and `request` throw a typed `NetworkRefused`
   * naming the URL — before any socket is opened. Task 19's dry-run gate layers
   * its own refusal on top of this one.
   */
  readonly allowNetwork: boolean;
  readonly promptTimeoutMs: number;
  readonly quarantineFailures: number;
  readonly quarantineWindowMs: number;
  readonly overlapPollMs: number;
  readonly snapshotPageSize: number;
  readonly snapshotPageSizeMax: number;
  /**
   * How many mirror-served snapshot sessions one host serves at once.
   *
   * The host's own cap, not the daemon's. A `host.open_snapshot` pins nothing
   * daemon-side — Ruling 5 answers the four snapshot ops from the mirror — so
   * the thing being bounded here is host memory: each session freezes the entry
   * array and the note path list at its generation. Eight rather than the
   * daemon's four because a host session costs a pair of arrays rather than a
   * pinned read transaction and a deferred WAL checkpoint, and because the host
   * is the door several clients come through at once. The refusal is
   * `too_many_snapshots`, which is the code the daemon answers for the same
   * condition, so a client's retry logic is identical through either door.
   */
  readonly snapshotSessionCap: number;
  /**
   * How many events one subscription may have waiting before the host stops
   * keeping them.
   *
   * The same bounded-queue discipline `vaultd`'s own subscriber registry uses,
   * and for the same reason: a client that has stopped reading must not be able
   * to grow the host. Past the limit the queue is dropped whole and the
   * subscription owes one `resync_required { reason: "subscriber_lag" }` — never
   * a truncated change set pretending to be a complete one. The host never
   * blocks on a slow subscriber.
   */
  readonly subscriberQueueLimit: number;
  /**
   * How many times a hydration retries an `open_snapshot` the daemon refused
   * with `too_many_snapshots`.
   *
   * **Retries, not attempts** — the name says which, and it is deliberately the
   * opposite convention from {@link restartBackoffMs}, whose *length* is the
   * attempt count. One attempt plus this many more, and retry `i` waits
   * `SNAPSHOT_RETRY_BACKOFF_MS[i]` first, so every rung of that ladder is used.
   *
   * The daemon caps concurrent sessions at four, and the cap is external,
   * transient, and cheap to wait out: several clients starting at once. A host
   * that treated it as fatal could not start while any other client was paging.
   */
  readonly snapshotCapRetries: number;
  /**
   * How many times a hydration may restart its walk on a lost snapshot pin.
   *
   * Separate from {@link snapshotCapRetries} because the two failures have
   * different physics. Cap contention is other clients; pin loss scales with
   * walk duration times write rate, and a restart throws away a completed walk
   * and starts again from the first page. Sharing one counter meant a couple of
   * ordinary cap retries at startup could leave a long walk with no restarts
   * left, and the host would fail to start with a raw `generation_mismatch` its
   * caller could do nothing with.
   *
   * There is no wait on this arm: the pin is already gone, so there is nothing
   * to wait for.
   */
  readonly hydrationPinLossRestarts: number;
  /**
   * How many paths a single delta may refetch before the mirror stops fetching
   * them one by one and re-hydrates instead.
   *
   * **It bounds the refetch, not the change set.** The two are not the same
   * number: the mirror adds the referrers of every created and deleted path
   * (the notes whose links that path answers, orphans or makes ambiguous) and
   * the ancestors of every changed path, so a one-path change set can imply a
   * thousand-path refetch — deleting a note that a thousand others link to is
   * exactly that. The limit is therefore tested twice: once on
   * `created + modified` when the event arrives, which is free and rejects the
   * obvious cases before any work is queued, and once on the assembled refetch
   * set, which is the only place the real size is known. Passing it takes the
   * resync road with the host-originated reason `refetch_oversized`.
   *
   * **Measured, not guessed.** Against the shipped daemon on a 1000-note vault
   * (1001 entries, each note carrying frontmatter, two wikilinks, two list
   * items and two headings):
   *
   * | what | cost |
   * | --- | --- |
   * | full hydration, warm | 102 ms |
   * | delta apply, 16 paths | 6 ms (0.38 ms/path) |
   * | delta apply, 64 paths | 10 ms (0.16 ms/path) |
   * | delta apply, 256 paths | 36 ms (0.14 ms/path) |
   * | delta apply, 1000 paths | 140 ms (0.14 ms/path) |
   *
   * The marginal cost per path is **flat at about 0.14 ms** — the
   * `mirrorWarmConcurrency` fan-out amortises the round trips completely, which
   * is what that bound is for — so the curve is a straight line rather than a
   * knee, and it crosses a full re-hydration at roughly **730 paths** on that
   * vault. The crossover only moves *up* with vault size, because a delta costs
   * O(change set) and a hydration costs O(vault).
   *
   * 512 rather than 1024, for two reasons. The mirror adds the ancestors of
   * created and deleted paths to the same `get_tree_entries` batch, so the
   * request can be larger than the change set and 512 keeps it comfortably
   * under `TREE_ENTRIES_PATH_LIMIT`. And above roughly 700 the two costs really
   * are comparable, at which point a re-hydration's coherence story — one
   * pinned snapshot, one atomic swap — is worth having.
   *
   * The value only ever governs the range 1..1024: `docs/protocol.md` has the
   * daemon report a larger change set as `counts_only` followed by
   * `resync_required { oversized_change_set }`, and both of those already take
   * the resync road. Configuration rather than a literal so a test can drive
   * the escalation without a 513-path fixture.
   */
  readonly mirrorDeltaPathLimit: number;
  /**
   * How many `read_file` calls the position warm-up keeps in flight.
   *
   * The warm-up is the one place the host reads every note's bytes, and it is
   * bounded here rather than by the daemon: the daemon answers as fast as it is
   * asked, and an unbounded fan-out over 100k notes would hold every note's
   * source in memory at once — which is the thing `PositionIndex` exists to
   * avoid.
   */
  readonly mirrorWarmConcurrency: number;
  readonly writeFileCapBytes: number;
  readonly unloadBudgetMs: number;
  /**
   * The restart ladder.
   *
   * **Its length is the number of spawn attempts, not the number of retries**,
   * and entry `i` is the wait between attempt `i` and attempt `i + 1` — so the
   * last entry is never waited on, because no attempt follows it. A ladder of
   * `[250, 500, 1000, 2000, 5000]` therefore means: try, wait 250 ms, try,
   * wait 500 ms, try, wait 1 s, try, wait 2 s, try, give up. An empty ladder
   * means one attempt and no restart at all.
   */
  readonly restartBackoffMs: readonly number[];
  /**
   * The flap ceiling: more than {@link restartFlapLimit} restarts inside this
   * many milliseconds and the supervisor stops instead of spawning again.
   *
   * The ladder alone does not bound this. Reaching readiness clears the ladder
   * — deliberately, so an engine that ran for hours and then crashed is not
   * punished for a failure hours ago — which means an engine that answers
   * `health` and then dies restarts forever, taking the index's writer lease on
   * every attempt. This is the engine-side twin of `quarantineWindowMs` /
   * `quarantineFailures` on the plugin side, and it is measured with
   * `clock.now()` like every other duration here.
   */
  readonly restartFlapWindowMs: number;
  readonly restartFlapLimit: number;
  /** Ruling 7: an engine restart does not reload plugins. */
  readonly reloadPluginsOnEngineRestart: boolean;
  readonly momentLocale: string;
  readonly dryRun: boolean;
  readonly dryRunAllowNetwork: boolean;
  readonly forceShared: readonly string[];
}

/**
 * Where the host keeps its own state: `$XDG_STATE_HOME/vaultd-host`, or
 * `~/.local/state/vaultd-host` when that variable is unset.
 */
function hostDataDir(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "vaultd-host");
}

/**
 * One socket per vault root, under a directory the host owns.
 *
 * The root is hashed rather than embedded: a vault path can be longer than the
 * ~104-byte cap a Unix domain socket address has on Darwin, and it can contain
 * separators. Sixteen hex characters of SHA-256 keep the whole address short
 * and stable for a given root.
 *
 * Exported so that a caller which overrides `dataDir` can keep the socket
 * under it: a harness that moved its data dir and left the socket path derived
 * from the real one would still name a path in the user's home directory, and
 * the first thing that bound it — or merely created its parent — would put the
 * host back outside the tree it was told to stay in.
 */
export function socketPathFor(dataDir: string, vaultRoot: string): string {
  const digest = createHash("sha256").update(vaultRoot).digest("hex").slice(0, 16);
  return join(dataDir, "run", digest, "host.sock");
}

/**
 * The default configuration for one vault root.
 *
 * `vaultdBinary` is the bare name: resolving it is `PATH`'s job, and a caller
 * that wants a specific build (every test in this repository, which uses the
 * release binary beside the workspace) overrides it. Every calibration value
 * below comes from the phase plan's Global Constraints list.
 */
export function defaultHostConfig(vaultRoot: string): HostConfig {
  const dataDir = hostDataDir();
  return {
    vaultRoot,
    vaultdBinary: "vaultd",
    vaultdArgs: ["--vault", vaultRoot],
    env: {},
    indexPath: null,
    configDirName: ".obsidian-headless",
    dataDir,
    socketPath: socketPathFor(dataDir, vaultRoot),
    clock: systemClock(),
    appVersion: "1.7.7",
    // Production can reach the network; `ShimHarness` turns this off for itself
    // so no test run can make a request, whatever bundle it loads.
    allowNetwork: true,
    promptTimeoutMs: 120_000,
    quarantineFailures: 5,
    quarantineWindowMs: 60_000,
    overlapPollMs: 60_000,
    snapshotPageSize: 500,
    snapshotPageSizeMax: 2_000,
    snapshotSessionCap: 8,
    subscriberQueueLimit: 256,
    snapshotCapRetries: 4,
    hydrationPinLossRestarts: 3,
    mirrorDeltaPathLimit: 512,
    mirrorWarmConcurrency: 16,
    writeFileCapBytes: 16 * 1024 * 1024,
    unloadBudgetMs: 5_000,
    restartBackoffMs: [250, 500, 1_000, 2_000, 5_000],
    restartFlapWindowMs: 60_000,
    restartFlapLimit: 5,
    reloadPluginsOnEngineRestart: false,
    momentLocale: "en",
    dryRun: false,
    dryRunAllowNetwork: false,
    forceShared: [],
  };
}
