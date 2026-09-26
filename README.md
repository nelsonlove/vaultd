# vaultd

`vaultd` is an open, high-performance semantic runtime for Obsidian-compatible vaults. Obsidian is one client.

## North star

The vault's ordinary files are authoritative. `vaultd` adds semantics, safe coordination, queries, and events without converting Markdown into a proprietary database.

## Boundaries

### Filesystem persistence

Markdown, YAML properties, attachments, Canvas, Bases, and `.obsidian` remain Obsidian-compatible files.

### Semantic runtime

`vault-core` will own lossless document semantics, identities, revisions, resolution, and mutation rules.

### Protocol

`vault-protocol` exposes versioned transport-neutral requests, responses, events, and errors.

### Client runtimes

MCP, CLI, URI handling, Obsidian acceleration, the Node API shim, Swift, Elisp, Sync adapters, mobile, and e-ink clients remain consumers of the runtime.

## Workspace

- `vault-core`: semantic types and runtime ports
- `vault-protocol`: stable external contract
- `vault-server`: daemon composition and its two transports, stdio and a Unix domain socket
- `host/`: a Node/TypeScript npm workspace, outside the Cargo workspace — the headless Obsidian plugin host and the `vaultd-host` binary. Built and tested on its own (`npm --prefix host run build`, `npm --prefix host test`); it supervises a `vaultd` child rather than linking against the crates.

## Current milestone

### On the branch `feat/headless-plugin-host`: the headless Obsidian plugin host

**Experimental.** `host/` runs unmodified Obsidian community plugin bundles with no Electron, no DOM and no window. It supervises `vaultd` as a child engine, keeps a mirror of the vault tree and semantic state, loads plugin bundles against a shim that impersonates the Obsidian API, and serves what the plugins registered — commands, menu items, protocol handlers, settings — as machine-readable capabilities over its own Unix socket.

The binary:

```
vaultd-host --vault <path> [options]

  --vault <path>            The vault to run over. Required; resolved to an absolute path,
                            because it is both the daemon's argument and the key the default
                            socket path's digest comes from.
  --config-dir <name>       The host's own config directory inside the vault.
                            Default: .obsidian-headless. Never ".obsidian" — that is the GUI's,
                            and sharing it is refused.
  --socket <path>           Where to bind the host's control socket.
                            Default: <state dir>/run/<vault digest>/host.sock.
  --vaultd <path>           The vaultd binary to run. Default: "vaultd" on PATH.
  --dry-run                 Intercept every write instead of performing it, and refuse the
                            file system, process spawning and the network to plugin bundles.
  --dry-run-allow-network   Under --dry-run, let requestUrl through anyway.
  --engine <mode>           auto (default): connect to a vaultd already listening for this
                            vault, else spawn one with --listen. connect: never spawn;
                            exit 3 if none is listening. spawn: always spawn, never
                            probe, and own its life through this process's stdin.
  --leave-engine-running    Under --engine auto, leave a daemon this host spawned
                            running when the host shuts down.
  --force-shared <id>       Run <id> even though the GUI has it enabled too. Repeatable.
  -h, --help                Print the usage and exit 0.
```

One machine-readable line goes to stdout when the host is ready — `{"ready":true,"socket":…,"vault":…,"dry_run":…,"engine_source":…,"engine_socket":…,"loaded":[…],"failed":[…]}` — so whatever started the host knows where to knock without recomputing the digest. `engine_source` is a snapshot taken at startup (`"connected"`, `"spawned"`, or the daemon this process owns under `--engine spawn`), and `engine_socket` is the path the engine listens on under `auto` and `connect`, or `null` under `spawn`, where nothing binds there.

**Exit codes are a contract:** `0` a clean shutdown on `SIGINT` or `SIGTERM`; `1` any other unhandled failure outside the shutdown window — a refusal with no typed code of its own, with the message on stderr; `2` a usage error (an unknown flag, a missing value, or no `--vault`); `3` the daemon was unreachable — it did not start, or never reached a watching state; `4` the config directory was refused, either because `--config-dir` named the GUI's own directory or because the GUI has every enabled plugin open too and there was nothing left to run. The overlap case is decided from the coexistence monitor's typed report, never from the text of a failure message.

