# vaultd socket transport performance baseline

Baselines for the socket-transport milestone (phase 7). They are **baselines, not contracts**: the contractual part of this phase is the conformance suite run over both transports and the socket test suites, all enforced by `cargo test -p vault-server` and `npm --prefix host test`. What follows is wall-clock measurement on one machine, reported so that it can fail — every case is named, run three times, and its median stated beside the design's target. **A target that was missed is reported as missed, with the number and the mechanism.** One of the four was missed, and the mechanism is named in Case 2.

The targets come from `docs/design/vaultd-socket-transport.md`'s "Performance requirements": connection setup under 5 ms p50, a round trip over the socket within 10 percent of the same request over stdio on a warm `get_note` and on one `write_note`, slow-client isolation within 10 percent, and no new thread per connection beyond what the stdio loop already has. The fifth of those is structural rather than timed and is at the end, where it is counted rather than clocked.

## Environment

- Date: 2026-09-26
- Machine: MacBook Air, Apple M2 (`Mac14,2`), 16 GiB — **not an idle machine.** The load average is recorded per case below.
- OS: macOS 26.5.1 (Darwin 25.5.0), arm64
- Node: v26.7.0
- Engine: `target/release/vaultd` 0.1.0, release profile, built by `cargo build --release --bin vaultd`
- Commit: `eb1d687` (branch `feat/socket-transport`), plus this document and its two harnesses
- Load at the start of the measurement session: `load averages: 1.61 2.43 2.37`, swap `10610.81M` of `12288.00M` used. Every run below was taken under a one-minute load average between 1.62 and 2.57, and the per-run figure is in each table.

## The fixture, and what it is

A 1,000-note synthetic vault, the same shape `headless-host-baseline.js` builds at 10,000: `Note-NNNNNN.md` with a `title` property, one `# Note NNNNNN` heading and a wikilink to its successor. It lives at `target/tmp/t7-bench/vault`, it is built by the harness on first use and **reused** afterwards — both transports and all three runs measure the same bytes, and rebuilding between them would hand one run a colder page cache than the next.

Every daemon in this document ran with `--no-watch --reconcile-interval-seconds 0`, one fresh index per run, on that fixture. `~/vault` was never a target, and the harnesses refuse a non-empty `--vault` outside `target/` unless `--keep-vault` says to measure it as it is. Each run removes the notes it wrote before it exits, so the fixture is 1,000 notes again at the end.

## Commands

```bash
cargo build --release --bin vaultd
npm --prefix host run build

node host/scripts/socket-transport-baseline.js \
  --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/stdio.sqlite3 \
  --transport stdio --samples 200 --repeat 3 --label air --out target/tmp/t7-bench/stdio.json

node host/scripts/socket-transport-baseline.js \
  --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/socket.sqlite3 \
  --transport socket --samples 200 --repeat 3 --label air --out target/tmp/t7-bench/socket.json

node host/scripts/socket-transport-isolation.js \
  --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/iso.sqlite3 \
  --samples 200 --stall-writes 1200 --repeat 3 --label air --out target/tmp/t7-bench/isolation.json
```

`socket-transport-baseline.js` is a **daemon** harness rather than a host one: every case it measures is one request to `vaultd` and back, so there is no plugin runtime, no mirror and no `startHost`, and the only thing that differs between a stdio run and a socket run is the byte pipe. `--transport socket|stdio` is that switch, `--samples N` sets the samples per case, and `--repeat N --label NAME` takes N measured runs one daemon each and writes `<out-dir>/<out>-<label>-<n>.json` beside a summary at `--out` — the convention `headless-host-baseline.js` uses, so two machines' series are comparable in one directory. Two different `--index` paths, because the writer lease allows one daemon per index and these are two runs.

`socket-transport-isolation.js` is the companion for the fourth requirement, which needs two clients at once: a worker, and a peer that subscribes and then stops reading. It is committed rather than left in `target/tmp` for the reason phase 6's document had to name a scratch path as its command — a number nobody else can reproduce is worth less than one they can.

## Case 1 — connection setup

`connect()` to the first `health` answer, on a fresh connection every time, 200 samples per run, against a daemon that is already serving. The first connection of a run is the one that waits for the daemon to hydrate and is discarded; these are the ones after it.

| run | connect p50 (ms) | load average at run |
|---|---:|---:|
| 1 | 0.176 | 1.79 |
| 2 | 0.180 | 1.79 |
| 3 | 0.165 | 1.79 |
| **median** | **0.176** | |

**Target: under 5 ms p50. Median 0.176 ms — met**, with a factor of 28 in hand. The number is a `connect(2)` on an AF_UNIX socket, the daemon's accept loop spawning the connection's threads, and one `health` request answered off a lock-free path; none of that touches the filesystem or the index.

