# vaultd socket transport performance baseline

Baselines for the socket-transport milestone (phase 7). They are **baselines, not contracts**: the contractual part of this phase is the conformance suite run over both transports and the socket test suites, all enforced by `cargo test -p vault-server` and `npm --prefix host test`. What follows is wall-clock measurement on one machine, reported so that it can fail — every case is named, run three times, and its median stated beside the design's target. **A target that was missed is reported as missed, with the number and the mechanism.**

The targets come from `docs/design/vaultd-socket-transport.md`'s "Performance requirements": connection setup under 5 ms p50, a round trip over the socket within 10 percent of the same request over stdio on a warm `get_note` and on one `write_note`, slow-client isolation within 10 percent, and no new thread per connection beyond the four the stdio loop already has. The last of those is structural rather than timed and is at the end, where it is counted rather than clocked.

**Every case carries two series, and the second is the one that counts.** The first measurement of this document found the warm `get_note` round trip 2.16× slower over the socket than over stdio — a real miss, whose mechanism was an unbuffered socket writer — and the fix landed in the same phase. Every table below therefore has a "before the write buffer" row, kept because a baseline nobody can compare to is half a baseline, and an "after" row taken on the same machine and the same fixture. Case 2 tells the story.

## Environment

- Date: 2026-09-26, both series
- Machine: MacBook Air, Apple M2 (`Mac14,2`), 16 GiB — **not an idle machine.** The load average is recorded per run below.
- OS: macOS 26.5.1 (Darwin 25.5.0), arm64
- Node: v26.7.0
- Engine: `target/release/vaultd` 0.1.0, release profile, built by `cargo build --release --bin vaultd`
- Commits: the "before" series on the daemon as of `eb1d687` (the documentation commits after it changed no code), the "after" series on the commit that buffered the write half in `connection::write_output`, both on branch `feat/socket-transport`. The "after" numbers were re-taken after the harnesses gained their hygiene fixes (a signal handler, a symlink-proof `--vault` guard, and a warm-up for the `write_note` case), so every published figure comes from the harness as it is committed today.
- Load at the start of the measurement session: `load averages: 1.61 2.43 2.37`, swap `10610.81M` of `12288.00M` used. Every run in either series was taken under a one-minute load average between 1.62 and 2.63, and the per-run figure is in each table.

## The fixture, and what it is

A 1,000-note synthetic vault, the same shape `headless-host-baseline.js` builds at 10,000: `Note-NNNNNN.md` with a `title` property, one `# Note NNNNNN` heading and a wikilink to its successor. It lives at `target/tmp/t7-bench/vault`, it is built by the harness on first use and **reused** afterwards — both transports, both series and all three runs measure the same bytes, and rebuilding between them would hand one run a colder page cache than the next.

Every daemon in this document ran with `--no-watch --reconcile-interval-seconds 0`, one fresh index per run, on that fixture. `~/vault` was never a target: the harnesses refuse a `--vault` that exists, is not empty, and does not resolve — through every symlink on the way — to somewhere under the repository's own `target/`, unless `--keep-vault` says to measure it as it is. `socket-transport-guard-selftest.js` pins that rule, including the symlink case.

**`--keep-vault` is not read-only, and the document says so where the flag does.** Case 3 creates `--samples` notes plus 20 warm-up notes named `Bench-<label>-<run>-NNNNNN.md` through `write_note` and removes them when the run ends; Case 4 creates 2×`--stall-writes` + 1 and does the same. A run that is killed between the two leaves them behind — which is why both harnesses now stop their daemon and clean up on SIGINT, SIGTERM and SIGHUP before re-raising the signal.

## Commands

```bash
cargo build --release --bin vaultd
npm --prefix host run build

node host/scripts/socket-transport-guard-selftest.js

node host/scripts/socket-transport-baseline.js \
  --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/stdio.sqlite3 \
  --transport stdio --samples 200 --repeat 3 --label air --out target/tmp/t7-bench/stdio.json

node host/scripts/socket-transport-baseline.js \
  --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/socket.sqlite3 \
  --transport socket --samples 200 --repeat 3 --label air --out target/tmp/t7-bench/socket.json

node host/scripts/socket-transport-isolation.js \
  --vault target/tmp/t7-bench/vault --index target/tmp/t7-bench/iso.sqlite3 \
  --samples 200 --stall-writes 1200 --repeat 3 --label air --out target/tmp/t7-bench/iso.json

node host/scripts/probe-echo.js --samples 400
node host/scripts/probe-chunks.js --vault target/tmp/t7-bench/vault
node host/scripts/probe-threads.js --vault target/tmp/t7-bench/vault
```

