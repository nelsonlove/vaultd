# `host/` — the headless Obsidian plugin host

A npm workspace (`packages/*`) that runs Obsidian plugins outside Obsidian, against a `vaultd` daemon over stdio. `@vaultd/host` is the runtime; the sibling stub packages stand in for the `obsidian` and `electron` modules a plugin imports.

## Commands

Every command runs from the repository root and needs no `cd`.

```bash
npm --prefix host install
npm --prefix host run build       # tsc --build packages/host
npm --prefix host run typecheck   # both projects: src, and src + test
npm --prefix host run lint        # eslint, type-aware
npm --prefix host test            # vitest, one process per test file
npm --prefix host test -- client  # one suite by name
```

`typecheck` and `lint` are not optional extras. The lint config is type-aware on purpose: `no-floating-promises` and `no-misused-promises` catch the bug class a single-FIFO async host suffers from, and neither can be seen without types.

## The `vaultd` binary, and `VAULTD_ALLOW_MISSING_BINARY`

`packages/host/test/client-real-daemon.test.ts` talks to the **real** daemon at `target/release/vaultd`. It is the only place the client is checked against something other than a fake that agrees with it, so the envelope it asserts byte-for-byte is the one wire truth the TypeScript suite has.

The binary is a Rust build artifact and is not in the repository. **Its absence fails the suite**, with a message naming the build command:

```bash
cargo build --release --bin vaultd
```

A checkout that genuinely cannot build Rust opts out, deliberately and per-run:

```bash
VAULTD_ALLOW_MISSING_BINARY=1 npm --prefix host test
```

That skips the real-daemon cases and prints a warning naming what was skipped. **CI must not set it.** A green run with those cases silently gone is a green run that proved nothing about the wire, which is exactly the failure the default guards against.

## Layout

```text
host/
  eslint.config.js        type-aware lint for the whole tree
  vitest.config.ts        node environment, forks pool, one process per file
  packages/host/
    src/runtime/          the fs seam, the electron registry
    src/client/           the vaultd client: protocol types, framing, errors, request/response
    src/testing/          test scaffolding the test tree and later tasks share
    test/                 vitest suites, including the invariant checks below
```

Two invariants are enforced by tests rather than by review, and both will bite if you ignore them:

- **One fs seam.** Only `src/runtime/fs-access.ts` may name `node:fs` or `node:fs/promises`. Everything else reaches the filesystem through it, and calls through the seam **object** (`fs.writeFileSync(...)`) rather than destructuring functions out of it — a destructured function is a snapshot the write guard cannot see. `test/fs-seam.test.ts` enforces both.
- **No real electron.** `test/no-electron.test.ts` proves the dependency tree contains no electron package.

## The fixture cache warms before vitest

Semantic parity is measured against rows produced by **`vault-core` itself** — `host/packages/host/src/testing/fixture-vault.ts` shells out to `cargo run --bin fixture-row` and memoizes the answers under `host/fixtures/cache/` (gitignored). The cache key names the fixture text, the whole document set, **and a digest of the generator binary**, so any change under `crates/` makes every cached row stale at once. That is deliberate: without it the host would keep comparing against the answer the parser gave before it was fixed, and a parser fix would be invisible here.

The consequence is that the first run after a `crates/` change has to regenerate the corpus, and that is slow exactly when it is most likely — a Rust session that just changed `crates/` is probably still holding the cargo build lock. So the regeneration happens **before** vitest rather than inside a test hook:

```bash
node host/scripts/warm-fixtures.js     # npm's `pretest` runs this for you
```

It builds `fixture-row` (debug) when `cargo` is on `PATH`, compiles the host so it can call the real `warmFixtureCache` rather than a second copy of the cache key, and fills the eighteen parity rows. It fails loudly, naming what it was doing, with no timeout involved. `npm --prefix host test` runs it automatically.

Opt out with `VAULTD_SKIP_FIXTURE_WARM=1` — for a machine with no Rust toolchain (it then runs from whatever the cache holds), or while someone else is mid-edit in `crates/` and a build would fail on their half-written code:

```bash
VAULTD_SKIP_FIXTURE_WARM=1 npm --prefix host test
```

A test that needs to **measure** caching — a miss, a spawn, the files one batch wrote — must not diff the shared cache directory: vitest runs one process per file in parallel, so a sibling regenerating its corpus is writing there at the same moment. Take a private directory instead, through `overrideFixtureCacheDir()`.

Two limits of the warm-up, both deliberate and both worth knowing before timing a clean checkout. **It covers the parity corpus only** — the shim `withVault` fixtures are inline in TypeScript rather than on disk, so on a cold cache those are still generated inside their own test processes, which is most of the cache by row count. And the isolated-cache self-test is a guaranteed miss by construction, so **every** run pays exactly one generator spawn for it; that case cannot be served from cache and so cannot run on a machine with no `cargo`, whatever `VAULTD_SKIP_FIXTURE_WARM` is set to.