## Case 2 — `get_note` warm, socket against stdio

One warm `get_note` round trip on the fixture's first note, 200 samples per run after 20 discarded warm-up requests, on both transports against the same fixture.

| run | stdio p50 (ms) | socket p50 (ms) | ratio | load (stdio / socket) |
|---|---:|---:|---:|---:|
| 1 | 0.127 | 0.273 | 2.15 | 1.82 / 1.79 |
| 2 | 0.125 | 0.271 | 2.17 | 1.82 / 1.79 |
| 3 | 0.126 | 0.263 | 2.10 | 1.82 / 1.79 |
| **median** | **0.126** | **0.271** | **2.16** | |

**Target: socket within 10 percent of stdio. Measured 2.16× — missed.** In absolute terms the socket costs 0.145 ms more per warm `get_note` than stdio does, on an operation that takes 0.126 ms over stdio; the target is missed by the ratio and the ratio is what the design asked for.

**The mechanism is an unbuffered writer, not the kernel.** Three measurements name it, and none of them is a guess.

First, the transport itself is not the difference. A pure Node echo — a parent and a child exchanging one line, with no `vaultd` anywhere — measures 0.0161 ms p50 over a pipe and 0.0159 ms p50 over an AF_UNIX socket, 400 round trips each (ratio 0.99). The kernel does not charge for the socket.

Second, the daemon's own overhead scales with the size of the answer rather than being a constant per request. The same probe against `vaultd` measures `health` (a 118-byte response that touches nothing) at 0.021 ms over stdio and 0.052 ms over the socket, a delta of 0.031 ms, while `get_note` (a 902-byte response on this fixture) measures 0.119 ms and 0.269 ms, a delta of 0.150 ms. A constant per-request cost would not grow five-fold with the payload.

Third, the payload arrives in pieces. Counting the chunks one response is delivered in — which is a lower bound on the number of `write(2)` calls the daemon made, since the kernel may coalesce but never splits without cause — gives:

| response | bytes | chunks over stdio | chunks over the socket |
|---|---:|---:|---:|
| `health` | 118 | 1 | 2 |
| `get_note` | 902 | 1 | 15 |

`connection::write_output` serialises straight into its sink with `serde_json::to_writer`, then writes a newline and flushes. For stdio the sink is `std::io::stdout()`, which is internally line-buffered, so one response leaves as one write. For a socket connection the sink is the accepted `UnixStream` itself, which buffers nothing, so serde's every fragment is its own syscall and its own wakeup on the client — 15 of them for a 902-byte answer here, and more for a larger note.

The three probes are scratch scripts under `target/tmp/t7-bench/` — `probe-echo.js` (pipe against AF_UNIX with no daemon), `probe-health.js` (`health` and `get_note` p50 on each transport) and `probe-chunks.js` (bytes and chunks per response on each transport) — and they are not committed: they exist to attribute one miss, not to be a baseline anybody re-runs.

**The remedy is one line and it is not applied in this task**, which is a measurement task: give the socket's writing half the buffer stdio gets for free, by handing `connection::serve` a `BufWriter` over the stream instead of the stream (`write_output` already flushes once per line, so the framing and the flush-per-response guarantee are unchanged). This document states the number as it stands today.

**What the miss does and does not mean.** It is 0.145 ms on a request whose answer is under a kilobyte, so it is a fixed-ish per-response tax that matters for a client issuing thousands of small reads in a row and is invisible in Case 3. It is not a regression against anything previously shipped: the socket transport is new in this phase, and stdio is unchanged.

## Case 3 — `write_note`, socket against stdio

One `write_note` to a path that does not exist, `expected: {absent: true}`, 200 distinct paths per run, all removed again when the run ends. A mutation answers only after its own reconciliation has published, so each sample includes the daemon's commit and not only the round trip.

| run | stdio p50 (ms) | socket p50 (ms) | ratio | load (stdio / socket) |
|---|---:|---:|---:|---:|
| 1 | 6.432 | 6.246 | 0.97 | 1.82 / 1.79 |
| 2 | 6.544 | 6.131 | 0.94 | 1.82 / 1.79 |
| 3 | 5.107 | 6.337 | 1.24 | 1.82 / 1.79 |
| **median** | **6.432** | **6.246** | **0.97** | |