Both series were taken with exactly those commands, the second one after rebuilding the release binary; only the `--index` and `--out` paths differed between series, because the writer lease allows one daemon per index. Every table in this document has a command above it that reproduces it — the three probes are committed for that reason, after the first version of this document published two tables that only a scratch directory could produce.

`socket-transport-baseline.js` is a **daemon** harness rather than a host one: every case it measures is one request to `vaultd` and back, so there is no plugin runtime, no mirror and no `startHost`, and the only thing that differs between a stdio run and a socket run is the byte pipe. `--transport socket|stdio` is that switch, `--samples N` sets the samples per case, and `--repeat N --label NAME` takes N measured runs one daemon each and writes `<out-dir>/<out>-<label>-<n>.json` beside a summary at `--out` — the convention `headless-host-baseline.js` uses, so two machines' series are comparable in one directory. `--help` on either harness prints its header.

One thing to know before reading Case 2 against Case 3: both discard 20 warm-up requests before their 200 samples, reads and writes alike, so neither case carries a first-of-the-run outlier the other does not. Case 4's windows discard 100, for the reason its own section gives.

## Case 1 — connection setup

`connect()` to the first `health` answer, on a fresh connection every time, 200 samples per run, against a daemon that is already serving. The first connection of a run is the one that waits for the daemon to hydrate and is discarded; these are the ones after it.

| series | run 1 | run 2 | run 3 | median | load |
|---|---:|---:|---:|---:|---:|
| before the write buffer | 0.176 | 0.180 | 0.165 | **0.176 ms** | 1.79 |
| after the write buffer | 0.146 | 0.139 | 0.137 | **0.139 ms** | 2.10 |

**Target: under 5 ms p50. Median 0.139 ms — met**, with a factor of 36 in hand, and met on the earlier series too. The number is a `connect(2)` on an AF_UNIX socket, the daemon's accept loop spawning the connection's threads, and one `health` request answered off a lock-free path; none of that touches the filesystem or the index.

## Case 2 — `get_note` warm, socket against stdio

One warm `get_note` round trip on the fixture's first note, 200 samples per run after 20 discarded warm-up requests, on both transports against the same fixture.

| series | transport | run 1 | run 2 | run 3 | median | ratio |
|---|---|---:|---:|---:|---:|---:|
| before the write buffer | stdio | 0.127 | 0.125 | 0.126 | **0.126 ms** | |
| before the write buffer | socket | 0.273 | 0.271 | 0.263 | **0.271 ms** | **2.16×** |
| after the write buffer | stdio | 0.122 | 0.121 | 0.118 | **0.121 ms** | |
| after the write buffer | socket | 0.123 | 0.119 | 0.116 | **0.119 ms** | **0.981×** |

Load at the runs: 1.82 (stdio) and 1.79 (socket) for the first series, 2.08 (stdio) and 2.10 (socket) for the second.

**Target: socket within 10 percent of stdio. Measured 0.981× — met.** The first series missed it at 2.16×, which was the socket costing 0.145 ms more per warm `get_note` than stdio on an operation that took 0.126 ms over stdio. What follows is why, because the mechanism is the useful part of a number that moved.

**The mechanism was an unbuffered writer, not the kernel.** Three measurements named it, and none of them was a guess.

First, the transport itself is not the difference. `probe-echo.js` — a parent and a child exchanging one line, with no `vaultd` anywhere — measures 0.0178 ms p50 over a pipe and 0.0159 ms p50 over an AF_UNIX socket, 400 round trips each. The kernel does not charge for the socket.

