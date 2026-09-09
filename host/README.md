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
