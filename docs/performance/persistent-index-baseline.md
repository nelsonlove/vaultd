# Persistent index performance baseline

Synthetic baselines for the persistent-index milestone. Absolute timings are observational and machine-bound; the structural warm-path counters (`warm_startup_body_reads = 0`, `warm_startup_reparsed = 0`) are the contractual part and are enforced by tests.

## Environment

- Date: 2026-08-25
- OS: macOS 26.5.1 (Darwin), arm64
- CPU: Apple M2
- RAM: 16 GiB
- Rust: rustc 1.97.1 (Homebrew), release profile
- Commit: d504b4d (feat branch `feat/persistent-index-read-api`)

## Commands

```bash
cargo build --release -p vault-index --bin vault-bench
./target/release/vault-bench --notes 10000 --repeats 7 > /tmp/vaultd-bench-10k.json
./target/release/vault-bench --notes 100000 --repeats 7 > /tmp/vaultd-bench-100k.json
python3 -m json.tool /tmp/vaultd-bench-10k.json
python3 -m json.tool /tmp/vaultd-bench-100k.json
```

## 10,000-note report

```json
{
  "mode": "synthetic",
  "note_count": 10000,
  "repeats": 7,
  "schema": 1,
  "timings_ms": {
    "backlinks": {
      "p50": 0.032,
      "p95": 0.041958,
      "samples": [
        0.03125,
        0.031459,
        0.031958999999999994,
        0.032,
        0.033708999999999996,
        0.035792,
        0.041958
      ]
    },
    "cold_index": {
      "p50": 1482.308792,
      "p95": 1544.3741659999998,
      "samples": [
        1434.0339159999999,
        1475.105083,
        1479.6509580000002,
        1482.308792,
        1502.723958,
        1508.807792,
        1544.3741659999998
      ]
    },
    "get_note": {
      "p50": 0.081084,
      "p95": 0.09883399999999999,
      "samples": [
        0.077542,
        0.078292,
        0.078666,
        0.081084,
        0.082625,
        0.087417,
        0.09883399999999999
      ]
    },
    "list_100": {
      "p50": 0.461875,
      "p95": 0.669958,
      "samples": [
        0.424875,
        0.435625,
        0.45804100000000003,
        0.461875,
        0.49779200000000007,
        0.543166,
        0.669958
      ]
    },
    "one_file_refresh": {
      "p50": 934.806375,
      "p95": 997.462083,
      "samples": [
        907.430375,
        916.168,
        918.089,
        934.806375,
        938.511209,
        944.2245,
        997.462083
      ]
    },
    "verified_refresh": {
      "p50": 451.218291,
      "p95": 532.471416,
      "samples": [
        440.782833,
        443.44758299999995,
        443.449875,
        451.218291,
        459.02700000000004,
        486.17199999999997,
        532.471416
      ]
    },
    "warm_startup": {
      "p50": 54.127958,
      "p95": 60.078582999999995,
      "samples": [
        52.585708000000004,
        53.426125,
        53.941042,
        54.127958,
        54.706833,
        55.557666999999995,
        60.078582999999995
      ]
    }
  },
  "work": {
    "one_file_refresh_body_reads": 7,
    "one_file_refresh_reparsed": 7,
    "warm_startup_body_reads": 0,
    "warm_startup_reparsed": 0
  }
}
```

## 100,000-note report

```json
{
  "mode": "synthetic",
  "note_count": 100000,
  "repeats": 7,
  "schema": 1,
  "timings_ms": {
    "backlinks": {
      "p50": 0.027083000000000003,
      "p95": 0.048291,
      "samples": [
        0.025332999999999998,
        0.025417000000000002,
        0.025833000000000002,
        0.027083000000000003,
        0.029082999999999998,
        0.034749999999999996,
        0.048291
      ]
    },
    "cold_index": {
      "p50": 19611.257125,
      "p95": 21666.787500000002,
      "samples": [
        16289.551875000001,
        18052.633209,
        19137.045417,
        19611.257125,
        21498.068,
        21605.926334,
        21666.787500000002
      ]
    },
    "get_note": {
      "p50": 0.0675,
      "p95": 0.08433299999999999,
      "samples": [
        0.062833,
        0.064125,
        0.06575,
        0.0675,
        0.07012499999999999,
        0.073666,
        0.08433299999999999
      ]
    },
    "list_100": {
      "p50": 0.353458,
      "p95": 0.36133299999999996,
      "samples": [
        0.352458,
        0.353167,
        0.35325,
        0.353458,
        0.354375,
        0.35625,
        0.36133299999999996
      ]
    },
    "one_file_refresh": {
      "p50": 8418.03275,
      "p95": 8685.351208,
      "samples": [
        8165.654874999999,
        8278.600083000001,
        8396.434834000002,
        8418.03275,
        8542.675708,
        8564.771,
        8685.351208
      ]
    },
    "verified_refresh": {
      "p50": 8199.187208,
      "p95": 8786.78925,
      "samples": [
        7639.684209,
        8144.184833,
        8181.92725,
        8199.187208,
        8306.92625,
        8417.638125,
        8786.78925
      ]
    },
    "warm_startup": {
      "p50": 505.39358400000003,
      "p95": 756.473334,
      "samples": [
        485.44599999999997,
        491.01933399999996,
        498.62070800000004,
        505.39358400000003,
        741.1345,
        749.07625,
        756.473334
      ]
    }
  },
  "work": {
    "one_file_refresh_body_reads": 7,
    "one_file_refresh_reparsed": 7,
    "warm_startup_body_reads": 0,
    "warm_startup_reparsed": 0
  }
}
```

## Reading the numbers

- `cold_index` builds a fresh database from a full read and parse of every note.
- `warm_startup` reopens the service and reconciles with **zero note-body reads and zero parses** — the structural fast-startup contract.
- `one_file_refresh` reads and reparses exactly one changed note; its cost is dominated by the correctness-first global resolution rebuild the design mandates for this phase.
- `verified_refresh` reads and hashes every body but parses none when content is unchanged.
- `get_note`, `backlinks`, and `list_100` are warm indexed SQL reads; no in-memory vault graph is rebuilt.

## Opt-in real-vault measurement

```bash
./target/release/vault-bench --vault /path/to/vault --repeats 7
```

Real-vault mode is read-only: it indexes into a temporary directory, performs no source writes, and skips the one-file-refresh metric. Never commit a real vault's paths, note names, index contents, or benchmark samples.

## Stock-Obsidian comparison rubric

No comparison result is recorded here, and no superiority claim is made. A future comparison must:

- use the same machine, power state, and vault snapshot, with at least seven runs per product;
- define cold as no reusable metadata/index cache, and warm as each product's normal persistent cache retained;
- end startup timing when Obsidian's metadata cache reports resolution complete, or when `vaultd` finishes startup reconciliation;
- compare exact-note retrieval and backlinks for the same predetermined paths;
- report p50/p95 separately for startup and for queries;
- disclose the measurement instrumentation and any disposable vault copy used.

A "faster than stock Obsidian" claim is permitted only when warm query latency and repeated-startup work both win under this rubric.