Second, the daemon's overhead scaled with the size of the answer rather than being a constant per request. A scratch probe against the **pre-fix** binary measured `health` (a 118-byte response that touches nothing) at 0.021 ms over stdio and 0.052 ms over the socket, a delta of 0.031 ms, while `get_note` (a 902-byte response on this fixture) measured 0.119 ms and 0.269 ms, a delta of 0.150 ms. A constant per-request cost would not grow five-fold with the payload. Those two figures are the one measurement here that **cannot** be reproduced from this tree, because the binary they were taken against no longer exists; they are recorded in `.superpowers/sdd/vaultd-socket-transport-implementation/task-9-report.md` and are not load-bearing for the verdict.

Third, the payload arrived in pieces. `probe-chunks.js` counts the chunks one response is delivered in — a lower bound on the number of `write(2)` calls the daemon made, since the kernel may coalesce but never splits without cause — before and after:

| response | bytes | stdio, before | socket, before | stdio, after | socket, after |
|---|---:|---:|---:|---:|---:|
| `health` | 118 | 1 | 2 | 1 | 1 |
| `get_note` | 902 | 1 | 15 | 1 | 1 |

`connection::write_output` serialises straight into its sink with `serde_json::to_writer`, then writes a newline and flushes. For stdio the sink was `std::io::stdout()`, which is internally line-buffered, so one response left as one write. For a socket connection the sink was the accepted `UnixStream` itself, which buffers nothing, so serde's every fragment was its own syscall and its own wakeup on the client — 15 of them for a 902-byte answer, and more for a larger note. The unit test `one_envelope_leaves_the_daemon_as_one_write_and_one_flush` measures the same thing from inside: 66 writes per health envelope unbuffered, one buffered.

**The fix is the buffer, inside `write_output`, for every transport.** The sink is wrapped in a `std::io::BufWriter` there rather than at one caller, so both doors are identical and a third door is correct by construction; the explicit `flush()` per envelope stays exactly where it was, because a `BufWriter` flushes when it is full or dropped and neither of those is "when a response is ready". One writer thread, one flush per envelope, nothing torn and nothing held back — unchanged from before; only the syscall count per flush moved. The bytes are identical on both transports (118 and 902 above, unchanged between series) and the conformance suite, which compares the two transports byte for byte, is green.

## Case 3 — `write_note`, socket against stdio

One `write_note` to a path that does not exist, `expected: {absent: true}`, 200 distinct paths per run after 20 discarded warm-up writes, all of them removed again when the run ends. A mutation answers only after its own reconciliation has published, so each sample includes the daemon's commit and not only the round trip.

| series | transport | run 1 | run 2 | run 3 | median | ratio |
|---|---|---:|---:|---:|---:|---:|
| before the write buffer | stdio | 6.432 | 6.544 | 5.107 | **6.432 ms** | |
| before the write buffer | socket | 6.246 | 6.131 | 6.337 | **6.246 ms** | **0.97×** |
| after the write buffer | stdio | 6.909 | 7.025 | 7.031 | **7.025 ms** | |
| after the write buffer | socket | 7.437 | 6.932 | 5.962 | **6.932 ms** | **0.987×** |

**Target: socket within 10 percent of stdio. Median ratio 0.987 — met**, and met on the earlier series too at 0.97×. Both readings are inside the run-to-run spread of stdio's own runs, which span 5.107 to 7.031 ms across the two series. The write buffer is invisible here and always was: a `write_note` answer is about 120 bytes, the `health`-sized end of the chunk table above, against a 7 ms reconcile-and-publish. The before series was taken without the 20 warm-up writes, which is one more reason its run 3 (5.107 ms) sits low.

## Case 4 — `get_note` beside a client that has stopped reading

Two clients on the socket, and a third that reads while the generations are driven. The worker subscribes and measures its own warm `get_note` p50; the peer subscribes and then stops taking bytes off its socket, which parks the daemon's writer for that connection, fills its output queue and its mailbox, and starts the fan-out's `try_send` into its 256-deep inbox failing — the collapse the design's Slow-client bullet names.