**Target: socket within 10 percent of stdio. Median ratio 0.97 — met**, the socket being 2.9 percent faster than stdio at the median, which is well inside the run-to-run spread on this machine (stdio's own three runs span 5.107 to 6.544 ms). The transport's 0.145 ms from Case 2 is real here too and is simply too small to see against a 6 ms reconcile-and-publish: a `write_note` answer is about 120 bytes, which is the `health`-sized end of the chunk table above.

## Case 4 — `get_note` p50 beside a client that has stopped reading

Two clients on the socket. The worker subscribes and measures its own warm `get_note` p50; the peer subscribes and then stops taking bytes off its socket, which parks the daemon's writer for that connection, fills its output queue and its mailbox, and starts the fan-out's `try_send` into its 256-deep inbox failing — the collapse the design's Slow-client bullet names.

**The stall is proved, not assumed.** 1,200 generations are committed while the peer is stalled; when it is let go it is handed 1,018 or 1,019 of them, so 181 to 182 notices were dropped, which is what a stall that reached the inbox looks like. One more generation is then committed as a carrier — a latched gap is announced ahead of the *next* notice and never on its own — and the peer receives `resync_required` with reason `runtime_recovered` in every run, which is the second half of the design's requirement.

**Which single-client value the stalled one is compared against, and why it is not the obvious one.** Producing the stall takes generations, and driving 1,200 generations also grows the vault by 1,200 notes that the daemon has just reconciled. A naive before-and-after therefore charges the larger, freshly churned vault to the stalled peer: measured that way the ratio is about 1.30, and almost all of it is the churn. So the run takes four samples of 200 — `alone` before anything is written, `control` after the same write volume with nobody stalled, `beside` with the peer stalled, and `recovered` at the same vault size with the peer reading again — and the isolation number is `beside` against `recovered`, the pair that differs in the stall alone.

| run | alone p50 (ms) | control p50 (ms) | beside a stalled peer (ms) | recovered p50 (ms) | **ratio** | events kept | load |
|---|---:|---:|---:|---:|---:|---|---:|
| 1 | 0.256 | 0.348 | 0.347 | 0.344 | 1.008 | 1018 / 1200 | 1.78 |
| 2 | 0.275 | 0.359 | 0.353 | 0.359 | 0.982 | 1018 / 1200 | 1.63 |
| 3 | 0.272 | 0.359 | 0.360 | 0.354 | 1.016 | 1019 / 1200 | 1.62 |
| **median** | **0.272** | **0.359** | **0.353** | **0.354** | **1.008** | | |

**Target: within 10 percent of the single-client value. Median 1.008 — met.** Against the other control, `beside` over `control`, the median is 0.996, so the conclusion does not depend on which of the two is chosen: a peer that has stopped reading costs the clients beside it nothing measurable. The churn the two controls bracket is the `alone`-to-`control` ratio, 1.32 at the median, and it is a property of a vault that just grew by 1,200 notes rather than anything to do with a stalled client.

This is the same property Task 8's `socket_clients` test pins with a 2× flake guard on a debug build, measured properly here: 201 samples there, 200 per phase over three runs here, on the release binary, with the confound removed.

## The fifth requirement — threads per connection

Structural rather than timed, and counted with `ps -M`, which prints one line per thread.

| daemon state | threads |
|---|---:|
| listening, no connection open (stdin at end of file) | 4 |
| one stdio connection and one socket connection | 12 |
| …plus one more socket connection | 16 |
| …plus one more | 20 |
| …plus one more | 24 |
| after closing the three | 12 |

**Four threads for the process, and exactly four per connection, returned in full when the connection closes.** The process's four are the main thread with the accept loop, the runtime's coordinator, the broadcaster's fan-out, and the signal watcher (`--no-watch --reconcile-interval-seconds 0` means no watcher thread and no periodic timer). A connection's four are its dispatcher, its reader, its writer, and its notice forwarder — and a **stdio** connection costs the same four, spawned as `vaultd-conn-stdio`, which is what makes the requirement met: a socket connection adds no thread beyond what the stdio loop already spends per connection, and three concurrent clients cost 12 threads with none left behind.

One correction to how the requirement is worded. The design says "reader, writer, dispatcher; the forwarder is replaced by the broadcaster's queue", and the forwarder is **not** replaced: it is still one thread per connection, the same thread the old design had, now fed by the broadcaster's 256-deep inbox instead of by the coordinator's notice channel directly. The count per connection is four either way, and it is identical for both transports, which is the property the requirement exists to protect.

## Summary

| case | target | median measured | verdict |
|---|---|---:|---|
| Connection setup, `connect()` to the first answer | under 5 ms p50 | 0.176 ms | met |
| `get_note` warm, socket against stdio | within 10 percent | 2.16× (0.271 against 0.126 ms) | **missed** — unbuffered socket writer, Case 2 |
| `write_note`, socket against stdio | within 10 percent | 0.97× (6.246 against 6.432 ms) | met |
| `get_note` p50 beside a stalled peer | within 10 percent | 1.008× (0.353 against 0.354 ms) | met |
| Threads per connection | no new thread beyond stdio's | 4 per connection on both transports | met |
