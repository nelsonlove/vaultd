# vaultd Socket Transport Design

## Status

Approved direction for phase 7, the phase following the headless plugin host (merged to main as `fa3028c`). Approach and sections approved on 2026-09-25; rulings are recorded in the Rulings section at the end.

## Summary

This phase gives `vaultd` a second door. Today the daemon speaks its newline-delimited JSON protocol over the stdio of exactly one parent process, and `docs/protocol.md` calls that "a proof transport, not a production transport commitment". After this phase the daemon can also listen on a Unix domain socket, serve any number of connections at once, and outlive any one of them. The protocol changes only additively: every request, response, event and error is the same bytes over either transport, and `get_vault_info` gains one optional field. What changes is who may talk to the daemon (any process on the machine that can open the socket file) and how many at once.

The design is "one server, one loop per connection". The existing stdio loop, with its reader, dispatcher, writer and subscription registry, becomes the per-connection unit, and stdio itself becomes connection zero. One new broadcaster thread fans the runtime's notices out to every connection. Writes still serialize inside the runtime, as they do today, so two clients cannot interleave a mutation. A slow client can stall only itself.

## Evidence and motivation

- The headless plugin host multiplexes the daemon for its own clients, because a stdio child can have only one parent. Every other program that wants the daemon must either go through the host, which drags the whole plugin runtime along, or spawn a second daemon, which the exclusive writer lease refuses (`IndexError::IndexInUse`). The socket makes the one daemon reachable.
- The deployment that asked for this: `vaultd` as a long-lived service on a Linux server, over a vault folder that the official headless Obsidian Sync client keeps merged with a desktop machine (`ob sync --continuous`, Obsidian 2026.02.27). Several programs on that server, an MCP server, agents, a CLI, share one daemon and one index. That machine has no parent process to own the daemon's stdio.
- Cold start is measured at 1.6 s warm and 2.1 to 2.4 s cold on the 10k fixture (`docs/performance/headless-host-baseline.md`). Every parent restart pays that today. A daemon that outlives its clients pays it once.
- The design document for the host (`docs/design/headless-plugin-host.md`) already lists "a `vaultd` socket transport (the host multiplexes; deferred)" under out of scope. This is that item.

## Goals

1. A Unix domain socket transport for the daemon, carrying the existing protocol unchanged, serving many connections at once.
2. Per-connection isolation: a slow, silent or misbehaving client affects no other client.
3. A daemon that outlives its clients and is found by them from the vault path alone.
4. The host connects to an existing daemon when there is one and spawns one only when there is none.
5. The conformance suite proves the socket transport byte-equivalent to stdio.

## Non-goals (deferred, not refused)

TCP or TLS listeners; socket activation by systemd; authentication beyond the socket file's mode; per-connection authorization or rate limits; multi-vault daemons; any change to the protocol's operations, envelopes or error codes. Reaching the daemon from another machine is done by forwarding the socket over SSH, documented as a recipe, not built.

## Architecture

### The per-connection loop

`stdio::run` today starts four threads: the stdin reader, the notice forwarder, the stdout writer, and the dispatcher on the calling thread. The dispatcher is the single owner of the `Server` reference and of a `SubscriptionRegistry`; it takes one input at a time from one bounded queue (`INPUT_CAPACITY` 256) where requests and runtime notices interleave, and hands finished envelopes to the writer through a second bounded queue (`OUTPUT_CAPACITY` 256). That structure is the whole ordering argument: a subscription is registered before or after each commit notice, never half; a `subscribe_events` response precedes its first event; an `unsubscribe` response follows its last.

This phase keeps that loop and makes it the unit of one connection. A connection is a reader, a dispatcher, a writer, one subscription registry and one set of snapshot sessions, over one stream. The stream is a socket for accepted connections and the process's stdio for connection zero. Nothing about connection zero is special; it is closed when stdin closes, and it is absent when the daemon is started with stdin closed (as under systemd).