**The stall is proved, not assumed.** 1,200 generations are committed while the peer is stalled; when it is let go it is handed 1,018 or 1,019 of them, so 181 to 182 notices were dropped, which is what a stall that reached the inbox looks like. One more generation is then committed as a carrier — a latched gap is announced ahead of the *next* notice and never on its own — and the peer receives `resync_required` with reason `runtime_recovered`, which is the second half of the design's requirement. That held in all six runs of both series.

**Which single-client value the stalled one is compared against.** Producing the stall takes generations, and driving 1,200 generations also grows the vault by 1,200 notes the daemon has just reconciled. A naive before-and-after therefore charges that to the stalled peer: measured that way the ratio is 1.30 before the fix and 1.38 after it, and none of it is the stall. So each run takes four samples of 200 — `alone` (before any writes), `control` (after the same write volume with nobody stalled), `beside` (peer stalled), and `recovered` (peer reading again, same vault size) — and the reported ratio is `beside` over `control`.

**Each of those four windows discards 100 reads before it samples**, and that warm-up is the difference between a number and a coin toss. Every window opens directly after a phase that committed a thousand generations or handed a stalled peer its whole backlog, and the reads that follow decay from about 2 ms to the floor over roughly a hundred requests — SQLite's WAL state, not the transport. Sampling straight into that decay puts each phase's p50 wherever its own decay had reached: a single unwarmed run of this case was measured at 1.60 and another at 0.66 on a quantity whose value is 1.0. With the warm-up, `control` reads 0.162, 0.160 and 0.161 ms across three runs — a spread under 1 percent — and the case is worth reporting.

`recovered` is published beside the rest and is still the loosest of the four, for the same reason in a smaller way: it follows the moment the peer drains its backlog, and its three p50s span 0.147 to 0.164 ms, about 11 percent, against `control`'s 1 percent. `control` is therefore the comparison. It is not a cherry-pick — the verdict is met on either, 1.003 against `control` and 1.056 against `recovered` — it is the steadier instrument.

| series | run | alone (ms) | control (ms) | beside a stalled peer (ms) | recovered (ms) | **ratio** | events kept | load |
|---|---|---:|---:|---:|---:|---:|---|---:|
| before | 1 | 0.256 | 0.348 | 0.347 | 0.344 | 0.996 | 1018 / 1200 | 1.78 |
| before | 2 | 0.275 | 0.359 | 0.353 | 0.359 | 0.982 | 1018 / 1200 | 1.63 |
| before | 3 | 0.272 | 0.359 | 0.360 | 0.354 | 1.001 | 1019 / 1200 | 1.62 |
| **before, median** | | **0.272** | **0.359** | **0.353** | **0.354** | **0.996** | | |
| after | 1 | 0.121 | 0.162 | 0.142 | 0.164 | 0.875 | 1019 / 1200 | 2.63 |
| after | 2 | 0.116 | 0.160 | 0.161 | 0.153 | 1.010 | 1019 / 1200 | 2.64 |
| after | 3 | 0.113 | 0.161 | 0.161 | 0.147 | 1.003 | 1019 / 1200 | 3.02 |
| **after, median** | | **0.116** | **0.161** | **0.161** | **0.153** | **1.003** | | |

(The before series was taken without the settling warm-up, which is why its absolute figures are higher than the after series' by more than Case 2's improvement accounts for. Its ratios are still ratios of two windows measured the same way.)

**Target: within 10 percent of the single-client value. Median of the three run ratios 1.003 — met.** No run of either series shows the stalled case slower than its own control by more than 1.0 percent; after-series run 1 shows it 12.5 percent *faster*, which is variance and not a cost. The honest summary of both series is that a peer which has stopped reading costs the clients beside it **nothing measurable**.

**The fan-out window, which the four samples above do not cover.** `beside` is taken after the worker's own event stream has gone quiet, so no notice is in flight while it is measured and the per-notice `try_send` into the stalled connection's inbox costs nothing at that moment: it is the cost of a *parked* peer, which is the spec's literal quantity. A third, unsubscribed client therefore reads continuously *while* the 1,200 generations are being driven, once with nobody stalled and once with the peer stalled:

| series | run | reads during the control writes (ms) | reads during the stalled writes (ms) | ratio | samples |
|---|---|---:|---:|---:|---:|
| after | 1 | 0.0960 | 0.0957 | 0.997 | 55,780 / 63,844 |
| after | 2 | 0.0958 | 0.0957 | 0.998 | 55,901 / 65,193 |
| after | 3 | 0.0957 | 0.0955 | 0.997 | 55,824 / 66,273 |
| **after, median** | | **0.0958** | **0.0957** | **0.997** | |

**A read costs the same while notices are being fanned out to a stalled peer as while they are being fanned out to a healthy one** — 0.997 in every run, and the sample count is "as many as the phase allowed" rather than 200, because the prober loops for the duration of the phase. (Those reads are faster than the quiet-window ones because the prober is a second connection doing nothing but reading one hot note while the index is continuously touched; the comparison that matters is the column against the column.)

One observation the same data carries, reported because it is real and not because it is a target: driving 1,200 generations took **5.7 s with nobody stalled and 6.5 to 6.7 s with the peer stalled**, consistently across all three runs. Two confounds sit in it — the stalled phase has one more connection registered with the broadcaster, and it runs against a vault 1,200 notes larger — so it is not a clean measurement of what a stalled peer costs a *writer*. The spec's requirement is about a client's round trip and that is met; write throughput beside a stalled peer is a question nobody has asked yet, and it is the one this pair suggests asking.

The `alone`-to-`control` ratio — the churn a vault that just grew by 1,200 reconciled notes costs a warm read — is 1.32 before the fix and 1.38 after: about 0.045 ms, index state rather than transport, and the reason this case compares one settled 200-sample p50 against another rather than against the start of the run.

This is the property Task 8's `socket_clients` test pins with a 2× flake guard on a debug build, measured properly here: 200 samples per phase over three runs plus about 60,000 during each write phase, on the release binary, with the confounds named and controlled.

## The fifth requirement — threads per connection

Structural rather than timed, and counted by `probe-threads.js` with `ps -M`, which prints one line per thread.

| daemon state | threads |
|---|---:|
| one stdio connection and one socket connection | 12 |
| …plus one more socket connection | 16 |
| …plus one more | 20 |
| …plus one more | 24 |
| after closing the three | 12 |
| no connection open (stdin at end of file, socket idle) | 4 |

**Four threads for the process, and exactly four per connection, returned in full when the connection closes.** The process's four are the main thread with the accept loop, the runtime's coordinator, the broadcaster's fan-out, and the signal watcher (`--no-watch --reconcile-interval-seconds 0` means no watcher thread and no periodic timer). A connection's four are its dispatcher, its reader, its writer, and its notice forwarder — and a **stdio** connection costs the same four, spawned as `vaultd-conn-stdio`, which is what makes the requirement met: a socket connection adds no thread beyond what the stdio loop already spends per connection, and three concurrent clients cost 12 threads with none left behind.

Two clauses to read the table with. **The count is of a daemon started with `--listen`**, which is what this whole document measures: without it, `connection::serve` for connection zero runs on the daemon's own main thread rather than a spawned one, so a bare stdio daemon spends three spawned threads and the main one — the same four, counted differently, and the parity claim holds in both configurations. And the forwarder is the thread the old design also had, now fed by the broadcaster's 256-deep inbox instead of the coordinator's channel directly — which is what the design's requirement says since it was amended on 2026-09-26, after the first series of this document counted four where it had claimed three.

## Summary

| case | target | median measured | verdict |
|---|---|---:|---|
| Connection setup, `connect()` to the first answer | under 5 ms p50 | 0.139 ms | met |
| `get_note` warm, socket against stdio | within 10 percent | 0.981× (medians 0.119 against 0.121 ms) | met — was 2.16× before the write buffer |
| `write_note`, socket against stdio | within 10 percent | 0.987× (medians 6.932 against 7.025 ms) | met |
| `get_note` p50 beside a stalled peer | within 10 percent | 1.003× (median of the three run ratios; medians 0.161 against 0.161 ms) | met |
| …and while notices are being fanned out | not a stated target | 0.997× (median of the three run ratios; medians 0.0957 against 0.0958 ms) | no measurable cost |
| Threads per connection | no new thread beyond stdio's four | 4 per connection on both transports | met |
