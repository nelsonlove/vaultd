"use strict";

/**
 * Fill the fixture-row cache before vitest starts, so no test ever pays for a
 * cold corpus inside its own timeout.
 *
 * Wired as npm's `pretest`, so `npm test` warms first and then runs.
 *
 * ## Why this is a script and not a bigger `beforeAll` budget
 *
 * The parity rows are produced by `vault-core` itself (`cargo run --bin
 * fixture-row`), and the cache key names the generator binary — so any change
 * under `crates/` makes all eighteen parity rows and every shim fixture cold at
 * once. That is deliberate: without it the host would go on comparing against
 * the answer the parser gave before it was fixed.
 *
 * The cost lands in one burst, and it lands under exactly the conditions that
 * make it slowest: a `crates/` change means a Rust session is probably holding
 * the cargo build lock, so every spawn queues behind it. A measured cold
 * standalone run took **1188 s** and died on a 900 s hook budget, reporting
 * "28 skipped" — a parity suite failing with no failing assertion, which is the
 * least useful shape available. Raising the budget again only moves the number.
 *
 * Taking the work out of the test process fixes the shape instead: warming
 * fails here, loudly, naming what it was doing, with no timeout involved; and
 * vitest then only ever reads a cache that is already warm, so its hooks can
 * keep a budget that means "something is wrong" rather than "the machine is
 * busy".
 *
 * ## What it does
 *
 * 1. Builds `fixture-row` when `cargo` is on `PATH`. A machine with no Rust
 *    toolchain skips this and runs from whatever the cache already holds.
 * 2. Compiles the host (`tsc --build`, incremental) so this plain-JS script can
 *    require the **real** `warmFixtureCache`. Re-implementing the cache key here
 *    would be a second copy of it, and a second copy is a thing to keep in step
 *    with the first.
 *
 *    **Since Task 13 that build has a second consumer, and it is not this
 *    script.** `packages/obsidian` and `packages/electron` are plain CommonJS
 *    stand-ins that the workspace links into `node_modules`, and both reach the
 *    host through `dist/` — so a plugin bundle that resolves `obsidian` by
 *    Node's own algorithm gets whatever `dist/` last held. Running the build
 *    here is what keeps that current for every `npm test`.
 *    `test/module-intercept.test.ts` holds a guard that fails, naming
 *    `npm run build`, for anyone who runs `vitest` directly instead.
 * 3. Warms the eighteen parity fixtures, each as the one-note vault the parity
 *    test parses it as.
 *
 * Set `VAULTD_SKIP_FIXTURE_WARM=1` to skip the **cargo build and the warm-up** —
 * for a machine with no Rust toolchain, or while someone else is mid-edit in
 * `crates/` and a build would fail on their half-written code. It does **not**
 * skip step 2: since Task 13 the `tsc` build is what keeps `dist/` current for
 * the `obsidian` and `electron` packages a plugin bundle resolves, so skipping
 * it would take the suite red on the freshness guard instead of degrading
 * gracefully. `tsc` needs nothing this suite does not already need.
 */

const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const hostRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(hostRoot, "..");
const fixturesDir = join(hostRoot, "fixtures", "metadata-parity");

function note(message) {
  process.stdout.write(`warm-fixtures: ${message}\n`);
}

function die(message) {
  process.stderr.write(`warm-fixtures: ${message}\n`);
  process.exit(1);
}

const skipWarm = Boolean(process.env.VAULTD_SKIP_FIXTURE_WARM);
if (skipWarm) {
  note("VAULTD_SKIP_FIXTURE_WARM is set: skipping cargo and the fixture warm-up; tests will run against whatever the cache holds");
}

/**
 * Is `cargo` runnable?
 *
 * Asked by running it, not by a shell lookup: `spawnSync(..., { shell: true })`
 * concatenates rather than escapes its arguments, which Node deprecates for
 * exactly the reason it sounds like.
 */
function hasCargo() {
  const probe = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

function run(command, args, what, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) die(`${what} could not start: ${result.error.message}`);
  if (result.status !== 0) die(`${what} exited ${String(result.status)}`);
}

if (skipWarm) {
  note("no cargo build (warm-up skipped)");
} else if (hasCargo()) {
  note("building the fixture generator");
  // Debug, never release: this binary is a test fixture, and a release build of
  // the workspace is minutes of work for no difference in what it prints.
  run(
    "cargo",
    ["build", "-q", "-p", "vault-server", "--bin", "fixture-row", "--manifest-path", join(workspaceRoot, "Cargo.toml")],
    "cargo build",
    workspaceRoot,
  );
} else {
  note("no cargo on PATH; running from the cache as it stands");
}

// **Always, whatever VAULTD_SKIP_FIXTURE_WARM says.** Since Task 13 the build
// is not only this script's own errand: `packages/obsidian` and
// `packages/electron` are what a plugin bundle resolves, and both reach the
// host through `dist/`. Skipping it here would leave a bundle running against
// whatever `dist/` last held, and would take the suite red on the freshness
// guard in `test/module-intercept.test.ts` rather than degrading gracefully —
// which is not what an escape hatch documented as "for a machine with no
// toolchain" should do. `tsc` needs no toolchain beyond the one `npm test`
// already requires, so there is nothing for the flag to protect here.
note("compiling the host: dist is what the obsidian and electron packages resolve, and the warm-up's cache key");
// From `host/`, not the workspace root: the build script lives in this
// package's own manifest.
run("npm", ["run", "--silent", "build"], "tsc --build", hostRoot);

const compiled = join(hostRoot, "packages", "host", "dist", "testing", "fixture-vault.js");
if (!existsSync(compiled)) die(`the build produced no ${compiled}`);
if (skipWarm) {
  note("dist is current; fixture warm-up skipped");
  process.exit(0);
}
// The require is deliberately here rather than at the top: `compiled` only
// exists after the build above ran, and the `existsSync` guard is what makes the
// failure legible.
const { warmFixtureCache, fixtureCacheDir } = require(compiled);

const cases = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".expected.json"))
  .map((name) => name.replace(".expected.json", ""));
if (cases.length === 0) die(`no parity fixtures under ${fixturesDir}`);

note(`warming ${String(cases.length)} parity fixtures into ${fixtureCacheDir()}`);
for (const name of cases) {
  // One note per request, because that is exactly how `metadata-parity` parses
  // each fixture — a different document set is a different cache key and would
  // warm nothing the test then reads.
  const source = readFileSync(join(fixturesDir, `${name}.md`), "utf8");
  try {
    warmFixtureCache([{ path: `${name}.md`, source }]);
  } catch (error) {
    die(`${name} could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
note("warm");