**`--engine` decides where the host's engine comes from.** `auto`, the default, connects to a `vaultd` already listening for this vault and spawns one with `--listen` when none is, so the daemon it starts is shareable and the next client's start is cheap. `connect` never spawns and exits 3 when nothing answers. `spawn` is the phase-6 behaviour exactly: always spawn, never probe, and own the daemon's life through its stdin. A daemon the host spawned under `auto` is sent `SIGTERM` at shutdown unless `--leave-engine-running` is passed. The ready line and `host.info` both report which road was taken.

**One copy of the wiring.** `host/packages/host/src/host.ts`'s `startHost(config)` is the entry point: it builds and starts the whole host in the one order that works, and returns a `RunningHost` with an ordered `stop()`. `src/main.ts` is the process half alone — parse the flags, start, print the ready line, wait for a signal, stop — and the live-host test seam drives the same function, so every golden test exercises the code the binary runs. There is deliberately no second copy: four separate mutations of an earlier private copy survived the whole suite because the copy under test was the harness's.

**Dry-run** intercepts an explicit, enumerated list of surfaces and is **not a sandbox**: plugins run with the host's Node privileges exactly as they do under Electron. What is intercepted, what is deliberately not, and what the dry-run overlay pretends instead are all listed in `docs/protocol-host.md`'s **Dry-run** section rather than restated here.

**`allowNetwork` defaults to `true` in production**, so `requestUrl` and `request` reach the network; every test harness forces it off, so no suite can phone home whatever bundle it loads. Under `--dry-run` the network is refused unless `--dry-run-allow-network` is also passed, in which case the ordinary `allowNetwork` policy governs.

**Decisions, recorded 2026-09-22.** `allowNetwork` defaults to `true` in production (agreed 2026-09-17; `--dry-run-allow-network` is the opt-back-in under dry-run). `nested-properties` not loading headless is accepted (agreed 2026-09-17): its `onload` asserts on `app.metadataTypeManager`'s registered type widgets, a GUI rendering surface this host does not have. The other two non-conforming goldens, `automatic-linker` (no active Markdown view, so it writes nothing) and `tag-wrangler` (no menu cursor, so its context menu is empty), are accepted as documented limits (2026-09-22). **The tag rule is settled by capture (2026-09-24).** A maintainer typed `#tag+more #a=b #c^d #p$ #tag-☺` into a live Obsidian and read back `#tag #a #c #p #tag-☺`: the tag stops at the ASCII symbols `+ = ^ $` and keeps the hyphen and the non-ASCII smiley. That is the parser's rule as shipped (`vault-core/src/obsidian.rs`, `TAG_CANDIDATE`), pinned by `tag_character_set_is_the_documented_set_plus_non_ascii_symbols`; no code changed.

Measured baselines — cold start, plugin write round trip, hydration and added RSS, per-plugin load time, and the timer registry with cadences — are in `docs/performance/headless-host-baseline.md`. The plugin-compatibility accounting, including which goldens conform and which do not, is Tier 3 of `VAULTD-COMPATIBILITY.md`. See also `docs/design/headless-plugin-host.md` and `docs/protocol-host.md`.

### Completed: vault mutations and bulk reads

`vaultd` now writes, and hands a whole vault over in a handful of round trips:

- ten new operations, nine of which write — `write_note`, `create_folder`, `rename_note`, `rename_folder`, `copy_file`, `delete_note`, `delete_folder`, `patch_frontmatter`, and `write_file`, plus the raw `read_file` — each with typed refusals that change nothing, per-file temp-then-rename atomicity, and paths canonicalized and contained inside the vault;
- compare-and-swap preconditions (`{"revision": …}`, `{"absent": true}`, `{"any": true}`) checked against **the bytes on disk** at mutation time, not against the index, so an external edit the index has not seen yet cannot be silently overwritten;
- **read-your-writes**: a mutation answers only after the generation containing it has published, so a client can read its own write at the generation it was handed;
- `rename_note`/`rename_folder` repair inbound links in the same generation, preserving each reference's spelling, upgrading only where the rename would make it ambiguous, and reporting every reference they declined with a stable reason code;
- `patch_frontmatter` edits addressed keys in place and leaves every byte outside the addressed span alone — key order, comments, whitespace, and the body survive;
- `write_file`/`read_file` carry raw bytes for attachments and the `.obsidian` zone, where nothing is indexed: a zone write joins no generation and announces itself with a `config_changed` event instead;
- **snapshot sessions** (`open_snapshot`, `snapshot_tree`, `snapshot_notes`, `close_snapshot`) page the whole vault — tree entries and per-note semantic facets — from one pinned read transaction, so an entire hydration is coherent at one generation, with an idle timeout, a concurrency cap, and release on disconnect;
- `--read-only` refuses every vault write, the configuration zone included.