The `Server` is shared between connections behind an `Arc`. It is already built for this shape: requests take `&self`, snapshot sessions sit behind a `Mutex` ("so reads answer from the dispatcher thread without ever touching the coordinator"), the raw-read engine is `Clone` and read-only-aware, and every mutation goes through the runtime's single coordinator. The phase adds a check that `Server` is `Sync`, and no rewrite.

### The broadcaster

Today the runtime sends `RuntimeNotice` values into one channel, and one forwarder thread feeds them into the dispatcher's input queue. With many connections, one broadcaster thread owns that channel. Each connection registers a bounded notice queue (capacity 256) with the broadcaster when it starts and unregisters it when it ends. The broadcaster clones every notice (the type is `Clone`) into every registered queue with a non-blocking send.

If a queue is full, the notice is dropped and that connection's gap flag is set. The next time the broadcaster can deliver to that connection, it first sends a synthetic notice that the connection's dispatcher turns into `resync_required` with reason `runtime_recovered`, naming the newest generation, and then sends the notice in hand; the latch clears only when the synthetic notice itself was accepted and could name a generation. That is exactly what the coordinator's own drop-and-latch does for the forwarder today (see "What a slow stdio client actually meets is backpressure" in `docs/protocol.md`): the marker precedes the notice, it never replaces it, so a configuration change or the final `stopped` state is never swallowed by a gap. (Amended 2026-09-26 after the Task 2 review: the first wording said "replaced", which would have lost one notice per latch cycle.) The rule moves one hop out; its shape does not change.

The per-subscription bound of 64 events and the `subscriber_lag` marker are unchanged, because they live in the per-connection registry. The per-generation bound of 1024 paths is unchanged, because it is applied before the notice exists.

The broadcaster never blocks: not on a full queue (it drops), not on the coordinator (it only receives). So indexing cannot be stalled by any client, which is the invariant the stdio design states and this phase preserves.

### Connection lifecycle

- **Flag.** `--listen [PATH]` (requires `--vault`). Absent: stdio only, exactly as today, and end of stream on stdin ends the daemon. Present with a path: bind that path. Present without a value: bind the default path below. With `--listen`, stdio is served as connection zero while stdin is open, and end of stream on stdin ends connection zero only: the daemon's life is then the listener's, ended by a signal. This is what lets systemd start it with stdin closed, and what lets the daemon outlive the process that started it.
- **Default path.** `<run dir>/<digest>.sock` where `<digest>` is the first 16 hex characters of the SHA-256 of the canonical vault root, the same rule the host applies in `socketPathFor`, and `<run dir>` is `$XDG_RUNTIME_DIR/vaultd` when that variable is set, else `<XDG cache dir>/vaultd/run`, beside the derived index. `get_vault_info` gains one optional field, `socket_path`, so a client on stdio can tell others where to knock.
- **Bind.** Create the run directory with mode 0700 and the socket with mode 0600. If a file already exists at the path, try to connect and send `get_health`. If a daemon answers, this one exits with code 2 and names the answering daemon's path on stderr ("another vaultd is listening at …"). If nothing answers, unlink the stale file and bind. A path that exists and is not a socket is refused with code 2.
- **Accept.** One accept thread with a listen backlog of 16. Each accepted stream starts a connection as above. There is no cap on connections; the operating system's file descriptor limit is the cap, and running into it is reported on stderr and does not stop the daemon.
- **Close.** A connection ends when its reader sees end of stream, when its writer fails, or when the daemon shuts down. Ending a connection drops its registry (every subscription with it), closes its snapshot sessions (releasing the WAL frames they pinned), and unregisters its notice queue. The other connections are not told; a client that cares about other clients has no business in this protocol.
- **Shutdown.** SIGTERM or SIGINT; without `--listen`, also end of stream on stdin as today. The daemon stops accepting, enqueues a `runtime_state_changed` with `live_state: stopped` into every live connection's queue, closes each writer once its queue drains, then shuts the runtime down, joins every thread, and unlinks the socket file. The drain is bounded at 5 seconds, after which writers are closed hard, and the join after the hard close is bounded by a second 5 seconds, so a stop never takes more than 10 seconds and never hangs on a wedged client. A connection whose inbox was full at the moment of the offer is offered `stopped` once more after the drain has made room. Exit code is 0 for a clean shutdown as today. (Amended 2026-09-26 after the Task 5 review: the first wording named one budget and did not say what bounds the join after the hard close.)
- **Readiness.** The daemon prints nothing new to stdout when it binds, because stdout is connection zero's protocol stream and a non-protocol line would break its client. Readiness is "the socket file exists and `get_health` answers". A service recipe uses exactly that probe.

### The host supervisor

The host's supervisor today spawns `vaultd` with stdio pipes, holds them, restarts the engine on exit within a bounded window, and raises `EngineLostError` into the Mirror's resync road when the engine is replaced. This phase adds one config field, `engine`, with three values:

- `auto` (the default): probe the default socket path for this vault with `get_health`. If a daemon answers, connect to it. If not, spawn as today, passing `--listen` so later clients can share the daemon this host started. On a dropped connection, retry the probe with the existing restart backoff; spawn only if the socket stays absent for the whole window.
- `connect`: never spawn. If the socket is absent at startup, exit with code 3, the code that already means "the daemon was unreachable".
- `spawn`: today's behaviour, unchanged, socket never probed.

A dropped socket is an engine-lost event and takes the road built in phase 6: the Mirror's `EngineLostError` → `runtime_recovered` resync. The `StartupReport` gains `engine_source: "spawned" | "connected"`, and `host.info` reports it in snake_case under the existing engine substructure.

Who owns the daemon's lifetime follows the mode. Under `connect`, the host never does: its shutdown closes the connection and leaves the daemon running. Under `spawn`, the host does, exactly as in phase 6: the daemon has no listener, and closing its stdin ends it. Under `auto`, a daemon the host found is left running, and a daemon the host spawned is spawned with `--listen` so others can share it, which means closing its stdin no longer ends it; the host therefore sends it SIGTERM at its own shutdown, unless the config field `leave_engine_running` is true, in which case the daemon stays for the next client. This supersedes the phase 6 sentence "host death closes stdio and `vaultd` exits" for the `auto` case, and the phase 6 design document is amended to say so. A host that dies without a shutdown (a crash, SIGKILL) leaves a spawned `auto` daemon running; that daemon is discoverable at the default path, is refused by the lease from any second daemon, and is ended by SIGTERM, so a stray is an inconvenience, never a hazard.

The host's own socket (`host.sock`, nonce-gated, 24 operations) is unchanged. It carries host operations; it does not proxy the daemon protocol. Clients that want the daemon go to `vaultd.sock` directly.

## Error handling

- An unknown protocol version or an oversized line: the same error as stdio produces today, on that connection only, and the connection stays open. A line that is not JSON at all has no request id to answer under, so it ends that connection with no response line, exactly as it ends the stdio loop today (`FatalInput`); the code is shared, so both doors behave identically, and the conformance suite pins it. Otherwise only end of stream, a write failure, or shutdown closes a connection. (Amended 2026-09-26 after Task 7: the first wording said a malformed line leaves the connection open, which stdio never did.)
- A write failure on one connection's stream ends that connection. The daemon logs one line on stderr and keeps serving the others. Stdio's rule that "a write failure outranks a clean end of input" applies per connection: the reason is recorded, and it is the connection's, not the daemon's.
- A silent connection is never timed out. Idle snapshot sessions are swept on every input on their own connection, as today. A connection that opens a session and then sends nothing pins WAL frames until it closes. This is a documented limit, unchanged from stdio, and the socket file's mode is the guard against strangers doing it. Cross-connection sweeping is deferred with a pointer here.
- The 16 MiB payload cap is per line per connection, unchanged.
- The exclusive writer lease is unchanged and is what makes the socket safe: there is one daemon per index, and the socket is a second door to it, never a second writer.
- `--read-only` is unchanged and applies to every connection.

## Performance requirements