10,000- and 100,000-note synthetic benchmarks against the design's targets are in `docs/performance/vault-mutation-baseline.md`. See `docs/protocol.md` and `docs/design/vault-mutations-and-bulk-reads.md`.

### Completed: live incremental runtime and bounded event subscriptions

`vaultd` now keeps the cache live and streams what changed:

- one coordinator thread owns every mutation; reads answer from a `Send + Sync` reader over the last published generation and never wait for the writer;
- a debounced filesystem watcher drives targeted incremental reconciliation, with a periodic complete reconciliation behind it (`--no-watch`, `--watch-debounce-ms`, `--reconcile-interval-seconds`);
- `subscribe_events` and `unsubscribe` multiplex **post-commit events** onto the stdio stream — one JSON object per line, one writer, so an event can never split a response and a client that never subscribes sees byte-identical protocol version 1 output;
- `generation_committed` carries the exact per-path change set, `runtime_state_changed` the runtime's observational state, and `resync_required` every case where no per-path delta describes the move;
- every queue is bounded and every overflow degrades into a `resync_required` marker rather than into silence: the registry enforces **bounded per-subscriber** queues of 64 events (`subscriber_lag`) and 1024 paths of change-set detail per generation (`oversized_change_set`);
- reconciliation is never stalled by a client — the coordinator offers notices without ever waiting and drops what will not fit, so a client that stops reading its own stdout meets backpressure and is later told `resync_required { runtime_recovered }`, rather than slowing indexing or losing a change. Subscriptions on one connection share a writer, though, so such a client does delay its peers on that connection until it resumes.

10,000- and 100,000-note synthetic benchmarks, structural work proofs, and an honest comparison against the design's timing targets are in `docs/performance/live-incremental-baseline.md`. The recommended next milestone is the MCP and CLI consumer surface over these now-stable read and event contracts.

See `docs/protocol.md` and `docs/design/live-incremental-runtime.md`.

### Completed: persistent index and daemon read API

`vaultd` now persists the semantic graph in a normalized persistent SQLite cache and serves read operations over protocol version 1:

- normalized SQLite storage outside the vault (XDG cache by default, `--index` to override), with exact source bytes, spans, resolutions, backlinks, and diagnostics as rows;
- `--listen [PATH]` also serves a Unix domain socket; with no value, `<run dir>/<digest>.sock`;
- the vault file tree indexed alongside the semantic rows: every non-hidden folder and file with its kind, size, and creation/modification timestamps, kept current on the same watcher path as the notes;
- atomic, monotonically numbered generations published by compare-and-swap; readers never observe partial state;
- normal reconciliation that trusts path/size/mtime fingerprints and reads no unchanged bodies, plus verified reconciliation that hashes every file but reparses only changed revisions;
- change detection through startup and manual reconciliation (`refresh_index`); a filesystem watcher and live events arrived with the milestone above;
- all eight indexed operations: `get_vault_info`, `list_notes`, `get_note`, `resolve_link`, `get_backlinks`, `list_references`, `get_diagnostics`, and `refresh_index`, plus `health`;
- generation-bound opaque cursors, bounded pages, and stable error codes.

**`--listen` gives the daemon a second door.** It serves the same protocol to any number of connections at once, each with its own subscriptions and snapshot sessions, and it outlives whatever started it: with a listener, end of stdin ends stdio alone and `SIGTERM` ends the daemon. The default path is derived from the vault root, so a client finds the daemon without being told where it is, and `get_vault_info` reports `socket_path` for one that would rather ask. `docs/protocol.md`'s **Transports** section is the contract.

See `docs/design/persistent-index-and-daemon-read-api.md`, `docs/plans/persistent-index-and-daemon-read-api-implementation.md`, `docs/protocol.md`, and `docs/performance/persistent-index-baseline.md`.

### Completed: foundation

The foundation implements semantic identity primitives, protocol versioning, and health dispatch. See `VAULTD-COMPATIBILITY.md`, `docs/protocol.md`, and `docs/adr/0001-core-language.md`.

### Completed: semantic read path

`vault-core` now scans an ordinary Obsidian vault into a read-only, in-memory semantic graph:

- exact source preservation (`SourceDocument` keeps every UTF-8 byte) and content-derived revisions;
- read-only deterministic enumeration (`FileSystemVaultSource` sorts vault paths, skips `.obsidian` and hidden directories, and bounds symlinks to the vault root);
- semantic parsing with exact byte spans for properties, aliases, headings, blocks, tags, links, embeds, and wikilinks, plus explicit structured diagnostics for malformed content;
- structural parsing with exact byte spans for **sections** (one per top-level block, with its kind and owning block identifier) and **list items** (with the line-number parent convention and raw task state), whose shapes are pinned against observed Obsidian 1.13.4 behavior through committed runtime captures — never derived from Obsidian's source (`crates/vault-core/tests/fixtures/structural/`);
- in-memory resolution with outgoing, backlink, unresolved, and ambiguous indexes (`scan_vault` → `SemanticGraph`);
- a committed compatibility fixture corpus at `fixtures/semantic-read-path/` with golden public snapshots;
- deliberately no protocol or daemon exposure, no persistence, no filesystem watching, and no mutation — the graph is a library boundary only.

## Non-goals

`vaultd` writes, renames, and deletes vault files as of the milestone above, one operation at a time. It does **not** provide multi-file transactions, conflict merging, journaling, undo, versioning, or Sync semantics, and it does not run plugins or render UI. Server-side read-modify-write is deliberately absent too: a client composes `get_note` and `write_note` into its own compare-and-swap loop. The persistent index is rebuildable derived state, never canonical data; the vault's ordinary files stay authoritative.

## Development

Run `cargo test --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`. Point `TMPDIR` inside the repository (`TMPDIR="$PWD/target/tmp"`) so the suites' synthetic vaults land on the same filesystem as the build, never in the system temporary directory.

### Property tests

Six suites use `proptest`. `PROPTEST_CASES` is honoured by all of them, including the ones written as `ProptestConfig::with_cases(N)`: `proptest!` passes any config expression through proptest's own `contextualize_config`, which re-applies the environment variable on top of whatever it was given. An earlier note in this repository claimed `with_cases` swallowed the variable and that the suites needed migrating — that claim was disproved against proptest 1.11.0's source, and the measurement behind it compared two runs that both had the variable set. **There is nothing to migrate.** `crates/vault-index/tests/frontmatter_patch.rs`'s `cases()` helper is equivalent to `with_cases(256)`, kept only because it states the default at the call site.

### Known flaky tests (both pre-existing, both load-dependent)

Two tests measure wall-clock time and fail when other multi-second tests run beside them. Both pass in isolation. **Re-run a failure on its own before treating it as a regression** — `cargo test -p vault-server --test <suite> <test_name> -- --exact`.

- `vault-server/tests/subscriptions.rs::a_subscriber_that_never_drains_is_bounded_against_a_live_runtime` — fails with "the marker must name the newest committed generation". The test waits on `published_status`, but notice *delivery* into the channel lags publication, so the final drain can run before the last notice arrives and the lag marker then names an older generation. **Fix sketch:** after reading `final_generation`, block on `notices.recv_timeout` until a notice naming it arrives, then drain.
- `vault-server/tests/runtime.rs::only_the_configured_threads_are_started` — fails the 5 s bound in `bounded_shutdown`. Measured 2026-09-08 on an Apple M2: 10.8 s in the full workspace run **and** 10.8 s again when only `--test runtime` ran, so its own suite's 22 siblings are load enough; run alone it passes 3/3. The bound exists to catch a shutdown that waits out a whole 60 s reconcile interval, which is a two-order-of-magnitude difference from what is being measured. **Fix sketch:** bound the shutdown against the configured interval rather than a fixed 5 s wall-clock figure, so the assertion keeps its signal and stops measuring the machine's load.