- Connection setup, from `connect()` to the first `get_health` answer, under 5 ms p50 on the development laptop.
- Round trip over the socket within 10 percent of the same request over stdio, measured on `get_note` warm and on one `write_note` (the baseline harness gains a `--transport socket|stdio` switch).
- Slow-client isolation: with one client that has stopped reading, a second client's `get_note` p50 is within 10 percent of its single-client value, and the stalled client receives `runtime_recovered` when it resumes.
- No new thread per connection beyond the four the stdio loop already has (reader, forwarder, writer, dispatcher): the forwarder now feeds the dispatcher from that connection's broadcaster inbox instead of from the runtime directly, and the broadcaster itself is one process-wide thread. (Amended 2026-09-26 after Task 9 measured four per connection on both transports; the first wording said three and claimed the forwarder was replaced, which the design never did.)

## Testing

- **Conformance twice.** The existing protocol conformance fixtures run once over stdio and once over the socket from one fixture set; the transport is a parameter of the harness. Any difference in bytes is a failure.
- **Two clients.** Both subscribe; one mutates; both observe the same generation, in order, each under its own subscription id; unsubscribing one does not affect the other.
- **Slow client.** One client stops reading; the other keeps working with no delay over baseline (the performance test above); the slow one gets `runtime_recovered` naming the newest generation when it reads again. The collapse it meets is at the broadcaster's 256-deep inbox, never at the per-subscription registry: a dispatcher drains a subscription's queue to completion after every notice, so the 64-event bound and its `subscriber_lag` marker are unreachable through any transport and are pinned only at the registry, as `docs/protocol.md` has always said for stdio. (Amended 2026-09-26 after Task 8: the first wording asserted the per-subscription queue never exceeds 64 under a stalled socket client, which no transport can make observable.)
- **Lifecycle.** A stale socket file is replaced; a live socket is refused with exit 2 and the message names the path; a non-socket file at the path is refused with exit 2; SIGTERM drains within the bound and every connection sees `stopped`; the socket file is gone after exit; a daemon started with stdin closed serves the socket alone.
- **Sessions.** A snapshot session opened on one connection is `snapshot_not_found` on another (sessions are connection-scoped); closing the connection closes the session.
- **Host.** `auto` connects when a daemon is up and spawns with `--listen` when not; `connect` exits 3 when the socket is absent; a killed daemon under `connect` produces the engine-lost road and exactly one resync; `spawn` never probes; the startup report says which.
- **Gates.** Every gate reports its process exit code, not only its counts. Rust tests run with `TMPDIR="$PWD/target/tmp"`; host tests under `target/tmp` via the pinned scratch base. Nothing points at the live vault.

## Documentation

- `docs/protocol.md`: a "Transports" section replacing the one-line "proof transport" note: stdio, the socket, the path rule, connection scoping of subscriptions and sessions, the fan-out rule, the drain bound, and the `socket_path` field.
- `docs/design/headless-plugin-host.md`: one line under Known limits or Rulings: "Sync compatibility means running over a folder that Obsidian Sync manages, headless or desktop. `vaultd` never speaks the Sync protocol."
- `README.md`: the `--listen` flag and the `engine` config field.

## Rulings (2026-09-24 and 2026-09-25)

1. The vault's primary copy stays on a desktop machine. A server copy was first imagined over Syncthing; the two-writer conflict problem moved it to the official headless Obsidian Sync client, which merges Markdown.
2. Read-only-on-the-server and folder-partitioned writes were both rejected as designs; with a merging sync client, neither is needed.
3. No exception to the rule against deriving behaviour from `app.asar`: Sync compatibility is achieved by running the real Sync client over the folder, never by reimplementing the Sync protocol.
4. Approach B, one server and one loop per connection, over A (one dispatcher, many connections) and C (the host proxies the daemon).
5. The spec lives repo-local in `docs/design/`, like the six designs before it.

## Deferred follow-on

TCP with TLS or a listener bound to a private network; systemd socket activation; cross-connection sweeping of idle snapshot sessions; per-connection authorization; a `vaultd` CLI client for shell use; multi-vault.
